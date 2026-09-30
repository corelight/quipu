// Tests for the Files view's model (filestree.ts).
//
// Run with `npm test`. What is being pinned down: a file in a sub-directory shows
// as being in one, the ordering is the same on every machine, readability and
// renamability come from the analysis rather than from a guess about the path, and
// an external source never gets filed under a relative path it does not have.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFilesModel, isEmptyFilesModel } from "./filestree.ts";

const internal = (path) => ({ external: false, path });
const external = (path) => ({ external: true, path });

// A `loaded` analysis whose discovered set is `paths`, all readable unless named
// in `unreadable`.
function analysis(root, ids, unreadable = []) {
  const keyed = (id) => `${id.external ? "ext" : "int"}:${id.path}`;
  const bad = new Set(unreadable.map(keyed));
  return {
    status: "loaded",
    root,
    manifest: null,
    entrypointOrigin: "inferred",
    entrypoints: [],
    discovered: ids,
    nodes: ids.map((id) => ({ id, readable: !bad.has(keyed(id)) })),
    edges: [],
    issues: [],
    compilable: true,
  };
}

// The tree as indented text, so a test can assert the whole shape at once.
function shape(model) {
  const lines = [];
  const walk = (entries, depth) => {
    for (const entry of entries) {
      lines.push(`${"  ".repeat(depth)}${entry.name}${entry.kind === "folder" ? "/" : ""}`);
      if (entry.kind === "folder") walk(entry.children, depth + 1);
    }
  };
  walk(model.entries, 0);
  return lines;
}

test("files nest under their directories", () => {
  const model = buildFilesModel(
    analysis("/p", [
      internal("main.yar"),
      internal("vendor/apt/one.yar"),
      internal("vendor/apt/two.yar"),
      internal("vendor/lib.yar"),
    ]),
  );
  assert.deepEqual(shape(model), [
    "vendor/",
    "  apt/",
    "    one.yar",
    "    two.yar",
    "  lib.yar",
    "main.yar",
  ]);
  assert.equal(model.count, 4);
});

test("folders come before files and each group is ordered by name", () => {
  // Discovery is already in identity order, which interleaves them: `a.yar` sorts
  // before `sub/`. The view groups instead, so the shape does not depend on the
  // spelling of the names around it.
  const model = buildFilesModel(
    analysis("/p", [
      internal("a.yar"),
      internal("b/inner.yar"),
      internal("c.yar"),
      internal("Z.yar"),
      internal("a/deep.yar"),
    ]),
  );
  assert.deepEqual(shape(model), [
    "a/",
    "  deep.yar",
    "b/",
    "  inner.yar",
    "Z.yar",
    "a.yar",
    "c.yar",
  ]);
});

test("the ordering is by codepoint, not by locale", () => {
  // Same input, same output, on every machine: a locale-sensitive comparison
  // would put `Z.yar` after `a.yar` in some locales and before it in others.
  const ids = [internal("b.yar"), internal("A.yar"), internal("a.yar"), internal("B.yar")];
  const first = shape(buildFilesModel(analysis("/p", ids)));
  const again = shape(buildFilesModel(analysis("/p", [...ids].reverse())));
  assert.deepEqual(first, ["A.yar", "B.yar", "a.yar", "b.yar"]);
  assert.deepEqual(again, first, "and it does not depend on discovery's order either");
});

test("a file's openable path is built from the canonical root", () => {
  const model = buildFilesModel(analysis("/real/p", [internal("sub/a.yar")]));
  const file = model.entries[0].children[0];
  assert.equal(file.path, "/real/p/sub/a.yar");
  assert.equal(file.name, "a.yar", "the row is named for the file, not the identity");
  assert.equal(model.root, "/real/p");
});

test("a root that ends in a separator does not produce a doubled one", () => {
  const model = buildFilesModel(analysis("/", [internal("a.yar")]));
  assert.equal(model.entries[0].path, "/a.yar");
});

test("an unreadable file is present and marked", () => {
  // Hiding it would leave the user wondering where their file went; showing it as
  // ordinary would have a click reject with nothing to explain it.
  const locked = internal("locked.yar");
  const model = buildFilesModel(analysis("/p", [internal("fine.yar"), locked], [locked]));
  const byName = Object.fromEntries(model.entries.map((e) => [e.name, e]));
  assert.equal(byName["fine.yar"].readable, true);
  assert.equal(byName["locked.yar"].readable, false);
});

test("an external discovered source is separate, and not renamable", () => {
  // Filing it under a relative path would put someone else's file inside the
  // project's tree, and offering Rename on it would move it from there.
  const model = buildFilesModel(
    analysis("/p", [internal("main.yar"), external("/opt/shared/lib.yar")]),
  );
  assert.deepEqual(shape(model), ["main.yar"]);
  assert.equal(model.external.length, 1);
  assert.equal(model.external[0].path, "/opt/shared/lib.yar", "already absolute");
  assert.equal(model.external[0].name, "lib.yar");
  assert.equal(model.external[0].renamable, false);
  assert.equal(model.entries[0].renamable, true);
  assert.equal(model.count, 2);
});

test("identity keys distinguish an internal source from an external namesake", () => {
  const model = buildFilesModel(analysis("/p", [internal("lib.yar"), external("/opt/lib.yar")]));
  assert.notEqual(model.entries[0].key, model.external[0].key);
});

test("an empty project is empty rather than a tree with nothing in it", () => {
  const model = buildFilesModel(analysis("/p", []));
  assert.deepEqual(model.entries, []);
  assert.deepEqual(model.external, []);
  assert.equal(model.count, 0);
  assert.equal(isEmptyFilesModel(model), true);
});

test("a project with only an external source is not empty", () => {
  const model = buildFilesModel(analysis("/p", [external("/opt/lib.yar")]));
  assert.equal(isEmptyFilesModel(model), false);
});

test("a malformed identity does not create an unnameable tree level", () => {
  // Not something the backend produces. If it ever did, a folder with no file
  // under it is a row the user cannot click and cannot understand.
  const model = buildFilesModel(analysis("/p", [internal(""), internal("a.yar")]));
  assert.deepEqual(shape(model), ["a.yar"]);
  assert.equal(model.count, 1);
});
