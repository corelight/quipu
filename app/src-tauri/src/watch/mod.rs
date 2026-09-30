//! Native project watching: one managed watcher for the project that is open.
//!
//! `notify` is used directly rather than through the Tauri filesystem plugin.
//! The plugin would put a general filesystem surface in front of the webview;
//! what Quipu needs is the opposite - a narrow interface over a watch plan the
//! *backend* derives from its own analysis, so the frontend can neither widen
//! the watched set nor name a path to watch.
//!
//! # What is counted, and by whom
//!
//! **Subscriptions** are the frontend's. Opening or reopening a project claims a
//! new one, even for the same directory, and switching or closing supersedes the
//! old one synchronously as far as the frontend is concerned. The backend only
//! ever *records* the serial it is given, never invents one, so the two halves
//! cannot drift: an event, a setup result or a plan update carrying a superseded
//! subscription is dropped at whichever end notices first.
//!
//! **Analysis generations** are the frontend's as well, and for the same reason. It
//! deliberately keeps several analyses of one project in flight - a manual Refresh while
//! an automatic one is reading, a catch-up beside either - and settles them by order,
//! displaying only a response newer than the newest it has already acted on. A plan
//! arrives on the same response, so it has to be installed by the same rule on the same
//! numbers: an older analysis that answered last would otherwise leave the watcher
//! filtering events through a project the window has already replaced. The subscription
//! and the generation therefore travel together as one value ([`Analysed`]), because a
//! subscription without an ordering is not enough to act on and an argument that could be
//! passed alone eventually is. The floor is reset where a subscription is claimed, since
//! the frontend's counter restarts with the project.
//!
//! **Native instances** are internal. Every arm creates one, and every retire
//! ends one, which is how an app-owned write avoids being reported back to Quipu
//! as an external change. Before Save, a compile's auto-save, New Rule or Rename
//! Rule, the frontend fences: the current instance is retired and its callbacks
//! made inert ([`Watchers::fence`]), the write happens, and the stored plan is
//! re-armed ([`Watchers::rearm_after_fence`]). No timeout and no "ignore the next
//! event" heuristic is involved - the events simply have no live watcher to arrive
//! at.
//!
//! # Nothing is retired before its replacement is live
//!
//! Every other transition is a *handoff*, not a fence: the new instance is armed
//! first and the one it replaces is retired only once it is. Retiring first would
//! leave an interval covered by nothing, and an event in that interval is not
//! merely late - there is no watcher to deliver it and no record that it happened.
//! Arming first means an event during the handoff reaches both instances instead,
//! and the frontend's debounce collapses the pair.
//!
//! A plan that is already armed *in full* is left alone. The instance covering it
//! is not improved by being replaced, and replacing it would cost a fresh recursive
//! walk and announce coverage that was never missing - which is also what stops the
//! analysis that derives a plan from scheduling the analysis that derives it
//! again.
//!
//! # Requested coverage and installed coverage are different things
//!
//! A plan is a request. What the OS accepted is what is being delivered, and the
//! two differ whenever an auxiliary location - the parent directory of an external
//! include, a candidate location outside the project - cannot be watched. The
//! project root is not in that category: without its subtree there is no automatic
//! refresh worth having, so failing to watch it fails the whole arm and leaves
//! whatever was already live in place.
//!
//! So an instance records both ([`Armed::plan`] and [`Armed::installed`]), and:
//!
//! * a partly installed plan is *not* "already armed", so the next analysis tries
//!   the locations that were skipped - a missing external dependency is retried for
//!   as long as it is missing, rather than being written off silently;
//! * the skip is [`WatchNotice::Partial`], never [`WatchNotice::Covered`]: the
//!   window says automatic refresh is degraded, and coverage that was never
//!   installed cannot clear that;
//! * what counts as newly covered is measured against what was being delivered
//!   before, not against what was requested before. Ground that was requested and
//!   skipped was watched by nothing, so it is newly covered the day it finally arms.
//!
//! That sequence terminates on a permanently unwatchable location: the retry
//! installs the same set, adds nothing to the same plan, and a `Partial` owing no
//! catch-up asks for no analysis.
//!
//! # A replacement never takes coverage away
//!
//! An arm can fail to duplicate a location the instance it replaces is watching -
//! the OS is out of watch descriptors, and duplicating the whole plan while the old
//! instance still holds it is exactly when that limit is met. Replacing outright
//! would then turn coverage that works into coverage that is missing, on the
//! strength of the replacement's bad luck.
//!
//! So a handoff *composes*: any older instance still delivering a location the plan
//! asks for and the replacement did not install is kept alive alongside it
//! ([`Armed::retained`]), and retired the moment a replacement installs that
//! location itself. The skip is still reported, and the plan is still not "already
//! armed", so the next analysis tries the location again with the current plan -
//! retained coverage prevents a loss, it does not stand in for the real thing.
//!
//! Kept for a location is *only* kept for that location. An instance was armed with
//! the plan of its own day, and it holds watches on everything that plan installed,
//! so leaving it alone would leave descriptors held for ground nobody asks for any
//! more and callbacks judging events by a superseded idea of what the project reads.
//! [`Instance::narrow`] drops the surplus watches and re-points the rest at the
//! current plan, so what a retained instance delivers is exactly what it is kept
//! for.
//!
//! On a backend that keeps one event stream per watcher - macOS - dropping a watch
//! restarts that stream, so narrowing a holder briefly stops delivering the coverage it
//! is being kept for. That is a gap in what the plan asks for, so the handoff that
//! narrowed it owes an analysis exactly as newly installed coverage does. It terminates
//! for the same reason the retries do: the analysis derives the same plan, that plan
//! narrows the same holder to the same targets, nothing is dropped the second time, and
//! nothing is owed.
//!
//! # Newly discovered coverage is owed an analysis
//!
//! An analysis reads the disk and *then* its plan is armed, so the first read of a
//! location happens before anything is watching it. A change in that interval
//! belongs to no event and to no snapshot. So installing a wider plan emits
//! [`WatchNotice::Covered`]: not a report that anything changed, but a statement
//! that somewhere newly watched was read before it was watched, and one more
//! analysis is owed. It terminates, because that analysis derives the plan that is
//! already armed.
//!
//! A plan can also widen without naming anywhere new - a file that only now counts,
//! inside a directory that was already watched recursively. Nothing was newly
//! installed, and the previous instance would have filtered a change to that file
//! out, so the same debt is owed. That is why the catch-up a notice asks for is
//! stated in its own right ([`WatchNotice::Covered::catch_up`],
//! [`WatchNotice::Partial::catch_up`]) rather than being inferred from the paths it
//! carries for display: the debt is owed when the delivered coverage grows *or* when
//! the relevance plan behind it changes, and repeating an identical plan against
//! identical coverage owes nothing, which is what makes the retries stop.
//!
//! Completing a plan and owing an analysis are therefore two answers, not one. A
//! handoff that finally installs a location an older instance was already delivering
//! for the project completes the plan - the degradation is over, and only complete
//! coverage may say so - while adding nothing that was read unwatched. It says
//! covered, and owes nothing.
//!
//! Starting a project and ending a fence owe nothing about the interval they cover.
//! The caller knows that interval better than the registry does - which documents it
//! wrote and which of its own writes to expect back, or that its first analysis is
//! about to read everything - so catching up on it is its job. What did arm is still
//! announced, complete or not, because that is news about the future rather than about
//! the interval.
//!
//! Re-arming after a *successful* write may fail, as may widening the plan. Either
//! is watcher degradation, not a failed write: the caller reports it separately
//! and leaves manual Refresh available rather than telling the user their save did
//! not happen.
//!
//! # An error from an instance that has been replaced is not news
//!
//! Retiring an instance does not stop its thread; it only makes its callbacks inert,
//! and only those that read the gate after it closed. A callback that read an open
//! gate and was then descheduled runs afterwards, so a [`WatchNotice::Failed`] can
//! arrive after the notice announcing the instance that replaced it. Restoring a
//! degradation on top of the proof that watching works would leave it on screen for
//! the rest of the project's life, and nothing would ever contradict it.
//!
//! The gate cannot decide this: closing it and emitting are separate steps on separate
//! threads, and no ordering between them exists to appeal to. So every notice about an
//! arm carries the native instance behind it, and the frontend - single-threaded, and
//! the only place with a total order over what it has been told - drops news about an
//! instance older than the newest arm it has heard of. That is why *every* arm is
//! announced, including one that installed everything and owes no analysis: an arm
//! nobody was told about leaves a stale error indistinguishable from a live one.
//!
//! What that ordering must not do is answer a failure with news about the very instance
//! that failed. [`native::arm`] installs its handler before it returns, so an instance's
//! callbacks are live throughout the arm that creates it and throughout the handoff that
//! follows: a [`WatchNotice::Failed`] stamped with instance N can arrive *before* N's own
//! [`WatchNotice::Covered`]. Nothing newer has replaced that watcher - it is the same
//! one - so the announcement is not proof that anything was fixed, and only a strictly
//! newer arm may clear the degradation. The frontend therefore keeps which instance a
//! failure came from, and coverage announcements clear it only when they are newer than
//! that, while a failure from an instance older than the newest arm is still dropped.
//! The two halves are one rule: news about an instance ranks by identity, and equal
//! identities do not supersede each other.
//!
//! Which is why an identity is taken *before* the arm that will carry it and never
//! handed out twice. An arm that emits under N and then fails leaves N spent: the next
//! successful arm is N+1, its announcement is strictly newer than the failure, and the
//! degradation clears. Recording the number only on success would have let that arm be N
//! as well, and its announcement would have cleared a failure that was never about it.
//! What a notice about live coverage names is [`Armed::serial`], never the counter, which
//! is one ahead for as long as an attempt has failed.
//!
//! [`WatchNotice::Changed`] is deliberately outside this. A retained instance is
//! *older* than the live one and is the only thing delivering the location it is kept
//! for, so ordering changes by instance would discard exactly the events retention
//! exists to keep. Its errors are droppable for a different reason: a handoff only
//! retains when it could not install everything, so it emitted
//! [`WatchNotice::Partial`] and the degradation is on screen already.
//!
//! # Notices are delivered in the order they were built
//!
//! Ordering news about instances is not enough on its own, because it says what to do with
//! a notice that arrives late and not that one cannot. A notice can only be *built* where
//! the state that makes it true is locked - which instance is delivering, what is newly
//! covered, what could not be armed - and can only be *delivered* where that lock is not
//! held, since the sink is the frontend's and a listener that called back in would deadlock
//! the watcher. Between those two points is an interval, and two transitions racing through
//! it deliver in whichever order they win: an arm's coverage reaching the frontend ahead of
//! the coverage it replaced would be dropped by the very rule above, and with it the
//! catch-up it was carrying. Discarding a debt is a project that stops refreshing, so
//! filtering at the far end cannot be the answer.
//!
//! So publication is serialized. Notices are queued as they are built, under the state
//! lock, and delivered from that one queue by one deliverer at a time, oldest first. A
//! transition ([`Transition`]) marks itself as in progress, and nothing queued while one
//! is running is delivered until it finishes: not by the thread that queued it - its own
//! arm's callbacks are live from inside the arm onwards, and it is holding the state
//! lock - and not by a deliverer that is already draining, which is not holding that lock
//! but would be delivering news about a state somebody else is still deciding. Such a
//! deliverer gives its turn up instead, and the last transition to finish takes the turn
//! itself.
//!
//! The queue's order is therefore the order the transitions happened in; the sink is
//! called holding neither lock, and only with no transition in progress, so a listener
//! may call back into the registry from any thread without waiting on a lock it cannot
//! see.
//!
//! The other channel is the result of the invoke that asked for an arm. Nothing about
//! coverage is *announced* there - the two channels interleave unpredictably, which is
//! the problem rather than a solution to it - but an arm that failed has to be answered
//! to its caller, so [`rearm_after_fence`](Watchers::rearm_after_fence) rejects with
//! [`ArmFailure`], carrying the identity the attempt reserved. That identity is what
//! orders it: taken before the arm and spent whether or not the arm succeeded, it is
//! newer than every notice built before the attempt and older than every notice built
//! after it, so the frontend needs no ordering between the channels to place it. A panic
//! in the arming step is caught where that identity is still known, for the same reason.
//!
//! Where the identity cannot be recovered at all - the task did not come back, and reading
//! the counter afterwards would race the next attempt - the rejection says so by naming
//! nothing. Not 0: 0 is the proved statement that no identity was reserved, and the
//! frontend answers it with any arm whatever, while an attempt whose identity is unknown
//! may have installed a watcher under a number nobody can name. That degradation is
//! therefore unplaceable at the far end and stands until the project is re-opened.
//!
//! # Events are hints
//!
//! A notice says only "something relevant changed"; the authoritative answer is
//! still a full `analyze_project`. So a notice carries the subscription and a
//! short list of paths for diagnostics, and never file contents.

