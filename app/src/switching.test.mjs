// Tests for leaving one project for another, and for saving a document while that
// can happen underneath the save.
//
// Run with `npm test`. Opening a folder and closing the workspace are the same
// transition: the project on screen stops being the project, and its documents stop
// being anything the window shows or may write to. A switch that skips the second
// half leaves the previous project's files open and dirty - saveable, counted by the
// next compile's save plan, and attributed to a folder that is no longer open - so
// the cases below check that a switch does everything a close does, and that
// declining one does nothing at all.
//
// The save cases are the other side of the same problem: a write is asynchronous,
// and by the time it lands the document may have been edited, renamed, closed, or
// replaced by another project's file of the same name. What reached the disk is the
// revision captured before the write, and that is what may be marked clean.
//
// The session, the operation tokens, the documents and the compile's save plan are
// the real modules. What is mirrored here is main.ts's ordering around them - the
// confirmation, the infallible prologue, the checks after every await - and the
// Monaco/LSP side of editor.ts. No clocks, no DOM, no backend: every analysis, read
// and write is a promise the test resolves by hand.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DocumentSet } from "./documents.ts";
import { Navigation } from "./navigation.ts";
import { ProjectSession, firstOpenableSource, memberPathsOf } from "./project.ts";
import { Operations } from "./operations.ts";
import { saveDirtyMembers } from "./saveplan.ts";
import { basename, openablePath } from "./sourceid.ts";

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

// A list of calls the test resolves by hand. `take()` hands over the oldest one
// that has not been dealt with, so a test never has to count indices.
function calls() {
  const list = [];
  return {
    keys: () => list.map((c) => c.key),
    pending: () => list.filter((c) => !c.taken).length,
    hold(info) {
      const d = deferred();
      list.push({ ...info, resolve: d.resolve, reject: d.reject, taken: false });
      return d.promise;
    },
    take() {
      const call = list.find((c) => !c.taken);
      assert.ok(call, "a call was expected to be waiting");
      call.taken = true;
      return call;
    },
  };
}

// A stand-in for a Monaco text model: the two methods the bookkeeping uses, plus
// the test's handle on editing it. Version ids only ever move forward here; undo
// is documents.test.mjs's business.
function model(text) {
  let value = text;
  let version = 1;
  return {
    getValue: () => value,
    getAlternativeVersionId: () => version,
    edit(next) {
      value = next;
      version += 1;
    },
  };
}

// A `loaded` analysis of `root` containing `names`, all readable and unconnected.
function loaded(root, names) {
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
  };
}

