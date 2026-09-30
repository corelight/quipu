// Tests for navigation that outlives the project it was asked for
// (navigation.ts).
//
// Run with `npm test`. Every gesture here has to read a file before it can show
// anything, and the user is free to open another folder, close the workspace, refresh
// the project or click somewhere else while that read is outstanding. So each case
// below holds the read open, moves the ground, and then lets the read land: what must
// not happen is a document from the project before appearing in the editor, a
// position being revealed in whatever document is active now, or a failure nobody is
// waiting for landing in the Problems pane.
//
// The session and the navigation are the real modules. What is faked is only what
// they are deliberately ignorant of: Monaco's models, the reads, and where a failure
// is shown. No clocks and no DOM - every read is a promise the test resolves by hand.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Navigation } from "./navigation.ts";
import { ProjectSession, firstOpenableSource } from "./project.ts";
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

// The reads the test resolves by hand. `take()` hands over the oldest one that has
// not been dealt with, so a test never has to count indices.
function calls() {
  const list = [];
  return {
    keys: () => list.map((c) => c.key),
    pending: () => list.filter((c) => !c.taken).length,
    hold(key) {
      const d = deferred();
      list.push({ key, resolve: d.resolve, reject: d.reject, taken: false });
      return d.promise;
    },
    take() {
      const call = list.find((c) => !c.taken);
      assert.ok(call, "a read was expected to be waiting");
      call.taken = true;
      return call;
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

function app() {
  const session = new ProjectSession();
  const reads = calls();
  const failures = [];
  // Everything a navigation could touch, so a test can assert that a stale one
  // touched none of it.
  const editor = { docs: new Map(), active: null, opened: [], activated: [], revealed: [] };

  // Every activation announces itself, exactly as main.ts hooks the workspace's
  // active-document callback up to navigation.activated(): what suppresses an
  // automatic open is the editor moving, whoever moved it.
  function activate(path) {
    editor.active = path;
    editor.activated.push(path);
    nav.activated();
  }

  const nav = new Navigation({
    selection: () => session.selection(),
    isSelected: (sel) => (sel === null ? !session.isOpen() : session.isCurrent(sel)),
    analysis: () => session.analysis(),
    isOpen: (path) => editor.docs.has(path),
    activeKey: () => editor.active,
    textOf: (path) => editor.docs.get(path) ?? "",
    read: (path) => reads.hold(path),
    open: (path, text) => {
      editor.docs.set(path, text);
      editor.opened.push(path);
      activate(path);
    },
    activate,
    fail: (err) => failures.push(String(err)),
    explicitNavigationStarted: () => session.retireInitialPresentationForUser(),
  });

  return {
    session,
    nav,
    reads,
    failures,
    editor,

    // The scratch buffer the app starts on, so that "nothing was opened" is a state
    // the editor can actually be in.
    scratch() {
      editor.docs.set("", "the scratch buffer");
      activate("");
    },

    // Opening a folder, as far as the session is concerned: the analysis is accepted
    // and the request settles. The transition itself is switching.test.mjs's.
    load(root, names) {
      const selection = session.open(root);
      const req = session.beginAnalysis(selection, true);
      const analysis = loaded(root, names);
      assert.equal(session.accept(req, analysis, false), true);
      session.finishAnalysis(req);
      return { selection, analysis };
    },

    // The editor being moved by something that is not a navigation at all: a rename
    // re-activating its document, the scratch buffer being put back, a tab click.
    // main.ts routes every change of active document to navigation.activated().
    activateOutside(path) {
      if (!editor.docs.has(path)) editor.docs.set(path, "opened by something else");
      activate(path);
    },

    // A refresh landing: a new snapshot replaces the accepted one under the same
    // selection.
    refresh(names) {
      const selection = session.selection();
      const req = session.beginAnalysis(selection, false);
      const analysis = loaded(selection.root, names);
      assert.equal(session.accept(req, analysis, false), true);
      session.finishAnalysis(req);
      return analysis;
    },

    accept(req, analysis) {
      assert.equal(session.accept(req, analysis, false), true);
      return { selection: req.selection, req, analysis };
    },

    present(project) {
      const attempt = session.beginInitialPresentation(project.req);
      if (attempt === null) return { attempt: null, outcome: Promise.resolve("not-started") };
      const first = firstOpenableSource(project.analysis);
      if (first === null) {
        session.finishInitialPresentation(attempt, "no-openable-source");
        return { attempt, outcome: Promise.resolve("no-openable-source") };
      }
      const outcome = nav
        .autoOpen(
          project.selection,
          project.analysis,
          openablePath(project.analysis.root, first),
          () => session.finishInitialPresentation(attempt, "shown"),
        )
        .then((result) => {
          session.finishInitialPresentation(attempt, result === "not-found" ? "failed" : result);
          return result;
        });
      return { attempt, outcome };
    },

    newRule(path) {
      session.retireInitialPresentationForUser();
      editor.docs.set(path, "");
      editor.opened.push(path);
      activate(path);
    },

    // main.ts's two lines around navigation.autoOpen(): which source, and then the
    // guarded open of it.
    autoOpen(project) {
      const first = firstOpenableSource(project.analysis);
      assert.ok(first, "the project has a source to open");
      return nav.autoOpen(
        project.selection,
        project.analysis,
        openablePath(project.analysis.root, first),
      );
    },

    // The explorer's gesture: show the source, and reveal the location when the row
    // names one. The offset conversion is bytepos.ts's; this records that a reveal
    // happened, and in which document.
    goToRow(path, offset = null) {
      return nav.goTo(path, offset === null ? null : () => editor.revealed.push(`${path}@${offset}`));
    },

    // A diagnostic row: the file to open, and the position to jump to within it.
    goToDiagnostic(file, line, column) {
      return nav.goTo(file, () => editor.revealed.push(`${editor.active}:${line}:${column}`));
    },

    // A match result: search the candidates for the rule, show the first hit.
    goToRule(candidates, ruleName) {
      return nav.goToRule(
        candidates,
        (text) => {
          const idx = text.indexOf(`rule ${ruleName}`);
          return idx < 0 ? null : text.slice(0, idx).split("\n").length;
        },
        (line) => editor.revealed.push(`${editor.active}:${line}`),
      );
    },
  };
}

// ---- Initial presentation ownership ----

test("C supersedes B's pending automatic read and presents exactly one project document", async () => {
  const h = app();
  h.scratch();
  const selection = h.session.open("/project");
  const initialA = h.session.beginAnalysis(selection, true);
  const catchUpB = h.session.beginAnalysis(selection, false);
  const projectB = h.accept(catchUpB, loaded("/project", ["b.yar"]));
  const presentationB = h.present(projectB);
  await drained();
  const readB = h.reads.take();

  const catchUpC = h.session.beginAnalysis(selection, false);
  const projectC = h.accept(catchUpC, loaded("/project", ["c.yar"]));
  const presentationC = h.present(projectC);
  assert.notEqual(presentationC.attempt, null, "C takes presentation ownership immediately");
  await drained();
  const readC = h.reads.take();

  readB.resolve("rule b {}");
  assert.equal(await presentationB.outcome, "stale");
  readC.resolve("rule c {}");
  assert.equal(await presentationC.outcome, "shown");

  h.session.finishAnalysis(catchUpB);
  h.session.finishAnalysis(catchUpC);
  h.session.finishAnalysis(initialA);
  assert.deepEqual(h.editor.opened, ["/project/c.yar"]);
  assert.equal(h.editor.active, "/project/c.yar");
  assert.deepEqual(h.session.initialPresentationState(), {
    kind: "terminal",
    order: 3,
    reason: "shown",
    retryable: false,
  });
});

test("explicit navigation retires a pending automatic presentation before either read lands", async () => {
  const h = app();
  h.scratch();
  const selection = h.session.open("/project");
  const b = h.session.beginAnalysis(selection, true);
  const projectB = h.accept(b, loaded("/project", ["auto.yar", "chosen.yar"]));
  const automatic = h.present(projectB);
  await drained();
  const autoRead = h.reads.take();

  const explicit = h.goToRow("/project/chosen.yar");
  await drained();
  const explicitRead = h.reads.take();
  explicitRead.resolve("rule chosen {}");
  assert.equal(await explicit, "shown");

  const c = h.session.beginAnalysis(selection, false);
  h.accept(c, loaded("/project", ["auto.yar", "chosen.yar", "new.yar"]));
  assert.equal(h.session.beginInitialPresentation(c), null, "C cannot displace user intent");

  autoRead.resolve("rule automatic {}");
  assert.equal(await automatic.outcome, "stale");
  assert.deepEqual(h.editor.opened, ["/project/chosen.yar"]);
  assert.equal(h.session.initialPresentationState().reason, "user-navigation");
});

test("New Rule retires a pending automatic presentation", async () => {
  const h = app();
  h.scratch();
  const selection = h.session.open("/project");
  const b = h.session.beginAnalysis(selection, true);
  const automatic = h.present(h.accept(b, loaded("/project", ["auto.yar"])));
  await drained();
  const autoRead = h.reads.take();

  h.newRule("/project/new.yar");
  autoRead.resolve("rule automatic {}");
  assert.equal(await automatic.outcome, "stale");
  assert.deepEqual(h.editor.opened, ["/project/new.yar"]);
  assert.equal(h.editor.active, "/project/new.yar");
  assert.equal(h.session.initialPresentationState().reason, "user-navigation");
});

test("switch and close retire pending presentation attempts", async () => {
  for (const transition of ["switch", "close"]) {
    const h = app();
    h.scratch();
    const selection = h.session.open("/old");
    const req = h.session.beginAnalysis(selection, true);
    const automatic = h.present(h.accept(req, loaded("/old", ["old.yar"])));
    await drained();
    const read = h.reads.take();
    if (transition === "switch") h.session.open("/new");
    else h.session.close();
    read.resolve("rule old {}");
    assert.equal(await automatic.outcome, "stale");
    assert.deepEqual(h.editor.opened, [], `${transition} keeps the old document closed`);
  }
});

test("read failure is terminal for one snapshot and retryable by a newer accepted snapshot", async () => {
  const h = app();
  const selection = h.session.open("/project");
  const b = h.session.beginAnalysis(selection, true);
  const projectB = h.accept(b, loaded("/project", ["broken.yar"]));
  const failed = h.present(projectB);
  await drained();
  h.reads.take().reject(new Error("unreadable"));
  assert.equal(await failed.outcome, "failed");
  assert.equal(h.session.beginInitialPresentation(b), null, "the same snapshot is not retried");
  assert.deepEqual(h.session.initialPresentationState(), {
    kind: "terminal",
    order: 1,
    reason: "failed",
    retryable: true,
  });

  const c = h.session.beginAnalysis(selection, false);
  const retried = h.present(h.accept(c, loaded("/project", ["readable.yar"])));
  await drained();
  h.reads.take().resolve("rule readable {}");
  assert.equal(await retried.outcome, "shown");
  assert.deepEqual(h.editor.opened, ["/project/readable.yar"]);
});

test("configuration failure and no openable source are explicit retryable terminal outcomes", () => {
  for (const outcome of ["configuration-failed", "no-openable-source"]) {
    const session = new ProjectSession();
    const selection = session.open("/project");
    const req = session.beginAnalysis(selection, true);
    const analysis =
      outcome === "configuration-failed"
        ? { status: "configurationFailed", issue: {} }
        : loaded("/project", []);
    assert.equal(session.accept(req, analysis, false), true);
    const attempt = session.beginInitialPresentation(req);
    assert.notEqual(attempt, null);
    assert.equal(session.finishInitialPresentation(attempt, outcome), true);
    assert.deepEqual(session.initialPresentationState(), {
      kind: "terminal",
      order: 1,
      reason: outcome,
      retryable: true,
    });
  }
});

test("a shown presentation commits synchronously and a later analysis cannot open twice", async () => {
  const h = app();
  const selection = h.session.open("/project");
  const b = h.session.beginAnalysis(selection, true);
  const shown = h.present(h.accept(b, loaded("/project", ["first.yar"])));
  await drained();
  h.reads.take().resolve("rule first {}");
  await drained();
  assert.equal(h.session.initialPresentationState().reason, "shown");

  const c = h.session.beginAnalysis(selection, false);
  h.accept(c, loaded("/project", ["second.yar"]));
  assert.equal(h.session.beginInitialPresentation(c), null);
  assert.equal(await shown.outcome, "shown");
  assert.deepEqual(h.editor.opened, ["/project/first.yar"]);
});

// ---- Navigating to a source ----

test("navigating to a source opens it and reveals the location", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["main.yar"]);

  const going = h.goToRow("/a/main.yar", 12);
  await drained();
  h.reads.take().resolve("rule a {}");

  assert.equal(await going, "shown");
  assert.deepEqual(h.editor.opened, ["/a/main.yar"]);
  assert.equal(h.editor.active, "/a/main.yar");
  assert.deepEqual(h.editor.revealed, ["/a/main.yar@12"]);
  assert.deepEqual(h.failures, []);
});

test("a source that is already open is activated rather than read again", async () => {
  const h = app();
  h.load("/a", ["main.yar", "other.yar"]);
  await (async () => {
    const going = h.goToRow("/a/main.yar");
    await drained();
    h.reads.take().resolve("rule a {}");
    await going;
  })();
  const going = h.goToRow("/a/other.yar");
  await drained();
  h.reads.take().resolve("rule other {}");
  await going;

  const again = h.goToRow("/a/main.yar", 4);
  assert.equal(await again, "shown");
  assert.equal(h.reads.pending(), 0, "an open document is not read from disk");
  assert.deepEqual(h.editor.activated.at(-1), "/a/main.yar");
  assert.deepEqual(h.editor.revealed, ["/a/main.yar@4"]);
});

test("a read that lands after a folder switch opens nothing", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["main.yar"]);

  const going = h.goToRow("/a/main.yar", 12);
  await drained();
  const read = h.reads.take();
  // The user opens another folder while A's file is still being read.
  h.load("/b", ["b.yar"]);
  read.resolve("rule a {}");

  assert.equal(await going, "stale");
  assert.deepEqual(h.editor.opened, [], "A's file did not appear in B");
  assert.equal(h.editor.active, "", "and the editor is where the switch left it");
  assert.deepEqual(h.editor.revealed, [], "so there was nothing to reveal a position in");
  assert.deepEqual(h.failures, []);
});

