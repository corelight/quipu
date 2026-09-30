// Import the namespace from `edcore.main`: it registers the editor feature
// CONTRIBUTIONS (hover, suggest/completion, semantic-tokens controllers — the
// parts that actually QUERY registered providers) while excluding Monaco's ~80
// bundled language modes. Bare `editor.api` lacks the contributions, so
// providers never fire; full `monaco-editor` re-adds all the languages we don't want.
import * as monaco from "monaco-editor/esm/vs/editor/edcore.main";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { YaraLspClient } from "./lsp/client";
import { atRiskOnExit } from "./closing";
import {
  DocumentSet,
  type Carried,
  type ConflictKind,
  type DiskAnswer,
  type DiskProbe,
  type DiskState,
  type Reconciliation,
  type RiskStamp,
  type SaveSnapshot,
} from "./documents";

// Monaco needs to know how to spawn its web workers. We only use the base
// editor worker (no TS/JSON/etc language services), so this is the whole setup.
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

export const LANGUAGE_ID = "yara";
// URI for the unsaved scratch buffer shown before a folder is opened.
const SCRATCH_URI = "inmemory://model/scratch.yar";

// Lightweight Monarch grammar for base highlighting. LSP semantic tokens
// (Phase 3) overlay this; the grammar is the fast first-paint layer.
function registerYaraLanguage() {
  if (monaco.languages.getLanguages().some((l) => l.id === LANGUAGE_ID)) return;

  monaco.languages.register({ id: LANGUAGE_ID, extensions: [".yar", ".yara"] });

  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "/", close: "/" },
    ],
  });

  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    defaultToken: "",
    keywords: [
      "rule", "private", "global", "meta", "strings", "condition",
      "import", "include", "and", "or", "not", "any", "all", "of", "them",
      "for", "in", "at", "filesize", "entrypoint", "true", "false",
      "nocase", "wide", "ascii", "xor", "base64", "base64wide", "fullword",
      "matches", "contains", "startswith", "endswith", "icontains",
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/\$[A-Za-z0-9_]*/, "variable"],
        [/#[A-Za-z0-9_]*/, "variable"],
        [/@[A-Za-z0-9_]*/, "variable"],
        [/![A-Za-z0-9_]*/, "variable"],
        [/"/, "string", "@string"],
        [/\{[0-9A-Fa-f\s?\[\]\-()|]+\}/, "number.hex"],
        [/\b\d+\b/, "number"],
        [
          /[A-Za-z_][A-Za-z0-9_]*/,
          { cases: { "@keywords": "keyword", "@default": "identifier" } },
        ],
        [/[{}()\[\]]/, "@brackets"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
      ],
    },
  });
}

/** A save in progress, as beginSave() captured it. Opaque; see documents.ts. */
export type EditorSave = SaveSnapshot<monaco.editor.ITextModel>;
/** A document as probe() captured it before a read of its file. Opaque; documents.ts. */
export type EditorProbe = DiskProbe<monaco.editor.ITextModel>;

// A multi-document editor: one Monaco model per open file (keyed by absolute
// path; the scratch buffer uses the key ""). A single editor view switches
// between models. The LSP client is told about open/changed documents and
// routes diagnostics back by URI (via Monaco's global model registry).
//
// Which keys are open, which model each holds and which revision of it is on disk
// live in a DocumentSet, so that bookkeeping - the save baseline in particular -
// can be tested without Monaco. What stays here is what is genuinely Monaco's and
// the LSP's: creating and disposing models, the change listeners, the open/close
// notifications, and which document the view is showing.
export class Workspace {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private docs = new DocumentSet<monaco.editor.ITextModel>();
  private active: string | null = null;
  private activeListeners: Array<() => void> = [];
  private dirtyListeners: Array<() => void> = [];
  private contentListeners: Array<() => void> = [];
  // Set only while reloadDoc() is installing text that came from the disk. Monaco
  // cannot tell that edit apart from a keystroke, and treating it as one would
  // report the rules as changed by the very refresh that brought them up to date -
  // invalidating a ruleset that is now correct and asking for another analysis of a
  // project nothing has touched. See reloadDoc().
  private reloading = false;

