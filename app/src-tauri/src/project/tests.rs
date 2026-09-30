//! Tests for the project model.
//!
//! Every test builds a throwaway tree on disk rather than using checked-in
//! fixtures: the model's whole job is to interpret a directory, and a temporary
//! directory keeps each case's layout next to its assertions.
//!
//! The project root is a `project/` subdirectory of the temporary directory, so
//! a test can also create files *outside* the project (via
//! [`Fixture::write_outside`]) to exercise external dependencies and include
//! directories that point at a shared sibling.
//!
//! Assertions are on structured values - identities, edges, entrypoints, issue
//! codes, plan validity - never on `Debug` output.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use super::*;

/// A temporary project tree.
struct Fixture {
    /// Kept alive so the directory outlives the test.
    _dir: tempfile::TempDir,
    /// Canonical temporary directory; the project root's parent.
    base: PathBuf,
    /// Canonical project root.
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let base = std::fs::canonicalize(dir.path()).expect("canonical temp dir");
        let root = base.join("project");
        std::fs::create_dir(&root).expect("project dir");
        Self {
            _dir: dir,
            base,
            root,
        }
    }

    /// Writes a file inside the project, creating parent directories.
    fn write(&self, relative: &str, contents: &str) -> &Self {
        write_at(&self.root.join(relative), contents);
        self
    }

    /// Writes a file in the project root under a name that need not be valid
    /// Unicode.
    fn write_raw(&self, name: OsString, contents: &str) -> &Self {
        write_at(&self.root.join(name), contents);
        self
    }

    /// Writes a file next to the project, outside its root.
    fn write_outside(&self, relative: &str, contents: &str) -> &Self {
        write_at(&self.base.join(relative), contents);
        self
    }

    fn manifest(&self, contents: &str) -> &Self {
        self.write(MANIFEST_FILE, contents)
    }

    fn dir(&self, relative: &str) -> &Self {
        std::fs::create_dir_all(self.root.join(relative)).expect("create dir");
        self
    }

    /// Creates a symlink at `link` (project-relative) pointing at `target`
    /// (as written, so it may be relative to `link`'s directory).
    #[cfg(unix)]
    fn symlink(&self, target: &str, link: &str) -> &Self {
        let link = self.root.join(link);
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        std::os::unix::fs::symlink(target, link).expect("create symlink");
        self
    }

    /// Analyzes the project, asserting the configuration is valid.
    fn open(&self) -> ProjectSnapshot {
        open_project(&self.root).unwrap_or_else(|e| panic!("unexpected config error: {e}"))
    }

    /// Analyzes the project, asserting the configuration is *not* valid.
    fn open_err(&self) -> ConfigError {
        match open_project(&self.root) {
            Ok(_) => panic!("expected a configuration error"),
            Err(err) => err,
        }
    }
}

fn write_at(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent dir");
    }
    std::fs::write(path, contents).expect("write file");
}

/// A filename from raw bytes that are deliberately not valid UTF-8.
///
/// Unix only: `OsStr` is a byte string there. On Windows the equivalent is an
/// unpaired surrogate, which needs a different API, and no production code in the
/// model constructs such a path - it only refuses to give one an identity.
#[cfg(unix)]
fn non_unicode(bytes: &[u8]) -> OsString {
    use std::os::unix::ffi::OsStrExt;
    OsStr::from_bytes(bytes).to_os_string()
}

/// A rule with a unique name, so a repeated expansion would be a real
/// duplicate-identifier error in YARA-X.
fn rule(name: &str) -> String {
    format!("rule {name} {{ condition: true }}\n")
}

fn paths_of(ids: &[SourceId]) -> Vec<&str> {
    ids.iter().map(|id| id.path.as_str()).collect()
}

fn discovered(snapshot: &ProjectSnapshot) -> Vec<&str> {
    paths_of(snapshot.discovered())
}

fn entrypoints(snapshot: &ProjectSnapshot) -> Vec<&str> {
    paths_of(snapshot.entrypoints())
}

fn codes(snapshot: &ProjectSnapshot) -> Vec<&'static str> {
    snapshot.issues().iter().map(ProjectIssue::code).collect()
}

/// Issue codes attributed to one source, in issue order.
fn codes_at(snapshot: &ProjectSnapshot, path: &str) -> Vec<&'static str> {
    snapshot
        .issues()
        .iter()
        .filter(|issue| issue.at.as_ref().is_some_and(|at| at.path == path))
        .map(ProjectIssue::code)
        .collect()
}

/// Every include directive as `(from, raw, resolved target)`.
fn edges(snapshot: &ProjectSnapshot) -> Vec<(&str, &str, Option<&str>)> {
    snapshot
        .edges()
        .iter()
        .map(|edge| {
            (
                edge.from.path.as_str(),
                edge.raw.as_str(),
                edge.to.as_ref().map(|to| to.path.as_str()),
            )
        })
        .collect()
}

fn expect_plan(snapshot: &ProjectSnapshot) -> CompilationPlan {
    snapshot
        .compilation_plan()
        .unwrap_or_else(|e| panic!("expected a valid plan, got {e}"))
}

fn expect_rejection(snapshot: &ProjectSnapshot) -> PlanRejection {
    match snapshot.compilation_plan() {
        Ok(_) => panic!("expected the plan to be rejected"),
        Err(rejection) => rejection,
    }
}

fn plan_entrypoints(plan: &CompilationPlan) -> Vec<&str> {
    plan.entrypoints()
        .iter()
        .map(|input| input.id.path.as_str())
        .collect()
}

fn plan_closure(plan: &CompilationPlan) -> Vec<&str> {
    plan.closure()
        .iter()
        .map(|input| input.id.path.as_str())
        .collect()
}