test("a read that lands after the workspace is closed opens nothing", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["main.yar"]);

  const going = h.goToRow("/a/main.yar");
  await drained();
  const read = h.reads.take();
  h.session.close();
  read.resolve("rule a {}");

  assert.equal(await going, "stale");
  assert.deepEqual(h.editor.opened, []);
  assert.equal(h.editor.active, "");
});

test("a read that fails after a folder switch reports nothing", async () => {
  const h = app();
  h.load("/a", ["main.yar"]);

  const going = h.goToRow("/a/main.yar");
  await drained();
  const read = h.reads.take();
  h.load("/b", ["b.yar"]);
  read.reject(new Error("permission denied"));

  assert.equal(await going, "stale");
  assert.deepEqual(h.failures, [], "B's Problems pane is not where A's failures go");
  assert.deepEqual(h.editor.opened, []);
});

test("a read that fails for the project still open is reported", async () => {
  const h = app();
  h.load("/a", ["main.yar"]);

  const going = h.goToRow("/a/main.yar");
  await drained();
  h.reads.take().reject(new Error("permission denied"));

  assert.equal(await going, "failed");
  assert.deepEqual(h.failures, ["Error: permission denied"]);
  assert.deepEqual(h.editor.opened, [], "an unreadable source has nothing to show");
});

