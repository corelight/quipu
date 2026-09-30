// Tests for the guard on terminating the application (closing.ts).
//
// Run with `npm test`. What is being protected is work that exists ONLY in the
// editor: unsaved edits, and a document whose file has gone, which reports no
// unsaved edits because nobody edited it and whose text is the last copy of that
// file anywhere. Exiting destroys both, and it destroys a dirty scratch buffer too -
// which a workspace switch does not, and which is why the exit path asks over its own
// list rather than the switch's filtered one.
//
// The window is mirrored here the way Tauri really behaves, because the guard's whole
// mechanism is that behaviour: while a frontend close-requested listener is
// registered, the native close is PREVENTED and the window is destroyed only if the
// handler declines to prevent it. `close()` below therefore delivers a request rather
// than closing anything, which is what makes File > Quit and the title bar the same
// path - and what lets a test assert that a cancelled close destroyed nothing.
//
// No DOM, no Monaco and no IPC: the documents are a real DocumentSet over a fake
// model, and every confirmation is answered by the test rather than by a dialogue.
//
// The confirmation is asynchronous, as the native dialogue behind it is, so `close()`
// here is awaited too - Tauri likewise awaits the handler before deciding whether to
// destroy the window. That gap is where a second close request can arrive, and the
// re-entrancy tests below open it deliberately by answering slowly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CloseCoordinator, atRiskOnExit, discardQuestion } from "./closing.ts";
import { DocumentSet, riskKeys } from "./documents.ts";

// A stand-in for a Monaco text model: an alternative version id that moves on every
// edit and comes back when the edit is undone, which is all documents.ts reads.
function model(text) {
  let version = 1;
  const history = [{ value: text, version }];
  let cursor = 0;
  return {
    getValue: () => history[cursor].value,
    getAlternativeVersionId: () => history[cursor].version,
    edit(value) {
      history.length = cursor + 1;
      version += 1;
      history.push({ value, version });
      cursor = history.length - 1;
    },
    undo() {
      if (cursor > 0) cursor -= 1;
    },
    setValue(value) {
      this.edit(value);
    },
  };
}

// The application, with everything the coordinator can reach and nothing it cannot.
//
// `state` stands in for what a close must not touch before it is confirmed: the
// project that is open, the ruleset generation, the outstanding watcher subscription.
// Nothing here ever mutates it, which is the point - a cancelled close is asserted to
// have left it exactly as it was, and the assertion would catch a coordinator that
// had grown a way to change it.
function app({ answer = () => false } = {}) {
  const docs = new DocumentSet();
  const prompts = [];
  const state = { project: null, operation: 0, subscription: 0 };
  let reply = answer;
  let inflight = Promise.resolve();

  const win = {
    destroyed: false,
    // Times the window really went: the close happening, as opposed to being asked
    // for. One gesture may never produce two of these.
    destroys: 0,
    // Close REQUESTS delivered, whatever came of them.
    requested: 0,
    handler: null,
    // Tauri's onCloseRequested, as far as this matters: registering a listener is what
    // makes the native close preventable.
    onCloseRequested(handler) {
      this.handler = handler;
    },
    // Every way out of the window arrives here: the title bar, the window manager,
    // macOS's Quit, and File > Quit through the coordinator. With no listener
    // registered the window would simply go, which is why registration comes first
    // in main.ts.
    async close() {
      this.requested += 1;
      if (this.handler === null) {
        this.destroy();
        return;
      }
      let prevented = false;
      await this.handler({ preventDefault: () => (prevented = true) });
      if (!prevented) this.destroy();
    },
    // What not preventing the default leads to. A second one - a duplicate request
    // delivered while the first destruction was in flight - finds nothing left to
    // destroy, which is why permitting it is safe and stranding the window is not.
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.destroys += 1;
    },
  };

  const closing = new CloseCoordinator({
    atRisk: () => atRiskOnExit(docs),
    confirm: async (keys) => {
      prompts.push(discardQuestion("Quit Quipu", keys, (key) => docs.isDirty(key)));
      return reply();
    },
    // The promise is kept rather than dropped so a test can await the close the
    // menu item asked for; main.ts has nothing to await it with, and needs nothing.
    requestWindowClose: () => {
      inflight = win.close();
    },
  });

  // main.ts's handler, verbatim in the part that matters: anything but an approved
  // close prevents the default, and preventing is what keeps the window alive.
  win.onCloseRequested(async (event) => {
    if ((await closing.closeRequested()) === "keep") event.preventDefault();
  });

  return {
    docs,
    win,
    closing,
    prompts,
    state,
    answerWith: (fn) => (reply = fn),
    // Whatever close the coordinator last asked the window for.
    settle: () => inflight,
    // A file the user has opened and edited: dirty, so its text is nowhere else.
    dirtyFile(key = "/p/a.yar") {
      const m = model("rule a {}");
      docs.ensure(key, () => m);
      m.edit("rule a { condition: true }");
      assert.equal(docs.isDirty(key), true);
      return m;
    },
    // A file the user has NOT edited whose file has since been deleted or renamed
    // away: clean, and the editor is holding the only copy of it.
    missingFile(key = "/p/gone.yar") {
      const m = model("rule gone {}");
      docs.ensure(key, () => m);
      const probe = docs.probe(key);
      assert.equal(docs.reconcile(probe, { present: false }).kind, "missing");
      assert.equal(docs.isDirty(key), false);
      return m;
    },
    // The scratch buffer, edited. It has no path, so nothing can write it out.
    dirtyScratch() {
      const m = model("");
      docs.ensure("", () => m);
      m.edit("rule scratch { condition: true }");
      return m;
    },
  };
}

