//! Tests for the compilation pipeline.
//!
//! These assert *compilation outcomes*, not internals. Where the question is
//! which of two same-named files was chosen, both carry a differently named rule,
//! so the built ruleset's rule identifiers answer it: nothing about how
//! resolution is arranged has to be inspected, which is what keeps these tests
//! honest if the mechanism ever changes.
//!
//! A few tests set the process working directory, because the fallback they exist
//! to rule out is defined in terms of it. Those go through
//! [`crate::testing::with_cwd`], which serializes them and restores the previous
//! directory.

use crate::commands::Diagnostic;
use crate::testing::{Fixture, rule, with_cwd};

use super::*;

/// Rule identifiers in the built ruleset, sorted so the assertion does not depend
/// on compilation order (which the ordering tests check separately).
fn rule_names(compiled: &Compiled) -> Vec<String> {
    let rules = compiled.rules.as_ref().unwrap_or_else(|| {
        panic!(
            "expected a successful compilation, got: {}",
            summary(compiled)
        )
    });
    let mut names: Vec<String> = rules.iter().map(|r| r.identifier().to_string()).collect();
    names.sort();
    names
}

/// Diagnostic codes in reported order.
fn codes(compiled: &Compiled) -> Vec<&str> {
    compiled
        .diagnostics
        .iter()
        .map(|d| d.code.as_str())
        .collect()
}