  constructor(container: HTMLElement, private lsp: YaraLspClient) {
    registerYaraLanguage();
    this.editor = monaco.editor.create(container, {
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      tabSize: 4,
      fixedOverflowWidgets: true,
    });
  }

  // Opens an in-memory scratch buffer (used before any folder is opened).
  openScratch(text: string) {
    this.open("", monaco.Uri.parse(SCRATCH_URI), text);
  }

  // Opens (or re-activates) a real file by absolute path.
  openFile(path: string, text: string) {
    this.open(path, monaco.Uri.file(path), text);
  }

  private open(key: string, uri: monaco.Uri, text: string) {
    this.ensureDoc(key, uri, text);
    this.activate(key);
  }

  // Creates the model + change tracking for a key if it isn't open yet.
  // Separate from open() so a rename can re-key a document without disturbing
  // which one is active.
  //
  // `carried` is what a rename brings across - unsaved edits, and which revision
  // of the file the baseline refers to. See documents.ts.
  private ensureDoc(key: string, uri: monaco.Uri, text: string, carried?: Carried) {
    const { model, created } = this.docs.ensure(
      key,
      () => monaco.editor.createModel(text, LANGUAGE_ID, uri),
      carried,
    );
    if (!created) return;
    this.lsp.openDocument(model);
    // Dirty state updates immediately (cheap), but the LSP sync sends the
    // FULL document text over IPC — debounce it so large files don't fire a
    // multi-MB round-trip on every keystroke.
    let changeTimer: number | undefined;
    model.onDidChangeContent(() => {
      // Cancelled unconditionally, before anything is decided: a pending sync
      // describes text that no longer exists whether this change was the user's or
      // a reload's, and a reload issues its own notification.
      window.clearTimeout(changeTimer);
      if (this.reloading) return;
      // Content first, then the dirty bookkeeping. These are deliberately two
      // signals: the content one fires ONLY here, for a real edit to a real
      // model, so a caller can treat it as "the rules changed" without having to
      // ask whether it was really a save's bookkeeping in disguise.
      this.fireContentChanged();
      this.fireDirty();
      changeTimer = window.setTimeout(() => this.lsp.changeDocument(model), 250);
    });
    // The debounce outlives the model: renameDoc() disposes this model to
    // re-create it under the new URI, and an edit within the preceding 250ms
    // leaves a timer that would call changeDocument() on a disposed model.
    // Cancelling on disposal keeps the timer local to the model that owns it.
    model.onWillDispose(() => window.clearTimeout(changeTimer));
  }

  // Re-keys an open document onto a new path after the file was renamed on
  // disk. A Monaco model's URI is immutable, so the model is re-created under
  // the new file URI (carrying content and dirty state over) and the old one is
  // disposed. Without this, the document would keep the old key and a later
  // save would write back to the path that no longer exists.
  renameDoc(oldKey: string, newPath: string) {
    if (oldKey === newPath) return;
    const model = this.docs.model(oldKey);
    if (model === null) return;
    const text = model.getValue();
    // Captured before the document is forgotten: whether it has unsaved edits, which
    // revision of the file its baseline refers to, and how it disagreed with the
    // disk. The file under the new path holds what the old path held, so that
    // baseline is still the truth about the disk - deriving it from the new model
    // instead would claim the editor's unsaved text was written - and a conflict
    // about those same bytes is still unresolved at their new path.
    const carried = this.docs.carriedFrom(oldKey) ?? undefined;
    const wasActive = this.active === oldKey;

    this.docs.remove(oldKey);
    this.lsp.closeDocument(model);
    model.dispose();

    // Unsaved edits come along: the new model is clean by construction, but the
    // file it now names has never been written, so the document is dirty from the
    // outset. A save of the OLD path still in flight cannot mark this one clean -
    // it is a different model under a different key (see documents.ts).
    this.ensureDoc(newPath, monaco.Uri.file(newPath), text, carried);

    if (wasActive) this.activate(newPath);
    else this.fireDirty(); // refresh the explorer's dirty markers
  }

