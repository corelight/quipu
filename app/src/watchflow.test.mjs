// Tests for what a change made outside Quipu does to the window.
//
// Run with `npm test`. The project's inputs are watched natively, and an event is
// only a hint: what it must lead to is one full analysis, open documents that agree
// with the disk or say plainly that they do not, and a compiled ruleset that stops
// being scannable the instant it stops describing the project. The cases below are
// the ordering rules that make that true, and the ones that make Quipu's OWN writes
// not look like somebody else's.
//
// The session, the operation tokens, the documents, the save plan and the refresh
// coordinator are all the real modules. What is mirrored here is main.ts's wiring
// around them: the fence, the catch-up that ends it, the reconciliation, the
// confirmations and the checks after every await. No DOM, no IPC, no Monaco and no
// clock - the debounce timer is driven by hand, and every analysis, read and write is
// a promise the test settles.
//
// The filesystem is modelled, and so is the native watcher over it: a write goes to
// the modelled disk and emits an event, which reaches the coordinator only if a
// native instance is armed. So "Quipu's own writes are not reported back to it" is
// not asserted here - it is a consequence of the fence, and the tests observe it.
//
// The fence itself is modelled as the backend implements it (src-tauri/src/watch):
// fencing hands out a token, tokens are never reused, and only the release of the
// last outstanding one re-arms the watcher. That is what makes overlapping writes
// testable here rather than merely plausible. Nothing is reported for the interval
// nothing was watching, so the last write out reconciles it itself - which is the
// only thing that can make a genuine external change during a save survive.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DocumentSet } from "./documents.ts";
import { ProjectSession, memberPathsOf } from "./project.ts";
import { Operations } from "./operations.ts";
import { saveDirtyMembers } from "./saveplan.ts";
import { basename, dirname, joinRoot } from "./sourceid.ts";
import { AutoRefresh } from "./watching.ts";
import { MutationQueue } from "./mutations.ts";

// Lets everything that can proceed proceed. What is still outstanding afterwards is
// waiting on a promise the test holds, not on a delay.
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

