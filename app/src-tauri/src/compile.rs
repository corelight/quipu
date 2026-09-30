//! Turning a project (or a scratch buffer) into a compiled ruleset.
//!
//! This is the Tauri-free half of the compile commands: it takes a project root
//! or a string of source, and returns compiled rules plus the diagnostics to
//! show. `commands.rs` owns the IPC signatures and the shared-state lifecycle;
//! everything decided here is decided by plain functions, so it is testable
//! without a Tauri runtime.
//!
//! # The project pipeline
//!
//! ```text
//! root -> ProjectDefinition -> ProjectSnapshot -> CompilationPlan -> yara_x::Compiler -> Rules
//! ```
//!
//! Analysis happens here, immediately before compiling, so what is compiled is
//! what is on disk now rather than whatever the frontend last saw. A
//! `PlanRejection` refuses compilation outright: YARA-X is never invoked for a
//! project the model has already found to be broken, because its errors would
//! describe symptoms of a problem the model can describe precisely.
//!
//! # Matching the model's include resolution
//!
//! The model resolves an include from the including file's parent directory
//! first, then from the configured include directories in order. YARA-X does the
//! same - but only for files it reaches through an `include`, because its include
//! stack is empty while it processes a source passed to `Compiler::add_source`.
//!
//! So no entrypoint is ever passed to `add_source`. Each one is compiled through
//! a one-line *synthetic wrapper* containing an absolute `include` of it (see
//! [`wrapper_source`]). YARA-X then reads the entrypoint through
//! `read_included_file`, pushes it onto its include stack, and every include
//! inside it - and inside everything it reaches - resolves parent-first, per
//! entrypoint, exactly as the model says.
//!
//! This is why entrypoint parents are *not* added to the include directory list:
//! one global list shared by every entrypoint would let one entrypoint resolve an
//! include through a different entrypoint's directory, which the model never
//! does.
//!
//! # No current-directory fallback
//!
//! `yara_x::Compiler` keeps its include directories as an `Option<Vec<PathBuf>>`
//! and, when that is `None`, resolves includes against the *process working
//! directory* - which for Quipu is wherever the user happened to launch it. That
//! would let an include the model reported as missing resolve to an unrelated
//! file. There is no public API to set an empty list, so a plan with no include
//! directories gets [`unresolvable_include_dir`] instead: a directory that cannot
//! exist, which makes the list non-empty and the fallback branch unreachable.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use yara_x::{Compiler, SourceCode};

use crate::commands::{Diagnostic, Span};
use crate::project::{
    CompilationPlan, PlanInput, PlanRejection, ProjectIssue, Severity, SourceId, open_project,
    to_slash,
};

/// The outcome of a compilation attempt.
///
/// `rules` is `Some` only on success, which is what makes "every failure
/// invalidates the stored ruleset" a property of the type rather than of each
/// caller remembering to clear it.
pub struct Compiled {
    pub rules: Option<Box<yara_x::Rules>>,
    pub diagnostics: Vec<Diagnostic>,
    pub rule_count: usize,
}

impl Compiled {
    /// A failure with diagnostics and no rules.
    fn failed(diagnostics: Vec<Diagnostic>) -> Self {
        Self {
            rules: None,
            diagnostics,
            rule_count: 0,
        }
    }
}

/// Compiles a single in-memory source: the scratch buffer, when no project
/// folder is open.
///
/// Include directories are sealed exactly as they are for a project with none
/// declared. A scratch buffer has no project, so an `include` in it has no
/// legitimate directory to resolve from and is reported as not found - rather
/// than silently resolving against Quipu's launch directory, which is what
/// leaving the list unset would do.
pub fn scratch(text: &str) -> Compiled {
    let mut compiler = Compiler::new();
    seal_include_dirs(&mut compiler, &[]);
    // No origin: the buffer has no path, so its diagnostics carry `file: null`
    // and the frontend keeps them on the active editor rather than trying to
    // open a file that does not exist.
    let _ = compiler.add_source(SourceCode::from(text));
    finish(compiler, &Origins::default())
}

