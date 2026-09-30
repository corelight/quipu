// Tests for the Includes view's model (includestree.ts).
//
// Run with `npm test`. The graph is a graph, and this turns it into a tree, so the
// cases below are the ways that goes wrong: a diamond duplicated instead of
// referenced, a cycle followed until the stack runs out, a fragment no entrypoint
// reaches quietly dropped, an unresolved include discarded because it has no
// target to hang under, and a project-scoped problem filed under the one source it
// happens to name.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildIncludesModel } from "./includestree.ts";

const internal = (path) => ({ external: false, path });
const external = (path) => ({ external: true, path });
const key = (id) => `${id.external ? "ext" : "int"}:${id.path}`;

// Builds a `loaded` analysis from an edge list. `graph` maps a source path to the
// include filenames it declares; `resolve` maps an include to its target, with a
// missing entry meaning the include resolved to nothing.
function analysis(spec) {
  const {
    root = "/p",
    sources = [],
    includes = [],
    entrypoints = [],
    issues = [],
    unreadable = [],
    manifest = null,
    entrypointOrigin = "inferred",
    compilable = true,
  } = spec;
  const bad = new Set(unreadable.map(key));
  const seen = new Map();
  const add = (id) => {
    if (!seen.has(key(id))) seen.set(key(id), id);
  };
  for (const id of sources) add(id);
  for (const edge of includes) {
    add(edge.from);
    if (edge.to) add(edge.to);
  }
  const order = new Map();
  const edges = includes.map((edge) => {
    const at = order.get(key(edge.from)) ?? 0;
    order.set(key(edge.from), at + 1);
    return {
      from: edge.from,
      order: edge.order ?? at,
      raw: edge.raw ?? (edge.to ? edge.to.path : "missing.yar"),
      span: edge.span ?? { start: 0, end: 0 },
      to: edge.to ?? null,
    };
  });
  // Identity order, as the wire promises.
  const ids = [...seen.values()].sort((a, b) =>
    a.external !== b.external ? (a.external ? 1 : -1) : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    status: "loaded",
    root,
    manifest,
    entrypointOrigin,
    entrypoints,
    discovered: ids.filter((id) => !id.external),
    nodes: ids.map((id) => ({ id, readable: !bad.has(key(id)) })),
    edges,
    issues,
    compilable,
  };
}

const issue = (props) => ({
  code: "x",
  message: "m",
  severity: "blocking",
  scope: "source",
  at: null,
  span: null,
  ...props,
});

function section(model, id) {
  return model.sections.find((s) => s.id === id);
}

// The tree as indented text: a source row is its label, an include row is the
// directive with its resolution.
function shape(sources) {
  const lines = [];
  const walkSource = (source, depth) => {
    lines.push(`${"  ".repeat(depth)}${source.label}${source.reference ? " (ref)" : ""}`);
    for (const inc of source.includes) {
      lines.push(`${"  ".repeat(depth + 1)}include "${inc.raw}" [${inc.resolution}]`);
      if (inc.target) walkSource(inc.target, depth + 2);
    }
  };
  for (const source of sources) walkSource(source, 0);
  return lines;
}

test("an entrypoint's includes hang under it, in declaration order", () => {
  const main = internal("main.yar");
  const model = buildIncludesModel(
    analysis({
      entrypoints: [main],
      includes: [
        { from: main, to: internal("b.yar"), raw: "b.yar", order: 1 },
        { from: main, to: internal("a.yar"), raw: "a.yar", order: 0 },
      ],
    }),
  );
  // Declared order, not the order the edges happened to arrive in and not
  // alphabetical: the file says `include "a.yar"` first.
  assert.deepEqual(shape(section(model, "entrypoints").sources), [
    "main.yar",
    '  include "a.yar" [resolved]',
    "    a.yar",
    '  include "b.yar" [resolved]',
    "    b.yar",
  ]);
  assert.deepEqual(section(model, "other").sources, [], "both are reachable");
});