/// Diagnostics as one line, for panic messages only.
fn summary(compiled: &Compiled) -> String {
    if compiled.diagnostics.is_empty() {
        return "no diagnostics".to_string();
    }
    compiled
        .diagnostics
        .iter()
        .map(|d| format!("{}: {}", d.code, d.title))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Asserts the compilation failed with exactly one diagnostic, and returns it.
fn expect_failure(compiled: &Compiled) -> &Diagnostic {
    assert!(
        compiled.rules.is_none(),
        "expected no rules, got {}",
        compiled.rule_count
    );
    assert_eq!(compiled.rule_count, 0);
    assert_eq!(
        compiled.diagnostics.len(),
        1,
        "expected one diagnostic, got: {}",
        summary(compiled)
    );
    &compiled.diagnostics[0]
}

// --- The scratch buffer ----------------------------------------------------

#[test]
fn a_scratch_buffer_compiles_to_rules() {
    let compiled = scratch(&format!("{}{}", rule("first"), rule("second")));

    assert_eq!(rule_names(&compiled), ["first", "second"]);
    assert_eq!(compiled.rule_count, 2);
    assert!(compiled.diagnostics.is_empty(), "{}", summary(&compiled));
}

#[test]
fn an_empty_scratch_buffer_is_a_successful_zero_rule_compilation() {
    let compiled = scratch("");

    assert!(compiled.rules.is_some());
    assert_eq!(compiled.rule_count, 0);
    assert!(compiled.diagnostics.is_empty(), "{}", summary(&compiled));
}

#[test]
fn a_scratch_error_names_no_file_so_it_stays_on_the_active_editor() {
    let compiled = scratch("rule broken { condition: }\n");

    assert!(compiled.rules.is_none());
    assert!(!compiled.diagnostics.is_empty());
    // The buffer has no path, so there is nothing for the frontend to open: the
    // diagnostic belongs to whatever is in the editor.
    assert!(
        compiled.diagnostics.iter().all(|d| d.file.is_none()),
        "{}",
        summary(&compiled)
    );
}

// --- No current-directory fallback -----------------------------------------

#[test]
fn a_scratch_include_cannot_reach_the_launch_directory() {
    let launch = Fixture::new();
    launch.write("decoy.yar", &rule("from_cwd"));
    let source = "include \"decoy.yar\"\n";

    let (unsealed, sealed) = with_cwd(&launch.root, || {
        // First, pin the hazard this seal exists for: given no include directory
        // list at all, YARA-X resolves an include against the process working
        // directory.
        let mut bare = Compiler::new();
        let _ = bare.add_source(SourceCode::from(source));
        let unsealed = finish(bare, &Origins::default());

        (unsealed, scratch(source))
    });

    assert_eq!(
        rule_names(&unsealed),
        ["from_cwd"],
        "yara-x is expected to fall back to the working directory when its \
         include directory list is unset; if it no longer does, the seal below \
         has become redundant rather than wrong"
    );

    // And that is exactly what a scratch buffer must not do: it has no project,
    // so an include in it has no legitimate directory to resolve from.
    assert!(sealed.rules.is_none(), "{}", summary(&sealed));
    assert_eq!(codes(&sealed), ["E043"]);
}

#[test]
fn a_project_never_resolves_an_include_from_the_launch_directory() {
    let launch = Fixture::new();
    launch.write("lib.yar", &rule("from_cwd"));

    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentrypoints = [\"main.yar\"]\ninclude_dirs = []\n");
    fixture.write("main.yar", "include \"lib.yar\"\n");

    let compiled = with_cwd(&launch.root, || project(&fixture.root));

    // Nothing beside the entrypoint and no include directories, so the model
    // reports the include as missing - and compilation is refused rather than
    // quietly picking up the file of the same name in the directory Quipu
    // happens to have been launched from.
    assert_eq!(expect_failure(&compiled).code, "missing-include");
}

#[test]
fn an_explicitly_empty_include_dir_list_still_resolves_an_entrypoints_sibling() {
    let launch = Fixture::new();
    launch.write("lib.yar", &rule("from_cwd"));

    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentrypoints = [\"rules/main.yar\"]\ninclude_dirs = []\n");
    fixture.write("rules/main.yar", "include \"lib.yar\"\n");
    fixture.write("rules/lib.yar", &rule("from_parent"));

    let compiled = with_cwd(&launch.root, || project(&fixture.root));

    // `include_dirs = []` seals the fallback without disabling the one rule that
    // does not come from the configuration: an entrypoint's own directory.
    assert_eq!(rule_names(&compiled), ["from_parent"]);
}

// --- Entrypoint parent-first resolution ------------------------------------

#[test]
fn a_nested_entrypoint_includes_its_sibling() {
    let fixture = Fixture::new();
    fixture.write(
        "rules/main.yar",
        &format!("include \"helper.yar\"\n{}", rule("main")),
    );
    fixture.write("rules/helper.yar", &rule("helper"));

    let compiled = project(&fixture.root);

    // The default include directory is the project root, which does not contain
    // `helper.yar`. Only the entrypoint's own parent can resolve it, and YARA-X
    // does not search that for a source it is handed directly - hence the
    // wrapper.
    assert_eq!(rule_names(&compiled), ["helper", "main"]);
    assert!(compiled.diagnostics.is_empty(), "{}", summary(&compiled));
}

#[test]
fn an_entrypoints_own_directory_wins_over_a_configured_include_dir() {
    let fixture = Fixture::new();
    fixture
        .manifest("schema = 1\nentrypoints = [\"rules/main.yar\"]\ninclude_dirs = [\"shared\"]\n");
    fixture.write("rules/main.yar", "include \"lib.yar\"\n");
    fixture.write("rules/lib.yar", &rule("from_parent"));
    fixture.write("shared/lib.yar", &rule("from_include_dir"));

    let compiled = project(&fixture.root);

    assert_eq!(rule_names(&compiled), ["from_parent"]);
}

#[test]
fn two_entrypoints_resolve_the_same_spelling_from_their_own_parents() {
    let fixture = Fixture::new();
    fixture.manifest(
        "schema = 1\nentrypoints = [\"a/main.yar\", \"b/main.yar\"]\ninclude_dirs = []\n",
    );
    fixture.write("a/main.yar", "include \"lib.yar\"\n");
    fixture.write("a/lib.yar", &rule("from_a"));
    fixture.write("b/main.yar", "include \"lib.yar\"\n");
    fixture.write("b/lib.yar", &rule("from_b"));

    let compiled = project(&fixture.root);

    // Each entrypoint's parent is searched for that entrypoint only. Prepending
    // both parents to one global list would let either resolve through the
    // other's directory, and with the same spelling on both sides the result
    // would be one file expanded twice - a duplicate-rule error.
    assert_eq!(rule_names(&compiled), ["from_a", "from_b"]);
}

#[test]
fn one_entrypoint_never_resolves_through_another_entrypoints_directory() {
    let fixture = Fixture::new();
    // `a` is a configured include directory, so `a/lib.yar` is reachable from
    // anywhere. `b`'s entrypoint must still prefer its own sibling.
    fixture.manifest(
        "schema = 1\nentrypoints = [\"a/main.yar\", \"b/main.yar\"]\ninclude_dirs = [\"a\"]\n",
    );
    fixture.write("a/main.yar", "include \"lib.yar\"\n");
    fixture.write("a/lib.yar", &rule("from_a"));
    fixture.write("b/main.yar", "include \"lib.yar\"\n");
    fixture.write("b/lib.yar", &rule("from_b"));

    let compiled = project(&fixture.root);

    assert_eq!(rule_names(&compiled), ["from_a", "from_b"]);
}

// --- Include directories ---------------------------------------------------

#[test]
fn include_dirs_are_searched_in_declared_order() {
    for (dirs, expected) in [("[\"a\", \"b\"]", "from_a"), ("[\"b\", \"a\"]", "from_b")] {
        let fixture = Fixture::new();
        fixture.manifest(&format!(
            "schema = 1\nentrypoints = [\"main.yar\"]\ninclude_dirs = {dirs}\n"
        ));
        // The entrypoint sits in the root, which holds no `lib.yar`, so the
        // configured directories are what decide.
        fixture.write("main.yar", "include \"lib.yar\"\n");
        fixture.write("a/lib.yar", &rule("from_a"));
        fixture.write("b/lib.yar", &rule("from_b"));

        let compiled = project(&fixture.root);

        assert_eq!(rule_names(&compiled), [expected], "include_dirs = {dirs}");
    }
}

#[test]
fn an_include_dir_outside_the_project_is_compiled_from() {
    let fixture = Fixture::new();
    fixture.manifest(
        "schema = 1\nentrypoints = [\"main.yar\"]\ninclude_dirs = [\".\", \"../shared\"]\n",
    );
    fixture.write(
        "main.yar",
        &format!("include \"ext.yar\"\n{}", rule("main")),
    );
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let compiled = project(&fixture.root);

    assert_eq!(rule_names(&compiled), ["ext", "main"]);
    // Depending on a file outside the project is informational, so it is not
    // repeated in the Problems pane.
    assert!(compiled.diagnostics.is_empty(), "{}", summary(&compiled));
}

// --- What gets compiled ----------------------------------------------------

#[test]
fn explicit_entrypoints_leave_an_unrelated_rule_out_of_the_ruleset() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentrypoints = [\"main.yar\"]\n");
    fixture.write(
        "main.yar",
        &format!("include \"lib.yar\"\n{}", rule("main")),
    );
    fixture.write("lib.yar", &rule("lib"));
    fixture.write("unrelated.yar", &rule("unrelated"));

    let compiled = project(&fixture.root);

    assert_eq!(rule_names(&compiled), ["lib", "main"]);
}

