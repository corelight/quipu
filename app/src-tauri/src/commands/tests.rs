//! Tests for the shared-ruleset lifecycle.
//!
//! Two invariants are under test. No unsuccessful compile may leave an older
//! ruleset available to Scan; and no compile may install a result after it has
//! been superseded. Both are properties of [`store`] and [`RuleStore`], so these
//! drive them directly rather than through a Tauri application - which is why
//! `store` takes the ruleset by handle instead of by `State`.

use std::sync::Arc;
use std::sync::mpsc;

use crate::testing::{Fixture, rule};

use super::*;

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}

/// Compiles a project through the real command path.
fn compile(shared: &SharedRules, root: &std::path::Path) -> Result<CompileResponse, String> {
    let root = root.to_path_buf();
    block_on(store(shared, move || crate::compile::project(&root)))
}

fn stored(shared: &SharedRules) -> bool {
    shared.with_rules(|rules| rules.is_some())
}

fn cache_for(fixture: &Fixture) -> SharedCache {
    new_shared_cache(fixture.base.join("cache"), fixture.base.join("config"))
}

fn project_cache_exists(cache: &CacheManager, root: &std::path::Path) -> bool {
    cache
        .effective_path()
        .join("projects")
        .join(crate::cache::ProjectId::for_root(root).as_str())
        .join("default")
        .join("metadata.json")
        .is_file()
}

fn seed_project_cache(cache: &CacheManager, root: &std::path::Path) {
    let proposal = match project_work(cache, root) {
        ProjectWork::Ready {
            persistence:
                ProjectPersistence::Prepared(crate::cache::PrepareOutcome::Prepared(proposal)),
            ..
        } => proposal,
        _ => panic!("the fixture should compile into a cache proposal"),
    };
    assert_eq!(
        cache.commit(proposal),
        crate::cache::CommitOutcome::Committed
    );
}

#[test]
fn compile_trace_reports_persistence_and_reuse() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("traced_cache"));
    let cache = cache_for(&fixture);
    let shared = new_shared_rules();
    let (trace, lines) = crate::debug_trace::DebugTrace::captured();
    for _ in 0..2 {
        let result = tauri::async_runtime::block_on(store_project_observed(
            &shared,
            &cache,
            fixture.root.clone(),
            Some(&trace),
        ))
        .expect("compile command");
        assert!(result.ok);
    }
    assert!(trace.flush());
    let records: Vec<serde_json::Value> = lines
        .lock()
        .expect("trace")
        .iter()
        .map(|line| serde_json::from_str(line).expect("JSON trace"))
        .collect();
    for outcome in ["prepared", "Committed", "not_needed"] {
        assert!(
            records
                .iter()
                .any(|record| record["event"] == "cache_persistence"
                    && record["fields"]["outcome"] == outcome),
            "missing {outcome}"
        );
    }
    assert!(
        records
            .iter()
            .any(|record| record["event"] == "cache_persistence"
                && record["fields"]["stage"] == "maintenance"
                && record["fields"]["currentProjectCached"] == true)
    );
}

fn restore_work(
    cache: &CacheManager,
    root: &std::path::Path,
    after_load: impl FnOnce(),
) -> RestoreWork {
    let snapshot = crate::project::open_project(root);
    restore_from_snapshot(cache, root, &snapshot, after_load)
}

/// A compile suspended partway through, so the test can act while it is in
/// flight.
///
/// `started` fires once the compile is inside its blocking task - which is after
/// [`store`] has captured its generation - and the compile then waits for
/// `release`. There are no sleeps and no timing assumptions anywhere: the
/// interleaving under test is the only one the channels permit.
struct SuspendedCompile {
    handle: tauri::async_runtime::JoinHandle<Result<CompileResponse, String>>,
    release: mpsc::Sender<()>,
}

