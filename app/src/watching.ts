// Turning native filesystem events into project refreshes.
//
// An event is a hint and nothing more: it says something under the project may
// have changed, and the authoritative answer is still a full analysis by the
// backend. So nothing here inspects the paths an event carried, and there is no
// incremental graph to keep in step with the compiler - there is a debounce
// window, a promise that no analysis is ever lost, and a guarantee that no two
// automatic analyses run at once.
//
// # What has to be true
//
// * The instant a relevant change is reported, a compiled or compiling ruleset
//   no longer describes the disk. That cannot wait for the debounce window.
// * A burst - one editor writing five files, one `git checkout` rewriting fifty -
//   produces ONE analysis.
// * An event that arrives while an analysis is running is not lost, and does not
//   start a second concurrent one. Exactly one trailing analysis is requested,
//   however many events arrive.
// * Coverage that has just been armed is followed by one more analysis whenever the
//   backend says one is owed, because the analysis that derived it read those
//   locations before anything watched them. That is not an invalidation: nothing said
//   anything had changed.
// * Opening, re-opening or closing a project makes every event, setup result,
//   document read and analysis of the previous subscription inert. Not "unlikely
//   to matter": inert.
// * A watcher failure reported by a native instance that has already been replaced
//   changes nothing. Retiring an instance makes its callbacks inert but does not stop
//   its thread, so one that read an open gate can emit after its replacement is live;
//   believing it would leave "automatic refresh unavailable" on screen on top of the
//   proof that it is running, with nothing left to contradict it.
// * A failure from the instance an announcement is about is NOT answered by that
//   announcement. A native handler is installed before its arm returns, so an instance
//   can report trouble before the notice announcing it arrives: that notice is news
//   about the same watcher, not evidence that a newer one replaced it. Only coverage
//   strictly newer than the degradation, or re-opening the project, clears it.
// * Coverage notices are read the same way. An arm already known to have been replaced
//   can neither report new degradation nor clear what is on screen: its news is about
//   coverage that is not the coverage being delivered, in both directions.
// * The one thing that is never dropped for being out of order is the catch-up an arm
//   says it owes. A debt is settled only by a debt honoured for a NEWER arm, whose
//   analysis reads the disk after this arm's coverage went in. An analysis nobody needed
//   costs one redundant read; a debt discarded is a project that never refreshes again.
//
// # Why a counted subscription
//
// The project a watcher belongs to cannot be recovered by comparing paths.
// Re-opening the folder that is already open is a new statement about what is on
// screen - its documents are closed and re-read - so its watcher is a new
// subscription too, and the old one's callbacks must stop counting from the moment
// the user asked, not from whenever the backend gets around to releasing it.
//
// No DOM, no IPC and no timers of its own: the operations and the timer are
// injected, so the ordering rules above are tested by driving them by hand rather
// than by sleeping. See watching.test.mjs.