mod native;
mod plan;

#[cfg(test)]
mod tests;

use std::any::Any;
use std::collections::{BTreeSet, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::project::{ConfigError, ProjectSnapshot, escaped};
use native::{Coverage, Instance, Signal, SinkFn};
use plan::{WatchPlan, WatchTarget};

/// The Tauri event a notice is emitted on.
pub const EVENT_WATCH: &str = "project_watch";

/// How many paths one notice carries. They are diagnostic only - the frontend
/// re-analyses the whole project either way - so a burst that touches a hundred
/// files does not need to send a hundred strings.
const MAX_PATHS: usize = 16;

/// What the frontend is told. Escaped for display, never parsed, never contents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WatchNotice {
    /// Something relevant changed. Deliberately the one notice that does not say which
    /// native instance it came from: an instance kept for coverage its replacement could
    /// not duplicate is *older* than the live one and is the only thing delivering that
    /// location, so ordering changes by instance would discard exactly the events
    /// retention exists to keep.
    #[serde(rename_all = "camelCase")]
    Changed {
        subscription: u64,
        /// Up to [`MAX_PATHS`] escaped paths, for diagnostics only.
        paths: Vec<String>,
    },
    /// The plan the last analysis derived is now armed *in full*. Not a report that
    /// anything changed: whatever the frontend has compiled is still as valid as it
    /// was.
    ///
    /// It is proof that watching this project works, which is what lets the frontend
    /// stop showing a degradation it has overtaken. Only complete coverage may say
    /// that, so a partly installed plan sends [`Self::Partial`].
    #[serde(rename_all = "camelCase")]
    Covered {
        subscription: u64,
        /// The native instance now delivering it. Counted and never reused, so the
        /// frontend can tell a retired instance's late error from a live one's - and can
        /// tell both from an error this instance itself reported before this notice was
        /// sent, which this does not answer. See [`Self::Failed::instance`].
        instance: u64,
        /// Up to [`MAX_PATHS`] escaped paths that are newly watched. Diagnostics
        /// only, and legitimately empty when a plan widened without adding a
        /// location - a file that only now counts inside a directory already
        /// watched.
        paths: Vec<String>,
        /// Whether one more analysis is owed: the coverage now being delivered grew,
        /// the relevance plan behind it changed, or narrowing an instance this handoff
        /// keeps interrupted what it is kept for. Any of them means something was read,
        /// or changed, while nothing would have reported it.
        ///
        /// Not implied by completeness, which is why it is carried rather than
        /// inferred. A handoff can complete a plan by installing a location an older
        /// instance was *already* delivering for the project - the recovery at the end
        /// of [`retain`]'s story - and that adds nothing that was not being watched.
        /// Coverage is complete, so the degradation goes; nothing was read unwatched,
        /// so no analysis is owed. Nor can `paths` be relied on to say: a plan can
        /// widen without naming anywhere new.
        catch_up: bool,
    },
    /// Some of the plan is armed and some of it could not be. Useful coverage is
    /// live - the project root always is - but the requested plan is not installed,
    /// so this is degradation, and the next analysis tries the rest again.
    ///
    /// Deliberately distinct from [`Self::Covered`]: coverage that was never
    /// installed cannot clear a degradation, and the frontend must not say
    /// automatic refresh is fully working while part of the project is unwatched.
    #[serde(rename_all = "camelCase")]
    Partial {
        subscription: u64,
        /// The native instance delivering the part that armed. See
        /// [`Self::Covered::instance`].
        instance: u64,
        /// Up to [`MAX_PATHS`] escaped paths that this handoff *did* newly watch.
        /// Diagnostics only: what is owed is [`Self::Partial::catch_up`], which is
        /// also true for a plan that widened without naming anywhere new.
        paths: Vec<String>,
        /// Whether one more analysis is owed, on exactly the terms of
        /// [`Self::Covered::catch_up`].
        ///
        /// False when the same plan installed the same coverage again and took nothing
        /// away from a holder it keeps - which is what makes retrying a permanently
        /// unwatchable location terminate - and false when the caller is already
        /// catching up on the interval itself (starting a project, ending a fence).
        catch_up: bool,
        /// Why the requested plan is not covered in full. For display.
        message: String,
    },
    /// Automatic refresh is degraded, for the instance named. Never a project failure:
    /// the snapshot on screen is still usable and manual Refresh still works.
    #[serde(rename_all = "camelCase")]
    Failed {
        subscription: u64,
        /// Which native instance this is news about: the one whose callback reported the
        /// error, or the one still live when an arm could not replace it. 0 when nothing
        /// was armed at all, and therefore nothing that a later arm could supersede.
        ///
        /// Carried because retirement does not stop a callback, it only makes one inert -
        /// and only if the callback reads the gate late enough (see
        /// [`native::Instance::retire`]). A callback that read an open gate and was then
        /// descheduled across a handoff emits *after* the replacement's [`Self::Covered`],
        /// and a degradation restored on top of the proof that watching works would sit
        /// in the window for the rest of the project's life. So the frontend drops news
        /// about an instance older than the newest arm it has been told about, which is
        /// why every arm is announced and why the announcement carries its instance.
        ///
        /// The same identity is what keeps this from being cleared by the announcement of
        /// the instance that reported it. Callbacks are live from inside the arm onwards,
        /// so this can arrive before that announcement, which is news about the same
        /// watcher and no evidence that it recovered. See the module documentation.
        instance: u64,
        message: String,
    },
}

