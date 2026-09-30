// The Includes view's model: the project's include graph as a finite tree.
//
// The graph is a graph - diamonds, cycles, disconnected fragments and edges that
// resolve to nothing are all normal - and a tree renderer that simply followed
// edges would either duplicate shared dependencies exponentially or loop forever.
// So the whole snapshot is turned into a tree HERE, once, with the two rules that
// make it finite and honest:
//
//   * every source expands its outgoing edges AT MOST ONCE. An edge to a source
//     already expanded elsewhere is kept, and shown as a reference to it; an edge
//     to a source in the current ancestry is kept, and shown as a cycle. Either
//     way the recursion stops, so a diamond costs one extra leaf rather than a
//     duplicated subtree.
//   * nothing is dropped. Sources no entrypoint reaches are expanded under their
//     own section, so a project whose every file is part of a cycle - and which
//     therefore has no roots at all - is still fully visible, which is exactly the
//     project whose problem the user most needs to see.
//
// Issues are partitioned by SCOPE, not by whether they name a source. Some
// project-scoped issues do name one (`unreachable-source` is attributed to the
// file it is about while blocking the project as a whole), so keying off `at`
// would file a project-wide problem under one source and make it look local. The
// scope is the contract; `at` is a location.
//
// Pure and DOM-free, so termination, ordering and completeness can be tested
// without a display (see includestree.test.mjs). Rendering it is explorer.ts's job.

import type { Issue, IncludeEdge, ProjectAnalysis, SourceId, Span } from "./ipc";
import { basename, identityKey, openablePath } from "./sourceid.ts";

// What an include directive turned out to point at.
export type Resolution =
  // The target is expanded right here, with its own includes below it.
  | "resolved"
  // The target is expanded elsewhere in the tree; this is a link to it, so the
  // subtree is not duplicated.
  | "reference"
  // The target is one of this directive's own ancestors: following it would loop.
  | "cycle"
  // The include resolved to nothing. The raw text is all there is to show.
  | "unresolved";

/** An issue, with its location resolved for display where it has one. */
export interface IncludesIssue {
  issue: Issue;
  // Display label of `issue.at`, or null when the issue names no source.
  label: string | null;
  // Openable path of `issue.at`, for navigation, or null.
  path: string | null;
}

export interface IncludesSource {
  kind: "source";
  id: SourceId;
  key: string;
  // File name, for the row.
  name: string;
  // Root-relative for an internal source, canonical absolute for an external
  // one - what distinguishes two files of the same name.
  label: string;
  // Openable path, spelled under the canonical root.
  path: string;
  external: boolean;
  readable: boolean;
  entrypoint: boolean;
  // True when this node is a link to a source expanded elsewhere, rather than the
  // place it is expanded. Its `includes` are empty by construction.
  reference: boolean;
  issues: IncludesIssue[];
  includes: IncludesInclude[];
}

export interface IncludesInclude {
  kind: "include";
  // The include filename as written, which is what an unresolved edge has to show.
  raw: string;
  // Position among the declaring source's includes, as the analysis reported it.
  order: number;
  // The source the directive is written in, and its openable path - so clicking
  // the directive can reveal the directive, not the target.
  from: SourceId;
  fromPath: string;
  span: Span;
  resolution: Resolution;
  // Null only when unresolved.
  target: IncludesSource | null;
}

export type IncludesSectionId = "entrypoints" | "other" | "project";

export interface IncludesSection {
  id: IncludesSectionId;
  title: string;
  // Why this section exists, for the view to explain itself.
  hint: string;
  sources: IncludesSource[];
  issues: IncludesIssue[];
}

export interface IncludesModel {
  // Canonical root, or null when the project has no snapshot.
  root: string | null;
  // `"quipu.toml"` when the project has a manifest, else null.
  manifest: string | null;
  entrypointOrigin: "declared" | "inferred" | null;
  // False means a compile would be refused before YARA-X is invoked.
  compilable: boolean;
  // True when the analysis itself failed to produce a project (its definition is
  // broken); the project section then holds the one issue that says why.
  configurationFailed: boolean;
  sections: IncludesSection[];
  // True when there is genuinely nothing to show: no sources and no problems.
  empty: boolean;
}

