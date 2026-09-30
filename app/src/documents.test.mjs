// Tests for the open documents and, above all, for the save baseline
// (documents.ts).
//
// Run with `npm test`. A write to disk is asynchronous and the user keeps typing
// during it, so every case below is the same question asked at a different moment:
// when the write finishes, WHICH revision of the document is on disk? Recording
// "whatever the model says now" is wrong in five different ways, and each of them
// silently loses an edit: the document is marked clean, the Save button greys out,
// and the next Ctrl+S has nothing to do.
//
// No Monaco. A model here is the two methods the bookkeeping uses, with an
// alternative version id that behaves the way Monaco's does: a new value for every
// edit, and an earlier value restored by undoing back to that earlier state.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DocumentSet } from "./documents.ts";

// A stand-in for a Monaco text model. `edit` and `undo` are the test's handles on
// it; `getValue` and `getAlternativeVersionId` are all that documents.ts sees.
function model(text) {
  let version = 1;
  let cursor = 0;
  const history = [{ value: text, version }];
  return {
    getValue: () => history[cursor].value,
    getAlternativeVersionId: () => history[cursor].version,
    // An edit discards any undone states, exactly as a real editor does.
    edit(value) {
      history.length = cursor + 1;
      version += 1;
      history.push({ value, version });
      cursor = history.length - 1;
    },
    undo() {
      if (cursor > 0) cursor -= 1;
    },
    redo() {
      if (cursor + 1 < history.length) cursor += 1;
    },
    // Monaco's setValue is an edit like any other as far as version ids go, which
    // is exactly why a reload has to move the baseline itself.
    setValue(value) {
      this.edit(value);
    },
  };
}

// What a rename carries onto the new key. Named because the shape is load-bearing:
// `dirty` alone would give the new document no idea what its file holds, dropping
// `conflict` would have a rename resolve a disagreement with the disk that nobody has
// settled, and dropping `observed` would make a read of the version already reported at
// the new path look like news. `observed` defaults to the baseline, which is what a
// document not in conflict has last seen.
function carried(dirty, diskText, conflict = null, observed = diskText) {
  return { dirty, diskText, conflict, observed };
}

// One open document, with an edit already made: the state a save starts from.
function dirtyDoc(key = "/p/main.yar", text = "rule a {}") {
  const docs = new DocumentSet();
  const m = model(text);
  docs.ensure(key, () => m);
  m.edit("rule a { condition: true }");
  assert.equal(docs.isDirty(key), true, "the edit made it dirty");
  return { docs, model: m, key };
}

test("a document is clean when opened and dirty once edited", () => {
  const docs = new DocumentSet();
  const m = model("rule a {}");
  docs.ensure("/p/a.yar", () => m);
  assert.equal(docs.isDirty("/p/a.yar"), false);
  m.edit("rule a { }");
  assert.equal(docs.isDirty("/p/a.yar"), true);
});

test("ensure() does not replace a document that is already open", () => {
  const docs = new DocumentSet();
  const first = model("rule a {}");
  const created = docs.ensure("/p/a.yar", () => first);
  assert.equal(created.created, true);
  const again = docs.ensure("/p/a.yar", () => {
    throw new Error("a second model must not be created for an open key");
  });
  assert.equal(again.created, false);
  assert.equal(again.model, first);
});

test("a save writes the captured text and leaves the document clean", () => {
  const { docs, key } = dirtyDoc();
  const snap = docs.beginSave(key);
  assert.equal(snap.key, key);
  assert.equal(snap.text, "rule a { condition: true }");

  assert.equal(docs.completeSave(snap), true);
  assert.equal(docs.isDirty(key), false);
});

test("the snapshot holds the text as it was, not the text as it becomes", () => {
  const { docs, model: m, key } = dirtyDoc();
  const snap = docs.beginSave(key);
  m.edit("rule a { condition: false }");
  // The bug this type exists to prevent: the write must send `snap.text`, and a
  // caller that re-reads the model instead sends something else entirely.
  assert.equal(snap.text, "rule a { condition: true }");
  assert.notEqual(snap.text, docs.textOf(key));
});

test("an edit while the write is in flight leaves the document dirty", () => {
  const { docs, model: m, key } = dirtyDoc();
  const snap = docs.beginSave(key);
  // Typed after the text was captured, so it is not what reached the disk.
  m.edit("rule a { condition: false }");

  assert.equal(docs.completeSave(snap), true, "the save still applies to this document");
  assert.equal(
    docs.isDirty(key),
    true,
    "and the document is still dirty, because the edit was never written",
  );

  // The proof that the baseline moved to the CAPTURED revision rather than being
  // left alone: undoing that edit returns the document to what was written, and it
  // is clean again.
  m.undo();
  assert.equal(docs.isDirty(key), false);
  m.redo();
  assert.equal(docs.isDirty(key), true, "and dirty again, so the next save writes it");
});