test("a snapshot replaced while reading discards the navigation", async () => {
  const h = app();
  h.scratch();
  const project = h.load("/a", ["main.yar"]);

  const going = h.goToRow("/a/main.yar", 12);
  await drained();
  const read = h.reads.take();
  // A refresh lands: the row that was clicked, and the byte offset it carried,
  // described the snapshot this one has just replaced.
  const replacement = h.refresh(["main.yar", "extra.yar"]);
  assert.notEqual(replacement, project.analysis);
  read.resolve("rule a {}");

  assert.equal(await going, "stale");
  assert.deepEqual(h.editor.opened, []);
  assert.deepEqual(h.editor.revealed, []);
});

// ---- Which gesture wins ----
//
// Two navigations are two reads, and nothing makes them come back in the order they
// were asked for. What decides is when each gesture was made, so a navigation that
// has been superseded must already be dead while the newer one is still reading -
// otherwise the older click wins by being slower, which is the bug these cover.

test("of two navigations the newer wins even when its read lands first", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["one.yar", "two.yar"]);

  const older = h.goToRow("/a/one.yar", 1);
  await drained();
  const readOne = h.reads.take();
  const newer = h.goToRow("/a/two.yar", 2);
  await drained();
  const readTwo = h.reads.take();

  readTwo.resolve("rule two {}");
  assert.equal(await newer, "shown");
  readOne.resolve("rule one {}");
  assert.equal(await older, "stale");

  assert.deepEqual(h.editor.opened, ["/a/two.yar"], "the file the user asked for last");
  assert.equal(h.editor.active, "/a/two.yar");
  assert.deepEqual(h.editor.revealed, ["/a/two.yar@2"]);
  assert.deepEqual(h.failures, []);
});

