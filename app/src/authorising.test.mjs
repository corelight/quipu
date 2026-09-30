// Tests for the confirmations that stand in front of losing work (authorising.ts).
//
// Run with `npm test`. The dialogue that can actually be seen is an IPC round trip,
// so every one of these questions is asked across an await, and that is the whole
// subject here: what the user is asked about, and whether the answer still means
// anything by the time it arrives. Each case that matters is the same shape - put a
// question up, let something happen while it is up, then answer it - and the answer
// must authorise exactly what was shown and nothing else.
//
// The session, the open documents and the open-request ordering are the real ones, so
// what is being checked is the application rather than a copy of it. Only Monaco and
// the disk are stood in for: a model here is the two methods documents.ts uses, and a
// "file" is whatever a test says a read found.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  answerHolds,
  authorise,
  closeGate,
  compileGate,
  departureGate,
  reloadGate,
  saveGate,
} from "./authorising.ts";
import { DocumentSet, coversRisk } from "./documents.ts";
import { OpenRequests } from "./opening.ts";
import { ProjectSession } from "./project.ts";

// A stand-in for a Monaco text model, with a version id that behaves the way the
// alternative version id does: a new value for every edit, and an EARLIER value
// restored by undoing back to it - which is how a document can be clean and still in
// conflict with its file.
function model(text) {
  const history = [{ value: text, version: 1 }];
  let version = 1;
  let cursor = 0;
  return {
    getValue: () => history[cursor].value,
    getAlternativeVersionId: () => history[cursor].version,
    // Monaco's setValue is an edit like any other as far as version ids go.
    setValue(next) {
      history.length = cursor + 1;
      version += 1;
      history.push({ value: next, version });
      cursor = history.length - 1;
    },
    undo() {
      if (cursor > 0) cursor -= 1;
    },
  };
}

const present = (text) => ({ present: true, text });
const absent = { present: false };

// The application the gates are asked about: the real session, the real documents,
// the real request ordering, and the same views main.ts hands them.
function app() {
  const session = new ProjectSession();
  const opens = new OpenRequests();
  const docs = new DocumentSet();
  const models = new Map();
  let active = null;
  let compiling = false;

  // What editor.ts's Workspace exposes, including its one filter: the scratch buffer
  // has no path, so leaving a project neither closes it nor can lose it.
  const files = (keys) => keys.filter((key) => key !== "");
  const view = {
    activeKey: () => active,
    atRiskFileStamps: () => docs.atRiskStamps().filter((stamp) => stamp.key !== ""),
    dirtyFileKeys: () => files(docs.dirtyKeys()),
    isDirty: (key) => docs.isDirty(key),
    conflictOf: (key) => docs.conflictOf(key),
    diskAnswer: (key) => docs.diskAnswer(key),
    textOf: (key) => docs.textOf(key),
    probe: (key) => docs.probe(key),
    beginSave: (key) => docs.beginSave(key),
    holds: (expect) => docs.holds(expect),
  };

  return {
    session,
    opens,
    docs,
    world: { session, docs: view, opens },
    busy: () => compiling,

    // ---- what the user does ----
    openProject(root = "/p") {
      return session.open(root);
    },
    openDoc(key, text = "rule a {}") {
      const m = model(text);
      models.set(key, m);
      docs.ensure(key, () => m);
      active = key;
      return m;
    },
    activate(key) {
      active = key;
    },
    edit(key, text) {
      models.get(key).setValue(text);
    },
    // Back to the revision the file was last agreed to hold: the document is clean
    // again, and any conflict reported meanwhile is still there.
    undo(key) {
      models.get(key).undo();
    },
    startCompiling() {
      compiling = true;
    },

    // ---- what the disk does ----
    // Another program wrote the file. A read of it lands as an observation, and as a
    // conflict when the document has edits of its own.
    external(key, text) {
      return docs.reconcile(docs.probe(key), present(text));
    },
    // The file is gone: the document holds the only copy of its text.
    deleted(key) {
      return docs.reconcile(docs.probe(key), absent);
    },
  };
}

// An answer of `yes`, with `during` run while the question is still on screen: the
// interleaving window, and the only place these tests need one.
function answering(yes, during = null) {
  const asked = [];
  return {
    asked,
    ask: async (question) => {
      asked.push(question);
      if (during !== null) await during();
      return yes;
    },
  };
}

