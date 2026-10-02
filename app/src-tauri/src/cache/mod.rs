//! Tauri-free compiled-rules cache storage.
//!
//! The module owns compatibility validation, bounded reads, serialization,
//! structural advisory locking, process-local clear epochs and the
//! artifact-first/metadata-last commit protocol. Tauri only supplies the two
//! resolved base directories when constructing [`CacheManager`].

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::commands::{Diagnostic, Span};
use crate::project::{
    COMPILER_CACHE_EPOCH, COMPILER_PROFILE, CompilationPlan, FINGERPRINT_ENCODING_VERSION,
    PlanFingerprint, to_slash,
};

pub(crate) const SETTINGS_SCHEMA: u32 = 1;
pub(crate) const METADATA_SCHEMA: u32 = 3;
pub(crate) const DEFAULT_MAXIMUM_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const MINIMUM_BYTES: u64 = 1024 * 1024;
pub(crate) const MAXIMUM_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
const TARGET: &str = "default";
const LAST_USED_INTERVAL_SECONDS: u64 = 60 * 60;
const LOW_WATER_NUMERATOR: u64 = 4;
const LOW_WATER_DENOMINATOR: u64 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CacheSettings {
    pub schema: u32,
    pub enabled: bool,
    pub maximum_bytes: u64,
}

impl Default for CacheSettings {
    fn default() -> Self {
        Self {
            schema: SETTINGS_SCHEMA,
            enabled: true,
            maximum_bytes: DEFAULT_MAXIMUM_BYTES,
        }
    }
}

