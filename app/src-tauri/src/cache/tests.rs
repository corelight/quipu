//! Storage-protocol tests live beside the Tauri-free cache core.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;

use crate::project::open_project;
use crate::testing::{Fixture, rule};

use super::*;

struct TestClock(AtomicU64);
impl TestClock {
    fn new(now: u64) -> Self {
        Self(AtomicU64::new(now))
    }

    fn set(&self, now: u64) {
        self.0.store(now, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
struct TestHooks {
    fail: Mutex<Option<Point>>,
    panic: Mutex<Option<Point>>,
    seen: Mutex<Vec<Point>>,
}

impl Hooks for TestHooks {
    fn check(&self, point: Point) -> Result<(), String> {
        self.seen.lock().expect("seen").push(point);
        if self.panic.lock().expect("panic point").as_ref() == Some(&point) {
            panic!("injected cache panic at {point:?}");
        }
        if self.fail.lock().expect("failure point").as_ref() == Some(&point) {
            return Err(format!("injected cache failure at {point:?}"));
        }
        Ok(())
    }
}

struct BlockingHooks {
    block: Point,
    seen: mpsc::Sender<Point>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl Hooks for BlockingHooks {
    fn check(&self, point: Point) -> Result<(), String> {
        self.seen.send(point).expect("test receives hook");
        if point == self.block {
            self.release
                .lock()
                .expect("release")
                .recv()
                .expect("released");
        }
        Ok(())
    }
}

struct Harness {
    fixture: Fixture,
    cache_root: PathBuf,
    config_root: PathBuf,
    hooks: Arc<TestHooks>,
    clock: Arc<TestClock>,
    manager: CacheManager,
}

impl Harness {
    fn new() -> Self {
        let fixture = Fixture::new();
        fixture.write("main.yar", &rule("cached"));
        let cache_root = fixture.base.join("cache");
        let config_root = fixture.base.join("config");
        let hooks = Arc::new(TestHooks::default());
        let clock = Arc::new(TestClock::new(1_800_000_000));
        let manager = CacheManager::with_parts(
            cache_root.clone(),
            config_root.clone(),
            clock.clone(),
            hooks.clone(),
        );
        Self {
            fixture,
            cache_root,
            config_root,
            hooks,
            clock,
            manager,
        }
    }

    fn plan(&self) -> CompilationPlan {
        open_project(&self.fixture.root)
            .expect("snapshot")
            .compilation_plan()
            .expect("plan")
    }

    fn proposal(&self) -> ProposedEntry {
        self.proposal_for(&self.fixture.root)
    }

    fn proposal_for(&self, root: &Path) -> ProposedEntry {
        let plan = open_project(root)
            .expect("snapshot")
            .compilation_plan()
            .expect("plan");
        let compiled = crate::compile::project(root);
        let rules = compiled.rules.as_ref().expect("rules");
        let claim = self.manager.capture_write_claim(root).expect("write claim");
        self.manager
            .prepare(
                &claim,
                &plan,
                rules,
                &compiled.diagnostics,
                compiled.rule_count,
            )
            .expect("proposal")
    }

    fn padded_proposal(&self, root: &Path, artifact_bytes: usize) -> ProposedEntry {
        let mut proposal = self.proposal_for(root);
        proposal.artifact.resize(artifact_bytes, 0);
        proposal.artifact_digest = blake3::hash(&proposal.artifact).to_hex().to_string();
        proposal
    }

    fn add_project(&self, name: &str) -> PathBuf {
        let root = self.fixture.base.join(name);
        std::fs::create_dir(&root).expect("project dir");
        std::fs::write(root.join("main.yar"), rule(name)).expect("rule");
        root
    }

    fn commit(&self) {
        assert_eq!(
            self.manager.commit(self.proposal()),
            CommitOutcome::Committed
        );
    }

    fn target_dir(&self) -> PathBuf {
        self.manager
            .target_dir(&ProjectId::for_root(&self.fixture.root))
    }

    fn metadata(&self) -> Metadata {
        read_metadata(&self.target_dir().join("metadata.json"))
            .expect("read metadata")
            .expect("metadata exists")
    }

    fn artifact_path(&self) -> PathBuf {
        let metadata = self.metadata();
        self.target_dir()
            .join(validated_artifact_name(&metadata).expect("valid artifact"))
    }

    fn replace_metadata(&self, change: impl FnOnce(&mut Metadata)) {
        let path = self.target_dir().join("metadata.json");
        let mut metadata = self.metadata();
        change(&mut metadata);
        std::fs::write(path, serde_json::to_vec(&metadata).expect("json")).expect("write metadata");
    }
}

fn assert_hit(outcome: LoadOutcome) -> LoadedEntry {
    match outcome {
        LoadOutcome::Hit(hit) => hit,
        other => panic!("expected hit, got {other:?}"),
    }
}

#[test]
fn project_ids_are_stable_lowercase_and_path_sensitive() {
    let first = ProjectId::for_root(Path::new("/project"));
    assert_eq!(first, ProjectId::for_root(Path::new("/project")));
    assert_ne!(first, ProjectId::for_root(Path::new("/other")));
    assert!(is_lower_hex(first.as_str(), 64));
}

#[test]
fn serialized_rules_and_success_diagnostics_round_trip() {
    let harness = Harness::new();
    harness
        .fixture
        .write("main.yar", "rule cached { condition: true }\n");
    let plan = harness.plan();
    let compiled = crate::compile::project(&harness.fixture.root);
    assert!(
        !compiled.diagnostics.is_empty(),
        "the fixture must carry a warning"
    );
    let claim = harness
        .manager
        .capture_write_claim(&harness.fixture.root)
        .expect("write claim");
    let proposal = harness
        .manager
        .prepare(
            &claim,
            &plan,
            compiled.rules.as_ref().expect("rules"),
            &compiled.diagnostics,
            compiled.rule_count,
        )
        .expect("proposal");
    assert_eq!(harness.manager.commit(proposal), CommitOutcome::Committed);

    let hit = assert_hit(harness.manager.load(&plan));
    assert_eq!(hit.rule_count, compiled.rule_count);
    assert_eq!(hit.diagnostics, compiled.diagnostics);
    let mut scanner = yara_x::Scanner::new(&hit.rules);
    let results = scanner.scan(b"anything").expect("scan");
    assert_eq!(results.matching_rules().count(), 1);
}

#[test]
fn thousands_of_attributed_diagnostics_above_one_mib_commit_and_hit_exactly() {
    let harness = Harness::new();
    let plan = harness.plan();
    let compiled = crate::compile::project(&harness.fixture.root);
    let file = to_slash(&plan.closure()[0].canonical).expect("Unicode fixture path");
    let diagnostics = (0..6_000)
        .map(|index| Diagnostic {
            severity: "warning",
            code: format!("representative-{index}"),
            title: format!(
                "representative cached compiler warning {index}: {}",
                "diagnostic evidence ".repeat(8)
            ),
            line: index + 1,
            column: index % 80 + 1,
            span: Span {
                start: index * 2,
                end: index * 2 + 1,
            },
            file: Some(file.clone()),
        })
        .collect::<Vec<_>>();
    let claim = harness
        .manager
        .capture_write_claim(&harness.fixture.root)
        .expect("write claim");
    let proposal = harness
        .manager
        .prepare(
            &claim,
            &plan,
            compiled.rules.as_ref().expect("rules"),
            &diagnostics,
            compiled.rule_count,
        )
        .expect("proposal");

    let outcome = harness.manager.commit(proposal);
    harness.manager.record_commit_outcome(outcome);
    assert_eq!(outcome, CommitOutcome::Committed);
    let metadata_bytes =
        std::fs::read(harness.target_dir().join("metadata.json")).expect("committed metadata");
    assert!(metadata_bytes.len() > 1024 * 1024);
    assert!(metadata_bytes.len() <= MAX_METADATA_BYTES as usize);
    assert!(
        !metadata_bytes.contains(&b'\n'),
        "metadata must use compact streaming JSON, not pretty printing"
    );

    let hit = assert_hit(harness.manager.load(&plan));
    assert_eq!(hit.rule_count, compiled.rule_count);
    assert_eq!(hit.diagnostics, diagnostics);
    assert_eq!(hit.diagnostics[0].file.as_deref(), Some(file.as_str()));
}

#[test]
fn external_warning_round_trips_with_exact_openable_attribution_without_persisting_its_path() {
    let harness = Harness::new();
    harness.fixture.write(
        "main.yar",
        "include \"../external.yar\"\nrule main { condition: filesize > 0 }\n",
    );
    harness.fixture.write_outside(
        "external.yar",
        "rule external_warning { condition: true }\n",
    );
    let external = std::fs::canonicalize(harness.fixture.base.join("external.yar"))
        .expect("external canonical path");
    let external_file = to_slash(&external).expect("external display path");
    let plan = harness.plan();
    let compiled = crate::compile::project(&harness.fixture.root);
    assert!(
        compiled
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.file.as_deref() == Some(&external_file)),
        "fixture must produce an external-source warning"
    );
    let claim = harness
        .manager
        .capture_write_claim(&harness.fixture.root)
        .expect("write claim");
    let proposal = harness
        .manager
        .prepare(
            &claim,
            &plan,
            compiled.rules.as_ref().expect("rules"),
            &compiled.diagnostics,
            compiled.rule_count,
        )
        .expect("proposal");
    assert_eq!(harness.manager.commit(proposal), CommitOutcome::Committed);

    let metadata_bytes =
        std::fs::read(harness.target_dir().join("metadata.json")).expect("metadata");
    let metadata_text = String::from_utf8(metadata_bytes).expect("json is utf8");
    assert!(
        !metadata_text.contains(&external_file),
        "external canonical paths are not cache data"
    );
    let metadata = harness.metadata();
    assert!(
        metadata
            .inputs
            .iter()
            .filter(|input| input.identity.external)
            .all(|input| input.identity.path.starts_with("external:")
                && !input.identity.path.contains('/'))
    );
    assert!(metadata.diagnostics.iter().any(|diagnostic| {
        diagnostic
            .input_reference
            .as_ref()
            .is_some_and(|reference| reference.external && reference.path.starts_with("external:"))
    }));
    let (trace, trace_lines) = crate::debug_trace::DebugTrace::captured();
    let hit = assert_hit(harness.manager.load_observed(&plan, Some(&trace)));
    trace.flush();
    assert_eq!(hit.diagnostics, compiled.diagnostics);
    let attributed = hit
        .diagnostics
        .iter()
        .find_map(|diagnostic| diagnostic.file.as_deref())
        .filter(|file| *file == external_file)
        .expect("cached external warning remains attributed");
    assert!(Path::new(attributed).is_file(), "attribution is openable");

    let trace_output = trace_lines
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .join("\n");
    assert!(trace_output.contains("cache_lookup_stage"));
    assert!(!trace_output.contains(&external_file));
    assert!(!trace_output.contains(&harness.fixture.root.to_string_lossy().into_owned()));
    assert!(
        !trace_output.contains("external_warning"),
        "no source or diagnostic title"
    );
    assert!(!trace_output.contains("filesize > 0"), "no source contents");
}

#[cfg(unix)]
#[test]
fn tagged_diagnostic_references_distinguish_an_internal_external_pseudonym_collision() {
    let harness = Harness::new();
    harness.fixture.write_outside(
        "external.yar",
        "rule external_warning { condition: true }\n",
    );
    harness.fixture.write(
        "main.yar",
        "include \"../external.yar\"\nrule main { condition: filesize > 0 }\n",
    );
    let preliminary = harness.plan();
    let external_reference = preliminary
        .closure()
        .iter()
        .find(|input| input.id.external)
        .map(stored_identity)
        .expect("external input");
    harness.fixture.write(
        &external_reference.path,
        "rule internal_warning { condition: true }\n",
    );
    harness.fixture.write(
        "main.yar",
        &format!(
            "include \"../external.yar\"\ninclude \"{}\"\nrule main {{ condition: filesize > 0 }}\n",
            external_reference.path
        ),
    );

    let plan = harness.plan();
    let compiled = crate::compile::compile_plan(&plan);
    let external_file = to_slash(
        &std::fs::canonicalize(harness.fixture.base.join("external.yar")).expect("external path"),
    )
    .expect("external display path");
    let internal_file = to_slash(
        &std::fs::canonicalize(harness.fixture.root.join(&external_reference.path))
            .expect("internal path"),
    )
    .expect("internal display path");
    let files = compiled
        .diagnostics
        .iter()
        .filter_map(|diagnostic| diagnostic.file.as_deref())
        .collect::<HashSet<_>>();
    assert!(files.contains(external_file.as_str()));
    assert!(files.contains(internal_file.as_str()));

    let claim = harness
        .manager
        .capture_write_claim(&harness.fixture.root)
        .expect("write claim");
    let proposal = harness
        .manager
        .prepare(
            &claim,
            &plan,
            compiled.rules.as_ref().expect("rules"),
            &compiled.diagnostics,
            compiled.rule_count,
        )
        .expect("proposal");
    assert_eq!(harness.manager.commit(proposal), CommitOutcome::Committed);
    let references = harness
        .metadata()
        .diagnostics
        .into_iter()
        .filter_map(|diagnostic| diagnostic.input_reference)
        .collect::<HashSet<_>>();
    assert!(references.contains(&external_reference));
    assert!(references.contains(&StoredIdentity {
        external: false,
        path: external_reference.path.clone(),
    }));

    let hit = assert_hit(harness.manager.load(&plan));
    assert_eq!(hit.diagnostics, compiled.diagnostics);
}

#[test]
fn a_source_fingerprint_change_is_an_ordinary_miss() {
    let harness = Harness::new();
    let old_plan = harness.plan();
    harness.commit();
    harness.fixture.write("main.yar", &rule("changed"));
    let new_plan = harness.plan();
    assert_ne!(old_plan.fingerprint(), new_plan.fingerprint());
    assert!(matches!(
        harness.manager.load(&new_plan),
        LoadOutcome::Miss(MissReason::Fingerprint)
    ));
    assert!(harness.target_dir().join("metadata.json").exists());
}

#[test]
fn artifact_digest_corruption_is_removed_and_misses() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    let artifact = harness.artifact_path();
    let mut bytes = std::fs::read(&artifact).expect("artifact");
    bytes[0] ^= 1;
    std::fs::write(&artifact, bytes).expect("corrupt artifact");

    assert!(matches!(
        harness.manager.load(&plan),
        LoadOutcome::Miss(MissReason::Corrupt)
    ));
    assert!(!artifact.exists());
    assert!(!harness.target_dir().join("metadata.json").exists());
}

#[test]
fn a_metadata_digest_mismatch_is_rejected_before_valid_artifact_deserialization() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    harness.hooks.seen.lock().expect("seen").clear();
    harness.replace_metadata(|metadata| {
        metadata.artifact.digest = if metadata.artifact.digest.starts_with('0') {
            "1".repeat(64)
        } else {
            "0".repeat(64)
        };
    });

    assert!(matches!(
        harness.manager.load(&plan),
        LoadOutcome::Miss(MissReason::Corrupt)
    ));
    assert!(
        !harness
            .hooks
            .seen
            .lock()
            .expect("seen")
            .contains(&Point::BeforeDeserialize)
    );
}

#[test]
fn truncated_artifacts_are_rejected_before_deserialization() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    let artifact = harness.artifact_path();
    std::fs::write(&artifact, b"short").expect("truncate");
    assert!(matches!(
        harness.manager.load(&plan),
        LoadOutcome::Miss(MissReason::Corrupt)
    ));
    assert!(
        !harness
            .hooks
            .seen
            .lock()
            .expect("seen")
            .contains(&Point::BeforeDeserialize)
    );
}