#[test]
fn plan_evidence_comes_from_the_bytes_the_snapshot_parsed() {
    let fixture = Fixture::new();
    let main = format!("include \"lib.yar\"\n{}", rule("main"));
    let library = rule("library");
    fixture.write("main.yar", &main);
    fixture.write("lib.yar", &library);

    let plan = expect_plan(&fixture.open());
    let evidence = |path: &str| {
        plan.closure()
            .iter()
            .find(|input| input.id.path == path)
            .expect("input")
            .evidence
    };
    assert_eq!(evidence("main.yar").bytes, main.len() as u64);
    assert_eq!(
        evidence("main.yar").digest,
        *blake3::hash(main.as_bytes()).as_bytes()
    );
    assert_eq!(evidence("lib.yar").bytes, library.len() as u64);
    assert_eq!(
        evidence("lib.yar").digest,
        *blake3::hash(library.as_bytes()).as_bytes()
    );
    assert_eq!(
        plan.edges(),
        [plan::PlanEdge {
            from: SourceId {
                external: false,
                path: "main.yar".into()
            },
            order: 0,
            raw: "lib.yar".into(),
            to: SourceId {
                external: false,
                path: "lib.yar".into()
            },
        }]
    );
}

// --- Manifest defaults and discovery ---------------------------------------

#[test]
fn project_without_manifest_uses_documented_defaults() {
    let fixture = Fixture::new();
    fixture.write("a.yar", &rule("a"));

    let snapshot = fixture.open();
    let definition = snapshot.definition();

    assert_eq!(definition.manifest(), None);
    assert!(definition.declared_entrypoints().is_empty());
    assert_eq!(definition.include_dirs().len(), 1);
    assert_eq!(definition.include_dirs()[0].spec(), ".");
    assert_eq!(definition.include_dirs()[0].path(), definition.root());
    assert!(definition.exclude_patterns().is_empty());
    assert_eq!(snapshot.entrypoint_origin(), EntrypointOrigin::Inferred);
}

#[test]
fn flat_project_without_manifest_infers_every_file_as_a_root() {
    let fixture = Fixture::new();
    fixture.write("a.yar", &rule("a"));
    fixture.write("b.yar", &rule("b"));
    fixture.write("c.yar", &rule("c"));

    let snapshot = fixture.open();

    assert_eq!(discovered(&snapshot), ["a.yar", "b.yar", "c.yar"]);
    assert_eq!(entrypoints(&snapshot), ["a.yar", "b.yar", "c.yar"]);
    assert_eq!(codes(&snapshot), Vec::<&str>::new());

    let plan = expect_plan(&snapshot);
    assert_eq!(plan_entrypoints(&plan), ["a.yar", "b.yar", "c.yar"]);
    assert_eq!(plan_closure(&plan), ["a.yar", "b.yar", "c.yar"]);
    assert_eq!(
        plan.include_dirs(),
        [snapshot.definition().root().to_path_buf()]
    );
}

#[test]
fn discovery_is_recursive_and_matches_extensions_case_insensitively() {
    let fixture = Fixture::new();
    fixture.write("top.YAR", &rule("top"));
    fixture.write("nested/deep/inner.Yara", &rule("inner"));
    fixture.write("nested/mid.yara", &rule("mid"));

    let snapshot = fixture.open();

    assert_eq!(
        discovered(&snapshot),
        ["nested/deep/inner.Yara", "nested/mid.yara", "top.YAR"]
    );
}

#[test]
fn discovery_ignores_files_that_are_not_rule_files() {
    let fixture = Fixture::new();
    fixture.write("a.yar", &rule("a"));
    fixture.write("notes.txt", "not a rule\n");
    fixture.write("common.inc", &rule("common"));
    fixture.write("archive.yar.bak", &rule("bak"));
    fixture.write("sub/README.md", "docs\n");

    let snapshot = fixture.open();

    assert_eq!(discovered(&snapshot), ["a.yar"]);
    // The manifest is not a rule file either, even though it is in the root.
    fixture.manifest("schema = 1\n");
    assert_eq!(discovered(&fixture.open()), ["a.yar"]);
}

#[test]
fn discovery_reports_trees_deeper_than_the_depth_limit() {
    let fixture = Fixture::new();
    let deep: String = (0..=super::discovery::MAX_DEPTH)
        .map(|i| format!("d{i}/"))
        .collect::<String>();
    fixture.write("shallow.yar", &rule("shallow"));
    fixture.write(&format!("{deep}buried.yar"), &rule("buried"));

    let snapshot = fixture.open();

    assert_eq!(discovered(&snapshot), ["shallow.yar"]);
    assert_eq!(codes(&snapshot), ["discovery-depth-exceeded"]);
    // Incomplete discovery is project-scoped, so it blocks every plan.
    assert_eq!(
        expect_rejection(&snapshot).codes(),
        ["discovery-depth-exceeded"]
    );
}

// --- Include resolution ----------------------------------------------------

#[test]
fn an_include_creates_an_edge_between_two_files() {
    let fixture = Fixture::new();
    fixture.write(
        "main.yar",
        &format!("include \"lib.yar\"\n{}", rule("main")),
    );
    fixture.write("lib.yar", &rule("lib"));

    let snapshot = fixture.open();

    assert_eq!(edges(&snapshot), [("main.yar", "lib.yar", Some("lib.yar"))]);
    assert_eq!(entrypoints(&snapshot), ["main.yar"]);
    assert_eq!(codes(&snapshot), Vec::<&str>::new());
    assert_eq!(
        plan_closure(&expect_plan(&snapshot)),
        ["lib.yar", "main.yar"]
    );
}

#[test]
fn nested_relative_includes_resolve_against_the_including_file() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"sub/a.yar\"\n");
    fixture.write("sub/a.yar", "include \"b.yar\"\n");
    fixture.write("sub/b.yar", "include \"../top.yar\"\n");
    fixture.write("top.yar", &rule("top"));

    let snapshot = fixture.open();

    assert_eq!(
        edges(&snapshot),
        [
            ("main.yar", "sub/a.yar", Some("sub/a.yar")),
            ("sub/a.yar", "b.yar", Some("sub/b.yar")),
            ("sub/b.yar", "../top.yar", Some("top.yar")),
        ]
    );
    assert_eq!(entrypoints(&snapshot), ["main.yar"]);
    assert_eq!(codes(&snapshot), Vec::<&str>::new());
    assert_eq!(
        plan_closure(&expect_plan(&snapshot)),
        ["main.yar", "sub/a.yar", "sub/b.yar", "top.yar"]
    );
}