test("a second save of the edit made during the first one cleans the document", () => {
  const { docs, model: m, key } = dirtyDoc();
  const first = docs.beginSave(key);
  m.edit("rule a { condition: false }");
  docs.completeSave(first);

  const second = docs.beginSave(key);
  assert.equal(second.text, "rule a { condition: false }");
  assert.equal(docs.completeSave(second), true);
  assert.equal(docs.isDirty(key), false);
});

test("a save cannot clean a replacement model opened under the same key", () => {
  const { docs, key } = dirtyDoc();
  const snap = docs.beginSave(key);

  // The document is closed and re-opened from disk while the write is in flight -
  // a folder re-opened, say. The new model has never been written by this save.
  docs.remove(key);
  const replacement = model("rule a { condition: true }");
  docs.ensure(key, () => replacement);
  replacement.edit("edited in the new document");

  assert.equal(docs.completeSave(snap), false);
  assert.equal(docs.isDirty(key), true, "the replacement's own edit is untouched");
});

test("a save cannot clean the model a rename moved the document onto", () => {
  const { docs, key } = dirtyDoc();
  const snap = docs.beginSave(key);

  // renameDoc(): the old key is gone and the contents continue on a new model
  // under the new key, marked dirty because that file has never been written.
  const moved = model(docs.textOf(key));
  docs.remove(key);
  docs.ensure("/p/renamed.yar", () => moved, carried(true, "rule a {}"));

  assert.equal(docs.completeSave(snap), false, "the key it was written under is gone");
  assert.equal(
    docs.isDirty("/p/renamed.yar"),
    true,
    "and the renamed document is still unwritten",
  );
  assert.deepEqual(docs.keys(), ["/p/renamed.yar"]);
});

test("a save that outlives the workspace being closed applies to nothing", () => {
  const { docs, key } = dirtyDoc();
  const snap = docs.beginSave(key);

  // closeFiles(): every real file is removed and its model disposed.
  assert.notEqual(docs.remove(key), null);
  assert.equal(docs.completeSave(snap), false);
  assert.deepEqual(docs.keys(), []);

  // And the answer does not change if the same path is opened again later, in
  // another project: that document has its own model and its own baseline.
  const reopened = model("rule a {}");
  docs.ensure(key, () => reopened);
  reopened.edit("edited after re-opening");
  assert.equal(docs.completeSave(snap), false);
  assert.equal(docs.isDirty(key), true);
});

test("beginSave() on a document that is not open captures nothing", () => {
  const docs = new DocumentSet();
  assert.equal(docs.beginSave("/p/never-opened.yar"), null);
});

test("closed documents stop appearing in dirty queries", () => {
  const docs = new DocumentSet();
  const scratch = model("scratch");
  const a = model("rule a {}");
  const b = model("rule b {}");
  docs.ensure("", () => scratch);
  docs.ensure("/p/a.yar", () => a);
  docs.ensure("/p/b.yar", () => b);
  scratch.edit("edited scratch");
  a.edit("edited a");

  assert.deepEqual(docs.dirtyKeys(), ["", "/p/a.yar"], "in the order they were opened");

  // Leaving the project closes every file. What the compile's save plan and the
  // explorer ask about afterwards must not include documents from a project that
  // is no longer open - they have nowhere to be saved to and nothing to belong to.
  for (const key of docs.keys()) {
    if (key !== "") docs.remove(key);
  }
  assert.deepEqual(docs.dirtyKeys(), [""], "only the scratch buffer is left");
  assert.deepEqual(docs.keys(), [""]);
  assert.equal(docs.isDirty("/p/a.yar"), false);
  assert.equal(docs.textOf("/p/a.yar"), "");
});

test("a document carried across a rename is dirty from the outset", () => {
  const docs = new DocumentSet();
  const moved = model("rule a { condition: true }");
  docs.ensure("/p/renamed.yar", () => moved, carried(true, "rule a {}"));
  // Nothing was typed into it: the model is new, and reports no changes of its
  // own. It is dirty because the file it now names has never been written.
  assert.equal(docs.isDirty("/p/renamed.yar"), true);

  const snap = docs.beginSave("/p/renamed.yar");
  assert.equal(docs.completeSave(snap), true);
  assert.equal(docs.isDirty("/p/renamed.yar"), false);
});

// ---- Reconciling against the disk ----
//
// The project's files are watched, so a document can be told that its file changed
// underneath it. What follows is what "changed" is allowed to mean. Every case is
// the same read landing against a different state of the document, because that is
// exactly what varies in practice: the read is asynchronous and the user keeps
// typing, closing and renaming things while it is in flight.

const present = (text) => ({ present: true, text });
const absent = { present: false };

// Reconciling as the caller does it: probe, read the file, hand the probe back. The
// probe is what scopes the answer to the document it was drawn about, so a test that
// passed a bare key could not tell a stale read from a current one.
function reconcileNow(docs, key, disk) {
  return docs.reconcile(docs.probe(key), disk);
}

