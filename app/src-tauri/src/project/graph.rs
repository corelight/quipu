//! Building and analyzing a project's include graph.
//!
//! The result is a [`ProjectSnapshot`]: a directed graph, not a tree. Two
//! sources may include the same dependency, a dependency may be reached by
//! several paths, and a chain may loop back on itself. All three are things the
//! analysis has to say something useful about.
//!
//! # Include resolution
//!
//! For an `include` in file A, candidates are tried in this order:
//!
//! 1. A's containing directory;
//! 2. each configured include directory, in declared order.
//!
//! The first existing regular file wins and is canonicalized for identity.
//! Multiple matches are not "ambiguous": YARA-X takes the first, so we do too.
//!
//! This mirrors `yara_x::Compiler::read_included_file`, which searches the
//! parent of the file at the top of its include stack before falling back to
//! the configured include directories. One deliberate difference: YARA-X's
//! include stack is empty while it processes a source passed to `add_source`,
//! so it does *not* search an entrypoint's own directory. This model applies
//! the parent-first rule to entrypoints as well, because that is the semantics
//! a user expects. [`crate::compile`] makes the compiler agree, by reaching each
//! entrypoint through an `include` of its own rather than handing it to
//! `add_source` directly.
//!
//! # Repeated inclusion
//!
//! YARA-X prevents *cycles* with its active include stack, but it does not
//! include each file only once globally. A file reached twice is expanded - and
//! therefore compiled - twice, which duplicates its rule identifiers. The
//! analysis detects that with expansion counts capped at two: proving "more
//! than once" never requires enumerating paths.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use super::discovery;
use super::includes;
use super::issues::{ByteSpan, IssueKind, ProjectIssue, Severity};
use super::manifest::ProjectDefinition;
use super::paths;
use super::{EntrypointOrigin, SourceId};

/// One node of the include graph.
#[derive(Clone, Debug)]
pub(crate) struct SourceNode {
    pub id: SourceId,
    /// Canonical absolute path, used for every filesystem access.
    pub canonical: PathBuf,
    /// False when the bytes could not be read. The node is kept either way, so
    /// the graph can show a dependency that exists but is unusable.
    pub readable: bool,
    /// Evidence from the exact bytes parsed for this snapshot. A valid
    /// compilation plan contains only nodes with evidence.
    pub evidence: Option<SourceEvidence>,
    /// Indices into [`ProjectSnapshot::edges`], in source order.
    pub outgoing: Vec<usize>,
}

/// Content evidence captured from the same read the include parser consumes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SourceEvidence {
    pub bytes: u64,
    pub digest: [u8; 32],
}

/// One parsed `include` directive and what it resolved to.
#[derive(Clone, Debug)]
pub(crate) struct IncludeEdge {
    /// The file containing the directive.
    pub from: SourceId,
    /// Position among the includes declared by `from`, starting at zero. Two
    /// edges with the same `from` and `raw` but different `order` are the same
    /// file included twice.
    pub order: usize,
    /// The include filename as written.
    pub raw: String,
    /// Byte span of the directive within `from`.
    pub span: ByteSpan,
    /// The resolved target, or `None` when no candidate existed.
    pub to: Option<SourceId>,
    /// The candidate locations resolution tried, in order, ending at the one
    /// that won. Native paths, so a candidate that is not valid Unicode is still
    /// usable by callers that touch the filesystem rather than the wire.
    ///
    /// The list stops at the winner because that is exactly the set whose
    /// contents can change this edge's outcome: an *earlier* candidate appearing
    /// would shadow the resolved target, whereas a later one is never reached.
    pub candidates: Vec<PathBuf>,
}

/// A point-in-time analysis of a project.
///
/// The snapshot describes the whole project, including files no entrypoint can
/// reach, so the future Includes view can show a broken graph. Deciding whether
/// something is compilable is [`super::CompilationPlan`]'s job.
#[derive(Debug)]
pub(crate) struct ProjectSnapshot {
    definition: ProjectDefinition,
    nodes: BTreeMap<SourceId, SourceNode>,
    edges: Vec<IncludeEdge>,
    discovered: Vec<SourceId>,
    entrypoints: Vec<SourceId>,
    entrypoint_origin: EntrypointOrigin,
    issues: Vec<ProjectIssue>,
}