/// Which analysis a plan update is carrying: which project, and which read of it.
///
/// One value rather than two arguments. A subscription on its own is not enough to install
/// a plan from - it says the project has not been left, not that this is the newest read of
/// it - and an argument that *can* be passed alone eventually is.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysed {
    pub subscription: u64,
    /// The frontend's own order for this analysis, counted from 1 within the project's
    /// selection and restarting with it. Not a time and not the registry's own: both ends
    /// ordering by the same numbers is the whole point.
    pub generation: u64,
}

/// Why an arm an invoke asked for could not be installed, and which attempt it was.
///
/// The caller of a re-arm is in the middle of a save and has to be answered, so this
/// failure travels on the invoke channel rather than the notice channel - and the two
/// interleave unpredictably, so the coverage the fence retired may still be in flight
/// when this arrives. What places it is therefore the identity, not the arrival: see the
/// module documentation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmFailure {
    /// Which attempt it was, in three answers rather than two.
    ///
    /// `Some(n)` is the identity the attempt reserved: newer than every notice built
    /// before the attempt and older than every notice built after it, and carried by no
    /// arm ever, so recording it silences nothing. An arm that *panicked* after reserving
    /// it says so under the same number, which is also the number any watcher it managed
    /// to install before panicking emits under.
    ///
    /// `Some(0)` is proof that nothing was reserved: an attempt that failed before it
    /// took an identity. Nothing orders that out and any arm supersedes it.
    ///
    /// `None` is not that claim. It says the identity is unknown, which is what a task
    /// that never came back leaves behind ([`Self::from`]): the frontend can place it
    /// against nothing, so no announcement may answer it.
    pub attempt: Option<u64>,
    pub message: String,
}

impl From<String> for ArmFailure {
    /// A failure the registry never got to attribute: the task did not come back at all.
    ///
    /// Not "reserved nothing", and deliberately not reported as it. It is not known what
    /// this attempt reserved, and the counter must not be read to find out, because by the
    /// time the join fails another attempt may have advanced it - so the answer is that
    /// there is no answer. Saying 0 would be a claim that the coverage a fence had just
    /// retired is free to answer, and its announcement may be in flight this moment.
    fn from(message: String) -> Self {
        Self {
            attempt: None,
            message,
        }
    }
}

/// The identity a failed attempt spent, or 0 for one that never got that far.
///
/// `counter` is read under the lock the attempt itself held, and compared only with what
/// that same hold began with: 0 is therefore proof that no identity was reserved, rather
/// than an admission that nobody looked. Which is why the answer is a number at all -
/// where nobody could look, [`ArmFailure::from`] reports no number.
fn attempted(before: u64, counter: u64) -> u64 {
    if counter > before { counter } else { 0 }
}

/// What a caught panic said, as far as it can be recovered. `panic!` with a literal
/// leaves a `&str` and one with arguments a `String`; any other payload is one nothing
/// here can read, and the default hook has already put the location on stderr.
fn panicked(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "no message".to_string()
    }
}

/// Emits a notice to whoever is listening. Injected so the registry stays
/// testable without a running Tauri application.
pub type NoticeSink = Arc<dyn Fn(WatchNotice) + Send + Sync>;

/// Delivers notices to the frontend one at a time, in the order they were built.
///
/// Building and delivering are necessarily separate - one needs the state lock, the other
/// must not hold it - so a queue is what carries the order across the gap. See the module
/// documentation.
struct Notices {
    sink: NoticeSink,
    queue: Mutex<Queue>,
}