// A list of calls the test settles by hand. `take()` hands over the oldest one that
// has not been dealt with, so a test never has to count indices.
function calls() {
  const list = [];
  return {
    keys: () => list.map((c) => c.key),
    count: () => list.length,
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

// The debounce timer, fired when the test says so.
function clock() {
  const timers = new Map();
  let next = 1;
  return {
    handle: {
      set(fn) {
        const id = next++;
        timers.set(id, fn);
        return id;
      },
      clear(id) {
        timers.delete(id);
      },
    },
    pending: () => timers.size,
    run() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
  };
}

// A stand-in for a Monaco text model. `notify` is the content-change listener, and
// setValue fires it exactly as Monaco does - which is why the reload path has to
// suppress it rather than rely on it not happening.
function model(text, notify) {
  let value = text;
  let version = 1;
  return {
    getValue: () => value,
    getAlternativeVersionId: () => version,
    edit(next) {
      value = next;
      version += 1;
      notify();
    },
    setValue(next) {
      value = next;
      version += 1;
      notify();
    },
  };
}

// main.ts's watching, saving and compiling paths, with the DOM and IPC removed and
// the ordering kept.
function app() {
  const session = new ProjectSession();
  let resetImpl = async () => {};
  const operations = new Operations(() => resetImpl());
  const docs = new DocumentSet();
  const analyses = calls();
  const reads = calls();
  const writes = calls();
  const compiles = calls();
  // Fence commands, held only when a test asks for it: what a deferred fence exists
  // to test is what a command does when the project changes while it waits.
  const fenceCalls = calls();
  let deferFences = false;
  const timer = clock();

  // The modelled disk, and the native watcher over it.
  //
  // `subscription` is the serial the backend has recorded, which it does whether or
  // not arming succeeded; `armed` is a live instance. `outstanding` is the set of
  // fence tokens handed out and not yet released, and `next` never goes backwards, so
  // a token from an abandoned mutation cannot be mistaken for a live one.
  const disk = new Map();
  const native = {
    armed: false,
    subscription: 0,
    root: "",
    instances: 0,
    fences: 0,
    rearms: 0,
    outstanding: new Set(),
    next: 0,
  };
  const faults = {
    start: false,
    rearm: false,
    rearmPanics: false,
    rearmLost: false,
    rearmOffline: false,
    fenceLost: false,
  };
  const lsp = { changed: [] };
  const prompts = [];
  // Anything the catch-up reported to the console rather than to the user. Empty is
  // the assertion: a bookkeeping failure must not surface as a failed write.
  const warnings = [];
  let answer = true;
  let reloading = false;
  const ui = { build: "not-compiled", problems: null, active: null, analyses: 0 };

  // A change to a file. It reaches the coordinator only through a live native
  // instance covering the directory the file is in: a fenced watcher has none, so the
  // events Quipu's own writes produce have nothing to arrive at, and a write into the
  // project the user has left is watched by nobody. No timeout, no "ignore the next
  // event".
  function emit(path) {
    if (!native.armed) return;
    if (!path.startsWith(`${native.root}/`)) return;
    watching.changed(native.subscription);
  }

  // The identity an arm takes before it tries, spent whether or not it succeeds, as the
  // backend's handoff spends it: the number a failed attempt reported under is never
  // reissued to the arm that recovers.
  function reserve() {
    native.instances += 1;
    return native.instances;
  }

  function arm() {
    native.armed = true;
    reserve();
  }

  async function watchFence(subscription) {
    native.fences += 1;
    if (deferFences) await fenceCalls.hold({ key: `fence:${subscription}` });
    // A superseded subscription gets token 0, which is never outstanding: there is
    // nothing here for it to fence and nothing for it to release.
    if (subscription !== native.subscription) return 0;
    native.next += 1;
    native.outstanding.add(native.next);
    native.armed = false;
    // The answer lost on the way back, the work having been done: the instance is retired
    // and its token is outstanding, and the caller learns neither. So no release will ever
    // lift this fence - a later mutation lifts its own token and finds this one still
    // outstanding, so it does not arm either - and the caller cannot say the fence was
    // never taken. Modelled in this order because the order is the hazard.
    if (faults.fenceLost) throw new Error("the fence answer never came back");
    return native.next;
  }

  async function watchRearm(subscription, token) {
    native.rearms += 1;
    if (subscription !== native.subscription) return;
    // Not a fence this registry is holding: a release that arrived twice, one whose
    // token a project change cleared, or one that never got a token.
    if (!native.outstanding.delete(token)) return;
    // Another mutation is still writing behind the fence.
    if (native.outstanding.size > 0) return;
    // The rejection of the invoke, carrying the identity the attempt reserved - the
    // shape `armFailure` in ipc.ts normalises. Nothing is armed under it, and nothing
    // ever will be: it is what places this failure against a coverage notice for the
    // retired instance that may still be in flight on the event channel.
    if (faults.rearm) throw { attempt: reserve(), message: "could not re-arm the watcher" };
    // An arming step that panicked, caught by the registry where the identity it had
    // already reserved is still known: an attributed rejection of the same shape, because
    // a watcher it installed just before panicking emits under that very number.
    if (faults.rearmPanics) {
      throw { attempt: reserve(), message: "the watcher arm panicked: assertion failed" };
    }
    // A rejection nothing could attribute: the task never came back to say which identity
    // it had, and the counter cannot be read on its behalf now because another attempt may
    // have advanced it. An identity may have been reserved and armed under - so this names
    // none at all, which is weaker than naming 0 and is deliberately not the same value.
    // The reservation is left in place, because whether one happened is exactly the unknown.
    if (faults.rearmLost) {
      reserve();
      throw { attempt: null, message: "the watcher task did not come back" };
    }
    // The rejection of a transport that never reached the command, which says even less: not
    // the registry's shape at all, so `armFailure` normalises it, and to unknown, not 0.
    if (faults.rearmOffline) throw new Error("the invoke never reached the backend");
    arm();
  }

  const watching = new AutoRefresh(
    {
      start(subscription, root) {
        // Recorded before arming is attempted, exactly as the backend does: a
        // watcher that could not be installed is degraded coverage of a project that
        // is nonetheless open, and a later fence still belongs to it.
        native.subscription = subscription;
        native.root = root;
        native.outstanding.clear();
        if (faults.start) return Promise.reject(new Error("inotify limit reached"));
        arm();
        return Promise.resolve();
      },
      release(subscription) {
        if (native.subscription === subscription) {
          native.armed = false;
          native.subscription = 0;
          native.root = "";
          native.outstanding.clear();
        }
      },
      invalidate() {
        invalidateCompilation();
        session.markStale();
      },
      refresh: (subscription) => respondToChanges(subscription),
      render() {},
    },
    timer.handle,
    150,
  );

  const dirtyDocuments = () => docs.dirtyKeys().filter((key) => key !== "");
  const stillSelected = (sel) => (sel === null ? !session.isOpen() : session.isCurrent(sel));

  function invalidateCompilation() {
    operations.invalidate();
    if (ui.build !== "compiling" && ui.build !== "compiled") return;
    ui.build = "stale";
    void operations.requestReset().catch(() => {});
  }

  // The editor's content-change listener. A reload drives the same model, so
  // without the guard a document brought up to date with the disk would invalidate
  // the compilation and mark the project stale - and each automatic refresh would
  // schedule the next one.
  function contentChanged() {
    if (reloading) return;
    invalidateCompilation();
    session.markStale();
  }

  function openFile(path) {
    docs.ensure(path, () => model(disk.get(path) ?? "", contentChanged));
    ui.active = path;
  }

  // editor.ts's renameDoc without Monaco: the model is re-created under the new key,
  // carrying the text, the unsaved edits, the disk baseline and any conflict.
  function renameDoc(oldKey, newPath) {
    if (oldKey === newPath) return;
    const m = docs.model(oldKey);
    if (m === null) return;
    const text = m.getValue();
    const carried = docs.carriedFrom(oldKey) ?? undefined;
    const wasActive = ui.active === oldKey;
    docs.remove(oldKey);
    docs.ensure(newPath, () => model(text, contentChanged), carried);
    if (wasActive) ui.active = newPath;
  }

  function reloadDoc(expect, text) {
    reloading = true;
    let replaced;
    try {
      replaced = docs.reload(expect, text);
    } finally {
      reloading = false;
    }
    if (!replaced) return false;
    // Exactly once, and no activation: a document being brought up to date must not
    // steal the editor from whatever the user is looking at.
    lsp.changed.push(expect.key);
    return true;
  }

  async function runAnalysis(req, reset) {
    const root = req.selection.root;
    try {
      if (reset !== null) await reset;
      if (!session.isCurrent(req.selection)) return;
      const analysis = await analyses.hold({
        key: root,
        subscription: watching.subscription(),
        generation: req.order,
      });
      const members = memberPathsOf(analysis, root);
      const unsaved = dirtyDocuments().some((key) => members.has(key));
      if (!session.accept(req, analysis, unsaved)) return;
      ui.analyses += 1;
      // The auto-open's own interleavings are navigation.test.mjs's business.
      if (req.initial && analysis.status === "loaded" && analysis.discovered.length > 0) {
        openFile(`${root}/${analysis.discovered[0].path}`);
      }
    } catch (err) {
      if (!session.failAnalysis(req, err)) return;
      ui.problems = String(err);
    } finally {
      session.finishAnalysis(req);
    }
  }

  async function refreshProject() {
    const selection = session.selection();
    if (selection === null) return;
    const req = session.beginAnalysis(selection, false);
    if (req === null) return;
    await runAnalysis(req, null);
  }

  async function respondToChanges(subscription) {
    const selection = session.selection();
    await reconcileOpenDocuments(
      () => watching.isCurrent(subscription) && stillSelected(selection),
    );
    if (!watching.isCurrent(subscription)) return;
    await refreshProject();
  }

  async function reconcileOpenDocuments(current) {
    const keys = docs.keys().filter((key) => key !== "");
    await Promise.all(keys.map((key) => reconcileDocument(key, current)));
  }

  // What is at `key` now. A read that fails is "not there", which is all a document
  // needs to know: its text is then the only copy left.
  async function readDiskState(key) {
    try {
      return { present: true, text: await reads.hold({ key }) };
    } catch {
      return { present: false };
    }
  }

  async function reconcileDocument(key, current) {
    const expect = docs.probe(key);
    if (expect === null) return;
    const found = await readDiskState(key);
    if (!current()) return;
    // The probe, not the key: a rename can have put a different document under this
    // key while the file was being read.
    const outcome = docs.reconcile(expect, found);
    if (outcome.kind !== "reload") return;
    reloadDoc(expect, outcome.text);
  }

  async function refreshManually() {
    const selection = session.selection();
    if (selection === null) return;
    // Before the first await: this is the fallback when nothing is watching, so it
    // cannot say in advance whether the disk still holds what was compiled.
    invalidateCompilation();
    await reconcileOpenDocuments(() => stillSelected(selection));
    if (!stillSelected(selection)) return;
    await refreshProject();
  }

  // How many app-owned mutations are behind the fence right now, per subscription.
  // They overlap, and a subscription's watcher only comes back - and its interval is
  // only caught up on - when the last of ITS mutations leaves. A mutation that
  // outlived its project must not stand in the way of the current one's catch-up.
  const mutating = new Map();

  function beginMutation(subscription) {
    mutating.set(subscription, (mutating.get(subscription) ?? 0) + 1);
  }

  function endMutation(subscription) {
    const left = (mutating.get(subscription) ?? 1) - 1;
    if (left > 0) {
      mutating.set(subscription, left);
      return false;
    }
    mutating.delete(subscription);
    return true;
  }

  // Quipu's own writes take turns: the queue is claimed synchronously, before the fence
  // is even asked for, so what reaches the disk is decided by the order the gestures
  // were made in rather than by which write happens to finish first.
  const mutations = new MutationQueue();

  // Whose fence this is. A fence is a blind interval whose catch-up invalidates
  // nothing, so a mutation has to answer for that interval itself, before it opens: it
  // supersedes whatever is compiled or compiling. A compile's own auto-save is the one
  // that must not, because superseding itself would mean no compile ever finished.
  //
  // A compile begun after the fence went up has an operation of its own and survives
  // this; what supersedes that one is New Rule and Rename Rule saying, once they have
  // acted, that the project no longer has the same files.
  async function fenced(owner, body) {
    const subscription = watching.subscription();
    if (owner === "mutation") invalidateCompilation();
    const turn = mutations.claim();
    if (subscription !== 0) beginMutation(subscription);
    // A rejection says nothing about whether the fence went up, so it names no identity: a
    // fence reserves none, and the coverage it retired - which it may well have retired
    // before the answer was lost - is announced by somebody else, on the other channel.
    // Reporting 0 would let that announcement clear this. The token is 0 all the same,
    // there being nothing here to release.
    const fence =
      subscription === 0
        ? Promise.resolve(0)
        : watchFence(subscription).catch((err) => {
            watching.failed(subscription, String(err), null);
            return 0;
          });
    let token = 0;
    try {
      await turn.ready;
      token = await fence;
      return await body();
    } finally {
      // Before the fence is released: the queue orders the writing, not the re-arm and
      // the catch-up read that follow it.
      turn.done();
      if (subscription !== 0) await endFence(subscription, token, endMutation(subscription));
    }
  }

  // The watcher first, then the catch-up. Never the other way round: reconciling
  // before the watcher is live would leave a second blind interval between the read
  // and the re-arm. `last` is per subscription: the last mutation out of THIS
  // project, not out of the window.
  async function endFence(subscription, token, last) {
    if (token !== 0) {
      try {
        await watchRearm(subscription, token);
      } catch (err) {
        // Reported under the identity the attempt reserved, as main.ts does through
        // `armFailure`: this rejection did not travel on the notice channel, so without a
        // number of its own it would be answered by news older than it. Normalised the same
        // way, and to unknown rather than 0, because a rejection that is not the registry's
        // own shape says nothing about what was reserved.
        const attributed =
          typeof err === "object" &&
          err !== null &&
          (typeof err.attempt === "number" || err.attempt === null) &&
          typeof err.message === "string";
        const failure = attributed ? err : { attempt: null, message: String(err) };
        watching.failed(subscription, failure.message, failure.attempt);
      }
    }
    if (!last || !watching.isCurrent(subscription)) return;
    try {
      await respondToChanges(subscription);
    } catch (err) {
      warnings.push(String(err));
    }
  }

  // A write Quipu performs: it lands on the modelled disk and emits an event, like
  // any other write. Whether that event is delivered is the fence's business.
  //
  // Conditional, as `save_text_file` is: `expect` is the version the caller was
  // authorised to replace - null for a file it expects not to exist - and the disk is
  // compared against it at the instant of the write rather than beforehand, so a
  // version written after the caller's read is preserved and the write is refused.
  // How that is made atomic is src-tauri/src/fs.rs's business and is tested there.
  async function writeFile(path, text, expect) {
    await writes.hold({ key: path, text });
    const found = disk.has(path) ? disk.get(path) : null;
    if (found !== expect) return "refused";
    disk.set(path, text);
    emit(path);
    return "written";
  }

  // `create_file`, which refuses to overwrite - so an existing path is a failure
  // rather than an emptied file.
  async function createFile(path) {
    await writes.hold({ key: path, kind: "create" });
    if (disk.has(path)) throw new Error(`${path}: already exists`);
    disk.set(path, "");
    emit(path);
  }

  // `rename_file`: one removal and one creation, which is why an event from it would
  // mark the document Quipu has just moved as missing. Both halves are in the same
  // directory, so one event stands for the pair.
  async function renameFile(from, to) {
    await writes.hold({ key: from, kind: "rename", to });
    disk.set(to, disk.get(from) ?? "");
    disk.delete(from);
    emit(to);
  }

  // The at-risk documents, named the way main.ts names them: a document whose file
  // has gone holds no unsaved edits, so calling it unsaved would be untrue of it.
  //
  // Synchronous here, and only here: the real confirmations are native dialogues and
  // so awaits, and what those awaits let interleave is authorising.test.mjs's subject.
  // These cases are about what the answers authorise afterwards.
  function confirmDiscardingUnsaved(action) {
    const atRisk = docs.atRiskKeys().filter((key) => key !== "");
    if (atRisk.length === 0) return true;
    const names = atRisk
      .map((key) =>
        docs.isDirty(key) ? `${basename(key)} (unsaved)` : `${basename(key)} (not on disk)`,
      )
      .join(", ");
    prompts.push(`discard:${names}:${action}`);
    return answer;
  }

  // Null means write nothing; otherwise the disk state the user was shown - the
  // disagreement AND which observation of the file it was - which the write has to find
  // again when its turn comes.
  function confirmOverwritingConflicts(keys) {
    const agreed = new Map(keys.map((key) => [key, docs.diskAnswer(key)]));
    const conflicted = keys.filter((key) => docs.conflictOf(key) !== null);
    if (conflicted.length === 0) return agreed;
    prompts.push(`overwrite:${conflicted.map(basename).join(",")}`);
    return answer ? agreed : null;
  }

  // Whether writing `key` is still what the user agreed to: somebody else at the file
  // revokes it, and so does the user taking the file's version, but Quipu's own earlier
  // save does not. An unasked-about key is held to "nothing was wrong with it", so a
  // member the fixpoint discovers cannot be written over a version nobody was shown.
  function stillConfirmed(confirmed, key) {
    const agreed = confirmed.get(key);
    const now = docs.diskAnswer(key);
    if (agreed === undefined) return now.conflict === null;
    return now.observation === agreed.observation && now.restored === agreed.restored;
  }

  const PREWRITE_READS = 3;

  // The last check before a write, and the only one that goes to the disk: nothing was
  // watching between the gesture and this turn, so an external edit made wholly inside
  // that interval has reached no read and contradicted no check. Recorded through
  // reconcile(), exactly as any other external change is, which is what makes
  // stillConfirmed() refuse - with no second dialogue. A read another read has already
  // answered over records nothing and therefore revalidates nothing, so it is asked
  // again; `unchanged` is the disk already holding this very revision.
  //
  // It closes everything but its own tail - what happens between it and the write - and
  // that is closed by the version travelling with the write, so `writable` carries what
  // the read found.
  async function checkWritable(confirmed, snap) {
    if (!stillConfirmed(confirmed, snap.key)) return { kind: "refused" };
    for (let read = 0; read < PREWRITE_READS; read += 1) {
      const expect = docs.probe(snap.key);
      if (expect === null) return { kind: "refused" };
      const found = await readDiskState(snap.key);
      const outcome = docs.reconcile(expect, found);
      if (outcome.kind === "stale") continue;
      if (!docs.holds(snap)) return { kind: "refused" };
      if (outcome.kind === "adopt" && found.present && found.text === snap.text) {
        return { kind: "unchanged" };
      }
      return stillConfirmed(confirmed, snap.key)
        ? { kind: "writable", expect: found.present ? found.text : null }
        : { kind: "refused" };
    }
    return { kind: "refused" };
  }

  async function openFolder(dir) {
    if (!confirmDiscardingUnsaved("Open another folder")) return false;
    const selection = session.open(dir);
    operations.begin(dir);
    const reset = operations.requestReset();
    leaveProject();
    const { armed } = watching.subscribe(dir);
    await armed;
    const req = session.beginAnalysis(selection, true);
    if (req === null) return true;
    await runAnalysis(req, reset);
    return true;
  }

  async function closeWorkspace() {
    if (!session.isOpen()) return false;
    if (!confirmDiscardingUnsaved("Close the workspace")) return false;
    session.close();
    operations.begin(session.root());
    const reset = operations.requestReset();
    leaveProject();
    await reset.catch(() => {});
    return true;
  }

  function leaveProject() {
    watching.cancel();
    resolutions.clear();
    ui.build = "not-compiled";
    ui.problems = null;
    for (const key of docs.keys()) {
      if (key !== "") docs.remove(key);
    }
    ui.active = null;
  }

  async function newRule(fileName) {
    const selection = session.selection();
    if (selection === null || session.isLoading()) return;
    const root = session.loaded()?.root ?? selection.root;
    const path = joinRoot(root, fileName);
    try {
      await fenced("mutation", async () => {
        // Raising the fence was an await, so the project is checked again with the
        // fence already up and before anything is created.
        if (!session.isCurrent(selection)) return;
        await createFile(path);
        if (!session.isCurrent(selection)) return;
        // Said again, having been said when the fence went up: that answered for the
        // blind interval, this is the project no longer having the same FILES - which a
        // compile begun while this waited its turn planned without.
        invalidateCompilation();
        session.markStale();
        // Inside the fence, so the catch-up reconciles a document that is already
        // where this command put it.
        openFile(path);
      });
    } catch (err) {
      ui.problems = String(err);
    }
  }

  async function renameRule(path, next) {
    const selection = session.selection();
    if (selection === null) return;
    const source = session.sourceAt(path);
    if (source === null || source.external) return;
    const to = joinRoot(dirname(path), next);
    try {
      await fenced("mutation", async () => {
        if (!session.isCurrent(selection)) return;
        // Re-asked after the waits rather than trusted from before them: a path the
        // project no longer contains is not this window's to move.
        const still = session.sourceAt(path);
        if (still === null || still.external) return;
        await renameFile(path, to);
        if (!session.isCurrent(selection)) return;
        // As New Rule: a compile begun while this waited named the document at its old
        // path, so it does not describe this project either.
        invalidateCompilation();
        session.markStale();
        // Inside the fence, and this is the case that requires it: the catch-up reads
        // whatever is open when it runs, and a document still keyed to the old path
        // would be read at a path this command has just emptied.
        if (docs.has(path)) renameDoc(path, to);
      });
    } catch (err) {
      ui.problems = String(err);
    }
  }

  async function saveActive() {
    const key = ui.active;
    if (key === null || key === "") return;
    const confirmed = confirmOverwritingConflicts([key]);
    if (confirmed === null) return;
    const snapshot = docs.beginSave(key);
    if (snapshot === null) return;
    const selection = session.selection();
    try {
      await fenced("mutation", async () => {
        // Re-checked with its turn come, the fence up, and before the write: a save
        // whose project the user left during those awaits writes nothing, and fenced()
        // still releases the fence it took.
        if (!stillSelected(selection)) return;
        // The document this snapshot names may have been renamed onto another path
        // while this save queued; writing it would recreate the emptied file.
        if (!docs.holds(snapshot)) return;
        // And what is known of the disk may have stopped being what the user agreed to
        // write over - then the disk itself, because knowing of no change is not the
        // same as there being none. Anything but `writable` writes nothing.
        const check = await checkWritable(confirmed, snapshot);
        if (check.kind !== "writable") return;
        // Conditional on the version that check read, so a version written after it -
        // inside the write's own tail - refuses instead of being overwritten. Silently:
        // nothing is lost, and the catch-up that ends this fence records it.
        if ((await writeFile(snapshot.key, snapshot.text, check.expect)) === "refused") return;
        if (!stillSelected(selection)) return;
        docs.completeSave(snapshot);
      });
    } catch (err) {
      if (stillSelected(selection)) ui.problems = String(err);
      return;
    }
    // No refresh here: ending the fence reconciled the open documents and re-read the
    // project.
  }

  const resolutions = new Map();

  async function reloadActive() {
    const key = ui.active;
    if (key === null || key === "") return;
    if (docs.conflictOf(key) === null) return;
    if (docs.isDirty(key)) {
      prompts.push(`reload:${basename(key)}`);
      if (!answer) return;
    }
    const selection = session.selection();
    const request = (resolutions.get(key) ?? 0) + 1;
    resolutions.set(key, request);
    const expect = docs.probe(key);
    if (expect === null) return;
    let text;
    try {
      text = await reads.hold({ key });
    } catch (err) {
      if (stillSelected(selection) && resolutions.get(key) === request) ui.problems = String(err);
      return;
    }
    if (!stillSelected(selection) || resolutions.get(key) !== request) return;
    reloadDoc(expect, text);
  }

  async function saveProjectDocuments(root, op, confirmed) {
    const dirty = dirtyDocuments();
    // Nothing to write, so nothing to fence: an empty plan must not cost this compile
    // a retired watcher and the catch-up that ending a fence owes.
    if (dirty.length === 0) return [];
    // One fence around the whole plan rather than one per file, so a later write in
    // the fixpoint cannot report itself back and invalidate the compile it belongs to.
    // The compile's own fence, and the only one that leaves a compilation standing.
    const plan = await fenced("compile", () =>
      saveDirtyMembers(dirty, new Set(session.memberIds().keys()), {
        members: async () => memberPathsOf(await analyses.hold({ key: root }), root),
        save: async (key) => {
          // Nothing left to write: the user's own Save, queued ahead of this plan, has
          // already put this document's text on disk.
          if (!docs.needsSaving(key)) return { kind: "unchanged" };
          // Captured after the plan's own waits, so a null IS the identity re-check
          // that manual Save has to make for itself.
          const snapshot = docs.beginSave(key);
          if (snapshot === null) {
            return { kind: "refused", why: `${basename(key)} is no longer open at that path` };
          }
          const check = await checkWritable(confirmed, snapshot);
          // That read was an await, and an edit or a Refresh during it supersedes this
          // compile: its captured snapshot is then a revision nobody asked to have
          // written. Checked here rather than only at the top of the next wave, because
          // the write is what cannot be taken back.
          if (!operations.isCurrent(op, session.root())) return { kind: "superseded" };
          // Somebody else put exactly this revision there: what the compiler will read is
          // what the editor holds, so the compile carries on rather than being refused
          // over text that is already in place.
          if (check.kind === "unchanged") return { kind: "unchanged" };
          if (check.kind === "refused") {
            return { kind: "refused", why: `${basename(key)} changed on disk` };
          }
          // Conditional too, and a refusal is the same answer to this plan as a refused
          // check: what the compiler would read is not what the editor holds.
          if ((await writeFile(snapshot.key, snapshot.text, check.expect)) === "refused") {
            return { kind: "refused", why: `${basename(key)} changed on disk` };
          }
          docs.completeSave(snapshot);
          return { kind: "written" };
        },
        superseded: () => !operations.isCurrent(op, session.root()),
      }),
    );
    // Thrown only once the fence has been released: a compile whose auto-save was
    // refused must not reach the compiler at all.
    if (plan.refused !== null) {
      throw new Error(`${plan.refused}, so nothing was compiled.`);
    }
    return plan.written;
  }

  async function compile() {
    if (ui.build === "compiling") return;
    const confirmed = confirmOverwritingConflicts(dirtyDocuments());
    if (confirmed === null) return;
    const op = operations.begin(session.root());
    ui.build = "compiling";
    try {
      if (op.project) {
        // The views are brought up to date by ending that save's fence; nothing extra
        // is needed here, and the compile does not depend on the snapshot at all.
        await saveProjectDocuments(op.project, op, confirmed);
        if (!operations.isCurrent(op, session.root())) return;
      }
      await operations.settle();
      if (!operations.isCurrent(op, session.root())) return;
      const res = await compiles.hold({ key: op.project ?? "" });
      if (!operations.isCurrent(op, session.root())) return;
      ui.build = res.ok ? "compiled" : "not-compiled";
    } catch (err) {
      const reset = operations.resetFor(op, session.root());
      if (reset === null) return;
      await reset.catch(() => {});
      if (!operations.isCurrent(op, session.root())) return;
      ui.problems = String(err);
      ui.build = "not-compiled";
    }
  }

  // Everything under `root`, as the analysis of the modelled disk would report it.
  function analysisOf(root) {
    const prefix = `${root}/`;
    const ids = [...disk.keys()]
      .filter((path) => path.startsWith(prefix))
      .sort()
      .map((path) => ({ external: false, path: path.slice(prefix.length) }));
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

  return {
    ui,
    session,
    operations,
    docs,
    watching,
    native,
    faults,
    timer,
    mutations,
    analyses,
    reads,
    writes,
    compiles,
    fenceCalls,
    lsp,
    prompts,
    warnings,
    disk,
    openFolder,
    closeWorkspace,
    refreshManually,
    newRule,
    renameRule,
    saveActive,
    reloadActive,
    compile,
    // Holds every fence command until the test settles it, so something can happen
    // between a command capturing its selection and its fence going up.
    deferFences: () => {
      deferFences = true;
    },
    setConfirm: (value) => {
      answer = value;
    },
    setReset: (fn) => {
      resetImpl = fn;
    },
    // The analysis of the modelled disk, for a test that answers analyses in some
    // order other than the one they were asked in and so cannot use settleAnalyses().
    analysisOf,
    conflicts: () => docs.conflictedKeys(),
    dirty: () => dirtyDocuments(),
    text: (path) => docs.textOf(path),
    // The Save button and File > Save, as refreshActiveUI() and refreshMenu() derive
    // them: what the disk does not hold, which is not the same as unsaved edits.
    canSave: () => {
      const key = ui.active;
      return key !== null && key !== "" && docs.needsSaving(key);
    },
    // Reload from Disk is shown only for a document that disagrees with its file.
    canReload: () => {
      const key = ui.active;
      return key !== null && key !== "" && docs.conflictOf(key) !== null;
    },
    open: (path) => openFile(path),
    activate(path) {
      assert.ok(docs.has(path), `${path} is open`);
      ui.active = path;
    },
    edit(path, text) {
      const m = docs.model(path);
      assert.ok(m, `${path} is open`);
      m.edit(text);
    },

    // A change made by something other than Quipu.
    external(path, text) {
      disk.set(path, text);
      emit(path);
    },
    removeExternally(path) {
      disk.delete(path);
      emit(path);
    },
    // The notice the backend sends when coverage derived from the last analysis is
    // armed in full. Played here rather than derived: which plan a snapshot implies is
    // watch/mod.rs's decision and is tested there. What is under test here is what
    // main.ts does with the notice - no invalidation, and one more analysis when
    // `catchUp` says one is owed, which is the backend's own answer for the same reason
    // it is on a partial notice. False is the recovery case: a plan completed by taking
    // over coverage already being delivered for the project.
    // A handoff installs the plan it derived, so if nothing was armed - a start that
    // failed, a re-arm that failed - this notice is the moment coverage begins.
    // The instance it names is the one arming counted, as the backend's announcement
    // does: an arm the frontend was not told about would leave a stale error from the
    // instance it replaced indistinguishable from a live one's. The ordering that rests
    // on it is watching.test.mjs's.
    //
    // Which is why this counts an instance every time. A coverage notice is what an arm
    // that installed something sends - a plan already armed in full sends nothing at all -
    // so every notice names a watcher that did not exist before, whether it replaced one
    // or began where nothing was armed.
    coverageArmed({ catchUp = true } = {}) {
      if (native.subscription === 0) return;
      arm();
      watching.covered(native.subscription, catchUp, native.instances);
    },
    // The notice for a handoff that installed only part of the plan it derived: the
    // root armed, and somewhere the project reaches out to did not. Mirrors main.ts's
    // dispatch, where `catchUp` - the backend's own answer to whether anything was read
    // before this coverage answered for it - is what decides whether an analysis is
    // owed, `paths` is for display, and `message` is degradation either way.
    // A partly installed plan is never "already armed", so a retry arms again and this
    // counts an instance for the same reason `coverageArmed` does.
    coveragePartial({ message, paths = [], catchUp = false }) {
      if (native.subscription === 0) return;
      arm();
      watching.partial(native.subscription, message, catchUp, native.instances);
    },

    // Answers the analyses that are waiting, from the modelled disk.
    settleAnalyses() {
      while (analyses.pending() > 0) {
        const call = analyses.take();
        call.resolve(analysisOf(call.key));
      }
    },
    // Answers the reconciliation reads that are waiting, from the modelled disk. A
    // test that needs one outstanding across an edit takes it itself.
    serveReads() {
      while (reads.pending() > 0) {
        const read = reads.take();
        if (disk.has(read.key)) read.resolve(disk.get(read.key));
        else read.reject(new Error(`${read.key}: no such file`));
      }
    },
    // Fires the debounce window and lets the whole response run to completion.
    async respond() {
      timer.run();
      await drained();
      this.serveReads();
      await drained();
      this.settleAnalyses();
      await drained();
    },

    // Lets an app-owned write finish, along with everything ending its fence owes:
    // the re-arm, the catch-up's reads and the analysis after them. Each round begins
    // by letting whatever is in flight get as far as it can, so a command that has not
    // yet reached its first await is not mistaken for a finished one.
    async settleWrites() {
      for (let round = 0; round < 40; round += 1) {
        await drained();
        let did = false;
        while (writes.pending() > 0) {
          writes.take().resolve();
          did = true;
        }
        if (reads.pending() > 0) {
          this.serveReads();
          did = true;
        }
        if (analyses.pending() > 0) {
          this.settleAnalyses();
          did = true;
        }
        if (!did && round > 0) return;
      }
      assert.fail("the app never stopped reading and writing");
    },

    // Opens `dir` containing `files` and lets it finish.
    async load(dir, files) {
      for (const [name, text] of Object.entries(files)) disk.set(`${dir}/${name}`, text);
      const opening = openFolder(dir);
      await drained();
      this.settleAnalyses();
      await opening;
    },

    // Compiles, and lets it succeed.
    async compileOk() {
      const compiling = compile();
      await drained();
      while (
        writes.pending() > 0 ||
        reads.pending() > 0 ||
        analyses.pending() > 0 ||
        compiles.pending() > 0
      ) {
        while (writes.pending() > 0) writes.take().resolve();
        this.serveReads();
        this.settleAnalyses();
        await drained();
        while (compiles.pending() > 0) compiles.take().resolve({ ok: true, ruleCount: 1 });
        await drained();
      }
      await compiling;
    },
  };
}

// ---- One analysis per burst ----

test("a burst of external changes produces one analysis", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const before = h.ui.analyses;

  h.external("/p/a.yar", "rule a { condition: true }");
  h.external("/p/b.yar", "rule b {}");
  h.external("/p/c.yar", "rule c {}");
  assert.equal(h.analyses.pending(), 0, "nothing runs until the window closes");

  await h.respond();
  assert.equal(h.ui.analyses, before + 1, "one analysis for the whole burst");
});

test("a change during the automatic analysis causes one trailing analysis", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const before = h.ui.analyses;

  h.external("/p/b.yar", "rule b {}");
  h.timer.run();
  await drained();
  h.serveReads();
  await drained();
  assert.equal(h.analyses.pending(), 1, "the analysis is reading the disk");

  // Written while that analysis was running, so it cannot be in its answer.
  h.external("/p/c.yar", "rule c {}");
  h.external("/p/d.yar", "rule d {}");

  h.settleAnalyses();
  await drained();
  h.serveReads();
  await drained();
  assert.equal(h.analyses.pending(), 1, "exactly one trailing analysis, not two");
  h.settleAnalyses();
  await drained();
  assert.equal(h.ui.analyses, before + 2);
  assert.equal(h.watching.isResponding(), false);
});

test("each analysis carries the order that decides whether it is applied", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const subscription = h.watching.subscription();
  const before = h.ui.analyses;

  // An automatic response, reading the disk...
  h.external("/p/b.yar", "rule b {}");
  h.timer.run();
  await drained();
  h.serveReads();
  await drained();
  const automatic = h.analyses.take();

  // ...and a Refresh made while it is still reading. Both belong to the subscription
  // being watched, and the Refresh is the newer of the two.
  const refreshing = h.refreshManually();
  await drained();
  h.serveReads();
  await drained();
  const manual = h.analyses.take();
  assert.equal(automatic.subscription, subscription);
  assert.equal(manual.subscription, subscription);
  assert.ok(
    manual.generation > automatic.generation,
    `${manual.generation} is newer than ${automatic.generation}`,
  );

  // The newer answers first and becomes the project on screen; the older answers
  // after it and is discarded. The order travelling with each one is what lets the
  // backend reach that same verdict about the plan derived from it, instead of
  // watching whatever happened to answer last.
  manual.resolve(h.analysisOf("/p"));
  await refreshing;
  automatic.resolve(h.analysisOf("/p"));
  await drained();
  assert.equal(h.ui.analyses, before + 1, "the older answer changed nothing");
});

