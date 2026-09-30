import { invoke } from "@tauri-apps/api/core";
import type { BackendDebugStatus } from "./trace";

// Mirrors the Rust IPC payloads in src-tauri/src/commands.rs.
// Byte offsets are into the (UTF-8) rule source.

export interface Span {
  start: number;
  end: number;
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  code: string;
  title: string;
  line: number;
  column: number;
  span: Span;
  // Canonical, openable path of the file the problem came from; null for the
  // scratch buffer and for problems that name no file (e.g. a bad quipu.toml).
  file: string | null;
}

export interface CompileResponse {
  ok: boolean;
  diagnostics: Diagnostic[];
  ruleCount: number;
  sourceChanged: boolean;
}

export type MetaValue =
  | { kind: "integer"; value: number }
  | { kind: "float"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "bytes"; value: string };

export interface MatchSpan {
  pattern: string;
  start: number;
  end: number;
  length: number;
  data: string;
}

export interface RuleMatch {
  rule: string;
  namespace: string;
  tags: string[];
  meta: Record<string, MetaValue>;
  matches: MatchSpan[];
}

export interface ScanResponse {
  ok: boolean;
  matched: RuleMatch[];
  scannedBytes: number;
  error: string | null;
}

// --- The project model ---
//
// Mirrors src-tauri/src/analysis.rs. A source is identified by an identity, not
// by a path: `external` decides what `path` means, so the two are never
// flattened into one string. `root` is the only standalone filesystem-path field
// on the wire; an identity's `path` is root-relative when internal and a
// canonical absolute path when external. So turning an identity back into
// something openable needs `root` only in the internal case:
//
//   internal: `${analysis.root}/${id.path}`
//   external: `id.path` (already absolute)

export interface SourceId {
  // False for a file inside the project root, whose `path` is then relative to
  // it; true for one reached by an include that leaves the project, whose
  // `path` is canonical and absolute.
  external: boolean;
  // Always `/`-separated, whatever the platform.
  path: string;
}

export interface SourceNode {
  id: SourceId;
  // False when the file is in the graph but its bytes could not be read.
  readable: boolean;
}

export interface IncludeEdge {
  from: SourceId;
  // Position among the includes declared by `from`, starting at zero.
  order: number;
  // The include filename as written.
  raw: string;
  // Byte span of the directive within `from`.
  span: Span;
  // Null when the include resolved to nothing.
  to: SourceId | null;
}

export interface Issue {
  // Stable kebab-case code; the field to branch on. Never parse `message`.
  code: string;
  message: string;
  severity: "blocking" | "informational";
  scope: "source" | "project";
  // The source the problem belongs to, when attributable to one.
  at: SourceId | null;
  // Byte span within `at`, when the issue has one.
  span: Span | null;
}

// `loaded` means a snapshot exists; it may still be full of blocking problems
// and refuse to compile (see `compilable`). `configurationFailed` means no
// snapshot can exist at all, because the project definition itself is broken.
export type ProjectAnalysis =
  | {
      status: "loaded";
      root: string;
      // `"quipu.toml"` when the project has a manifest, else null.
      manifest: string | null;
      entrypointOrigin: "declared" | "inferred";
      entrypoints: SourceId[];
      discovered: SourceId[];
      nodes: SourceNode[];
      edges: IncludeEdge[];
      issues: Issue[];
      // False means a compile would be refused before YARA-X is invoked.
      compilable: boolean;
    }
  | { status: "configurationFailed"; issue: Issue };

export type CacheRestore =
  | { status: "notRequested" }
  | { status: "disabled" }
  | { status: "miss" }
  | { status: "unavailable" }
  | { status: "superseded" }
  | { status: "hit"; ruleCount: number; diagnostics: Diagnostic[] };

export interface AnalyzeResponse {
  analysis: ProjectAnalysis;
  cache: CacheRestore;
}

