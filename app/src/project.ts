// The open project, as the frontend owns it.
//
// Before this, the frontend's idea of a project was two unrelated globals - a
// directory string and a flat file list - and the analysis was something a compile
// fetched and threw away. That could not answer the questions the Files and
// Includes views ask (what does this project contain, is what I am showing still
// true, did the analysis fail or is the project merely broken), so the state is
// modelled explicitly here instead: one selection, one accepted snapshot, and a
// phase that says which of them the UI may believe.
//
// ---- What supersedes what ----
//
// The user is free to keep working while anything here is in flight, so every
// response has to be checked against the state as it is when it LANDS:
//
//   * a newer folder selection supersedes every load, analysis and refresh of the
//     previous one - including a selection of the folder already open, which
//     comparing paths cannot see, which is why selections are counted;
//   * closing the workspace supersedes them all the same way;
//   * among the analyses of ONE selection, an older response cannot replace a
//     newer one, however they happen to arrive: refreshes are ordered, and the
//     order of the newest response accepted or failed is remembered.
//
// This is the folder-load token from Phase 2 grown up rather than a second
// mechanism beside it: the selection serial IS the load identity, so `begin`,
// `isCurrent`, `isLoading` and `finish` still exist here with their semantics
// intact (their tests moved to project.test.mjs). Keeping FolderLoads as well
// would have meant two counters that had to agree about which folder is open.
//
// It is deliberately NOT the compilation operation token (operations.ts). A
// compile of the folder that is still analysing is legitimate - the backend reads
// the directory itself - and must not cancel the analysis, nor be cancelled by it.
//
// ---- Staleness, and what a stored snapshot may be used for ----
//
// An accepted snapshot describes the disk at the moment the backend read it. An
// edit in the editor, or a filesystem change behind the app's back, makes it a
// description of the past. The frontend therefore never compiles from it and
// never decides dirty-document membership from it alone: those go to a fresh
// `analyze_project`. `isStale()` exists so the UI can SAY so, and so an explicit
// Refresh has something to offer.
//
// A failure is not a snapshot. `configurationFailed` is a perfectly good answer -
// the project definition is broken, there is no graph, and the issue explains it -
// whereas a rejected `analyze_project` is an infrastructure failure with no
// answer in it at all. The two are kept apart: the first is an accepted analysis,
// the second sets `failure()` and, if nothing was ever accepted, the `failed`
// phase.
//
// No DOM and no IPC - the analysis is injected by the caller - so the ordering can
// be tested on its own (see project.test.mjs).

import type { ProjectAnalysis, SourceId } from "./ipc";
// Spelled with its extension because the .mjs tests import this module on Node's
// ESM resolver, which does not guess one. `./ipc` needs no extension: the import
// is type-only, so nothing of it survives to be resolved at runtime - which is
// also what keeps @tauri-apps out of the test process.
import { identityKey, joinRoot } from "./sourceid.ts";

/** A snapshot that exists: the `loaded` arm of ProjectAnalysis. */
export type LoadedAnalysis = Extract<ProjectAnalysis, { status: "loaded" }>;

/** One accepted folder selection. Counted, so re-opening the same path differs. */
export interface Selection {
  serial: number;
  // The root exactly as the folder picker supplied it. The analysis reports a
  // canonical root, which need not be this spelling.
  root: string;
}

/** One analysis of one selection. Hand it back to accept/fail/finish. */
export interface AnalysisRequest {
  selection: Selection;
  // Position among this selection's analyses, from 1. Newer is greater.
  order: number;
  // The edit epoch when it started, so an edit during it is detectable.
  epoch: number;
  // True for the analysis that is part of opening the project: only that one owns
  // the loading flag the commands which would race it are gated on.
  initial: boolean;
}

/** Identity of one in-flight attempt to present this selection's first source. */
export interface InitialPresentationAttempt {
  selection: Selection;
  order: number;
  serial: number;
}

export type InitialPresentationOutcome =
  | "shown"
  | "stale"
  | "failed"
  | "configuration-failed"
  | "no-openable-source";

export type InitialPresentationState =
  | { kind: "available" }
  | { kind: "pending"; attempt: InitialPresentationAttempt }
  | {
      kind: "terminal";
      order: number;
      reason: InitialPresentationOutcome | "user-navigation";
      retryable: boolean;
    };

function samePresentationAttempt(
  left: InitialPresentationAttempt,
  right: InitialPresentationAttempt,
): boolean {
  return (
    left.selection.serial === right.selection.serial &&
    left.order === right.order &&
    left.serial === right.serial
  );
}