test("a clean application closes immediately, without asking anything", async () => {
  const a = app();
  a.docs.ensure("/p/a.yar", () => model("rule a {}"));
  await a.win.close();
  assert.deepEqual(a.prompts, [], "there was nothing at risk to ask about");
  assert.equal(a.win.destroys, 1);
  assert.equal(a.closing.state(), "closing");
});

test("a dirty file and Cancel keeps the window, and changes nothing", async () => {
  const a = app();
  const m = a.dirtyFile();
  const before = m.getValue();
  await a.win.close();

  assert.equal(a.prompts.length, 1, "asked once");
  assert.match(a.prompts[0], /a\.yar \(unsaved\)/);
  assert.equal(a.win.destroys, 0, "cancelling prevented the close");
  assert.equal(a.closing.state(), "idle", "and left nothing behind to remember it by");
  // Nothing was superseded, cleared or closed on the way to asking.
  assert.deepEqual(a.docs.keys(), ["/p/a.yar"], "the document is still open");
  assert.equal(m.getValue(), before, "with its text intact");
  assert.equal(a.docs.isDirty("/p/a.yar"), true, "and still unsaved");
  assert.deepEqual(a.state, { project: null, operation: 0, subscription: 0 });
});

test("a document whose file has gone is at risk even though it is clean", async () => {
  const a = app();
  a.missingFile();
  await a.win.close();

  assert.equal(a.prompts.length, 1, "a clean document can still be the only copy");
  assert.match(a.prompts[0], /gone\.yar \(not on disk\)/);
  assert.doesNotMatch(a.prompts[0], /unsaved/, "nobody edited it, so it is not unsaved");
  assert.equal(a.win.destroys, 0);
  assert.equal(a.closing.state(), "idle");
});

test("a dirty scratch buffer with no project open is at risk on exit", async () => {
  const a = app();
  const m = a.dirtyScratch();
  const before = m.getValue();
  await a.win.close();

  assert.equal(a.prompts.length, 1, "exiting destroys the scratch buffer, so it is asked about");
  assert.match(a.prompts[0], /the scratch buffer \(unsaved\)/);
  // Not "Cancel, then Save": Save is unavailable for a document with no path, and
  // sending the user to a greyed-out command is worse than saying nothing.
  assert.doesNotMatch(a.prompts[0], /Cancel, then Save/);
  assert.match(a.prompts[0], /no file to save to/);
  assert.equal(a.win.destroys, 0);
  assert.equal(m.getValue(), before, "and it still holds its text");
});

test("a workspace switch keeps the scratch buffer that an exit asks about", async () => {
  const a = app();
  a.dirtyScratch();
  // The two lists over the same documents. The exit-level one is the whole set; the
  // switch's is what main.ts confirms against, which cannot lose a document that no
  // folder change closes.
  assert.deepEqual(riskKeys(atRiskOnExit(a.docs)), [""]);
  assert.deepEqual(
    riskKeys(atRiskOnExit(a.docs)).filter((key) => key !== ""),
    [],
    "which is exactly the difference Workspace.atRiskFileStamps() makes",
  );
});

test("a clean file that merely changed on disk does not prompt", async () => {
  const a = app();
  const m = model("rule a {}");
  a.docs.ensure("/p/a.yar", () => m);
  const probe = a.docs.probe("/p/a.yar");
  // Another program wrote the file. The document is clean, so the disk holds a
  // version of its own and nothing in the editor is the only copy of anything.
  assert.equal(a.docs.reconcile(probe, { present: true, text: "rule a { }" }).kind, "reload");
  assert.deepEqual(atRiskOnExit(a.docs), [], "nothing would be lost with it");

  await a.win.close();
  assert.deepEqual(a.prompts, [], "so exiting asks nothing");
  assert.equal(a.win.destroys, 1);
});