#[test]
fn excessive_declared_artifact_size_is_rejected_before_hash_or_deserialization() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    harness.replace_metadata(|metadata| metadata.artifact.bytes = MAX_ARTIFACT_BYTES + 1);
    harness.hooks.seen.lock().expect("seen").clear();

    assert!(matches!(
        harness.manager.load(&plan),
        LoadOutcome::Miss(MissReason::Corrupt)
    ));
    let seen = harness.hooks.seen.lock().expect("seen");
    assert!(!seen.contains(&Point::BeforeArtifactHash));
    assert!(!seen.contains(&Point::BeforeDeserialize));
}

#[test]
fn sparse_artifact_above_the_ceiling_is_not_read_or_hashed_on_load() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    let artifact = harness.artifact_path();
    OpenOptions::new()
        .write(true)
        .open(&artifact)
        .expect("open artifact")
        .set_len(MAX_ARTIFACT_BYTES + 1)
        .expect("create sparse oversized artifact");
    harness.hooks.seen.lock().expect("seen").clear();

    assert!(matches!(
        harness.manager.load(&plan),
        LoadOutcome::Miss(MissReason::Corrupt)
    ));
    let seen = harness.hooks.seen.lock().expect("seen");
    assert!(!seen.contains(&Point::BeforeArtifactHash));
    assert!(!seen.contains(&Point::BeforeDeserialize));
}

