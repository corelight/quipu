//! Tests for the project watcher: what gets watched, which events matter, and
//! the two orderings - subscriptions and native instances - that keep a
//! superseded project, or Quipu's own write, from being reported as a change.
//!
//! Almost all of these are pure. A watch plan is a value, relevance is a function
//! of a path and a change, and both the fence and the handoff are observable as
//! bookkeeping, so none of them has to wait for anything. Everything about the
//! fence and the handoff substitutes its own arming step ([`Arming`]), which hands
//! back instances that watch nothing: the ordering is then inspected at the instant
//! it happens instead of being inferred from whether something was delivered.
//!
//! Arming nothing is also what keeps the suite from running the machine out of
//! inotify instances. The limit is per user rather than per process, dropping a
//! watcher does not join its thread, and the instance is only released when that
//! thread notices - so real watchers created for bookkeeping tests accumulate
//! against a limit a desktop session is already using most of.
//!
//! Three tests do use `notify`:
//! [`a_real_watcher_delivers_changes_and_a_fence_stops_them`] demonstrates the
//! guarantee that actually holds,
//! [`narrowing_a_real_instance_keeps_delivering_what_it_is_kept_for`] runs the
//! unwatch that narrowing performs against a watcher that has something to unwatch,
//! and [`a_rearm_that_fails_after_the_write_reports_only_watcher_degradation`] needs a
//! root the OS genuinely cannot watch. Dropping a watcher does not join its thread,
//! so `fence` returning does not mean the thread has stopped; what it means is that
//! the gate is closed, so a write begun afterwards is reported by nobody. The
//! timeout is only an upper bound on how long the OS may take to deliver the writes
//! that *are* expected, and exceeding it fails the test rather than passing it
//! quietly.

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Barrier, Mutex};
use std::time::Duration;

use notify::event::{
    AccessKind, AccessMode, CreateKind, DataChange, MetadataKind, ModifyKind, RemoveKind,
    RenameMode,
};
use notify::{Event, EventKind};

use crate::project::MANIFEST_FILE;
use crate::testing::{Fixture, rule};

use super::native::{self, Signal};
use super::plan::{self, Change, Scope, WatchPlan, WatchTarget};
use super::{WatchNotice, Watchers};

/// Upper bound on how long the OS may take to deliver an event. Nothing is proved
/// by it; exceeding it fails the test rather than passing it quietly.
const DELIVERY: Duration = Duration::from_secs(10);

/// The plan for a fixture that is expected to load.
fn plan_for(fixture: &Fixture) -> WatchPlan {
    match crate::project::open_project(&fixture.root) {
        Ok(snapshot) => plan::for_snapshot(&snapshot),
        Err(err) => panic!("the fixture project loads: {err}"),
    }
}

fn targets(plan: &WatchPlan) -> Vec<(PathBuf, Scope)> {
    plan.targets()
        .iter()
        .map(|target| (target.path.clone(), target.scope))
        .collect()
}

fn scoped(targets: &[WatchTarget], scope: Scope) -> Vec<PathBuf> {
    targets
        .iter()
        .filter(|target| target.scope == scope)
        .map(|target| target.path.clone())
        .collect()
}

fn inputs(plan: &WatchPlan) -> Vec<PathBuf> {
    plan.inputs().map(|path| path.to_path_buf()).collect()
}

/// A registry whose notices are collected instead of emitted.
fn registry() -> (Watchers, Arc<Mutex<Vec<WatchNotice>>>) {
    let log: Arc<Mutex<Vec<WatchNotice>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&log);
    let watchers = Watchers::new(Arc::new(move |notice| {
        sink.lock().expect("the notice log").push(notice);
    }));
    (watchers, log)
}

fn notices(log: &Arc<Mutex<Vec<WatchNotice>>>) -> Vec<WatchNotice> {
    log.lock().expect("the notice log").clone()
}

/// Forgets the notices seen so far, so a test can assert on exactly what follows.
///
/// Every arm announces itself, including the one [`Watchers::start`] makes before the
/// project's first analysis: that announcement is what gives the frontend its order
/// over native instances. It is asserted on its own by
/// [`starting_a_project_announces_the_arm_it_made_and_owes_nothing`]; a test about what
/// a later handoff says begins from here rather than restating it.
fn forget(log: &Arc<Mutex<Vec<WatchNotice>>>) {
    log.lock().expect("the notice log").clear();
}

/// The arming step the handoff tests inject in place of a real watcher.
///
/// Every arm hands back an instance that watches nothing and keeps its gate, which
/// is the whole of an instance's liveness: asking whether a gate is open is asking
/// whether that instance is still delivering. Every instance's routing callback is
/// kept too, so an event can be delivered from *inside* an arm - the one instant at
/// which a handoff has a window to lose one - or through an instance a partial
/// replacement had to keep. Through the callback rather than to the sink it wraps,
/// because the filtering it applies is exactly what a retained instance is narrowed
/// to change.
#[derive(Default)]
struct Arming {
    /// For each arm, whether the instance it replaced was still live as it ran.
    replaced_live: Vec<bool>,
    /// Every gate armed, oldest first.
    gates: Vec<Arc<native::Gate>>,
    /// Every routing callback armed, oldest first, so `routes[i]` reports as
    /// `gates[i]` does.
    routes: Vec<native::RouteFn>,
    /// Deliver an event through the previous instance during the next arm, routed
    /// through its gate exactly as a real callback is.
    interrupt: bool,
    /// Report a watcher failure from inside this many arms, starting with the next,
    /// through the sink that arm was given. A real handler is installed before
    /// `native::arm` returns, so every arm can report before it has finished - and an
    /// arm that goes on to fail can have reported already.
    reports: usize,
    /// Refuse this many arms, starting with the next.
    refuse: usize,
    /// Panic in this many arms, starting with the next - after the identity has been
    /// reserved, which is where a real arming step's panic falls: it is reached by
    /// arming, and arming reserves before it tries. The arming log is released first,
    /// so the panic does not poison it and the test can go on inspecting it.
    panic: usize,
    /// Targets whose watch cannot be installed, named by the last component of
    /// their path. Every arm skips them, exactly as `native::arm` does when the OS
    /// refuses an auxiliary location, until the test says otherwise.
    unwatchable: Vec<String>,
    /// The backend answer every instance armed from here gives to "does dropping one
    /// watch interrupt the others?". False is inotify and Windows; macOS restarts its
    /// event stream, and a test that wants that answer asks for it, because nothing
    /// armed here has a watcher to observe it on.
    narrowing_interrupts: bool,
}

/// The path an interrupting event names, so the notice can be recognised.
const HANDED_OVER: &str = "handed-over.yar";

/// A file appearing, as `notify` reports it. Structural, and so judged
/// conservatively: what decides whether it is delivered is the plan the receiving
/// instance is filtering against and the targets it still answers for.
fn appeared(path: &Path) -> notify::Result<Event> {
    Ok(Event::new(EventKind::Create(CreateKind::File)).add_path(path.to_path_buf()))
}

/// A write to a file that exists. Judged by relevance alone, so a plan that has
/// stopped reading a path drops this where it would keep the event above.
fn written(path: &Path) -> notify::Result<Event> {
    Ok(
        Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
            .add_path(path.to_path_buf()),
    )
}

/// A registry with its notice log and the arming log behind it.
type Handoffs = (Watchers, Arc<Mutex<Vec<WatchNotice>>>, Arc<Mutex<Arming>>);

/// A registry whose arming step is [`Arming`] rather than a real watcher.
fn arming() -> Handoffs {
    let log: Arc<Mutex<Vec<WatchNotice>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&log);
    let (armer, arming) = arming_step();
    let watchers = Watchers::with_test_armer(
        Arc::new(move |notice| sink.lock().expect("the notice log").push(notice)),
        armer,
    );
    (watchers, log, arming)
}

/// The arming step on its own, for the test that has to build its sink around the very
/// registry that sink calls back into.
fn arming_step() -> (super::Armer, Arc<Mutex<Arming>>) {
    let arming: Arc<Mutex<Arming>> = Arc::new(Mutex::new(Arming::default()));
    let observer = Arc::clone(&arming);
    let armer = Arc::new(move |plan: Arc<WatchPlan>, sink: native::SinkFn| {
        let mut state = observer.lock().expect("the arming log");
        let replaced_live = state.gates.last().is_none_or(|gate| gate.is_open());
        state.replaced_live.push(replaced_live);
        if state.interrupt
            && replaced_live
            && let Some(previous) = state.routes.last()
        {
            previous(appeared(&PathBuf::from(HANDED_OVER)));
        }
        if state.reports > 0 {
            state.reports -= 1;
            sink(Signal::Failed(
                "the test's armer reports trouble".to_string(),
            ));
        }
        if state.refuse > 0 {
            state.refuse -= 1;
            return Err("the test's armer refuses".to_string());
        }
        if state.panic > 0 {
            state.panic -= 1;
            drop(state);
            panic!("the test's armer panics");
        }
        // What the plan asked for, split into what this arm could install and what
        // it could not - the distinction the registry has to keep.
        let refused = |target: &WatchTarget| {
            let file = target.path.file_name().unwrap_or_default();
            let name = file.to_string_lossy();
            state.unwatchable.iter().any(|which| *which == *name)
        };
        let installed: Vec<WatchTarget> = plan
            .targets()
            .iter()
            .filter(|target| !refused(target))
            .cloned()
            .collect();
        let skipped: Vec<String> = plan
            .targets()
            .iter()
            .filter(|target| refused(target))
            .map(|target| {
                let path = target.path.display();
                format!("{path}: the test's armer cannot watch it")
            })
            .collect();
        let (instance, gate, route) = native::inert(
            Arc::clone(&plan),
            installed.clone(),
            state.narrowing_interrupts,
            sink,
        );
        state.gates.push(gate);
        state.routes.push(route);
        Ok(native::Coverage {
            instance,
            installed,
            skipped,
        })
    });
    (armer, arming)
}

// --- The watch plan ---

#[test]
fn the_root_is_watched_recursively_before_any_analysis() {
    let fixture = Fixture::new();

    let plan = plan::for_root(&fixture.root);

    // One recursive watch, installed before the first analysis so a change made
    // while it runs schedules another one instead of being lost.
    assert_eq!(targets(&plan), vec![(fixture.root.clone(), Scope::Tree)]);
    // The manifest counts whether or not it exists yet: creating one changes the
    // definition as much as editing one.
    assert!(inputs(&plan).contains(&fixture.root.join(MANIFEST_FILE)));
    assert!(plan.is_relevant(&fixture.root.join(MANIFEST_FILE), Change::Content));
}

