// Tests for the open project (project.ts).
//
// Run with `npm test`. The first half is the folder-load ordering that used to
// live in folderload.test.mjs, re-stated against the session that absorbed the
// token: opening a folder is several awaits deep and the user can pick another
// folder during any of them, so the cases below are all the same bug seen from
// different sides - a slow response applying itself to the folder that replaced
// it, or to no folder at all.
//
// Then the same question one level up: which commands may run while a load is
// outstanding. New Rule creates a file the outstanding analysis will not know
// about and whose document the auto-open would push out of the editor - it waits.
// Compile asks the backend to read the directory itself - it does not.
//
// The second half is what the session adds: refreshes that cannot be applied out
// of order, an edit during an analysis leaving its result stale on arrival, a
// failed refresh that leaves the project it could not refresh in place, and the
// three answers being kept apart - a snapshot, a configuration failure (an
// answer), and an infrastructure failure (no answer at all).
//
// No clocks, no DOM, no display, no backend. Each analysis and each file read is
// a promise the test resolves by hand, so the interleaving is chosen rather than
// raced.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ProjectSession,
  firstOpenableSource,
  memberPathsOf,
  sourcesOf,
} from "./project.ts";
import { Operations } from "./operations.ts";
import { openablePath } from "./sourceid.ts";

// Lets everything that can proceed proceed: setImmediate runs after the microtask
// queue is exhausted, so what is still outstanding afterwards is waiting on a
// promise the test holds, not on a delay.
const drained = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A `loaded` analysis of `root` containing `names`, all readable and unconnected.
// Enough for the ordering questions; the graph shapes are includestree.test.mjs's.
function loaded(root, names, extra = {}) {
  const ids = names.map((path) => ({ external: false, path }));
  return {
    status: "loaded",
    root,
    manifest: null,
    entrypointOrigin: "inferred",
    entrypoints: ids,
    discovered: ids,
    nodes: ids.map((id) => ({ id, readable: true })),
    edges: [],
    issues: [],
    compilable: true,
    ...extra,
  };
}

function configurationFailed(code = "manifest-invalid") {
  return {
    status: "configurationFailed",
    issue: { code, message: "quipu.toml is not valid TOML", severity: "blocking", scope: "project", at: null, span: null },
  };
}