test("Refresh is immediate and does not wait out a window", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const before = h.ui.analyses;

  const refreshing = h.refreshManually();
  await drained();
  h.serveReads();
  await drained();
  assert.equal(h.analyses.pending(), 1, "no debounce window was involved");
  h.settleAnalyses();
  await refreshing;
  assert.equal(h.ui.analyses, before + 1);
});

// ---- Compilation ----

test("an external change disables Scan at once, before the window closes", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  await h.compileOk();
  assert.equal(h.ui.build, "compiled", "Scan is available");

  h.external("/p/a.yar", "rule a { condition: false }");
  // Synchronously, on the first event of the burst. Waiting for the debounce window
  // would leave Scan offered against a ruleset that no longer describes the project.
  assert.equal(h.ui.build, "stale");
  assert.equal(h.timer.pending(), 1, "and the analysis is still only scheduled");
});

test("an external change during a compile supersedes it", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });

  const compiling = h.compile();
  await drained();
  assert.equal(h.compiles.pending(), 1, "the backend is compiling");

  h.external("/p/a.yar", "rule a { condition: false }");
  assert.equal(h.ui.build, "stale");

  // The response describes a project that has changed since. Honouring it would
  // report a compilation Scan cannot run.
  h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await compiling;
  assert.equal(h.ui.build, "stale");
});

test("a compile with nothing to write fences nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const before = h.ui.analyses;

  await h.compileOk();
  assert.equal(h.ui.build, "compiled");
  // An empty save plan is not a mutation: fencing for it would retire the watcher and
  // owe a catch-up analysis for a compile that did not touch the disk at all.
  assert.equal(h.native.fences, 0);
  assert.equal(h.ui.analyses, before, "and no analysis was owed");
  assert.ok(h.native.armed);
});

test("the compile's own auto-save does not invalidate the compile", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "rule a { condition: true }");
  assert.deepEqual(h.dirty(), ["/p/a.yar"]);

  await h.compileOk();
  // The write emitted an event, as any write does. It found no live watcher, so it
  // was never reported - and the compile it belongs to reached the end.
  assert.equal(h.ui.build, "compiled");
  assert.equal(h.watching.isResponding(), false);
  assert.equal(h.native.fences, 1, "one fence for the whole save plan");
  assert.equal(h.native.outstanding.size, 0, "released");
  assert.ok(h.native.armed, "and the watcher is back");
  assert.deepEqual(h.warnings, []);
});

test("a save during a compile supersedes it, though nothing reports the write", async () => {
  // The other side of the same rule. A compile's own auto-save is fenced without
  // superseding the compile, and the catch-up that ends any fence deliberately
  // invalidates nothing - so a mutation that is NOT the compile's own has to answer for
  // its blind interval itself, or the compile finishes across it and offers Scan.
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.activate("/p/a.yar");
  h.removeExternally("/p/a.yar");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"], "open, and not on disk");
  assert.deepEqual(h.dirty(), [], "with nothing unsaved: nobody edited it");

  // A compile of what is there now. It has nothing to write - a document with no
  // unsaved edits is not the auto-save's business - so it fences nothing and is
  // simply in flight.
  const compiling = h.compile();
  await drained();
  assert.equal(h.compiles.pending(), 1, "the backend is compiling a project without a.yar");

  // Save puts the file back, while that compile is still in the backend. Nothing will
  // report the write: the fence is up, and the catch-up would not invalidate anyway.
  const saving = h.saveActive();
  await drained();
  assert.equal(h.ui.build, "stale", "so the save says it itself, before it writes a byte");
  // Its pre-write read: the file is still gone, which is what it expects to recreate.
  h.serveReads();
  await drained();
  const write = h.writes.take();

  // The compiler answers now, for a directory that did not contain a.yar.
  h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  write.resolve();
  await h.settleWrites();
  await saving;
  await compiling;

  assert.equal(h.disk.get("/p/a.yar"), "rule a {}", "the file is back");
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0);
  // Not "compiled": those rules were produced from a project this save has changed, and
  // offering Scan against them would scan with a ruleset a.yar was never in.
  assert.equal(h.ui.build, "stale", "and Scan is not offered");
  assert.equal(h.ui.problems, null, "nothing failed, so there is nothing to report");
});

test("a manual save does not report itself back as an external change", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;

  assert.equal(h.dirty().length, 0, "saved");
  assert.equal(h.conflicts().length, 0, "and not in conflict with its own write");
  assert.equal(h.watching.isResponding(), false, "and no automatic refresh was scheduled");
  assert.ok(h.native.armed);
});

test("a watcher that cannot be re-armed does not fail the write", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.faults.rearm = true;

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  await drained();

  assert.equal(h.ui.problems, null, "the save succeeded, so nothing failed");
  assert.equal(h.dirty().length, 0, "and the user is not asked to save again");
  assert.match(h.watching.degradation(), /could not re-arm/, "reported as degradation instead");
  // The catch-up still ran: it is the last thing that will ever look at that interval,
  // and it is exactly what a lost watcher makes indispensable. Two reads of the one open
  // document: the save's own check of what it was about to overwrite, then the catch-up.
  assert.deepEqual(h.reads.keys(), ["/p/a.yar", "/p/a.yar"]);
});

// ---- The fence: overlapping mutations and the catch-up ----
//
// App-owned mutations overlap - a compile's auto-save asked for while a rename is
// still writing - and each takes a fence of its own even though the writes themselves
// take turns. Coverage may only come back when the last of them leaves, and the
// interval nothing was watching is caught up on exactly once, by whichever left last.
//
// The fences therefore genuinely overlap, which is what the backend's token protocol
// is for: two mutations of one subscription hold two tokens, and the one that finishes
// first must not re-arm the watcher the other is still relying on.

test("overlapping mutations write in turn, and the watcher waits for the last one", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.open("/p/b.yar");
  h.edit("/p/b.yar", "mine in b");
  const armed = h.native.instances;
  const before = h.ui.analyses;

  // A save of b.yar and a rename of a.yar, asked for one after the other with neither
  // finished.
  const saving = h.saveActive();
  const renaming = h.renameRule("/p/a.yar", "c.yar");
  await drained();
  assert.equal(h.native.fences, 2, "each mutation fenced for itself");
  assert.equal(h.native.outstanding.size, 2);
  assert.equal(h.native.armed, false);
  // The save re-reads the file it is about to overwrite first: nothing was watching from
  // the moment the gesture was made, so this is the only thing that can find a change
  // made inside that interval.
  h.serveReads();
  await drained();
  // But only one of them is touching the disk. The rename claimed its turn behind the
  // save and has not written anything yet.
  assert.equal(h.writes.pending(), 1);

  const save = h.writes.take();
  assert.equal(save.key, "/p/b.yar");

  // The save finishes. Re-arming here would report the rename's removal and creation
  // as somebody else's change - and mark the document Quipu is about to move as
  // missing.
  save.resolve();
  await drained();
  assert.equal(h.native.armed, false, "the rename still holds a fence of its own");
  assert.equal(h.native.outstanding.size, 1);
  assert.deepEqual(h.reads.keys(), ["/p/b.yar"], "the save's own check, and no catch-up yet");

  const rename = h.writes.take();
  assert.equal(rename.kind, "rename", "which is only now being performed");
  rename.resolve();
  await h.settleWrites();
  await saving;
  await renaming;

  assert.ok(h.native.armed);
  assert.equal(h.native.instances, armed + 1, "one replacement between them, not one each");
  assert.equal(h.native.outstanding.size, 0);
  // One catch-up for the whole interval: each open document read once, then one
  // analysis. Not one per mutation - the extra b.yar is the save's own pre-write check.
  assert.deepEqual(h.reads.keys().sort(), ["/p/b.yar", "/p/b.yar", "/p/c.yar"]);
  assert.equal(h.ui.analyses, before + 1);
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0, "and nothing conflicts with Quipu's own writes");
  assert.equal(h.mutations.outstanding(), 0);
});

test("the other gesture order settles in the same place", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.open("/p/b.yar");
  h.edit("/p/b.yar", "mine in b");
  const armed = h.native.instances;

  // The rename is asked for first this time, so it is the rename that writes first.
  const renaming = h.renameRule("/p/a.yar", "c.yar");
  const saving = h.saveActive();
  await drained();
  assert.equal(h.native.fences, 2);
  assert.equal(h.native.outstanding.size, 2);
  assert.equal(h.writes.pending(), 1);

  const rename = h.writes.take();
  assert.equal(rename.kind, "rename");
  rename.resolve();
  await drained();
  assert.equal(h.native.armed, false, "the save has yet to write, behind its own fence");
  assert.equal(h.native.outstanding.size, 1);

  // Its turn has come, so it checks the file it is about to overwrite and then writes.
  h.serveReads();
  await drained();
  const save = h.writes.take();
  assert.equal(save.key, "/p/b.yar");
  save.resolve();
  await h.settleWrites();
  await saving;
  await renaming;

  assert.ok(h.native.armed);
  assert.equal(h.native.instances, armed + 1);
  assert.equal(h.native.outstanding.size, 0);
  assert.equal(h.disk.get("/p/b.yar"), "mine in b");
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0);
});

// ---- Mutations take turns: what actually ends up on disk ----
//
// Overlapping app-owned writes would decide the disk between them by completion order,
// and no bookkeeping afterwards can take a write back: two saves of one document leave
// whichever landed last, and a save that lands after a rename recreates the file the
// rename emptied. So they take turns in the order the gestures were made (mutations.ts),
// and each of them re-checks what it was asked to do once its turn comes - the project,
// the document's identity, and what the user agreed to write over.

test("a second save of one document leaves the second revision on disk", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "A");

  const first = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  const writeA = h.writes.take();
  assert.equal(writeA.text, "A");

  // Edited again while that write is in flight, and saved again. Save stays available
  // throughout, so this is one accelerator press away at any time.
  h.edit("/p/a.yar", "B");
  const second = h.saveActive();
  await drained();
  assert.equal(h.writes.pending(), 0, "the second save waits for the first");

  writeA.resolve();
  await drained();
  assert.deepEqual(h.dirty(), ["/p/a.yar"], "still dirty: what reached the disk was not B");
  // The second save's turn: it finds A on disk, which is Quipu's own write and no reason
  // to stop, and goes on to write B over it.
  h.serveReads();
  await drained();
  const writeB = h.writes.take();
  assert.equal(writeB.text, "B", "and the revision the user asked for last goes last");

  writeB.resolve();
  await h.settleWrites();
  await first;
  await second;

  assert.equal(h.disk.get("/p/a.yar"), "B");
  assert.equal(h.dirty().length, 0, "clean, at the revision that is actually there");
  assert.equal(h.conflicts().length, 0);
});