#[test]
fn inferred_independent_roots_are_all_compiled_once() {
    let fixture = Fixture::new();
    fixture.write(
        "alpha.yar",
        &format!("include \"alpha_lib.yar\"\n{}", rule("alpha")),
    );
    fixture.write("alpha_lib.yar", &rule("alpha_lib"));
    fixture.write("beta.yar", &rule("beta"));
    fixture.write(
        "nested/gamma.yar",
        &format!("include \"gamma_lib.yar\"\n{}", rule("gamma")),
    );
    fixture.write("nested/gamma_lib.yar", &rule("gamma_lib"));

    let compiled = project(&fixture.root);

    // Three inferred roots, five files, five rules: an included file is expanded
    // by YARA-X and never added as a compilation unit of its own, which would
    // define its rules a second time.
    assert_eq!(
        rule_names(&compiled),
        ["alpha", "alpha_lib", "beta", "gamma", "gamma_lib"]
    );
    assert_eq!(compiled.rule_count, 5);
}

#[test]
fn a_library_that_is_not_a_rule_file_is_compiled_through_its_includer() {
    let fixture = Fixture::new();
    fixture.write(
        "main.yar",
        &format!("include \"common.inc\"\n{}", rule("main")),
    );
    fixture.write("common.inc", &rule("common"));

    let compiled = project(&fixture.root);

    // `common.inc` is not discovered as a project file - discovery only matches
    // rule extensions - but it is a graph node, part of the plan's closure, and
    // its rules are in the ruleset.
    assert_eq!(rule_names(&compiled), ["common", "main"]);
}

#[test]
fn a_project_with_nothing_to_compile_succeeds_with_zero_rules() {
    let empty = Fixture::new();

    let compiled = project(&empty.root);

    // An empty plan is a valid plan: Scan stays enabled and matches nothing,
    // rather than the user having to interpret a failure that is not one.
    assert!(compiled.rules.is_some(), "{}", summary(&compiled));
    assert_eq!(compiled.rule_count, 0);
    assert!(compiled.diagnostics.is_empty(), "{}", summary(&compiled));

    // Same outcome for a directory that has files, none of them rules.
    let no_rules = Fixture::new();
    no_rules.write("notes.txt", "nothing to compile\n");

    let compiled = project(&no_rules.root);

    assert!(compiled.rules.is_some(), "{}", summary(&compiled));
    assert_eq!(compiled.rule_count, 0);
}