test("a diamond references the shared dependency instead of duplicating it", () => {
  const main = internal("main.yar");
  const left = internal("left.yar");
  const right = internal("right.yar");
  const shared = internal("shared.yar");
  const model = buildIncludesModel(
    analysis({
      entrypoints: [main],
      includes: [
        { from: main, to: left },
        { from: main, to: right },
        { from: left, to: shared },
        { from: right, to: shared },
      ],
    }),
  );
  assert.deepEqual(shape(section(model, "entrypoints").sources), [
    "main.yar",
    '  include "left.yar" [resolved]',
    "    left.yar",
    '      include "shared.yar" [resolved]',
    "        shared.yar",
    '  include "right.yar" [resolved]',
    "    right.yar",
    // Kept, and named, but not expanded a second time.
    '      include "shared.yar" [reference]',
    "        shared.yar (ref)",
  ]);
});

test("a cycle stops at the ancestor it would loop back to", () => {
  const a = internal("a.yar");
  const b = internal("b.yar");
  const model = buildIncludesModel(
    analysis({
      entrypoints: [a],
      includes: [
        { from: a, to: b },
        { from: b, to: a },
      ],
    }),
  );
  assert.deepEqual(shape(section(model, "entrypoints").sources), [
    "a.yar",
    '  include "b.yar" [resolved]',
    "    b.yar",
    '      include "a.yar" [cycle]',
    "        a.yar (ref)",
  ]);
});

test("a self-include is a cycle, not a reference", () => {
  const a = internal("a.yar");
  const model = buildIncludesModel(
    analysis({ entrypoints: [a], includes: [{ from: a, to: a, raw: "a.yar" }] }),
  );
  assert.deepEqual(shape(section(model, "entrypoints").sources), [
    "a.yar",
    '  include "a.yar" [cycle]',
    "    a.yar (ref)",
  ]);
});

test("a cycle no entrypoint reaches is still shown in full", () => {
  // The project with the worst problem: every file is included by another, so
  // there are no inferred roots at all. A view that only walked from entrypoints
  // would render nothing and leave the user with a blank pane and a failing
  // compile.
  const a = internal("a.yar");
  const b = internal("b.yar");
  const model = buildIncludesModel(
    analysis({
      entrypoints: [],
      includes: [
        { from: a, to: b },
        { from: b, to: a },
      ],
    }),
  );
  assert.deepEqual(section(model, "entrypoints").sources, []);
  assert.deepEqual(shape(section(model, "other").sources), [
    "a.yar",
    '  include "b.yar" [resolved]',
    "    b.yar",
    '      include "a.yar" [cycle]',
    "        a.yar (ref)",
  ]);
  assert.equal(model.empty, false);
});

test("a disconnected source appears under Other sources, once", () => {
  const main = internal("main.yar");
  const dep = internal("dep.yar");
  const orphan = internal("orphan.yar");
  const model = buildIncludesModel(
    analysis({
      entrypoints: [main],
      sources: [orphan],
      includes: [{ from: main, to: dep }],
    }),
  );
  assert.deepEqual(shape(section(model, "entrypoints").sources), [
    "main.yar",
    '  include "dep.yar" [resolved]',
    "    dep.yar",
  ]);
  assert.deepEqual(shape(section(model, "other").sources), ["orphan.yar"]);
});

test("an unresolved include is kept, with the text as written", () => {
  // The raw filename is the whole content of the row: there is no target to name,
  // and it is what the user has to correct.
  const main = internal("main.yar");
  const model = buildIncludesModel(
    analysis({
      entrypoints: [main],
      includes: [{ from: main, to: null, raw: "../outside/missing.yar" }],
    }),
  );
  const inc = section(model, "entrypoints").sources[0].includes[0];
  assert.equal(inc.resolution, "unresolved");
  assert.equal(inc.target, null);
  assert.equal(inc.raw, "../outside/missing.yar");
});

test("an include directive carries where it is written, not only what it points at", () => {
  // Clicking the directive has to reveal the directive. Its span is inside the
  // declaring file, so the path to open is the declaring file's.
  const main = internal("sub/main.yar");
  const model = buildIncludesModel(
    analysis({
      root: "/real/p",
      entrypoints: [main],
      includes: [{ from: main, to: internal("dep.yar"), span: { start: 12, end: 30 } }],
    }),
  );
  const inc = section(model, "entrypoints").sources[0].includes[0];
  assert.equal(inc.fromPath, "/real/p/sub/main.yar");
  assert.deepEqual(inc.span, { start: 12, end: 30 });
  assert.equal(inc.target.path, "/real/p/dep.yar");
});