/** Builds the Includes view's model from any accepted analysis. */
export function buildIncludesModel(analysis: ProjectAnalysis): IncludesModel {
  if (analysis.status !== "loaded") {
    // No snapshot can exist, so there is no graph and no source to attribute
    // anything to - but there IS a problem, and it is the only thing the user can
    // act on. It renders through the same issue path as any other.
    const section: IncludesSection = {
      id: "project",
      title: "Project problems",
      hint: "The project definition could not be read, so it has no include graph.",
      sources: [],
      issues: [{ issue: analysis.issue, label: null, path: null }],
    };
    return {
      root: null,
      manifest: null,
      entrypointOrigin: null,
      compilable: false,
      configurationFailed: true,
      sections: [section],
      empty: false,
    };
  }

  const root = analysis.root;
  const readable = new Map<string, boolean>();
  for (const node of analysis.nodes) readable.set(identityKey(node.id), node.readable);

  const entrypointKeys = new Set(analysis.entrypoints.map(identityKey));

  // Outgoing edges per source, in declaration order. The analysis already sorts
  // by `(from, order)`; sorting again keeps the view's promise about `order`
  // independent of that.
  const outgoing = new Map<string, IncludeEdge[]>();
  for (const edge of analysis.edges) {
    const key = identityKey(edge.from);
    const list = outgoing.get(key);
    if (list) list.push(edge);
    else outgoing.set(key, [edge]);
  }
  for (const list of outgoing.values()) list.sort((a, b) => a.order - b.order);

  const sourceIssues = new Map<string, IncludesIssue[]>();
  const projectIssues: IncludesIssue[] = [];
  for (const issue of analysis.issues) {
    const located: IncludesIssue = {
      issue,
      label: issue.at === null ? null : labelOf(issue.at),
      path: issue.at === null ? null : openablePath(root, issue.at),
    };
    // Scope, not `at`: a project-scoped issue that names a source still blocks the
    // project, and showing it as that source's own problem would understate it.
    if (issue.scope === "source" && issue.at !== null) {
      const key = identityKey(issue.at);
      const list = sourceIssues.get(key);
      if (list) list.push(located);
      else sourceIssues.set(key, [located]);
      continue;
    }
    projectIssues.push(located);
  }

  const expanded = new Set<string>();

  function node(id: SourceId, reference: boolean): IncludesSource {
    const key = identityKey(id);
    return {
      kind: "source",
      id,
      key,
      name: basename(id.path),
      label: labelOf(id),
      path: openablePath(root, id),
      external: id.external,
      // A source that is only a graph node - a declared entrypoint outside
      // discovery, say - is assumed readable until the analysis says otherwise;
      // marking an unknown as unreadable would invent a problem.
      readable: readable.get(key) ?? true,
      entrypoint: entrypointKeys.has(key),
      reference,
      issues: sourceIssues.get(key) ?? [],
      includes: [],
    };
  }

  // Expands `id`'s outgoing edges. `ancestry` is the chain of sources above it,
  // which is what makes a cycle detectable as such rather than as a repeat visit.
  function expand(id: SourceId, ancestry: ReadonlySet<string>): IncludesSource {
    const key = identityKey(id);
    expanded.add(key);
    const here = node(id, false);
    const below = new Set(ancestry);
    below.add(key);
    for (const edge of outgoing.get(key) ?? []) {
      here.includes.push(include(edge, below));
    }
    return here;
  }

  function include(edge: IncludeEdge, ancestry: ReadonlySet<string>): IncludesInclude {
    const base = {
      kind: "include" as const,
      raw: edge.raw,
      order: edge.order,
      from: edge.from,
      fromPath: openablePath(root, edge.from),
      span: edge.span,
    };
    // An unresolved edge is kept, not dropped: `include "missing.yar"` in the tree
    // beside its error is how the user finds the line to fix.
    if (edge.to === null) return { ...base, resolution: "unresolved", target: null };
    const targetKey = identityKey(edge.to);
    // Ancestry first. A target that is both an ancestor and expanded is a cycle,
    // and saying so is more use than calling it a reference.
    if (ancestry.has(targetKey)) return { ...base, resolution: "cycle", target: node(edge.to, true) };
    if (expanded.has(targetKey)) {
      return { ...base, resolution: "reference", target: node(edge.to, true) };
    }
    return { ...base, resolution: "resolved", target: expand(edge.to, ancestry) };
  }

  // Entrypoints first, in the order the analysis reports them: manifest order when
  // declared, identity order when inferred. An entrypoint another entrypoint
  // includes has already been expanded by the time it comes up; it stays in the
  // list as a reference, because a declared entrypoint is a fact about the project
  // whether or not something else pulls it in first.
  const entrypoints: IncludesSource[] = [];
  for (const id of analysis.entrypoints) {
    if (expanded.has(identityKey(id))) entrypoints.push(node(id, true));
    else entrypoints.push(expand(id, new Set()));
  }

  // Then everything the entrypoints did not reach, in identity order, each
  // expanded as its own root against the SAME expanded set - so a fragment is
  // shown once, and a cycle with no root at all does not vanish for want of one.
  const other: IncludesSource[] = [];
  for (const graphNode of analysis.nodes) {
    if (expanded.has(identityKey(graphNode.id))) continue;
    other.push(expand(graphNode.id, new Set()));
  }

  const sections: IncludesSection[] = [
    {
      id: "entrypoints",
      title: "Entrypoints",
      hint:
        analysis.entrypointOrigin === "declared"
          ? "Declared in quipu.toml, in the order it lists them."
          : "Inferred: the project files nothing else includes.",
      sources: entrypoints,
      issues: [],
    },
    {
      id: "other",
      title: "Other sources",
      hint: "In the project but not reachable from an entrypoint.",
      sources: other,
      issues: [],
    },
    {
      id: "project",
      title: "Project problems",
      hint: "Problems that apply to the project as a whole, not to one source.",
      sources: [],
      issues: projectIssues,
    },
  ];

  return {
    root,
    manifest: analysis.manifest,
    entrypointOrigin: analysis.entrypointOrigin,
    compilable: analysis.compilable,
    configurationFailed: false,
    sections,
    empty: sections.every((s) => s.sources.length === 0 && s.issues.length === 0),
  };
}

// What identifies a source to the user. Both spellings are `/`-separated; the
// external one is absolute, which is the point - it is what distinguishes a
// dependency outside the project from a file of the same name inside it.
function labelOf(id: SourceId): string {
  return id.path;
}