#[derive(Default)]
struct Queue {
    /// Built and not yet delivered, oldest first.
    waiting: VecDeque<WatchNotice>,
    /// Whether a thread is delivering. One at a time: two deliverers would be two orders.
    publishing: bool,
    /// How many transitions are in progress. A notice built while one is running waits for
    /// it, because the state it is news about is still being decided - and because that is
    /// what makes an arm's own callbacks report behind the arm's announcement rather than
    /// racing it.
    ///
    /// It holds a deliverer that is *already* draining back too, and for the same reason:
    /// the thread that queued the notice is not the only one that could deliver it. What
    /// that buys is a sink called only with the registry settled, so a listener may call
    /// back in from any thread.
    transitions: usize,
}

/// Holds delivery back while a transition decides what it is going to say.
///
/// Taken *before* the state lock so that it is released after it, on every exit path
/// including `?` and an unwind: everything the transition queued is delivered together,
/// once the state it describes has settled and the lock is gone.
///
/// The last transition to finish delivers whatever is waiting, which is what makes the
/// holdback resumable: a deliverer that found a transition in progress gave its turn up
/// rather than waiting for it, so somebody has to take it back, and dropping this is the
/// one point where "no transition is in progress" becomes true.
struct Transition<'a>(&'a Notices);

/// Gives the turn back if the sink panics.
///
/// A deliverer that unwound holding it would leave every later notice queued behind a turn
/// nobody has, which is the same trade as recovering from a poisoned lock: the state behind
/// all this is watcher bookkeeping, and silently losing automatic refresh is the worse
/// answer.
struct Draining<'a>(&'a Notices);

impl Notices {
    fn new(sink: NoticeSink) -> Self {
        Self {
            sink,
            queue: Mutex::new(Queue::default()),
        }
    }

    /// Queues a notice, and delivers what is waiting unless a transition is still running -
    /// in which case that transition delivers it, in this position.
    fn send(&self, notice: WatchNotice) {
        let settled = {
            let mut queue = self.lock();
            queue.waiting.push_back(notice);
            queue.transitions == 0
        };
        if settled {
            self.publish();
        }
    }

    /// Marks a transition as in progress for as long as the returned guard lives.
    fn transition(&self) -> Transition<'_> {
        self.lock().transitions += 1;
        Transition(self)
    }

    /// Takes a turn at delivering, if nobody else has one.
    fn publish(&self) {
        {
            let mut queue = self.lock();
            if queue.publishing {
                // Somebody else is delivering and will find whatever is queued behind what
                // they are on, including anything a sink of theirs queues re-entrantly.
                return;
            }
            queue.publishing = true;
        }
        let _turn = Draining(self);
        while let Some(notice) = self.next_or_release() {
            (self.sink)(notice);
        }
    }

    /// The next notice, or `None` with the turn given up - decided in one hold of the lock.
    /// A deliverer that gave the turn up before looking again, or looked again after giving
    /// it up, would strand whatever was queued in between behind a turn nobody holds.
    ///
    /// Nothing is taken while a transition is in progress, which is the holdback [`send`]
    /// applies to a notice it queues, applied to the other thread that could deliver it:
    /// whoever is draining, a notice waits for the transition that queued it. The turn is
    /// given up rather than waited on, so the last transition out delivers it - and the
    /// notice keeps its place, because giving the turn up takes nothing off the queue.
    ///
    /// [`send`]: Self::send
    fn next_or_release(&self) -> Option<WatchNotice> {
        let mut queue = self.lock();
        let next = if queue.transitions == 0 {
            queue.waiting.pop_front()
        } else {
            None
        };
        if next.is_none() {
            queue.publishing = false;
        }
        next
    }

    /// Recovers from a poisoned lock, for the reason [`Watchers::lock`] does.
    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Drop for Transition<'_> {
    fn drop(&mut self) {
        let settled = {
            let mut queue = self.0.lock();
            queue.transitions -= 1;
            queue.transitions == 0
        };
        if settled {
            self.0.publish();
        }
    }
}

impl Drop for Draining<'_> {
    fn drop(&mut self) {
        // Only on the way out of a panic. On the way out of a finished drain the turn has
        // already been given up, and taking it away again could take it from whoever
        // claimed it next.
        if std::thread::panicking() {
            self.0.lock().publishing = false;
        }
    }
}

pub type SharedWatchers = Arc<Watchers>;

pub fn new_shared_watchers<F>(sink: F) -> SharedWatchers
where
    F: Fn(WatchNotice) + Send + Sync + 'static,
{
    Arc::new(Watchers::new(Arc::new(sink)))
}

#[derive(Default)]
struct State {
    /// The newest subscription the frontend has claimed. Only ever set from the
    /// value the frontend supplies, so the backend cannot get ahead of it.
    subscription: u64,
    /// The newest analysis generation a plan has been installed from, within
    /// `subscription`. Nothing older may install one, whatever order it answered in - the
    /// frontend has rejected it by the same rule - and it is reset where a subscription is
    /// claimed, because the frontend's counter restarts with the project.
    analysed: u64,
    /// Hands out native instance identities. Taken before the arm that will carry it,
    /// because [`native::arm`] installs its handler before it returns and the callbacks
    /// of an arm that then fails have already emitted under that identity. Never
    /// reused, so a failure from an attempt that came to nothing can never be mistaken
    /// for news about the arm that follows it. Which identity is *live* is
    /// [`Armed::serial`]; the live gate is inside [`Instance`].
    instance: u64,
    /// The plan to arm. Retained across a fence so re-arming needs no analysis.
    plan: Option<Arc<WatchPlan>>,
    armed: Option<Armed>,
    /// Fence tokens handed out and not yet released. App-owned mutations overlap -
    /// a compile's auto-save while a rename is in flight - so the watcher stays
    /// retired until the last of them releases, and a token says *which* mutation
    /// is releasing. A count alone cannot: a release that arrived twice, or late
    /// enough to be mistaken for another mutation's, would lift a fence that is
    /// still being written behind.
    fences: BTreeSet<u64>,
    /// Hands out fence tokens. Never reused, so a token from a released fence
    /// cannot be confused with a live one.
    next_fence: u64,
}

/// A live native instance and what it covers.
///
/// The plan travels with the instance rather than beside it: "is this plan already
/// armed?" is a question about the instance that is live, and answering it from a
/// plan that outlived its instance would skip arming altogether.
struct Armed {
    instance: Instance,
    /// The identity this instance's callbacks stamp what they emit with, and the one
    /// its announcement carries. Held here rather than read off [`State::instance`]
    /// because that counter has already moved on whenever an arm was attempted and
    /// failed, and what a notice about live coverage must name is the coverage that is
    /// live.
    serial: u64,
    /// What was asked for.
    plan: Arc<WatchPlan>,
    /// What the OS accepted for this instance. A subset of `plan`'s targets; equal
    /// to them whenever the plan installed in full.
    installed: Vec<WatchTarget>,
    /// Older instances kept alive because this one could not install a location they
    /// are watching and the plan still asks for. Each records only the targets it is
    /// being kept *for*; it goes as soon as a replacement installs them. See
    /// [`retain`].
    retained: Vec<Held>,
    /// Which subscription's notices this instance emits. An instance armed for a
    /// project the user has left cannot be reused for the next one, however alike
    /// their plans: its notices carry a subscription the frontend discards.
    subscription: u64,
}

/// An older instance kept for coverage its replacement could not duplicate.
struct Held {
    instance: Instance,
    /// The still-requested targets it is being kept for, not everything it watches:
    /// what it is relied on for is what decides when it may go.
    installed: Vec<WatchTarget>,
}

