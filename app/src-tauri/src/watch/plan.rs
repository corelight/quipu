//! Deriving *what to watch* from an analysed project, and *which events matter*.
//!
//! A watch plan is a set of filesystem locations plus the set of paths whose
//! contents the project actually reads. It is derived from a
//! [`ProjectSnapshot`] - never from a list of paths the frontend supplies - so
//! the watched set cannot be wider than what the analysis says the project
//! depends on.
//!
//! Nothing here knows about `notify`, Tauri or debouncing. It answers two
//! questions about paths, which is what makes both answerable in tests:
//! [`WatchPlan::targets`] (where to install watches) and
//! [`WatchPlan::is_relevant`] (whether an event could change the analysis).
//!
//! # Why directories rather than files
//!
//! Watching a file watches its *inode*. Every careful editor saves by writing a
//! temporary file and renaming it over the target, which replaces the inode: the
//! watch survives, attached to a file nothing will ever write to again. A
//! deletion and a rename are invisible for the same reason. So an external
//! source is watched through its **parent directory**, non-recursively, and the
//! project root - whose whole subtree is the project - is watched recursively.
//!
//! # Why candidate locations
//!
//! An `include` resolves to the first candidate that exists, tried in the
//! compiler's own order. A file appearing at an *earlier* candidate therefore
//! changes the answer without anything the project currently reads changing at
//! all, and a candidate that resolves to nothing today resolves to something the
//! moment a file appears there. Those locations come from the snapshot's
//! structured resolution data ([`crate::project::IncludeEdge::candidates`]),
//! which is the compiler's search order - not from parsing issue messages.
//!
//! A candidate whose directory does not exist yet is watched through its
//! **nearest existing ancestor**, so creating - or atomically moving in - the
//! missing subtree is observed. Only exact candidate parents are watched, never
//! a broad external directory recursively.
//!
//! Paths stay native ([`PathBuf`]) throughout. A path that is not valid Unicode
//! has no *identity* in the model, but it is still a path the filesystem can
//! watch, and losing that merely to support watching would be a regression.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::project::{MANIFEST_FILE, ProjectSnapshot, is_rule_file};

/// How much of a location to watch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Scope {
    /// The directory and everything under it. Used for the project root only.
    Tree,
    /// The directory's own entries, and the directory itself disappearing.
    Directory,
}

/// One location to install a watch on.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct WatchTarget {
    pub path: PathBuf,
    pub scope: Scope,
}

impl WatchTarget {
    /// Whether an event naming `path` could have come from this target's watch.
    ///
    /// Respect the installed depth even when the backend normally does so for us:
    /// Windows unwatch is asynchronous, so a removed nested watch can still deliver
    /// callbacks after this instance is narrowed to its non-recursive parent.
    pub(crate) fn covers(&self, path: &Path) -> bool {
        match self.scope {
            Scope::Tree => path.starts_with(&self.path),
            Scope::Directory => path == self.path || path.parent() == Some(self.path.as_path()),
        }
    }
}

/// What kind of change an event describes, once access-only noise is dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Change {
    /// A write to an existing path: contents or metadata.
    Content,
    /// A change to the tree itself: creation, removal, rename, or an event whose
    /// meaning the backend does not pin down.
    Structure,
}

/// Where to watch, and what counts as a change worth re-analysing for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WatchPlan {
    targets: Vec<WatchTarget>,
    /// Paths the project reads, or would read if they existed: graph nodes,
    /// include candidates, configured include directories, the manifest, the
    /// root. A write to anything else cannot change the analysis.
    inputs: BTreeSet<PathBuf>,
}

impl WatchPlan {
    /// The locations to install watches on, deduplicated and in a deterministic
    /// order. A location already covered by a recursive target is not repeated.
    pub(crate) fn targets(&self) -> &[WatchTarget] {
        &self.targets
    }

    /// The paths the project reads. Test-facing; relevance is decided by
    /// [`Self::is_relevant`].
    #[cfg(test)]
    pub(crate) fn inputs(&self) -> impl Iterator<Item = &Path> {
        self.inputs.iter().map(PathBuf::as_path)
    }

    /// Whether `path` changing in this way could change the analysis.
    ///
    /// Content changes are judged strictly: a write to a README or to an example
    /// scan target is not a reason to invalidate a compiled ruleset. Structural
    /// changes are judged conservatively, because they are ambiguous - a removed
    /// path cannot be inspected at all, and a directory moved in atomically
    /// reports only itself, never the rule files it brought with it.
    pub(crate) fn is_relevant(&self, path: &Path, change: Change) -> bool {
        if self.names_input(path) {
            return true;
        }
        match change {
            Change::Content => false,
            Change::Structure => self.encloses_input(path) || !looks_like_plain_file(path),
        }
    }

    /// Whether `path` is something the project reads, or a rule file anywhere.
    ///
    /// Any `.yar`/`.yara` file counts even when the snapshot has never seen it:
    /// discovery would pick it up, so its appearance is exactly the change that
    /// has to be noticed.
    fn names_input(&self, path: &Path) -> bool {
        self.inputs.contains(path) || is_rule_file(path)
    }

