// Taking the editor somewhere, scoped to the project that asked for it.
//
// Every navigating gesture - a row in Files or Includes, a diagnostic in the
// Problems pane, a match in the results, the automatic open of a project's first
// source - may have to read a file before it can show anything, and a read is an
// await the user can outlive. By the time the bytes arrive the folder may have been
// switched or closed, or a refresh may have replaced the snapshot the gesture came
// from. Opening the document then is not a late success, it is another project's
// file appearing in the editor; revealing a position afterwards is worse, because
// the position belongs to a document that is no longer the active one.
//
// So a navigation captures its context before it starts - which selection, which
// accepted analysis, and which gesture - re-checks it after every await, and reports
// what happened. The reveal is handed to the navigation rather than performed by the
// caller afterwards, because "afterwards" is exactly where that bug lives. A failure
// belonging to an abandoned navigation is dropped rather than shown: the Problems
// pane belongs to the project that is open.
//
// The gesture is what orders navigations against each other, and it is counted when
// the gesture is made rather than when its read lands. Two clicks in quick succession
// are two reads of two different files, and nothing makes them come back in the order
// they were asked for: the older one landing second would otherwise leave the editor
// on the file the user asked for first, purely because that file was slower to read.
// Whichever gesture was made last owns the editor from the moment it was made, so an
// older navigation - and an automatic open the user has overtaken - is superseded
// while its read is still outstanding, not once it has finished.
//
// No Monaco, no IPC and no DOM - the editor, the reads and the failure reporting
// are the host's, and the session's types are parameters - so the ordering can be
// tested on its own (see navigation.test.mjs).

/** What a navigation did. Anything but `shown` left the editor untouched. */
export type NavOutcome =
  // The document is open and active, and any location within it was revealed.
  | "shown"
  // The context it was asked for is gone, or the user has since taken the editor
  // somewhere themselves. Nothing was opened, activated, revealed or reported.
  | "stale"
  // The document could not be read, and the failure was reported.
  | "failed"
  // No candidate contained what was being looked for (match navigation only).
  | "not-found";

/** What navigation needs of the app. One line each where it is constructed. */
export interface NavHost<S, A> {
  /** The selection to scope this navigation to, or null when no project is open. */
  selection(): S | null;
  /** Whether `selection` is still the one on screen; null means "still none". */
  isSelected(selection: S | null): boolean;
  /** The accepted snapshot. Compared by identity: a refresh brings a new object. */
  analysis(): A | null;
  isOpen(path: string): boolean;
  activeKey(): string | null;
  /** An open document's text, which is the editor's and may differ from the disk. */
  textOf(path: string): string;
  read(path: string): Promise<string>;
  open(path: string, text: string): void;
  activate(path: string): void;
  /** Where a failure goes. Only ever called for a context that is still current. */
  fail(err: unknown): void;
  /** Synchronously retires any automatic courtesy before an explicit gesture awaits. */
  explicitNavigationStarted?(): void;
}

// The context a navigation must still be in when it finishes.
interface NavScope<S, A> {
  selection: S | null;
  analysis: A | null;
  // The activation count when it began; see `activated`.
  activations: number;
  // The gesture this navigation is; see `requests`.
  request: number;
}

export class Navigation<S, A> {
  // Explicit navigating gestures, counted. Incremented the moment one begins, so
  // that a navigation is superseded by a newer one straight away rather than when
  // the newer one's read happens to land.
  private requests = 0;
  // Every activation of a document, whoever caused it. An automatic open compares
  // this against what it captured: if the editor has been taken somewhere in the
  // meantime, it does not take it back.
  private activations = 0;
  // Assigned rather than declared as a constructor parameter property: the .mjs
  // tests run this file through Node's type stripping, which rejects that syntax.
  private host: NavHost<S, A>;

  constructor(host: NavHost<S, A>) {
    this.host = host;
  }

  /** Call for every change of active document, from wherever it came. */
  activated(): void {
    this.activations += 1;
  }

  // Shows `path`, then reveals a location within it if `reveal` is given. The
  // explorer, the Problems pane and anything else that navigates to a document go
  // through here, so ownership is decided in one place rather than per gesture.
  async goTo(path: string, reveal: (() => void) | null): Promise<NavOutcome> {
    const scope = this.begin();
    try {
      const outcome = await this.reach(scope, path, false);
      if (outcome !== "shown") return outcome;
      // Guaranteed to be the active document: reach() activated it and nothing has
      // been awaited since.
      if (reveal !== null) reveal();
      return "shown";
    } catch (err) {
      return this.report(scope, err, false);
    }
  }

