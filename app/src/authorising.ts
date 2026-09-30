// Asking the user before something destructive, and holding the answer to exactly
// what was asked about.
//
// The dialogue that can be seen is the dialog plugin's, and it is an IPC round trip:
// `window.confirm` displays nothing at all in Quipu's WebKitGTK webview and returns
// true, so a guard built on it discards the user's work in silence. That is measured
// rather than assumed - see docs/workspace-project-model.md - and it is why every
// confirmation in the application is asynchronous.
//
// Which is the whole problem this module exists for. A synchronous question has
// nothing between the answer and the transition that acts on it; an awaited one has
// an interval in which the project can be switched, a document can be closed or
// renamed, another program can write the file, a queued save can land, a reload can
// take the file's version, and the user can make a newer gesture of their own. An
// answer given about one state of the world must not authorise a change to another.
//
// So a confirmation is expressed as a gate over three steps, and the order is the
// guarantee:
//
// * `claim` captures - synchronously, before anything is asked - everything the
//   question will be about: which gesture, which project, which document and
//   revision, which observations of the disk, which documents are at risk. Nothing
//   is superseded, cleared or written here, so a cancelled gate leaves the
//   application exactly as it was;
// * `question` turns that claim into the words the user sees, or null when there is
//   nothing at risk at all - a clean workspace and an unconflicted save are never
//   asked anything;
// * `current` is re-checked after the answer, and it is what refuses a stale one.
//
// The caller gets the claim back only if it is still current, and then runs its own
// infallible prologue synchronously on it. A rejected dialogue (an IPC failure)
// throws out of `authorise`, authorising nothing, for the caller to report in
// whichever scope it belongs to.
//
// No DOM, no IPC and no Monaco: the gates are built from the same session, open-
// request, document and observation identities the rest of the app orders itself by,
// so they can be tested against the real ones (see authorising.test.mjs).

// Spelled with extensions because the .mjs tests import these modules on Node's ESM
// resolver, which does not guess one.
import { discardQuestion } from "./closing.ts";
import {
  coversRisk,
  riskKeys,
  type ConflictKind,
  type DiskAnswer,
  type DiskProbe,
  type DocModel,
  type RiskStamp,
  type SaveSnapshot,
} from "./documents.ts";
import type { OpenRequest } from "./opening.ts";
import type { Selection } from "./project.ts";
import { basename } from "./sourceid.ts";

/**
 * One destructive step, as the three things that make an answer to it usable.
 *
 * `C` is whatever the answer is about, and it travels from `claim` to the caller
 * unchanged: the point is that the thing acted on is the thing asked about, not
 * something re-derived from the UI afterwards.
 */
export interface Gate<C> {
  // What the question is about, captured before it is asked. Null means there is
  // nothing to do at all - no document, no project, an operation already running -
  // and nothing is asked.
  claim: () => C | null;
  // The words the user sees, or null when nothing is at risk and no dialogue is
  // warranted. Asking with nothing to say is how users learn to dismiss dialogues
  // unread.
  question: (claim: C) => string | null;
  // Whether the claim still describes the application after the answer. False
  // refuses: a stale answer changes nothing.
  current: (claim: C) => boolean;
}

/**
 * Runs one gate and hands back the claim it is safe to act on, or null.
 *
 * Null means do nothing, and covers all four ways that happens: nothing to claim,
 * the user cancelled, or the world moved while the question was up. A cancelled or
 * stale gate has changed nothing at all, so the caller's own state is untouched and
 * the gesture can simply be repeated.
 *
 * `ask` rejecting propagates. A confirmation that could not be shown authorises
 * nothing - answering for the user is the one thing a broken dialogue must not do -
 * and the caller reports it in the scope it owns.
 *
 * The clean path performs no IPC and shows no dialogue; it resolves in the same tick.
 * `current` is checked on it as well, because resolving a promise still yields to
 * whatever else is waiting on one, and this way the answer is validated on every
 * path rather than on the ones somebody remembered.
 */
export async function authorise<C>(
  gate: Gate<C>,
  ask: (question: string) => Promise<boolean>,
): Promise<C | null> {
  const claim = gate.claim();
  if (claim === null) return null;
  const question = gate.question(claim);
  if (question !== null && !(await ask(question))) return null;
  return gate.current(claim) ? claim : null;
}

/** What the session must be able to say for a claim to be re-checked. */
export interface SessionView {
  selection(): Selection | null;
  isCurrent(sel: Selection): boolean;
  isOpen(): boolean;
}

