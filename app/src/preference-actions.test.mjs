import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authorizeAllCachesClear,
  authorizeCurrentCacheClear,
  runPreferenceClear,
} from "./preference-actions.ts";

test("cancelling either native clear confirmation authorizes no command", async () => {
  assert.equal(await authorizeCurrentCacheClear("/project", async () => false), null);
  assert.equal(await authorizeAllCachesClear(async () => false), false);
});

test("Clear Current retains the project root named before its confirmation await", async () => {
  let current = "/old";
  const captured = current;
  const answer = authorizeCurrentCacheClear(captured, async () => {
    current = "/new";
    return true;
  });

  assert.equal(await answer, "/old");
  assert.equal(current, "/new");
});

test("without a project Clear Current does not even ask", async () => {
  let asked = 0;
  const root = await authorizeCurrentCacheClear(null, async () => {
    asked += 1;
    return true;
  });
  assert.equal(root, null);
  assert.equal(asked, 0);
});

test("an old clear failure cannot repaint a reopened Preferences dialog", async () => {
  let rejectClear;
  let current = true;
  const events = [];
  const pending = runPreferenceClear({
    isCurrent: () => current,
    isOpen: () => true,
    clear: () => new Promise((_, reject) => (rejectClear = reject)),
    setBusy: (busy) => events.push(["busy", busy]),
    clearError: () => events.push(["clear-error"]),
    showError: (error) => events.push(["error", String(error)]),
    refresh: () => events.push(["refresh"]),
  });
  assert.deepEqual(events, [["clear-error"], ["busy", true]]);

  current = false;
  rejectClear(new Error("old failure"));
  await pending;

  assert.deepEqual(events, [["clear-error"], ["busy", true]]);
});

test("a successful old clear refreshes status with new request ownership", async () => {
  let finishClear;
  let current = true;
  const events = [];
  const pending = runPreferenceClear({
    isCurrent: () => current,
    isOpen: () => true,
    clear: () => new Promise((resolve) => (finishClear = resolve)),
    setBusy: (busy) => events.push(["busy", busy]),
    clearError: () => events.push(["clear-error"]),
    showError: (error) => events.push(["error", String(error)]),
    refresh: () => events.push(["refresh"]),
  });
  current = false;
  finishClear();
  await pending;

  assert.deepEqual(events, [["clear-error"], ["busy", true], ["refresh"]]);
});
