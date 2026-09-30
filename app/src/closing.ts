// Terminating the application, and the one guard every way of doing it goes
// through.
//
// There are two ways to end a Quipu window and they arrive by different routes:
// File > Quit, which is Quipu's own menu item on every platform, and the title
// bar's close button or the window manager, which is not Quipu's code at all.
// Quit is built by hand even on macOS, where the predefined item would be
// `terminate:` and would leave by neither route (menu.ts).
// What makes one guard possible is that both end up asking the *window* to
// close, and Tauri turns that request into `tauri://close-requested` while a
// frontend listener exists - the native close is prevented for as long as one is
// registered, and the window is destroyed only when the handler declines to
// prevent it. So the guard lives in that handler, and File > Quit deliberately
// asks the window to close rather than exiting the process: an unconditional exit
// would be a second way out with no guard on it.
//
// What exiting puts at risk is NOT quite what leaving a project puts at risk. A
// workspace switch keeps the scratch buffer - it has no path, so no folder change
// can close it or lose it - which is why `Workspace.atRiskFileKeys()` filters it
// out. Exiting destroys it along with everything else, so the exit path asks for
// the unfiltered set (`Workspace.atRiskExitKeys()`). The difference is deliberate
// and is the reason this asks for its own list rather than reusing the switch's.
//
// The classification itself is not re-implemented here: a document is at risk when
// it has unsaved edits, or when its file has gone and its text is the only copy
// left (documents.ts). A clean document whose file merely changed on disk is not at
// risk - the disk has a version of its own - and naming it would teach the user to
// click through the question.
//
// The wording is shared with the workspace-switch confirmation for the same
// reason the classification is: two spellings of "and lose a.yar?" would drift,
// and the exit path would be the one that drifted silently, because it is the one
// nothing else exercises.
//
// No DOM, no IPC and no Monaco: the state machine and the wording can be tested on
// their own (see closing.test.mjs).

// Spelled with its extension because the .mjs tests import this module on Node's
// ESM resolver, which does not guess one.
import { coversRisk, riskKeys, type DocModel, type RiskStamp } from "./documents.ts";
import { basename } from "./sourceid.ts";

// The scratch buffer's document key. It has no path, and that is what distinguishes
// it: it can never be saved, so a question about it cannot advise saving it.
const SCRATCH_KEY = "";

/**
 * Whether a close request may proceed.
 *
 * `keep` is the caller's cue to prevent the default, which is what stops the
 * window being destroyed. Anything other than `close` must therefore prevent -
 * including a failure, since refusing to exit loses nothing and exiting anyway
 * loses the user's work.
 */
export type CloseDecision = "close" | "keep";

/**
 * How far a close has got.
 *
 * `idle` is the resting state, and the state a cancelled close returns to - a
 * cancelled close changes nothing at all, this included, so the next request asks
 * again. `prompting` is a question on screen. `closing` is a close the user has
 * approved: the window is on its way out, and any further request is that same
 * gesture arriving twice rather than a new decision to make.
 */
export type CloseState = "idle" | "prompting" | "closing";

/** What the coordinator needs of the application. */
export interface CloseHooks {
  /**
   * Every open document whose text exiting would destroy, in the order they were
   * opened. Exit-level, so the scratch buffer is included when it is dirty.
   *
   * Stamped rather than named, because it is asked twice - once to put the question
   * together, once to check the answer still describes the application - and a path
   * cannot tell one revision of a document from another. See [`RiskStamp`].
   */
  atRisk: () => RiskStamp[];
  // Asks the user whether to go ahead. Only ever called with a non-empty `keys`, so
  // a clean application is never asked anything. False keeps the application.
  //
  // Asynchronous because the dialogue that can actually be seen is: `window.confirm`
  // returns true without displaying anything at all in Quipu's WebKitGTK webview -
  // measured, not assumed - so a guard built on it would discard the user's work in
  // silence, which is the exact failure it exists to prevent. The native dialogue is
  // an IPC round trip. Tauri awaits the close-requested handler before deciding
  // whether to destroy the window, so awaiting an answer is safe; what it opens is a
  // window in which another close request can arrive, which is what `prompting`
  // below is for.
  confirm: (keys: string[]) => Promise<boolean>;
  // Asks the window to close - the same request the title bar makes, so it arrives
  // back here as a close request like any other. Never a process exit.
  requestWindowClose: () => void;
}

/**
 * The one place that decides whether the application may terminate.
 *
 * Every entry point converges on `closeRequested`: File > Quit through
 * `quit()`, which asks the window to close rather than deciding anything itself,
 * and the title bar and the window manager through Tauri's close-requested event.
 */
export class CloseCoordinator {
  private phase: CloseState = "idle";
  // Spelled out rather than declared as a constructor parameter property, which
  // Node's type-stripping loader - what the .mjs tests run on - does not accept.
  private hooks: CloseHooks;

  constructor(hooks: CloseHooks) {
    this.hooks = hooks;
  }

  state(): CloseState {
    return this.phase;
  }

  // File > Quit. Deliberately not a decision of its own: it makes the same request
  // the title bar's close button makes, which comes back through closeRequested()
  // below. A guard the menu item could bypass would be no guard at all.
  quit(): void {
    this.hooks.requestWindowClose();
  }