/** The scheduling this needs. `window.setTimeout`/`clearTimeout` satisfy it. */
export interface WatchTimer {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

/** Everything the coordinator drives, and nothing it can do for itself. */
export interface WatchOps {
  /** Begins watching `root` for `subscription`. May reject: that is degradation. */
  start(subscription: number, root: string): Promise<void>;
  /** Stops watching for `subscription`. Fire-and-forget; ordering is the backend's. */
  release(subscription: number): void;
  /**
   * A relevant change has been reported. Whatever is compiled or compiling no
   * longer describes the disk, and the snapshot on screen may be out of date.
   * Called synchronously on every event, ahead of any debouncing.
   */
  invalidate(): void;
  /**
   * Reconciles the open documents against the disk and re-reads the project.
   * Reports its own failures; a rejection here is bookkeeping only.
   */
  refresh(subscription: number): Promise<void>;
  /** The coordinator's visible state changed: it is responding, or it degraded. */
  render(): void;
}

/**
 * How long to wait for a burst to finish, in milliseconds.
 *
 * Measured from the FIRST event of the burst rather than the last. A window that
 * restarted on every event would be postponed indefinitely by a program writing
 * into the project continuously, which is precisely when the views are most wrong.
 */
export const DEBOUNCE_MS = 150;

export class AutoRefresh {
  private ops: WatchOps;
  private timer: WatchTimer;
  private window: number;
  // Counts subscriptions. Only ever incremented here: the backend records the
  // serial it is given and never invents one, so the two halves cannot drift.
  private serial = 0;
  // The subscription that speaks for what is on screen; 0 when no project is open.
  private current = 0;
  // The debounce timer's handle, or null when no burst is being waited out.
  private pending: number | null = null;
  // The subscription of the analysis in flight, 0 when none. The subscription
  // rather than a boolean: an analysis of the project the user has just left
  // completes eventually, and must not clear the flag belonging to the new one.
  private running = 0;
  // Whether an event arrived while that analysis was running, so one more is owed.
  private trailing = false;
  // Whether what is scheduled or running was asked for by a REPORTED change, as
  // opposed to coverage catching up on ground it read before it watched it. Only
  // the status line cares, and it must not tell the user something changed when
  // nothing said anything had.
  private reported = false;
  // The newest native instance anything has named - an announcement, or a failure from
  // an instance whose announcement has not arrived yet - and so a lower bound on the
  // newest one armed. What orders an error out that came from coverage already
  // replaced. Never reset and never lowered: the backend counts instances for the life
  // of the process, across projects, and never reuses one - so a mark carried over
  // from the previous project can only be smaller than anything armed for this one.
  private instance = 0;
  private degraded: string | null = null;
  // Which instance the degradation on screen is about, or null when there is none. What
  // decides whether an announcement answers it: an instance's own notice is news about
  // the watcher that failed, so only coverage from a strictly newer arm may clear it.
  //
  // "unknown" is a fourth possibility and not a number, because a failure nothing could
  // attribute cannot be compared with anything: see `failed`. It is sticky for the life of
  // the subscription - a later notice may replace what the window SAYS, but nothing can
  // make the identity known afterwards, so clearing still needs the project re-opened.
  private degradedBy: number | "unknown" | null = null;
  // The newest arm a catch-up has been honoured for, or 0 when none has. Only ever
  // raised, and not reset with the project for the same reason `instance` is not: the
  // backend counts instances for the life of the process and never reuses one. This is
  // the only thing that may drop a debt, because an analysis asked for by a newer arm
  // reads the disk after that arm's coverage was installed and so covers the same ground
  // an older arm's debt describes.
  private caughtUpFor = 0;

  constructor(ops: WatchOps, timer: WatchTimer, window = DEBOUNCE_MS) {
    this.ops = ops;
    this.timer = timer;
    this.window = window;
  }

  /**
   * Claims a new subscription and starts watching `root`.
   *
   * `armed` never rejects. Await it to order the project's first analysis after
   * the watch is installed - a change made during that analysis then schedules a
   * trailing one instead of being lost - and carry on opening the project either
   * way: a watcher that could not be installed is degraded operation, recorded
   * here, not a folder that failed to open.
   */
  subscribe(root: string): { subscription: number; armed: Promise<void> } {
    this.stop();
    this.serial += 1;
    this.current = this.serial;
    // Re-opening a project is the recovery that needs no newer instance to prove it:
    // whatever was degraded was about a watcher of the project being replaced. For a
    // failure nothing could place - see `failed` - it is the ONLY recovery, since every
    // other one is an announcement, and announcements are compared with an identity.
    this.degraded = null;
    this.degradedBy = null;
    const subscription = this.current;
    const armed = this.ops
      .start(subscription, root)
      .catch((err: unknown) => this.failed(subscription, String(err)));
    return { subscription, armed };
  }