/// Analyzes `root` and compiles it from the resulting plan.
#[cfg(test)]
pub fn project(root: &Path) -> Compiled {
    let plan = match project_plan(root) {
        Ok(plan) => plan,
        Err(compiled) => return compiled,
    };

    compile_plan(&plan)
}

/// Opens and validates a project without invoking YARA-X.
pub(crate) fn project_plan(root: &Path) -> Result<CompilationPlan, Compiled> {
    let snapshot = match open_project(root) {
        Ok(snapshot) => snapshot,
        // A configuration failure is the user's problem, described precisely, so
        // it becomes a diagnostic rather than an IPC rejection.
        Err(err) => {
            return Err(Compiled::failed(vec![config_diagnostic(&err)]));
        }
    };

    let plan = match snapshot.compilation_plan() {
        Ok(plan) => plan,
        // Attributed against the *canonical* root, not the one the frontend
        // sent: the identities in these issues are relative to that, and a
        // diagnostic the user cannot click through is barely a diagnostic.
        Err(rejection) => {
            let root = snapshot.definition().root();
            return Err(Compiled::failed(rejection_diagnostics(&rejection, root)));
        }
    };
    Ok(plan)
}

/// Compiles a validated plan, and nothing else.
///
/// Only the plan's entrypoints become compilation units. The rest of the closure
/// is deliberately *not* added: YARA-X expands includes itself, and adding a
/// closure member independently would compile it twice and duplicate every rule
/// identifier it defines.
pub(crate) fn compile_plan(plan: &CompilationPlan) -> Compiled {
    // Every path YARA-X will touch has to be expressible before anything is
    // compiled: it panics on a non-Unicode included path, and an entrypoint that
    // cannot be written as an include literal cannot be compiled with the
    // parent-first semantics the model promises. Both are reported instead.
    if let Err(diagnostics) = check_representable(plan) {
        return Compiled::failed(diagnostics);
    }

    let mut compiler = Compiler::new();
    seal_include_dirs(&mut compiler, plan.include_dirs());

    // Declared entrypoint order is preserved: it is part of the plan's contract
    // and decides which of two duplicate definitions YARA-X sees first.
    let wrappers: Vec<(String, String)> = plan
        .entrypoints()
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            wrapper_source(&entry.canonical).map(|source| (source, wrapper_origin(index)))
        })
        .collect();
    for (source, origin) in &wrappers {
        // Errors are also recorded on the compiler, so the returned first error
        // adds nothing here.
        let _ = compiler.add_source(SourceCode::from(source.as_str()).with_origin(origin.as_str()));
    }

    // An empty plan is a valid plan: a project with no rule files compiles
    // successfully to zero rules, so Scan runs and matches nothing rather than
    // the user having to interpret a failure that is not one.
    finish(compiler, &Origins::new(plan))
}

/// Collects diagnostics from a compiler and builds the rules if it is clean.
fn finish(compiler: Compiler<'_>, origins: &Origins) -> Compiled {
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    for e in compiler.errors() {
        diagnostics.push(origins.rewrite(error_to_diagnostic(e)));
    }
    for w in compiler.warnings() {
        diagnostics.push(origins.rewrite(warning_to_diagnostic(w)));
    }
    if !compiler.errors().is_empty() {
        return Compiled::failed(diagnostics);
    }

    let rules = compiler.build();
    let rule_count = rules.iter().count();
    Compiled {
        rules: Some(Box::new(rules)),
        diagnostics,
        rule_count,
    }
}

// ---- Include directories ----

/// Adds `dirs` in order, sealing the list so YARA-X cannot fall back to the
/// process working directory.
///
/// Order is significant and preserved: resolution stops at the first match, so
/// the compiler must search the same directories in the same sequence the model
/// did.
fn seal_include_dirs(compiler: &mut Compiler, dirs: &[PathBuf]) {
    for dir in dirs {
        compiler.add_include_dir(dir);
    }
    if dirs.is_empty() {
        compiler.add_include_dir(unresolvable_include_dir());
    }
}

