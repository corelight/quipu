//! Machine-readable problems found while analyzing a project.
//!
//! Every issue carries a stable kebab-case [`ProjectIssue::code`] and a
//! [`Severity`], so a later IPC layer and the Includes view can map issues
//! without parsing human-readable text. `message()` exists for logs and
//! tooltips only.
//!
//! [`IssueScope`] is the other half of the contract: it decides whether an
//! issue only matters when the file it names is part of a compilation plan
//! ([`IssueScope::Source`]) or invalidates every plan for the project
//! ([`IssueScope::Project`]).

use super::SourceId;

/// A byte range within one source file.
///
/// Mirrors `yara_x_parser::Span`, which is what the parser reports, but is
/// owned so issues outlive the AST that produced them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct ByteSpan {
    pub start: u32,
    pub end: u32,
}

impl From<yara_x_parser::Span> for ByteSpan {
    fn from(span: yara_x_parser::Span) -> Self {
        Self {
            start: span.start() as u32,
            end: span.end() as u32,
        }
    }
}

/// Whether an issue prevents compilation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Severity {
    /// Compilation of the affected plan cannot be trusted.
    Blocking,
    /// Worth showing, but compilation proceeds.
    Informational,
}

/// How far a blocking issue reaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum IssueScope {
    /// Blocks only the plans whose source closure contains the named file.
    /// This is what lets a broken file that no entrypoint reaches stay visible
    /// in the snapshot without blocking an explicit compilation plan.
    Source,
    /// Blocks every plan for the project: the analysis itself is incomplete or
    /// the configuration is wrong, so no closure can be trusted.
    Project,
}

/// The problems the analyzer can report, with their structured payloads.
///
/// Variant order is part of the deterministic issue ordering (see
/// [`ProjectIssue`]), so new variants should be appended rather than inserted.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum IssueKind {
    /// A manifest or definition problem found while analyzing (as opposed to
    /// while loading) the project - typically a declared entrypoint that is
    /// not on disk. Load-time problems are [`super::ConfigError`]s.
    InvalidConfiguration { detail: String },
    /// A directory below the project root could not be listed, so discovery is
    /// incomplete.
    UnreadableDirectory { path: String, error: String },
    /// Discovery stopped descending at [`super::discovery::MAX_DEPTH`].
    /// Reported rather than silently truncated.
    DiscoveryDepthExceeded { path: String, limit: usize },
    /// A graph node exists but its bytes could not be read.
    UnreadableSource { error: String },
    /// The YARA parser rejected part of a source file.
    ParserError { message: String, span: ByteSpan },
    /// An `include` directive matched none of its search candidates.
    MissingInclude {
        include: String,
        span: ByteSpan,
        searched: Vec<String>,
    },
    /// An `include` chain returns to a file already being expanded. `members`
    /// is the cycle in inclusion order, rotated to start at its lowest
    /// identity so the same cycle always reports identically.
    IncludeCycle {
        members: Vec<SourceId>,
        include: String,
        span: ByteSpan,
    },
    /// YARA-X would expand this file more than once for the analyzed
    /// entrypoints, which duplicates its rule definitions. The count is capped
    /// (see `graph::expansion_counts`); it proves "more than once", it is not
    /// an exact path count.
    RepeatedInclusion { expansions_at_least: u32 },
    /// A discovered file that no inferred root reaches. Only possible when a
    /// rootless cycle swallows it, so it invalidates the inferred project.
    UnreachableSource,
    /// A resolved dependency lives outside the project root. Informational:
    /// sharing a sibling rule directory is a supported layout.
    ExternalDependency,
    /// A directory entry could not be inspected or resolved, so discovery is
    /// incomplete. Project-scoped for the same reason as
    /// [`Self::UnreadableDirectory`]: the file never becomes a graph node, so a
    /// source-scoped report could never block a plan.
    ///
    /// Appended out of logical order because variant order is part of the issue
    /// sort key; see the note above.
    UnreadableEntry { path: String, error: String },
    /// A path that is not valid Unicode, and therefore has no identity (see
    /// `paths::to_slash`). `path` is escaped for display and is unique per file,
    /// but it is not an identity and must not be used as one.
    ///
    /// Appended for the same reason as [`Self::UnreadableEntry`].
    NonUnicodePath { path: String },
}