#[test]
fn an_absent_root_is_watched_through_its_nearest_existing_ancestor() {
    let fixture = Fixture::new();
    let absent = fixture.root.join("not/created/yet");

    let plan = plan::for_root(&absent);

    assert_eq!(
        targets(&plan),
        vec![(fixture.root.clone(), Scope::Directory)]
    );
    assert!(plan.is_relevant(&absent, Change::Structure));
}

#[test]
fn a_plan_is_deterministic_deduplicated_and_covered_by_the_root() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\ninclude_dirs = [\"shared\"]\n");
    fixture.write("main.yar", "include \"lib.yar\"\n");
    fixture.write("nested/other.yar", "include \"lib.yar\"\n");
    fixture.write("shared/lib.yar", &rule("lib"));

    let plan = plan_for(&fixture);

    assert_eq!(plan, plan_for(&fixture));
    let listed = plan.targets();
    assert!(
        listed.windows(2).all(|pair| pair[0] < pair[1]),
        "sorted and deduplicated: {listed:?}"
    );
    // Everything inside the project is reached by the one recursive watch, so no
    // location under it is watched a second time.
    assert_eq!(scoped(listed, Scope::Tree), vec![fixture.root.clone()]);
    assert!(
        scoped(listed, Scope::Directory)
            .iter()
            .all(|dir| !dir.starts_with(&fixture.root)),
        "{listed:?}"
    );
}

#[test]
fn an_external_source_is_watched_through_its_parent_directory() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let plan = plan_for(&fixture);
    let external = fixture.base.join("shared/ext.yar");

    assert!(inputs(&plan).contains(&external));
    // The directory, not the file: a watch on the file watches its inode, which
    // an atomic save replaces.
    assert!(
        scoped(plan.targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "{:?}",
        plan.targets()
    );
    assert!(!plan.targets().iter().any(|target| target.path == external));
}

#[test]
fn atomically_replacing_an_external_source_is_relevant() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let plan = plan_for(&fixture);
    let external = fixture.base.join("shared/ext.yar");

    // The rename that completes the save names the destination, and so does the
    // deletion that a removal reports.
    assert!(plan.is_relevant(&external, Change::Structure));
    assert!(plan.is_relevant(&external, Change::Content));
    // The temporary file it was renamed from is not an input, and writing it is
    // not a reason to re-analyse.
    let temporary = fixture.base.join("shared/ext.yar.tmp");
    assert!(!plan.is_relevant(&temporary, Change::Content));
    assert!(!plan.is_relevant(&temporary, Change::Structure));
}

#[test]
fn an_unresolved_include_is_watched_where_it_would_appear() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"nowhere.yar\"\n");

    let plan = plan_for(&fixture);
    let candidate = fixture.root.join("nowhere.yar");

    // The candidate comes from the snapshot's resolution data, not from reading
    // the missing-include message.
    assert!(inputs(&plan).contains(&candidate));
    assert!(plan.is_relevant(&candidate, Change::Structure));
}

#[test]
fn an_earlier_candidate_that_would_shadow_the_resolved_target_is_watched() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\ninclude_dirs = [\"../early\", \"../late\"]\n");
    fixture.write("main.yar", "include \"common.yar\"\n");
    fixture.write_outside("early/unrelated.txt", "");
    fixture.write_outside("late/common.yar", &rule("late"));

    let plan = plan_for(&fixture);
    let listed = plan.targets();
    let recorded = inputs(&plan);

    // Resolution stopped at `../late`, but a file appearing in the including
    // file's own directory, or in `../early`, would shadow it without anything
    // the project currently reads changing at all.
    assert!(
        recorded.contains(&fixture.root.join("common.yar")),
        "{recorded:?}"
    );
    assert!(
        recorded.contains(&fixture.base.join("early/common.yar")),
        "{recorded:?}"
    );
    assert!(
        recorded.contains(&fixture.base.join("late/common.yar")),
        "{recorded:?}"
    );
    assert!(
        plan.is_relevant(&fixture.base.join("early/common.yar"), Change::Structure),
        "an earlier candidate appearing changes the answer"
    );

    let dirs = scoped(listed, Scope::Directory);
    assert!(dirs.contains(&fixture.base.join("early")), "{dirs:?}");
    assert!(dirs.contains(&fixture.base.join("late")), "{dirs:?}");
    // Non-recursively, and only the exact candidate parents.
    assert_eq!(scoped(listed, Scope::Tree), vec![fixture.root.clone()]);
}

#[test]
fn a_candidate_under_a_missing_directory_is_watched_through_its_nearest_ancestor() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\ninclude_dirs = [\"../vendor\"]\n");
    fixture.write("main.yar", "include \"pack/deep.yar\"\n");
    fixture.write_outside("vendor/unrelated.txt", "");

    let plan = plan_for(&fixture);
    let missing = fixture.base.join("vendor/pack");

    assert!(inputs(&plan).contains(&missing.join("deep.yar")));
    // The absent directory cannot be watched, so its nearest existing ancestor
    // stands in for it.
    assert!(!plan.targets().iter().any(|target| target.path == missing));
    assert!(
        scoped(plan.targets(), Scope::Directory).contains(&fixture.base.join("vendor")),
        "{:?}",
        plan.targets()
    );
    // Creating, or atomically moving in, the missing subtree reports only the
    // subtree's own path.
    assert!(plan.is_relevant(&missing, Change::Structure));
}

#[test]
fn an_ordinary_write_to_a_file_nothing_reads_is_ignored() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));
    fixture.write("README.md", "# notes\n");
    fixture.write("targets/sample.txt", "hello\n");

    let plan = plan_for(&fixture);

    assert!(!plan.is_relevant(&fixture.root.join("README.md"), Change::Content));
    assert!(!plan.is_relevant(&fixture.root.join("targets/sample.txt"), Change::Content));
    // Nor is one a structural reason on its own: an example scan target being
    // rewritten in place is not a reason to invalidate a compiled ruleset.
    assert!(!plan.is_relevant(&fixture.root.join("README.md"), Change::Structure));

    assert!(plan.is_relevant(&fixture.root.join("main.yar"), Change::Content));
    // A rule file the snapshot has never seen: discovery would pick it up, so its
    // appearance is exactly the change that has to be noticed.
    assert!(plan.is_relevant(&fixture.root.join("later.yar"), Change::Structure));
}

#[test]
fn a_structural_change_is_judged_conservatively() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"nested/lib.yar\"\n");
    fixture.write("nested/lib.yar", &rule("lib"));

    let plan = plan_for(&fixture);

    // A removed directory cannot be inspected, and removing this one took an
    // input with it.
    assert!(plan.is_relevant(&fixture.root.join("nested"), Change::Structure));
    // A path with no extension may well be a directory that has already gone.
    assert!(plan.is_relevant(&fixture.root.join("gone"), Change::Structure));
}

#[test]
fn a_broken_configuration_still_watches_the_root_so_the_manifest_can_be_fixed() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 2\n");
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, _arming) = arming();
    watchers.start(1, &fixture.root).expect("the plan arms");
    forget(&log);
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    // No definition means nothing to derive a wider plan from, and the root watch
    // is what makes correcting the manifest recover automatically.
    assert_eq!(
        watchers
            .targets()
            .iter()
            .map(|target| (target.path.clone(), target.scope))
            .collect::<Vec<_>>(),
        vec![(fixture.root.clone(), Scope::Tree)]
    );
    assert!(
        notices(&log).is_empty(),
        "a broken manifest is neither a watcher failure nor newly covered ground: \
         the root plan it derives is the one already armed"
    );

    // Correcting it, and the analysis that follows, widens the plan.
    fixture.manifest("schema = 1\n");
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert!(
        scoped(&watchers.targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "{:?}",
        watchers.targets()
    );
    // The external directory was read to build that plan before it was watched, so
    // one more analysis is owed on it. (The manifest rewrite is also a real change
    // under the live root watch, so this registry's notices include its events.)
    let seen = notices(&log);
    assert!(
        seen.iter().any(|notice| matches!(
            notice,
            WatchNotice::Covered { subscription: 1, paths, catch_up: true, .. }
                if paths.iter().any(|p| p.contains("shared"))
        )),
        "{seen:?}"
    );
    assert!(
        !seen
            .iter()
            .any(|notice| matches!(notice, WatchNotice::Failed { .. })),
        "{seen:?}"
    );
}

// --- Event kinds ---

#[test]
fn access_only_events_are_dropped_before_any_path_is_considered() {
    let classify = native::classify_for_test;

    assert_eq!(classify(&EventKind::Access(AccessKind::Read)), None);
    assert_eq!(
        classify(&EventKind::Access(AccessKind::Open(AccessMode::Any))),
        None
    );
    assert_eq!(
        classify(&EventKind::Access(AccessKind::Close(AccessMode::Write))),
        None
    );

    // A write is its own event, and everything ambiguous is structural.
    assert_eq!(
        classify(&EventKind::Modify(ModifyKind::Data(DataChange::Any))),
        Some(Change::Content)
    );
    assert_eq!(
        classify(&EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::WriteTime
        ))),
        Some(Change::Content)
    );
    assert_eq!(
        classify(&EventKind::Modify(ModifyKind::Name(RenameMode::Any))),
        Some(Change::Structure)
    );
    assert_eq!(
        classify(&EventKind::Create(CreateKind::File)),
        Some(Change::Structure)
    );
    assert_eq!(
        classify(&EventKind::Remove(RemoveKind::Any)),
        Some(Change::Structure)
    );
    assert_eq!(classify(&EventKind::Any), Some(Change::Structure));
    assert_eq!(classify(&EventKind::Other), Some(Change::Structure));
}