  // Closes every real file, leaving the scratch buffer if one is open. Used when
  // the project on screen stops being the project - closing the workspace, and
  // opening another folder alike: each document is announced to the LSP as closed
  // and its model destroyed, so nothing is left claiming to be a file in a project
  // that is not open, a later save cannot write to it, and the dirty-document
  // queries the explorer and the compile's save plan make no longer see it.
  //
  // The caller should put another document in the editor FIRST (openScratch),
  // because disposing the model the view is displaying would leave Monaco holding
  // destroyed state. If the active document is closed here regardless, the editor
  // is moved to the scratch buffer when there is one and emptied when there is
  // not - either way it is not left pointing at a disposed model.
  closeFiles() {
    for (const key of this.docs.keys()) {
      if (key === "") continue; // the scratch buffer is not a file
      const model = this.docs.remove(key);
      if (model === null) continue;
      this.lsp.closeDocument(model);
      model.dispose();
    }
    if (this.active !== null && !this.docs.has(this.active)) {
      if (this.docs.has("")) {
        this.activate("");
      } else {
        this.active = null;
        this.editor.setModel(null);
        for (const cb of this.activeListeners) cb();
      }
    }
    // The dirty markers described documents that no longer exist.
    this.fireDirty();
  }

  activate(key: string) {
    const model = this.docs.model(key);
    if (model === null) return;
    this.active = key;
    this.editor.setModel(model);
    this.editor.focus();
    for (const cb of this.activeListeners) cb();
  }

  activeKey(): string | null {
    return this.active;
  }

  // Moves the cursor to (line, column) (both 1-based), centers it, and focuses
  // the editor. Used by the diagnostics list to jump to a warning/error.
  revealPosition(line: number, column: number) {
    const pos = { lineNumber: Math.max(1, line), column: Math.max(1, column) };
    this.editor.setPosition(pos);
    this.editor.revealLineInCenter(pos.lineNumber);
    this.editor.focus();
  }

  activeModel(): monaco.editor.ITextModel | null {
    return this.active === null ? null : this.docs.model(this.active);
  }

  textOf(key: string): string {
    return this.docs.textOf(key);
  }

  isDirty(key: string): boolean {
    return this.docs.isDirty(key);
  }

  /** Whether the document under `key` holds work the disk does not; documents.ts. */
  needsSaving(key: string): boolean {
    return this.docs.needsSaving(key);
  }

  /**
   * Every open FILE whose text would go with it, in the order they were opened.
   * What closing the workspace or switching projects has to confirm first.
   *
   * The scratch buffer is excluded: it has no path, so leaving a project neither
   * closes it nor can lose it. Which documents are at risk is documents.ts's, and so
   * is why the set is stamped with each document's revision rather than named by path;
   * see [`RiskStamp`].
   */
  atRiskFileStamps(): RiskStamp<monaco.editor.ITextModel>[] {
    return this.docs.atRiskStamps().filter((stamp) => stamp.key !== "");
  }

  /**
   * Every open document whose text would be lost by *exiting*, the scratch buffer
   * included. What terminating the application has to confirm first.
   *
   * Deliberately a separate query from `atRiskFileStamps()` rather than the same one
   * used differently: leaving a project keeps the scratch buffer, because it has no
   * path and belongs to no folder, whereas exiting destroys it along with the
   * window. Reusing the filtered list here would discard a dirty scratch buffer
   * without a word, which is exactly the case that has no file to recover it from.
   *
   * Which documents that is is closing.ts's, so that the exit scope is decided in one
   * testable place rather than by which filter each call site happens to apply.
   */
  atRiskExitStamps(): RiskStamp<monaco.editor.ITextModel>[] {
    return atRiskOnExit(this.docs);
  }

  // Every open FILE with unsaved edits, in the order they were opened. The
  // scratch buffer is excluded throughout the app: it has no path, so it can be
  // neither written to disk nor a member of a project.
  dirtyFileKeys(): string[] {
    return this.docs.dirtyKeys().filter((key) => key !== "");
  }

  // Captures the revision of `key` that a save is about to write, or null when
  // there is no such document. Hand the snapshot's `text` to the write and the
  // snapshot itself to completeSave(); see documents.ts for why the two are
  // separate steps.
  beginSave(key: string): EditorSave | null {
    return this.docs.beginSave(key);
  }