    /// Whether `path` is an ancestor of something the project reads, so removing
    /// or renaming it takes that input with it.
    fn encloses_input(&self, path: &Path) -> bool {
        self.inputs.iter().any(|input| input.starts_with(path))
    }
}

/// A path that is provably an ordinary file rather than a directory.
///
/// Directories almost never carry an extension, and one that does can be
/// inspected when it exists. A path that has been removed cannot be inspected,
/// which is why the extension is the first test rather than the only one.
fn looks_like_plain_file(path: &Path) -> bool {
    path.extension().is_some() && !path.is_dir()
}

/// The plan for a project that has not been analysed yet, or whose configuration
/// could not even be loaded.
///
/// Watching starts here, before the first analysis, so a change made while the
/// analysis is running schedules another one instead of being lost. It is also
/// the whole plan whenever `ProjectDefinition::load` fails: a broken
/// `quipu.toml` means there is no definition to derive anything else from, and
/// the root watch is what makes correcting the manifest recover automatically.
///
/// `requested` need not exist. When it does not, its nearest existing ancestor is
/// watched instead, so the project directory appearing is observed too.
pub(crate) fn for_root(requested: &Path) -> WatchPlan {
    let root = std::fs::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());
    let mut builder = Builder::default();
    builder.input(root.join(MANIFEST_FILE));
    builder.input(root.clone());
    if root.is_dir() {
        builder.tree(&root);
    } else {
        builder.directory(&root);
    }
    builder.build()
}

/// The plan for an analysed project.
///
/// Coverage, and why each part is needed:
///
/// * the canonical root, recursively - every internal rule file, the manifest
///   (including its creation or removal), and any subtree appearing inside;
/// * every graph node, through its parent directory, which covers the external
///   dependencies an `include` reached out of the tree for, and covers atomic
///   replacement, rename and deletion rather than only in-place writes;
/// * every configured include directory, whose direct entries decide resolution;
/// * every candidate location of every include, resolved or not, so an earlier
///   candidate appearing and shadowing the resolved target is seen;
/// * for a candidate under a directory that does not exist, its nearest existing
///   ancestor.
pub(crate) fn for_snapshot(snapshot: &ProjectSnapshot) -> WatchPlan {
    let definition = snapshot.definition();
    let root = definition.root();

    let mut builder = Builder::default();
    // Recorded as an input whether or not it exists: creating a manifest where
    // there was none, and removing one, both change the definition.
    builder.input(root.join(MANIFEST_FILE));
    builder.input(root.to_path_buf());
    builder.tree(root);

    for dir in definition.include_dirs() {
        builder.input(dir.path().to_path_buf());
        builder.directory(dir.path());
    }

    // Every node, discovered or reached by an include. `discovered` identities
    // are all nodes too, so the node list is the complete set of files the
    // project reads.
    for node in snapshot.nodes() {
        builder.input(node.canonical.clone());
        builder.containing(&node.canonical);
    }

    for edge in snapshot.edges() {
        for candidate in &edge.candidates {
            builder.input(candidate.clone());
            builder.containing(candidate);
        }
    }

    builder.build()
}

#[derive(Default)]
struct Builder {
    targets: Vec<WatchTarget>,
    inputs: BTreeSet<PathBuf>,
}

impl Builder {
    fn input(&mut self, path: PathBuf) {
        self.inputs.insert(path);
    }

    fn tree(&mut self, path: &Path) {
        self.targets.push(WatchTarget {
            path: path.to_path_buf(),
            scope: Scope::Tree,
        });
    }

    /// Watches `dir` itself, or the nearest existing ancestor when it is absent.
    fn directory(&mut self, dir: &Path) {
        if let Some(existing) = nearest_existing(dir) {
            self.targets.push(WatchTarget {
                path: existing,
                scope: Scope::Directory,
            });
        }
    }

    /// Watches the directory holding `file`, so replacing, renaming or deleting
    /// the file is observed rather than only in-place writes to its inode.
    fn containing(&mut self, file: &Path) {
        if let Some(parent) = file.parent() {
            self.directory(parent);
        }
    }

    fn build(mut self) -> WatchPlan {
        self.targets.sort();
        self.targets.dedup();

        // A recursive target already covers everything beneath it, so a separate
        // watch there would only duplicate every event it reports.
        let trees: Vec<PathBuf> = self
            .targets
            .iter()
            .filter(|t| t.scope == Scope::Tree)
            .map(|t| t.path.clone())
            .collect();
        self.targets.retain(|target| {
            !trees.iter().any(|tree| {
                let itself = tree == &target.path && target.scope == Scope::Tree;
                !itself && target.path.starts_with(tree)
            })
        });

        WatchPlan {
            targets: self.targets,
            inputs: self.inputs,
        }
    }
}

/// The closest ancestor of `path` (or `path` itself) that is a directory now.
fn nearest_existing(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.is_dir() {
            return Some(candidate.to_path_buf());
        }
        current = candidate.parent();
    }
    None
}