#[test]
fn a_callback_from_a_retired_instance_reports_nothing() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));
    fixture.write("README.md", "# notes\n");

    let plan = Arc::new(plan_for(&fixture));
    let seen: Arc<Mutex<Vec<Signal>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = {
        let seen = Arc::clone(&seen);
        move |signal| seen.lock().expect("the signal log").push(signal)
    };
    let (handler, gate) = native::detached(plan, recorder);
    let count = || seen.lock().expect("the signal log").len();

    let write = |relative: &str| {
        Ok(
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
                .add_path(fixture.root.join(relative)),
        )
    };

    handler(write("main.yar"));
    assert_eq!(count(), 1);

    // The same callback drops an access event and an irrelevant write, so what
    // the gate adds can be seen on its own.
    handler(Ok(
        Event::new(EventKind::Access(AccessKind::Read)).add_path(fixture.root.join("main.yar"))
    ));
    handler(write("README.md"));
    assert_eq!(count(), 1);

    // Retiring the gate is what a fence, a project switch and a close all do. A
    // callback already queued on the watcher's thread then finds it closed.
    gate.close();
    handler(write("main.yar"));
    handler(Err(notify::Error::generic("event queue overflowed")));
    assert_eq!(count(), 1, "a retired instance reports nothing at all");
}

#[test]
fn a_watcher_error_is_reported_as_a_failure_rather_than_a_change() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let plan = Arc::new(plan_for(&fixture));
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = {
        let seen = Arc::clone(&seen);
        move |signal| {
            if let Signal::Failed(message) = signal {
                seen.lock().expect("the failure log").push(message);
            }
        }
    };
    let (handler, _gate) = native::detached(plan, recorder);

    handler(Err(notify::Error::generic("event queue overflowed")));

    let failures = seen.lock().expect("the failure log").clone();
    assert_eq!(failures.len(), 1);
    assert!(failures[0].contains("overflowed"), "{failures:?}");
}

// --- Subscription ordering ---

#[test]
fn an_older_subscription_can_neither_start_update_nor_release() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));
    let abandoned = Fixture::new();
    abandoned.write("main.yar", "include \"../shared/ext.yar\"\n");
    abandoned.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, _arming) = arming();
    watchers.start(7, &fixture.root).expect("the plan arms");
    forget(&log);
    let armed = watchers.instance();

    // A setup call from a project that has already been left behind.
    watchers
        .start(6, &abandoned.root)
        .expect("ignored, not failed");
    assert_eq!(watchers.subscription(), 7);
    assert_eq!(watchers.instance(), armed, "the live instance is untouched");
    assert_eq!(
        scoped(&watchers.targets(), Scope::Tree),
        vec![fixture.root.clone()]
    );

    // So is the analysis it eventually returned.
    watchers.analysed(
        6,
        &abandoned.root,
        &crate::project::open_project(&abandoned.root),
    );
    assert_eq!(
        scoped(&watchers.targets(), Scope::Tree),
        vec![fixture.root.clone()]
    );
    assert!(
        !scoped(&watchers.targets(), Scope::Directory).contains(&abandoned.base.join("shared")),
        "{:?}",
        watchers.targets()
    );

    // And so is its release: the current project keeps its watch.
    watchers.release(6);
    assert!(watchers.is_armed());
    assert!(notices(&log).is_empty());
}

#[test]
fn releasing_stops_watching_without_advancing_the_recorded_serial() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, _log, _arming) = arming();
    watchers.start(3, &fixture.root).expect("the plan arms");

    watchers.release(3);
    assert!(!watchers.is_armed());
    assert!(watchers.targets().is_empty());
    // The serial is kept rather than bumped: the frontend counts subscriptions, so
    // a backend that got ahead would make the next one look stale.
    assert_eq!(watchers.subscription(), 3);

    // Reopening the same project claims a new subscription and arms again.
    watchers.start(4, &fixture.root).expect("the plan arms");
    assert!(watchers.is_armed());
    assert_eq!(watchers.subscription(), 4);
}

// --- The native fence ---

#[test]
fn fencing_retires_the_watcher_and_rearming_starts_a_new_instance() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, _arming) = arming();
    watchers.start(1, &fixture.root).expect("the plan arms");
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    let before = watchers.instance();
    forget(&log);

    let fence = watchers.fence(1);
    assert!(
        !watchers.is_armed(),
        "an app-owned write has no live watcher"
    );
    assert!(watchers.is_fenced());
    // The plan survives the fence, so re-arming needs no second analysis.
    assert!(
        scoped(&watchers.targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "{:?}",
        watchers.targets()
    );

    watchers.rearm_after_fence(1, fence).expect("re-armed");
    assert!(watchers.is_armed());
    assert!(!watchers.is_fenced());
    assert_eq!(watchers.instance(), before + 1, "a new instance identity");
    // Ending a fence says nothing about the interval it fenced: the caller fenced it
    // and catches up on it itself, and asking for an analysis here would cost every
    // save one. What the notice does say is which instance came back, which is what
    // makes a stale error from the one the fence retired droppable.
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [WatchNotice::Covered { subscription: 1, instance, paths, catch_up: false }]
                if *instance == watchers.instance() && paths.is_empty()
        ),
        "{seen:?}"
    );
}

#[test]
fn an_analysis_landing_while_fenced_stores_its_plan_without_arming() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, _arming) = arming();
    watchers.start(1, &fixture.root).expect("the plan arms");
    forget(&log);
    let fence = watchers.fence(1);
    let fenced = watchers.instance();

    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    assert!(
        !watchers.is_armed(),
        "the fence is not lifted by an analysis"
    );
    assert_eq!(watchers.instance(), fenced);
    assert!(
        scoped(&watchers.targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "{:?}",
        watchers.targets()
    );
    assert!(
        notices(&log).is_empty(),
        "and nothing is announced for coverage that is not live yet"
    );

    watchers.rearm_after_fence(1, fence).expect("re-armed");
    assert!(watchers.is_armed());
    assert!(
        scoped(&watchers.armed_targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "the plan stored while fenced is the one armed: {:?}",
        watchers.armed_targets()
    );
}

#[test]
fn a_fence_or_rearm_from_an_older_subscription_does_nothing() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, _log, _arming) = arming();
    watchers.start(5, &fixture.root).expect("the plan arms");
    let armed = watchers.instance();

    // No token, because there is nothing here for a project that is gone to fence.
    assert_eq!(watchers.fence(4), 0);
    assert!(watchers.is_armed(), "the current project keeps its watcher");
    assert!(!watchers.is_fenced());

    // A stale re-arm reports success without touching the live instance: there is
    // nothing wrong, it is simply about a project that is gone.
    watchers
        .rearm_after_fence(4, 1)
        .expect("ignored, not failed");
    assert_eq!(watchers.instance(), armed);
}

#[test]
fn overlapping_mutations_hold_the_fence_until_the_last_one_releases() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, log, _arming) = arming();
    watchers.start(1, &fixture.root).expect("the plan arms");
    let armed = watchers.instance();

    // A save and a rename fencing at the same time, and finishing in either order.
    let save = watchers.fence(1);
    let rename = watchers.fence(1);
    assert!(!watchers.is_armed());

    watchers.rearm_after_fence(1, save).expect("released");
    assert!(
        !watchers.is_armed(),
        "the rename is still writing behind the fence"
    );
    assert!(watchers.is_fenced());
    watchers.rearm_after_fence(1, rename).expect("re-armed");
    assert!(watchers.is_armed());
    assert_eq!(
        watchers.instance(),
        armed + 1,
        "one replacement between them, not one each"
    );

    // The other completion order settles at the same place.
    let save = watchers.fence(1);
    let rename = watchers.fence(1);
    watchers.rearm_after_fence(1, rename).expect("released");
    assert!(!watchers.is_armed(), "the save is still writing");
    watchers.rearm_after_fence(1, save).expect("re-armed");
    assert!(watchers.is_armed());
    // Three arms - the start and the two re-arms - and every one of them announced
    // itself without asking for an analysis: the mutations behind the fence catch up
    // on their own interval.
    let seen = notices(&log);
    assert!(
        seen.iter().all(|notice| matches!(
            notice,
            WatchNotice::Covered {
                catch_up: false,
                ..
            }
        )),
        "{seen:?}"
    );
    assert_eq!(seen.len(), 3, "{seen:?}");
}

#[test]
fn a_release_cannot_lift_a_fence_it_does_not_hold() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, _log, _arming) = arming();
    watchers.start(1, &fixture.root).expect("the plan arms");

    // A save fences and writes, and its release is still queued on the blocking
    // pool when the next command runs. A rename fences and starts writing.
    let save = watchers.fence(1);
    let rename = watchers.fence(1);

    // Now the save's release arrives, out of order. It ends its own fence and no
    // more: the rename's write is still to come, and arming here would report it.
    watchers.rearm_after_fence(1, save).expect("released");
    assert!(!watchers.is_armed());
    // Nor can the same release arriving twice stand in for the rename's.
    watchers
        .rearm_after_fence(1, save)
        .expect("ignored, not failed");
    assert!(!watchers.is_armed());

    watchers.rearm_after_fence(1, rename).expect("re-armed");
    assert!(watchers.is_armed());

    // Afterwards, a token from a fence that is already released is inert, so a
    // duplicate cannot replace a live instance either.
    let live = watchers.instance();
    watchers
        .rearm_after_fence(1, rename)
        .expect("ignored, not failed");
    watchers
        .rearm_after_fence(1, 0)
        .expect("ignored, not failed");
    assert_eq!(watchers.instance(), live);
    assert!(watchers.is_armed());
}

#[test]
fn a_fence_taken_after_a_release_gets_a_token_of_its_own() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, _log, _arming) = arming();
    watchers.start(1, &fixture.root).expect("the plan arms");

    // Three overlapping mutations, one of which releases before the last begins.
    let save = watchers.fence(1);
    let rename = watchers.fence(1);
    watchers.rearm_after_fence(1, save).expect("released");
    let compile = watchers.fence(1);
    assert_ne!(compile, rename, "a token still outstanding is not reissued");

    // A counter that reused released numbers would have handed the rename's token
    // out again here, and this release would lift the rename's fence rather than its
    // own - re-arming while the rename is still writing.
    watchers.rearm_after_fence(1, compile).expect("released");
    assert!(!watchers.is_armed(), "the rename is still writing");

    watchers.rearm_after_fence(1, rename).expect("re-armed");
    assert!(watchers.is_armed());
}

