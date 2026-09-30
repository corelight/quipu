//! Opt-in, copy/paste-friendly troubleshooting trace.
//!
//! `--debug` is deliberately the only switch. Without it this type contains no
//! sink and [`DebugTrace::event`] returns before constructing a record. With it,
//! records are JSON Lines written directly to stdout and flushed on every line so
//! a hung process still leaves its last transition behind.
//!
//! Callers try to enqueue value-only records on a fixed-capacity channel. A
//! dedicated writer assigns sequence numbers and invokes the sink, so logging
//! cannot acquire a trace lock, wait for stdout, or invoke an application callback
//! while an application lock is held. When the queue fills, producers count drops;
//! the writer reports the count after the blocked sink resumes.

use std::ffi::OsString;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[cfg(test)]
use std::time::Duration;

use serde::{Deserialize, Serialize};

const SCHEMA: &str = "quipu-debug-v1";
const TRACE_QUEUE_CAPACITY: usize = 1024;
const MAX_FRONTEND_LINE_BYTES: usize = 64 * 1024;
const MAX_TRACE_ID_BYTES: usize = 128;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone)]
pub(crate) struct DebugTrace {
    enabled: Option<Arc<Enabled>>,
}

struct Enabled {
    started: Instant,
    trace_id: String,
    sender: mpsc::SyncSender<Queued>,
    dropped: Arc<AtomicU64>,
}