  /**
   * Decides one close request. `keep` means the caller must prevent the default.
   *
   * The order of the tests is the meaning:
   *
   * * a close the user has already approved proceeds without being asked about
   *   again. This is what a duplicate request is: an approved close asks the
   *   window to go away, and the window manager or a second impatient click can
   *   deliver another request while it does. Re-asking would put a second dialogue
   *   in front of one gesture, and refusing outright would strand a window that
   *   has been told to close;
   * * a request arriving while the question is on screen is refused without asking
   *   anything. Nothing has been approved, so nothing may close - and the dialogue
   *   is awaited, so this is a window several requests really can arrive in;
   * * nothing at risk closes immediately. Not "prompts with an empty list": a
   *   clean application must never put a dialogue in front of Quit;
   * * otherwise the user decides. Yes moves to `closing`, and every request after
   *   it is the first case above. No returns to `idle`, having changed nothing:
   *   the project is still open, the documents still hold their text, and the next
   *   Quit asks again.
   *
   * Yes is then held to what it was given about. The dialogue is awaited, and a
   * watcher noticing a deleted file, a queued reconciliation or a rename can put a
   * document at risk while it is up - so the at-risk set is taken again and the answer
   * must still cover it: same document, same revision. Work saved meanwhile has simply
   * left the set and does not revoke anything, but work the user was never shown keeps
   * the application, back at `idle`, and the next Quit asks about all of it. The
   * revalidation is deliberately symmetric with a workspace departure's
   * (authorising.ts); exiting has strictly more to lose.
   *
   * A confirmation that throws or rejects leaves the state `idle` and propagates, so the caller
   * prevents the close: a guard that cannot ask must not answer for the user.
   */
  async closeRequested(): Promise<CloseDecision> {
    if (this.phase === "closing") return "close";
    if (this.phase === "prompting") return "keep";
    const atRisk = this.hooks.atRisk();
    if (atRisk.length === 0) {
      this.phase = "closing";
      return "close";
    }
    // Set before the await, so a request arriving while the dialogue is up finds
    // `prompting` rather than `idle` and cannot raise a second dialogue.
    this.phase = "prompting";
    let approved: boolean;
    try {
      approved = await this.hooks.confirm(riskKeys(atRisk));
    } catch (err) {
      this.phase = "idle";
      throw err;
    }
    if (!approved || !coversRisk(atRisk, this.hooks.atRisk())) {
      this.phase = "idle";
      return "keep";
    }
    this.phase = "closing";
    return "close";
  }
}

/**
 * Which of the open documents exiting would destroy, given all of them.
 *
 * The exit-level query, and the only one: it keeps the scratch buffer, because
 * exiting the application destroys it, whereas leaving a project does not - the
 * scratch buffer has no path and belongs to no folder, so a switch neither closes it
 * nor can lose it. That is the whole difference between this and the switch's
 * `Workspace.atRiskFileKeys()`, and it lives here rather than as a decision taken at
 * the call site so that there is one answer to hold to a test.
 *
 * The classification is documents.ts's throughout: unsaved edits, or a file that is
 * no longer there at all. Stamped, so that the answer to a question about this set can
 * be checked against it afterwards; see [`RiskStamp`].
 */
export function atRiskOnExit<M extends DocModel>(docs: {
  atRiskStamps(): RiskStamp<M>[];
}): RiskStamp<M>[] {
  return docs.atRiskStamps();
}

/**
 * The question asked before work that exists nowhere else is thrown away.
 *
 * `action` completes "... and lose a.yar?", so it reads as the gesture the user
 * made: "Close the workspace", "Open another folder", "Quit Quipu". `keys` is the
 * at-risk set, and `isDirty` says which of the two ways each document is at risk -
 * unsaved edits, or a file that is no longer there and a document holding the only
 * copy of its text. The second reports no unsaved edits, because nothing was
 * edited, so calling it unsaved would be untrue of it.
 *
 * Callers ask this only with a non-empty `keys`; an empty one has no question in
 * it, and asking anyway is what teaches users to dismiss dialogues unread.
 */
export function discardQuestion(
  action: string,
  keys: readonly string[],
  isDirty: (key: string) => boolean,
): string {
  const names = keys
    .map((key) => `${riskName(key)} (${isDirty(key) ? "unsaved" : "not on disk"})`)
    .join(", ");
  // What to do instead, and only what applies. Save is the answer for a file, and
  // the scratch buffer is the one document it is not the answer for: it has no path,
  // File > Save is unavailable for it throughout the app, and telling the user to
  // save it would send them looking for a command that is greyed out.
  const advice: string[] = [];
  if (keys.some((key) => key !== SCRATCH_KEY)) {
    advice.push("Cancel, then Save, to write them to disk.");
  }
  if (keys.includes(SCRATCH_KEY)) {
    advice.push("The scratch buffer has no file to save to; copy its text elsewhere to keep it.");
  }
  return `${action} and lose ${names}?\n\n${advice.join(" ")}`;
}

// How a document is named in that question. Its file name, except for the scratch
// buffer, which has no path to take a name from.
function riskName(key: string): string {
  return key === SCRATCH_KEY ? "the scratch buffer" : basename(key);
}