impl ProjectSnapshot {
    /// Analyzes `definition`: discovers project files, resolves the complete
    /// include graph, determines entrypoints and reports every problem found.
    pub(crate) fn analyze(definition: ProjectDefinition) -> Self {
        let mut snapshot = build_graph(definition);

        let adjacency = snapshot.adjacency();
        snapshot.issues.extend(detect_cycles(&snapshot, &adjacency));

        if snapshot.entrypoint_origin == EntrypointOrigin::Inferred {
            let (roots, unreachable) = infer_entrypoints(&snapshot, &adjacency);
            snapshot.entrypoints = roots;
            snapshot.issues.extend(
                unreachable
                    .into_iter()
                    .map(|id| ProjectIssue::at(id, IssueKind::UnreachableSource)),
            );
        }

        snapshot
            .issues
            .extend(detect_repeated_inclusion(&snapshot, &adjacency));

        snapshot.issues.sort();
        snapshot.issues.dedup();
        snapshot
    }

    pub(crate) fn definition(&self) -> &ProjectDefinition {
        &self.definition
    }

    /// Every graph node, ordered by identity (internal before external).
    pub(crate) fn nodes(&self) -> impl Iterator<Item = &SourceNode> {
        self.nodes.values()
    }

    pub(crate) fn node(&self, id: &SourceId) -> Option<&SourceNode> {
        self.nodes.get(id)
    }

    /// Every include directive, ordered by `(from, order)`.
    pub(crate) fn edges(&self) -> &[IncludeEdge] {
        &self.edges
    }

    /// The includes declared by one file, in source order.
    pub(crate) fn edges_from(&self, id: &SourceId) -> impl Iterator<Item = &IncludeEdge> {
        self.nodes
            .get(id)
            .into_iter()
            .flat_map(|node| node.outgoing.iter().map(|&i| &self.edges[i]))
    }

    /// Project files found by discovery, ordered by identity.
    pub(crate) fn discovered(&self) -> &[SourceId] {
        &self.discovered
    }

    /// The effective entrypoints: manifest order when declared, identity order
    /// when inferred.
    pub(crate) fn entrypoints(&self) -> &[SourceId] {
        &self.entrypoints
    }

    pub(crate) fn entrypoint_origin(&self) -> EntrypointOrigin {
        self.entrypoint_origin
    }

    /// Every problem found, in the model's canonical issue order.
    pub(crate) fn issues(&self) -> &[ProjectIssue] {
        &self.issues
    }

    pub(crate) fn blocking_issues(&self) -> impl Iterator<Item = &ProjectIssue> {
        self.issues
            .iter()
            .filter(|i| i.severity() == Severity::Blocking)
    }

    /// The complete set of nodes reachable from `roots` by following resolved
    /// include edges, ordered by identity and containing each node once.
    pub(crate) fn closure_of(&self, roots: &[SourceId]) -> Vec<SourceId> {
        let adjacency = self.adjacency();
        let mut reached: Vec<SourceId> = adjacency
            .reachable(roots)
            .into_iter()
            .map(|index| adjacency.ids[index].clone())
            .collect();
        reached.sort();
        reached
    }

    /// Index-based view of the graph, built on demand for the traversals.
    fn adjacency(&self) -> Adjacency {
        Adjacency::new(&self.nodes, &self.edges)
    }
}