#[test]
fn the_including_files_directory_takes_priority_over_include_dirs() {
    let fixture = Fixture::new();
    fixture
        .manifest("schema = 1\nentrypoints = [\"rules/main.yar\"]\ninclude_dirs = [\"shared\"]\n");
    fixture.write("rules/main.yar", "include \"lib.yar\"\n");
    fixture.write("rules/lib.yar", &rule("near"));
    fixture.write("shared/lib.yar", &rule("far"));

    let snapshot = fixture.open();

    assert_eq!(
        edges(&snapshot),
        [("rules/main.yar", "lib.yar", Some("rules/lib.yar"))]
    );
    assert_eq!(
        plan_closure(&expect_plan(&snapshot)),
        ["rules/lib.yar", "rules/main.yar"]
    );
}

#[test]
fn include_dirs_are_searched_in_declared_order() {
    for (dirs, expected) in [
        ("[\"a\", \"b\"]", "a/lib.yar"),
        ("[\"b\", \"a\"]", "b/lib.yar"),
    ] {
        let fixture = Fixture::new();
        fixture.manifest(&format!(
            "schema = 1\nentrypoints = [\"main.yar\"]\ninclude_dirs = {dirs}\n"
        ));
        fixture.write("main.yar", "include \"lib.yar\"\n");
        fixture.write("a/lib.yar", &rule("from_a"));
        fixture.write("b/lib.yar", &rule("from_b"));

        let snapshot = fixture.open();

        assert_eq!(edges(&snapshot), [("main.yar", "lib.yar", Some(expected))]);
    }
}

#[test]
fn an_included_file_is_parsed_whatever_its_extension() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"common.inc\"\n");
    fixture.write(
        "common.inc",
        &format!("include \"more.yar\"\n{}", rule("common")),
    );
    fixture.write("more.yar", &rule("more"));

    let snapshot = fixture.open();

    // `common.inc` is not a project file, but it is a graph node with its own
    // resolved includes.
    assert_eq!(discovered(&snapshot), ["main.yar", "more.yar"]);
    assert_eq!(
        edges(&snapshot),
        [
            ("common.inc", "more.yar", Some("more.yar")),
            ("main.yar", "common.inc", Some("common.inc")),
        ]
    );
    // `more.yar` is discovered but included, so it is not an inferred root.
    assert_eq!(entrypoints(&snapshot), ["main.yar"]);
    assert_eq!(
        plan_closure(&expect_plan(&snapshot)),
        ["common.inc", "main.yar", "more.yar"]
    );
}

#[test]
fn a_missing_include_is_an_unresolved_edge_and_a_blocking_issue() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\ninclude_dirs = [\".\", \"extra\"]\n");
    fixture.dir("extra");
    fixture.write("main.yar", "include \"nowhere.yar\"\n");

    let snapshot = fixture.open();

    assert_eq!(edges(&snapshot), [("main.yar", "nowhere.yar", None)]);
    assert_eq!(codes_at(&snapshot, "main.yar"), ["missing-include"]);

    let searched = match &snapshot.issues()[0].kind {
        IssueKind::MissingInclude {
            include, searched, ..
        } => {
            assert_eq!(include, "nowhere.yar");
            searched.clone()
        }
        other => panic!("unexpected issue kind: {other:?}"),
    };
    // The including file's directory is also `.`, so it is searched once, then
    // `extra`: candidates are bounded by the configuration, not enumerated.
    assert_eq!(searched.len(), 2);
    assert!(
        searched[1].ends_with("extra/nowhere.yar"),
        "searched: {searched:?}"
    );

    assert_eq!(expect_rejection(&snapshot).codes(), ["missing-include"]);
}

#[test]
fn the_same_file_reached_by_different_spellings_is_one_node() {
    let fixture = Fixture::new();
    fixture.write(
        "main.yar",
        "include \"./sub/../lib.yar\"\ninclude \"lib.yar\"\n",
    );
    fixture.write("lib.yar", &rule("lib"));
    fixture.dir("sub");

    let snapshot = fixture.open();

    assert_eq!(
        edges(&snapshot),
        [
            ("main.yar", "./sub/../lib.yar", Some("lib.yar")),
            ("main.yar", "lib.yar", Some("lib.yar")),
        ]
    );
    assert_eq!(snapshot.nodes().count(), 2);
}

// --- Symlinks --------------------------------------------------------------

#[cfg(unix)]
#[test]
fn directory_symlinks_are_not_followed() {
    let fixture = Fixture::new();
    fixture.write("real/inside.yar", &rule("inside"));
    fixture.symlink("real", "alias");
    // A link back to the project root would make a naive walk run forever.
    fixture.symlink("..", "loop");

    let snapshot = fixture.open();

    assert_eq!(discovered(&snapshot), ["real/inside.yar"]);
    assert_eq!(codes(&snapshot), Vec::<&str>::new());
}

#[cfg(unix)]
#[test]
fn two_symlinked_spellings_of_one_file_are_a_single_node() {
    let fixture = Fixture::new();
    fixture.write("real.yar", &rule("real"));
    fixture.symlink("real.yar", "alias.yar");

    let snapshot = fixture.open();

    // Identity follows the canonical target, so the alias is not a second file.
    assert_eq!(discovered(&snapshot), ["real.yar"]);
    assert_eq!(snapshot.nodes().count(), 1);
    assert_eq!(plan_closure(&expect_plan(&snapshot)), ["real.yar"]);
}

#[cfg(unix)]
#[test]
fn a_symlink_to_a_file_outside_the_project_is_an_external_source() {
    let fixture = Fixture::new();
    fixture.write_outside("shared/target.yar", &rule("target"));
    fixture.symlink("../shared/target.yar", "alias.yar");

    let snapshot = fixture.open();

    // The identity of a discovered file always follows its canonical path, so a
    // link out of the project yields an external source that is still a project
    // file for root inference.
    assert_eq!(snapshot.discovered().len(), 1);
    assert!(snapshot.discovered()[0].external);
    assert!(snapshot.discovered()[0].path.ends_with("shared/target.yar"));
    assert_eq!(entrypoints(&snapshot), discovered(&snapshot));
    assert_eq!(codes(&snapshot), ["external-dependency"]);
    assert!(!expect_plan(&snapshot).is_empty());
}