test("the superseded navigation is dead before its read lands, and never activates", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["one.yar", "two.yar"]);

  const older = h.goToRow("/a/one.yar", 1);
  await drained();
  const readOne = h.reads.take();
  const newer = h.goToRow("/a/two.yar", 2);
  await drained();
  const readTwo = h.reads.take();

  // This time in the order they were asked for, which is the order that could put
  // the editor on the older file first and move it afterwards.
  readOne.resolve("rule one {}");
  assert.equal(await older, "stale");
  readTwo.resolve("rule two {}");
  assert.equal(await newer, "shown");

  assert.deepEqual(h.editor.opened, ["/a/two.yar"], "the older gesture opened nothing at all");
  assert.deepEqual(
    h.editor.activated,
    ["", "/a/two.yar"],
    "and the editor was never even briefly moved to it",
  );
  assert.deepEqual(h.editor.revealed, ["/a/two.yar@2"]);
});

test("a superseded navigation's read failure stays out of the Problems pane", async () => {
  const h = app();
  h.load("/a", ["one.yar", "two.yar"]);

  const older = h.goToRow("/a/one.yar");
  await drained();
  const readOne = h.reads.take();
  const newer = h.goToRow("/a/two.yar");
  await drained();
  const readTwo = h.reads.take();

  readOne.reject(new Error("permission denied"));
  assert.equal(await older, "stale");
  assert.deepEqual(h.failures, [], "the click it belonged to is not the one being answered");

  readTwo.resolve("rule two {}");
  assert.equal(await newer, "shown");
  assert.deepEqual(h.failures, [], "and nothing was left to report afterwards either");
});