test("a save cannot recreate the path a rename made after it has emptied", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  // Save, then Rename of the same document, neither finished.
  const saving = h.saveActive();
  const renaming = h.renameRule("/p/a.yar", "c.yar");
  await drained();
  h.serveReads();
  await drained();
  // Only the save is writing. Were both in flight, the rename could land first and the
  // save's write would then recreate the path it had just emptied - and no bookkeeping
  // afterwards could remove that file again.
  assert.equal(h.writes.pending(), 1);
  const save = h.writes.take();
  assert.equal(save.key, "/p/a.yar");
  save.resolve();
  await drained();

  const rename = h.writes.take();
  assert.equal(rename.kind, "rename", "the rename moves what the save had just written");
  rename.resolve();
  await h.settleWrites();
  await saving;
  await renaming;

  assert.equal(h.disk.has("/p/a.yar"), false, "the rename moved it, and nothing put it back");
  assert.equal(h.disk.get("/p/c.yar"), "mine", "holding the text the save wrote");
  assert.deepEqual(h.docs.keys(), ["/p/c.yar"]);
  assert.equal(h.dirty().length, 0, "written before the rename, and clean at that revision");
  assert.equal(h.conflicts().length, 0);
});

test("a save queued behind a rename does not write the path it abandoned", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  // The other order: the rename goes first, and the save's snapshot - captured when the
  // gesture was made, because the revision written has to be the one asked for - still
  // names the old path.
  const renaming = h.renameRule("/p/a.yar", "c.yar");
  const saving = h.saveActive();
  await h.settleWrites();
  await renaming;
  await saving;

  assert.equal(h.writes.count(), 1, "one write: the rename. The save had nothing to write");
  assert.equal(h.disk.has("/p/a.yar"), false, "so the file the user renamed away stayed away");
  assert.equal(h.disk.get("/p/c.yar"), "rule a {}", "and the new path still holds the old text");
  assert.deepEqual(h.dirty(), ["/p/c.yar"], "the edit is unsaved, under the path it moved to");
  assert.equal(h.text("/p/c.yar"), "mine", "and it is still the user's text");
  assert.deepEqual(h.conflicts(), [], "which agrees with the file it came from");
  assert.equal(h.ui.problems, null, "nothing failed: the save simply had nothing to say");
});

test("a compile's auto-save and a manual Save never write one document at once", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  await h.compileOk();
  h.edit("/p/a.yar", "mine");

  const compiling = h.compile();
  await drained();
  h.serveReads();
  await drained();
  const auto = h.writes.take();
  assert.equal(auto.key, "/p/a.yar", "the compile writes what it is about to compile");

  // Save pressed while that write is in flight: the same document, the same path, and
  // both writes Quipu's own.
  const saving = h.saveActive();
  await drained();
  assert.equal(h.writes.pending(), 0, "one writer at a time");

  auto.resolve();
  await drained();
  h.serveReads();
  await drained();
  const manual = h.writes.take();
  assert.equal(manual.key, "/p/a.yar", "and the manual save writes only now");
  manual.resolve();
  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await compiling;
  await saving;

  assert.equal(h.disk.get("/p/a.yar"), "mine");
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0);
  assert.equal(h.mutations.outstanding(), 0);
});

test("a mutation gives up its turn before its catch-up, not after it", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");

  // The save's write lands, which starts everything ending its fence owes: the re-arm,
  // the reconciliation reads, and the analysis after them. None of those is a write, and
  // none of them is answered here.
  const saving = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  h.writes.take().resolve();
  await drained();
  assert.ok(h.reads.pending() > 0, "the catch-up is still reading");

  // A gesture made during that catch-up writes straight away. The queue orders writes
  // against writes; holding the turn until the catch-up finished would put one project's
  // reads - or an abandoned project's - in the way of the next project's write.
  const renaming = h.renameRule("/p/b.yar", "d.yar");
  await drained();
  assert.equal(h.writes.pending(), 1, "not waiting behind somebody else's reads");

  await h.settleWrites();
  await saving;
  await renaming;

  assert.equal(h.disk.get("/p/a.yar"), "mine");
  assert.equal(h.disk.get("/p/d.yar"), "rule b {}");
  assert.equal(h.mutations.outstanding(), 0);
});

test("a mutation queued when the user opens another folder writes nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");

  // A rename of b.yar is in flight, and Save is pressed behind it.
  const renaming = h.renameRule("/p/b.yar", "d.yar");
  await drained();
  const rename = h.writes.take();
  const saving = h.saveActive();
  await drained();
  assert.equal(h.writes.pending(), 0, "waiting its turn");

  // The folder changes while the save is still queued. Its documents are gone and its
  // project is not the one on screen, so when its turn comes there is nothing to write.
  await h.load("/q", { "z.yar": "rule z {}" });
  const written = h.writes.count();

  rename.resolve();
  await h.settleWrites();
  await renaming;
  await saving;

  assert.equal(h.writes.count(), written, "the queued save wrote nothing at all");
  assert.equal(h.disk.get("/p/a.yar"), "rule a {}", "/p's file still holds what it held");
  assert.deepEqual(h.docs.keys(), ["/q/z.yar"], "and /q's documents are untouched by it");
  assert.equal(h.ui.problems, null, "an abandoned save is not a failure to report");
});

test("a queued rename does not move a file the project no longer has", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.open("/p/b.yar");

  // A rename of a.yar is in flight, and a rename of b.yar is asked for behind it.
  const first = h.renameRule("/p/a.yar", "c.yar");
  await drained();
  const write = h.writes.take();
  const second = h.renameRule("/p/b.yar", "e.yar");
  await drained();
  assert.equal(h.writes.pending(), 0, "waiting its turn");

  // b.yar goes while that wait is happening. Nothing is watching - the fence is up - so
  // it is a manual Refresh that finds out, and the project it accepts has no b.yar in it.
  h.disk.delete("/p/b.yar");
  const refreshing = h.refreshManually();
  await drained();
  h.serveReads();
  await drained();
  h.settleAnalyses();
  await refreshing;
  assert.equal(h.session.sourceAt("/p/b.yar"), null);

  write.resolve();
  await h.settleWrites();
  await first;
  await second;

  assert.equal(h.writes.count(), 1, "one write: the rename that was still about something");
  assert.equal(h.disk.has("/p/e.yar"), false, "nothing was moved onto the new name");
  assert.equal(h.disk.get("/p/c.yar"), "rule a {}", "and the first rename stands");
  assert.equal(h.ui.problems, null);
});

test("a queued save does not write over a change it was never asked about", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");

  // Somebody else changes a.yar, and the automatic response is already reading it.
  h.external("/p/a.yar", "theirs");
  h.timer.run();
  await drained();
  const read = h.reads.take();

  // A rename of b.yar is in flight, and Save is pressed behind it. Nothing is known to
  // be wrong with a.yar yet, so no question is asked.
  const renaming = h.renameRule("/p/b.yar", "d.yar");
  await drained();
  const rename = h.writes.take();
  const saving = h.saveActive();
  await drained();
  assert.deepEqual(h.prompts, [], "nothing to ask about: the read has not landed");
  assert.equal(h.writes.pending(), 0);

  // The read lands while the save waits, and a.yar turns out to hold somebody else's
  // version.
  read.resolve("theirs");
  await drained();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  rename.resolve();
  await h.settleWrites();
  await renaming;
  await saving;

  assert.equal(h.disk.get("/p/a.yar"), "theirs", "the save left it alone");
  assert.deepEqual(h.dirty(), ["/p/a.yar"], "and the user's text is still theirs to save");
  assert.deepEqual(h.conflicts(), ["/p/a.yar"], "over a version they now know about");
  assert.deepEqual(h.prompts, [], "and no dialogue appeared several gestures later");
  assert.equal(h.ui.problems, null);
});

test("a compile's queued auto-save does not write over a change it was never asked about", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.open("/p/b.yar");
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");

  // Somebody else changes a.yar, and the automatic response is already reading it.
  h.external("/p/a.yar", "theirs");
  h.timer.run();
  await drained();
  const read = h.reads.take();

  // A save of b.yar is in flight, and Compile is pressed behind it. Its auto-save is
  // about a.yar, and nothing is known to be wrong with a.yar yet.
  h.activate("/p/b.yar");
  const saving = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  const write = h.writes.take();
  assert.equal(write.key, "/p/b.yar");
  const compiling = h.compile();
  await drained();
  assert.deepEqual(h.prompts, [], "nothing to ask about: the read has not landed");
  assert.equal(h.writes.pending(), 0, "and the auto-save is waiting its turn");

  read.resolve("theirs");
  await drained();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  write.resolve();
  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await saving;
  await compiling;

  assert.equal(h.writes.count(), 1, "the auto-save wrote nothing: only b.yar was written");
  assert.equal(h.disk.get("/p/a.yar"), "theirs", "so the other version is still there");
  assert.deepEqual(h.dirty(), ["/p/a.yar"], "and the user's text is still theirs to save");
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);
  assert.deepEqual(h.prompts, [], "with no dialogue appearing after the gesture");
  // And the compile itself did not happen. A document it was going to write is not on
  // disk, so compiling the root would have compiled somebody else's version of it and
  // then offered it to be scanned with.
  assert.equal(h.compiles.count(), 0, "the compiler was never asked");
  assert.equal(h.ui.build, "not-compiled", "and Scan is not offered");
  assert.match(h.ui.problems, /a\.yar changed on disk, so nothing was compiled/);
});

test("a compile whose auto-saved document was renamed away compiles nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  // Rename Rule on the document, and Compile pressed behind it. The plan named
  // /p/a.yar, because that is where the unsaved text was when the gesture was made.
  const renaming = h.renameRule("/p/a.yar", "c.yar");
  await drained();
  const rename = h.writes.take();
  const compiling = h.compile();
  await drained();
  assert.equal(h.writes.pending(), 0, "the plan is waiting its turn");

  // The rename lands, and the document it moved is now open at another path entirely.
  rename.resolve();
  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await renaming;
  await compiling;

  assert.equal(h.writes.count(), 1, "one write: the rename. The plan wrote nothing");
  assert.equal(h.disk.has("/p/a.yar"), false, "nothing was written back to the old path");
  // Quietly cancelled rather than reported: renaming a rule is itself a change to the
  // project, so this compile was already about a project that has moved on.
  assert.equal(h.compiles.count(), 0, "and the compiler was never asked");
  assert.equal(h.ui.build, "stale", "so Scan is not offered: the rename moved the project");
  assert.equal(h.ui.problems, null, "and there is nothing to tell the user");
  assert.deepEqual(h.dirty(), ["/p/c.yar"], "their text is unsaved under the new name");
  assert.equal(h.text("/p/c.yar"), "mine");
});

// ---- Which version of the file the user agreed to overwrite ----
//
// "It changed on disk" is not an identity. A file can change twice while a write queues,
// and both versions are the same answer - a conflict - so an authorisation given for the
// first would carry straight over to the second. Each accepted answer about a file is
// therefore counted, and a write re-checks the count it was authorised against.
//
// The count also cannot see what nothing read. From the moment a mutation claims its
// turn the watcher is fenced, so an edit made entirely inside that interval reaches no
// read and contradicts no check. So the write reads the file itself, immediately before
// writing it, and that read goes through the same reconciliation as any other.

test("a second external version, observed while a save queues, is not overwritten", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");

  // Version A, reported and reconciled: the user can see that a.yar disagrees with its
  // file, and Save asks about it.
  h.external("/p/a.yar", "theirs A");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  // Version B, with its read still in flight.
  h.external("/p/a.yar", "theirs B");
  h.timer.run();
  await drained();
  const read = h.reads.take();
  assert.equal(read.key, "/p/a.yar");

  // Save, behind a rename of b.yar, and confirmed: what the user was shown and agreed
  // to overwrite was version A.
  const renaming = h.renameRule("/p/b.yar", "d.yar");
  await drained();
  const rename = h.writes.take();
  const saving = h.saveActive();
  await drained();
  assert.deepEqual(h.prompts, ["overwrite:a.yar"]);
  assert.equal(h.writes.pending(), 0, "waiting its turn");

  // B lands while the save waits. It is the same answer as A - the file disagrees with
  // the document - and it is a different file.
  read.resolve("theirs B");
  await drained();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"], "still just 'changed'");

  rename.resolve();
  await h.settleWrites();
  await renaming;
  await saving;

  assert.equal(h.writes.count(), 1, "one write: the rename. The save did not write");
  assert.equal(h.disk.get("/p/a.yar"), "theirs B", "version B is still there");
  assert.deepEqual(h.dirty(), ["/p/a.yar"], "and the user's text is still theirs to save");
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);
  assert.deepEqual(h.prompts, ["overwrite:a.yar"], "asked once, at the gesture, and not again");
  assert.equal(h.ui.problems, null);
});

test("an external edit made wholly inside a save's own queued interval survives it", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");

  // A rename of b.yar is in flight, and Save is pressed behind it. Nothing is known to
  // be wrong with a.yar, and nothing is asked.
  const renaming = h.renameRule("/p/b.yar", "d.yar");
  await drained();
  const rename = h.writes.take();
  const saving = h.saveActive();
  await drained();
  assert.deepEqual(h.prompts, []);

  // Somebody else edits a.yar now. The fence is up, so this is reported to nobody: no
  // window opens, no read is issued, and no check the save has already made was wrong.
  h.external("/p/a.yar", "theirs");
  assert.equal(h.timer.pending(), 0, "nothing was reported, and nothing can be");
  assert.equal(h.reads.count(), 0, "and no read is in flight to find it");

  rename.resolve();
  await h.settleWrites();
  await renaming;
  await saving;

  // Found by the save's own read of the file it was about to replace, which is the only
  // thing that could have found it before the write rather than after.
  assert.equal(h.writes.count(), 1, "one write: the rename");
  assert.equal(h.disk.get("/p/a.yar"), "theirs", "their edit is still on disk");
  assert.equal(h.text("/p/a.yar"), "mine", "and the user's text was not thrown away either");
  assert.deepEqual(h.dirty(), ["/p/a.yar"]);
  assert.deepEqual(h.conflicts(), ["/p/a.yar"], "which is now a conflict they can resolve");
  assert.deepEqual(h.prompts, [], "with no dialogue appearing without a gesture");
  assert.equal(h.ui.problems, null);
});

test("a compile's auto-save will not overwrite a second external version either", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.open("/p/b.yar");
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");

  h.external("/p/a.yar", "theirs A");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  h.external("/p/a.yar", "theirs B");
  h.timer.run();
  await drained();
  const read = h.reads.take();
  assert.equal(read.key, "/p/a.yar");

  // A save of b.yar holds the queue - a save, not a rename, because renaming a rule
  // would be a change to the project and would supersede the compile outright.
  h.activate("/p/b.yar");
  const saving = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  const write = h.writes.take();
  assert.equal(write.key, "/p/b.yar");

  // Compile, confirmed against version A.
  const compiling = h.compile();
  await drained();
  assert.deepEqual(h.prompts, ["overwrite:a.yar"]);
  assert.equal(h.writes.pending(), 0, "the plan is waiting its turn");

  read.resolve("theirs B");
  await drained();

  write.resolve();
  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await saving;
  await compiling;

  assert.equal(h.writes.count(), 1, "only b.yar was written");
  assert.equal(h.disk.get("/p/a.yar"), "theirs B");
  // The document it was going to compile is not on disk, so there is nothing honest to
  // compile and nothing to offer Scan for.
  assert.equal(h.compiles.count(), 0, "the compiler was never asked");
  assert.equal(h.ui.build, "not-compiled");
  assert.match(h.ui.problems, /a\.yar changed on disk, so nothing was compiled/);
  assert.deepEqual(h.dirty(), ["/p/a.yar"]);
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);
  assert.deepEqual(h.prompts, ["overwrite:a.yar"], "and asked nothing after the gesture");
});

test("a compile does not overwrite an edit made wholly inside its plan's queued interval", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.open("/p/b.yar");
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");

  h.activate("/p/b.yar");
  const saving = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  const write = h.writes.take();

  const compiling = h.compile();
  await drained();
  assert.deepEqual(h.prompts, [], "nothing is known to be wrong with a.yar");

  h.external("/p/a.yar", "theirs");
  assert.equal(h.timer.pending(), 0, "and the fence means nothing can be");

  write.resolve();
  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await saving;
  await compiling;

  assert.equal(h.writes.count(), 1, "the plan wrote nothing");
  assert.equal(h.disk.get("/p/a.yar"), "theirs", "their edit survived the compile");
  assert.equal(h.compiles.count(), 0, "which was not performed");
  assert.equal(h.ui.build, "not-compiled");
  assert.match(h.ui.problems, /a\.yar changed on disk, so nothing was compiled/);
  assert.deepEqual(h.dirty(), ["/p/a.yar"]);
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);
});

