// Renamed on import: `confirm` is also a global (and one that does nothing here -
// see the close guard below), so the name has to say which of the two is meant.
import { open, confirm as askNatively } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  analyzeProject,
  compileProject,
  compileScratch,
  scanTarget,
  resetRules,
  readFileBytes,
  readTextFile,
  saveTextFile,
  createFile,
  renameFile,
  prepareExample,
  watchProject,
  watchRelease,
  watchFence,
  watchRearm,
  armFailure,
  debugStatus,
  debugFrontendTrace,
  showHelp,
  WATCH_EVENT,
  type Diagnostic,
  type PreparedExample,
  type PreparedTarget,
  type ProjectAnalysis,
  type WatchNotice,
} from "./ipc";
import { Workspace, type EditorSave } from "./editor";
import { YaraLspClient } from "./lsp/client";
import { ResultsView } from "./results";
import { Operations, type Operation } from "./operations";
import {
  decideRestoration,
  decideRestorationFailure,
  invalidationRequiresReset,
  sameRestoration,
  type BuildOwner,
  type RestorationOwner,
} from "./restoring";
import {
  ProjectSession,
  firstOpenableSource,
  memberPathsOf,
  sourcesOf,
  type AnalysisRequest,
  type InitialPresentationAttempt,
  type InitialPresentationOutcome,
  type Selection,
} from "./project";
import { buildFilesModel, isEmptyFilesModel, type FilesModel } from "./filestree";
import { buildIncludesModel, type IncludesModel } from "./includestree";
import {
  RefTable,
  renderFilesView,
  renderIncludesView,
  renderNotice,
  type ExplorerRef,
} from "./explorer";
import { basename, dirname, isPlainName, joinRoot, openablePath } from "./sourceid";
import { positionAt } from "./bytepos";
import { escapeAttr, escapeHtml } from "./escape";
import { saveDirtyMembers } from "./saveplan";
import { Navigation } from "./navigation";
import { OpenRequests, type OpenRequest } from "./opening";
import { TargetRequests } from "./targets";
import { AutoRefresh } from "./watching";
import { MutationQueue } from "./mutations";
import type { DiskAnswer, DiskState } from "./documents";
import { initMenu, syncMenuState } from "./menu";
import { showAbout } from "./about";
import { reportIssue } from "./reportissue";
import { configurePreferences, refreshPreferences, showPreferences } from "./preferences";
import { CloseCoordinator, discardQuestion } from "./closing";
import {
  answerHolds,
  authorise,
  closeGate,
  compileGate,
  departureGate,
  reloadGate,
  saveGate,
  type Gate,
} from "./authorising";
import { showExamples } from "./examples";
import { installExtraZoomShortcuts, resetZoom, restoreZoom, zoomIn, zoomOut } from "./zoom";
import { redactedException, trace } from "./trace";
import "./styles.css";

trace.event("frontend_start", {});
void debugStatus().then(
  (status) => {
    if (status.enabled) {
      trace.setMirror((line) => debugFrontendTrace(line));
    }
    trace.configure(status);
    trace.event("debug_mode_confirmed", { enabled: status.enabled });
  },
  () => trace.disable(),
);

const SAMPLE_RULE = `rule demo_text_match {
    meta:
        author = "quipu"
        description = "Open a folder of .yar files to begin"
    strings:
        $a = "malware"
        $c = /ev[il]+/ nocase
    condition:
        any of them
}`;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <main>
    <section class="pane explorer" id="explorer">
      <div class="explorer-head">
        <h2>Explorer</h2>
        <div class="actions">
          <button id="open-folder" class="icon-btn" title="Open folder">Open…</button>
          <button id="new-file" class="icon-btn" title="New rule file" disabled>+ New</button>
        </div>
      </div>
      <div id="dir-label" class="muted">No folder open</div>
      <div id="project-status" class="project-status empty"></div>
      <div class="tab-bar explorer-tabs">
        <button class="explorer-tab active" id="tab-files" data-view="files">Files</button>
        <button class="explorer-tab" id="tab-includes" data-view="includes">Includes</button>
        <button id="refresh-project" class="icon-btn refresh" title="Re-read the project from disk" disabled>Refresh</button>
      </div>
      <div id="view-files" class="explorer-view active"></div>
      <div id="view-includes" class="explorer-view"></div>
    </section>
    <div class="splitter" id="splitter" title="Drag to resize"></div>
    <section class="pane editor-pane">
      <div class="pane-head">
        <h2 id="active-file">Rule source</h2>
        <div class="actions">
          <button id="reload-disk" class="hidden" title="Replace this document with the version on disk">Reload from Disk</button>
          <button id="save" disabled>Save</button>
          <button id="compile" title="Compile all rules in the project">Compile</button>
          <button id="scan" class="primary" title="Scan the target with the compiled rules" disabled>Scan</button>
        </div>
      </div>
      <div id="build-status" class="build-status not-compiled">Not compiled</div>
      <div id="rule"></div>
      <div class="pane-head">
        <h2>Scan target</h2>
        <div class="actions">
          <button id="pick">Choose file…</button>
        </div>
      </div>
      <textarea id="target" spellcheck="false" placeholder="Type text to scan, or choose a file."></textarea>
      <div id="target-info" class="muted"></div>
    </section>
    <div class="splitter results-splitter" id="results-splitter" title="Drag to resize">
      <button id="results-chevron" class="chevron" title="Show results">&lsaquo;</button>
    </div>
    <section class="pane results-pane collapsed" id="results-pane">
      <div class="tab-bar">
        <button class="tab active" id="tab-matches" data-tab="matches">Matches <span id="matches-count" class="tab-count">0</span></button>
        <button class="tab" id="tab-problems" data-tab="problems">Problems <span id="problems-count" class="tab-count">0</span></button>
      </div>
      <div id="tab-panel-matches" class="tab-panel active">
        <div id="results"></div>
      </div>
      <div id="tab-panel-problems" class="tab-panel">
        <div id="diagnostics"></div>
      </div>
    </section>
  </main>
  <div id="hex-dock" class="hex-dock hidden">
    <div class="hex-dock-head">
      <span id="hex-title" class="hex-title"></span>
      <button id="hex-close" class="icon-btn" title="Close">✕</button>
    </div>
    <div id="hex-body" class="hex-body"></div>
  </div>
