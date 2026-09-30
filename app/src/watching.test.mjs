// Tests for the automatic-refresh coordinator (watching.ts).
//
// Run with `npm test`. Nothing here sleeps. The debounce timer and every host
// operation are injected, so a burst, a window expiring, an analysis completing and
// a project switch are all things the test performs in an order it chooses - which
// is the only way to state what the ordering rules ARE rather than observe that they
// usually hold.
//
// The timer is a queue of callbacks with handles, so "the window expired" is
// `clock.run()`. The refresh operation is a deferred promise the test settles, so
// "an analysis is still running" is simply not having settled it yet.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AutoRefresh } from "./watching.ts";

// A timer whose callbacks fire when the test says so. Cleared handles are dropped,
// which is what makes "cancel() withdrew the pending window" observable.
function clock() {
  const timers = new Map();
  let next = 1;
  return {
    handle: {
      set(fn, ms) {
        const id = next++;
        timers.set(id, { fn, ms });
        return id;
      },
      clear(id) {
        timers.delete(id);
      },
    },
    pending: () => timers.size,
    // Fires every timer set so far, in the order they were set.
    run() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.fn();
    },
  };
}

// A promise the test settles by hand, standing in for one analysis.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Lets pending `.then` callbacks run. Awaiting a settled promise a few times is
// enough: the coordinator's continuations are all one or two microtasks deep, and
// this is not a delay - the loop never yields to a timer.
async function drained() {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

// The coordinator plus a record of everything it asked its host to do.
//
// `startFails` makes the setup call reject, which is what a watcher that could not
// be installed looks like. Each refresh hands back a deferred, so the test decides
// when each analysis finishes and in which order.
function harness({ startFails = false } = {}) {
  const timer = clock();
  const log = [];
  const refreshes = [];
  const ops = {
    start(subscription, root) {
      log.push(`start:${subscription}:${root}`);
      return startFails
        ? Promise.reject(new Error("inotify limit reached"))
        : Promise.resolve();
    },
    release(subscription) {
      log.push(`release:${subscription}`);
    },
    invalidate() {
      log.push("invalidate");
    },
    refresh(subscription) {
      log.push(`refresh:${subscription}`);
      const pending = deferred();
      refreshes.push({ subscription, ...pending });
      return pending.promise;
    },
    render() {
      log.push("render");
    },
  };
  const auto = new AutoRefresh(ops, timer.handle, 150);
  return {
    auto,
    timer,
    log,
    refreshes,
    // Just the calls worth asserting on. `render` is noise in an ordering test: it
    // is called whenever the visible state moves, which is most of these steps.
    calls: () => log.filter((entry) => entry !== "render"),
  };
}

test("a burst of events produces exactly one analysis", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  h.auto.changed(subscription);
  h.auto.changed(subscription);
  h.auto.changed(subscription);
  assert.equal(h.refreshes.length, 0, "nothing runs until the window closes");
  assert.equal(h.auto.isResponding(), true, "but the user is told it is coming");

  h.timer.run();
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.refreshes[0].subscription, subscription);

  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.refreshes.length, 1, "and no more");
  assert.equal(h.auto.isResponding(), false);
});

test("every event invalidates the compilation immediately, ahead of the window", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  h.auto.changed(subscription);
  assert.deepEqual(h.calls(), ["start:1:/p", "invalidate"], "before any timer fired");

  // Repeated on every event of the burst, deliberately: a compile that STARTED
  // during the burst has to be invalidated too, and it is only in flight after the
  // first event.
  h.auto.changed(subscription);
  assert.deepEqual(h.calls(), ["start:1:/p", "invalidate", "invalidate"]);
  assert.equal(h.refreshes.length, 0);
});

test("the debounce window is measured from the first event, not the last", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  h.auto.changed(subscription);
  assert.equal(h.timer.pending(), 1);
  // A program writing continuously into the project would postpone a window that
  // restarted on every event indefinitely - which is precisely when the views are
  // most wrong. So later events set no new timer.
  h.auto.changed(subscription);
  h.auto.changed(subscription);
  assert.equal(h.timer.pending(), 1);
});

test("an event during an analysis causes exactly one trailing analysis", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  h.auto.changed(subscription);
  h.timer.run();
  assert.equal(h.refreshes.length, 1);

  // Arrived while the analysis was reading the disk, so it cannot be part of that
  // read. Several of them are still one trailing analysis.
  h.auto.changed(subscription);
  h.auto.changed(subscription);
  assert.equal(h.refreshes.length, 1, "and no second concurrent analysis");

  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.refreshes.length, 2, "the trailing analysis started when the first ended");
  // No second window: the events that asked for this already waited one out.
  assert.equal(h.timer.pending(), 0);

  h.refreshes[1].resolve();
  await drained();
  assert.equal(h.refreshes.length, 2, "and the owed analysis is settled");
  assert.equal(h.auto.isResponding(), false);
});

test("repeated bursts never run two analyses at once", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  h.auto.changed(subscription);
  h.timer.run();
  for (let i = 0; i < 20; i += 1) h.auto.changed(subscription);
  assert.equal(h.refreshes.length, 1);

  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.refreshes.length, 2, "twenty events, one trailing analysis");
  h.refreshes[1].resolve();
  await drained();
  assert.equal(h.refreshes.length, 2);
});