// A read another read has already answered over is not a revalidation. It records
// nothing - including the changed contents it found - so a write that took its issuing
// for proof would go ahead on the strength of the older answer instead.

test("a save whose pre-write read was overtaken asks again rather than writing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  // Version A, reported and reconciled, and Save confirmed against it.
  h.external("/p/a.yar", "theirs A");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  const saving = h.saveActive();
  await drained();
  assert.deepEqual(h.prompts, ["overwrite:a.yar"]);
  const prewrite = h.reads.take();
  assert.equal(prewrite.key, "/p/a.yar");

  // Refresh, pressed while that read is in flight: a second read of the same file,
  // issued later and answered first. What it finds is the version already confirmed, so
  // it is news to nobody and contradicts no check the save has made.
  const refreshing = h.refreshManually();
  await drained();
  const later = h.reads.take();
  assert.equal(later.key, "/p/a.yar");
  later.resolve("theirs A");
  await drained();

  // Version B lands after that answer, inside the interval nothing watches. The save's
  // read is still in flight and will return B - but it is the older read now, so what it
  // found is discarded and the save has revalidated nothing.
  h.external("/p/a.yar", "theirs B");
  assert.equal(h.timer.pending(), 0, "nothing was reported, and nothing can be");
  prewrite.resolve("theirs B");
  await drained();
  assert.equal(h.reads.pending(), 1, "so it reads again instead of writing");

  await h.settleWrites();
  await refreshing;
  await saving;

  assert.equal(h.writes.count(), 0, "and the second read refused the write");
  assert.equal(h.disk.get("/p/a.yar"), "theirs B", "version B is still there");
  assert.equal(h.text("/p/a.yar"), "mine", "and the user's text is still theirs to save");
  assert.deepEqual(h.dirty(), ["/p/a.yar"]);
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);
  assert.deepEqual(h.prompts, ["overwrite:a.yar"], "asked once, at the gesture");
  assert.equal(h.ui.problems, null);
});

test("a compile's auto-save whose pre-write read was overtaken refuses too", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs A");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  // A window opened by an event for a version already reported, waiting to be fired.
  // Not a Refresh: pressing that would invalidate the compile outright, and what is
  // under test here is a compile that is otherwise perfectly current.
  h.external("/p/a.yar", "theirs A");
  assert.equal(h.timer.pending(), 1);

  const compiling = h.compile();
  await drained();
  assert.deepEqual(h.prompts, ["overwrite:a.yar"]);
  const prewrite = h.reads.take();
  assert.equal(prewrite.key, "/p/a.yar");

  // The window closes while the plan's read is in flight, and its own read of the same
  // file - issued later - is answered first with the version already confirmed.
  h.timer.run();
  await drained();
  const later = h.reads.take();
  later.resolve("theirs A");
  await drained();

  h.external("/p/a.yar", "theirs B");
  prewrite.resolve("theirs B");
  await drained();
  assert.equal(h.reads.pending(), 1, "the plan reads again rather than writing");

  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await compiling;

  assert.equal(h.writes.count(), 0, "nothing was written over version B");
  assert.equal(h.disk.get("/p/a.yar"), "theirs B");
  assert.equal(h.compiles.count(), 0, "and there was nothing honest to compile");
  assert.equal(h.ui.build, "not-compiled");
  assert.match(h.ui.problems, /a\.yar changed on disk, so nothing was compiled/);
  assert.deepEqual(h.dirty(), ["/p/a.yar"]);
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);
});

// ---- The interval between the last read and the write ----
//
// The read before a write cannot speak for the instant of the write: they are two
// operations, and however close together they are issued something can land between
// them - inside the fence, where nothing is watching and no read will ever be answered
// again. So the version that read found travels with the write, which is conditional on
// it and refuses. That the refusal is atomic is the backend's guarantee and is tested
// there (src-tauri/src/fs.rs); what these assert is that the frontend authorises the
// write against a version at all, and does the right thing with a refusal.

test("a version landing between the read and the write is not overwritten", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  const saving = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  // The check has passed: the file holds what the document was opened at, and the write
  // is authorised against that version.
  const write = h.writes.take();

  // And now, before it lands, somebody else writes. The fence is up, so this reaches no
  // watcher, no read and no check: the write itself is the only thing left that can
  // refuse it.
  h.external("/p/a.yar", "theirs");
  assert.equal(h.timer.pending(), 0, "nothing was reported, and nothing can be");

  write.resolve();
  await h.settleWrites();
  await saving;

  assert.equal(h.disk.get("/p/a.yar"), "theirs", "their version is still there");
  assert.equal(h.text("/p/a.yar"), "mine", "and the user's text was not silently lost");
  assert.deepEqual(h.dirty(), ["/p/a.yar"], "the document is still theirs to save");
  // Found by the catch-up that ends the fence, which is the only thing that can find it -
  // and the reason the refusal needs no dialogue of its own.
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);
  assert.deepEqual(h.prompts, [], "nothing was asked, at the gesture or afterwards");
  assert.equal(h.ui.problems, null, "and a refused write is not a failure");
});

test("a compile whose auto-save was refused at the write compiles nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  const compiling = h.compile();
  await drained();
  h.serveReads();
  await drained();
  const write = h.writes.take();

  h.external("/p/a.yar", "theirs");
  write.resolve();
  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await compiling;

  assert.equal(h.disk.get("/p/a.yar"), "theirs");
  assert.deepEqual(h.dirty(), ["/p/a.yar"]);
  // To the plan a refused write is the same answer as a refused check: what the compiler
  // would read at that path is not what the editor holds, so it is not asked at all.
  assert.equal(h.compiles.count(), 0, "the compiler was never asked");
  assert.equal(h.ui.build, "not-compiled", "and Scan is not offered");
  assert.match(h.ui.problems, /a\.yar changed on disk, so nothing was compiled/);
});

test("a compile superseded while its auto-save was reading writes nothing", async () => {
  // The read before a write is an await like any other, and a Refresh during it says the
  // disk is no longer known to hold what was compiled - which supersedes this compile.
  // Its snapshot is then a revision nobody is asking to have written, and the write is
  // the one thing that cannot be taken back afterwards.
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  const compiling = h.compile();
  await drained();
  const prewrite = h.reads.take();
  assert.equal(prewrite.key, "/p/a.yar", "the plan is deciding whether it may write");

  // Refresh, pressed while that read is held. It touches no document - so nothing the
  // check looks at has changed - and it invalidates the compile outright.
  const refreshing = h.refreshManually();
  await drained();
  assert.equal(h.ui.build, "stale");

  // The read now answers with exactly what the plan expected to find, so the check says
  // writable and only the re-check after it can stop the write.
  prewrite.resolve("rule a {}");
  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await refreshing;
  await compiling;

  assert.equal(h.writes.count(), 0, "nothing was written for an abandoned compile");
  assert.equal(h.disk.get("/p/a.yar"), "rule a {}", "the file is as the user left it");
  assert.deepEqual(h.dirty(), ["/p/a.yar"], "and their text is still theirs to save");
  assert.equal(h.text("/p/a.yar"), "mine");
  // Quietly: an operation the user has moved past is not a refusal to report to them.
  assert.equal(h.compiles.count(), 0, "the compiler was never asked");
  assert.equal(h.ui.build, "stale");
  assert.equal(h.ui.problems, null);
});

// ---- The disk already holding what the write was going to put there ----
//
// An external actor can write exactly the editor's text: the same file exported twice,
// a formatter run outside Quipu, a checkout of the branch it came from. The pre-write
// read then finds the disk in agreement with the document, which is not a change to
// refuse - it is the write's own purpose, already served.

test("an external write of exactly the editor's text leaves Save nothing to do", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");

  // Save queued behind a rename, with nothing known to be wrong with a.yar.
  const renaming = h.renameRule("/p/b.yar", "d.yar");
  await drained();
  const rename = h.writes.take();
  const saving = h.saveActive();
  await drained();
  assert.deepEqual(h.prompts, []);

  // Written by somebody else inside the interval nothing watches, and identical to what
  // this save holds.
  h.external("/p/a.yar", "mine");

  rename.resolve();
  await h.settleWrites();
  await renaming;
  await saving;

  assert.equal(h.writes.count(), 1, "one write: the rename. The save had nothing to add");
  assert.equal(h.disk.get("/p/a.yar"), "mine");
  assert.equal(h.dirty().length, 0, "the document is clean, because the disk holds its text");
  assert.equal(h.conflicts().length, 0, "and a file that agrees with it is no conflict");
  assert.deepEqual(h.prompts, []);
  assert.equal(h.ui.problems, null);
});

test("a compile whose auto-save finds its own text already on disk still compiles", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.open("/p/b.yar");
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");

  // A save of b.yar holds the queue - a save, not a rename, because renaming a rule
  // would be a change to the project and would supersede the compile outright.
  h.activate("/p/b.yar");
  const saving = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  const write = h.writes.take();

  const compiling = h.compile();
  await drained();
  assert.deepEqual(h.prompts, [], "nothing is known to be wrong with a.yar");

  h.external("/p/a.yar", "mine");

  write.resolve();
  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await saving;
  await compiling;

  // The compile depends on the disk holding the editor's text, and it does. Refusing
  // because somebody else put it there would abort a compile over its own success.
  assert.equal(h.writes.count(), 1, "only b.yar was written");
  assert.equal(h.disk.get("/p/a.yar"), "mine");
  assert.equal(h.compiles.count(), 1, "and what was compiled is what is on disk");
  assert.equal(h.ui.build, "compiled");
  assert.equal(h.ui.problems, null);
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0);
});

// ---- Two writes authorised by one conflict ----
//
// One visible conflict can authorise two gestures, and by the time the second one's turn
// comes the conflict is over. HOW it ended is the whole question. Quipu's own earlier
// write ended it by doing what both gestures asked for, so the second still means what it
// meant. Reload from Disk ended it by taking the other version, which discards exactly
// the revision the queued write is holding - so that authorisation is gone.

test("a second Save authorised by the same conflict writes its own revision", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  // Save, with its write in flight and the conflict still on screen.
  const first = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  const write = h.writes.take();

  // More typing, then a second Save - asked and answered against the same conflict,
  // because that is still what is shown.
  h.edit("/p/a.yar", "mine, and more");
  const second = h.saveActive();
  await drained();
  assert.deepEqual(h.prompts, ["overwrite:a.yar", "overwrite:a.yar"], "asked once each");
  assert.equal(h.writes.pending(), 0, "the second save is waiting its turn");

  write.resolve();
  await h.settleWrites();
  await first;
  await second;

  // Nobody else has been at the file and nothing was discarded: the conflict was resolved
  // by the first of these two gestures, which is not a reason to drop the second.
  assert.equal(h.writes.count(), 2, "both saves wrote");
  assert.equal(h.disk.get("/p/a.yar"), "mine, and more", "the second revision is on disk");
  assert.equal(h.dirty().length, 0, "so nothing is left unsaved despite the second gesture");
  assert.equal(h.conflicts().length, 0);
  assert.equal(h.ui.problems, null);
});

test("a Save queued when Reload from Disk resolved the conflict writes nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  // Save, queued behind a rename so that it has not written yet, and confirmed.
  const renaming = h.renameRule("/p/b.yar", "d.yar");
  await drained();
  const rename = h.writes.take();
  const saving = h.saveActive();
  await drained();
  assert.deepEqual(h.prompts, ["overwrite:a.yar"]);

  // Then the user changes their mind and takes the other version instead. The conflict
  // ends exactly as the save's own write would have ended it, and the version taken is
  // the one already reported - so nothing about the FILE has been found out since.
  const reloading = h.reloadActive();
  await drained();
  h.serveReads();
  await drained();
  await reloading;
  assert.equal(h.text("/p/a.yar"), "theirs");

  rename.resolve();
  await h.settleWrites();
  await renaming;
  await saving;

  // What the queued save holds is the revision they have just discarded, so writing it
  // would undo the resolution they chose.
  assert.equal(h.writes.count(), 1, "one write: the rename");
  assert.equal(h.disk.get("/p/a.yar"), "theirs", "their version is still there");
  assert.equal(h.text("/p/a.yar"), "theirs");
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0);
  assert.deepEqual(h.prompts, ["overwrite:a.yar", "reload:a.yar"], "and nothing was asked twice");
  assert.equal(h.ui.problems, null);
});

test("a compile queued behind the save that resolved the conflict compiles that save", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  // Save and Compile, both asked about the same conflict and both agreed to.
  const saving = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  const write = h.writes.take();
  const compiling = h.compile();
  await drained();
  assert.deepEqual(h.prompts, ["overwrite:a.yar", "overwrite:a.yar"], "asked once each");

  write.resolve();
  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await saving;
  await compiling;

  // The disk holds exactly what the editor holds, put there by the save the plan was
  // queued behind - so the plan had nothing to write and nothing to refuse.
  assert.equal(h.writes.count(), 1, "one write, not two");
  assert.equal(h.disk.get("/p/a.yar"), "mine");
  assert.equal(h.compiles.count(), 1, "and what was compiled is what is on disk");
  assert.equal(h.ui.build, "compiled");
  assert.equal(h.ui.problems, null);
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0, "the conflict is over, having been overwritten");
});

test("an edit made during that save is not compiled as though it had been written", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();

  const saving = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  const write = h.writes.take();
  const compiling = h.compile();
  await drained();

  // Typed while the save's write was in flight, so the disk will not hold it and the
  // document stays dirty. Editing a rule is a change to the project, so this compile is
  // already about something else.
  h.edit("/p/a.yar", "mine, and more");
  write.resolve();
  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await drained();
  await saving;
  await compiling;

  assert.equal(h.writes.count(), 1, "the plan did not write the newer revision");
  assert.equal(h.disk.get("/p/a.yar"), "mine", "the disk holds what the save wrote");
  // Nothing was compiled, rather than the older revision being compiled and offered for
  // scanning as though it were what is on screen. Quietly, because the user's own edit
  // is what overtook it.
  assert.equal(h.compiles.count(), 0);
  assert.equal(h.ui.build, "stale", "so Scan is not offered");
  assert.equal(h.ui.problems, null);
  assert.deepEqual(h.dirty(), ["/p/a.yar"], "and their newer text is still theirs to save");
  assert.equal(h.text("/p/a.yar"), "mine, and more");
});

test("an external edit during a manual save is found by the catch-up", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.open("/p/b.yar");
  h.activate("/p/a.yar");
  h.edit("/p/a.yar", "mine in a");

  const saving = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  const write = h.writes.take();
  // Somebody else edits the OTHER open document while the fence is up. There is no
  // watcher to report it, so nothing but the catch-up can ever find it. The save's own
  // pre-write read was about the file it is writing, and would not have found this.
  h.external("/p/b.yar", "theirs in b");
  assert.equal(h.timer.pending(), 0, "nothing was reported, and nothing can be");

  write.resolve();
  await h.settleWrites();
  await saving;

  assert.equal(h.text("/p/b.yar"), "theirs in b", "the catch-up read it and took it");
  assert.deepEqual(h.lsp.changed, ["/p/b.yar"]);
  assert.equal(h.dirty().length, 0, "a.yar was saved");
  assert.equal(h.disk.get("/p/a.yar"), "mine in a");
  assert.equal(h.conflicts().length, 0);
});

test("an external edit to the file being saved is not baked into its baseline", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  const saving = h.saveActive();
  await drained();
  h.serveReads();
  await drained();
  const write = h.writes.take();
  write.resolve();
  await drained();
  // Written by Quipu, then overwritten by somebody else, all inside the fence. The
  // document is clean at "mine" and its file no longer holds it.
  h.external("/p/a.yar", "theirs, after Quipu's write");
  await h.settleWrites();
  await saving;

  // The catch-up finds a clean document whose file changed, which is a reload - not a
  // baseline that claims the disk holds what Quipu wrote.
  assert.equal(h.text("/p/a.yar"), "theirs, after Quipu's write");
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0);
  assert.deepEqual(h.lsp.changed, ["/p/a.yar"]);
});