// A dialogue that could not be shown at all.
function rejecting() {
  const asked = [];
  return {
    asked,
    ask: async (question) => {
      asked.push(question);
      throw new Error("dialog unavailable");
    },
  };
}

// A project with one edited file in it: what every departure case starts from.
function dirtyProject(a = "/p/a.yar") {
  const it = app();
  const selection = it.openProject("/p");
  it.openDoc(a, "rule a {}");
  it.edit(a, "rule a { condition: true }");
  assert.equal(it.docs.isDirty(a), true, "the edit made it dirty");
  return { it, selection, key: a };
}

// ---- Leaving the project on screen ----

test("a cancelled Close Workspace changes nothing and supersedes nothing", async () => {
  const { it, selection, key } = dirtyProject();
  // A folder picker the user is still looking at. A close they cancel must leave it
  // alone: nothing has been abandoned, so nothing may be superseded.
  const pending = it.opens.begin();
  const dialog = answering(false);
  const gate = closeGate(it.world);

  assert.equal(await authorise(gate, dialog.ask), null);
  assert.equal(dialog.asked.length, 1);
  assert.equal(it.session.isOpen(), true);
  assert.equal(it.session.isCurrent(selection), true);
  assert.equal(it.docs.isDirty(key), true);
  assert.equal(it.opens.isCurrent(pending), true);
});

test("the question names unsaved work and a document whose file has gone", async () => {
  const { it } = dirtyProject();
  it.openDoc("/p/gone.yar", "rule gone {}");
  it.deleted("/p/gone.yar");
  const dialog = answering(false);

  await authorise(
    closeGate(it.world),
    dialog.ask,
  );

  const [question] = dialog.asked;
  assert.match(question, /a\.yar \(unsaved\)/);
  assert.match(question, /gone\.yar \(not on disk\)/);
});

test("a clean workspace departs without being asked anything", async () => {
  const it = app();
  it.openProject("/p");
  it.openDoc("/p/a.yar", "rule a {}");
  const dialog = answering(false);

  const claim = await authorise(
    closeGate(it.world),
    dialog.ask,
  );

  assert.notEqual(claim, null, "the departure proceeds");
  assert.deepEqual(dialog.asked, [], "and nothing was asked");
});

test("a departure is never asked about the scratch buffer", async () => {
  const it = app();
  it.openProject("/p");
  it.openDoc("", "scratch");
  it.edit("", "scratch, edited");
  assert.equal(it.docs.isDirty(""), true);
  const dialog = answering(false);

  const claim = await authorise(
    closeGate(it.world),
    dialog.ask,
  );

  // Leaving a project keeps it - it has no path and belongs to no folder - so there
  // is nothing to warn about. Exiting the application is the case that asks; see
  // closing.ts.
  assert.notEqual(claim, null);
  assert.deepEqual(dialog.asked, []);
});

// main.ts's order for the two ways into a project, both of which have to obtain a
// root before they may ask about anything: the request is claimed when the gesture is
// made, the prelude - a native picker, or an example copied out of the bundle - is
// awaited, and the gate is reached only if that produced a root. Dismissing a picker
// is not a decision about unsaved work, and neither is a copy that failed.
async function enterVia(it, prelude, dialog, action) {
  const request = it.opens.begin();
  let root;
  try {
    root = await prelude();
  } catch {
    return false;
  }
  if (root === null) return false;
  const claim = await authorise(
    departureGate(it.world, { action, request, requireOpen: false }),
    dialog.ask,
  );
  if (claim === null) return false;
  it.openProject(root);
  return true;
}

test("dismissing the folder picker never asks about unsaved work", async () => {
  const { it, selection, key } = dirtyProject();
  const dialog = answering(true);

  const opened = await enterVia(it, async () => null, dialog, "Open another folder");

  assert.equal(opened, false);
  assert.deepEqual(dialog.asked, [], "a user who was only browsing is asked nothing");
  assert.equal(it.session.isCurrent(selection), true);
  assert.equal(it.docs.isDirty(key), true);
});

test("an example that could not be prepared never asks about unsaved work", async () => {
  const { it, selection, key } = dirtyProject();
  const dialog = answering(true);

  const opened = await enterVia(
    it,
    async () => {
      throw new Error("no such example");
    },
    dialog,
    "Open an example",
  );

  assert.equal(opened, false);
  assert.deepEqual(dialog.asked, []);
  assert.equal(it.session.isCurrent(selection), true);
  assert.equal(it.docs.isDirty(key), true);
});

