import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cacheClearControls,
  formatBytes,
  parseMaximumBytes,
} from "./preference-values.ts";

test("cache usage uses binary units without hiding exact small values", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(313), "313 B");
  assert.equal(formatBytes(1024), "1 KiB");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(1024 ** 3), "1 GiB");
});

test("maximum size accepts only whole binary MiB from 1 MiB through 1 TiB", () => {
  assert.deepEqual(parseMaximumBytes("1"), { ok: true, bytes: 1024 ** 2 });
  assert.deepEqual(parseMaximumBytes("1048576"), { ok: true, bytes: 1024 ** 4 });
  for (const value of ["0", "0.5", "1.5", "1e3", "-1", "1048577", ""])
    assert.equal(parseMaximumBytes(value).ok, false, value);
});

test("Clear Current needs a current live entry; Clear All needs any managed usage", () => {
  const cached = { available: true, totalBytes: 100, currentProjectCached: true };
  assert.deepEqual(cacheClearControls(cached, "/project"), {
    clearCurrent: true,
    clearAll: true,
  });
  assert.deepEqual(cacheClearControls(cached, null), {
    clearCurrent: false,
    clearAll: true,
  });
  assert.deepEqual(
    cacheClearControls({ available: false, totalBytes: 100, currentProjectCached: true }, "/p"),
    { clearCurrent: false, clearAll: false },
  );
  assert.deepEqual(
    cacheClearControls({ available: true, totalBytes: 0, currentProjectCached: false }, "/p"),
    { clearCurrent: false, clearAll: false },
  );
});