/** What the open documents must be able to say. `Workspace` (editor.ts) satisfies it. */
export interface DocsView<M extends DocModel = DocModel> {
  activeKey(): string | null;
  atRiskFileStamps(): RiskStamp<M>[];
  dirtyFileKeys(): string[];
  isDirty(key: string): boolean;
  conflictOf(key: string): ConflictKind | null;
  diskAnswer(key: string): DiskAnswer;
  textOf(key: string): string;
  probe(key: string): DiskProbe<M> | null;
  beginSave(key: string): SaveSnapshot<M> | null;
  holds(expect: DiskProbe<M>): boolean;
}

/** What ordering a departure needs: the gesture's place among the requests to open. */
export interface OpensView {
  isCurrent(req: OpenRequest): boolean;
  mark(): OpenRequest;
}

// True when `sel` is still the project on screen. Null is a selection too - no
// project at all - so an answer given with the workspace closed does not authorise
// anything against the folder opened since.
function stillSelected(session: SessionView, sel: Selection | null): boolean {
  return sel === null ? !session.isOpen() : session.isCurrent(sel);
}

/**
 * How each of `keys` stood with its file, as one comparable record of what was shown.
 *
 * Every key, not only the conflicted ones: "this file agreed with the disk when you
 * pressed Save" is as much a part of the answer as the conflicts the question named,
 * and it is the part a later change contradicts.
 */
export function answersFor(
  keys: readonly string[],
  diskAnswer: (key: string) => DiskAnswer,
): Map<string, DiskAnswer> {
  return new Map(keys.map((key) => [key, diskAnswer(key)] as const));
}

/**
 * Whether writing `key` is still the thing the user agreed to.
 *
 * Exactly what was shown, down to WHICH version of the file it was shown about:
 * "changed on disk" can be true of one external version and then of the next, so the
 * disagreement alone would let permission granted for the first be spent on the
 * second. See [`DiskAnswer`].
 *
 * Deliberately not the disagreement itself: what revokes an authorisation is somebody
 * ELSE having been at the file, or the user having withdrawn the revision. A conflict
 * that has merely been RESOLVED since the gesture is neither, and there are two ways
 * it gets resolved. Quipu's own earlier save leaves the file holding Quipu's text,
 * which is what the gesture asked for, so the write behind it still means what it
 * meant. Reload from Disk is the other way, and it takes the file's version: the
 * revision the queued write captured is one the user has just discarded, so the
 * authorisation is gone with it. The observations answer the first half, the reloads
 * the second; the conflict kind cannot tell them apart at all.
 *
 * A key nobody was asked about is held to "nothing was wrong with it", and to no
 * observation in particular - there is no answer to compare against - so a document
 * a compile's auto-save discovers mid-plan cannot be written over a version the user
 * has never been shown either.
 */
export function answerHolds(
  shown: Map<string, DiskAnswer>,
  key: string,
  now: DiskAnswer,
): boolean {
  const agreed = shown.get(key);
  if (agreed === undefined) return now.conflict === null;
  return now.observation === agreed.observation && now.restored === agreed.restored;
}

/** Whether every document the question named still stands where it stood. */
export function answersHold(
  shown: Map<string, DiskAnswer>,
  diskAnswer: (key: string) => DiskAnswer,
): boolean {
  return [...shown.keys()].every((key) => answerHolds(shown, key, diskAnswer(key)));
}

/**
 * The question asked before Quipu's text replaces a version of a file it never saw,
 * or null when none of `keys` disagrees with the disk and there is nothing to ask.
 *
 * One question for all of `keys`, however many of them changed: everything that
 * writes goes through it, the compile's auto-save may write several files, and asking
 * per file would put a queue of dialogues in front of one gesture and invite the user
 * to click through them.
 *
 * A deleted file is included, and answering yes recreates it. That is a real choice -
 * the editor is holding the only copy of its text - but not one to make silently.
 */
export function conflictQuestion(
  keys: readonly string[],
  conflictOf: (key: string) => ConflictKind | null,
): string | null {
  const conflicted = keys.filter((key) => conflictOf(key) !== null);
  if (conflicted.length === 0) return null;
  const lines = conflicted.map((key) => {
    const what =
      conflictOf(key) === "missing"
        ? "no longer on disk; saving recreates it"
        : "changed on disk since it was opened";
    return `  ${basename(key)} - ${what}`;
  });
  return (
    `Save over the version${conflicted.length === 1 ? "" : "s"} on disk?\n\n` +
    `${lines.join("\n")}\n\n` +
    "Saving replaces what is on disk with the editor's text. Cancel, then Reload " +
    "from Disk, to take the other version instead."
  );
}

