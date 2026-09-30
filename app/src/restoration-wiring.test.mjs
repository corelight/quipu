import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const backendLib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const run = main.slice(main.indexOf("async function runAnalysis("), main.indexOf("function hasUnsavedIn("));

test("runAnalysis consumes restoration before an older view response returns", () => {
  const accepted = run.indexOf("const accepted = session.accept(");
  const restoration = run.indexOf("if (restoration !== null)", accepted);
  const rejectedView = run.indexOf("if (!accepted)", accepted);
  assert.ok(accepted >= 0 && restoration > accepted && rejectedView > restoration, {
    accepted,
    restoration,
    rejectedView,
  });
  assert.match(run.slice(restoration, rejectedView), /decideRestoration\(/);
});

test("response-application exceptions settle restoration before failAnalysis can reject the order", () => {
  const caught = run.indexOf("} catch (err) {");
  const settle = run.indexOf("settleRestorationAfterException(req, restoration)", caught);
  const fail = run.indexOf("session.failAnalysis(req, err)", caught);
  assert.ok(caught >= 0 && settle > caught && fail > settle, { caught, settle, fail });
});

test("selection presentation is owned by an accepted snapshot, not request A only", () => {
  assert.match(run, /session\.beginInitialPresentation\(req\)/);
  assert.match(run, /session\.finishInitialPresentation\(presentationAttempt/);
  assert.doesNotMatch(run, /if \(req\.initial\)/);
  assert.doesNotMatch(run, /req\.initial\s*&&\s*session\.beginInitialPresentation/);
});

test("the trace retains the edge that discriminates the original orphan", () => {
  assert.match(run, /trace\.event\("analysis_accept"/);
  assert.match(run, /trace\.event\("restoration_decision"/);
  assert.match(run, /viewAccepted: accepted/);
  assert.match(run, /view_response_superseded_after_restoration/);
});

test("the Web Inspector is opened only behind the exact backend debug decision", () => {
  const guard = backendLib.indexOf("if setup_trace.is_enabled()");
  const open = backendLib.indexOf("window.open_devtools()", guard);
  const end = backendLib.indexOf("\n            }\n            Ok(())", open);
  assert.ok(guard >= 0 && open > guard && end > open, { guard, open, end });
  assert.equal(backendLib.indexOf("window.open_devtools()"), open, "there is no unguarded second site");
});
