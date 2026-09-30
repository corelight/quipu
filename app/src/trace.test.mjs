import assert from "node:assert/strict";
import test from "node:test";

import { FrontendTrace, redactedException } from "./trace.ts";

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

test("debug disabled emits nothing, including buffered startup records", () => {
  const lines = [];
  const trace = new FrontendTrace((line) => lines.push(line), () => 10);
  trace.event("frontend_start", { count: 1 });
  trace.configure({ enabled: false, traceId: null });
  trace.event("later", { count: 2 });
  assert.deepEqual(lines, []);
});

test("disabled and pending tracing never retain document URIs", () => {
  const trace = new FrontendTrace(() => {}, () => 0);
  const secret = "file:///home/person/private/project/secret-rule.yar";
  assert.equal(trace.documentId(secret), null);
  assert.equal(trace.forgetDocument(secret), null);
  assert.equal(trace.documents.size, 0);

  trace.configure({ enabled: true, traceId: "documents" });
  assert.equal(trace.documentId(secret), 1);
  assert.equal(trace.documents.size, 1);
  assert.equal(trace.forgetDocument("file:///not/open.yar"), null, "forget does not allocate");
  assert.equal(trace.documents.size, 1);
  trace.disable();
  assert.equal(trace.documents.size, 0);
  assert.equal(trace.documentId(secret), null);
  assert.equal(trace.documents.size, 0);
});

test("debug enabled flushes correlated JSON records in monotonic order", () => {
  const lines = [];
  let now = 100;
  const trace = new FrontendTrace((line) => lines.push(line), () => now);
  trace.event("startup", { selection: 0 });
  now = 112;
  trace.configure({ enabled: true, traceId: "backend-session" });
  trace.event("ready", { selection: 1 });

  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((record) => [record.layer, record.traceId, record.sequence, record.event]),
    [
      ["frontend", "backend-session", 1, "startup"],
      ["frontend", "backend-session", 2, "ready"],
    ],
  );
  assert.equal(records[1].elapsedMs, 12);
});

test("the pre-enable buffer is bounded and reports dropped records", () => {
  const lines = [];
  const trace = new FrontendTrace((line) => lines.push(line), () => 0, 2);
  trace.event("one");
  trace.event("two");
  trace.event("three");
  trace.configure({ enabled: true, traceId: "bounded" });
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.event), ["two", "three", "trace_buffer_dropped"]);
  assert.equal(records[2].fields.count, 1);
});

test("document identities and exception stacks do not expose absolute paths", () => {
  const lines = [];
  const trace = new FrontendTrace((line) => lines.push(line), () => 0);
  trace.configure({ enabled: true, traceId: "redacted" });
  const uri = "file:///home/person/private/project/secret-rule.yar";
  trace.event("lsp_document_open", { document: trace.documentId(uri) });
  trace.event(
    "exception",
    redactedException(
      new Error("failed at /home/person/private/project/secret-rule.yar: diagnostic title"),
    ),
  );

  const output = lines.join("\n");
  assert.doesNotMatch(output, /secret-rule|diagnostic title|\/home\/person|file:\/\//);
  assert.match(output, /<redacted-path>/);
});

test("the optional stdout mirror receives the same Inspector record", async () => {
  const consoleLines = [];
  const mirrored = [];
  const trace = new FrontendTrace((line) => consoleLines.push(line), () => 0);
  trace.setMirror((line) => mirrored.push(line));
  trace.configure({ enabled: true, traceId: "mirror" });
  trace.event("edge", { count: 1 });
  await drained();
  assert.deepEqual(mirrored, consoleLines);
});

test("a stalled or rejected mirror reports every bounded-backlog loss", async () => {
  const consoleLines = [];
  const first = deferred();
  const mirrored = [];
  const trace = new FrontendTrace(
    (line) => consoleLines.push(line),
    () => 0,
    16,
    2,
  );
  trace.setMirror((line) => {
    mirrored.push(line);
    if (mirrored.length === 1) return first.promise;
    if (mirrored.length === 2) return Promise.reject(new Error("IPC unavailable"));
  });
  trace.configure({ enabled: true, traceId: "mirror-bounded" });

  for (let i = 0; i < 20; i += 1) trace.event("edge", { count: i });
  assert.equal(consoleLines.length, 20, "Inspector production never waits for IPC");
  await drained();
  assert.equal(mirrored.length, 1, "one mirror call is in flight while its sink is blocked");
  assert.ok(trace.mirrorQueue.length <= 2, "the retained mirror queue is fixed-capacity");

  first.resolve();
  await drained();
  await drained();
  const records = mirrored.map((line) => JSON.parse(line));
  const data = records.filter((record) => record.event === "edge");
  const losses = records.filter((record) => record.event === "trace_records_dropped");
  assert.equal(data.length, 3, "one active and two retained data records were attempted");
  assert.equal(
    losses.reduce((count, record) => count + record.fields.count, 0),
    18,
    "17 overflowed records and one rejected IPC record were reported",
  );
  assert.ok(
    consoleLines.some((line) => JSON.parse(line).event === "trace_records_dropped"),
    "the Inspector also exposes stdout mirror loss",
  );
  assert.equal(trace.mirrorQueue.length, 0, "the bounded queue drained after output resumed");
  assert.equal(trace.mirrorRunning, false, "rejection was contained and the pump settled");
});

test("a final data rejection attempts one summary without looping on summary rejection", async () => {
  const attempted = [];
  let rejecting = true;
  const trace = new FrontendTrace(() => {}, () => 0, 16, 2);
  trace.setMirror((line) => {
    attempted.push(JSON.parse(line));
    return rejecting ? Promise.reject(new Error("IPC unavailable")) : undefined;
  });
  trace.configure({ enabled: true, traceId: "terminal-rejection" });

  trace.event("edge", { count: 1 });
  await drained();
  await drained();
  assert.deepEqual(
    attempted.map((record) => record.event),
    ["edge", "trace_records_dropped"],
    "the terminal data rejection received exactly one summary attempt",
  );
  assert.equal(attempted[1].fields.count, 1);
  assert.equal(trace.mirrorDropped, 1, "a rejected summary preserves its represented loss");
  assert.equal(trace.mirrorQueue.length, 0);
  assert.equal(trace.mirrorRunning, false, "summary rejection did not immediately retry itself");

  rejecting = false;
  trace.event("recovery", {});
  await drained();
  await drained();
  assert.deepEqual(
    attempted.slice(2).map((record) => record.event),
    ["recovery", "trace_records_dropped"],
    "later successful data gives the preserved summary one new attempt",
  );
  assert.equal(trace.mirrorDropped, 0);
});

test("the trace boundary redacts path, source, target and diagnostic fields", () => {
  const lines = [];
  const trace = new FrontendTrace((line) => lines.push(line), () => 0);
  trace.configure({ enabled: true, traceId: "safe" });
  trace.event("adversarial", {
    path: "/private/source.yar",
    sourceText: "rule SECRET_SOURCE { condition: true }",
    target: [83, 69, 67, 82, 69, 84],
    diagnostic: {
      title: "SECRET_DIAGNOSTIC_TITLE",
      message: "SECRET_DIAGNOSTIC_MESSAGE",
      file: "/private/external.yar",
    },
    ruleCount: 9,
  });
  const output = lines[0];
  assert.doesNotMatch(output, /private|SECRET|83,69|source\.yar|external\.yar/);
  assert.match(output, /"ruleCount":9/);
});