#[test]
fn maintenance_cleans_a_sparse_artifact_above_the_ceiling_without_hashing() {
    let harness = Harness::new();
    harness.commit();
    let artifact = harness.artifact_path();
    OpenOptions::new()
        .write(true)
        .open(&artifact)
        .expect("open artifact")
        .set_len(MAX_ARTIFACT_BYTES + 1)
        .expect("create sparse oversized artifact");
    harness.hooks.seen.lock().expect("seen").clear();

    available_usage(harness.manager.maintain(Some(&harness.fixture.root)));

    assert!(!harness.target_dir().join("metadata.json").exists());
    assert!(!artifact.exists());
    assert!(
        !harness
            .hooks
            .seen
            .lock()
            .expect("seen")
            .contains(&Point::BeforeArtifactHash)
    );
}

#[test]
fn ceiling_writer_fails_without_growing_past_its_limit() {
    let mut artifact = ArtifactBuffer::new(4);
    assert!(artifact.write_all(b"12345").is_err());
    assert!(artifact.bytes.len() <= 4);
    assert!(artifact.finish().is_err());
}

#[test]
fn independent_artifact_rejection_has_its_own_observable_outcome() {
    let harness = Harness::new();
    let mut artifact = ArtifactBuffer::new(4);
    assert!(artifact.write_all(b"12345").is_err());
    assert_eq!(artifact.finish(), Err(SerializationFailure::OverLimit));

    let outcome = PrepareOutcome::ArtifactOverLimit;
    harness.manager.record_prepare_outcome(&outcome);

    assert!(!harness.target_dir().exists());
    assert_eq!(
        harness.manager.warning().as_deref(),
        Some("compiled cache artifact exceeds the 256 MiB safety limit")
    );
}

#[test]
fn metadata_writer_accepts_its_boundary_and_refuses_the_next_byte() {
    let mut exact = MetadataBuffer::new(4);
    exact.write_all(b"1234").expect("exact boundary");
    assert_eq!(exact.finish().expect("complete"), b"1234");

    let mut exceeded = MetadataBuffer::new(4);
    assert!(exceeded.write_all(b"12345").is_err());
    assert!(exceeded.bytes.len() <= 4);
    assert_eq!(exceeded.finish(), Err(SerializationFailure::OverLimit));
}

#[test]
fn metadata_above_the_independent_ceiling_is_rejected_before_entry_creation() {
    let harness = Harness::new();
    let mut proposal = harness.proposal();
    proposal.diagnostics = vec![StoredDiagnostic {
        severity: "warning".into(),
        code: "metadata-ceiling".into(),
        title: "x".repeat(MAX_METADATA_BYTES as usize),
        line: 1,
        column: 1,
        span: StoredSpan { start: 0, end: 1 },
        input_reference: None,
    }];

    let outcome = harness.manager.commit(proposal);
    harness.manager.record_commit_outcome(outcome);

    assert_eq!(outcome, CommitOutcome::MetadataOverLimit);
    assert!(!harness.target_dir().exists());
    assert_eq!(
        harness.manager.warning().as_deref(),
        Some("compiled cache metadata exceeds the 16 MiB safety limit")
    );
}

#[test]
fn configured_quota_rejection_is_distinct_and_creates_no_entry_directory() {
    let harness = Harness::new();
    harness.manager.lock_state().settings.maximum_bytes = MINIMUM_BYTES;
    let proposal = harness.padded_proposal(&harness.fixture.root, MINIMUM_BYTES as usize);

    let outcome = harness.manager.commit(proposal);
    harness.manager.record_commit_outcome(outcome);

    assert_eq!(outcome, CommitOutcome::QuotaExceeded);
    assert!(!harness.target_dir().exists());
    assert_eq!(
        harness.manager.warning().as_deref(),
        Some("compiled cache entry exceeds the configured maximum")
    );
}

#[test]
fn artifact_length_policy_rejects_equal_lengths_above_the_independent_ceiling() {
    assert!(artifact_lengths_valid(
        MAX_ARTIFACT_BYTES,
        MAX_ARTIFACT_BYTES
    ));
    assert!(!artifact_lengths_valid(
        MAX_ARTIFACT_BYTES + 1,
        MAX_ARTIFACT_BYTES + 1
    ));
    assert!(!artifact_lengths_valid(1, 2));
}

#[test]
fn bounded_reader_probes_growth_in_one_stack_byte_without_growing_its_vector() {
    struct TrackingReader {
        bytes: std::io::Cursor<Vec<u8>>,
        requested: Vec<usize>,
    }

    impl Read for TrackingReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.requested.push(buffer.len());
            self.bytes.read(buffer)
        }
    }

    let mut reader = TrackingReader {
        bytes: std::io::Cursor::new(b"12345".to_vec()),
        requested: Vec::new(),
    };
    assert!(matches!(
        read_exact_bounded(&mut reader, 4, 4),
        Err(ReadFailure::Corrupt)
    ));
    assert_eq!(reader.requested, [4, 1]);
}

#[test]
fn oversized_metadata_is_bounded_before_json_parsing() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    let metadata = harness.target_dir().join("metadata.json");
    std::fs::write(&metadata, vec![b' '; MAX_METADATA_BYTES as usize + 1]).expect("oversize");
    assert!(matches!(
        harness.manager.load(&plan),
        LoadOutcome::Miss(MissReason::Corrupt)
    ));
    assert!(!metadata.exists());
}