// One clean open document whose file holds what it was opened with.
function openDoc(key = "/p/main.yar", text = "rule a {}") {
  const docs = new DocumentSet();
  const m = model(text);
  docs.ensure(key, () => m);
  return { docs, model: m, key };
}

test("a file still holding what was last written reconciles to nothing", () => {
  const { docs, key } = openDoc();
  assert.deepEqual(reconcileNow(docs, key, present("rule a {}")), { kind: "none" });
  assert.equal(docs.conflictOf(key), null);
});

test("a notification for Quipu's own completed save is not a conflict", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("rule a { condition: true }");
  const snap = docs.beginSave(key);
  docs.completeSave(snap);
  // The watcher's notice for that very write arrives afterwards. The disk holds
  // exactly what was written, so there is nothing external about it.
  assert.deepEqual(reconcileNow(docs, key, present("rule a { condition: true }")), {
    kind: "none",
  });
  assert.equal(docs.conflictOf(key), null);
  assert.equal(docs.isDirty(key), false);
});

test("a clean document whose file changed is reloaded", () => {
  const { docs, model: m, key } = openDoc();
  const expect = docs.probe(key);
  const outcome = docs.reconcile(expect, present("rule a { condition: true }"));
  assert.deepEqual(outcome, { kind: "reload", text: "rule a { condition: true }" });
  // Deliberately nothing yet: replacing text has to be guarded on the read still
  // describing this document, so reconcile() only says what to do.
  assert.equal(m.getValue(), "rule a {}");

  assert.equal(docs.reload(expect, outcome.text), true);
  assert.equal(m.getValue(), "rule a { condition: true }");
  assert.equal(docs.isDirty(key), false, "a reload is a new agreement with the disk");
  assert.equal(docs.conflictOf(key), null);
});

test("a reload leaves nothing for the next reconcile to do", () => {
  const { docs, key } = openDoc();
  const expect = docs.probe(key);
  docs.reload(expect, "rule a { condition: true }");
  assert.deepEqual(reconcileNow(docs, key, present("rule a { condition: true }")), {
    kind: "none",
  });
});

test("a user edit while the reload read was pending keeps their text", () => {
  const { docs, model: m, key } = openDoc();
  const expect = docs.probe(key);
  // Typed while the file was being read. The document is dirty by the time the
  // read lands, so the answer is a conflict rather than a reload...
  m.edit("mine");
  const outcome = docs.reconcile(expect, present("theirs"));
  assert.deepEqual(outcome, { kind: "conflict" });
  assert.equal(docs.conflictOf(key), "changed");
  // ...and even if a caller went on to apply the reload it was about to, the
  // version guard refuses it.
  assert.equal(docs.reload(expect, "theirs"), false);
  assert.equal(m.getValue(), "mine");
  assert.equal(docs.isDirty(key), true);
});

test("a dirty document changed externally is a conflict and is never replaced", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  assert.deepEqual(reconcileNow(docs, key, present("theirs")), { kind: "conflict" });
  assert.equal(m.getValue(), "mine");
  assert.equal(docs.conflictOf(key), "changed");
  assert.deepEqual(docs.conflictedKeys(), [key]);

  // And it stays a conflict however many notices arrive: the baseline was not
  // moved, so the same disk contents reach the same answer rather than quietly
  // becoming "nothing happened".
  assert.deepEqual(reconcileNow(docs, key, present("theirs")), { kind: "conflict" });
});

test("a dirty document is clean and unconflicted once its edits match the disk", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("theirs");
  // Both sides arrived at the same text. There is nothing to reconcile and nothing
  // to warn about; the editor is simply right.
  assert.deepEqual(reconcileNow(docs, key, present("theirs")), { kind: "adopt" });
  assert.equal(docs.isDirty(key), false);
  assert.equal(docs.conflictOf(key), null);
});

test("saving over a conflict ends it", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  reconcileNow(docs, key, present("theirs"));
  assert.equal(docs.conflictOf(key), "changed");

  const snap = docs.beginSave(key);
  assert.equal(docs.completeSave(snap), true);
  assert.equal(docs.conflictOf(key), null, "the file now holds what this document holds");
  assert.deepEqual(reconcileNow(docs, key, present("mine")), { kind: "none" });
});

test("a file that has gone is a conflict, not a closed document", () => {
  const { docs, model: m, key } = openDoc();
  assert.deepEqual(reconcileNow(docs, key, absent), { kind: "missing" });
  assert.equal(docs.conflictOf(key), "missing");
  // The document's text is the only copy left, so it stays exactly where it is.
  assert.deepEqual(docs.keys(), [key]);
  assert.equal(m.getValue(), "rule a {}");
});

