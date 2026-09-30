// Tests for target choices that outlive the gesture that made them (targets.ts).
//
// Run with `npm test`. Choosing a file to scan is a dialogue and then a read, and the
// user can do something else while either is outstanding: pick a different file, open
// an example that brings its own sample target, or type the bytes themselves. So each
// case below holds the dialogue or the read open, has the user say something newer,
// and then lets the older one land. What must not happen is the older file installing
// itself over the newer choice, or a failure nobody is waiting for replacing what the
// newer gesture put on screen.
//
// The coordinator is the real module. What is faked is only what it is deliberately
// ignorant of: the dialogue, the read, the target area's presentation, and where a
// failure is shown. No clocks and no DOM - every dialogue and every read is a promise
// the test resolves by hand, so what is asserted is the order of the gestures and
// never the order the I/O happened to finish in.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TargetRequests } from "./targets.ts";

// Lets everything that can proceed proceed: setImmediate runs after the microtask
// queue is exhausted, so what is still outstanding afterwards is waiting on a promise
// the test holds, not on a delay.
const drained = () => new Promise((resolve) => setImmediate(resolve));

// What a gesture returned, without ever waiting on it. Everything that can proceed
// has by the time this reads the outcome, so a gesture that has not finished is one
// still holding out for I/O the test is deliberately keeping open - which is a result
// to assert on rather than something to hang the suite on.
async function outcome(gesture) {
  let value = "pending";
  gesture.then(
    (settled) => {
      value = settled;
    },
    (err) => {
      value = `threw: ${err}`;
    },
  );
  await drained();
  return value;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The dialogues and reads the test resolves by hand. `take()` hands over the oldest
// one that has not been dealt with, so a test never has to count indices.
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
      assert.ok(call, "a dialogue or read was expected to be waiting");
      call.taken = true;
      return call;
    },
  };
}

// The Scan target area, as main.ts drives it.
function area() {
  const picks = calls();
  const reads = calls();
  const failures = [];
  // Everything the target area holds, so a test can assert that a stale gesture
  // changed none of it. `bytes` is what a scan would be given: the file's when one is
  // installed, and otherwise whatever is in the textarea.
  const ui = { bytes: null, text: "", disabled: false, info: "" };

  // main.ts's setFileTarget. One presentation, shared by Choose file… and by an
  // example's sample target, which is why the supersede lives here: whichever of them
  // installs a target has just said what to scan.
  function setFileTarget(path, bytes) {
    targets.supersede();
    ui.bytes = bytes;
    ui.text = "";
    ui.disabled = true;
    ui.info = `File: ${path} (${bytes.length} bytes)`;
  }

  const targets = new TargetRequests({
    pick: () => picks.hold("dialogue"),
    read: (path) => reads.hold(path),
    install: setFileTarget,
    fail: (err) => failures.push(String(err)),
  });

  return {
    targets,
    picks,
    reads,
    failures,
    ui,

    // The Choose file… button.
    choose: () => targets.choose(),

    // main.ts's input listener on the textarea. The DOM delivers input only while the
    // textarea is enabled, which is every state a read can be outstanding in: what
    // disables it is an install, and an install is the last thing a gesture does.
    type(text) {
      ui.text = text;
      targets.supersede();
      if (ui.bytes) {
        ui.bytes = null;
        ui.disabled = false;
        ui.info = "";
      }
    },

    // enterProject's prologue for an accepted example: its sample target arrives with
    // its bytes already in hand.
    openExample(path, bytes) {
      setFileTarget(path, bytes);
    },

    // And an ordinary Open Folder, in terms of the target area: nothing at all. It
    // brings no target of its own and takes nobody's away, so it is written as a call
    // rather than left out - if that ever changes, this is where it has to change too.
    openFolder() {},
  };
}

