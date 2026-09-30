// Tests for the two ways into a project - Open Folder and Open Example - racing
// each other.
//
// Run with `npm test`. Both begin with an await the current project has to survive:
// the native directory picker in one case, copying a packaged example into an
// editable working copy in the other. Neither may abandon anything before it has an
// answer, so between the gesture and the switch the user can make another gesture -
// and nothing about the two answers says which was asked for first. A dismissed
// picker still returns a path; a slow copy still returns a root. Whichever landed
// last would otherwise win, and the project the user chose last would lose to
// whichever piece of I/O happened to be slower.
//
// So the cases below are about ordering and about what a losing or failing request
// is allowed to touch: nothing. The counted requests (opening.ts), the session, the
// operation tokens and the documents are the real modules; what is mirrored here is
// main.ts's shared transition - the currency check, the confirmation, the infallible
// prologue, the sample target - with the DOM and the IPC removed. No clocks and no
// backend: every picker, preparation, analysis and read is a promise the test
// resolves by hand.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DocumentSet } from "./documents.ts";
import { Navigation } from "./navigation.ts";
import { OpenRequests } from "./opening.ts";
import { ProjectSession, firstOpenableSource, memberPathsOf } from "./project.ts";
import { Operations } from "./operations.ts";
import { basename, openablePath } from "./sourceid.ts";

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