test("a deleted file reappearing with other contents is reconciled again", () => {
  const { docs, key } = openDoc();
  reconcileNow(docs, key, absent);
  const expect = docs.probe(key);
  const outcome = docs.reconcile(expect, present("recreated by someone else"));
  assert.deepEqual(outcome, { kind: "reload", text: "recreated by someone else" });
  // Still marked until the reload actually lands. A reload that the version guard
  // refuses must not leave the document looking reconciled.
  assert.equal(docs.conflictOf(key), "missing");
  assert.equal(docs.reload(expect, outcome.text), true);
  assert.equal(docs.conflictOf(key), null, "and now there is a file, holding what it holds");
});

test("a read that lands after the document was closed changes nothing", () => {
  const { docs, key } = openDoc();
  const expect = docs.probe(key);
  docs.remove(key);
  assert.deepEqual(docs.reconcile(expect, present("theirs")), { kind: "stale" });
  assert.equal(docs.reload(expect, "theirs"), false);
  assert.deepEqual(docs.keys(), []);
});

test("a read decides nothing about the model a rename put under its key", () => {
  const { docs, key } = openDoc();
  const expect = docs.probe(key);

  // renameDoc() the other way about: another file is renamed ONTO this path while
  // the read is in flight, so the key is open but the document is not the one read.
  docs.remove(key);
  const other = model("a different file entirely");
  docs.ensure(key, () => other, carried(true, "what this path held before"));

  // Deliberately the text the replacement is showing. Keyed on the path alone this
  // read would look like the file having caught up with the editor, and the
  // replacement - which has never been written to this path - would be marked clean
  // against a baseline nobody wrote. Scoped to the probe, it decides nothing.
  assert.deepEqual(docs.reconcile(expect, present("a different file entirely")), {
    kind: "stale",
  });
  assert.equal(other.getValue(), "a different file entirely");
  assert.equal(docs.isDirty(key), true, "still unwritten at this path");
  assert.equal(docs.conflictOf(key), null, "and not in a conflict drawn about a stranger");
  // Its baseline is untouched too, which only another reconcile can show: the disk
  // still holding what this path held is nothing having happened.
  assert.deepEqual(reconcileNow(docs, key, present("what this path held before")), {
    kind: "none",
  });

  // Nor may the reload the read was about land on it.
  assert.equal(docs.reload(expect, "theirs"), false);
  assert.equal(other.getValue(), "a different file entirely");
});

test("an edit made while the read was pending is still a conflict", () => {
  const { docs, model: m, key } = openDoc();
  const expect = docs.probe(key);
  // The same model, at a later revision. That is not a stale read - it is precisely
  // the case the conflict exists for - so the probe scopes the answer to the
  // document, never to the revision. An edit establishes nothing about the file
  // either, so it moves no baseline and does not supersede the read.
  m.edit("mine");
  assert.deepEqual(docs.reconcile(expect, present("theirs")), { kind: "conflict" });
  assert.equal(docs.conflictOf(key), "changed");
});

test("a read cannot reload a document a save has moved on since", () => {
  const { docs, model: m, key } = openDoc();
  const expect = docs.probe(key);
  // Saved while the reconciliation read was in flight. The revision the read
  // describes is no longer the one the document is at.
  m.edit("saved since");
  docs.completeSave(docs.beginSave(key));
  assert.equal(docs.reload(expect, "theirs"), false);
  assert.equal(m.getValue(), "saved since");
  assert.equal(docs.isDirty(key), false, "and the save's own baseline is untouched");
});

// ---- Which observation of the file an answer was about ----
//
// A conflict is an answer, not an identity: a file changed twice while a write queued
// gives the same answer both times. So the accepted answers about a file are counted,
// and `diskAnswer` hands the count out with the conflict for a caller to compare when
// its write's turn comes. The count moves only when what was found is different from
// what was found before, because a repeated answer authorises nothing new and must
// revoke nothing either.

test("a repeated external version is one observation, and a second one is a new answer", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  const opened = docs.diskAnswer(key);
  assert.deepEqual(opened, { conflict: null, observation: 0, restored: 0 });

  reconcileNow(docs, key, present("theirs A"));
  const versionA = docs.diskAnswer(key);
  assert.equal(versionA.conflict, "changed");
  assert.notEqual(versionA.observation, opened.observation, "a version nobody had seen");

  // The catch-up after a fence re-reads a file it has already reported. Counting that
  // would revoke a permission the user gave for exactly this version.
  reconcileNow(docs, key, present("theirs A"));
  assert.deepEqual(docs.diskAnswer(key), versionA, "the same answer about the same file");

  // A different version is the case the conflict kind cannot express.
  reconcileNow(docs, key, present("theirs B"));
  const versionB = docs.diskAnswer(key);
  assert.equal(versionB.conflict, "changed", "still just 'changed'");
  assert.notEqual(versionB.observation, versionA.observation, "and yet not the same answer");
});

