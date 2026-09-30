// Choosing the file to scan, in the order the user chose it.
//
// Picking a target file is two awaits long: the file dialogue, and then reading the
// bytes. Both are long enough to be overtaken. While one is outstanding the user can
// pick a different file, open an example - which brings its own sample target - or
// type into the target textarea, and each of those is a later statement about what
// the target is than the read that is still in flight. Installing those bytes when
// they finally arrive would replace the newer choice with the older one, purely
// because the older file was slower to read.
//
// So a gesture is counted the moment it is made, before the dialogue is shown, and
// the count is re-checked after each await, whether it succeeded or failed. What the
// user did last owns the target area from the moment they did it, not from the moment
// its I/O lands. A gesture that has been overtaken installs nothing and reports
// nothing - including when what arrives is a failure, since the dialogue that would
// not open or the file that would not read is not the one the user is waiting for,
// and saying so would talk over whatever the newer gesture has to say about the one
// they are.
//
// This is a generation of its own, deliberately not one of the others. A compilation
// operation, a project selection, a navigation gesture and a pending open all
// answer different questions - which ruleset, which folder, which document, which
// open request - and the scan target survives all of them: closing a workspace does
// not clear the chosen file, and choosing a file is not a navigation. Sharing a
// counter would make each of those cancel target choices it has nothing to say
// about.
//
// No DOM and no IPC - the dialogue, the read, the presentation and the failure
// reporting are the host's - so the ordering can be tested on its own (see
// targets.test.mjs).

/** What a target-file gesture did. Only `installed` changes the scan target. */
export type TargetOutcome =
  // The bytes are the scan target now.
  | "installed"
  // The user closed the dialogue without choosing. Nothing was read.
  | "cancelled"
  // Overtaken by a later gesture. Nothing was installed and nothing was reported,
  // so whatever the newer gesture put on screen still stands.
  | "stale"
  // The dialogue could not be shown, or the file could not be read. The target is
  // unchanged, but the failure was reported, so this outcome does show the user
  // something.
  | "failed";

/** What target selection needs of the app. One line each where it is constructed. */
export interface TargetHost {
  /**
   * Shows the file dialogue. Null when the user chooses nothing; a rejection is
   * a dialogue that could not be shown, which is a failure of the gesture.
   */
  pick(): Promise<string | null>;
  read(path: string): Promise<number[]>;
  /**
   * Presents `path` as the target. May call [`TargetRequests.supersede`] itself -
   * the host's one presentation is shared with the example path - which is harmless
   * here: there is nothing left of this gesture to invalidate.
   */
  install(path: string, bytes: number[]): void;
  /**
   * Where a failure goes - a dialogue that could not be shown, or a file that
   * could not be read. Only ever called for a gesture that is still current, and
   * at most once per gesture.
   */
  fail(err: unknown): void;
}

export class TargetRequests {
  // Statements about what the target is, counted. A gesture holds the number it was
  // given and is current only while it is still the newest.
  private requests = 0;
  // Assigned rather than declared as a constructor parameter property: the .mjs
  // tests run this file through Node's type stripping, which rejects that syntax.
  private host: TargetHost;

  constructor(host: TargetHost) {
    this.host = host;
  }

  /**
   * Records that the target has been set some other way: an example's sample target
   * installed, or the user typing their own bytes into the textarea.
   *
   * Call it whether or not that other way changes anything visible. Typing with no
   * file target installed alters no state and still has to win, because it is the
   * user saying what to scan while a read they no longer want is outstanding.
   */
  supersede(): void {
    this.requests += 1;
  }

  /** Runs the Choose file gesture: dialogue, read, install. */
  async choose(): Promise<TargetOutcome> {
    // Before the dialogue rather than after it: the gesture is made by asking for
    // the dialogue, so an earlier one is superseded even if this one is then
    // cancelled - the user has said they are choosing again, and the older answer is
    // not what they want either way.
    const request = this.claim();
    let path: string | null;
    try {
      path = await this.host.pick();
    } catch (err) {
      // A dialogue that could not be shown is reported the same way a file that
      // could not be read is, and dropped for the same reason when the user has
      // moved on: they are waiting on a newer gesture, not this one.
      if (!this.isCurrent(request)) return "stale";
      this.host.fail(err);
      return "failed";
    }
    // Currency before the answer's contents, so nothing about an overtaken gesture
    // is acted on. A cancelled dialogue is not a target either way, and it does not
    // hand the older gesture back its claim: `requests` has already moved on.
    if (!this.isCurrent(request)) return "stale";
    if (path === null) return "cancelled";
    let bytes: number[];
    try {
      bytes = await this.host.read(path);
    } catch (err) {
      if (!this.isCurrent(request)) return "stale";
      this.host.fail(err);
      return "failed";
    }
    if (!this.isCurrent(request)) return "stale";
    this.host.install(path, bytes);
    return "installed";
  }

  // Claims the target area for a new gesture. Synchronous, and called before
  // anything is shown or read, which is what makes the ordering the user's rather
  // than the disk's.
  private claim(): number {
    this.requests += 1;
    return this.requests;
  }

  // Whether this gesture may still touch the target area. A gesture's own number is
  // the newest from the moment it is claimed until the next gesture, so this never
  // rejects the gesture that is asking.
  private isCurrent(request: number): boolean {
    return this.requests === request;
  }
}
