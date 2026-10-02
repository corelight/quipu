//! Tauri IPC commands: analyze a project, compile YARA rules, scan byte buffers.
//!
//! These map the `yara-x` library types and the project model into stable,
//! frontend-facing JSON shapes (see app/src/ipc.ts). Byte offsets are into the
//! UTF-8 rule source (for diagnostics) or into the scanned buffer (for matches).
//!
//! Compilation has exactly two supported shapes, one command each: an in-memory
//! scratch source when no folder is open, and a project identified by its root
//! directory. There is deliberately no command that accepts a list of sources -
//! the backend analyzes the project itself, so what gets compiled cannot drift
//! from what is on disk. The pipeline lives in [`crate::compile`]; this module
//! owns the IPC signatures and the shared-ruleset lifecycle.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use yara_x::Scanner;

use crate::analysis::ProjectAnalysis;
use crate::cache::{
    CacheManager, CacheSettings, CacheUsage, ClaimOutcome, ClearOutcome, CommitOutcome,
    LoadOutcome, LoadedEntry, PersistenceDecline, PrepareOutcome, UsageOutcome,
};
use crate::compile::Compiled;

/// Shared, in-memory compiled ruleset. Persisted in Tauri managed state so a
/// Compile stores it once and subsequent Scans reuse it (no recompile). Held
/// behind an `Arc` so async commands can clone the handle out of `State` and move
/// it into a blocking task without holding `State` across an await.
/// `yara_x::Rules` is Send + Sync + 'static (verified).
pub type SharedRules = Arc<RuleStore>;
pub type SharedCache = Arc<CacheManager>;

pub fn new_shared_rules() -> SharedRules {
    Arc::new(RuleStore::new())
}

pub fn new_shared_cache(cache_root: PathBuf, config_root: PathBuf) -> SharedCache {
    Arc::new(CacheManager::new(cache_root, config_root))
}

/// A marker for one compile attempt's claim on the store.
///
/// Only ever compared, never counted from: the single question asked of it is
/// "is this still the current attempt?".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Generation(u64);

/// The compiled ruleset, and the generation that decides who is allowed to
/// replace it.
///
/// Clearing the rules when an invalidation arrives is not enough on its own,
/// because a compile that started *before* the invalidation is still running when
/// it happens. Left alone, that compile would install its result afterwards and
/// hand Scan the rules of the project the user has just closed, under the name of
/// the one they have just opened. So every invalidation also advances the
/// generation, and a compile may only install a result while the generation it
/// captured is still current. The same rule supersedes an older compile when a
/// newer one starts: two attempts cannot both be current.
pub struct RuleStore {
    /// One lock over both fields, because the generation check and the store have
    /// to happen together: a reset landing between them would be lost.
    state: Mutex<StoreState>,
}

struct StoreState {
    rules: Option<yara_x::Rules>,
    generation: u64,
}

impl RuleStore {
    fn new() -> Self {
        Self {
            state: Mutex::new(StoreState {
                rules: None,
                generation: 0,
            }),
        }
    }

    /// Invalidates the stored ruleset and opens a generation for the compile about
    /// to run.
    ///
    /// Called before the work starts rather than after it finishes, so a compile
    /// that fails, panics or never returns cannot leave the previous rules
    /// scannable.
    pub fn begin(&self) -> Generation {
        let mut state = self.lock();
        state.rules = None;
        state.generation += 1;
        Generation(state.generation)
    }

    /// Installs `rules` if `generation` is still current, reporting whether it
    /// did.
    ///
    /// A superseded result is dropped rather than stored: it describes a project
    /// the store has since been told to forget. It is deliberately not *cleared*
    /// either - a newer compile may already have installed rules that are
    /// perfectly valid, and this one has no business discarding them.
    pub fn finish(&self, generation: Generation, rules: yara_x::Rules) -> bool {
        let mut state = self.lock();
        if state.generation != generation.0 {
            return false;
        }
        state.rules = Some(rules);
        true
    }

    /// Invalidates the stored ruleset and supersedes every compile in flight.
    pub fn reset(&self) {
        let mut state = self.lock();
        state.rules = None;
        state.generation += 1;
    }

    /// Runs `body` with the stored ruleset, holding the lock throughout.
    ///
    /// A scan borrows the `Rules`, so the lock has to be held for the whole scan.
    /// An invalidation arriving mid-scan therefore waits, which is the right
    /// answer: a scan that has already started is scanning the rules it was
    /// given, and the invalidation applies from the next one.
    pub fn with_rules<T>(&self, body: impl FnOnce(Option<&yara_x::Rules>) -> T) -> T {
        body(self.lock().rules.as_ref())
    }