  /**
   * Gives up the current subscription.
   *
   * Synchronous, and belongs in the infallible half of leaving a project: from the
   * moment it returns, every event, setup result, document read and analysis of
   * that subscription changes nothing, whenever it arrives.
   */
  cancel() {
    this.stop();
    this.current = 0;
    this.degraded = null;
    this.degradedBy = null;
  }

  /** The live subscription, or 0 when no project is being watched. */
  subscription(): number {
    return this.current;
  }

  /** Whether `subscription` still speaks for what is on screen. */
  isCurrent(subscription: number): boolean {
    return subscription !== 0 && subscription === this.current;
  }

  /**
   * A relevant change was reported for `subscription`.
   *
   * The paths are deliberately not a parameter: they are diagnostics, and what
   * happens next is the same for all of them.
   */
  changed(subscription: number) {
    if (!this.isCurrent(subscription)) return;
    // Immediately, on every event, ahead of the window: from this moment the
    // ruleset does not describe the disk and Scan must not be offered against it.
    // Repeating it is cheap - the second event of a burst finds nothing left to
    // invalidate - and repeating it is what stops a compile that succeeded DURING
    // the burst from outliving it.
    this.ops.invalidate();
    this.schedule(subscription, true);
  }

  /**
   * Coverage the last analysis derived is now armed IN FULL, for `subscription`.
   *
   * That is proof that watching this project works: the backend announces coverage
   * only when it has installed the plan it derived in full, and says `partial`
   * otherwise. So a degradation recorded before it - a watcher that could not be
   * started, a re-arm that failed and left the next analysis to install one, a
   * location the last handoff could not take - has been overtaken by events and must
   * stop being shown, or the window would say automatic refresh is unavailable while
   * it is demonstrably running. Deliberately only this notice: a reported change
   * proves that SOMETHING is delivering, which a plan that armed one location out of
   * three also does.
   *
   * Overtaken means by a STRICTLY newer arm. A native handler is installed before its
   * arm returns, so instance N can report trouble before N's own announcement arrives,
   * and that announcement is news about the very watcher that reported it - the coverage
   * it names is the coverage that failed, so it proves nothing about it. Only a
   * degradation older than this arm is cleared here; anything else waits for the next
   * arm, or for the project to be re-opened.
   *
   * `catchUp` is the separate question of whether an analysis is owed, and it is the
   * backend's to answer for the same reason it answers it for `partial`. Usually yes:
   * an analysis reads the disk and its plan is armed afterwards, so a change in
   * between belongs to no event and to no snapshot, and one more analysis settles it -
   * terminating, because the plan that analysis derives is the one already armed. But a
   * plan can also be completed by an instance taking over coverage that something else
   * was already delivering for this project, and then nothing was read unwatched:
   * complete coverage still clears the degradation, and asking for an analysis would
   * only ask for one after every such recovery.
   *
   * Deliberately NOT an invalidation either way. Nothing here says anything changed -
   * only that something may have been read before it was watched - and invalidating a
   * compiled ruleset on it would make Quipu's own save cost the user their compile.
   *
   * `instance` is the native instance now delivering, and it is also read the way a
   * failure's is: an arm already known to have been replaced proves nothing about the
   * coverage that IS being delivered, so its notice clears nothing - not even a
   * degradation that names no instance at all, which any live arm would answer. That is
   * the case a watcher that could not be re-armed leaves behind: nothing is watching,
   * and coverage announced by an instance from before the attempt is news from before it.
   * Where the failed attempt's own identity is UNKNOWN, no announcement clears it at all,
   * because which of them are from before it is precisely what cannot be worked out.
   * The backend announces EVERY arm - including one that completed the plan and owes
   * nothing, and the one it makes when a fence ends - so that this mark cannot fall
   * behind.
   */
  covered(subscription: number, catchUp: boolean, instance = 0) {
    if (!this.isCurrent(subscription)) return;
    // Before the mark moves, or this notice would be measured against itself.
    const stale = this.replaced(instance);
    this.observe(instance);
    const cleared = !stale && this.degraded !== null && this.supersedes(instance);
    if (cleared) {
      this.degraded = null;
      this.degradedBy = null;
    }
    // Whatever was decided about the message: see `settleDebt`.
    this.settleDebt(subscription, catchUp, instance);
    // schedule() renders only when it opens a window, and this changed what the
    // status line says whether it did or not.
    if (cleared) this.ops.render();
  }