test("a folder that was chosen is asked about, and opens once approved", async () => {
  const { it, key } = dirtyProject();
  const dialog = answering(true);

  const opened = await enterVia(it, async () => "/q", dialog, "Open another folder");

  assert.equal(opened, true);
  assert.match(dialog.asked[0], /Open another folder and lose a\.yar \(unsaved\)\?/);
  assert.equal(it.session.root(), "/q");
  assert.equal(it.docs.isDirty(key), true, "the documents are closed by the caller's prologue");
});

test("an approval that arrives after a newer open gesture opens nothing", async () => {
  const { it, selection } = dirtyProject();
  const a = it.opens.begin();
  let b = null;
  const dialog = answering(true, () => {
    // The user gave up on the first picker and asked for another folder.
    b = it.opens.begin();
  });

  const claim = await authorise(
    departureGate(it.world, { action: "Open another folder", request: a, requireOpen: false }),
    dialog.ask,
  );

  assert.equal(claim, null, "the older gesture opens nothing");
  assert.equal(it.opens.isCurrent(b), true, "and the newer one is untouched");
  assert.equal(it.session.isCurrent(selection), true);
});

test("an approved close does not cancel the open gesture made while it was asking", async () => {
  const { it, selection, key } = dirtyProject();
  let opening = null;
  const dialog = answering(true, () => {
    opening = it.opens.begin();
  });

  const claim = await authorise(
    closeGate(it.world),
    dialog.ask,
  );

  // The close's own prologue - opens.cancel(), session.close() - is never reached, so
  // the folder the user has just asked for still opens over the project they were
  // leaving anyway.
  assert.equal(claim, null);
  assert.equal(it.opens.isCurrent(opening), true);
  assert.equal(it.session.isCurrent(selection), true);
  assert.equal(it.docs.isDirty(key), true);
});

test("a document that becomes at risk while the question is up is not covered", async () => {
  const { it } = dirtyProject();
  it.openDoc("/p/b.yar", "rule b {}");
  const dialog = answering(true, () => {
    // Never named in the question, so the answer cannot speak for it.
    it.edit("/p/b.yar", "rule b { condition: true }");
  });

  const claim = await authorise(
    closeGate(it.world),
    dialog.ask,
  );

  assert.doesNotMatch(dialog.asked[0], /b\.yar/);
  assert.equal(claim, null);
  assert.equal(it.docs.isDirty("/p/b.yar"), true);
});

test("a further edit to a document the question named is not covered either", async () => {
  const { it, key } = dirtyProject();
  const dialog = answering(true, () => {
    // The path is still at risk, but the work under it has moved on. What the user
    // agreed to lose was the revision they were shown.
    it.edit(key, "rule a { condition: false }");
  });

  const claim = await authorise(closeGate(it.world), dialog.ask);

  assert.equal(claim, null);
  assert.equal(it.docs.isDirty(key), true);
});

test("a document re-created under the same path while the question is up is not covered", async () => {
  const { it, key } = dirtyProject();
  const dialog = answering(true, () => {
    // A refresh or a rename closing that document and opening another under the same
    // path, with unsaved work of its own. Only the path is what it was.
    it.docs.remove(key);
    it.openDoc(key, "rule replacement {}");
    it.edit(key, "rule replacement { condition: true }");
  });

  const claim = await authorise(closeGate(it.world), dialog.ask);

  assert.equal(claim, null, "a path is not an identity");
  assert.equal(it.docs.isDirty(key), true);
});

test("work saved while the question is up does not cancel the answer", async () => {
  const { it, key } = dirtyProject();
  const dialog = answering(true, () => {
    // The user's other Save landed. That document is no longer at risk, and the
    // answer covered more than is left rather than less.
    assert.equal(it.docs.completeSave(it.docs.beginSave(key)), true);
  });

  const claim = await authorise(
    closeGate(it.world),
    dialog.ask,
  );

  assert.notEqual(claim, null, "the departure the user approved still happens");
});

test("subset, not equality, is what an approved at-risk set means", () => {
  const a = { key: "a", model: {}, versionId: 1 };
  const b = { key: "b", model: {}, versionId: 1 };
  assert.equal(coversRisk([a, b], [a]), true, "saved since: still covered");
  assert.equal(coversRisk([a], [a, b]), false, "newly at risk: never covered");
  assert.equal(coversRisk([], []), true);
  assert.equal(
    coversRisk([a], [{ ...a, versionId: 2 }]),
    false,
    "edited since: a revision nobody was shown",
  );
  assert.equal(
    coversRisk([a], [{ ...a, model: {} }]),
    false,
    "re-created under the same path: a different document",
  );
});