test("a match search is superseded by a newer navigation that is still reading", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["one.yar", "two.yar"]);

  const searching = h.goToRule(["/a/one.yar", "/a/two.yar"], "wanted");
  await drained();
  const candidate = h.reads.take();
  const chosen = h.goToRow("/a/two.yar");
  await drained();
  const chosenRead = h.reads.take();

  // The candidate does contain the rule. The user has since asked for a file
  // themselves, and that is what the editor is for now.
  candidate.resolve("rule wanted {}");
  assert.equal(await searching, "stale");
  assert.deepEqual(h.editor.opened, [], "the match did not get in front of the user's own click");
  assert.deepEqual(h.editor.revealed, []);

  chosenRead.resolve("// nothing of the sort");
  assert.equal(await chosen, "shown");
  assert.equal(h.editor.active, "/a/two.yar");
  assert.deepEqual(h.editor.revealed, [], "and no line was revealed in it");
});

// ---- Diagnostics ----

test("a diagnostic's file is opened before its position is revealed", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["main.yar"]);

  const going = h.goToDiagnostic("/a/main.yar", 7, 3);
  await drained();
  h.reads.take().resolve("rule a {}");

  assert.equal(await going, "shown");
  assert.deepEqual(h.editor.revealed, ["/a/main.yar:7:3"], "in the file the row named");
});

test("a diagnostic whose file arrives after a switch reveals nothing", async () => {
  const h = app();
  h.load("/a", ["main.yar"]);
  const going = h.goToDiagnostic("/a/main.yar", 7, 3);
  await drained();
  const read = h.reads.take();

  // Another folder, with a document of its own in the editor.
  h.load("/b", ["b.yar"]);
  const opening = h.goToRow("/b/b.yar");
  await drained();
  h.reads.take().resolve("rule b {}");
  await opening;

  read.resolve("rule a {}");
  assert.equal(await going, "stale");
  assert.equal(h.editor.active, "/b/b.yar");
  assert.deepEqual(
    h.editor.revealed,
    [],
    "line 7 of A's file is not a position in B's document",
  );
});

// ---- Match results ----

test("match navigation shows the first candidate that contains the rule", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["one.yar", "two.yar"]);

  const going = h.goToRule(["/a/one.yar", "/a/two.yar"], "wanted");
  await drained();
  h.reads.take().resolve("rule elsewhere {}");
  await drained();
  h.reads.take().resolve("rule first {}\nrule wanted {}");

  assert.equal(await going, "shown");
  assert.deepEqual(h.editor.opened, ["/a/two.yar"], "only the file with the match");
  assert.deepEqual(h.editor.revealed, ["/a/two.yar:2"]);
  assert.equal(h.reads.pending(), 0, "and it was read once, not once to search and once to open");
});