impl SuspendedCompile {
    /// Starts a compile of `rule_name` and returns once it is suspended.
    fn start(shared: &SharedRules, rule_name: &'static str) -> Self {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let shared = shared.clone();

        let handle = tauri::async_runtime::spawn(async move {
            store(&shared, move || {
                started_tx.send(()).expect("the test is waiting");
                release_rx.recv().expect("the test releases the compile");
                crate::compile::scratch(&rule(rule_name))
            })
            .await
        });

        started_rx.recv().expect("the compile reaches its work");
        Self {
            handle,
            release: release_tx,
        }
    }

    /// Lets the compile finish and returns its response.
    fn finish(self) -> Result<CompileResponse, String> {
        self.release.send(()).expect("the compile is waiting");
        block_on(self.handle).expect("the task joins")
    }
}

#[test]
fn a_successful_compile_persists_rules_that_can_then_scan() {
    let fixture = Fixture::new();
    fixture.write(
        "main.yar",
        "rule finds_needle { strings: $a = \"needle\" condition: $a }\n",
    );
    let shared = new_shared_rules();

    let response = compile(&shared, &fixture.root).expect("not an infrastructure failure");

    assert!(response.ok);
    assert_eq!(response.rule_count, 1);
    assert!(response.diagnostics.is_empty());

    // The persisted ruleset is what a subsequent Scan uses, so scanning it is the
    // only assertion that proves the compile was actually useful.
    let matched = shared.with_rules(|rules| {
        let rules = rules.expect("rules are persisted for the next scan");
        let mut scanner = Scanner::new(rules);
        collect_matches(
            scanner
                .scan(b"a haystack with a needle in it")
                .expect("scan"),
        )
    });

    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].rule, "finds_needle");
    assert_eq!(matched[0].matches[0].data, "needle");
}

#[test]
fn a_failed_recompilation_clears_the_previously_compiled_ruleset() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));
    let shared = new_shared_rules();

    assert!(compile(&shared, &fixture.root).expect("first compile").ok);
    assert!(stored(&shared));

    // Break the project the same way a user would: an include that resolves to
    // nothing.
    fixture.write("main.yar", "include \"nowhere.yar\"\n");
    let response = compile(&shared, &fixture.root).expect("a user error is not an IPC failure");

    assert!(!response.ok);
    assert_eq!(response.rule_count, 0);
    assert!(
        !stored(&shared),
        "a failed compile must not leave the old rules scannable"
    );
}

#[test]
fn a_configuration_failure_answers_with_a_response_and_clears_the_ruleset() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));
    let shared = new_shared_rules();

    assert!(compile(&shared, &fixture.root).expect("first compile").ok);
    fixture.manifest("schema = 2\n");
    let response = compile(&shared, &fixture.root).expect("a user error is not an IPC failure");

    assert!(!response.ok);
    assert_eq!(response.diagnostics.len(), 1);
    assert_eq!(response.diagnostics[0].code, "manifest-unsupported-schema");
    assert!(!stored(&shared));
}

#[test]
fn a_scratch_compile_persists_its_rules_too() {
    let shared = new_shared_rules();

    let response = block_on(store(&shared, || crate::compile::scratch(&rule("kept"))))
        .expect("not an infrastructure failure");

    assert!(response.ok);
    assert_eq!(response.rule_count, 1);
    assert!(stored(&shared));
}

#[test]
fn a_compile_task_that_dies_leaves_no_rules_behind() {
    let shared = new_shared_rules();
    block_on(store(&shared, || crate::compile::scratch(&rule("kept")))).expect("first compile");
    assert!(stored(&shared));

    // An infrastructure failure may reject the IPC call, but it must invalidate
    // the ruleset all the same - which is why `store` clears before it spawns
    // rather than after it returns.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = block_on(store(&shared, || {
        panic!("simulated infrastructure failure")
    }));
    std::panic::set_hook(previous);

    let error = match outcome {
        Ok(_) => panic!("expected the task's death to be surfaced"),
        Err(error) => error,
    };

    assert!(error.contains("compile task panicked"), "{error}");
    assert!(!stored(&shared));
}