  // Shows the first candidate whose text `find` locates a line in, and reveals it.
  //
  // Match navigation works this way because a matched rule's source location is not
  // in the results: the project's sources are searched for the rule instead. An
  // unreadable candidate is skipped rather than reported, since the rule may well be
  // in the next one - but a read that lands out of context ends the search, because
  // the candidates were the sources of a project that is no longer open.
  async goToRule(
    candidates: string[],
    find: (text: string) => number | null,
    reveal: (line: number) => void,
  ): Promise<NavOutcome> {
    const scope = this.begin();
    for (const path of candidates) {
      let text: string | null;
      if (this.host.isOpen(path)) {
        // The editor's text rather than the disk's: an unsaved edit is what the user
        // is looking at, and what the line the reveal is given has to agree with.
        text = this.host.textOf(path);
      } else if (path === "") {
        // The scratch buffer is the only document without a path, and there is
        // nothing to read when it is not open.
        continue;
      } else {
        text = await this.readOrNull(path);
        if (!this.live(scope, false)) return "stale";
        if (text === null) continue;
      }
      const line = find(text);
      if (line === null) continue;
      // The text goes with it: the candidate has already been read, and reading it
      // again could open the document at bytes the line no longer describes.
      const outcome = await this.reach(scope, path, false, text);
      if (outcome !== "shown") return outcome;
      reveal(line);
      return "shown";
    }
    return "not-found";
  }

  // The automatic open of the first source of a project that has just been
  // analysed, so that a folder the user opens shows its own rules rather than the
  // demo buffer.
  //
  // Scoped to that analysis and not merely to the folder: a refresh whose snapshot
  // has replaced it has already said what the project is, and this open belongs to
  // the answer before it. And it is a courtesy, so it is withdrawn the moment the
  // user makes a choice of their own - if anything has activated a document while
  // the read was pending, the editor is where they put it, and taking it back is
  // the bug this guard exists for.
  async autoOpen(
    selection: S | null,
    analysis: A | null,
    path: string,
    shown: () => void = () => {},
  ): Promise<NavOutcome> {
    // No gesture of its own: it takes the one that is current, so the next explicit
    // navigation supersedes it. Nothing the user does can be older than this.
    const scope = {
      selection,
      analysis,
      activations: this.activations,
      request: this.requests,
    };
    try {
      return await this.reach(scope, path, true, null, shown);
    } catch (err) {
      // Discovery found the file and the analysis said its bytes could be read, so
      // a failure here is real - but still only this project's to report.
      return this.report(scope, err, true);
    }
  }

  // Claims the editor for a new gesture. Synchronous, and called before anything is
  // read, which is what makes the ordering the user's rather than the disk's.
  private begin(): NavScope<S, A> {
    this.host.explicitNavigationStarted?.();
    this.requests += 1;
    return {
      selection: this.host.selection(),
      analysis: this.host.analysis(),
      activations: this.activations,
      request: this.requests,
    };
  }

  // Opens `path` if it is not open already and makes it the active document,
  // reporting whether it is now showing. `automatic` additionally requires that
  // nothing has activated a document since the scope began. `known` is the text when
  // the caller has already read it, so no document is ever read twice.
  private async reach(
    scope: NavScope<S, A>,
    path: string,
    automatic: boolean,
    known: string | null = null,
    shown: () => void = () => {},
  ): Promise<NavOutcome> {
    if (!this.live(scope, automatic)) return "stale";
    if (this.host.isOpen(path)) {
      if (this.host.activeKey() !== path) this.host.activate(path);
      shown();
      return "shown";
    }
    const text = known ?? (await this.host.read(path));
    if (!this.live(scope, automatic)) return "stale";
    this.host.open(path, text);
    // This is the presentation linearization point. It is deliberately inside
    // the same synchronous turn as the editor/LSP open, before another analysis
    // continuation can supersede a merely pending attempt.
    shown();
    return "shown";
  }

  // Whether this navigation may still touch the editor. Everything checked here is
  // checked before opening or activating anything and again after every await; the
  // reveal that follows a successful `reach` is synchronous, so it needs no check of
  // its own.
  private live(scope: NavScope<S, A>, automatic: boolean): boolean {
    if (!this.owns(scope)) return false;
    // A newer gesture has claimed the editor. Its read may well still be outstanding
    // - that is the point: what the user asked for last wins whatever order the disk
    // answers in. A navigation's own request is the newest one from the moment it
    // begins until the next gesture, so this never rejects the navigation that is
    // asking, and its own open cannot invalidate it either.
    if (this.requests !== scope.request) return false;
    // Only an automatic open is withdrawn by a change of active document, and it is
    // withdrawn by any of them - including one from outside navigation altogether,
    // which is the case the request count cannot see. An explicit navigation is the
    // user's instruction and is not called off by the editor moving.
    return !automatic || this.activations === scope.activations;
  }

  // The selection is still the one on screen and the snapshot is still the accepted
  // one. Both matter: the folder decides whether the document belongs to the
  // project at all, and the snapshot decides whether the offsets and the candidate
  // list the gesture was built from still describe it.
  private owns(scope: NavScope<S, A>): boolean {
    return this.host.isSelected(scope.selection) && this.host.analysis() === scope.analysis;
  }

  private async readOrNull(path: string): Promise<string | null> {
    try {
      return await this.host.read(path);
    } catch {
      return null;
    }
  }

  // A failure is only worth showing to the navigation that is still current, by the
  // same test as a success: the Problems pane is shared, and a read that failed for a
  // gesture the user has already replaced would report on a file they are no longer
  // waiting for - and overwrite what the newer one has to say about the one they are.
  private report(scope: NavScope<S, A>, err: unknown, automatic: boolean): NavOutcome {
    if (!this.live(scope, automatic)) return "stale";
    this.host.fail(err);
    return "failed";
  }
}
