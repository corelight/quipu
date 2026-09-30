// Ordering the filesystem changes Quipu makes itself.
//
// Save, the compile's auto-save, New Rule and Rename Rule all change files the user
// is also looking at, and nothing about the window stops two of them being in flight
// at once: Save stays available while its write is pending, its accelerator can fire
// twice, a compile auto-saves whatever is dirty whenever it is pressed, and a rename
// is a separate gesture from either. Overlapping, they decide the disk between them
// by completion order - two writes to one path leave whichever finished last, and a
// save that overlaps a rename re-creates the path the rename has just emptied. No
// amount of bookkeeping afterwards can take a write back.
//
// So they take turns. A mutation claims its place the moment the user asks for it -
// synchronously, before anything is awaited - and touches the disk only once every
// mutation claimed before it has finished. What ends up on disk is then the result of
// the gestures in the order they were made, which is the only order the user can
// reason about.
//
// # One queue, not one per path
//
// Deliberately global rather than per path or per project. Which paths a mutation
// touches is not always known before it runs - the compile's auto-save discovers
// members as it writes, and a rename touches two paths at once - so a per-path queue
// would have to be claimed from inside the mutation, which is exactly where the
// ordering has already been lost. Mutations are short and few; serialising all of
// them costs a little latency and removes a class of races entirely.
//
// # Waiting is an await like any other
//
// What a mutation was asked to do can have stopped making sense by the time its turn
// comes: the document may have been closed, renamed onto another path, or saved by
// the mutation in front of it, and the project may not be open any more. None of that
// is knowable here. The queue's whole contract is that turns are handed out in the
// order they were claimed and that no turn is lost; re-checking what the mutation is
// about - the selection, the operation, the document's identity, its path, and what
// the user confirmed - belongs to the command itself, on the far side of the wait.
//
// No DOM, no IPC and no timers: see mutations.test.mjs.

/** One mutation's place in the queue. */
export interface MutationTurn {
  /** Resolves when every mutation that claimed a turn earlier has finished. */
  readonly ready: Promise<void>;
  /**
   * Gives up the turn, letting the next mutation start.
   *
   * Call it from a `finally`, so that a mutation which throws still releases the ones
   * behind it. Calling it more than once does nothing.
   */
  done(): void;
}

export class MutationQueue {
  // What the next claim will wait on: the turn of whoever claimed last, or an already
  // resolved promise when nothing is outstanding. It is only ever resolved - never
  // rejected - so a mutation that fails cannot break the chain for the ones behind
  // it, which would strand every later write for the lifetime of the window.
  private tail: Promise<void> = Promise.resolve();
  private held = 0;

  /**
   * Claims the next turn.
   *
   * Synchronous on purpose, and it must be called before the caller awaits anything:
   * the point of the queue is that the order is the order of the gestures, and every
   * await between a gesture and its write is a chance for two mutations to change
   * places.
   */
  claim(): MutationTurn {
    const ready = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held += 1;
    let given = false;
    return {
      ready,
      done: () => {
        if (given) return;
        given = true;
        this.held -= 1;
        release();
      },
    };
  }

  /** How many mutations hold a turn or are waiting for one. */
  outstanding(): number {
    return this.held;
  }
}