test("a file that is still missing is not news twice over", () => {
  const { docs, key } = openDoc();
  reconcileNow(docs, key, absent);
  const gone = docs.diskAnswer(key);
  assert.equal(gone.conflict, "missing");

  reconcileNow(docs, key, absent);
  assert.deepEqual(docs.diskAnswer(key), gone, "still gone, and still the same answer");

  // Whereas the file coming back is something to have found out, even before the reload
  // that answer implies lands.
  const expect = docs.probe(key);
  docs.reconcile(expect, present("recreated by someone else"));
  assert.notEqual(docs.diskAnswer(key).observation, gone.observation);
});

test("a document's own save is not an observation that revokes anything", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  reconcileNow(docs, key, present("theirs"));
  const agreed = docs.diskAnswer(key);

  // Written over, which is what the user agreed to. The conflict is over, so the answer
  // is a different one - but the count is Quipu's own writing and must not move: a
  // mutation queued behind this save was authorised against exactly this count.
  docs.completeSave(docs.beginSave(key));
  const afterSave = docs.diskAnswer(key);
  assert.equal(afterSave.conflict, null);
  assert.equal(afterSave.observation, agreed.observation);

  // And what the file now holds is known from having written it, so reading it back is
  // not news either.
  reconcileNow(docs, key, present("mine"));
  assert.deepEqual(docs.diskAnswer(key), afterSave);
});

test("Reload from Disk is an observation like any other read", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  const before = docs.diskAnswer(key);
  // It bypasses reconcile() entirely: the user asked for the file's text and got it, so
  // what the file holds was found out here and nowhere else.
  docs.reload(docs.probe(key), "theirs");
  const after = docs.diskAnswer(key);
  assert.equal(after.conflict, null);
  assert.notEqual(after.observation, before.observation);
  assert.equal(m.getValue(), "theirs");
});

test("a conflict resolved by saving keeps the answer; resolved by reloading it does not", () => {
  // Two Saves over one conflict: what the first one leaves behind is Quipu's own text,
  // which is what both gestures asked for, so the answer the second was authorised
  // against still stands and it goes on to write its own revision.
  const own = openDoc();
  own.model.edit("mine");
  reconcileNow(own.docs, own.key, present("theirs"));
  const authorised = own.docs.diskAnswer(own.key);
  own.docs.completeSave(own.docs.beginSave(own.key));
  const afterSave = own.docs.diskAnswer(own.key);
  assert.equal(afterSave.observation, authorised.observation, "nobody else has been here");
  assert.equal(afterSave.restored, authorised.restored, "and nothing was discarded");

  // Reload from Disk resolves the same conflict the other way. The version it takes was
  // already the one reported, so nothing about the FILE was found out - and yet the
  // revision a queued write captured has been thrown away, which is what the count says.
  const taken = openDoc();
  taken.model.edit("mine");
  reconcileNow(taken.docs, taken.key, present("theirs"));
  const before = taken.docs.diskAnswer(taken.key);
  taken.docs.reload(taken.docs.probe(taken.key), "theirs");
  const after = taken.docs.diskAnswer(taken.key);
  assert.equal(after.observation, before.observation, "the same version, already observed");
  assert.notEqual(after.restored, before.restored, "but the document is no longer theirs");
});

test("a read a newer operation refused observes nothing", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  const expect = docs.probe(key);
  docs.completeSave(docs.beginSave(key));
  const agreed = docs.diskAnswer(key);

  // The read describes the file as it was before that write. It decides nothing, so it
  // must not be counted as an answer about the file either - a write authorised since
  // would be refused on the strength of a read that was never accepted.
  assert.deepEqual(docs.reconcile(expect, present("theirs")), { kind: "stale" });
  assert.deepEqual(docs.diskAnswer(key), agreed);
});

test("a path nothing is open under answers with no conflict and no observations", () => {
  const docs = new DocumentSet();
  assert.deepEqual(docs.diskAnswer("/p/never-opened.yar"), {
    conflict: null,
    observation: 0,
    restored: 0,
  });
});

test("a renamed document starts its own count, and its conflict comes with it", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  reconcileNow(docs, key, present("theirs"));

  // renameDoc(): the same text and the same disagreement, under another key. A write
  // authorised for the old path is not authorised for the new one, so its count is the
  // new document's own rather than the old one's carried over.
  const carriedOver = docs.carriedFrom(key);
  docs.remove(key);
  docs.ensure("/p/moved.yar", () => model("mine"), carriedOver);
  const moved = docs.diskAnswer("/p/moved.yar");
  assert.equal(moved.conflict, "changed", "still in conflict with the file it came from");
  assert.equal(moved.observation, 0);
  assert.deepEqual(
    docs.diskAnswer(key),
    { conflict: null, observation: 0, restored: 0 },
    "nothing there",
  );

  // And what it was last seen to hold moved with it, so re-reading that is not news.
  reconcileNow(docs, "/p/moved.yar", present("theirs"));
  assert.deepEqual(docs.diskAnswer("/p/moved.yar"), moved);
});

