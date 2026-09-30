// Deciding whether the response to a long-running operation is still wanted, and
// keeping the ruleset resets that go with it in order.
//
// A compile spans several awaits - saving documents, re-analysing, compiling - and
// the world can move underneath it while it runs. Three things make its answer
// obsolete, and none of them is detectable from the response itself:
//
//   * a newer operation started;
//   * the project changed (including re-opening the same folder, whose ruleset
//     was dropped on the way in);
//   * the rules' content changed, so what came back describes bytes the editor no
//     longer holds.
//
// The third is the one that is easy to get wrong. It has to be driven by *real*
// content changes and by app-controlled project mutations, and NOT by save
// bookkeeping - a compile auto-saves the dirty documents it is about to compile,
// and must not thereby invalidate itself.
//
// `revision` only ever increases, so there is no sequence of events that can make
// a superseded operation current again. That is what makes a manual save during a
// compile harmless: it cannot un-supersede the edit that preceded it.
//
// This is the frontend half of a pair. The backend enforces the same rule over
// the compiled ruleset with a generation (src-tauri/src/commands.rs): that stops
// stale rules becoming scannable, this stops a stale response claiming the UI.
// Neither substitutes for the other, and neither is replaced by disabling the
// actions that cause the trouble - the lifecycle has to be right whatever the
// user does while a compile is running.
//
// ---- The reset barrier ----
//
// Superseding an operation is not enough on its own, because dropping the
// backend's ruleset is an asynchronous IPC call and the user is not made to wait
// for it. Invalidation deliberately re-enables Compile at once, which allows this:
//
//   1. compile A is running;
//   2. an edit supersedes A and requests reset R;
//   3. the user compiles again straight away - B;
//   4. B installs rules under a NEWER backend generation;
//   5. R finally executes and drops them;
//   6. B reports failure, though it was the valid retry.
//
// So resets are not merely fired off: every one is appended to a chain, and a
// compile must `settle()` that chain before it invokes the backend compiler. Once
// a compile has crossed the barrier, every reset that existed before it has
// already executed, and the only resets left to run are newer ones - which are
// meant to supersede it. The two rules that make that airtight are that resets
// chain rather than replace one another (so a second request cannot hide a first),
// and that `resetFor` refuses to queue a reset for an operation that is already
// obsolete (so a failing compile cannot clean up after its successor).
//
// A reset that fails is not treated as done. `settle()` rethrows it, so the compile
// behind it does not run at all, rather than compiling while rules that should
// have been dropped are still installed.
//
// Kept apart from main.ts, with no DOM and no IPC - the ruleset reset is injected -
// so the ordering can be tested on its own (see operations.test.mjs).

export interface Operation {
  serial: number;
  // The project the operation was started for, or null for the scratch buffer.
  project: string | null;
  // The content revision at the moment it started.
  revision: number;
}

export type OperationTraceEvent =
  | { event: "operation_begin"; serial: number; revision: number; hasProject: boolean }
  | { event: "operation_invalidate"; serial: number; previousRevision: number; revision: number }
  | { event: "reset_queued"; reset: number; serial: number; revision: number }
  | { event: "reset_started"; reset: number }
  | { event: "reset_completed"; reset: number }
  | { event: "reset_failed"; reset: number };

export interface OperationCurrency {
  serial: number;
  revision: number;
}

export class Operations {
  private serial = 0;
  private revision = 0;
  // Tail of the reset chain: resolves once every reset requested so far has
  // settled. It never rejects - one failed reset must not stop the next from
  // running - so a failure is remembered in `resetFailure` instead.
  private resets: Promise<void> = Promise.resolve();
  // The failure of the most recent reset, or null if it succeeded. A later reset
  // that succeeds clears it: whatever went wrong before, the ruleset is gone now.
  private resetFailure: unknown = null;
  private resetSerial = 0;
  // Drops the backend's compiled ruleset and advances its generation. Injected, so
  // this module needs neither IPC nor a running backend to be tested. Written out
  // rather than declared as a constructor parameter property because Node's
  // type-stripping test runner does not support those.
  private readonly reset: () => Promise<void>;
  private readonly observe: (event: OperationTraceEvent) => void;