test("a close approved after the workspace has closed closes nothing", async () => {
  const { it } = dirtyProject();
  const dialog = answering(true, () => {
    it.session.close();
  });

  const claim = await authorise(
    closeGate(it.world),
    dialog.ask,
  );

  assert.equal(claim, null);
});

test("a switch approved after the project changed underneath it opens nothing", async () => {
  const { it } = dirtyProject();
  const request = it.opens.begin();
  const dialog = answering(true, () => {
    it.openProject("/q");
  });

  const claim = await authorise(
    departureGate(it.world, { action: "Open another folder", request, requireOpen: false }),
    dialog.ask,
  );

  assert.equal(claim, null);
});

test("a confirmation that cannot be shown keeps the workspace intact", async () => {
  const { it, selection, key } = dirtyProject();
  const dialog = rejecting();

  await assert.rejects(
    authorise(
      closeGate(it.world),
      dialog.ask,
    ),
    /dialog unavailable/,
  );

  assert.equal(it.session.isOpen(), true);
  assert.equal(it.session.isCurrent(selection), true);
  assert.equal(it.docs.isDirty(key), true);
});

// ---- Saving over a version of the file Quipu never saw ----

// One edited document whose file another program has changed since: the state a
// conflicted save starts from.
function conflicted(key = "/p/a.yar") {
  const it = app();
  const selection = it.openProject("/p");
  it.openDoc(key, "rule a {}");
  it.edit(key, "mine");
  assert.deepEqual(it.external(key, "theirs"), { kind: "conflict" });
  return { it, selection, key };
}

test("a cancelled save writes nothing and leaves the conflict standing", async () => {
  const { it, key } = conflicted();
  const dialog = answering(false);

  const claim = await authorise(saveGate(it.world, key), dialog.ask);

  assert.equal(claim, null);
  assert.equal(dialog.asked.length, 1);
  assert.equal(it.docs.conflictOf(key), "changed");
  assert.equal(it.docs.isDirty(key), true);
  assert.equal(it.docs.textOf(key), "mine");
});

test("the save question says which file disagrees and how", async () => {
  const { it, key } = conflicted();
  it.openDoc("/p/gone.yar", "rule gone {}");
  it.deleted("/p/gone.yar");
  const changed = answering(false);
  const missing = answering(false);

  await authorise(saveGate(it.world, key), changed.ask);
  await authorise(saveGate(it.world, "/p/gone.yar"), missing.ask);

  assert.match(changed.asked[0], /a\.yar - changed on disk since it was opened/);
  assert.match(missing.asked[0], /gone\.yar - no longer on disk; saving recreates it/);
});

test("a save with no conflict is never asked about", async () => {
  const it = app();
  it.openProject("/p");
  it.openDoc("/p/a.yar", "rule a {}");
  it.edit("/p/a.yar", "mine");
  const dialog = answering(false);

  const claim = await authorise(saveGate(it.world, "/p/a.yar"), dialog.ask);

  assert.notEqual(claim, null);
  assert.deepEqual(dialog.asked, []);
  assert.equal(claim.snapshot.text, "mine", "and the revision written is the one shown");
});

test("another external version arriving while the question is up is not written over", async () => {
  const { it, key } = conflicted();
  const dialog = answering(true, () => {
    // A different version from the one the user was shown. The conflict kind has not
    // changed at all - it was "changed on disk" before and it still is - so the
    // observation is what refuses this.
    assert.deepEqual(it.external(key, "theirs, again"), { kind: "conflict" });
  });

  const claim = await authorise(saveGate(it.world, key), dialog.ask);

  assert.equal(claim, null);
  assert.equal(it.docs.conflictOf(key), "changed");
});

test("an edit made while the question is up is not written in its place", async () => {
  const { it, key } = conflicted();
  const dialog = answering(true, () => {
    it.edit(key, "mine, and then some");
  });

  const claim = await authorise(saveGate(it.world, key), dialog.ask);

  assert.equal(claim, null, "the revision confirmed is not the one on screen any more");
  assert.equal(it.docs.isDirty(key), true);
});

test("a reload taking the file's version while the question is up revokes the answer", async () => {
  const { it, key } = conflicted();
  const dialog = answering(true, () => {
    assert.equal(it.docs.reload(it.docs.probe(key), "theirs"), true);
  });

  const claim = await authorise(saveGate(it.world, key), dialog.ask);

  assert.equal(claim, null, "the text confirmed is one the user has just discarded");
  assert.equal(it.docs.textOf(key), "theirs");
});