test("an analysis that fails still settles the coordinator", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.changed(subscription);
  h.timer.run();

  // The host reports its own failures where the user can see them - the previous
  // snapshot stays on screen, marked stale - and the coordinator must not be left
  // believing an analysis is still running, or nothing would ever run again.
  h.refreshes[0].reject(new Error("analysis failed"));
  await drained();
  assert.equal(h.auto.isResponding(), false);

  h.auto.changed(subscription);
  h.timer.run();
  assert.equal(h.refreshes.length, 2, "a later change is still acted on");
  h.refreshes[1].resolve();
  await drained();
});

test("an owed trailing analysis still runs after a failed one", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.changed(subscription);
  h.timer.run();
  h.auto.changed(subscription);

  h.refreshes[0].reject(new Error("analysis failed"));
  await drained();
  // The events that arrived during it described a project that has changed since
  // the failed read. Losing them because the read failed would leave the views
  // stale with nothing scheduled to fix them.
  assert.equal(h.refreshes.length, 2);
  h.refreshes[1].resolve();
  await drained();
});

// ---- Coverage catching up on what it read before it watched it ----
//
// The backend derives its watch plan from an analysis, so the first read of a
// location always happens before anything is watching it. Installing the wider plan
// says so, and that statement is not an event: one more analysis is owed, and
// nothing that was compiled has stopped describing the disk.

test("newly armed coverage is analysed once, and invalidates nothing", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  h.auto.covered(subscription, true);
  // The absent "invalidate" is the whole point: a save's own analysis widens the
  // plan, and invalidating here would cost the user their compile for it.
  assert.deepEqual(h.calls(), ["start:1:/p"]);
  assert.equal(h.auto.isResponding(), true, "an analysis is owed");
  assert.equal(
    h.auto.isRespondingToChange(),
    false,
    "but nothing has said the project changed, so the status line must not either",
  );

  h.timer.run();
  assert.equal(h.refreshes.length, 1);
  h.refreshes[0].resolve();
  await drained();
  // And it terminates: the analysis derives the plan that is already armed, so the
  // backend announces nothing further. Nothing here is owed either.
  assert.equal(h.auto.isResponding(), false);
  assert.deepEqual(h.calls(), ["start:1:/p", "refresh:1"]);
});

test("a coverage notice joins a window a change is already waiting out", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  h.auto.changed(subscription);
  h.auto.covered(subscription, true);
  assert.equal(h.timer.pending(), 1, "one window, not two");
  // Still a change: what the user is told describes the strongest reason for the
  // analysis, and one of these two reasons is a report that the project moved.
  assert.equal(h.auto.isRespondingToChange(), true);
  h.timer.run();
  assert.equal(h.refreshes.length, 1);
});

test("a change during a coverage analysis is reported as a change", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  h.auto.covered(subscription, true);
  h.timer.run();
  assert.equal(h.auto.isRespondingToChange(), false);

  // A real event arrives while the catch-up is reading the disk. It owes a trailing
  // analysis, and it is a change: the ruleset is invalidated at once, and the status
  // line says what is happening.
  h.auto.changed(subscription);
  assert.deepEqual(h.calls(), ["start:1:/p", "refresh:1", "invalidate"]);
  assert.equal(h.auto.isRespondingToChange(), true);

  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.refreshes.length, 2, "the trailing analysis answers the change");
  assert.equal(h.auto.isRespondingToChange(), true, "and it is still that change's analysis");

  h.refreshes[1].resolve();
  await drained();
  // Nothing more is owed, so the change has been answered and the status line goes
  // back to describing a project nobody is changing.
  assert.equal(h.auto.isResponding(), false);
  assert.equal(h.auto.isRespondingToChange(), false);
});

test("coverage armed for a project the user has left is analysed for nobody", () => {
  const h = harness();
  const first = h.auto.subscribe("/p").subscription;
  const second = h.auto.subscribe("/q").subscription;

  h.auto.covered(first, true);
  assert.equal(h.timer.pending(), 0);
  h.timer.run();
  assert.equal(h.refreshes.length, 0);
  assert.equal(h.auto.isResponding(), false);

  // And switching away mid-response leaves nothing behind that would have the new
  // project's first analysis reported as somebody's change.
  h.auto.changed(second);
  h.auto.subscribe("/r");
  assert.equal(h.auto.isResponding(), false);
  assert.equal(h.auto.isRespondingToChange(), false);
});

test("events for a superseded subscription change nothing", async () => {
  const h = harness();
  const first = h.auto.subscribe("/p").subscription;
  const second = h.auto.subscribe("/q").subscription;
  assert.notEqual(first, second);
  assert.deepEqual(h.calls(), ["start:1:/p", "release:1", "start:2:/q"]);

  h.auto.changed(first);
  assert.equal(h.timer.pending(), 0, "no window");
  assert.deepEqual(h.calls(), ["start:1:/p", "release:1", "start:2:/q"], "and no invalidation");

  h.timer.run();
  assert.equal(h.refreshes.length, 0);
});

