// Executable frontend restoration/view ownership table. Backend RuleStore
// generation tests independently prove installation authority.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Operations } from "./operations.ts";
import { ProjectSession } from "./project.ts";
import {
  decideRestoration,
  decideRestorationFailure,
  invalidationRequiresReset,
} from "./restoring.ts";

const diagnostic = {
  severity: "warning",
  code: "fixture",
  title: "kept exactly",
  line: 7,
  column: 3,
  span: { start: 10, end: 12 },
  file: "/not-logged/by-the-trace.yar",
};
const hit = { status: "hit", ruleCount: 3, diagnostics: [diagnostic] };
const restoration = { kind: "restoration", selection: 1, serial: 4, revision: 2 };

function authority(overrides = {}) {
  return {
    selectionIsCurrent: true,
    operationIsCurrent: true,
    buildState: "restoring",
    buildOwner: restoration,
    ...overrides,
  };
}

function loaded(root = "/project") {
  const id = { external: false, path: "main.yar" };
  return {
    status: "loaded",
    root,
    manifest: null,
    entrypointOrigin: "inferred",
    entrypoints: [id],
    discovered: [id],
    nodes: [{ id, readable: true }],
    edges: [],
    issues: [],
    compilable: true,
  };
}

test("restoring invalidation requires the same backend reset as compiled rules", () => {
  assert.equal(invalidationRequiresReset("restoring"), true);
  assert.equal(invalidationRequiresReset("compiling"), true);
  assert.equal(invalidationRequiresReset("compiled"), true);
  assert.equal(invalidationRequiresReset("not-compiled"), false);
  assert.equal(invalidationRequiresReset("stale"), false);
});

test("an ordinary current hit restores exact diagnostics and rule count", () => {
  const decision = decideRestoration(hit, restoration, authority());
  assert.deepEqual(decision, {
    kind: "compiled",
    ruleCount: 3,
    diagnostics: [diagnostic],
    reason: "hit",
  });
  assert.equal(decision.diagnostics[0], diagnostic, "attribution is not copied or rewritten");
});

test("ordinary miss-like statuses settle not compiled", () => {
  for (const status of ["disabled", "miss", "unavailable"]) {
    assert.deepEqual(decideRestoration({ status }, restoration, authority()), {
      kind: "not-compiled",
      reason: status,
    });
  }
});

test("catch-up B can own the view while restoring A's hit still settles", () => {
  const session = new ProjectSession();
  const selection = session.open("/project");
  const a = session.beginAnalysis(selection, true);
  const b = session.beginAnalysis(selection, false);
  assert.equal(session.accept(b, loaded(), false), true);
  assert.equal(session.accept(a, loaded(), false), false, "A lost only view order");

  const owner = { ...restoration, selection: selection.serial };
  assert.equal(
    decideRestoration(hit, owner, authority({ buildOwner: owner })).kind,
    "compiled",
    "view rejection does not consume restoration authority",
  );
});

test("the same catch-up interleaving with a miss settles not compiled", () => {
  const session = new ProjectSession();
  const selection = session.open("/project");
  const a = session.beginAnalysis(selection, true);
  const b = session.beginAnalysis(selection, false);
  session.accept(b, loaded(), false);
  assert.equal(session.accept(a, loaded(), false), false);
  const owner = { ...restoration, selection: selection.serial };
  assert.deepEqual(
    decideRestoration({ status: "miss" }, owner, authority({ buildOwner: owner })),
    { kind: "not-compiled", reason: "miss" },
  );
});

test("a Changed event overtaking A leaves its invalidation owner stale", async () => {
  let resets = 0;
  const operations = new Operations(async () => {
    resets += 1;
  });
  const restore = operations.begin("/project");
  operations.invalidate();
  await operations.requestReset();
  assert.equal(operations.isCurrent(restore, "/project"), false);
  assert.deepEqual(
    decideRestoration(hit, restoration, authority({
      operationIsCurrent: false,
      buildState: "stale",
      buildOwner: { kind: "invalidation", revision: 3 },
    })),
    { kind: "unchanged", reason: "newer-build-owner" },
  );
  assert.equal(resets, 1);
});

test("manual Refresh overtaking A has the same explicit stale owner", () => {
  assert.deepEqual(
    decideRestoration(hit, restoration, authority({
      operationIsCurrent: false,
      buildState: "stale",
      buildOwner: { kind: "invalidation", revision: 9 },
    })),
    { kind: "unchanged", reason: "newer-build-owner" },
  );
});

test("a newer Compile is the sole owner and an old hit cannot overwrite it", () => {
  assert.deepEqual(
    decideRestoration(hit, restoration, authority({
      operationIsCurrent: false,
      buildState: "compiling",
      buildOwner: { kind: "compile", serial: 5, revision: 2 },
    })),
    { kind: "unchanged", reason: "newer-build-owner" },
  );
});

test("project switch and close make the old response inert", () => {
  for (const buildState of ["restoring", "not-compiled"]) {
    assert.deepEqual(
      decideRestoration(hit, restoration, authority({
        selectionIsCurrent: false,
        operationIsCurrent: false,
        buildState,
        buildOwner: { kind: "none" },
      })),
      { kind: "unchanged", reason: "selection-superseded" },
    );
  }
});

test("backend superseded without a correlated frontend producer cannot strand restoring", () => {
  assert.deepEqual(decideRestoration({ status: "superseded" }, restoration, authority()), {
    kind: "not-compiled",
    reason: "orphaned-superseded",
  });
  assert.deepEqual(
    decideRestoration({ status: "superseded" }, restoration, authority({
      buildOwner: { kind: "none" },
    })),
    { kind: "not-compiled", reason: "orphaned-superseded" },
  );
});

test("backend superseded by a real newer compile remains inert", () => {
  assert.deepEqual(
    decideRestoration({ status: "superseded" }, restoration, authority({
      operationIsCurrent: false,
      buildState: "compiled",
      buildOwner: { kind: "compile", serial: 5, revision: 2 },
    })),
    { kind: "unchanged", reason: "newer-build-owner" },
  );
});

test("an application exception after acceptance still retires the live restoration", () => {
  const session = new ProjectSession();
  const selection = session.open("/project");
  const req = session.beginAnalysis(selection, true);
  const owner = { ...restoration, selection: selection.serial };
  assert.equal(session.accept(req, loaded(), false), true);
  assert.equal(session.failAnalysis(req, new Error("apply failed")), false);
  assert.deepEqual(
    decideRestorationFailure(owner, authority({ buildOwner: owner })),
    { kind: "not-compiled", reason: "orphaned-superseded" },
  );
});

test("not-requested is terminal when a live restoration unexpectedly receives it", () => {
  assert.deepEqual(decideRestoration({ status: "notRequested" }, restoration, authority()), {
    kind: "not-compiled",
    reason: "not-requested",
  });
});

test("duplicate open retires the old selection and gives the new restoration its own identity", () => {
  const session = new ProjectSession();
  const first = session.open("/project");
  const old = { ...restoration, selection: first.serial };
  const second = session.open("/project");
  assert.notEqual(first.serial, second.serial);
  assert.deepEqual(
    decideRestoration(hit, old, authority({ selectionIsCurrent: false })),
    { kind: "unchanged", reason: "selection-superseded" },
  );
  const current = { ...old, selection: second.serial, serial: old.serial + 1 };
  assert.equal(
    decideRestoration(hit, current, authority({ buildOwner: current })).kind,
    "compiled",
  );
});