test("an external target is marked and keeps its absolute identity", () => {
  const main = internal("main.yar");
  const lib = external("/opt/shared/lib.yar");
  const model = buildIncludesModel(
    analysis({ entrypoints: [main], includes: [{ from: main, to: lib, raw: "../shared/lib.yar" }] }),
  );
  const target = section(model, "entrypoints").sources[0].includes[0].target;
  assert.equal(target.external, true);
  assert.equal(target.label, "/opt/shared/lib.yar");
  assert.equal(target.path, "/opt/shared/lib.yar", "already openable, root not prefixed");
  assert.equal(target.name, "lib.yar");
});

test("an unreadable source is marked", () => {
  const main = internal("main.yar");
  const locked = internal("locked.yar");
  const model = buildIncludesModel(
    analysis({ entrypoints: [main], includes: [{ from: main, to: locked }], unreadable: [locked] }),
  );
  assert.equal(section(model, "entrypoints").sources[0].readable, true);
  assert.equal(section(model, "entrypoints").sources[0].includes[0].target.readable, false);
});

test("a source-scoped issue sits with its source", () => {
  const main = internal("main.yar");
  const dep = internal("dep.yar");
  const model = buildIncludesModel(
    analysis({
      entrypoints: [main],
      includes: [{ from: main, to: dep }],
      issues: [
        issue({ code: "unreadable-source", scope: "source", at: dep, span: { start: 1, end: 2 } }),
      ],
    }),
  );
  const target = section(model, "entrypoints").sources[0].includes[0].target;
  assert.equal(target.issues.length, 1);
  assert.equal(target.issues[0].issue.code, "unreadable-source");
  assert.equal(target.issues[0].path, "/p/dep.yar", "so clicking it can open the file");
  assert.equal(target.issues[0].label, "dep.yar");
  assert.deepEqual(section(model, "project").issues, []);
});

test("a project-scoped issue that names a source is still a project problem", () => {
  // `unreachable-source` is attributed to the file it is about and blocks the
  // whole project. Keying off `at` instead of `scope` would show it as that one
  // file's local difficulty.
  const orphan = internal("orphan.yar");
  const model = buildIncludesModel(
    analysis({
      sources: [orphan],
      issues: [issue({ code: "unreachable-source", scope: "project", at: orphan })],
    }),
  );
  assert.deepEqual(section(model, "other").sources[0].issues, [], "not filed under the source");
  const project = section(model, "project").issues;
  assert.equal(project.length, 1);
  assert.equal(project[0].issue.code, "unreachable-source");
  assert.equal(project[0].label, "orphan.yar", "but it still says which file it is about");
  assert.equal(project[0].path, "/p/orphan.yar");
});

test("a project-scoped issue with no source has nowhere to navigate", () => {
  const model = buildIncludesModel(
    analysis({ issues: [issue({ code: "no-entrypoints", scope: "project", at: null })] }),
  );
  const [only] = section(model, "project").issues;
  assert.equal(only.label, null);
  assert.equal(only.path, null);
});

test("an entrypoint another entrypoint includes stays listed, as a reference", () => {
  // Declared entrypoints are a fact about the project. Dropping the second one
  // because the first pulled it in would make the manifest and the view disagree.
  const first = internal("first.yar");
  const second = internal("second.yar");
  const model = buildIncludesModel(
    analysis({
      entrypointOrigin: "declared",
      manifest: "quipu.toml",
      entrypoints: [first, second],
      includes: [{ from: first, to: second }],
    }),
  );
  assert.deepEqual(shape(section(model, "entrypoints").sources), [
    "first.yar",
    '  include "second.yar" [resolved]',
    "    second.yar",
    "second.yar (ref)",
  ]);
  assert.equal(model.manifest, "quipu.toml");
  assert.equal(model.entrypointOrigin, "declared");
});