enum Queued {
    Event {
        elapsed_ms: u128,
        event: String,
        fields: serde_json::Value,
    },
    Frontend(String),
    #[cfg(test)]
    Flush(mpsc::Sender<()>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DebugStatus {
    pub enabled: bool,
    pub trace_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record<'a, T> {
    schema: &'static str,
    layer: &'static str,
    trace_id: &'a str,
    sequence: u64,
    elapsed_ms: u128,
    event: &'a str,
    fields: T,
}

impl DebugTrace {
    pub(crate) fn from_process_args() -> Self {
        Self::from_args(std::env::args_os())
    }

    fn from_args(args: impl IntoIterator<Item = OsString>) -> Self {
        if !args.into_iter().any(|arg| arg == "--debug") {
            return Self::disabled();
        }
        Self::with_sink(new_trace_id(), |line| {
            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            let _ = writeln!(stdout, "{line}");
            let _ = stdout.flush();
        })
    }

    pub(crate) fn disabled() -> Self {
        Self { enabled: None }
    }

    fn with_sink(trace_id: String, sink: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self::with_sink_and_capacity(trace_id, TRACE_QUEUE_CAPACITY, sink)
    }

    fn with_sink_and_capacity(
        trace_id: String,
        capacity: usize,
        sink: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        let started = Instant::now();
        let worker_started = started;
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let dropped = Arc::new(AtomicU64::new(0));
        let worker_dropped = Arc::clone(&dropped);
        let worker_trace_id = trace_id.clone();
        std::thread::Builder::new()
            .name("quipu-debug-trace".into())
            .spawn(move || {
                let mut sequence = 0_u64;
                while let Ok(queued) = receiver.recv() {
                    match queued {
                        Queued::Event {
                            elapsed_ms,
                            event,
                            fields,
                        } => {
                            sequence = sequence.saturating_add(1);
                            let record = Record {
                                schema: SCHEMA,
                                layer: "backend",
                                trace_id: &worker_trace_id,
                                sequence,
                                elapsed_ms,
                                event: &event,
                                fields,
                            };
                            write_record(&sink, &record);
                            write_dropped_records(
                                &sink,
                                &worker_trace_id,
                                &mut sequence,
                                &worker_dropped,
                                worker_started.elapsed().as_millis(),
                            );
                        }
                        Queued::Frontend(line) => {
                            sink(&line);
                            write_dropped_records(
                                &sink,
                                &worker_trace_id,
                                &mut sequence,
                                &worker_dropped,
                                worker_started.elapsed().as_millis(),
                            );
                        }
                        #[cfg(test)]
                        Queued::Flush(done) => {
                            let _ = done.send(());
                        }
                    }
                }
            })
            .expect("debug trace writer thread");
        Self {
            enabled: Some(Arc::new(Enabled {
                started,
                trace_id,
                sender,
                dropped,
            })),
        }
    }

    #[cfg(test)]
    pub(crate) fn captured() -> (Self, Arc<std::sync::Mutex<Vec<String>>>) {
        let lines = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = Arc::clone(&lines);
        let trace = Self::with_sink("test-trace-id".into(), move |line| {
            captured
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(line.to_string());
        });
        (trace, lines)
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled.is_some()
    }

    pub(crate) fn status(&self) -> DebugStatus {
        DebugStatus {
            enabled: self.is_enabled(),
            trace_id: self
                .enabled
                .as_ref()
                .map(|enabled| enabled.trace_id.clone()),
        }
    }

    /// Emits one record. `fields` must already be redacted: this boundary never
    /// receives source text, diagnostic bodies, paths or target bytes.
    pub(crate) fn event<T: Serialize>(&self, event: &str, fields: T) {
        self.event_lazy(event, || fields);
    }

    /// Emits one record, constructing trace-only fields only when tracing is on.
    pub(crate) fn event_lazy<T: Serialize>(&self, event: &str, fields: impl FnOnce() -> T) {
        let Some(enabled) = &self.enabled else {
            return;
        };
        let mut fields = serde_json::to_value(fields()).unwrap_or(serde_json::Value::Null);
        redact_trace_value(&mut fields, None);
        enqueue(
            enabled,
            Queued::Event {
                elapsed_ms: enabled.started.elapsed().as_millis(),
                event: event.to_string(),
                fields,
            },
        );
    }

    fn frontend_line(&self, line: String) {
        let Some(enabled) = &self.enabled else {
            return;
        };
        enqueue(enabled, Queued::Frontend(line));
    }

    #[cfg(test)]
    pub(crate) fn flush(&self) -> bool {
        let Some(enabled) = &self.enabled else {
            return true;
        };
        let (done, wait) = mpsc::channel();
        if enabled.sender.try_send(Queued::Flush(done)).is_err() {
            return false;
        }
        wait.recv_timeout(Duration::from_millis(250)).is_ok()
    }
}

fn enqueue(enabled: &Enabled, queued: Queued) {
    match enabled.sender.try_send(queued) {
        Ok(()) | Err(mpsc::TrySendError::Disconnected(_)) => {}
        Err(mpsc::TrySendError::Full(_)) => {
            enabled.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn write_record<T: Serialize>(sink: &impl Fn(&str), record: &T) {
    if let Ok(line) = serde_json::to_string(record) {
        sink(&line);
    }
}

fn write_dropped_records(
    sink: &impl Fn(&str),
    trace_id: &str,
    sequence: &mut u64,
    dropped: &AtomicU64,
    elapsed_ms: u128,
) {
    let count = dropped.swap(0, Ordering::AcqRel);
    if count == 0 {
        return;
    }
    *sequence = sequence.saturating_add(1);
    let record = Record {
        schema: SCHEMA,
        layer: "backend",
        trace_id,
        sequence: *sequence,
        elapsed_ms,
        event: "trace_records_dropped",
        fields: serde_json::json!({ "count": count }),
    };
    write_record(sink, &record);
}

fn new_trace_id() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let digest = blake3::hash(format!("{}:{nanos}", std::process::id()).as_bytes());
        bytes.copy_from_slice(&digest.as_bytes()[..16]);
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn redact_trace_value(value: &mut serde_json::Value, key: Option<&str>) {
    if key.is_some_and(sensitive_key) {
        *value = serde_json::Value::String("<redacted>".into());
        return;
    }
    match value {
        serde_json::Value::String(text) => {
            if text.starts_with('/') || text.contains("file:///") || text.contains(":\\") {
                *text = "<redacted-path>".into();
            } else if text.len() > 4096 {
                text.truncate(4096);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redact_trace_value(item, None);
            }
        }
        serde_json::Value::Object(fields) => {
            for (field, value) in fields {
                redact_trace_value(value, Some(field));
            }
        }
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {}
    }
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key == "root"
        || key == "path"
        || key.ends_with("path")
        || key == "file"
        || key.ends_with("file")
        || key == "title"
        || key == "message"
        || key == "text"
        || key.ends_with("text")
        || key == "content"
        || key == "source"
        || key == "diagnostic"
        || key == "diagnostics"
        || key == "target"
        || key == "bytes"
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrontendRecord {
    schema: String,
    layer: String,
    trace_id: String,
    sequence: u64,
    elapsed_ms: u64,
    event: String,
    fields: serde_json::Map<String, serde_json::Value>,
}

fn validate_frontend_line(line: &str, trace_id: &str) -> Result<String, &'static str> {
    if line.len() > MAX_FRONTEND_LINE_BYTES {
        return Err("oversized");
    }
    let mut record = serde_json::from_str::<FrontendRecord>(line).map_err(|_| "invalid_schema")?;
    if record.schema != SCHEMA
        || record.layer != "frontend"
        || record.trace_id != trace_id
        || record.trace_id.is_empty()
        || record.trace_id.len() > MAX_TRACE_ID_BYTES
        || !record
            .trace_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("identity_mismatch");
    }
    if record.sequence == 0
        || record.sequence > MAX_SAFE_INTEGER
        || record.elapsed_ms > MAX_SAFE_INTEGER
    {
        return Err("invalid_clock");
    }
    let Some(allowed) = frontend_fields(&record.event) else {
        return Err("unknown_event");
    };
    let required = if record.event == "analysis_early_return" {
        &["selection", "order", "reason"][..]
    } else {
        allowed
    };
    if record.event.len() > 64
        || record.fields.len() > allowed.len()
        || required.iter().any(|key| !record.fields.contains_key(*key))
    {
        return Err("invalid_fields");
    }
    for (key, value) in &mut record.fields {
        if !allowed.contains(&key.as_str()) || !validate_frontend_value(key, value, 0) {
            return Err("invalid_fields");
        }
    }
    serde_json::to_string(&record).map_err(|_| "invalid_schema")
}

fn validate_frontend_value(key: &str, value: &mut serde_json::Value, depth: usize) -> bool {
    if depth > 2 {
        return false;
    }
    match key {
        "accepted" | "catchUp" | "completed" | "enabled" | "finished" | "hasProject"
        | "initial" | "installed" | "loading" | "modelPresent" | "operationCurrent" | "retired"
        | "restoreCache" | "retryable" | "viewAccepted" => value.is_boolean(),
        "restorationCurrent" | "restorationCurrentAfter" | "restorationCurrentBefore" => {
            value.is_null() || value.is_boolean()
        }
        "attempt" | "document" | "instance" | "selection" => {
            value.is_null() || safe_frontend_number(value)
        }
        "appliedCount" | "characterCount" | "count" | "order" | "pathCount"
        | "previousRevision" | "receivedCount" | "reset" | "revision" | "ruleCount" | "serial"
        | "subscription" | "version" | "watchSubscription" => safe_frontend_number(value),
        "buildOwner" | "operationAfter" | "operationBefore" | "owner" | "previousOwner"
        | "restoration" | "state" => {
            let Some(object) = value.as_object_mut() else {
                return value.is_null();
            };
            if object.len() > 7 {
                return false;
            }
            object.iter_mut().all(|(child_key, child)| {
                matches!(
                    child_key.as_str(),
                    "attempt"
                        | "kind"
                        | "order"
                        | "reason"
                        | "retryable"
                        | "revision"
                        | "selection"
                        | "serial"
                ) && validate_frontend_value(child_key, child, depth + 1)
            })
        }
        // Exception strings are useful in the Inspector, but stdout never needs
        // their unrestricted contents. Preserve only nullability at the mirror.
        "name" | "stack" => {
            if value.is_string() {
                *value = serde_json::Value::String("<redacted>".into());
                true
            } else {
                value.is_null()
            }
        }
        "activity" | "buildState" | "cacheStatus" | "decision" | "kind" | "next" | "outcome"
        | "phase" | "previous" | "reason" | "summary" => value
            .as_str()
            .is_some_and(|text| SAFE_FRONTEND_STRINGS.contains(&text)),
        _ => false,
    }
}

fn safe_frontend_number(value: &serde_json::Value) -> bool {
    value
        .as_u64()
        .is_some_and(|number| number <= MAX_SAFE_INTEGER)
}

const SAFE_FRONTEND_STRINGS: &[&str] = &[
    "already-terminal",
    "analysis_not_loaded",
    "available",
    "changed",
    "closed",
    "compile",
    "compile_exception",
    "compile_failed",
    "compile_source_changed",
    "compile_started",
    "compile_succeeded",
    "compilation_invalidated",
    "compiled",
    "compiling",
    "configuration-failed",
    "covered",
    "coverage_catch_up",
    "disabled",
    "exception",
    "explicit_navigation",
    "failed",
    "failure_response_superseded",
    "hit",
    "invalidation",
    "loaded",
    "miss",
    "new_rule",
    "newer-build-owner",
    "no_openable_source",
    "no-openable-source",
    "none",
    "not-compiled",
    "not-found",
    "not-requested",
    "notRequested",
    "opening",
    "orphaned-superseded",
    "partial",
    "pending",
    "project_left",
    "project_opened",
    "ready",
    "restoration",
    "restoration_analysis_failed",
    "restoration_disabled",
    "restoration_hit",
    "restoration_miss",
    "restoration_not-requested",
    "restoration_orphaned-superseded",
    "restoration_response_application_failed",
    "restoration_unavailable",
    "restoring",
    "selection-superseded",
    "selection_stale_before_invoke",
    "shown",
    "stale",
    "superseded",
    "terminal",
    "unchanged",
    "unavailable",
    "user-navigation",
    "view_response_superseded_after_restoration",
];

fn frontend_fields(event: &str) -> Option<&'static [&'static str]> {
    Some(match event {
        "frontend_start" | "lsp_ready" | "lsp_start" | "lsp_transport_ready" => &[],
        "debug_mode_confirmed" => &["enabled"],
        "trace_buffer_dropped" | "trace_records_dropped" => &["count"],
        "operation_begin" => &["serial", "revision", "hasProject"],
        "operation_invalidate" => &["serial", "previousRevision", "revision"],
        "reset_queued" => &["reset", "serial", "revision"],
        "reset_started" | "reset_completed" | "reset_failed" => &["reset"],
        "watch_subscription_started"
        | "watch_subscription_armed"
        | "watch_subscription_released"
        | "watch_subscription_cancelled"
        | "watch_changed_invalidation"
        | "watch_refresh_completed" => &["subscription"],
        "watch_subscription_failed" | "watch_refresh_failed" => {
            &["subscription", "name", "summary", "stack"]
        }
        "watch_listener_failed" | "lsp_start_failed" => &["name", "summary", "stack"],
        "watch_refresh_started" => &["subscription", "activity"],
        "watch_notice_received" => &["kind", "subscription", "instance", "catchUp", "pathCount"],
        "build_state_transition" => &["previous", "next", "reason", "previousOwner", "owner"],
        "restoration_exception_settlement" => {
            &["selection", "order", "decision", "reason", "buildOwner"]
        }
        "analysis_started" => &["selection", "order", "initial", "restoration"],
        "analysis_invoking" => &[
            "selection",
            "order",
            "initial",
            "watchSubscription",
            "restoreCache",
            "operationBefore",
            "restorationCurrentBefore",
        ],
        "analysis_response" => &[
            "selection",
            "order",
            "cacheStatus",
            "operationAfter",
            "restorationCurrentAfter",
        ],
        "analysis_accept" | "analysis_fail" => &["selection", "order", "accepted", "phase"],
        "analysis_early_return" => &[
            "selection",
            "order",
            "reason",
            "cacheStatus",
            "restorationCurrent",
        ],
        "analysis_exception" => &["selection", "order", "name", "summary", "stack"],
        "analysis_finish" => &["selection", "order", "finished", "phase", "loading"],
        "restoration_decision" => &[
            "selection",
            "order",
            "cacheStatus",
            "operationCurrent",
            "decision",
            "reason",
            "viewAccepted",
            "buildState",
            "buildOwner",
        ],
        "initial_presentation_begin" => &["selection", "order", "attempt", "state"],
        "initial_presentation_started" => &["selection", "order", "attempt"],
        "initial_presentation_committed" => &["selection", "order", "attempt", "completed"],
        "initial_presentation_completed" => &[
            "selection",
            "order",
            "attempt",
            "outcome",
            "completed",
            "state",
        ],
        "initial_presentation_retired" => &["reason", "retired", "state"],
        "document_auto_open_started" => &["selection", "order"],
        "document_auto_open_completed" => &["selection", "order", "outcome"],
        "document_auto_open_skipped" => &["selection", "order", "reason"],
        "project_selected" | "project_closed" => &["selection"],
        "lsp_document_opened" => &["document", "characterCount"],
        "lsp_document_changed" => &["document", "version", "characterCount"],
        "lsp_document_closed" => &["document"],
        "lsp_diagnostics_received" => {
            &["document", "receivedCount", "appliedCount", "modelPresent"]
        }
        _ => return None,
    })
}

#[tauri::command]
pub(crate) fn debug_status(trace: tauri::State<'_, DebugTrace>) -> DebugStatus {
    let status = trace.status();
    trace.event_lazy(
        "command_received",
        || serde_json::json!({ "command": "debug_status" }),
    );
    trace.event_lazy(
        "command_responded",
        || serde_json::json!({ "command": "debug_status", "ok": true }),
    );
    status
}

/// Mirrors the exact frontend Inspector JSON Line to stdout so one captured
/// process log contains both layers. The same line is still written to the
/// Inspector console first. Invalid, oversized or cross-session input is dropped.
#[tauri::command]
pub(crate) fn debug_frontend_trace(line: String, trace: tauri::State<'_, DebugTrace>) {
    let Some(enabled) = &trace.enabled else {
        return;
    };
    match validate_frontend_line(&line, &enabled.trace_id) {
        Ok(safe_line) => trace.frontend_line(safe_line),
        Err(reason) => trace.event(
            "frontend_trace_rejected",
            serde_json::json!({ "reason": reason }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_is_exactly_opt_in() {
        let disabled = DebugTrace::from_args([OsString::from("quipu")]);
        assert!(!disabled.is_enabled());
        let similarly_named =
            DebugTrace::from_args([OsString::from("quipu"), OsString::from("--debug-cache")]);
        assert!(!similarly_named.is_enabled());
    }

    #[test]
    fn disabled_trace_does_not_evaluate_expensive_or_locking_field_producers() {
        let trace = DebugTrace::disabled();
        let evaluated = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let field_evaluated = Arc::clone(&evaluated);
        let application_lock = Arc::new(std::sync::Mutex::new(()));
        let field_lock = Arc::clone(&application_lock);
        let _held = application_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        trace.event_lazy("must_not_appear", move || {
            assert!(
                field_lock.try_lock().is_ok(),
                "disabled trace acquired an application lock"
            );
            field_evaluated.store(true, Ordering::SeqCst);
            serde_json::json!({ "path": "/secret" })
        });
        assert!(!evaluated.load(Ordering::SeqCst));
        assert_eq!(
            trace.status(),
            DebugStatus {
                enabled: false,
                trace_id: None
            }
        );
    }

    #[test]
    fn enabled_records_are_correlated_json_lines_in_monotonic_order() {
        let lines = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let captured = Arc::clone(&lines);
        let trace = DebugTrace::with_sink("trace-test".into(), move |line| {
            captured
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(line.to_string());
        });

        trace.event("first", serde_json::json!({ "count": 3 }));
        trace.event("second", serde_json::json!({ "status": "hit" }));
        assert!(trace.flush());

        let lines = lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let records = lines
            .iter()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("valid JSON"))
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["schema"], SCHEMA);
        assert_eq!(records[0]["layer"], "backend");
        assert_eq!(records[0]["traceId"], "trace-test");
        assert_eq!(records[0]["sequence"], 1);
        assert_eq!(records[1]["sequence"], 2);
        assert_eq!(records[1]["event"], "second");
    }

    #[test]
    fn a_valid_frontend_line_is_mirrored_without_resequencing_it() {
        let lines = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let captured = Arc::clone(&lines);
        let trace = DebugTrace::with_sink("trace-test".into(), move |line| {
            captured
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(line.to_string());
        });
        let frontend = serde_json::json!({
            "schema": SCHEMA,
            "layer": "frontend",
            "traceId": "trace-test",
            "sequence": 9,
            "elapsedMs": 12,
            "event": "analysis_accept",
            "fields": { "selection": 1, "order": 2, "accepted": false, "phase": "ready" },
        })
        .to_string();
        let safe = validate_frontend_line(&frontend, "trace-test").expect("valid frontend event");
        trace.frontend_line(safe.clone());
        assert!(trace.flush());
        let mirrored = lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(mirrored.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&mirrored[0]).unwrap(),
            serde_json::from_str::<serde_json::Value>(&safe).unwrap()
        );
    }

    #[test]
    fn backend_record_boundary_redacts_sensitive_fields() {
        let (trace, lines) = DebugTrace::captured();
        trace.event(
            "adversarial",
            serde_json::json!({
                "path": "/private/source.yar",
                "diagnostic": { "title": "SECRET_TITLE", "message": "SECRET_MESSAGE" },
                "sourceText": "rule SECRET_SOURCE { condition: true }",
                "target": [1, 2, 3],
                "ruleCount": 7,
            }),
        );
        assert!(trace.flush());
        let output = lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .join("\n");
        assert!(!output.contains("/private"));
        assert!(!output.contains("SECRET"));
        assert!(!output.contains("[1,2,3]"));
        assert!(output.contains("\"ruleCount\":7"));
    }

    #[test]
    fn blocked_sink_never_blocks_producers_and_reports_bounded_queue_drops() {
        let lines = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let captured = Arc::clone(&lines);
        let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let sink_gate = Arc::clone(&gate);
        let (sink_started, wait_started) = mpsc::channel();
        let first = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let sink_first = Arc::clone(&first);
        let trace = DebugTrace::with_sink_and_capacity("bounded".into(), 2, move |line| {
            if sink_first.swap(false, Ordering::SeqCst) {
                let _ = sink_started.send(());
                let (lock, ready) = &*sink_gate;
                let mut released = lock
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                while !*released {
                    released = ready
                        .wait(released)
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                }
            }
            captured
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(line.to_string());
        });

        trace.event("first", serde_json::json!({}));
        wait_started
            .recv_timeout(Duration::from_secs(1))
            .expect("sink reached the deliberate block");
        let producer = trace.clone();
        let (produced, produced_wait) = mpsc::channel();
        std::thread::spawn(move || {
            for count in 0..1000 {
                producer.event("queued", serde_json::json!({ "count": count }));
            }
            let _ = produced.send(());
        });
        produced_wait
            .recv_timeout(Duration::from_millis(250))
            .expect("non-blocking producers finish while the sink is blocked");
        assert!(
            !trace.flush(),
            "a full queue makes test coordination return, not wait"
        );

        let (lock, ready) = &*gate;
        *lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        ready.notify_all();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !trace.flush() && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(
            Instant::now() < deadline,
            "the released writer drains without deadlock"
        );

        let records = lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        let retained = records
            .iter()
            .filter(|record| record["event"] == "first" || record["event"] == "queued")
            .count();
        assert!(
            retained <= 3,
            "one active record plus the two-slot queue is bounded"
        );
        let dropped = records
            .iter()
            .filter(|record| record["event"] == "trace_records_dropped")
            .map(|record| record["fields"]["count"].as_u64().unwrap())
            .sum::<u64>();
        assert!(
            dropped >= 998,
            "dropped records become observable after output resumes"
        );
    }

    #[test]
    fn drop_reporting_emits_only_one_summary_per_dequeued_record() {
        let dropped = AtomicU64::new(9);
        let summaries = AtomicU64::new(0);
        let mut sequence = 0;
        write_dropped_records(
            &|_| {
                let previous = summaries.fetch_add(1, Ordering::SeqCst);
                if previous < 3 {
                    // Model producers continuing to overflow while stdout is
                    // writing the summary. Those new drops belong to a later
                    // dequeued record; this call must not chase them forever.
                    dropped.fetch_add(1, Ordering::SeqCst);
                }
            },
            "bounded",
            &mut sequence,
            &dropped,
            1,
        );
        assert_eq!(summaries.load(Ordering::SeqCst), 1);
        assert_eq!(sequence, 1);
        assert_eq!(
            dropped.load(Ordering::SeqCst),
            1,
            "drops arriving during the summary remain for the next dequeue"
        );
    }

    #[test]
    fn sink_is_never_invoked_inline_while_a_producer_holds_an_application_lock() {
        let application_lock = Arc::new(std::sync::Mutex::new(()));
        let sink_lock = Arc::clone(&application_lock);
        let (sink_ran, sink_wait) = mpsc::channel();
        let trace = DebugTrace::with_sink("outside-lock".into(), move |_| {
            let _guard = sink_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let _ = sink_ran.send(());
        });
        let producer_trace = trace.clone();
        let producer_lock = Arc::clone(&application_lock);
        let (event_returned, returned_wait) = mpsc::channel();
        let (release, release_wait) = mpsc::channel();
        std::thread::spawn(move || {
            let _guard = producer_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            producer_trace.event("edge", serde_json::json!({}));
            let _ = event_returned.send(());
            let _ = release_wait.recv();
        });
        returned_wait
            .recv_timeout(Duration::from_millis(250))
            .expect("event returned without calling the sink inline");
        let _ = release.send(());
        sink_wait
            .recv_timeout(Duration::from_secs(1))
            .expect("sink ran after the application lock was released");
        assert!(trace.flush());
    }

    #[test]
    fn frontend_mirror_rejects_unrestricted_names_keys_strings_and_top_level_fields() {
        fn line(event: &str, fields: serde_json::Value) -> String {
            serde_json::json!({
                "schema": SCHEMA,
                "layer": "frontend",
                "traceId": "strict",
                "sequence": 1,
                "elapsedMs": 2,
                "event": event,
                "fields": fields,
            })
            .to_string()
        }

        let build_transition = line(
            "build_state_transition",
            serde_json::json!({
                "previous": "not-compiled",
                "next": "compiling",
                "reason": "compile_started",
                "previousOwner": { "kind": "none" },
                "owner": { "kind": "compile", "serial": 2, "revision": 0 },
            }),
        );
        validate_frontend_line(&build_transition, "strict")
            .expect("the complete build-state vocabulary is accepted");
        validate_frontend_line(
            &line("trace_records_dropped", serde_json::json!({ "count": 17 })),
            "strict",
        )
        .expect("a bounded frontend mirror loss summary is accepted");

        let mut invalid_sequence = serde_json::from_str::<serde_json::Value>(&line(
            "frontend_start",
            serde_json::json!({}),
        ))
        .unwrap();
        invalid_sequence["sequence"] = serde_json::json!(0);
        assert!(
            validate_frontend_line(&invalid_sequence.to_string(), "strict").is_err(),
            "sequence zero is not a monotonic event identity"
        );
        let mut invalid_elapsed = invalid_sequence;
        invalid_elapsed["sequence"] = serde_json::json!(1);
        invalid_elapsed["elapsedMs"] = serde_json::json!(MAX_SAFE_INTEGER + 1);
        assert!(validate_frontend_line(&invalid_elapsed.to_string(), "strict").is_err());
        let oversized_id = "x".repeat(MAX_TRACE_ID_BYTES + 1);
        let oversized_identity = line("frontend_start", serde_json::json!({}))
            .replace("\"strict\"", &format!("\"{oversized_id}\""));
        assert!(validate_frontend_line(&oversized_identity, &oversized_id).is_err());

        let attacks = [
            line("/private/SECRET_EVENT", serde_json::json!({})),
            line(
                "analysis_accept",
                serde_json::json!({ "/private/SECRET_KEY": 1 }),
            ),
            line(
                "analysis_early_return",
                serde_json::json!({
                    "selection": 1,
                    "order": 2,
                    "reason": "rule SECRET_SOURCE { condition: true }",
                }),
            ),
            line(
                "analysis_accept",
                serde_json::json!({ "selection": 1, "accepted": true }),
            ),
            serde_json::json!({
                "schema": SCHEMA,
                "layer": "frontend",
                "traceId": "strict",
                "sequence": 1,
                "elapsedMs": 2,
                "event": "frontend_start",
                "fields": {},
                "extra": "/private/SECRET_EXTRA",
            })
            .to_string(),
        ];
        for attack in attacks {
            assert!(validate_frontend_line(&attack, "strict").is_err());
        }

        let exception = line(
            "analysis_exception",
            serde_json::json!({
                "selection": 1,
                "order": 2,
                "name": "SECRET_DIAGNOSTIC_TITLE",
                "summary": "exception",
                "stack": "at /private/SECRET_SOURCE.yar",
            }),
        );
        let safe = validate_frontend_line(&exception, "strict").expect("known exception shape");
        assert!(!safe.contains("SECRET"));
        assert!(!safe.contains("/private"));
        assert!(safe.contains("<redacted>"));
    }
}
