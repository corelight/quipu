// Tests for byte-offset to Monaco-position conversion (bytepos.ts).
//
// Run with `npm test`. The backend counts UTF-8 bytes and Monaco counts UTF-16
// code units, so every case here is a place the two diverge: a multi-byte
// character, an astral character that is one code point but two columns, an offset
// that lands inside a character, and an offset that is simply not in the file.
//
// The expected offsets are computed with TextEncoder rather than written by hand,
// so a wrong constant cannot make a wrong implementation pass.

import { test } from "node:test";
import assert from "node:assert/strict";

import { positionAt } from "./bytepos.ts";

// The byte offset of the first occurrence of `needle` in `text`.
const byteOf = (text, needle) =>
  new TextEncoder().encode(text.slice(0, text.indexOf(needle))).length;

test("ASCII: bytes and columns agree", () => {
  const text = "rule a {\n    condition:\n        true\n}\n";
  assert.deepEqual(positionAt(text, 0), { line: 1, column: 1 });
  assert.deepEqual(positionAt(text, byteOf(text, "a {")), { line: 1, column: 6 });
  assert.deepEqual(positionAt(text, byteOf(text, "condition")), { line: 2, column: 5 });
  assert.deepEqual(positionAt(text, byteOf(text, "true")), { line: 3, column: 9 });
});

test("a newline's own offset is the end of the line it ends", () => {
  const text = "ab\ncd";
  assert.deepEqual(positionAt(text, 2), { line: 1, column: 3 });
  assert.deepEqual(positionAt(text, 3), { line: 2, column: 1 }, "and the next byte starts line 2");
});

test("a two-byte character costs one column", () => {
  // `é` is 2 bytes and 1 UTF-16 unit: counting bytes as columns would put the
  // caret one place too far right for the rest of the line.
  const text = '// café\ninclude "dep.yar"';
  assert.deepEqual(positionAt(text, byteOf(text, "include")), { line: 2, column: 1 });
  assert.deepEqual(positionAt(text, byteOf(text, "dep.yar")), { line: 2, column: 10 });
});

test("a three-byte character costs one column", () => {
  const text = "// 中文 x";
  assert.deepEqual(positionAt(text, byteOf(text, "x")), { line: 1, column: 7 });
});

test("an astral character costs two columns", () => {
  // One code point, 4 bytes, and TWO UTF-16 code units. Counting characters would
  // leave the caret one unit short, which Monaco would place inside the surrogate
  // pair.
  const text = "// \u{1f600} x";
  assert.equal(text.length, 7, "six code points, seven code units");
  assert.deepEqual(positionAt(text, byteOf(text, "x")), { line: 1, column: 7 });
});

test("an offset inside a character clamps to that character's start", () => {
  // Never past it: a position that overshoots would highlight the wrong text, and
  // splitting a surrogate pair is not a position Monaco can honour at all.
  const text = "\u{1f600}ab";
  assert.deepEqual(positionAt(text, 0), { line: 1, column: 1 });
  assert.deepEqual(positionAt(text, 1), { line: 1, column: 1 }, "second byte of four");
  assert.deepEqual(positionAt(text, 3), { line: 1, column: 1 }, "last byte of four");
  assert.deepEqual(positionAt(text, 4), { line: 1, column: 3 }, "and `a` is at column 3");
});

test("multi-byte characters accumulate across lines", () => {
  const text = "// ééé\n// \u{1f600}\nrule r {}";
  assert.deepEqual(positionAt(text, byteOf(text, "rule")), { line: 3, column: 1 });
});

test("an offset past the end clamps to the end of the text", () => {
  const text = "ab\ncd";
  assert.deepEqual(positionAt(text, 5), { line: 2, column: 3 });
  assert.deepEqual(positionAt(text, 500), { line: 2, column: 3 });
});

test("a trailing newline puts the end on the next line", () => {
  assert.deepEqual(positionAt("ab\n", 99), { line: 2, column: 1 });
});

test("empty text is position 1:1", () => {
  assert.deepEqual(positionAt("", 0), { line: 1, column: 1 });
  assert.deepEqual(positionAt("", 40), { line: 1, column: 1 });
});

test("a malformed offset does not produce a position Monaco would reject", () => {
  const text = "ab";
  for (const bad of [-1, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const pos = positionAt(text, bad);
    assert.ok(pos.line >= 1 && pos.column >= 1, `${bad} -> ${JSON.stringify(pos)}`);
  }
  assert.deepEqual(positionAt(text, -1), { line: 1, column: 1 });
  assert.deepEqual(positionAt(text, Number.NaN), { line: 1, column: 1 });
  assert.deepEqual(positionAt(text, Number.POSITIVE_INFINITY), { line: 1, column: 1 });
});

test("a fractional offset is not fractional in the answer", () => {
  const text = "abc";
  assert.deepEqual(positionAt(text, 1.7), { line: 1, column: 2 });
});