/// Discovers files, then parses and resolves until the graph is closed.
fn build_graph(definition: ProjectDefinition) -> ProjectSnapshot {
    let mut builder = Builder::new(&definition);

    // Declared entrypoints are seeded first so a project whose manifest points
    // at a file outside the discovery set still gets a complete closure.
    let mut entrypoints = Vec::new();
    for relative in definition.declared_entrypoints() {
        match resolve_declared_entrypoint(definition.root(), relative) {
            Ok(canonical) => entrypoints.extend(builder.node_for(canonical)),
            Err(detail) => {
                builder
                    .issues
                    .push(ProjectIssue::project(IssueKind::InvalidConfiguration {
                        detail,
                    }))
            }
        }
    }

    // Every discovered file is seeded too, whether or not an entrypoint reaches
    // it: problems in an unrelated file must stay visible in the snapshot.
    let found = discovery::discover(&definition);
    builder.issues.extend(found.issues);
    let mut discovered: Vec<SourceId> = found
        .files
        .into_iter()
        .filter_map(|f| builder.node_for(f.canonical))
        .collect();
    discovered.sort();
    discovered.dedup();

    builder.drain();

    let entrypoint_origin = if definition.declared_entrypoints().is_empty() {
        EntrypointOrigin::Inferred
    } else {
        EntrypointOrigin::Declared
    };

    let Builder {
        mut nodes,
        mut edges,
        mut issues,
        ..
    } = builder;

    // Edges are appended per file as the queue drains; sorting them by
    // (from, order) makes the edge list itself independent of traversal order.
    edges.sort_by(|a, b| (&a.from, a.order).cmp(&(&b.from, b.order)));
    for node in nodes.values_mut() {
        node.outgoing.clear();
    }
    for (index, edge) in edges.iter().enumerate() {
        if let Some(node) = nodes.get_mut(&edge.from) {
            node.outgoing.push(index);
        }
    }

    // External dependencies are informational, one per external node.
    for id in nodes.keys() {
        if id.external {
            issues.push(ProjectIssue::at(id.clone(), IssueKind::ExternalDependency));
        }
    }

    ProjectSnapshot {
        definition,
        nodes,
        edges,
        discovered,
        entrypoints,
        entrypoint_origin,
        issues,
    }
}

/// Resolves a declared entrypoint to a canonical path, describing why not.
///
/// `normalize_inside_root` already proved the *declaration* stays inside the
/// project, but that is lexical: a symlink can still point out of the tree. The
/// canonical target is therefore checked against the (canonical) root, so a
/// declared entrypoint can never become an external source. Files reached by an
/// `include`, by contrast, are allowed outside the root - that is the documented
/// external-dependency case.
fn resolve_declared_entrypoint(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(root.join(relative))
        .map_err(|e| format!("entrypoint \"{relative}\" is unavailable: {e}"))?;
    if !canonical.starts_with(root) {
        return Err(format!(
            "entrypoint \"{relative}\" resolves outside the project root"
        ));
    }
    if !canonical.is_file() {
        return Err(format!("entrypoint \"{relative}\" is not a regular file"));
    }
    Ok(canonical)
}

/// Incremental graph construction: a worklist of canonical paths to parse.
struct Builder<'a> {
    definition: &'a ProjectDefinition,
    /// Canonical path to identity, so a file reached by several spellings
    /// becomes one node.
    ids: HashMap<PathBuf, SourceId>,
    nodes: BTreeMap<SourceId, SourceNode>,
    edges: Vec<IncludeEdge>,
    issues: Vec<ProjectIssue>,
    queue: VecDeque<(SourceId, PathBuf)>,
}

impl<'a> Builder<'a> {
    fn new(definition: &'a ProjectDefinition) -> Self {
        Self {
            definition,
            ids: HashMap::new(),
            nodes: BTreeMap::new(),
            edges: Vec::new(),
            issues: Vec::new(),
            queue: VecDeque::new(),
        }
    }

    /// Returns the identity for a canonical path, creating and queueing the
    /// node the first time it is seen.
    ///
    /// `None` when the path has no identity because it is not valid Unicode. The
    /// file is reported and left out of the graph rather than merged with any
    /// other non-Unicode path, which a lossy conversion would do.
    fn node_for(&mut self, canonical: PathBuf) -> Option<SourceId> {
        if let Some(id) = self.ids.get(&canonical) {
            return Some(id.clone());
        }
        let Some(id) = SourceId::for_path(&canonical, self.definition.root()) else {
            self.issues
                .push(ProjectIssue::project(IssueKind::NonUnicodePath {
                    path: paths::escaped(&canonical),
                }));
            return None;
        };
        self.ids.insert(canonical.clone(), id.clone());
        self.nodes.insert(
            id.clone(),
            SourceNode {
                id: id.clone(),
                canonical: canonical.clone(),
                readable: true,
                evidence: None,
                outgoing: Vec::new(),
            },
        );
        self.queue.push_back((id.clone(), canonical));
        Some(id)
    }