// main.ts's project transitions and its two save paths, with the DOM and IPC
// removed and the ordering kept.
function app() {
  const session = new ProjectSession();
  // Real reset barrier. The reset itself succeeds and does nothing, because these
  // cases are about documents and the compile lifecycle has its own tests - until a
  // test replaces it (setReset below) to hold one open or fail it.
  let resetImpl = async () => {};
  const operations = new Operations(() => resetImpl());
  const docs = new DocumentSet();
  const analyses = calls();
  const reads = calls();
  const writes = calls();
  // The LSP and Monaco sides of closing a document: what was announced as closed,
  // and what was destroyed. Nothing may be written to a model in either list.
  const lsp = { closed: [] };
  const disposed = [];
  const prompts = [];
  let answer = true;
  // Everything a stale response could corrupt, so a test can assert that all of it
  // still describes the project the user chose last.
  const ui = { dir: null, problems: null, build: "not-compiled", active: null, refreshes: 0 };

  // editor.ts, minus Monaco: the DocumentSet is the real one, and this is the
  // adapter around it.
  const editor = {
    openScratch() {
      docs.ensure("", () => model("the scratch buffer"));
      setActive("");
    },
    openFile(path, text) {
      docs.ensure(path, () => model(text));
      setActive(path);
    },
    activate(key) {
      if (docs.has(key)) setActive(key);
    },
    closeFiles() {
      for (const key of docs.keys()) {
        if (key === "") continue; // the scratch buffer is not a file
        const closed = docs.remove(key);
        lsp.closed.push(closed);
        disposed.push(closed);
      }
      if (ui.active !== null && !docs.has(ui.active)) setActive(docs.has("") ? "" : null);
    },
  };

  // Every activation announces itself, exactly as main.ts hooks the workspace's
  // active-document callback up to navigation.activated().
  function setActive(key) {
    ui.active = key;
    navigation.activated();
  }

  const dirtyDocuments = () => docs.dirtyKeys().filter((key) => key !== "");
  const stillSelected = (sel) => (sel === null ? !session.isOpen() : session.isCurrent(sel));

  // The real scoped navigation: the auto-open below is the one main.ts performs, so
  // that a switch during it is decided by the same code rather than by a copy of it.
  // Its own cases are navigation.test.mjs's.
  const navigation = new Navigation({
    selection: () => session.selection(),
    isSelected: stillSelected,
    analysis: () => session.analysis(),
    isOpen: (path) => docs.has(path),
    activeKey: () => ui.active,
    textOf: (path) => docs.textOf(path),
    read: (path) => reads.hold({ key: path }),
    open: (path, text) => editor.openFile(path, text),
    activate: (path) => editor.activate(path),
    fail: (err) => {
      ui.problems = String(err);
    },
  });

  // Synchronous here, and only here: the real one is a native dialogue and so an
  // await, and what that await lets interleave is authorising.test.mjs's subject.
  // These cases are about what the answer then does, so they answer immediately.
  function confirmDiscardingUnsaved(action) {
    const dirty = dirtyDocuments();
    if (dirty.length === 0) return true;
    prompts.push(`${action} and discard unsaved changes to ${dirty.map(basename).join(", ")}?`);
    return answer;
  }

  // The infallible half of leaving a project, shared by both commands.
  function leaveProject(dirLabel) {
    ui.dir = dirLabel;
    ui.build = "not-compiled";
    ui.problems = null;
    editor.openScratch();
    editor.closeFiles();
  }

  async function runAnalysis(req, reset) {
    const root = req.selection.root;
    try {
      if (reset !== null) await reset;
      if (!session.isCurrent(req.selection)) return;
      const analysis = await analyses.hold({ key: root });
      const members = memberPathsOf(analysis, root);
      const unsaved = dirtyDocuments().some((key) => members.has(key));
      if (!session.accept(req, analysis, unsaved)) return;
      if (!req.initial || analysis.status !== "loaded") return;
      const first = firstOpenableSource(analysis);
      if (first === null) return;
      await navigation.autoOpen(req.selection, analysis, openablePath(analysis.root, first));
    } catch (err) {
      if (!session.failAnalysis(req, err)) return;
      ui.problems = String(err);
    } finally {
      session.finishAnalysis(req);
    }
  }

  async function openFolder(dir) {
    // Before anything is superseded or cleared, so declining changes nothing.
    if (!confirmDiscardingUnsaved("Open another folder")) return false;
    const selection = session.open(dir);
    operations.begin(dir);
    const reset = operations.requestReset();
    leaveProject(dir);
    const req = session.beginAnalysis(selection, true);
    if (req === null) return true;
    await runAnalysis(req, reset);
    return true;
  }

  async function closeWorkspace() {
    if (!session.isOpen()) return false;
    if (!confirmDiscardingUnsaved("Close the workspace")) return false;
    session.close();
    const op = operations.begin(session.root());
    const reset = operations.requestReset();
    leaveProject("No folder open");
    try {
      await reset;
    } catch (err) {
      // Only while this close still owns the ruleset: a folder opened while the
      // reset was outstanding has a Problems pane of its own, and the barrier holds
      // on to the rejection either way.
      if (operations.isCurrent(op, session.root())) ui.problems = String(err);
    }
    return true;
  }

  async function saveActive() {
    const key = ui.active;
    if (key === null || key === "") return;
    const snapshot = docs.beginSave(key);
    if (snapshot === null) return;
    const selection = session.selection();
    try {
      await writes.hold({ key: snapshot.key, text: snapshot.text });
    } catch (err) {
      if (stillSelected(selection)) ui.problems = String(err);
      return;
    }
    if (!stillSelected(selection)) return;
    docs.completeSave(snapshot);
    // The refresh itself is project.test.mjs's; what matters here is that it is
    // scoped to the selection that started the save.
    if (selection !== null) ui.refreshes += 1;
  }

  // compileWorkspace()'s auto-save, over the real save plan.
  async function compileSave() {
    const op = operations.begin(session.root());
    const root = session.root();
    return await saveDirtyMembers(dirtyDocuments(), new Set(session.memberIds().keys()), {
      members: async () => memberPathsOf(await analyses.hold({ key: root }), root),
      save: async (key) => {
        const snapshot = docs.beginSave(key);
        // Not a document to move on from: whatever the plan named is no longer open at
        // that path, so nothing may compile as though its text were on disk.
        if (snapshot === null) return { kind: "refused", why: `${key} is no longer open` };
        await writes.hold({ key: snapshot.key, text: snapshot.text });
        docs.completeSave(snapshot);
        return { kind: "written" };
      },
      superseded: () => !operations.isCurrent(op, session.root()),
    });
  }

  return {
    ui,
    session,
    operations,
    docs,
    analyses,
    reads,
    writes,
    lsp,
    disposed,
    prompts,
    openFolder,
    closeWorkspace,
    saveActive,
    compileSave,
    setConfirm: (value) => {
      answer = value;
    },
    // Replaces the ruleset reset the barrier performs, for the cases that need one
    // to be outstanding across a transition.
    setReset: (fn) => {
      resetImpl = fn;
    },
    edit(path, text) {
      const m = docs.model(path);
      assert.ok(m, `${path} is open`);
      m.edit(text);
    },

    // Opens a folder and lets it finish, resolving the analysis and the first
    // file's read. The interleavings are project.test.mjs's business; this is how
    // the cases below reach a loaded project.
    async load(dir, names, contents = {}) {
      const opening = openFolder(dir);
      await drained();
      analyses.take().resolve(loaded(dir, names));
      await drained();
      if (reads.pending() > 0) {
        const read = reads.take();
        read.resolve(contents[read.key] ?? `rule ${basename(read.key)} {}`);
      }
      await opening;
    },
  };
}