/** The question asked before the editor's own unsaved text is thrown away for the file's. */
export function reloadQuestion(key: string): string {
  return (
    `Discard unsaved changes to ${basename(key)} and load the version on disk?\n\n` +
    "This cannot be undone."
  );
}

/** What leaving the project on screen was authorised against. */
export interface Departure<M extends DocModel = DocModel> {
  /**
   * The documents the question named, each at the revision it named - so neither a
   * newly at-risk document nor a further edit to one of these is covered by the
   * answer. See [`RiskStamp`] and [`coversRisk`].
   */
  readonly atRisk: readonly RiskStamp<M>[];
  /** The project being left, so an answer cannot be spent on the one opened since. */
  readonly selection: Selection | null;
}

/**
 * Leaving the project on screen: Open Folder, Open Example, Close Workspace.
 *
 * One gate for all three, because they are one transition with different endings and
 * a switch must never do less than a close.
 *
 * `request` is what orders the answer against the user's other gestures. Open Folder
 * and Open Example each claimed one before their picker or their copy started, so
 * theirs is the request that has to still be current; Close Workspace makes no
 * request of its own and marks the ordering instead (`OpenRequests.mark`), so that an
 * open gesture begun while its question was up wins over its answer rather than being
 * cancelled by it.
 *
 * The at-risk list is the FILE list, deliberately: leaving a project keeps the scratch
 * buffer, which has no path and belongs to no folder, and only exiting the application
 * destroys it. The wording is shared with the exit question (closing.ts), so the two
 * cannot drift into describing the same document differently.
 *
 * `requireOpen` is Close Workspace's: there must be a project to close, both when the
 * gesture is made and when the answer arrives.
 */
export function departureGate<M extends DocModel>(
  world: { session: SessionView; docs: DocsView<M>; opens: OpensView },
  opts: { action: string; request: OpenRequest; requireOpen: boolean },
): Gate<Departure<M>> {
  const { session, docs, opens } = world;
  return {
    claim: () => {
      if (!opens.isCurrent(opts.request)) return null;
      if (opts.requireOpen && !session.isOpen()) return null;
      return { atRisk: docs.atRiskFileStamps(), selection: session.selection() };
    },
    question: (claim) =>
      claim.atRisk.length === 0
        ? null
        : discardQuestion(opts.action, riskKeys(claim.atRisk), (key) => docs.isDirty(key)),
    current: (claim) =>
      opens.isCurrent(opts.request) &&
      stillSelected(session, claim.selection) &&
      (!opts.requireOpen || session.isOpen()) &&
      coversRisk(claim.atRisk, docs.atRiskFileStamps()),
  };
}

/**
 * File > Close Workspace, which is a departure with nothing to open afterwards.
 *
 * Its own function rather than options at the call site, because which request it is
 * ordered by is the delicate half and belongs where it can be tested: closing marks
 * the ordering instead of claiming a request, so cancelling it supersedes nothing -
 * a folder picker the user is still looking at outlives a close they thought better
 * of. Claiming one here would cancel that picker just for asking the question.
 */
export function closeGate<M extends DocModel>(world: {
  session: SessionView;
  docs: DocsView<M>;
  opens: OpensView;
}): Gate<Departure<M>> {
  return departureGate(world, {
    action: "Close the workspace",
    request: world.opens.mark(),
    requireOpen: true,
  });
}

/** What one manual Save was authorised against. */
export interface SaveAuthorisation<M extends DocModel> {
  /** The exact revision the gesture named, and the one the write will put on disk. */
  readonly snapshot: SaveSnapshot<M>;
  /** How the file stood when the question was asked; re-checked again at write time. */
  readonly shown: Map<string, DiskAnswer>;
  readonly selection: Selection | null;
}

/**
 * File > Save, and the Save button.
 *
 * The snapshot is captured before the question, not after it: the revision written
 * has to be the one the user was asking about. Which is also what refuses a stale
 * answer - if the document has been edited, reloaded, renamed or closed while the
 * dialogue was up, the text it holds is no longer the text that was confirmed, and
 * this write is abandoned rather than quietly writing something else. The document
 * stays dirty and Save says so again.
 */