/// A path that can never name a directory, used only to make YARA-X's include
/// directory list non-empty.
///
/// A NUL byte cannot appear in a path on any supported platform, so every
/// `canonicalize` of a candidate under it fails - including one that tries to
/// climb out with `..`, since canonicalization requires the whole prefix to
/// exist. A merely *absent* directory would be weaker: the user could create it.
fn unresolvable_include_dir() -> PathBuf {
    PathBuf::from("\0")
}

// ---- Entrypoint wrappers ----

/// The one-line source compiled in place of an entrypoint.
///
/// `None` when the path cannot be written as a YARA include filename; the caller
/// has already rejected the plan in that case, so this is a second gate rather
/// than the first.
fn wrapper_source(canonical: &Path) -> Option<String> {
    include_literal(canonical).map(|literal| format!("include \"{literal}\"\n"))
}

/// A synthetic origin for one entrypoint's wrapper.
///
/// Never shown to the user: [`Origins::rewrite`] replaces it with the entrypoint
/// it stands for, because a filename the user cannot open is worse than none.
/// The `quipu:` prefix is not a path on any platform, so it cannot collide with
/// an origin YARA-X derives from a real file.
fn wrapper_origin(index: usize) -> String {
    format!("quipu:entrypoint/{index}")
}

/// Renders `canonical` as the body of a YARA include filename literal.
///
/// YARA's include filename is a plain string literal with no escape sequences at
/// all: a backslash is rejected by the tokenizer, and so are a double quote and a
/// newline. A path containing any of them therefore cannot be compiled, and
/// `None` says so rather than producing a literal that would silently name a
/// different file.
///
/// On Windows the separators are rewritten to `/` and the `\\?\` verbatim prefix
/// that `canonicalize` adds is stripped, which is what [`to_slash`] already does
/// for identities. A verbatim UNC path (`\\?\UNC\server\share\...`) has no such
/// rewriting - dropping the prefix would change which host the path names - so it
/// is rejected.
fn include_literal(canonical: &Path) -> Option<String> {
    if cfg!(windows) && canonical.as_os_str().to_str()?.starts_with(r"\\?\UNC\") {
        return None;
    }
    let text = to_slash(canonical)?;
    if text.contains('\\') || text.contains('"') || text.contains('\n') || text.contains('\r') {
        return None;
    }
    Some(text)
}