impl Armed {
    /// Whether every target the plan asked for is watched *by this instance*.
    ///
    /// Deliberately not counting retained coverage: an older instance filters events
    /// through the plan it was armed with, so relying on it is degraded operation,
    /// and the next analysis has to keep trying the real thing.
    ///
    /// Counting is enough: `installed` is drawn from the plan's own deduplicated
    /// target list, so it can only be a subset of it.
    fn is_complete(&self) -> bool {
        self.installed.len() == self.plan.targets().len()
    }

    /// Every location actually being watched for this project, by this instance and
    /// by anything it retains.
    fn delivering(&self) -> Vec<WatchTarget> {
        let mut all = self.installed.clone();
        for held in &self.retained {
            for target in &held.installed {
                if !all.contains(target) {
                    all.push(target.clone());
                }
            }
        }
        all
    }

    /// Ends delivery from this instance and from everything it retains.
    fn retire(&self) {
        self.instance.retire();
        for held in &self.retained {
            held.instance.retire();
        }
    }
}

/// What a handoff did.
enum Handoff {
    /// The requested plan is already armed in full; nothing was replaced and
    /// nothing is owed.
    Unchanged,
    /// A new instance is live.
    Installed {
        /// What is now watched that nothing was watching before - measured against
        /// the coverage that was actually being delivered, not against what was
        /// asked for, because ground that was requested and skipped was watched by
        /// nobody. Diagnostics for the notice.
        added: Vec<WatchTarget>,
        /// Whether one more analysis is owed for ground read before this coverage
        /// would have reported a change to it. See [`WatchNotice::Partial::catch_up`].
        catch_up: bool,
        /// Why the requested plan is not covered in full, one message per target.
        /// Empty when it is. Reported even when older coverage of it is retained:
        /// that coverage is not what was asked for.
        missing: Vec<String>,
    },
}

/// How a plan gets installed. Indirect only so the handoff tests can substitute an
/// arming step that reports what the registry did to the coverage it replaced, can
/// install part of a plan, and can fail on demand; production always arms a real
/// watcher.
type Armer = Arc<dyn Fn(Arc<WatchPlan>, SinkFn) -> Result<Coverage, String> + Send + Sync>;

/// The one managed watcher for the active project.
pub struct Watchers {
    notices: Arc<Notices>,
    armer: Armer,
    state: Mutex<State>,
}

impl Watchers {
    pub(crate) fn new(sink: NoticeSink) -> Self {
        Self::with_armer(sink, Arc::new(native::arm))
    }

    fn with_armer(sink: NoticeSink, armer: Armer) -> Self {
        Self {
            notices: Arc::new(Notices::new(sink)),
            armer,
            state: Mutex::new(State::default()),
        }
    }

    /// Begins watching `root` recursively under `subscription`.
    ///
    /// Called *before* the project's first analysis, so a change made while that
    /// analysis runs schedules a trailing one instead of being lost. `root` need
    /// not be analysable, or even exist: the root watch is also what makes a
    /// broken `quipu.toml` recoverable by editing it.
    pub(crate) fn start(&self, subscription: u64, root: &Path) -> Result<(), String> {
        let _publish = self.notices.transition();
        let mut state = self.lock();
        if subscription < state.subscription {
            return Ok(());
        }
        if subscription != state.subscription {
            // Coverage of a project the user has left is not coverage worth
            // keeping: its notices carry a superseded subscription and are
            // discarded at the far end anyway.
            Self::retire(&mut state);
            // And the frontend's analysis counter restarts with the project, so the floor
            // that orders plan updates has to restart with it too. Only on a change: a
            // repeat of the subscription in hand is the same project, still counting.
            state.analysed = 0;
        }
        state.subscription = subscription;
        // Fences belong to the mutations of the project being replaced. Their
        // releases will find no token and do nothing, which is what should happen:
        // this subscription's coverage is not theirs to lift.
        state.fences.clear();
        state.plan = Some(Arc::new(plan::for_root(root)));
        // No catch-up is owed. The project's first analysis follows this call, so
        // it reads the disk with this coverage already live - which is also why the
        // notice carries no paths: the coverage is news, the interval is not.
        let missing = match self.handoff(&mut state)? {
            Handoff::Unchanged => return Ok(()),
            Handoff::Installed { missing, .. } => missing,
        };
        self.announce_coverage(&state, subscription, missing);
        Ok(())
    }

    /// Replaces the watch plan with one derived from the analysis just taken.
    ///
    /// The snapshot is the one the frontend is about to be shown, so the watched
    /// set and the displayed project always describe the same read of the disk;
    /// nothing here re-analyses anything.
    ///
    /// Installing a wider plan in full announces itself with
    /// [`WatchNotice::Covered`], so the frontend takes one more analysis over what
    /// was read before it was watched. A plan already armed in full announces
    /// nothing, which is what makes that sequence stop. Installing part of it
    /// announces [`WatchNotice::Partial`]: the same catch-up for whatever did arm,
    /// and degradation for whatever did not. A failure to arm anything at all is
    /// reported as degradation and keeps the coverage already in place, along with
    /// the plan it could not arm, so the next analysis tries again.
    ///
    /// An analysis no newer than one a plan has already been installed from does none of
    /// that. The frontend keeps several in flight and displays the newest to settle, so an
    /// older one answering last has been rejected there; installing its plan here would
    /// point the watcher at a project the window has already replaced, and correcting that
    /// on the next analysis still costs an arm and an announcement about coverage nobody
    /// asked for.
    pub(crate) fn update(
        &self,
        of: Analysed,
        root: &Path,
        outcome: &Result<ProjectSnapshot, ConfigError>,
    ) {
        let _publish = self.notices.transition();
        let mut state = self.lock();
        if of.subscription != state.subscription {
            return;
        }
        if of.generation <= state.analysed {
            return;
        }
        let subscription = of.subscription;
        // Moved before the fence check, so the floor keeps up with the newest analysis even
        // while an app-owned mutation holds the arm back: what is stored is this analysis's
        // plan, and an older analysis must not replace it when the fence lifts either.
        state.analysed = of.generation;
        state.plan = Some(Arc::new(match outcome {
            Ok(snapshot) => plan::for_snapshot(snapshot),
            // No definition means nothing to derive a wider plan from. The root
            // watch stands, so correcting the manifest is picked up.
            Err(_) => plan::for_root(root),
        }));
        if !state.fences.is_empty() {
            // An app-owned mutation holds the watcher. Storing the plan is the
            // whole job here: the release that ends the last fence installs it,
            // and the interval itself is the caller's to catch up on.
            return;
        }
        let notice = match self.handoff(&mut state) {
            Ok(Handoff::Unchanged) => return,
            // The whole requested plan is live, which is the only thing that may
            // tell the frontend automatic refresh is working again. Whether it also
            // owes an analysis is a separate question with a separate answer: a plan
            // completed by taking over coverage something else was already delivering
            // recovers from degradation without anything having been read unwatched.
            Ok(Handoff::Installed {
                added,
                catch_up,
                missing,
            }) if missing.is_empty() => WatchNotice::Covered {
                subscription,
                instance: Self::live(&state),
                paths: escaped_targets(&added),
                catch_up,
            },
            // Part of it is. Whatever this coverage newly answers for was still read
            // before it answered for it, so the catch-up is owed for that much and the
            // rest is reported as degradation - one notice, because they are one event.
            Ok(Handoff::Installed {
                added,
                catch_up,
                missing,
            }) => WatchNotice::Partial {
                subscription,
                instance: Self::live(&state),
                paths: escaped_targets(&added),
                catch_up,
                message: missing.join("; "),
            },
            // Against the instance that is still live, because that is what this
            // degradation is news about: the plan it covers is not the plan that was
            // asked for. Not the identity the failed attempt reserved, which is newer
            // than everything actually delivering: naming it would put the frontend's
            // ordering floor above the live instance and silence its genuine failures.
            // 0 when nothing was armed at all, and therefore nothing a later arm could
            // supersede.
            Err(message) => WatchNotice::Failed {
                subscription,
                instance: Self::live(&state),
                message,
            },
        };
        self.notices.send(notice);
    }