#[test]
fn compatibility_fields_all_miss_without_deserializing() {
    let mutations: &[fn(&mut Metadata)] = &[
        |m| m.schema += 1,
        |m| m.fingerprint_encoding += 1,
        |m| m.compiler_cache_epoch += 1,
        |m| m.yara_x_version.push_str("-other"),
        |m| m.compiler_profile.push_str("-other"),
        |m| {
            let replacement = if m.project_id.starts_with('f') {
                "e"
            } else {
                "f"
            };
            m.project_id.replace_range(..1, replacement);
        },
        |m| m.target.push_str("-other"),
        |m| m.inputs[0].bytes += 1,
        |m| m.artifact.native_code = true,
        |m| m.artifact.target = Some("target".into()),
    ];
    for mutate in mutations {
        let harness = Harness::new();
        let plan = harness.plan();
        harness.commit();
        harness.replace_metadata(mutate);
        assert!(matches!(
            harness.manager.load(&plan),
            LoadOutcome::Miss(MissReason::Compatibility)
        ));
        assert!(
            !harness
                .hooks
                .seen
                .lock()
                .expect("seen")
                .contains(&Point::BeforeDeserialize)
        );
    }
}

#[test]
fn a_deserialization_panic_is_contained_as_a_corrupt_miss() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    *harness.hooks.panic.lock().expect("panic point") = Some(Point::BeforeDeserialize);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = harness.manager.load(&plan);
    std::panic::set_hook(previous);
    assert!(matches!(outcome, LoadOutcome::Miss(MissReason::Corrupt)));
}

#[cfg(unix)]
#[test]
fn symlink_metadata_and_artifacts_are_never_followed() {
    use std::os::unix::fs::symlink;

    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    let outside = harness.fixture.base.join("outside");
    std::fs::write(&outside, b"untouched").expect("outside");
    let metadata = harness.target_dir().join("metadata.json");
    std::fs::remove_file(&metadata).expect("remove metadata");
    symlink(&outside, &metadata).expect("metadata symlink");
    assert!(matches!(
        harness.manager.load(&plan),
        LoadOutcome::Miss(MissReason::Corrupt)
    ));
    assert_eq!(std::fs::read(&outside).expect("outside"), b"untouched");

    harness.commit();
    let artifact = harness.artifact_path();
    std::fs::remove_file(&artifact).expect("remove artifact");
    symlink(&outside, &artifact).expect("artifact symlink");
    assert!(matches!(
        harness.manager.load(&plan),
        LoadOutcome::Miss(MissReason::Corrupt)
    ));
    assert_eq!(std::fs::read(&outside).expect("outside"), b"untouched");
}

#[test]
fn same_fingerprint_replacements_use_distinct_artifact_generations() {
    let harness = Harness::new();
    harness.commit();
    let first = harness.metadata();
    let first_path = harness.artifact_path();
    harness.commit();
    let second = harness.metadata();
    let second_path = harness.artifact_path();
    assert_eq!(first.fingerprint, second.fingerprint);
    assert_ne!(first.artifact.generation, second.artifact.generation);
    assert_ne!(first_path, second_path);
    assert!(!first_path.exists());
    assert!(second_path.exists());
}

#[test]
fn every_precommit_failure_preserves_the_old_generation() {
    for point in [
        Point::BeforeArtifactWrite,
        Point::BeforeArtifactInstall,
        Point::AfterArtifactInstall,
        Point::BeforeMetadataCommit,
    ] {
        let harness = Harness::new();
        let plan = harness.plan();
        harness.commit();
        let old = harness.metadata();
        *harness.hooks.fail.lock().expect("failure") = Some(point);
        let outcome = harness.manager.commit(harness.proposal());
        harness.manager.record_commit_outcome(outcome);
        assert_eq!(outcome, CommitOutcome::Unavailable);
        assert_eq!(
            harness.manager.warning().as_deref(),
            Some("compiled cache commit storage or serialization is unavailable")
        );
        assert_eq!(
            harness.metadata().artifact.generation,
            old.artifact.generation,
            "{point:?}"
        );
        assert_hit(harness.manager.load(&plan));
    }
}

#[test]
fn metadata_replacement_is_the_commit_point() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    let old = harness.metadata();
    *harness.hooks.fail.lock().expect("failure") = Some(Point::AfterMetadataCommit);
    assert_eq!(
        harness.manager.commit(harness.proposal()),
        CommitOutcome::Unavailable
    );
    let new = harness.metadata();
    assert_ne!(new.artifact.generation, old.artifact.generation);
    assert_hit(harness.manager.load(&plan));
}

#[test]
fn clear_epochs_refuse_proposals_captured_before_clear() {
    let harness = Harness::new();
    harness.commit();
    let old = harness.proposal();
    assert_eq!(
        harness.manager.clear_current(&harness.fixture.root),
        ClearOutcome::Cleared
    );
    let outcome = harness.manager.commit(old);
    harness.manager.record_commit_outcome(outcome);
    assert_eq!(
        outcome,
        CommitOutcome::Declined(PersistenceDecline::Cleared)
    );
    assert_eq!(harness.manager.warning(), None);
    assert!(!harness.target_dir().exists());

    let old = harness.proposal();
    assert_eq!(harness.manager.clear_all(), ClearOutcome::Cleared);
    let outcome = harness.manager.commit(old);
    harness.manager.record_commit_outcome(outcome);
    assert_eq!(
        outcome,
        CommitOutcome::Declined(PersistenceDecline::Cleared)
    );
    assert_eq!(harness.manager.warning(), None);
    assert!(!harness.target_dir().exists());
}

#[test]
fn clear_invalidates_a_precompile_claim_before_serialization() {
    let harness = Harness::new();
    let plan = harness.plan();
    let claim = harness
        .manager
        .capture_write_claim(&harness.fixture.root)
        .expect("precompile claim");
    assert_eq!(
        harness.manager.clear_current(&harness.fixture.root),
        ClearOutcome::Cleared
    );
    let compiled = crate::compile::compile_plan(&plan);
    harness.hooks.seen.lock().expect("seen").clear();

    let outcome = harness.manager.prepare(
        &claim,
        &plan,
        compiled.rules.as_ref().expect("rules"),
        &compiled.diagnostics,
        compiled.rule_count,
    );
    harness.manager.record_prepare_outcome(&outcome);
    assert!(matches!(
        outcome,
        PrepareOutcome::Declined(PersistenceDecline::Cleared)
    ));
    assert_eq!(harness.manager.warning(), None);
    assert!(
        !harness
            .hooks
            .seen
            .lock()
            .expect("seen")
            .contains(&Point::BeforeSerialize)
    );
}

#[test]
fn unavailable_preparation_is_observable_and_a_later_commit_clears_it() {
    let harness = Harness::new();
    let plan = harness.plan();
    let compiled = crate::compile::project(&harness.fixture.root);
    let claim = harness
        .manager
        .capture_write_claim(&harness.fixture.root)
        .expect("write claim");
    *harness.hooks.fail.lock().expect("failure") = Some(Point::BeforeSerialize);

    let preparation = harness.manager.prepare(
        &claim,
        &plan,
        compiled
            .rules
            .as_ref()
            .expect("compiled rules remain usable"),
        &compiled.diagnostics,
        compiled.rule_count,
    );
    harness.manager.record_prepare_outcome(&preparation);

    assert!(matches!(preparation, PrepareOutcome::Unavailable));
    assert!(
        compiled.rules.is_some(),
        "cache failure is not compile failure"
    );
    assert_eq!(
        harness.manager.warning().as_deref(),
        Some("compiled cache preparation or serialization is unavailable")
    );

    *harness.hooks.fail.lock().expect("failure") = None;
    let outcome = harness.manager.commit(harness.proposal());
    harness.manager.record_commit_outcome(outcome);
    assert_eq!(outcome, CommitOutcome::Committed);
    assert_eq!(harness.manager.warning(), None);
}

