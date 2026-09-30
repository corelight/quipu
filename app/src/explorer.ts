// Drawing the Files and Includes views.
//
// Deliberately thin: the shape of both trees is decided by filestree.ts and
// includestree.ts, which are pure and tested, and everything below is markup plus
// two pieces of bookkeeping - the reference table, and which nodes the user has
// collapsed.
//
// ---- Why rows carry an index rather than a path ----
//
// A row has to say what to open when it is clicked. Rows therefore carry an index
// into a table built by the same render pass, so the target is the very object the
// model produced rather than a string parsed back out of the DOM, and no
// filesystem path needs to survive a round trip through markup to be usable. The
// table is replaced together with the markup it describes, so the two cannot
// drift apart.
//
// Disclosure state is the one thing that cannot work that way: it has to outlive
// the render pass, so it is keyed by a stable node name in `data-node`. That is
// safe as long as everything interpolated into an attribute is FULLY escaped -
// `&` included - because an attribute value is entity-decoded when it is read
// back, and escaping only the quote would hand `a&quot;b.yar` back as a different
// name than went in. See escape.ts.
//
// ---- Keyboard and disclosure ----
//
// Folders and expandable nodes are `<details>`/`<summary>`: focusable, toggled by
// Enter/Space, and announced as disclosures without any ARIA of our own. Rows are
// real `<button>`s for the same reason. The one consequence to remember is that a
// button inside a `<summary>` still toggles the disclosure when clicked, so the
// delegated handler in main.ts calls preventDefault() once it has found a row -
// activating a row navigates, it does not also collapse the thing containing it.

import type { FilesEntry, FilesFile, FilesModel } from "./filestree.ts";
import type {
  IncludesInclude,
  IncludesIssue,
  IncludesModel,
  IncludesSection,
  IncludesSource,
} from "./includestree.ts";
import { escapeAttr, escapeHtml } from "./escape.ts";

// What activating a row means. Both arms carry the openable path; `location` adds
// the byte offset to reveal once the document is open.
export type ExplorerRef =
  | {
      kind: "source";
      path: string;
      label: string;
      readable: boolean;
      // False where Rename does not apply - an external source, whose path is a
      // canonical target outside the project.
      renamable: boolean;
    }
  | {
      kind: "location";
      path: string;
      label: string;
      // Byte offset into the file, or null to just open it.
      offset: number | null;
    };

/** The rows of one render pass, addressed by the token in their `data-ref`. */
export class RefTable {
  private items: ExplorerRef[] = [];

  add(ref: ExplorerRef): string {
    this.items.push(ref);
    return String(this.items.length - 1);
  }

  get(token: string | null | undefined): ExplorerRef | null {
    if (token == null) return null;
    const index = Number(token);
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return null;
    return this.items[index];
  }
}

/** Which disclosure nodes the user has collapsed; survives a re-render. */
export type Collapsed = (node: string) => boolean;

/** Live editor state the Files view marks rows with. */
export interface FilesViewState {
  // Key of the active document, which for a project file is its openable path.
  active: string | null;
  // True when the document at this path has unsaved changes.
  dirty: (path: string) => boolean;
  // How the open document at this path disagrees with the file on disk, if it
  // does: `changed` for an external write Quipu will not take by itself, `missing`
  // for a file that has been removed or renamed away underneath it. Distinct from
  // dirty, and shown separately - one says the editor has more than the disk, the
  // other says they have diverged.
  conflict: (path: string) => "changed" | "missing" | null;
  collapsed: Collapsed;
}

/** Replaces `el` with a plain message - no project, still loading, nothing found. */
export function renderNotice(el: HTMLElement, message: string, hint?: string): RefTable {
  el.innerHTML =
    `<div class="muted">${escapeHtml(message)}</div>` +
    (hint === undefined ? "" : `<div class="muted subtle">${escapeHtml(hint)}</div>`);
  return new RefTable();
}