test("declared entrypoint order is the manifest's, not identity order", () => {
  const z = internal("z.yar");
  const a = internal("a.yar");
  const model = buildIncludesModel(
    analysis({ entrypointOrigin: "declared", entrypoints: [z, a], sources: [z, a] }),
  );
  assert.deepEqual(
    section(model, "entrypoints").sources.map((s) => s.label),
    ["z.yar", "a.yar"],
  );
  assert.equal(section(model, "entrypoints").sources[0].entrypoint, true);
});

test("Other sources is in identity order", () => {
  const model = buildIncludesModel(
    analysis({ sources: [internal("b.yar"), internal("a.yar"), external("/opt/x.yar")] }),
  );
  assert.deepEqual(
    section(model, "other").sources.map((s) => s.label),
    ["a.yar", "b.yar", "/opt/x.yar"],
  );
});

test("an empty valid project is empty", () => {
  const model = buildIncludesModel(analysis({}));
  assert.equal(model.empty, true);
  assert.equal(model.configurationFailed, false);
  assert.equal(model.root, "/p");
});

test("a configuration failure renders its issue though there is no graph", () => {
  const model = buildIncludesModel({
    status: "configurationFailed",
    issue: issue({ code: "manifest-invalid", scope: "project", message: "bad TOML" }),
  });
  assert.equal(model.configurationFailed, true);
  assert.equal(model.empty, false);
  assert.equal(model.root, null);
  assert.equal(model.compilable, false);
  assert.deepEqual(model.sections.map((s) => s.id), ["project"]);
  assert.equal(model.sections[0].issues[0].issue.code, "manifest-invalid");
});

test("a wide diamond does not duplicate exponentially", () => {
  // Six layers of two-wide diamond: 2^6 duplicated subtrees if every edge is
  // followed, and one node per source plus one reference per extra edge if the
  // expansion rule holds. This is the termination guarantee as a number.
  const layers = 6;
  const includes = [];
  const top = internal("l0.yar");
  for (let i = 0; i < layers; i += 1) {
    const from = internal(`l${i}.yar`);
    includes.push({ from, to: internal(`l${i + 1}a.yar`) });
    includes.push({ from, to: internal(`l${i + 1}b.yar`) });
    includes.push({ from: internal(`l${i + 1}a.yar`), to: internal(`l${i + 1}.yar`) });
    includes.push({ from: internal(`l${i + 1}b.yar`), to: internal(`l${i + 1}.yar`) });
  }
  const model = buildIncludesModel(analysis({ entrypoints: [top], includes }));
  let sources = 0;
  let references = 0;
  const walk = (source) => {
    sources += 1;
    if (source.reference) references += 1;
    for (const inc of source.includes) if (inc.target) walk(inc.target);
  };
  for (const source of section(model, "entrypoints").sources) walk(source);
  for (const source of section(model, "other").sources) walk(source);
  // 3 sources per layer plus the final `l6.yar`, expanded once each; the second
  // edge into every layer's join is one reference leaf.
  assert.equal(sources - references, 3 * layers + 1);
  assert.equal(references, layers);
});

test("every source in the analysis appears somewhere", () => {
  // The completeness property behind the sections: unreachable, external,
  // unreadable or in a cycle, a source the backend knows about is a source the
  // user can find.
  const main = internal("main.yar");
  const cycleA = internal("cycle-a.yar");
  const cycleB = internal("cycle-b.yar");
  const orphan = internal("orphan.yar");
  const lib = external("/opt/lib.yar");
  const spec = analysis({
    entrypoints: [main],
    sources: [orphan],
    includes: [
      { from: main, to: lib },
      { from: main, to: null, raw: "gone.yar" },
      { from: cycleA, to: cycleB },
      { from: cycleB, to: cycleA },
    ],
  });
  const model = buildIncludesModel(spec);
  const found = new Set();
  const walk = (source) => {
    if (!source.reference) found.add(source.key);
    for (const inc of source.includes) if (inc.target) walk(inc.target);
  };
  for (const s of model.sections) for (const source of s.sources) walk(source);
  assert.deepEqual(
    [...found].sort(),
    spec.nodes.map((n) => key(n.id)).sort(),
  );
});