test("an external edit during a multi-file compile auto-save is not lost", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}", "c.yar": "rule c {}" });
  h.open("/p/b.yar");
  h.open("/p/c.yar");
  h.edit("/p/a.yar", "mine in a");
  h.edit("/p/b.yar", "mine in b");

  const compiling = h.compile();
  await drained();
  h.serveReads();
  await drained();
  const first = h.writes.take();
  first.resolve();
  await drained();
  // Between the plan's two writes: still fenced, so still nobody's to report.
  h.external("/p/c.yar", "theirs in c");
  // The plan's second write checks its own file, which is not the one that changed.
  h.serveReads();
  await drained();
  const second = h.writes.take();
  second.resolve();
  await drained();
  assert.equal(h.native.fences, 1, "one fence for the whole plan");

  await h.settleWrites();
  while (h.compiles.pending() > 0) h.compiles.take().resolve({ ok: true, ruleCount: 1 });
  await compiling;

  assert.equal(h.ui.build, "compiled", "the compile's own writes did not invalidate it");
  assert.equal(h.text("/p/c.yar"), "theirs in c", "and the unrelated edit is on screen");
  assert.deepEqual(h.lsp.changed, ["/p/c.yar"]);
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0);
  assert.ok(h.native.armed);
});

test("coverage armed after a save is analysed without invalidating the compile", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "rule a { condition: true }");
  await h.compileOk();
  assert.equal(h.ui.build, "compiled");
  const before = h.ui.analyses;

  // The analysis that ended the save's fence derived wider coverage - a dependency
  // reached outside the root, say - and the backend has now armed it. Some of that
  // was read before anything watched it, so one more analysis is owed; nothing has
  // said the project changed, so the ruleset still describes it.
  h.coverageArmed();
  assert.equal(h.ui.build, "compiled", "Scan is still offered");
  assert.equal(h.watching.isRespondingToChange(), false);

  await h.respond();
  assert.equal(h.ui.analyses, before + 1, "one analysis, and nothing further is owed");
  assert.equal(h.ui.build, "compiled");
  assert.equal(h.watching.isResponding(), false);
});

// ---- A command whose project changed while its fence was going up ----
//
// Raising the fence is an await, and the user can switch folders or close the
// workspace during it. Every one of these commands captured a selection before that
// await, so each has to ask again with the fence up and before it mutates anything.

test("a save whose project the user left during the fence writes nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.deferFences();

  const saving = h.saveActive();
  await drained();
  const fence = h.fenceCalls.take();
  // The switch happens while the fence command is still queued.
  await h.load("/q", { "z.yar": "rule z {}" });
  fence.resolve();
  await saving;
  await drained();

  assert.equal(h.writes.count(), 0, "not one write was issued");
  assert.equal(h.disk.get("/p/a.yar"), "rule a {}", "the file is as its own project left it");
  assert.equal(h.ui.problems, null, "and nothing was reported against /q");
  assert.ok(h.native.armed, "/q is watched");
  assert.equal(h.native.outstanding.size, 0, "and no fence was left standing");
});

test("New Rule whose project the user left during the fence creates nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.deferFences();

  const creating = h.newRule("new.yar");
  await drained();
  const fence = h.fenceCalls.take();
  await h.load("/q", { "z.yar": "rule z {}" });
  fence.resolve();
  await creating;
  await drained();

  assert.equal(h.writes.count(), 0);
  assert.equal(h.disk.has("/p/new.yar"), false, "no file in the project the user left");
  assert.equal(h.disk.has("/q/new.yar"), false, "and none in the one they went to");
  assert.deepEqual(h.docs.keys(), ["/q/z.yar"], "the editor holds only /q's document");
  assert.equal(h.ui.problems, null);
  assert.equal(h.native.outstanding.size, 0);
});

test("Rename Rule whose project the user left during the fence renames nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.deferFences();

  const renaming = h.renameRule("/p/a.yar", "b.yar");
  await drained();
  const fence = h.fenceCalls.take();
  await h.load("/q", { "z.yar": "rule z {}" });
  fence.resolve();
  await renaming;
  await drained();

  assert.equal(h.writes.count(), 0);
  assert.equal(h.disk.get("/p/a.yar"), "rule a {}", "still where it was");
  assert.equal(h.disk.has("/p/b.yar"), false);
  assert.deepEqual(h.docs.keys(), ["/q/z.yar"]);
  assert.equal(h.native.outstanding.size, 0);
});

test("a save whose workspace was closed during the fence writes nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.deferFences();

  const saving = h.saveActive();
  await drained();
  const fence = h.fenceCalls.take();
  await h.closeWorkspace();
  fence.resolve();
  await saving;
  await drained();

  assert.equal(h.writes.count(), 0);
  assert.equal(h.disk.get("/p/a.yar"), "rule a {}");
  assert.equal(h.reads.count(), 0, "and nothing was caught up on for a closed workspace");
  assert.equal(h.ui.problems, null);
});

// ---- A mutation that outlived its project ----
//
// A write already in flight when the user opens another folder cannot be recalled: it
// finishes eventually, against a project that is no longer on screen. What it must not
// do is stand in the way of the catch-up the CURRENT project is owed - it cannot
// perform that catch-up itself, its subscription being gone - which is why what is
// outstanding is counted per subscription rather than once for the window.

test("a mutation left behind in another project does not swallow this one's catch-up", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });

  // /p's New Rule reaches its write and stays there.
  const stray = h.newRule("stray.yar");
  await drained();
  const strayWrite = h.writes.take();

  await h.load("/q", { "z.yar": "rule z {}" });
  const before = h.ui.analyses;
  const subscription = h.watching.subscription();

  // /q's own New Rule, which relies entirely on the end of its fence to put the new
  // file into the project model: nothing else is going to report it. It claims its turn
  // behind /p's write, so both are outstanding at once - which is the state the
  // per-subscription count exists for.
  const creating = h.newRule("new.yar");
  await drained();
  assert.equal(h.native.fences, 2, "one fence each");
  assert.equal(h.writes.pending(), 0, "/q's write is waiting for /p's to finish");

  // /p's write lands, and /p's mutation is therefore the first one out. It may not
  // report /q as caught up on - it cannot catch /q up, its own subscription being gone
  // - and /q's mutation has not even written yet.
  strayWrite.resolve();
  await h.settleWrites();
  await creating;

  assert.equal(h.disk.get("/q/new.yar"), "");
  assert.equal(h.ui.analyses, before + 1, "/q was caught up on exactly once");
  assert.equal(h.session.isStale(), false, "so its snapshot describes the disk again");
  assert.deepEqual(h.reads.keys().sort(), ["/q/new.yar", "/q/z.yar"]);
  assert.ok(h.native.armed);
  assert.equal(h.native.outstanding.size, 0);

  // And /p's mutation finishing changes nothing about /q beyond that: its subscription
  // is gone, so it can neither catch up nor claim to have been caught up on.
  const analyses = h.ui.analyses;
  const reads = h.reads.count();
  await stray;

  assert.equal(h.disk.get("/p/stray.yar"), "", "the write itself was already in flight");
  assert.deepEqual(h.docs.keys(), ["/q/z.yar", "/q/new.yar"], "and nothing of /p was opened");
  assert.equal(h.ui.analyses, analyses);
  assert.equal(h.reads.count(), reads);
  assert.equal(h.ui.problems, null);
  assert.equal(h.watching.subscription(), subscription, "/q is still the project being watched");
  assert.ok(h.native.armed);
});

// ---- Documents ----

test("a clean document changed externally is reloaded", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  assert.equal(h.text("/p/a.yar"), "rule a {}");

  h.external("/p/a.yar", "rule a { condition: true }");
  await h.respond();

  assert.equal(h.text("/p/a.yar"), "rule a { condition: true }");
  assert.equal(h.dirty().length, 0, "the reloaded revision is the saved baseline");
  assert.equal(h.conflicts().length, 0);
  assert.deepEqual(h.lsp.changed, ["/p/a.yar"], "the LSP is told exactly once");
});

test("a reload does not masquerade as a user edit", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  await h.compileOk();

  h.external("/p/a.yar", "rule a { condition: true }");
  await h.respond();
  assert.equal(h.text("/p/a.yar"), "rule a { condition: true }");

  // The reload drove the model, so the content listener would have fired. Had it
  // been treated as an edit, each automatic refresh would have scheduled the next.
  assert.equal(h.watching.isResponding(), false);
  assert.equal(h.timer.pending(), 0);
});

test("a reload does not move the editor off the document the user chose", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.docs.ensure("/p/b.yar", () => ({
    getValue: () => "rule b {}",
    getAlternativeVersionId: () => 1,
    setValue() {
      throw new Error("b.yar was not the file that changed");
    },
  }));
  const active = h.ui.active;

  h.external("/p/a.yar", "rule a { condition: true }");
  await h.respond();
  assert.equal(h.ui.active, active, "still where the user left it");
});

test("a user edit while the reload read is pending keeps their text", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });

  h.external("/p/a.yar", "theirs");
  h.timer.run();
  await drained();
  const read = h.reads.take();

  // Typed while the file was being read. An edit establishes nothing about the file,
  // so it deliberately does not supersede the read - the read is exactly what turns
  // this into a conflict.
  h.edit("/p/a.yar", "mine");
  read.resolve("theirs");
  await drained();
  h.settleAnalyses();
  await drained();

  assert.equal(h.text("/p/a.yar"), "mine", "their text is not replaced");
  assert.deepEqual(h.conflicts(), ["/p/a.yar"], "it is a conflict instead");
  assert.deepEqual(h.lsp.changed, [], "and nothing was reloaded");
});

// ---- A read a newer disk operation has overtaken ----
//
// Reads are asynchronous, and something that KNOWS what the file holds can happen
// while one is in flight: a save writing it, a Reload from Disk taking it. What the
// read found is then a comparison against an agreement that no longer exists, and
// acting on it puts back the state the disk has just moved out of. The document's
// revision cannot stand in for this - a save moves the baseline without moving the
// revision, and recording a `missing` conflict touches no revision at all.

test("a reconciliation read from before a save cannot undo it", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  // Unsaved BEFORE the read is issued, so the read is answered against a document
  // whose revision the save is about to declare written.
  h.edit("/p/a.yar", "mine");

  // A response is under way - something else in the project changed - and its read of
  // a.yar is outstanding. What it will report is the file as it is now, which is not
  // what the save is about to make it.
  h.external("/p/b.yar", "rule b {}");
  h.timer.run();
  await drained();
  const read = h.reads.take();
  assert.equal(read.key, "/p/a.yar");

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  assert.deepEqual(h.prompts, [], "nothing was in conflict when Save was asked for");
  assert.equal(h.disk.get("/p/a.yar"), "mine");
  assert.equal(h.dirty().length, 0);

  // The read describes the file as it was before that write, at the very revision the
  // save recorded as being on disk. Reloading from it would replace the text the save
  // wrote with the text it replaced.
  read.resolve("rule a {}");
  await drained();
  h.settleAnalyses();
  await drained();

  assert.equal(h.text("/p/a.yar"), "mine", "the saved text is still on screen");
  assert.equal(h.disk.get("/p/a.yar"), "mine", "and still on disk");
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0);
  assert.deepEqual(h.lsp.changed, [], "nothing was reloaded");

  // The baseline is what the save wrote, and reads are still being answered against
  // it: a genuine change after the save is still taken.
  h.external("/p/a.yar", "theirs, later");
  await h.respond();
  assert.equal(h.text("/p/a.yar"), "theirs, later");
  assert.deepEqual(h.lsp.changed, ["/p/a.yar"]);
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0);
});

test("a read from before a save recreated the file does not mark it missing again", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });

  h.removeExternally("/p/a.yar");
  await h.respond();
  assert.equal(h.docs.conflictOf("/p/a.yar"), "missing");

  // A second response is under way, and its read of a.yar is still outstanding.
  h.external("/p/b.yar", "rule b {}");
  h.timer.run();
  await drained();
  const read = h.reads.take();

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  assert.deepEqual(h.prompts, ["overwrite:a.yar"]);
  assert.equal(h.disk.get("/p/a.yar"), "rule a {}", "the file is back");
  assert.equal(h.docs.conflictOf("/p/a.yar"), null);

  // That read is about the interval in which the file was gone. Recording it now would
  // warn the user about a document whose file is sitting on the disk, and offer to
  // write it back over itself.
  read.reject(new Error("/p/a.yar: no such file"));
  await drained();
  h.settleAnalyses();
  await drained();

  assert.equal(h.docs.conflictOf("/p/a.yar"), null, "the file is there, and so it stays");
  assert.equal(h.canSave(), false, "the disk holds exactly what the editor holds");
  assert.equal(h.canReload(), false);
  assert.equal(h.text("/p/a.yar"), "rule a {}");
  assert.equal(h.disk.get("/p/a.yar"), "rule a {}");
  assert.equal(h.dirty().length, 0);
  assert.deepEqual(h.lsp.changed, []);

  // And the baseline is the recreated file's, so a change to it is still found.
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.equal(h.text("/p/a.yar"), "theirs");
  assert.deepEqual(h.lsp.changed, ["/p/a.yar"]);
});

test("an automatic read cannot undo a newer Reload from Disk", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  // Another external change, whose automatic read is outstanding...
  h.external("/p/a.yar", "theirs again");
  h.timer.run();
  await drained();
  const auto = h.reads.take();

  // ...while the user resolves the conflict by taking the file's version.
  const resolving = h.reloadActive();
  await drained();
  h.reads.take().resolve("theirs again");
  await resolving;
  assert.equal(h.text("/p/a.yar"), "theirs again");
  assert.equal(h.conflicts().length, 0);
  assert.equal(h.dirty().length, 0);

  // Now the automatic read lands, from before the reload read the file, and says the
  // file is gone. A revision check could not refuse it: recording a `missing`
  // conflict compares no revisions at all.
  auto.reject(new Error("/p/a.yar: no such file"));
  await drained();
  h.settleAnalyses();
  await drained();

  assert.equal(h.docs.conflictOf("/p/a.yar"), null, "the resolution the user asked for stands");
  assert.equal(h.canSave(), false);
  assert.equal(h.canReload(), false);
  assert.equal(h.text("/p/a.yar"), "theirs again");
  assert.deepEqual(h.lsp.changed, ["/p/a.yar"], "told once, by the reload");
  assert.deepEqual(h.prompts, ["reload:a.yar"]);
});

test("a save while Reload from Disk is reading wins, and the reload is dropped", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  // Reload from Disk is reading the file...
  const resolving = h.reloadActive();
  await drained();
  const read = h.reads.take();

  // ...and the user resolves the same conflict the other way before it answers.
  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  assert.deepEqual(h.prompts, ["reload:a.yar", "overwrite:a.yar"]);
  assert.equal(h.disk.get("/p/a.yar"), "mine");

  // The read is about the file the save has just replaced, and its revision is the one
  // the save declared written - so nothing about the model can refuse it.
  read.resolve("theirs");
  await resolving;
  await drained();

  assert.equal(h.text("/p/a.yar"), "mine", "the text the user chose to keep");
  assert.equal(h.disk.get("/p/a.yar"), "mine", "and the file still holds it");
  assert.equal(h.dirty().length, 0);
  assert.equal(h.conflicts().length, 0);
  assert.deepEqual(h.lsp.changed, [], "nothing was reloaded");
});

test("a dirty document changed externally is a conflict, never replaced", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  h.external("/p/a.yar", "theirs");
  await h.respond();

  assert.equal(h.text("/p/a.yar"), "mine");
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);
  assert.deepEqual(h.dirty(), ["/p/a.yar"], "and still unsaved");
});

test("an open file deleted externally stays open, marked missing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.edit("/p/a.yar", "work nobody else has");

  h.removeExternally("/p/a.yar");
  await h.respond();

  assert.equal(h.text("/p/a.yar"), "work nobody else has", "its text is the only copy left");
  assert.equal(h.docs.conflictOf("/p/a.yar"), "missing");
  // Renamed away is the same event pair, and Quipu does not guess which creation is
  // the rename's target: a.yar is missing, and b.yar is whatever b.yar is.
  assert.equal(h.docs.conflictOf("/p/b.yar"), null);
});

test("a notification for Quipu's own completed save arriving late is not a conflict", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;

  // The event was fenced out, but a slow notification for the same write can arrive
  // through a later instance. What is on disk is exactly what Quipu wrote.
  h.external("/p/a.yar", "mine");
  await h.respond();
  assert.equal(h.conflicts().length, 0);
  assert.equal(h.dirty().length, 0);
});