#[test]
fn a_project_change_clears_the_fences_the_abandoned_project_held() {
    let left = Fixture::new();
    left.write("main.yar", &rule("main"));
    let opened = Fixture::new();
    opened.write("main.yar", &rule("main"));

    let (watchers, _log, _arming) = arming();
    watchers.start(1, &left.root).expect("the plan arms");
    // A mutation of the project the user is leaving, still in flight.
    let abandoned = watchers.fence(1);

    watchers.start(2, &opened.root).expect("the new plan arms");
    assert!(
        watchers.is_armed(),
        "the project just opened is watched at once, fence or no fence"
    );
    assert!(!watchers.is_fenced());
    assert_eq!(
        scoped(&watchers.armed_targets(), Scope::Tree),
        vec![opened.root.clone()]
    );

    // The abandoned mutation's release names a token this registry no longer holds.
    // Tokens are never reused, so it cannot be mistaken for one of the new
    // project's, even presented under the new subscription.
    let live = watchers.instance();
    watchers
        .rearm_after_fence(2, abandoned)
        .expect("ignored, not failed");
    assert_eq!(watchers.instance(), live);
    assert!(watchers.is_armed());
}

#[test]
fn a_rearm_that_fails_after_the_write_reports_only_watcher_degradation() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, log) = registry();
    watchers
        .start(1, &fixture.root)
        .expect("the root is watchable");
    forget(&log);
    let fence = watchers.fence(1);

    // Stands in for the app-owned mutation, and makes re-arming impossible.
    std::fs::remove_dir_all(&fixture.root).expect("remove the project root");

    let err = watchers
        .rearm_after_fence(1, fence)
        .expect_err("the root can no longer be watched");
    assert!(err.message.contains("project"), "{err:?}");
    // The failure is returned as the watcher's own value, for the caller to
    // report separately - the write it followed is not implicated, and nothing is
    // left half-armed or stuck fenced.
    assert!(!watchers.is_armed());
    assert!(!watchers.is_fenced());
    assert_eq!(watchers.subscription(), 1);
    assert!(notices(&log).is_empty());
}

// --- The plan handoff ---

#[test]
fn a_replacement_is_armed_before_the_coverage_it_replaces_is_retired() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    forget(&log);
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    let state = arming.lock().expect("the arming log");
    assert_eq!(
        state.gates.len(),
        2,
        "the wider plan replaced the root-only plan"
    );
    assert_eq!(
        state.replaced_live,
        vec![true, true],
        "each arm ran while the coverage it was replacing was still delivering"
    );
    // And only once the replacement was live did the old instance go.
    assert!(
        !state.gates[0].is_open(),
        "the replaced instance is retired"
    );
    assert!(state.gates[1].is_open(), "the replacement is live");
    drop(state);

    assert!(
        matches!(
            notices(&log).as_slice(),
            [WatchNotice::Covered { subscription: 1, paths, catch_up: true, .. }]
                if paths.iter().any(|p| p.contains("shared"))
        ),
        "{:?}",
        notices(&log)
    );
}

#[test]
fn an_event_during_a_plan_handoff_is_not_discarded() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    forget(&log);
    arming.lock().expect("the arming log").interrupt = true;

    // The analysis's plan is installed, and the OS reports a change in the middle of
    // the changeover - the interval in which retiring first would leave nothing
    // watching at all.
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [
                WatchNotice::Changed { subscription: 1, paths },
                WatchNotice::Covered { subscription: 1, .. },
            ] if paths.iter().any(|p| p.contains(HANDED_OVER))
        ),
        "the outgoing instance was still able to report it: {seen:?}"
    );
}

#[test]
fn a_plan_already_armed_is_left_alone_so_the_analyses_stop() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, _arming) = arming();
    watchers.start(1, &fixture.root).expect("the plan arms");
    forget(&log);
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    let armed = watchers.instance();
    assert_eq!(notices(&log).len(), 1, "{:?}", notices(&log));

    // The analysis that notice asks for. It reads the same disk, so it derives the
    // plan that is already armed: no new instance, and nothing asking for another
    // analysis. That is what makes the sequence terminate instead of looping.
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    assert_eq!(watchers.instance(), armed, "no replacement was armed");
    assert!(watchers.is_armed());
    assert_eq!(notices(&log).len(), 1, "{:?}", notices(&log));
}

#[test]
fn an_external_dependency_changed_before_its_watch_existed_is_owed_an_analysis() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, _arming) = arming();
    watchers.start(1, &fixture.root).expect("the plan arms");
    forget(&log);

    // The first analysis reads the external dependency. Nothing is watching it: the
    // plan that covers it is derived from this very read.
    let outcome = crate::project::open_project(&fixture.root);
    // It changes here - after it was read, before its watch exists. No event covers
    // this interval and the snapshot above predates it.
    fixture.write_outside("shared/ext.yar", &rule("replaced"));

    watchers.analysed(1, &fixture.root, &outcome);

    // The notice is what closes the interval. Not a claim that anything changed -
    // the registry cannot know - but that newly watched ground was read before it
    // was watched, so one more analysis is owed on it.
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [WatchNotice::Covered { subscription: 1, paths, catch_up: true, .. }]
                if paths.iter().any(|p| p.contains("shared"))
        ),
        "{seen:?}"
    );

    // That analysis reads the changed file and derives the same plan, so it asks for
    // nothing further.
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert_eq!(notices(&log).len(), 1, "{:?}", notices(&log));
}

#[test]
fn a_handoff_that_cannot_arm_keeps_the_coverage_already_in_place() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    forget(&log);
    arming.lock().expect("the arming log").refuse = 1;

    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    assert!(
        watchers.is_armed(),
        "the root watch is still live: less coverage than asked for beats none"
    );
    assert!(
        arming.lock().expect("the arming log").gates[0].is_open(),
        "and it was never retired"
    );
    // Against the instance that is still live, so the frontend keeps it: what this
    // degradation is news about is that the coverage still delivering is not the
    // coverage that was asked for.
    assert!(
        matches!(
            notices(&log).as_slice(),
            [WatchNotice::Failed {
                subscription: 1,
                instance,
                ..
            }] if *instance == watchers.instance()
        ),
        "{:?}",
        notices(&log)
    );
    // The plan it could not arm is kept, so the next analysis tries it again rather
    // than settling for what is armed.
    assert!(
        scoped(&watchers.targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "{:?}",
        watchers.targets()
    );

    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert!(
        matches!(
            notices(&log).as_slice(),
            [WatchNotice::Failed { .. }, WatchNotice::Covered { .. }]
        ),
        "{:?}",
        notices(&log)
    );
    assert!(
        scoped(&watchers.armed_targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "{:?}",
        watchers.armed_targets()
    );
}

// --- Coverage that was asked for and coverage that is live ---

#[test]
fn an_auxiliary_location_that_cannot_be_watched_keeps_the_root_and_says_so() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    forget(&log);
    arming.lock().expect("the arming log").unwatchable = vec!["shared".to_string()];

    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    // The project's own subtree is still watched: an external dependency that cannot
    // be watched is not a reason to stop watching the rules being edited.
    assert!(watchers.is_armed());
    assert_eq!(
        scoped(&watchers.armed_targets(), Scope::Tree),
        vec![fixture.root.clone()]
    );
    // What was never installed is not recorded as coverage, however completely it was
    // requested. That is what makes the difference retryable.
    assert!(
        !scoped(&watchers.armed_targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "{:?}",
        watchers.armed_targets()
    );
    assert!(!watchers.is_complete());
    // And the frontend hears about it as degradation, never as coverage: nothing here
    // may tell the window that automatic refresh is fully working. Nowhere new was
    // installed, but the plan's relevance filter widened inside the root, so one
    // analysis is still owed.
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [WatchNotice::Partial { subscription: 1, paths, catch_up: true, message, .. }]
                if message.contains("shared") && paths.is_empty()
        ),
        "{seen:?}"
    );

    // The analysis that follows derives the same plan. It is not "already armed":
    // the location that was skipped is watched by nobody, and this is the only thing
    // that will ever try it again.
    let retried = watchers.instance();
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert!(
        watchers.instance() > retried,
        "the missing target was tried again"
    );
    // It failed again, so the same plan is delivering the same coverage and no further
    // analysis is owed: a permanently unwatchable location degrades the watch, it does
    // not loop.
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [
                WatchNotice::Partial { .. },
                WatchNotice::Partial {
                    paths,
                    catch_up: false,
                    ..
                },
            ] if paths.is_empty()
        ),
        "{seen:?}"
    );
}

#[test]
fn a_wider_relevance_filter_inside_the_root_is_owed_one_analysis_and_no_more() {
    let fixture = Fixture::new();
    // A dependency inside the root that is not a rule file by name, so nothing treats
    // a write to it as relevant until an analysis says the project reads it - and an
    // auxiliary location that cannot be watched, so the notice is a `Partial`.
    fixture.write(
        "main.yar",
        "include \"helper.ya\"\ninclude \"../vendor/lib.yar\"\n",
    );
    fixture.write("helper.ya", &rule("helper"));
    fixture.write_outside("vendor/lib.yar", &rule("lib"));
    let helper = fixture.root.join("helper.ya");
    assert!(
        !plan::for_root(&fixture.root).is_relevant(&helper, Change::Content),
        "the watcher armed before the first analysis filters this write out"
    );
    assert!(
        plan_for(&fixture).is_relevant(&helper, Change::Content),
        "and the plan the analysis derives does not"
    );

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    forget(&log);
    arming.lock().expect("the arming log").unwatchable = vec!["vendor".to_string()];
    let root_only = watchers.armed_targets();

    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    // Nowhere new is being watched: `helper.ya` is inside the root's own recursive
    // watch, and the one location this plan added could not be watched at all.
    assert_eq!(watchers.armed_targets(), root_only);
    // The debt is owed all the same, and cannot be inferred from the paths - there are
    // none. It is the interval between the analysis reading `helper.ya` and this
    // instance being the one deciding what counts.
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [WatchNotice::Partial { subscription: 1, paths, catch_up: true, message, .. }]
                if paths.is_empty() && message.contains("vendor")
        ),
        "{seen:?}"
    );

    // The analysis it asked for derives the same plan and installs the same coverage
    // again, so it owes nothing: one catch-up, not a loop.
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [
                WatchNotice::Partial { catch_up: true, .. },
                WatchNotice::Partial {
                    catch_up: false,
                    ..
                },
            ]
        ),
        "{seen:?}"
    );
}