// --- Failures --------------------------------------------------------------

#[test]
fn a_plan_rejection_is_reported_without_invoking_yara_x() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "// leading comment\ninclude \"nowhere.yar\"\n");

    let compiled = project(&fixture.root);

    // One diagnostic, and it is the model's: YARA-X was never asked, so there is
    // no E043 beside it describing the same problem less precisely.
    let diagnostic = expect_failure(&compiled);
    assert_eq!(diagnostic.code, "missing-include");
    assert_eq!(diagnostic.severity, "error");
    assert!(
        diagnostic.title.contains("nowhere.yar"),
        "{}",
        diagnostic.title
    );
    // Attributed to a canonical, openable path, with a position derived from the
    // file's own bytes.
    assert_eq!(
        diagnostic.file.as_deref(),
        Some(fixture.path_text("main.yar").as_str())
    );
    assert_eq!((diagnostic.line, diagnostic.column), (2, 1));
    assert_eq!((diagnostic.span.start, diagnostic.span.end), (19, 40));
}

#[test]
fn a_configuration_failure_is_a_compile_failure_with_its_own_code() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 2\n");

    let compiled = project(&fixture.root);

    let diagnostic = expect_failure(&compiled);
    assert_eq!(diagnostic.code, "manifest-unsupported-schema");
    // There is no usable project, so no path can be trusted to open.
    assert_eq!(diagnostic.file, None);
    assert_eq!((diagnostic.line, diagnostic.column), (0, 0));
}

#[test]
fn a_root_that_is_not_there_is_reported_as_such() {
    let fixture = Fixture::new();

    let compiled = project(&fixture.root.join("gone"));

    assert_eq!(expect_failure(&compiled).code, "root-unavailable");
}

#[test]
fn a_semantic_error_found_after_planning_is_attributed_to_its_own_file() {
    let fixture = Fixture::new();
    // Syntactically valid, so the model parses it, resolves its graph and builds
    // a plan. The identifier only fails to exist once YARA-X compiles it.
    fixture.write("main.yar", "include \"lib.yar\"\n");
    fixture.write(
        "lib.yar",
        "rule uses_unknown {\n  condition: no_such_identifier\n}\n",
    );

    let compiled = project(&fixture.root);

    assert!(compiled.rules.is_none());
    assert_eq!(codes(&compiled), ["E009"]);
    let diagnostic = &compiled.diagnostics[0];
    // The error is inside an *included* file, reached through the entrypoint's
    // wrapper. The origin YARA-X reports is mapped back to a canonical path the
    // frontend can open - and it is never the wrapper's synthetic name.
    assert_eq!(
        diagnostic.file.as_deref(),
        Some(fixture.path_text("lib.yar").as_str())
    );
    assert_eq!(diagnostic.line, 2);
    assert!(diagnostic.column > 0);
}

#[test]
fn a_missing_entrypoint_never_surfaces_the_wrapper_as_a_filename() {
    let fixture = Fixture::new();
    fixture.write("main.yar", &rule("main"));

    let snapshot = crate::project::open_project(&fixture.root).expect("a valid configuration");
    let plan = snapshot.compilation_plan().expect("a valid plan");
    // Deleting the entrypoint after planning is the one way to make YARA-X fail
    // inside a wrapper. It is a race in production; here it is how the wrapper's
    // diagnostics get exercised at all.
    std::fs::remove_file(fixture.root.join("main.yar")).expect("remove the entrypoint");

    let compiled = compile_plan(&plan);

    let diagnostic = expect_failure(&compiled);
    assert_eq!(diagnostic.code, "E043");
    // The wrapper is Quipu's own text: the user gets the entrypoint it stands
    // for, and no position pointing into a file they never wrote.
    assert_eq!(
        diagnostic.file.as_deref(),
        Some(fixture.path_text("main.yar").as_str())
    );
    assert_eq!((diagnostic.line, diagnostic.column), (0, 0));
    assert_eq!((diagnostic.span.start, diagnostic.span.end), (0, 0));
}

// --- Include literals ------------------------------------------------------