test("a chosen file becomes the target, and choosing again replaces it", async () => {
  const a = area();

  const first = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/one.bin");
  await drained();
  a.reads.take().resolve([1, 1]);
  assert.equal(await outcome(first), "installed");
  assert.deepEqual(a.ui.bytes, [1, 1]);
  assert.equal(a.ui.disabled, true);
  assert.equal(a.ui.info, "File: /tmp/one.bin (2 bytes)");

  // The install superseded the gesture that made it, which must not leave the
  // coordinator unable to accept the next one.
  const second = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/two.bin");
  await drained();
  a.reads.take().resolve([2]);
  assert.equal(await outcome(second), "installed");
  assert.deepEqual(a.ui.bytes, [2]);
});

test("a dialogue answered after a newer gesture began does not even read its file", async () => {
  const a = area();

  // Two dialogues open at once - the button is not disabled while one is up - and the
  // older one answered second. The user's newer gesture already owns the target area,
  // so the older answer is dropped where it stands rather than costing a read.
  const first = a.choose();
  const second = a.choose();
  await drained();
  const one = a.picks.take();
  const two = a.picks.take();
  two.resolve("/tmp/two.bin");
  await drained();
  one.resolve("/tmp/one.bin");
  await drained();

  assert.equal(await outcome(first), "stale");
  assert.deepEqual(a.reads.keys(), ["/tmp/two.bin"], "only the newer file is read");

  a.reads.take().resolve([2]);
  assert.equal(await outcome(second), "installed");
  assert.deepEqual(a.ui.bytes, [2]);
});

test("the file chosen last wins, whichever read finishes first", async () => {
  const a = area();

  // Both gestures get as far as reading, so the ordering cannot come from one of
  // them being dropped early: it has to come from the count.
  const first = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/one.bin");
  await drained();
  const second = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/two.bin");
  await drained();
  assert.deepEqual(a.reads.keys(), ["/tmp/one.bin", "/tmp/two.bin"]);

  // The newer file is small and lands first; the older one is slow, and arrives after
  // it is already installed. Nothing about the order the disk answers in is allowed
  // to decide which file is the target.
  const one = a.reads.take();
  const two = a.reads.take();
  two.resolve([2]);
  await drained();
  assert.equal(await outcome(second), "installed");
  one.resolve([1, 1, 1]);
  await drained();

  assert.equal(await outcome(first), "stale");
  assert.deepEqual(a.ui.bytes, [2]);
  assert.equal(a.ui.info, "File: /tmp/two.bin (1 bytes)");
});

test("choosing again while a read is pending drops the older read", async () => {
  const a = area();

  const first = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/one.bin");
  await drained();
  assert.equal(a.reads.pending(), 1, "the first gesture is waiting on its bytes");

  const second = a.choose();
  await drained();
  a.reads.take().resolve([1]);
  await drained();

  assert.equal(await outcome(first), "stale");
  assert.equal(a.ui.bytes, null, "nothing is installed while the newer gesture runs");
  assert.equal(a.ui.info, "");

  a.picks.take().resolve("/tmp/two.bin");
  await drained();
  a.reads.take().resolve([2, 2]);
  assert.equal(await outcome(second), "installed");
  assert.deepEqual(a.ui.bytes, [2, 2]);
});

test("a newer dialogue supersedes an older gesture even when it is cancelled", async () => {
  const a = area();

  const first = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/one.bin");
  await drained();

  // Asking for the dialogue is the gesture. Closing it without choosing says the
  // user did not want that file either - it does not hand the older gesture its
  // claim back.
  const second = a.choose();
  await drained();
  a.picks.take().resolve(null);
  a.reads.take().resolve([1]);
  await drained();

  assert.equal(await outcome(second), "cancelled");
  assert.equal(await outcome(first), "stale");
  assert.equal(a.ui.bytes, null);
  assert.equal(a.ui.info, "");
});