export interface CacheStatus {
  enabled: boolean;
  maximumBytes: number;
  available: boolean;
  effectivePath: string;
  totalBytes: number;
  currentProjectBytes: number;
  currentProjectCached: boolean;
  warning: string | null;
}

/** Confirms the process-level `--debug` mode and supplies its cross-layer ID. */
export function debugStatus(): Promise<BackendDebugStatus> {
  return invoke<BackendDebugStatus>("debug_status");
}

export function debugFrontendTrace(line: string): Promise<void> {
  return invoke<void>("debug_frontend_trace", { line });
}

// Both Help menu entries address the same singleton documentation window. The
// backend accepts this closed set rather than a path supplied by the webview.
export type HelpPage = "documentation" | "quickStart";

export function showHelp(page: HelpPage): Promise<void> {
  return invoke<void>("show_help", { page });
}

// Analyses the project rooted at `root`: its include graph, its problems, and
// whether it can currently be compiled. Ordinary calls touch no compiled-ruleset
// state; the initial opening call may restore a hit from this same snapshot.
//
// `subscription` is the watcher subscription this analysis belongs to, or 0 for
// none. Given one, the backend derives what to watch from the very snapshot it is
// about to return, so the watched set and the project on screen always describe one
// read of the disk; a superseded subscription is ignored there. 0 is for an
// analysis that is nobody's view of the project - the compile's membership query -
// which must not widen or narrow what is being watched.
//
// `generation` is this analysis's order within that subscription, which matters
// because several analyses can be in flight: a manual Refresh started while an
// automatic one is reading, a catch-up beside either. Only the newest to answer
// becomes the project on screen, so only the newest to answer may install a watch
// plan - otherwise the watcher ends up filtering events through a project the window
// has already replaced. Sending the order lets the backend apply that same rule.
export function analyzeProject(
  root: string,
  subscription = 0,
  generation = 0,
  restoreCache = false,
): Promise<AnalyzeResponse> {
  return invoke<AnalyzeResponse>("analyze_project", {
    root,
    watching: subscription === 0 ? null : { subscription, generation },
    restoreCache,
  });
}

export function cacheStatus(root: string | null): Promise<CacheStatus> {
  return invoke<CacheStatus>("cache_status", { root });
}

export function updateCacheSettings(
  enabled: boolean,
  maximumBytes: number,
  root: string | null,
): Promise<CacheStatus> {
  return invoke<CacheStatus>("update_cache_settings", { enabled, maximumBytes, root });
}

export function clearProjectCache(root: string): Promise<void> {
  return invoke("clear_project_cache", { root });
}

export function clearAllCaches(): Promise<void> {
  return invoke("clear_all_caches");
}

// Compilation has exactly two shapes, matching the backend commands.

// Compiles one in-memory source - the scratch buffer, when no folder is open.
// The result is PERSISTED on the backend for later scans.
export function compileScratch(text: string): Promise<CompileResponse> {
  return invoke<CompileResponse>("compile_scratch", { text });
}

// Compiles the project rooted at `root`. The backend analyses the directory
// itself immediately before compiling, so only the root is sent: what gets
// compiled cannot drift from what is on disk. Save dirty documents first.
export function compileProject(root: string): Promise<CompileResponse> {
  return invoke<CompileResponse>("compile_project", { root });
}

// Scans `target` against the persisted compiled ruleset (no recompile).
export function scanTarget(target: number[]): Promise<ScanResponse> {
  return invoke<ScanResponse>("scan_target", { target });
}

// Drops the persisted compiled ruleset (e.g. on project-folder switch).
export function resetRules(): Promise<void> {
  return invoke<void>("reset_rules");
}

export function readFileBytes(path: string): Promise<number[]> {
  return invoke<number[]>("read_file", { path });
}

// --- The packaged example projects ---
//
// Mirrors src-tauri/src/examples.rs. The catalog lives there and only there, so
// there is no list here to drift from it: the chooser renders whatever
// `listExamples()` returns, and an example is identified across IPC by that id
// alone. No path from here reaches the filesystem - `prepareExample` looks the id
// up in its fixed catalog and rejects anything it does not know.