    /// Stops watching for `subscription`, keeping the recorded serial so a later
    /// stop that arrives out of order cannot disturb a newer subscription.
    pub(crate) fn release(&self, subscription: u64) {
        let mut state = self.lock();
        if subscription != state.subscription {
            return;
        }
        Self::retire(&mut state);
        state.plan = None;
        state.fences.clear();
    }

    /// Retires the live instance ahead of an app-owned filesystem mutation, and
    /// returns the token that mutation presents to release it.
    ///
    /// The plan is kept; only the native watcher goes. Callbacks already queued on
    /// its thread find a closed gate and report nothing, which is what stops
    /// Quipu's own write coming back as an external change. A superseded
    /// subscription gets token 0, which is never outstanding: there is nothing here
    /// for it to fence and nothing for it to release.
    pub(crate) fn fence(&self, subscription: u64) -> u64 {
        let mut state = self.lock();
        if subscription != state.subscription {
            return 0;
        }
        state.next_fence += 1;
        let token = state.next_fence;
        state.fences.insert(token);
        Self::retire(&mut state);
        token
    }

    /// Releases one fence, and re-arms the stored plan if it was the last.
    ///
    /// Nothing is emitted about the interval it fenced. The caller fenced a stretch of
    /// its own work and knows what it did in there; the registry only knows that it was
    /// not watching. Catching up on that interval is therefore the caller's, and asking
    /// for it from here would cost every save a redundant analysis.
    ///
    /// The arm itself is announced - which coverage came back, and which instance is
    /// delivering it - owing no analysis. See [`Self::announce_coverage`].
    ///
    /// An arm that failed is not announced but returned, because the caller is waiting on
    /// this call and its save is not implicated. The rejection carries the identity the
    /// attempt reserved ([`ArmFailure`]), which is what lets the frontend place it against
    /// the notices still in flight on the channel it did not travel on: the fence retired
    /// the coverage whose announcement may be one of them.
    ///
    /// An arm that *panicked* is the same outcome and is answered the same way. The arming
    /// step is foreign code - a real one is `notify`, a test's is the test's - and a panic
    /// in it after the identity was reserved is not a failure that reserved nothing: an
    /// orphan watcher it installed before panicking emits under exactly that number. So the
    /// panic is caught here, while the identity is known and the lock that hands identities
    /// out is still held, rather than being left to the task boundary, where the counter
    /// could have moved on.
    pub(crate) fn rearm_after_fence(
        &self,
        subscription: u64,
        fence: u64,
    ) -> Result<(), ArmFailure> {
        let _publish = self.notices.transition();
        let mut state = self.lock();
        if subscription != state.subscription {
            return Ok(());
        }
        if !state.fences.remove(&fence) {
            // Not a fence this registry is holding: a release that arrived twice,
            // one whose fence a project change cleared, or one that never got a
            // token. Arming here would lift a fence that is not its to lift.
            return Ok(());
        }
        if !state.fences.is_empty() {
            // Another mutation is still writing behind the fence.
            return Ok(());
        }
        // What the counter stood at before this attempt, so that the identity the attempt
        // spent can be told from no identity at all without asking the arming step to
        // report it - which an arm that panicked is in no position to do.
        let before = state.instance;
        // The caller is about to catch up on the interval it fenced either way, so this
        // arm owes it no analysis - only the news of which coverage came back and which
        // instance is delivering it.
        //
        // `AssertUnwindSafe` because the state is behind a lock this frame holds and the
        // frame outlives the unwind: what the caught region can have done before panicking
        // is spend an identity, which is meant to be spent, and replace the coverage - and
        // only once the replacement was live. That is the state an arm that returned an
        // error leaves too.
        let armed = std::panic::catch_unwind(AssertUnwindSafe(|| self.handoff(&mut state)));
        let missing = match armed {
            Ok(Ok(Handoff::Unchanged)) => return Ok(()),
            Ok(Ok(Handoff::Installed { missing, .. })) => missing,
            // The identity the attempt spent, which the handoff took before arming and
            // which the frontend has not heard of: nothing is armed now, so naming it
            // silences no live instance, and it is what orders this rejection against a
            // delayed announcement of the coverage this fence retired. The next arm is
            // newer still, so recovery is announced in the ordinary way.
            Ok(Err(message)) => {
                return Err(ArmFailure {
                    attempt: Some(attempted(before, state.instance)),
                    message,
                });
            }
            Err(panic) => {
                let message = format!("the watcher arm panicked: {}", panicked(&*panic));
                return Err(ArmFailure {
                    attempt: Some(attempted(before, state.instance)),
                    message,
                });
            }
        };
        self.announce_coverage(&state, subscription, missing);
        Ok(())
    }

    /// Installs the stored plan, keeping the coverage already in place until the
    /// replacement is live.
    ///
    /// Arming before retiring is the whole point: an event during the changeover
    /// reaches both instances rather than neither, and the frontend's debounce
    /// collapses the duplicate. The other order has an interval covered by nothing,
    /// and an event there is not late - it is gone. A plan that is already armed
    /// keeps its instance, so a project that has stopped changing stops arming
    /// watchers.
    ///
    /// A failure leaves the previous instance live and the plan stored: less
    /// coverage than was asked for is still more than none, and the next analysis
    /// tries the same plan again.
    ///
    /// "Already armed" means the same plan armed *in full*. A plan only partly
    /// installed is not left alone, however identical the request: the locations
    /// that were skipped are unwatched, and the next analysis is the only thing that
    /// will ever try them again.
    fn handoff(&self, state: &mut MutexGuard<'_, State>) -> Result<Handoff, String> {
        let Some(plan) = state.plan.clone() else {
            return Ok(Handoff::Unchanged);
        };
        let subscription = state.subscription;
        let already = state.armed.as_ref().is_some_and(|armed| {
            armed.subscription == subscription && *armed.plan == *plan && armed.is_complete()
        });
        if already {
            return Ok(Handoff::Unchanged);
        }

        // The queue rather than the sink: this arm's callbacks are live from inside the arm
        // onwards, and the arm is holding the state lock. What they emit is queued behind
        // the transition that is arming and delivered when it lets go.
        let notices = Arc::clone(&self.notices);
        // The identity this arm's callbacks stamp what they emit with, taken before the
        // arm and kept whether or not it succeeds. `native::arm` installs its handler
        // before it returns, so an arm that fails part-way can already have emitted
        // under this number; handing it to the next arm would let that arm's
        // announcement answer a failure it knows nothing about.
        state.instance += 1;
        let instance = state.instance;
        let coverage = (self.armer)(
            Arc::clone(&plan),
            Box::new(move |signal| {
                notices.send(match signal {
                    Signal::Changed(paths) => WatchNotice::Changed {
                        subscription,
                        paths: paths.iter().take(MAX_PATHS).map(|p| escaped(p)).collect(),
                    },
                    Signal::Failed(message) => WatchNotice::Failed {
                        subscription,
                        instance,
                        message,
                    },
                })
            }),
        )?;
        let installed = coverage.installed;
        let missing = coverage.skipped;
        let replaced = state.armed.take();
        // Against what was actually being delivered - by the instance being replaced
        // and by anything it had retained - because that is what would have reported
        // a change while the analysis behind this plan was reading the disk.
        let delivering = replaced.as_ref().map(Armed::delivering).unwrap_or_default();
        let added = newly_installed(&delivering, &installed);
        let replanned = replaced.as_ref().is_none_or(|old| *old.plan != *plan);
        // Only now, with the replacement delivering, is the coverage it replaced
        // reconsidered - and only the parts of it that are now redundant go.
        let (retained, interrupted) = match replaced {
            Some(old) => retain(old, &plan, &installed),
            None => (Vec::new(), false),
        };
        // Coverage that grew was read before it was watched. So was a location whose
        // relevance only now counts, in a directory the previous instance was already
        // watching and would have filtered it out of - which adds nothing to
        // `delivering` and is owed the same analysis. And so was coverage that this
        // handoff took away from itself: narrowing a holder can interrupt delivery of
        // what it is still kept for, which is an unwatched interval like any other.
        let catch_up = !added.is_empty() || replanned || interrupted;
        state.armed = Some(Armed {
            instance: coverage.instance,
            serial: instance,
            plan,
            installed,
            retained,
            subscription,
        });
        Ok(Handoff::Installed {
            added,
            catch_up,
            missing,
        })
    }