test("a watcher error from a project the user has left is not shown", () => {
  const h = harness();
  const first = h.auto.subscribe("/p").subscription;
  h.auto.subscribe("/q");

  h.auto.failed(first, "inotify limit reached");
  assert.equal(h.auto.degradation(), null, "the project on screen is watched perfectly well");
});

test("switching projects withdraws a pending window and releases the watch", () => {
  const h = harness();
  const first = h.auto.subscribe("/p").subscription;
  h.auto.changed(first);
  assert.equal(h.timer.pending(), 1);

  const second = h.auto.subscribe("/q").subscription;
  assert.equal(h.timer.pending(), 0, "the old project's window is gone, not merely ignored");
  assert.deepEqual(h.calls(), ["start:1:/p", "invalidate", "release:1", "start:2:/q"]);

  // And the new project starts from nothing owed.
  assert.equal(h.auto.isResponding(), false);
  h.auto.changed(second);
  h.timer.run();
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.refreshes[0].subscription, second);
});

test("an analysis of the project the user left cannot start one for the new project", async () => {
  const h = harness();
  const first = h.auto.subscribe("/p").subscription;
  h.auto.changed(first);
  h.timer.run();
  h.auto.changed(first); // one trailing analysis owed to /p

  const second = h.auto.subscribe("/q").subscription;
  // The abandoned analysis cannot be recalled, so it completes eventually. It must
  // neither start /p's owed trailing analysis nor be mistaken for /q's.
  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.auto.isResponding(), false);

  // And /q's own events are unaffected by any of it.
  h.auto.changed(second);
  h.timer.run();
  assert.equal(h.refreshes.length, 2);
  assert.equal(h.refreshes[1].subscription, second);
});

test("an old analysis completing does not free a slot the new project is using", async () => {
  const h = harness();
  const first = h.auto.subscribe("/p").subscription;
  h.auto.changed(first);
  h.timer.run();

  const second = h.auto.subscribe("/q").subscription;
  h.auto.changed(second);
  h.timer.run();
  assert.equal(h.refreshes.length, 2);

  // /p's analysis lands while /q's is still running. A boolean "an analysis is
  // running" flag would be cleared here, and the next event for /q would start a
  // second concurrent analysis of it.
  h.refreshes[0].resolve();
  await drained();
  h.auto.changed(second);
  assert.equal(h.timer.pending(), 0, "no window: it is owed a trailing analysis instead");
  assert.equal(h.refreshes.length, 2, "and nothing runs beside /q's analysis");

  h.refreshes[1].resolve();
  await drained();
  assert.equal(h.refreshes.length, 3);
  assert.equal(h.refreshes[2].subscription, second);
});

test("closing the workspace makes everything owed inert", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.changed(subscription);
  h.timer.run();
  h.auto.changed(subscription);

  h.auto.cancel();
  assert.equal(h.auto.subscription(), 0);
  assert.equal(h.auto.isCurrent(subscription), false);
  assert.deepEqual(h.calls(), ["start:1:/p", "invalidate", "refresh:1", "invalidate", "release:1"]);

  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.refreshes.length, 1, "the trailing analysis is not owed to anybody");
  assert.equal(h.auto.isResponding(), false);
  assert.equal(h.auto.degradation(), null);
});

test("a zero subscription is never current", () => {
  const h = harness();
  assert.equal(h.auto.subscription(), 0);
  assert.equal(h.auto.isCurrent(0), false);
  // Which is what makes analyzeProject(root, 0) safe to send: it is the compile's
  // membership query, and it must not widen or narrow what is being watched.
  h.auto.changed(0);
  assert.equal(h.timer.pending(), 0);
});

test("a watcher that could not be installed is degradation, not a failed open", async () => {
  const h = harness({ startFails: true });
  const { subscription, armed } = h.auto.subscribe("/p");

  // `armed` resolves either way: whoever is opening the project awaits it to order
  // the first analysis after the watch, and a folder must still open without one.
  await armed;
  assert.match(h.auto.degradation(), /inotify limit reached/);
  assert.equal(h.auto.isCurrent(subscription), true, "the project is open and current");
});

test("a watcher error is recorded and cleared by re-opening", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.failed(subscription, "watch dropped");
  assert.equal(h.auto.degradation(), "watch dropped");

  // Re-opening installs a fresh watcher, so the previous one's trouble says nothing
  // about it.
  h.auto.subscribe("/p");
  assert.equal(h.auto.degradation(), null);
});

test("a degraded watcher still acts on the events it does deliver", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  // Degradation is a report about coverage, not a switch that stops the machinery:
  // a plan that failed to widen still watches the root.
  h.auto.failed(subscription, "could not watch /p/vendor");
  h.auto.changed(subscription);
  h.timer.run();
  assert.equal(h.refreshes.length, 1);
  // And delivering an event does not withdraw the notice: that a change under the root
  // arrived says nothing about the location the plan could not reach, which is exactly
  // what the user is being told about.
  assert.equal(h.auto.degradation(), "could not watch /p/vendor");
});