    fn observation(&self) -> RuleStoreObservation {
        let state = self.lock();
        RuleStoreObservation {
            generation: state.generation,
            installed: state.rules.is_some(),
        }
    }

    /// A poisoned lock means something panicked while the state was borrowed -
    /// in practice, a scan. Both mutations are plain field assignments with
    /// nothing observable in between, so the state cannot be torn, and recovering
    /// beats bricking every later command.
    fn lock(&self) -> std::sync::MutexGuard<'_, StoreState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleStoreObservation {
    generation: u64,
    installed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    pub severity: &'static str,
    pub code: String,
    pub title: String,
    /// 1-based line, or 0 when the problem has no position in any file's bytes
    /// (a configuration error, or a whole-file problem).
    pub line: usize,
    /// 1-based column, counted in UTF-16 code units so it can be handed straight
    /// to Monaco. 0 alongside `line == 0`.
    pub column: usize,
    pub span: Span,
    /// Canonical, openable path of the source the diagnostic came from. `None`
    /// for the scratch buffer, and for problems that name no file the frontend
    /// could open.
    pub file: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResponse {
    /// True when a ruleset from *this* compile is stored and Scan can run it.
    ///
    /// So a compile that succeeded but was superseded before it could store its
    /// result reports false: there is nothing for Scan to run, which is what the
    /// flag is asked about.
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
    /// Number of rules in the compiled ruleset (only meaningful when ok).
    pub rule_count: usize,
    /// The project changed across the compiler's two observations. The frontend
    /// keeps the still-current operation explicitly stale and presents none of
    /// the diagnostics from the potentially mixed compilation.
    pub source_changed: bool,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CacheRestore {
    NotRequested,
    Disabled,
    Miss,
    Unavailable,
    #[serde(rename_all = "camelCase")]
    Hit {
        rule_count: usize,
        diagnostics: Vec<Diagnostic>,
    },
    Superseded,
}

#[derive(Serialize)]
pub struct AnalyzeResponse {
    pub analysis: ProjectAnalysis,
    pub cache: CacheRestore,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    pub enabled: bool,
    pub maximum_bytes: u64,
    pub available: bool,
    pub effective_path: String,
    pub total_bytes: u64,
    pub current_project_bytes: u64,
    pub current_project_cached: bool,
    pub warning: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MetaValue {
    Integer { value: i64 },
    Float { value: f64 },
    Bool { value: bool },
    String { value: String },
    Bytes { value: String },
}

#[derive(Serialize)]
pub struct MatchSpan {
    pub pattern: String,
    pub start: usize,
    pub end: usize,
    pub length: usize,
    pub data: String,
}

#[derive(Serialize)]
pub struct RuleMatch {
    pub rule: String,
    pub namespace: String,
    pub tags: Vec<String>,
    pub meta: std::collections::BTreeMap<String, MetaValue>,
    pub matches: Vec<MatchSpan>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResponse {
    pub ok: bool,
    pub matched: Vec<RuleMatch>,
    pub scanned_bytes: usize,
    /// Set when scanning was attempted with no compiled ruleset, or the scan
    /// itself errored. Compile errors live on the CompileResponse, not here.
    pub error: Option<String>,
}

/// Reads a file's raw bytes for scanning. The path comes from the native file
/// dialog, so it is user-selected; reading happens in Rust to avoid pulling in
/// the fs plugin and its scoped-permission surface.
#[tauri::command]
pub fn read_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("{path}: {e}"))
}

/// Analyzes the project rooted at `root`: its include graph, its problems, and
/// whether it can currently be compiled.
///
/// Ordinary analysis touches no compiled-ruleset state. The initial opening call
/// may additionally request restoration from this same snapshot; that path claims
/// a normal [`RuleStore`] generation and never invokes the compiler. A broken
/// configuration is part of the *result*; see [`ProjectAnalysis`].
///
/// `watching` is the caller's watcher subscription and this analysis's own order within
/// it, when it has one. The watch plan is then derived from *this* snapshot rather than
/// from an analysis of its own, so what is watched and what is displayed can never
/// describe two different reads of the disk. The order is what keeps that true when
/// several analyses are in flight: the caller displays only the newest to settle, and the
/// registry installs a plan by the same rule. A superseded subscription or an older
/// analysis is ignored by the registry, and widening the watch cannot fail the analysis.
#[tauri::command]
pub async fn analyze_project(
    root: String,
    watching: Option<crate::watch::Analysed>,
    watchers: tauri::State<'_, crate::watch::SharedWatchers>,
    restore_cache: bool,
    rules: tauri::State<'_, SharedRules>,
    cache: tauri::State<'_, SharedCache>,
    trace: tauri::State<'_, crate::debug_trace::DebugTrace>,
) -> Result<AnalyzeResponse, String> {
    let watchers = Arc::clone(watchers.inner());
    let rules = rules.inner().clone();
    let cache = cache.inner().clone();
    let trace = trace.inner().clone();
    let watch_subscription = watching.map(|identity| identity.subscription).unwrap_or(0);
    let analysis_order = watching.map(|identity| identity.generation).unwrap_or(0);
    trace.event_lazy("command_received", || {
        serde_json::json!({
            "command": "analyze_project",
            "restoreCache": restore_cache,
            "watchSubscription": watch_subscription,
            "analysisOrder": analysis_order,
        })
    });
    let store_before_begin = (restore_cache && trace.is_enabled()).then(|| rules.observation());
    let generation = restore_cache.then(|| rules.begin());
    if let Some(generation) = generation {
        trace.event_lazy("rule_store_transition", || {
            serde_json::json!({
                "action": "restoration_begin",
                "claimedGeneration": generation.0,
                "before": store_before_begin.expect("enabled restoration trace observed its store"),
                "after": rules.observation(),
            })
        });
    }
    let work_trace = trace.clone();
    // Walking a directory tree and parsing every rule file is blocking work, so
    // it stays off the UI thread even though nothing here compiles.
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(root);
        let project_id = work_trace
            .is_enabled()
            .then(|| crate::cache::ProjectId::for_root(&root));
        work_trace.event_lazy("project_analysis_started", || {
            serde_json::json!({
                "watchSubscription": watch_subscription,
                "analysisOrder": analysis_order,
                "restoreCache": restore_cache,
                "projectId": project_id.as_ref().expect("enabled trace has project ID").as_str(),
            })
        });
        let outcome = crate::project::open_project(&root);
        let analysis = crate::analysis::describe(&outcome);
        work_trace.event_lazy("project_analysis_finished", || {
            let (analysis_status, fingerprint, source_count) = match &outcome {
                Ok(snapshot) => {
                    let fingerprint = snapshot
                        .compilation_plan()
                        .ok()
                        .map(|plan| plan.fingerprint().to_hex());
                    ("loaded", fingerprint, snapshot.discovered().len())
                }
                Err(_) => ("configuration_failed", None, 0),
            };
            serde_json::json!({
                "watchSubscription": watch_subscription,
                "analysisOrder": analysis_order,
                "status": analysis_status,
                "fingerprint": fingerprint,
                "sourceCount": source_count,
                "projectId": project_id.as_ref().expect("enabled trace has project ID").as_str(),
            })
        });
        if let Some(of) = watching {
            watchers.update(of, &root, &outcome);
            work_trace.event_lazy("watch_plan_updated", || {
                serde_json::json!({
                    "watchSubscription": of.subscription,
                    "analysisOrder": of.generation,
                })
            });
        }
        let restore = if restore_cache {
            restore_from_snapshot_observed(&cache, &root, &outcome, || {}, Some(&work_trace))
        } else {
            RestoreWork::Status(CacheRestore::NotRequested)
        };
        (analysis, restore)
    })
    .await
    .map_err(|e| {
        trace.event_lazy("command_responded", || {
            serde_json::json!({
                "command": "analyze_project",
                "ok": false,
                "reason": "blocking_task_failed",
                "watchSubscription": watch_subscription,
                "analysisOrder": analysis_order,
            })
        });
        format!("analysis task panicked: {e}")
    })
    .map(|(analysis, restore)| {
        let cache = finish_restoration_observed(&rules, generation, restore, Some(&trace));
        trace.event_lazy("command_responded", || {
            serde_json::json!({
                "command": "analyze_project",
                "ok": true,
                "cacheStatus": cache_restore_name(&cache),
                "watchSubscription": watch_subscription,
                "analysisOrder": analysis_order,
            })
        });
        AnalyzeResponse { analysis, cache }
    })
}