test("confirming permits exactly one close", async () => {
  const a = app({ answer: () => true });
  a.dirtyFile();
  await a.win.close();

  assert.equal(a.prompts.length, 1);
  assert.equal(a.win.destroys, 1);
  assert.equal(a.closing.state(), "closing");
});

// ---- What the answer is held to ----
//
// The dialogue is awaited, so the application can move while it is up. Nothing the
// user does gets there - the dialogue has the input - but a watcher noticing a
// deleted file, a queued reconciliation, a rename or a save landing all do, and each
// changes what exiting would destroy. An approval is an answer about the set it named.

test("a document that becomes at risk while the question is up keeps the application", async () => {
  const a = app();
  a.dirtyFile("/p/a.yar");
  a.answerWith(() => {
    // A second document goes at risk while the user is reading about the first: a
    // watcher reporting its file deleted, leaving the editor holding the only copy.
    a.missingFile("/p/gone.yar");
    return true;
  });

  await a.win.close();

  assert.equal(a.prompts.length, 1);
  assert.match(a.prompts[0], /a\.yar \(unsaved\)/);
  assert.doesNotMatch(a.prompts[0], /gone\.yar/, "which was not at risk yet when it was asked");
  assert.equal(a.win.destroys, 0, "so gone.yar would have gone unasked about");
  assert.equal(a.closing.state(), "idle", "back to resting: the next Quit asks about both");
});

test("a further edit to a document the question named keeps the application", async () => {
  const a = app();
  const m = a.dirtyFile("/p/a.yar");
  a.answerWith(() => {
    // Not the user - the dialogue has the input - but the app's own writers reach the
    // model: a rename carrying text onto a new path, a reconciliation, a snippet
    // insertion. Whatever did it, this is a revision nobody has been shown.
    m.edit("rule a { condition: false }");
    return true;
  });

  await a.win.close();

  assert.equal(a.win.destroys, 0);
  assert.equal(a.closing.state(), "idle");
});

test("a document re-created under the same path while the question is up is not covered", async () => {
  const a = app();
  a.dirtyFile("/p/a.yar");
  a.answerWith(() => {
    // Same path, different document: the old one closed and a new one opened with
    // unsaved work of its own. The path is still "at risk" and the work is not the
    // work that was named.
    a.docs.remove("/p/a.yar");
    a.dirtyFile("/p/a.yar");
    return true;
  });

  await a.win.close();

  assert.equal(a.win.destroys, 0, "a path is not an identity");
  assert.equal(a.closing.state(), "idle");
});

test("work saved while the question is up does not revoke the answer", async () => {
  const a = app();
  a.dirtyFile("/p/a.yar");
  a.dirtyFile("/p/b.yar");
  a.answerWith(() => {
    // The other direction: a.yar's queued save lands, so it is no longer at risk at
    // all. Refusing over that would let a save cancel the user's decision.
    const snap = a.docs.beginSave("/p/a.yar");
    assert.equal(a.docs.completeSave(snap), true);
    assert.equal(a.docs.isDirty("/p/a.yar"), false);
    return true;
  });

  await a.win.close();

  assert.equal(a.win.destroys, 1, "b.yar is still at risk, and was asked about");
  assert.equal(a.closing.state(), "closing");
});

test("a duplicate close request after approval neither prompts nor closes twice", async () => {
  const a = app({ answer: () => true });
  a.dirtyFile();
  await a.win.close();
  assert.equal(a.prompts.length, 1);
  assert.equal(a.win.destroys, 1);

  // The window manager delivering a second request, or an impatient second click on
  // the title bar: the same gesture arriving twice. Asking again would put a second
  // dialogue in front of one decision.
  await a.win.close();
  assert.equal(a.prompts.length, 1, "the approved close is not re-litigated");
  assert.equal(a.win.destroys, 1, "and one gesture destroyed the window once");
  assert.equal(a.win.requested, 2, "both requests were delivered");
});

test("a re-entrant close request while the question is up asks nothing and closes nothing", async () => {
  const a = app();
  const nested = [];
  a.dirtyFile();
  // A close request arriving while the confirmation is on screen - a second click on
  // the title bar while the dialogue waits for an answer, which awaiting the dialogue
  // makes an ordinary occurrence rather than a curiosity. Answering "keep" to it is
  // the only safe answer: nothing has been approved yet.
  a.answerWith(async () => {
    nested.push(await a.closing.closeRequested());
    return false;
  });

  await a.win.close();
  assert.deepEqual(nested, ["keep"], "the nested request refused to close");
  assert.equal(a.prompts.length, 1, "and did not ask a second question");
  assert.equal(a.win.destroys, 0);
  assert.equal(a.closing.state(), "idle", "the cancellation is what the state ends up reflecting");
});