    /// Parses queued sources until nothing new is reached. Termination is
    /// guaranteed by identity: every node is queued once, and identities are
    /// canonical paths, of which the filesystem has finitely many.
    fn drain(&mut self) {
        while let Some((id, canonical)) = self.queue.pop_front() {
            self.parse(&id, &canonical);
        }
    }

    fn parse(&mut self, id: &SourceId, canonical: &Path) {
        let bytes = match std::fs::read(canonical) {
            Ok(bytes) => bytes,
            Err(err) => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.readable = false;
                }
                self.issues.push(ProjectIssue::at(
                    id.clone(),
                    IssueKind::UnreadableSource {
                        error: err.to_string(),
                    },
                ));
                return;
            }
        };

        if let Some(node) = self.nodes.get_mut(id) {
            node.evidence = Some(SourceEvidence {
                bytes: bytes.len() as u64,
                digest: *blake3::hash(&bytes).as_bytes(),
            });
        }

        let parsed = includes::parse_source(&bytes);
        for (message, span) in parsed.errors {
            self.issues.push(ProjectIssue::at(
                id.clone(),
                IssueKind::ParserError { message, span },
            ));
        }

        for (order, include) in parsed.includes.into_iter().enumerate() {
            let (target, candidates) =
                resolve_include(self.definition, canonical, &include.file_name);
            let to = match target {
                // A resolved target with no identity leaves the edge unresolved
                // but is *not* a missing include: it exists. `node_for` has
                // already reported it, and that report blocks every plan.
                Some(path) => self.node_for(path),
                None => {
                    self.issues.push(ProjectIssue::at(
                        id.clone(),
                        IssueKind::MissingInclude {
                            include: include.file_name.clone(),
                            span: include.span,
                            // A candidate location is diagnostic text, not an
                            // identity, so an unrepresentable one is escaped
                            // rather than dropped.
                            searched: candidates.iter().map(|p| paths::escaped(p)).collect(),
                        },
                    ));
                    None
                }
            };
            self.edges.push(IncludeEdge {
                from: id.clone(),
                order,
                raw: include.file_name,
                span: include.span,
                to,
                candidates,
            });
        }
    }
}

/// Resolves one include, returning the target and every candidate tried.
///
/// The candidate list is bounded by `1 + include_dirs.len()`, so resolution
/// never enumerates paths open-endedly.
///
/// A free function rather than a method on the builder because the candidate
/// order *is* the compiler's search order, and anything that needs to know which
/// locations decide an include - `crate::watch`, deciding what to watch - has to
/// ask this same code rather than reimplement it.
pub(crate) fn resolve_include(
    definition: &ProjectDefinition,
    from: &Path,
    raw: &str,
) -> (Option<PathBuf>, Vec<PathBuf>) {
    let mut dirs: Vec<&Path> = Vec::with_capacity(definition.include_dirs().len() + 1);
    if let Some(parent) = from.parent() {
        dirs.push(parent);
    }
    for dir in definition.include_dirs() {
        // The parent may also be a configured include directory; trying it
        // twice cannot change the outcome and only clutters diagnostics.
        if !dirs.contains(&dir.path()) {
            dirs.push(dir.path());
        }
    }

    let mut searched = Vec::with_capacity(dirs.len());
    for dir in dirs {
        let candidate = dir.join(raw);
        searched.push(candidate.clone());
        // Canonicalizing proves existence and collapses `.`, `..` and
        // symlinks into the identity the rest of the model compares by.
        if let Ok(canonical) = std::fs::canonicalize(&candidate)
            && canonical.is_file()
        {
            return (Some(canonical), searched);
        }
    }
    (None, searched)
}

/// Index-based view of the graph for the traversals.
struct Adjacency {
    /// Node index to identity, in the snapshot's node order.
    ids: Vec<SourceId>,
    index: HashMap<SourceId, usize>,
    /// Resolved outgoing edges per node, in source order: `(edge, target)`.
    out: Vec<Vec<(usize, usize)>>,
}