// ---- Degradation that coverage has overtaken ----
//
// A start that failed and a re-arm that failed both leave the backend with nothing
// installed, so the next handoff has every location to arm and says so. That notice is
// the one signal that proves the coverage the project asked for is live, and the window
// must stop saying automatic refresh is unavailable while it demonstrably works.
//
// Whether the same notice also owes an analysis is a second question with a second
// answer. A plan completed by taking over coverage that was already being delivered for
// the project recovers from degradation without anything having been read unwatched, and
// the notice says so.

test("coverage announced after a failed start clears the degradation", async () => {
  const h = harness({ startFails: true });
  const { subscription, armed } = h.auto.subscribe("/p");
  await armed;
  assert.match(h.auto.degradation(), /inotify limit reached/);

  // The first arm there has been: what failed was the call, so nothing was armed and no
  // instance existed to name.
  h.auto.covered(subscription, true, 1);
  assert.equal(h.auto.degradation(), null);
  h.timer.run();
  assert.equal(h.refreshes.length, 1, "and the analysis it owes still runs");
  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.auto.degradation(), null);
});

test("coverage announced after a failed re-arm clears the degradation", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  // What ending a fence looks like when the replacement watcher could not be
  // installed: the write succeeded, automatic refresh is gone until something arms one,
  // and the failure names the identity the attempt reserved.
  h.auto.failed(subscription, "could not re-arm the watcher", 2);
  assert.match(h.auto.degradation(), /could not re-arm/);
  // A change is already waiting out a window, so the notice opens none of its own: the
  // redraw has to come from the notice itself, or the status line would go on saying
  // automatic refresh is unavailable until something else happened to redraw it.
  h.auto.changed(subscription);
  const renders = h.log.filter((entry) => entry === "render").length;

  h.auto.covered(subscription, true, 3);
  assert.equal(h.auto.degradation(), null, "and the next handoff is what arms one");
  assert.equal(h.log.filter((entry) => entry === "render").length, renders + 1);
});

test("complete coverage that owes no analysis still clears the degradation", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  // A location the last handoff could not take, still being delivered for this project
  // by the instance that handoff replaced. Retained coverage is not the coverage that
  // was asked for, so the window says automatic refresh is degraded.
  h.auto.partial(subscription, "/p/shared: no space left on device", false, 1);
  assert.equal(h.auto.isResponding(), false);
  const renders = h.log.filter((entry) => entry === "render").length;

  // The next handoff installs it - by taking it over from the very instance that was
  // delivering it, so nothing was read before something watched it. The coverage the
  // project asked for is nonetheless live, and that is what the degradation was about.
  h.auto.covered(subscription, false, 2);
  assert.equal(h.auto.degradation(), null);
  assert.equal(
    h.log.filter((entry) => entry === "render").length,
    renders + 1,
    "and the window is redrawn to stop saying otherwise",
  );
  // Nothing is owed. Scheduling one anyway would cost an analysis every time coverage
  // recovered, for an interval nothing was ever unwatched in.
  assert.equal(h.auto.isResponding(), false);
  assert.equal(h.timer.pending(), 0);
  h.timer.run();
  assert.equal(h.refreshes.length, 0);
});

test("a coverage notice for a project the user has left clears nothing", () => {
  const h = harness({ startFails: true });
  const stale = h.auto.subscribe("/p").subscription;
  const current = h.auto.subscribe("/q").subscription;
  h.auto.failed(current, "inotify limit reached");

  // /p's coverage says nothing whatever about /q, whose watcher is the one that could
  // not be installed.
  h.auto.covered(stale, true);
  assert.equal(h.auto.degradation(), "inotify limit reached");
  assert.equal(h.timer.pending(), 0, "and nothing was scheduled for it either");
  h.timer.run();
  assert.equal(h.refreshes.length, 0);
});

// ---- Coverage that installed in part ----
//
// A plan can name a location the platform will not watch - a directory an include
// left the project for, on a filesystem or at a limit that refuses it - while the
// root arms perfectly well. Both halves are true at once, and the coordinator has to
// hold both: the part that armed owes the same catch-up analysis newly armed coverage
// does, and the part that did not is degradation that must go on being shown.

test("a partly installed plan degrades the watch and still catches up on what armed", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  h.auto.partial(subscription, "/p/vendor: no space left on device", true);
  assert.equal(h.auto.degradation(), "/p/vendor: no space left on device");
  // Not an invalidation, for the same reason `covered` is not one: nothing has said
  // anything changed, only that something was read before it was watched.
  assert.deepEqual(h.calls(), ["start:1:/p"]);
  assert.equal(h.auto.isResponding(), true, "an analysis is owed for what did arm");
  assert.equal(h.auto.isRespondingToChange(), false);

  h.timer.run();
  assert.equal(h.refreshes.length, 1);
  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.auto.isResponding(), false, "exactly one, and it terminates");
  // And the location nobody is watching is still the user's problem to be told about:
  // the analysis did not fix it.
  assert.equal(h.auto.degradation(), "/p/vendor: no space left on device");
});