impl IssueKind {
    /// A stable identifier for IPC and UI mapping. Matches the style of the
    /// existing compile diagnostics' `code` field.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::InvalidConfiguration { .. } => "invalid-configuration",
            Self::UnreadableDirectory { .. } => "unreadable-directory",
            Self::DiscoveryDepthExceeded { .. } => "discovery-depth-exceeded",
            Self::UnreadableSource { .. } => "unreadable-source",
            Self::ParserError { .. } => "parser-error",
            Self::MissingInclude { .. } => "missing-include",
            Self::IncludeCycle { .. } => "include-cycle",
            Self::RepeatedInclusion { .. } => "repeated-inclusion",
            Self::UnreachableSource => "unreachable-source",
            Self::ExternalDependency => "external-dependency",
            Self::UnreadableEntry { .. } => "unreadable-entry",
            Self::NonUnicodePath { .. } => "non-unicode-path",
        }
    }

    pub(crate) fn severity(&self) -> Severity {
        match self {
            Self::ExternalDependency => Severity::Informational,
            _ => Severity::Blocking,
        }
    }

    pub(crate) fn scope(&self) -> IssueScope {
        match self {
            // Either the configuration is wrong or discovery is incomplete;
            // in both cases entrypoint inference and the closure are suspect.
            Self::InvalidConfiguration { .. }
            | Self::UnreadableDirectory { .. }
            | Self::DiscoveryDepthExceeded { .. }
            | Self::UnreachableSource
            | Self::UnreadableEntry { .. }
            | Self::NonUnicodePath { .. } => IssueScope::Project,
            _ => IssueScope::Source,
        }
    }

    /// The byte range the problem points at within the file it is attributed to,
    /// for the kinds that have one.
    ///
    /// `None` is not "offset zero": a configuration or discovery problem is about
    /// a *path*, so it has no position in any file's bytes. Matching exhaustively
    /// rather than defaulting keeps that distinction true as kinds are added.
    pub(crate) fn span(&self) -> Option<ByteSpan> {
        match self {
            Self::ParserError { span, .. }
            | Self::MissingInclude { span, .. }
            | Self::IncludeCycle { span, .. } => Some(*span),
            Self::InvalidConfiguration { .. }
            | Self::UnreadableDirectory { .. }
            | Self::DiscoveryDepthExceeded { .. }
            | Self::UnreadableSource { .. }
            | Self::RepeatedInclusion { .. }
            | Self::UnreachableSource
            | Self::ExternalDependency
            | Self::UnreadableEntry { .. }
            | Self::NonUnicodePath { .. } => None,
        }
    }
}

/// One problem, attributed to the file it was found in where that is
/// meaningful.
///
/// The derived ordering is `(at, kind)`: project-wide issues (`at` is `None`)
/// come first, then issues grouped by source identity and, within a file, by
/// [`IssueKind`] variant order. Analyses sort their issues with it, which is
/// what makes repeated analyses of an unchanged project byte-identical.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct ProjectIssue {
    /// The source the problem belongs to. `None` for problems that are not
    /// attributable to a single file (configuration, discovery).
    pub at: Option<SourceId>,
    pub kind: IssueKind,
}

impl ProjectIssue {
    pub(crate) fn at(source: SourceId, kind: IssueKind) -> Self {
        Self {
            at: Some(source),
            kind,
        }
    }

    pub(crate) fn project(kind: IssueKind) -> Self {
        Self { at: None, kind }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.kind.code()
    }

    pub(crate) fn severity(&self) -> Severity {
        self.kind.severity()
    }

    pub(crate) fn scope(&self) -> IssueScope {
        self.kind.scope()
    }

    /// Only meaningful next to [`Self::severity`]; kept for callers that read as
    /// a question rather than a comparison.
    #[allow(dead_code)] // used by the model's tests
    pub(crate) fn is_blocking(&self) -> bool {
        self.severity() == Severity::Blocking
    }

    pub(crate) fn span(&self) -> Option<ByteSpan> {
        self.kind.span()
    }

    /// A one-line description for logs and tooltips.
    ///
    /// Deliberately never contains source file *contents*: paths, include
    /// spellings and parser messages only.
    pub(crate) fn message(&self) -> String {
        let where_ = match &self.at {
            Some(id) => format!("{id}: "),
            None => String::new(),
        };
        let what = match &self.kind {
            IssueKind::InvalidConfiguration { detail } => detail.clone(),
            IssueKind::UnreadableDirectory { path, error } => {
                format!("cannot list directory {path}: {error}")
            }
            IssueKind::DiscoveryDepthExceeded { path, limit } => {
                format!("stopped discovery below {path}: deeper than {limit} directories")
            }
            IssueKind::UnreadableSource { error } => format!("cannot read source: {error}"),
            IssueKind::ParserError { message, span } => {
                format!(
                    "syntax error at bytes {}..{}: {message}",
                    span.start, span.end
                )
            }
            IssueKind::MissingInclude {
                include, searched, ..
            } => format!(
                "include \"{include}\" not found (searched {} candidate location(s))",
                searched.len()
            ),
            IssueKind::IncludeCycle {
                members, include, ..
            } => format!(
                "include \"{include}\" closes a cycle: {}",
                members
                    .iter()
                    .map(|m| m.path.as_str())
                    .collect::<Vec<_>>()
                    .join(" -> ")
            ),
            IssueKind::RepeatedInclusion {
                expansions_at_least,
            } => format!(
                "would be included {expansions_at_least} or more times, duplicating its rules"
            ),
            IssueKind::UnreachableSource => {
                "not reachable from any inferred entrypoint".to_string()
            }
            IssueKind::ExternalDependency => "resolved outside the project root".to_string(),
            IssueKind::UnreadableEntry { path, error } => {
                format!("cannot inspect {path}: {error}")
            }
            IssueKind::NonUnicodePath { path } => {
                format!("path {path} is not valid Unicode, so it has no stable identity")
            }
        };
        format!("{where_}{what}")
    }
}
