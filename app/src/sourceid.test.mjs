// Tests for identity keys and openable paths (sourceid.ts).
//
// Run with `npm test`. Two things are being pinned down here. First, that
// `external` survives every conversion: an identity is a pair, and the moment it
// is flattened to a path the UI can no longer tell a file inside the project from
// one an include reached outside it. Second, that joining a root to a relative
// path produces a path the filesystem commands accept for EVERY root - including
// the two that already end in a separator, `/` and a Windows drive root, which
// naive concatenation turns into `//sub/a.yar` and `C:\/sub/a.yar`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  basename,
  dirname,
  identityKey,
  isPlainName,
  joinRoot,
  openablePath,
  sameSource,
  segments,
} from "./sourceid.ts";

const internal = (path) => ({ external: false, path });
const external = (path) => ({ external: true, path });

test("an internal and an external identity spelled alike are different sources", () => {
  // The bug this exists to prevent: `vendor/lib.yar` relative to the root, and a
  // canonical `vendor/lib.yar` somewhere else, sharing a map entry, a DOM node
  // and therefore an editor document.
  assert.notEqual(identityKey(internal("vendor/lib.yar")), identityKey(external("vendor/lib.yar")));
  assert.equal(sameSource(internal("a.yar"), external("a.yar")), false);
  assert.equal(sameSource(internal("a.yar"), internal("a.yar")), true);
});

test("identity keys are stable and distinguish paths", () => {
  assert.equal(identityKey(internal("a.yar")), identityKey(internal("a.yar")));
  assert.notEqual(identityKey(internal("a.yar")), identityKey(internal("b.yar")));
  // A path may contain the separator the key uses; the prefix is a prefix, so
  // nothing after it is parsed and no spelling can forge another key.
  assert.equal(identityKey(internal("int:a.yar")), "int:int:a.yar");
});

test("an external identity is already openable and ignores the root", () => {
  const id = external("/elsewhere/shared/lib.yar");
  assert.equal(openablePath("/project", id), "/elsewhere/shared/lib.yar");
  assert.equal(openablePath("/other", id), "/elsewhere/shared/lib.yar");
});

test("an internal identity resolves against the root it is relative to", () => {
  assert.equal(openablePath("/project", internal("sub/a.yar")), "/project/sub/a.yar");
});

test("a root that is itself a separator does not double it", () => {
  // `/` is a legitimate project root, and `//sub/a.yar` is not the same path:
  // POSIX leaves a leading double slash implementation-defined.
  assert.equal(joinRoot("/", "sub/a.yar"), "/sub/a.yar");
  assert.equal(openablePath("/", internal("a.yar")), "/a.yar");
});

test("a trailing separator on any root is not doubled", () => {
  assert.equal(joinRoot("/project/", "a.yar"), "/project/a.yar");
  assert.equal(joinRoot("C:\\rules\\", "a.yar"), "C:\\rules\\a.yar");
});

test("a Windows root joins without a malformed separator run", () => {
  // Identities are always `/`-separated, so a mixed result is expected and
  // accepted by Windows; `C:\rules\/sub/a.yar` is what must not happen.
  assert.equal(joinRoot("C:\\rules", "sub/a.yar"), "C:\\rules/sub/a.yar");
  assert.equal(joinRoot("C:\\", "a.yar"), "C:\\a.yar");
  assert.equal(joinRoot("C:/", "a.yar"), "C:/a.yar");
});

test("joining an empty relative path leaves the root alone", () => {
  // Not a case the analysis produces, but a root plus nothing is the root, not
  // the root with a separator stuck on the end.
  assert.equal(joinRoot("/project", ""), "/project");
  assert.equal(joinRoot("", "a.yar"), "a.yar");
});

test("basename reads either separator", () => {
  assert.equal(basename("/project/sub/a.yar"), "a.yar");
  assert.equal(basename("C:\\rules\\a.yar"), "a.yar");
  assert.equal(basename("C:\\rules/sub/a.yar"), "a.yar");
  assert.equal(basename("a.yar"), "a.yar");
  assert.equal(basename("/a.yar"), "a.yar");
});

test("dirname keeps a root's separator and drops any other", () => {
  // Rename renames in place, so this feeds straight back into joinRoot: losing
  // the leading separator would turn an absolute path into a relative one, and
  // keeping a trailing one would have joinRoot produce a doubled separator.
  assert.equal(dirname("/project/sub/a.yar"), "/project/sub");
  assert.equal(joinRoot(dirname("/project/sub/a.yar"), "b.yar"), "/project/sub/b.yar");
  assert.equal(dirname("/a.yar"), "/");
  assert.equal(joinRoot(dirname("/a.yar"), "b.yar"), "/b.yar");
  assert.equal(dirname("C:\\a.yar"), "C:\\");
  assert.equal(joinRoot(dirname("C:\\a.yar"), "b.yar"), "C:\\b.yar");
  assert.equal(dirname("C:/a.yar"), "C:/");
  assert.equal(dirname("a.yar"), "");
});

test("segments splits an identity path and tolerates a malformed one", () => {
  assert.deepEqual(segments("sub/deeper/a.yar"), ["sub", "deeper", "a.yar"]);
  assert.deepEqual(segments("a.yar"), ["a.yar"]);
  assert.deepEqual(segments(""), []);
  assert.deepEqual(segments("/sub//a.yar"), ["sub", "a.yar"], "no empty tree level");
});

test("a name with a separator is not a plain name", () => {
  // Rename would silently move the file, into a directory it has not created.
  assert.equal(isPlainName("b.yar"), true);
  assert.equal(isPlainName("sub/b.yar"), false);
  assert.equal(isPlainName("..\\b.yar"), false);
  assert.equal(isPlainName(""), false);
});