test("a partial notice that newly watched nothing asks for no analysis", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  // What every subsequent analysis of a permanently unwatchable location produces: the
  // handoff arms the same coverage it already had, so there is nothing to catch up on.
  // Scheduling one here is the whole loop this avoids - each analysis would produce a
  // notice that asked for the next.
  h.auto.partial(subscription, "/p/vendor: no space left on device", false);
  assert.equal(h.auto.degradation(), "/p/vendor: no space left on device");
  assert.equal(h.auto.isResponding(), false);
  assert.equal(h.timer.pending(), 0);
  h.timer.run();
  assert.equal(h.refreshes.length, 0);
  // Still worth a redraw: the status line did not previously say the watch was
  // degraded, and nothing else here would make it say so.
  assert.equal(h.log.filter((entry) => entry === "render").length, 1);
});

test("partial coverage does not clear a degradation, and complete coverage does", async () => {
  const h = harness({ startFails: true });
  const { subscription, armed } = h.auto.subscribe("/p");
  await armed;
  assert.match(h.auto.degradation(), /inotify limit reached/);

  // The replacement watcher armed the root and not the rest. That is not proof the
  // coverage the project asked for is live, so the window may not go back to saying
  // automatic refresh works.
  h.auto.partial(subscription, "/p/vendor: no space left on device", true, 1);
  assert.equal(h.auto.degradation(), "/p/vendor: no space left on device");
  h.timer.run();
  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.auto.degradation(), "/p/vendor: no space left on device");

  // Only the notice that proves the whole requested plan is installed clears it - and it
  // is the arm after the partial one that sends it, never that arm again.
  h.auto.covered(subscription, true, 2);
  assert.equal(h.auto.degradation(), null);
});

test("a partial notice replaces the reason rather than accumulating reasons", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.partial(subscription, "/p/vendor: no space left on device", false);
  // The next handoff's account is derived from the plan the latest analysis produced,
  // so it supersedes the previous one entirely: an include the user deleted is no
  // longer a location that is not being watched.
  h.auto.partial(subscription, "/p/shared: permission denied", false);
  assert.equal(h.auto.degradation(), "/p/shared: permission denied");
});

test("a partial notice for a project the user has left is inert", () => {
  const h = harness();
  const stale = h.auto.subscribe("/p").subscription;
  h.auto.subscribe("/q");

  h.auto.partial(stale, "/p/vendor: no space left on device", true);
  assert.equal(h.auto.degradation(), null, "/q's watch is not degraded by /p's trouble");
  assert.equal(h.timer.pending(), 0);
  h.timer.run();
  assert.equal(h.refreshes.length, 0);
});

// ---- An error from coverage that has been replaced ----
//
// Retiring a native instance makes its callbacks inert but does not stop its thread, so
// one that read an open gate before a handoff can report afterwards - after the
// replacement announced itself. Believing it would leave "automatic refresh
// unavailable" on screen on top of the proof that it is running, and nothing would ever
// contradict it: a project nobody is touching arms no more watchers.
//
// The backend cannot order this out. Closing a gate and emitting from a callback are
// separate steps on separate threads. So every arm is announced with the instance it
// installed, every failure carries the instance it is news about, and this - single
// threaded, and the only place with a total order over what it has been told - drops the
// obsolete ones.
//
// The other direction matters just as much. A native handler is installed before the arm
// that creates it returns, so a failure from instance N can arrive BEFORE N's own
// announcement: that announcement is news about the watcher that failed, not proof that
// anything replaced it. Only a strictly newer arm may clear a degradation, which is also
// why an identity is never reused - an arm that reported and then failed leaves its number
// spent, and the arm that follows has one of its own.
//
// A failure need not arrive on that channel at all. An arm that fails comes back on the
// call that asked for it, so the queue that orders the notices says nothing about where it
// lands among them - and one of them may be the announcement of the very coverage the
// fence retired. It carries the identity its attempt reserved instead: newer than
// everything built before the attempt and older than the arm that recovers, and armed by
// nothing, so naming it silences no live instance. Both interleavings then reach the same
// state, which is the point of ordering by identity rather than by arrival.
//
// How the arm failed changes nothing here, and that is worth stating rather than assuming.
// An arming step that panicked reserved its identity before it tried, exactly as one that
// refused did, and comes back naming it - so a panic is an ordinary rejection at this
// level. It has to be: a watcher installed just moments before the panic is an orphan
// nothing will retire, and what it emits, it emits under that same number.

test("an error from an instance a later arm replaced is not shown", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.covered(subscription, false, 7);
  const renders = h.log.filter((entry) => entry === "render").length;

  // A callback of instance 6, descheduled across the handoff that armed 7.
  h.auto.failed(subscription, "event queue overflowed", 6);
  assert.equal(h.auto.degradation(), null, "instance 6 is not what is delivering now");
  assert.equal(
    h.log.filter((entry) => entry === "render").length,
    renders,
    "and nothing was redrawn, because nothing changed",
  );
});

test("an error from the instance that is delivering is shown", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.covered(subscription, false, 7);

  h.auto.failed(subscription, "event queue overflowed", 7);
  assert.equal(h.auto.degradation(), "event queue overflowed");
});