enum RestoreWork {
    Status(CacheRestore),
    Hit(LoadedEntry),
}

#[cfg(test)]
fn finish_restoration(
    rules: &RuleStore,
    generation: Option<Generation>,
    restore: RestoreWork,
) -> CacheRestore {
    finish_restoration_observed(rules, generation, restore, None)
}

fn finish_restoration_observed(
    rules: &RuleStore,
    generation: Option<Generation>,
    restore: RestoreWork,
    trace: Option<&crate::debug_trace::DebugTrace>,
) -> CacheRestore {
    match restore {
        RestoreWork::Status(status) => {
            if let Some(trace) = trace {
                trace.event_lazy("finish_restoration", || {
                    serde_json::json!({
                        "result": cache_restore_name(&status),
                        "claimedGeneration": generation.map(|generation| generation.0),
                        "store": rules.observation(),
                    })
                });
            }
            status
        }
        RestoreWork::Hit(hit) => {
            let generation = generation.expect("restoration claimed a generation");
            let before = trace
                .is_some_and(crate::debug_trace::DebugTrace::is_enabled)
                .then(|| rules.observation());
            let installed = rules.finish(generation, *hit.rules);
            let after = trace
                .is_some_and(crate::debug_trace::DebugTrace::is_enabled)
                .then(|| rules.observation());
            let status = if installed {
                CacheRestore::Hit {
                    rule_count: hit.rule_count,
                    diagnostics: hit.diagnostics,
                }
            } else {
                CacheRestore::Superseded
            };
            if let Some(trace) = trace {
                trace.event_lazy("finish_restoration", || {
                    serde_json::json!({
                        "result": cache_restore_name(&status),
                        "installed": installed,
                        "claimedGeneration": generation.0,
                        "before": before,
                        "after": after,
                    })
                });
            }
            status
        }
    }
}

