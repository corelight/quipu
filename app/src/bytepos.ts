// Turning a UTF-8 byte offset into a Monaco position.
//
// The backend describes every location as a byte span into the file's UTF-8 bytes,
// because that is what YARA-X and the include parser work in. Monaco addresses
// text as 1-based lines and 1-based UTF-16 code-unit columns. The two agree only
// for pure ASCII, and the ways they disagree both matter:
//
//   * a multi-byte character costs 2-4 bytes and 1 UTF-16 unit, so a comment with
//     an accent in it pushes every later byte offset past the column it names;
//   * an astral character (an emoji, say) costs 4 bytes and TWO UTF-16 units, so
//     counting characters instead of code units is wrong in the other direction.
//
// Iterating with `for...of` gives code points rather than code units, so an astral
// character is one step whose `length` is 2 - which is exactly the pair of numbers
// needed here.
//
// A malformed or out-of-range offset is clamped rather than trusted: it comes over
// IPC, Monaco throws on an invalid position, and a location that is slightly wrong
// is far better than a click that raises. An offset that falls INSIDE a character
// clamps to the start of that character, never past it.
//
// No DOM and no IPC, so the conversion can be tested on its own (see
// bytepos.test.mjs).

/** A Monaco position: 1-based line, 1-based UTF-16 code-unit column. */
export interface Position {
  line: number;
  column: number;
}

/** The position of `byteOffset` within `text`, clamped into the text. */
export function positionAt(text: string, byteOffset: number): Position {
  let line = 1;
  let column = 1;
  // Not a number, negative, or NaN: the start of the file is the honest answer.
  if (!Number.isFinite(byteOffset) || byteOffset <= 0) return { line, column };
  const target = Math.floor(byteOffset);

  let bytes = 0;
  for (const ch of text) {
    // Decided before the step, so an offset pointing into the middle of this
    // character resolves to the character's own start rather than the next one's.
    if (target < bytes + utf8Length(ch)) return { line, column };
    bytes += utf8Length(ch);
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else {
      // Code UNITS, not characters: an astral character occupies two columns.
      column += ch.length;
    }
  }
  // Past the end - a span from a stale analysis, or a file that has shrunk since.
  // The end of the text is as close as it can be honoured.
  return { line, column };
}

// How many UTF-8 bytes one code point encodes to.
function utf8Length(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}