test("an error naming no instance is never ordered out", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.covered(subscription, false, 7);

  // What a call that reserved no identity looks like: a fence that could not be taken, or
  // a `watch_project` that failed outright. Nothing was armed and no attempt is named, so
  // no arm can have superseded it.
  h.auto.failed(subscription, "could not fence the watcher");
  assert.equal(h.auto.degradation(), "could not fence the watcher");
});

test("a notice naming no instance does not un-order the arms already announced", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.covered(subscription, false, 7);
  // A notice that named no instance says nothing about which arm is newest, so it must
  // leave the mark where it is - lowering it would make every earlier instance's stale
  // error current again.
  h.auto.covered(subscription, false);

  h.auto.failed(subscription, "event queue overflowed", 6);
  assert.equal(h.auto.degradation(), null);
});

test("a stale error does not replace the reason a partial notice is showing", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  // A partial arm is still an arm, and still supersedes what it replaced.
  h.auto.partial(subscription, "/p/vendor: no space left on device", false, 8);

  h.auto.failed(subscription, "event queue overflowed", 7);
  assert.equal(
    h.auto.degradation(),
    "/p/vendor: no space left on device",
    "the location nobody is watching is what the user needs to know",
  );
});

test("the announcement of the instance that failed does not clear its failure", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.covered(subscription, false, 7);
  // Instance 8's handler is live from inside the arm that creates it, so it can report
  // before the notice announcing it arrives.
  h.auto.failed(subscription, "event queue overflowed", 8);
  const renders = h.log.filter((entry) => entry === "render").length;

  h.auto.covered(subscription, false, 8);
  assert.equal(
    h.auto.degradation(),
    "event queue overflowed",
    "instance 8 announcing itself says nothing about instance 8 having failed",
  );
  assert.equal(
    h.log.filter((entry) => entry === "render").length,
    renders,
    "and nothing was redrawn, because nothing changed",
  );
});

test("an error older than one already shown is still ordered out", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.covered(subscription, false, 7);
  // The failure of an instance whose announcement has not arrived yet is news that the
  // instance exists, so it raises the mark as an announcement would.
  h.auto.failed(subscription, "event queue overflowed", 8);

  // A callback of instance 7, descheduled across the handoff that armed 8. It is stale
  // whether or not 8 has announced itself.
  h.auto.failed(subscription, "the watcher went away", 7);
  assert.equal(h.auto.degradation(), "event queue overflowed");
});

test("coverage from a newer arm clears the failure the previous one reported", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.covered(subscription, false, 7);
  h.auto.failed(subscription, "event queue overflowed", 8);
  const renders = h.log.filter((entry) => entry === "render").length;

  // A watcher that instance 8 is not: the degradation has been overtaken, and leaving it
  // on screen would leave it there for as long as the project stayed open.
  h.auto.covered(subscription, false, 9);
  assert.equal(h.auto.degradation(), null);
  assert.equal(
    h.log.filter((entry) => entry === "render").length,
    renders + 1,
    "and the window is redrawn to stop saying otherwise",
  );
});

test("a failed re-arm is not answered by the coverage its own fence retired", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  // Instance 8 announced itself and the notice has not arrived. A fence retired it, and
  // the re-arm reserved 9 and could not install it - emitting nothing under 9, so this
  // rejection is the only thing that will ever mention it.
  h.auto.failed(subscription, "could not re-arm the watcher", 9);
  assert.equal(h.auto.degradation(), "could not re-arm the watcher");

  // Now instance 8's announcement arrives: coverage, and proof of nothing, because the
  // watcher it is about was retired before the attempt that failed. Placed by the number
  // the attempt reserved rather than by which channel got here first.
  h.auto.covered(subscription, true, 8);
  assert.equal(
    h.auto.degradation(),
    "could not re-arm the watcher",
    "nothing is armed, so nothing may say automatic refresh is working",
  );
  // The analysis it owes is another matter: ground was read before instance 8 answered for
  // it, and nothing newer has caught up on that.
  h.timer.run();
  assert.equal(h.refreshes.length, 1);
  h.refreshes[0].resolve();
  await drained();

  // And that analysis handing its plan over is what recovers: a strictly newer arm.
  h.auto.covered(subscription, false, 10);
  assert.equal(h.auto.degradation(), null);
});

test("the coverage a fence retired arriving first leaves the same state", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");

  // The other interleaving, with the same two notices: instance 8's announcement arrives
  // while it is still the newest arm heard of, so it is ordinary news of coverage.
  h.auto.covered(subscription, true, 8);
  assert.equal(h.auto.degradation(), null);

  // Then the rejection, naming an attempt newer than it. The mark moves as it would for a
  // failure heard of before its announcement - which is what the reserved identity makes
  // this: news that an arm was tried and is not delivering.
  h.auto.failed(subscription, "could not re-arm the watcher", 9);
  assert.equal(h.auto.degradation(), "could not re-arm the watcher");
  // So an even older instance's late error is stale, exactly as in the other order.
  h.auto.failed(subscription, "event queue overflowed", 8);
  assert.equal(h.auto.degradation(), "could not re-arm the watcher");
  h.timer.run();
  assert.equal(h.refreshes.length, 1, "and the debt is the same debt");
});