// openFolder(), refreshProject() and compileWorkspace() with the DOM and IPC
// removed and the ordering kept: the infallible prologue, then a check after every
// fallible await, with results held in locals until that check has passed.
//
// `ui` stands in for the shared state a stale response could corrupt, so a test
// can simply assert that all of it still belongs to the project the user chose
// last.
function app() {
  const ui = { dir: null, files: [], opened: null, problem: null, canCreateRule: false };
  const session = new ProjectSession();
  // Real reset barrier, no-op reset: this is about project loads, and the compile
  // lifecycle has its own tests.
  const operations = new Operations(async () => {});
  const analyses = [];
  const reads = [];
  // What the caller knows and the session does not: whether a document belonging
  // to the analysis being accepted has unsaved edits.
  let unsaved = false;

  const held = (calls, key) => {
    const d = deferred();
    calls.push({ key, resolve: d.resolve, reject: d.reject });
    return d.promise;
  };

  const pathsOf = (analysis) =>
    analysis.status === "loaded"
      ? sourcesOf(analysis).map((id) => openablePath(analysis.root, id))
      : [];

  async function runAnalysis(req, reset) {
    try {
      if (reset) await reset;
      if (!session.isCurrent(req.selection)) return;
      const analysis = await held(analyses, req.selection.root);
      if (!session.accept(req, analysis, unsaved)) return;
      ui.files = pathsOf(analysis);
      ui.problem = null;
      const presentation = session.beginInitialPresentation(req);
      if (presentation === null) return;
      if (analysis.status !== "loaded") {
        session.finishInitialPresentation(presentation, "configuration-failed");
        return;
      }
      const first = firstOpenableSource(analysis);
      if (!first) {
        session.finishInitialPresentation(presentation, "no-openable-source");
        return;
      }
      const path = openablePath(analysis.root, first);
      // Its own guard: a file that cannot be read is worth reporting, but it does
      // not unmake the project that was just accepted.
      try {
        const text = await held(reads, path);
        if (!session.finishInitialPresentation(presentation, "shown")) return;
        ui.opened = { path, text };
      } catch (err) {
        if (session.finishInitialPresentation(presentation, "failed"))
          ui.problem = String(err);
      }
    } catch (err) {
      // The real guard, not a mirror of it: failAnalysis() decides, so a failure
      // belonging to a project the user has left changes nothing.
      if (!session.failAnalysis(req, err)) return;
      if (session.loaded() === null) ui.files = [];
      ui.problem = String(err);
    } finally {
      // Reached from every exit above, including the early returns for a
      // superseded response: finishAnalysis() says false for one that is no
      // longer current, so it cannot announce a newer load as done.
      if (session.finishAnalysis(req)) {
        ui.canCreateRule = session.isOpen() && !session.isLoading();
      }
    }
  }

  return {
    ui,
    session,
    analyses,
    reads,
    loaded,
    edit: () => {
      unsaved = true;
      session.markStale();
    },
    saved: () => {
      unsaved = false;
    },

    async openFolder(dir) {
      // Everything that cannot fail goes first: the project changes, anything in
      // flight is superseded, and the UI lands in the state an unloaded project
      // has. Only then is a fallible await reached.
      const sel = session.open(dir);
      operations.begin(dir); // switching projects supersedes compilations
      const reset = operations.requestReset();
      ui.dir = dir;
      ui.files = [];
      ui.problem = null;
      ui.canCreateRule = false;
      const req = session.beginAnalysis(sel, true);
      await runAnalysis(req, reset);
    },

    async refresh() {
      const sel = session.selection();
      if (sel === null) return;
      const req = session.beginAnalysis(sel, false);
      if (req === null) return;
      await runAnalysis(req, null);
    },

    close() {
      session.close();
      operations.begin(null);
      ui.dir = null;
      ui.files = [];
      ui.opened = null;
      ui.problem = null;
      ui.canCreateRule = false;
    },

    // New Rule reduced to its guard and the one effect that matters here: it
    // changes the project, which is what a load landing afterwards would undo.
    newRule(name) {
      if (!session.isOpen() || session.isLoading()) return { created: false };
      ui.files = [...ui.files, name];
      ui.opened = { path: name, text: "" };
      return { created: true };
    },

    // Reduced to what matters here: a compile begins an operation and crosses the
    // reset barrier, and touches the project load not at all.
    async compile() {
      const op = operations.begin(session.root());
      await operations.settle();
      return { compiled: operations.isCurrent(op, session.root()) };
    },
  };
}