// --- Failing closed on discovery errors ------------------------------------

#[cfg(unix)]
#[test]
fn a_rule_file_that_cannot_be_resolved_blocks_every_plan() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));
    // A dangling link is the one entry-level I/O failure a test can arrange
    // portably: it looks like a rule file, and resolving it fails.
    fixture.symlink("gone.yar", "alias.yar");

    let snapshot = fixture.open();

    // It is not a project file, because it could not be resolved to one ...
    assert_eq!(discovered(&snapshot), ["main.yar"]);
    // ... but it is reported rather than dropped, and the report is
    // project-scoped, so the otherwise-valid `main.yar` plan is still rejected.
    // A source-scoped report would name a file that is in no closure and would
    // therefore block nothing.
    let issue = snapshot
        .issues()
        .iter()
        .find(|i| i.code() == "unreadable-entry")
        .expect("the unresolvable entry is reported");
    assert_eq!(issue.scope(), IssueScope::Project);
    assert!(issue.at.is_none());
    match &issue.kind {
        IssueKind::UnreadableEntry { path, error } => {
            assert_eq!(path, "alias.yar");
            assert!(!error.is_empty());
        }
        other => panic!("unexpected issue kind: {other:?}"),
    }
    assert_eq!(expect_rejection(&snapshot).codes(), ["unreadable-entry"]);
}

#[test]
fn an_entry_that_cannot_be_inspected_is_reported_project_scoped() {
    // The remaining per-entry failures - `read_dir` yielding an `Err`, and
    // `DirEntry::file_type()` failing - need an operating system that produces
    // them. Neither can be provoked portably without permission games or a
    // filesystem race, so the mapping from such a failure to an issue is
    // asserted directly instead.
    let error = || std::io::Error::other("simulated");

    let (name, err) = super::discovery::classify(Err(error())).expect_err("a failed entry");
    assert!(name.is_none(), "an iterator failure has no name");
    let anonymous = super::discovery::entry_issue("nested", name.as_deref(), &err);
    assert_eq!(anonymous.code(), "unreadable-directory");
    assert_eq!(anonymous.scope(), IssueScope::Project);
    assert!(anonymous.is_blocking());
    assert!(anonymous.at.is_none());

    let named = super::discovery::entry_issue("nested", Some(OsStr::new("mystery.yar")), &error());
    assert_eq!(named.code(), "unreadable-entry");
    assert_eq!(named.scope(), IssueScope::Project);
    assert!(named.is_blocking());
    match &named.kind {
        // Named as precisely as the error allows: prefix plus entry name.
        IssueKind::UnreadableEntry { path, .. } => assert_eq!(path, "nested/mystery.yar"),
        other => panic!("unexpected issue kind: {other:?}"),
    }
}

// --- Non-Unicode paths -----------------------------------------------------

#[cfg(unix)]
#[test]
fn a_non_unicode_path_has_no_identity_but_still_has_a_display_form() {
    let one = PathBuf::from(non_unicode(b"a\xff.yar"));
    let two = PathBuf::from(non_unicode(b"a\xfe.yar"));

    assert_eq!(super::paths::to_slash(&one), None);
    assert_eq!(super::paths::to_slash(&two), None);
    // A lossy conversion would make these two equal, which is exactly why there
    // is no identity. The escaped forms differ and are for display only.
    assert_ne!(super::paths::escaped(&one), super::paths::escaped(&two));
    assert_eq!(
        super::paths::to_slash(Path::new("sub/a.yar")).as_deref(),
        Some("sub/a.yar")
    );
}

#[cfg(unix)]
#[test]
fn a_non_unicode_rule_filename_is_reported_and_left_out_of_the_project() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));
    fixture.write_raw(non_unicode(b"bad\xffname.yar"), &rule("bad"));
    // Not a rule file, so its name never had to be represented at all.
    fixture.write_raw(non_unicode(b"bad\xffname.txt"), "notes\n");

    let snapshot = fixture.open();

    assert_eq!(discovered(&snapshot), ["main.yar"]);
    assert_eq!(codes(&snapshot), ["non-unicode-path"]);
    match &snapshot.issues()[0].kind {
        IssueKind::NonUnicodePath { path } => {
            assert!(path.contains("name.yar"), "escaped path: {path}");
            assert!(!path.contains(".txt"), "escaped path: {path}");
        }
        other => panic!("unexpected issue kind: {other:?}"),
    }
    // Excluding it from the graph is only safe because the exclusion blocks the
    // plan: a rule file the project cannot name may be its only entrypoint.
    assert_eq!(expect_rejection(&snapshot).codes(), ["non-unicode-path"]);
}

#[cfg(unix)]
#[test]
fn a_non_unicode_directory_name_is_reported_because_it_cannot_be_walked() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));
    let nested = fixture.root.join(non_unicode(b"sub\xff"));
    std::fs::create_dir(&nested).expect("create dir");
    write_at(&nested.join("buried.yar"), &rule("buried"));

    let snapshot = fixture.open();

    // Its contents cannot be given identities either, so not descending is
    // incomplete discovery and has to be reported.
    assert_eq!(discovered(&snapshot), ["main.yar"]);
    assert_eq!(codes(&snapshot), ["non-unicode-path"]);
    assert_eq!(expect_rejection(&snapshot).codes(), ["non-unicode-path"]);
}

#[cfg(unix)]
#[test]
fn two_non_unicode_filenames_do_not_collapse_into_one_identity() {
    let fixture = Fixture::new();
    fixture.write_raw(non_unicode(b"a\xff.yar"), &rule("one"));
    fixture.write_raw(non_unicode(b"a\xfe.yar"), &rule("two"));

    let snapshot = fixture.open();

    // Lossy conversion would give both files the identity `a<U+FFFD>.yar`,
    // silently merging two different files into one graph node.
    assert!(snapshot.discovered().is_empty());
    assert_eq!(snapshot.nodes().count(), 0);
    let reported: Vec<&str> = snapshot
        .issues()
        .iter()
        .map(|issue| match &issue.kind {
            IssueKind::NonUnicodePath { path } => path.as_str(),
            other => panic!("unexpected issue kind: {other:?}"),
        })
        .collect();
    assert_eq!(reported.len(), 2, "reported: {reported:?}");
    assert_ne!(reported[0], reported[1]);
}