#[test]
fn a_replacement_that_cannot_duplicate_live_coverage_keeps_it() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));
    let shared = fixture.base.join("shared");

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert!(watchers.is_complete());
    assert!(
        scoped(&watchers.armed_targets(), Scope::Directory).contains(&shared),
        "{:?}",
        watchers.armed_targets()
    );
    // The instance delivering that coverage. Duplicating a whole plan while this one
    // still holds it is exactly when an OS runs out of watch descriptors.
    let covering = arming.lock().expect("the arming log").gates.len() - 1;

    // The plan widens, and the arm that installs the wider one cannot take `shared`.
    fixture.write(
        "main.yar",
        "include \"../shared/ext.yar\"\ninclude \"../vendor/lib.yar\"\n",
    );
    fixture.write_outside("vendor/lib.yar", &rule("lib"));
    arming.lock().expect("the arming log").unwatchable = vec!["shared".to_string()];
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    // Working coverage does not become missing coverage because its replacement was
    // unlucky: the instance holding it is still delivering.
    {
        let state = arming.lock().expect("the arming log");
        assert!(
            state.gates[covering].is_open(),
            "the coverage the replacement could not duplicate was retired anyway"
        );
        state.routes[covering](written(&shared.join("ext.yar")));
    }
    assert!(
        matches!(
            notices(&log).last(),
            Some(WatchNotice::Changed { subscription: 1, paths }) if paths.iter().any(|p| p.contains("ext.yar"))
        ),
        "{:?}",
        notices(&log)
    );
    assert!(
        scoped(&watchers.delivered_targets(), Scope::Directory).contains(&shared),
        "{:?}",
        watchers.delivered_targets()
    );

    // It is reported as missing all the same, and the plan is not "already armed":
    // retained coverage filters events through the plan it was armed with, so it
    // prevents a loss rather than standing in for what was asked for.
    assert!(!watchers.is_complete());
    assert!(
        !scoped(&watchers.armed_targets(), Scope::Directory).contains(&shared),
        "{:?}",
        watchers.armed_targets()
    );
    let seen = notices(&log);
    let reported = seen.iter().find(|notice| {
        matches!(notice, WatchNotice::Partial { message, .. } if message.contains("shared"))
    });
    assert!(
        matches!(
            reported,
            Some(WatchNotice::Partial { subscription: 1, paths, catch_up: true, .. })
                if paths.iter().any(|p| p.contains("vendor"))
        ),
        "{seen:?}"
    );

    // And it is kept only until a replacement installs that location itself.
    arming.lock().expect("the arming log").unwatchable.clear();
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert!(watchers.is_complete());
    assert!(
        !arming.lock().expect("the arming log").gates[covering].is_open(),
        "kept for as long as it was needed, and no longer"
    );
    // The recovery is complete coverage, so it clears the degradation - and it owes no
    // analysis, because the location it finally installed was already being delivered
    // for this project by the instance it has just retired. Nothing was read unwatched,
    // and asking for an analysis here would ask for one after every such recovery.
    assert!(
        matches!(
            notices(&log).last(),
            Some(WatchNotice::Covered {
                subscription: 1,
                paths,
                catch_up: false,
                ..
            }) if paths.is_empty()
        ),
        "{:?}",
        notices(&log)
    );
}

#[test]
fn retained_coverage_answers_for_what_it_is_kept_for_and_nothing_else() {
    let fixture = Fixture::new();
    fixture.write(
        "main.yar",
        "include \"../shared/ext.yar\"\ninclude \"../shared/helper.ya\"\ninclude \"../vendor/lib.yar\"\n",
    );
    fixture.write_outside("shared/ext.yar", &rule("ext"));
    fixture.write_outside("shared/helper.ya", &rule("helper"));
    fixture.write_outside("vendor/lib.yar", &rule("lib"));
    let shared = fixture.base.join("shared");
    let vendor = fixture.base.join("vendor");
    let helper = shared.join("helper.ya");
    let wider = plan_for(&fixture);
    assert!(
        wider.is_relevant(&helper, Change::Content),
        "the plan of the day reads this file"
    );

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert!(watchers.is_complete());
    // The instance watching all three locations. It is about to be kept for one of
    // them, which says nothing about the other two.
    let covering = arming.lock().expect("the arming log").gates.len() - 1;

    // The project stops reaching for `vendor` and for `helper.ya`, and the arm that
    // installs the narrower plan cannot take `shared` - so the instance above is kept
    // alive for `shared`, and for nothing else it happens to be watching.
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    arming.lock().expect("the arming log").unwatchable = vec!["shared".to_string()];
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert!(!watchers.is_complete());

    // What it is kept for is what it still holds descriptors for. The rest is not
    // merely uncounted: `vendor` is ground nobody asks for now, and the root is being
    // watched by the replacement, so keeping either would hold a watch for nothing -
    // and holding watches for nothing is what makes an OS refuse the next one.
    let held = watchers.retained_watches();
    assert_eq!(
        scoped(&held, Scope::Directory),
        vec![shared.clone()],
        "{held:?}"
    );
    assert!(scoped(&held, Scope::Tree).is_empty(), "{held:?}");
    assert!(
        !scoped(&watchers.delivered_targets(), Scope::Directory).contains(&vendor),
        "{:?}",
        watchers.delivered_targets()
    );

    let state = arming.lock().expect("the arming log");
    assert!(
        state.gates[covering].is_open(),
        "and it is still delivering"
    );
    let before = notices(&log).len();

    // A rule file appearing under `vendor`. Every plan finds a `.yar` path relevant -
    // discovery would pick it up - so relevance is not what makes this inert: this
    // instance has stopped answering for that location.
    state.routes[covering](appeared(&vendor.join("later.yar")));
    assert_eq!(notices(&log).len(), before, "{:?}", notices(&log));

    // A write to a file the project has stopped reading, inside the location this
    // instance *is* kept for. Its own plan called that relevant; the current plan is
    // what it answers to now.
    state.routes[covering](written(&helper));
    assert_eq!(notices(&log).len(), before, "{:?}", notices(&log));

    // And the coverage it is kept for is delivered, which is the whole reason it was
    // not retired.
    state.routes[covering](written(&shared.join("ext.yar")));
    assert!(
        matches!(
            notices(&log).last(),
            Some(WatchNotice::Changed { subscription: 1, paths }) if paths.iter().any(|p| p.contains("ext.yar"))
        ),
        "{:?}",
        notices(&log)
    );

    // Nor did dropping the old instance's root watch take root coverage with it: the
    // replacement installed that location itself, which is why it was redundant.
    state.routes[covering + 1](appeared(&fixture.root.join("later.yar")));
    assert!(
        matches!(
            notices(&log).last(),
            Some(WatchNotice::Changed { subscription: 1, paths }) if paths.iter().any(|p| p.contains("later.yar"))
        ),
        "{:?}",
        notices(&log)
    );
}

#[test]
fn coverage_that_finally_installs_is_newly_covered_and_announced_as_complete() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    forget(&log);
    arming.lock().expect("the arming log").unwatchable = vec!["shared".to_string()];
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert!(!watchers.is_complete());

    // Whatever was in the way of watching it has gone.
    arming.lock().expect("the arming log").unwatchable.clear();
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    assert!(watchers.is_complete());
    assert!(
        scoped(&watchers.armed_targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "{:?}",
        watchers.armed_targets()
    );
    // Newly covered against what was *installed* before, not against what was asked
    // for before: nothing was watching that directory until now, so the analysis that
    // read it read it unwatched. And only now, with the whole requested plan live, may
    // a notice say coverage is complete.
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [
                WatchNotice::Partial { .. },
                WatchNotice::Covered { subscription: 1, paths, catch_up: true, .. },
            ] if paths.iter().any(|p| p.contains("shared"))
        ),
        "{seen:?}"
    );
}

#[test]
fn a_partly_installed_plan_still_owes_an_analysis_for_what_did_arm() {
    let fixture = Fixture::new();
    fixture.write(
        "main.yar",
        "include \"../shared/ext.yar\"\ninclude \"../vendor/lib.yar\"\n",
    );
    fixture.write_outside("shared/ext.yar", &rule("ext"));
    fixture.write_outside("vendor/lib.yar", &rule("lib"));

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    forget(&log);
    arming.lock().expect("the arming log").unwatchable = vec!["vendor".to_string()];

    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    // One of the two external directories armed, and the analysis that derived the
    // plan read it before it was watched - so that much is owed a catch-up, and the
    // other is owed a retry. One notice, because they are one event.
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [WatchNotice::Partial { subscription: 1, paths, catch_up: true, message, .. }]
                if paths.iter().any(|p| p.contains("shared"))
                    && !paths.iter().any(|p| p.contains("vendor"))
                    && message.contains("vendor")
        ),
        "{seen:?}"
    );

    // The catch-up analysis derives the same plan again. `shared` is already live, so
    // nothing is newly covered and the sequence stops here.
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [
                WatchNotice::Partial { .. },
                WatchNotice::Partial {
                    paths,
                    catch_up: false,
                    ..
                },
            ] if paths.is_empty()
        ),
        "{seen:?}"
    );
}

/// Drives a registry to the state a shrinking holder needs: an instance kept for two
/// external directories, under a plan that also reaches a third.
///
/// `interrupts` is the backend answer every instance armed here gives about unwatching
/// (see [`Arming::narrowing_interrupts`]). Leaves the notice log holding what its three
/// arms announced, so a test reads only what follows them.
fn retained_for_two(fixture: &Fixture, interrupts: bool) -> Handoffs {
    fixture.write(
        "main.yar",
        "include \"../shared/ext.yar\"\ninclude \"../vendor/lib.yar\"\n",
    );
    fixture.write_outside("shared/ext.yar", &rule("ext"));
    fixture.write_outside("vendor/lib.yar", &rule("lib"));
    fixture.write_outside("extra/more.yar", &rule("more"));

    let (watchers, log, arming) = arming();
    arming.lock().expect("the arming log").narrowing_interrupts = interrupts;
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert!(watchers.is_complete(), "both external directories armed");

    // The project reaches for a third directory, and the arm that installs the wider
    // plan can take neither of the two that are already live - so the instance holding
    // them is kept, for both of them.
    fixture.write(
        "main.yar",
        "include \"../shared/ext.yar\"\ninclude \"../vendor/lib.yar\"\ninclude \"../extra/more.yar\"\n",
    );
    arming.lock().expect("the arming log").unwatchable =
        vec!["shared".to_string(), "vendor".to_string()];
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    let held = watchers.retained_watches();
    assert_eq!(
        scoped(&held, Scope::Directory),
        vec![fixture.base.join("shared"), fixture.base.join("vendor")],
        "{held:?}"
    );
    (watchers, log, arming)
}