// ---- Switching project ----

test("cancelling a switch with dirty documents changes nothing at all", async () => {
  const h = app();
  await h.load("/a", ["main.yar"], { "/a/main.yar": "rule a {}" });
  h.edit("/a/main.yar", "unsaved work");
  const before = h.session.selection();
  // A compiled ruleset, and an operation that owns it: a cancelled switch must not
  // supersede either.
  h.ui.build = "compiled";
  const op = h.operations.begin("/a");

  h.setConfirm(false);
  assert.equal(await h.openFolder("/b"), false);

  assert.deepEqual(h.prompts, [
    "Open another folder and discard unsaved changes to main.yar?",
  ]);
  assert.equal(h.session.selection(), before, "the same selection, not a new one");
  assert.equal(h.ui.dir, "/a");
  assert.equal(h.ui.build, "compiled");
  assert.deepEqual(h.docs.keys(), ["", "/a/main.yar"]);
  assert.equal(h.docs.textOf("/a/main.yar"), "unsaved work");
  assert.equal(h.docs.isDirty("/a/main.yar"), true);
  assert.deepEqual(h.lsp.closed, [], "no model was announced as closed");
  assert.deepEqual(h.disposed, [], "and none was destroyed");
  assert.equal(h.analyses.pending(), 0, "the other folder was never analysed");
  assert.equal(h.operations.isCurrent(op, h.session.root()), true, "the compile still owns the ruleset");
});

test("a switch with clean documents does not ask, and still closes them", async () => {
  const h = app();
  await h.load("/a", ["main.yar"]);
  const wasOpen = h.docs.model("/a/main.yar");

  await h.load("/b", ["b.yar"]);

  assert.deepEqual(h.prompts, [], "nothing was unsaved, so there was nothing to ask about");
  assert.equal(h.ui.dir, "/b");
  assert.deepEqual(h.docs.keys(), ["", "/b/b.yar"], "A's document is gone, B's is open");
  assert.deepEqual(h.lsp.closed, [wasOpen]);
  assert.deepEqual(h.disposed, [wasOpen]);
  assert.equal(h.ui.active, "/b/b.yar");
});

test("an accepted switch discards the dirty documents rather than writing them", async () => {
  const h = app();
  await h.load("/a", ["main.yar"], { "/a/main.yar": "rule a {}" });
  h.edit("/a/main.yar", "unsaved work");
  const discarded = h.docs.model("/a/main.yar");

  h.setConfirm(true);
  await h.load("/b", ["b.yar"]);

  assert.equal(h.prompts.length, 1, "the user was asked");
  assert.equal(h.writes.pending(), 0, "discarding is not saving: nothing was written");
  assert.deepEqual(h.lsp.closed, [discarded]);
  assert.deepEqual(h.docs.dirtyKeys(), [], "and nothing is left claiming to be unsaved");
  assert.equal(h.ui.dir, "/b");
});

test("re-opening the folder already open is a switch too", async () => {
  const h = app();
  await h.load("/a", ["main.yar"], { "/a/main.yar": "on disk" });
  h.edit("/a/main.yar", "unsaved work");
  const first = h.session.selection();
  const firstModel = h.docs.model("/a/main.yar");

  h.setConfirm(true);
  // The same path, which no comparison of paths could tell from a no-op.
  await h.load("/a", ["main.yar"], { "/a/main.yar": "on disk" });

  assert.equal(h.prompts.length, 1, "the unsaved work was still unsaved work");
  assert.notEqual(h.session.selection(), first, "a new selection, so everything in flight was superseded");
  assert.deepEqual(h.lsp.closed, [firstModel], "the old model was closed, not reused");
  assert.notEqual(h.docs.model("/a/main.yar"), firstModel);
  assert.equal(h.docs.textOf("/a/main.yar"), "on disk", "the document was re-read from disk");
  assert.equal(h.docs.isDirty("/a/main.yar"), false);
});