#[test]
fn clear_current_orders_both_locks_and_clear_all_needs_only_global_exclusive() {
    let harness = Harness::new();
    harness.commit();
    harness.hooks.seen.lock().expect("seen").clear();
    assert_eq!(
        harness.manager.clear_current(&harness.fixture.root),
        ClearOutcome::Cleared
    );
    let seen = harness.hooks.seen.lock().expect("seen").clone();
    let global = seen
        .iter()
        .position(|p| *p == Point::LockGlobal)
        .expect("global");
    let project = seen
        .iter()
        .position(|p| *p == Point::LockProject)
        .expect("project");
    assert!(global < project);
    assert!(
        harness
            .manager
            .effective_path()
            .join(".global.lock")
            .exists()
    );
    assert!(harness.manager.effective_path().join("locks").is_dir());

    harness.commit();
    harness.hooks.seen.lock().expect("seen").clear();
    assert_eq!(harness.manager.clear_all(), ClearOutcome::Cleared);
    let seen = harness.hooks.seen.lock().expect("seen");
    assert!(seen.contains(&Point::LockGlobal));
    assert!(!seen.contains(&Point::LockProject));
    assert!(
        harness
            .manager
            .effective_path()
            .join(".global.lock")
            .exists()
    );
    assert!(harness.manager.effective_path().join("locks").is_dir());
    assert!(harness.manager.effective_path().join("projects").is_dir());
}

#[test]
fn failed_global_or_project_locks_make_only_the_cache_unavailable() {
    for point in [Point::LockGlobal, Point::LockProject] {
        let harness = Harness::new();
        let plan = harness.plan();
        let proposal = harness.proposal();
        *harness.hooks.fail.lock().expect("failure") = Some(point);
        assert_eq!(harness.manager.commit(proposal), CommitOutcome::Unavailable);
        assert!(matches!(
            harness.manager.load(&plan),
            LoadOutcome::Unavailable
        ));
        assert_eq!(
            harness.manager.warning().as_deref(),
            Some("compiled cache storage is unavailable")
        );
    }
}

#[test]
fn unavailable_storage_issues_no_claim_and_skips_serialization() {
    let harness = Harness::new();
    let blocker = harness.fixture.base.join("blocked-cache");
    std::fs::write(&blocker, b"not a directory").expect("blocker");
    let manager = CacheManager::with_parts(
        blocker,
        harness.config_root.clone(),
        harness.clock.clone(),
        harness.hooks.clone(),
    );
    let plan = harness.plan();
    let compiled = crate::compile::project(&harness.fixture.root);
    assert!(manager.capture_write_claim(&harness.fixture.root).is_none());
    assert!(matches!(manager.load(&plan), LoadOutcome::Unavailable));
    assert!(
        !harness
            .hooks
            .seen
            .lock()
            .expect("seen")
            .contains(&Point::BeforeSerialize)
    );
    assert!(
        compiled.rules.is_some(),
        "fresh rules remain independently usable"
    );
}

#[test]
fn malformed_settings_use_safe_defaults_and_report_a_warning() {
    let harness = Harness::new();
    std::fs::create_dir_all(&harness.config_root).expect("config");
    std::fs::write(harness.config_root.join("cache.json"), b"not json").expect("settings");
    let manager = CacheManager::new(harness.cache_root.clone(), harness.config_root.clone());
    assert_eq!(manager.settings(), CacheSettings::default());
    assert!(manager.warning().is_some());
}

#[test]
fn settings_validation_rejects_non_mib_and_out_of_range_values() {
    for maximum_bytes in [0, MINIMUM_BYTES - 1, MINIMUM_BYTES + 1, MAXIMUM_BYTES + 1] {
        assert!(
            CacheSettings {
                maximum_bytes,
                ..CacheSettings::default()
            }
            .validate()
            .is_err()
        );
    }
    assert!(CacheSettings::default().validate().is_ok());
}

// --- Maintenance, usage and quota -----------------------------------------

fn available_usage(outcome: UsageOutcome) -> CacheUsage {
    match outcome {
        UsageOutcome::Available(usage) => usage,
        UsageOutcome::Unavailable => panic!("cache should be available"),
    }
}

fn entry_exists(manager: &CacheManager, root: &Path) -> bool {
    manager
        .target_dir(&ProjectId::for_root(root))
        .join("metadata.json")
        .is_file()
}

#[test]
fn maintenance_removes_owned_temporaries_and_orphans_but_keeps_the_live_generation() {
    let harness = Harness::new();
    harness.commit();
    let live = harness.artifact_path();
    let fingerprint = harness.metadata().fingerprint;
    let orphan = harness
        .target_dir()
        .join(format!("rules-{fingerprint}-{}.yarc", "a".repeat(32)));
    let temporary = harness
        .target_dir()
        .join(format!(".artifact-42-{}.tmp", "b".repeat(32)));
    std::fs::write(&orphan, vec![1; 137]).expect("orphan");
    std::fs::write(&temporary, vec![2; 91]).expect("temporary");

    let usage = available_usage(harness.manager.maintain(Some(&harness.fixture.root)));

    assert!(live.exists());
    assert!(!orphan.exists());
    assert!(!temporary.exists());
    assert!(usage.current_project_cached);
    assert_eq!(
        usage.total_bytes,
        regular_usage_nofollow(&harness.manager.root.join("projects")).expect("usage")
    );
    assert_eq!(
        usage.current_project_bytes,
        regular_usage_nofollow(
            &harness
                .manager
                .root
                .join("projects")
                .join(ProjectId::for_root(&harness.fixture.root).as_str()),
        )
        .expect("project usage")
    );
}

#[test]
fn invalid_metadata_and_its_now_unreferenced_artifact_are_cleaned() {
    let harness = Harness::new();
    harness.commit();
    let artifact = harness.artifact_path();
    std::fs::write(harness.target_dir().join("metadata.json"), b"broken").expect("corrupt");

    let usage = available_usage(harness.manager.maintain(Some(&harness.fixture.root)));

    assert!(!artifact.exists());
    assert!(!harness.target_dir().join("metadata.json").exists());
    assert!(!usage.current_project_cached);
    assert_eq!(usage.current_project_bytes, 0);
}

#[test]
fn quota_evicts_lru_to_low_water_and_breaks_timestamp_ties_by_project_id() {
    let harness = Harness::new();
    let first = harness.add_project("first");
    let second = harness.add_project("second");
    let newest = harness.add_project("newest");
    harness.manager.lock_state().settings.maximum_bytes = MINIMUM_BYTES;
    harness.clock.set(100);
    assert_eq!(
        harness
            .manager
            .commit(harness.padded_proposal(&first, 400 * 1024)),
        CommitOutcome::Committed
    );
    // Same second: project ID, not directory enumeration order, decides.
    assert_eq!(
        harness
            .manager
            .commit(harness.padded_proposal(&second, 400 * 1024)),
        CommitOutcome::Committed
    );
    harness.clock.set(200);
    assert_eq!(
        harness
            .manager
            .commit(harness.padded_proposal(&newest, 400 * 1024)),
        CommitOutcome::Committed
    );

    let (tie_first, tie_second) = if ProjectId::for_root(&first) < ProjectId::for_root(&second) {
        (&first, &second)
    } else {
        (&second, &first)
    };
    assert!(!entry_exists(&harness.manager, tie_first));
    assert!(entry_exists(&harness.manager, tie_second));
    assert!(entry_exists(&harness.manager, &newest));
    let usage = available_usage(harness.manager.maintain(Some(&newest)));
    assert!(usage.total_bytes <= MINIMUM_BYTES * 4 / 5);
}