export function saveGate<M extends DocModel>(
  world: { session: SessionView; docs: DocsView<M> },
  key: string,
): Gate<SaveAuthorisation<M>> {
  const { session, docs } = world;
  return {
    claim: () => {
      const snapshot = docs.beginSave(key);
      if (snapshot === null) return null;
      return {
        snapshot,
        shown: answersFor([key], (k) => docs.diskAnswer(k)),
        selection: session.selection(),
      };
    },
    question: (claim) => conflictQuestion([claim.snapshot.key], (k) => docs.conflictOf(k)),
    current: (claim) =>
      stillSelected(session, claim.selection) &&
      docs.holds(claim.snapshot) &&
      docs.textOf(claim.snapshot.key) === claim.snapshot.text &&
      answersHold(claim.shown, (k) => docs.diskAnswer(k)),
  };
}

/** What a compile's auto-save was authorised against. */
export interface CompileAuthorisation {
  /** The documents the question was about, in the order they were opened. */
  readonly keys: readonly string[];
  readonly shown: Map<string, DiskAnswer>;
  readonly selection: Selection | null;
}

/**
 * Rules > Compile Workspace, whose auto-save may write several documents.
 *
 * Asked before the operation begins and before the build state moves, so a cancel
 * leaves everything as it was: nothing written, nothing superseded, no ruleset
 * dropped, and the button still saying what it said.
 *
 * `busy` is the compile already running. It is re-checked after the answer as well,
 * because the dialogue is long enough for the user to start one by another route.
 */
export function compileGate<M extends DocModel>(
  world: { session: SessionView; docs: DocsView<M> },
  opts: { busy: () => boolean },
): Gate<CompileAuthorisation> {
  const { session, docs } = world;
  return {
    claim: () => {
      if (opts.busy()) return null;
      const keys = docs.dirtyFileKeys();
      return {
        keys,
        shown: answersFor(keys, (k) => docs.diskAnswer(k)),
        selection: session.selection(),
      };
    },
    question: (claim) => conflictQuestion(claim.keys, (k) => docs.conflictOf(k)),
    current: (claim) =>
      !opts.busy() &&
      stillSelected(session, claim.selection) &&
      answersHold(claim.shown, (k) => docs.diskAnswer(k)),
  };
}

/** What one Reload from Disk was authorised against. */
export interface ReloadAuthorisation<M extends DocModel> {
  readonly key: string;
  /** The document and revision the question named; `reload` refuses against anything else. */
  readonly expect: DiskProbe<M>;
  /** The text the user agreed to throw away, which is what makes the answer specific. */
  readonly text: string;
  readonly selection: Selection | null;
}

/**
 * Reload from Disk: the editor's text is replaced by the file's, which is the only
 * way out of a conflict other than saving over it.
 *
 * Asked only when there are unsaved edits to lose. A clean document in conflict holds
 * nothing the disk has not got, so reloading it is not destructive and is not asked
 * about - the same rule that keeps it out of the at-risk list.
 *
 * The probe is taken before the question for the same reason a save's snapshot is: it
 * names the revision the user was asked about, and `DocumentSet.reload` refuses to
 * replace anything else - an edit, a save or another reload landing while the dialogue
 * was up leaves the text and the conflict alone. Taking it records nothing and
 * supersedes nothing; it only claims a place in that document's order of disk
 * operations, so a cancelled reload still changes nothing.
 */
export function reloadGate<M extends DocModel>(
  world: { session: SessionView; docs: DocsView<M> },
): Gate<ReloadAuthorisation<M>> {
  const { session, docs } = world;
  return {
    claim: () => {
      const key = docs.activeKey();
      // The scratch buffer has no file to reload from.
      if (key === null || key === "") return null;
      if (docs.conflictOf(key) === null) return null;
      const expect = docs.probe(key);
      if (expect === null) return null;
      return { key, expect, text: docs.textOf(key), selection: session.selection() };
    },
    question: (claim) => (docs.isDirty(claim.key) ? reloadQuestion(claim.key) : null),
    current: (claim) =>
      stillSelected(session, claim.selection) &&
      // The gesture was made on the document the user was looking at. Reloading one
      // they have since navigated away from would replace text off screen.
      docs.activeKey() === claim.key &&
      docs.holds(claim.expect) &&
      // And the text the answer was about is still the text that would be lost. An
      // edit made while the dialogue was up is work the user has never been asked
      // about, so this reload is abandoned rather than reading the file and finding
      // out down there. (`holds` is identity only, deliberately; see documents.ts.)
      docs.textOf(claim.key) === claim.text &&
      // Resolved while the question was up - by a save, or by the file coming back -
      // and there is nothing left to reload.
      docs.conflictOf(claim.key) !== null,
  };
}
