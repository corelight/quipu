// Opt-in frontend half of `quipu --debug` tracing.
//
// The bundle starts before it can ask the backend whether this process was
// launched with `--debug`, so startup records wait in a small bounded buffer.
// Confirmation either flushes that buffer to the Web Inspector console with the
// backend's trace ID, or drops it and makes every later call a true no-op. Nothing
// is printed while tracing is absent or still unconfirmed.

const SCHEMA = "quipu-debug-v1";
const DEFAULT_BUFFER_CAPACITY = 512;
const DEFAULT_MIRROR_CAPACITY = 128;

type TraceFields = Record<string, unknown>;
type PendingRecord = {
  sequence: number;
  elapsedMs: number;
  event: string;
  fields: TraceFields;
};
type MirroredRecord = {
  line: string;
  dropSummary?: number;
};

export type BackendDebugStatus = {
  enabled: boolean;
  traceId: string | null;
};

export class FrontendTrace {
  private readonly sink: (line: string) => void;
  private readonly now: () => number;
  private readonly capacity: number;
  private mode: "pending" | "enabled" | "disabled" = "pending";
  private readonly started: number;
  private sequence = 0;
  private traceId = "";
  private pending: PendingRecord[] = [];
  private dropped = 0;
  private mirror: ((line: string) => void | Promise<void>) | null = null;
  private readonly mirrorCapacity: number;
  private mirrorQueue: MirroredRecord[] = [];
  private mirrorRunning = false;
  private mirrorDropped = 0;
  private documentSerial = 0;
  private documents = new Map<string, number>();

  constructor(
    sink: (line: string) => void = (line) => console.debug(line),
    now: () => number = () => performance.now(),
    capacity = DEFAULT_BUFFER_CAPACITY,
    mirrorCapacity = DEFAULT_MIRROR_CAPACITY,
  ) {
    this.sink = sink;
    this.now = now;
    this.capacity = capacity;
    this.mirrorCapacity = Math.max(1, mirrorCapacity);
    this.started = this.now();
  }

  configure(status: BackendDebugStatus): void {
    if (!status.enabled || status.traceId === null || status.traceId.length === 0) {
      this.mode = "disabled";
      this.pending = [];
      this.documents.clear();
      this.mirror = null;
      this.mirrorQueue = [];
      this.mirrorDropped = 0;
      return;
    }
    this.traceId = status.traceId;
    this.mode = "enabled";
    const pending = this.pending;
    this.pending = [];
    for (const record of pending) this.write(record);
    if (this.dropped > 0) {
      this.event("trace_buffer_dropped", { count: this.dropped });
      this.dropped = 0;
    }
  }

  disable(): void {
    this.configure({ enabled: false, traceId: null });
  }

  isEnabled(): boolean {
    return this.mode === "enabled";
  }

  setMirror(mirror: ((line: string) => void | Promise<void>) | null): void {
    this.mirror = mirror;
    if (mirror === null) {
      this.mirrorQueue = [];
      this.mirrorDropped = 0;
    }
  }

  event(event: string, fields: TraceFields = {}): void {
    if (this.mode === "disabled") return;
    const record = this.record(event, fields);
    if (this.mode === "enabled") {
      this.write(record);
      return;
    }
    if (this.capacity <= 0) {
      this.dropped += 1;
      return;
    }
    if (this.pending.length === this.capacity) {
      this.pending.shift();
      this.dropped += 1;
    }
    this.pending.push(record);
  }

  // Document URIs contain unrestricted absolute paths. Assign an opaque identity
  // once and log only that number at every LSP edge.
  documentId(uri: string): number | null {
    if (this.mode !== "enabled") return null;
    const existing = this.documents.get(uri);
    if (existing !== undefined) return existing;
    this.documentSerial += 1;
    this.documents.set(uri, this.documentSerial);
    return this.documentSerial;
  }

  forgetDocument(uri: string): number | null {
    if (this.mode !== "enabled") return null;
    const id = this.documents.get(uri) ?? null;
    this.documents.delete(uri);
    return id;
  }

  private write(record: PendingRecord): void {
    const line = this.line(record);
    try {
      this.sink(line);
    } catch {
      // Troubleshooting must not become control flow.
    }
    this.enqueueMirror(line);
  }

  private record(event: string, fields: TraceFields): PendingRecord {
    return {
      sequence: ++this.sequence,
      elapsedMs: Math.max(0, Math.round(this.now() - this.started)),
      event,
      fields: sanitizeFields(fields),
    };
  }