`;

const ruleEl = document.querySelector<HTMLDivElement>("#rule")!;
const targetEl = document.querySelector<HTMLTextAreaElement>("#target")!;
const targetInfo = document.querySelector<HTMLDivElement>("#target-info")!;
const diagnosticsEl = document.querySelector<HTMLDivElement>("#diagnostics")!;
const resultsEl = document.querySelector<HTMLDivElement>("#results")!;
const filesViewEl = document.querySelector<HTMLDivElement>("#view-files")!;
const includesViewEl = document.querySelector<HTMLDivElement>("#view-includes")!;
const dirLabelEl = document.querySelector<HTMLDivElement>("#dir-label")!;
const projectStatusEl = document.querySelector<HTMLDivElement>("#project-status")!;
const activeFileEl = document.querySelector<HTMLHeadingElement>("#active-file")!;
const saveBtn = document.querySelector<HTMLButtonElement>("#save")!;
const reloadBtn = document.querySelector<HTMLButtonElement>("#reload-disk")!;
const newFileBtn = document.querySelector<HTMLButtonElement>("#new-file")!;
const refreshBtn = document.querySelector<HTMLButtonElement>("#refresh-project")!;
const explorerEl = document.querySelector<HTMLElement>("#explorer")!;
const splitterEl = document.querySelector<HTMLDivElement>("#splitter")!;
const mainEl = document.querySelector<HTMLElement>("main")!;
const resultsPaneEl = document.querySelector<HTMLElement>("#results-pane")!;
const resultsSplitterEl = document.querySelector<HTMLDivElement>("#results-splitter")!;
const resultsChevronEl = document.querySelector<HTMLButtonElement>("#results-chevron")!;
const buildStatusEl = document.querySelector<HTMLDivElement>("#build-status")!;
const matchesCountEl = document.querySelector<HTMLElement>("#matches-count")!;
const problemsCountEl = document.querySelector<HTMLElement>("#problems-count")!;

const resultsView = new ResultsView(
  resultsEl,
  document.querySelector<HTMLElement>("#hex-dock")!,
  document.querySelector<HTMLElement>("#hex-title")!,
  document.querySelector<HTMLElement>("#hex-body")!,
  document.querySelector<HTMLElement>("#hex-close")!,
  (ruleName) => void focusRuleInEditor(ruleName),
  (ruleName, pattern) => void focusRuleInEditor(ruleName, pattern)
);

// Locates `rule <name>` across project files (yara-x doesn't expose a matched
// rule's source location) and reveals it in the editor, opening the file if
// needed. Jumps to the first match if the name appears in multiple files.
// When `pattern` is given, additionally locates that string's definition
// (e.g. `$s1 =`) WITHIN the rule body and focuses there instead of the header.
//
// The searching is here and the showing is navigation's, which is what scopes it:
// reading a candidate is an await, and a match found in a project the user has
// since left must not open anything. See navigation.ts.
async function focusRuleInEditor(ruleName: string, pattern?: string) {
  // Every source the project knows about, not just the ones in the root: a matched
  // rule can come from a nested file or from an included dependency outside the
  // project, and the compile that produced the match compiled all of them.
  const candidates = session.isOpen() ? projectSourcePaths() : [workspace.activeKey() ?? ""];
  await navigation.goToRule(
    candidates,
    (text) => ruleLineIn(text, ruleName, pattern),
    (line) => workspace.revealPosition(line, 1),
  );
}

// The 1-based line a rule is declared on within `text`, or null if it is not there.
// With `pattern`, the line that pattern is defined on within the rule's own body.
function ruleLineIn(text: string, ruleName: string, pattern?: string): number | null {
  const ruleRe = new RegExp(`\\brule\\s+${escapeRegExp(ruleName)}\\b`);
  const ruleIdx = text.search(ruleRe);
  if (ruleIdx < 0) return null;

  // Default target: the rule header line.
  let targetIdx = ruleIdx;
  if (pattern) {
    // Search for the pattern definition within this rule's body only: from
    // the rule keyword to the next `rule ` at column 0 (or end of file).
    const nextRule = text.slice(ruleIdx + 1).search(/\nrule\s/);
    const ruleEnd = nextRule < 0 ? text.length : ruleIdx + 1 + nextRule;
    // Pattern ids: $foo / #foo / @foo / !foo - match the definition `$foo =`.
    const id = pattern.replace(/^[$#@!]/, "");
    const defRe = new RegExp(`[$]${escapeRegExp(id)}\\s*=`);
    const rel = text.slice(ruleIdx, ruleEnd).search(defRe);
    if (rel >= 0) targetIdx = ruleIdx + rel;
  }
  return text.slice(0, targetIdx).split("\n").length;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- The open project ----
// One object owns the selected root, the accepted analysis, whether anything is
// still in flight and whether what is on screen may already be out of date. It is
// the only source of truth for "what project is open and what is in it": the
// explorer, the menu's enablement, rename's safety and the compile's membership
// starting point all read it. See project.ts for the ordering rules.
const session = new ProjectSession();
configurePreferences(() => session.loaded()?.root ?? session.root());

function initialPresentationTraceState() {
  const state = session.initialPresentationState();
  if (state.kind === "available") return state;
  if (state.kind === "terminal") return state;
  return {
    kind: state.kind,
    selection: state.attempt.selection.serial,
    order: state.attempt.order,
    attempt: state.attempt.serial,
  };
}

// Every openable path the accepted snapshot reaches, canonical spelling only.
function projectSourcePaths(): string[] {
  const analysis = session.loaded();
  if (analysis === null) return [];
  return sourcesOf(analysis).map((id) => openablePath(analysis.root, id));
}

// Every open document with unsaved edits. The scratch buffer is excluded by the
// editor: it has no path, so it can be neither saved nor a project member.
function dirtyDocuments(): string[] {
  return workspace.dirtyFileKeys();
}

// True when the project a command started under is still the project on screen.
//
// `null` is a selection too - no project at all - so a command that outlives the
// workspace being closed does not go on to treat the next folder opened as the one
// it was working on.
function stillSelected(selection: Selection | null): boolean {
  return selection === null ? !session.isOpen() : session.isCurrent(selection);
}

// ---- Operation tokens ----
// One user action can span several awaits - a compile saves documents, has the
// project re-analysed, then compiles - and the user is free to keep working while
// any of them is in flight. A response that belongs to a project they have left,
// to an operation a newer one has replaced, or to rule text they have since
// edited, must change nothing: the diagnostics, the results, the rule count, the
// build state and therefore Scan's enablement all describe whichever operation is
// current NOW.
//
// `operations` also serialises the ruleset resets those transitions ask for, so a
// reset can never land after the compile that was started to replace it. See
// operations.ts for the reasoning and the tests.
//
// Deliberately separate from the session's selection token. A compile of the
// folder that is still being analysed is legitimate - the backend reads the
// directory itself - so starting one must not cancel the analysis, and the
// analysis must not cancel the compile.
const operations = new Operations(resetRules, (record) => {
  const { event, ...fields } = record;
  trace.event(event, fields);
});

// Starts an operation, superseding any still running.
function beginOperation(): Operation {
  return operations.begin(session.root());
}

function isCurrent(op: Operation): boolean {
  return operations.isCurrent(op, session.root());
}

// Queues a ruleset reset on behalf of `op`, or returns null if `op` no longer owns
// the ruleset and must leave it alone.
function resetFor(op: Operation): Promise<void> | null {
  return operations.resetFor(op, session.root());
}

// ---- Requests to open a project ----
// Open Folder and Open Example both have to get their root before they may touch
// anything: one shows the native picker, the other copies a packaged example into
// an editable working copy. Both are awaits the user can outlive, and neither
// answer says anything about when it was asked for. This counts the gestures, so
// the project the user chose LAST wins however slowly the pickers and the copies
// answer. See opening.ts.
const opens = new OpenRequests();

// Declares that the project's rules no longer match any compiled or compiling
// ruleset: an edit, or an app-controlled mutation such as New Rule or Rename.
//
// Two things have to happen, and marking a *finished* compilation stale is only
// one of them. A compile that is still running has already had its result
// invalidated here, but the backend does not know that: it may be moments from
// installing rules that predate this change, and its response would arrive
// claiming a compiled project. So the backend's generation is advanced too, which
// makes its own store refuse the result. The UI leaves `compiling` for a state
// that cannot be scanned, and Compile is available again immediately.
function invalidateCompilation() {
  operations.invalidate();
  // The common case, and the one that runs on every keystroke: nothing compiled
  // and nothing compiling, so there is no ruleset to drop and no response in
  // flight to head off. Bumping the revision above was the whole cost.
  if (!invalidationRequiresReset(buildState)) return;
  // "Stale" over "not compiled" because it says what to do about it, and the two
  // are equally unscannable. Set before the reset is even issued, so scannability
  // is never advertised while the backend still holds the old rules.
  const currency = operations.currency();
  setBuildState("stale", {
    reason: "compilation_invalidated",
    owner: { kind: "invalidation", revision: currency.revision },
  });
  // Queued, not awaited: Compile has to be usable again this instant, and the
  // barrier is what makes that safe. The next compile waits for this reset before
  // it invokes the backend, so the reset cannot land afterwards and drop the very
  // ruleset that retry installed. Which way this races the abandoned compile's own
  // store no longer needs an argument: a reset landing first makes the store refuse
  // the result, a reset landing second clears what it stored.
  //
  // The rejection is logged rather than shown. There is nowhere sensible to put it
  // mid-keystroke, and it does not need to be shown from here: the barrier holds
  // on to the failure, so the next compile refuses to run and reports it there.
  void operations.requestReset().catch((err) => console.error("invalidate: reset failed", err));
}

const lsp = new YaraLspClient();
const workspace = new Workspace(ruleEl, lsp);

// ---- Asking the user ----
// The one way anything in Quipu asks a yes/no question, and it is the NATIVE dialogue
// rather than `window.confirm`: in this WebKitGTK build `window.confirm` displays
// nothing whatever and returns true, so every guard built on it discarded the user's
// work in silence. Ok/Cancel rather than Yes/No, because the questions tell the user
// to cancel and then save.
//
// One function, so that no destructive path can be wired to the global by accident:
// `confirm` is deliberately not in scope under its own name anywhere in this file (see
// the renamed import at the top). Asking is asynchronous as a result, which is what
// authorising.ts exists to make safe.
function ask(title: string, question: string): Promise<boolean> {
  return askNatively(question, { title, kind: "warning" });
}

// ---- Terminating the application ----
// Every way out of the window - File > Quit on any platform, the title bar and the
// window manager - arrives as one close request, and this is what decides it. See
// closing.ts.
const closing = new CloseCoordinator({
  // The exit-level list, scratch buffer included: exiting destroys it, whereas
  // leaving a project does not, which is why this is not the switch's list.
  atRisk: () => workspace.atRiskExitStamps(),
  confirm: (keys) =>
    ask("Quit Quipu", discardQuestion("Quit Quipu", keys, (key) => workspace.isDirty(key))),
  // The same request the title bar makes, so File > Quit comes back through the
  // handler below instead of terminating anything itself.
  requestWindowClose: () => {
    void getCurrentWindow()
      .close()
      .catch((err) => console.error("closing: requesting the window close failed", err));
  },
});

// Registered here - immediately after the workspace exists, and before the menu is
// built - because the guard only holds while a frontend listener is registered:
// Tauri prevents the native close for exactly as long as one is, and destroys the
// window itself otherwise. This is the earliest point at which there is anything to
// ask about, and it puts the registration ahead of every other startup await,
// including the one that creates the menu item that can request a close.
//
// Not preventing the default is what lets the window be destroyed, so every path
// that is not an approved close must prevent - a thrown guard included. Refusing to
// exit costs the user a second gesture; exiting on a guard that could not run costs
// them their work.
void getCurrentWindow()
  .onCloseRequested(async (event) => {
    let decision: "close" | "keep";
    try {
      decision = await closing.closeRequested();
    } catch (err) {
      console.error("closing: the unsaved-work guard failed, so the window stays open", err);
      decision = "keep";
    }
    if (decision === "keep") event.preventDefault();
  })
  .catch((err) => {
    console.error("closing: failed to install the window close guard", err);
  });

// Every gesture that takes the editor to a document goes through here, so that one
// place decides whether a read that has just landed still belongs to the project on
// screen. See navigation.ts; the host below is the Monaco, IPC and DOM half it
// deliberately does not know about.
const navigation = new Navigation<Selection, ProjectAnalysis>({
  selection: () => session.selection(),
  isSelected: stillSelected,
  analysis: () => session.analysis(),
  isOpen: (path) => workspace.openKeys().includes(path),
  activeKey: () => workspace.activeKey(),
  textOf: (path) => workspace.textOf(path),
  read: (path) => readTextFile(path),
  open: (path, text) => workspace.openFile(path, text),
  activate: (path) => workspace.activate(path),
  fail: (err) => showFailure(err),
  explicitNavigationStarted: () => {
    const retired = session.retireInitialPresentationForUser();
    trace.event("initial_presentation_retired", {
      reason: "explicit_navigation",
      retired,
      state: initialPresentationTraceState(),
    });
  },
});

// ---- Automatic refresh ----
// The project's inputs are watched natively, and a change to any of them is a hint
// that what is on screen - and what is compiled - may no longer describe the disk.
// The coordinator owns the counted subscription, the debounce window and the
// promise that no event is lost and no two automatic analyses overlap; everything
// below is the half of it that touches IPC, Monaco and the DOM. See watching.ts.
const watching = new AutoRefresh(
  {
    start: (subscription, root) => {
      trace.event("watch_subscription_started", { subscription });
      const armed = watchProject(root, subscription);
      void armed.then(
        () => trace.event("watch_subscription_armed", { subscription }),
        (error) =>
          trace.event("watch_subscription_failed", {
            subscription,
            ...redactedException(error),
          }),
      );
      return armed;
    },
    // Fire-and-forget: the backend ignores a release that a newer subscription has
    // already overtaken, so nothing here depends on when it lands. Losing the
    // release would mean watching a folder nobody is looking at, which is worth a
    // log and nothing more.
    release: (subscription) => {
      trace.event("watch_subscription_released", { subscription });
      void watchRelease(subscription).catch((err) => console.error("watch: release failed", err));
    },
    // The first thing that happens, synchronously, on every reported change:
    // whatever is compiled or compiling describes a project that has moved, so
    // Scan goes away at once and the snapshot is marked as possibly out of date.
    // Both are cheap to repeat and neither waits for the debounce window.
    invalidate: () => {
      trace.event("watch_changed_invalidation", { subscription: watching.subscription() });
      invalidateCompilation();
      session.markStale();
      renderProjectStatus();
    },
    refresh: async (subscription) => {
      trace.event("watch_refresh_started", {
        subscription,
        activity: watching.isRespondingToChange() ? "changed" : "coverage_catch_up",
      });
      try {
        await respondToChanges(subscription);
        trace.event("watch_refresh_completed", { subscription });
      } catch (error) {
        trace.event("watch_refresh_failed", { subscription, ...redactedException(error) });
        throw error;
      }
    },
    render: () => renderProjectStatus(),
  },
  { set: (fn, ms) => window.setTimeout(fn, ms), clear: (handle) => window.clearTimeout(handle) },
);

// Why the notices could not be subscribed to at all, or null. Distinct from the
// coordinator's own degradation, which is per project: this one is fatal to
// automatic refresh for the lifetime of the window, and the status line has to say
// so rather than let the user believe the views keep themselves up to date.
let noticesUnavailable: string | null = null;

// One listener for the whole window, installed once. The subscription identity in
// the payload is what scopes a notice to a project, so there is nothing to
// re-subscribe on a folder switch - and a notice from the folder the user has left
// is dropped by the coordinator rather than by unsubscribing in time.
void listen<WatchNotice>(WATCH_EVENT, (event) => {
  const notice = event.payload;
  trace.event("watch_notice_received", {
    kind: notice.kind,
    subscription: notice.subscription,
    instance: "instance" in notice ? notice.instance : null,
    catchUp: "catchUp" in notice ? notice.catchUp : false,
    pathCount: "paths" in notice ? notice.paths.length : 0,
  });
  if (notice.kind === "changed") watching.changed(notice.subscription);
  // Coverage the last analysis derived is armed now, in full, which is proof that
  // watching this project works. Whether it also read something before anything
  // watched it is the backend's own answer to give: completing a plan by taking over
  // coverage already being delivered owes nothing. Deliberately not an invalidation
  // either way: nothing has said anything changed.
  else if (notice.kind === "covered")
    watching.covered(notice.subscription, notice.catchUp, notice.instance);
  // Part of it armed and part of it did not. Whether the part that did owes the same
  // catch-up analysis is the backend's answer to give - the paths it sends are for
  // display, and a plan can widen what counts inside a directory it was already
  // watching without naming anywhere new - and the part that did not is degradation
  // the status line has to keep showing.
  else if (notice.kind === "partial")
    watching.partial(notice.subscription, notice.message, notice.catchUp, notice.instance);
  // A watcher failure, for the instance it is news about. Every notice above announces
  // the arm it belongs to, and this listener is where they meet in one order - which is
  // what lets the coordinator drop an error from an instance that has been replaced, and
  // keep one from the instance an announcement is merely about: a handler is installed
  // before its arm returns, so a failure can arrive ahead of that announcement.
  else watching.failed(notice.subscription, notice.message, notice.instance);
}).catch((err) => {
  trace.event("watch_listener_failed", redactedException(err));
  noticesUnavailable = String(err);
  console.error("watch: could not listen for notices", err);
  renderProjectStatus();
});

// Why automatic refresh is unavailable, or null while it works.
function watcherDegradation(): string | null {
  return noticesUnavailable ?? watching.degradation();
}

// The whole automatic response to a burst of changes: bring the open documents back
// into agreement with the disk, then re-read the project.
//
// In that order, and both scoped to `subscription`. Reconciliation first because
// whether a snapshot arrives stale depends on which documents are unsaved, and a
// document being reloaded is one that stops being unsaved. Every read is guarded on
// the subscription AND the selection, so a project the user has left changes
// nothing here (see reconcileDocument).
async function respondToChanges(subscription: number): Promise<void> {
  const selection = session.selection();
  await reconcileOpenDocuments(() => watching.isCurrent(subscription) && stillSelected(selection));
  if (!watching.isCurrent(subscription)) return;
  await refreshProject();
}

// Compares every open project document with its file, and either reloads it,
// leaves it alone, or marks it as diverged. `current` says whether the answers are
// still wanted; see documents.ts for the decision itself.
//
// The scratch buffer is skipped throughout: it has no path, so there is no file for
// it to disagree with.
async function reconcileOpenDocuments(current: () => boolean): Promise<void> {
  const keys = workspace.openKeys().filter((key) => key !== "");
  await Promise.all(keys.map((key) => reconcileDocument(key, current)));
  if (!current()) return;
  renderFiles();
  refreshActiveUI();
  renderProjectStatus();
}

// What is at `key` now, as one comparable answer for reconcile().
//
// A read that fails is "not there": removed, renamed away, or no longer readable all
// mean the same thing to a document - its text is the only copy left, so it stays open
// and marked rather than closed or replaced. Deliberately not reported as a failure: a
// file being deleted is a normal thing for a file to have happen, and the marker and
// the status line say so.
async function readDiskState(key: string): Promise<DiskState> {
  try {
    return { present: true, text: await readTextFile(key) };
  } catch {
    return { present: false };
  }
}

async function reconcileDocument(key: string, current: () => boolean): Promise<void> {
  // Captured before the read: what comes back describes THIS model at THIS
  // revision, and reloading anything else with it would be replacing text that
  // nobody read. The guard is applied in workspace.reloadDoc().
  const expect = workspace.probe(key);
  if (expect === null) return;
  const disk = await readDiskState(key);
  if (!current()) return;
  // The probe, not the key: a rename can have put a different document under this
  // key while the file was being read, and a conclusion drawn about the one that
  // was probed says nothing about that one. See documents.ts.
  const outcome = workspace.reconcile(expect, disk);
  // The only outcome with anything left to do. A clean document whose file changed
  // is brought up to date; everything else - unchanged, already equal to the
  // editor's text, missing, or conflicting with unsaved edits - was recorded by
  // reconcile() itself, and a document with unsaved edits is never replaced.
  if (outcome.kind !== "reload") return;
  workspace.reloadDoc(expect, outcome.text);
}

// How many app-owned mutations are behind the fence right now, per subscription.
//
// They overlap - a compile's auto-save while a rename is still writing - and each
// holds a fence of its own, so the watcher only comes back when the last of them
// leaves. That is also the only moment at which there is one finished interval to
// catch up on rather than a half-written one, so the catch-up belongs to whichever
// mutation leaves last, not to whichever started first.
//
// Counted per subscription rather than once for the window, because a mutation can
// outlive the project it belongs to: a save whose write is still in flight when the
// user opens another folder stays outstanding until it finishes. One shared count
// would let it stand in the way of the CURRENT project's catch-up - the new
// project's mutation would not be the last one out, so it would owe nothing - and
// the abandoned one cannot perform that catch-up either, because its subscription is
// no longer the one on screen. The result would be a New Rule or a Rename whose file
// never reaches the project model at all.
const mutating = new Map<number, number>();

// Records a mutation of `subscription` as outstanding.
function beginMutation(subscription: number): void {
  mutating.set(subscription, (mutating.get(subscription) ?? 0) + 1);
}

// Records one as finished, and reports whether it was the last one `subscription`
// had outstanding - which is what owes the catch-up. The entry is dropped at zero,
// so a project that has been left behind stops being counted at all.
function endMutation(subscription: number): boolean {
  const left = (mutating.get(subscription) ?? 1) - 1;
  if (left > 0) {
    mutating.set(subscription, left);
    return false;
  }
  mutating.delete(subscription);
  return true;
}

// Orders the filesystem changes Quipu makes itself, so that two of them never touch
// the disk at the same time. See mutations.ts; every mutation goes through fenced(),
// which is where the turn is claimed.
const mutations = new MutationQueue();

// Whose fence this is, which decides one thing: whether a compiled or compiling
// ruleset survives the interval.
//
// A fence is a blind interval. Nothing is watching, so nothing reports what happens in
// it, and the catch-up that ends it reads the disk rather than being told - which is
// why it deliberately invalidates nothing, or Quipu's own save would cost the user
// their compile. That is only safe if the mutation itself has already answered for the
// interval it is about to open.
//
// A compile's own auto-save is the one mutation that must not answer no: it writes
// exactly the documents it is about to compile, and superseding itself would mean no
// compile could ever finish. Every other mutation changes the files the compiler reads
// on somebody else's behalf, so it supersedes whatever is compiled or compiling before
// the interval opens - including a Save, which can recreate a file a compile in flight
// was analysing the absence of.
//
// That covers the interval, which is not the same as covering what happens in it: a
// compile begun after the fence went up gets an operation of its own and is not
// superseded by this. It does not need to be for a Save, whose write it is queued behind
// and whose document it re-reads and re-decides. New Rule and Rename Rule are different -
// they change WHICH files the project has, and such a compile's plan was captured before
// that - so they supersede again once they have acted.
type FenceOwner = "compile" | "mutation";

// Performs a filesystem change Quipu is making itself: in turn, and with the native
// watcher retired for the duration.
//
// Save, the compile's auto-save, New Rule and Rename Rule all change files the
// watcher is watching. Without this, each of them would report itself back as an
// external change: a redundant analysis, a compile invalidated by its own
// auto-save, and - worst - a conflict raised against Quipu's own write.
//
// They also overlap each other. Save stays available while its write is pending, and
// the compile's auto-save and Rename are separate gestures again - so two writes to
// one path would land in completion order, and a save overlapping a rename would
// re-create the path the rename emptied. The queue is what stops that; nothing later
// can, because a write cannot be taken back. What the queue does NOT do is decide
// whether the mutation still makes sense when its turn comes: that is each command's
// own re-check, on the far side of the wait.
//
// Not a timeout and not an "ignore the next event" rule, both of which are guesses
// about timing. What the fence establishes is an ordering: the watcher's gate is
// closed before `watchFence` returns, so a callback either reads it afterwards and
// is inert, or read it before - in which case it was already past the check when
// the fence went up, and the event it carries describes the disk as it was BEFORE
// this write. Either way this write is not reported. Dropping the native watcher
// does not wait for its thread and does not need to (see watch/native.rs).
//
// The body runs with the fence up, which is where every consequence of the mutation
// belongs too - re-keying a renamed document in particular, because the catch-up
// below reads whatever is open by then and would find a moved document missing.
//
// Neither the fence nor the catch-up may replace the body's result. A fence, a
// re-arm or a catch-up that fails is watcher degradation - manual Refresh still
// works - and the user is never asked to repeat a write that succeeded.
async function fenced<T>(owner: FenceOwner, body: () => Promise<T>): Promise<T> {
  const subscription = watching.subscription();
  // Before the turn is claimed, before the fence is asked for, and before anything is
  // written: from this moment nothing compiled or compiling describes the project. A
  // mutation that invalidated after its write instead - or not at all, leaving it to the
  // catch-up, which deliberately invalidates nothing - would let a compile that started
  // earlier finish across this blind interval and offer Scan against rules produced
  // before the mutation existed. A mutation that then decides not to write anything has
  // cost a recompile, which is the cheaper mistake.
  if (owner === "mutation") invalidateCompilation();
  // Claimed synchronously, before anything is awaited - including before the fence is
  // asked for - because the order that decides the disk has to be the order the
  // gestures were made in, and every await between a gesture and its write is a
  // chance for two mutations to change places.
  const turn = mutations.claim();
  // Counted now rather than when the turn comes, so that a mutation still waiting is
  // already outstanding: the one in front of it is then not the last one out and does
  // not catch up on an interval this one is about to write into again.
  if (subscription !== 0) beginMutation(subscription);
  // Asked for while the turn is still being waited on, not after it. The fences of
  // one subscription overlap by design - the backend counts them by token and re-arms
  // only when the last is released - so an early fence costs nothing but a watcher
  // that stays retired slightly longer, and the round trip is off the critical path
  // between one write finishing and the next starting.
  //
  // A rejection does not say whether the fence went up. It may not have - and then this
  // write may come back as an external change, which is a redundant refresh and, for a
  // document about to be recorded as saved, a reconcile that finds the file holding
  // exactly what was written. Or it went up and the answer was lost on the way back, and
  // then the watcher is retired behind a token nobody holds: no release will ever lift
  // it, so nothing is watching until the project is re-opened - which clears the
  // registry's fences with the subscription. Recorded as degradation either way, and the
  // write goes ahead: refusing to save because a watcher misbehaved would be worse.
  //
  // Against no identity at all, and deliberately not 0. A fence reserves none, so there
  // is none to name; what it does instead is retire the live instance, whose coverage
  // notice may be in flight on the event channel this moment - and 0 would let that
  // notice answer this degradation, saying automatic refresh is working while nothing is
  // armed. Naming the retired instance is not available either: the frontend's mark is a
  // lower bound, and a fence can retire an instance it has not been told about yet. See
  // `AutoRefresh.failed`.
  //
  // 0 is still the token, meaning what it means from the backend: nothing to release.
  const fence =
    subscription === 0
      ? Promise.resolve(0)
      : watchFence(subscription).catch((err: unknown) => {
          watching.failed(subscription, String(err), null);
          return 0;
        });
  let token = 0;
  try {
    await turn.ready;
    token = await fence;
    return await body();
  } finally {
    // The turn is given up before the fence is released: what has to be serialised is
    // the writing, and the re-arm and the catch-up read that follow it are neither.
    // Holding the queue across them would make every mutation wait on the previous
    // one's project read.
    turn.done();
    // Awaited, and from the finally, so it happens whether the body succeeded or
    // threw: a caller that has awaited fenced() may rely on the watcher being live
    // again and on the interval it fenced having been reconciled.
    if (subscription !== 0) await endFence(subscription, token, endMutation(subscription));
  }
}

// Ends one fence: the watcher is re-armed, and the last mutation to leave catches
// up on the interval nothing was watching.
//
// The catch-up is what makes a genuine external change made during a save
// survivable. The events for that interval are gone - there was no watcher to
// deliver them - so nothing will ever report it; only reading the files and
// re-reading the project can, and doing so is the caller's job precisely because
// the backend cannot tell Quipu's own write from anybody else's.
//
// In that order, and never the other way round: reconciling before the watcher is
// live would leave a second blind interval between the read and the re-arm, which
// is the very gap this exists to close.
async function endFence(subscription: number, token: number, last: boolean): Promise<void> {
  if (token !== 0) {
    try {
      await watchRearm(subscription, token);
    } catch (err) {
      // Automatic refresh is gone until the project is re-opened. The catch-up
      // below still runs: it is the last thing that will look at this interval.
      //
      // Reported under the identity the failed attempt reserved, because this
      // rejection did not travel on the channel the notices do: the announcement of
      // the coverage this fence retired may still be in flight there, and without a
      // number of its own this degradation would be cleared by news older than it.
      // A rejection that could not say which identity it had reports none, and that
      // stands until the project is re-opened - see `AutoRefresh.failed`.
      const failure = armFailure(err);
      watching.failed(subscription, failure.message, failure.attempt);
    }
  }
  // Only the last mutation out OF THIS SUBSCRIPTION, and only for the project still
  // on screen. A save the user has outlived reconciles nothing: its documents are
  // closed and its project is not the one being shown - and by the same token it
  // does not get to decide whether the project that IS on screen is caught up on.
  if (!last || !watching.isCurrent(subscription)) return;
  try {
    await respondToChanges(subscription);
  } catch (err) {
    // respondToChanges reports its own failures where a failed refresh reports
    // them; anything left here is bookkeeping, and it must not surface as the
    // mutation having failed.
    console.error("watch: catching up after an app-owned write failed", err);
  }
}

// Counts conflict resolutions per document, so that only the newest one for a given
// document may install anything.
//
// Per document rather than one counter for all of them: reloading a.yar says nothing
// about a reload of b.yar the user asked for first, and dropping it would silently
// discard a gesture they made.
const resolutions = new Map<string, number>();

function beginResolution(key: string): number {
  const next = (resolutions.get(key) ?? 0) + 1;
  resolutions.set(key, next);
  return next;
}

function isCurrentResolution(key: string, request: number): boolean {
  return resolutions.get(key) === request;
}

// Open documents only after the LSP handshake completes (openDocument/
// changeDocument are no-ops until then). The scratch buffer lets the editor
// work before a folder is opened.
void lsp.start().then(() => {
  workspace.openScratch(SAMPLE_RULE);
  refreshActiveUI();
});

// The Files view marks the active file, so it is redrawn here rather than by each
// command that happens to activate a document.
workspace.onDidChangeActive(() => {
  // Whoever caused it. An automatic open that is still reading its file gives way to
  // this, because the editor is now showing what someone asked for by name.
  navigation.activated();
  renderFiles();
  refreshActiveUI();
});
// Dirty markers and the Save button, and nothing else. A completed save fires
// this, so the compile's own auto-save comes through here - which is exactly why the
// compilation lifecycle is NOT driven from it. Doing so would have a compile
// invalidate itself the moment it saved the documents it was about to compile.
workspace.onDidChangeDirty(() => {
  renderFiles();
  refreshActiveUI();
});

// A real edit to rule content. This is the signal that a compiled - or still
// compiling - ruleset no longer describes the project.
workspace.onDidChangeContent(() => {
  invalidateCompilation();
  // The project's STRUCTURE is not re-read here. An edit can change it - typing
  // `include "dep.yar"` adds a file to the project - but analysing per keystroke
  // would ask the backend to read the directory for every character, and would
  // answer from a file whose new include is not on disk yet. So the snapshot is
  // marked as possibly out of date instead, and the status line says what
  // refreshes it. An analysis already in flight is covered by the same mark: it
  // arrives stale rather than arriving current.
  const wasStale = session.isStale();
  session.markStale();
  if (!wasStale && session.isStale()) renderProjectStatus();
});

// ---- Compile/scan state machine ----
// Scan is only valid against a freshly compiled ruleset. Editing any rule
// invalidates it. The status line is the primary signal (button text alone was
// too weak).
type BuildState = "not-compiled" | "restoring" | "compiling" | "compiled" | "stale";
let buildState: BuildState = "not-compiled";
let buildOwner: BuildOwner = { kind: "none" };
let lastRuleCount = 0;
// An in-flight scan isn't a BuildState (the ruleset stays compiled throughout),
// but the menu needs it to disable Scan Target for the duration - the button
// conveys this by relabelling itself. Declared here, with the rest of the
// compile/scan state, because refreshMenu() reads it.
let scanning = false;

function setBuildState(
  state: BuildState,
  change: { ruleCount?: number; reason: string; owner: BuildOwner },
) {
  const previous = buildState;
  const previousOwner = buildOwner;
  buildState = state;
  buildOwner = change.owner;
  if (change.ruleCount != null) lastRuleCount = change.ruleCount;
  trace.event("build_state_transition", {
    previous,
    next: state,
    reason: change.reason,
    previousOwner,
    owner: buildOwner,
  });
  buildStatusEl.className = `build-status ${state}`;
  switch (state) {
    case "not-compiled":
      buildStatusEl.textContent = "Not compiled";
      break;
    case "compiling":
      buildStatusEl.textContent = "Compiling…";
      break;
    case "restoring":
      buildStatusEl.textContent = "Checking compiled cache…";
      break;
    case "compiled":
      buildStatusEl.textContent = `Compiled ✓ — ${lastRuleCount} rule${lastRuleCount === 1 ? "" : "s"}`;
      break;
    case "stale":
      buildStatusEl.textContent = "Stale — rules changed, recompile";
      break;
  }
  // Scan only when we have a valid compiled ruleset; both disabled while busy.
  scanBtn.disabled = state !== "compiled";
  compileBtn.disabled = state === "compiling";
  refreshMenu();
}

// ---- Results drawer ----

// Both of these end with refreshMenu() so the View > Results Pane check item
// tracks the drawer no matter what moved it - chevron, View menu, or a
// compile/scan that surfaced its output.
function openResultsDrawer() {
  resultsPaneEl.classList.remove("collapsed");
  mainEl.classList.add("results-open");
  resultsChevronEl.innerHTML = "&rsaquo;"; // ">" collapses
  resultsChevronEl.title = "Collapse results";
  refreshMenu();
}

function closeResultsDrawer() {
  resultsPaneEl.classList.add("collapsed");
  mainEl.classList.remove("results-open");
  resultsChevronEl.innerHTML = "&lsaquo;"; // "<" expands
  resultsChevronEl.title = "Show results";
  refreshMenu();
}

resultsChevronEl.addEventListener("click", (e) => {
  // Don't let the click initiate a drag on the parent splitter.
  e.stopPropagation();
  toggleResults();
});

// ---- View controls ----
// Layout state lives in CSS classes on <main>, so the drag-set column widths
// (--explorer-width / --results-width) survive a hide/show cycle untouched.

function toggleExplorer() {
  mainEl.classList.toggle("explorer-hidden");
  refreshMenu();
}

// Toggles the results drawer through the same functions the chevron and the
// compile/scan flows use. Opening an empty pane is allowed: from the View menu
// that is the only way to inspect the (possibly empty) tabs.
function toggleResults() {
  if (mainEl.classList.contains("results-open")) closeResultsDrawer();
  else openResultsDrawer();
  refreshMenu();
}

// Back to the layout the app starts with: default column widths (dropping the
// inline overrides restores the values declared in styles.css), explorer shown,
// results collapsed. Deliberately touches layout only - editor content, project,
// compile state, results and which explorer view is selected are left alone.
function resetLayout() {
  mainEl.style.removeProperty("--explorer-width");
  mainEl.style.removeProperty("--results-width");
  mainEl.classList.remove("explorer-hidden");
  closeResultsDrawer();
  refreshMenu();
}

// ---- Draggable splitters ----
// Each splitter drags a CSS column-width variable; the editor (1fr) absorbs
// the slack. `sign` flips the delta for the right-hand (results) splitter,
// whose width grows as the pointer moves left.
function makeSplitter(
  el: HTMLElement,
  measure: () => number,
  varName: string,
  sign: 1 | -1,
  min: number,
  max: number,
  enabled: () => boolean
) {
  el.addEventListener("pointerdown", (e) => {
    // Clicks on a child control (e.g. the results chevron) must not start a
    // drag — setPointerCapture here would swallow the child's click.
    if (e.target !== el) return;
    if (!enabled()) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = measure();
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(max, Math.max(min, startWidth + sign * (ev.clientX - startX)));
      mainEl.style.setProperty(varName, `${next}px`);
    };
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  });
}

makeSplitter(
  splitterEl,
  () => explorerEl.getBoundingClientRect().width,
  "--explorer-width",
  1,
  140,
  500,
  () => true
);

makeSplitter(
  resultsSplitterEl,
  () => resultsPaneEl.getBoundingClientRect().width,
  "--results-width",
  -1,
  240,
  700,
  () => mainEl.classList.contains("results-open") // only resize when open
);

// ---- Results tabs ----

function showTab(tab: "matches" | "problems") {
  for (const t of document.querySelectorAll<HTMLElement>(".tab")) {
    t.classList.toggle("active", t.dataset.tab === tab);
  }
  for (const p of document.querySelectorAll<HTMLElement>(".tab-panel")) {
    p.classList.toggle("active", p.id === `tab-panel-${tab}`);
  }
}

for (const t of document.querySelectorAll<HTMLElement>(".tab")) {
  t.addEventListener("click", () => showTab(t.dataset.tab as "matches" | "problems"));
}

// ---- Explorer ----
// Two views of the same accepted analysis: Files, the project's own sources as a
// directory tree, and Includes, its graph. Both models are pure and tested
// (filestree.ts, includestree.ts); everything here is state and DOM.

// Which view is selected lives in the DOM classes alone, so there is nothing to
// keep in step with it: both views are always drawn, and CSS shows one of them.
type ExplorerView = "files" | "includes";

// Cached view models, rebuilt only when the accepted analysis changes. The Files
// tree is also redrawn for dirty markers and the active file, which have nothing
// to do with the analysis, so rebuilding the model on every render would be work
// for nothing.
let filesModel: FilesModel | null = null;
let includesModel: IncludesModel | null = null;
// The rows of the last render pass of each view, so a click can be resolved back
// to the model object it came from rather than to a path parsed out of the DOM.
let filesRefs = new RefTable();
let includesRefs = new RefTable();
// Which disclosures the user has collapsed, by node name. Held here rather than
// in the DOM so a redraw does not re-expand the folder they have just closed.
const collapsedFiles = new Set<string>();
const collapsedIncludes = new Set<string>();
// Bumped whenever something OTHER than the editor's own markers changes what the
// Files tree would draw. Together with the active and dirty keys it is the
// signature the redraw is skipped on: the dirty signal fires on every keystroke,
// while only the first one after a save changes anything visible.
let viewsStamp = 0;
let filesDrawn = "";

function selectExplorerView(view: ExplorerView) {
  for (const t of document.querySelectorAll<HTMLElement>(".explorer-tab")) {
    t.classList.toggle("active", t.dataset.view === view);
  }
  filesViewEl.classList.toggle("active", view === "files");
  includesViewEl.classList.toggle("active", view === "includes");
}

for (const t of document.querySelectorAll<HTMLElement>(".explorer-tab")) {
  t.addEventListener("click", () => selectExplorerView(t.dataset.view as ExplorerView));
}

// View > Includes View. Reveals the pane as well as switching to the view -
// choosing it while the Explorer is hidden has to show something - but it is not
// the Explorer toggle: that still shows and hides the whole pane, whichever view
// is selected inside it.
function showIncludesView() {
  mainEl.classList.remove("explorer-hidden");
  selectExplorerView("includes");
  refreshMenu();
}

// Rebuilds both view models from the accepted analysis and redraws everything
// that depends on it. Called on every accepted analysis, every failure, and every
// project open or close - the one place the views learn that the project changed.
function rebuildProjectViews() {
  const analysis = session.analysis();
  const loaded = session.loaded();
  filesModel = loaded === null ? null : buildFilesModel(loaded);
  includesModel = analysis === null ? null : buildIncludesModel(analysis);
  viewsStamp += 1;
  renderFiles();
  renderIncludes();
  refreshProjectControls();
  refreshMenu();
}

// What a view shows when there is no tree to draw. Shared by both, because "no
// project", "still analysing" and "the analysis could not be performed" are
// properties of the session rather than of either view.
function sessionNotice(): { message: string; hint?: string } | null {
  switch (session.phase()) {
    case "closed":
      return { message: "No project open.", hint: "Open a folder to begin." };
    case "opening":
      return { message: "Analysing the project…" };
    case "failed":
      // Not an empty project: the analysis itself could not be performed, and
      // saying "no files" would be a claim about the folder that nothing supports.
      return { message: "This folder could not be analysed.", hint: String(session.failure()) };
    case "ready":
      return null;
  }
}

function renderFiles() {
  const active = workspace.activeKey();
  const dirty = dirtyDocuments();
  const conflicted = workspace.conflictedFileKeys();
  // Quoted rather than concatenated, so no combination of an active file, a dirty
  // list and a conflicted list can spell the same signature two different ways -
  // whatever characters a path on this platform is allowed to contain.
  const stamp = JSON.stringify([viewsStamp, active, dirty, conflicted]);
  if (stamp === filesDrawn) return;
  filesDrawn = stamp;

  const notice = sessionNotice();
  if (notice !== null) {
    filesRefs = renderNotice(filesViewEl, notice.message, notice.hint);
    return;
  }
  if (filesModel === null) {
    // Ready, but with no snapshot: the project's definition is broken, so it has
    // no sources to list and the issue that says why is in the other view.
    filesRefs = renderNotice(
      filesViewEl,
      "This project's configuration could not be read.",
      "See the Includes view for the problem.",
    );
    return;
  }
  if (isEmptyFilesModel(filesModel)) {
    filesRefs = renderNotice(
      filesViewEl,
      "No rule files in this folder.",
      "New Rule… creates one in the project root.",
    );
    return;
  }
  const unsaved = new Set(dirty);
  filesRefs = renderFilesView(filesViewEl, filesModel, {
    active,
    dirty: (path) => unsaved.has(path),
    conflict: (path) => workspace.conflictOf(path),
    collapsed: (node) => collapsedFiles.has(node),
  });
}

function renderIncludes() {
  const notice = sessionNotice();
  if (notice !== null) {
    includesRefs = renderNotice(includesViewEl, notice.message, notice.hint);
    return;
  }
  if (includesModel === null) {
    includesRefs = renderNotice(includesViewEl, "No analysis for this project.");
    return;
  }
  if (includesModel.empty) {
    includesRefs = renderNotice(
      includesViewEl,
      "Nothing to show.",
      "This project has no sources and no problems.",
    );
    return;
  }
  includesRefs = renderIncludesView(includesViewEl, includesModel, (node) =>
    collapsedIncludes.has(node),
  );
}

// The project status line, and the two controls that follow the session rather
// than the editor.
function refreshProjectControls() {
  // New Rule waits for the INITIAL analysis only: its file would not be in a
  // snapshot already in flight, and the auto-open would push its new document
  // straight out of the editor. A refresh does not gate it - the project is fully
  // known by then. Compile is deliberately not gated either way: it asks the
  // backend to read the directory itself.
  newFileBtn.disabled = !session.isOpen() || session.isLoading();
  refreshBtn.disabled = !session.isOpen();
  renderProjectStatus();
}

function renderProjectStatus() {
  const classes = ["project-status"];
  const parts: string[] = [];
  const phase = session.phase();
  if (phase === "closed") {
    projectStatusEl.className = "project-status empty";
    projectStatusEl.textContent = "";
    projectStatusEl.title = "";
    return;
  }
  if (phase === "opening") parts.push("Analysing the project…");
  if (phase === "failed") {
    classes.push("bad");
    parts.push(`Could not analyse this folder: ${String(session.failure())}`);
  }
  if (phase === "ready") {
    const loaded = session.loaded();
    if (loaded === null) {
      classes.push("bad");
      parts.push("Broken configuration");
    } else {
      const count = filesModel?.count ?? 0;
      parts.push(`${count} ${count === 1 ? "file" : "files"}`);
      if (!loaded.compilable) parts.push("not compilable");
    }
    if (watching.isRespondingToChange()) {
      // Distinct from both of the states below, and said first because it is the
      // only one the user did not cause: something outside Quipu changed the
      // project and it is being re-read without being asked. "Save or compile
      // re-reads it" would be wrong advice here - nothing needs doing.
      //
      // Only for a REPORTED change. The other reason an automatic analysis runs is
      // that coverage was armed over something read before it was watched, and
      // nothing has said anything changed then: that one shows as "re-reading…"
      // below, which is all it is.
      classes.push("stale");
      parts.push("changes detected, updating…");
    } else if (session.isRefreshing()) {
      parts.push("re-reading…");
    } else if (session.failure() !== null) {
      // A refresh failed on top of a snapshot that is still being shown. Both
      // facts belong here: what is on screen is the older answer, and the attempt
      // to replace it did not work.
      classes.push("bad");
      parts.push(`refresh failed: ${String(session.failure())}`);
    } else if (session.isStale()) {
      classes.push("stale");
      parts.push("may be out of date, saving or compiling re-reads it");
    }
  }
  // Both of these outlive the phases above: a document can still be conflicted
  // while the project is being re-analysed, and a lost watcher stays lost until the
  // project is re-opened.
  const conflicts = workspace.conflictedFileKeys();
  if (conflicts.length > 0) {
    classes.push("bad");
    parts.push(conflictSummary(conflicts));
  }
  const degraded = watcherDegradation();
  if (degraded !== null) parts.push("automatic refresh unavailable, use Refresh");
  // The watcher's own message goes in the tooltip rather than the line. It is
  // infrastructure trouble, and it must not crowd out - or be mistaken for - what
  // the analysis says about the project itself.
  projectStatusEl.title = degraded ?? "";
  projectStatusEl.className = classes.join(" ");
  // textContent, not innerHTML: a failure string is backend text and a file count
  // needs no markup, so there is nothing here to escape.
  projectStatusEl.textContent = parts.join(", ");
}

// How the open documents disagree with the disk, in one clause. Named only when a
// single document is involved: a list of paths would wrap the status line to
// several times its height, which is the one thing this area must not do.
function conflictSummary(keys: string[]): string {
  const missing = keys.filter((key) => workspace.conflictOf(key) === "missing").length;
  if (keys.length === 1) {
    const name = basename(keys[0]);
    return missing === 1 ? `${name} is no longer readable on disk` : `${name} changed on disk`;
  }
  if (missing === keys.length) return `${keys.length} open files are no longer readable on disk`;
  if (missing === 0) return `${keys.length} open files changed on disk`;
  return `${keys.length} open files no longer agree with the disk`;
}

// A `toggle` event does not bubble, but it does propagate down, so one
// capture-phase listener per view catches every disclosure inside it.
function trackCollapse(el: HTMLElement, collapsed: Set<string>) {
  el.addEventListener(
    "toggle",
    (e) => {
      const details = e.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      const node = details.dataset.node;
      if (node === undefined) return;
      if (details.open) collapsed.delete(node);
      else collapsed.add(node);
    },
    true,
  );
}

trackCollapse(filesViewEl, collapsedFiles);
trackCollapse(includesViewEl, collapsedIncludes);

// Activating a row: open its source, and reveal the location when the row names
// one. Both views go through here, so navigation behaves the same in each.
//
// An unreadable source is deliberately shown and clickable - the user needs to see
// that it is part of the project - so failing to read it is a normal outcome, and it
// goes to Problems like any other failure. Unless the row belonged to a project or a
// snapshot that has since been replaced, in which case there is nobody it would be
// telling anything: navigation drops it.
async function activateRef(ref: ExplorerRef) {
  const offset = ref.kind === "location" ? ref.offset : null;
  await navigation.goTo(
    ref.path,
    offset === null ? null : () => workspace.revealPosition(...positionOf(ref.path, offset)),
  );
}

// A byte offset from the backend as a Monaco position. The conversion is UTF-8 to
// UTF-16 and is tested on its own; see bytepos.ts.
function positionOf(path: string, offset: number): [number, number] {
  const pos = positionAt(workspace.textOf(path), offset);
  return [pos.line, pos.column];
}

function explorerClick(e: MouseEvent, refs: RefTable) {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-ref]");
  if (!row) return;
  // A row inside a <summary> would otherwise toggle the disclosure as well:
  // activating a row navigates, it does not also collapse what contains it.
  // Clicking the summary itself, which carries no ref, still toggles.
  e.preventDefault();
  const ref = refs.get(row.dataset.ref);
  if (ref === null) return;
  void activateRef(ref);
}

filesViewEl.addEventListener("click", (e) => explorerClick(e, filesRefs));
includesViewEl.addEventListener("click", (e) => explorerClick(e, includesRefs));

// Rename via double-click on a file row - the same code path as File > Rename
// Rule…. Only in the Files view, and only on a row the model says is renamable.
filesViewEl.addEventListener("dblclick", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-ref]");
  if (!row) return;
  const ref = filesRefs.get(row.dataset.ref);
  if (ref === null || ref.kind !== "source" || !ref.renamable) return;
  void renameRule(ref.path);
});

// ---- Commands ----
// Every user-facing action lives in a named function so the buttons, the native
// menu, and the explorer gestures all drive the SAME code path. Nothing below
// duplicates behaviour that a handler used to hold inline.

// Performs one analysis of the project and applies it if it is still wanted.
//
// `reset` is the ruleset reset that opening a folder queues; it is awaited here so
// that the analysis - and the auto-open that follows it - happen after the
// previous project's rules have been dropped. Refreshes pass null: the ruleset
// belongs to the project they are refreshing.
function settleRestorationAfterException(req: AnalysisRequest, restoration: Operation | null) {
  if (restoration === null || buildState !== "restoring") return;
  const restorationOwner: RestorationOwner = {
    kind: "restoration",
    selection: req.selection.serial,
    serial: restoration.serial,
    revision: restoration.revision,
  };
  const decision = decideRestorationFailure(restorationOwner, {
    selectionIsCurrent: session.isCurrent(req.selection),
    operationIsCurrent: isCurrent(restoration),
    buildState,
    buildOwner,
  });
  trace.event("restoration_exception_settlement", {
    selection: req.selection.serial,
    order: req.order,
    decision: decision.kind,
    reason: decision.reason,
    buildOwner,
  });
  if (decision.kind === "not-compiled") {
    setBuildState("not-compiled", {
      reason: "restoration_response_application_failed",
      owner: sameRestoration(buildOwner, restorationOwner) ? restorationOwner : buildOwner,
    });
  }
}

async function runAnalysis(
  req: AnalysisRequest,
  reset: Promise<void> | null,
  restoration: Operation | null = null,
) {
  const root = req.selection.root;
  let presentationAttempt: InitialPresentationAttempt | null = null;
  trace.event("analysis_started", {
    selection: req.selection.serial,
    order: req.order,
    initial: req.initial,
    restoration:
      restoration === null
        ? null
        : { serial: restoration.serial, revision: restoration.revision },
  });
  try {
    if (reset !== null) await reset;
    // Every await from here on is followed by a currency check. What comes back
    // describes `root`, and `root` is only still interesting while this selection
    // is current; otherwise the newer project's views, editor and Problems pane
    // are none of this analysis's business.
    if (!session.isCurrent(req.selection)) {
      trace.event("analysis_early_return", {
        selection: req.selection.serial,
        order: req.order,
        reason: "selection_stale_before_invoke",
      });
      return;
    }
    // The watch set is derived from this very analysis, on the backend, from the
    // same read it answers with - so what is being watched and what is on screen
    // always describe one look at the disk. Read here rather than passed in: this is
    // the current project's subscription because the check above says so. This
    // request's own order travels with it, so the plan the backend installs is
    // decided by the same ordering accept() applies below: several analyses can be in
    // flight, and only the newest to answer is anybody's view of the project.
    const restoreCache = restoration !== null && isCurrent(restoration);
    trace.event("analysis_invoking", {
      selection: req.selection.serial,
      order: req.order,
      initial: req.initial,
      watchSubscription: watching.subscription(),
      restoreCache,
      operationBefore: operations.currency(),
      restorationCurrentBefore: restoration === null ? null : isCurrent(restoration),
    });
    const response = await analyzeProject(
      root,
      watching.subscription(),
      req.order,
      restoreCache,
    );
    trace.event("analysis_response", {
      selection: req.selection.serial,
      order: req.order,
      cacheStatus: response.cache.status,
      operationAfter: operations.currency(),
      restorationCurrentAfter: restoration === null ? null : isCurrent(restoration),
    });
    const analysis = response.analysis;
    // Whether any document belonging to THIS analysis is unsaved is decided here,
    // where the editor is, and handed to accept(): a snapshot that describes files
    // the user has unsaved edits to is already out of date on arrival.
    const accepted = session.accept(req, analysis, hasUnsavedIn(analysis, root));
    trace.event("analysis_accept", {
      selection: req.selection.serial,
      order: req.order,
      accepted,
      phase: session.phase(),
    });
    if (accepted) {
      presentationAttempt = session.beginInitialPresentation(req);
      trace.event("initial_presentation_begin", {
        selection: req.selection.serial,
        order: req.order,
        attempt: presentationAttempt?.serial ?? null,
        state: initialPresentationTraceState(),
      });
    }
    if (restoration !== null) {
      const restorationOwner: RestorationOwner = {
        kind: "restoration",
        selection: req.selection.serial,
        serial: restoration.serial,
        revision: restoration.revision,
      };
      const decision = decideRestoration(response.cache, restorationOwner, {
        selectionIsCurrent: session.isCurrent(req.selection),
        operationIsCurrent: isCurrent(restoration),
        buildState,
        buildOwner,
      });
      trace.event("restoration_decision", {
        selection: req.selection.serial,
        order: req.order,
        cacheStatus: response.cache.status,
        operationCurrent: isCurrent(restoration),
        decision: decision.kind,
        reason: decision.reason,
        viewAccepted: accepted,
        buildState,
        buildOwner,
      });
      switch (decision.kind) {
        case "compiled":
          renderDiagnostics(decision.diagnostics);
          problemsCountEl.textContent = String(decision.diagnostics.length);
          setBuildState("compiled", {
            ruleCount: decision.ruleCount,
            reason: "restoration_hit",
            owner: restorationOwner,
          });
          if (decision.diagnostics.length > 0) {
            showTab("problems");
            openResultsDrawer();
          }
          break;
        case "not-compiled":
          setBuildState("not-compiled", {
            reason: `restoration_${decision.reason}`,
            owner: sameRestoration(buildOwner, restorationOwner) ? restorationOwner : buildOwner,
          });
          break;
        case "unchanged":
          break;
      }
    }
    // View ordering and restoration ordering meet only after each has consumed
    // its own arm. A coverage catch-up may reject A as a view while A still owns
    // the cache result; that is now an early return only for view application.
    if (!accepted) {
      trace.event("analysis_early_return", {
        selection: req.selection.serial,
        order: req.order,
        reason: "view_response_superseded_after_restoration",
        cacheStatus: response.cache.status,
        restorationCurrent: restoration === null ? null : isCurrent(restoration),
      });
      return;
    }
    rebuildProjectViews();
    if (presentationAttempt !== null) {
      trace.event("initial_presentation_started", {
        selection: req.selection.serial,
        order: req.order,
        attempt: presentationAttempt.serial,
      });
      // A broken configuration has no files to show, so the view that can explain
      // it is the one to be looking at.
      if (analysis.status !== "loaded") selectExplorerView("includes");
      const outcome = await autoOpenFirstSource(req, analysis, () => {
        const completed = session.finishInitialPresentation(presentationAttempt!, "shown");
        trace.event("initial_presentation_committed", {
          selection: req.selection.serial,
          order: req.order,
          attempt: presentationAttempt!.serial,
          completed,
        });
      });
      const completed = session.finishInitialPresentation(presentationAttempt, outcome);
      trace.event("initial_presentation_completed", {
        selection: req.selection.serial,
        order: req.order,
        attempt: presentationAttempt.serial,
        outcome,
        completed,
        state: initialPresentationTraceState(),
      });
    }
  } catch (err) {
    trace.event("analysis_exception", {
      selection: req.selection.serial,
      order: req.order,
      ...redactedException(err),
    });
    if (presentationAttempt !== null) {
      const completed = session.finishInitialPresentation(presentationAttempt, "failed");
      trace.event("initial_presentation_completed", {
        selection: req.selection.serial,
        order: req.order,
        attempt: presentationAttempt.serial,
        outcome: "failed",
        completed,
        state: initialPresentationTraceState(),
      });
    }
    // accept() may already have settled this analysis before a later application
    // step throws. View failure ordering therefore cannot own restoration cleanup.
    settleRestorationAfterException(req, restoration);
    // An infrastructure failure: `analyze_project` rejected, rather than answering
    // `configurationFailed`. failAnalysis() decides whether it is this project's to
    // show - a failed refresh leaves the snapshot in place and marks it stale, and
    // a failure belonging to a folder the user has left is dropped entirely.
    const failed = session.failAnalysis(req, err);
    trace.event("analysis_fail", {
      selection: req.selection.serial,
      order: req.order,
      accepted: failed,
      phase: session.phase(),
    });
    if (!failed) {
      trace.event("analysis_early_return", {
        selection: req.selection.serial,
        order: req.order,
        reason: "failure_response_superseded",
      });
      return;
    }
    rebuildProjectViews();
    showFailure(err);
    if (restoration !== null && isCurrent(restoration) && buildState === "restoring")
      setBuildState("not-compiled", {
        reason: "restoration_analysis_failed",
        owner: buildOwner,
      });
  } finally {
    // Succeeded, failed or superseded, this analysis is over. Guarded by its own
    // identity and reached from every exit above, including the early returns: a
    // slow response landing after the user has chosen another folder cannot
    // announce THAT folder as loaded and re-enable the commands gated on it.
    const finished = session.finishAnalysis(req);
    trace.event("analysis_finish", {
      selection: req.selection.serial,
      order: req.order,
      finished,
      phase: session.phase(),
      loading: session.isLoading(),
    });
    if (finished) {
      refreshProjectControls();
      refreshMenu();
    }
  }
}

// True when any open document that this analysis's project contains has unsaved
// edits. Computed from the analysis itself rather than from the session, which has
// not accepted it yet.
function hasUnsavedIn(analysis: ProjectAnalysis, pickedRoot: string): boolean {
  const members = memberPathsOf(analysis, pickedRoot);
  return dirtyDocuments().some((key) => members.has(key));
}

// Opens the first readable source of a project that has just been opened, so the
// editor is showing something rather than the demo buffer.
//
// Which source is this analysis's decision, and so is whether the open still stands
// when the file has been read: it is scoped to `analysis` remaining the accepted
// snapshot, not merely to the folder remaining open, because a refresh that has
// replaced it has already said what the project is. A user who navigates while the
// read is pending keeps the document they chose. See navigation.ts.
async function autoOpenFirstSource(
  req: AnalysisRequest,
  analysis: ProjectAnalysis,
  shown: () => void,
): Promise<InitialPresentationOutcome> {
  if (analysis.status !== "loaded") {
    trace.event("document_auto_open_skipped", {
      selection: req.selection.serial,
      order: req.order,
      reason: "analysis_not_loaded",
    });
    return "configuration-failed";
  }
  const first = firstOpenableSource(analysis);
  if (first === null) {
    trace.event("document_auto_open_skipped", {
      selection: req.selection.serial,
      order: req.order,
      reason: "no_openable_source",
    });
    return "no-openable-source";
  }
  trace.event("document_auto_open_started", {
    selection: req.selection.serial,
    order: req.order,
  });
  const outcome = await navigation.autoOpen(
    req.selection,
    analysis,
    openablePath(analysis.root, first),
    shown,
  );
  trace.event("document_auto_open_completed", {
    selection: req.selection.serial,
    order: req.order,
    outcome,
  });
  return outcome === "not-found" ? "failed" : outcome;
}

// ---- Leaving the project that is open ----
// Opening another folder and closing the workspace are the same transition with
// different endings: in both, the project on screen stops being the project, and
// its documents stop being anything this window shows or may write to. The two
// halves below are shared so that a switch cannot do less than a close - it used
// to install the new project over the old one's documents, leaving the previous
// project's files open, saveable, and reported as dirty members of a folder that
// was no longer open.

// What every confirmation in the application is asked and re-checked against: the
// session's counted selection, the open documents and their observations of the disk,
// and the ordering of the gestures that open a project. The real ones, so that a gate
// is checking the application rather than a copy of it. See authorising.ts.
const world = { session, docs: workspace, opens };

// Runs one gate against the application and hands back the claim it is safe to act
// on, or null - which is every reason not to: nothing at risk to begin with, the
// user cancelled, the world moved while the question was up, or the dialogue could
// not be shown at all. In all four the application is exactly as it was, so a caller
// only has to return.
//
// A confirmation that could not be shown authorises nothing: answering for the user
// is the one thing a broken dialogue must not do. It is reported where the gesture
// happened, and dropped if the user has left that project since - a dialogue that
// failed about a workspace they have closed does not belong in the next one's
// Problems pane, and would clear whatever that project had put there.
async function authorised<C>(gate: Gate<C>, title: string): Promise<C | null> {
  const selection = session.selection();
  try {
    return await authorise(gate, (question) => ask(title, question));
  } catch (err) {
    if (stillSelected(selection)) showFailure(err);
    return null;
  }
}

// Whether writing `key` is still the thing the user agreed to.
//
// The question is asked when the gesture is made, and the write happens when its turn
// in the mutation queue comes. In between, a catch-up or a manual Refresh can find the
// file changed or gone, so an answer given about one state of the disk must not
// authorise a write over another. Exactly what was shown, down to WHICH version of the
// file it was shown about: "changed on disk" can be true of one external version and
// then of the next, so the disagreement alone would let permission granted for the
// first be spent on the second.
//
// Which comparison that is, and why it is not the disagreement itself, is
// answerHolds() in authorising.ts - the same predicate the gate re-checks with the
// moment the user answers, so the two cannot disagree about what an answer covers.
//
// Silence rather than a second dialogue: the write is abandoned, the document stays
// dirty and still marked as conflicted, and Save says so again next time it is
// pressed. Putting a dialogue up here would put it up while the user is looking at
// something else, several mutations after the gesture it belongs to.
function stillConfirmed(confirmed: Map<string, DiskAnswer>, key: string): boolean {
  return answerHolds(confirmed, key, workspace.diskAnswer(key));
}

/**
 * What the last check before a write concluded.
 *
 * `unchanged` is not a weaker `writable`: it says the file already holds exactly the
 * revision this write would put there, so writing is pointless rather than forbidden.
 * A compile can go straight on to read it; only a refusal stops one.
 *
 * `writable` carries the version the read found, and carries it because that is what
 * authorises the write rather than merely preceding it: the write is issued against
 * this version and refuses if the file has moved on again, which is the one thing no
 * check up here can promise. Null for a file that is not there - what a save of a
 * deleted document recreates.
 */
type WriteCheck =
  | { kind: "writable"; expect: string | null }
  | { kind: "unchanged" }
  | { kind: "refused" };

// How many times the check below re-reads a file whose read was overtaken before it
// gives up and refuses. Bounded, and small: a refusal writes nothing, says so, and the
// gesture can be repeated, whereas retrying until a read is not overtaken would make a
// program writing into the project continuously into an unbounded wait.
const PREWRITE_READS = 3;

// The last check before a write, and the only one that goes to the disk: reads `snap`'s
// file, records what is there, and says whether writing it is still what the user
// agreed to.
//
// Everything above this can only speak for observations that have already landed, and
// between the gesture and the write there is an interval nothing observes at all. The
// watcher is fenced from the moment the mutation is queued, and before that a change is
// only reported after the debounce window: an external edit made wholly inside that
// interval reaches no read, records no conflict, and so passes every check there is -
// and the write replaces a version nobody ever saw. Nor can the catch-up that ends the
// fence find it, because by then the file holds Quipu's text.
//
// This read closes all of that except its own tail: what happens between it and the
// write. That last stretch is not closed by looking again, however late - two IPC
// operations have an interval between them however short it is - so the version this
// read found travels with the write instead, and the write itself is what refuses. See
// `WriteCheck` and src-tauri/src/fs.rs.
//
// The read goes through reconcile(), so what it finds is recorded exactly as any other
// external change is. That is what makes stillConfirmed() refuse below - no second
// dialogue - and leaves the document dirty and marked, so Save says it again. A
// `reload` outcome is deliberately not acted on here: replacing the user's document is
// the catch-up's business, not a save's.
//
// The reconciliation's OUTCOME is what this turns on, not merely the fact of having
// read. A read whose answer another read has already given records nothing - see
// `stale` in documents.ts - so it revalidates nothing either: what it found, changed
// contents included, is discarded, and the checks below would then pass on the strength
// of the answer that older read gave. So a stale outcome asks again from a fresh probe,
// and a check that never gets an answer of its own refuses.
//
// One read per write is the cost, and it buys the one thing no bookkeeping afterwards
// can: a write that never happens.
async function checkWritable(
  confirmed: Map<string, DiskAnswer>,
  snap: EditorSave,
): Promise<WriteCheck> {
  // Before the read: a save already answered for - by a catch-up that found the file
  // changed while this queued - costs nothing.
  if (!stillConfirmed(confirmed, snap.key)) return { kind: "refused" };
  for (let read = 0; read < PREWRITE_READS; read += 1) {
    const expect = workspace.probe(snap.key);
    if (expect === null) return { kind: "refused" };
    const disk = await readDiskState(snap.key);
    const outcome = workspace.reconcile(expect, disk);
    // This read decided nothing, so it proved nothing. Ask again rather than write.
    if (outcome.kind === "stale") continue;
    // The read was an await, so identity is re-asked with what it found recorded: the
    // document may have been closed or renamed onto another path while it was in flight.
    if (!workspace.holds(snap)) return { kind: "refused" };
    // Somebody else put exactly this revision there while the write queued. The disk
    // agrees with the editor, which is what `adopt` means and why the document is clean
    // again - so there is nothing to write, and nothing to refuse a compile for either.
    // The text has to match the SNAPSHOT and not just the model: a document edited since
    // the gesture also adopts when the file catches up with the newer revision, and
    // writing the older one would then undo their edit behind their back.
    if (outcome.kind === "adopt" && disk.present && disk.text === snap.text) {
      return { kind: "unchanged" };
    }
    // Anything else the read found is an answer about the file, and the authorisation is
    // re-checked against it: a version that is neither what was confirmed nor what this
    // write holds is refused. What the read found goes back with the answer, because the
    // write is conditional on it.
    return stillConfirmed(confirmed, snap.key)
      ? { kind: "writable", expect: disk.present ? disk.text : null }
      : { kind: "refused" };
  }
  return { kind: "refused" };
}

// The infallible half of leaving a project: the UI lands in the state a project
// that has not been loaded has, and the previous project's documents are gone from
// the editor and from the LSP.
//
// Nothing here may fail, because it runs after the switch has been accepted:
// whatever comes next - an analysis that rejects, a first file that cannot be read
// - must not be able to leave the previous project's files on screen.
//
// Call it once the session and operation tokens have moved, so a response still in
// flight for the old project cannot re-open a document this has just closed.
function leaveProject(dirLabel: string) {
  dirLabelEl.textContent = dirLabel;
  // Synchronously, before anything else: from here on every event, watcher error,
  // document read and automatic analysis of the project being left is inert, and
  // the native watch is released. Whoever is entering a project subscribes AFTER
  // this, so the new subscription is not the one being given up.
  trace.event("watch_subscription_cancelled", { subscription: watching.subscription() });
  watching.cancel();
  resolutions.clear();
  collapsedFiles.clear();
  collapsedIncludes.clear();
  selectExplorerView("files");
  resultsView.clear();
  diagnosticsEl.innerHTML = "";
  matchesCountEl.textContent = "0";
  problemsCountEl.textContent = "0";
  closeResultsDrawer();
  setBuildState("not-compiled", { reason: "project_left", owner: { kind: "none" } });
  // Redraws both views from the session as it is now: the "analysing" notice for a
  // folder being opened, the no-project notice for a workspace being closed. Also
  // disables the commands that need a loaded project.
  rebuildProjectViews();
  // The scratch buffer FIRST, so the editor is never left holding a model that is
  // about to be disposed, and then the project's documents are closed: the LSP is
  // told about each one and the models are destroyed, so nothing is left claiming
  // to be a file in a project that is not open, no later save can write to one,
  // and the dirty-document queries the compile's save plan and the explorer make
  // no longer see them.
  workspace.openScratch(SAMPLE_RULE);
  workspace.closeFiles();
  refreshActiveUI();
  refreshPreferences();
}

// Entering a project, whatever obtained it.
//
// Open Folder and Open Example differ only in how they get a root - a native
// picker, or a packaged template copied into an editable working copy - and in
// whether they bring a scan target with them. From here on they are the same
// transition, and deliberately the same code: a second implementation would be a
// second set of guarantees, and the ordering below is the entire reason the
// guarantees hold.
//
// `request` is the gesture this transition belongs to, and it is re-checked here
// because the caller has just awaited. A picker dismissed late, or a copy that was
// slow, must not open over the project the user has chosen since; nor may an
// accepted Close Workspace be undone by an open that was already in flight when it
// happened. See opening.ts.
//
// `target` is the sample scan target of an example, installed as part of the
// prologue below so that it lands only for the request that actually opens. Open
// Folder passes null: choosing a folder says nothing about what to scan, and the
// target the user picked themselves is theirs to keep.
async function enterProject(
  request: OpenRequest,
  root: string,
  action: string,
  target: PreparedTarget | null,
) {
  // Before anything is accepted: a project with unsaved work is not abandoned
  // without asking, and Cancel means nothing below happens at all. The gate makes
  // the currency check itself, before it asks anything, which is why there is not a
  // separate one here.
  //
  // After the root has been obtained rather than before, because dismissing a
  // picker is not a decision about unsaved work: asking first would put a dialogue
  // in front of a user who was only browsing and never left the project at all.
  //
  // The question is a native dialogue, so it is an await, and that is what the gate
  // is for: the answer is re-checked against this request, this project and this
  // at-risk set before the transition below runs, and the transition then runs
  // synchronously from here. An answer given about one state of the world does not
  // authorise a change to another. See authorising.ts.
  const departure = await authorised(
    departureGate(world, { action, request, requireOpen: false }),
    action,
  );
  if (departure === null) return;

  // The selection is accepted, so the switch happens now, in an order chosen so
  // that every remaining step is allowed to fail. Everything that CANNOT fail
  // goes first: the project changes, anything in flight is superseded, and the UI
  // lands in the state an unloaded project has. Only then is a fallible await
  // reached. Loading the folder before this point is what could leave the window
  // stuck in `compiling` with the previous project's rules still installed.
  //
  // The session's own selection supersedes every load, analysis and refresh of the
  // previous project - including a re-selection of the folder already open, which
  // comparing paths cannot see. That re-selection goes through the whole
  // transition too: the same folder is still a switch, so its documents are closed
  // and re-opened from disk rather than kept with edits nothing has written. An
  // example re-opened is the same case, and is a new counted selection too.
  const selection = session.open(root);
  trace.event("project_selected", { selection: selection.serial });
  // Supersede any compilation separately. Two tokens rather than one: the
  // operation is about what may be compiled, the selection is about what may be
  // shown, and a compile of this folder starting while it is being analysed must
  // cancel neither.
  const restoration = beginOperation();
  // Queued here, synchronously, rather than issued down in runAnalysis. From the
  // moment the build state says "not compiled" the user can start a compile, and
  // the folder is still loading; registering the reset now puts it *before* that
  // compile on the barrier, so it runs first instead of landing afterwards and
  // dropping the rules that compile installed.
  const reset = operations.requestReset();
  leaveProject(root);
  setBuildState("restoring", {
    reason: "project_opened",
    owner: {
      kind: "restoration",
      selection: selection.serial,
      serial: restoration.serial,
      revision: restoration.revision,
    },
  });
  // Its bytes are already in hand, so this cannot fail either, and installing it
  // supersedes any target file the user was still waiting to be read. Scan stays
  // disabled until a compile succeeds, and nothing here starts one: what to do next
  // is the example's README and the comment at the top of the file it opens.
  if (target !== null) setFileTarget(target.path, target.bytes);

  // Watching starts BEFORE the first analysis, and is awaited so that it really has.
  // A file written during that analysis would otherwise fall in the gap between the
  // read and the watch, and be lost until something else happened to change the
  // project; arriving now, it is a change the coordinator can see, and it schedules a
  // trailing analysis. `armed` never rejects - a watcher that could not be installed
  // is degraded operation, recorded by the coordinator, and this project still opens.
  const { armed } = watching.subscribe(root);
  await armed;

  const req = session.beginAnalysis(selection, true);
  // Null once the selection is no longer current, which the await above makes
  // reachable: the user may have opened another folder, or closed the workspace,
  // while the watcher was being installed. Their newer choice has already run this
  // same prologue, so there is nothing to undo here.
  if (req === null) return;
  await runAnalysis(req, reset, restoration);
}

async function openFolder() {
  // Claimed before the picker is shown, so that the ordering is the user's: a
  // folder chosen in a picker they have since moved past opens nothing.
  const request = opens.begin();
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir !== "string") return;
  await enterProject(request, dir, "Open another folder", null);
}

// File > Open Example…: the chooser for the packaged examples. It lists the
// backend's catalog and hands back whichever id the user activates; see
// examples.ts for the dialog and examples.rs for the catalog itself.
function openExample() {
  void showExamples({ open: prepareExampleProject });
}

// Copies one example into its editable working copy and opens that as a project.
//
// The copy comes first and it can fail, so it happens while the project on screen
// is still completely intact: a template that cannot be materialised - or whose
// sample target the catalog names wrongly - leaves the current project, its
// documents, its views, its ruleset and its operation state exactly as they were,
// and the chooser shows what went wrong.
//
// Reaching the backend by id only is the point: the destination is derived there
// from the fixed catalog, so nothing the frontend holds decides what is copied or
// where it lands.
async function prepareExampleProject(id: string) {
  const request = opens.begin();
  let prepared: PreparedExample;
  try {
    prepared = await prepareExample(id);
  } catch (err) {
    // Only the request the user is still waiting on has anywhere to report this.
    // A failure belonging to one they have replaced is dropped rather than shown:
    // whatever is open now is not what failed to be replaced.
    if (opens.isCurrent(request)) throw err;
    return;
  }
  await enterProject(request, prepared.root, "Open an example", prepared.target);
}

// Re-reads the project from disk and replaces the views with the answer.
//
// External changes normally reach the views by themselves - the project's inputs are
// watched, and a change to any of them schedules this - so what this is FOR is the
// cases watching cannot cover: a change the watcher was not armed for, a watcher that
// could not be installed at all, and every app-owned mutation below, which fences the
// watcher precisely so that it does not report Quipu's own writes.
async function refreshProject() {
  const selection = session.selection();
  if (selection === null) return;
  const req = session.beginAnalysis(selection, false);
  if (req === null) return;
  // Refreshes are ordered by the session, so an older response cannot replace a
  // newer one however they arrive; several may be in flight at once.
  renderProjectStatus();
  await runAnalysis(req, null);
}

// File > Refresh Project, and the Refresh button. Immediate: it does not wait out a
// debounce window, and the session's own ordering lets it supersede an automatic
// analysis rather than queue behind one.
//
// It reconciles the open documents as well, because this is the fallback when
// watching is degraded - a Refresh that redrew the tree but left a document showing
// text the file no longer has would only be half an answer.
//
// And because it is that fallback, it invalidates whatever is compiled the moment it
// is accepted. When watching is degraded nothing has said the rules changed and
// nothing will: this Refresh is the only thing that will ever look, and it is about
// to reload documents and re-read the project without being able to say in advance
// whether anything moved. Synchronously, before the first await, for the same reason
// a reported change invalidates before the debounce window: Scan must not be offered
// against a ruleset that may already describe a project the disk no longer holds. A
// Refresh that finds nothing changed costs a recompile, which is the cheaper mistake.
async function refreshManually() {
  const selection = session.selection();
  if (selection === null) return;
  invalidateCompilation();
  await reconcileOpenDocuments(() => stillSelected(selection));
  if (!stillSelected(selection)) return;
  await refreshProject();
}

// File > Close Workspace. Returns the app to the state it starts in: no project,
// the scratch buffer in the editor, no compiled rules.
async function closeWorkspace() {
  // Closing must never silently discard a document the user has edited and not
  // saved. Same gate, same wording, same point in the transition as a switch, and
  // the same requirement that the answer still describe the project it was given
  // about - which here includes there still being one to close.
  //
  // Ordered against the pending opens without making a request of its own, so that a
  // folder picker the user is still looking at survives a close they cancel and an
  // open gesture made while this question is up wins over this answer. That choice
  // lives in closeGate(), where it is tested.
  const departure = await authorised(closeGate(world), "Close Workspace");
  if (departure === null) return;

  // The same infallible prologue as opening: the project is gone, everything in
  // flight is superseded, and the UI lands in the no-project state before the
  // first await. Outstanding loads, refreshes and analyses see the closed session
  // and change nothing; the compile token supersedes any compilation.
  //
  // Pending opens are superseded here, and only once the close has been accepted:
  // the user has said what they want the window to be showing, so a folder picker
  // still up or an example still being copied must not fill the workspace back in
  // afterwards. Cancelling the confirmation above leaves them alone, because
  // nothing has been abandoned.
  opens.cancel();
  const closingSelection = session.selection()?.serial ?? null;
  session.close();
  trace.event("project_closed", { selection: closingSelection });
  const op = beginOperation();
  const reset = operations.requestReset();
  leaveProject("No folder open");

  // Awaited only to report a failure - the ordering was settled when it was
  // queued, and the barrier holds on to the rejection either way, so the next
  // compile refuses to run rather than compiling on top of stale rules.
  //
  // Which is what makes silence safe here. The reset is slow enough for the user to
  // open a folder while it is outstanding, and a rejection reported then would put
  // the failure of a workspace they have closed into the new project's Problems pane
  // - and clear whatever that project had put there. So the close's own operation is
  // checked first: if it no longer owns the ruleset, this handler has nothing to say,
  // and nothing is lost by its silence, because the failure is still in the barrier
  // and the next compile of the new project has to wait on it and report it.
  try {
    await reset;
  } catch (err) {
    if (isCurrent(op)) showFailure(err);
  }
}

async function newRule() {
  // The disabled button and the greyed-out menu item are the visible half of this.
  // The guard is the half that holds: the menu's state is pushed over IPC and can
  // lag behind the state it was derived from, an accelerator can fire in that
  // window, and the command is invoked by name rather than through the button.
  const selection = session.selection();
  if (selection === null || session.isLoading()) return;
  const name = prompt("New rule file name:", "untitled.yar");
  if (!name) return;
  if (!isPlainName(name)) {
    alert("A rule file name cannot contain a path separator.");
    return;
  }
  const fileName = name.endsWith(".yar") || name.endsWith(".yara") ? name : `${name}.yar`;
  const retiredPresentation = session.retireInitialPresentationForUser();
  trace.event("initial_presentation_retired", {
    reason: "new_rule",
    retired: retiredPresentation,
    state: initialPresentationTraceState(),
  });
  // The project root, in the spelling the analysis reports where there is one: the
  // views and the backend's diagnostics both name files that way, so the new
  // document's key matches the row that is about to appear for it. `create_file`
  // refuses to overwrite, so an existing file comes back as a failure rather than
  // as an empty document.
  const root = session.loaded()?.root ?? selection.root;
  const path = joinRoot(root, fileName);
  try {
    // Fenced: creating a rule file in the watched root is a change Quipu is making
    // on purpose, and the catch-up the fence ends with re-reads the project anyway.
    // Reported back as an external change it would be a second, redundant analysis.
    await fenced("mutation", async () => {
      // Waiting for its turn and raising the fence were both awaits, so the project is
      // checked again with the fence already up and before anything is created. A
      // folder switch or a close during them means this command speaks for nothing: it
      // creates no file at all, and fenced() still releases the fence it took.
      if (!session.isCurrent(selection)) return;
      // Nothing else needs re-checking, and one thing must not be: whether `path` is
      // free. `create_file` refuses to overwrite at the boundary that does the
      // creating (see fs.rs), so a file that appeared while this waited comes back as
      // a failure instead of being emptied - which no check up here could promise.
      await createFile(path);
      // The file exists now, but it belongs to the project that was open when this
      // started. If the user has moved on, it is not this project's business.
      if (!session.isCurrent(selection)) return;
      // The project's contents have changed on disk, and a new .yar file in the root is
      // a file the backend's entrypoint inference will compile, so the snapshot on
      // screen no longer describes the directory.
      //
      // Said again here, having already been said when the fence went up (see fenced()),
      // because these are two different facts. That one answered for the blind interval
      // this mutation opened; this one is that the project no longer has the same FILES.
      // A compile that began while this waited its turn has a plan and a membership that
      // both predate the creation, so it cannot speak for the directory either.
      invalidateCompilation();
      session.markStale();
      // Inside the fence, so that the catch-up reconciles a document that is already
      // where this command put it. It agrees with the file by construction: both are
      // empty.
      workspace.openFile(path, "");
    });
  } catch (err) {
    alert(String(err));
  }
  // No refresh here: ending the fence reconciles the open documents and re-reads the
  // project, so the new file reaches the tree and the graph that way.
}

// ---- Save ----

async function saveActive() {
  const key = workspace.activeKey();
  if (key == null || key === "") return; // scratch buffer: nothing to save
  // Asked before anything is written, and Cancel writes nothing at all: this file
  // changed on disk after it was opened, so saving replaces someone else's version
  // with a revision that never saw it.
  //
  // The gate captures the exact revision to be written BEFORE it asks, so the text
  // that reaches the disk is the text the user was asked about, and re-checks the
  // document, that text and the disk observations once they have answered: an edit,
  // a reload or a folder switch while the dialogue was up abandons this save rather
  // than writing something else. The document stays dirty and Save says so again.
  //
  // The answer itself is kept, because the write happens when this save's turn in the
  // mutation queue comes and the disk can change while it waits. See stillConfirmed().
  const save = await authorised(saveGate(world, key), "Save");
  if (save === null) return;
  // The text comes from this snapshot rather than from the model, because by the time
  // the write is issued - let alone finishes - the model may say something else, and
  // what the document is marked clean at has to be what actually reached the disk.
  const { snapshot, shown: confirmed } = save;
  // Which project this save belongs to. Everything after the write is scoped to
  // it: a rejection arriving after the user has opened another folder is not that
  // folder's problem, and putting it in the Problems pane would report a failure
  // against a project it was never about. The gesture's own project, taken from the
  // gate: it is the one the answer was given about, and the gate has just re-checked
  // that it is still the project on screen.
  const selection = save.selection;
  try {
    // The write and the baseline it establishes both happen inside the fence, so the
    // file's own notification has no live watcher to reach and cannot come back as an
    // external change to the very revision Quipu just wrote.
    await fenced("mutation", async () => {
      // Waiting for its turn and raising the fence were both awaits. If the user
      // switched folders or closed the workspace during them, this save speaks for a
      // project that is not on screen and a document that is no longer open: it writes
      // nothing, and fenced() still releases its fence.
      if (!stillSelected(selection)) return;
      // The document itself, re-asked. This snapshot was captured when the gesture was
      // made - deliberately, because the revision written has to be the one the user
      // asked to save - so it can name a document a Rename has since moved onto
      // another path. Writing it would recreate the file the rename emptied, and no
      // bookkeeping afterwards could remove it again.
      if (!workspace.holds(snapshot)) return;
      // Then what is known about the disk, and then the disk itself: knowing of no change
      // is not the same as there being none, because nothing was watching while this
      // waited. See checkWritable(). Anything but `writable` writes nothing - a refusal
      // in silence, leaving the document dirty and marked so Save says it again, and
      // `unchanged` because somebody else has already put this very text there, which
      // leaves the document clean with nothing for a write to add.
      const check = await checkWritable(confirmed, snapshot);
      if (check.kind !== "writable") return;
      // Conditional on the version that check read: the write refuses if the file has
      // moved on since, and refuses in the same silence, for the same reason. Nothing
      // has been lost - the version that stopped it is still on disk - and the catch-up
      // that ends this fence is what records it and marks the document.
      if ((await saveTextFile(snapshot.key, snapshot.text, check.expect)) === "refused") return;
      if (!stillSelected(selection)) return;
      // A no-op if the document was closed or replaced while the write was in flight
      // - by a rename, or by the workspace being closed - and the document stays
      // dirty if it was edited, because that edit is not the revision written. It
      // also clears the conflict and moves the disk baseline: the file now says what
      // this document says, whatever it said before, and a file that had been deleted
      // has just been recreated by this write.
      workspace.completeSave(snapshot);
    });
  } catch (err) {
    if (stillSelected(selection)) showFailure(err);
    return;
  }
  if (!stillSelected(selection)) return;
  refreshActiveUI();
  // The project is not re-read here: ending the fence reconciles the open documents
  // and re-reads the project from disk. That is what a save needs anyway - `include
  // "dep.yar"` added to a file brings dep.yar into the graph, and the analysis that
  // discovers it reads the file from disk, so the write is the first moment it could
  // be seen - and it is also what makes an unrelated external edit made while the
  // fence was up visible instead of lost.
}