export interface ExampleInfo {
  // Lowercase ASCII letters, digits and hyphens; also the working copy's
  // directory name. The only thing the frontend may send back.
  id: string;
  name: string;
  description: string;
}

// The example's sample scan target, read from the prepared working copy rather
// than from the packaged template, so the path shown is one the user can edit.
export interface PreparedTarget {
  path: string;
  bytes: number[];
}

export interface PreparedExample extends ExampleInfo {
  // The working copy's root, ready to be opened like any other project folder.
  root: string;
  target: PreparedTarget;
}

/** The fixed catalog of examples the application ships. */
export function listExamples(): Promise<ExampleInfo[]> {
  return invoke<ExampleInfo[]>("list_examples");
}

// Materialises `id`'s editable working copy under the application's data
// directory and returns it, copying the packaged template on the first open and
// reusing (never repairing) an existing copy afterwards, so user edits survive.
export function prepareExample(id: string): Promise<PreparedExample> {
  return invoke<PreparedExample>("prepare_example", { id });
}

// --- Rules project explorer ---
//
// There is deliberately no "list the rule files in this directory" call. The
// explorer's contents come from `analyze_project`, which discovers the project's
// sources, resolves its includes and reports its problems in one answer; a second,
// flatter listing alongside it would be a competing account of what the project
// contains.

export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

// What a save did. Neither is a failure: `refused` says the file no longer holds the
// version the save was authorised against, and that version - somebody else's - is
// still there.
export type WriteOutcome = "written" | "refused";

// Writes `contents` to `path`, over `expect` and nothing else: the text the caller last
// read there, or null for a file it expects not to exist at all.
//
// The expected version travels with the write because a read of the file is an
// observation with a lifetime, and the backend commits against what is there at the
// instant it writes rather than against what was read beforehand. See
// src-tauri/src/fs.rs.
export function saveTextFile(
  path: string,
  contents: string,
  expect: string | null,
): Promise<WriteOutcome> {
  return invoke<WriteOutcome>("save_text_file", { path, contents, expect });
}

export function createFile(path: string): Promise<void> {
  return invoke<void>("create_file", { path });
}

export function renameFile(from: string, to: string): Promise<void> {
  return invoke<void>("rename_file", { from, to });
}

// --- Native project watching ---
//
// Mirrors src-tauri/src/watch. The backend derives what to watch from its own
// analysis: there is deliberately no call that takes a list of paths to watch, and
// no general filesystem plugin behind this. `subscription` is the frontend's
// counted identity for one project's watcher, recorded by the backend and never
// invented by it, so a notice, a setup result or a plan update belonging to a
// superseded project is dropped at whichever end notices first.

/** The Tauri event notices arrive on. */
export const WATCH_EVENT = "project_watch";

// What a notice carries. Never file contents: `paths` is a short, escaped,
// display-only list for diagnostics, and the authoritative answer to "what changed"
// is a full `analyzeProject`.
//
// `instance` is the backend's counted identity for one native watcher. Every arm is
// announced with its own, and a failure carries whichever instance it is news about, so
// an error from a watcher that has since been replaced can be told from an error from
// the one that is live. Deliberately absent from "changed": an instance kept for
// coverage its replacement could not duplicate is OLDER than the live one and is the
// only thing delivering that location.
export type WatchNotice =
  | { kind: "changed"; subscription: number; paths: string[] }
  // Coverage derived from the last analysis is now armed IN FULL. Not a report that
  // anything changed, and nothing compiled is invalidated by it. Being complete is
  // what makes it proof that watching this project works. `catchUp` is the separate
  // question of whether an analysis is owed: true when something was read before this
  // coverage would have reported a change to it, and false when a plan was completed
  // by taking over coverage that was already being delivered for the project, which
  // ends a degradation without anything having gone unwatched - and false for the arms
  // that start a project or end a fence, whose caller catches up on its own interval.
  | {
      kind: "covered";
      subscription: number;
      instance: number;
      paths: string[];
      catchUp: boolean;
    }
  // Part of that coverage is armed and part of it could not be. `message` says what
  // is not being watched, which is degradation; `catchUp` is the same debt as above -
  // true when the coverage being delivered grew OR when the relevance plan behind it
  // changed, so it is not something `paths` (display only) can be relied on to imply.
  // Deliberately not "covered": coverage that was never installed may not say
  // automatic refresh is working.
  | {
      kind: "partial";
      subscription: number;
      instance: number;
      paths: string[];
      catchUp: boolean;
      message: string;
    }
  // Automatic refresh is degraded for the instance named: the one whose callback
  // reported the error, or the one still live when an arm could not replace it. 0 when
  // nothing was armed at all.
  | { kind: "failed"; subscription: number; instance: number; message: string };

