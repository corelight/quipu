//! The Quipu project model: what a project contains, how its `include` graph
//! resolves, and which sources a compilation would consume.
//!
//! "Project" is deliberately not "workspace": the frontend already has a
//! `Workspace` class that owns Monaco editor documents. This module is the
//! backend domain model and knows nothing about editors, IPC or caching.
//!
//! The pipeline is four separable steps, each with its own type:
//!
//! 1. [`ProjectDefinition`] - user intent. An optional `quipu.toml` in the
//!    project root, or documented defaults when there isn't one.
//! 2. [`ProjectSnapshot`] - a point-in-time analysis: discovered files, the
//!    complete include graph as a *graph* (not a tree), and every
//!    [`ProjectIssue`] found while building it.
//! 3. [`CompilationPlan`] - the deterministic subset of a *valid* snapshot that
//!    a later phase hands to YARA-X.
//! 4. A future cache layer, which will hash a valid plan. Nothing here knows
//!    about hashing, `.yarc` files or cache paths; see
//!    `docs/compiled-rules-cache-design.md`.
//!
//! Snapshot analysis and plan validation are kept apart on purpose: the future
//! Includes view must be able to render a broken graph, which means analysis
//! has to succeed where planning fails.
//!
//! The contract implemented here is documented in
//! `docs/workspace-project-model.md`.

mod discovery;
mod fingerprint;
mod graph;
mod includes;
mod issues;
mod manifest;
mod paths;
mod plan;

#[cfg(test)]
mod tests;

// The module's surface, in one place: everything a caller needs and nothing else.
// `crate::analysis` renders it for the wire and `crate::compile` consumes a plan;
// nothing outside those two reaches into the model.
pub(crate) use fingerprint::{
    COMPILER_CACHE_EPOCH, COMPILER_PROFILE, FINGERPRINT_ENCODING_VERSION, PlanFingerprint,
};
pub(crate) use graph::{IncludeEdge, ProjectSnapshot, SourceEvidence, SourceNode};
pub(crate) use issues::{ByteSpan, IssueKind, IssueScope, ProjectIssue, Severity};
pub(crate) use manifest::{ConfigError, MANIFEST_FILE, ProjectDefinition};
pub(crate) use paths::{escaped, is_rule_file, to_slash};
pub(crate) use plan::{CompilationPlan, PlanInput, PlanRejection};

use std::path::Path;

/// A stable identity for one node of the include graph.
///
/// Identities - not paths - are what the model sorts, deduplicates and compares
/// by, and what a future cache layer will hash. Two spellings of the same file
/// (`./a.yar`, `sub/../a.yar`, a symlink) canonicalize to one identity.
///
/// The derived ordering puts every internal source before every external one,
/// then orders lexicographically by `path`. That is the model's canonical
/// ordering for nodes, entrypoint inference and issue lists.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct SourceId {
    /// True when the file lives outside the project root. External files are
    /// reachable through `include` directives and configured include
    /// directories, and are informational rather than errors.
    pub external: bool,
    /// `/`-separated, project-root-relative path for internal sources;
    /// `/`-separated canonical absolute path for external ones.
    pub path: String,
}

impl SourceId {
    /// Classifies `canonical` (an already-canonicalized absolute path) against
    /// the canonical project `root`.
    ///
    /// `None` when the path is not valid Unicode. An identity must be unique per
    /// file, and a lossy conversion is not: `a<0xff>.yar` and `a<0xfe>.yar` are
    /// different files that would share one lossy string. The policy is the same
    /// for internal and external sources; see [`paths::to_slash`].
    fn for_path(canonical: &Path, root: &Path) -> Option<Self> {
        match canonical.strip_prefix(root) {
            Ok(relative) => Some(Self {
                external: false,
                path: paths::to_slash(relative)?,
            }),
            Err(_) => Some(Self {
                external: true,
                path: paths::to_slash(canonical)?,
            }),
        }
    }
}

impl std::fmt::Display for SourceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.path)
    }
}

/// How a snapshot's entrypoints were determined.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EntrypointOrigin {
    /// Listed in `quipu.toml`, used verbatim and in manifest order.
    Declared,
    /// Inferred from the include graph (files nothing includes).
    Inferred,
}

/// Loads the definition for `root` and analyzes it in one step.
///
/// A configuration error is returned rather than folded into the snapshot,
/// because without a usable definition there is no meaningful graph to show.
/// Callers that want to render it alongside graph problems can use
/// [`ConfigError::as_issue`].
pub(crate) fn open_project(root: &Path) -> Result<ProjectSnapshot, ConfigError> {
    ProjectDefinition::load(root).map(ProjectSnapshot::analyze)
}