// ---- A document whose file has gone ----
//
// Nothing was edited, so it is not dirty - and its text is the only copy of the file
// left anywhere. That makes it work at risk: Save has to be able to put it back, the
// question before overwriting still has to be asked, and leaving the project has to
// warn about it in words that are true of it.

test("a missing document offers Save and Reload from Disk", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  assert.equal(h.canSave(), false, "the file holds exactly what the editor does");

  h.removeExternally("/p/a.yar");
  await h.respond();

  assert.equal(h.docs.conflictOf("/p/a.yar"), "missing");
  assert.equal(h.dirty().length, 0, "nothing was edited");
  // Both derived from needsSaving() rather than from the dirty flag: the toolbar
  // button and the File > Save item say the same thing, and greying it out here would
  // leave the only copy of the file with no way back onto the disk.
  assert.equal(h.canSave(), true);
  assert.equal(h.canReload(), true);
});

test("saving a missing document recreates the file after confirmation", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.removeExternally("/p/a.yar");
  await h.respond();
  const before = h.ui.analyses;

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;

  // Recreating a file somebody else deleted is a real choice, so it goes through the
  // same question as overwriting one they changed.
  assert.deepEqual(h.prompts, ["overwrite:a.yar"]);
  assert.equal(h.disk.get("/p/a.yar"), "rule a {}", "the file is back");
  assert.equal(h.conflicts().length, 0, "and the document agrees with it again");
  assert.equal(h.canSave(), false);
  assert.equal(h.canReload(), false);
  // The project gained a file back, and the catch-up is what re-reads it.
  assert.equal(h.ui.analyses, before + 1);
});

test("cancelling that question leaves the missing file missing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.removeExternally("/p/a.yar");
  await h.respond();

  h.setConfirm(false);
  await h.saveActive();
  assert.equal(h.writes.count(), 0, "nothing was written");
  assert.equal(h.disk.has("/p/a.yar"), false);
  assert.equal(h.native.fences, 0, "and nothing was fenced, because nothing was written");
  assert.equal(h.docs.conflictOf("/p/a.yar"), "missing", "still the only copy of its text");
  assert.equal(h.canSave(), true, "so Save is still the way out");
});

test("closing the workspace warns about a missing document in its own words", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.removeExternally("/p/a.yar");
  await h.respond();

  h.setConfirm(false);
  assert.equal(await h.closeWorkspace(), false, "declining leaves the project open");
  // "unsaved changes" would be untrue of it: nobody changed it, and that is precisely
  // why it would be lost without a word.
  assert.deepEqual(h.prompts, ["discard:a.yar (not on disk):Close the workspace"]);
  assert.equal(h.session.isOpen(), true);
  assert.equal(h.text("/p/a.yar"), "rule a {}", "and its text is still here");

  h.setConfirm(true);
  assert.equal(await h.closeWorkspace(), true);
  assert.deepEqual(h.docs.keys(), []);
});

test("switching projects warns about a missing document too", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}" });
  h.open("/p/b.yar");
  h.edit("/p/b.yar", "mine in b");
  h.removeExternally("/p/a.yar");
  await h.respond();

  h.setConfirm(false);
  assert.equal(await h.openFolder("/q"), false);
  // Both, in the order they were opened, each described the way it is at risk.
  assert.deepEqual(h.prompts, [
    "discard:a.yar (not on disk), b.yar (unsaved):Open another folder",
  ]);
  assert.equal(h.session.root(), "/p", "the project on screen did not move");
});

test("a clean document whose file merely changed is not warned about", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });

  // Changed underneath a document holding no edits: the catch-up reloads it, and even
  // before that the disk has a version of its own. There is nothing to lose.
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.equal(h.text("/p/a.yar"), "theirs");

  h.setConfirm(false);
  assert.equal(await h.closeWorkspace(), true, "nothing to ask about");
  assert.deepEqual(h.prompts, []);
});

// ---- Resolving a conflict ----

test("Reload from Disk takes the other version after confirmation", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  const resolving = h.reloadActive();
  await drained();
  h.serveReads();
  await resolving;

  assert.deepEqual(h.prompts, ["reload:a.yar"], "asked before unsaved work was discarded");
  assert.equal(h.text("/p/a.yar"), "theirs");
  assert.equal(h.conflicts().length, 0);
  assert.equal(h.dirty().length, 0);
});

test("cancelling Reload from Disk changes nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();

  h.setConfirm(false);
  await h.reloadActive();
  assert.equal(h.reads.pending(), 0, "nothing was even read");
  assert.equal(h.text("/p/a.yar"), "mine");
  assert.deepEqual(h.conflicts(), ["/p/a.yar"], "and the conflict still stands");
});

test("Reload from Disk on a file that has gone reports it and keeps the conflict", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.removeExternally("/p/a.yar");
  await h.respond();
  assert.equal(h.docs.conflictOf("/p/a.yar"), "missing");

  const resolving = h.reloadActive();
  await drained();
  h.serveReads();
  await resolving;

  assert.match(h.ui.problems, /no such file/);
  assert.equal(h.docs.conflictOf("/p/a.yar"), "missing", "still the only copy of its text");
  assert.equal(h.text("/p/a.yar"), "rule a {}");
});

test("a reload that lands after the workspace closed changes nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.external("/p/a.yar", "theirs");
  await h.respond();
  h.external("/p/a.yar", "theirs again");
  await h.respond();

  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "and theirs again");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  const resolving = h.reloadActive();
  await drained();
  const read = h.reads.take();
  await h.closeWorkspace();
  read.resolve("and theirs again");
  await resolving;
  assert.deepEqual(h.docs.keys(), [], "there is nothing to reload into");
});

// ---- Saving over a conflict ----

test("saving a conflicted document asks first", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;

  assert.deepEqual(h.prompts, ["overwrite:a.yar"]);
  assert.equal(h.disk.get("/p/a.yar"), "mine");
  assert.equal(h.conflicts().length, 0, "the file now holds what the document holds");
});

test("cancelling that question writes nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();

  h.setConfirm(false);
  await h.saveActive();
  assert.equal(h.writes.count(), 0, "not one write was issued");
  assert.equal(h.disk.get("/p/a.yar"), "theirs");
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);
  assert.deepEqual(h.dirty(), ["/p/a.yar"]);
});

test("renaming a conflicted document does not get it past that question", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar"]);

  // The rename moves the file too, so the version Quipu never saw is at the new path
  // now. The disagreement is about whose bytes are right, and moving them settled
  // nothing about that.
  const renaming = h.renameRule("/p/a.yar", "b.yar");
  await drained();
  h.writes.take().resolve();
  await drained();

  // Asserted here, with the catch-up's reads still outstanding, because that is the
  // interval the user can act in: a Ctrl+S now must still be asked about. A conflict
  // that only a later read restores would leave a window in which Save silently
  // overwrites the other version - and if the watcher was degraded, no read is coming.
  assert.deepEqual(h.docs.keys(), ["/p/b.yar"]);
  assert.equal(h.text("/p/b.yar"), "mine", "the unsaved text came along");
  assert.deepEqual(h.dirty(), ["/p/b.yar"]);
  assert.equal(h.docs.conflictOf("/p/b.yar"), "changed", "and so did the conflict");
  assert.equal(h.disk.get("/p/b.yar"), "theirs");

  h.prompts.length = 0;
  h.setConfirm(false);
  await h.saveActive();
  assert.deepEqual(h.prompts, ["overwrite:b.yar"], "the question was still asked");
  assert.equal(h.disk.get("/p/b.yar"), "theirs", "and cancelling wrote nothing");
  assert.equal(h.native.fences, 1, "the cancelled save did not even fence");

  await h.settleWrites();
  await renaming;
  assert.deepEqual(h.conflicts(), ["/p/b.yar"], "the catch-up reached the same conclusion");

  h.setConfirm(true);
  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  assert.equal(h.disk.get("/p/b.yar"), "mine");
  assert.equal(h.conflicts().length, 0);
});

test("a compile asks once for every conflicted file it would overwrite", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}", "b.yar": "rule b {}", "c.yar": "rule c {}" });
  for (const name of ["a", "b", "c"]) {
    h.docs.ensure(`/p/${name}.yar`, () => model(`rule ${name} {}`, () => {}));
    h.edit(`/p/${name}.yar`, `mine in ${name}`);
  }
  h.external("/p/a.yar", "theirs in a");
  h.external("/p/c.yar", "theirs in c");
  await h.respond();
  assert.deepEqual(h.conflicts(), ["/p/a.yar", "/p/c.yar"]);

  await h.compileOk();
  // One question naming both, not one dialogue per file.
  assert.deepEqual(h.prompts, ["overwrite:a.yar,c.yar"]);
  assert.equal(h.ui.build, "compiled");
});

test("cancelling a compile's overwrite question aborts before anything is written", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.external("/p/a.yar", "theirs");
  await h.respond();

  h.setConfirm(false);
  await h.compile();
  assert.deepEqual(h.prompts, ["overwrite:a.yar"]);
  assert.equal(h.writes.count(), 0);
  assert.equal(h.compiles.count(), 0, "and the compiler was never invoked");
  assert.equal(h.ui.build, "not-compiled", "the build state did not even move");
  assert.equal(h.native.fences, 0, "nothing was fenced, because nothing was written");
});

// ---- New Rule and Rename Rule ----

test("New Rule is not reported back as somebody else's change", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const before = h.ui.analyses;

  const creating = h.newRule("new.yar");
  await h.settleWrites();
  await creating;

  assert.equal(h.disk.get("/p/new.yar"), "");
  assert.equal(h.text("/p/new.yar"), "", "and it is open, agreeing with its file");
  assert.equal(h.conflicts().length, 0);
  assert.equal(h.dirty().length, 0);
  // One analysis: the catch-up's. A second one would be the event for Quipu's own
  // creation coming back through a live watcher.
  assert.equal(h.ui.analyses, before + 1);
  assert.equal(h.timer.pending(), 0, "no window was ever opened");
  assert.equal(h.session.isStale(), false, "and the snapshot describes the disk again");
  assert.ok(h.native.armed);
});

test("a rename does not leave the document it moved marked as missing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const before = h.ui.analyses;

  const renaming = h.renameRule("/p/a.yar", "b.yar");
  await h.settleWrites();
  await renaming;

  // The rename is a removal and a creation. Had either reached the coordinator, the
  // catch-up would have read a.yar at a path Quipu itself had just emptied.
  assert.deepEqual(h.docs.keys(), ["/p/b.yar"]);
  assert.equal(h.text("/p/b.yar"), "rule a {}");
  assert.equal(h.conflicts().length, 0);
  assert.equal(h.dirty().length, 0, "a clean document stays clean across a rename");
  assert.equal(h.disk.has("/p/a.yar"), false);
  assert.equal(h.ui.analyses, before + 1);
  assert.equal(h.session.isStale(), false);
});

test("a rename that cannot be performed reports itself and moves nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });

  const renaming = h.renameRule("/p/a.yar", "b.yar");
  await drained();
  h.writes.take().reject(new Error("/p/b.yar: permission denied"));
  await h.settleWrites();
  await renaming;

  assert.match(h.ui.problems, /permission denied/);
  assert.deepEqual(h.docs.keys(), ["/p/a.yar"], "the document is where it was");
  assert.equal(h.disk.get("/p/a.yar"), "rule a {}");
  // The fence is still released, and the interval still caught up on: the write
  // failed, but the watcher was retired for it either way.
  assert.ok(h.native.armed);
  assert.equal(h.native.outstanding.size, 0);
});

// ---- The project the user has left ----

test("an event for the previous project changes nothing in the new one", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const stale = h.watching.subscription();

  await h.load("/q", { "z.yar": "rule z {}" });
  await h.compileOk();
  const before = h.ui.analyses;

  h.watching.changed(stale);
  assert.equal(h.timer.pending(), 0, "no window");
  assert.equal(h.ui.build, "compiled", "and /q's ruleset is untouched");

  h.timer.run();
  await drained();
  assert.equal(h.ui.analyses, before);
});

test("a watcher error from the previous project is not shown against the new one", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const stale = h.watching.subscription();
  await h.load("/q", { "z.yar": "rule z {}" });

  h.watching.failed(stale, "inotify limit reached");
  assert.equal(h.watching.degradation(), null);
});

test("an automatic response cannot reconcile the new project's documents", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });

  h.external("/p/a.yar", "theirs");
  h.timer.run();
  await drained();
  const read = h.reads.take();

  // The user opens another folder while that read is in flight. /q happens to have a
  // file at the same path shape, and nothing about /p may reach it.
  await h.load("/q", { "a.yar": "rule qa {}" });
  read.resolve("theirs");
  await drained();

  assert.equal(h.text("/q/a.yar"), "rule qa {}");
  assert.equal(h.conflicts().length, 0);
  assert.deepEqual(h.lsp.changed, []);
});

test("switching projects withdraws a scheduled response", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.external("/p/a.yar", "theirs");
  assert.equal(h.timer.pending(), 1);

  await h.load("/q", { "z.yar": "rule z {}" });
  assert.equal(h.timer.pending(), 0);
  const before = h.ui.analyses;
  h.timer.run();
  await drained();
  assert.equal(h.ui.analyses, before);
});

// ---- Degradation ----

test("a watcher that could not be installed still opens the project", async () => {
  const h = app();
  h.faults.start = true;
  await h.load("/p", { "a.yar": "rule a {}" });

  assert.equal(h.session.phase(), "ready", "the folder opened");
  assert.equal(h.text("/p/a.yar"), "rule a {}", "and its first file is in the editor");
  assert.match(h.watching.degradation(), /inotify limit reached/);
  assert.equal(h.ui.problems, null, "and it is not the project's own diagnostics");
});

test("manual Refresh still reconciles when watching is unavailable", async () => {
  const h = app();
  h.faults.start = true;
  await h.load("/p", { "a.yar": "rule a {}" });

  // Nothing is watching, so this change is announced by nobody.
  h.external("/p/a.yar", "rule a { condition: true }");
  assert.equal(h.timer.pending(), 0);
  assert.equal(h.text("/p/a.yar"), "rule a {}");

  const refreshing = h.refreshManually();
  await drained();
  h.serveReads();
  await drained();
  h.settleAnalyses();
  await refreshing;
  assert.equal(h.text("/p/a.yar"), "rule a { condition: true }", "Refresh is the fallback");
});

test("manual Refresh takes Scan away the moment it is accepted", async () => {
  const h = app();
  h.faults.start = true;
  await h.load("/p", { "a.yar": "rule a {}" });
  await h.compileOk();
  assert.equal(h.ui.build, "compiled", "Scan is available");

  // Nothing is watching, so this change is announced by nobody: the compiled ruleset
  // has silently stopped describing the disk, and Refresh is the only thing that will
  // ever look.
  h.external("/p/a.yar", "rule a { condition: true }");
  assert.equal(h.ui.build, "compiled", "and nothing has noticed");

  const refreshing = h.refreshManually();
  // Synchronously, before the first read: the whole point of this Refresh is that it
  // cannot say in advance whether anything moved, so Scan must not be offered against
  // the ruleset while it finds out.
  assert.equal(h.ui.build, "stale");

  await drained();
  h.serveReads();
  await drained();
  h.settleAnalyses();
  await refreshing;
  assert.equal(h.text("/p/a.yar"), "rule a { condition: true }");
  // A Refresh costing a recompile is the cheaper mistake, so the old ruleset never
  // comes back on its own.
  assert.equal(h.ui.build, "stale");

  await h.compileOk();
  assert.equal(h.ui.build, "compiled", "only another compile makes Scan available again");
});

// A watcher that could not be started, or that could not be re-armed, leaves the
// backend with nothing installed - so the next handoff has every location to arm, and
// announcing coverage is the moment automatic refresh demonstrably works again.

test("coverage armed after a failed start stops the window saying refresh is unavailable", async () => {
  const h = app();
  h.faults.start = true;
  await h.load("/p", { "a.yar": "rule a {}" });
  assert.match(h.watching.degradation(), /inotify limit reached/);
  assert.equal(h.native.armed, false);

  // A later analysis handed its plan over and the backend armed it. Nothing said the
  // project changed, so this is not an invalidation - but it is proof of coverage.
  h.coverageArmed();
  assert.equal(h.watching.degradation(), null, "automatic refresh is demonstrably working");
  assert.ok(h.native.armed);
  await h.respond();
  assert.equal(h.watching.degradation(), null);

  const before = h.ui.analyses;
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.equal(h.ui.analyses, before + 1, "and events are being delivered");
  assert.equal(h.text("/p/a.yar"), "theirs");
});