#[test]
fn quota_skips_the_active_project_even_when_it_is_oldest() {
    let harness = Harness::new();
    let active = harness.add_project("active");
    let middle = harness.add_project("middle");
    let newest = harness.add_project("latest");
    for (time, root) in [(100, &active), (200, &middle), (300, &newest)] {
        harness.clock.set(time);
        assert_eq!(
            harness
                .manager
                .commit(harness.padded_proposal(root, 400 * 1024)),
            CommitOutcome::Committed
        );
    }
    harness.manager.lock_state().settings.maximum_bytes = MINIMUM_BYTES;

    let usage = available_usage(harness.manager.maintain(Some(&active)));

    assert!(entry_exists(&harness.manager, &active));
    assert!(!entry_exists(&harness.manager, &middle));
    assert!(entry_exists(&harness.manager, &newest));
    assert!(usage.current_project_cached);
    assert!(usage.total_bytes <= MINIMUM_BYTES * 4 / 5);
}

#[test]
fn a_sole_pinned_entry_may_remain_over_target_and_is_reported_exactly() {
    let harness = Harness::new();
    let active = harness.add_project("large_active");
    assert_eq!(
        harness
            .manager
            .commit(harness.padded_proposal(&active, 1100 * 1024)),
        CommitOutcome::Committed
    );
    harness.manager.lock_state().settings.maximum_bytes = MINIMUM_BYTES;

    let usage = available_usage(harness.manager.maintain(Some(&active)));

    assert!(entry_exists(&harness.manager, &active));
    assert!(usage.total_bytes > MINIMUM_BYTES);
    assert_eq!(usage.current_project_bytes, usage.total_bytes);
    assert!(usage.current_project_cached);
    assert_eq!(
        harness.manager.warning().as_deref(),
        Some("compiled cache maintenance could not reach its target")
    );
}

#[test]
fn an_oversized_replacement_is_never_committed_and_keeps_the_old_generation() {
    let harness = Harness::new();
    harness.manager.lock_state().settings.maximum_bytes = MINIMUM_BYTES;
    harness.commit();
    let old = harness.metadata();

    assert_eq!(
        harness
            .manager
            .commit(harness.padded_proposal(&harness.fixture.root, MINIMUM_BYTES as usize + 1)),
        CommitOutcome::QuotaExceeded
    );
    assert_eq!(
        harness.metadata().artifact.generation,
        old.artifact.generation
    );
}

#[test]
fn an_unremovable_orphan_remains_in_exact_usage_and_sets_a_warning() {
    let harness = Harness::new();
    harness.commit();
    let orphan = harness.target_dir().join(format!(
        "rules-{}-{}.yarc",
        harness.metadata().fingerprint,
        "c".repeat(32)
    ));
    std::fs::write(&orphan, vec![7; 313]).expect("orphan");
    *harness.hooks.fail.lock().expect("failure") = Some(Point::MaintenanceRemove);

    let usage = available_usage(harness.manager.maintain(Some(&harness.fixture.root)));

    assert!(orphan.exists());
    assert_eq!(
        usage.total_bytes,
        regular_usage_nofollow(&harness.manager.root.join("projects")).expect("usage")
    );
    assert_eq!(
        harness.manager.warning().as_deref(),
        Some("compiled cache maintenance could not reach its target")
    );
}

#[test]
fn last_used_is_touched_at_most_hourly_and_touch_failure_does_not_lose_the_hit() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.clock.set(10_000);
    harness.commit();
    assert_eq!(harness.metadata().last_used_unix_seconds, 10_000);

    harness.clock.set(10_000 + LAST_USED_INTERVAL_SECONDS - 1);
    assert_hit(harness.manager.load(&plan));
    assert_eq!(harness.metadata().last_used_unix_seconds, 10_000);

    harness.clock.set(10_000 + LAST_USED_INTERVAL_SECONDS);
    assert_hit(harness.manager.load(&plan));
    assert_eq!(
        harness.metadata().last_used_unix_seconds,
        10_000 + LAST_USED_INTERVAL_SECONDS
    );

    harness.hooks.seen.lock().expect("seen").clear();
    *harness.hooks.fail.lock().expect("failure") = Some(Point::BeforeLastUsedCommit);
    harness.clock.set(10_000 + 2 * LAST_USED_INTERVAL_SECONDS);
    assert_hit(harness.manager.load(&plan));
    assert_eq!(
        harness.metadata().last_used_unix_seconds,
        10_000 + LAST_USED_INTERVAL_SECONDS
    );
    assert_eq!(
        harness.manager.warning().as_deref(),
        Some("compiled cache last-used update failed")
    );
}

#[test]
fn unavailable_maintenance_is_a_cache_only_failure() {
    let harness = Harness::new();
    let blocker = harness.fixture.base.join("maintenance-blocker");
    std::fs::write(&blocker, b"not a directory").expect("blocker");
    let manager = CacheManager::new(blocker, harness.config_root.clone());

    assert_eq!(
        manager.maintain(Some(&harness.fixture.root)),
        UsageOutcome::Unavailable
    );
    assert_eq!(
        manager.warning().as_deref(),
        Some("compiled cache maintenance is unavailable")
    );
}

#[test]
fn maintenance_read_failure_preserves_the_committed_entry() {
    let harness = Harness::new();
    harness.commit();
    let metadata = harness.metadata();
    let artifact = harness.artifact_path();
    *harness.hooks.fail.lock().expect("failure") = Some(Point::BeforeArtifactHash);

    available_usage(harness.manager.maintain(Some(&harness.fixture.root)));

    assert_eq!(harness.metadata(), metadata, "unreadable is not corrupt");
    assert!(artifact.exists());
    assert!(harness.manager.warning().is_some());
    *harness.hooks.fail.lock().expect("failure") = None;
    assert_hit(harness.manager.load(&harness.plan()));
}

#[test]
fn persistence_trace_distinguishes_commit_failure_without_exposing_project_data() {
    let harness = Harness::new();
    let (trace, lines) = crate::debug_trace::DebugTrace::captured();
    *harness.hooks.fail.lock().expect("failure") = Some(Point::BeforeMetadataCommit);
    let outcome = harness
        .manager
        .commit_observed(harness.proposal(), Some(&trace));
    assert_eq!(outcome, CommitOutcome::Unavailable);
    assert!(trace.flush());
    let output = lines.lock().expect("trace").join("\n");
    assert!(output.contains("BeforeMetadataCommit"));
    assert!(output.contains("Unavailable"));
    assert!(!output.contains(&harness.fixture.root.to_string_lossy().into_owned()));
    assert!(!output.contains("main.yar"));
    assert!(!output.contains("rule cached"));
}

#[test]
fn cache_io_evidence_keeps_codes_but_not_os_error_text() {
    let detail = cache_io_error(
        "cache temporary write failed",
        io::Error::from_raw_os_error(5),
    );
    assert!(detail.contains("OS code: Some(5)"));
    let detail = cache_io_error(
        "cache temporary write failed",
        io::Error::other("private/path/to/rules"),
    );
    assert!(!detail.contains("private"));
}