  /**
   * Part of the coverage the last analysis derived is armed, and part of it could
   * not be, for `subscription`.
   *
   * Both halves are true at once, so both are recorded. `message` is degradation:
   * something the project depends on is watched by nobody, automatic refresh will
   * not answer for it, and the window must say so rather than implying the watch is
   * whole. This deliberately never CLEARS a degradation - unlike `covered`, it is
   * not proof that watching works, it is proof that it half works.
   *
   * `catchUp` is the backend's own answer about whether an analysis is owed, and it
   * is the same debt `covered` describes: ground read before it was watched, settled
   * by one more analysis. Deliberately not inferred from `message` or from the paths
   * the notice named - coverage can grow without naming a new path, a wider relevance
   * filter inside a directory already watched being exactly that. It terminates
   * because that analysis derives the same plan, and installing the same coverage
   * under the same plan owes nothing. A location that can never be watched therefore
   * degrades the watch permanently and analyses nothing repeatedly.
   *
   * `instance` is the arm that installed the part that armed, recorded exactly as
   * `covered` records it: a partial arm is still an arm, and still supersedes what it
   * replaced. It is also what this degradation is about, so the next arm's coverage is
   * what clears it - this arm has already said all it has to say.
   *
   * And it is what orders this notice out when it names an arm already replaced. Such a
   * notice describes coverage that no longer exists, so recording its message would put
   * "automatic refresh is degraded" back on screen over the newer arm's proof that it is
   * not - the mirror image of the stale failure above, and the reason the message and the
   * debt are decided separately here.
   */
  partial(subscription: number, message: string, catchUp: boolean, instance = 0) {
    if (!this.isCurrent(subscription)) return;
    // Before the mark moves, as in `covered`.
    const stale = this.replaced(instance);
    this.observe(instance);
    if (!stale) {
      this.degraded = message;
      this.degradedBy = this.attribute(instance);
    }
    // Even when the message was dropped: what this arm read before it watched it was
    // still read, and only a newer arm's catch-up answers for it.
    this.settleDebt(subscription, catchUp, instance);
    // schedule() renders only when it opens a window, and what the status line says has
    // changed whether it did or not.
    if (!stale) this.ops.render();
  }

  // Schedules the analysis a notice says is owed, unless one has already been honoured
  // for a newer arm - the single case where a debt may be dropped, because that arm's
  // analysis reads the disk after this arm's coverage was installed and settles the same
  // ground. Notably not dropped for a notice that was otherwise ordered out: its message
  // is about coverage that has been replaced, but the ground it read unwatched was read
  // all the same. Instance 0 names no arm, so nothing can subsume its debt.
  private settleDebt(subscription: number, catchUp: boolean, instance: number) {
    if (!catchUp) return;
    if (instance !== 0 && instance < this.caughtUpFor) return;
    if (instance > this.caughtUpFor) this.caughtUpFor = instance;
    this.schedule(subscription, false);
  }

  private schedule(subscription: number, reported: boolean) {
    if (reported) this.reported = true;
    // Already waiting out a burst: this event is one of the same burst, and the
    // analysis that window is going to start will read the disk as it is by then.
    if (this.pending !== null) return;
    if (this.running !== 0) {
      // An analysis is already reading the disk and cannot be told about this. One
      // more is owed, and exactly one however many events arrive.
      this.trailing = true;
      return;
    }
    this.pending = this.timer.set(() => this.fire(subscription), this.window);
    this.ops.render();
  }

