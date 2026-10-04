//! The `notify` half of the watcher: installing watches, and filtering what
//! comes back.
//!
//! This is the only module that names `notify`. Everything above it works in
//! terms of a [`WatchPlan`] and a [`Signal`], so the debounce coordinator, the
//! plan derivation and their tests never have to run a real watcher.
//!
//! # Instance identity
//!
//! A native watcher delivers callbacks from its own thread, and dropping it does
//! not stop that thread synchronously. `notify` 8.2's inotify backend sends its
//! event loop a shutdown message and wakes it; it holds no join handle and waits
//! for nothing. The Windows backend is asynchronous in the same way. So a
//! callback can still run after the drop returns - which is exactly the window an
//! app-owned write has to survive, or Quipu would treat its own save as an
//! external change. Every armed watcher therefore carries a [`Gate`], and
//! [`Instance::retire`] closes it: a callback that finds it closed returns
//! without emitting anything.
//!
//! The gate alone is enough for a mutation that *begins after* retirement, with
//! no assumption about the watcher's thread. Either the callback reads the gate
//! after it was closed, and is inert; or it read the gate before, in which case
//! it was already past the check when the fence went up, so the event it carries
//! describes the disk before the mutation - which is what any analysis would have
//! found anyway. What the gate cannot do is report a *genuine* external change
//! made during the fenced interval: that one is nobody's event, and the caller
//! has to catch up on it after re-arming.
//!
//! The gate deliberately holds no lock the registry also takes: a callback must
//! never be able to block the thread that is retiring it.
//!
//! # An instance kept for part of what it watches
//!
//! A handoff can leave an older instance alive because its replacement could not
//! duplicate a location it is watching, and what it is kept *for* is narrower than
//! what it watches - see [`super::retain`]. [`Instance::narrow`] is what makes that
//! true of the watcher rather than only of the registry's bookkeeping: it drops the
//! watches the instance is no longer answering for, and replaces the plan its
//! callbacks are judged against with the current one. Neither half is optional. A
//! descriptor held for coverage nobody relies on is the scarce resource that made
//! keeping this instance worth doing, and the plan it was armed with is one the
//! project has moved on from.
//!
//! Windows queues unwatch requests without waiting for their completion. The
//! filter must therefore enforce each retained target's depth: a non-recursive
//! parent watch cannot justify a late callback from a removed nested watch.
//!
//! Dropping a watch is not always free for the watches that remain. `notify`'s macOS
//! backend runs one FSEvents stream per watcher, so removing a path from it stops that
//! stream and starts a fresh one from `kFSEventStreamEventIdSinceNow`: for an instant,
//! everything the instance is still kept for is watched by nothing, and events in that
//! instant are not late but gone. inotify and the Windows backend remove one watch
//! without disturbing the others. [`Instance::narrow`] therefore reports whether it
//! interrupted delivery, and the registry treats that as catch-up debt for the handoff
//! that narrowed the instance - the same debt as coverage that was read before it was
//! watched, because that is exactly what the gap amounts to.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::plan::{Change, Scope, WatchPlan, WatchTarget};

/// What an armed watcher reports upwards.
pub(crate) enum Signal {
    /// Relevant paths changed. Never carries file contents - only paths.
    Changed(Vec<PathBuf>),
    /// The watcher itself failed (a dropped event queue, a backend error).
    /// Degraded operation, not a project failure.
    Failed(String),
}

/// An event sink, boxed rather than generic so the registry can hold its arming
/// step behind one function type and substitute another in its tests.
pub(crate) type SinkFn = Box<dyn Fn(Signal) + Send + 'static>;

/// Whether dropping one of this backend's watches interrupts delivery of the rest.
///
/// True for macOS, whose `notify` backend keeps a single FSEvents stream per watcher and
/// restarts it from "now" on every `unwatch`. False for inotify and for Windows, which
/// remove one watch and leave the others alone. See the module documentation.
const NARROWING_INTERRUPTS_DELIVERY: bool = cfg!(target_os = "macos");