test("two close requests in flight at once produce one question", async () => {
  // Held open by hand: the dialogue is an IPC round trip, so the second request is
  // not a contrivance - it is what a user clicking twice does.
  let answer = null;
  const asked = new Promise((resolve) => (answer = resolve));
  const a = app({ answer: () => asked });
  a.dirtyFile();

  const first = a.win.close();
  const second = a.win.close();
  assert.equal(a.prompts.length, 1, "the second request found a question already up");
  answer(true);
  await Promise.all([first, second]);

  assert.equal(a.prompts.length, 1, "and never raised one of its own");
  assert.equal(a.win.destroys, 1, "one window, destroyed once");
  assert.equal(a.win.requested, 2);
});

test("File > Quit goes through the same guard as the title bar", async () => {
  const a = app();
  a.dirtyFile();
  // The menu item asks the WINDOW to close rather than exiting the process, so the
  // request arrives at the same handler the title bar's does.
  a.closing.quit();
  await a.settle();
  assert.equal(a.win.requested, 1, "Quit requested a window close");
  assert.equal(a.prompts.length, 1, "which the guard answered for");
  assert.equal(a.win.destroys, 0, "Cancel kept the application running");

  a.answerWith(() => true);
  a.closing.quit();
  await a.settle();
  assert.equal(a.prompts.length, 2, "asked again, because nothing was decided last time");
  assert.equal(a.win.destroys, 1);
});

test("the application is still usable after a cancelled close", async () => {
  const a = app();
  const m = a.dirtyFile();
  await a.win.close();
  assert.equal(a.win.destroys, 0);

  // Everything a cancelled close must have left alone: the document is open, dirty
  // and editable, and saving it is still what makes it clean.
  m.edit("rule a { condition: false }");
  assert.equal(a.docs.isDirty("/p/a.yar"), true);
  const snap = a.docs.beginSave("/p/a.yar");
  assert.equal(a.docs.completeSave(snap), true);
  assert.equal(a.docs.isDirty("/p/a.yar"), false, "the save applied normally");

  // And the guard is back where it started: now that nothing is at risk, exiting
  // needs no question at all.
  await a.win.close();
  assert.equal(a.prompts.length, 1, "no second question, because there was nothing left to lose");
  assert.equal(a.win.destroys, 1);
});

test("a confirmation that throws keeps the window and leaves the guard usable", async () => {
  const a = app({
    answer: () => {
      throw new Error("no dialogue available");
    },
  });
  a.dirtyFile();
  await assert.rejects(() => a.closing.closeRequested(), /no dialogue/);
  assert.equal(a.closing.state(), "idle", "a guard that could not ask has decided nothing");

  a.answerWith(() => true);
  assert.equal(await a.closing.closeRequested(), "close");
});

test("the question names every at-risk document, and how each is at risk", async () => {
  const a = app();
  a.dirtyScratch();
  a.dirtyFile("/p/a.yar");
  a.missingFile("/p/gone.yar");
  const keys = riskKeys(atRiskOnExit(a.docs));
  assert.deepEqual(keys, ["", "/p/a.yar", "/p/gone.yar"], "in the order they were opened");
  const question = discardQuestion("Quit Quipu", keys, (key) => a.docs.isDirty(key));
  assert.match(
    question,
    /^Quit Quipu and lose the scratch buffer \(unsaved\), a\.yar \(unsaved\), gone\.yar \(not on disk\)\?/,
  );
  assert.match(question, /Cancel, then Save/, "there are files this applies to");
  assert.match(question, /no file to save to/, "and a scratch buffer it does not");
});

test("the wording is the same question the workspace switch asks", async () => {
  const docs = new DocumentSet();
  const m = model("rule a {}");
  docs.ensure("/p/a.yar", () => m);
  m.edit("rule a { condition: true }");
  const isDirty = (key) => docs.isDirty(key);
  // One function, two actions: switching and exiting cannot describe the same
  // document differently, however differently they arrive at the list.
  assert.equal(
    discardQuestion("Close the workspace", ["/p/a.yar"], isDirty),
    "Close the workspace and lose a.yar (unsaved)?\n\nCancel, then Save, to write them to disk.",
  );
  assert.equal(
    discardQuestion("Quit Quipu", ["/p/a.yar"], isDirty),
    "Quit Quipu and lose a.yar (unsaved)?\n\nCancel, then Save, to write them to disk.",
  );
});