test("match navigation skips a candidate it cannot read", async () => {
  const h = app();
  h.load("/a", ["one.yar", "two.yar"]);

  const going = h.goToRule(["/a/one.yar", "/a/two.yar"], "wanted");
  await drained();
  h.reads.take().reject(new Error("permission denied"));
  await drained();
  h.reads.take().resolve("rule wanted {}");

  assert.equal(await going, "shown");
  assert.deepEqual(h.failures, [], "an unreadable candidate is not a failure of the search");
  assert.deepEqual(h.editor.revealed, ["/a/two.yar:1"]);
});

test("match navigation stops when the search's project is left", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["one.yar", "two.yar"]);

  const going = h.goToRule(["/a/one.yar", "/a/two.yar"], "wanted");
  await drained();
  const read = h.reads.take();
  h.load("/b", ["b.yar"]);
  // This file does contain the rule. It is not this project's file any more.
  read.resolve("rule wanted {}");

  assert.equal(await going, "stale");
  assert.deepEqual(h.editor.opened, []);
  assert.deepEqual(h.editor.revealed, []);
  assert.equal(h.reads.pending(), 0, "the remaining candidates were not even read");
  assert.equal(h.editor.active, "");
});

test("match navigation stops when the snapshot it listed candidates from is replaced", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["one.yar", "two.yar"]);

  const going = h.goToRule(["/a/one.yar", "/a/two.yar"], "wanted");
  await drained();
  const read = h.reads.take();
  h.refresh(["one.yar"]);
  read.resolve("rule wanted {}");

  assert.equal(await going, "stale");
  assert.deepEqual(h.editor.opened, []);
  assert.deepEqual(h.editor.revealed, []);
});

test("match navigation reveals in an open document without reading anything", async () => {
  const h = app();
  h.load("/a", ["one.yar"]);
  const opening = h.goToRow("/a/one.yar");
  await drained();
  h.reads.take().resolve("rule on disk {}");
  await opening;
  // The editor's text, not the disk's: an unsaved edit is what the user is looking
  // at, and the line has to agree with it.
  h.editor.docs.set("/a/one.yar", "// edited\nrule wanted {}");

  assert.equal(await h.goToRule(["/a/one.yar"], "wanted"), "shown");
  assert.equal(h.reads.pending(), 0);
  assert.deepEqual(h.editor.revealed, ["/a/one.yar:2"]);
});

test("match navigation that finds nothing says so and shows nothing", async () => {
  const h = app();
  h.scratch();
  h.load("/a", ["one.yar"]);

  const going = h.goToRule(["/a/one.yar"], "wanted");
  await drained();
  h.reads.take().resolve("rule elsewhere {}");

  assert.equal(await going, "not-found");
  assert.deepEqual(h.editor.opened, []);
  assert.equal(h.editor.active, "");
});

// ---- The automatic open of a project's first source ----

test("the first source opens when the project that asked is still current", async () => {
  const h = app();
  h.scratch();
  const project = h.load("/a", ["main.yar"]);

  const opening = h.autoOpen(project);
  await drained();
  h.reads.take().resolve("rule a {}");

  assert.equal(await opening, "shown");
  assert.deepEqual(h.editor.opened, ["/a/main.yar"]);
  assert.equal(h.editor.active, "/a/main.yar");
});

test("a refresh replacing the accepted analysis suppresses the automatic open", async () => {
  const h = app();
  h.scratch();
  const project = h.load("/a", ["main.yar"]);

  const opening = h.autoOpen(project);
  await drained();
  const read = h.reads.take();
  // The refresh's own answer is what the project is now, and its auto-open - if it
  // wanted one - is not this request's to perform.
  h.refresh(["main.yar", "extra.yar"]);
  read.resolve("rule a {}");

  assert.equal(await opening, "stale");
  assert.deepEqual(h.editor.opened, [], "the snapshot that asked is no longer the accepted one");
  assert.equal(h.editor.active, "");
});

test("explicit navigation during the read keeps the document the user chose", async () => {
  const h = app();
  h.scratch();
  const project = h.load("/a", ["main.yar", "other.yar"]);

  const opening = h.autoOpen(project);
  await drained();
  const autoRead = h.reads.take();

  // The user picks a file themselves while the automatic one is still being read.
  const chosen = h.goToRow("/a/other.yar");
  await drained();
  h.reads.take().resolve("rule other {}");
  assert.equal(await chosen, "shown");

  autoRead.resolve("rule a {}");
  assert.equal(await opening, "stale");
  assert.deepEqual(h.editor.opened, ["/a/other.yar"], "the automatic open did not steal it back");
  assert.equal(h.editor.active, "/a/other.yar");
});