// Starts watching the project rooted at `root`, recursively, under `subscription`.
// Called before the project's first analysis, so a change made while that analysis
// runs is not lost. A rejection is degraded operation, not a folder that failed to
// open.
export function watchProject(root: string, subscription: number): Promise<void> {
  return invoke<void>("watch_project", { root, subscription });
}

// Stops watching for `subscription`. Ignored by the backend when a newer
// subscription has already taken over.
export function watchRelease(subscription: number): Promise<void> {
  return invoke<void>("watch_release", { subscription });
}

// Retires the native watcher ahead of a filesystem change the app is making
// itself, so Quipu's own writes are not reported back to it as external changes.
// Await it BEFORE mutating: what it establishes is that a write begun afterwards has
// no live watcher to be reported by, not a timeout (see watch/native.rs).
//
// Resolves with the token that releases this fence, and only this fence. App-owned
// mutations overlap, so the token is what stops one of them re-arming the watcher
// while another is still writing.
//
// A rejection says nothing about whether the fence went up. It may have, with the token
// lost along with the answer - and then no release will ever lift it. So the caller reports
// degradation nothing can place: this call reserves no instance identity, but it retires
// one, whose coverage notice may be in flight on the event channel.
export function watchFence(subscription: number): Promise<number> {
  return invoke<number>("watch_fence", { subscription });
}

// Why a re-arm could not be made, and which attempt could not make it.
//
// `attempt` is the instance identity the failed arm reserved before it tried: newer
// than every notice built before the attempt, older than every one built after it.
// Nothing is armed under it and nothing ever will be, so it is not a live instance -
// it is the position a failure that came back on this call, rather than on the event
// channel, occupies among the notices still in flight there. An arming step that
// panicked reserved one all the same and names it. 0 only where nothing was reserved.
//
// `null` says the identity is unknown, which is a weaker statement than 0 and must stay
// distinguishable from it: unknown means an arm may be installed under a number nobody
// can name, so nothing in flight can be told from the recovery.
export type ArmFailure = { attempt: number | null; message: string };

// The rejection of a `watchRearm`, whatever shape it arrived in. A backend rejection is
// the serialised `ArmFailure`; anything else - a transport error, a rejection from a Tauri
// layer below the command - tells this side nothing about what was reserved, and unknown
// is what that is, never 0.
export function armFailure(err: unknown): ArmFailure {
  if (typeof err === "object" && err !== null && "attempt" in err && "message" in err) {
    const { attempt, message } = err as ArmFailure;
    const placed = typeof attempt === "number" || attempt === null;
    if (placed && typeof message === "string") {
      return { attempt, message };
    }
  }
  return { attempt: null, message: String(err) };
}

// Releases the fence `watchFence` returned, re-arming the stored plan if it was the
// last one outstanding. Rejects with an `ArmFailure`: automatic refresh has been lost -
// report that, never the write, which succeeded.
//
// Nothing external is reported for the fenced interval: the events are gone, so the
// caller reconciles it itself once this resolves.
export function watchRearm(subscription: number, fence: number): Promise<void> {
  return invoke<void>("watch_rearm", { subscription, fence });
}