#[test]
fn shrinking_retained_coverage_owes_one_analysis_where_narrowing_interrupts_delivery() {
    let fixture = Fixture::new();
    let (watchers, log, arming) = retained_for_two(&fixture, true);
    let before = notices(&log).len();

    // This arm takes `shared`, so the holder is kept for `vendor` alone. Dropping its
    // `shared` watch is what restarts the stream that was delivering `vendor`: the
    // coverage this handoff is relying on stops for an instant, and the instant belongs
    // to no event and to no analysis.
    arming.lock().expect("the arming log").unwatchable = vec!["vendor".to_string()];
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    assert_eq!(
        scoped(&watchers.retained_watches(), Scope::Directory),
        vec![fixture.base.join("vendor")],
        "kept for one of the two it was kept for"
    );

    // Nothing was newly installed - `shared` was already being delivered by the very
    // instance this narrowed - and the plan has not changed, so every other reason to
    // owe an analysis says no. The interruption is the only thing this can be owed for.
    let seen = notices(&log)[before..].to_vec();
    assert!(
        matches!(
            seen.as_slice(),
            [WatchNotice::Partial { subscription: 1, paths, catch_up: true, message, .. }]
                if paths.is_empty() && message.contains("vendor")
        ),
        "{seen:?}"
    );

    // And it stops there. The analysis it asked for derives the same plan, which keeps
    // the same holder for the same target, so the second narrowing drops nothing and
    // owes nothing - otherwise a project nobody is touching would analyse itself for
    // ever.
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );
    let seen = notices(&log)[before..].to_vec();
    assert!(
        matches!(
            seen.as_slice(),
            [
                WatchNotice::Partial { catch_up: true, .. },
                WatchNotice::Partial {
                    catch_up: false,
                    ..
                },
            ]
        ),
        "{seen:?}"
    );
}

#[test]
fn shrinking_retained_coverage_owes_nothing_where_a_watch_can_be_dropped_alone() {
    // The same shrink on inotify or Windows, where removing one watch leaves the others
    // delivering. Nothing went unwatched, so nothing is owed - the debt above is the
    // interruption's, not the shrink's.
    let fixture = Fixture::new();
    let (watchers, log, arming) = retained_for_two(&fixture, false);
    let before = notices(&log).len();

    arming.lock().expect("the arming log").unwatchable = vec!["vendor".to_string()];
    watchers.analysed(
        1,
        &fixture.root,
        &crate::project::open_project(&fixture.root),
    );

    let seen = notices(&log)[before..].to_vec();
    assert!(
        matches!(
            seen.as_slice(),
            [WatchNotice::Partial {
                paths,
                catch_up: false,
                ..
            }] if paths.is_empty()
        ),
        "{seen:?}"
    );
}

// --- Which analysis a plan comes from ---

/// The two analyses of one project that the ordering turns on: the project as it was, and
/// the project once it reaches outside itself. Their plans differ in a location that is
/// visible in `armed_targets`, so which of them installed is decidable.
fn two_reads(
    fixture: &Fixture,
) -> [Result<crate::project::ProjectSnapshot, crate::project::ConfigError>; 2] {
    fixture.write("main.yar", &rule("main"));
    let first = crate::project::open_project(&fixture.root);
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));
    let second = crate::project::open_project(&fixture.root);
    [first, second]
}

#[test]
fn an_analysis_that_answers_after_a_newer_one_does_not_install_its_plan() {
    let fixture = Fixture::new();
    let (watchers, log, _arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    // Two analyses of one project in flight at once, which the frontend deliberately
    // allows: a manual Refresh while an automatic one is reading, a catch-up beside
    // either.
    let [r1, r2] = two_reads(&fixture);
    forget(&log);

    // R2 answers first, so it is the snapshot the window shows and its plan is the one to
    // arm.
    watchers.update(
        super::Analysed {
            subscription: 1,
            generation: 2,
        },
        &fixture.root,
        &r2,
    );
    let armed = watchers.instance();
    assert!(
        scoped(&watchers.armed_targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "{:?}",
        watchers.armed_targets()
    );
    let announced = notices(&log).len();

    // And R1 answers last. The frontend has already rejected it by order, so a plan
    // installed from it would have the watcher filtering events through a project the
    // window has replaced - and correcting that on the next analysis would still cost an
    // arm and an announcement about coverage nobody asked for.
    watchers.update(
        super::Analysed {
            subscription: 1,
            generation: 1,
        },
        &fixture.root,
        &r1,
    );

    assert!(
        scoped(&watchers.armed_targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "the newer plan is the one still armed: {:?}",
        watchers.armed_targets()
    );
    assert!(
        scoped(&watchers.targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "and the newer plan is the one still stored: {:?}",
        watchers.targets()
    );
    assert_eq!(watchers.instance(), armed, "nothing was re-armed");
    assert_eq!(
        watchers.reserved(),
        armed,
        "and no identity was spent attempting it"
    );
    assert_eq!(
        notices(&log).len(),
        announced,
        "{:?}",
        notices(&log)[announced..].to_vec()
    );
}

#[test]
fn an_analysis_that_answers_while_a_fence_holds_still_moves_the_ordering_floor() {
    let fixture = Fixture::new();
    let (watchers, log, _arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    let [r1, r2] = two_reads(&fixture);
    forget(&log);

    // An app-owned mutation holds the watcher, so R2 only stores its plan; the release
    // that ends the fence is what installs it.
    let fence = watchers.fence(1);
    watchers.update(
        super::Analysed {
            subscription: 1,
            generation: 2,
        },
        &fixture.root,
        &r2,
    );
    // R1 answers inside the same fence. Storing its plan would be as wrong as arming it:
    // the plan is stored to be armed, and the fence lifting is not an authorisation to
    // install an analysis the frontend has rejected.
    watchers.update(
        super::Analysed {
            subscription: 1,
            generation: 1,
        },
        &fixture.root,
        &r1,
    );

    watchers
        .rearm_after_fence(1, fence)
        .expect("the stored plan arms");
    assert!(
        scoped(&watchers.armed_targets(), Scope::Directory).contains(&fixture.base.join("shared")),
        "{:?}",
        watchers.armed_targets()
    );
}

#[test]
fn a_new_subscription_orders_its_analyses_from_the_beginning_again() {
    let fixture = Fixture::new();
    let (watchers, _log, _arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    let [_r1, r2] = two_reads(&fixture);
    watchers.update(
        super::Analysed {
            subscription: 1,
            generation: 2,
        },
        &fixture.root,
        &r2,
    );

    // The user opens another project. Its analyses are counted from 1 again - the
    // frontend's counter belongs to the selection - so a floor left standing from the
    // project just left would reject the new one's first analysis and leave the watcher on
    // nothing but its root.
    fixture.write_outside("second/main.yar", "include \"../vendor/lib.yar\"\n");
    fixture.write_outside("vendor/lib.yar", &rule("lib"));
    let second = fixture.base.join("second");
    watchers.start(2, &second).expect("the root plan arms");
    watchers.update(
        super::Analysed {
            subscription: 2,
            generation: 1,
        },
        &second,
        &crate::project::open_project(&second),
    );

    assert!(
        scoped(&watchers.armed_targets(), Scope::Directory).contains(&fixture.base.join("vendor")),
        "{:?}",
        watchers.armed_targets()
    );
}

// --- The order notices are delivered in ---

#[test]
fn a_transition_that_finishes_during_a_delivery_is_announced_behind_it() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    // A sink that starts another transition while it is still handling this one. That
    // second transition decides everything about itself - reserves its identity, arms it,
    // builds its notice - before the first notice has finished being delivered, which is
    // the interval the queue exists for.
    //
    // It is also where "the sink is never called with the state lock held" is decided: the
    // sink below takes that lock, so a notice delivered from under it would not merely
    // reorder anything, it would hang here.
    let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let registry: Arc<Mutex<Option<Arc<Watchers>>>> = Arc::new(Mutex::new(None));
    let seen = Arc::clone(&log);
    let hook = Arc::clone(&registry);
    let (armer, _arming) = arming_step();
    let watchers = Arc::new(Watchers::with_test_armer(
        Arc::new(move |notice| {
            let instance = match notice {
                WatchNotice::Covered { instance, .. } => instance,
                other => panic!("every arm here installs its whole plan: {other:?}"),
            };
            seen.lock().expect("the log").push(format!("{instance} in"));
            if instance == 1 {
                let watchers = hook
                    .lock()
                    .expect("the registry")
                    .clone()
                    .expect("the registry is built by now");
                let fence = watchers.fence(1);
                watchers
                    .rearm_after_fence(1, fence)
                    .expect("the stored plan arms again");
            }
            seen.lock()
                .expect("the log")
                .push(format!("{instance} out"));
        }),
        armer,
    ));
    *registry.lock().expect("the registry") = Some(Arc::clone(&watchers));

    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");

    // Neither nested nor reordered. Calling the sink as each notice was built would have
    // run the frontend's handler for the second arm inside its handler for the first - to
    // a single-threaded frontend, the newer arm applying first and the older one applying
    // on top of it, which is exactly what its ordering rule would then discard.
    assert_eq!(
        *log.lock().expect("the log"),
        vec!["1 in", "1 out", "2 in", "2 out"]
    );
}

#[test]
fn a_notice_a_transition_queued_waits_for_it_even_where_another_thread_is_delivering() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    // Two threads, and the interval the holdback is about is the one where a deliverer is
    // already inside a sink call when a transition on another thread queues something. The
    // transition cannot deliver it - somebody has the turn - and the deliverer must not,
    // because the state it describes is still being decided.
    //
    // Four rendezvous, in pairs: one thread reaches a point, and the other lets it past.
    // Nothing here sleeps or polls, so what the assertions describe is an order rather than
    // a duration.
    let delivering = Arc::new(Barrier::new(2));
    let may_return = Arc::new(Barrier::new(2));
    let arming = Arc::new(Barrier::new(2));
    let may_finish = Arc::new(Barrier::new(2));

    let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&log);
    let delivered: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));
    let entered = Arc::clone(&delivering);
    let resume = Arc::clone(&may_return);
    let sink: super::NoticeSink = Arc::new(move |notice| {
        let label = match notice {
            WatchNotice::Covered { instance, .. } => format!("covered {instance}"),
            WatchNotice::Changed { .. } => "changed".to_string(),
            other => panic!("nothing here builds {other:?}"),
        };
        let first = {
            let mut delivered = delivered.lock().expect("the delivery count");
            *delivered += 1;
            *delivered == 1
        };
        seen.lock().expect("the log").push(label);
        if first {
            // Logged, and then held here: whatever the other thread does next, it does
            // with this delivery still in progress.
            entered.wait();
            resume.wait();
        }
    });

    // An arm that emits from inside itself and then stays there, holding open the
    // transition that is arming it - the state the drainer must not deliver through.
    let (inner, _arming) = arming_step();
    let arms: Mutex<usize> = Mutex::new(0);
    let inside = Arc::clone(&arming);
    let finish = Arc::clone(&may_finish);
    let armer: super::Armer = Arc::new(move |plan, sink: native::SinkFn| {
        let nth = {
            let mut arms = arms.lock().expect("the arm count");
            *arms += 1;
            *arms
        };
        if nth == 2 {
            sink(Signal::Changed(vec![PathBuf::from(HANDED_OVER)]));
            inside.wait();
            finish.wait();
        }
        inner(plan, sink)
    });

    let watchers = Arc::new(Watchers::with_test_armer(sink, armer));
    let publisher = {
        let watchers = Arc::clone(&watchers);
        let root = fixture.root.clone();
        std::thread::spawn(move || watchers.start(1, &root).expect("the root plan arms"))
    };
    // One thread is inside the sink, holding neither lock and holding the turn.
    delivering.wait();
    let transition = {
        let watchers = Arc::clone(&watchers);
        std::thread::spawn(move || {
            let fence = watchers.fence(1);
            watchers
                .rearm_after_fence(1, fence)
                .expect("the stored plan arms again");
        })
    };
    // The other is inside its arm, with its transition open and a notice queued behind it.
    arming.wait();

    // The first delivery finishes while that transition is still running.
    may_return.wait();
    publisher.join().expect("the publishing thread");
    let while_open = log.lock().expect("the log").clone();

    may_finish.wait();
    transition.join().expect("the transitioning thread");
    let afterwards = log.lock().expect("the log").clone();

    // The deliverer gave its turn up rather than reporting a change to a plan another
    // thread had not finished installing - which is the same guarantee the re-entrant
    // case gets, against a transition it does not run inside of.
    assert_eq!(while_open, vec!["covered 1"]);
    // And the transition that queued it took the turn back when it finished, in the order
    // the queue was holding: nothing was stranded by the deliverer letting go.
    assert_eq!(afterwards, vec!["covered 1", "changed", "covered 2"]);
}

// --- Which instance a notice is about ---

#[test]
fn starting_a_project_announces_the_arm_it_made_and_owes_nothing() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, log, _arming) = arming();
    watchers.start(1, &fixture.root).expect("the plan arms");

    // Retiring an instance does not stop its thread, so a `Failed` from one that has
    // been replaced can arrive after its replacement is live. The frontend orders that
    // out by instance, and these announcements are the only thing telling it which
    // instance is newest - so every arm makes one, on the same channel the errors
    // arrive on. This one carries no paths and owes no analysis: the project's first
    // analysis follows this call and reads everything anyway.
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [WatchNotice::Covered { subscription: 1, instance, paths, catch_up: false }]
                if *instance == watchers.instance() && paths.is_empty()
        ),
        "{seen:?}"
    );
}

