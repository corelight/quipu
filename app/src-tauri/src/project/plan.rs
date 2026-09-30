//! The deterministic compilation plan derived from a snapshot.
//!
//! A [`ProjectSnapshot`] describes a project as it is, including what is wrong
//! with it. A [`CompilationPlan`] is the narrower question "what exactly would
//! be compiled, in what order": ordered entrypoints, ordered include
//! directories and the complete resolved source closure.
//!
//! The two are separate on purpose. A future Includes view has to render a
//! project whose graph is broken, which means analysis must never refuse to
//! produce a result; deciding that a graph is not compilable belongs here, in
//! one place, behind one call.
//!
//! Everything in a plan is derived from the snapshot: same project on disk,
//! same plan, byte for byte. That determinism is what makes the plan a usable
//! cache key later - see `docs/compiled-rules-cache-design.md`. This phase adds
//! no hashing, no serialization and no cache metadata.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::graph::ProjectSnapshot;
use super::issues::{IssueKind, IssueScope, ProjectIssue};
use super::{EntrypointOrigin, SourceId};

/// One compilation input: its stable identity and where to read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlanInput {
    /// Normalized identity, used for ordering and comparison.
    pub id: SourceId,
    /// Canonical absolute path, used to read the bytes.
    pub canonical: PathBuf,
    /// Length and digest of the exact bytes parsed into this snapshot.
    pub evidence: super::SourceEvidence,
}

/// One resolved include edge in the selected closure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlanEdge {
    pub from: SourceId,
    pub order: usize,
    pub raw: String,
    pub to: SourceId,
}

/// A validated, deterministic description of what to compile.
#[derive(Clone, Debug)]
pub(crate) struct CompilationPlan {
    // Deferred: the root and the entrypoint origin are part of what a plan
    // *is* and what the future cache layer will hash (see
    // `docs/compiled-rules-cache-design.md`), but compilation itself needs
    // neither - it reads canonical paths and compiles entrypoints in order.
    #[allow(dead_code)]
    pub(super) root: PathBuf,
    #[allow(dead_code)]
    pub(super) origin: EntrypointOrigin,
    pub(super) entrypoints: Vec<PlanInput>,
    pub(super) include_dirs: Vec<PathBuf>,
    pub(super) closure: Vec<PlanInput>,
    pub(super) edges: Vec<PlanEdge>,
}

impl CompilationPlan {
    /// Canonical project root.
    #[allow(dead_code)] // see the note on the field
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Whether the entrypoints came from the manifest or from the graph.
    #[allow(dead_code)] // see the note on the field
    pub(crate) fn entrypoint_origin(&self) -> EntrypointOrigin {
        self.origin
    }

    /// Top-level sources, in manifest order when declared and in identity order
    /// when inferred. Several independent roots are normal, not an error.
    pub(crate) fn entrypoints(&self) -> &[PlanInput] {
        &self.entrypoints
    }

    /// Include search directories in declared order; order is significant.
    pub(crate) fn include_dirs(&self) -> &[PathBuf] {
        &self.include_dirs
    }

    /// Every source the compiler will read, entrypoints included, ordered by
    /// identity and containing each canonical file exactly once.
    ///
    /// Deduplication here is about the plan being a set of inputs. It is not a
    /// claim that YARA-X would expand each file once: it would not, which is
    /// why repeated inclusion is reported separately and blocks this plan.
    pub(crate) fn closure(&self) -> &[PlanInput] {
        &self.closure
    }

    /// Resolved edges whose source is in the selected closure, ordered by
    /// `(from identity, source order)`.
    pub(crate) fn edges(&self) -> &[PlanEdge] {
        &self.edges
    }

    /// True when the project contains nothing to compile.
    ///
    /// Compilation does not branch on this: an empty plan adds no sources and
    /// builds an empty ruleset, which is the documented behaviour. Kept because
    /// "is there anything here?" is a question about a plan, and the tests ask
    /// it.
    #[allow(dead_code)]
    pub(crate) fn is_empty(&self) -> bool {
        self.entrypoints.is_empty()
    }
}

/// Why a plan could not be built.
///
/// Carries the blocking issues themselves rather than a message, so a caller
/// can render them with the same code path it uses for snapshot issues.
#[derive(Clone, Debug)]
pub(crate) struct PlanRejection {
    blocking: Vec<ProjectIssue>,
}