test("a navigation the user has only just started supersedes the automatic open", async () => {
  const h = app();
  h.scratch();
  const project = h.load("/a", ["main.yar", "other.yar"]);

  const opening = h.autoOpen(project);
  await drained();
  const autoRead = h.reads.take();

  // The user picks a file of their own, and its read is still outstanding: the click
  // is what withdraws the automatic open, not the answer to it.
  const chosen = h.goToRow("/a/other.yar");
  await drained();
  const chosenRead = h.reads.take();

  autoRead.resolve("rule main {}");
  assert.equal(await opening, "stale");
  assert.deepEqual(h.editor.opened, [], "the default source did not appear while they waited");
  assert.equal(h.editor.active, "");

  chosenRead.resolve("rule other {}");
  assert.equal(await chosen, "shown");
  assert.deepEqual(h.editor.opened, ["/a/other.yar"]);
  assert.equal(h.editor.active, "/a/other.yar");
});

test("an automatic open that fails under a newer navigation reports nothing", async () => {
  const h = app();
  h.scratch();
  const project = h.load("/a", ["main.yar", "other.yar"]);

  const opening = h.autoOpen(project);
  await drained();
  const autoRead = h.reads.take();
  const chosen = h.goToRow("/a/other.yar");
  await drained();
  const chosenRead = h.reads.take();

  autoRead.reject(new Error("vanished"));
  assert.equal(await opening, "stale");
  assert.deepEqual(h.failures, [], "nobody is waiting to hear about the file they did not choose");

  chosenRead.resolve("rule other {}");
  assert.equal(await chosen, "shown");
  assert.deepEqual(h.failures, []);
});

test("an active-document change from outside navigation withdraws the automatic open", async () => {
  const h = app();
  h.scratch();
  const project = h.load("/a", ["main.yar"]);

  const opening = h.autoOpen(project);
  await drained();
  const read = h.reads.take();
  // No gesture to count here: this is the editor moving on its own account, which is
  // the case the request order cannot see.
  h.activateOutside("/a/elsewhere.yar");
  read.resolve("rule main {}");

  assert.equal(await opening, "stale");
  assert.deepEqual(h.editor.opened, [], "the automatic open did not take the editor back");
  assert.equal(h.editor.active, "/a/elsewhere.yar");
});

test("an automatic open that fails after the editor moved reports nothing", async () => {
  const h = app();
  h.scratch();
  const project = h.load("/a", ["main.yar"]);

  const opening = h.autoOpen(project);
  await drained();
  const read = h.reads.take();
  h.activateOutside("/a/elsewhere.yar");
  read.reject(new Error("vanished"));

  assert.equal(await opening, "stale");
  assert.deepEqual(h.failures, [], "the courtesy was withdrawn, so it has nothing to complain about");
});

test("a folder switch during the read suppresses the automatic open", async () => {
  const h = app();
  h.scratch();
  const project = h.load("/a", ["main.yar"]);

  const opening = h.autoOpen(project);
  await drained();
  const read = h.reads.take();
  h.load("/b", ["b.yar"]);
  read.resolve("rule a {}");

  assert.equal(await opening, "stale");
  assert.deepEqual(h.editor.opened, []);
});

test("a stale automatic open's failure is not reported", async () => {
  const h = app();
  const project = h.load("/a", ["main.yar"]);

  const opening = h.autoOpen(project);
  await drained();
  const read = h.reads.take();
  h.load("/b", ["b.yar"]);
  read.reject(new Error("vanished"));

  assert.equal(await opening, "stale");
  assert.deepEqual(h.failures, [], "the project it happened to is not the project on screen");
});

test("an automatic open's failure is reported for the project still open", async () => {
  const h = app();
  const project = h.load("/a", ["main.yar"]);

  const opening = h.autoOpen(project);
  await drained();
  h.reads.take().reject(new Error("vanished"));

  // Discovery found the file and the analysis said it was readable, so this is a real
  // failure - and the project it belongs to is the one being shown.
  assert.equal(await opening, "failed");
  assert.deepEqual(h.failures, ["Error: vanished"]);
});