  constructor(reset: () => Promise<void>, observe: (event: OperationTraceEvent) => void = () => {}) {
    this.reset = reset;
    this.observe = observe;
  }

  // Starts an operation against `project`, superseding any still running.
  //
  // The serial is what supersedes an operation on the *same* project - re-opening
  // the folder that is already open, say - which the project comparison alone
  // cannot see.
  begin(project: string | null): Operation {
    this.serial += 1;
    const operation = { serial: this.serial, project, revision: this.revision };
    this.emit({
      event: "operation_begin",
      serial: operation.serial,
      revision: operation.revision,
      hasProject: project !== null,
    });
    return operation;
  }

  // Records that the compiled - or compiling - rules no longer describe the
  // project: an edit, a new file, a rename. Supersedes every operation that
  // started before now, and cannot be undone.
  invalidate(): void {
    const previousRevision = this.revision;
    this.revision += 1;
    this.emit({
      event: "operation_invalidate",
      serial: this.serial,
      previousRevision,
      revision: this.revision,
    });
  }

  currency(): OperationCurrency {
    return { serial: this.serial, revision: this.revision };
  }

  // True while `op` is still the operation whose response the UI wants.
  //
  // `project` is passed in rather than held here because main.ts owns the open
  // project for everything else it does; one source of truth beats two that have
  // to be kept in step.
  isCurrent(op: Operation, project: string | null): boolean {
    return op.serial === this.serial && op.revision === this.revision && op.project === project;
  }

  // Queues a reset of the backend's ruleset behind every reset already queued.
  //
  // Chained, not replaced: two invalidations in quick succession are two resets,
  // and `settle()` waits for both. Overwriting a pending reset with a newer one
  // would let the older one execute after a compile had crossed the barrier.
  //
  // The returned promise rejects if this reset fails, for a caller with somewhere
  // useful to report it. A caller without one - a keystroke - may ignore it: the
  // barrier remembers the failure regardless, and the next compile refuses to run.
  requestReset(): Promise<void> {
    this.resetSerial += 1;
    const reset = this.resetSerial;
    this.emit({
      event: "reset_queued",
      reset,
      serial: this.serial,
      revision: this.revision,
    });
    // `this.resets` never rejects, so this link always runs.
    const settled = this.resets.then(() => this.runReset(reset));
    this.resets = settled.then(
      () => {},
      () => {},
    );
    return settled;
  }

  // Queues a reset on behalf of `op`, and only while `op` still owns the ruleset.
  // Returns null when it does not, meaning: leave the ruleset alone, someone newer
  // is responsible for it now.
  //
  // The check and the queueing are one synchronous step on purpose. Nothing can
  // start a newer operation between them, so a compile that has crossed the
  // barrier can never find an older operation's cleanup queued behind it.
  resetFor(op: Operation, project: string | null): Promise<void> | null {
    if (!this.isCurrent(op, project)) return null;
    return this.requestReset();
  }

  // Waits for every reset requested before this call, and throws if the most
  // recent one failed.
  //
  // Call it immediately before invoking the backend compiler, and re-check
  // `isCurrent` immediately after: the wait is an await like any other, and
  // whatever superseded the operation during it means the compiler should not be
  // called at all.
  async settle(): Promise<void> {
    await this.resets;
    if (this.resetFailure !== null) throw this.resetFailure;
  }

  private async runReset(reset: number): Promise<void> {
    this.emit({ event: "reset_started", reset });
    try {
      await this.reset();
      this.resetFailure = null;
      this.emit({ event: "reset_completed", reset });
    } catch (err) {
      // Non-null even if the rejection value was, so `settle()` cannot mistake a
      // failed reset for a completed one.
      this.resetFailure = err ?? new Error("reset_rules failed");
      this.emit({ event: "reset_failed", reset });
      throw err;
    }
  }

  private emit(event: OperationTraceEvent): void {
    try {
      this.observe(event);
    } catch {
      // Troubleshooting is never correctness authority.
    }
  }
}