#[cfg(test)]
fn restore_from_snapshot(
    cache: &CacheManager,
    root: &std::path::Path,
    outcome: &Result<crate::project::ProjectSnapshot, crate::project::ConfigError>,
    after_load: impl FnOnce(),
) -> RestoreWork {
    restore_from_snapshot_observed(cache, root, outcome, after_load, None)
}

fn restore_from_snapshot_observed(
    cache: &CacheManager,
    root: &std::path::Path,
    outcome: &Result<crate::project::ProjectSnapshot, crate::project::ConfigError>,
    after_load: impl FnOnce(),
    trace: Option<&crate::debug_trace::DebugTrace>,
) -> RestoreWork {
    let Ok(snapshot) = outcome else {
        if let Some(trace) = trace {
            trace.event_lazy(
                "restore_cache",
                || serde_json::json!({ "stage": "plan", "outcome": "configuration_failed" }),
            );
        }
        return RestoreWork::Status(CacheRestore::Miss);
    };
    let Ok(plan) = snapshot.compilation_plan() else {
        if let Some(trace) = trace {
            trace.event_lazy(
                "restore_cache",
                || serde_json::json!({ "stage": "plan", "outcome": "not_compilable" }),
            );
        }
        return RestoreWork::Status(CacheRestore::Miss);
    };
    let first_fingerprint = trace
        .filter(|trace| trace.is_enabled())
        .map(|_| plan.fingerprint().to_hex());
    if let Some(trace) = trace {
        trace.event_lazy("restore_cache", || {
            serde_json::json!({
                "stage": "lookup_started",
                "fingerprint": first_fingerprint,
            })
        });
    }
    match cache.load_observed(&plan, trace) {
        LoadOutcome::Hit(hit) => {
            if let Some(trace) = trace {
                trace.event_lazy("restore_cache", || {
                    serde_json::json!({
                        "stage": "lookup_hit",
                        "ruleCount": hit.rule_count,
                        "diagnosticCount": hit.diagnostics.len(),
                    })
                });
            }
            after_load();
            let second = crate::compile::project_plan(root).ok();
            let stable = second
                .as_ref()
                .is_some_and(|second| second.fingerprint() == plan.fingerprint());
            if let Some(trace) = trace {
                trace.event_lazy("restore_cache_second_fingerprint", || {
                    serde_json::json!({
                        "first": first_fingerprint,
                        "second": second.as_ref().map(|plan| plan.fingerprint().to_hex()),
                        "equal": stable,
                    })
                });
            }
            if stable {
                RestoreWork::Hit(hit)
            } else {
                RestoreWork::Status(CacheRestore::Miss)
            }
        }
        LoadOutcome::Disabled => RestoreWork::Status(CacheRestore::Disabled),
        LoadOutcome::Unavailable => RestoreWork::Status(CacheRestore::Unavailable),
        LoadOutcome::Miss(reason) => {
            let _ = reason;
            RestoreWork::Status(CacheRestore::Miss)
        }
    }
}

fn cache_restore_name(status: &CacheRestore) -> &'static str {
    match status {
        CacheRestore::NotRequested => "not_requested",
        CacheRestore::Disabled => "disabled",
        CacheRestore::Miss => "miss",
        CacheRestore::Unavailable => "unavailable",
        CacheRestore::Superseded => "superseded",
        CacheRestore::Hit { .. } => "hit",
    }
}