test("a switch whose analysis fails leaves no document from the old project", async () => {
  const h = app();
  await h.load("/a", ["main.yar"]);
  const wasOpen = h.docs.model("/a/main.yar");

  const switching = h.openFolder("/b");
  await drained();
  // Before the analysis has even answered: A's documents are already gone, because
  // closing them is part of the prologue that cannot fail.
  assert.deepEqual(h.docs.keys(), [""]);
  assert.equal(h.ui.active, "");
  assert.deepEqual(h.lsp.closed, [wasOpen]);

  h.analyses.take().reject(new Error("analyze_project: backend not running"));
  await switching;

  assert.equal(h.session.phase(), "failed");
  assert.match(h.ui.problems, /backend not running/);
  assert.deepEqual(h.docs.keys(), [""], "and the failure did not bring A's document back");
  assert.equal(h.ui.dir, "/b");
});

test("closing the workspace and switching leave the documents in the same state", async () => {
  const closed = app();
  await closed.load("/a", ["main.yar"]);
  await closed.closeWorkspace();
  assert.deepEqual(closed.docs.keys(), [""]);
  assert.equal(closed.ui.active, "");
  assert.equal(closed.session.isOpen(), false);

  const switched = app();
  await switched.load("/a", ["main.yar"]);
  const switching = switched.openFolder("/b");
  await drained();
  // The same point in the transition: the project is gone and so are its
  // documents, whatever happens next.
  assert.deepEqual(switched.docs.keys(), [""]);
  assert.equal(switched.ui.active, "");
  switched.analyses.take().resolve(loaded("/b", []));
  await switching;
});

test("documents closed by a switch are out of the next project's save plan", async () => {
  const h = app();
  await h.load("/a", ["main.yar", "extra.yar"], {
    "/a/main.yar": "rule a {}",
  });
  // Two of A's documents open, both edited: the state that used to be carried into
  // the next project and written out by its first compile.
  h.edit("/a/main.yar", "unsaved main");
  h.docs.ensure("/a/extra.yar", () => model("rule extra {}"));
  h.edit("/a/extra.yar", "unsaved extra");
  const abandoned = [h.docs.model("/a/main.yar"), h.docs.model("/a/extra.yar")];
  assert.equal(h.docs.dirtyKeys().length, 2);

  h.setConfirm(true);
  await h.load("/b", ["b.yar"]);

  assert.deepEqual(h.lsp.closed, abandoned, "both were announced as closed, in order");
  assert.deepEqual(h.disposed, abandoned);
  assert.deepEqual(h.docs.dirtyKeys(), [], "no dirty-document query can see them");
  assert.equal(h.docs.isDirty("/a/main.yar"), false);

  // So B's compile has nothing to auto-save, and does not go looking for
  // membership either.
  assert.deepEqual(await h.compileSave(), { written: [], refused: null });
  assert.equal(h.writes.pending(), 0);
  assert.equal(h.analyses.pending(), 0);
});

// ---- A close whose ruleset reset fails ----

test("a close's failing reset is reported while the close is still what happened last", async () => {
  const h = app();
  await h.load("/a", ["main.yar"]);

  const failing = deferred();
  h.setReset(() => failing.promise);
  const closing = h.closeWorkspace();
  await drained();
  failing.reject(new Error("reset_rules failed"));

  assert.equal(await closing, true);
  assert.equal(h.ui.problems, "Error: reset_rules failed");
  // And the barrier is still holding it, so a compile cannot run on top of rules
  // that should have been dropped.
  await assert.rejects(h.operations.settle(), /reset_rules failed/);
});

test("a close's failing reset says nothing once another folder has opened", async () => {
  const h = app();
  await h.load("/a", ["main.yar"]);

  // The close's reset is held open: slow enough for the user to open a folder while
  // it is outstanding, which is the whole difficulty.
  const failing = deferred();
  h.setReset(() => failing.promise);
  const closing = h.closeWorkspace();
  await drained();
  assert.equal(h.session.isOpen(), false);

  // B's own reset is a separate request on the same chain, and succeeds.
  h.setReset(async () => {});
  const opening = h.openFolder("/b");
  await drained();
  assert.equal(h.ui.dir, "/b");
  // B is waiting behind the close's reset - that is the ordering the barrier exists
  // for - so nothing has been analysed yet.
  assert.equal(h.analyses.pending(), 0);

  failing.reject(new Error("reset_rules failed"));
  assert.equal(await closing, true);
  assert.equal(h.ui.problems, null, "A's failure is not B's to show, and did not clear B's pane");

  // B then loads normally, on a ruleset its own reset did drop.
  await drained();
  h.analyses.take().resolve(loaded("/b", ["b.yar"]));
  await drained();
  h.reads.take().resolve("rule b {}");
  assert.equal(await opening, true);
  assert.equal(h.ui.problems, null);
  assert.equal(h.ui.active, "/b/b.yar");
  await h.operations.settle();
});