/// Rejects a plan YARA-X cannot be handed faithfully.
///
/// Two distinct limits, both structural rather than accidental:
///
/// * YARA-X unwraps the included path to a `&str` when it records a diagnostic
///   origin, so a closure member whose canonical path is not valid Unicode would
///   abort the process. (The model gives such a file no identity, but the project
///   *root* can be unrepresentable while every path below it is fine.)
/// * An entrypoint whose path cannot be written as an include literal cannot be
///   compiled parent-first, and compiling it any other way would use different
///   resolution semantics than the model reported.
fn check_representable(plan: &CompilationPlan) -> Result<(), Vec<Diagnostic>> {
    let mut diagnostics = Vec::new();
    for input in plan.closure() {
        if to_slash(&input.canonical).is_none() {
            diagnostics.push(unrepresentable_diagnostic(
                input,
                "its canonical path is not valid Unicode, which YARA-X cannot record",
            ));
        }
    }
    for input in plan.entrypoints() {
        if include_literal(&input.canonical).is_none() {
            diagnostics.push(unrepresentable_diagnostic(
                input,
                "its canonical path cannot be written as a YARA include filename \
                 (no backslash, double quote or newline is representable)",
            ));
        }
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn unrepresentable_diagnostic(input: &PlanInput, why: &str) -> Diagnostic {
    Diagnostic {
        severity: "error",
        code: "unrepresentable-path".to_string(),
        title: format!("cannot compile {}: {why}", input.id),
        line: 0,
        column: 0,
        span: Span { start: 0, end: 0 },
        // No `file`: the whole problem is that this path cannot be named, so
        // handing the frontend a name to open would be self-contradictory.
        file: None,
    }
}

// ---- Diagnostic origins ----

/// Maps the origin strings YARA-X reports back to openable canonical paths.
///
/// Two forms have to be recognized, because `read_included_file` strips the
/// process working directory from the path it records: a file under the cwd is
/// reported relative to it, anything else absolutely. Both are computed the same
/// way YARA-X computes them, so the keys match by construction rather than by
/// guessing.
#[derive(Default)]
struct Origins {
    /// Origin as YARA-X reports it, to the canonical path to open.
    files: HashMap<String, String>,
    /// Wrapper origin to the entrypoint it stands for.
    wrappers: HashMap<String, String>,
}

impl Origins {
    fn new(plan: &CompilationPlan) -> Self {
        let cwd = std::env::current_dir().and_then(std::fs::canonicalize).ok();

        let mut files = HashMap::new();
        for input in plan.closure() {
            let Some(absolute) = to_slash(&input.canonical) else {
                continue;
            };
            // The absolute form first, then the cwd-relative one, so a file
            // under the cwd is reachable under either spelling.
            if let Some(relative) = cwd
                .as_deref()
                .and_then(|cwd| input.canonical.strip_prefix(cwd).ok())
                .and_then(to_slash)
            {
                files.insert(relative, absolute.clone());
            }
            files.insert(absolute.clone(), absolute);
        }

        let wrappers = plan
            .entrypoints()
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| Some((wrapper_origin(index), to_slash(&entry.canonical)?)))
            .collect();

        Self { files, wrappers }
    }

    /// Replaces a diagnostic's origin with a path the frontend can open.
    fn rewrite(&self, mut diagnostic: Diagnostic) -> Diagnostic {
        let Some(origin) = diagnostic.file.take() else {
            // No origin at all: the scratch buffer. Left as `None`, so the
            // frontend keeps the diagnostic on the active editor.
            return diagnostic;
        };
        if let Some(entrypoint) = self.wrappers.get(&origin) {
            // A wrapper is Quipu's own text, so its line, column and span mean
            // nothing to the user. The entrypoint it stands for is what went
            // wrong - in practice it disappeared between analysis and
            // compilation - and the position is dropped rather than pointing
            // into a file the user never wrote.
            diagnostic.file = Some(entrypoint.clone());
            diagnostic.line = 0;
            diagnostic.column = 0;
            diagnostic.span = Span { start: 0, end: 0 };
            return diagnostic;
        }
        if let Some(path) = self.files.get(&origin) {
            diagnostic.file = Some(path.clone());
            return diagnostic;
        }
        // An origin outside the plan's closure: the tree changed under us
        // between analysis and compilation. Resolve it the same way YARA-X did
        // so the row stays clickable, and drop it if that no longer works
        // rather than handing over a path that may be relative to a directory
        // the frontend knows nothing about.
        diagnostic.file = std::fs::canonicalize(&origin)
            .ok()
            .as_deref()
            .and_then(to_slash);
        diagnostic
    }
}

// ---- Project issues as diagnostics ----

fn config_diagnostic(err: &crate::project::ConfigError) -> Diagnostic {
    Diagnostic {
        severity: "error",
        code: err.code().to_string(),
        title: err.to_string(),
        line: 0,
        column: 0,
        span: Span { start: 0, end: 0 },
        // A configuration failure means there is no usable project root, so
        // there is no path that can be trusted to open.
        file: None,
    }
}

/// Converts a plan rejection into Problems-pane rows.
///
/// Only blocking issues are converted: informational ones (an external
/// dependency) belong to the Includes view, and repeating them as compile
/// problems would train the user to ignore the pane. Source attribution, byte
/// span and an editor position are preserved wherever the issue has them.
fn rejection_diagnostics(rejection: &PlanRejection, root: &Path) -> Vec<Diagnostic> {
    rejection
        .blocking()
        .iter()
        .map(|issue| issue_diagnostic(issue, root))
        .collect()
}

fn issue_diagnostic(issue: &ProjectIssue, root: &Path) -> Diagnostic {
    let file = issue.at.as_ref().and_then(|id| canonical_of(id, root));
    let span = issue.span();
    // Line and column need the file's bytes, so they are only available when the
    // issue names a readable file. A zero line means "no position", which the
    // frontend already treats as "open the file, do not jump".
    let (line, column) = match (&file, span) {
        (Some(path), Some(span)) => std::fs::read(path)
            .ok()
            .map(|bytes| line_col(&bytes, span.start))
            .unwrap_or((0, 0)),
        _ => (0, 0),
    };
    Diagnostic {
        severity: match issue.severity() {
            Severity::Blocking => "error",
            Severity::Informational => "warning",
        },
        code: issue.code().to_string(),
        title: issue.message(),
        line,
        column,
        span: span
            .map(|s| Span {
                start: s.start as usize,
                end: s.end as usize,
            })
            .unwrap_or(Span { start: 0, end: 0 }),
        file,
    }
}

/// Turns an identity back into an openable canonical path.
///
/// An internal identity is root-relative by construction, so the root supplies
/// the prefix; an external identity already *is* a canonical absolute path.
/// `None` when the result cannot be represented, which only happens for a root
/// that is not valid Unicode.
fn canonical_of(id: &SourceId, root: &Path) -> Option<String> {
    if id.external {
        Some(id.path.clone())
    } else {
        to_slash(&root.join(&id.path))
    }
}

/// 1-based line, and 1-based column counted in UTF-16 code units.
///
/// The column is in UTF-16 code units because the frontend hands it straight to
/// Monaco, whose positions are UTF-16 offsets into the line. Counting bytes or
/// Rust `char`s would both be wrong: a character outside the BMP (an emoji, say)
/// is one `char` but two UTF-16 code units, so counting scalar values would place
/// every column after it one short and navigation would land early.
///
/// Neither a byte offset past the end nor one that lands inside a multi-byte
/// character can fail: the offset is clamped to the length, and the line's bytes
/// are decoded lossily, so malformed or truncated UTF-8 contributes one unit per
/// replacement character. A diagnostic with a slightly imprecise column is far
/// better than none.
fn line_col(bytes: &[u8], offset: u32) -> (usize, usize) {
    let offset = (offset as usize).min(bytes.len());
    let mut line = 1usize;
    let mut line_start = 0usize;
    for (index, byte) in bytes[..offset].iter().enumerate() {
        if *byte == b'\n' {
            line += 1;
            line_start = index + 1;
        }
    }
    let column = String::from_utf8_lossy(&bytes[line_start..offset])
        .encode_utf16()
        .count()
        + 1;
    (line, column)
}

// ---- YARA-X diagnostics ----

fn error_to_diagnostic(e: &yara_x::errors::CompileError) -> Diagnostic {
    let (line, column, span, file) = location_from_json(&serde_json::to_value(e).ok());
    Diagnostic {
        severity: "error",
        code: e.code().to_string(),
        title: e.title().to_string(),
        line,
        column,
        span,
        file,
    }
}

fn warning_to_diagnostic(w: &yara_x::warnings::Warning) -> Diagnostic {
    let (line, column, span, file) = location_from_json(&serde_json::to_value(w).ok());
    Diagnostic {
        severity: "warning",
        code: w.code().to_string(),
        title: w.title().to_string(),
        line,
        column,
        span,
        file,
    }
}

/// CompileError/Warning serialize with top-level `line`, `column`, and a
/// `labels[0]` carrying byte `span` and `code_origin` (the file path set via
/// SourceCode::with_origin). We read these from the serialized form rather than
/// depending on private fields. (Verified shape in Phase 0.)
fn location_from_json(value: &Option<serde_json::Value>) -> (usize, usize, Span, Option<String>) {
    let default = (0usize, 0usize, Span { start: 0, end: 0 }, None);
    let Some(v) = value else { return default };
    let line = v.get("line").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
    let column = v.get("column").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
    let label = v.get("labels").and_then(|l| l.get(0));
    let span = label
        .and_then(|l| l.get("span"))
        .map(|s| Span {
            start: s.get("start").and_then(|x| x.as_u64()).unwrap_or(0) as usize,
            end: s.get("end").and_then(|x| x.as_u64()).unwrap_or(0) as usize,
        })
        .unwrap_or(Span { start: 0, end: 0 });
    let file = label
        .and_then(|l| l.get("code_origin"))
        .and_then(|o| o.as_str())
        .map(|s| s.to_string());
    (line, column, span, file)
}

#[cfg(test)]
mod tests;