#[test]
fn an_error_from_a_retained_instance_names_it_while_its_changes_stay_unstamped() {
    let fixture = Fixture::new();
    let (watchers, log, arming) = retained_for_two(&fixture, false);
    let live = watchers.instance();

    // The last thing the frontend was told is which instance the handoff armed. That is
    // the high-water mark an obsolete error has to be older than.
    let seen = notices(&log);
    assert!(
        matches!(
            seen.last(),
            Some(WatchNotice::Partial { instance, .. }) if *instance == live
        ),
        "{seen:?}"
    );
    let before = seen.len();

    let state = arming.lock().expect("the arming log");
    // The instance kept for `shared` and `vendor`, which is older than the one that
    // replaced it and is still the only thing delivering them.
    let holder = state.routes.len() - 2;
    state.routes[holder](Err(notify::Error::generic("event queue overflowed")));
    state.routes[holder](written(&fixture.base.join("vendor/lib.yar")));
    drop(state);

    let seen = notices(&log)[before..].to_vec();
    assert!(
        matches!(
            seen.as_slice(),
            [
                WatchNotice::Failed { subscription: 1, instance, message },
                WatchNotice::Changed { subscription: 1, paths },
            ] if *instance == holder as u64 + 1
                && *instance < live
                && message.contains("overflowed")
                && paths.iter().any(|p| p.contains("lib.yar"))
        ),
        "an error names the instance it came from, and a change names none: {seen:?}"
    );

    // The live instance's own error names the live instance, which is what keeps a real
    // degradation from being ordered out along with the obsolete ones.
    let state = arming.lock().expect("the arming log");
    state.routes[live as usize - 1](Err(notify::Error::generic("event queue overflowed")));
    drop(state);
    assert!(
        matches!(
            notices(&log).last(),
            Some(WatchNotice::Failed { instance, .. }) if *instance == live
        ),
        "{:?}",
        notices(&log)
    );
}

#[test]
fn a_failure_reported_while_arming_carries_the_identity_its_announcement_then_carries() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, log, arming) = arming();
    arming.lock().expect("the arming log").reports = 1;

    watchers.start(1, &fixture.root).expect("the plan arms");

    // The other half of the ordering. A handler is installed before the arm returns, so
    // an instance can report trouble before the notice announcing it is sent: the
    // announcement is then news about the very watcher that failed, and no evidence that
    // anything recovered. Both notices naming the same instance is what lets the frontend
    // tell that from a replacement's announcement, and keep the degradation.
    let seen = notices(&log);
    assert!(
        matches!(
            seen.as_slice(),
            [
                WatchNotice::Failed { subscription: 1, instance: failed, message },
                WatchNotice::Covered { subscription: 1, instance: covered, .. },
            ] if failed == covered
                && *covered == watchers.instance()
                && message.contains("trouble")
        ),
        "{seen:?}"
    );
}

#[test]
fn an_arm_that_reported_before_it_failed_does_not_lend_its_identity_to_the_next() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    let live = watchers.instance();
    forget(&log);

    // An arm that gets as far as reporting and then cannot finish. Nothing it emitted is
    // retractable, so the identity it emitted under is spent.
    {
        let mut state = arming.lock().expect("the arming log");
        state.reports = 1;
        state.refuse = 1;
    }
    let fence = watchers.fence(1);
    watchers
        .rearm_after_fence(1, fence)
        .expect_err("the test's armer refuses");

    let attempted = match notices(&log).as_slice() {
        [WatchNotice::Failed { instance, .. }] => *instance,
        seen => panic!("a failure from the arm that was in flight: {seen:?}"),
    };
    assert!(attempted > live, "{attempted} is newer than {live}");
    assert!(!watchers.is_armed(), "and it left nothing delivering");
    forget(&log);

    // So the next arm is a different watcher and says so. Recording an identity only on
    // success would give this arm the number the failure above carries, and its
    // announcement would clear a degradation reported by a watcher that never delivered
    // anything and is not coming back.
    let fence = watchers.fence(1);
    watchers.rearm_after_fence(1, fence).expect("the plan arms");
    let armed = watchers.instance();

    assert!(armed > attempted, "{armed} is newer than {attempted}");
    assert_eq!(
        watchers.reserved(),
        armed,
        "identities are handed out in order, and the spent one is not reissued"
    );
    assert!(
        matches!(
            notices(&log).as_slice(),
            [WatchNotice::Covered { instance, .. }] if *instance == armed
        ),
        "{:?}",
        notices(&log)
    );
}

#[test]
fn a_rearm_that_armed_nothing_rejects_with_the_identity_its_attempt_reserved() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    let retired = watchers.instance();
    forget(&log);

    // An arm that fails without its handler having emitted anything, so there is no notice
    // on the channel to order the rejection by - and the rejection travels on the channel
    // the call that asked for it is waiting on, which says nothing about where it lands
    // relative to the announcement of the coverage this fence just retired.
    arming.lock().expect("the arming log").refuse = 1;
    let fence = watchers.fence(1);
    let failure = watchers
        .rearm_after_fence(1, fence)
        .expect_err("the test's armer refuses");

    // So the rejection carries a number of its own: the one the attempt reserved before
    // arming. Strictly newer than every notice built before it, which is what stops a
    // delayed announcement of the retired instance from answering this failure, and
    // strictly older than the next arm's, which is what lets a real recovery clear it.
    assert!(
        failure.attempt > Some(retired),
        "{:?} is newer than {retired}",
        failure.attempt
    );
    assert_eq!(
        failure.attempt,
        Some(watchers.reserved()),
        "the identity the attempt spent, not the one that is live"
    );
    assert!(failure.message.contains("refuses"), "{failure:?}");
    // Nothing is armed and nothing was announced: naming that identity silences no live
    // instance, because no arm will ever carry it.
    assert!(!watchers.is_armed());
    assert!(notices(&log).is_empty(), "{:?}", notices(&log));

    let fence = watchers.fence(1);
    watchers.rearm_after_fence(1, fence).expect("the plan arms");
    let armed = watchers.instance();
    assert!(
        Some(armed) > failure.attempt,
        "{armed} is newer than {:?}",
        failure.attempt
    );
    assert!(
        matches!(
            notices(&log).as_slice(),
            [WatchNotice::Covered { instance, .. }] if *instance == armed
        ),
        "{:?}",
        notices(&log)
    );
}