// --- Superseded compilations -----------------------------------------------

#[test]
fn a_suspended_compile_that_is_never_superseded_does_store_its_result() {
    let shared = new_shared_rules();

    // The control for the two tests below: without this, they could pass because
    // the suspended compile never got as far as trying to store anything.
    let response = SuspendedCompile::start(&shared, "kept")
        .finish()
        .expect("not an infrastructure failure");

    assert!(response.ok);
    assert_eq!(response.rule_count, 1);
    assert!(stored(&shared));
}

#[test]
fn a_reset_while_compiling_stops_that_compile_from_restoring_its_rules() {
    let shared = new_shared_rules();
    // Rules from the project the user is about to close.
    block_on(store(&shared, || {
        crate::compile::scratch(&rule("project_a"))
    }))
    .expect("first compile");
    assert!(stored(&shared));

    let in_flight = SuspendedCompile::start(&shared, "project_a_recompiled");

    // The user opens another folder: `reset_rules` runs while A's compile is still
    // in its blocking task, holding a result it is about to try to store.
    shared.reset();
    assert!(!stored(&shared));

    let response = in_flight.finish().expect("not an infrastructure failure");

    assert!(
        !response.ok,
        "a superseded compile must not report a ruleset that is not there"
    );
    assert_eq!(response.rule_count, 0);
    assert!(response.diagnostics.is_empty());
    assert!(
        !stored(&shared),
        "the reset must win: a compile that captured an older generation may not \
         restore rules the store has been told to forget"
    );
}

#[test]
fn a_newer_compile_supersedes_an_older_one_still_in_flight() {
    let shared = new_shared_rules();

    let older = SuspendedCompile::start(&shared, "older");

    // A second compile starts and completes entirely while the first is suspended.
    let newer = block_on(store(&shared, || crate::compile::scratch(&rule("newer"))))
        .expect("the newer compile");
    assert!(newer.ok);

    let response = older.finish().expect("not an infrastructure failure");

    assert!(!response.ok, "the older compile has been superseded");

    // The newer result is what remains: an older compile is discarded, never
    // allowed to clear rules that a later one legitimately installed.
    let names = shared.with_rules(|rules| {
        rules
            .expect("the newer compile's rules survive")
            .iter()
            .map(|r| r.identifier().to_string())
            .collect::<Vec<_>>()
    });
    assert_eq!(names, ["newer"]);
}

// --- Project cache integration --------------------------------------------

#[test]
fn a_compile_miss_invokes_yara_once_and_the_next_hit_not_at_all() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("cached"));
    let cache = cache_for(&fixture);
    let calls = std::cell::Cell::new(0);

    let first = project_work_with(
        &cache,
        &fixture.root,
        |plan| {
            calls.set(calls.get() + 1);
            crate::compile::compile_plan(plan)
        },
        || {},
        || {},
    );
    let proposal = match first {
        ProjectWork::Ready {
            persistence:
                ProjectPersistence::Prepared(crate::cache::PrepareOutcome::Prepared(proposal)),
            ..
        } => proposal,
        _ => panic!("a miss should compile and propose persistence"),
    };
    assert_eq!(calls.get(), 1);
    assert_eq!(
        cache.commit(proposal),
        crate::cache::CommitOutcome::Committed
    );

    let second = project_work_with(
        &cache,
        &fixture.root,
        |_| panic!("a valid hit must not invoke YARA-X"),
        || {},
        || {},
    );
    assert!(matches!(
        second,
        ProjectWork::Ready {
            persistence: ProjectPersistence::NotNeeded,
            ..
        }
    ));
}