// ---- A read a newer disk operation has overtaken ----
//
// A save writes the file and a reload takes it: both END one agreement with the disk
// and begin another, and both can happen while a read of that same file is in flight.
// What that read found is then a comparison against an agreement that no longer
// exists. The revision cannot detect it - a save moves the baseline without touching
// the model, and recording a `missing` conflict compares no revisions at all - so
// every probe records which agreement it was drawn against.

test("a read from before a save is refused at the very revision the save wrote", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  const expect = docs.probe(key);
  // Saved at exactly the revision this read was drawn against: what the disk holds
  // moved, and nothing the model can report did.
  docs.completeSave(docs.beginSave(key));
  assert.equal(docs.isDirty(key), false);

  assert.deepEqual(docs.reconcile(expect, present("theirs")), { kind: "stale" });
  assert.equal(docs.reload(expect, "theirs"), false, "and the reload it implied is refused");
  assert.equal(m.getValue(), "mine", "the text that was written is what is on screen");
  assert.equal(docs.isDirty(key), false);
  assert.equal(docs.conflictOf(key), null, "and no conflict was drawn about the old file");

  // The baseline is the save's, which only another reconcile can show: the file
  // holding what was written is nothing having happened, and a change to it after
  // that is still found.
  assert.deepEqual(reconcileNow(docs, key, present("mine")), { kind: "none" });
  assert.deepEqual(reconcileNow(docs, key, present("theirs, later")), {
    kind: "reload",
    text: "theirs, later",
  });
});

test("a read from before a save recreated the file cannot mark it missing", () => {
  const { docs, key } = openDoc();
  assert.deepEqual(reconcileNow(docs, key, absent), { kind: "missing" });

  // A second read of the missing file is in flight when the user saves, which puts
  // the file back.
  const expect = docs.probe(key);
  docs.completeSave(docs.beginSave(key));
  assert.equal(docs.conflictOf(key), null, "the file is there again");

  assert.deepEqual(docs.reconcile(expect, absent), { kind: "stale" });
  assert.equal(docs.conflictOf(key), null, "so the interval it describes is over");
  assert.equal(docs.needsSaving(key), false);
  assert.deepEqual(docs.atRiskKeys(), [], "and nothing is at risk any more");
});

test("a read issued before a reload is refused once that reload has landed", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  assert.deepEqual(reconcileNow(docs, key, present("theirs")), { kind: "conflict" });

  // An automatic read is outstanding when the user resolves the conflict explicitly
  // by taking the file's version.
  const automatic = docs.probe(key);
  assert.equal(docs.reload(docs.probe(key), "theirs"), true);
  assert.equal(docs.conflictOf(key), null);

  // The older read describes the file before the reload read it. Whatever it found -
  // other contents, or no file at all - applying it would undo the resolution the
  // user asked for.
  assert.deepEqual(docs.reconcile(automatic, absent), { kind: "stale" });
  assert.deepEqual(docs.reconcile(automatic, present("theirs")), { kind: "stale" });
  assert.equal(docs.reload(automatic, "older still"), false);
  assert.equal(m.getValue(), "theirs");
  assert.equal(docs.isDirty(key), false);
  assert.equal(docs.conflictOf(key), null);
});

// ---- Two reads of one file, in flight at once ----
//
// Automatic reconciliation, a manual Refresh, a fence's catch-up and explicit conflict
// handling all read the same file, and nothing stops two of them overlapping. The
// baseline cannot order them: `missing` and `conflict` deliberately establish no new
// agreement with the disk - a disagreement is not knowledge of what the file holds - so
// two reads drawn against one baseline both remain valid against it, and their answers
// would otherwise take effect in whatever order they happened to arrive. So each read
// takes a number, and an answer from below the highest already applied is inert.

test("an earlier read cannot report a file gone that a later read found present", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  // Two reads issued, in this order.
  const earlier = docs.probe(key);
  const later = docs.probe(key);

  // The later one comes back first, and finds the file present with another program's
  // text in it.
  assert.deepEqual(docs.reconcile(later, present("theirs")), { kind: "conflict" });
  assert.equal(docs.conflictOf(key), "changed");

  // Then the earlier one lands, from the moment before the file was put back. Applying
  // it would tell the user their only copy of the text is all that is left of a file
  // that demonstrably exists.
  assert.deepEqual(docs.reconcile(earlier, absent), { kind: "stale" });
  assert.equal(docs.conflictOf(key), "changed");
  assert.equal(m.getValue(), "mine");
  assert.equal(docs.isDirty(key), true);
  assert.deepEqual(docs.atRiskKeys(), [key], "at risk because it is dirty, not because it is gone");

  // And the baseline both reads were drawn against still stands: neither answer
  // established what the file holds, so the disagreement is decided again from
  // current facts.
  assert.deepEqual(reconcileNow(docs, key, present("theirs")), { kind: "conflict" });
  assert.deepEqual(reconcileNow(docs, key, present("mine")), { kind: "adopt" });
  assert.equal(docs.isDirty(key), false);
});