    /// Says which coverage an arm installed - all of the plan, or part of it - for the
    /// callers that catch up on their own interval: starting a project, ending a fence.
    ///
    /// So it carries no paths and owes no analysis either way. The interval is the
    /// caller's own business and it is already reading it; what the coverage now *is* is
    /// news about the future.
    ///
    /// Silent when there is nothing to say would be cheaper by one event per save, and
    /// wrong: an arm nobody was told about leaves the frontend unable to tell a retired
    /// instance's late error from the live instance's, which is what
    /// [`WatchNotice::Failed::instance`] exists to decide. Every arm is announced, and a
    /// complete one owing no analysis costs a notice and nothing else.
    ///
    /// Built here, under the lock that decided it, and delivered by the transition that is
    /// running - which is what keeps it behind the announcement of the coverage it replaced
    /// and ahead of the next one.
    fn announce_coverage(&self, state: &State, subscription: u64, missing: Vec<String>) {
        let instance = Self::live(state);
        self.notices.send(if missing.is_empty() {
            WatchNotice::Covered {
                subscription,
                instance,
                paths: Vec::new(),
                catch_up: false,
            }
        } else {
            WatchNotice::Partial {
                subscription,
                instance,
                paths: Vec::new(),
                catch_up: false,
                message: missing.join("; "),
            }
        });
    }

    /// The identity of the instance now delivering, or 0 when nothing is armed.
    ///
    /// What every notice about coverage names. [`State::instance`] is one ahead of it
    /// for as long as an attempted arm failed, and 0 is the identity no arm has, so a
    /// failure carrying it is news nothing can supersede.
    fn live(state: &State) -> u64 {
        state.armed.as_ref().map_or(0, |armed| armed.serial)
    }

    /// Closes the live instance's gate, and those of anything it retains, then drops
    /// them. In that order: a callback racing the drop has to find the gate already
    /// closed.
    fn retire(state: &mut MutexGuard<'_, State>) {
        if let Some(old) = state.armed.take() {
            old.retire();
            drop(old);
        }
    }

    /// Recovers from a poisoned lock rather than propagating a panic: the state
    /// behind it is watcher bookkeeping, and losing automatic refresh is a worse
    /// answer than continuing with it.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The locations `new` watches that `old` did not.
///
/// Both lists are the installed subsets of plans that were already sorted,
/// deduplicated and stripped of anything inside a recursive target, so "not in the
/// old list" is exactly "not previously watched". Diagnostics for the notice; the
/// analysis it prompts covers the whole project regardless.
fn newly_installed(old: &[WatchTarget], new: &[WatchTarget]) -> Vec<WatchTarget> {
    new.iter()
        .filter(|target| !old.contains(target))
        .cloned()
        .collect()
}

/// Keeps whatever of `old` is still worth keeping, retires the rest, and says whether
/// narrowing a holder interrupted the coverage it is kept for.
///
/// Worth keeping is narrow: a target `plan` still asks for that the replacement did
/// not install. Everything else is either no longer wanted or now covered by the
/// instance that replaced it, and coverage nobody needs is a watch descriptor held
/// for nothing.
///
/// Narrowing a holder to what it is kept for is therefore not bookkeeping. Its
/// watches on everything else are dropped, and its callbacks are re-pointed at the
/// current plan and at those targets, so an event under ground the plan has stopped
/// asking for is inert rather than merely unaccounted for. See
/// [`Instance::narrow`], which is also what decides the second half of the answer:
/// dropping a watch costs the remaining ones an instant of delivery on some backends,
/// and an instant nobody was watching is an analysis owed.
///
/// Newest holder first, each claiming the targets left unclaimed, so one location is
/// never kept alive twice and the list cannot outgrow the plan.
fn retain(old: Armed, plan: &Arc<WatchPlan>, installed: &[WatchTarget]) -> (Vec<Held>, bool) {
    let mut unclaimed: Vec<WatchTarget> = plan
        .targets()
        .iter()
        .filter(|target| !installed.contains(target))
        .cloned()
        .collect();
    let holders = std::iter::once(Held {
        instance: old.instance,
        installed: old.installed,
    })
    .chain(old.retained);
    let mut kept = Vec::new();
    let mut interrupted = false;
    for holder in holders {
        let covers: Vec<WatchTarget> = holder
            .installed
            .iter()
            .filter(|target| unclaimed.contains(target))
            .cloned()
            .collect();
        if covers.is_empty() {
            holder.instance.retire();
            continue;
        }
        unclaimed.retain(|target| !covers.contains(target));
        let mut instance = holder.instance;
        interrupted |= instance.narrow(Arc::clone(plan), &covers);
        kept.push(Held {
            instance,
            installed: covers,
        });
    }
    (kept, interrupted)
}

/// The paths a notice carries: escaped, truncated, diagnostics only.
fn escaped_targets(targets: &[WatchTarget]) -> Vec<String> {
    targets
        .iter()
        .take(MAX_PATHS)
        .map(|target| escaped(&target.path))
        .collect()
}

/// Observations the fencing and ordering tests make. Bookkeeping only: whether a
/// native watcher exists and which generation it belongs to are decidable without
/// waiting for an event, which is what keeps those tests free of sleeps.
#[cfg(test)]
impl Watchers {
    /// A registry whose arming step is the test's own. See [`Armer`].
    pub(crate) fn with_test_armer(sink: NoticeSink, armer: Armer) -> Self {
        Self::with_armer(sink, armer)
    }

    /// [`Watchers::update`] from the next generation, for the tests that are about
    /// something else. Ordering has tests of its own, and they pass generations by hand.
    pub(crate) fn analysed(
        &self,
        subscription: u64,
        root: &Path,
        outcome: &Result<ProjectSnapshot, ConfigError>,
    ) {
        let generation = self.lock().analysed + 1;
        self.update(
            Analysed {
                subscription,
                generation,
            },
            root,
            outcome,
        );
    }

