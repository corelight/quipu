//! The wire representation of a project analysis.
//!
//! This module is the boundary between the backend domain model
//! (`crate::project`) and the frontend. The model knows nothing about IPC or
//! serialization; the types here are `serde` DTOs that mirror it and nothing
//! else, so the model's shape can change without breaking the wire format by
//! accident, and the wire format cannot quietly acquire a Tauri dependency in
//! the model.
//!
//! Two rules shape the DTOs:
//!
//! * **Identities, not paths.** A [`SourceId`] crosses the wire as
//!   `{ external, path }`, never flattened into one ambiguous string. `root` is
//!   the only standalone filesystem-path field; an identity's `path` is
//!   root-relative when internal, and a canonical absolute path when external.
//!   The frontend needs `root` to turn an internal identity back into an
//!   openable path; an external identity already is one.
//! * **Nothing lossy.** A path that is not valid Unicode has no identity (see
//!   `project::paths`), and the same applies here: rather than substitute
//!   replacement characters, an unrepresentable project root is reported as a
//!   configuration failure. `to_string_lossy` is never used.

use serde::Serialize;

use crate::project::{
    ByteSpan, ConfigError, EntrypointOrigin, IncludeEdge, IssueKind, IssueScope, ProjectIssue,
    ProjectSnapshot, Severity, SourceId, SourceNode, to_slash,
};

/// A source identity, exactly as the model represents it.
///
/// Kept as a pair rather than one string because `external` changes what `path`
/// means: a root-relative path for an internal source, a canonical absolute path
/// for an external one. Flattening them would make `vendor/lib.yar` and a
/// hypothetical external source of the same spelling indistinguishable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SourceIdDto {
    pub external: bool,
    pub path: String,
}

impl From<&SourceId> for SourceIdDto {
    fn from(id: &SourceId) -> Self {
        Self {
            external: id.external,
            path: id.path.clone(),
        }
    }
}

/// A byte range within one source file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ByteSpanDto {
    pub start: u32,
    pub end: u32,
}

impl From<ByteSpan> for ByteSpanDto {
    fn from(span: ByteSpan) -> Self {
        Self {
            start: span.start,
            end: span.end,
        }
    }
}

/// One node of the include graph.
///
/// Deliberately carries no path of its own: `root` plus `id` determines it, and
/// duplicating it here would be a second, divergeable source of truth.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SourceNodeDto {
    pub id: SourceIdDto,
    /// False when the file exists in the graph but its bytes could not be read.
    pub readable: bool,
}

/// One `include` directive and what it resolved to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IncludeEdgeDto {
    pub from: SourceIdDto,
    /// Position among the includes declared by `from`, starting at zero.
    pub order: usize,
    /// The include filename as written.
    pub raw: String,
    /// Byte span of the directive within `from`.
    pub span: ByteSpanDto,
    /// `null` when the include resolved to nothing.
    pub to: Option<SourceIdDto>,
}

impl From<&IncludeEdge> for IncludeEdgeDto {
    fn from(edge: &IncludeEdge) -> Self {
        Self {
            from: (&edge.from).into(),
            order: edge.order,
            raw: edge.raw.clone(),
            span: edge.span.into(),
            to: edge.to.as_ref().map(SourceIdDto::from),
        }
    }
}

/// One structured problem.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IssueDto {
    /// Stable kebab-case code; the field a UI should branch on.
    pub code: &'static str,
    /// Human-readable one-liner for tooltips and logs. Never parse it.
    pub message: String,
    pub severity: &'static str,
    pub scope: &'static str,
    /// The source the problem belongs to, when it is attributable to one.
    pub at: Option<SourceIdDto>,
    /// Byte span within `at`, when the issue has one.
    pub span: Option<ByteSpanDto>,
}

impl From<&ProjectIssue> for IssueDto {
    fn from(issue: &ProjectIssue) -> Self {
        Self {
            code: issue.code(),
            message: issue.message(),
            severity: severity_name(issue.severity()),
            scope: scope_name(issue.scope()),
            at: issue.at.as_ref().map(SourceIdDto::from),
            span: issue.span().map(ByteSpanDto::from),
        }
    }
}

/// A load-time configuration failure, in the same shape as a snapshot issue.
///
/// The *specific* code is kept ([`ConfigError::code`]), not the
/// `invalid-configuration` that [`ConfigError::as_issue`] would produce: a UI
/// that has to explain what to fix needs to know an unsupported schema from an
/// unreadable manifest, and `crate::compile` reports the same codes for the same
/// failures.
impl From<&ConfigError> for IssueDto {
    fn from(err: &ConfigError) -> Self {
        Self {
            code: err.code(),
            message: err.to_string(),
            severity: severity_name(Severity::Blocking),
            scope: scope_name(IssueScope::Project),
            // A configuration failure is about the project, not about a file in
            // it - there is no snapshot yet for a file to be part of.
            at: None,
            span: None,
        }
    }
}