fn cache_status_from_usage(cache: &CacheManager, usage: UsageOutcome) -> CacheStatus {
    let settings = cache.settings();
    let (available, usage) = match usage {
        UsageOutcome::Available(usage) => (cache.is_available(), usage),
        UsageOutcome::Unavailable => (false, CacheUsage::default()),
    };
    CacheStatus {
        enabled: settings.enabled,
        maximum_bytes: settings.maximum_bytes,
        available,
        effective_path: cache.effective_path().to_string_lossy().into_owned(),
        total_bytes: usage.total_bytes,
        current_project_bytes: usage.current_project_bytes,
        current_project_cached: usage.current_project_cached,
        warning: cache.warning(),
    }
}

fn cache_status_work(cache: &CacheManager, root: Option<&std::path::Path>) -> CacheStatus {
    cache_status_from_usage(cache, cache.maintain(root))
}

/// Returns backend-owned cache configuration and exact post-maintenance usage.
#[tauri::command]
pub async fn cache_status(
    root: Option<String>,
    cache: tauri::State<'_, SharedCache>,
) -> Result<CacheStatus, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        cache_status_work(&cache, root.as_deref().map(std::path::Path::new))
    })
    .await
    .map_err(|e| format!("cache status task panicked: {e}"))
}

/// Atomically saves cache settings before publishing them to this process.
#[tauri::command]
pub async fn update_cache_settings(
    enabled: bool,
    maximum_bytes: u64,
    root: Option<String>,
    cache: tauri::State<'_, SharedCache>,
) -> Result<CacheStatus, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = CacheSettings {
            enabled,
            maximum_bytes,
            ..CacheSettings::default()
        };
        let usage = cache.update_settings(settings, root.as_deref().map(std::path::Path::new))?;
        Ok(cache_status_from_usage(&cache, usage))
    })
    .await
    .map_err(|e| format!("cache settings task panicked: {e}"))?
}

/// Clears only the cache entry derived from the supplied project root. Loaded
/// rules are intentionally not part of this command's state.
#[tauri::command]
pub async fn clear_project_cache(
    root: String,
    cache: tauri::State<'_, SharedCache>,
) -> Result<(), String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match cache.clear_current(PathBuf::from(root).as_path()) {
            ClearOutcome::Cleared => Ok(()),
            ClearOutcome::Unavailable => Err("compiled cache could not be cleared".into()),
        }
    })
    .await
    .map_err(|e| format!("cache clear task panicked: {e}"))?
}

/// Clears all managed project entries while preserving lock infrastructure and
/// any rules already installed in memory.
#[tauri::command]
pub async fn clear_all_caches(cache: tauri::State<'_, SharedCache>) -> Result<(), String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match cache.clear_all() {
        ClearOutcome::Cleared => Ok(()),
        ClearOutcome::Unavailable => Err("compiled caches could not be cleared".into()),
    })
    .await
    .map_err(|e| format!("cache clear task panicked: {e}"))?
}

/// Compiles one in-memory source - the scratch buffer, when no folder is open -
/// and persists the result for subsequent scans.
#[tauri::command]
pub async fn compile_scratch(
    text: String,
    state: tauri::State<'_, SharedRules>,
    trace: tauri::State<'_, crate::debug_trace::DebugTrace>,
) -> Result<CompileResponse, String> {
    trace.event_lazy(
        "command_received",
        || serde_json::json!({ "command": "compile_scratch", "sourceBytes": text.len() }),
    );
    let response = store(state.inner(), move || crate::compile::scratch(&text)).await;
    trace.event_lazy("command_responded", || {
        serde_json::json!({
            "command": "compile_scratch",
            "transportOk": response.is_ok(),
            "ok": response.as_ref().is_ok_and(|response| response.ok),
        })
    });
    response
}

/// Analyzes the project rooted at `root` and compiles it from the resulting
/// plan, persisting the result for subsequent scans.
///
/// The analysis happens here rather than being sent by the frontend, so the
/// compiled ruleset always describes the project as it is on disk now.
#[tauri::command]
pub async fn compile_project(
    root: String,
    state: tauri::State<'_, SharedRules>,
    cache: tauri::State<'_, SharedCache>,
    trace: tauri::State<'_, crate::debug_trace::DebugTrace>,
) -> Result<CompileResponse, String> {
    let root = PathBuf::from(root);
    let project_id = trace
        .is_enabled()
        .then(|| crate::cache::ProjectId::for_root(&root));
    trace.event_lazy("command_received", || {
        serde_json::json!({
            "command": "compile_project",
            "projectId": project_id.as_ref().expect("enabled trace has project ID").as_str(),
        })
    });
    let response =
        store_project_observed(state.inner(), cache.inner(), root, Some(trace.inner())).await;
    trace.event_lazy("command_responded", || {
        serde_json::json!({
            "command": "compile_project",
            "projectId": project_id.as_ref().expect("enabled trace has project ID").as_str(),
            "transportOk": response.is_ok(),
            "ok": response.as_ref().is_ok_and(|response| response.ok),
            "ruleCount": response.as_ref().ok().map(|response| response.rule_count),
            "diagnosticCount": response.as_ref().ok().map(|response| response.diagnostics.len()),
            "sourceChanged": response.as_ref().ok().map(|response| response.source_changed),
            "store": state.observation(),
        })
    });
    response
}

