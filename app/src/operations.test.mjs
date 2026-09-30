// Tests for the operation token and the reset barrier (operations.ts).
//
// Run with `npm test`. Every case below is a lifecycle bug that reached the UI at
// some point: a compile finishing after the rules were edited, a compile
// invalidating itself by auto-saving, a failure handler from the previous project
// overwriting the current one's state, and - the ordering half - a ruleset reset
// landing after the compile that was started to replace it.
//
// Nothing here waits on a clock. The reset is a promise the test opens by hand, so
// "the compile has not reached the backend yet" is an assertion about order rather
// than about timing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Operations } from "./operations.ts";

// The cases that are only about the token do not care what a reset does; the
// ordering cases further down use harness() instead.
const tokenOnly = () => new Operations(async () => {});

// Lets everything that can proceed proceed. setImmediate runs after the microtask
// queue is exhausted, so whatever is still pending afterwards is pending on the
// gate below - not on a delay.
const drained = () => new Promise((resolve) => setImmediate(resolve));

// The lifecycle wired to a ruleset reset the test controls, plus the three places
// in main.ts that ask for one. Every reset and every backend compile appends to
// `log`, so the order they really happened in can be asserted directly.
function harness({ project = null } = {}) {
  const log = [];
  let open = () => {};
  let gate = Promise.resolve(); // resets settle at once until hold() is called
  let failure = null;
  let resets = 0;
  let current = project; // the harness's projectDir

  const ops = new Operations(async () => {
    const id = ++resets;
    log.push(`reset${id}:start`);
    await gate;
    if (failure) {
      log.push(`reset${id}:failed`);
      throw failure;
    }
    log.push(`reset${id}:done`);
  });

  return {
    ops,
    log,
    get project() {
      return current;
    },

    // Holds every reset from here on open, until release() is called.
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
    },
    // Makes every reset from here on reject with `err` (null to stop).
    failResets(err) {
      failure = err;
    },

    // invalidateCompilation(): bump the revision, queue the reset, do NOT await it.
    invalidate() {
      ops.invalidate();
      return ops.requestReset();
    },

    // openFolder(): supersede, then queue the reset - both synchronously, before
    // the fallible folder loading that follows in the real thing.
    openFolder(dir) {
      current = dir;
      ops.begin(dir);
      return ops.requestReset();
    },

    // compileWorkspace(): begin, cross the barrier, re-check the token, and only
    // then invoke the backend compiler.
    async compile() {
      const op = ops.begin(current);
      try {
        await ops.settle();
      } catch (err) {
        log.push(`blocked:${err.message}`);
        return { op, compiled: false, error: err };
      }
      if (!ops.isCurrent(op, current)) {
        log.push("dropped");
        return { op, compiled: false };
      }
      log.push(`compile:${current}`);
      return { op, compiled: true };
    },

    // The compile failure path: drop the ruleset only while this operation still
    // owns it, then re-check before reporting anything.
    async cleanup(op) {
      const reset = ops.resetFor(op, current);
      if (reset === null) {
        log.push("cleanup:skipped");
        return false;
      }
      await reset.catch(() => {});
      if (!ops.isCurrent(op, current)) {
        log.push("cleanup:dropped");
        return false;
      }
      log.push("cleanup:reported");
      return true;
    },
  };
}

test("an operation nothing has disturbed is current", () => {
  const ops = tokenOnly();
  const op = ops.begin("/p");

  assert.equal(ops.isCurrent(op, "/p"), true);
});

test("a newer operation supersedes an older one still in flight", () => {
  const ops = tokenOnly();
  const older = ops.begin("/p");
  const newer = ops.begin("/p");

  assert.equal(ops.isCurrent(older, "/p"), false);
  assert.equal(ops.isCurrent(newer, "/p"), true);
});

test("a content change supersedes a compile that is still running", () => {
  // The headline bug: editing a rule during a compile left the old compilation
  // free to finish, install its rules and set the UI to Compiled, enabling Scan
  // against rules that predate the editor's contents.
  const ops = tokenOnly();
  const compile = ops.begin("/p");

  ops.invalidate(); // a real Monaco content change

  assert.equal(ops.isCurrent(compile, "/p"), false);
});

test("save bookkeeping does not supersede the compile that caused it", () => {
  // A compile auto-saves the dirty documents it is about to compile, and each
  // save fires the workspace's dirty callback. Driving invalidation from that
  // callback would have every compile invalidate itself. Only real content
  // changes call invalidate(), so a compile whose saves are the only thing that
  // happened is still current.
  const ops = tokenOnly();
  const compile = ops.begin("/p");

  // Three completed saves, a manual Ctrl+S, an explorer redraw: no content changed.
  assert.equal(ops.isCurrent(compile, "/p"), true);
});