#[test]
fn a_source_change_after_load_installs_no_hit_and_falls_through_to_fresh_compilation() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("before"));
    let cache = cache_for(&fixture);
    let initial = project_work(cache.as_ref(), &fixture.root);
    let proposal = match initial {
        ProjectWork::Ready {
            persistence:
                ProjectPersistence::Prepared(crate::cache::PrepareOutcome::Prepared(proposal)),
            ..
        } => proposal,
        _ => panic!("initial compile"),
    };
    assert_eq!(
        cache.commit(proposal),
        crate::cache::CommitOutcome::Committed
    );
    let calls = std::cell::Cell::new(0);

    let work = project_work_with(
        &cache,
        &fixture.root,
        |plan| {
            calls.set(calls.get() + 1);
            crate::compile::compile_plan(plan)
        },
        || {
            fixture.write("main.yar", &rule("after"));
        },
        || {},
    );
    assert_eq!(calls.get(), 1, "the stale deserialized hit was not used");
    let compiled = match work {
        ProjectWork::Ready { compiled, .. } => compiled,
        _ => panic!("the new observation should compile"),
    };
    let names = compiled
        .rules
        .expect("fresh rules")
        .iter()
        .map(|rule| rule.identifier().to_string())
        .collect::<Vec<_>>();
    assert_eq!(names, ["after"]);
}

#[test]
fn a_post_compile_fingerprint_change_discards_rules_before_store_finish() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("before"));
    let cache = cache_for(&fixture);
    let shared = new_shared_rules();
    let generation = shared.begin();

    let work = project_work_with(
        &cache,
        &fixture.root,
        crate::compile::compile_plan,
        || {},
        || {
            fixture.write("main.yar", &rule("changed_while_compiling"));
        },
    );
    let source_changed = match work {
        ProjectWork::SourceChanged => true,
        ProjectWork::Ready { compiled, .. } => {
            // This is exactly what store_project would do if project_work let
            // changed rules escape. Keeping it in the test makes weakening the
            // post-compile check prove that stale Rules become scannable, rather
            // than merely changing an internal enum arm.
            shared.finish(generation, *compiled.rules.expect("ready rules"));
            false
        }
        ProjectWork::Failed(_) => false,
    };
    assert!(!stored(&shared));
    assert!(source_changed);
    let project = crate::cache::ProjectId::for_root(&fixture.root);
    assert!(
        !cache
            .effective_path()
            .join("projects")
            .join(project.as_str())
            .join("default")
            .join("metadata.json")
            .exists()
    );
}

#[test]
fn clear_current_after_compilation_starts_prevents_that_compile_reappearing() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("clear_current"));
    let cache = cache_for(&fixture);

    let work = project_work_with(
        &cache,
        &fixture.root,
        crate::compile::compile_plan,
        || {},
        || {
            assert_eq!(
                cache.clear_current(&fixture.root),
                crate::cache::ClearOutcome::Cleared
            );
        },
    );

    assert!(matches!(
        work,
        ProjectWork::Ready {
            persistence: ProjectPersistence::Prepared(crate::cache::PrepareOutcome::Declined(
                crate::cache::PersistenceDecline::Cleared
            )),
            ..
        }
    ));
    assert!(!project_cache_exists(&cache, &fixture.root));
}

#[test]
fn clear_all_after_compilation_starts_prevents_that_compile_reappearing() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("clear_all"));
    let cache = cache_for(&fixture);

    let work = project_work_with(
        &cache,
        &fixture.root,
        crate::compile::compile_plan,
        || {},
        || {
            assert_eq!(cache.clear_all(), crate::cache::ClearOutcome::Cleared);
        },
    );

    assert!(matches!(
        work,
        ProjectWork::Ready {
            persistence: ProjectPersistence::Prepared(crate::cache::PrepareOutcome::Declined(
                crate::cache::PersistenceDecline::Cleared
            )),
            ..
        }
    ));
    assert!(!project_cache_exists(&cache, &fixture.root));
}