test("a re-arm that panicked is answered by no coverage older than its attempt", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  const panicked = "the watcher arm panicked: no such file or directory";

  // The attempt reserved 9 and then the arming step panicked, which is a rejection like any
  // other here - the identity is what places it, not the manner of the failure.
  h.auto.failed(subscription, panicked, 9);
  h.auto.covered(subscription, true, 8);
  assert.equal(
    h.auto.degradation(),
    panicked,
    "the coverage the fence retired cannot answer for an arm that panicked either",
  );

  // And 9 is exactly the number an orphan watcher installed before the panic emits under, so
  // trouble reported from it is current news rather than something ordered out.
  h.auto.failed(subscription, "event queue overflowed", 9);
  assert.equal(h.auto.degradation(), "event queue overflowed");
  h.auto.covered(subscription, false, 10);
  assert.equal(h.auto.degradation(), null, "and a strictly newer arm still recovers");
});

test("coverage arriving before a panicking re-arm's rejection leaves the same state", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  const panicked = "the watcher arm panicked: no such file or directory";

  // The other interleaving. Instance 8's announcement is ordinary news of coverage while it
  // is the newest arm heard of, and the rejection that follows names an attempt newer than
  // it - so the state after both is the state after both in either order.
  h.auto.covered(subscription, true, 8);
  assert.equal(h.auto.degradation(), null);
  h.auto.failed(subscription, panicked, 9);
  assert.equal(h.auto.degradation(), panicked);
  h.timer.run();
  assert.equal(h.refreshes.length, 1, "with the same catch-up owed");
});

// ---- A failure nothing could attribute ----
//
// The third outcome, and the one that cannot be ordered at all. A re-arm whose task never
// came back left the registry unable to say what that attempt reserved - reading the
// counter afterwards would race the next attempt - so the rejection names no identity.
//
// Naming none is not naming 0. 0 is a proved statement, that nothing was reserved and
// nothing can have armed, and it is answered by any arm at all for exactly that reason.
// Unknown proves nothing: an identity may have been taken and a watcher installed under
// it, and where that identity fell among the notices is the missing fact - so an
// announcement already in flight cannot be told from the arm that recovered, and neither
// can any later one. Conflating the two is how the delayed announcement of the coverage a
// fence had just retired would end up saying automatic refresh works while nothing is
// armed, which is the bug the reserved identity exists to prevent, arriving by another road.
//
// So it is recorded as unplaceable and stays: no announcement clears it, in either order of
// arrival, and re-opening the project is the recovery - which proves nothing about
// instances, because the watcher the degradation was about goes with the subscription.

test("a failure nothing could place is not answered by the coverage in flight", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  const lost = "watcher task panicked: the task did not come back";

  h.auto.failed(subscription, lost, null);
  assert.equal(h.auto.degradation(), lost);

  // What an attributed rejection would have ordered out by identity. There is none here, so
  // this is refused for a different reason: nothing about it can be compared.
  h.auto.covered(subscription, true, 8);
  assert.equal(h.auto.degradation(), lost, "coverage in flight answers nothing");
  // The debt is a separate question and is settled as usual: ground was read before that
  // arm watched it, whatever is unknown about the arm that failed.
  h.timer.run();
  assert.equal(h.refreshes.length, 1);
});

test("the coverage in flight arriving first leaves the same state", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  const lost = "watcher task panicked: the task did not come back";

  // The other interleaving. This announcement is ordinary news of coverage as it arrives -
  // it is the newest arm heard of - and the mark moves to it.
  h.auto.covered(subscription, true, 8);
  assert.equal(h.auto.degradation(), null);

  h.auto.failed(subscription, lost, null);
  assert.equal(h.auto.degradation(), lost);
  // And having been believed does not make it an answer to what follows: the state after
  // both notices is the state after both in the other order.
  h.auto.covered(subscription, false, 9);
  assert.equal(h.auto.degradation(), lost, "nor does the next arm");
  h.timer.run();
  assert.equal(h.refreshes.length, 1, "with the same catch-up owed");
});

test("no arm clears a failure nothing could place, and re-opening does", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  const lost = "watcher task panicked: the task did not come back";

  h.auto.failed(subscription, lost, null);
  // Two arms newer than anything heard of. A failure that named 0 - proved to have reserved
  // nothing - would be answered by either; this one is answered by neither, because the
  // frontend cannot tell an arm that recovered from an announcement built before the attempt.
  h.auto.covered(subscription, false, 10);
  h.auto.covered(subscription, false, 11);
  assert.equal(h.auto.degradation(), lost);

  const reopened = h.auto.subscribe("/p");
  assert.equal(h.auto.degradation(), null, "re-opening needs nothing proved about instances");
  assert.notEqual(reopened.subscription, subscription);
});

test("an unplaceable failure outlives the message a later notice replaces", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  const lost = "watcher task panicked: the task did not come back";

  h.auto.failed(subscription, lost, null);
  // A partial arm says something more specific about what is unwatched, and the window shows
  // it - the mark was never raised by the unplaceable failure, so nothing orders this out.
  h.auto.partial(subscription, "/shared: permission denied", false, 9);
  assert.equal(h.auto.degradation(), "/shared: permission denied");

  // But replacing what is SAID does not make the lost attempt's identity known, so the
  // degradation is still one no announcement can clear.
  h.auto.covered(subscription, false, 10);
  assert.equal(
    h.auto.degradation(),
    "/shared: permission denied",
    "a newer arm would clear a partial on its own; it cannot clear this one",
  );
});