test("an earlier read cannot report contents for a file a later read found gone", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  const earlier = docs.probe(key);
  const later = docs.probe(key);

  assert.deepEqual(docs.reconcile(later, absent), { kind: "missing" });
  assert.equal(docs.conflictOf(key), "missing");

  // The earlier read saw the file before it was deleted. Recording it would downgrade
  // the conflict to `changed`, and the document would claim to be out of step with a
  // file that is not there - which is also the difference between being offered a save
  // that recreates it and being told it merely diverged.
  assert.deepEqual(docs.reconcile(earlier, present("theirs")), { kind: "stale" });
  assert.equal(docs.conflictOf(key), "missing");
  assert.equal(m.getValue(), "mine");
  assert.equal(docs.isDirty(key), true);
  assert.deepEqual(docs.atRiskKeys(), [key]);

  // The baseline is untouched by either, so the next read decides afresh.
  assert.deepEqual(reconcileNow(docs, key, present("theirs")), { kind: "conflict" });
});

test("an earlier read cannot say nothing happened after a later one found the file gone", () => {
  const { docs, key } = openDoc();
  const earlier = docs.probe(key);
  const later = docs.probe(key);

  assert.deepEqual(docs.reconcile(later, absent), { kind: "missing" });

  // The earlier read found the file still holding what Quipu last agreed with it on,
  // which reconciles to `none` - and `none` CLEARS a conflict. Out of order it would
  // erase the deletion, leaving a clean document that says it is safely on disk while
  // its text is the last copy anywhere.
  assert.deepEqual(docs.reconcile(earlier, present("rule a {}")), { kind: "stale" });
  assert.equal(docs.conflictOf(key), "missing");
  assert.equal(docs.needsSaving(key), true, "so Save is still offered, to put the file back");
});

test("reads answered in the order they were issued are both applied", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  const earlier = docs.probe(key);
  const later = docs.probe(key);

  // The ordinary case, and the one the guard must not break: each read is the newest
  // word on the file when it lands, so both are recorded and the last one decides.
  assert.deepEqual(docs.reconcile(earlier, present("theirs")), { kind: "conflict" });
  assert.equal(docs.conflictOf(key), "changed");
  assert.deepEqual(docs.reconcile(later, absent), { kind: "missing" });
  assert.equal(docs.conflictOf(key), "missing");
  assert.equal(m.getValue(), "mine");
});

test("the reload an earlier read implied is refused once a later read has answered", () => {
  const { docs, model: m, key } = openDoc();
  const earlier = docs.probe(key);
  const later = docs.probe(key);

  // A clean document whose file changed: the earlier read's answer is an instruction
  // to the caller rather than a recorded fact, and it moves no baseline until applied.
  assert.deepEqual(docs.reconcile(earlier, present("theirs")), {
    kind: "reload",
    text: "theirs",
  });
  // The later read lands in between, and finds the file gone.
  assert.deepEqual(docs.reconcile(later, absent), { kind: "missing" });

  assert.equal(docs.reload(earlier, "theirs"), false, "so the older instruction is void");
  assert.equal(m.getValue(), "rule a {}", "and the last copy of the text is untouched");
  assert.equal(docs.conflictOf(key), "missing");
});

test("a read for a document a rename replaced is refused by identity, not by order", () => {
  const { docs, key } = openDoc();
  const expect = docs.probe(key);
  // Re-keyed onto a new model, which resets the read order to nothing - so identity is
  // what has to refuse this, and it does.
  const replacement = model("elsewhere");
  docs.remove(key);
  docs.ensure(key, () => replacement, carried(false, "elsewhere"));

  assert.deepEqual(docs.reconcile(expect, absent), { kind: "stale" });
  assert.equal(docs.conflictOf(key), null);
  assert.equal(docs.reload(expect, "older still"), false);
  assert.equal(replacement.getValue(), "elsewhere");
});

test("holds() is identity alone: the document is still open, on the same model", () => {
  const { docs, model: m, key } = openDoc();
  const expect = docs.probe(key);
  assert.equal(docs.holds(expect), true);

  // Deliberately says nothing about revisions, baselines or conflicts: what a queued
  // mutation asks is whether the document it was given is still the one under this key.
  m.edit("mine");
  assert.equal(docs.holds(expect), true);
  docs.completeSave(docs.beginSave(key));
  assert.equal(docs.holds(expect), true);

  const replacement = model("elsewhere");
  docs.remove(key);
  assert.equal(docs.holds(expect), false, "closed");
  docs.ensure(key, () => replacement);
  assert.equal(docs.holds(expect), false, "and re-created under the same key is not it either");
});