export type ProjectPhase =
  // No project. The scratch buffer is what the editor shows.
  | "closed"
  // A selection has been accepted and its first analysis has not landed yet.
  | "opening"
  // A snapshot has been accepted. It may be a configuration failure, and it may
  // be stale; both are things to show, not reasons to disbelieve the project.
  | "ready"
  // The project's first analysis could not be performed at all. Not the same as a
  // project with problems, and emphatically not an empty project.
  | "failed";

export class ProjectSession {
  private serial = 0;
  private current: Selection | null = null;
  private phaseValue: ProjectPhase = "closed";
  private accepted: ProjectAnalysis | null = null;
  // The order of the newest response acted on, accepted or failed. Both count:
  // once a newer response has been dealt with, an older one has nothing to say.
  private settledOrder = 0;
  private issuedOrder = 0;
  private loading = false;
  private refreshes = 0;
  private staleFlag = false;
  private failureValue: unknown = null;
  // Auto-opening a source belongs to the selection, not necessarily to request
  // order 1: a coverage catch-up may be the first accepted snapshot while the
  // initial restore response is still in flight. Pending is deliberately not a
  // permanent claim: a newer accepted snapshot may replace an attempt whose file
  // read has not reached the editor yet.
  private initialPresentation: InitialPresentationState = { kind: "available" };
  private initialPresentationSerial = 0;
  // Bumped by every real edit. Captured in each request, so an edit that lands
  // while an analysis is outstanding leaves its result marked stale rather than
  // presented as current.
  private epoch = 0;
  // Derived from `accepted`; rebuilt when it changes rather than on every lookup,
  // because the menu asks on every keystroke.
  private members: Map<string, SourceId> | null = null;

  // ---- Selection ----

  // Accepts a folder selection, superseding every load, analysis and refresh
  // outstanding, and leaves the session in the state an unloaded project has.
  //
  // Nothing here can fail, which is the point: call it before the first fallible
  // await of opening, so a folder switch cannot leave the previous project's
  // snapshot on screen if listing the new one throws.
  open(root: string): Selection {
    this.serial += 1;
    this.current = { serial: this.serial, root };
    this.phaseValue = "opening";
    this.reset();
    this.loading = true;
    return this.current;
  }

  // Closes the project, superseding everything outstanding. The caller still has
  // to drop the ruleset and the editor documents; this makes every response that
  // is still in flight refuse to touch them on the way out.
  close(): void {
    this.serial += 1;
    this.current = null;
    this.phaseValue = "closed";
    this.reset();
  }

  private reset(): void {
    this.accepted = null;
    this.members = null;
    this.settledOrder = 0;
    this.issuedOrder = 0;
    this.loading = false;
    this.refreshes = 0;
    this.staleFlag = false;
    this.failureValue = null;
    this.initialPresentation = { kind: "available" };
  }

  /** The current selection, or null when no project is open. */
  selection(): Selection | null {
    return this.current;
  }

  // True while `sel` is still the selection whose results the UI wants. Check it
  // after every await, before touching anything shared.
  isCurrent(sel: Selection): boolean {
    return this.current !== null && sel.serial === this.current.serial;
  }

  /** The open root as the picker spelled it, or null. Feeds the operation token. */
  root(): string | null {
    return this.current?.root ?? null;
  }

  isOpen(): boolean {
    return this.current !== null;
  }

  phase(): ProjectPhase {
    return this.phaseValue;
  }

  // True while the project now open still has its INITIAL analysis outstanding.
  // Commands that would race it - New Rule, whose file the analysis would not
  // know about and whose new document the auto-open would push out of the editor -
  // are unavailable until it settles. A refresh does not count: the project is
  // fully known by then, and making the user wait for one buys nothing.
  isLoading(): boolean {
    return this.loading;
  }

  /** True while a refresh of the project now open is outstanding. */
  isRefreshing(): boolean {
    return this.refreshes > 0;
  }

  // True when the accepted snapshot may no longer describe the disk: an edit has
  // happened since it was taken, a document belonging to it is unsaved, a refresh
  // failed, or the app mutated the project. Presentation only - the compile path
  // always obtains a fresh analysis regardless.
  isStale(): boolean {
    return this.staleFlag;
  }

  /** The accepted analysis, configuration failure included, or null. */
  analysis(): ProjectAnalysis | null {
    return this.accepted;
  }