test("a project switch while the question is up refuses the write", async () => {
  const { it, key } = conflicted();
  const dialog = answering(true, () => {
    it.openProject("/q");
  });

  assert.equal(await authorise(saveGate(it.world, key), dialog.ask), null);
});

test("the answer records how the file stood, for the write to re-check later", async () => {
  const { it, key } = conflicted();
  const claim = await authorise(saveGate(it.world, key), answering(true).ask);

  assert.notEqual(claim, null);
  // What main.ts's stillConfirmed() asks when this save's turn in the mutation queue
  // comes: still the version the user was shown, so still writable.
  assert.equal(answerHolds(claim.shown, key, it.docs.diskAnswer(key)), true);
  it.external(key, "theirs, again");
  assert.equal(answerHolds(claim.shown, key, it.docs.diskAnswer(key)), false);
});

// ---- The compile's auto-save ----

test("a cancelled compile writes nothing and does not start", async () => {
  const { it, key } = conflicted();
  const dialog = answering(false);

  const claim = await authorise(compileGate(it.world, { busy: it.busy }), dialog.ask);

  assert.equal(claim, null);
  assert.equal(dialog.asked.length, 1);
  assert.equal(it.docs.isDirty(key), true);
  assert.equal(it.docs.conflictOf(key), "changed");
});

test("a compile confirmation covers only the documents it presented", async () => {
  const { it, key } = conflicted();
  it.openDoc("/p/b.yar", "rule b {}");
  it.edit("/p/b.yar", "mine b");
  const dialog = answering(true, () => {
    // b.yar was named in the question, but as a file in agreement with the disk.
    // Somebody has been at it since, and the answer says nothing about that version.
    assert.deepEqual(it.external("/p/b.yar", "theirs b"), { kind: "conflict" });
  });

  const claim = await authorise(compileGate(it.world, { busy: it.busy }), dialog.ask);

  assert.equal(claim, null, "a document shown as clean cannot be written over silently");
  assert.match(dialog.asked[0], /a\.yar/);
  assert.doesNotMatch(dialog.asked[0], /b\.yar/, "only the conflicts are named");
  assert.equal(it.docs.conflictOf(key), "changed");
});

test("a document that becomes dirty while the compile question is up is not written", async () => {
  const { it } = conflicted();
  it.openDoc("/p/b.yar", "rule b {}");
  const dialog = answering(true, () => {
    it.edit("/p/b.yar", "mine b");
  });

  const claim = await authorise(compileGate(it.world, { busy: it.busy }), dialog.ask);

  assert.notEqual(claim, null, "the compile the user asked for still runs");
  assert.deepEqual(claim.keys, ["/p/a.yar"], "over the documents it asked about");
  // And b.yar, which nobody was asked about, is held to having nothing wrong with it.
  assert.equal(answerHolds(claim.shown, "/p/b.yar", it.docs.diskAnswer("/p/b.yar")), true);
});

test("a compile started by another route while the question is up wins", async () => {
  const { it } = conflicted();
  const dialog = answering(true, () => {
    it.startCompiling();
  });

  assert.equal(await authorise(compileGate(it.world, { busy: it.busy }), dialog.ask), null);
});

test("a compile with nothing in conflict is prompt-free", async () => {
  const it = app();
  it.openProject("/p");
  it.openDoc("/p/a.yar", "rule a {}");
  it.edit("/p/a.yar", "mine");
  const dialog = answering(false);

  const claim = await authorise(compileGate(it.world, { busy: it.busy }), dialog.ask);

  assert.deepEqual(claim.keys, ["/p/a.yar"]);
  assert.deepEqual(dialog.asked, []);
});

// ---- Reload from Disk ----

test("a cancelled reload keeps the editor's text and the conflict", async () => {
  const { it, key } = conflicted();
  const dialog = answering(false);

  const claim = await authorise(reloadGate(it.world), dialog.ask);

  assert.equal(claim, null);
  assert.match(dialog.asked[0], /Discard unsaved changes to a\.yar/);
  assert.equal(it.docs.textOf(key), "mine");
  assert.equal(it.docs.conflictOf(key), "changed");
});