export function renderFilesView(
  el: HTMLElement,
  model: FilesModel,
  state: FilesViewState,
): RefTable {
  const refs = new RefTable();
  const body = model.entries.map((entry) => filesEntry(entry, refs, state)).join("");
  const external =
    model.external.length === 0
      ? ""
      : disclosure(
          "folder external-group",
          "ext:",
          `<span class="folder-name">External</span>${count(model.external.length)}`,
          model.external.map((file) => fileRow(file, refs, state)).join(""),
          state.collapsed,
        );
  el.innerHTML = `<div class="tree">${body}${external}</div>`;
  return refs;
}

function filesEntry(entry: FilesEntry, refs: RefTable, state: FilesViewState): string {
  if (entry.kind === "file") return fileRow(entry, refs, state);
  return disclosure(
    "folder",
    `dir:${entry.path}`,
    `<span class="folder-name">${escapeHtml(entry.name)}</span>`,
    entry.children.map((child) => filesEntry(child, refs, state)).join(""),
    state.collapsed,
  );
}

function fileRow(file: FilesFile, refs: RefTable, state: FilesViewState): string {
  const ref = refs.add({
    kind: "source",
    path: file.path,
    label: file.name,
    readable: file.readable,
    renamable: file.renamable,
  });
  const active = state.active === file.path;
  const conflict = state.conflict(file.path);
  const classes = ["row", "file", active ? "active" : "", file.readable ? "" : "unreadable"];
  return `<button type="button" class="${classes.filter(Boolean).join(" ")}" data-ref="${ref}"
      title="${escapeAttr(file.path)}"${active ? ' aria-current="true"' : ""}>
      <span class="file-name">${escapeHtml(file.name)}</span>
      ${file.readable ? "" : chip("unreadable", "bad")}
      ${conflict === null ? "" : conflictMark(conflict)}
      ${state.dirty(file.path) ? '<span class="dirty-dot" title="Unsaved changes">●</span>' : ""}
    </button>`;
}

// Beside the dirty dot rather than instead of it: a conflicted document usually
// has unsaved edits too, and the two facts are different - one is work not yet
// written, the other is a file that changed underneath it.
function conflictMark(conflict: "changed" | "missing"): string {
  const title =
    conflict === "missing"
      ? "No longer readable on disk; the editor still has its text"
      : "Changed on disk since it was opened";
  return `<span class="conflict-mark" title="${escapeAttr(title)}">${
    conflict === "missing" ? "✖" : "⇅"
  }</span>`;
}

// ---- Includes ----

export function renderIncludesView(
  el: HTMLElement,
  model: IncludesModel,
  collapsed: Collapsed,
): RefTable {
  const refs = new RefTable();
  const sections = model.sections
    .filter((s) => s.sources.length > 0 || s.issues.length > 0)
    .map((s) => includesSection(s, refs, collapsed))
    .join("");
  el.innerHTML = `${includesHead(model)}<div class="tree">${sections}</div>`;
  return refs;
}

function includesHead(model: IncludesModel): string {
  const bits: string[] = [];
  if (model.manifest !== null) bits.push(chip(model.manifest, "info"));
  else if (!model.configurationFailed) bits.push(chip("no manifest", "subtle"));
  if (!model.configurationFailed && !model.compilable) bits.push(chip("not compilable", "bad"));
  return bits.length === 0 ? "" : `<div class="includes-head">${bits.join("")}</div>`;
}

function includesSection(
  section: IncludesSection,
  refs: RefTable,
  collapsed: Collapsed,
): string {
  const rows =
    section.issues.map((i) => issueRow(i, refs)).join("") +
    section.sources.map((s) => sourceNode(s, refs, collapsed)).join("");
  return `<section class="includes-section">
      <h3>${escapeHtml(section.title)}${count(section.sources.length + section.issues.length)}</h3>
      <div class="hint">${escapeHtml(section.hint)}</div>
      ${rows}
    </section>`;
}

// A source and, when it has any, its problems and its includes below it.
function sourceNode(source: IncludesSource, refs: RefTable, collapsed: Collapsed): string {
  const row = sourceRow(source, refs);
  const children = sourceChildren(source, refs, collapsed);
  if (children === "") return row;
  return disclosure("node", `src:${source.key}`, row, children, collapsed);
}