// --- External dependencies -------------------------------------------------

#[test]
fn external_includes_and_their_dependencies_are_marked_external() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", "include \"deep.yar\"\n");
    fixture.write_outside("shared/deep.yar", &rule("deep"));

    let snapshot = fixture.open();

    let external: Vec<&str> = snapshot
        .nodes()
        .filter(|node| node.id.external)
        .map(|node| node.id.path.as_str())
        .collect();
    assert_eq!(external.len(), 2, "external nodes: {external:?}");
    assert!(external.iter().all(|path| path.ends_with(".yar")));
    assert!(external[0].ends_with("shared/deep.yar"));
    assert!(external[1].ends_with("shared/ext.yar"));

    // External dependencies are informational, so the project still compiles.
    assert_eq!(
        codes(&snapshot),
        ["external-dependency", "external-dependency"]
    );
    assert!(snapshot.blocking_issues().next().is_none());

    let plan = expect_plan(&snapshot);
    assert_eq!(plan_entrypoints(&plan), ["main.yar"]);
    // Identities sort internal before external, so `main.yar` comes first.
    assert_eq!(plan.closure().len(), 3);
    assert_eq!(plan_closure(&plan)[0], "main.yar");
}

#[test]
fn an_include_dir_outside_the_project_is_supported() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\ninclude_dirs = [\".\", \"../shared\"]\n");
    fixture.write("main.yar", "include \"ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let snapshot = fixture.open();

    assert_eq!(snapshot.definition().include_dirs()[1].spec(), "../shared");
    let edge = &snapshot.edges()[0];
    assert!(edge.to.as_ref().is_some_and(|to| to.external));
    assert!(expect_plan(&snapshot).include_dirs()[1].ends_with("shared"));
}

// --- Cycles ----------------------------------------------------------------

#[test]
fn a_self_include_is_a_cycle() {
    let fixture = Fixture::new();
    fixture.write("loop.yar", "include \"loop.yar\"\n");

    let snapshot = fixture.open();

    let cycle = snapshot
        .issues()
        .iter()
        .find(|i| i.code() == "include-cycle")
        .unwrap();
    match &cycle.kind {
        IssueKind::IncludeCycle {
            members, include, ..
        } => {
            assert_eq!(paths_of(members), ["loop.yar"]);
            assert_eq!(include, "loop.yar");
        }
        other => panic!("unexpected issue kind: {other:?}"),
    }

    // The file includes itself, so nothing is a root and the only project file
    // is unreachable. The plan is rejected for that project-scoped reason; the
    // cycle behind it is source-scoped and visible in the snapshot.
    assert_eq!(entrypoints(&snapshot), Vec::<&str>::new());
    assert_eq!(
        codes_at(&snapshot, "loop.yar"),
        ["include-cycle", "unreachable-source"]
    );
    assert_eq!(expect_rejection(&snapshot).codes(), ["unreachable-source"]);
}

#[test]
fn a_two_file_cycle_below_a_root_is_reported() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"a.yar\"\n");
    fixture.write("a.yar", "include \"b.yar\"\n");
    fixture.write("b.yar", "include \"a.yar\"\n");

    let snapshot = fixture.open();

    assert_eq!(entrypoints(&snapshot), ["main.yar"]);
    let cycles: Vec<&ProjectIssue> = snapshot
        .issues()
        .iter()
        .filter(|i| i.code() == "include-cycle")
        .collect();
    assert_eq!(cycles.len(), 1);
    match &cycles[0].kind {
        IssueKind::IncludeCycle {
            members, include, ..
        } => {
            assert_eq!(paths_of(members), ["a.yar", "b.yar"]);
            assert_eq!(include, "a.yar");
        }
        other => panic!("unexpected issue kind: {other:?}"),
    }
    // A cycle makes expansion counting meaningless, so it is not also reported
    // as repeated inclusion.
    assert_eq!(expect_rejection(&snapshot).codes(), ["include-cycle"]);
}

#[test]
fn a_multi_file_cycle_is_reported_once_from_its_lowest_member() {
    let fixture = Fixture::new();
    fixture.write("b.yar", "include \"c.yar\"\n");
    fixture.write("c.yar", "include \"a.yar\"\n");
    fixture.write("a.yar", "include \"b.yar\"\n");

    let snapshot = fixture.open();

    let cycles: Vec<&ProjectIssue> = snapshot
        .issues()
        .iter()
        .filter(|i| i.code() == "include-cycle")
        .collect();
    assert_eq!(cycles.len(), 1);
    match &cycles[0].kind {
        IssueKind::IncludeCycle { members, .. } => {
            assert_eq!(paths_of(members), ["a.yar", "b.yar", "c.yar"]);
        }
        other => panic!("unexpected issue kind: {other:?}"),
    }
}

#[test]
fn an_inferred_project_reports_a_disconnected_rootless_cycle() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));
    fixture.write("a.yar", "include \"b.yar\"\n");
    fixture.write("b.yar", "include \"a.yar\"\n");

    let snapshot = fixture.open();

    // Nothing includes `main.yar`; the cycle has no root at all.
    assert_eq!(entrypoints(&snapshot), ["main.yar"]);
    assert_eq!(codes_at(&snapshot, "a.yar"), ["unreachable-source"]);
    assert_eq!(
        codes_at(&snapshot, "b.yar"),
        ["include-cycle", "unreachable-source"]
    );

    // Unreachable sources are project-scoped: an inferred project that cannot
    // account for one of its own files is invalid, even though the cycle itself
    // is outside `main.yar`'s closure.
    let rejection = expect_rejection(&snapshot);
    assert_eq!(
        rejection.codes(),
        ["unreachable-source", "unreachable-source"]
    );
}

// --- Repeated inclusion ----------------------------------------------------