impl Adjacency {
    fn new(nodes: &BTreeMap<SourceId, SourceNode>, edges: &[IncludeEdge]) -> Self {
        let ids: Vec<SourceId> = nodes.keys().cloned().collect();
        let index: HashMap<SourceId, usize> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.clone(), i))
            .collect();
        let mut out = vec![Vec::new(); ids.len()];
        for (edge_index, edge) in edges.iter().enumerate() {
            let (Some(&from), Some(to)) = (
                index.get(&edge.from),
                edge.to.as_ref().and_then(|to| index.get(to)).copied(),
            ) else {
                continue;
            };
            out[from].push((edge_index, to));
        }
        Self { ids, index, out }
    }

    fn len(&self) -> usize {
        self.ids.len()
    }

    /// Node indices reachable from `roots`, including the roots themselves.
    fn reachable(&self, roots: &[SourceId]) -> HashSet<usize> {
        let mut seen: HashSet<usize> = HashSet::new();
        let mut pending: Vec<usize> = roots
            .iter()
            .filter_map(|id| self.index.get(id).copied())
            .collect();
        for &start in &pending {
            seen.insert(start);
        }
        while let Some(node) = pending.pop() {
            for &(_, target) in &self.out[node] {
                if seen.insert(target) {
                    pending.push(target);
                }
            }
        }
        seen
    }
}

/// Finds include cycles.
///
/// Depth-first search over every node reports one cycle per back edge, which is
/// what YARA-X's include stack would hit. It deliberately does not enumerate
/// every simple cycle: that is exponential, and one report per back edge is
/// enough to make the project invalid and point at the offending include.
///
/// Each cycle's member list is rotated to start at its lowest identity and the
/// set is deduplicated, so the same cycle always reports identically no matter
/// which node the search entered it from.
fn detect_cycles(snapshot: &ProjectSnapshot, adjacency: &Adjacency) -> Vec<ProjectIssue> {
    const WHITE: u8 = 0;
    const GREY: u8 = 1;
    const BLACK: u8 = 2;

    let mut state = vec![WHITE; adjacency.len()];
    let mut position: Vec<Option<usize>> = vec![None; adjacency.len()];
    let mut cycles: Vec<Vec<SourceId>> = Vec::new();

    for start in 0..adjacency.len() {
        if state[start] != WHITE {
            continue;
        }
        let mut path: Vec<usize> = Vec::new();
        // Each frame is a node and how many of its edges have been taken.
        let mut stack: Vec<(usize, usize)> = vec![(start, 0)];
        state[start] = GREY;
        position[start] = Some(0);
        path.push(start);

        while let Some(&(node, next)) = stack.last() {
            if next < adjacency.out[node].len() {
                let (_, target) = adjacency.out[node][next];
                stack.last_mut().expect("frame just observed").1 += 1;
                match state[target] {
                    GREY => {
                        // Grey means the target is on the current path, so the
                        // slice from its position to the end is the cycle.
                        let from = position[target].expect("grey nodes are on the path");
                        cycles.push(
                            path[from..]
                                .iter()
                                .map(|&i| adjacency.ids[i].clone())
                                .collect(),
                        );
                    }
                    WHITE => {
                        state[target] = GREY;
                        position[target] = Some(path.len());
                        path.push(target);
                        stack.push((target, 0));
                    }
                    _ => {}
                }
            } else {
                state[node] = BLACK;
                position[node] = None;
                path.pop();
                stack.pop();
            }
        }
    }

    for members in &mut cycles {
        rotate_to_lowest(members);
    }
    cycles.sort();
    cycles.dedup();

    cycles
        .into_iter()
        .map(|members| {
            // After rotation the closing include is the one from the last member
            // back to the first.
            let last = members.last().expect("a cycle has members").clone();
            let first = members[0].clone();
            let closing = snapshot
                .edges_from(&last)
                .find(|edge| edge.to.as_ref() == Some(&first));
            let (include, span) = closing
                .map(|edge| (edge.raw.clone(), edge.span))
                .unwrap_or_else(|| (first.path.clone(), ByteSpan::default()));
            ProjectIssue::at(
                last,
                IssueKind::IncludeCycle {
                    members,
                    include,
                    span,
                },
            )
        })
        .collect()
}