// ---- Saving the revision that was written ----

test("a manual save writes the revision it captured and stays dirty for the rest", async () => {
  const h = app();
  await h.load("/a", ["main.yar"], { "/a/main.yar": "rule a {}" });
  h.edit("/a/main.yar", "rule a { condition: true }");

  const saving = h.saveActive();
  await drained();
  const write = h.writes.take();
  assert.equal(write.key, "/a/main.yar");
  assert.equal(write.text, "rule a { condition: true }");

  // The user keeps typing while the write is in flight.
  h.edit("/a/main.yar", "rule a { condition: false }");
  write.resolve();
  await saving;

  assert.equal(
    h.docs.isDirty("/a/main.yar"),
    true,
    "what was typed during the write is not on disk",
  );
  assert.equal(h.ui.refreshes, 1, "and the project was re-read after the save that did land");

  // The next save writes exactly that edit, and only then is the document clean.
  const again = h.saveActive();
  await drained();
  const second = h.writes.take();
  assert.equal(second.text, "rule a { condition: false }");
  second.resolve();
  await again;
  assert.equal(h.docs.isDirty("/a/main.yar"), false);
});

test("a compile's auto-save writes the revision it captured, not what it finds afterwards", async () => {
  const h = app();
  await h.load("/a", ["main.yar"], { "/a/main.yar": "rule a {}" });
  h.edit("/a/main.yar", "rule a { condition: true }");

  const compiling = h.compileSave();
  await drained();
  const write = h.writes.take();
  assert.equal(write.text, "rule a { condition: true }");

  // Typed while the compile's own write was in flight. The compile is about to
  // send the root to the backend, which reads the file as it is on disk - what was
  // written - so this edit is not part of that compilation.
  h.edit("/a/main.yar", "edited during the compile");
  write.resolve();

  assert.deepEqual(await compiling, { written: ["/a/main.yar"], refused: null });
  assert.equal(
    h.docs.isDirty("/a/main.yar"),
    true,
    "so the document is still dirty and the next compile writes it again",
  );
  assert.equal(
    h.analyses.pending(),
    0,
    "and the accepted snapshot already accounted for the document, so nothing was re-analysed",
  );
});

test("a save whose document the workspace closed under it marks nothing clean", async () => {
  const h = app();
  await h.load("/a", ["main.yar"]);
  h.edit("/a/main.yar", "unsaved work");

  const saving = h.saveActive();
  await drained();
  const write = h.writes.take();

  h.setConfirm(true);
  await h.closeWorkspace();
  assert.deepEqual(h.docs.keys(), [""]);

  write.resolve();
  await saving;

  assert.equal(h.ui.refreshes, 0, "there is no project left to re-read");
  assert.deepEqual(h.docs.keys(), [""], "and the save did not resurrect the document");
});

test("a save failure that arrives after a switch stays out of the new project's problems", async () => {
  const h = app();
  await h.load("/a", ["main.yar"]);
  h.edit("/a/main.yar", "unsaved work");

  const saving = h.saveActive();
  await drained();
  const write = h.writes.take();

  h.setConfirm(true);
  await h.load("/b", ["b.yar"]);
  assert.equal(h.ui.problems, null);

  write.reject(new Error("disk full"));
  await saving;

  assert.equal(
    h.ui.problems,
    null,
    "A's failure is not B's to report: the file it names is not even open here",
  );
  assert.equal(h.ui.dir, "/b");
  assert.equal(h.ui.refreshes, 0);
});

test("a save failure for the project still open is reported", async () => {
  const h = app();
  await h.load("/a", ["main.yar"]);
  h.edit("/a/main.yar", "unsaved work");

  const saving = h.saveActive();
  await drained();
  h.writes.take().reject(new Error("permission denied"));
  await saving;

  assert.match(h.ui.problems, /permission denied/);
  assert.equal(h.docs.isDirty("/a/main.yar"), true, "and the document is still unsaved");
  assert.equal(h.ui.refreshes, 0, "a failed save has nothing for the project to re-read");
});