  /**
   * The watcher itself failed for `subscription`.
   *
   * Automatic refresh is gone; the project is not. The snapshot on screen stays
   * usable and manual Refresh still works, which is why this is recorded as
   * degradation rather than reported as a project failure - it must never replace
   * the project's own diagnostics with watcher infrastructure trouble.
   *
   * It lasts until the project is re-opened, or until coverage from a STRICTLY newer arm
   * is announced - the one signal that proves a replacement watcher is live. The arm
   * this failure came from announcing itself is not that signal: it is the same watcher.
   * See `covered`.
   *
   * `instance` names the native instance the failure came from, and this is where the
   * ordering over instances is spent, in both directions. Retiring an instance makes its
   * callbacks inert but does not stop its thread: one that read an open gate before a
   * handoff can emit after the replacement announced itself, and recording that would
   * put a permanent degradation on top of the proof that watching works - so news about
   * an instance older than the newest one heard of is dropped. A failure from an instance
   * NEWER than that raises the mark, because it is news that this instance exists: an
   * even older instance's error arriving next is stale, and the announcement that
   * follows will be about this instance rather than a replacement of it.
   *
   * A failed `watch_rearm` names the identity its attempt RESERVED, which is not an
   * instance that is delivering anything - nothing armed under it and nothing ever will.
   * It is what places a rejection that came back on the call instead of on the notice
   * channel: newer than the announcement of the coverage the fence retired, which may
   * still be in flight there, and older than the next arm, whose announcement is the
   * recovery. An arming step that PANICKED took its identity before it tried, exactly as
   * one that refused did, and names that same identity: it must, because a watcher
   * installed just before the panic would emit under it. See `armFailure` in ipc.ts.
   *
   * 0 is not an instance at all, and only for a call whose reservation is settled: an arm
   * that failed before it took an identity, or a `watch_project` that failed outright,
   * whose subscription can have no older notice of its own in flight for anything it might
   * have reserved to be compared with. Such a failure is always recorded, and superseded by
   * any arm at all.
   *
   * `null` is a different statement again, and the reason 0 cannot be reused for it: the
   * backend does not KNOW what this attempt reserved, which is what a task that never came
   * back leaves behind. Unknown is not none. An identity may have been reserved and a
   * watcher installed under it, so an announcement already in flight - the coverage the
   * fence just retired among them - cannot be told from the arm that recovered, and neither
   * can any later one, since where the unknown identity fell is exactly what is missing.
   * Such a degradation is therefore recorded and kept: no announcement clears it, and
   * re-opening the project is the recovery, which needs nothing proved about instances.
   *
   * A rejected `watch_fence` is the same answer reached from the other side. It reserves no
   * identity, but it RETIRES one, and the coverage notice for the instance it retired may
   * be in flight - so 0 would hand that notice the power to clear this. Which instance that
   * is cannot be named from here either: the mark is a lower bound, and a fence can retire
   * an arm nothing has announced yet. Worse than the re-arm case if the fence did go up,
   * because the token went with the answer and no release will ever lift it.
   */
  failed(subscription: number, message: string, instance: number | null = 0) {
    if (!this.isCurrent(subscription)) return;
    if (instance === null) {
      // Nothing to order it against, so nothing to order it out either: it is recorded
      // whatever the mark stands at, and the mark does not move, because this is not news
      // that any particular instance exists.
      this.degraded = message;
      this.degradedBy = "unknown";
      this.ops.render();
      return;
    }
    if (this.replaced(instance)) return;
    this.observe(instance);
    this.degraded = message;
    this.degradedBy = this.attribute(instance);
    this.ops.render();
  }