test("coverage armed after a failed re-arm stops it too", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  h.edit("/p/a.yar", "mine");
  h.faults.rearm = true;

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  await drained();
  assert.match(h.watching.degradation(), /could not re-arm/);
  assert.equal(h.native.armed, false, "the save left no watcher behind");

  // The catch-up's analysis derived the same plan and the handoff installed it: there
  // was no armed instance for it to keep, so every location is newly covered.
  h.coverageArmed();
  assert.equal(h.watching.degradation(), null);
  assert.ok(h.native.armed);

  await h.respond();
  const before = h.ui.analyses;
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.equal(h.ui.analyses, before + 1);
  assert.equal(h.watching.degradation(), null);
});

test("a failed re-arm outlives the announcement of the coverage its fence retired", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  // The instance the save's fence is about to retire. Its announcement went out on the
  // event channel and need not have arrived yet.
  const retired = h.native.instances;
  h.edit("/p/a.yar", "mine");
  h.faults.rearm = true;

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  await drained();
  assert.match(h.watching.degradation(), /could not re-arm/);
  assert.equal(h.native.armed, false, "and there is nothing delivering");

  // Now that announcement arrives: coverage, but a retired instance's, and it reached the
  // window behind a rejection that came back on the other channel entirely. The two
  // orderings are one ordering because the attempt reserved a number before it failed -
  // drop that, and the news that watching worked before the save would answer a failure
  // reported after it, leaving the window saying automatic refresh is fine while nothing
  // is armed.
  h.watching.covered(h.native.subscription, false, retired);
  assert.match(
    h.watching.degradation(),
    /could not re-arm/,
    "coverage older than the failed attempt clears nothing",
  );
  assert.equal(h.native.armed, false);

  // And the catch-up's own arm, which is newer than the attempt, does clear it.
  h.coverageArmed();
  assert.equal(h.watching.degradation(), null);
  assert.ok(h.native.armed);
});

test("a re-arm whose arming step panicked outlives that announcement too", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const retired = h.native.instances;
  h.edit("/p/a.yar", "mine");
  h.faults.rearmPanics = true;

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  await drained();

  assert.equal(h.disk.get("/p/a.yar"), "mine", "the write went through");
  assert.equal(h.ui.problems, null, "and a panic in the watcher is not a failed save");
  assert.match(h.watching.degradation(), /panicked/);
  assert.ok(h.native.instances > retired, "the attempt spent an identity before it panicked");

  // Which is the whole correction: a panic used to come back saying it had reserved
  // nothing, and a rejection that names no identity is answered by any coverage at all -
  // including this, the announcement of the instance the save's own fence retired.
  h.watching.covered(h.native.subscription, false, retired);
  assert.match(
    h.watching.degradation(),
    /panicked/,
    "coverage older than the attempt that panicked clears nothing either",
  );
  assert.equal(h.native.armed, false, "and nothing is armed to make it true");

  h.coverageArmed();
  assert.equal(h.watching.degradation(), null, "only a newer arm recovers");
  assert.ok(h.native.armed);
});

test("that announcement arriving before the panic leaves the same state", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const retired = h.native.instances;

  // The other interleaving: the announcement of the instance about to be retired arrives
  // while it is still the newest arm heard of, so it is ordinary news of coverage.
  h.watching.covered(h.native.subscription, false, retired);
  assert.equal(h.watching.degradation(), null);

  h.edit("/p/a.yar", "mine");
  h.faults.rearmPanics = true;
  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  await drained();

  assert.match(h.watching.degradation(), /panicked/, "and the rejection still stands");
  h.coverageArmed();
  assert.equal(h.watching.degradation(), null);
  assert.ok(h.native.armed);
});

test("a re-arm nobody could attribute is answered by no announcement at all", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const retired = h.native.instances;
  h.edit("/p/a.yar", "mine");
  h.faults.rearmLost = true;

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  await drained();

  assert.equal(h.ui.problems, null, "still not a failed save");
  assert.match(h.watching.degradation(), /did not come back/);

  // The delayed announcement of the coverage this save's own fence retired. An attributed
  // failure orders it out by comparing identities; this failure has none to compare, and
  // the attempt may have armed a watcher under a number nobody can name - so the one thing
  // that must not happen is treating "unknown" as "nothing was reserved" and letting news
  // from before the attempt say automatic refresh is working.
  h.watching.covered(h.native.subscription, false, retired);
  assert.match(h.watching.degradation(), /did not come back/, "and nothing has answered it");

  // Nor does a later arm, for the same reason in the other direction: the frontend cannot
  // tell this announcement from one that was already in flight, because where the lost
  // attempt's identity fell is exactly what is missing.
  h.coverageArmed();
  assert.match(
    h.watching.degradation(),
    /did not come back/,
    "an announcement it cannot place is not proof, however new it looks",
  );

  // Re-opening the project is the recovery, and it needs nothing proved about instances:
  // the watcher the degradation was about is gone with the subscription.
  await h.load("/p", {});
  assert.equal(h.watching.degradation(), null);
  assert.ok(h.native.armed);
});

test("that announcement arriving before an unattributable rejection leaves the same state", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const retired = h.native.instances;

  // The other interleaving: the announcement arrives while its instance is still the newest
  // arm heard of, so it is ordinary news of coverage and the mark moves to it.
  h.watching.covered(h.native.subscription, false, retired);
  assert.equal(h.watching.degradation(), null);

  h.edit("/p/a.yar", "mine");
  h.faults.rearmLost = true;
  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  await drained();

  // Arriving second changes nothing about what it is: recorded, and no more placeable than
  // it was in the other order. Both interleavings end in the same state - the difference
  // from the attributed cases being that here the state is reached by refusing to order
  // rather than by ordering.
  assert.match(h.watching.degradation(), /did not come back/);
  h.coverageArmed();
  assert.match(h.watching.degradation(), /did not come back/, "still unanswerable");
  await h.load("/p", {});
  assert.equal(h.watching.degradation(), null, "and re-opening is still the way out");
});

test("a rejection that never reached the command is unplaceable in the same way", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const retired = h.native.instances;
  h.edit("/p/a.yar", "mine");
  h.faults.rearmOffline = true;

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  await drained();

  // A transport error is not the registry's shape, so it is normalised - and what it is
  // normalised to matters: 0 would claim the attempt reserved nothing, which nothing here
  // knows. The command may have run and armed before the answer was lost.
  assert.equal(h.ui.problems, null, "still not a failed save");
  assert.match(h.watching.degradation(), /never reached the backend/);
  h.watching.covered(h.native.subscription, false, retired);
  h.coverageArmed();
  assert.match(h.watching.degradation(), /never reached the backend/);
});

// The fence itself is the other call whose rejection cannot say what it did. It reserves no
// identity, so there is none to report - but it RETIRES one, and if it got that far before
// its answer was lost, the token went with the answer and no release will ever lift the
// fence. Reporting that as 0 would let the announcement of the very coverage it retired say
// automatic refresh was working, at the one moment when nothing is watching and nothing can
// arm again until the project is re-opened.

test("a fence whose answer was lost is unplaceable, and nothing can arm again", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  // The instance this save's fence is about to retire. Its announcement went out on the
  // event channel and need not have arrived yet.
  const retired = h.native.instances;
  h.edit("/p/a.yar", "mine");
  h.faults.fenceLost = true;

  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  await drained();

  assert.equal(h.disk.get("/p/a.yar"), "mine", "the write still went through");
  assert.equal(h.ui.problems, null, "and a fence that misbehaved is not a failed save");
  assert.match(h.watching.degradation(), /fence answer never came back/);
  assert.equal(h.native.armed, false, "the fence went up, and the answer was what got lost");
  assert.equal(h.native.outstanding.size, 1, "its token went the same way");

  // The delayed announcement of the coverage that fence retired.
  h.watching.covered(h.native.subscription, false, retired);
  assert.match(
    h.watching.degradation(),
    /fence answer never came back/,
    "news from before the fence answers nothing about it",
  );

  // And nothing else will either. The next mutation lifts its own fence and finds this one
  // still outstanding, so it does not arm: the degradation is the plain truth about the
  // watcher for the rest of the subscription.
  h.faults.fenceLost = false;
  h.edit("/p/a.yar", "mine again");
  const again = h.saveActive();
  await h.settleWrites();
  await again;
  await drained();
  assert.equal(h.disk.get("/p/a.yar"), "mine again", "saving still works");
  assert.equal(h.native.armed, false, "a fence nobody can lift keeps the watcher retired");
  assert.match(h.watching.degradation(), /fence answer never came back/);

  // Re-opening is the recovery at both ends: the frontend gets a subscription nothing has
  // said anything about, and the registry's outstanding fences go with the old one.
  await h.load("/p", {});
  assert.equal(h.watching.degradation(), null);
  assert.ok(h.native.armed);
  assert.equal(h.native.outstanding.size, 0, "including the token nobody could release");
});

test("that announcement arriving before a lost fence answer leaves the same state", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const retired = h.native.instances;

  // The other interleaving: the announcement of the instance the fence is about to retire
  // arrives while it is still the newest arm heard of, so it is ordinary news of coverage.
  h.watching.covered(h.native.subscription, false, retired);
  assert.equal(h.watching.degradation(), null);

  h.edit("/p/a.yar", "mine");
  h.faults.fenceLost = true;
  const saving = h.saveActive();
  await h.settleWrites();
  await saving;
  await drained();

  // Having arrived first makes the rejection no more placeable: the mark stands at the
  // instance the fence retired, and nothing about that says what this fence did.
  assert.match(h.watching.degradation(), /fence answer never came back/);
  assert.equal(h.native.armed, false);

  // An announcement newer than anything heard of - which a real registry could not even
  // produce here, the fence being unliftable - is not evidence either.
  h.coverageArmed();
  assert.match(h.watching.degradation(), /fence answer never came back/, "still unanswerable");

  await h.load("/p", {});
  assert.equal(h.watching.degradation(), null, "and re-opening is still the way out");
});

// Coverage can also install in part: the root arms and a location an include left the
// project for does not. Both halves have to reach the window - the catch-up the armed
// part owes, and the standing degradation for the part nobody is watching.

test("coverage that armed in part catches up and goes on saying what is unwatched", async () => {
  const h = app();
  h.faults.start = true;
  await h.load("/p", { "a.yar": "rule a {}" });
  assert.match(h.watching.degradation(), /inotify limit reached/);

  // Changed while nothing was watching it, which is precisely the debt a handoff's
  // catch-up analysis exists to settle.
  h.disk.set("/p/a.yar", "theirs");

  h.coveragePartial({ message: "/shared: permission denied", paths: ["/p"], catchUp: true });
  await h.respond();
  assert.equal(h.text("/p/a.yar"), "theirs", "the catch-up read the ground that did arm");
  // And the window may not say automatic refresh is working: what the project includes
  // from outside itself is watched by nobody, and only a complete plan clears that.
  assert.equal(h.watching.degradation(), "/shared: permission denied");

  // Events from the part that did arm are delivered as normal meanwhile.
  const before = h.ui.analyses;
  h.external("/p/a.yar", "theirs again");
  await h.respond();
  assert.equal(h.ui.analyses, before + 1);
  assert.equal(h.text("/p/a.yar"), "theirs again");
  assert.equal(h.watching.degradation(), "/shared: permission denied");
});

test("a partial notice that owes nothing does not analyse in a loop", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const before = h.ui.analyses;

  // What every analysis after the first produces once a location has settled into being
  // unwatchable: the same plan installing the same coverage it already had, so nothing
  // was read before this watcher would have reported a change to it. A notice that asked
  // for an analysis regardless would have each analysis produce the next, for as long as
  // the project stayed open.
  h.coveragePartial({ message: "/shared: permission denied", paths: [] });
  assert.equal(h.timer.pending(), 0);
  await h.respond();
  assert.equal(h.ui.analyses, before);
  assert.equal(h.watching.degradation(), "/shared: permission denied");
});

test("a partial notice owing a catch-up with no newly watched path analyses once", async () => {
  const h = app();
  await h.load("/p", { "a.yar": 'include "helper.ya"', "helper.ya": "rule h {}" });
  await h.compileOk();
  const before = h.ui.analyses;

  // The analysis found a dependency that is not a rule file by name, inside the root the
  // watcher was already covering recursively. Nowhere new was installed - so there is no
  // path here to infer anything from - but the watcher being replaced would have
  // filtered a write to it out, and the analysis read it before this one took over. The
  // auxiliary location the same plan named could not be watched at all, so what arrives
  // is a `partial` with nothing to show and a debt all the same.
  h.disk.set("/p/helper.ya", "rule h { condition: true }");
  h.coveragePartial({ message: "/shared: permission denied", paths: [], catchUp: true });
  assert.equal(h.timer.pending(), 1, "one analysis is owed");
  // Not an invalidation: nothing has said the project changed, and taking Scan away here
  // would make discovering a dependency cost the user their compile.
  assert.equal(h.ui.build, "compiled");
  assert.equal(h.watching.isRespondingToChange(), false);

  await h.respond();
  assert.equal(h.ui.analyses, before + 1);
  assert.equal(h.watching.degradation(), "/shared: permission denied");

  // And the identical retry - same plan, same coverage - owes nothing, so it stops here
  // rather than analysing for as long as the location stays unwatchable.
  h.coveragePartial({ message: "/shared: permission denied", paths: [] });
  assert.equal(h.timer.pending(), 0);
  await h.respond();
  assert.equal(h.ui.analyses, before + 1);
});

test("complete coverage that owes no analysis clears the degradation and analyses nothing", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  await h.compileOk();
  h.coveragePartial({ message: "/shared: permission denied", paths: [] });
  assert.equal(h.watching.degradation(), "/shared: permission denied");
  const before = h.ui.analyses;

  // The location that could not be watched became watchable again - by an instance
  // already delivering it for this project, which the handoff kept rather than
  // duplicating. The plan is now complete, so the degradation is over; but nothing was
  // installed, so nothing was read before a watcher would have reported a change to it.
  h.coverageArmed({ catchUp: false });
  assert.equal(h.watching.degradation(), null, "automatic refresh is whole again");
  assert.equal(h.timer.pending(), 0, "and no analysis is owed for coverage never lost");
  assert.equal(h.watching.isResponding(), false);
  assert.equal(h.ui.build, "compiled", "still not an invalidation");

  await h.respond();
  assert.equal(h.ui.analyses, before);

  // Events from the recovered coverage are delivered as normal.
  h.external("/p/a.yar", "theirs");
  await h.respond();
  assert.equal(h.ui.analyses, before + 1);
  assert.equal(h.text("/p/a.yar"), "theirs");
});

test("watching starts before the first analysis, so a change during it is not lost", async () => {
  const h = app();
  h.disk.set("/p/a.yar", "rule a {}");
  const opening = h.openFolder("/p");
  await drained();
  // The initial analysis is in flight, and the watcher is already armed.
  assert.equal(h.analyses.pending(), 1);
  assert.ok(h.native.armed);

  h.external("/p/b.yar", "rule b {}");
  h.settleAnalyses();
  await opening;

  // Not lost: the change made during the first read is scheduled rather than
  // forgotten until something else happens to touch the project.
  assert.equal(h.timer.pending(), 1);
  const before = h.ui.analyses;
  await h.respond();
  assert.equal(h.ui.analyses, before + 1);
});

test("an automatic analysis that fails leaves the previous snapshot on screen", async () => {
  const h = app();
  await h.load("/p", { "a.yar": "rule a {}" });
  const before = h.ui.analyses;

  h.external("/p/b.yar", "rule b {}");
  h.timer.run();
  await drained();
  h.serveReads();
  await drained();
  h.analyses.take().reject(new Error("the backend went away"));
  await drained();

  assert.equal(h.ui.analyses, before, "nothing replaced it");
  assert.equal(h.session.phase(), "ready", "and the snapshot is still usable");
  assert.equal(h.session.isStale(), true);
  assert.equal(h.watching.isResponding(), false, "and the coordinator is not stuck");
});