test("a renamed document knows what its new file holds", () => {
  const { docs, key } = openDoc();
  const taken = docs.carriedFrom(key);
  assert.deepEqual(taken, {
    dirty: false,
    diskText: "rule a {}",
    conflict: null,
    observed: "rule a {}",
  });
  docs.remove(key);
  const moved = model("rule a {}");
  docs.ensure("/p/renamed.yar", () => moved, taken);

  // The rename moved the file, so the new path holds what the old one did. Without
  // the carried baseline this reconcile would invent a change out of nothing.
  assert.deepEqual(reconcileNow(docs, "/p/renamed.yar", present("rule a {}")), { kind: "none" });
  assert.equal(docs.conflictOf("/p/renamed.yar"), null);
});

test("a renamed document takes an unresolved conflict with it", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  assert.deepEqual(reconcileNow(docs, key, present("theirs")), { kind: "conflict" });

  // The rename moved the file as well, so the version Quipu never saw is at the new
  // path now: the disagreement is about where the bytes are, and moving them settled
  // nothing about whose bytes are right.
  const taken = docs.carriedFrom(key);
  assert.deepEqual(taken, {
    dirty: true,
    diskText: "rule a {}",
    conflict: "changed",
    // The version the document never agreed with, which the rename moved onto the new
    // path: a read finding it there is not a change, it is the same disagreement.
    observed: "theirs",
  });
  docs.remove(key);
  const moved = model("mine");
  docs.ensure("/p/renamed.yar", () => moved, taken);

  assert.equal(docs.conflictOf("/p/renamed.yar"), "changed");
  assert.deepEqual(docs.conflictedKeys(), ["/p/renamed.yar"]);
  // Still unresolved, and still reached from the disk: a rename must not be a way of
  // getting a document saved over someone else's version without being asked.
  assert.deepEqual(reconcileNow(docs, "/p/renamed.yar", present("theirs")), { kind: "conflict" });
});

test("a document with no known disk revision treats any contents as a change", () => {
  const docs = new DocumentSet();
  const m = model("typed, never written");
  docs.ensure("/p/new.yar", () => m, carried(true, null));
  // Dirty and with no baseline: whatever is on disk, it is not this text, so the
  // answer is a conflict rather than a silent replacement.
  assert.deepEqual(reconcileNow(docs, "/p/new.yar", present("something else")), {
    kind: "conflict",
  });
});

// ---- What is saveable, and what is at risk ----
//
// Two questions with deliberately different answers. Save has to be offered for
// anything the disk does not already hold, including a document nobody edited whose
// file has gone; the discard question may only name work that would actually be
// lost, or it teaches the user to click through it.

test("a document whose file has gone needs saving without being dirty", () => {
  const { docs, key } = openDoc();
  assert.equal(docs.needsSaving(key), false, "the file holds exactly this");

  assert.deepEqual(reconcileNow(docs, key, absent), { kind: "missing" });
  assert.equal(docs.isDirty(key), false, "nothing was edited");
  // Save is the only thing that can put it back, so it must be offered.
  assert.equal(docs.needsSaving(key), true);
  assert.deepEqual(docs.atRiskKeys(), [key], "and its text is the only copy left");
});

test("a conflict undone back to the baseline is saveable but not at risk", () => {
  const { docs, model: m, key } = openDoc();
  m.edit("mine");
  assert.deepEqual(reconcileNow(docs, key, present("theirs")), { kind: "conflict" });

  // Undone all the way back to what was on disk when the file was opened. The
  // document holds no edits any more, but the file still holds a third version that
  // nothing here has seen, so the disagreement stands and Save still applies.
  m.undo();
  assert.equal(docs.isDirty(key), false);
  assert.equal(docs.conflictOf(key), "changed");
  assert.equal(docs.needsSaving(key), true);
  // Nothing would be lost by closing it, though: every character it holds came from
  // the disk. Naming it in the discard question would be asking about nothing.
  assert.deepEqual(docs.atRiskKeys(), []);
});

test("at-risk documents are listed in the order they were opened", () => {
  const docs = new DocumentSet();
  const scratch = model("scratch");
  const a = model("rule a {}");
  const b = model("rule b {}");
  const c = model("rule c {}");
  docs.ensure("", () => scratch);
  docs.ensure("/p/a.yar", () => a);
  docs.ensure("/p/b.yar", () => b);
  docs.ensure("/p/c.yar", () => c);

  scratch.edit("edited scratch");
  c.edit("mine");
  assert.deepEqual(reconcileNow(docs, "/p/a.yar", absent), { kind: "missing" });
  // b.yar's file changed while it was clean, so it is simply reloaded: no conflict,
  // and nothing of the user's in it.
  assert.deepEqual(reconcileNow(docs, "/p/b.yar", present("theirs")), {
    kind: "reload",
    text: "theirs",
  });

  // The scratch buffer is in the list: it holds unsaved text like any other
  // document. Excluding it is editor.ts's job, because the reason is that it has no
  // path rather than anything about its contents.
  assert.deepEqual(docs.atRiskKeys(), ["", "/p/a.yar", "/p/c.yar"]);
  assert.deepEqual(
    docs.keys().filter((key) => docs.needsSaving(key)),
    ["", "/p/a.yar", "/p/c.yar"],
  );
});