#[test]
fn a_diamond_reports_the_shared_leaf_as_repeated() {
    let fixture = Fixture::new();
    fixture.write("a.yar", "include \"b.yar\"\ninclude \"c.yar\"\n");
    fixture.write("b.yar", "include \"d.yar\"\n");
    fixture.write("c.yar", "include \"d.yar\"\n");
    fixture.write("d.yar", &rule("d"));

    let snapshot = fixture.open();

    assert_eq!(entrypoints(&snapshot), ["a.yar"]);
    assert_eq!(codes(&snapshot), ["repeated-inclusion"]);
    match &snapshot.issues()[0].kind {
        IssueKind::RepeatedInclusion {
            expansions_at_least,
        } => {
            assert_eq!(*expansions_at_least, 2);
        }
        other => panic!("unexpected issue kind: {other:?}"),
    }
    assert_eq!(snapshot.issues()[0].at.as_ref().unwrap().path, "d.yar");
    assert_eq!(expect_rejection(&snapshot).codes(), ["repeated-inclusion"]);
}

#[test]
fn two_roots_sharing_a_dependency_report_it_as_repeated() {
    let fixture = Fixture::new();
    fixture.write("one.yar", "include \"shared.yar\"\n");
    fixture.write("two.yar", "include \"shared.yar\"\n");
    fixture.write("shared.yar", &rule("shared"));

    let snapshot = fixture.open();

    assert_eq!(entrypoints(&snapshot), ["one.yar", "two.yar"]);
    assert_eq!(codes_at(&snapshot, "shared.yar"), ["repeated-inclusion"]);
    assert_eq!(expect_rejection(&snapshot).codes(), ["repeated-inclusion"]);
}

#[test]
fn including_the_same_file_twice_from_one_source_is_repeated() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"lib.yar\"\ninclude \"lib.yar\"\n");
    fixture.write("lib.yar", &rule("lib"));

    let snapshot = fixture.open();

    assert_eq!(
        edges(&snapshot),
        [
            ("main.yar", "lib.yar", Some("lib.yar")),
            ("main.yar", "lib.yar", Some("lib.yar")),
        ]
    );
    assert_eq!(snapshot.edges()[0].order, 0);
    assert_eq!(snapshot.edges()[1].order, 1);
    assert_eq!(codes_at(&snapshot, "lib.yar"), ["repeated-inclusion"]);
}

#[test]
fn a_dependency_of_a_repeated_parent_is_itself_repeated() {
    let fixture = Fixture::new();
    fixture.write("root.yar", "include \"x.yar\"\ninclude \"y.yar\"\n");
    fixture.write("x.yar", "include \"p.yar\"\n");
    fixture.write("y.yar", "include \"p.yar\"\n");
    fixture.write("p.yar", "include \"leaf.yar\"\n");
    fixture.write("leaf.yar", &rule("leaf"));

    let snapshot = fixture.open();

    // `leaf.yar` has indegree one, but its only parent is expanded twice.
    assert_eq!(codes_at(&snapshot, "leaf.yar"), ["repeated-inclusion"]);
    assert_eq!(codes_at(&snapshot, "p.yar"), ["repeated-inclusion"]);
    assert_eq!(codes_at(&snapshot, "x.yar"), Vec::<&str>::new());
}

#[test]
fn multiple_independent_roots_are_valid() {
    let fixture = Fixture::new();
    fixture.write("alpha.yar", "include \"alpha_lib.yar\"\n");
    fixture.write("alpha_lib.yar", &rule("alpha_lib"));
    fixture.write("beta.yar", &rule("beta"));
    fixture.write("nested/gamma.yar", "include \"gamma_lib.yar\"\n");
    fixture.write("nested/gamma_lib.yar", &rule("gamma_lib"));

    let snapshot = fixture.open();

    assert_eq!(codes(&snapshot), Vec::<&str>::new());
    let plan = expect_plan(&snapshot);
    assert_eq!(
        plan_entrypoints(&plan),
        ["alpha.yar", "beta.yar", "nested/gamma.yar"]
    );
    assert_eq!(
        plan_closure(&plan),
        [
            "alpha.yar",
            "alpha_lib.yar",
            "beta.yar",
            "nested/gamma.yar",
            "nested/gamma_lib.yar"
        ]
    );
    assert!(!plan.is_empty());
    assert_eq!(plan.entrypoint_origin(), EntrypointOrigin::Inferred);
    assert_eq!(plan.root(), snapshot.definition().root());
}

// --- Declared entrypoints --------------------------------------------------

#[test]
fn declared_entrypoints_keep_manifest_order() {
    let fixture = Fixture::new();
    fixture.manifest(
        "schema = 1\nentrypoints = [\"second.yar\", \"first.yar\", \"./nested/third.yar\"]\n",
    );
    fixture.write("first.yar", &rule("first"));
    fixture.write("second.yar", &rule("second"));
    fixture.write("nested/third.yar", &rule("third"));

    let snapshot = fixture.open();

    assert_eq!(snapshot.entrypoint_origin(), EntrypointOrigin::Declared);
    assert_eq!(
        snapshot.definition().declared_entrypoints(),
        ["second.yar", "first.yar", "nested/third.yar"]
    );
    assert_eq!(
        entrypoints(&snapshot),
        ["second.yar", "first.yar", "nested/third.yar"]
    );

    let plan = expect_plan(&snapshot);
    // Entrypoints keep declared order; the closure is sorted by identity.
    assert_eq!(
        plan_entrypoints(&plan),
        ["second.yar", "first.yar", "nested/third.yar"]
    );
    assert_eq!(
        plan_closure(&plan),
        ["first.yar", "nested/third.yar", "second.yar"]
    );
    assert_eq!(plan.entrypoint_origin(), EntrypointOrigin::Declared);
}

#[test]
fn declared_entrypoints_leave_unrelated_files_out_of_the_plan() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentrypoints = [\"main.yar\"]\n");
    fixture.write("main.yar", "include \"lib.yar\"\n");
    fixture.write("lib.yar", &rule("lib"));
    fixture.write("scratch.yar", &rule("scratch"));

    let snapshot = fixture.open();

    // The unrelated file is still part of the snapshot ...
    assert_eq!(
        discovered(&snapshot),
        ["lib.yar", "main.yar", "scratch.yar"]
    );
    // ... and, unlike an inferred project, it is not treated as a root.
    assert_eq!(entrypoints(&snapshot), ["main.yar"]);
    assert_eq!(
        plan_closure(&expect_plan(&snapshot)),
        ["lib.yar", "main.yar"]
    );
}