fn severity_name(severity: Severity) -> &'static str {
    match severity {
        Severity::Blocking => "blocking",
        Severity::Informational => "informational",
    }
}

fn scope_name(scope: IssueScope) -> &'static str {
    match scope {
        IssueScope::Source => "source",
        IssueScope::Project => "project",
    }
}

fn origin_name(origin: EntrypointOrigin) -> &'static str {
    match origin {
        EntrypointOrigin::Declared => "declared",
        EntrypointOrigin::Inferred => "inferred",
    }
}

/// The result of analyzing a project root.
///
/// The two variants are not two shades of the same thing. `Loaded` means a
/// snapshot exists - it may still be full of blocking problems and refuse to
/// compile, which is exactly what the future Includes view has to render.
/// `ConfigurationFailed` means no snapshot can exist at all, because the
/// definition itself could not be built.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ProjectAnalysis {
    #[serde(rename_all = "camelCase")]
    Loaded {
        /// Canonical project root, `/`-separated. The only standalone
        /// filesystem-path field on the wire - external identities carry
        /// canonical absolute paths too, but inside a [`SourceIdDto`] - and the
        /// frontend needs it to turn an internal identity back into a path it can
        /// open.
        root: String,
        /// The manifest as a project-relative identity (`quipu.toml`), or `null`
        /// when the project has none. Sent as an identity rather than an
        /// absolute path because `root` already supplies the prefix.
        manifest: Option<String>,
        /// Whether the entrypoints were declared in the manifest or inferred.
        entrypoint_origin: &'static str,
        /// Effective entrypoints: manifest order when declared, identity order
        /// when inferred.
        entrypoints: Vec<SourceIdDto>,
        /// Project files found by discovery, in identity order.
        discovered: Vec<SourceIdDto>,
        /// Every graph node, in identity order.
        nodes: Vec<SourceNodeDto>,
        /// Every include directive, ordered by `(from, order)`, unresolved ones
        /// included.
        edges: Vec<IncludeEdgeDto>,
        /// Every problem found, in the model's canonical issue order.
        issues: Vec<IssueDto>,
        /// Whether a compilation plan can currently be derived. False means a
        /// compile would be refused before YARA-X is invoked.
        compilable: bool,
    },
    #[serde(rename_all = "camelCase")]
    ConfigurationFailed {
        /// The failure, in the same shape as a snapshot issue so a UI can render
        /// configuration and graph problems through one code path.
        issue: IssueDto,
    },
}

/// Renders an analysis its caller has already performed, for the wire.
///
/// Never fails: a configuration error is a *result*, not an error, because the
/// frontend has to be able to show it. Reserved for genuinely unexpected
/// failures is the caller's `Result`, not this function's.
///
/// Takes the outcome rather than a root so a caller that needs the snapshot *as
/// well as* its wire form - `crate::watch`, deriving what to watch from the very
/// snapshot the frontend is about to be shown - analyses the project once. Two
/// analyses could describe two different reads of the disk.
pub(crate) fn describe(outcome: &Result<ProjectSnapshot, ConfigError>) -> ProjectAnalysis {
    match outcome {
        Ok(snapshot) => loaded(snapshot),
        Err(err) => ProjectAnalysis::ConfigurationFailed {
            issue: IssueDto::from(err),
        },
    }
}

fn loaded(snapshot: &ProjectSnapshot) -> ProjectAnalysis {
    let root = snapshot.definition().root();
    // The root is the only path on the wire, and an unrepresentable one cannot
    // be sent without either lying about the project's identity or dropping the
    // frontend's only way to open a file in it. Reported as a configuration
    // failure instead - the same answer the model gives for a path with no
    // identity, for the same reason.
    let Some(root_text) = to_slash(root) else {
        return ProjectAnalysis::ConfigurationFailed {
            issue: IssueDto::from(&ProjectIssue::project(IssueKind::NonUnicodePath {
                path: crate::project::escaped(root),
            })),
        };
    };

    ProjectAnalysis::Loaded {
        root: root_text,
        manifest: snapshot
            .definition()
            .manifest()
            .map(|_| crate::project::MANIFEST_FILE.to_string()),
        entrypoint_origin: origin_name(snapshot.entrypoint_origin()),
        entrypoints: snapshot.entrypoints().iter().map(Into::into).collect(),
        discovered: snapshot.discovered().iter().map(Into::into).collect(),
        nodes: snapshot.nodes().map(node_dto).collect(),
        edges: snapshot.edges().iter().map(Into::into).collect(),
        issues: snapshot.issues().iter().map(Into::into).collect(),
        compilable: snapshot.compilation_plan().is_ok(),
    }
}

fn node_dto(node: &SourceNode) -> SourceNodeDto {
    SourceNodeDto {
        id: (&node.id).into(),
        readable: node.readable,
    }
}

#[cfg(test)]
mod tests;