#[cfg(windows)]
#[test]
fn maintenance_sharing_violations_preserve_metadata_and_artifact() {
    use std::os::windows::fs::OpenOptionsExt;

    for lock_metadata in [true, false] {
        let harness = Harness::new();
        harness.commit();
        let metadata = harness.metadata();
        let metadata_path = harness.target_dir().join("metadata.json");
        let artifact = harness.artifact_path();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(if lock_metadata {
                &metadata_path
            } else {
                &artifact
            })
            .expect("hold cache file exclusively");

        let _ = harness.manager.maintain(Some(&harness.fixture.root));
        drop(held);

        assert_eq!(
            harness.metadata(),
            metadata,
            "sharing violation lost metadata"
        );
        assert!(artifact.exists(), "sharing violation lost artifact");
        let restarted = CacheManager::new(harness.cache_root.clone(), harness.config_root.clone());
        assert_hit(restarted.load(&harness.plan()));
    }
}

// --- Backend-owned settings -----------------------------------------------

#[test]
fn settings_update_is_atomic_published_and_preserves_the_config_lock() {
    let harness = Harness::new();
    let settings = CacheSettings {
        enabled: false,
        maximum_bytes: 64 * 1024 * 1024,
        ..CacheSettings::default()
    };

    let usage = available_usage(
        harness
            .manager
            .update_settings(settings, Some(&harness.fixture.root))
            .expect("settings update"),
    );

    assert_eq!(harness.manager.settings(), settings);
    let persisted: CacheSettings = serde_json::from_slice(
        &std::fs::read(harness.config_root.join("cache.json")).expect("settings file"),
    )
    .expect("settings json");
    assert_eq!(persisted, settings);
    assert!(harness.config_root.join("cache.lock").is_file());
    assert_eq!(usage.total_bytes, 0);
}

#[test]
fn an_unavailable_optional_active_root_drops_only_the_eviction_pin() {
    let harness = Harness::new();
    let settings = CacheSettings {
        maximum_bytes: 64 * 1024 * 1024,
        ..CacheSettings::default()
    };
    let missing = harness.fixture.base.join("no-longer-open");

    let usage = harness
        .manager
        .update_settings(settings, Some(&missing))
        .expect("global settings do not require an eviction pin");

    assert_eq!(harness.manager.settings(), settings);
    assert!(matches!(usage, UsageOutcome::Available(_)));
}

#[test]
fn a_precommit_settings_failure_keeps_runtime_and_disk_settings() {
    let harness = Harness::new();
    let old = CacheSettings {
        maximum_bytes: 64 * 1024 * 1024,
        ..CacheSettings::default()
    };
    harness
        .manager
        .update_settings(old, None)
        .expect("initial settings");
    *harness.hooks.fail.lock().expect("failure") = Some(Point::BeforeSettingsCommit);
    let replacement = CacheSettings {
        enabled: false,
        ..old
    };

    assert!(harness.manager.update_settings(replacement, None).is_err());

    assert_eq!(harness.manager.settings(), old);
    let persisted: CacheSettings = serde_json::from_slice(
        &std::fs::read(harness.config_root.join("cache.json")).expect("old settings"),
    )
    .expect("settings json");
    assert_eq!(persisted, old);
}

#[test]
fn disabling_refuses_an_older_proposal_and_retains_the_committed_entry() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    let old_generation = harness.metadata().artifact.generation;
    let proposal = harness.proposal();

    harness
        .manager
        .update_settings(
            CacheSettings {
                enabled: false,
                ..CacheSettings::default()
            },
            Some(&harness.fixture.root),
        )
        .expect("disable");

    let outcome = harness.manager.commit(proposal);
    harness.manager.record_commit_outcome(outcome);
    assert_eq!(
        outcome,
        CommitOutcome::Declined(PersistenceDecline::Disabled)
    );
    assert_eq!(harness.manager.warning(), None);
    assert_eq!(harness.metadata().artifact.generation, old_generation);
    assert!(matches!(harness.manager.load(&plan), LoadOutcome::Disabled));
}

#[test]
fn disable_then_reenable_does_not_revive_a_precompile_claim() {
    let harness = Harness::new();
    let plan = harness.plan();
    let claim = harness
        .manager
        .capture_write_claim(&harness.fixture.root)
        .expect("precompile claim");
    harness
        .manager
        .update_settings(
            CacheSettings {
                enabled: false,
                ..CacheSettings::default()
            },
            None,
        )
        .expect("disable");
    harness
        .manager
        .update_settings(CacheSettings::default(), None)
        .expect("re-enable");
    let compiled = crate::compile::compile_plan(&plan);
    harness.hooks.seen.lock().expect("seen").clear();

    let outcome = harness.manager.prepare(
        &claim,
        &plan,
        compiled.rules.as_ref().expect("rules"),
        &compiled.diagnostics,
        compiled.rule_count,
    );
    harness.manager.record_prepare_outcome(&outcome);
    assert!(matches!(
        outcome,
        PrepareOutcome::Declined(PersistenceDecline::Superseded)
    ));
    assert_eq!(harness.manager.warning(), None);
    assert!(
        !harness
            .hooks
            .seen
            .lock()
            .expect("seen")
            .contains(&Point::BeforeSerialize)
    );
}

#[test]
fn disabled_cache_issues_no_write_claim() {
    let harness = Harness::new();
    harness
        .manager
        .update_settings(
            CacheSettings {
                enabled: false,
                ..CacheSettings::default()
            },
            None,
        )
        .expect("disable");
    harness.hooks.seen.lock().expect("seen").clear();

    assert!(matches!(
        harness.manager.capture_write_claim(&harness.fixture.root),
        ClaimOutcome::Declined(PersistenceDecline::Disabled)
    ));
    assert!(
        !harness
            .hooks
            .seen
            .lock()
            .expect("seen")
            .contains(&Point::BeforeSerialize)
    );
}

#[test]
fn lowering_the_limit_enforces_quota_before_the_settings_request_returns() {
    let harness = Harness::new();
    let active = harness.add_project("settings_active");
    let victim = harness.add_project("settings_victim");
    let newest = harness.add_project("settings_newest");
    for (time, root) in [(100, &active), (200, &victim), (300, &newest)] {
        harness.clock.set(time);
        assert_eq!(
            harness
                .manager
                .commit(harness.padded_proposal(root, 400 * 1024)),
            CommitOutcome::Committed
        );
    }

    let usage = available_usage(
        harness
            .manager
            .update_settings(
                CacheSettings {
                    maximum_bytes: MINIMUM_BYTES,
                    ..CacheSettings::default()
                },
                Some(&active),
            )
            .expect("lower limit"),
    );

    assert!(entry_exists(&harness.manager, &active));
    assert!(!entry_exists(&harness.manager, &victim));
    assert!(entry_exists(&harness.manager, &newest));
    assert!(usage.total_bytes <= MINIMUM_BYTES * 4 / 5);
}

#[test]
fn unwritable_settings_storage_does_not_publish_the_requested_settings() {
    let harness = Harness::new();
    let blocker = harness.fixture.base.join("config-blocker");
    std::fs::write(&blocker, b"not a directory").expect("blocker");
    let manager = CacheManager::new(harness.cache_root.clone(), blocker);
    let requested = CacheSettings {
        enabled: false,
        ..CacheSettings::default()
    };

    assert!(manager.update_settings(requested, None).is_err());
    assert_eq!(manager.settings(), CacheSettings::default());
}

#[test]
fn settings_remain_writable_when_only_the_cache_location_is_unavailable() {
    let harness = Harness::new();
    let manager = CacheManager::unavailable_with_config(harness.config_root.clone());
    let settings = CacheSettings {
        enabled: false,
        ..CacheSettings::default()
    };

    assert_eq!(
        manager
            .update_settings(settings, None)
            .expect("settings write"),
        UsageOutcome::Unavailable
    );
    assert_eq!(manager.settings(), settings);
    assert!(harness.config_root.join("cache.json").is_file());
}

