// Tests for the app-owned mutation queue (mutations.ts).
//
// Run with `npm test`. Nothing here sleeps: each "write" is a promise the test
// settles, so "two mutations overlapped" is a thing the test can attempt rather than
// something it has to catch happening.

import { test } from "node:test";
import assert from "node:assert/strict";

import { MutationQueue } from "./mutations.ts";

// Lets everything that can proceed proceed.
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

// A mutation, as a command performs one: claim first, then await the turn, then act.
// `log` records what actually happened in the order it happened, which is the thing
// under test.
function mutation(queue, log, name, work) {
  const turn = queue.claim();
  return (async () => {
    await turn.ready;
    log.push(`start:${name}`);
    try {
      return await work();
    } finally {
      log.push(`end:${name}`);
      turn.done();
    }
  })();
}

test("mutations run one at a time, in the order they were claimed", async () => {
  const queue = new MutationQueue();
  const log = [];
  const writes = [deferred(), deferred(), deferred()];

  // All three asked for before any of them has written anything - which is what a
  // double-pressed accelerator, or Save followed by Compile, actually looks like.
  const all = [
    mutation(queue, log, "a", () => writes[0].promise),
    mutation(queue, log, "b", () => writes[1].promise),
    mutation(queue, log, "c", () => writes[2].promise),
  ];
  assert.equal(queue.outstanding(), 3);

  await drained();
  assert.deepEqual(log, ["start:a"], "and only the first is touching the disk");

  writes[0].resolve();
  await drained();
  assert.deepEqual(log, ["start:a", "end:a", "start:b"]);
  writes[1].resolve();
  await drained();
  writes[2].resolve();
  await Promise.all(all);

  assert.deepEqual(log, [
    "start:a",
    "end:a",
    "start:b",
    "end:b",
    "start:c",
    "end:c",
  ]);
  assert.equal(queue.outstanding(), 0);
});

test("the order is the order of the claims, not of the awaits before them", async () => {
  const queue = new MutationQueue();
  const log = [];
  // Two commands, each of which does some asynchronous preparation between claiming
  // its turn and writing. The second one's preparation finishes first; the queue is
  // what stops that deciding who writes first.
  const slow = deferred();
  const first = (async () => {
    const turn = queue.claim();
    await slow.promise;
    await turn.ready;
    log.push("first");
    turn.done();
  })();
  const second = (async () => {
    const turn = queue.claim();
    await turn.ready;
    log.push("second");
    turn.done();
  })();

  await drained();
  assert.deepEqual(log, [], "the second cannot go ahead: the first claimed before it");
  slow.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(log, ["first", "second"]);
});

test("a mutation that fails does not strand the ones behind it", async () => {
  const queue = new MutationQueue();
  const log = [];
  const failing = mutation(queue, log, "a", () => Promise.reject(new Error("disk full")));
  const following = mutation(queue, log, "b", () => Promise.resolve());

  await assert.rejects(failing, /disk full/);
  await following;
  // Losing the queue to one failed write would stop every later write for the
  // lifetime of the window, which is worse than the failure.
  assert.deepEqual(log, ["start:a", "end:a", "start:b", "end:b"]);
  assert.equal(queue.outstanding(), 0);
});

test("giving up a turn twice releases only one mutation", async () => {
  const queue = new MutationQueue();
  const log = [];
  const one = queue.claim();
  const two = queue.claim();
  const three = queue.claim();

  one.done();
  one.done();
  await drained();
  await two.ready;
  log.push("two");
  // If the repeated release had advanced the queue, this third turn would already be
  // runnable beside the second.
  let started = false;
  void three.ready.then(() => {
    started = true;
  });
  await drained();
  assert.equal(started, false);
  assert.equal(queue.outstanding(), 2, "and the count is not double-decremented");

  two.done();
  await three.ready;
  assert.equal(started, true);
  three.done();
  assert.equal(queue.outstanding(), 0);
});

test("a queue nobody is using hands out its turn immediately", async () => {
  const queue = new MutationQueue();
  const turn = queue.claim();
  await turn.ready;
  assert.equal(queue.outstanding(), 1, "held until it is given up");
  turn.done();
  assert.equal(queue.outstanding(), 0);

  // And it is reusable afterwards: the chain is not left resolved-once.
  const next = queue.claim();
  await next.ready;
  next.done();
  assert.equal(queue.outstanding(), 0);
});