enum ProjectWork {
    Failed(Compiled),
    SourceChanged,
    Ready {
        compiled: Compiled,
        persistence: ProjectPersistence,
    },
}

enum ProjectPersistence {
    NotNeeded,
    Prepared(PrepareOutcome),
}

fn project_work(cache: &CacheManager, root: &std::path::Path) -> ProjectWork {
    project_work_with(cache, root, crate::compile::compile_plan, || {}, || {})
}

fn project_work_with(
    cache: &CacheManager,
    root: &std::path::Path,
    compile: impl FnOnce(&crate::project::CompilationPlan) -> Compiled,
    after_load: impl FnOnce(),
    after_compile: impl FnOnce(),
) -> ProjectWork {
    let mut write_claim = cache.capture_write_claim(root);
    let mut plan = match crate::compile::project_plan(root) {
        Ok(plan) => plan,
        Err(failure) => return ProjectWork::Failed(failure),
    };

    match cache.load(&plan) {
        LoadOutcome::Hit(hit) => {
            after_load();
            let second = match crate::compile::project_plan(root) {
                Ok(plan) => plan,
                // The entry was valid for the first observation, but the project is
                // no longer valid. Treat the hit as transient and let the current
                // compile report the new project state without installing it.
                Err(failure) => return ProjectWork::Failed(failure),
            };
            if second.fingerprint() == plan.fingerprint() {
                return ProjectWork::Ready {
                    compiled: Compiled {
                        rules: Some(hit.rules),
                        diagnostics: hit.diagnostics,
                        rule_count: hit.rule_count,
                    },
                    persistence: ProjectPersistence::NotNeeded,
                };
            }
            plan = second;
        }
        LoadOutcome::Miss(reason) => {
            let _ = reason;
        }
        LoadOutcome::Disabled => write_claim = ClaimOutcome::Declined(PersistenceDecline::Disabled),
        LoadOutcome::Unavailable => write_claim = ClaimOutcome::Unavailable,
    }

    let compiled = compile(&plan);
    if compiled.rules.is_none() {
        return ProjectWork::Failed(compiled);
    }
    after_compile();
    let stable = crate::compile::project_plan(root)
        .ok()
        .is_some_and(|second| second.fingerprint() == plan.fingerprint());
    if !stable {
        // The compiler may have observed a mixture. Drop the Rules here, before
        // the caller can offer them to RuleStore::finish.
        return ProjectWork::SourceChanged;
    }
    let persistence = match write_claim {
        ClaimOutcome::Claimed(claim) => cache.prepare(
            &claim,
            &plan,
            compiled
                .rules
                .as_ref()
                .expect("successful compile has rules"),
            &compiled.diagnostics,
            compiled.rule_count,
        ),
        ClaimOutcome::Declined(decline) => PrepareOutcome::Declined(decline),
        ClaimOutcome::Unavailable => PrepareOutcome::Unavailable,
    };
    ProjectWork::Ready {
        compiled,
        persistence: ProjectPersistence::Prepared(persistence),
    }
}

#[cfg(test)]
async fn store_project(
    state: &SharedRules,
    cache: &SharedCache,
    root: PathBuf,
) -> Result<CompileResponse, String> {
    store_project_observed(state, cache, root, None).await
}