#[test]
fn disable_then_reenable_cannot_revive_a_compile_started_before_disable() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("settings_barrier"));
    let cache = cache_for(&fixture);

    let work = project_work_with(
        &cache,
        &fixture.root,
        crate::compile::compile_plan,
        || {},
        || {
            cache
                .update_settings(
                    CacheSettings {
                        enabled: false,
                        ..CacheSettings::default()
                    },
                    Some(&fixture.root),
                )
                .expect("disable");
            cache
                .update_settings(CacheSettings::default(), Some(&fixture.root))
                .expect("re-enable");
        },
    );

    assert!(cache.settings().enabled);
    assert!(matches!(
        work,
        ProjectWork::Ready {
            persistence: ProjectPersistence::Prepared(crate::cache::PrepareOutcome::Declined(
                crate::cache::PersistenceDecline::Superseded
            )),
            ..
        }
    ));
    assert!(!project_cache_exists(&cache, &fixture.root));
}

#[test]
fn a_compile_started_after_clear_captures_a_new_claim_and_commits() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("new_claim"));
    let cache = cache_for(&fixture);
    assert_eq!(cache.clear_all(), crate::cache::ClearOutcome::Cleared);

    let proposal = match project_work(&cache, &fixture.root) {
        ProjectWork::Ready {
            persistence:
                ProjectPersistence::Prepared(crate::cache::PrepareOutcome::Prepared(proposal)),
            ..
        } => proposal,
        _ => panic!("newer compilation should receive a cache proposal"),
    };
    assert_eq!(
        cache.commit(proposal),
        crate::cache::CommitOutcome::Committed
    );
    assert!(project_cache_exists(&cache, &fixture.root));
}

#[test]
fn unavailable_cache_storage_does_not_change_compile_success() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("fresh"));
    let blocker = fixture.base.join("not-a-directory");
    std::fs::write(&blocker, b"block").expect("blocker");
    let cache = Arc::new(CacheManager::new(blocker, fixture.base.join("config")));
    let shared = new_shared_rules();

    let response = block_on(store_project(&shared, &cache, fixture.root.clone()))
        .expect("cache failure is not a compile failure");
    assert!(response.ok);
    assert!(stored(&shared));
    assert_eq!(
        cache.warning().as_deref(),
        Some("compiled cache preparation or serialization is unavailable")
    );
}

#[test]
fn prepare_failure_remains_typed_and_observable_after_successful_compilation() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("fresh"));
    let cache = cache_for(&fixture);

    let work = project_work_with(
        &cache,
        &fixture.root,
        crate::compile::compile_plan,
        || {},
        || {
            let projects = cache.effective_path().join("projects");
            std::fs::remove_dir(&projects).expect("empty projects directory");
            std::fs::write(&projects, b"blocks preparation").expect("block projects path");
        },
    );
    let outcome = match work {
        ProjectWork::Ready {
            compiled,
            persistence: ProjectPersistence::Prepared(outcome),
        } => {
            assert!(compiled.rules.is_some());
            outcome
        }
        _ => panic!("compile success must carry the preparation outcome"),
    };
    assert!(matches!(outcome, crate::cache::PrepareOutcome::Unavailable));
    cache.record_prepare_outcome(&outcome);
    assert_eq!(
        cache.warning().as_deref(),
        Some("compiled cache preparation or serialization is unavailable")
    );
}

#[test]
fn commit_quota_rejection_is_visible_without_changing_compile_success() {
    let fixture = Fixture::new();
    let mut source = String::new();
    for index in 0..8_000 {
        source.push_str(&format!("rule warning_{index} {{ condition: true }}\n"));
    }
    fixture.write("main.yar", &source);
    let cache = cache_for(&fixture);
    cache
        .update_settings(
            CacheSettings {
                maximum_bytes: crate::cache::MINIMUM_BYTES,
                ..CacheSettings::default()
            },
            Some(&fixture.root),
        )
        .expect("minimum quota");
    let shared = new_shared_rules();

    let response = block_on(store_project(&shared, &cache, fixture.root.clone()))
        .expect("persistence rejection is not a compile failure");

    assert!(response.ok);
    assert!(response.diagnostics.len() >= 4_000);
    assert_eq!(response.rule_count, 8_000);
    assert!(stored(&shared));
    assert!(!project_cache_exists(&cache, &fixture.root));
    assert_eq!(
        cache.warning().as_deref(),
        Some("compiled cache entry exceeds the configured maximum")
    );
}