#[test]
fn an_arm_that_panicked_rejects_with_the_identity_it_had_already_reserved() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (watchers, log, arming) = arming();
    watchers
        .start(1, &fixture.root)
        .expect("the root plan arms");
    let retired = watchers.instance();
    forget(&log);

    // The arming step is foreign code reached with an identity already spent, so a panic
    // in it is an arming outcome and not a failure that reserved nothing: a watcher it
    // installed before panicking is delivering under that very number.
    arming.lock().expect("the arming log").panic = 1;
    let fence = watchers.fence(1);
    let failure = watchers
        .rearm_after_fence(1, fence)
        .expect_err("the test's armer panics");

    assert_eq!(
        failure.attempt,
        Some(watchers.reserved()),
        "the identity the attempt reserved, not the one nothing reserved"
    );
    assert!(
        failure.attempt > Some(retired),
        "{:?} is newer than {retired}",
        failure.attempt
    );
    assert!(failure.message.contains("panicked"), "{failure:?}");
    assert!(
        failure.message.contains("the test's armer panics"),
        "what it said is what the user is told: {failure:?}"
    );
    assert!(!watchers.is_armed());
    assert!(notices(&log).is_empty(), "{:?}", notices(&log));

    // And the registry is left usable, because catching the panic is what makes it an
    // answer rather than a lost task: the next arm is newer than the attempt and clears
    // the degradation in the ordinary way.
    let fence = watchers.fence(1);
    watchers.rearm_after_fence(1, fence).expect("the plan arms");
    let armed = watchers.instance();
    assert!(
        Some(armed) > failure.attempt,
        "{armed} is newer than {:?}",
        failure.attempt
    );
    assert!(
        matches!(
            notices(&log).as_slice(),
            [WatchNotice::Covered { instance, .. }] if *instance == armed
        ),
        "{:?}",
        notices(&log)
    );
}

#[test]
fn only_a_failure_that_reserved_nothing_names_no_attempt() {
    // The rule the two outcomes are told apart by, stated on its own. The counter is read
    // under the lock the attempt held and compared with what that hold began with, so a
    // reservation is proved by the number having moved - and 0 is proof that it did not,
    // rather than an admission that the answer was unavailable by then.
    assert_eq!(super::attempted(7, 8), 8, "the attempt spent 8");
    assert_eq!(super::attempted(7, 7), 0, "nothing was reserved");
}

#[test]
fn a_failure_nobody_could_attribute_names_nothing_rather_than_none() {
    // The third outcome, and the reason the identity is an `Option` rather than a number
    // with 0 doing double duty. A task that did not come back left the counter unreadable -
    // another attempt may have advanced it since - so what this says is that the answer is
    // unknown. It must not be mistaken for the answer "nothing was reserved", which is a
    // degradation any arm at all may clear.
    let lost = super::ArmFailure::from("watcher task panicked: JoinError".to_string());
    assert_eq!(lost.attempt, None, "unknown, and not 0");
    assert!(
        lost.message.contains("panicked"),
        "and it still says what happened: {lost:?}"
    );
}

// --- One real watcher ---

/// Waits for a `Changed` notice naming `needle`, returning every notice seen up
/// to and including it.
fn drain_until(rx: &Receiver<WatchNotice>, needle: &str) -> Vec<WatchNotice> {
    let mut seen = Vec::new();
    loop {
        let notice = rx
            .recv_timeout(DELIVERY)
            .unwrap_or_else(|e| panic!("waiting for {needle}: {e}; saw {seen:?}"));
        let found = match &notice {
            WatchNotice::Changed { paths, .. } => paths.iter().any(|p| p.contains(needle)),
            WatchNotice::Covered { .. }
            | WatchNotice::Partial { .. }
            | WatchNotice::Failed { .. } => false,
        };
        seen.push(notice);
        if found {
            return seen;
        }
    }
}

/// Windows unwatch is asynchronous: late events from the removed nested watch
/// must be rejected even though its parent is still watched non-recursively.
#[test]
fn narrowed_directory_rejects_late_descendant_events_but_keeps_its_entries() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", "include \"nested/deep.yar\"\n");
    fixture.write_outside("shared/nested/deep.yar", &rule("deep"));
    let plan = Arc::new(plan_for(&fixture));
    let nested = fixture.base.join("shared").join("nested");
    let deep = nested.join("deep.yar");
    let (tx, rx) = std::sync::mpsc::channel();
    let (mut instance, _gate, route) = native::inert(
        Arc::clone(&plan),
        plan.targets().to_vec(),
        false,
        Box::new(move |signal| tx.send(signal).unwrap()),
    );
    route(written(&deep));
    assert!(matches!(rx.try_recv(), Ok(Signal::Changed(paths)) if paths == vec![deep.clone()]));

    let kept: Vec<_> = plan
        .targets()
        .iter()
        .filter(|t| t.path != nested)
        .cloned()
        .collect();
    instance.narrow(plan, &kept);
    // Model a callback delivered after unwatch returns, without a timing race.
    route(written(&deep));
    route(appeared(&deep));
    assert!(
        rx.try_recv().is_err(),
        "removed nested watch must be silent"
    );

    // A directory watch still covers itself and direct entries, including a
    // subdirectory being removed/renamed. The recursive project watch keeps depth.
    for path in [
        fixture.base.join("shared"),
        fixture.base.join("shared").join("ext.yar"),
        nested,
        fixture.root.join("nested").join("deep.yar"),
    ] {
        route(appeared(&path));
        assert!(matches!(rx.try_recv(), Ok(Signal::Changed(paths)) if paths == vec![path]));
    }
}

/// Narrowing a real watcher keeps its remaining locations delivering while
/// filtering any late events from a removed nested watch.
#[test]
fn narrowing_a_real_instance_keeps_delivering_what_it_is_kept_for() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", "include \"nested/deep.yar\"\n");
    fixture.write_outside("shared/nested/deep.yar", &rule("deep"));

    let plan = Arc::new(plan_for(&fixture));
    let (tx, rx) = std::sync::mpsc::channel();
    let mut coverage = native::arm(
        Arc::clone(&plan),
        Box::new(move |signal| {
            let _ = tx.send(signal);
        }),
    )
    .expect("the root and both external directories are watchable");
    let nested = fixture.base.join("shared").join("nested");
    assert_eq!(
        scoped(&coverage.installed, Scope::Directory),
        vec![fixture.base.join("shared"), nested.clone()],
        "each external source's own parent directory: {:?}",
        coverage.installed
    );

    // Kept for everything except the nested directory, as a handoff keeps an instance
    // for the part of its coverage the replacement could not duplicate. The watch it is
    // no longer answering for goes, and the descriptor with it - which is not observable
    // from here, only its consequence is.
    let kept: Vec<WatchTarget> = coverage
        .installed
        .iter()
        .filter(|target| target.path != nested)
        .cloned()
        .collect();
    let interrupted = coverage.instance.narrow(Arc::clone(&plan), &kept);
    assert_eq!(coverage.instance.watching(), kept.as_slice());
    // An instance armed by `native::arm` answers for its own backend, which is what the
    // handoff tests can only be told. On macOS the unwatch above restarted the event
    // stream and the kept coverage is owed a catch-up; elsewhere one watch goes and the
    // others carry on, as the deliveries below then demonstrate.
    assert_eq!(interrupted, cfg!(target_os = "macos"));

    // These directories have separate OS watches; their callbacks need not arrive
    // in write order. Wait for both retained locations below.
    fixture.write_outside("shared/nested/deep.yar", &rule("deeper"));
    fixture.write_outside("shared/ext.yar", "include \"nested/deep.yar\"\n\n");
    fixture.write("added.yar", &rule("added"));

    let mut reported: Vec<String> = Vec::new();
    let mut saw_project = false;
    let mut saw_external = false;
    while !saw_project || !saw_external {
        match rx
            .recv_timeout(DELIVERY)
            .unwrap_or_else(|e| panic!("waiting for retained locations: {e}; saw {reported:?}"))
        {
            Signal::Changed(paths) => {
                let named: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
                saw_project |= named.iter().any(|path| path.contains("added.yar"));
                saw_external |= named.iter().any(|path| path.contains("ext.yar"));
                reported.extend(named);
            }
            Signal::Failed(message) => panic!("the watcher failed: {message}"),
        }
    }
    assert!(
        !reported.iter().any(|path| path.contains("deep.yar")),
        "the location it was not kept for reported nothing: {reported:?}"
    );
    assert!(
        reported.iter().any(|path| path.contains("ext.yar")),
        "and the directory it was kept for went on delivering: {reported:?}"
    );
}

#[test]
fn a_real_watcher_delivers_changes_and_a_fence_stops_them() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let (tx, rx) = std::sync::mpsc::channel();
    let watchers = Watchers::new(Arc::new(move |notice| {
        let _ = tx.send(notice);
    }));
    watchers
        .start(1, &fixture.root)
        .expect("the root is watchable");

    fixture.write("added.yar", &rule("added"));
    let seen = drain_until(&rx, "added.yar");
    assert!(
        seen.iter().all(|notice| matches!(
            notice,
            WatchNotice::Changed {
                subscription: 1,
                ..
            } | WatchNotice::Covered {
                subscription: 1,
                ..
            }
        )),
        "every notice carries the subscription that asked for it: {seen:?}"
    );

    // Closing the gate before the write is what stops Quipu's own save being
    // reported back to it: a callback that reads a closed gate reports nothing, and
    // one that read it earlier was describing the disk before the write. The
    // instance armed afterwards cannot report the write either - it did not exist
    // when it happened.
    let fence = watchers.fence(1);
    fixture.write("fenced.yar", &rule("fenced"));
    watchers.rearm_after_fence(1, fence).expect("re-armed");
    fixture.write("after.yar", &rule("after"));

    let seen = drain_until(&rx, "after.yar");
    let reported: Vec<String> = seen
        .iter()
        .filter_map(|notice| match notice {
            WatchNotice::Changed { paths, .. } => Some(paths.clone()),
            WatchNotice::Covered { .. }
            | WatchNotice::Partial { .. }
            | WatchNotice::Failed { .. } => None,
        })
        .flatten()
        .collect();
    assert!(
        !reported.iter().any(|path| path.contains("fenced.yar")),
        "the fenced write was not reported: {reported:?}"
    );
    // A notice is a hint: paths for diagnostics, never the bytes that changed.
    assert!(
        !reported.iter().any(|path| path.contains("condition")),
        "a notice never carries file contents: {reported:?}"
    );
}