// Ctrl+S is owned by the native menu accelerator. There is deliberately no
// window keydown handler for it: having both would save twice per press.
saveBtn.addEventListener("click", () => void saveActive());

// ---- Rename ----

// Renames one project file on disk and brings the UI along with it. Both entry
// points (File > Rename Rule…, and double-clicking a Files row) call this, so the
// rename semantics live in exactly one place.
async function renameRule(path: string) {
  const selection = session.selection();
  if (selection === null) return;
  const source = session.sourceAt(path);
  // Only a file the project contains, and only an internal one. An external
  // source's path is a canonical target OUTSIDE the project that an include
  // happened to reach; renaming it would move someone else's file, and the include
  // that named it would then resolve to nothing.
  if (source === null || source.external) return;
  const current = basename(path);
  const next = prompt("Rename file:", current);
  if (!next || next === current) return;
  if (!isPlainName(next)) {
    alert("A file name cannot contain a path separator.");
    return;
  }
  // In place: the file keeps the directory it is in. Building the new path from
  // the project root instead would silently MOVE a file in a sub-directory up to
  // the root, which is not what Rename means.
  const to = joinRoot(dirname(path), next);
  try {
    // Fenced for the same reason as New Rule, and more so: a rename shows up as a
    // removal AND a creation, and the removal arriving as an external change would
    // mark the document Quipu has just moved onto the new path as missing.
    await fenced("mutation", async () => {
      // Re-checked with the fence up, its turn come, and before anything moves, for the
      // same reason as New Rule: a rename that belongs to a project the user has left
      // renames nothing.
      if (!session.isCurrent(selection)) return;
      // And the file itself is re-asked about, rather than trusted from before those
      // waits: the project may have been re-read since, and a path it no longer
      // contains - or now reaches only from outside - is not this window's to move.
      const still = session.sourceAt(path);
      if (still === null || still.external) return;
      // The destination is deliberately not re-checked here either: `rename_file`
      // refuses to replace an existing file at the boundary that performs the rename
      // (see fs.rs), so a destination that appeared while this waited comes back as a
      // failure rather than being overwritten.
      await renameFile(path, to);
      if (!session.isCurrent(selection)) return;
      // Same as New Rule, and for the same two reasons: the set of files the backend
      // would compile has changed and an include naming the old path no longer resolves,
      // so neither the snapshot on screen nor a compile that began while this waited -
      // whose plan named the document at its old path - describes this project.
      invalidateCompilation();
      session.markStale();
      // Move any open buffer onto the new path so it stays active and a subsequent
      // save writes to the new file rather than re-creating the old one.
      //
      // Inside the fence, and this is the case that requires it: the catch-up reads
      // whatever is open when it runs, so a document still keyed to the old path
      // would be read at a path this command has just emptied and marked as missing -
      // a conflict against Quipu's own rename.
      if (workspace.openKeys().includes(path)) workspace.renameDoc(path, to);
    });
  } catch (err) {
    alert(String(err));
  }
  // Ending the fence re-reads the project, so the renamed file reaches the tree, the
  // graph and the includes that name it.
}