    pub(crate) fn is_armed(&self) -> bool {
        self.lock().armed.is_some()
    }

    /// The identity of the instance now delivering, or 0 when nothing is armed. Not the
    /// number of identities handed out, which an arm that failed has already moved on -
    /// that is [`Self::reserved`].
    pub(crate) fn instance(&self) -> u64 {
        Self::live(&self.lock())
    }

    /// How many native instance identities this registry has handed out, whether or not
    /// the arm that took one went on to deliver anything.
    pub(crate) fn reserved(&self) -> u64 {
        self.lock().instance
    }

    pub(crate) fn subscription(&self) -> u64 {
        self.lock().subscription
    }

    pub(crate) fn is_fenced(&self) -> bool {
        !self.lock().fences.is_empty()
    }

    /// The stored plan's targets, or an empty list when nothing is stored.
    pub(crate) fn targets(&self) -> Vec<WatchTarget> {
        match &self.lock().plan {
            Some(plan) => plan.targets().to_vec(),
            None => Vec::new(),
        }
    }

    /// What the live instance *actually* watches. Neither the stored plan, while a
    /// fence holds a newer one back, nor the plan the instance was armed with, when
    /// part of that plan could not be installed.
    pub(crate) fn armed_targets(&self) -> Vec<WatchTarget> {
        match &self.lock().armed {
            Some(armed) => armed.installed.clone(),
            None => Vec::new(),
        }
    }

    /// Everything being delivered for the project, including by coverage a partial
    /// replacement could not duplicate and so did not retire.
    pub(crate) fn delivered_targets(&self) -> Vec<WatchTarget> {
        match &self.lock().armed {
            Some(armed) => armed.delivering(),
            None => Vec::new(),
        }
    }

    /// Whether the live instance covers everything its plan asked for.
    pub(crate) fn is_complete(&self) -> bool {
        self.lock().armed.as_ref().is_some_and(Armed::is_complete)
    }

    /// What the instances kept for coverage a replacement could not duplicate still
    /// hold watches on. Not what they are being kept *for* - that is
    /// [`Watchers::delivered_targets`] - but what the OS is still holding descriptors
    /// for on their behalf, which is what a narrowing that only kept books would
    /// leave behind.
    pub(crate) fn retained_watches(&self) -> Vec<WatchTarget> {
        match &self.lock().armed {
            Some(armed) => armed
                .retained
                .iter()
                .flat_map(|held| held.instance.watching().to_vec())
                .collect(),
            None => Vec::new(),
        }
    }
}

// --- IPC ---
//
// Four commands, all doing their work on a blocking thread: arming a recursive
// watch walks the tree, and it is done holding the registry's lock.

/// Starts watching `root` under `subscription`.
///
/// A failure is degraded operation, not a failed open: the caller keeps the
/// project, keeps manual Refresh, and says automatic refresh is unavailable.
#[tauri::command]
pub async fn watch_project(
    root: String,
    subscription: u64,
    state: tauri::State<'_, SharedWatchers>,
    trace: tauri::State<'_, crate::debug_trace::DebugTrace>,
) -> Result<(), String> {
    trace.event_lazy(
        "command_received",
        || serde_json::json!({ "command": "watch_project", "subscription": subscription }),
    );
    let watchers = Arc::clone(state.inner());
    let result = blocking(move || watchers.start(subscription, &PathBuf::from(root))).await;
    trace.event_lazy("command_responded", || {
        serde_json::json!({
            "command": "watch_project",
            "subscription": subscription,
            "ok": result.is_ok(),
        })
    });
    result
}

/// Stops watching for `subscription`. Ignored when a newer one has taken over.
#[tauri::command]
pub async fn watch_release(
    subscription: u64,
    state: tauri::State<'_, SharedWatchers>,
    trace: tauri::State<'_, crate::debug_trace::DebugTrace>,
) -> Result<(), String> {
    trace.event_lazy(
        "command_received",
        || serde_json::json!({ "command": "watch_release", "subscription": subscription }),
    );
    let watchers = Arc::clone(state.inner());
    let result = blocking(move || {
        watchers.release(subscription);
        Ok(())
    })
    .await;
    trace.event_lazy("command_responded", || {
        serde_json::json!({
            "command": "watch_release",
            "subscription": subscription,
            "ok": result.is_ok(),
        })
    });
    result
}

/// Retires the native watcher before an app-owned write, returning the token that
/// releases it. Await this *before* mutating, or the write reports itself back as
/// an external change.
///
/// A rejection - the task not coming back - is unplaceable at the far end, and has to be:
/// this call reserves no identity, but it retires the instance whose coverage notice may
/// still be in flight, and it may have taken the token before the answer was lost, leaving
/// a fence nothing can lift until the project is re-opened.
#[tauri::command]
pub async fn watch_fence(
    subscription: u64,
    state: tauri::State<'_, SharedWatchers>,
    trace: tauri::State<'_, crate::debug_trace::DebugTrace>,
) -> Result<u64, String> {
    trace.event_lazy(
        "command_received",
        || serde_json::json!({ "command": "watch_fence", "subscription": subscription }),
    );
    let watchers = Arc::clone(state.inner());
    let result = blocking(move || Ok(watchers.fence(subscription))).await;
    trace.event_lazy("command_responded", || {
        serde_json::json!({
            "command": "watch_fence",
            "subscription": subscription,
            "ok": result.is_ok(),
            "fence": result.as_ref().ok(),
        })
    });
    result
}

/// Releases the fence `fence` opened, re-arming the stored plan if it was the last
/// one outstanding.
///
/// The token is what keeps overlapping mutations honest: a caller can only release
/// its own fence, once. Its failure never turns a successful write into a reported
/// write failure; the caller reports watcher degradation on its own - and reports it
/// against the identity in the [`ArmFailure`], which is what orders it against the
/// announcements still in flight on the event channel.
#[tauri::command]
pub async fn watch_rearm(
    subscription: u64,
    fence: u64,
    state: tauri::State<'_, SharedWatchers>,
    trace: tauri::State<'_, crate::debug_trace::DebugTrace>,
) -> Result<(), ArmFailure> {
    trace.event_lazy("command_received", || {
        serde_json::json!({
            "command": "watch_rearm",
            "subscription": subscription,
            "fence": fence,
        })
    });
    let watchers = Arc::clone(state.inner());
    let result = blocking(move || watchers.rearm_after_fence(subscription, fence)).await;
    trace.event_lazy("command_responded", || {
        serde_json::json!({
            "command": "watch_rearm",
            "subscription": subscription,
            "fence": fence,
            "ok": result.is_ok(),
            "attempt": result.as_ref().err().and_then(|failure| failure.attempt),
        })
    });
    result
}

/// Runs `work` on a blocking thread, a panic in it becoming the failure the command
/// reports. Generic over that failure so a command whose rejection carries more than a
/// message can say so, and `From<String>` says what a task that never came back cannot -
/// which for an arm is that its identity is unknown, rather than any claim about it.
///
/// A re-arm's own panic does not reach here: the registry catches it where the identity it
/// spent is still known, because this end cannot ask the counter without racing the next
/// attempt. See [`ArmFailure::from`].
async fn blocking<T, E, F>(work: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<String> + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| E::from(format!("watcher task panicked: {e}")))?
}