#[test]
fn problems_in_unrelated_files_do_not_block_an_explicit_plan() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentrypoints = [\"main.yar\"]\n");
    fixture.write("main.yar", "include \"lib.yar\"\n");
    fixture.write("lib.yar", &rule("lib"));
    fixture.write("broken.yar", "include \"nowhere.yar\"\nrule oops { \n");

    let snapshot = fixture.open();

    // Both problems are visible in the snapshot for a future Includes view.
    assert_eq!(
        codes_at(&snapshot, "broken.yar"),
        ["parser-error", "missing-include"]
    );
    assert!(snapshot.blocking_issues().count() >= 2);

    // But they are source-scoped and outside the selected closure.
    let plan = expect_plan(&snapshot);
    assert_eq!(plan_closure(&plan), ["lib.yar", "main.yar"]);
}

#[test]
fn a_declared_entrypoint_that_is_missing_on_disk_blocks_the_plan() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentrypoints = [\"main.yar\", \"gone.yar\"]\n");
    fixture.write("main.yar", &rule("main"));

    let snapshot = fixture.open();

    assert_eq!(codes(&snapshot), ["invalid-configuration"]);
    assert_eq!(snapshot.issues()[0].scope(), IssueScope::Project);
    assert_eq!(entrypoints(&snapshot), ["main.yar"]);
    assert_eq!(
        expect_rejection(&snapshot).codes(),
        ["invalid-configuration"]
    );
}

#[cfg(unix)]
#[test]
fn a_declared_entrypoint_may_not_escape_the_project_through_a_symlink() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentrypoints = [\"link.yar\"]\n");
    fixture.write_outside("shared/outside.yar", &rule("outside"));
    fixture.symlink("../shared/outside.yar", "link.yar");

    let snapshot = fixture.open();

    // The declaration is lexically inside the root, so only the canonical target
    // reveals the escape. Without that check the manifest's contract - that an
    // entrypoint is a file of *this* project - would be silently broken.
    assert_eq!(entrypoints(&snapshot), Vec::<&str>::new());
    assert!(
        snapshot.entrypoints().iter().all(|id| !id.external),
        "no declared entrypoint may be external"
    );
    let invalid = snapshot
        .issues()
        .iter()
        .find(|i| i.code() == "invalid-configuration")
        .expect("the escape is reported");
    assert_eq!(invalid.scope(), IssueScope::Project);
    assert!(invalid.message().contains("outside the project root"));
    assert!(
        expect_rejection(&snapshot)
            .codes()
            .contains(&"invalid-configuration")
    );
}

#[cfg(unix)]
#[test]
fn a_declared_entrypoint_may_be_a_symlink_within_the_project() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentrypoints = [\"link.yar\"]\n");
    fixture.write("real.yar", &rule("real"));
    fixture.symlink("real.yar", "link.yar");

    let snapshot = fixture.open();

    // The escape check is on the canonical target, not on the entry being a
    // symlink, so an in-project alias still resolves - to the identity of the
    // file the compiler will actually read.
    assert_eq!(entrypoints(&snapshot), ["real.yar"]);
    assert_eq!(codes(&snapshot), Vec::<&str>::new());
    assert_eq!(plan_closure(&expect_plan(&snapshot)), ["real.yar"]);
}

// --- Exclusions ------------------------------------------------------------

#[test]
fn exclusions_affect_discovery_but_not_a_reachable_include() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentrypoints = [\"main.yar\"]\nexclude = [\"vendor/**\"]\n");
    fixture.write("main.yar", "include \"vendor/lib.yar\"\n");
    fixture.write("vendor/lib.yar", &rule("vendor_lib"));
    fixture.write("vendor/unused.yar", "rule broken { \n");

    let snapshot = fixture.open();

    // Neither excluded file is a project file ...
    assert_eq!(discovered(&snapshot), ["main.yar"]);
    // ... and the unreferenced one is never even parsed, so its syntax error is
    // not reported.
    assert_eq!(codes(&snapshot), Vec::<&str>::new());
    // But the one an entrypoint reaches is still resolved and compiled.
    assert_eq!(
        edges(&snapshot),
        [("main.yar", "vendor/lib.yar", Some("vendor/lib.yar"))]
    );
    assert_eq!(
        plan_closure(&expect_plan(&snapshot)),
        ["main.yar", "vendor/lib.yar"]
    );
}

#[test]
fn exclusions_apply_to_inferred_entrypoints() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nexclude = [\"tests/**\", \"*.tmp.yar\"]\n");
    fixture.write("main.yar", &rule("main"));
    fixture.write("scratch.tmp.yar", &rule("scratch"));
    fixture.write("tests/case.yar", &rule("case"));
    fixture.write("nested/keep.yar", &rule("keep"));

    let snapshot = fixture.open();

    assert_eq!(discovered(&snapshot), ["main.yar", "nested/keep.yar"]);
    assert_eq!(entrypoints(&snapshot), ["main.yar", "nested/keep.yar"]);
    // `literal_separator` is on, so `*.tmp.yar` does not cross a directory
    // boundary: a nested file with the same name would still be discovered.
    assert!(snapshot.definition().is_excluded("scratch.tmp.yar"));
    assert!(!snapshot.definition().is_excluded("nested/scratch.tmp.yar"));
}

// --- Manifest validation ---------------------------------------------------

#[test]
fn an_unsupported_schema_is_reported_as_such() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 2\nunknown_future_key = true\n");

    let error = fixture.open_err();

    assert_eq!(error.code(), "manifest-unsupported-schema");
    assert_eq!(
        error,
        ConfigError::UnsupportedSchema {
            found: 2,
            supported: super::manifest::SCHEMA_VERSION
        }
    );
    assert_eq!(error.as_issue().code(), "invalid-configuration");
    assert!(error.as_issue().is_blocking());
}

#[test]
fn a_manifest_that_is_not_valid_toml_is_reported() {
    let fixture = Fixture::new();
    fixture.manifest("schema = = 1\n");

    assert_eq!(fixture.open_err().code(), "manifest-invalid");
}