  private line(record: PendingRecord): string {
    return JSON.stringify({
      schema: SCHEMA,
      layer: "frontend",
      traceId: this.traceId,
      sequence: record.sequence,
      elapsedMs: record.elapsedMs,
      event: record.event,
      fields: record.fields,
    });
  }

  private enqueueMirror(line: string): void {
    if (this.mirror === null) return;
    if (this.mirrorQueue.length >= this.mirrorCapacity) {
      this.noteMirrorDrop(1);
      return;
    }
    this.mirrorQueue.push({ line });
    this.pumpMirror();
  }

  private pumpMirror(): void {
    if (this.mirrorRunning || this.mirror === null) return;
    const record = this.mirrorQueue.shift();
    if (record === undefined) return;
    // Dequeuing a retained data record makes room for one loss summary. Never
    // enqueue a summary behind another summary: a rejecting or overloaded sink
    // must still make progress through real records when it resumes.
    if (record.dropSummary === undefined) this.enqueueMirrorDropSummary();
    const mirror = this.mirror;
    let dataRejected = false;
    this.mirrorRunning = true;
    void Promise.resolve()
      .then(() => mirror(record.line))
      .catch(() => {
        // IPC rejection is trace loss, never application control flow. Restore
        // a rejected summary's represented count rather than counting only the
        // summary line itself.
        if (this.mirror !== null) {
          this.noteMirrorDrop(record.dropSummary ?? 1);
          dataRejected = record.dropSummary === undefined;
        }
      })
      .finally(() => {
        this.mirrorRunning = false;
        // A rejected final data record has no later dequeue to expose its loss.
        // Give it one summary attempt now. A rejected summary deliberately does
        // not schedule itself again; its restored count waits for later data.
        if (dataRejected) this.enqueueMirrorDropSummary();
        this.pumpMirror();
      });
  }

  private enqueueMirrorDropSummary(): void {
    if (
      this.mirror === null ||
      this.mirrorDropped === 0 ||
      this.mirrorQueue.length >= this.mirrorCapacity
    ) {
      return;
    }
    const count = this.mirrorDropped;
    this.mirrorDropped = 0;
    const line = this.line(this.record("trace_records_dropped", { count }));
    try {
      this.sink(line);
    } catch {
      // The stdout mirror remains independent of the Inspector sink.
    }
    this.mirrorQueue.push({ line, dropSummary: count });
  }

  private noteMirrorDrop(count: number): void {
    this.mirrorDropped = Math.min(Number.MAX_SAFE_INTEGER, this.mirrorDropped + count);
  }
}

export function redactedException(error: unknown): TraceFields {
  if (error instanceof Error) {
    const frames = (error.stack ?? "")
      .split("\n")
      .slice(1)
      .join("\n");
    return {
      name: error.name,
      summary: "exception",
      stack: frames.length === 0 ? null : redactPaths(frames),
    };
  }
  return { name: "NonError", summary: "exception", stack: null };
}

// Preserve useful function/module/line information while removing Unix, Windows
// and file-URL paths. Callers never pass source or diagnostic text here.
function redactPaths(text: string): string {
  return text
    .replace(/file:\/\/\/[^\s)]+/g, "<redacted-path>")
    .replace(/(?:^|[\s(])\/(?:[^\s/:)]+\/)*[^\s/:)]+/gm, (match) =>
      `${match[0] === "/" ? "" : match[0]}<redacted-path>`,
    )
    .replace(/[A-Za-z]:\\(?:[^\s\\:)]+\\)*[^\s\\:)]+/g, "<redacted-path>");
}

function sanitizeFields(fields: TraceFields): TraceFields {
  return sanitizeValue(fields, "") as TraceFields;
}

function sanitizeValue(value: unknown, key: string): unknown {
  if (sensitiveKey(key)) return "<redacted>";
  if (typeof value === "string") return redactPaths(value).slice(0, 4096);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, ""));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        sanitizeValue(child, childKey),
      ]),
    );
  }
  return value;
}

function sensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === "root" ||
    lower === "path" ||
    lower.endsWith("path") ||
    lower === "file" ||
    lower.endsWith("file") ||
    lower === "title" ||
    lower === "message" ||
    lower === "text" ||
    lower.endsWith("text") ||
    lower === "content" ||
    lower === "source" ||
    lower === "diagnostic" ||
    lower === "diagnostics" ||
    lower === "target" ||
    lower === "bytes"
  );
}

export const trace = new FrontendTrace();