function renameActiveRule() {
  const key = workspace.activeKey();
  // Only a real document can be renamed, not the scratch buffer. Whether it is a
  // file this project may rename is renameRule()'s decision, made from the
  // identity rather than from the path.
  if (key == null || key === "") return;
  void renameRule(key);
}

function documentLabel(key: string): string {
  return key === "" ? "untitled.yar" : basename(key);
}

function refreshActiveUI() {
  const key = workspace.activeKey();
  const real = key != null && key !== "";
  const dirty = real && workspace.isDirty(key);
  const conflict = real ? workspace.conflictOf(key) : null;
  // Both markers go on the heading that is already there, so a document changing
  // underneath the user does not push the editor down the pane. The glyphs match the
  // Files rows: the same two facts, said the same way in both places.
  activeFileEl.textContent =
    key == null
      ? "Rule source"
      : documentLabel(key) +
        (conflict === null ? "" : conflict === "missing" ? " ✖" : " ⇅") +
        (dirty ? " ●" : "");
  activeFileEl.title =
    conflict === null
      ? ""
      : conflict === "missing"
        ? "No longer readable on disk; Save writes the editor's text back"
        : "Changed on disk since it was opened";
  // Not just unsaved edits. A document whose file has been deleted or renamed away
  // holds the only copy of its text and reports no unsaved edits, because nothing was
  // edited - and Save is the one thing that can put it back on disk, so it has to be
  // reachable. Same rule in the menu; see refreshMenu().
  saveBtn.disabled = !real || !workspace.needsSaving(key);
  reloadBtn.classList.toggle("hidden", conflict === null);
  refreshMenu();
}