test("a clean document in conflict is reloaded without being asked about", async () => {
  const { it, key } = conflicted();
  // The edit that caused the conflict has been undone, so the document agrees with
  // the revision it was opened at and holds nothing the disk has not got. Reloading
  // it destroys nothing, and asking would teach the user to click through the
  // question that matters.
  it.undo(key);
  assert.equal(it.docs.isDirty(key), false);
  assert.equal(it.docs.conflictOf(key), "changed");
  const dialog = answering(false);

  const claim = await authorise(reloadGate(it.world), dialog.ask);

  assert.notEqual(claim, null);
  assert.deepEqual(dialog.asked, []);
});

test("an edit made while the reload question is up prevents the reload", async () => {
  const { it, key } = conflicted();
  const dialog = answering(true, () => {
    it.edit(key, "mine, and then some");
  });

  const claim = await authorise(reloadGate(it.world), dialog.ask);

  assert.equal(claim, null);
  assert.equal(it.docs.textOf(key), "mine, and then some");
});

test("navigating to another document while the question is up prevents the reload", async () => {
  const { it, key } = conflicted();
  it.openDoc("/p/b.yar", "rule b {}");
  it.activate(key);
  const dialog = answering(true, () => {
    it.activate("/p/b.yar");
  });

  const claim = await authorise(reloadGate(it.world), dialog.ask);

  assert.equal(claim, null, "a reload must not replace text off screen");
  assert.equal(it.docs.textOf(key), "mine");
});

test("a project switch while the reload question is up prevents the reload", async () => {
  const { it, key } = conflicted();
  const dialog = answering(true, () => {
    it.openProject("/q");
  });

  assert.equal(await authorise(reloadGate(it.world), dialog.ask), null);
  assert.equal(it.docs.textOf(key), "mine");
});

test("a conflict resolved while the question is up leaves nothing to reload", async () => {
  const { it, key } = conflicted();
  const dialog = answering(true, () => {
    // The user's Save landed first and the file now holds their text.
    assert.equal(it.docs.completeSave(it.docs.beginSave(key)), true);
  });

  const claim = await authorise(reloadGate(it.world), dialog.ask);

  assert.equal(claim, null);
  assert.equal(it.docs.textOf(key), "mine");
  assert.equal(it.docs.conflictOf(key), null);
});

test("an approved reload names the exact revision it was given about", async () => {
  const { it, key } = conflicted();

  const claim = await authorise(reloadGate(it.world), answering(true).ask);

  assert.notEqual(claim, null);
  assert.equal(claim.key, key);
  // The probe the question was asked about, and the only thing documents.ts will
  // accept a reload against.
  assert.equal(it.docs.reload(claim.expect, "theirs"), true);
  assert.equal(it.docs.textOf(key), "theirs");
  assert.equal(it.docs.conflictOf(key), null);
  assert.equal(it.docs.isDirty(key), false);
});

test("a reload confirmation that cannot be shown reloads nothing", async () => {
  const { it, key } = conflicted();

  await assert.rejects(authorise(reloadGate(it.world), rejecting().ask), /dialog unavailable/);

  assert.equal(it.docs.textOf(key), "mine");
  assert.equal(it.docs.conflictOf(key), "changed");
});

// ---- The defect itself ----

test("no browser-global confirmation is left anywhere in the frontend", () => {
  // `window.confirm` displays nothing and returns true in Quipu's WebKitGTK webview,
  // so a guard built on it discards the user's work in silence. Every confirmation
  // goes through the dialog plugin instead, which main.ts imports under another name
  // precisely so that a bare `confirm(` cannot be anything but the broken global.
  // A property access - `this.hooks.confirm(...)` - is not the global and is allowed,
  // except when the object it hangs off is the global itself, which is the form the
  // lookbehind would otherwise wave through.
  const bare = /(?<![\w.])confirm\s*\(|\b(?:window|globalThis|self|top|parent)\s*\.\s*confirm\s*\(/;
  // The whole frontend, subdirectories included: lsp/ is frontend code too, and a
  // scan of one directory would go on passing while the tree grew around it.
  const sources = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sources(join(dir, entry.name))
        : entry.name.endsWith(".ts")
          ? [join(dir, entry.name)]
          : [],
    );
  const root = import.meta.dirname;
  const scanned = sources(root);
  const offenders = scanned
    .filter((path) => bare.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path));

  assert.deepEqual(offenders, []);
  assert.ok(
    scanned.some((path) => path.includes(`${sep}lsp${sep}`)),
    "and the walk really did descend into the subdirectories",
  );
});