  /** The accepted snapshot, or null if none was accepted or it has no graph. */
  loaded(): LoadedAnalysis | null {
    return this.accepted !== null && this.accepted.status === "loaded" ? this.accepted : null;
  }

  // The reason the last analysis could not be performed - an IPC or backend
  // failure, never a configuration problem - or null. Non-null alongside an
  // accepted snapshot means a refresh failed and the snapshot it would have
  // replaced is still what is being shown.
  failure(): unknown {
    return this.failureValue;
  }

  // ---- Analyses ----

  // Starts an analysis of `sel`, or returns null if `sel` is no longer current
  // and asking the backend about it would be pointless.
  beginAnalysis(sel: Selection, initial: boolean): AnalysisRequest | null {
    if (!this.isCurrent(sel)) return null;
    this.issuedOrder += 1;
    if (!initial) this.refreshes += 1;
    return { selection: sel, order: this.issuedOrder, epoch: this.epoch, initial };
  }

  // Accepts `analysis` as what the project is, and reports whether it was taken.
  //
  // False means the caller must change nothing: the response belongs to a folder
  // the user has left, or an older analysis has been overtaken by a newer one
  // whose answer is already on screen.
  //
  // `unsaved` is whether any document belonging to THIS analysis has unsaved
  // edits; the caller knows, because it holds the editor. Together with the edit
  // epoch captured when the analysis started, it decides whether the snapshot is
  // already out of date on arrival.
  accept(req: AnalysisRequest, analysis: ProjectAnalysis, unsaved: boolean): boolean {
    if (!this.isCurrent(req.selection)) return false;
    if (req.order <= this.settledOrder) return false;
    this.settledOrder = req.order;
    this.accepted = analysis;
    this.members = null;
    this.phaseValue = "ready";
    this.failureValue = null;
    // Recomputed rather than OR-ed with the previous value: a save followed by a
    // refresh is exactly how a stale project stops being stale.
    this.staleFlag = unsaved || req.epoch !== this.epoch;
    return true;
  }

  // Records that an analysis could not be performed, and reports whether the
  // failure is this project's to show.
  //
  // A failed refresh does NOT clear the accepted snapshot: the project is still
  // open and still described by the last answer that arrived, so the failure is
  // reported beside it and the snapshot is marked stale. Only a project that
  // never got an answer at all ends up in the `failed` phase.
  failAnalysis(req: AnalysisRequest, err: unknown): boolean {
    if (!this.isCurrent(req.selection)) return false;
    if (req.order <= this.settledOrder) return false;
    this.settledOrder = req.order;
    this.failureValue = err ?? new Error("analyze_project failed");
    if (this.accepted === null) this.phaseValue = "failed";
    else this.staleFlag = true;
    return true;
  }

  // Records that `req` has settled - accepted, failed or superseded, it makes no
  // difference - and reports whether it was still the current selection's.
  //
  // False means the caller must change nothing: a superseded load's cleanup has
  // no business announcing the newer one as finished and re-enabling the commands
  // that were gated on it. Call it from a `finally`, so every exit goes through
  // the same guard.
  finishAnalysis(req: AnalysisRequest): boolean {
    if (!this.isCurrent(req.selection)) return false;
    if (req.initial) this.loading = false;
    else this.refreshes = Math.max(0, this.refreshes - 1);
    return true;
  }

  /**
   * Starts the selection's automatic initial presentation for the currently
   * accepted snapshot. A newer accepted response may supersede an older pending
   * attempt or retry an explicit retryable terminal outcome. The same response
   * can never start twice.
   */
  beginInitialPresentation(req: AnalysisRequest): InitialPresentationAttempt | null {
    if (!this.isCurrent(req.selection)) return null;
    if (req.order !== this.settledOrder || this.accepted === null) return null;
    if (this.initialPresentation.kind === "pending") {
      if (req.order <= this.initialPresentation.attempt.order) return null;
    } else if (this.initialPresentation.kind === "terminal") {
      if (!this.initialPresentation.retryable || req.order <= this.initialPresentation.order)
        return null;
    }
    this.initialPresentationSerial += 1;
    const attempt = {
      selection: req.selection,
      order: req.order,
      serial: this.initialPresentationSerial,
    };
    this.initialPresentation = { kind: "pending", attempt };
    return attempt;
  }