// Replaces the active document with what is on disk, discarding whatever the editor
// holds. The only way out of a conflict other than saving over it.
//
// Confirmed first when there is unsaved work, because that work is about to be
// destroyed and nothing else will bring it back. Read asynchronously, and applied
// only if the project, the document, its revision and this gesture are all still the
// current ones - a reload the user has moved past must not land on whatever they are
// looking at now.
async function reloadActive() {
  // The revision this reload is answering for is captured before the question and
  // carried out of it, so the text discarded is the text the user was asked about:
  // workspace.reloadDoc refuses if the model or its version has moved on, so an edit
  // made while the dialogue was up - or while the read was in flight - keeps the
  // user's text and leaves the conflict standing. Nothing is superseded until the
  // answer is in and current, which is why beginResolution comes after it.
  const reload = await authorised(reloadGate(world), "Reload from Disk");
  if (reload === null) return;
  const { key, expect, selection } = reload;
  const request = beginResolution(key);
  let text: string;
  try {
    text = await readTextFile(key);
  } catch (err) {
    // Scoped, and the conflict is left exactly as it was: the file is still not
    // readable, so the document still holds the only copy of its text.
    if (stillSelected(selection) && isCurrentResolution(key, request)) showFailure(err);
    return;
  }
  if (!stillSelected(selection) || !isCurrentResolution(key, request)) return;
  workspace.reloadDoc(expect, text);
  refreshActiveUI();
  renderFiles();
  renderProjectStatus();
}