#[test]
fn scratch_compilation_never_creates_a_cache_entry() {
    let fixture = Fixture::new();
    let cache = cache_for(&fixture);
    let shared = new_shared_rules();
    let response = block_on(store(&shared, || crate::compile::scratch(&rule("scratch"))))
        .expect("scratch compile");
    assert!(response.ok);
    assert!(!cache.effective_path().exists());
}

// --- Initial analysis restoration -----------------------------------------

#[test]
fn an_initial_restore_hit_installs_only_through_its_claimed_generation() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("restored"));
    let cache = cache_for(&fixture);
    seed_project_cache(&cache, &fixture.root);
    let shared = new_shared_rules();
    let generation = shared.begin();

    let status = finish_restoration(
        &shared,
        Some(generation),
        restore_work(&cache, &fixture.root, || {}),
    );

    assert!(matches!(status, CacheRestore::Hit { rule_count: 1, .. }));
    let names = shared.with_rules(|rules| {
        rules
            .expect("the hit was installed")
            .iter()
            .map(|rule| rule.identifier().to_string())
            .collect::<Vec<_>>()
    });
    assert_eq!(names, ["restored"]);
}

#[test]
fn reopening_an_unchanged_project_restores_scan_capable_rules_without_compiling() {
    let fixture = Fixture::new();
    fixture.write(
        "main.yar",
        "rule restored_scan { strings: $a = \"needle\" condition: $a }\n",
    );
    let cache = cache_for(&fixture);
    let shared = new_shared_rules();
    assert!(
        block_on(store_project(&shared, &cache, fixture.root.clone()))
            .expect("first compile")
            .ok
    );

    // The opening transition drops the previous in-memory rules. The only work
    // below is analysis plus restoration; restore_from_snapshot has no compiler
    // callback and must make the reopened project scan-capable by itself.
    shared.reset();
    let generation = shared.begin();
    let status = finish_restoration(
        &shared,
        Some(generation),
        restore_work(&cache, &fixture.root, || {}),
    );
    assert!(matches!(status, CacheRestore::Hit { .. }));

    let matches = shared.with_rules(|rules| {
        let mut scanner = Scanner::new(rules.expect("restored rules"));
        collect_matches(scanner.scan(b"a needle").expect("scan"))
    });
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].rule, "restored_scan");
}

#[test]
fn an_opening_cache_miss_never_invokes_the_compiler_or_installs_rules() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("uncached"));
    let cache = cache_for(&fixture);
    let shared = new_shared_rules();
    let generation = shared.begin();

    // restore_from_snapshot has deliberately no compiler callback: a miss is an
    // answer to opening, not permission to turn opening into an implicit compile.
    let status = finish_restoration(
        &shared,
        Some(generation),
        restore_work(&cache, &fixture.root, || {}),
    );

    assert!(matches!(status, CacheRestore::Miss));
    assert!(!stored(&shared));
}

#[test]
fn a_source_change_after_restore_load_installs_nothing() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("before"));
    let cache = cache_for(&fixture);
    seed_project_cache(&cache, &fixture.root);
    let shared = new_shared_rules();
    let generation = shared.begin();

    let status = finish_restoration(
        &shared,
        Some(generation),
        restore_work(&cache, &fixture.root, || {
            fixture.write("main.yar", &rule("after"));
        }),
    );

    assert!(matches!(status, CacheRestore::Miss));
    assert!(!stored(&shared));
}

