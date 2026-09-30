// Turning a source identity into the two things the UI needs from it: a key that
// is unique per source, and a path the filesystem commands will accept.
//
// An identity is not a path. `external` decides what `path` means - root-relative
// for a file inside the project, canonical and absolute for one an include reached
// outside it - so collapsing the pair into a single string makes an internal
// `vendor/lib.yar` and an external source spelled the same way indistinguishable.
// Nothing here takes a bare path where an identity was available.
//
// Joining is not string concatenation either. A root of `/` already ends in a
// separator, and so does a Windows drive root (`C:\`), so appending `/` to it
// yields `//sub/a.yar` - a path that on Unix means something else entirely (a
// POSIX-implementation-defined prefix) and on Windows starts a UNC name.
//
// No DOM and no IPC - only the identity TYPE is imported, and only as a type - so
// the joining rules can be tested on their own (see sourceid.test.mjs).

import type { SourceId } from "./ipc";

// A string that is unique per source, for keying maps, sets and DOM nodes.
//
// The prefix is what stops an internal identity colliding with an external one:
// `external` is part of the identity, so it has to be part of the key.
export function identityKey(id: SourceId): string {
  return `${id.external ? "ext" : "int"}:${id.path}`;
}

// True when both identities name the same source.
export function sameSource(a: SourceId, b: SourceId): boolean {
  return a.external === b.external && a.path === b.path;
}

// Appends a `/`-separated relative path to a root, without doubling the
// separator when the root already ends in one.
//
// Both separators count as one: on Windows the picker hands back `C:\rules`,
// canonical roots keep the backslashes, and identities are always `/`-separated,
// so the result is legitimately mixed - which Windows accepts - but must not be
// `C:\rules\/sub\a.yar`.
export function joinRoot(root: string, relative: string): string {
  if (relative === "") return root;
  if (root === "") return relative;
  return root.endsWith("/") || root.endsWith("\\") ? `${root}${relative}` : `${root}/${relative}`;
}

// The path to hand `read_text_file`, `save_text_file` or `rename_file` for a
// source. `root` must be the root the identity is relative to; an external
// identity ignores it, being canonical and absolute already.
export function openablePath(root: string, id: SourceId): string {
  return id.external ? id.path : joinRoot(root, id.path);
}

// The last path segment, for display. Accepts either separator, because it is
// applied to canonical paths as well as to identity paths.
export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? path : path.slice(cut + 1);
}

// Everything before the last separator, ready to be handed back to joinRoot().
//
// A root keeps its separator, because dropping it would turn the absolute
// `/a.yar` into the relative `a.yar`; anything else loses its trailing one, so
// joinRoot() supplies exactly one. A path with no separator at all has no
// directory to name, and answers with the empty string.
export function dirname(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0) return "";
  if (cut === 0) return path.slice(0, 1);
  // `C:/a.yar` and `C:\a.yar`: the separator at index 2 belongs to the drive root.
  if (cut === 2 && /^[A-Za-z]:$/.test(path.slice(0, 2))) return path.slice(0, 3);
  return path.slice(0, cut);
}

// The directory components of an internal identity's path, outermost first, and
// then its file name. Identity paths are always `/`-separated and never carry a
// leading, trailing or empty component, but a defensive filter costs nothing and
// keeps a malformed one from producing an unnamed tree level.
export function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

// True when `name` is a plain file name - what Rename may be given. A name with
// a separator in it would move the file somewhere else, which Rename does not
// mean and whose target directory it has not been asked to create.
export function isPlainName(name: string): boolean {
  return name !== "" && !name.includes("/") && !name.includes("\\");
}