  // Captures the document under `key` before a read of its file, to be handed to
  // reconcile() or reloadDoc() afterwards. The same capture a save makes, for the
  // same reason: what comes back describes the document as it was when the read
  // started, and something newer may have happened to it since.
  probe(key: string): EditorProbe | null {
    return this.docs.probe(key);
  }

  // Whether `expect` still names the document that is open: the same key, still
  // open, still the same model. What a queued mutation checks before it acts, having
  // been captured before it waited its turn; see documents.ts.
  holds(expect: EditorProbe): boolean {
    return this.docs.holds(expect);
  }

  // Records what a read found, against the document `expect` probed before it. The
  // decision is documents.ts's; a `reload` outcome is the only one that leaves the
  // caller anything to do.
  //
  // Passing the probe rather than the key is what keeps the conclusion attached to
  // the document it was drawn about: a `stale` outcome means the read no longer
  // describes anything, and nothing at all is recorded.
  reconcile(expect: EditorProbe, disk: DiskState): Reconciliation {
    const outcome = this.docs.reconcile(expect, disk);
    // A conflict - or its resolution - changes what the explorer and the status
    // line say about the document, and both are redrawn from the dirty signal.
    if (outcome.kind !== "reload" && outcome.kind !== "stale") this.fireDirty();
    return outcome;
  }

  // Replaces a clean document with the text just read from its file.
  //
  // Not an edit, and deliberately not treated as one. `reloading` suppresses the
  // content signal, so a reload cannot report the rules as changed and start
  // another invalidate-and-re-analyse cycle over a change that came FROM the disk.
  // The LSP is told once, directly, because the debounced notification the
  // suppressed handler would have scheduled is exactly what was skipped.
  //
  // Nothing is activated and nothing is revealed: an external change to a
  // background document must not take the editor away from what the user is
  // working on. False means the document, its revision or what is known about its
  // file moved while it was being read, and nothing was replaced; see documents.ts.
  reloadDoc(expect: EditorProbe, text: string): boolean {
    this.reloading = true;
    let replaced: boolean;
    try {
      replaced = this.docs.reload(expect, text);
    } finally {
      this.reloading = false;
    }
    if (!replaced) return false;
    this.lsp.changeDocument(expect.model);
    this.fireDirty();
    return true;
  }

  /** How the document under `key` disagrees with the disk, if it does. */
  conflictOf(key: string): ConflictKind | null {
    return this.docs.conflictOf(key);
  }

  // How the document under `key` stands with its file, as one answer a write can be
  // authorised against and re-check later; the decision is documents.ts's.
  diskAnswer(key: string): DiskAnswer {
    return this.docs.diskAnswer(key);
  }

  /** Every open FILE in conflict with the disk, in the order they were opened. */
  conflictedFileKeys(): string[] {
    return this.docs.conflictedKeys().filter((key) => key !== "");
  }

  // Records `snap` as written to disk, and reports whether it still applied.
  //
  // False means the document it describes is no longer open under that key, or a
  // different model is: the workspace was closed, or the file was renamed, while
  // the write was in flight. Nothing is marked clean and no listener is told,
  // because as far as the editor is concerned nothing changed.
  completeSave(snap: EditorSave): boolean {
    if (!this.docs.completeSave(snap)) return false;
    this.fireDirty();
    return true;
  }

  openKeys(): string[] {
    return this.docs.keys();
  }

  onDidChangeActive(cb: () => void) {
    this.activeListeners.push(cb);
  }

  // Fires whenever the dirty markers may need redrawing - including from
  // completeSave(), which is bookkeeping rather than a change to the rules.
  // Anything that must distinguish the two wants onDidChangeContent instead.
  onDidChangeDirty(cb: () => void) {
    this.dirtyListeners.push(cb);
  }

  // Fires only when a real edit changes a document's content.
  //
  // Not on completeSave(), so a compile's own auto-save cannot look like the rules
  // changing underneath it; and not on openFile/openScratch/renameDoc, because a
  // model created with its initial value does not report a content change. This
  // is the signal that a compiled - or compiling - ruleset no longer describes
  // what is in the editor.
  onDidChangeContent(cb: () => void) {
    this.contentListeners.push(cb);
  }

  private fireDirty() {
    for (const cb of this.dirtyListeners) cb();
  }

  private fireContentChanged() {
    for (const cb of this.contentListeners) cb();
  }
}