test("an example's sample target is not undone by a read the user overtook", async () => {
  const a = area();

  const pending = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/one.bin");
  await drained();

  a.openExample("/data/examples/basic-text-match/v1/targets/sample.txt", [9, 9, 9]);
  a.reads.take().resolve([1]);
  await drained();

  assert.equal(await outcome(pending), "stale");
  assert.deepEqual(a.ui.bytes, [9, 9, 9], "the example's target is the newer statement");
  assert.match(a.ui.info, /sample\.txt \(3 bytes\)$/);
});

test("typing wins over a pending read even with no file target installed", async () => {
  const a = area();

  const pending = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/one.bin");
  await drained();
  assert.equal(a.ui.bytes, null, "nothing is installed yet, so the textarea is live");

  a.type("bytes I typed instead");
  a.reads.take().resolve([1]);
  await drained();

  assert.equal(await outcome(pending), "stale");
  assert.equal(a.ui.bytes, null, "what they typed is still what a scan would see");
  assert.equal(a.ui.text, "bytes I typed instead");
  assert.equal(a.ui.disabled, false);
  assert.equal(a.ui.info, "");
});

test("a dialogue that will not open is reported and installs nothing", async () => {
  const a = area();

  const only = a.choose();
  await drained();
  a.picks.take().reject(new Error("no file dialogue available"));
  await drained();

  assert.equal(await outcome(only), "failed");
  assert.deepEqual(a.failures, ["Error: no file dialogue available"]);
  assert.deepEqual(a.reads.keys(), [], "a dialogue that failed chose no file to read");
  assert.equal(a.ui.bytes, null);
  assert.equal(a.ui.info, "");
});

test("a failure from a dialogue the user overtook is not reported", async () => {
  const a = area();

  // Two dialogues up at once, and the older one fails after the newer one has been
  // asked for. Whatever went wrong belongs to a gesture the user has already
  // replaced, so it is theirs to hear about only if they are still waiting on it.
  const first = a.choose();
  const second = a.choose();
  await drained();
  const one = a.picks.take();
  const two = a.picks.take();
  one.reject(new Error("no file dialogue available"));
  await drained();

  assert.equal(await outcome(first), "stale");
  assert.deepEqual(a.failures, [], "nothing is said about the gesture they left behind");
  assert.equal(a.ui.bytes, null);
  assert.equal(a.ui.info, "");

  // And the newer gesture is unaffected by its predecessor's failure.
  two.resolve("/tmp/two.bin");
  await drained();
  a.reads.take().resolve([2, 2]);
  assert.equal(await outcome(second), "installed");
  assert.deepEqual(a.ui.bytes, [2, 2]);
});

test("a failure from a read the user overtook is not reported", async () => {
  const a = area();

  const pending = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/gone.bin");
  await drained();
  a.type("mine");

  a.reads.take().reject(new Error("No such file or directory"));
  await drained();

  assert.equal(await outcome(pending), "stale");
  assert.deepEqual(a.failures, [], "the file it could not read is not the one being waited for");
  assert.equal(a.ui.text, "mine");
  assert.equal(a.ui.bytes, null);
});

test("a failure from the current read is reported and installs nothing", async () => {
  const a = area();

  const only = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/gone.bin");
  await drained();
  a.reads.take().reject(new Error("No such file or directory"));
  await drained();

  assert.equal(await outcome(only), "failed");
  assert.deepEqual(a.failures, ["Error: No such file or directory"]);
  assert.equal(a.ui.bytes, null);
  assert.equal(a.ui.info, "");
});

test("opening an ordinary folder leaves a target choice in flight alone", async () => {
  const a = area();

  const pending = a.choose();
  await drained();
  a.picks.take().resolve("/tmp/one.bin");
  await drained();

  // The scan target is not part of a project: opening a folder says nothing about
  // what to scan, so the file the user asked for still arrives.
  a.openFolder();
  a.reads.take().resolve([1]);
  await drained();

  assert.equal(await outcome(pending), "installed");
  assert.deepEqual(a.ui.bytes, [1]);
});