test("a manual save cannot make an already superseded compile current again", () => {
  // Edit during a compile, then press Ctrl+S. The edit superseded the compile;
  // nothing the save does may undo that, which is why the revision only ever
  // increases.
  const ops = tokenOnly();
  const compile = ops.begin("/p");

  ops.invalidate(); // the edit
  // The save writes bytes and clears a dirty marker. Whatever it fires, there is
  // no operation to restore: the only mutator is invalidate(), and it counts up.
  assert.equal(ops.isCurrent(compile, "/p"), false);

  ops.invalidate();
  ops.invalidate();
  assert.equal(ops.isCurrent(compile, "/p"), false);
});

test("a compile started after the change is current, so the user can retry", () => {
  // Invalidation must not wedge the app: having superseded the running compile,
  // the next one has to be able to succeed.
  const ops = tokenOnly();
  const abandoned = ops.begin("/p");
  ops.invalidate();

  const retry = ops.begin("/p");

  assert.equal(ops.isCurrent(abandoned, "/p"), false);
  assert.equal(ops.isCurrent(retry, "/p"), true);
});

test("a project file created or renamed during a compile supersedes it", () => {
  // New Rule and Rename Rule change what the backend would compile without any
  // editor content changing, so they invalidate explicitly.
  const ops = tokenOnly();
  const compile = ops.begin("/p");

  ops.invalidate(); // createFile() / renameFile() landed

  assert.equal(ops.isCurrent(compile, "/p"), false);
});

test("opening a different folder supersedes an operation", () => {
  const ops = tokenOnly();
  const compile = ops.begin("/a");

  // openFolder sets projectDir before anything else; isCurrent is asked about the
  // project that is open now.
  assert.equal(ops.isCurrent(compile, "/b"), false);
});

test("re-opening the folder that is already open supersedes too", () => {
  // The project comparison cannot see this one - the path is unchanged - but the
  // ruleset was dropped on the way in, so the running compile is obsolete all the
  // same. That is what the serial is for.
  const ops = tokenOnly();
  const compile = ops.begin("/a");

  ops.begin("/a"); // openFolder, same directory

  assert.equal(ops.isCurrent(compile, "/a"), false);
});

test("an operation superseded during its own failure cleanup is no longer current", async () => {
  // The compile failure path checks the token, then awaits the reset. The
  // operation can go obsolete during that await, so the answer from before it is
  // worthless: acting on it would overwrite the new project's diagnostics and
  // build state with the old project's failure. Deterministic by microtask
  // ordering - no timing involved.
  const ops = tokenOnly();
  let project = "/a";
  const op = ops.begin(project);

  assert.equal(ops.isCurrent(op, project), true, "the check before the reset passes");

  await Promise.resolve().then(() => {
    // openFolder, while the reset is in flight.
    project = "/b";
    ops.begin(project);
  });

  assert.equal(ops.isCurrent(op, project), false, "so the check has to be repeated after it");
});

test("the scratch buffer is tracked the same way", () => {
  // No folder open: compileScratch sends the live editor text, so an edit while
  // it is in flight makes the response describe text that is gone.
  const ops = tokenOnly();
  const compile = ops.begin(null);

  assert.equal(ops.isCurrent(compile, null), true);
  ops.invalidate();
  assert.equal(ops.isCurrent(compile, null), false);
});

// ---- Reset ordering ----

test("an edit's reset finishes before the retry compile reaches the backend", async () => {
  // The race the barrier exists for. Compile A is running; an edit supersedes it
  // and asks for the ruleset to be dropped; the user hits Compile again at once,
  // because invalidation deliberately re-enables it. Fire the reset off unordered
  // and it lands after the retry has installed its rules, so the retry - the valid
  // one - comes back ok: false.
  const h = harness({ project: "/p" });
  h.hold();
  const a = h.ops.begin("/p"); // compile A, in flight
  const reset = h.invalidate(); // the edit
  const retry = h.compile(); // the user, immediately

  await drained();
  assert.deepEqual(h.log, ["reset1:start"], "the retry is parked on the barrier");

  h.release();
  const b = await retry;
  await reset;

  assert.deepEqual(h.log, ["reset1:start", "reset1:done", "compile:/p"]);
  assert.equal(b.compiled, true, "and it compiles as soon as the reset is done");
  assert.equal(h.ops.isCurrent(a, "/p"), false, "A stays superseded");
  assert.equal(h.ops.isCurrent(b.op, "/p"), true);
});

test("a reset held open cannot be overtaken by a compile started after it", async () => {
  // A folder switch whose reset is slow. The UI says "not compiled" from the moment
  // the folder changes, so Compile is available and the user takes it while the
  // folder is still loading. No amount of progress elsewhere may let that compile
  // reach the backend before the reset has run.
  const h = harness({ project: "/p" });
  h.hold();
  const switching = h.openFolder("/q");
  const compiling = h.compile();

  await drained();
  await drained();
  assert.deepEqual(h.log, ["reset1:start"], "still parked, however much else has run");

  h.release();
  const res = await compiling;
  await switching;

  assert.deepEqual(h.log, ["reset1:start", "reset1:done", "compile:/q"]);
  assert.equal(res.compiled, true);
});