document.querySelector<HTMLButtonElement>("#open-folder")!.addEventListener("click", () => {
  void openFolder();
});
newFileBtn.addEventListener("click", () => void newRule());
refreshBtn.addEventListener("click", () => void refreshManually());
reloadBtn.addEventListener("click", () => void reloadActive());

// ---- Scan target (single-file scan retained from Phase 1; directory-ruleset
// compile lands in 4.2) ----

let fileBytes: number[] | null = null;

// Orders the gestures that say what to scan against each other, so that a file read
// the user has overtaken cannot install itself over their newer choice. Its own
// generation: see targets.ts for why it is not any of the others.
const targets = new TargetRequests({
  pick: async () => {
    const path = await open({ multiple: false, directory: false });
    // A directory or a multiple selection is not something this asked for; the
    // dialogue's type allows them, so treat anything else as no choice.
    return typeof path === "string" ? path : null;
  },
  read: readFileBytes,
  install: setFileTarget,
  fail: showFailure,
});

function targetBytes(): number[] {
  if (fileBytes) return fileBytes;
  return Array.from(new TextEncoder().encode(targetEl.value));
}

// Presents `path` as the scan target, holding its bytes.
//
// Shared by Choose file… and by opening an example, which brings its own sample
// target: one presentation, so a preloaded target looks and behaves exactly like a
// chosen one - the textarea steps aside, and typing in it takes the target back
// (see the input listener below).
function setFileTarget(path: string, bytes: number[]) {
  // This is the target now, whoever set it. An example's sample target arrives here
  // too, and it has to beat a file read the user started before they opened the
  // example - the newer statement wins even though the older I/O may land second.
  targets.supersede();
  fileBytes = bytes;
  targetEl.value = "";
  targetEl.disabled = true;
  targetInfo.textContent = `File: ${path} (${bytes.length} bytes)`;
}