/// Whether callbacks of one armed watcher still count.
pub(crate) struct Gate {
    alive: AtomicBool,
}

impl Gate {
    fn open() -> Arc<Self> {
        Arc::new(Self {
            alive: AtomicBool::new(true),
        })
    }

    pub(crate) fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);
    }

    pub(crate) fn is_open(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// What one instance's callbacks are judged against.
///
/// Both halves change when an instance is narrowed, so they are held together and
/// shared with the callback: an instance kept for part of what it watches has to
/// stop reporting the rest from that moment, not from the next arm.
struct Filter {
    /// The plan deciding relevance. The plan this instance was *armed* with while it
    /// is the live one; the current plan once it is only being kept for something.
    plan: Arc<WatchPlan>,
    /// The targets this instance answers for, or `None` while it answers for
    /// everything it installed.
    kept: Option<Vec<WatchTarget>>,
}

/// One armed native watcher.
pub(crate) struct Instance {
    /// Dropping this ends delivery; narrowing this instance unwatches through it.
    /// `None` only in the handoff tests, which watch nothing: a real inotify
    /// instance is a scarce per-user resource, and they have no use for one.
    watcher: Option<RecommendedWatcher>,
    gate: Arc<Gate>,
    filter: Arc<Mutex<Filter>>,
    /// What this instance has watches installed on - what the OS is holding
    /// descriptors for on its behalf, as distinct from what the registry counts as
    /// coverage of a plan ([`super::Armed::installed`], [`super::Held::installed`]).
    /// Narrowing is what keeps the two in step.
    watching: Vec<WatchTarget>,
    /// Whether unwatching one of this instance's targets interrupts delivery of the
    /// others. [`NARROWING_INTERRUPTS_DELIVERY`] for every instance production arms;
    /// the handoff tests set it both ways, so a backend that restarts its stream is
    /// exercised wherever the suite runs.
    interrupted_by_narrowing: bool,
}

impl Instance {
    /// Makes every callback of this instance inert. Called before dropping it, so
    /// a callback already queued on the watcher's thread reports nothing.
    pub(crate) fn retire(&self) {
        self.gate.close();
    }

    /// Keeps this instance only for `kept`, judged against `plan`, and says whether
    /// doing so interrupted delivery of what it is kept for.
    ///
    /// The filter is replaced first, so a callback overlapping this cannot report
    /// ground the instance has stopped answering for. Then the watches on everything
    /// else are dropped: an unwatch the OS refuses - a directory that has already
    /// gone - has lost the descriptor anyway, and there is nothing to report either
    /// way, because none of this changes what coverage the registry is counting.
    ///
    /// What the return value is for is the one thing an unwatch can cost elsewhere: on
    /// a backend with one event stream per watcher, dropping a watch restarts the
    /// stream, so the coverage being kept is momentarily absent. It is true only when a
    /// watch was actually dropped - narrowing an instance to what it already watches
    /// interrupts nothing - which is what lets a repeated handoff of an unchanged plan
    /// re-narrow the same holder and owe nothing for it.
    pub(crate) fn narrow(&mut self, plan: Arc<WatchPlan>, kept: &[WatchTarget]) -> bool {
        {
            let mut filter = locked(&self.filter);
            filter.plan = plan;
            filter.kept = Some(kept.to_vec());
        }
        let dropped: Vec<WatchTarget> = self
            .watching
            .iter()
            .filter(|target| !kept.contains(target))
            .cloned()
            .collect();
        if let Some(watcher) = &mut self.watcher {
            for target in &dropped {
                let _ = watcher.unwatch(&target.path);
            }
        }
        self.watching.retain(|target| kept.contains(target));
        !dropped.is_empty() && self.interrupted_by_narrowing
    }

    /// What the OS is still watching for this instance.
    #[cfg(test)]
    pub(crate) fn watching(&self) -> &[WatchTarget] {
        &self.watching
    }
}

/// Recovers from a poisoned filter rather than propagating a panic: the state behind
/// it decides what an event is judged against, and losing automatic refresh is a
/// worse answer than continuing with it.
fn locked(filter: &Mutex<Filter>) -> MutexGuard<'_, Filter> {
    filter.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One armed instance and what it *actually* watches.
///
/// The plan is what was asked for; this is what the OS accepted. They differ
/// whenever an auxiliary location has gone away since the plan was derived, and
/// keeping the difference is the whole point: coverage that was never installed is
/// not coverage, however completely it was requested.
pub(crate) struct Coverage {
    pub(crate) instance: Instance,
    /// The requested targets that are being watched, in plan order.
    pub(crate) installed: Vec<WatchTarget>,
    /// The requested targets that are not, one message each, ready to show.
    pub(crate) skipped: Vec<String>,
}

/// Installs `plan`'s watches and routes relevant events to `sink`.
///
/// Fails only when nothing useful could be installed: the project root, whose
/// subtree *is* the project, or a plan none of whose locations could be watched at
/// all. Anything else is partial coverage - reported in [`Coverage::skipped`] for
/// the caller to surface as degradation and to retry - because watching the project
/// while one external dependency is unwatchable beats watching nothing.
pub(crate) fn arm(plan: Arc<WatchPlan>, sink: SinkFn) -> Result<Coverage, String> {
    let gate = Gate::open();
    let filter = Arc::new(Mutex::new(Filter {
        plan: Arc::clone(&plan),
        kept: None,
    }));
    let handler = route(Arc::clone(&gate), Arc::clone(&filter), sink);

    let mut watcher =
        notify::recommended_watcher(handler).map_err(|e| format!("watcher unavailable: {e}"))?;

    let mut installed = Vec::new();
    let mut skipped = Vec::new();
    for target in plan.targets() {
        let mode = match target.scope {
            Scope::Tree => RecursiveMode::Recursive,
            Scope::Directory => RecursiveMode::NonRecursive,
        };
        match watcher.watch(&target.path, mode) {
            Ok(()) => installed.push(target.clone()),
            Err(err) => {
                let reason = format!("{}: {err}", crate::project::escaped(&target.path));
                if target.scope == Scope::Tree {
                    gate.close();
                    return Err(reason);
                }
                skipped.push(reason);
            }
        }
    }

    if installed.is_empty() {
        // An instance watching nothing would be recorded as coverage and never
        // deliver anything. Failing says so, and leaves whatever is already armed
        // in place.
        gate.close();
        return Err(if skipped.is_empty() {
            "the watch plan names nothing to watch".to_string()
        } else {
            skipped.join("; ")
        });
    }

    Ok(Coverage {
        instance: Instance {
            watcher: Some(watcher),
            gate,
            filter,
            watching: installed.clone(),
            interrupted_by_narrowing: NARROWING_INTERRUPTS_DELIVERY,
        },
        installed,
        skipped,
    })
}

/// The callback an armed watcher runs: gate, classify, filter, emit.
///
/// Separate from [`arm`] so the ordering tests can drive it by hand, with no
/// watcher and no dependence on when the OS chooses to deliver anything.
fn route<F>(
    gate: Arc<Gate>,
    filter: Arc<Mutex<Filter>>,
    sink: F,
) -> impl Fn(notify::Result<Event>) + Send + 'static
where
    F: Fn(Signal) + Send + 'static,
{
    move |result: notify::Result<Event>| {
        if !gate.is_open() {
            return;
        }
        match result {
            Ok(event) => {
                let Some(change) = classify(&event.kind) else {
                    return;
                };
                // Taken out rather than held: a callback must not hold a lock across
                // the sink, which is the frontend's, and holding this one would let a
                // listener block the thread narrowing or retiring this instance.
                let (plan, kept) = {
                    let filter = locked(&filter);
                    (Arc::clone(&filter.plan), filter.kept.clone())
                };
                let paths: Vec<PathBuf> = event
                    .paths
                    .into_iter()
                    .filter(|path| plan.is_relevant(path, change))
                    .filter(|path| answers_for(kept.as_deref(), path))
                    .collect();
                if !paths.is_empty() {
                    sink(Signal::Changed(paths));
                }
            }
            Err(err) => sink(Signal::Failed(err.to_string())),
        }
    }
}

/// Whether an instance narrowed to `kept` still answers for `path`.
///
/// An instance that has not been narrowed answers for everything its plan finds
/// relevant: the events it is delivered come from the watches it installed, so there
/// is nothing for a target test to exclude.
fn answers_for(kept: Option<&[WatchTarget]>, path: &Path) -> bool {
    kept.is_none_or(|targets| targets.iter().any(|target| target.covers(path)))
}

/// A routing callback with no watcher behind it, boxed so a test can keep one per
/// instance.
#[cfg(test)]
pub(crate) type RouteFn = Box<dyn Fn(notify::Result<Event>) + Send + 'static>;

/// An instance that watches nothing, with its gate and its callback handed back.
///
/// Lets the handoff tests stand in for [`arm`] and see exactly what the registry
/// does to the coverage it is replacing: the gate is the whole of an instance's
/// liveness, so holding one is holding the answer to "is that instance still
/// delivering?" without a filesystem or a real event in sight. The callback comes
/// with it so an event can be delivered *through* the filtering a narrowed instance
/// depends on rather than past it - `installed` says what this instance would be
/// holding descriptors for if it had a watcher.
///
/// `interrupted_by_narrowing` is that backend difference as a parameter. Nothing is
/// physically unwatched here, so it is the only way a test can ask what the registry
/// does about a narrowing that costs delivery, and asking it on the platform the suite
/// happens to be running on would leave one of the two answers untested.
#[cfg(test)]
pub(crate) fn inert(
    plan: Arc<WatchPlan>,
    installed: Vec<WatchTarget>,
    interrupted_by_narrowing: bool,
    sink: SinkFn,
) -> (Instance, Arc<Gate>, RouteFn) {
    let gate = Gate::open();
    let filter = Arc::new(Mutex::new(Filter { plan, kept: None }));
    let handler = route(Arc::clone(&gate), Arc::clone(&filter), sink);
    (
        Instance {
            watcher: None,
            gate: Arc::clone(&gate),
            filter,
            watching: installed,
            interrupted_by_narrowing,
        },
        gate,
        Box::new(handler),
    )
}

/// A callback and its gate with no watcher behind them, so a test can deliver an
/// event - or a stale one, after retiring the gate - itself.
#[cfg(test)]
pub(crate) fn detached<F>(
    plan: Arc<WatchPlan>,
    sink: F,
) -> (impl Fn(notify::Result<Event>), Arc<Gate>)
where
    F: Fn(Signal) + Send + 'static,
{
    let gate = Gate::open();
    let filter = Arc::new(Mutex::new(Filter { plan, kept: None }));
    (route(Arc::clone(&gate), filter, sink), gate)
}

/// Maps a `notify` event kind onto what it means for the project.
///
/// `None` drops the event. Access-only events - opening, reading, closing - never
/// change a file, and a write that follows one arrives as its own modify event.
/// Anything whose meaning is not pinned down is treated as structural, because
/// under-reacting to a rename or a removal is the failure that matters.
fn classify(kind: &EventKind) -> Option<Change> {
    match kind {
        EventKind::Access(_) => None,
        EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)) => Some(Change::Content),
        EventKind::Modify(_)
        | EventKind::Create(_)
        | EventKind::Remove(_)
        | EventKind::Any
        | EventKind::Other => Some(Change::Structure),
    }
}

#[cfg(test)]
pub(crate) fn classify_for_test(kind: &EventKind) -> Option<Change> {
    classify(kind)
}