// ---- Coverage notices about an arm already replaced ----
//
// The same ordering, applied to the notices that carry good news. The backend serializes
// publication, so a coverage notice cannot overtake the one it replaced there; these are
// the rows of that table driven by hand, because a rule that is only unreachable is not a
// rule. What a notice from a replaced arm says about the watch is out of date in both
// directions - its degradation is about coverage that no longer exists, and its coverage
// is not the coverage being delivered - while what it says about the disk is not: ground
// it read before anything watched it was still read unwatched, and only an analysis asked
// for by a NEWER arm has looked at that ground since.

test("a partial notice from an arm already replaced degrades nothing", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.covered(subscription, false, 8);
  const renders = h.log.filter((entry) => entry === "render").length;

  // Instance 7's handoff, announcing a location it could not watch. Instance 8 has since
  // installed the whole plan, so recording this would put the watch back on screen as
  // degraded on top of the proof that it is not.
  h.auto.partial(subscription, "/p/vendor: no space left on device", false, 7);
  assert.equal(h.auto.degradation(), null);
  assert.equal(
    h.log.filter((entry) => entry === "render").length,
    renders,
    "and nothing was redrawn, because nothing changed",
  );
});

test("a partial notice ordered out still asks for the analysis it owes", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.covered(subscription, false, 8);

  // The message is about coverage that has been replaced; the debt is about a read that
  // happened. Nothing has caught up since, so it is still owed.
  h.auto.partial(subscription, "/p/vendor: no space left on device", true, 7);
  assert.equal(h.auto.degradation(), null, "the message is still about instance 7");
  assert.equal(h.auto.isResponding(), true);
  h.timer.run();
  assert.equal(h.refreshes.length, 1);
  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.auto.isResponding(), false);
});

test("a catch-up honoured for a newer arm subsumes an older arm's", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.partial(subscription, "/p/vendor: no space left on device", true, 9);
  h.timer.run();
  assert.equal(h.refreshes.length, 1);
  h.refreshes[0].resolve();
  await drained();

  // Instance 8's coverage, arriving after the arm that replaced it. It clears nothing, and
  // the analysis it asks for has already been performed for newer coverage than its own:
  // that analysis read the disk after instance 9's watch went in, so it answered for
  // instance 8's ground as well.
  h.auto.covered(subscription, true, 8);
  assert.equal(h.auto.degradation(), "/p/vendor: no space left on device");
  assert.equal(h.auto.isResponding(), false, "no second analysis was asked for");
  assert.equal(h.timer.pending(), 0);
  h.timer.run();
  assert.equal(h.refreshes.length, 1);
});

test("an older arm's catch-up is honoured when nothing newer has caught up", async () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  // Instance 9 armed the same coverage it already had, so it owed nothing and no analysis
  // has run since. Its degradation stands, being about the live watch.
  h.auto.partial(subscription, "/p/vendor: no space left on device", false, 9);
  assert.equal(h.auto.isResponding(), false);

  // So instance 8's debt is nobody else's: dropping it for being out of order would leave
  // whatever was written while its plan was being armed in no analysis at all.
  h.auto.covered(subscription, true, 8);
  assert.equal(h.auto.degradation(), "/p/vendor: no space left on device", "still not cleared");
  h.timer.run();
  assert.equal(h.refreshes.length, 1);
  h.refreshes[0].resolve();
  await drained();
  assert.equal(h.auto.isResponding(), false);
});

test("coverage from a replaced arm does not answer a failure that named no instance", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  h.auto.covered(subscription, false, 8);
  // A fence that could not be taken, which reserved no identity: any live arm answers it -
  // but instance 7 is not a live arm, and its coverage is news from before the call that
  // could not fence what is watching now.
  h.auto.failed(subscription, "could not fence the watcher");

  h.auto.covered(subscription, true, 7);
  assert.equal(h.auto.degradation(), "could not fence the watcher");
  // The debt is still honoured, being about ground that was read.
  h.timer.run();
  assert.equal(h.refreshes.length, 1);
});

test("an error from a retained instance is dropped without losing its changes", () => {
  const h = harness();
  const { subscription } = h.auto.subscribe("/p");
  // A handoff only keeps an older instance when it could not install everything, so it
  // reported degradation at the same time: dropping that instance's later error loses
  // nothing the user is not already being told.
  h.auto.partial(subscription, "/p/shared: no space left on device", true, 8);
  h.timer.run();
  h.refreshes[0].resolve();

  h.auto.failed(subscription, "event queue overflowed", 6);
  assert.equal(h.auto.degradation(), "/p/shared: no space left on device");
  // Its changes are a different matter: it is the only thing delivering the location it
  // is kept for, and a change notice names no instance for exactly that reason.
  h.auto.changed(subscription);
  assert.deepEqual(h.calls().slice(-1), ["invalidate"]);
  assert.equal(h.auto.isRespondingToChange(), true);
});