impl CacheSettings {
    pub(crate) fn validate(self) -> Result<Self, String> {
        if self.schema != SETTINGS_SCHEMA {
            return Err("unsupported cache settings schema".into());
        }
        if !(MINIMUM_BYTES..=MAXIMUM_BYTES).contains(&self.maximum_bytes) {
            return Err("cache maximum must be between 1 MiB and 1 TiB".into());
        }
        if !self.maximum_bytes.is_multiple_of(MINIMUM_BYTES) {
            return Err("cache maximum must be a whole number of MiB".into());
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct ProjectId(String);

impl ProjectId {
    pub(crate) fn for_root(root: &Path) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"quipu-cache-project-id");
        hasher.update(&os_bytes(root.as_os_str()));
        Self(hasher.finalize().to_hex().to_string())
    }

    fn parse(text: &str) -> Option<Self> {
        is_lower_hex(text, 64).then(|| Self(text.to_string()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug)]
struct Epochs {
    global: u64,
    project: u64,
    settings: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct WriteClaim {
    project_id: ProjectId,
    epochs: Epochs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PersistenceDecline {
    Cleared,
    Disabled,
    Superseded,
}

#[derive(Clone, Debug)]
pub(crate) enum ClaimOutcome {
    Claimed(WriteClaim),
    Declined(PersistenceDecline),
    Unavailable,
}

#[cfg(test)]
impl ClaimOutcome {
    fn expect(self, message: &str) -> WriteClaim {
        match self {
            Self::Claimed(claim) => claim,
            other => panic!("{message}: {other:?}"),
        }
    }

    fn is_none(&self) -> bool {
        !matches!(self, Self::Claimed(_))
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ProposedEntry {
    project_id: ProjectId,
    fingerprint: PlanFingerprint,
    inputs: Vec<StoredInput>,
    diagnostics: Vec<StoredDiagnostic>,
    rule_count: usize,
    artifact: Vec<u8>,
    artifact_digest: String,
    epochs: Epochs,
    created: u64,
}

#[derive(Debug)]
pub(crate) struct LoadedEntry {
    pub rules: Box<yara_x::Rules>,
    pub diagnostics: Vec<Diagnostic>,
    pub rule_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MissReason {
    Absent,
    Fingerprint,
    Compatibility,
    Corrupt,
}

#[derive(Debug)]
pub(crate) enum LoadOutcome {
    Hit(LoadedEntry),
    Miss(MissReason),
    Disabled,
    Unavailable,
}

macro_rules! cache_stage {
    ($trace:expr, $stage:expr, $outcome:expr, $detail:expr $(,)?) => {
        if let Some(trace) = $trace {
            trace.event_lazy("cache_lookup_stage", || {
                serde_json::json!({
                    "stage": $stage,
                    "outcome": $outcome,
                    "detail": $detail,
                })
            });
        }
    };
}

#[derive(Debug)]
pub(crate) enum PrepareOutcome {
    Prepared(ProposedEntry),
    Declined(PersistenceDecline),
    ArtifactOverLimit,
    Unavailable,
}

#[cfg(test)]
impl PrepareOutcome {
    fn expect(self, message: &str) -> ProposedEntry {
        match self {
            Self::Prepared(proposal) => proposal,
            other => panic!("{message}: {other:?}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CommitOutcome {
    Committed,
    Declined(PersistenceDecline),
    ArtifactOverLimit,
    MetadataOverLimit,
    QuotaExceeded,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClearOutcome {
    Cleared,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheUsage {
    pub total_bytes: u64,
    pub current_project_bytes: u64,
    pub current_project_cached: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UsageOutcome {
    Available(CacheUsage),
    Unavailable,
}

#[derive(Debug)]
struct LiveEntry {
    project_id: ProjectId,
    target: String,
    metadata_path: PathBuf,
    artifact_path: PathBuf,
    last_used: u64,
}

struct ManagerState {
    settings: CacheSettings,
    global_epoch: u64,
    project_epochs: HashMap<ProjectId, u64>,
    settings_epoch: u64,
    warnings: CacheWarnings,
}

#[derive(Default)]
struct CacheWarnings {
    location: Option<String>,
    settings: Option<String>,
    persistence: Option<String>,
    maintenance: Option<String>,
    touch: Option<String>,
}

#[derive(Clone, Copy)]
enum WarningOwner {
    Location,
    Settings,
    Persistence,
    Maintenance,
    Touch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PrepareFailure {
    ArtifactOverLimit,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SerializationFailure {
    OverLimit,
    Unavailable,
}

pub(crate) struct CacheManager {
    root: PathBuf,
    config_root: PathBuf,
    available: bool,
    permit: Mutex<()>,
    state: Mutex<ManagerState>,
    clock: Arc<dyn Clock>,
    hooks: Arc<dyn Hooks>,
}

impl CacheManager {
    pub(crate) fn new(cache_root: PathBuf, config_root: PathBuf) -> Self {
        Self::with_parts(
            cache_root,
            config_root,
            Arc::new(SystemClock),
            Arc::new(NoHooks),
        )
    }

    fn with_parts(
        cache_root: PathBuf,
        config_root: PathBuf,
        clock: Arc<dyn Clock>,
        hooks: Arc<dyn Hooks>,
    ) -> Self {
        let (settings, settings_warning) = load_settings(&config_root);
        Self {
            root: cache_root.join("compiled").join("v1"),
            config_root,
            available: true,
            permit: Mutex::new(()),
            state: Mutex::new(ManagerState {
                settings,
                global_epoch: 0,
                project_epochs: HashMap::new(),
                settings_epoch: 0,
                warnings: CacheWarnings {
                    settings: settings_warning,
                    ..CacheWarnings::default()
                },
            }),
            clock,
            hooks,
        }
    }

    pub(crate) fn unavailable() -> Self {
        Self {
            root: PathBuf::new(),
            config_root: PathBuf::new(),
            available: false,
            permit: Mutex::new(()),
            state: Mutex::new(ManagerState {
                settings: CacheSettings::default(),
                global_epoch: 0,
                project_epochs: HashMap::new(),
                settings_epoch: 0,
                warnings: CacheWarnings {
                    location: Some("compiled cache location is unavailable".into()),
                    ..CacheWarnings::default()
                },
            }),
            clock: Arc::new(SystemClock),
            hooks: Arc::new(NoHooks),
        }
    }

    pub(crate) fn unavailable_with_config(config_root: PathBuf) -> Self {
        let (settings, settings_warning) = load_settings(&config_root);
        Self {
            root: PathBuf::new(),
            config_root,
            available: false,
            permit: Mutex::new(()),
            state: Mutex::new(ManagerState {
                settings,
                global_epoch: 0,
                project_epochs: HashMap::new(),
                settings_epoch: 0,
                warnings: CacheWarnings {
                    location: Some("compiled cache location is unavailable".into()),
                    settings: settings_warning,
                    ..CacheWarnings::default()
                },
            }),
            clock: Arc::new(SystemClock),
            hooks: Arc::new(NoHooks),
        }
    }

    pub(crate) fn effective_path(&self) -> &Path {
        &self.root
    }

    pub(crate) fn settings(&self) -> CacheSettings {
        self.lock_state().settings
    }

    pub(crate) fn warning(&self) -> Option<String> {
        let state = self.lock_state();
        state
            .warnings
            .persistence
            .as_ref()
            .or(state.warnings.location.as_ref())
            .or(state.warnings.settings.as_ref())
            .or(state.warnings.maintenance.as_ref())
            .or(state.warnings.touch.as_ref())
            .cloned()
    }

    pub(crate) fn is_available(&self) -> bool {
        self.available
    }

    /// Captures cache-write authority for one complete compile operation.
    /// This runs before lookup or compilation; preparation is not allowed to
    /// manufacture a newer claim after Clear or settings changes have won.
    pub(crate) fn capture_write_claim(&self, root: &Path) -> ClaimOutcome {
        if !self.available {
            return ClaimOutcome::Unavailable;
        }
        let canonical = match std::fs::canonicalize(root) {
            Ok(canonical) => canonical,
            Err(_) => return ClaimOutcome::Unavailable,
        };
        let project_id = ProjectId::for_root(&canonical);
        let _permit = self.lock_permit();
        let epochs = {
            let state = self.lock_state();
            if !state.settings.enabled {
                return ClaimOutcome::Declined(PersistenceDecline::Disabled);
            }
            Epochs {
                global: state.global_epoch,
                project: state.project_epochs.get(&project_id).copied().unwrap_or(0),
                settings: state.settings_epoch,
            }
        };
        if (|| {
            self.ensure_layout()?;
            let _locks = Locks::project(self, &project_id, LockMode::Shared)?;
            Ok::<(), String>(())
        })()
        .is_err()
        {
            return ClaimOutcome::Unavailable;
        }
        ClaimOutcome::Claimed(WriteClaim { project_id, epochs })
    }

    /// Atomically persists backend-owned settings, publishes them to this
    /// process in the same local-permit order, then enforces a lowered limit.
    pub(crate) fn update_settings(
        &self,
        settings: CacheSettings,
        active_root: Option<&Path>,
    ) -> Result<UsageOutcome, String> {
        let settings = settings.validate()?;
        let active = active_root
            .and_then(|root| std::fs::canonicalize(root).ok())
            .map(|root| ProjectId::for_root(&root));
        let _permit = self.lock_permit();
        let durable = self.write_settings(&settings)?;
        {
            let mut state = self.lock_state();
            state.settings = settings;
            state.settings_epoch += 1;
            *warning_slot(&mut state.warnings, WarningOwner::Settings) =
                (!durable).then(|| "cache settings directory sync failed".to_string());
        }
        if !self.available {
            return Ok(UsageOutcome::Unavailable);
        }
        match self.maintenance_locked(active.as_ref(), settings.maximum_bytes) {
            Ok(usage) => Ok(UsageOutcome::Available(usage)),
            Err(_) => {
                self.set_warning(
                    WarningOwner::Maintenance,
                    "compiled cache maintenance is unavailable",
                );
                Ok(UsageOutcome::Unavailable)
            }
        }
    }

    fn write_settings(&self, settings: &CacheSettings) -> Result<bool, String> {
        ensure_private_dir(&self.config_root)?;
        self.hooks.check(Point::LockConfig)?;
        let config_lock = open_lock(&self.config_root.join("cache.lock"))?;
        lock(&config_lock, LockMode::Exclusive)?;
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|_| "cache settings serialization failed".to_string())?;
        let mut temporary = None;
        for _ in 0..16 {
            let candidate = self.config_root.join(format!(
                ".cache-{}-{}.tmp",
                std::process::id(),
                self.generation_token()?
            ));
            if !candidate.exists() {
                temporary = Some(candidate);
                break;
            }
        }
        let temporary =
            temporary.ok_or_else(|| "cache settings temporary unavailable".to_string())?;
        let mut remove_temporary = true;
        let result = (|| {
            write_new_file(&temporary, &bytes)?;
            self.hooks.check(Point::BeforeSettingsCommit)?;
            atomic_replace(&temporary, &self.config_root.join("cache.json"))?;
            remove_temporary = false;
            // The replacement is already the authoritative settings atom. A
            // directory-sync failure is a durability warning, not licence to
            // publish runtime settings that disagree with the file now visible.
            Ok(sync_dir(&self.config_root).is_ok())
        })();
        if remove_temporary {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    pub(crate) fn prepare(
        &self,
        claim: &WriteClaim,
        plan: &CompilationPlan,
        rules: &yara_x::Rules,
        diagnostics: &[Diagnostic],
        rule_count: usize,
    ) -> PrepareOutcome {
        let project_id = ProjectId::for_root(plan.root());
        if claim.project_id != project_id {
            return PrepareOutcome::Unavailable;
        }
        {
            let _permit = self.lock_permit();
            if let Err(decline) = self.current_claim_settings(claim) {
                return PrepareOutcome::Declined(decline);
            }
            if self.ensure_layout().is_err()
                || Locks::project(self, &project_id, LockMode::Shared).is_err()
            {
                return PrepareOutcome::Unavailable;
            }
        }
        let inputs = plan.closure().iter().map(StoredInput::from).collect();
        let diagnostics = match diagnostics
            .iter()
            .map(|diagnostic| StoredDiagnostic::new(diagnostic, plan))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(diagnostics) => diagnostics,
            Err(_) => return self.finish_prepare_failure(claim, PrepareFailure::Unavailable),
        };
        if self.hooks.check(Point::BeforeSerialize).is_err() {
            return self.finish_prepare_failure(claim, PrepareFailure::Unavailable);
        }
        let (artifact, artifact_digest) = match serialize_artifact(rules) {
            Ok(artifact) => artifact,
            Err(SerializationFailure::OverLimit) => {
                return self.finish_prepare_failure(claim, PrepareFailure::ArtifactOverLimit);
            }
            Err(SerializationFailure::Unavailable) => {
                return self.finish_prepare_failure(claim, PrepareFailure::Unavailable);
            }
        };
        PrepareOutcome::Prepared(ProposedEntry {
            project_id,
            fingerprint: plan.fingerprint(),
            inputs,
            diagnostics,
            rule_count,
            artifact,
            artifact_digest,
            epochs: claim.epochs.clone(),
            created: self.clock.now(),
        })
    }

    fn finish_prepare_failure(
        &self,
        claim: &WriteClaim,
        failure: PrepareFailure,
    ) -> PrepareOutcome {
        let _permit = self.lock_permit();
        if let Err(decline) = self.current_claim_settings(claim) {
            return PrepareOutcome::Declined(decline);
        }
        match failure {
            PrepareFailure::ArtifactOverLimit => PrepareOutcome::ArtifactOverLimit,
            PrepareFailure::Unavailable => PrepareOutcome::Unavailable,
        }
    }

    fn current_claim_settings(
        &self,
        claim: &WriteClaim,
    ) -> Result<CacheSettings, PersistenceDecline> {
        let state = self.lock_state();
        if state.global_epoch != claim.epochs.global
            || state
                .project_epochs
                .get(&claim.project_id)
                .copied()
                .unwrap_or(0)
                != claim.epochs.project
        {
            return Err(PersistenceDecline::Cleared);
        }
        if state.settings_epoch != claim.epochs.settings {
            return Err(if state.settings.enabled {
                PersistenceDecline::Superseded
            } else {
                PersistenceDecline::Disabled
            });
        }
        if !state.settings.enabled {
            return Err(PersistenceDecline::Disabled);
        }
        Ok(state.settings)
    }

    #[cfg(test)]
    pub(crate) fn commit(&self, proposal: ProposedEntry) -> CommitOutcome {
        self.commit_observed(proposal, None)
    }

    pub(crate) fn commit_observed(
        &self,
        proposal: ProposedEntry,
        trace: Option<&crate::debug_trace::DebugTrace>,
    ) -> CommitOutcome {
        let outcome = self.commit_inner(proposal, trace);
        if let Some(trace) = trace {
            trace.event_lazy("cache_persistence", || {
                serde_json::json!({
                    "stage": "commit", "outcome": format!("{outcome:?}"),
                })
            });
        }
        outcome
    }

    fn commit_inner(
        &self,
        proposal: ProposedEntry,
        trace: Option<&crate::debug_trace::DebugTrace>,
    ) -> CommitOutcome {
        if !self.available {
            return CommitOutcome::Unavailable;
        }
        let _permit = self.lock_permit();
        let active_project = proposal.project_id.clone();
        let settings = {
            let claim = WriteClaim {
                project_id: proposal.project_id.clone(),
                epochs: proposal.epochs.clone(),
            };
            match self.current_claim_settings(&claim) {
                Ok(settings) => settings,
                Err(decline) => return CommitOutcome::Declined(decline),
            }
        };

        match self.commit_locked(proposal, settings.maximum_bytes) {
            Ok(CommitOutcome::Committed) => {
                // The just-compiled project is the active entry for automatic
                // quota. Persistence has already committed, so maintenance
                // failure is a warning and never changes compile success.
                let maintenance =
                    self.maintenance_locked(Some(&active_project), settings.maximum_bytes);
                if let Some(trace) = trace {
                    trace.event_lazy("cache_persistence", || serde_json::json!({
                        "stage": "maintenance", "ok": maintenance.is_ok(),
                        "currentProjectCached": maintenance.as_ref().ok().map(|usage| usage.current_project_cached),
                    }));
                }
                if maintenance.is_err() {
                    self.set_warning(
                        WarningOwner::Maintenance,
                        "compiled cache maintenance is unavailable",
                    );
                }
                CommitOutcome::Committed
            }
            Ok(outcome @ CommitOutcome::ArtifactOverLimit) => outcome,
            Ok(outcome @ CommitOutcome::MetadataOverLimit) => outcome,
            Ok(outcome @ CommitOutcome::QuotaExceeded) => outcome,
            Ok(outcome @ CommitOutcome::Declined(_)) => outcome,
            Ok(CommitOutcome::Unavailable) => CommitOutcome::Unavailable,
            Err(reason) => {
                if let Some(trace) = trace {
                    // Cache errors are fixed operation labels, optionally with a
                    // numeric OS error; never raw OS text containing paths.
                    trace.event_lazy("cache_persistence", || {
                        serde_json::json!({
                            "stage": "storage", "outcome": "failed", "reason": reason,
                        })
                    });
                }
                CommitOutcome::Unavailable
            }
        }
    }

    pub(crate) fn record_prepare_outcome(&self, outcome: &PrepareOutcome) {
        match outcome {
            PrepareOutcome::Prepared(_) => {}
            PrepareOutcome::Declined(decline) => {
                let _ = decline;
            }
            PrepareOutcome::ArtifactOverLimit => self.set_warning(
                WarningOwner::Persistence,
                "compiled cache artifact exceeds the 256 MiB safety limit",
            ),
            PrepareOutcome::Unavailable => self.set_warning(
                WarningOwner::Persistence,
                "compiled cache preparation or serialization is unavailable",
            ),
        }
    }

    pub(crate) fn record_commit_outcome(&self, outcome: CommitOutcome) {
        match outcome {
            CommitOutcome::Committed => {
                self.clear_warning(WarningOwner::Persistence);
                self.clear_warning(WarningOwner::Location);
            }
            CommitOutcome::Declined(_) => {}
            CommitOutcome::ArtifactOverLimit => self.set_warning(
                WarningOwner::Persistence,
                "compiled cache artifact exceeds the 256 MiB safety limit",
            ),
            CommitOutcome::MetadataOverLimit => self.set_warning(
                WarningOwner::Persistence,
                "compiled cache metadata exceeds the 16 MiB safety limit",
            ),
            CommitOutcome::QuotaExceeded => self.set_warning(
                WarningOwner::Persistence,
                "compiled cache entry exceeds the configured maximum",
            ),
            CommitOutcome::Unavailable => self.set_warning(
                WarningOwner::Persistence,
                "compiled cache commit storage or serialization is unavailable",
            ),
        }
    }

    pub(crate) fn record_persistence_task_failure(&self) {
        self.set_warning(
            WarningOwner::Persistence,
            "compiled cache persistence task is unavailable",
        );
    }

    fn commit_locked(
        &self,
        proposal: ProposedEntry,
        maximum_bytes: u64,
    ) -> Result<CommitOutcome, String> {
        let artifact_bytes = u64::try_from(proposal.artifact.len()).unwrap_or(u64::MAX);
        if artifact_bytes > MAX_ARTIFACT_BYTES {
            return Ok(CommitOutcome::ArtifactOverLimit);
        }
        let generation = self.generation_token()?;
        let artifact_name = artifact_name(proposal.fingerprint, &generation);
        let metadata = Metadata {
            schema: METADATA_SCHEMA,
            fingerprint_encoding: FINGERPRINT_ENCODING_VERSION,
            compiler_cache_epoch: COMPILER_CACHE_EPOCH,
            yara_x_version: yara_x::VERSION.to_string(),
            compiler_profile: COMPILER_PROFILE.to_string(),
            project_id: proposal.project_id.0.clone(),
            target: TARGET.to_string(),
            fingerprint: proposal.fingerprint.to_hex(),
            inputs: proposal.inputs,
            artifact: StoredArtifact {
                generation,
                bytes: artifact_bytes,
                digest: proposal.artifact_digest,
                native_code: false,
                target: None,
            },
            rule_count: proposal.rule_count,
            diagnostics: proposal.diagnostics,
            created_unix_seconds: proposal.created,
            last_used_unix_seconds: proposal.created,
        };
        let metadata_bytes = match serialize_metadata(&metadata) {
            Ok(bytes) => bytes,
            Err(SerializationFailure::OverLimit) => {
                return Ok(CommitOutcome::MetadataOverLimit);
            }
            Err(SerializationFailure::Unavailable) => {
                return Err("compiled cache metadata serialization failed".into());
            }
        };
        let metadata_length = u64::try_from(metadata_bytes.len()).unwrap_or(u64::MAX);
        if artifact_bytes
            .checked_add(metadata_length)
            .is_none_or(|entry_bytes| entry_bytes > maximum_bytes)
        {
            return Ok(CommitOutcome::QuotaExceeded);
        }

        self.ensure_layout()?;
        let _locks = Locks::project(self, &proposal.project_id, LockMode::Shared)?;
        let target_dir = self.target_dir(&proposal.project_id);
        ensure_private_dir(
            &self
                .root
                .join("projects")
                .join(proposal.project_id.as_str()),
        )?;
        ensure_private_dir(&target_dir)?;
        let old = match read_metadata_any(&target_dir.join("metadata.json")) {
            Ok(old) => old,
            Err(ReadFailure::Corrupt) => None,
            Err(ReadFailure::Unavailable) => return Err("metadata unavailable".into()),
        };
        let artifact_path = target_dir.join(&artifact_name);

        let artifact_temp = self.unique_temp(&target_dir, "artifact")?;
        let mut remove_temp = true;
        let result = (|| {
            self.hooks.check(Point::BeforeArtifactWrite)?;
            write_new_file(&artifact_temp, &proposal.artifact)?;
            self.hooks.check(Point::BeforeArtifactInstall)?;
            install_no_replace(&artifact_temp, &artifact_path)?;
            remove_temp = false;
            self.hooks.check(Point::AfterArtifactInstall)?;

            let metadata_temp = self.unique_temp(&target_dir, "metadata")?;
            let mut remove_metadata_temp = true;
            let metadata_result = (|| {
                write_new_file(&metadata_temp, &metadata_bytes)?;
                self.hooks.check(Point::BeforeMetadataCommit)?;
                atomic_replace(&metadata_temp, &target_dir.join("metadata.json"))?;
                remove_metadata_temp = false;
                self.hooks.check(Point::AfterMetadataCommit)?;
                sync_dir(&target_dir)?;
                Ok::<(), String>(())
            })();
            if remove_metadata_temp {
                let _ = std::fs::remove_file(&metadata_temp);
            }
            metadata_result?;
            Ok::<(), String>(())
        })();
        if remove_temp {
            let _ = std::fs::remove_file(&artifact_temp);
        }
        result?;

        if let Some(old) = old
            && let Some(old_name) = validated_artifact_name(&old)
            && old_name != artifact_name
        {
            let _ = remove_nofollow_file(&target_dir.join(old_name));
        }
        Ok(CommitOutcome::Committed)
    }

    pub(crate) fn load(&self, plan: &CompilationPlan) -> LoadOutcome {
        self.load_observed(plan, None)
    }

    /// The production lookup with optional stage records. The observer is the
    /// concrete non-blocking debug tracer rather than a callback: cache and file
    /// locks may be held at these points, so arbitrary code must never run here.
    pub(crate) fn load_observed(
        &self,
        plan: &CompilationPlan,
        trace: Option<&crate::debug_trace::DebugTrace>,
    ) -> LoadOutcome {
        if !self.available {
            cache_stage!(trace, "availability", "unavailable", serde_json::json!({}));
            return LoadOutcome::Unavailable;
        }
        cache_stage!(
            trace,
            "lock",
            "waiting_process_permit",
            serde_json::json!({}),
        );
        let _permit = self.lock_permit();
        cache_stage!(
            trace,
            "lock",
            "process_permit_acquired",
            serde_json::json!({}),
        );
        let settings = self.lock_state().settings;
        if !settings.enabled {
            cache_stage!(trace, "settings", "disabled", serde_json::json!({}));
            return LoadOutcome::Disabled;
        }
        let outcome = match self.load_locked(plan, settings.maximum_bytes, trace) {
            Ok(outcome) => {
                self.clear_warning(WarningOwner::Location);
                outcome
            }
            Err(_) => {
                self.set_warning(
                    WarningOwner::Location,
                    "compiled cache storage is unavailable",
                );
                LoadOutcome::Unavailable
            }
        };
        let (result, reason) = match &outcome {
            LoadOutcome::Hit(_) => ("hit", None),
            LoadOutcome::Miss(reason) => (
                "miss",
                Some(match reason {
                    MissReason::Absent => "absent",
                    MissReason::Fingerprint => "fingerprint",
                    MissReason::Compatibility => "compatibility",
                    MissReason::Corrupt => "corrupt",
                }),
            ),
            LoadOutcome::Disabled => ("disabled", None),
            LoadOutcome::Unavailable => ("unavailable", None),
        };
        cache_stage!(
            trace,
            "outcome",
            result,
            serde_json::json!({ "reason": reason }),
        );
        outcome
    }

    fn load_locked(
        &self,
        plan: &CompilationPlan,
        maximum_bytes: u64,
        trace: Option<&crate::debug_trace::DebugTrace>,
    ) -> Result<LoadOutcome, String> {
        self.ensure_layout()?;
        let project_id = ProjectId::for_root(plan.root());
        cache_stage!(trace, "lock", "waiting_project_lock", serde_json::json!({}));
        let _locks = Locks::project(self, &project_id, LockMode::Shared)?;
        cache_stage!(
            trace,
            "lock",
            "project_lock_acquired",
            serde_json::json!({}),
        );
        let target_dir = self.target_dir(&project_id);
        if !target_dir.exists() {
            return Ok(LoadOutcome::Miss(MissReason::Absent));
        }
        ensure_existing_dir(&self.root.join("projects").join(project_id.as_str()))?;
        ensure_existing_dir(&target_dir)?;
        let metadata_path = target_dir.join("metadata.json");
        cache_stage!(trace, "metadata", "read_started", serde_json::json!({}));
        let mut metadata = match read_metadata(&metadata_path) {
            Ok(Some(metadata)) => {
                cache_stage!(trace, "metadata", "read", serde_json::json!({}));
                metadata
            }
            Ok(None) => {
                cache_stage!(trace, "metadata", "absent", serde_json::json!({}));
                return Ok(LoadOutcome::Miss(MissReason::Absent));
            }
            Err(ReadFailure::Corrupt) => {
                cache_stage!(trace, "metadata", "corrupt", serde_json::json!({}));
                let _ = remove_nofollow_file(&metadata_path);
                return Ok(LoadOutcome::Miss(MissReason::Corrupt));
            }
            Err(ReadFailure::Unavailable) => {
                cache_stage!(trace, "metadata", "unavailable", serde_json::json!({}));
                return Err("metadata unavailable".into());
            }
        };
        let expected_fingerprint = plan.fingerprint();
        match compatible(&metadata, &project_id, expected_fingerprint, plan) {
            Compatibility::Fingerprint => {
                cache_stage!(
                    trace,
                    "metadata",
                    "fingerprint_mismatch",
                    serde_json::json!({}),
                );
                return Ok(LoadOutcome::Miss(MissReason::Fingerprint));
            }
            Compatibility::Other => {
                cache_stage!(trace, "metadata", "incompatible", serde_json::json!({}));
                return Ok(LoadOutcome::Miss(MissReason::Compatibility));
            }
            Compatibility::Compatible => {
                cache_stage!(trace, "metadata", "validated", serde_json::json!({}));
            }
        }
        let Some(name) = validated_artifact_name(&metadata) else {
            cache_stage!(
                trace,
                "metadata",
                "invalid_artifact_identity",
                serde_json::json!({}),
            );
            let _ = remove_nofollow_file(&metadata_path);
            return Ok(LoadOutcome::Miss(MissReason::Corrupt));
        };
        let artifact_path = target_dir.join(&name);
        let diagnostics = match resolve_diagnostics(&metadata.diagnostics, plan) {
            Ok(diagnostics) => {
                cache_stage!(
                    trace,
                    "metadata",
                    "diagnostics_resolved",
                    serde_json::json!({ "diagnosticCount": diagnostics.len() }),
                );
                diagnostics
            }
            Err(()) => {
                cache_stage!(
                    trace,
                    "metadata",
                    "diagnostics_invalid",
                    serde_json::json!({}),
                );
                let _ = remove_nofollow_file(&metadata_path);
                let _ = remove_nofollow_file(&artifact_path);
                return Ok(LoadOutcome::Miss(MissReason::Corrupt));
            }
        };
        if metadata.artifact.bytes > maximum_bytes {
            cache_stage!(
                trace,
                "artifact_read",
                "configured_quota_rejected",
                serde_json::json!({ "artifactBytes": metadata.artifact.bytes }),
            );
            return Ok(LoadOutcome::Miss(MissReason::Compatibility));
        }
        cache_stage!(
            trace,
            "artifact_read",
            "started",
            serde_json::json!({ "artifactBytes": metadata.artifact.bytes }),
        );
        let artifact = match read_regular_bounded(&artifact_path, metadata.artifact.bytes) {
            Ok(bytes) => {
                cache_stage!(
                    trace,
                    "artifact_read",
                    "completed",
                    serde_json::json!({ "artifactBytes": bytes.len() }),
                );
                bytes
            }
            Err(ReadFailure::Corrupt) => {
                cache_stage!(trace, "artifact_read", "corrupt", serde_json::json!({}));
                let _ = remove_nofollow_file(&metadata_path);
                let _ = remove_nofollow_file(&artifact_path);
                return Ok(LoadOutcome::Miss(MissReason::Corrupt));
            }
            Err(ReadFailure::Unavailable) => {
                cache_stage!(trace, "artifact_read", "unavailable", serde_json::json!({}));
                return Err("artifact unavailable".into());
            }
        };
        cache_stage!(trace, "artifact_hash", "started", serde_json::json!({}));
        self.hooks.check(Point::BeforeArtifactHash)?;
        if blake3::hash(&artifact).to_hex().as_str() != metadata.artifact.digest {
            cache_stage!(trace, "artifact_hash", "mismatch", serde_json::json!({}));
            let _ = remove_nofollow_file(&metadata_path);
            let _ = remove_nofollow_file(&artifact_path);
            return Ok(LoadOutcome::Miss(MissReason::Corrupt));
        }
        cache_stage!(trace, "artifact_hash", "validated", serde_json::json!({}));
        let hooks = Arc::clone(&self.hooks);
        cache_stage!(trace, "deserialize", "started", serde_json::json!({}));
        let rules = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            hooks.check(Point::BeforeDeserialize)?;
            yara_x::Rules::deserialize(&artifact).map_err(|_| "deserialize failed".to_string())
        })) {
            Ok(Ok(rules)) => {
                cache_stage!(trace, "deserialize", "completed", serde_json::json!({}));
                rules
            }
            Ok(Err(_)) | Err(_) => {
                cache_stage!(trace, "deserialize", "failed", serde_json::json!({}));
                let _ = remove_nofollow_file(&metadata_path);
                let _ = remove_nofollow_file(&artifact_path);
                return Ok(LoadOutcome::Miss(MissReason::Corrupt));
            }
        };
        let actual_rule_count = rules.iter().count();
        cache_stage!(
            trace,
            "rule_count_validation",
            if actual_rule_count == metadata.rule_count {
                "validated"
            } else {
                "mismatch"
            },
            serde_json::json!({
                "actualRuleCount": actual_rule_count,
                "expectedRuleCount": metadata.rule_count,
            }),
        );
        if actual_rule_count != metadata.rule_count {
            let _ = remove_nofollow_file(&metadata_path);
            let _ = remove_nofollow_file(&artifact_path);
            return Ok(LoadOutcome::Miss(MissReason::Corrupt));
        }
        let now = self.clock.now();
        if now.saturating_sub(metadata.last_used_unix_seconds) >= LAST_USED_INTERVAL_SECONDS {
            metadata.last_used_unix_seconds = now;
            if self.touch_metadata(&target_dir, &metadata).is_err() {
                // The fully validated rules are already in memory. A bookkeeping
                // write cannot demote the hit or delete its committed metadata.
                self.set_warning(
                    WarningOwner::Touch,
                    "compiled cache last-used update failed",
                );
            } else {
                self.clear_warning(WarningOwner::Touch);
            }
        }
        Ok(LoadOutcome::Hit(LoadedEntry {
            rules: Box::new(rules),
            diagnostics,
            rule_count: metadata.rule_count,
        }))
    }

    pub(crate) fn clear_current(&self, root: &Path) -> ClearOutcome {
        if !self.available {
            return ClearOutcome::Unavailable;
        }
        let project_id = match std::fs::canonicalize(root) {
            Ok(root) => ProjectId::for_root(&root),
            Err(_) => return ClearOutcome::Unavailable,
        };
        {
            let mut state = self.lock_state();
            *state.project_epochs.entry(project_id.clone()).or_default() += 1;
        }
        if self.hooks.check(Point::AfterClearEpoch).is_err() {
            return ClearOutcome::Unavailable;
        }
        let _permit = self.lock_permit();
        match (|| {
            self.ensure_layout()?;
            let _locks = Locks::project(self, &project_id, LockMode::Shared)?;
            remove_tree_nofollow(&self.target_dir(&project_id))
        })() {
            Ok(()) => {
                self.clear_warning(WarningOwner::Location);
                ClearOutcome::Cleared
            }
            Err(_) => {
                self.set_warning(
                    WarningOwner::Location,
                    "compiled cache storage is unavailable",
                );
                ClearOutcome::Unavailable
            }
        }
    }

    pub(crate) fn clear_all(&self) -> ClearOutcome {
        if !self.available {
            return ClearOutcome::Unavailable;
        }
        {
            let mut state = self.lock_state();
            state.global_epoch += 1;
        }
        if self.hooks.check(Point::AfterClearEpoch).is_err() {
            return ClearOutcome::Unavailable;
        }
        let _permit = self.lock_permit();
        match (|| {
            self.ensure_layout()?;
            let _global = Locks::global(self, LockMode::Exclusive)?;
            clear_children_nofollow(&self.root.join("projects"))
        })() {
            Ok(()) => {
                self.clear_warning(WarningOwner::Location);
                ClearOutcome::Cleared
            }
            Err(_) => {
                self.set_warning(
                    WarningOwner::Location,
                    "compiled cache storage is unavailable",
                );
                ClearOutcome::Unavailable
            }
        }
    }

    /// Cleans owned debris, enforces quota and returns exact managed usage.
    /// `active_root` is accepted only as a project root and converted here; no
    /// cache path or project ID crosses the management boundary.
    pub(crate) fn maintain(&self, active_root: Option<&Path>) -> UsageOutcome {
        if !self.available {
            return UsageOutcome::Unavailable;
        }
        let active = active_root
            .and_then(|root| std::fs::canonicalize(root).ok())
            .map(|root| ProjectId::for_root(&root));
        let _permit = self.lock_permit();
        let maximum = self.lock_state().settings.maximum_bytes;
        match self.maintenance_locked(active.as_ref(), maximum) {
            Ok(usage) => UsageOutcome::Available(usage),
            Err(_) => {
                self.set_warning(
                    WarningOwner::Maintenance,
                    "compiled cache maintenance is unavailable",
                );
                UsageOutcome::Unavailable
            }
        }
    }

    fn touch_metadata(&self, target_dir: &Path, metadata: &Metadata) -> Result<(), String> {
        let bytes = serialize_metadata(metadata)
            .map_err(|_| "compiled cache metadata serialization failed".to_string())?;
        let temporary = self.unique_temp(target_dir, "metadata")?;
        let mut remove_temporary = true;
        let result = (|| {
            write_new_file(&temporary, &bytes)?;
            self.hooks.check(Point::BeforeLastUsedCommit)?;
            atomic_replace(&temporary, &target_dir.join("metadata.json"))?;
            remove_temporary = false;
            sync_dir(target_dir)
        })();
        if remove_temporary {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    fn maintenance_locked(
        &self,
        active: Option<&ProjectId>,
        maximum_bytes: u64,
    ) -> Result<CacheUsage, String> {
        self.ensure_layout()?;
        let projects_root = self.root.join("projects");
        // Full maintenance owns the global lock exclusively before it inspects
        // project names. Valid project locks are then appended in ID order while
        // that global exclusion prevents a one-project operation entering.
        let mut locks = Locks::global(self, LockMode::Exclusive)?;
        let mut project_dirs = Vec::new();
        let mut other_children = Vec::new();
        for entry in std::fs::read_dir(&projects_root).map_err(|_| "cache directory unavailable")? {
            let entry = entry.map_err(|_| "cache directory unavailable")?;
            let path = entry.path();
            let metadata =
                std::fs::symlink_metadata(&path).map_err(|_| "cache directory unavailable")?;
            let id = entry.file_name().to_str().and_then(ProjectId::parse);
            if metadata.file_type().is_dir()
                && let Some(id) = id
            {
                project_dirs.push((id, path));
            } else {
                other_children.push(path);
            }
        }
        project_dirs.sort_by(|left, right| left.0.cmp(&right.0));
        let ids = project_dirs
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        locks.lock_projects(self, &ids)?;

        let mut incomplete = false;
        for path in other_children {
            if self.remove_for_maintenance(&path).is_err() {
                incomplete = true;
            }
        }

        let mut live = Vec::new();
        for (project_id, project_dir) in &project_dirs {
            match self.inspect_project(project_id, project_dir) {
                Ok((entry, clean)) => {
                    incomplete |= !clean;
                    if let Some(entry) = entry {
                        live.push(entry);
                    }
                }
                Err(_) => incomplete = true,
            }
        }

        let mut total = regular_usage_nofollow(&projects_root)?;
        let was_over_high_water = total > maximum_bytes;
        let low_water = maximum_bytes.saturating_mul(LOW_WATER_NUMERATOR) / LOW_WATER_DENOMINATOR;
        let mut live_projects = live
            .iter()
            .map(|entry| entry.project_id.clone())
            .collect::<HashSet<_>>();
        if was_over_high_water {
            live.sort_by(|left, right| {
                (left.last_used, &left.project_id, &left.target).cmp(&(
                    right.last_used,
                    &right.project_id,
                    &right.target,
                ))
            });
            for entry in &live {
                if total <= low_water {
                    break;
                }
                if active == Some(&entry.project_id) {
                    continue;
                }
                match self.evict(entry) {
                    Ok(()) => {
                        live_projects.remove(&entry.project_id);
                        total = regular_usage_nofollow(&projects_root)?;
                    }
                    Err(_) => incomplete = true,
                }
            }
        }

        // Recount after every cleanup/eviction attempt. Files whose removal
        // failed, including orphan artifacts, remain visible in exact usage.
        total = regular_usage_nofollow(&projects_root)?;
        let current_project_bytes = match active {
            Some(project) => regular_usage_nofollow(&projects_root.join(project.as_str()))?,
            None => 0,
        };
        if incomplete || (was_over_high_water && total > low_water) {
            self.set_warning(
                WarningOwner::Maintenance,
                "compiled cache maintenance could not reach its target",
            );
        } else {
            self.clear_warning(WarningOwner::Maintenance);
        }
        Ok(CacheUsage {
            total_bytes: total,
            current_project_bytes,
            current_project_cached: active.is_some_and(|id| live_projects.contains(id)),
        })
    }

    /// Returns the one live target entry and whether every licensed cleanup
    /// succeeded. Unknown files are retained (and counted) because their names do
    /// not prove cache ownership.
    fn inspect_project(
        &self,
        project_id: &ProjectId,
        project_dir: &Path,
    ) -> Result<(Option<LiveEntry>, bool), String> {
        let target_dir = project_dir.join(TARGET);
        let target_type = match std::fs::symlink_metadata(&target_dir) {
            Ok(metadata) => metadata.file_type(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((None, true));
            }
            Err(_) => return Err("cache entry unavailable".into()),
        };
        if !target_type.is_dir() {
            return Ok((None, self.remove_for_maintenance(&target_dir).is_ok()));
        }

        let metadata_path = target_dir.join("metadata.json");
        let metadata = match read_metadata(&metadata_path) {
            Ok(metadata) => metadata,
            Err(ReadFailure::Corrupt) => None,
            // A sharing violation or other I/O failure is not evidence that
            // metadata (or its artifact) is invalid. Leave both for a retry.
            Err(ReadFailure::Unavailable) => return Err("cache metadata unavailable".into()),
        };
        let mut clean = true;
        let mut live = None;
        let mut live_artifact = None;
        if let Some(metadata) = metadata {
            let artifact_name = validated_artifact_name(&metadata);
            let structurally_valid = metadata.schema == METADATA_SCHEMA
                && metadata.fingerprint_encoding == FINGERPRINT_ENCODING_VERSION
                && metadata.compiler_cache_epoch == COMPILER_CACHE_EPOCH
                && metadata.yara_x_version == yara_x::VERSION
                && metadata.compiler_profile == COMPILER_PROFILE
                && metadata.project_id == project_id.as_str()
                && metadata.target == TARGET
                && !metadata.artifact.native_code
                && metadata.artifact.target.is_none()
                && is_lower_hex(&metadata.artifact.digest, 64);
            if structurally_valid && let Some(name) = artifact_name {
                let artifact_path = target_dir.join(&name);
                let artifact_valid = match digest_regular_exact(
                    &artifact_path,
                    metadata.artifact.bytes,
                    self.hooks.as_ref(),
                ) {
                    Ok(digest) => digest == metadata.artifact.digest,
                    Err(ReadFailure::Corrupt) => false,
                    Err(ReadFailure::Unavailable) => {
                        return Err("cache artifact unavailable".into());
                    }
                };
                if artifact_valid {
                    live_artifact = Some(name);
                    live = Some(LiveEntry {
                        project_id: project_id.clone(),
                        target: TARGET.to_string(),
                        metadata_path: metadata_path.clone(),
                        artifact_path,
                        last_used: metadata.last_used_unix_seconds,
                    });
                }
            }
        }

        if live.is_none()
            && std::fs::symlink_metadata(&metadata_path).is_ok()
            && self.remove_for_maintenance(&metadata_path).is_err()
        {
            clean = false;
        }
        for entry in std::fs::read_dir(&target_dir).map_err(|_| "cache entry unavailable")? {
            let entry = entry.map_err(|_| "cache entry unavailable")?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name == "metadata.json" || live_artifact.as_deref() == Some(name) {
                continue;
            }
            if (is_cache_temporary(name) || is_artifact_filename(name))
                && self.remove_for_maintenance(&entry.path()).is_err()
            {
                clean = false;
            }
        }
        Ok((live, clean))
    }

    fn evict(&self, entry: &LiveEntry) -> Result<(), String> {
        self.hooks.check(Point::MaintenanceRemove)?;
        // Metadata is the authority. Remove it first so an artifact-removal
        // failure leaves an unmistakable orphan rather than committed metadata
        // naming a missing artifact.
        remove_nofollow_file(&entry.metadata_path)?;
        remove_nofollow_file(&entry.artifact_path)?;
        if let Some(target_dir) = entry.metadata_path.parent() {
            let _ = std::fs::remove_dir(target_dir);
            if let Some(project_dir) = target_dir.parent() {
                let _ = std::fs::remove_dir(project_dir);
            }
        }
        Ok(())
    }

    fn remove_for_maintenance(&self, path: &Path) -> Result<(), String> {
        self.hooks.check(Point::MaintenanceRemove)?;
        remove_tree_nofollow(path)
    }

    fn ensure_layout(&self) -> Result<(), String> {
        ensure_private_dir(&self.root)?;
        ensure_private_dir(&self.root.join("locks"))?;
        ensure_private_dir(&self.root.join("projects"))?;
        Ok(())
    }

    fn target_dir(&self, project_id: &ProjectId) -> PathBuf {
        self.root
            .join("projects")
            .join(project_id.as_str())
            .join(TARGET)
    }

    fn generation_token(&self) -> Result<String, String> {
        self.hooks.check(Point::GenerateToken)?;
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| "generation token unavailable".to_string())?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    fn unique_temp(&self, directory: &Path, kind: &str) -> Result<PathBuf, String> {
        for _ in 0..16 {
            let token = self.generation_token()?;
            let path = directory.join(format!(".{kind}-{}-{token}.tmp", std::process::id()));
            if !path.exists() {
                return Ok(path);
            }
        }
        Err("could not claim a unique cache temporary".into())
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, ManagerState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn lock_permit(&self) -> std::sync::MutexGuard<'_, ()> {
        self.permit
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn set_warning(&self, owner: WarningOwner, warning: &str) {
        let mut state = self.lock_state();
        *warning_slot(&mut state.warnings, owner) = Some(warning.to_string());
    }

    fn clear_warning(&self, owner: WarningOwner) {
        let mut state = self.lock_state();
        *warning_slot(&mut state.warnings, owner) = None;
    }
}

fn warning_slot(warnings: &mut CacheWarnings, owner: WarningOwner) -> &mut Option<String> {
    match owner {
        WarningOwner::Location => &mut warnings.location,
        WarningOwner::Settings => &mut warnings.settings,
        WarningOwner::Persistence => &mut warnings.persistence,
        WarningOwner::Maintenance => &mut warnings.maintenance,
        WarningOwner::Touch => &mut warnings.touch,
    }
}

struct ArtifactBuffer {
    bytes: Vec<u8>,
    digest: blake3::Hasher,
    maximum: u64,
    failure: Option<SerializationFailure>,
}

impl ArtifactBuffer {
    fn new(maximum: u64) -> Self {
        Self {
            bytes: Vec::new(),
            digest: blake3::Hasher::new(),
            maximum,
            failure: None,
        }
    }

    fn finish(self) -> Result<(Vec<u8>, String), SerializationFailure> {
        if let Some(failure) = self.failure {
            return Err(failure);
        }
        Ok((self.bytes, self.digest.finalize().to_hex().to_string()))
    }
}

impl Write for ArtifactBuffer {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let next = self
            .bytes
            .len()
            .checked_add(buffer.len())
            .and_then(|length| u64::try_from(length).ok());
        if next.is_none_or(|length| length > self.maximum) {
            self.failure = Some(SerializationFailure::OverLimit);
            return Err(io::Error::other("compiled cache artifact limit exceeded"));
        }
        if self.bytes.try_reserve_exact(buffer.len()).is_err() {
            self.failure = Some(SerializationFailure::Unavailable);
            return Err(io::Error::other(
                "compiled cache artifact allocation failed",
            ));
        }
        self.bytes.extend_from_slice(buffer);
        self.digest.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn serialize_artifact(rules: &yara_x::Rules) -> Result<(Vec<u8>, String), SerializationFailure> {
    let mut artifact = ArtifactBuffer::new(MAX_ARTIFACT_BYTES);
    let serialized = rules.serialize_into(&mut artifact);
    if serialized.is_err() && artifact.failure.is_none() {
        return Err(SerializationFailure::Unavailable);
    }
    artifact.finish()
}

struct MetadataBuffer {
    bytes: Vec<u8>,
    maximum: u64,
    failure: Option<SerializationFailure>,
}

impl MetadataBuffer {
    fn new(maximum: u64) -> Self {
        Self {
            bytes: Vec::new(),
            maximum,
            failure: None,
        }
    }

    fn finish(self) -> Result<Vec<u8>, SerializationFailure> {
        match self.failure {
            Some(failure) => Err(failure),
            None => Ok(self.bytes),
        }
    }
}

impl Write for MetadataBuffer {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let next = self
            .bytes
            .len()
            .checked_add(buffer.len())
            .and_then(|length| u64::try_from(length).ok());
        if next.is_none_or(|length| length > self.maximum) {
            self.failure = Some(SerializationFailure::OverLimit);
            return Err(io::Error::other("compiled cache metadata limit exceeded"));
        }
        if self.bytes.try_reserve_exact(buffer.len()).is_err() {
            self.failure = Some(SerializationFailure::Unavailable);
            return Err(io::Error::other(
                "compiled cache metadata allocation failed",
            ));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn serialize_metadata(metadata: &Metadata) -> Result<Vec<u8>, SerializationFailure> {
    let mut buffer = MetadataBuffer::new(MAX_METADATA_BYTES);
    let serialized = serde_json::to_writer(&mut buffer, metadata);
    if serialized.is_err() && buffer.failure.is_none() {
        return Err(SerializationFailure::Unavailable);
    }
    buffer.finish()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    schema: u32,
    fingerprint_encoding: u32,
    compiler_cache_epoch: u32,
    yara_x_version: String,
    compiler_profile: String,
    project_id: String,
    target: String,
    fingerprint: String,
    inputs: Vec<StoredInput>,
    artifact: StoredArtifact,
    rule_count: usize,
    diagnostics: Vec<StoredDiagnostic>,
    created_unix_seconds: u64,
    last_used_unix_seconds: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
struct StoredIdentity {
    external: bool,
    path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct StoredInput {
    identity: StoredIdentity,
    bytes: u64,
    digest: String,
}

impl From<&crate::project::PlanInput> for StoredInput {
    fn from(input: &crate::project::PlanInput) -> Self {
        Self {
            identity: stored_identity(input),
            bytes: input.evidence.bytes,
            digest: input
                .evidence
                .digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredArtifact {
    generation: String,
    bytes: u64,
    digest: String,
    native_code: bool,
    target: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct StoredSpan {
    start: usize,
    end: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredDiagnostic {
    severity: String,
    code: String,
    title: String,
    line: usize,
    column: usize,
    span: StoredSpan,
    input_reference: Option<StoredIdentity>,
}

impl StoredDiagnostic {
    fn new(value: &Diagnostic, plan: &CompilationPlan) -> Result<Self, String> {
        let input_reference = match value.file.as_deref() {
            None => None,
            Some(file) => Some(
                plan.closure()
                    .iter()
                    .find(|input| to_slash(&input.canonical).as_deref() == Some(file))
                    .map(stored_identity)
                    .ok_or_else(|| {
                        "compiled cache diagnostic source is outside the validated plan".to_string()
                    })?,
            ),
        };
        Ok(Self {
            severity: value.severity.to_string(),
            code: value.code.clone(),
            title: value.title.clone(),
            line: value.line,
            column: value.column,
            span: StoredSpan {
                start: value.span.start,
                end: value.span.end,
            },
            input_reference,
        })
    }

    fn resolve(&self, paths: &HashMap<StoredIdentity, String>) -> Result<Diagnostic, ()> {
        let severity = if self.severity == "warning" {
            "warning"
        } else {
            "error"
        };
        let file = self
            .input_reference
            .as_ref()
            .map(|reference| paths.get(reference).cloned().ok_or(()))
            .transpose()?;
        Ok(Diagnostic {
            severity,
            code: self.code.clone(),
            title: self.title.clone(),
            line: self.line,
            column: self.column,
            span: Span {
                start: self.span.start,
                end: self.span.end,
            },
            file,
        })
    }
}

fn stored_identity(input: &crate::project::PlanInput) -> StoredIdentity {
    let path = if input.id.external {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"quipu-cache-external-identity-v1");
        hasher.update(input.id.path.as_bytes());
        format!("external:{}", hasher.finalize().to_hex())
    } else {
        input.id.path.clone()
    };
    StoredIdentity {
        external: input.id.external,
        path,
    }
}

fn resolve_diagnostics(
    diagnostics: &[StoredDiagnostic],
    plan: &CompilationPlan,
) -> Result<Vec<Diagnostic>, ()> {
    let mut paths = HashMap::new();
    for input in plan.closure() {
        let reference = stored_identity(input);
        let path = to_slash(&input.canonical).ok_or(())?;
        if paths.insert(reference, path).is_some() {
            return Err(());
        }
    }
    diagnostics
        .iter()
        .map(|diagnostic| diagnostic.resolve(&paths))
        .collect()
}

fn compatible(
    metadata: &Metadata,
    project_id: &ProjectId,
    fingerprint: PlanFingerprint,
    plan: &CompilationPlan,
) -> Compatibility {
    if metadata.fingerprint != fingerprint.to_hex() {
        return Compatibility::Fingerprint;
    }
    let expected_inputs: Vec<StoredInput> = plan.closure().iter().map(StoredInput::from).collect();
    if metadata.schema != METADATA_SCHEMA
        || metadata.fingerprint_encoding != FINGERPRINT_ENCODING_VERSION
        || metadata.compiler_cache_epoch != COMPILER_CACHE_EPOCH
        || metadata.yara_x_version != yara_x::VERSION
        || metadata.compiler_profile != COMPILER_PROFILE
        || ProjectId::parse(&metadata.project_id).as_ref() != Some(project_id)
        || metadata.target != TARGET
        || metadata.inputs != expected_inputs
        || metadata.artifact.native_code
        || metadata.artifact.target.is_some()
        || !is_lower_hex(&metadata.artifact.digest, 64)
    {
        Compatibility::Other
    } else {
        Compatibility::Compatible
    }
}

enum Compatibility {
    Compatible,
    Fingerprint,
    Other,
}

fn artifact_name(fingerprint: PlanFingerprint, generation: &str) -> String {
    format!("rules-{}-{generation}.yarc", fingerprint.to_hex())
}

fn validated_artifact_name(metadata: &Metadata) -> Option<String> {
    if !is_lower_hex(&metadata.fingerprint, 64) || !is_lower_hex(&metadata.artifact.generation, 32)
    {
        return None;
    }
    Some(artifact_name(
        PlanFingerprint::parse_hex(&metadata.fingerprint)?,
        &metadata.artifact.generation,
    ))
}

fn is_lower_hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_artifact_filename(name: &str) -> bool {
    let Some(body) = name
        .strip_prefix("rules-")
        .and_then(|name| name.strip_suffix(".yarc"))
    else {
        return false;
    };
    let Some((fingerprint, generation)) = body.split_once('-') else {
        return false;
    };
    is_lower_hex(fingerprint, 64) && is_lower_hex(generation, 32)
}

fn is_cache_temporary(name: &str) -> bool {
    let Some(body) = name
        .strip_prefix(".artifact-")
        .or_else(|| name.strip_prefix(".metadata-"))
        .and_then(|name| name.strip_suffix(".tmp"))
    else {
        return false;
    };
    let Some((process, token)) = body.split_once('-') else {
        return false;
    };
    !process.is_empty()
        && process.bytes().all(|byte| byte.is_ascii_digit())
        && is_lower_hex(token, 32)
}

#[derive(Debug)]
enum ReadFailure {
    Corrupt,
    Unavailable,
}

fn read_metadata(path: &Path) -> Result<Option<Metadata>, ReadFailure> {
    let bytes = match read_regular_bounded_optional(path, MAX_METADATA_BYTES)? {
        Some(bytes) => bytes,
        None => return Ok(None),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| ReadFailure::Corrupt)
}

fn read_metadata_any(path: &Path) -> Result<Option<Metadata>, ReadFailure> {
    read_metadata(path)
}

fn read_regular_bounded(path: &Path, exact: u64) -> Result<Vec<u8>, ReadFailure> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ReadFailure::Corrupt
        } else {
            ReadFailure::Unavailable
        }
    })?;
    if !metadata.file_type().is_file() || !artifact_lengths_valid(exact, metadata.len()) {
        return Err(ReadFailure::Corrupt);
    }
    let Some(bytes) = read_regular_bounded_optional(path, exact)? else {
        return Err(ReadFailure::Corrupt);
    };
    if bytes.len() as u64 != exact {
        return Err(ReadFailure::Corrupt);
    }
    Ok(bytes)
}

fn read_regular_bounded_optional(
    path: &Path,
    maximum: u64,
) -> Result<Option<Vec<u8>>, ReadFailure> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ReadFailure::Unavailable),
    };
    if !metadata.file_type().is_file() || metadata.len() > maximum {
        return Err(ReadFailure::Corrupt);
    }
    let mut file = File::open(path).map_err(|_| ReadFailure::Unavailable)?;
    read_exact_bounded(&mut file, metadata.len(), maximum).map(Some)
}

fn read_exact_bounded(
    reader: &mut impl Read,
    exact: u64,
    maximum: u64,
) -> Result<Vec<u8>, ReadFailure> {
    if exact > maximum {
        return Err(ReadFailure::Corrupt);
    }
    let capacity = usize::try_from(exact).map_err(|_| ReadFailure::Corrupt)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(capacity)
        .map_err(|_| ReadFailure::Corrupt)?;
    bytes.resize(capacity, 0);
    if let Err(error) = reader.read_exact(&mut bytes) {
        return Err(if error.kind() == io::ErrorKind::UnexpectedEof {
            ReadFailure::Corrupt
        } else {
            ReadFailure::Unavailable
        });
    }
    let mut overflow = [0u8; 1];
    match reader.read(&mut overflow) {
        Ok(0) => Ok(bytes),
        Ok(_) => Err(ReadFailure::Corrupt),
        Err(_) => Err(ReadFailure::Unavailable),
    }
}

// Preserve actionable I/O evidence without logging OS error text or local paths.
fn cache_io_error(operation: &str, error: io::Error) -> String {
    format!(
        "{operation} (kind: {:?}, OS code: {:?})",
        error.kind(),
        error.raw_os_error()
    )
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| cache_io_error("cache temporary unavailable", error))?;
    file.write_all(bytes)
        .map_err(|error| cache_io_error("cache temporary write failed", error))?;
    file.flush()
        .map_err(|error| cache_io_error("cache temporary flush failed", error))?;
    file.sync_all()
        .map_err(|error| cache_io_error("cache temporary sync failed", error))
}

fn install_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::hard_link(from, to)
        .map_err(|error| cache_io_error("cache artifact install failed", error))?;
    std::fs::remove_file(from)
        .map_err(|error| cache_io_error("cache artifact temporary cleanup failed", error))
}

#[cfg(not(windows))]
fn atomic_replace(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to)
        .map_err(|error| cache_io_error("cache metadata replacement failed", error))
}

#[cfg(windows)]
fn atomic_replace(from: &Path, to: &Path) -> Result<(), String> {
    // `std::fs::rename` refuses an existing destination on Windows. The cache
    // needs the same replace atom as Unix rename; `ReplaceFileW` supplies it.
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    if std::fs::symlink_metadata(to).is_err() {
        return std::fs::rename(from, to)
            .map_err(|error| cache_io_error("cache metadata installation failed", error));
    }
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>()
    };
    let from = wide(from);
    let to = wide(to);
    let ok = unsafe {
        ReplaceFileW(
            to.as_ptr(),
            from.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(cache_io_error(
            "cache metadata replacement failed",
            io::Error::last_os_error(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_dir(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| cache_io_error("cache directory sync failed", error))
}

#[cfg(not(unix))]
fn sync_dir(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
    if !path.exists() {
        std::fs::create_dir_all(path).map_err(|_| "cache directory unavailable".to_string())?;
    }
    ensure_existing_dir(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(path, permissions)
            .map_err(|_| "cache directory permissions unavailable".to_string())?;
    }
    Ok(())
}

fn ensure_existing_dir(path: &Path) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| "cache directory unavailable".to_string())?;
    if metadata.file_type().is_dir() {
        Ok(())
    } else {
        Err("cache directory is unsafe".into())
    }
}

fn remove_nofollow_file(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            Err("refusing cache directory as file".into())
        }
        Ok(_) => std::fs::remove_file(path).map_err(|_| "cache file removal failed".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("cache file unavailable".into()),
    }
}

fn remove_tree_nofollow(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("cache entry unavailable".into()),
    };
    if !metadata.file_type().is_dir() {
        return std::fs::remove_file(path).map_err(|_| "cache entry removal failed".into());
    }
    for entry in std::fs::read_dir(path).map_err(|_| "cache entry unavailable".to_string())? {
        let entry = entry.map_err(|_| "cache entry unavailable".to_string())?;
        remove_tree_nofollow(&entry.path())?;
    }
    std::fs::remove_dir(path).map_err(|_| "cache directory removal failed".into())
}

fn clear_children_nofollow(path: &Path) -> Result<(), String> {
    ensure_existing_dir(path)?;
    for entry in std::fs::read_dir(path).map_err(|_| "cache directory unavailable".to_string())? {
        let entry = entry.map_err(|_| "cache directory unavailable".to_string())?;
        remove_tree_nofollow(&entry.path())?;
    }
    Ok(())
}

fn regular_usage_nofollow(path: &Path) -> Result<u64, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err("cache usage unavailable".into()),
    };
    if metadata.file_type().is_file() {
        return Ok(metadata.len());
    }
    if !metadata.file_type().is_dir() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in std::fs::read_dir(path).map_err(|_| "cache usage unavailable")? {
        let entry = entry.map_err(|_| "cache usage unavailable")?;
        total = total
            .checked_add(regular_usage_nofollow(&entry.path())?)
            .ok_or_else(|| "cache usage overflow".to_string())?;
    }
    Ok(total)
}

fn digest_regular_exact(path: &Path, exact: u64, hooks: &dyn Hooks) -> Result<String, ReadFailure> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            ReadFailure::Corrupt
        } else {
            ReadFailure::Unavailable
        }
    })?;
    if !metadata.file_type().is_file() || !artifact_lengths_valid(exact, metadata.len()) {
        return Err(ReadFailure::Corrupt);
    }
    hooks
        .check(Point::BeforeArtifactHash)
        .map_err(|_| ReadFailure::Unavailable)?;
    let mut file = File::open(path).map_err(|_| ReadFailure::Unavailable)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut read = 0u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| ReadFailure::Unavailable)?;
        if count == 0 {
            break;
        }
        read = read.checked_add(count as u64).ok_or(ReadFailure::Corrupt)?;
        if read > exact {
            return Err(ReadFailure::Corrupt);
        }
        hasher.update(&buffer[..count]);
    }
    if read != exact {
        return Err(ReadFailure::Corrupt);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn artifact_lengths_valid(declared: u64, actual: u64) -> bool {
    declared == actual && declared <= MAX_ARTIFACT_BYTES && actual <= MAX_ARTIFACT_BYTES
}

#[derive(Clone, Copy)]
enum LockMode {
    Shared,
    Exclusive,
}

struct Locks {
    _global: File,
    _projects: Vec<File>,
}

impl Locks {
    fn global(manager: &CacheManager, mode: LockMode) -> Result<Self, String> {
        manager.hooks.check(Point::LockGlobal)?;
        let global = open_lock(&manager.root.join(".global.lock"))?;
        lock(&global, mode)?;
        Ok(Self {
            _global: global,
            _projects: Vec::new(),
        })
    }

    fn project(
        manager: &CacheManager,
        project: &ProjectId,
        mode: LockMode,
    ) -> Result<Self, String> {
        let mut locks = Self::global(manager, mode)?;
        locks.lock_projects(manager, std::slice::from_ref(project))?;
        Ok(locks)
    }

    fn lock_projects(
        &mut self,
        manager: &CacheManager,
        projects: &[ProjectId],
    ) -> Result<(), String> {
        for project in projects {
            manager.hooks.check(Point::LockProject)?;
            let project_lock = open_lock(
                &manager
                    .root
                    .join("locks")
                    .join(format!("{}.lock", project.0)),
            )?;
            lock(&project_lock, LockMode::Exclusive)?;
            self._projects.push(project_lock);
        }
        Ok(())
    }
}

fn open_lock(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "cache lock unavailable".into())
}

fn lock(file: &File, mode: LockMode) -> Result<(), String> {
    match mode {
        LockMode::Shared => FileExt::lock_shared(file),
        LockMode::Exclusive => FileExt::lock_exclusive(file),
    }
    .map_err(|_| "cache lock unavailable".into())
}

trait Clock: Send + Sync {
    fn now(&self) -> u64;
}

struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Point {
    LockGlobal,
    LockProject,
    LockConfig,
    AfterClearEpoch,
    BeforeSerialize,
    GenerateToken,
    BeforeArtifactWrite,
    BeforeArtifactInstall,
    AfterArtifactInstall,
    BeforeMetadataCommit,
    AfterMetadataCommit,
    BeforeDeserialize,
    BeforeArtifactHash,
    BeforeLastUsedCommit,
    MaintenanceRemove,
    BeforeSettingsCommit,
}

trait Hooks: Send + Sync {
    fn check(&self, _point: Point) -> Result<(), String> {
        Ok(())
    }
}

struct NoHooks;
impl Hooks for NoHooks {}

fn load_settings(config_root: &Path) -> (CacheSettings, Option<String>) {
    let path = config_root.join("cache.json");
    if !path.exists() {
        return (CacheSettings::default(), None);
    }
    let result = read_regular_bounded_optional(&path, MAX_METADATA_BYTES)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<CacheSettings>(&bytes).ok())
        .and_then(|settings| settings.validate().ok());
    match result {
        Some(settings) => (settings, None),
        None => (
            CacheSettings::default(),
            Some("cache settings are invalid; defaults are in use".into()),
        ),
    }
}

#[cfg(unix)]
fn os_bytes(value: &std::ffi::OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    let mut bytes = vec![1];
    bytes.extend_from_slice(value.as_bytes());
    bytes
}

#[cfg(windows)]
fn os_bytes(value: &std::ffi::OsStr) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    let mut bytes = vec![2];
    for unit in value.encode_wide() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

#[cfg(not(any(unix, windows)))]
fn os_bytes(value: &std::ffi::OsStr) -> Vec<u8> {
    let mut bytes = vec![3];
    bytes.extend_from_slice(value.as_encoded_bytes());
    bytes
}

#[cfg(test)]
mod tests;
