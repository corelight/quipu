// The Files view's model: the project's discovered sources as a directory tree.
//
// Phase 2's explorer was a flat list from a separate `list_rule_files` call, which
// meant two answers to "what is in this project" that could disagree, and no way
// to show a file in a sub-directory as being in one. The tree is derived from the
// accepted analysis instead - the same snapshot the Includes view and the compile
// plan describe - so there is one answer, and it is the backend's.
//
// Discovery is what belongs here: the files the project CONTAINS. A file that is
// included but was never discovered (outside the root, or below an ignored
// directory) is a dependency rather than a member, and belongs to the Includes
// view, where the edge that reached it explains why it is there at all.
//
// Pure and DOM-free, so the hierarchy and the ordering can be tested without a
// display (see filestree.test.mjs). Rendering it is explorer.ts's job.

import type { SourceId } from "./ipc";
import type { LoadedAnalysis } from "./project.ts";
import { basename, identityKey, openablePath, segments } from "./sourceid.ts";

export interface FilesFile {
  kind: "file";
  // Display name: the last path segment.
  name: string;
  id: SourceId;
  // Unique per source, for keying DOM nodes and lookups.
  key: string;
  // Openable path, spelled under the CANONICAL root. The backend's diagnostics
  // name files the same way, so a click here and a click in the Problems pane
  // reach the same editor document instead of opening the file twice.
  path: string;
  // False when the file is in the project but its bytes could not be read.
  readable: boolean;
  // False where Rename's filesystem semantics do not apply: renaming an external
  // canonical target is not renaming a project file, it is reaching outside the
  // project to move someone else's.
  renamable: boolean;
}

export interface FilesFolder {
  kind: "folder";
  name: string;
  // Root-relative, `/`-separated, and unique - the folder's identity in the tree.
  path: string;
  children: FilesEntry[];
}

export type FilesEntry = FilesFolder | FilesFile;

export interface FilesModel {
  // The canonical root the paths above are built from.
  root: string;
  // The internal hierarchy, folders before files, each group by name.
  entries: FilesEntry[];
  // Discovered sources that are not inside the root. Discovery walks the root, so
  // this is normally empty; it exists because an identity says whether it is
  // external and a view that assumed otherwise would file such a source under a
  // relative path it does not have.
  external: FilesFile[];
  // Total sources, for the status line.
  count: number;
}

/** Builds the Files view's model from an accepted snapshot. */
export function buildFilesModel(analysis: LoadedAnalysis): FilesModel {
  const unreadable = new Set(
    analysis.nodes.filter((n) => !n.readable).map((n) => identityKey(n.id)),
  );
  const readable = (id: SourceId) => !unreadable.has(identityKey(id));

  const root: FilesFolder = { kind: "folder", name: "", path: "", children: [] };
  const external: FilesFile[] = [];
  let count = 0;

  for (const id of analysis.discovered) {
    count += 1;
    const file: FilesFile = {
      kind: "file",
      name: basename(id.path),
      id,
      key: identityKey(id),
      path: openablePath(analysis.root, id),
      readable: readable(id),
      renamable: !id.external,
    };
    if (id.external) {
      external.push(file);
      continue;
    }
    const parts = segments(id.path);
    // A directory component with no file name after it cannot be opened and has
    // no bytes to show; discovery does not produce one, and inventing a folder for
    // it would put an unnameable row in the tree.
    if (parts.length === 0) {
      count -= 1;
      continue;
    }
    file.name = parts[parts.length - 1];
    folderFor(root, parts.slice(0, -1)).children.push(file);
  }

  sortFolder(root);
  return { root: analysis.root, entries: root.children, external, count };
}

/** True when there is nothing at all to show - as opposed to nothing readable. */
export function isEmptyFilesModel(model: FilesModel): boolean {
  return model.entries.length === 0 && model.external.length === 0;
}

// Walks (creating as it goes) to the folder holding `parts`.
function folderFor(root: FilesFolder, parts: string[]): FilesFolder {
  let here = root;
  for (const part of parts) {
    const path = here.path === "" ? part : `${here.path}/${part}`;
    let next = here.children.find(
      (c): c is FilesFolder => c.kind === "folder" && c.name === part,
    );
    if (!next) {
      next = { kind: "folder", name: part, path, children: [] };
      here.children.push(next);
    }
    here = next;
  }
  return here;
}

// Folders first, then files, each group by name.
//
// A plain codepoint comparison, deliberately not localeCompare: the ordering has
// to be the same on every machine, and a locale-sensitive one would reorder the
// tree when the user's locale changed and make the tests depend on the runner's.
function sortFolder(folder: FilesFolder): void {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (const child of folder.children) {
    if (child.kind === "folder") sortFolder(child);
  }
}