impl PlanRejection {
    /// The blocking issues, in the snapshot's issue order.
    pub(crate) fn blocking(&self) -> &[ProjectIssue] {
        &self.blocking
    }

    /// Stable codes of the blocking issues.
    ///
    /// IPC converts whole issues rather than codes (see `crate::compile`), so
    /// this is the tests' summary view.
    #[allow(dead_code)]
    pub(crate) fn codes(&self) -> Vec<&'static str> {
        self.blocking.iter().map(ProjectIssue::code).collect()
    }
}

impl std::fmt::Display for PlanRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the project cannot be compiled:")?;
        for issue in &self.blocking {
            write!(f, "\n  {}", issue.message())?;
        }
        Ok(())
    }
}

impl ProjectSnapshot {
    /// Derives the compilation plan for this snapshot's entrypoints.
    ///
    /// Fails when anything blocking affects the selected closure:
    ///
    /// * an invalid configuration or incomplete discovery, which makes the whole
    ///   analysis untrustworthy ([`IssueScope::Project`]);
    /// * a missing include, unreadable input, invalidating parser error, include
    ///   cycle or repeated inclusion in a file the closure contains
    ///   ([`IssueScope::Source`]).
    ///
    /// A blocking problem in a discovered file that the closure does *not*
    /// contain stays in the snapshot and does not block the plan: that is what
    /// lets explicit entrypoints compile while an unrelated file is broken.
    pub(crate) fn compilation_plan(&self) -> Result<CompilationPlan, PlanRejection> {
        let closure_ids = self.closure_of(self.entrypoints());
        let in_closure: HashSet<&SourceId> = closure_ids.iter().collect();

        let blocking: Vec<ProjectIssue> = self
            .blocking_issues()
            .filter(|issue| match issue.scope() {
                IssueScope::Project => true,
                IssueScope::Source => match &issue.at {
                    Some(id) => in_closure.contains(id),
                    // Unattributed source issues cannot be excluded safely.
                    None => true,
                },
            })
            .cloned()
            .collect();
        if !blocking.is_empty() {
            return Err(PlanRejection { blocking });
        }

        let entrypoints = self.inputs_for(self.entrypoints())?;
        let closure = self.inputs_for(&closure_ids)?;
        let edges = self
            .edges()
            .iter()
            .filter(|edge| in_closure.contains(&edge.from))
            .map(|edge| match &edge.to {
                Some(to) => Ok(PlanEdge {
                    from: edge.from.clone(),
                    order: edge.order,
                    raw: edge.raw.clone(),
                    to: to.clone(),
                }),
                None => Err(PlanRejection {
                    blocking: vec![ProjectIssue::project(IssueKind::InvalidConfiguration {
                        detail: format!(
                            "internal error: unresolved include from {} survived plan validation",
                            edge.from
                        ),
                    })],
                }),
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(CompilationPlan {
            root: self.definition().root().to_path_buf(),
            origin: self.entrypoint_origin(),
            entrypoints,
            include_dirs: self
                .definition()
                .include_dirs()
                .iter()
                .map(|dir| dir.path().to_path_buf())
                .collect(),
            closure,
            edges,
        })
    }

    /// Pairs identities with their canonical paths, preserving the given order.
    fn inputs_for(&self, ids: &[SourceId]) -> Result<Vec<PlanInput>, PlanRejection> {
        ids.iter()
            .map(|id| match self.node(id) {
                Some(node) => Ok(PlanInput {
                    id: id.clone(),
                    canonical: node.canonical.clone(),
                    evidence: node.evidence.ok_or_else(|| PlanRejection {
                        blocking: vec![ProjectIssue::project(IssueKind::InvalidConfiguration {
                            detail: format!("internal error: {id} has no source evidence"),
                        })],
                    })?,
                }),
                // Unreachable: every identity in a snapshot comes from a node.
                // Reported rather than panicking, because a plan refusing to
                // exist is always recoverable and a panic in the backend is not.
                None => Err(PlanRejection {
                    blocking: vec![ProjectIssue::project(IssueKind::InvalidConfiguration {
                        detail: format!("internal error: {id} is not in the include graph"),
                    })],
                }),
            })
            .collect()
    }
}