#[test]
fn an_edit_or_project_switch_reset_refuses_a_hit_already_loaded_in_memory() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("old_project"));
    let cache = cache_for(&fixture);
    seed_project_cache(&cache, &fixture.root);
    let shared = new_shared_rules();
    let generation = shared.begin();
    let loaded = restore_work(&cache, &fixture.root, || {});

    // Both an edit/watcher invalidation and leaving the project use reset_rules.
    // The load has left the cache permit by now, so this is the difficult row:
    // bytes exist in memory, but their generation has lost ownership.
    shared.reset();
    let status = finish_restoration(&shared, Some(generation), loaded);

    assert!(matches!(status, CacheRestore::Superseded));
    assert!(!stored(&shared));
}

#[test]
fn a_newer_compile_refuses_a_hit_loaded_by_the_older_restore() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("cached"));
    let cache = cache_for(&fixture);
    seed_project_cache(&cache, &fixture.root);
    let shared = new_shared_rules();
    let restore_generation = shared.begin();
    let loaded = restore_work(&cache, &fixture.root, || {});

    let compile = block_on(store(&shared, || crate::compile::scratch(&rule("newer"))))
        .expect("newer compile");
    assert!(compile.ok);
    let status = finish_restoration(&shared, Some(restore_generation), loaded);

    assert!(matches!(status, CacheRestore::Superseded));
    let names = shared.with_rules(|rules| {
        rules
            .expect("the newer rules survive")
            .iter()
            .map(|rule| rule.identifier().to_string())
            .collect::<Vec<_>>()
    });
    assert_eq!(names, ["newer"]);
}

// --- Cache management boundary --------------------------------------------

#[test]
fn cache_status_exposes_usage_and_location_without_project_ids() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("managed"));
    let cache = cache_for(&fixture);
    seed_project_cache(&cache, &fixture.root);

    let status = cache_status_work(&cache, Some(&fixture.root));

    assert!(status.available);
    assert!(status.enabled);
    assert!(status.total_bytes > 0);
    assert_eq!(status.current_project_bytes, status.total_bytes);
    assert!(status.current_project_cached);
    assert_eq!(
        status.effective_path,
        cache.effective_path().to_string_lossy()
    );
    assert!(
        !status
            .effective_path
            .contains(crate::cache::ProjectId::for_root(&fixture.root).as_str()),
        "the management response must not expose backend project IDs"
    );
}

#[test]
fn clearing_disk_never_unloads_valid_rules_already_in_memory() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("still_scannable"));
    let cache = cache_for(&fixture);
    let shared = new_shared_rules();
    let compiled =
        block_on(store_project(&shared, &cache, fixture.root.clone())).expect("compile and cache");
    assert!(compiled.ok);

    assert_eq!(
        cache.clear_current(&fixture.root),
        crate::cache::ClearOutcome::Cleared
    );

    let names = shared.with_rules(|rules| {
        rules
            .expect("clear does not touch RuleStore")
            .iter()
            .map(|rule| rule.identifier().to_string())
            .collect::<Vec<_>>()
    });
    assert_eq!(names, ["still_scannable"]);
}

#[test]
fn clearing_all_disk_entries_also_leaves_loaded_rules_scannable() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("still_loaded"));
    let cache = cache_for(&fixture);
    let shared = new_shared_rules();
    assert!(
        block_on(store_project(&shared, &cache, fixture.root.clone()))
            .expect("compile")
            .ok
    );

    assert_eq!(cache.clear_all(), crate::cache::ClearOutcome::Cleared);

    assert!(stored(&shared));
    let matched_name = shared.with_rules(|rules| {
        rules
            .expect("rules remain")
            .iter()
            .next()
            .expect("one rule")
            .identifier()
            .to_string()
    });
    assert_eq!(matched_name, "still_loaded");
}