#[test]
fn a_commit_already_at_its_commit_point_finishes_before_concurrent_clear_returns() {
    let harness = Harness::new();
    harness.commit();
    let proposal = harness.proposal();
    let (seen_tx, seen_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let hooks = Arc::new(BlockingHooks {
        block: Point::AfterMetadataCommit,
        seen: seen_tx,
        release: Mutex::new(release_rx),
    });
    let manager = Arc::new(CacheManager::with_parts(
        harness.cache_root.clone(),
        harness.config_root.clone(),
        Arc::new(TestClock::new(1_800_000_000)),
        hooks,
    ));

    std::thread::scope(|scope| {
        let writer = {
            let manager = Arc::clone(&manager);
            scope.spawn(move || manager.commit(proposal))
        };
        while seen_rx.recv().expect("writer hook") != Point::AfterMetadataCommit {}
        let clearer = {
            let manager = Arc::clone(&manager);
            let root = harness.fixture.root.clone();
            scope.spawn(move || manager.clear_current(&root))
        };
        while seen_rx.recv().expect("clear hook") != Point::AfterClearEpoch {}
        release_tx.send(()).expect("release writer");
        assert_eq!(writer.join().expect("writer"), CommitOutcome::Committed);
        assert_eq!(clearer.join().expect("clearer"), ClearOutcome::Cleared);
    });

    assert!(!harness.target_dir().exists());
}

#[test]
fn a_load_that_validates_before_disable_keeps_its_in_memory_hit() {
    let harness = Harness::new();
    let plan = harness.plan();
    harness.commit();
    let (seen_tx, seen_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let hooks = Arc::new(BlockingHooks {
        block: Point::BeforeDeserialize,
        seen: seen_tx,
        release: Mutex::new(release_rx),
    });
    let manager = Arc::new(CacheManager::with_parts(
        harness.cache_root.clone(),
        harness.config_root.clone(),
        Arc::new(TestClock::new(1_800_000_000)),
        hooks,
    ));

    std::thread::scope(|scope| {
        let loader = {
            let manager = Arc::clone(&manager);
            scope.spawn(move || manager.load(&plan))
        };
        while seen_rx.recv().expect("load hook") != Point::BeforeDeserialize {}
        let disabler = {
            let manager = Arc::clone(&manager);
            let root = harness.fixture.root.clone();
            scope.spawn(move || {
                manager.update_settings(
                    CacheSettings {
                        enabled: false,
                        ..CacheSettings::default()
                    },
                    Some(&root),
                )
            })
        };
        release_tx.send(()).expect("release load");
        assert_hit(loader.join().expect("loader"));
        assert!(disabler.join().expect("disabler").is_ok());
    });

    assert!(matches!(
        manager.load(&harness.plan()),
        LoadOutcome::Disabled
    ));
    assert!(
        harness.artifact_path().exists(),
        "disable retains disk entries"
    );
}

#[cfg(unix)]
#[test]
fn read_only_cache_storage_degrades_without_affecting_compiled_rules() {
    use std::os::unix::fs::PermissionsExt;

    let harness = Harness::new();
    let read_only = harness.fixture.base.join("read-only-cache");
    std::fs::create_dir(&read_only).expect("cache parent");
    std::fs::set_permissions(&read_only, std::fs::Permissions::from_mode(0o500))
        .expect("make read only");
    let manager = CacheManager::new(read_only.clone(), harness.config_root.clone());
    let plan = harness.plan();
    let compiled = crate::compile::project(&harness.fixture.root);

    assert!(matches!(manager.load(&plan), LoadOutcome::Unavailable));
    assert!(compiled.rules.is_some());

    // TempDir cleanup must be able to remove its child after the assertion.
    std::fs::set_permissions(&read_only, std::fs::Permissions::from_mode(0o700))
        .expect("restore permissions");
}

#[cfg(unix)]
#[test]
fn maintenance_unlinks_cache_named_symlinks_without_following_them() {
    use std::os::unix::fs::symlink;

    let harness = Harness::new();
    harness.commit();
    let outside = harness.fixture.base.join("outside-maintenance");
    std::fs::write(&outside, b"untouched").expect("outside");
    let orphan = harness.target_dir().join(format!(
        "rules-{}-{}.yarc",
        harness.metadata().fingerprint,
        "d".repeat(32)
    ));
    symlink(&outside, &orphan).expect("orphan symlink");

    available_usage(harness.manager.maintain(Some(&harness.fixture.root)));

    assert!(!orphan.exists());
    assert_eq!(std::fs::read(&outside).expect("outside"), b"untouched");
}

#[test]
#[ignore = "manual, non-gating cache measurement"]
fn measure_portable_cache_operations() {
    use std::time::{Duration, Instant};

    fn median(mut values: Vec<Duration>) -> Duration {
        values.sort();
        values[values.len() / 2]
    }

    let harness = Harness::new();
    let mut source = String::new();
    for index in 0..250 {
        source.push_str(&format!(
            "rule measured_{index} {{ strings: $a = \"needle-{index}\" condition: $a }}\n"
        ));
    }
    harness.fixture.write("main.yar", &source);
    let plan = harness.plan();
    let _warmup = crate::compile::compile_plan(&plan);

    let mut compile_times = Vec::new();
    let mut compiled = None;
    for _ in 0..11 {
        let start = Instant::now();
        let result = crate::compile::compile_plan(&plan);
        compile_times.push(start.elapsed());
        compiled = Some(result);
    }
    let compiled = compiled.expect("measurement compile");
    let rules = compiled.rules.as_ref().expect("rules");

    let mut serialize_times = Vec::new();
    let mut artifact = Vec::new();
    for _ in 0..11 {
        let start = Instant::now();
        artifact = rules.as_ref().serialize().expect("serialize");
        serialize_times.push(start.elapsed());
    }
    let mut deserialize_times = Vec::new();
    for _ in 0..11 {
        let start = Instant::now();
        let restored = yara_x::Rules::deserialize(&artifact).expect("deserialize");
        deserialize_times.push(start.elapsed());
        std::hint::black_box(restored);
    }

    let claim = harness
        .manager
        .capture_write_claim(&harness.fixture.root)
        .expect("write claim");
    let proposal = harness
        .manager
        .prepare(
            &claim,
            &plan,
            rules,
            &compiled.diagnostics,
            compiled.rule_count,
        )
        .expect("proposal");
    assert_eq!(harness.manager.commit(proposal), CommitOutcome::Committed);
    let metadata_bytes = std::fs::metadata(harness.target_dir().join("metadata.json"))
        .expect("metadata")
        .len();
    let mut restore_times = Vec::new();
    for _ in 0..11 {
        let start = Instant::now();
        assert_hit(harness.manager.load(&plan));
        restore_times.push(start.elapsed());
    }

    println!(
        "cache-measurement rules={} source_bytes={} artifact_bytes={} metadata_bytes={} \
         fresh_compile_median_us={} serialize_median_us={} deserialize_median_us={} \
         cache_restore_median_us={} os={} arch={} yara_x={}",
        compiled.rule_count,
        source.len(),
        artifact.len(),
        metadata_bytes,
        median(compile_times).as_micros(),
        median(serialize_times).as_micros(),
        median(deserialize_times).as_micros(),
        median(restore_times).as_micros(),
        std::env::consts::OS,
        std::env::consts::ARCH,
        yara_x::VERSION,
    );
}