test("every queued reset finishes before a compile reaches the backend", async () => {
  // Three resets, from two different call sites. Each one must run: a request that
  // replaced the tracked promise instead of chaining onto it would leave an earlier
  // reset free to execute after the compile.
  const h = harness({ project: "/p" });
  h.hold();
  const first = h.invalidate();
  const second = h.invalidate();
  const third = h.openFolder("/q");
  const compiling = h.compile();

  await drained();
  assert.deepEqual(h.log, ["reset1:start"], "serialised, so only the first has started");

  h.release();
  const res = await compiling;
  await Promise.all([first, second, third]);

  assert.deepEqual(h.log, [
    "reset1:start",
    "reset1:done",
    "reset2:start",
    "reset2:done",
    "reset3:start",
    "reset3:done",
    "compile:/q",
  ]);
  assert.equal(res.compiled, true);
});

test("an operation superseded while it waits on the barrier never reaches the compiler", async () => {
  // Waiting for the barrier is an await like any other. If the user opens another
  // folder during it, the backend must not be called at all - rules never installed
  // are rules nothing has to undo.
  const h = harness({ project: "/p" });
  h.hold();
  const reset = h.invalidate();
  const compiling = h.compile();
  await drained();

  const switching = h.openFolder("/q");
  h.release();
  const res = await compiling;
  await Promise.all([reset, switching]);

  assert.equal(res.compiled, false);
  assert.ok(
    !h.log.some((entry) => entry.startsWith("compile:")),
    "the compiler was never invoked",
  );
  assert.ok(h.log.includes("dropped"));
});

test("a stale failure handler cannot reset the ruleset a newer compile installed", async () => {
  // Compile A fails, but only after an edit and a retry have overtaken it. Its
  // cleanup has to do nothing whatsoever: dropping the ruleset here would delete
  // the retry's rules, and the retry has already told the UI it is compiled.
  const h = harness({ project: "/p" });
  const a = h.ops.begin("/p");
  await h.invalidate(); // the edit that superseded A
  const b = await h.compile(); // the retry, which crossed the barrier and compiled
  assert.equal(b.compiled, true);

  const reported = await h.cleanup(a);

  assert.equal(reported, false, "and it does not touch the UI either");
  assert.deepEqual(h.log, ["reset1:start", "reset1:done", "compile:/p", "cleanup:skipped"]);
  assert.equal(h.ops.isCurrent(b.op, "/p"), true, "the retry still owns the ruleset");
});

test("a reset requested after a compile crossed the barrier still supersedes it", async () => {
  // The other half of the guarantee. The barrier holds back resets that were asked
  // for before the compile; it does not pretend a *newer* edit never happened. This
  // response has to be dropped, and its rules dropped with it.
  const h = harness({ project: "/p" });
  const compiled = await h.compile();
  assert.equal(compiled.compiled, true);

  await h.invalidate(); // an edit, while the response is still in flight

  assert.equal(h.ops.isCurrent(compiled.op, "/p"), false, "its response is no longer wanted");
  assert.deepEqual(h.log, ["compile:/p", "reset1:start", "reset1:done"]);
});

test("a reset that fails blocks compilation instead of being ignored", async () => {
  // A reset that could not be performed is not a reset that happened. Compiling on
  // top of rules that may still be installed is the failure this is guarding
  // against, so the compile does not run and says why.
  const h = harness({ project: "/p" });
  h.failResets(new Error("ipc channel closed"));
  const reset = h.invalidate();

  await assert.rejects(() => reset, /ipc channel closed/, "the requester can see it");

  const blocked = await h.compile();

  assert.equal(blocked.compiled, false);
  assert.match(String(blocked.error), /ipc channel closed/);
  assert.deepEqual(h.log, ["reset1:start", "reset1:failed", "blocked:ipc channel closed"]);

  // A later reset that succeeds clears the way: whatever went wrong before, the
  // ruleset is gone now.
  h.failResets(null);
  await h.invalidate();
  const res = await h.compile();

  assert.equal(res.compiled, true);
});

test("operation and reset trace edges are injectable and never affect outcomes", async () => {
  const events = [];
  const ops = new Operations(async () => {}, (event) => events.push(event));
  const operation = ops.begin("/project");
  ops.invalidate();
  await ops.requestReset();

  assert.deepEqual(events.map((event) => event.event), [
    "operation_begin",
    "operation_invalidate",
    "reset_queued",
    "reset_started",
    "reset_completed",
  ]);
  assert.deepEqual(ops.currency(), { serial: 1, revision: 1 });
  assert.equal(ops.isCurrent(operation, "/project"), false);

  const throwingObserver = new Operations(async () => {}, () => {
    throw new Error("trace sink failed");
  });
  throwingObserver.begin("/project");
  await throwingObserver.requestReset();
});