// A reference leaf's includes are empty by construction, and repeating its
// problems where it is only being linked to would double them.
function sourceChildren(source: IncludesSource, refs: RefTable, collapsed: Collapsed): string {
  if (source.reference) return "";
  return (
    source.issues.map((i) => issueRow(i, refs)).join("") +
    source.includes.map((inc) => includeNode(inc, refs, collapsed)).join("")
  );
}

function sourceRow(source: IncludesSource, refs: RefTable): string {
  const ref = refs.add({
    kind: "source",
    path: source.path,
    label: source.name,
    readable: source.readable,
    renamable: !source.external,
  });
  const chips = [
    source.entrypoint ? chip("entrypoint", "info") : "",
    source.external ? chip("external", "warn") : "",
    source.readable ? "" : chip("unreadable", "bad"),
  ]
    .filter(Boolean)
    .join("");
  return `<button type="button" class="row source${source.readable ? "" : " unreadable"}"
      data-ref="${ref}" title="${escapeAttr(source.label)}">
      <span class="file-name">${escapeHtml(source.name)}</span>${chips}
    </button>`;
}

// One include directive: the directive itself, which navigates to the line it is
// written on, and its target, which opens the file. An unresolved edge keeps the
// raw text and has no target to offer.
function includeNode(inc: IncludesInclude, refs: RefTable, collapsed: Collapsed): string {
  const directive = refs.add({
    kind: "location",
    path: inc.fromPath,
    label: `include "${inc.raw}"`,
    offset: inc.span.start,
  });
  const row = `<div class="row include ${inc.resolution}">
      <button type="button" class="include-directive" data-ref="${directive}"
        title="Go to the include directive">include "${escapeHtml(inc.raw)}"</button>
      ${inc.target === null ? "" : `<span class="include-arrow">&rarr;</span>${sourceRow(inc.target, refs)}`}
      ${resolutionChip(inc)}
    </div>`;
  const children = inc.target === null ? "" : sourceChildren(inc.target, refs, collapsed);
  if (children === "") return row;
  return disclosure("node", `inc:${identity(inc)}`, row, children, collapsed);
}

// Unique per directive: one source declares each `order` once.
function identity(inc: IncludesInclude): string {
  return `${inc.from.external ? "ext" : "int"}:${inc.from.path}#${inc.order}`;
}

function resolutionChip(inc: IncludesInclude): string {
  switch (inc.resolution) {
    case "resolved":
      return "";
    case "reference":
      return chip("shown above", "subtle");
    case "cycle":
      return chip("cycle", "bad");
    case "unresolved":
      return chip("not found", "bad");
  }
}

function issueRow(located: IncludesIssue, refs: RefTable): string {
  const { issue } = located;
  const severity = issue.severity === "blocking" ? "bad" : "info";
  const at =
    located.label === null ? "" : `<span class="issue-at">${escapeHtml(located.label)}</span>`;
  const body = `<span class="issue-msg">${escapeHtml(issue.message)}</span>
      <span class="issue-meta">${chip(issue.severity, severity)}<span class="code">${escapeHtml(issue.code)}</span>${at}</span>`;
  // Only navigable when it names a file. An issue about the project as a whole has
  // nowhere to go, and a button that does nothing is worse than a plain row.
  if (located.path === null) return `<div class="row issue ${severity}">${body}</div>`;
  const ref = refs.add({
    kind: "location",
    path: located.path,
    label: located.label ?? located.path,
    offset: issue.span === null ? null : issue.span.start,
  });
  return `<button type="button" class="row issue ${severity}" data-ref="${ref}"
      title="${escapeAttr(located.path)}">${body}</button>`;
}

// A `<details>` whose open state survives re-rendering, because the user's choice
// to collapse something must not be undone by a keystroke redrawing the tree.
function disclosure(
  classes: string,
  node: string,
  summary: string,
  children: string,
  collapsed: Collapsed,
): string {
  return `<details class="${classes}" data-node="${escapeAttr(node)}"${collapsed(node) ? "" : " open"}>
      <summary>${summary}</summary>
      <div class="children">${children}</div>
    </details>`;
}

function chip(text: string, kind: string): string {
  return `<span class="chip ${kind}">${escapeHtml(text)}</span>`;
}

function count(n: number): string {
  return `<span class="tree-count">${n}</span>`;
}