// Cap rendered diagnostic rows — large aggregated rule files can produce
// thousands of warnings; rendering them all is slow and unreadable.
const MAX_DIAGNOSTIC_ROWS = 500;

function renderDiagnostics(diags: Diagnostic[]) {
  if (diags.length === 0) {
    diagnosticsEl.innerHTML = `<div class="ok">No errors or warnings.</div>`;
    return;
  }
  const shown = diags.slice(0, MAX_DIAGNOSTIC_ROWS);
  const overflow = diags.length - shown.length;
  diagnosticsEl.innerHTML =
    shown
      .map((d) => {
        // For directory-ruleset diagnostics, show which file and let the click
        // open that file before revealing the line.
        const fileBase = d.file ? basename(d.file) : "";
        const fileChip = fileBase ? `<span class="diag-file" title="${escapeAttr(fileBase)}">${escapeHtml(fileBase)}</span>` : "";
        return `
      <div class="diag ${d.severity}" data-line="${d.line}" data-col="${d.column}" data-file="${escapeAttr(d.file ?? "")}" title="Go to ${escapeAttr(fileBase)}:${d.line}:${d.column}">
        <span class="msg">${escapeHtml(d.title)}</span>
        <div class="diag-meta">
          <span class="badge">${d.severity}</span>
          <span class="code">${d.code}</span>
          ${fileChip}
          <span class="loc">${d.line}:${d.column}</span>
        </div>
      </div>`;
      })
      .join("") +
    (overflow > 0
      ? `<div class="muted">…and ${overflow} more (showing first ${MAX_DIAGNOSTIC_ROWS})</div>`
      : "");
}

// Click a diagnostic row -> open its file (if from a multi-file compile) and
// jump to the line in the editor.
diagnosticsEl.addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".diag");
  if (!row) return;
  const line = Number(row.dataset.line);
  const col = Number(row.dataset.col);
  const file = row.dataset.file;
  // A zero line means the diagnostic has no position: open the file, do not jump.
  const reveal = line > 0 ? () => workspace.revealPosition(line, col || 1) : null;
  if (!file) {
    // A scratch compile's diagnostics name no file, so there is nothing to open and
    // nothing is awaited: the active document is the one that was compiled.
    if (reveal !== null) reveal();
    return;
  }
  void navigation.goTo(file, reveal);
});

const compileBtn = document.querySelector<HTMLButtonElement>("#compile")!;
const scanBtn = document.querySelector<HTMLButtonElement>("#scan")!;