  /**
   * Settles an attempt only if it is still the pending owner. `shown` and an
   * explicit user choice are permanent for this selection. Failure/no-source
   * outcomes may be retried once, and only when a newer snapshot is accepted.
   */
  finishInitialPresentation(
    attempt: InitialPresentationAttempt,
    outcome: InitialPresentationOutcome,
  ): boolean {
    if (this.initialPresentation.kind !== "pending") return false;
    if (!samePresentationAttempt(this.initialPresentation.attempt, attempt)) return false;
    this.initialPresentation = {
      kind: "terminal",
      order: attempt.order,
      reason: outcome,
      retryable: outcome !== "shown",
    };
    return true;
  }

  /** Retires automatic presentation synchronously when the user owns the editor. */
  retireInitialPresentationForUser(): boolean {
    if (this.current === null) return false;
    if (
      this.initialPresentation.kind === "terminal" &&
      !this.initialPresentation.retryable
    )
      return false;
    this.initialPresentation = {
      kind: "terminal",
      order: this.settledOrder,
      reason: "user-navigation",
      retryable: false,
    };
    return true;
  }

  /** Observable state for wiring, trace records and deterministic tests. */
  initialPresentationState(): InitialPresentationState {
    return this.initialPresentation;
  }

  // Declares that the disk no longer matches the accepted snapshot: an edit, or
  // an app-controlled mutation such as New Rule or Rename before its refresh has
  // landed. Advancing the epoch is what makes an analysis that is already in
  // flight arrive stale instead of arriving current.
  markStale(): void {
    this.epoch += 1;
    if (this.current !== null) this.staleFlag = true;
  }

  // ---- Membership ----

  // Every openable path the accepted snapshot reaches, mapped to its identity.
  //
  // Both spellings of an internal source are present: the analysis reports a
  // canonical root, which need not be what the file dialog handed us (a symlink
  // on the way in, say), and this answers membership tests against document keys
  // that may have come from either. The canonical spelling wins where they
  // collide, because that is the one the views and the backend's diagnostics use.
  memberIds(): Map<string, SourceId> {
    if (this.members !== null) return this.members;
    const map = new Map<string, SourceId>();
    const analysis = this.loaded();
    const picked = this.current?.root ?? null;
    if (analysis !== null) {
      for (const id of sourcesOf(analysis)) {
        if (id.external) {
          map.set(id.path, id);
          continue;
        }
        if (picked !== null && picked !== analysis.root) map.set(joinRoot(picked, id.path), id);
        map.set(joinRoot(analysis.root, id.path), id);
      }
    }
    this.members = map;
    return map;
  }

  /** The identity of the source an open document key refers to, if any. */
  sourceAt(key: string): SourceId | null {
    return this.memberIds().get(key) ?? null;
  }

  /** True when `key` is a document belonging to the accepted snapshot. */
  isMember(key: string): boolean {
    return this.memberIds().has(key);
  }
}

// Every source an analysis mentions: the files discovery found, plus the graph's
// nodes, which additionally cover declared entrypoints outside discovery and the
// external files includes reached. In identity order, de-duplicated.
export function sourcesOf(analysis: LoadedAnalysis): SourceId[] {
  const seen = new Set<string>();
  const out: SourceId[] = [];
  for (const id of analysis.discovered) {
    const key = identityKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  for (const node of analysis.nodes) {
    const key = identityKey(node.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node.id);
  }
  return out;
}

// The same membership map for an analysis the session has not accepted yet -
// needed to answer "are any of THIS analysis's documents unsaved?" before
// accepting it, since the answer decides whether it arrives stale.
export function memberPathsOf(analysis: ProjectAnalysis, pickedRoot: string): Set<string> {
  const paths = new Set<string>();
  if (analysis.status !== "loaded") return paths;
  for (const id of sourcesOf(analysis)) {
    if (id.external) {
      paths.add(id.path);
      continue;
    }
    paths.add(joinRoot(analysis.root, id.path));
    if (pickedRoot !== analysis.root) paths.add(joinRoot(pickedRoot, id.path));
  }
  return paths;
}

// The source to open when a project is first shown: the first discovered file
// whose bytes can be read. Discovery is in identity order, so internal files come
// before external ones and the answer is the shallowest, alphabetically first
// rule file - which is what a user opening a folder expects to be looking at.
export function firstOpenableSource(analysis: LoadedAnalysis): SourceId | null {
  const unreadable = new Set(
    analysis.nodes.filter((n) => !n.readable).map((n) => identityKey(n.id)),
  );
  for (const id of analysis.discovered) {
    if (!unreadable.has(identityKey(id))) return id;
  }
  return null;
}