#[test]
fn a_manifest_without_a_schema_is_rejected() {
    let fixture = Fixture::new();
    fixture.manifest("entrypoints = [\"main.yar\"]\n");

    assert_eq!(fixture.open_err().code(), "manifest-invalid");
}

#[test]
fn unknown_manifest_keys_are_rejected() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentry_points = [\"main.yar\"]\n");

    assert_eq!(fixture.open_err().code(), "manifest-invalid");
}

#[test]
fn invalid_entrypoint_declarations_are_rejected() {
    let cases = [
        ("entrypoints = [\"\"]", "entrypoint-invalid-path"),
        (
            "entrypoints = [\"/abs/main.yar\"]",
            "entrypoint-invalid-path",
        ),
        (
            "entrypoints = [\"../outside.yar\"]",
            "entrypoint-invalid-path",
        ),
        (
            "entrypoints = [\"sub\\\\main.yar\"]",
            "entrypoint-invalid-path",
        ),
        ("entrypoints = [\"notes.txt\"]", "entrypoint-invalid-path"),
        (
            "entrypoints = [\"main.yar\", \"./main.yar\"]",
            "entrypoint-duplicate",
        ),
        (
            "entrypoints = [\"skip/main.yar\"]\nexclude = [\"skip/**\"]",
            "entrypoint-excluded",
        ),
    ];
    for (body, expected) in cases {
        let fixture = Fixture::new();
        fixture.manifest(&format!("schema = 1\n{body}\n"));
        fixture.write("main.yar", &rule("main"));
        fixture.write("skip/main.yar", &rule("skipped"));

        let error = fixture.open_err();
        assert_eq!(error.code(), expected, "for manifest body: {body}");
    }
}

#[test]
fn invalid_include_dir_declarations_are_rejected() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\ninclude_dirs = [\"gone\"]\n");
    assert_eq!(fixture.open_err().code(), "include-dir-unavailable");

    let fixture = Fixture::new();
    fixture.manifest("schema = 1\ninclude_dirs = [\"/absolute\"]\n");
    assert_eq!(fixture.open_err().code(), "include-dir-invalid-path");

    let fixture = Fixture::new();
    fixture.manifest("schema = 1\ninclude_dirs = [\"main.yar\"]\n");
    fixture.write("main.yar", &rule("main"));
    assert_eq!(fixture.open_err().code(), "include-dir-not-a-directory");
}

#[test]
fn an_invalid_exclude_glob_is_rejected() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nexclude = [\"vendor/[\"]\n");

    assert_eq!(fixture.open_err().code(), "exclude-invalid-pattern");
}

#[test]
fn a_project_root_that_is_not_a_directory_is_rejected() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let error = open_project(&fixture.root.join("main.yar")).expect_err("not a directory");

    assert_eq!(error.code(), "root-not-a-directory");
}

// --- Parser errors ---------------------------------------------------------

#[test]
fn parser_errors_are_reported_and_recovered_includes_still_resolve() {
    let fixture = Fixture::new();
    fixture.write(
        "main.yar",
        "include \"lib.yar\"\nrule broken { condition: }\n",
    );
    fixture.write("lib.yar", &rule("lib"));

    let snapshot = fixture.open();

    // The include before the broken rule is still collected ...
    assert_eq!(edges(&snapshot), [("main.yar", "lib.yar", Some("lib.yar"))]);
    // ... and the error is structured, with a span, not a scraped string.
    let parser_errors: Vec<&ProjectIssue> = snapshot
        .issues()
        .iter()
        .filter(|i| i.code() == "parser-error")
        .collect();
    assert!(!parser_errors.is_empty());
    match &parser_errors[0].kind {
        IssueKind::ParserError { message, span } => {
            assert!(!message.is_empty());
            assert!(span.end >= span.start);
        }
        other => panic!("unexpected issue kind: {other:?}"),
    }
    // A parser error in the closure blocks compilation.
    assert!(
        expect_rejection(&snapshot)
            .codes()
            .contains(&"parser-error")
    );
}

#[test]
fn a_source_that_is_not_valid_utf8_is_a_parser_error() {
    let fixture = Fixture::new();
    std::fs::write(fixture.root.join("bad.yar"), [0xff, 0xfe, b'\n']).expect("write bytes");

    let snapshot = fixture.open();

    assert_eq!(codes_at(&snapshot, "bad.yar"), ["parser-error"]);
    assert!(
        snapshot
            .node(&SourceId {
                external: false,
                path: "bad.yar".into()
            })
            .is_some()
    );
}

// --- Determinism -----------------------------------------------------------

#[test]
fn repeated_analyses_of_one_project_are_identical() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\ninclude_dirs = [\".\", \"shared\"]\n");
    fixture.write("z.yar", "include \"common.yar\"\ninclude \"missing.yar\"\n");
    fixture.write("a.yar", "include \"nested/deep.yar\"\n");
    fixture.write("nested/deep.yar", "include \"common.yar\"\n");
    fixture.write("shared/common.yar", &rule("common"));
    fixture.write("m.yar", "rule unfinished { \n");
    fixture.write_outside("outside/ext.yar", &rule("ext"));
    fixture.write("e.yar", "include \"../outside/ext.yar\"\n");

    let first = fixture.open();
    let second = fixture.open();

    assert_eq!(discovered(&first), discovered(&second));
    assert_eq!(entrypoints(&first), entrypoints(&second));
    assert_eq!(edges(&first), edges(&second));
    assert_eq!(codes(&first), codes(&second));
    let messages =
        |s: &ProjectSnapshot| -> Vec<String> { s.issues().iter().map(|i| i.message()).collect() };
    assert_eq!(messages(&first), messages(&second));

    // Both analyses reject the plan for the same reasons, in the same order.
    assert_eq!(
        expect_rejection(&first).codes(),
        expect_rejection(&second).codes()
    );
    assert!(
        expect_rejection(&first)
            .codes()
            .contains(&"missing-include")
    );

    // Discovery order does not depend on the filesystem: identities are sorted.
    let mut sorted = discovered(&first);
    sorted.sort_unstable();
    assert_eq!(discovered(&first), sorted);
}