async fn store_project_observed(
    state: &SharedRules,
    cache: &SharedCache,
    root: PathBuf,
    trace: Option<&crate::debug_trace::DebugTrace>,
) -> Result<CompileResponse, String> {
    let shared = state.clone();
    let tracing = trace.is_some_and(crate::debug_trace::DebugTrace::is_enabled);
    let before = tracing.then(|| shared.observation());
    let generation = shared.begin();
    if let Some(trace) = trace {
        trace.event_lazy("rule_store_transition", || {
            serde_json::json!({
                "action": "compile_begin",
                "claimedGeneration": generation.0,
                "before": before,
                "after": shared.observation(),
            })
        });
    }
    let cache_for_work = cache.clone();
    let work = tauri::async_runtime::spawn_blocking(move || project_work(&cache_for_work, &root))
        .await
        .map_err(|e| format!("compile task panicked: {e}"))?;

    let (compiled, persistence) = match work {
        ProjectWork::Failed(compiled) => {
            return Ok(CompileResponse {
                ok: false,
                diagnostics: compiled.diagnostics,
                rule_count: 0,
                source_changed: false,
            });
        }
        ProjectWork::SourceChanged => {
            return Ok(CompileResponse {
                ok: false,
                diagnostics: Vec::new(),
                rule_count: 0,
                source_changed: true,
            });
        }
        ProjectWork::Ready {
            compiled,
            persistence,
        } => (compiled, persistence),
    };
    let rules = compiled.rules.expect("ready project work has rules");
    let before_finish = tracing.then(|| shared.observation());
    let installed = shared.finish(generation, *rules);
    if let Some(trace) = trace {
        trace.event_lazy("rule_store_transition", || {
            serde_json::json!({
                "action": "compile_finish",
                "claimedGeneration": generation.0,
                "installed": installed,
                "before": before_finish,
                "after": shared.observation(),
            })
        });
    }
    if !installed {
        return Ok(CompileResponse {
            ok: false,
            diagnostics: Vec::new(),
            rule_count: 0,
            source_changed: false,
        });
    }

    match persistence {
        ProjectPersistence::NotNeeded => {
            if let Some(trace) = trace {
                trace.event(
                    "cache_persistence",
                    serde_json::json!({
                        "stage": "prepare", "outcome": "not_needed",
                    }),
                );
            }
        }
        ProjectPersistence::Prepared(PrepareOutcome::Prepared(proposal)) => {
            if let Some(trace) = trace {
                trace.event(
                    "cache_persistence",
                    serde_json::json!({
                        "stage": "prepare", "outcome": "prepared",
                    }),
                );
            }
            let cache_for_commit = cache.clone();
            let commit_trace = trace.cloned();
            match tauri::async_runtime::spawn_blocking(move || {
                cache_for_commit.commit_observed(proposal, commit_trace.as_ref())
            })
            .await
            {
                Ok(outcome @ CommitOutcome::Committed)
                | Ok(outcome @ CommitOutcome::Declined(_))
                | Ok(outcome @ CommitOutcome::ArtifactOverLimit)
                | Ok(outcome @ CommitOutcome::MetadataOverLimit)
                | Ok(outcome @ CommitOutcome::QuotaExceeded)
                | Ok(outcome @ CommitOutcome::Unavailable) => {
                    cache.record_commit_outcome(outcome);
                }
                Err(_) => {
                    if let Some(trace) = trace {
                        trace.event(
                            "cache_persistence",
                            serde_json::json!({
                                "stage": "commit", "outcome": "task_failed",
                            }),
                        );
                    }
                    cache.record_persistence_task_failure();
                }
            }
        }
        ProjectPersistence::Prepared(outcome @ PrepareOutcome::Declined(_))
        | ProjectPersistence::Prepared(outcome @ PrepareOutcome::ArtifactOverLimit)
        | ProjectPersistence::Prepared(outcome @ PrepareOutcome::Unavailable) => {
            if let Some(trace) = trace {
                // These variants carry only fixed outcome names; Prepared's
                // artifact and diagnostics must never be formatted into traces.
                trace.event_lazy("cache_persistence", || {
                    serde_json::json!({
                        "stage": "prepare", "outcome": format!("{outcome:?}"),
                    })
                });
            }
            cache.record_prepare_outcome(&outcome);
        }
    }

    Ok(CompileResponse {
        ok: true,
        diagnostics: compiled.diagnostics,
        rule_count: compiled.rule_count,
        source_changed: false,
    })
}