test("an analysis that lands after another folder was accepted cannot replace its files", async () => {
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  assert.deepEqual(
    h.analyses.map((c) => c.key),
    ["/a"],
    "A is waiting on its analysis",
  );

  const b = h.openFolder("/b");
  await drained();

  // B's analysis lands first and A's second, which is the whole point: A cannot
  // be relied on to finish first just because it started first.
  h.analyses[1].resolve(loaded("/b", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule b {}");
  h.analyses[0].resolve(loaded("/a", ["stale.yar"]));
  await Promise.all([a, b]);

  assert.equal(h.ui.dir, "/b");
  assert.deepEqual(h.ui.files, ["/b/main.yar"]);
  assert.deepEqual(h.ui.opened, { path: "/b/main.yar", text: "rule b {}" });
  assert.deepEqual(
    h.reads.map((c) => c.key),
    ["/b/main.yar"],
    "and A never even asked to read a file",
  );
});

test("a catch-up accepted before the initial response auto-opens through the LSP owner exactly once", async () => {
  const h = app();
  const opening = h.openFolder("/project");
  await drained();
  const catchUp = h.refresh();
  await drained();

  // B is the first accepted snapshot. It is not the request marked initial, but
  // it owns this selection's initial presentation and starts the only read.
  h.analyses[1].resolve(loaded("/project", ["main.yar"]));
  await drained();
  assert.deepEqual(h.reads.map((call) => call.key), ["/project/main.yar"]);
  h.reads[0].resolve("rule current {}");
  await catchUp;

  // A lands later and loses view order. It cannot start a second document open.
  h.analyses[0].resolve(loaded("/project", ["main.yar"]));
  await opening;
  assert.deepEqual(h.reads.map((call) => call.key), ["/project/main.yar"]);
  assert.deepEqual(h.ui.opened, {
    path: "/project/main.yar",
    text: "rule current {}",
  });
});

test("a first-file read that lands after another folder was accepted cannot open in it", async () => {
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  assert.deepEqual(
    h.reads.map((c) => c.key),
    ["/a/main.yar"],
    "A got as far as reading its first file",
  );

  const b = h.openFolder("/b");
  await drained();
  h.analyses[1].resolve(loaded("/b", [])); // B has no rule files
  await drained();

  h.reads[0].resolve("rule a {}"); // A's read, far too late
  await Promise.all([a, b]);

  assert.equal(h.ui.dir, "/b");
  assert.equal(h.ui.opened, null, "nothing was opened in B's workspace");
  assert.deepEqual(h.ui.files, []);
});

test("a load that fails after another folder was accepted reports nothing", async () => {
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  const b = h.openFolder("/b");
  await drained();

  h.analyses[1].resolve(loaded("/b", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule b {}");
  await drained();

  h.analyses[0].reject(new Error("permission denied"));
  await Promise.all([a, b]);

  assert.deepEqual(h.ui.files, ["/b/main.yar"], "B's files are untouched");
  assert.equal(h.ui.problem, null, "and A's failure is not shown beside them");
  assert.equal(h.session.failure(), null, "nor recorded against B");
  assert.deepEqual(h.ui.opened, { path: "/b/main.yar", text: "rule b {}" });
});

test("a current load's failure is still reported", async () => {
  // The guard must not turn the failure path off: an empty project and the error
  // in the Problems pane is the existing behaviour, and it is right.
  const h = app();
  const a = h.openFolder("/a");
  await drained();

  h.analyses[0].reject(new Error("permission denied"));
  await a;

  assert.deepEqual(h.ui.files, []);
  assert.match(h.ui.problem, /permission denied/);
});

test("reopening the same folder supersedes the load already running", async () => {
  // Comparing paths cannot tell these two apart, which is why selections are
  // counted.
  const h = app();
  const first = h.openFolder("/a");
  await drained();
  const second = h.openFolder("/a");
  await drained();

  h.analyses[1].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule fresh {}");
  h.analyses[0].resolve(loaded("/a", ["stale.yar", "gone.yar"]));
  await Promise.all([first, second]);

  assert.deepEqual(h.ui.files, ["/a/main.yar"]);
  assert.deepEqual(h.ui.opened, { path: "/a/main.yar", text: "rule fresh {}" });
});

test("a compile started while the project is loading does not cancel the load", async () => {
  // Why the two tokens are separate. Compiling the folder that is still analysing
  // is legitimate - the backend reads the directory itself - and one shared
  // counter would have the compile cancel the load and the load cancel the
  // compile.
  const h = app();
  const a = h.openFolder("/a");
  await drained();

  const compiling = h.compile();
  await drained();

  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  const [, compiled] = await Promise.all([a, compiling]);

  assert.deepEqual(h.ui.files, ["/a/main.yar"], "the load ran to completion");
  assert.deepEqual(h.ui.opened, { path: "/a/main.yar", text: "rule a {}" });
  assert.equal(compiled.compiled, true, "and the compile was not cancelled either");
});

// ---- New Rule against a project that is still loading ----
// Every one of these is the same bug from a different side: a rule created during
// the load, which the analysis in flight does not contain and whose document the
// load's auto-open then pushes out of the editor.

test("New Rule is unavailable while the project's analysis is outstanding", async () => {
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  assert.deepEqual(
    h.analyses.map((c) => c.key),
    ["/a"],
    "the analysis is what is outstanding",
  );

  assert.equal(h.ui.canCreateRule, false, "so the button and the menu item say no");
  assert.deepEqual(h.newRule("/a/new.yar"), { created: false }, "and so does the guard");

  h.analyses[0].resolve(loaded("/a", []));
  await a;
  assert.deepEqual(h.ui.files, [], "nothing was created behind the load's back");
});

test("New Rule is unavailable while the first-file read is outstanding", async () => {
  // The load is two awaits deep here, and the read is the step that would steal
  // focus from a document New Rule had just opened.
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  assert.deepEqual(
    h.reads.map((c) => c.key),
    ["/a/main.yar"],
    "the read is what is outstanding",
  );

  assert.equal(h.ui.canCreateRule, false);
  assert.deepEqual(h.newRule("/a/new.yar"), { created: false });

  h.reads[0].resolve("rule a {}");
  await a;
  assert.deepEqual(h.ui.files, ["/a/main.yar"]);
  assert.deepEqual(h.ui.opened, { path: "/a/main.yar", text: "rule a {}" });
});

test("a stale load finishing cannot make New Rule available during the newer load", async () => {
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  const b = h.openFolder("/b");
  await drained();

  // A runs all the way to its end - an empty project, so no read - after B has
  // taken over. Its cleanup runs; B's loading state is not its to clear.
  h.analyses[0].resolve(loaded("/a", []));
  await a;

  assert.equal(h.ui.canCreateRule, false, "B is still analysing");
  assert.deepEqual(h.newRule("/b/new.yar"), { created: false });

  h.analyses[1].resolve(loaded("/b", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule b {}");
  await b;

  assert.equal(h.ui.canCreateRule, true, "and B re-enables it when B is done");
  assert.deepEqual(h.ui.files, ["/b/main.yar"]);
});

test("New Rule becomes available once the current load succeeds", async () => {
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  await a;

  assert.equal(h.ui.canCreateRule, true);
  assert.deepEqual(h.newRule("/a/new.yar"), { created: true });
  assert.deepEqual(h.ui.files, ["/a/main.yar", "/a/new.yar"]);
  assert.deepEqual(h.ui.opened, { path: "/a/new.yar", text: "" }, "and it keeps the editor");
});

test("New Rule becomes available once the current load fails", async () => {
  // A failed load leaves a project the user is entitled to put a rule in - the
  // whole point of not gating this on success.
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  h.analyses[0].reject(new Error("permission denied"));
  await a;

  assert.match(h.ui.problem, /permission denied/);
  assert.equal(h.ui.canCreateRule, true);
  assert.deepEqual(h.newRule("/a/new.yar"), { created: true });
  assert.deepEqual(h.ui.files, ["/a/new.yar"]);
});

test("Compile stays available while the project is loading, though New Rule does not", async () => {
  // The two commands are treated differently on purpose, so assert both halves
  // together: making New Rule wait must not have made Compile wait with it.
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  assert.equal(h.ui.canCreateRule, false);

  const compiled = await h.compile();
  assert.equal(compiled.compiled, true, "the compile crossed the barrier and stands");
  assert.equal(h.ui.canCreateRule, false, "and it did not end the load on its way past");

  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  await a;
  assert.equal(h.ui.canCreateRule, true);
});

// ---- Refreshes ----

test("an older refresh cannot replace a newer one", async () => {
  // Two refreshes of the same project, answered out of order. Nothing about the
  // responses says which is which; the request's position does.
  const h = app();
  const open = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  await open;

  const older = h.refresh();
  await drained();
  const newer = h.refresh();
  await drained();

  h.analyses[2].resolve(loaded("/a", ["main.yar", "newest.yar"]));
  await drained();
  h.analyses[1].resolve(loaded("/a", ["main.yar", "older.yar"]));
  await Promise.all([older, newer]);

  assert.deepEqual(h.ui.files, ["/a/main.yar", "/a/newest.yar"]);
  assert.equal(h.session.isRefreshing(), false, "and both refreshes are accounted for");
});

test("a refresh does not gate New Rule the way the initial load does", async () => {
  const h = app();
  const open = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  await open;

  const refreshing = h.refresh();
  await drained();
  assert.equal(h.session.isRefreshing(), true);
  assert.equal(h.session.isLoading(), false, "the project is known; only its structure is being rechecked");
  assert.equal(h.ui.canCreateRule, true);

  h.analyses[1].resolve(loaded("/a", ["main.yar"]));
  await refreshing;
  assert.equal(h.session.isRefreshing(), false);
});

test("a refresh that fails leaves the project it could not refresh in place", async () => {
  // The snapshot is the last answer that arrived, and it is still the best
  // available description of the project. Wiping it would replace something
  // mostly true with nothing at all - and turn an infrastructure failure into an
  // empty project.
  const h = app();
  const open = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  await open;

  const refreshing = h.refresh();
  await drained();
  h.analyses[1].reject(new Error("backend gone"));
  await refreshing;

  assert.deepEqual(h.ui.files, ["/a/main.yar"], "still shown");
  assert.equal(h.session.phase(), "ready", "and still a project");
  assert.match(String(h.session.failure()), /backend gone/, "with the failure recorded beside it");
  assert.equal(h.session.isStale(), true, "and no longer trusted to be current");
});

test("a failed refresh belonging to a folder the user has left is dropped", async () => {
  const h = app();
  const open = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  await open;

  const refreshing = h.refresh();
  await drained();
  const reopened = h.openFolder("/b");
  await drained();
  h.analyses[2].resolve(loaded("/b", ["b.yar"]));
  await drained();
  h.reads[1].resolve("rule b {}");
  h.analyses[1].reject(new Error("permission denied"));
  await Promise.all([refreshing, reopened]);

  assert.deepEqual(h.ui.files, ["/b/b.yar"]);
  assert.equal(h.ui.problem, null);
  assert.equal(h.session.failure(), null, "B's Problems pane is not A's to write");
});

// ---- Staleness ----

test("an edit during an analysis leaves its result stale on arrival", async () => {
  // The backend read the files before the edit. Presenting the answer as current
  // would tell the user the structure reflects what they have just typed.
  const h = app();
  const open = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  await open;
  assert.equal(h.session.isStale(), false);

  const refreshing = h.refresh();
  await drained();
  h.edit(); // the user types while the analysis is outstanding
  h.analyses[1].resolve(loaded("/a", ["main.yar"]));
  await refreshing;

  assert.equal(h.session.isStale(), true);
});

test("saving and refreshing is what makes a project current again", async () => {
  const h = app();
  const open = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  await open;

  h.edit();
  assert.equal(h.session.isStale(), true);

  h.saved();
  const refreshing = h.refresh();
  await drained();
  h.analyses[1].resolve(loaded("/a", ["main.yar"]));
  await refreshing;

  assert.equal(h.session.isStale(), false, "the disk and the snapshot agree again");
});

test("a snapshot accepted while a document is unsaved is stale immediately", async () => {
  // The refresh read the file as it is on disk, and the editor holds something
  // else. Nothing was edited during the analysis, so the epoch alone would call
  // this current.
  const h = app();
  const open = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  await open;

  h.edit();
  const refreshing = h.refresh(); // the document is still dirty
  await drained();
  h.analyses[1].resolve(loaded("/a", ["main.yar"]));
  await refreshing;

  assert.equal(h.session.isStale(), true);
});

// ---- Closing ----

test("closing supersedes an outstanding load", async () => {
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  h.close();

  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await a;

  assert.equal(h.session.phase(), "closed");
  assert.equal(h.session.analysis(), null);
  assert.deepEqual(h.ui.files, [], "the closed workspace was not repopulated");
  assert.equal(h.ui.opened, null);
  assert.deepEqual(h.reads, [], "and nothing was read on its behalf");
});

test("closing supersedes an outstanding refresh's failure too", async () => {
  const h = app();
  const open = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  await open;

  const refreshing = h.refresh();
  await drained();
  h.close();
  h.analyses[1].reject(new Error("permission denied"));
  await refreshing;

  assert.equal(h.session.phase(), "closed");
  assert.equal(h.session.failure(), null);
  assert.equal(h.ui.problem, null);
});

test("a reopened project is a new selection, not the closed one resumed", async () => {
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  h.close();
  const again = h.openFolder("/a");
  await drained();

  h.analyses[1].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule a {}");
  h.analyses[0].resolve(loaded("/a", ["from-before-the-close.yar"]));
  await Promise.all([a, again]);

  assert.deepEqual(h.ui.files, ["/a/main.yar"]);
});

// ---- The three answers ----

test("a configuration failure is an answer, not a failure", async () => {
  // No graph can exist, and the issue says why. That is a project the UI has to
  // show - not an empty one, and not an analysis that could not be performed.
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  h.analyses[0].resolve(configurationFailed());
  await a;

  assert.equal(h.session.phase(), "ready");
  assert.equal(h.session.analysis().status, "configurationFailed");
  assert.equal(h.session.loaded(), null, "there is no snapshot to render a tree from");
  assert.equal(h.session.failure(), null, "and nothing went wrong with the analysis itself");
  assert.equal(h.ui.problem, null);
  assert.equal(h.ui.canCreateRule, true, "a rule can still be added to it");
});

test("an analysis that could not be performed is not an empty project", async () => {
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  h.analyses[0].reject(new Error("IPC dropped"));
  await a;

  assert.equal(h.session.phase(), "failed");
  assert.equal(h.session.analysis(), null, "no snapshot, rather than an empty one");
  assert.match(String(h.session.failure()), /IPC dropped/);
  assert.equal(h.session.isOpen(), true, "the project is open, it just could not be read");
});

test("a later success clears an earlier failure", async () => {
  const h = app();
  const a = h.openFolder("/a");
  await drained();
  h.analyses[0].reject(new Error("IPC dropped"));
  await a;

  const refreshing = h.refresh();
  await drained();
  h.analyses[1].resolve(loaded("/a", ["main.yar"]));
  await drained();
  h.reads[0].resolve("rule recovered {}");
  await refreshing;

  assert.equal(h.session.phase(), "ready");
  assert.equal(h.session.failure(), null);
  assert.deepEqual(h.ui.files, ["/a/main.yar"]);
});

// ---- Membership ----

test("membership covers both spellings of the root and external sources as they are", () => {
  // The picker's path and the canonical root can differ - a symlink on the way in -
  // and a document key may have come from either. This is a membership test, so
  // only exact keys can match.
  const session = new ProjectSession();
  const sel = session.open("/link/rules");
  const req = session.beginAnalysis(sel, true);
  const external = { external: true, path: "/opt/shared/lib.yar" };
  session.accept(
    req,
    loaded("/real/rules", ["main.yar", "sub/dep.yar"], {
      nodes: [
        { id: { external: false, path: "main.yar" }, readable: true },
        { id: { external: false, path: "sub/dep.yar" }, readable: true },
        { id: external, readable: true },
      ],
    }),
    false,
  );

  assert.equal(session.isMember("/real/rules/main.yar"), true);
  assert.equal(session.isMember("/link/rules/main.yar"), true);
  assert.equal(session.isMember("/real/rules/sub/dep.yar"), true);
  assert.equal(session.isMember("/opt/shared/lib.yar"), true, "external, from the graph");
  assert.equal(session.isMember("/elsewhere/main.yar"), false);

  assert.deepEqual(session.sourceAt("/link/rules/main.yar"), { external: false, path: "main.yar" });
  assert.deepEqual(session.sourceAt("/opt/shared/lib.yar"), external);
  assert.equal(session.sourceAt("/opt/shared/lib.yar").external, true, "and it stays external");
  assert.equal(session.sourceAt("/nope.yar"), null);
});

test("membership is empty when there is no snapshot to derive it from", () => {
  const session = new ProjectSession();
  assert.equal(session.isMember("/a/main.yar"), false);

  const sel = session.open("/a");
  const req = session.beginAnalysis(sel, true);
  session.failAnalysis(req, new Error("IPC dropped"));
  assert.equal(session.isMember("/a/main.yar"), false, "a failure names no members");

  session.accept(session.beginAnalysis(sel, false), configurationFailed(), false);
  assert.equal(session.isMember("/a/main.yar"), false, "nor does a broken configuration");
});

test("memberPathsOf answers for an analysis the session has not accepted", () => {
  // Needed before accepting: whether a document of THIS analysis is unsaved is
  // what decides that the snapshot arrives stale.
  const analysis = loaded("/real/rules", ["main.yar"]);
  assert.deepEqual(
    [...memberPathsOf(analysis, "/link/rules")].sort(),
    ["/link/rules/main.yar", "/real/rules/main.yar"],
  );
  assert.deepEqual([...memberPathsOf(configurationFailed(), "/a")], []);
});

test("sources cover the graph as well as discovery, without duplicates", () => {
  // A declared entrypoint outside discovery and an external dependency are graph
  // nodes and nothing else; a discovered file is both.
  const declared = { external: false, path: "elsewhere/entry.yar" };
  const external = { external: true, path: "/opt/lib.yar" };
  const analysis = loaded("/a", ["main.yar"], {
    nodes: [
      { id: { external: false, path: "main.yar" }, readable: true },
      { id: declared, readable: false },
      { id: external, readable: true },
    ],
  });
  assert.deepEqual(sourcesOf(analysis), [{ external: false, path: "main.yar" }, declared, external]);
});

test("the file to open first is the first readable one", () => {
  const unreadable = { external: false, path: "aaa-locked.yar" };
  const readable = { external: false, path: "bbb-fine.yar" };
  const analysis = loaded("/a", [], {
    discovered: [unreadable, readable],
    nodes: [
      { id: unreadable, readable: false },
      { id: readable, readable: true },
    ],
  });
  assert.deepEqual(firstOpenableSource(analysis), readable);

  assert.equal(firstOpenableSource(loaded("/a", [])), null, "an empty project opens nothing");
  assert.equal(
    firstOpenableSource(
      loaded("/a", [], { discovered: [unreadable], nodes: [{ id: unreadable, readable: false }] }),
    ),
    null,
    "and neither does one whose only file cannot be read",
  );
});