// Writes out the dirty documents belonging to the project about to be compiled,
// preserving auto-save-on-compile, and reports which ones it wrote.
//
// The backend reads the files itself, so an unsaved edit would compile as its
// previous version. Which documents get written matters: the scratch buffer has
// nowhere to write to, and a file left open from a project the user has since
// switched away from is not this compile's business.
//
// Membership is not decided in one pass, because a save can change the answer -
// see saveplan.ts for the fixpoint and the reasoning. Everything filesystem- or
// IPC-shaped stays here; the decision itself is testable on its own.
//
// The accepted snapshot's membership is the STARTING set only. It may be stale, so
// it is never the last word: any dirty document it does not account for sends the
// fixpoint to a fresh analysis, which is what actually decides.
async function saveProjectDocuments(
  root: string,
  op: Operation,
  confirmed: Map<string, DiskAnswer>,
): Promise<string[]> {
  const dirty = dirtyDocuments();
  // Nothing to write, so nothing to fence: an empty plan must not cost this compile
  // a retired watcher and the catch-up that ending a fence owes.
  if (dirty.length === 0) return [];
  // One fence around the whole plan rather than one per file. The fixpoint may write
  // several files and analyse between them, and re-arming between each write would
  // leave gaps in which the next write reports itself back as an external change -
  // invalidating the very compile whose auto-save caused it.
  //
  // Ending that one fence reconciles the open documents and re-reads the project, so
  // the writes below reach the views, and an unrelated external edit made while they
  // were happening is seen rather than lost. Awaited before the compiler is invoked:
  // this compile sends the root and the backend reads the directory itself, so what
  // the catch-up settles is what is on screen, not what gets compiled.
  // The compile's own fence, and the only one that leaves a compilation standing: this
  // is the compile writing the documents it is about to compile, and superseding itself
  // would mean no compile ever finished. See `FenceOwner`.
  const plan = await fenced("compile", () =>
    saveDirtyMembers(dirty, new Set(session.memberIds().keys()), {
      members: async () => await graphPaths(root),
      save: async (key) => {
        // Nothing left to write: the disk already holds this document's text, because
        // the user's own Save - queued ahead of this plan - has just written it. Not a
        // refusal, and not a write either.
        if (!workspace.needsSaving(key)) return { kind: "unchanged" };
        // The same captured-revision rule as manual Save: the text written is the
        // text the snapshot holds, and the document is marked clean at THAT
        // revision. An edit made while the write was in flight therefore stays
        // dirty, and the next wave of the fixpoint - or the next compile - writes it.
        const snapshot = workspace.beginSave(key);
        // Gone from the editor since the plan named it - closed, or renamed onto
        // another path by a mutation this one queued behind. There is nothing to write
        // and nothing to write it from, and what the compiler would read at this path
        // is not what the editor was holding. Captured here rather than before the
        // waits, so this null IS the identity re-check manual Save makes explicitly.
        if (snapshot === null) {
          return { kind: "refused", why: `${basename(key)} is no longer open at that path` };
        }
        // What the file says may have stopped being what the user agreed to write over,
        // and a member the fixpoint discovered was never in the question at all. Then
        // the disk itself, because nothing was watching while this waited its turn.
        const check = await checkWritable(confirmed, snapshot);
        // That read was an await, and an edit or a Refresh during it supersedes this
        // compile. Its captured snapshot is then a revision nobody is asking to have
        // written, and writing it would put the editor's older text on disk on behalf of
        // an operation that has been abandoned. Checked here rather than only at the top
        // of the next wave, because the write is what cannot be taken back.
        if (!isCurrent(op)) return { kind: "superseded" };
        // Somebody else wrote exactly this revision while the plan queued. What the
        // compiler will read is what the editor holds, so this document is accounted for
        // and the compile carries on: refusing here would abort it over text that is
        // already in place.
        if (check.kind === "unchanged") return { kind: "unchanged" };
        if (check.kind === "refused") {
          return { kind: "refused", why: `${basename(key)} changed on disk` };
        }
        // Conditional on the version that check read, so a file written in the interval
        // between the two is preserved and reported rather than replaced. To this plan
        // that is the same answer a refused check gives: what the compiler would read at
        // this path is not what the editor holds.
        if ((await saveTextFile(snapshot.key, snapshot.text, check.expect)) === "refused") {
          return { kind: "refused", why: `${basename(key)} changed on disk` };
        }
        workspace.completeSave(snapshot);
        return { kind: "written" };
      },
      superseded: () => !isCurrent(op),
    }),
  );
  // Thrown, not returned, and only once the fence has been released above: a compile
  // whose auto-save was refused must not reach the compiler, because what is on disk is
  // not what the editor holds and "compiled" would be a claim about the wrong text.
  // The failure path drops the ruleset, says which document it was, and leaves the
  // build not compiled; an operation that has merely been superseded is dropped there
  // in silence instead.
  if (plan.refused !== null) {
    throw new Error(
      `${plan.refused}, so nothing was compiled. Save it, or Reload from Disk, and compile again.`,
    );
  }
  return plan.written;
}

// Every file the project's include graph reaches, as the frontend spells paths.
//
// A fresh analysis every time, never the session's stored one: that snapshot is a
// description of the disk as it was when it was taken, and compiling from it would
// skip a dependency an edit has since introduced.
//
// A rejection is deliberately NOT caught. A user's broken configuration comes
// back as a successful `configurationFailed` analysis, so the only thing left for
// a rejection to mean is an infrastructure failure: a panicking backend, or IPC
// itself. Answering "no members" to that would silently skip dirty nested and
// external dependencies and then compile anyway, and if the backend's own
// analysis happened to succeed the user would get a green compile of stale
// dependency contents. Propagating puts the compile on its normal failure path,
// which invalidates the ruleset and says what went wrong.
async function graphPaths(root: string): Promise<Set<string>> {
  // Both spellings of an internal identity: the root the analysis reports is
  // canonical, which need not be the spelling the file dialog handed us (a symlink
  // on the way in, say), and this is a membership test against document keys that
  // may have come from either. A configuration failure IS an answer - this project
  // has no graph, and the compile is about to report the same error with the code
  // that explains it - and yields the empty set.
  return memberPathsOf((await analyzeProject(root)).analysis, root);
}

async function compileWorkspace() {
  // Asked before the operation begins and before the build state moves, so that
  // Cancel leaves everything exactly as it was: nothing written, nothing superseded,
  // no ruleset dropped, and the button still saying what it said. Asked once for all
  // of them - a compile of a project whose files changed underneath it is one
  // decision, not one decision per file - and the answer covers only the documents
  // and observations it presented, so one that appears while the question is up is
  // written by nothing here.
  //
  // `busy` is not a correctness gate, just a courtesy: it stops a double-click
  // starting two identical compiles, and it is re-checked after the answer because a
  // dialogue is long enough for the user to start one by another route. Genuine
  // overlap is allowed and has to be safe anyway - invalidateCompilation() leaves
  // `compiling` for `stale` precisely so the user can recompile at once, while the
  // abandoned compile is still in flight. What makes that safe is the token below,
  // the reset barrier and the backend's generation, not this.
  const compile = await authorised(
    compileGate(world, { busy: () => buildState === "compiling" }),
    "Compile Workspace",
  );
  if (compile === null) return;
  const confirmed = compile.shown;
  const op = beginOperation();
  setBuildState("compiling", {
    reason: "compile_started",
    owner: { kind: "compile", serial: op.serial, revision: op.revision },
  });
  try {
    if (op.project) {
      // Save first, then send only the root: the backend analyses the directory
      // as it is on disk at that moment, rather than trusting a snapshot
      // assembled here. `op.project` rather than the session's root throughout, so
      // this compile keeps describing the folder it started on even after the user
      // has opened another one.
      // The views are brought up to date by ending that save's fence, which
      // reconciles the open documents and re-reads the project. Nothing extra is
      // needed here, and nothing is lost by not asking: the compile does not depend
      // on the snapshot at all - it sends the root and the backend reads the
      // directory itself.
      await saveProjectDocuments(op.project, op, confirmed);
      if (!isCurrent(op)) return;
    }
    // Cross the reset barrier before the backend compiler is invoked at all. Every
    // reset requested before this compile started - by an edit, by a folder switch,
    // by an earlier compile's cleanup - must have finished by now, or it would land
    // afterwards and drop the generation this compile is about to install, failing a
    // retry that was perfectly valid. A reset that could not be performed throws
    // out of here instead, and this compile never runs.
    await operations.settle();
    // The barrier is an await like any other, so ask again. Anything that
    // superseded this operation while it waited - an edit, another folder - means
    // the compiler must not be called: rules never installed are rules nothing has
    // to undo.
    if (!isCurrent(op)) return;
    let res;
    if (op.project) {
      res = await compileProject(op.project);
    } else {
      // No folder open: the live editor text is the whole compilation.
      const key = workspace.activeKey();
      res = await compileScratch(key == null ? "" : workspace.textOf(key));
    }
    // The response arrived; whether it is still wanted is a separate question.
    // An obsolete one is dropped whole - the backend has already refused to
    // install its ruleset, so honouring it here would report a compilation that
    // Scan cannot run, over a project it was never about.
    if (!isCurrent(op)) return;
    renderDiagnostics(res.diagnostics);
    problemsCountEl.textContent = String(res.diagnostics.length);
    setBuildState(res.ok ? "compiled" : res.sourceChanged ? "stale" : "not-compiled", {
      ruleCount: res.ruleCount,
      reason: res.ok
        ? "compile_succeeded"
        : res.sourceChanged
          ? "compile_source_changed"
          : "compile_failed",
      owner: { kind: "compile", serial: op.serial, revision: op.revision },
    });
    // Only surface the pane when there's something to look at. A clean compile
    // is already signalled by the "Compiled ✓" status line, so opening Problems
    // just to show "No errors or warnings" is noise.
    if (res.diagnostics.length > 0) {
      showTab("problems");
      openResultsDrawer();
    }
  } catch (err) {
    // A rejected compile has already dropped the backend's ruleset, but a failure
    // before it was reached (a save that could not be written, an analysis or a
    // reset that could not run) has not. Dropping it here keeps the one rule that
    // matters: no unsuccessful compile attempt leaves older rules available to Scan.
    //
    // Unless this operation is obsolete, in which case the ruleset is not its
    // business any more and resetting would destroy whatever the current operation
    // has legitimately compiled since. resetFor() makes that decision and the
    // queueing a single synchronous step, so a newer compile cannot slip in between
    // and find this cleanup waiting behind it on the barrier.
    const reset = resetFor(op);
    if (reset === null) return;
    // Ignored here, deliberately: the failure being reported below is the one the
    // user asked about, and a reset that failed on top of it is held by the barrier,
    // which will refuse the next compile rather than let it run on stale rules.
    await reset.catch(() => {});
    // The reset was itself an await, so ask again. Without this, a failure
    // belonging to the folder the user has just left would overwrite the new
    // folder's diagnostics and build state - the very thing the check above
    // exists to prevent, one await later.
    if (!isCurrent(op)) return;
    showFailure(err);
    setBuildState("not-compiled", {
      reason: "compile_exception",
      owner: { kind: "compile", serial: op.serial, revision: op.revision },
    });
  }
}

// Reports a failure the user cannot act on from within the rules themselves: an
// IPC call that rejected, a folder that could not be analysed, a file that could
// not be read. It goes in the Problems pane rather than an alert() so it is not
// modal and stays readable beside the project it concerns.
function showFailure(err: unknown) {
  diagnosticsEl.innerHTML = `<div class="diag error">${escapeHtml(String(err))}</div>`;
  problemsCountEl.textContent = "1";
  showTab("problems");
  openResultsDrawer();
}

async function runScan() {
  if (buildState !== "compiled" || scanning) return;
  const bytes = targetBytes();
  const prev = scanBtn.textContent;
  scanning = true;
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning…";
  refreshMenu();
  try {
    const res = await scanTarget(bytes);
    if (res.ok) {
      resultsView.render(res, new Uint8Array(bytes));
      matchesCountEl.textContent = String(res.matched.length);
    } else {
      resultsView.clear();
      matchesCountEl.textContent = "0";
      if (res.error) {
        diagnosticsEl.innerHTML = `<div class="diag error">${escapeHtml(res.error)}</div>`;
      }
    }
    showTab("matches"); // scan output is matches — surface them
    openResultsDrawer();
  } finally {
    scanning = false;
    scanBtn.textContent = prev;
    scanBtn.disabled = buildState !== "compiled";
    refreshMenu();
  }
}

compileBtn.addEventListener("click", () => void compileWorkspace());
scanBtn.addEventListener("click", () => void runScan());

document.querySelector<HTMLButtonElement>("#pick")!.addEventListener("click", () => {
  void targets.choose();
});

targetEl.addEventListener("input", () => {
  // Unconditionally, before the state check: typing is the user saying what to scan,
  // and it has to beat a read that is still outstanding even when there is no file
  // target to take back - which is exactly the case where nothing below runs.
  targets.supersede();
  if (fileBytes) {
    fileBytes = null;
    targetEl.disabled = false;
    targetInfo.textContent = "";
  }
});

// ---- Native menu ----

// Derives the menu's enabled/checked flags from live app state and pushes them
// to the native menu. Called after every state transition (see the callers
// above); it's a no-op until the menu exists, and the async push is
// fire-and-forget because nothing depends on its completion.
function refreshMenu() {
  const key = workspace.activeKey();
  const real = key != null && key !== "";
  // The identity, not the path: whether Rename applies depends on the source
  // being one this project contains AND being internal.
  const source = real ? session.sourceAt(key) : null;
  void syncMenuState({
    // Mirrors the New button: a project, and no initial analysis still to finish.
    // Compile is deliberately not gated this way - it asks the backend to read the
    // directory itself, so it is valid whether or not the views have caught up.
    canCreateRule: session.isOpen() && !session.isLoading(),
    // Mirrors the Save button: any real document holding work the disk does not,
    // which includes one whose file has gone and whose text is the only copy left.
    // The scratch buffer has no path to write to, so it is never saveable.
    canSave: real && workspace.needsSaving(key),
    canRename: source !== null && !source.external,
    canCloseWorkspace: session.isOpen(),
    canRefreshProject: session.isOpen(),
    canCompile: buildState !== "compiling",
    canScan: buildState === "compiled" && !scanning,
    explorerVisible: !mainEl.classList.contains("explorer-hidden"),
    resultsOpen: mainEl.classList.contains("results-open"),
  }).catch((err) => console.error("menu: state sync failed", err));
}

// Build the menu after the initial UI exists, then immediately sync it so the
// items that start disabled (New Rule, Save, Rename, Scan, Close Workspace,
// Refresh Project) match reality. A failure here must not stop the editor from
// being usable, but it also must not pass unnoticed.
void initMenu({
  openFolder: () => void openFolder(),
  openExample: () => openExample(),
  closeWorkspace: () => void closeWorkspace(),
  refreshProject: () => void refreshManually(),
  newRule: () => void newRule(),
  saveActive: () => void saveActive(),
  renameActiveRule: () => renameActiveRule(),
  compileWorkspace: () => void compileWorkspace(),
  scanTarget: () => void runScan(),
  zoomIn: () => void zoomIn(),
  zoomOut: () => void zoomOut(),
  resetZoom: () => void resetZoom(),
  toggleExplorer: () => toggleExplorer(),
  toggleResults: () => toggleResults(),
  showIncludesView: () => showIncludesView(),
  resetLayout: () => resetLayout(),
  showPreferences: () => showPreferences(),
  showQuickStart: () =>
    void showHelp("quickStart").catch((err) =>
      console.error("help: failed to show Quick Start", err),
    ),
  showDocumentation: () =>
    void showHelp("documentation").catch((err) =>
      console.error("help: failed to show Documentation", err),
    ),
  reportIssue: () =>
    void reportIssue().catch((err) => console.error("help: failed to report an issue", err)),
  showAbout: () => void showAbout(),
  // Requests a window close rather than terminating the process: that is the same
  // path the title bar's close button takes, so the unsaved-work guard covers both
  // at once and the two are indistinguishable. Used on every platform - menu.ts
  // builds Quit by hand everywhere, because neither predefined item will do.
  quit: () => closing.quit(),
})
  .then(() => refreshMenu())
  .catch((err) => {
    console.error("menu: failed to install the native application menu", err);
  });

// The views start in their no-project state rather than empty, so the explorer
// says what to do before a folder has ever been opened.
rebuildProjectViews();

// ---- Zoom ----

void restoreZoom().catch((err) => console.error("zoom: failed to restore", err));
installExtraZoomShortcuts();