/// Runs a compilation off the UI thread and owns the shared ruleset's lifecycle.
///
/// [`RuleStore::begin`] drops the stored ruleset *before* the work starts, so
/// every failure path - configuration error, plan rejection, unreadable input,
/// YARA-X error, or a panic in the blocking task - leaves nothing stale behind for
/// Scan. Clearing afterwards instead would leave the old rules scannable whenever
/// the task never returned.
///
/// The generation captured there is what makes the result's installation
/// conditional: see [`RuleStore`].
///
/// Takes the ruleset by handle rather than by `State` so the lifecycle can be
/// tested directly, without standing up a Tauri application.
async fn store<F>(state: &SharedRules, compile: F) -> Result<CompileResponse, String>
where
    F: FnOnce() -> Compiled + Send + 'static,
{
    let shared = state.clone();
    let generation = shared.begin();

    let compiled = tauri::async_runtime::spawn_blocking(compile)
        .await
        .map_err(|e| format!("compile task panicked: {e}"))?;

    let Some(rules) = compiled.rules else {
        return Ok(CompileResponse {
            ok: false,
            diagnostics: compiled.diagnostics,
            rule_count: compiled.rule_count,
            source_changed: false,
        });
    };

    if !shared.finish(generation, *rules) {
        // Superseded while this was compiling: the project was closed, or a newer
        // compile started. The diagnostics go with the rules - they describe a
        // project nothing is asking about any more, and showing them beside a
        // different one would be worse than showing nothing. A frontend that
        // tracks its own operations discards this response anyway; reporting it as
        // "nothing compiled" means one that does not still cannot enable Scan.
        return Ok(CompileResponse {
            ok: false,
            diagnostics: Vec::new(),
            rule_count: 0,
            source_changed: false,
        });
    }

    Ok(CompileResponse {
        ok: true,
        diagnostics: compiled.diagnostics,
        rule_count: compiled.rule_count,
        source_changed: false,
    })
}

/// Drops the persisted compiled ruleset (e.g. when switching project folders) and
/// supersedes any compile still in flight.
#[tauri::command]
pub fn reset_rules(
    state: tauri::State<'_, SharedRules>,
    trace: tauri::State<'_, crate::debug_trace::DebugTrace>,
) {
    trace.event_lazy(
        "command_received",
        || serde_json::json!({ "command": "reset_rules" }),
    );
    let before = trace.is_enabled().then(|| state.observation());
    state.inner().reset();
    trace.event_lazy("rule_store_transition", || {
        serde_json::json!({
            "action": "reset",
            "before": before,
            "after": state.observation(),
        })
    });
    trace.event_lazy(
        "command_responded",
        || serde_json::json!({ "command": "reset_rules", "ok": true }),
    );
}

/// Scans `target` against the PERSISTED compiled ruleset. Returns ok=false with
/// an `error` if nothing has been compiled yet (the frontend gates Scan on the
/// compiled state, but we guard here too).
#[tauri::command]
pub async fn scan_target(
    target: Vec<u8>,
    state: tauri::State<'_, SharedRules>,
) -> Result<ScanResponse, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scanned_bytes = target.len();
        shared.with_rules(|rules| {
            let Some(rules) = rules else {
                return ScanResponse {
                    ok: false,
                    matched: Vec::new(),
                    scanned_bytes,
                    error: Some("No compiled rules. Compile first.".to_string()),
                };
            };
            let mut scanner = Scanner::new(rules);
            match scanner.scan(&target) {
                Ok(results) => ScanResponse {
                    ok: true,
                    matched: collect_matches(results),
                    scanned_bytes,
                    error: None,
                },
                Err(err) => ScanResponse {
                    ok: false,
                    matched: Vec::new(),
                    scanned_bytes,
                    error: Some(err.to_string()),
                },
            }
        })
    })
    .await
    .map_err(|e| format!("scan task panicked: {e}"))
}

/// Maps yara-x scan results into the frontend RuleMatch shape.
fn collect_matches(results: yara_x::ScanResults) -> Vec<RuleMatch> {
    let mut matched = Vec::new();
    for rule in results.matching_rules() {
        let mut matches = Vec::new();
        for pattern in rule.patterns() {
            for m in pattern.matches() {
                let range = m.range();
                matches.push(MatchSpan {
                    pattern: pattern.identifier().to_string(),
                    start: range.start,
                    end: range.end,
                    length: range.end - range.start,
                    data: String::from_utf8_lossy(m.data()).into_owned(),
                });
            }
        }
        let meta = rule
            .metadata()
            .map(|(k, v)| (k.to_string(), meta_value(v)))
            .collect();
        matched.push(RuleMatch {
            rule: rule.identifier().to_string(),
            namespace: rule.namespace().to_string(),
            tags: rule.tags().map(|t| t.identifier().to_string()).collect(),
            meta,
            matches,
        });
    }
    matched
}

fn meta_value(v: yara_x::MetaValue) -> MetaValue {
    match v {
        yara_x::MetaValue::Integer(i) => MetaValue::Integer { value: i },
        yara_x::MetaValue::Float(f) => MetaValue::Float { value: f },
        yara_x::MetaValue::Bool(b) => MetaValue::Bool { value: b },
        yara_x::MetaValue::String(s) => MetaValue::String {
            value: s.to_string(),
        },
        yara_x::MetaValue::Bytes(b) => MetaValue::Bytes {
            value: b.to_string(),
        },
    }
}

#[cfg(test)]
mod tests;