/// Rotates a cycle so its lowest identity comes first, preserving cyclic order.
fn rotate_to_lowest(members: &mut [SourceId]) {
    let Some(lowest) = members
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| a.cmp(b))
        .map(|(i, _)| i)
    else {
        return;
    };
    members.rotate_left(lowest);
}

/// Infers entrypoints from the graph and reports files no root can reach.
///
/// Roots are the discovered project files nothing includes. Independent files
/// with no includes at all are therefore valid roots, and so is every file at
/// the head of a chain. A file that is neither a root nor reachable from one can
/// only have been swallowed by a rootless cycle, which must not be silently
/// dropped: it is reported and invalidates the inferred project.
fn infer_entrypoints(
    snapshot: &ProjectSnapshot,
    adjacency: &Adjacency,
) -> (Vec<SourceId>, Vec<SourceId>) {
    let mut indegree = vec![0usize; adjacency.len()];
    for edges in &adjacency.out {
        for &(_, target) in edges {
            indegree[target] += 1;
        }
    }

    // `discovered` is already sorted by identity, so the roots are too.
    let roots: Vec<SourceId> = snapshot
        .discovered
        .iter()
        .filter(|id| adjacency.index.get(*id).is_some_and(|&i| indegree[i] == 0))
        .cloned()
        .collect();

    let reachable = adjacency.reachable(&roots);
    let unreachable: Vec<SourceId> = snapshot
        .discovered
        .iter()
        .filter(|id| {
            !adjacency
                .index
                .get(*id)
                .is_some_and(|i| reachable.contains(i))
        })
        .cloned()
        .collect();

    (roots, unreachable)
}

/// Reports sources YARA-X would expand more than once for these entrypoints.
///
/// Counts are capped at two: the question is only ever "once, or more than
/// once", so no path enumeration is needed. Skipped when the closure contains a
/// cycle, because a cycle already invalidates the plan and makes expansion
/// counting meaningless.
fn detect_repeated_inclusion(
    snapshot: &ProjectSnapshot,
    adjacency: &Adjacency,
) -> Vec<ProjectIssue> {
    const CAP: u32 = 2;

    let closure = adjacency.reachable(&snapshot.entrypoints);
    if closure.is_empty() {
        return Vec::new();
    }

    // Kahn's algorithm over the closure only; a leftover node means a cycle.
    let mut indegree: HashMap<usize, usize> = closure.iter().map(|&n| (n, 0)).collect();
    for &node in &closure {
        for &(_, target) in &adjacency.out[node] {
            if let Some(count) = indegree.get_mut(&target) {
                *count += 1;
            }
        }
    }

    let mut counts: HashMap<usize, u32> = closure.iter().map(|&n| (n, 0)).collect();
    for entry in &snapshot.entrypoints {
        if let Some(count) = adjacency
            .index
            .get(entry)
            .and_then(|node| counts.get_mut(node))
        {
            *count = (*count + 1).min(CAP);
        }
    }

    let mut ready: Vec<usize> = indegree
        .iter()
        .filter(|&(_, &degree)| degree == 0)
        .map(|(&node, _)| node)
        .collect();
    ready.sort_unstable();
    let mut ordered = 0usize;
    while let Some(node) = ready.pop() {
        ordered += 1;
        let count = counts.get(&node).copied().unwrap_or(0);
        for &(_, target) in &adjacency.out[node] {
            if let Some(target_count) = counts.get_mut(&target) {
                *target_count = target_count.saturating_add(count).min(CAP);
            }
            if let Some(degree) = indegree.get_mut(&target) {
                *degree -= 1;
                if *degree == 0 {
                    ready.push(target);
                }
            }
        }
    }
    if ordered != closure.len() {
        return Vec::new(); // cyclic closure; already reported as a cycle
    }

    let mut repeated: Vec<ProjectIssue> = counts
        .into_iter()
        .filter(|&(_, count)| count >= CAP)
        .map(|(node, count)| {
            ProjectIssue::at(
                adjacency.ids[node].clone(),
                IssueKind::RepeatedInclusion {
                    expansions_at_least: count,
                },
            )
        })
        .collect();
    repeated.sort();
    repeated
}