#[test]
fn a_path_that_cannot_be_written_as_an_include_literal_is_refused() {
    // YARA's include filename is a plain string literal: no escape sequences at
    // all. A path containing a quote or a newline therefore cannot be compiled
    // with the model's resolution semantics, and saying so is the only honest
    // answer.
    assert_eq!(
        include_literal(Path::new("/rules/main.yar")).as_deref(),
        Some("/rules/main.yar")
    );
    assert_eq!(include_literal(Path::new("/rules/od\"d.yar")), None);
    assert_eq!(include_literal(Path::new("/rules/od\nd.yar")), None);
    assert_eq!(
        wrapper_source(Path::new("/rules/main.yar")).as_deref(),
        Some("include \"/rules/main.yar\"\n")
    );
}

// --- Editor positions ------------------------------------------------------

#[test]
fn a_column_counts_utf16_code_units_so_monaco_lands_on_the_right_character() {
    // Monaco positions are UTF-16 offsets into the line, so the column has to be
    // counted the way Monaco counts it. `line_col` is given the byte offset of the
    // `X` in each of these, and must always answer "the column the X is at".
    //
    // ASCII: bytes, chars and UTF-16 units all agree, so this pins the base case.
    let ascii = "rule X";
    assert_eq!(line_col(ascii.as_bytes(), 5), (1, 6));

    // A BMP character above ASCII is 3 bytes but a single UTF-16 unit, so the
    // column must not follow the byte offset.
    let bmp = "// caf\u{e9}\nX";
    assert_eq!(
        line_col(bmp.as_bytes(), bmp.find('X').unwrap() as u32),
        (2, 1)
    );
    assert_eq!(line_col(bmp.as_bytes(), 8), (1, 8));

    // An astral character is one Rust `char` but a surrogate pair: two UTF-16
    // units. This is the case that counting scalar values gets wrong, placing the
    // diagnostic one column early.
    let astral = "// \u{1f600} X";
    let offset = astral.find('X').unwrap() as u32;
    assert_eq!(line_col(astral.as_bytes(), offset), (1, 7));
    assert_eq!(
        astral[..offset as usize].chars().count() + 1,
        6,
        "the scalar-value count is one short - which is the bug being ruled out"
    );
}

#[test]
fn a_column_is_measured_from_the_start_of_its_own_line() {
    let text = "rule a {\n  // \u{1f600}\n  condition: X\n}\n";
    let offset = text.find('X').unwrap() as u32;

    // Line 3, and the emoji on line 2 must not affect it at all: only the two
    // spaces and `condition: ` before the X on this line count.
    assert_eq!(line_col(text.as_bytes(), offset), (3, 14));

    // A newline belongs to the line it ends, and the byte after it starts the
    // next line at column 1.
    assert_eq!(line_col(b"a\nbb\nccc", 1), (1, 2));
    assert_eq!(line_col(b"a\nbb\nccc", 2), (2, 1));
    assert_eq!(line_col(b"a\nbb\nccc", 5), (3, 1));
}

#[test]
fn an_offset_at_or_past_the_end_still_yields_a_position() {
    // YARA-X spans and on-disk contents can disagree - the file may have been
    // edited since - so an out-of-range offset must clamp rather than panic.
    let text = "rule a {}\n";
    assert_eq!(line_col(text.as_bytes(), text.len() as u32), (2, 1));
    assert_eq!(line_col(text.as_bytes(), 9_999), (2, 1));
    assert_eq!(line_col(b"rule a {}", 9), (1, 10));
    assert_eq!(line_col(b"rule a {}", 9_999), (1, 10));
    assert_eq!(line_col(b"", 0), (1, 1));
    assert_eq!(line_col(b"", 7), (1, 1));
}

#[test]
fn an_offset_inside_broken_utf8_does_not_fail() {
    // Rule files are not guaranteed to be valid UTF-8, and an offset can land
    // mid-character. Either way a position comes back: the replacement character
    // the editor itself would show counts as the one unit it is displayed as.
    let truncated = b"// \xf0\x9f\x98"; // an emoji missing its last byte
    assert_eq!(line_col(truncated, truncated.len() as u32), (1, 5));

    let emoji = "\u{1f600}".as_bytes();
    assert_eq!(
        line_col(emoji, 2),
        (1, 2),
        "half an emoji is one replacement"
    );
    assert_eq!(line_col(emoji, 4), (1, 3), "all of it is a surrogate pair");
}