  // Raises the mark to `instance`, and only ever raises it. Notices arrive in order on
  // one channel, a rejection that arrives off it carries the identity its attempt
  // reserved, and identities are handed out in order either way - so this is a floor
  // rather than a correction; what it must never do is fall back. Notably not for 0,
  // which named no instance: nothing has been superseded, and lowering the mark would let
  // an error from coverage that HAS been replaced count again.
  private observe(instance: number) {
    if (instance > this.instance) this.instance = instance;
  }

  // Whether `instance` is an arm already known to have been replaced, and so speaks for
  // coverage that is not the coverage being delivered - whatever it has to say. Asked by
  // every notice that names an instance, before the mark is raised. 0 names no instance at
  // all, so there is nothing it can be older than.
  private replaced(instance: number): boolean {
    return instance !== 0 && instance < this.instance;
  }

  // Whether coverage from `instance` is newer than the degradation on screen, and so
  // evidence that whatever was wrong has been replaced rather than merely announced.
  // Equal identities do not supersede each other: an instance's own announcement is news
  // about the watcher that failed. A degradation about no instance - an invoke that never
  // armed anything - is superseded by any arm. A degradation nothing could place is
  // superseded by nothing: an announcement can only be compared with an identity, and that
  // is the one thing missing, so "newer" cannot be established at all. See `failed`.
  private supersedes(instance: number): boolean {
    if (this.degradedBy === "unknown") return false;
    return this.degradedBy === null || instance > this.degradedBy;
  }

  // What a degradation being recorded now is about. An unplaceable failure outlives the
  // message it put on screen: a later notice may say something more specific about what is
  // wrong, but the identity the lost attempt may have armed under stays unknown, so the
  // degradation stays unanswerable by any announcement.
  private attribute(instance: number): number | "unknown" {
    return this.degradedBy === "unknown" ? "unknown" : instance;
  }

  /** Whether an automatic refresh is scheduled or running for the open project. */
  isResponding(): boolean {
    return this.pending !== null || this.running !== 0 || this.trailing;
  }

  /**
   * Whether that refresh is answering a reported change, rather than catching up on
   * newly armed coverage. What the status line may call "changes detected".
   */
  isRespondingToChange(): boolean {
    return this.isResponding() && this.reported;
  }

  /** Why automatic refresh is unavailable, or null while it is working. */
  degradation(): string | null {
    return this.degraded;
  }

  private fire(subscription: number) {
    this.pending = null;
    if (!this.isCurrent(subscription)) return;
    this.begin();
  }

  private begin() {
    const subscription = this.current;
    this.running = subscription;
    this.ops.render();
    void this.ops
      .refresh(subscription)
      // The host reports its own failures where the user can see them: a failed
      // automatic analysis leaves the previous snapshot on screen and marked
      // stale, exactly as a failed manual refresh does. Caught here only so the
      // bookkeeping below runs whatever happened.
      .catch((err: unknown) => console.error("watching: automatic refresh failed", err))
      .then(() => this.settle(subscription));
  }

  private settle(subscription: number) {
    // Only if this analysis is still the one being waited for. An analysis of a
    // project the user has left completes eventually, and clearing the flag then
    // would let a second analysis of the CURRENT project start beside its first.
    if (this.running === subscription) this.running = 0;
    if (!this.isCurrent(subscription)) return;
    if (this.trailing) {
      // No second window: the events that asked for this have already waited out
      // one, and the analysis they waited for read the disk before they arrived.
      this.trailing = false;
      this.begin();
      return;
    }
    // Nothing more is owed, so the change that started this has been answered.
    this.reported = false;
    this.ops.render();
  }

  // Withdraws everything scheduled, and releases the native watch. An analysis
  // already in flight cannot be recalled, but its result is scoped to the
  // subscription it was started for and is inert once that subscription is gone.
  private stop() {
    if (this.pending !== null) {
      this.timer.clear(this.pending);
      this.pending = null;
    }
    this.trailing = false;
    this.running = 0;
    this.reported = false;
    if (this.current !== 0) this.ops.release(this.current);
  }
}