// A list of calls the test resolves by hand. `take()` hands over the oldest one that
// has not been dealt with, so a test never has to count indices.
function calls() {
  const list = [];
  return {
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

// A stand-in for a Monaco text model: the two methods the bookkeeping uses, plus the
// test's handle on editing it.
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

// What `prepare_example` answers: the working copy's root and the sample target read
// from inside it. The bytes are the test's marker for "this example's target".
function preparedExample(id, root, bytes) {
  return {
    id,
    name: id,
    description: `the ${id} example`,
    root,
    target: { path: `${root}/targets/sample.txt`, bytes },
  };
}

// main.ts's transition into a project, with the DOM and IPC removed and the ordering
// kept, reached by both commands exactly as it is there.
function app() {
  const session = new ProjectSession();
  const opens = new OpenRequests();
  const docs = new DocumentSet();
  const pickers = calls();
  const preparations = calls();
  const analyses = calls();
  const reads = calls();
  // The steps of the transition, in the order they happen. Two commands share one
  // implementation in main.ts; this is how the tests below say so.
  const trace = [];
  let resetImpl = async () => {
    trace.push("reset-ran");
  };
  const operations = new Operations(() => resetImpl());
  const prompts = [];
  let answer = true;
  // Everything a losing request could corrupt, so a test can assert that all of it
  // still describes what the user asked for last. `target` is the scan target area:
  // null for the textarea, or the file whose bytes are held.
  const ui = { dir: null, problems: null, build: "not-compiled", active: null, target: null };

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
        if (key === "") continue;
        docs.remove(key);
      }
      if (ui.active !== null && !docs.has(ui.active)) setActive(docs.has("") ? "" : null);
    },
  };

  function setActive(key) {
    ui.active = key;
    navigation.activated();
  }

  const dirtyDocuments = () => docs.dirtyKeys().filter((key) => key !== "");
  const stillSelected = (sel) => (sel === null ? !session.isOpen() : session.isCurrent(sel));

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
  // await. What that await lets interleave - a newer gesture, a changed at-risk set -
  // is authorising.test.mjs's subject; the ordering of the requests is this file's.
  function confirmDiscardingUnsaved(action) {
    trace.push("confirm");
    const dirty = dirtyDocuments();
    if (dirty.length === 0) return true;
    prompts.push(`${action} and discard unsaved changes to ${dirty.map(basename).join(", ")}?`);
    return answer;
  }

  function leaveProject(dirLabel) {
    trace.push("leave");
    ui.dir = dirLabel;
    ui.build = "not-compiled";
    ui.problems = null;
    editor.openScratch();
    editor.closeFiles();
  }

  // Choose file…, and an example's sample target, land in the same place.
  function setFileTarget(path, bytes) {
    trace.push("target");
    ui.target = { path, bytes };
  }

  async function runAnalysis(req, reset) {
    const root = req.selection.root;
    try {
      if (reset !== null) await reset;
      if (!session.isCurrent(req.selection)) return;
      trace.push("analyse");
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

  // The shared half: everything from "there is a root" onwards.
  async function enterProject(request, root, action, target) {
    if (!opens.isCurrent(request)) return;
    if (!confirmDiscardingUnsaved(action)) return;
    const selection = session.open(root);
    trace.push("select");
    operations.begin(root);
    trace.push("operation");
    const reset = operations.requestReset();
    trace.push("reset-requested");
    leaveProject(root);
    if (target !== null) setFileTarget(target.path, target.bytes);
    const req = session.beginAnalysis(selection, true);
    if (req === null) return;
    await runAnalysis(req, reset);
  }

  // The picker is held, so a test decides when - and in what order - it answers.
  async function openFolder() {
    const request = opens.begin();
    const dir = await pickers.hold({ key: "picker" });
    if (typeof dir !== "string") return;
    await enterProject(request, dir, "Open another folder", null);
  }

  // Rejects with what the chooser would show; resolves when there is nothing to
  // show, whether the example opened or a newer request took over.
  async function openExample(id) {
    const request = opens.begin();
    let prepared;
    try {
      prepared = await preparations.hold({ key: id });
    } catch (err) {
      if (opens.isCurrent(request)) throw err;
      return;
    }
    await enterProject(request, prepared.root, "Open an example", prepared.target);
  }

  async function closeWorkspace() {
    if (!session.isOpen()) return false;
    if (!confirmDiscardingUnsaved("Close the workspace")) return false;
    opens.cancel();
    session.close();
    operations.begin(null);
    const reset = operations.requestReset();
    leaveProject("No folder open");
    try {
      await reset;
    } catch {
      // Reported only while the close still owns the ruleset; switching.test.mjs
      // covers that, and nothing here fails a reset.
    }
    return true;
  }

  // Finishes a transition that has reached its analysis: the snapshot, then the
  // first file's read. The interleavings are project.test.mjs's business.
  async function settle(names, contents) {
    await drained();
    if (analyses.pending() === 0) return;
    const analysis = analyses.take();
    analysis.resolve(loaded(analysis.key, names));
    await drained();
    if (reads.pending() > 0) {
      const read = reads.take();
      read.resolve(contents?.[read.key] ?? `rule ${basename(read.key)} {}`);
    }
  }

  // The text each of `names` is read as, keyed the way the editor keys documents.
  function contents(names, root) {
    return Object.fromEntries(names.map((name) => [`${root}/${name}`, `rule ${name} {}`]));
  }

  return {
    ui,
    trace,
    session,
    operations,
    opens,
    docs,
    pickers,
    preparations,
    analyses,
    reads,
    prompts,
    openFolder,
    openExample,
    closeWorkspace,
    setFileTarget,
    setConfirm: (value) => {
      answer = value;
    },
    setReset: (fn) => {
      resetImpl = fn;
    },
    edit(path, text) {
      const m = docs.model(path);
      assert.ok(m, `${path} is open`);
      m.edit(text);
    },

    // Opens a folder the whole way, resolving the picker, the analysis and the read.
    async loadFolder(dir, names, contents) {
      const opening = openFolder();
      await drained();
      pickers.take().resolve(dir);
      await settle(names, contents);
      await opening;
    },

    // The same, for an example whose working copy materialises at `root`.
    async loadExample(id, root, names, bytes = [1, 2, 3]) {
      const opening = openExample(id);
      await drained();
      preparations.take().resolve(preparedExample(id, root, bytes));
      await settle(names, contents(names, root));
      await opening;
    },
  };

}

// ---- Gesture order, not completion order ----

test("the folder chosen last opens, whichever picker answers first", async () => {
  const h = app();
  const older = h.openFolder();
  await drained();
  // A second gesture while the first picker is still up. Nothing has been abandoned
  // yet - there is no project to abandon - but the first request is already spent.
  const newer = h.openFolder();
  await drained();
  const first = h.pickers.take();
  const second = h.pickers.take();

  // The NEWER picker answers first and opens, exactly as it should.
  second.resolve("/b");
  await drained();
  h.analyses.take().resolve(loaded("/b", ["b.yar"]));
  await drained();
  h.reads.take().resolve("rule b {}");
  await newer;
  const selection = h.session.selection();
  assert.equal(h.ui.dir, "/b");

  // And then the older one answers. It is not a late success, it is the folder the
  // user changed their mind about.
  first.resolve("/a");
  await older;

  assert.equal(h.ui.dir, "/b");
  assert.equal(h.session.selection(), selection, "the same selection, not a new one");
  assert.equal(h.analyses.pending(), 0, "/a was never analysed");
  assert.deepEqual(h.docs.keys(), ["", "/b/b.yar"]);
});

test("an example prepared after another folder has opened opens nothing and preloads nothing", async () => {
  const h = app();
  const example = h.openExample("basic-text-match");
  await drained();
  const preparation = h.preparations.take();

  // The user does not wait for the copy: they open a folder instead, and it lands
  // first.
  await h.loadFolder("/work", ["main.yar"]);
  const selection = h.session.selection();

  preparation.resolve(preparedExample("basic-text-match", "/data/basic", [7, 7, 7]));
  await example;

  assert.equal(h.ui.dir, "/work", "the working copy did not open over the folder");
  assert.equal(h.session.selection(), selection);
  assert.equal(h.ui.target, null, "and its sample target was not installed either");
  assert.equal(h.analyses.pending(), 0);
  assert.deepEqual(h.docs.keys(), ["", "/work/main.yar"]);
});

test("a preparation that fails after another open is not reported", async () => {
  const h = app();
  await h.loadFolder("/a", ["main.yar"]);
  const example = h.openExample("nested-includes");
  await drained();
  const preparation = h.preparations.take();

  await h.loadFolder("/b", ["b.yar"]);
  assert.equal(h.ui.problems, null);

  // The copy fails, for the request the user has already replaced. There is no
  // chooser waiting on it and the project on screen is not the one that failed to be
  // replaced, so it resolves with nothing to say.
  preparation.reject(new Error("resource examples/nested-includes not found"));
  await example;

  assert.equal(h.ui.problems, null, "a stale failure is nobody's to show");
  assert.equal(h.ui.dir, "/b");
});

// ---- A failure leaves the project that is open alone ----

test("a preparation that fails is reported to the chooser and changes nothing", async () => {
  const h = app();
  await h.loadFolder("/a", ["main.yar"], { "/a/main.yar": "rule a {}" });
  h.setFileTarget("/elsewhere/chosen.bin", [9]);
  h.ui.build = "compiled";
  const selection = h.session.selection();
  const op = h.operations.begin("/a");
  const openDocument = h.docs.model("/a/main.yar");

  const example = h.openExample("multiple-entrypoints");
  await drained();
  h.preparations.take().reject(new Error("permission denied"));

  // The chooser asked, so the chooser is told.
  await assert.rejects(example, /permission denied/);

  assert.equal(h.session.selection(), selection, "the project was never abandoned");
  assert.equal(h.ui.dir, "/a");
  assert.equal(h.ui.build, "compiled", "the compiled ruleset is still the ruleset");
  assert.equal(h.operations.isCurrent(op, h.session.root()), true, "and still owns it");
  assert.equal(h.ui.problems, null, "the failure did not land in the project's problems");
  assert.deepEqual(h.docs.keys(), ["", "/a/main.yar"]);
  assert.equal(h.docs.model("/a/main.yar"), openDocument, "no document was closed");
  assert.deepEqual(h.ui.target, { path: "/elsewhere/chosen.bin", bytes: [9] });
  assert.equal(h.ui.active, "/a/main.yar");
});

test("declining the unsaved-work prompt for an example changes nothing, the target included", async () => {
  const h = app();
  await h.loadFolder("/a", ["main.yar"], { "/a/main.yar": "rule a {}" });
  h.edit("/a/main.yar", "unsaved work");
  const selection = h.session.selection();
  h.ui.build = "compiled";
  const op = h.operations.begin("/a");

  h.setConfirm(false);
  const example = h.openExample("basic-text-match");
  await drained();
  // The copy itself succeeds - it only wrote to the application's own data
  // directory - and then the user keeps their unsaved work.
  h.preparations.take().resolve(preparedExample("basic-text-match", "/data/basic", [7]));
  await example;

  assert.deepEqual(h.prompts, ["Open an example and discard unsaved changes to main.yar?"]);
  assert.equal(h.session.selection(), selection);
  assert.equal(h.ui.dir, "/a");
  assert.equal(h.ui.build, "compiled");
  assert.equal(h.operations.isCurrent(op, h.session.root()), true);
  assert.equal(h.docs.isDirty("/a/main.yar"), true, "the unsaved work is still unsaved work");
  assert.equal(h.docs.textOf("/a/main.yar"), "unsaved work");
  assert.equal(h.ui.target, null, "and the example's target was not preloaded");
  assert.equal(h.analyses.pending(), 0);
});

// ---- Close Workspace against a pending open ----

test("a close accepted while an open is pending leaves the workspace closed", async () => {
  const h = app();
  await h.loadFolder("/a", ["main.yar"]);
  const opening = h.openFolder();
  await drained();
  const picker = h.pickers.take();

  assert.equal(await h.closeWorkspace(), true);
  assert.equal(h.session.isOpen(), false);

  // The picker answers afterwards. The user has said what they want the window to be
  // showing since.
  picker.resolve("/b");
  await opening;

  assert.equal(h.session.isOpen(), false, "the close was not undone by an older gesture");
  assert.equal(h.ui.dir, "No folder open");
  assert.equal(h.analyses.pending(), 0);
  assert.deepEqual(h.docs.keys(), [""]);
});

test("a close the user cancels leaves a pending open to land", async () => {
  const h = app();
  await h.loadFolder("/a", ["main.yar"], { "/a/main.yar": "rule a {}" });
  h.edit("/a/main.yar", "unsaved work");
  const opening = h.openFolder();
  await drained();
  const picker = h.pickers.take();

  // Cancelled, so nothing was abandoned - and an open the user started before it is
  // not collateral damage.
  h.setConfirm(false);
  assert.equal(await h.closeWorkspace(), false);

  h.setConfirm(true);
  picker.resolve("/b");
  await drained();
  h.analyses.take().resolve(loaded("/b", ["b.yar"]));
  await drained();
  h.reads.take().resolve("rule b {}");
  await opening;

  assert.equal(h.ui.dir, "/b", "the folder the user chose still opened");
  assert.equal(h.session.isOpen(), true);
});

// ---- An example is a project like any other ----

test("an example enters the project by the same steps as a folder, plus its target", async () => {
  const folder = app();
  await folder.loadFolder("/a", ["main.yar"]);

  const example = app();
  await example.loadExample("nested-includes", "/data/nested/v1", ["main.yar"], [1, 2, 3, 4]);

  assert.deepEqual(folder.trace, [
    "confirm",
    "select",
    "operation",
    "reset-requested",
    "leave",
    "reset-ran",
    "analyse",
  ]);
  assert.deepEqual(example.trace, [
    "confirm",
    "select",
    "operation",
    "reset-requested",
    "leave",
    "target",
    "reset-ran",
    "analyse",
  ]);
  // Said the way that matters: the same transition, in the same order, with the
  // sample target installed by the prologue that cannot fail - after the previous
  // project's documents have gone, and before anything is analysed.
  assert.deepEqual(
    example.trace.filter((step) => step !== "target"),
    folder.trace,
  );
  assert.equal(example.ui.dir, "/data/nested/v1");
  assert.equal(example.ui.active, "/data/nested/v1/main.yar");
  assert.deepEqual(example.ui.target, {
    path: "/data/nested/v1/targets/sample.txt",
    bytes: [1, 2, 3, 4],
  });
  // Nothing was compiled and nothing was scanned: the example says what to do next,
  // and doing it is the user's.
  assert.equal(example.ui.build, "not-compiled");
});

test("re-opening the same example is a new selection, and opening a folder leaves the target alone", async () => {
  const h = app();
  await h.loadExample("basic-text-match", "/data/basic/v1", ["text_indicators.yar"], [1]);
  const first = h.session.selection();
  const firstDocument = h.docs.model("/data/basic/v1/text_indicators.yar");

  // The same working copy, which no comparison of paths could tell from a no-op.
  await h.loadExample("basic-text-match", "/data/basic/v1", ["text_indicators.yar"], [2]);
  assert.notEqual(h.session.selection(), first, "everything in flight was superseded");
  assert.notEqual(
    h.docs.model("/data/basic/v1/text_indicators.yar"),
    firstDocument,
    "the document was closed and re-read, not kept",
  );
  assert.deepEqual(h.ui.target.bytes, [2], "and the target came from this open");

  // Opening an ordinary folder says nothing about what to scan, so what is loaded
  // stays loaded.
  await h.loadFolder("/work", ["main.yar"]);
  assert.equal(h.ui.dir, "/work");
  assert.deepEqual(h.ui.target, {
    path: "/data/basic/v1/targets/sample.txt",
    bytes: [2],
  });
});
