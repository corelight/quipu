# Workspace and project model

## Status

Implemented, Phases 1 to 5. The model lives in `app/src-tauri/src/project/`, its wire face in `app/src-tauri/src/analysis.rs`, and the compilation pipeline in `app/src-tauri/src/compile.rs`. Compilation runs from a validated `CompilationPlan`: the backend analyses the project itself instead of being handed a list of file contents, and there is no longer any command that accepts one. The frontend owns the analysed project as a first-class object (`app/src/project.ts`) and presents it as a recursive Files tree and an Includes graph. The project's inputs are watched natively (`app/src-tauri/src/watch/`, `app/src/watching.ts`), so a change made outside Quipu updates the views by itself. The changes Quipu makes itself are ordered by a single mutation queue (`app/src/mutations.ts`) and refuse to clobber at the boundary that acts: creating and renaming carry their refusal into the kernel, and a save is conditional on the version it was authorised to replace (`app/src-tauri/src/fs.rs`). The example projects the application ships are real projects of exactly this kind: `examples/` in the source tree, `app/src-tauri/src/examples.rs` for the catalog and the working copies, `app/src/examples.ts` for the chooser.

Still deferred: compiled-rules caching and manifest authoring. Their menu items, where they have any, exist as stubs. See the phase boundaries at the end.

## Scope

The project model answers three questions about a directory of YARA rules, and nothing else:

1. What does this project contain?
2. How does its `include` graph resolve?
3. Exactly which sources would a compilation consume, in what order?

It knows nothing about editors, Monaco documents, IPC, file watching, caching or hashing. Everything it produces is derived from the filesystem and from an optional manifest, so the same directory always yields the same answer.

## Terminology

The backend calls this a **project**; the frontend already has a `Workspace` class that owns editor documents, and the two are deliberately not the same thing. A project is a directory on disk plus the configuration that describes it. `docs/compiled-rules-cache-design.md` follows the same terminology; user-facing commands retain “workspace”.

The four steps of the pipeline each have their own type:

| Type | Responsibility |
| --- | --- |
| `ProjectDefinition` | User intent: the manifest, or the documented defaults when there is none. |
| `ProjectSnapshot` | A point-in-time analysis: discovered files, the whole include graph, every problem found. |
| `CompilationPlan` | The deterministic inputs of a *valid* snapshot: ordered entrypoints, ordered include directories, the complete source closure. |
| A future cache layer | Hashes a plan. Not part of this phase. |

## The manifest

A project may contain a `quipu.toml` in its root. It is optional: a directory without one is a valid project that uses the defaults below. The manifest holds stable user intent only, so it is safe to commit to a rule repository.

### Schema 1

```toml
schema = 1
entrypoints = ["rules/main.yar"]
include_dirs = ["rules", "../shared"]
exclude = ["tests/**", "*.tmp.yar"]
```

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `schema` | yes | - | Manifest format version. Must be `1`; anything else is reported as an unsupported schema rather than as a parse error. |
| `entrypoints` | no | infer from the graph | Top-level sources, in significant order. Each must be a project-relative `.yar`/`.yara` path that does not escape the root, and each must be unique after normalisation. |
| `include_dirs` | no | `["."]` | Include search path, in significant order. Resolved relative to the project root. May use `..` and may resolve outside the project. Each must exist and be a directory. |
| `exclude` | no | `[]` | Globs matched against normalised, `/`-separated, project-relative paths. |

Unknown keys are rejected. With the schema version gating format changes, a stray or misspelled key is far more likely to be a mistake worth reporting than a forward-compatible extension.

Every configuration problem is reported as a `ConfigError` with a stable code, before any analysis happens: invalid TOML, an unsupported schema, an unknown key, a duplicate or non-relative or non-rule entrypoint, an entrypoint the same manifest excludes, an invalid glob, an include directory that is absolute, missing or not a directory.

### What the manifest never contains

No hashes, no cache paths, no timestamps, no engine or compiler versions, no generated state of any kind. Compiling a project - and, later, caching it - must never dirty the user's repository.

## Paths and identities

Two path forms live side by side and are not interchangeable:

- **Canonical absolute paths** (`std::fs::canonicalize`) are used for every filesystem access and to decide whether two spellings name the same file.
- **Identities** (`SourceId`) are used for ordering, deduplication, issue attribution and, later, hashing. An internal source's identity is its `/`-separated path relative to the project root; an external source's identity is its `/`-separated canonical absolute path.

Identities never depend on the host separator, so the same tree analysed on Linux and on Windows produces the same identity strings. On Windows the `\\?\` verbatim prefix that `canonicalize` adds is stripped; on Unix nothing is rewritten, because a backslash is a legal filename character there.

Ordering is by `(external, path)`: every internal source sorts before every external one, then lexicographically. That single rule orders graph nodes, inferred entrypoints, plan closures and issue lists.

### Paths that are not valid Unicode

An identity has to be unique per file, and a lossy conversion is not: `a<0xff>.yar` and `a<0xfe>.yar` are two different files that a lossy conversion collapses into one `a<U+FFFD>.yar` string, and therefore into one graph node. So such a path gets **no identity at all**. It is reported as `non-unicode-path` and left out of the graph, and because that report is project-scoped it blocks every plan - a rule file the project cannot name might be its only entrypoint.

Rejecting is preferred over encoding the bytes losslessly - percent-encoding them, or escaping them into the identity - for two reasons. An identity is destined for JSON over Tauri IPC and, later, for a cache fingerprint, neither of which can carry arbitrary bytes; and an encoded identity would be a path that looks like a path but is not one, which every consumer - display, the Includes view, error messages - would have to know to decode.

The policy is the same for internal and external sources, and it applies wherever a path becomes an identity: a discovered file, a walked directory (its contents cannot be named either, so not descending is incomplete discovery), and the canonical target of an `include`. A resolved include target with no identity leaves the edge unresolved but is *not* a `missing-include`: the file exists, so it is reported as what it is.

Display is a separate concern. A path that has no identity still has an *escaped* form, derived from `OsStr`'s `Debug` (`\xNN` on Unix, an escaped surrogate on Windows), which is what appears in issue payloads and messages. It is unique per file and readable, but it is not parseable, is never fed back to the filesystem and is never used as an identity. The same escaped form is used for the two paths that only ever appear in messages: the candidate locations in a `missing-include`, and the project root in a `root-unavailable` or `root-not-a-directory` error.

One consequence is worth stating: an exclusion glob cannot suppress a `non-unicode-path` report for an individual file, because matching a glob would need exactly the lossy string the policy refuses to produce. Excluding the *containing directory* does work, since discovery prunes it before enumerating its contents. A non-Unicode name that is not a rule file is not reported at all - it was never a project file, exactly as a representable one would not be.

Manifest paths are validated lexically, so the error describes the declaration rather than the disk: an entrypoint's `..` components are resolved against earlier components and may not climb above the root, an absolute path or a drive prefix is rejected, and a backslash is rejected because it would make the manifest machine-specific.

## Discovery

Discovery decides project membership. It is independent of the include graph.

- The root is walked recursively for regular files whose extension is `yar` or `yara`, matched case-insensitively (the same rule the existing flat explorer uses).
- Files with any other extension are not project files. `notes.txt`, `common.inc` and `quipu.toml` are never discovered.
- Exclusion globs prune matching directories and skip matching files. Globs are matched with `literal_separator` on, so `*` stops at a directory boundary and `**` is required to cross one: `*.tmp.yar` matches `scratch.tmp.yar` but not `nested/scratch.tmp.yar`.
- Directory symlinks are never followed. That is both the symlink-loop guard and the reason the walk always terminates. A symlink to a *file* is treated as a candidate rule file.
- Each directory's entries are visited in sorted order and the results are sorted by identity, so neither the file list nor the issue list depends on what order the filesystem happened to hand entries back in.
- The walk stops descending at 64 directories deep and reports `discovery-depth-exceeded` rather than silently truncating the project.

A discovered file's identity follows its canonical path. A symlink inside the project pointing at a file outside it is therefore discovered as an *external* source: it is still a project file for the purposes of entrypoint inference, but its identity is the absolute path of its target, because that is the file the compiler will read.

Not being discovered does not keep a file out of a compilation. A file reached by an `include` from a reachable source is parsed and compiled whatever its extension, wherever it lives, and even if an exclusion glob matches it. Discovery decides membership; the graph decides inputs.

### Failing closed

Discovery never skips an entry silently. Every entry is either accounted for or reported, because an unaccounted-for entry could have been a rule file - even the project's only entrypoint - and a snapshot missing it would still look valid. That matters more, not less, once plans are used for cache validation: a plan built from incomplete discovery would key a cache entry that does not describe the project.

Concretely, all four of these are reported rather than skipped:

| Failure | Reported as |
| --- | --- |
| `read_dir` fails on a directory | `unreadable-directory`, naming the directory |
| `read_dir`'s iterator yields an error, before any entry can be named | `unreadable-directory`, naming the directory being listed |
| `DirEntry::file_type()` fails | `unreadable-entry`, naming the entry |
| An entry that looks like a rule file cannot be canonicalized (a dangling symlink, most often) | `unreadable-entry`, naming the entry |

A symlink whose metadata cannot be read is treated as a possible file rather than skipped, so it reaches canonicalization and is reported there.

Every one of these reports is *project-scoped*, and that is not incidental: the entry never becomes a graph node, so an issue attributed to it would sit outside every plan's closure and block nothing at all. The snapshot itself stays displayable, exactly as it does for a broken graph; it is plan construction that rejects the incomplete result.

## Include resolution

Include directives are extracted with `yara-x-parser` - the same parser the compiler uses, pinned to the same `v1.20.0` tag as `yara-x` and `yara-x-ls` - through its public AST. Nothing scans lines, matches regexes or reads `Debug` output. The parser recovers from errors, so a file with a broken rule still contributes the includes it declares, which keeps a partially broken project navigable.

For an `include` in file A, candidates are tried in this order:

1. A's containing directory.
2. Each configured include directory, in declared order.

The first candidate that canonicalizes to an existing regular file wins, and that canonical path is its identity. A directory that is both A's parent and a configured include directory is only tried once. Multiple matches are *not* reported as ambiguous: YARA-X takes the first, so the model takes the first too. The candidate list is bounded by `1 + include_dirs.len()`, so resolution never enumerates paths open-endedly.

This mirrors `yara_x::Compiler::read_included_file`, which searches the parent of the file on top of its include stack before falling back to the configured include directories. `.` and `..` inside an include work, and two spellings of one file - `lib.yar`, `./sub/../lib.yar`, a symlink - collapse to a single graph node.

An include that matches no candidate produces an unresolved `IncludeEdge` (`to` is `None`) and a `missing-include` issue carrying the raw filename, its byte span and every candidate location searched.

### Entrypoints and YARA-X's include stack

YARA-X's include stack is empty while it processes a source handed to `Compiler::add_source`, so it does not search that source's own directory. This model applies the parent-first rule to entrypoints as well, because that is the semantics a user expects from a project. Compilation makes the compiler agree by never handing an entrypoint to `add_source` at all; see [Entrypoint parent-first resolution](#entrypoint-parent-first-resolution).

## External dependencies

A resolved dependency outside the project root is normal, not an error. It arises from an `include` that reaches out of the tree (`../shared/ext.yar`), from an `include_dirs` entry that points at a shared sibling directory, or from a symlink. Such a source is marked external, keeps its canonical absolute path as its identity, is parsed and followed recursively like any other node, and appears in the compilation plan's closure.

Each external node produces one informational `external-dependency` issue so a future Includes view can show what the project depends on. It never blocks compilation.

## Entrypoints

An entrypoint is a top-level source: something the compiler is handed directly rather than reaching through an `include`. Several independent entrypoints are normal.

### Declared

When `entrypoints` is present and non-empty, exactly those files are the entrypoints, in manifest order, and the plan analyses their closure. Files that no declared entrypoint reaches remain in the snapshot with all their problems, but they neither become entrypoints nor block that plan.

A declared entrypoint that is not on disk is reported as an `invalid-configuration` issue and blocks every plan for the project. So is one that is not a regular file, and so is one whose canonical target lies outside the project root: the lexical check on the declaration proves only that the *spelling* stays inside the project, and a symlink can still point out of it. An entrypoint is by definition a file of this project, so unlike a file reached by an `include` it may not be external. The check is on the canonical target, not on the entry being a symlink, so an alias to a file inside the project resolves normally - to the identity of the file the compiler will actually read.

### Inferred

When `entrypoints` is absent or empty, every discovered internal rule file is part of the project and roots are inferred from the graph: a discovered file that nothing includes is a root. Independent files with no includes at all are therefore valid roots, and so is the head of every chain. Inferred roots are sorted by identity.

Every non-excluded discovered file must be a root or reachable from one. A file that is neither can only have been swallowed by a cycle that has no root, and that is reported as `unreachable-source` and makes the inferred project invalid. Rootless cycles are never silently omitted.

## Issues

Every problem is a `ProjectIssue`: a stable machine-readable `IssueKind` with a structured payload, optionally attributed to the source it was found in. Each kind has a stable kebab-case code. A UI maps issues by code and payload; `message()` exists for logs and tooltips and must not be parsed. It never contains source file contents - only paths, include spellings and parser messages.

| Code | Severity | Scope | Meaning |
| --- | --- | --- | --- |
| `invalid-configuration` | blocking | project | A manifest or definition problem found during analysis, typically a declared entrypoint that is not on disk, is not a regular file, or resolves outside the root. Load-time problems are `ConfigError`s instead. |
| `unreadable-directory` | blocking | project | A directory could not be listed, so discovery is incomplete. |
| `discovery-depth-exceeded` | blocking | project | The tree is deeper than the discovery limit, so discovery is incomplete. |
| `unreadable-source` | blocking | source | A graph node exists but its bytes could not be read. |
| `parser-error` | blocking | source | The YARA parser rejected part of a source, with a message and a byte span. |
| `missing-include` | blocking | source | An `include` matched none of its candidates. Carries the spelling, span and candidates searched. |
| `include-cycle` | blocking | source | An `include` chain returns to a file already being expanded. Carries the cycle members, the closing include and its span. |
| `repeated-inclusion` | blocking | source | YARA-X would expand this file more than once for the analysed entrypoints. |
| `unreachable-source` | blocking | project | A discovered file that no inferred root reaches. |
| `external-dependency` | informational | source | A resolved dependency lives outside the project root. |
| `unreadable-entry` | blocking | project | A directory entry could not be inspected or resolved, so discovery is incomplete. |
| `non-unicode-path` | blocking | project | A path that is not valid Unicode, and therefore has no identity. Carries the escaped path, which is for display only. |

New codes are appended to the list rather than inserted, because the order of the underlying `IssueKind` variants is part of the deterministic issue ordering below.

**Severity** answers "can compilation be trusted?". Only external dependencies are informational.

**Scope** answers "which plans does this block?". A project-scoped issue means the analysis itself is incomplete or the configuration is wrong, so no closure can be trusted and every plan is blocked. A source-scoped issue only blocks the plans whose closure contains the file it names. That distinction is what lets an explicit-entrypoint project compile while an unrelated file in the same directory is broken, and it is also why an unreachable source is project-scoped: an unreachable file is by definition outside every closure, so a source-scoped report would be silently ignored. Every discovery failure is project-scoped for the same reason - the entry it names never became a graph node, so no closure can contain it.

Cycles are reported once per back edge, with the members rotated to start at the cycle's lowest identity, so the same cycle always reports identically regardless of where the traversal entered it. The analysis deliberately does not enumerate every simple cycle in a graph: that is exponential, and one report per back edge already identifies the offending include and invalidates the project.

## Repeated inclusion

YARA-X prevents *cycles* using its active include stack, but it does not include each file once globally: `include_stack.contains(...)` only sees the chain currently being expanded. A file reached by two different paths is expanded - and therefore compiled - twice, which duplicates every rule identifier it defines. So repeated inclusion is a real error, not a style problem, and it blocks the plan.

The analysis therefore reports every source that would be expanded more than once for the selected entrypoints. It detects at least:

- two entrypoints sharing a dependency;
- a diamond (A includes B and C, both include D);
- the same file included twice by one source;
- a dependency with indegree one whose only parent is itself reached by several paths.

Expansion counts are propagated in topological order and capped at two. The question is only ever "once, or more than once", so proving it never requires enumerating paths, and the analysis stays bounded on graphs where the number of distinct paths is exponential. `expansions_at_least` is that capped count: it proves repetition, it is not an exact path count.

When the selected closure contains a cycle, expansion counting is skipped: the cycle already invalidates the plan, and counts through a cycle are meaningless.

## Snapshot versus plan

`ProjectSnapshot` describes the project as it is, *including* what is wrong with it. Analysis never refuses to produce one, because the future Includes view has to be able to render a broken graph. It exposes the definition, the discovered files, every graph node, every include edge in `(from, source order)` order, the effective entrypoints and every issue.

`CompilationPlan` is the narrower question of what would be compiled. It is derived from a snapshot by one call, and it contains the ordered canonical entrypoints, the ordered include directories and the complete resolved source closure, each with its identity and canonical path.

Plan construction fails - returning the blocking issues rather than a message - when anything blocking affects the selected closure: any project-scoped issue, or a source-scoped issue naming a file the closure contains. In practice that means missing includes, unreadable inputs, parser errors, cycles and repeated inclusion inside the closure, plus invalid configuration, an unnameable path and incomplete discovery anywhere.

The closure contains each canonical input exactly once, because a plan is a set of inputs. That is not a claim that YARA-X would expand each file once; it would not, which is exactly why repeated inclusion is reported separately and blocks the plan.

Keeping the two apart means a caller can display an invalid graph and a validated plan through the same types, and there is exactly one place that decides "compilable".

## Determinism

Identical inputs produce identical output, including the order of everything:

- discovered files and inferred entrypoints are sorted by identity;
- declared entrypoints and include directories keep their manifest order, which is part of the contract because include resolution stops at the first match;
- edges are sorted by `(from, source order)`, so the edge list does not depend on traversal order;
- issues are sorted by `(source, kind)` and deduplicated, with project-wide issues first;
- cycle members are rotated to a canonical starting point.

This is asserted directly: the same project analysed twice must produce identical discovered files, entrypoints, edges, issue codes and messages, and identical plan rejections.

## The IPC boundary

`app/src-tauri/src/analysis.rs` is the only place the model becomes JSON. The model itself has no `serde` derives, no Tauri dependency and no wire types; the DTOs mirror it and nothing else. So the model's shape can change without breaking `app/src/ipc.ts` by accident, and the wire format cannot quietly pull Tauri into the model.

Seven commands make up the boundary:

| Command | Request | Response |
| --- | --- | --- |
| `analyze_project` | `{ root, subscription }` | `ProjectAnalysis` |
| `compile_scratch` | `{ text }` | `CompileResponse` |
| `compile_project` | `{ root }` | `CompileResponse` |
| `watch_project` | `{ root, subscription }` | `()` |
| `watch_release` | `{ subscription }` | `()` |
| `watch_fence` | `{ subscription }` | `u64` (the fence token) |
| `watch_rearm` | `{ subscription, fence }` | `()` |

All of them run their blocking work - a directory walk, a parse of every rule file, a compilation, installing or dropping native watches - in `spawn_blocking`, so none of them holds the UI thread.

`analyze_project`'s `subscription` is null except when the analysis belongs to the watched project on screen, in which case the same read that renders the views also widens the watch set (see the watching section). The compile's membership query passes null: it must not change what is being watched.

### `ProjectAnalysis`

Tagged by `status`, and the two variants are not two shades of the same thing. `loaded` means a snapshot exists; it may still be full of blocking problems and refuse to compile, which is exactly what the Includes view will have to render. `configurationFailed` means no snapshot can exist at all, because the definition itself could not be built.

```json
{
  "status": "loaded",
  "root": "/home/u/rules",
  "manifest": "quipu.toml",
  "entrypointOrigin": "declared",
  "entrypoints": [{ "external": false, "path": "main.yar" }],
  "discovered": [{ "external": false, "path": "lib.yar" },
                 { "external": false, "path": "main.yar" }],
  "nodes": [{ "id": { "external": false, "path": "lib.yar" }, "readable": true }],
  "edges": [{ "from": { "external": false, "path": "main.yar" },
              "order": 0,
              "raw": "lib.yar",
              "span": { "start": 0, "end": 17 },
              "to": { "external": false, "path": "lib.yar" } }],
  "issues": [{ "code": "missing-include",
               "message": "...",
               "severity": "blocking",
               "scope": "source",
               "at": { "external": false, "path": "main.yar" },
               "span": { "start": 0, "end": 21 } }],
  "compilable": true
}
```

```json
{ "status": "configurationFailed",
  "issue": { "code": "manifest-unsupported-schema", "message": "...",
             "severity": "blocking", "scope": "project", "at": null, "span": null } }
```

`manifest` is an identity (`"quipu.toml"`), not an absolute path, because `root` already supplies the prefix. `entrypointOrigin` is `"declared"` or `"inferred"`. An unresolved include keeps its edge with `to: null`, so a broken graph is still renderable. `compilable` is whether `compilation_plan()` currently succeeds - false means a compile would be refused before YARA-X is invoked.

A configuration failure carries the *specific* code (`manifest-unsupported-schema`, `manifest-invalid-toml`, `root-unavailable`, ...) rather than the generic `invalid-configuration`, because a UI that has to tell the user what to fix needs to know an unsupported schema from an unreadable manifest. `compile_project` reports the same codes for the same failures.

### Two rules the wire keeps

**Identities, not paths.** A `SourceId` crosses as `{ external, path }` and is never flattened into one string: `external` decides what `path` means (root-relative, or canonical absolute), so flattening would make an internal `vendor/lib.yar` and an external source of the same spelling indistinguishable. `root` is the only standalone filesystem-path field on the wire; an identity's `path` is root-relative when internal, and is itself a canonical absolute path when external. So `root` is what turns an *internal* identity back into something openable, while an external one already is:

```
internal: `${analysis.root}/${id.path}`
external: `id.path`
```

**Nothing lossy.** `to_string_lossy` is not used at the boundary. A path with no identity has none here either (see [Paths that are not valid Unicode](#paths-that-are-not-valid-unicode)), and a project *root* that is not representable is reported as a `configurationFailed` carrying `non-unicode-path` rather than sent with replacement characters: substituting them would either lie about the project's identity or silently break the frontend's only way to open a file in it.

## Compiling a project

```text
root -> ProjectDefinition -> ProjectSnapshot -> CompilationPlan -> yara_x::Compiler -> Rules
```

Analysis happens in the backend immediately before compiling, so what is compiled is what is on disk now rather than whatever the frontend last saw. A `PlanRejection` refuses compilation outright: YARA-X is never invoked for a project the model has already found to be broken, because its errors would describe the symptoms of a problem the model can state precisely, and both would land in the Problems pane.

Only the plan's **entrypoints** become compilation units, in plan order. The rest of the closure is deliberately not added: YARA-X expands includes itself, and adding a closure member independently would compile it twice and duplicate every rule identifier it defines. The plan's include directories are passed to the compiler in declared order, because resolution stops at the first match.

### Entrypoint parent-first resolution

No entrypoint is passed to `Compiler::add_source`. Each is compiled through a one-line **synthetic wrapper** whose only content is an absolute `include` of it:

```yara
include "/home/u/rules/main.yar"
```

YARA-X then reaches the entrypoint through `read_included_file`, pushes it onto its include stack, and every include inside it - and inside everything it reaches - resolves parent-first, per entrypoint, exactly as the model says.

This is why entrypoint parents are *not* prepended to the include directory list. One global list shared by every entrypoint would let one entrypoint resolve an include through a different entrypoint's directory, which the model never does. With two entrypoints in different directories both including `"lib.yar"`, that would resolve one file twice and produce a duplicate-rule error instead of two distinct rules.

A wrapper is Quipu's own text and is never shown as a user file. Its origin is `quipu:entrypoint/<n>` - not a path on any platform, so it cannot collide with an origin YARA-X derives from a real file - and any diagnostic carrying it is rewritten to name the entrypoint it stands for, with its line, column and span dropped rather than pointing into a file the user never wrote. In practice this only happens when an entrypoint disappears between analysis and compilation.

**Limitation.** YARA's include filename is a plain string literal with no escape sequences at all: a backslash, a double quote and a newline are all rejected by its tokenizer. A canonical path containing one therefore cannot be expressed as an include, and compiling that entrypoint any other way would use different resolution semantics than the model reported. Such a plan is refused with a structured `unrepresentable-path` diagnostic rather than compiled under different rules. On Windows, separators are rewritten to `/` and the `\\?\` verbatim prefix is stripped, exactly as identities are; a verbatim UNC path (`\\?\UNC\server\share\...`) is rejected, because dropping its prefix would change which host it names. The same diagnostic covers a closure member whose canonical path is not valid Unicode, which YARA-X cannot record as an origin.

### No current-directory fallback

`yara_x::Compiler` holds its include directories as an `Option<Vec<PathBuf>>` and, when that is `None`, resolves includes against the **process working directory** - for Quipu, wherever the user happened to launch it. That would let an include the model reported as missing resolve to an unrelated file with the same name.

There is no public API for setting an empty list, so a plan with no include directories - including an explicit `include_dirs = []` - gets a single unresolvable sentinel directory instead: a path containing a NUL byte, which cannot name a directory on any supported platform. The list is then non-empty, the fallback branch is unreachable, and every candidate under the sentinel fails to canonicalize, including one that tries to climb out with `..`. A merely absent directory would be weaker, since the user could create it.

The seal applies to the scratch buffer too. A scratch buffer has no project, so an `include` in it has no legitimate directory to resolve from and is reported as not found. It does not silently pick up a file from Quipu's launch directory.

`include_dirs = []` does not disable the one search rule that does not come from the configuration: an entrypoint's own directory, which arrives through the wrapper rather than through the include path.

### Empty projects

An empty plan is a valid plan. A project with no rule files - or a directory with files, none of them rules - adds no compilation units and builds an empty ruleset: a **successful compilation with zero rules**. Scan stays enabled and matches nothing, rather than the user having to interpret a failure that is not one. YARA-X allows this; `Compiler::build()` on a compiler with no sources succeeds.

### Failure invalidates the stored ruleset

The compiled ruleset is shared state (`RuleStore`) that Scan reads without recompiling, so a stale ruleset surviving a failed compile would mean scanning rules the user no longer has. The stored ruleset is therefore dropped *before* the work starts and restored only from a successful result. Every exit path lands correctly by construction rather than by each branch remembering to clear:

| Exit path | Result |
| --- | --- |
| Configuration failure (`ConfigError`) | `ok: false` with its specific code; no rules stored |
| Plan rejection | `ok: false` with the model's blocking issues; no rules stored |
| Unrepresentable path | `ok: false` with `unrepresentable-path`; no rules stored |
| A file cannot be read at compile time | `ok: false` with YARA-X's error; no rules stored |
| YARA-X compiler error | `ok: false` with the compiler's diagnostics; no rules stored |
| The blocking task panics or fails to join | The IPC call rejects; no rules stored |
| Successful empty compilation | `ok: true`, zero rules, stored |
| Successful superseded compilation | `ok: false`, no diagnostics, zero rules; its result discarded |
| Successful normal compilation | `ok: true`, stored |

Clearing afterwards instead would leave the old rules scannable whenever the task never returned. `reset_rules` and switching project folders keep their existing behaviour, which is the same invalidation by another route.

### Superseded compilations

Clearing before the work is not enough on its own, because a compile that started *before* an invalidation is still running when it happens. Left alone it would install its result afterwards, handing Scan the rules of the project the user has just closed under the name of the one they have just opened.

So `RuleStore` holds a **generation** beside the rules, under the same mutex - the check and the store have to be one atomic step, or a reset landing between them is lost:

- `begin()` clears the rules, advances the generation, and returns it. Each compile captures the generation it opened.
- `finish(generation, rules)` installs the rules only while that generation is still current, and reports whether it did.
- `reset()` clears the rules and advances the generation, superseding every compile in flight.

A superseded result is *dropped*, not stored - and deliberately not allowed to clear either, because a newer compile may already have installed rules that are perfectly valid. Its diagnostics go with it: they describe a project nothing is asking about, and showing them beside a different one would be worse than showing nothing. `ok` therefore means exactly "a ruleset from *this* compile is stored and Scan can run it", so a frontend that ignored its own bookkeeping still could not enable Scan off a superseded compile.

Scan reads through `with_rules`, which holds the lock for the whole scan because the scanner borrows the `Rules`. An invalidation arriving mid-scan waits, which is the right answer: a scan already under way is scanning the rules it was given, and the invalidation applies from the next one.

The frontend keeps the matching discipline with an **operation token** (`app/src/operations.ts`). A compile spans several awaits - saving documents, re-analysing, compiling - and the user can keep working throughout, so an operation captures three things when it starts, and every await is followed by re-checking all three:

| Captured | Superseded when | Because |
| --- | --- | --- |
| `serial` | a newer operation starts | including a compile of the folder already open, which the project comparison cannot see |
| `project` | the open folder changes | the response describes a project the user has left |
| `revision` | the rules' content changes | the response describes bytes the editor no longer holds |

An obsolete response is dropped whole: it updates no diagnostics, no results, no rule count, no build state, and so cannot enable Scan. Opening another folder while a compile is running therefore leaves the new folder `Not compiled.`

The two halves are not substitutes: the generation stops stale rules becoming scannable, the token stops a stale response claiming the UI. A third piece, the reset barrier below, orders the ruleset resets the frontend asks for against the compiles that follow them. Disabling Open Folder, or Compile, during compilation is not a substitute for any of them.

#### What counts as a content change

`revision` is the one that is easy to get wrong, because a compile *writes files itself* - it auto-saves the dirty documents it is about to compile. Driving invalidation from the workspace's dirty callback would therefore have every compile invalidate itself, since completing a save fires it. So `Workspace` exposes two distinct signals:

- `onDidChangeDirty` - dirty markers and the Save button. Fires for `completeSave()` too. Nothing in the compilation lifecycle is driven from it.
- `onDidChangeContent` - fires only from a Monaco content change on a real model. Not from `completeSave()`, and not from `openFile`/`openScratch`/`renameDoc`, because a model created with its initial value reports no change.

App-controlled project mutations change what would be compiled without any editor content changing, so they invalidate explicitly rather than through the editor. *When* is the load-bearing part, and it is before the write: every mutation supersedes whatever is compiled or compiling as its first synchronous act, ahead of claiming its turn and ahead of raising the fence. The compile's own auto-save is the single exception, because it writes exactly the documents it is about to compile. See "Whose fence it is". **New Rule** and **Rename Rule** additionally invalidate again once they have acted, since they change *which* files the project has and a compile begun inside their fence settled its membership before that.

**Refresh Project** invalidates too, synchronously, the moment it is accepted and before it reads anything. It is the fallback when watching is degraded, where nothing has said the rules changed and nothing will: this Refresh is the only thing that is going to look, and it cannot say in advance whether the disk still holds what was compiled. A Refresh that finds nothing changed then costs a recompile, which is the cheaper of the two mistakes - the other is Scan offered against a ruleset that no longer describes the project. The catch-up that ends a fence and the analysis a coverage notice asks for deliberately do not invalidate: those have already established what the disk holds.

`revision` only ever increases, which is what makes a manual save during a compile harmless: the edit that preceded it already superseded the compile, and no sequence of events can restore a superseded operation.

Invalidation while a compile is in flight does three things at once. The revision bump supersedes the operation, so its response will be dropped. `reset_rules` advances the backend generation, so its result is refused at the store rather than sitting there installed - the backend has no other way to learn that the compile it is running is pointless. And the UI leaves `compiling` for `stale`, which is unscannable and, unlike `compiling`, lets the user compile again straight away. Overlapping compiles are therefore possible by design; the token, the generation and the barrier below are what make them safe, not a disabled button.

#### The reset barrier

Re-enabling Compile the instant a compile is invalidated is what the user wants, and it opens one last race, because dropping the backend's ruleset is an asynchronous call that nobody is made to wait for:

1. compile A is running;
2. an edit supersedes A and requests reset R;
3. the user compiles again straight away - B;
4. B installs its rules under a newer generation;
5. R finally executes and drops them;
6. B comes back `ok: false`, though it was the valid retry.

Firing R off and forgetting it is therefore not enough. `Operations` keeps a **barrier**: every reset the frontend requests is appended to a chain, and a compile awaits that chain - `settle()` - immediately before it invokes the backend compiler, then re-checks its token, because the wait is an await like any other. If the operation went obsolete while it waited, the compiler is not called at all: rules never installed are rules nothing has to undo.

Two properties make the ordering total rather than merely likely:

- **Resets chain, they do not replace.** Two invalidations in quick succession are two resets, and `settle()` waits for both. Tracking only the most recent would leave the earlier one free to execute after a compile had crossed.
- **An obsolete operation may not request one.** `resetFor(op)` tests the token and queues the reset in a single synchronous step, so nothing can start a newer operation between the two. A compile that has crossed the barrier can never find an older compile's failure cleanup queued behind it.

Together those give the guarantee: **once a compile has crossed the barrier, every reset that existed before it has already run, and the only resets that can still run are newer ones.** A newer one superseding that compile is not a bug - it is an edit the user made, and the token and the generation handle it exactly as they did before.

All three places that ask for a reset go through the barrier: invalidation, a failing compile's cleanup, and a folder switch. The folder switch registers its reset *synchronously*, in the same infallible prologue that sets the build state, rather than at its first await - from the moment the UI says `Not compiled` the user can start a compile, and registering any later would let that compile cross a barrier the reset had not joined yet.

A reset that **fails** is not a reset that happened. The barrier remembers the failure and `settle()` rethrows it, so the next compile takes its failure path and reports it rather than compiling on top of rules that may still be installed. A later reset that succeeds clears it, because by then the ruleset is gone whatever went wrong before. Invalidation itself only logs the failure - there is nowhere sensible to show it mid-keystroke - but it cannot be lost, only deferred to the compile that would otherwise be unsafe.

The barrier is frontend ordering, not a new authority. The backend's generation remains the only thing that decides whether a result may be stored; the ordering exists so that a *valid* compile is not failed by a reset belonging to a previous one. Both are tested in `app/src/operations.test.mjs`, against a reset the test opens by hand, so the assertions are about order rather than about timing.

### Project problems in the Problems pane

A user-caused project failure is a normal `CompileResponse` with `ok: false`, not a rejected promise carrying an opaque string. Each blocking issue becomes one diagnostic row preserving the issue's stable code, its message, its source attribution as a canonical openable path, its byte span, and an editor position derived from the named file's own bytes. A zero line means "no position", which the frontend already treats as "open the file, do not jump". Informational issues are not converted: an external dependency belongs to the Includes view, and repeating it as a compile problem would train the user to ignore the pane.

A diagnostic's `line` is 1-based, and its `column` is 1-based **in UTF-16 code units**, because the frontend hands it straight to Monaco, whose positions are UTF-16 offsets into the line. Counting bytes or Rust `char`s would both be wrong: an astral character such as an emoji is one `char` but a surrogate pair, so counting scalar values places every column after it one short and navigation lands early. An offset past the end clamps to the length, and the line's bytes are decoded lossily, so malformed or truncated UTF-8 contributes one unit per replacement character - a slightly imprecise column beats no diagnostic.

YARA-X's own errors and warnings continue through the existing conversion. The origin it reports is mapped back to a canonical path via the plan's closure; both spellings YARA-X can produce are recognised, because it records a file under the process working directory relative to it and anything else absolutely.

Only genuinely unexpected infrastructure failures reject the IPC call - and those invalidate the ruleset too.

### What the frontend does

Compilation has exactly two shapes, and `app/src/main.ts` picks between them on whether a folder is open:

- **No folder:** the live editor text goes to `compile_scratch`. Diagnostics carry no `file`, so they stay on the active editor.
- **Folder open:** dirty documents belonging to that project are saved, then only the root goes to `compile_project`, which re-analyses before compiling.

Membership decides what gets saved. The session's accepted snapshot supplies the starting set, and it is deliberately only a starting set: it describes the disk as it was when it was taken, so any dirty document it does not account for sends the decision to a fresh `analyze_project`, whose graph nodes are what actually settle it. Internal identities are offered under both the analysed canonical root and the root the file dialog gave, since the two can differ through a symlink and only exact keys match. The scratch buffer has nowhere to write to and is never saved; neither is a document left open from a project the user has since switched away from.

#### Membership has to reach a fixpoint

Membership cannot be decided in one pass, because *a save changes the answer*. Add `include "dep.yar"` to a dirty `main.yar` where the on-disk `main.yar` has no such include, and have `dep.yar` open and dirty too. The graph analysed before any save does not contain `dep.yar`, so a single pass writes `main.yar`, skips `dep.yar`, and the backend's own re-analysis then discovers the new include and compiles `dep.yar`'s **stale disk contents**.

So the save step runs bounded save-and-reanalyse waves (`app/src/saveplan.ts`):

1. Write the dirty documents already known to belong to the project.
2. Re-analyse, which now sees the includes those writes introduced.
3. Write any further dirty open documents the new graph brings in.
4. Repeat only while a wave actually wrote something and something is still unwritten.

Each document is written at most once per compile, and the candidate set is the finite set of dirty open documents, so the loop runs at most `dirty.length + 1` waves. In the common case where the explorer list already accounts for every dirty document, no analysis happens at all. The frontend's operation token is honoured throughout, so switching folders stops the remaining writes. The backend still performs its own fresh analysis after all of this: the waves exist to make the *editor contents* current on disk, not to tell the backend what to compile.

The decision lives in `saveplan.ts` rather than `main.ts`, with the filesystem and the analysis behind an interface, so it can be tested without a running application - `app/src/saveplan.test.mjs`, run by `npm test` on Node's built-in test runner, adds no dependency.

#### A write the plan was not allowed to make

Each write reports what became of it, because a write can be declined without anything having failed: the file changed on disk after the user was asked about it (see "Ordering Quipu's own mutations"), or the document the plan named is no longer open at that path. So the callback answers `written`, `unchanged` or `refused`, and the three are not interchangeable. `unchanged` is a document the disk already holds - the user's own Save, queued ahead of this plan, is the ordinary way that happens - and the plan moves on. `refused` ends the plan where it stands and is passed back to the caller with the reason; the writes already made stand, since they were the user's own editor contents.

A refusal has to abort the compile, not merely be counted. The document the compile was going to write is not on disk, so compiling the root would compile somebody else's version of it and then offer Scan against the result. The compile therefore reports the reason - "... changed on disk, so nothing was compiled. Save it, or Reload from Disk, and compile again." - and never reaches the compiler at all. A plan cut short because the operation was **superseded** is not a refusal and is not reported: the user has opened another folder or started a newer compile, and that is quiet cancellation like any other.

#### A membership analysis that fails is not an empty project

A `configurationFailed` analysis is an *answer*: this project has no graph, and the compile is about to report the same error with the code that explains it. Membership is legitimately empty.

A **rejected** `analyze_project` is something else entirely. Every user-caused configuration problem is a successful structured response, so a rejection can only be an infrastructure failure: a panicking backend, or IPC itself. Treating it as "no members" would skip the dirty nested and external dependencies the answer would have named, then compile anyway - and if the backend's own analysis happened to succeed, the user would get a green compile of those dependencies' stale disk contents. So it is not caught. It propagates out of the save step, the compile takes its normal failure path, the ruleset is invalidated, and the failure is shown in the Problems pane with Scan disabled.

#### Leaving the project that is open

Opening another folder and closing the workspace are the same transition, so they are one shared step rather than two similar ones (`leaveProject` in `app/src/main.ts`): everything on screen that described a project the app is no longer in belongs to nobody, and it all goes at once - the views, the results and diagnostics, the rule count, the build state, and the project's **documents**.

The documents are the part that is easy to leave behind. A file still open from a project that is not open any more is an editor model with a path: the explorer would list it as dirty, the next compile's save plan would consider it a candidate, and a save of it would write into a folder the user has left. So each one is announced to the LSP as closed and its model disposed, exactly as Close Workspace already did. A switch is not a gentler event than a close, and re-selecting the folder already open is a switch too - its files are re-read from disk, and answering from the models the previous selection created would be a different project's contents wearing the new selection's identity.

Work that would be lost is prompted for **first**: before the session, the operation token, the reset barrier, the views or the models have been touched. That is not quite the same set as the dirty documents. A document whose file was deleted or renamed away underneath it holds no unsaved edits - nobody edited it - and its text is the last copy of that file anywhere, so it is named too, as "not on disk" rather than "unsaved": calling it unsaved would be untrue of it, and leaving it out would discard it without a word. A clean document whose file merely changed is deliberately *not* named, because the disk has a version of its own and nothing would be lost; asking about it would teach the user to click through the question. Cancelling therefore has nothing to undo - the project, its editor, its models, its views and any compile in flight are all exactly as they were, and no analysis was ever asked for. The question is a native dialogue and therefore an **await**, so the answer is re-checked against the gesture, the project and the at-risk set it was given about before the prologue runs: see "Confirming a destructive step". For a folder switch it comes *after* the picker rather than before: dismissing the picker is not a decision about unsaved work, and asking first would put a dialogue in front of a user who was only looking.

The documents are closed inside the infallible prologue, not after the first await, for the same reason the reset is queued there. An analysis or a file read still in flight would otherwise re-open a document that is about to be closed; and if the new project's own analysis then fails, nothing may be left visible or open from the project before it.

#### Opening a folder or an example

There are two ways in - File > Open Folder and File > Open Example - and they differ only in how a root is obtained: a native directory picker, or a packaged example copied into an editable working copy. From the moment there is a root they are the same code (`enterProject` in `app/src/main.ts`), because a second implementation would be a second set of guarantees, and the ordering below is the whole reason the guarantees hold. An example additionally brings its sample scan target, installed inside the infallible prologue so that it lands only for the request that actually opens.

The order matters, because everything after the directory is chosen can fail. Once the selection is accepted - the picker has returned a directory, and any unsaved work has been agreed to - every step that *cannot* fail runs first: the project changes, anything in flight is superseded, the ruleset reset is queued on the barrier, the previous project's documents are closed, results and diagnostics are cleared, and the build state becomes `not-compiled`. Only then is a fallible await reached, and the queued reset is the first of them - a compile of the project just left may be moments from installing its rules, and advancing the generation is the only thing that stops it. It is awaited there to report a failure; its *ordering* against any later compile was settled the moment it was queued.

The selection also gets an identity of its own, taken in the same prologue and checked after every fallible await before anything shared is written. Analysing a project and reading a file are slow, and the user can choose another folder while either is outstanding; without the check, folder A's analysis could hand folder B its file tree, A's first source could open in B's editor, and A's failure could clear B's views and claim B's Problems pane. Results stay in local variables until the check has passed. Selections are **counted**, not compared by path, because re-opening the folder already open must supersede too. It is deliberately not the operation token: a compile of the folder now open may legitimately start while it is still being analysed, and one shared counter would have each cancel the other.

Analysing the folder is allowed to fail. When it does, the user gets a project whose views say the folder could not be analysed and the error in the Problems pane; Scan is already disabled and nothing is stuck in `compiling`, because the build state was set before any of it ran. Doing this in the other order - load the folder, then reset - is what could leave the window showing the previous project as still compiling, with its rules still installed.

#### Ordering the requests to open a project

Both entry points begin with an await the current project has to survive, and neither may touch the session before it has an answer: a project is not abandoned for a picker the user might dismiss, or for a copy that might fail. So between the gesture and the switch there is a window in which the user can make another gesture, and nothing about the two answers says which was asked for first - a dismissed picker still returns a path, and a slow first copy of an example still returns a root. Whichever landed last would win, and the project chosen last would lose to whichever piece of I/O happened to be slower.

`OpenRequests` (`app/src/opening.ts`) counts the gestures instead. A request is claimed synchronously, before the picker is shown or the copy is started, and only the newest one may go on to open anything. An older request landing afterwards opens nothing, preloads no target, and does not report its failure either: the chooser and the Problems pane belong to what the user is doing now. An accepted Close Workspace supersedes every pending request for the same reason - the user has said what they want the window to be showing - while a cancelled one leaves them alone, because nothing was abandoned.

It is a generation of its own, deliberately not one of the others. The frontend keeps several, because they answer different questions and each has to be able to supersede without cancelling the rest: the compilation operation (which ruleset), the session's counted selection (which folder), navigation's gesture and activation counts (which document), the pending-open count here (which open request), and target selection below (which bytes to scan). A pending open is not an operation on the ruleset, since it has not yet decided to abandon anything, so superseding one must not supersede a compile of the project still open; and it must not be superseded by the user clicking around in the editor, which is what navigation's gesture count is for. The session's counted selection cannot serve either, because advancing it to reserve a request would abandon the current project before the request had earned it. The mechanism has no DOM, no IPC and no session, and the ordering is tested directly (`app/src/opening.test.mjs`).

The same identity answers a second question: whether the project now open is still performing its *initial* analysis. New Rule is unavailable while it is. Creating a rule re-analyses the project and opens the new document, both of which an outstanding initial analysis would then undo - its snapshot replaces the tree the new file was just added to, and its auto-open takes the editor back. So the loading state is set in that same synchronous prologue, and cleared in a `finally` **only if the analysis is still current**: a superseded analysis's cleanup announcing the newer one as finished would put the command straight back into the race. The disabled toolbar button and the `canCreateRule` menu flag are the visible half; the guard inside the command is the half that holds, because the native menu's state is pushed over IPC and an accelerator can fire before it lands. A later refresh does not gate the command, because by then the project is fully known. Compile is deliberately *not* gated either way - the backend reads the directory itself, so compiling a folder whose explorer has not caught up is valid, and the reset barrier already orders it against the load's own reset.

#### Ordering the scan target

Choosing a file to scan is two awaits long - the native file dialogue, and then reading the bytes - and both are long enough for the user to say something newer. They can pick a different file, open an example (which brings its own sample target, installed in the prologue above), or type the bytes into the target textarea themselves. Installing the older file when its read finally lands would replace the newer choice with the one they had already moved on from, purely because that file was slower to read.

`TargetRequests` (`app/src/targets.ts`) counts those statements. The count is claimed synchronously, before the dialogue is shown, and re-checked after the dialogue and again after the read; a gesture that is no longer the newest installs nothing and reports nothing - a failed read of a file the user is not waiting for would otherwise talk over whatever the newer gesture has to say about the file they are. Asking for the dialogue is itself the gesture, so an older choice is superseded even if the newer dialogue is then cancelled: the user has said they are choosing again. Installing a target and typing into the textarea both supersede as well, the first because an example's sample target is a newer statement than any read in flight, and the second because typing is the user saying what to scan - which has to hold even when no file target is installed, since that is the only state the textarea can be typed into.

This is the fifth generation and shares nothing with the other four. The scan target is not part of a project: closing a workspace does not clear it, opening a folder does not take a chosen file away, and a compile of the project it will be scanned against says nothing about which bytes those are. The coordinator has no DOM and no IPC - the dialogue, the read, the presentation and the failure reporting are the host's - and the ordering is tested directly against dialogues and reads the test resolves by hand (`app/src/targets.test.mjs`).

### The frontend's project session

`app/src/project.ts` holds one object, `ProjectSession`, that owns everything about the open project: the root as the folder picker supplied it, the selection identity described above, the most recently accepted `ProjectAnalysis`, whether an initial analysis or a refresh is outstanding, whether the accepted snapshot may be out of date, and any infrastructure failure. It has no DOM and no IPC - analyses are handed to it - so the ordering rules below are tested directly (`app/src/project.test.mjs`).

An explicit phase (`closed`, `opening`, `ready`, `failed`) replaces the nullable globals the frontend used to keep, because the states that matter are not distinguishable by "is the path null". In particular a `configurationFailed` analysis is a **loaded project**: it has a root, it has an issue explaining why it has no graph, and its views must say so. It is not a failure of the call, and it is not an empty project.

Three ordering rules, all of them enforced by the session rather than by its callers:

- A newer selection supersedes every analysis, refresh and auto-open of an older one, including a re-selection of the folder already open.
- Refreshes carry an increasing order, and an accepted answer records it, so a slow refresh cannot overwrite a newer one that has already landed.
- A failure is accepted only for the current selection, and a failed *refresh* leaves the accepted snapshot in place: what is on screen is still the best answer available, so the status line says both that it is older and that the attempt to replace it failed.

### Staleness and refresh

The project's structure is re-read after the events that can change it: opening a folder, a relevant change reported by the watcher, File > Refresh Project, and every app-owned mutation - New Rule, Rename Rule, an explicit save and the compile's auto-save alike, all of which get their re-read from the catch-up that ends their fence rather than each asking for one of their own. It is deliberately *not* re-read per keystroke. Typing `include "dep.yar"` does change the project, but analysing on every character would ask the backend to read the directory that often and would answer from a file whose new include is not on disk yet. So an edit marks the snapshot stale and the status line says what refreshes it. An edit while an analysis is in flight marks the answer stale on arrival rather than discarding it.

The status line distinguishes the two reasons a snapshot can be stale, because they need opposite things from the user. An edit says "Save or Refresh": nothing will happen until they act. A watcher notice says "changes detected, updating...": an analysis is already coming, and the right response is to wait. Refresh Project remains immediate in both cases, and is the whole mechanism when watching is degraded.

## Watching the project

A change made outside Quipu - a colleague's `git pull`, a shared include edited in another editor, a dependency dropped into place - has to reach the views without the user having to know that Quipu needs telling. The mechanism is the `notify` crate, used directly behind a narrow interface in `app/src-tauri/src/watch/`, with the ordering rules in `app/src/watching.ts`. The general Tauri filesystem plugin is deliberately absent: the webview gets no filesystem permissions of its own, and the event that reaches it carries a subscription number and at most a handful of paths - never file contents.

### Events are hints; the analysis is authoritative

Nothing about a filesystem event is trusted beyond "something under this project may have changed". There is no incremental graph engine, no attempt to work out which nodes an event invalidates, and no attempt to reconstruct the change from the event kind. The response to any relevant event is the existing full `analyze_project`, which is the only account of what the project contains. This is what keeps the watcher from being a second, subtly different project model that can drift from the first.

Consequently the watch plan may be over-broad and never under-broad. A spurious extra analysis costs a directory walk; a missed one leaves the user looking at something untrue.

### What is watched

`WatchPlan` (`app/src-tauri/src/watch/plan.rs`) is derived by the backend from a `ProjectSnapshot` and its structured include-resolution data. The frontend supplies a subscription number and nothing else - it cannot hand over a list of paths to watch. The plan covers:

- the canonical project root, recursively. That alone catches every internal rule file, every internal include, `quipu.toml` being created, removed or replaced, and files appearing in directories that did not exist when the project was opened.
- each discovered rule file and each included file, whatever its extension.
- each external dependency, and each configured external include directory.
- each **candidate** location that could change how an include resolves.

The candidates are the load-bearing part, and they come from the same calculation the resolver uses rather than a second one written for the watcher - which is also why nothing parses issue messages to recover paths. Two cases matter. An include that resolves to nothing today will resolve to something the moment a file appears at one of its candidates, so those candidates are watched even though no file is there. And an include that *does* resolve today resolves through the first candidate that exists, so every candidate the resolver considered *before* the one it settled on is watched too: a file appearing at an earlier candidate shadows the current target and silently changes what compiles.

### Why external files are watched through their parent directory

An external source is watched by watching its parent directory non-recursively, not by watching the file. Watching an inode is exactly the wrong granularity for how editors save: an atomic save writes a temporary file and renames it over the target, so the inode the watcher holds is orphaned and every subsequent change to that path goes unreported. The same applies to the file being renamed away or deleted. Watching the parent sees all three as directory events.

Where the candidate itself does not exist - `../shared/dep.yar` under a `shared` directory nobody has created yet - the nearest existing ancestor is watched instead. So creating the missing subtree, or atomically moving it into place, is observed. What is deliberately *not* done is recursively watching a broad external directory when the exact parents suffice: recursing a home directory or a monorepo root to notice one dependency is a large amount of kernel state and a large amount of noise for something an exact parent already answers.

The plan is deduplicated and deterministically ordered, and paths stay as native `PathBuf`s throughout. A project containing a non-Unicode path is unusual, but making it unwatchable - or lossily watchable - merely because the watcher wanted a `String` would be a poor trade.

### What is ignored

Access-only events are dropped: reading a file changes nothing. An ordinary content modification to a file the snapshot knows about but the compilation does not consume - a README, an example scan target - does not invalidate the rules. Directory topology changes and ambiguous remove/rename events go the other way and are treated as relevant, because the cheap answer to "this might have changed the include graph" is to re-analyse.

A failure to install an auxiliary watch never brings down the root watch. Otherwise a project whose `quipu.toml` names a directory that does not exist would be unwatchable precisely while the user is editing the manifest to fix it, and editing that manifest is the thing that has to recover automatically. What such a failure does do is leave the coverage that was installed narrower than the coverage the plan asked for, and those are kept as separate facts rather than rounded off into one; see "Requested coverage and installed coverage" below.

### Subscriptions

Every subscription has a counted identity. Opening a project takes a new one even when it is the same path as before, switching or closing withdraws the old one synchronously as far as the frontend is concerned, and everything that arrives afterwards carrying the old number is inert: change notices, watcher errors, setup results, the analyses those notices asked for, and the document reads those analyses issued. A late error from a project the user has left must not appear against the project they are looking at, and the previous project's owed work must not be mistaken for the new project's.

Watching starts on the canonical root, recursively, *before* the initial analysis begins. That ordering is the point: a change that lands while the first analysis is reading the disk cannot be part of its answer, and starting the watch afterwards would lose it silently until something else happened to touch the project. Once a snapshot exists, the watch set is widened from that same snapshot - the analysis that renders the views is the analysis the plan comes from, so there is no second read to disagree with.

### Debounce and the trailing analysis

`AutoRefresh` (`app/src/watching.ts`) holds the ordering, with its timer and every host operation injected, so the rules are tested directly rather than observed to usually hold (`app/src/watching.test.mjs`, `app/src/watchflow.test.mjs`).

The first relevant event of a burst does two things immediately, ahead of any timer: it marks the snapshot stale, and it invalidates the compilation and supersedes any compile in flight. Waiting out the debounce window first would leave Scan offered for a ruleset that has already stopped describing the project, which is the one outcome worth ruling out synchronously.

The analysis itself is debounced. A `git checkout` produces hundreds of events and needs one analysis. The window is measured from the *first* event of the burst and is never re-armed, because a window that restarted on every event would be postponed indefinitely by a program writing continuously into the project - which is exactly when the views are most wrong. Later events in the burst still invalidate, every time: a compile that started *during* the burst is only in flight after the first event.

While an automatic analysis is running, further events request exactly one **trailing** analysis, which starts when the current one finishes and takes no second window. Events that arrive during an analysis cannot be in its answer, so they are never dropped merely because they were unlucky in their timing; and however many arrive, there is one trailing analysis, so a repeated burst cannot open an unbounded number of concurrent ones. A trailing analysis is still owed after a failed one - the events that asked for it described a project that has changed since the read that failed.

An automatic analysis that fails follows the existing failed-refresh rule: the previous snapshot stays on screen, marked stale, and the failure is reported beside it. An automatic refresh beginning does not clear the compile diagnostics already on screen; they describe a compilation that really happened.

### Quipu's own writes: the native watcher fence

Save, the compile's auto-save, New Rule and Rename Rule all change the filesystem, and the watcher reports them like anything else. Left alone, that would mean a redundant analysis after every save, a compile invalidated by its own auto-save, a ruleset reset queued for no reason, and - worst - an "external change" conflict raised against Quipu's own write.

The fix is not a timeout or an "ignore the next event" flag; both are guesses about scheduling that fail under load, which is when they matter. Instead the watcher is **fenced**. Before an app-owned mutation the live native instance is retired: its gate - an `AtomicBool` shared with the callback - is closed, and the watcher is dropped.

What that guarantees is worth stating exactly, because the obvious stronger claim is false. Dropping a `notify` watcher does **not** join its thread: `INotifyWatcher::drop` signals the thread and returns, so a callback can still be running when `watch_fence` returns. The closed gate is the guarantee. Every callback consults the gate before it does anything, so a callback already in flight either reported its event before the gate closed - describing the disk as it was before the mutation, which is a legitimate thing to report - or finds the gate closed and reports nothing. And a write that *begins* after `watch_fence` returns cannot have produced an event yet, so nothing about it can be reported by anybody. That is all the fence needs, and it is what the tests assert.

Fences are counted rather than Boolean, because app-owned mutations overlap: a compile's auto-save can be under way while a rename is still writing. The writes themselves take turns (see "Ordering Quipu's own mutations"), but the fence is taken when the mutation is asked for rather than when its turn comes, so a mutation still waiting already holds one and two are genuinely outstanding at once. `watch_fence` returns a **token** from a counter that never goes backwards, and the registry holds the set of tokens outstanding. Only the release of the last one re-arms; a token the registry does not hold - a duplicate release, one whose project has been left, or the `0` a superseded subscription is given - lifts nothing. A counter that reissued released numbers would eventually hand a live fence's token to a new mutation, whose release would then lift somebody else's fence.

Re-arming is a **handoff**, not a stop and start. The replacement is armed first and only then is the instance it replaces retired, so an event during the changeover reaches both instances rather than neither and the frontend's debounce collapses the duplicate. The other order leaves an interval covered by nothing, where an event is not late but gone. A plan that is already armed under the current subscription is left exactly as it is: nothing is replaced, and nothing is announced.

The fence also has to compose with an analysis landing inside it, so a plan update that arrives while fenced is stored without being armed, and the re-arm installs whatever plan is stored. Either interleaving ends with the newest plan armed exactly once.

Re-arming is the one part that can fail after the write has already succeeded. It is reported as watcher degradation and nothing else: the write happened, so the document is clean and the user is not asked to do it again. Reporting a successful save as failed - and having the user save again - would be strictly worse than losing automatic refresh until the next project open. A handoff that cannot arm keeps the coverage already in place rather than ending up with none.

Taking the fence can fail too, before the write rather than after it, and it is degradation on the same terms: the write goes ahead, because refusing to save over a misbehaving watcher is the worse answer. What such a rejection cannot say is whether the fence went up. If it did not, this write may come back as an external change, which costs a redundant refresh. If it did and the answer was lost on the way back, the token went with the answer - no release will ever lift that fence, so the project is watched by nobody until it is re-opened, which clears the outstanding fences along with the subscription. Since the two cases are indistinguishable to the caller, the degradation is reported as one nothing can place; the identity a failure carries, and what that buys, is the subject of the next section.

#### Whose fence it is

What survives a fence is a different question from what happens inside one, and it is decided before the interval opens. Nothing is watching in there, so nothing reports it, and the catch-up that ends it reads the disk rather than being told - which is why the catch-up invalidates nothing, or Quipu's own save would cost the user their compile. That is only safe if the mutation has already answered for the interval it is about to open, and only one kind of mutation may answer no.

So a fence has an owner (`FenceOwner` in `app/src/main.ts`). A compile's auto-save owns its own fence and leaves the compilation standing: it writes exactly the documents it is about to compile, and superseding itself would mean no compile ever finished. Every other mutation writes files the compiler reads on somebody else's behalf, so it supersedes whatever is compiled or compiling first. Without that, a Save that re-creates a file a compile in flight analysed the *absence* of would leave that compile current across the interval - the write is reported to nobody, the catch-up invalidates nothing, and Scan would be offered against rules built before the file existed. A mutation that then decides to write nothing has cost a recompile, which is the cheaper of the two mistakes.

Answering for the interval is not answering for what starts inside it. A compile begun after the fence went up gets an operation of its own and is deliberately not superseded by it: a Save's write is queued behind that compile's own save plan, whose pre-write read re-decides the document anyway. New Rule and Rename Rule are the exception to the exception - they change which files the project *has*, and such a compile's membership was settled before that - so those two supersede again after they have acted.

### The catch-up that ends a fence

A fence is a deliberate blind interval, and an external change can land in it. Nothing reports that interval - the registry emits nothing on the way out, because the caller fenced a stretch of its own work and only it knows what it did in there - so closing it is the caller's, and `main.ts` does it in one place. Every app-owned mutation runs inside `fenced()`, which takes the token, counts itself in, and on the way out awaits its own release and then, **if it was the last mutating frame out**, reconciles every open document and re-reads the project. Changes made after the re-arm are the watcher's; changes made during the interval are the catch-up's; between them nothing is unaccounted for.

The order matters twice over. The re-arm comes before the catch-up, or the read and the re-arm would leave a second blind interval between them. And the catch-up runs once for the whole interval rather than once per mutation, which is what makes a multi-file auto-save cost one analysis rather than one per file.

"Last out" is counted **per subscription**, not once for the window, because a mutation can outlive the project it belongs to: a save whose write is still in flight when the user opens another folder stays outstanding until it finishes. A single count would let that abandoned mutation stand in the way of the current project's catch-up - the new project's own mutation would not be the last one out, so it would owe nothing - and the abandoned one cannot perform the catch-up either, its subscription no longer being the one on screen. The result would be a New Rule or a Rename whose file never reaches the project model at all, those two commands having no other source of a refresh. So each subscription counts its own mutations, and only its own last one out reconciles and re-reads.

This is also what lets a compile survive its own auto-save. The catch-up's analysis is not an event: it does not invalidate the compilation, and reconciling documents Quipu itself just wrote yields "nothing changed" for each, because `completeSave` recorded exactly what went to disk. An unrelated edit to another open document in the same interval is found by the same read and shown - reloaded if that document is clean, marked as a conflict if it is not. A save plan with nothing to write does not fence at all, so it owes no catch-up.

Because waiting for its turn and raising the fence are both `await`s, every command re-checks what it is about to act on **after** both and before it mutates anything: Save re-checks the project selection it captured, and New Rule and Rename Rule do the same. A command whose project the user left during that wait writes nothing at all - and still releases the fence it took, and gives up its turn. The compile's save plan keeps its operation token for the same reason. The rest of what has to be re-checked there is in "Ordering Quipu's own mutations" below.

One last ordering closes the initial window. The first watch covers only the project root, and the wider plan is derived from an analysis - so the first read of an external dependency necessarily happens before anything is watching it, and a change in between is covered by neither the snapshot nor the watcher. Installing a wider plan therefore emits a notice, naming what is newly watched and stating whether an analysis is owed. It is not a claim that anything changed. That analysis reads the same disk and derives the plan already armed, so the next handoff owes nothing and the sequence terminates. Which notice it is depends on whether the whole requested plan went in: `covered` when it did, `partial` when part of it could not be watched at all. Every arm emits one, including the arm that ends a fence and one that owes no analysis at all, because the notice is also what tells the frontend which native instance is delivering now - see "An error from an instance that has been replaced". Both carry the debt as a field of their own, because completing a plan and owing an analysis are two different answers - a handoff can complete a plan by keeping coverage that was already being delivered, and then nothing was read unwatched. Neither invalidates the compilation - a save's own analysis can widen the plan, and invalidating there would cost the user their compile for nothing - and the difference between the two is the subject of the next section.

### Ordering Quipu's own mutations

Save, the compile's auto-save, New Rule and Rename Rule are separate gestures, and nothing about the window stops two of them being in flight at once: Save stays enabled while its write is pending and its accelerator can fire twice, a compile auto-saves whatever is dirty whenever it is pressed, and a rename is a separate gesture again. Overlapping, they decide the disk between them by completion order - two writes to one path leave whichever finished last, and a save that overlaps a rename re-creates the path the rename has just emptied. Bookkeeping afterwards cannot repair that. `completeSave` can decline to mark a document clean, but it cannot take a write back.

So they take turns. `app/src/mutations.ts` is a single FIFO queue, and `fenced()` claims a turn from it **synchronously**, before anything is awaited: the point is that the order of the writes is the order of the gestures, and every await between a gesture and its write is a chance for two mutations to change places. The turn is given up in the same `finally` that releases the fence, and deliberately before it - the queue serialises writes, not the re-arm and the catch-up analysis that end a fence, which are reads and can overlap the next mutation's write without harm. A mutation that throws still gives up its turn, because losing the queue to one failed write would strand every later write for the lifetime of the window.

One queue, not one per path or per project. Which paths a mutation touches is not always known before it runs - the compile's auto-save discovers members as it writes, and a rename touches two paths at once - so a per-path queue would have to be claimed from inside the mutation, which is precisely where the ordering has already been lost. Mutations are short and few; serialising all of them costs a little latency and removes the class of races entirely.

What the queue does not do is decide whether the mutation still makes sense when its turn comes, and by then it may not: the document may have been closed, renamed onto another path, or already written by the mutation in front of it, and the project may not be open any more. Each command therefore re-checks its own subject on the far side of the wait, and writes nothing rather than guessing:

- **the project, and the operation.** `stillSelected` for Save, `session.isCurrent` for New Rule and Rename Rule, and the operation token for the compile's save plan. A queued mutation whose folder the user has switched away from writes nothing at all. The compile's plan tests its token once more between the pre-write read below and the write itself, because that read is an await like any other: an edit or a Refresh during it supersedes the compile, its captured snapshot becomes a revision nobody is asking to have written, and the write is the step that cannot be taken back. It stops there in silence - a superseded operation is quiet cancellation, not a refusal to report.
- **the document's identity.** Save re-checks `workspace.holds(snapshot)`, so a save queued behind a rename that re-created its model under a new key is abandoned instead of writing the path the document no longer has. The compile's plan captures each document only when its own turn comes, and `beginSave` returning `null` is the same check - a refusal there, because a compile cannot proceed without the document it was going to write. In practice a rename or a project switch has also superseded the compile by then, so what the user sees is the quiet cancellation; the refusal is what keeps a compile that somehow outlived its document from claiming to have compiled it.
- **the path.** Rename re-checks that the accepted snapshot still has an internal source at the path it was going to move, so a rename queued behind another mutation cannot move a file the project no longer has - or one that has become external, which Rename never offers.
- **what the user confirmed.** Overwriting a conflict is confirmed once, before any write, and the answer is re-checked when the turn comes (`stillConfirmed`): if that document's answer about its file has moved since, the write is abandoned rather than carried out on the answer to a different question. Deliberately without asking again - a modal in the middle of a queue of writes would ask about work the user has already moved on from. A key the dialogue never mentioned is held to having no conflict, which fails safe in the same direction.

  What is recorded is not the conflict alone. "It changed on disk" is an answer, not an identity: a file changed twice while a write queued gives that same answer both times, so an authorisation given for the first version would carry straight over to the second. What a confirmation records is therefore the whole of `diskAnswer` - the conflict, **which observation of the file it was**, and **how many times the document has taken the file's version** - and what the turn re-checks is those two counts, never the conflict kind. See "Reconciling open documents" for the counts themselves.

  The kind is left out because what revokes an authorisation is somebody else having been at the file, or the user having withdrawn the revision that was going to be written; a conflict that has merely been *resolved* since the gesture is neither, and it gets resolved in two ways that differ. Quipu's **own earlier save** - the user's first Save, with a second queued behind it - leaves the file holding Quipu's text, which is what the gesture asked for, so the queued write still means what it meant and goes on to write its own revision after revalidating against the disk. **Reload from Disk** takes the file's version instead, discarding exactly the revision the queued write captured, so the authorisation goes with it. The observations answer the first half - a completed save deliberately advances none, or a save would revoke the permission given to the mutation queued behind it - and the reload count answers the half the observations cannot: a reload changes what the *document* holds without being news about the file, and may find the file holding a version already observed.

- **what the file holds now.** The last check before a write, and the only one that goes to the disk. From the moment a mutation claims its turn the watcher is fenced, so an external edit made wholly inside that interval reaches no read, contradicts no check, and would be silently overwritten - and the catch-up after the write would then see only Quipu's replacement. So every write re-reads the file it is about to replace, immediately before writing it, and hands the answer through the ordinary reconciliation: an edit found there becomes a conflict like any other and the confirmation re-check refuses, with no second dialogue. One read per write is the cost, and it closes the whole queued and fenced interval, which is the one that can be arbitrarily long. The last gap - between that read and the write itself - is not closed by reading later, since two IPC operations have an interval between them however short it is. It is closed by the write, which is conditional on the version the read found: see "A save is conditional on the version it replaces".

  What the check turns on is the read's **outcome**, not the fact of having read. Reads of one file overlap, and reconciliation answers a read that a later one has already answered with `stale`: nothing is recorded, so such a read revalidates nothing, and treating it as a successful pre-write read would authorise the write on the strength of the older answer instead - which is exactly the answer this read exists to supersede. A stale outcome therefore asks again from a fresh probe, at most a small fixed number of times, and a check that never gets an answer of its own refuses. Bounded rather than persistent: a refusal writes nothing and says so, and the gesture can be repeated, whereas retrying until a read is not overtaken would turn a program writing into the project continuously into an unbounded wait.

  And the answer has three shapes, not two: `writable`, `unchanged`, `refused`. `unchanged` is the read finding the file already holding **exactly the revision this write would put there** - somebody else wrote it while the mutation queued - so the document is clean again, there is nothing to write, and nothing for a compile to be refused over: what the compiler will read is what the editor holds. The comparison is against the write's captured text and not merely against the model, because a document edited since the gesture also reconciles cleanly when the file catches up with the *newer* revision, and writing the older one would undo that edit behind the user's back. A refusal stays a refusal: a version that is neither what the user confirmed nor what this write holds is not written, and a compile that would have written it does not run.

The queue's own behaviour is tested directly in `app/src/mutations.test.mjs`. What ends up **on disk** is tested in `app/src/watchflow.test.mjs`, with each write held and released explicitly so that both completion orders are reachable: a second Save of one document leaves the second text and a correctly clean document; a Save cannot re-create the path a later Rename has emptied; a Rename followed by an obsolete Save does not write the abandoned path; the compile's auto-save and a manual Save are never both writing one document; a queued mutation whose project the user left writes nothing; a queued write whose document acquired a conflict while it waited is abandoned; and a gesture made while a previous mutation's catch-up is still reading writes straight away, the turn having been given up ahead of it.

The version a write was authorised for is tested there too, in both directions and for a manual Save and a compile's auto-save alike: a second external version observed while the write queues is not overwritten even though it is the same conflict as the first, and an external edit made wholly inside the queued interval - reported to nobody, with no read in flight to find it - survives, having been found by the write's own read of the file. In the compile's case each of those ends with no compile request, no Scan and the reason on screen. The pre-write read being *overtaken* is a case of its own, driven by holding two reads of one file open and answering the later one first: the write asks again rather than proceeding on the answer it did not get, finds the change the fresh read records, and writes nothing - and the compile's auto-save refuses on the same footing. The opposite finding has its own pair as well: an external write of exactly the editor's text leaves a manual Save nothing to do and the document clean, and leaves a compile with a document that is accounted for, so it compiles rather than aborting.

The last gap of all - a version landing after the pre-write read has answered and before the write - is driven from the same harness, with the write held open and the file changed underneath it: the conditional save refuses, the manual Save leaves the competing version exactly as it found it, and the compile whose auto-save was refused there compiles nothing and says which document it was. A compile *superseded* while that read was in flight is the quiet case beside it, and is held with the read itself open: the edit lands, the plan stops without writing, and nothing is reported.

Two writes authorised by one conflict are tested from both transitions, which is the point of separating them. A second Save queued behind the Save that resolved the conflict goes ahead and writes its own revision - the file holds Quipu's text, which is what was asked for - while a Save queued behind a **Reload from Disk** that resolved the same conflict writes nothing, the revision it captured being the one the user discarded. The compile's side of it is covered too: a compile queued behind the Save that resolved the conflict finds nothing left to write and compiles what is actually on disk, and a revision typed during that Save is not compiled as though it had been written.

Serialising the writes deliberately does not serialise the **fences**. `fenced()` requests its fence at claim time rather than after its turn, so a mutation still waiting already holds one, and two tokens are genuinely outstanding at once - exactly the overlap the counted registry exists for. The counted token protocol is therefore load-bearing rather than merely defensive, and it is also what makes duplicate or reordered IPC harmless: a release carrying a token the registry does not hold lifts nothing, whether it is a duplicate, one whose project has been left, or the `0` a superseded subscription is given.

Ordering Quipu's own mutations says nothing about anybody else's, so the two commands that must not touch an existing file refuse at the boundary that acts. `create_file` uses `File::create_new`, and `rename_file` a no-replace rename (`rustix::fs::renameat_with` with `RenameFlags::NOREPLACE` - `RENAME_NOREPLACE` on Linux, `RENAME_EXCL` on macOS); a platform offering no such operation reports that the rename cannot be done rather than falling back to one that replaces. "Does it exist? then write it" is two operations, and another Quipu window, the editor the user also has open, their shell or a second command of this window's own can create the path in between - which is why neither command re-checks its destination when its turn comes. No check up in the frontend could promise anything, and the kernel's refusal needs no check. `save_text_file` refuses on a different footing, because overwriting is exactly what Save means: what it must not overwrite is a version nobody was authorised against, so it is conditional rather than unconditional. What keeps two of Quipu's *own* saves off one path remains the queue.

#### A save is conditional on the version it replaces

The pre-write read above and the write were once two IPC operations with nothing joining them, so an external write landing between them was overwritten without a word - inside the fenced interval, so nothing reported it, and after every check that could have refused it.

So the expected version travels with the write. `save_text_file` is told what the caller believes is on disk - the text, or nothing at all for a document whose file has been deleted, which Save re-creates - and commits only against that (`app/src-tauri/src/fs.rs`). It answers `written` or `refused`, and neither is a failure: `refused` says the file no longer holds that version, and whatever it does hold is still there.

- **Expected absent:** `File::create_new`, so the kernel refuses if anything is there at all - the same one-operation refusal `create_file` and `rename_file` already rely on.
- **Expected present:** the new text is written into a hidden temporary beside the file and swapped in with an atomic exchange (`RENAME_EXCHANGE` on Linux, `RENAME_SWAP` on macOS, both through `rustix::fs::renameat_with`). The swap hands back the version it displaced, which is the only account of the file at the instant of the write that nothing could have raced. If that is not the expected version, it is put back - conditionally in its turn, see below - and the save is refused.

The exchange is what makes this more than looking first. A comparison followed by a write cannot say what was there when the write happened; an exchange takes the old version away in the same operation that installs the new one, so a competing version is always still in hand to be put back. The comparison is still made first - refusing cheaply beats a swap that has to be undone, and it never puts the new text where a reader could see it - but the second comparison is the one that decides.

Committing by rename has consequences, all of them the price of that guarantee: the file gets a new inode, so hard links stop following the save and its owner becomes whoever is running Quipu; permissions are copied onto the replacement and extended attributes are not; and for the moment between the exchange and the restore, a refused save's text is what a reader would find. The path is canonicalised first, so a rule file reached through a symlink is written *through* the link rather than having the link replaced by a regular file. The temporary is hidden and named as one, so a crash between creating it and committing it leaves something recognisable rather than a file the project would compile - nothing in the project model counts a `.tmp` as a rule file, and the watch plan does not find one relevant.

That moment between the exchange and the restore is an interval like any other, and putting a version back has exactly the problem writing one had: something may write the file again in there, and a plain rename back would destroy that version to make room for one nobody asked to see. So the restore is an exchange as well, and what it hands back is what decides. If it is the replacement this save installed, nothing else wrote and the displaced version is home. If it is anything else, a competing version has been taken out of the way rather than overwritten: a second exchange puts it back, the displaced version stays in the temporary beside it, and the save fails with an error naming that file - the only recovery there is once two versions exist and one path. Which is what removing the temporary is conditional on, and the two sides of the save answer that differently because they are authorised differently. A **committed** save has just replaced exactly the bytes it was told to replace, compared at the instant of the swap, so the file it swapped through may go: the inode that goes with it is the one the save was authorised to replace, which is the hard-link consequence stated above rather than a second one. A **refused** save has no such authorisation, so what it removes has to be *shown* to be its own - and byte equality does not show that. The save still holds the file it wrote its replacement into, open, so the proof is that the temporary's name still resolves to that same file - device and inode, against the open handle - *and* that reading it back through that handle yields the replacement. A third party's atomic replacement carrying exactly the replacement's bytes fails the first half; an in-place write into Quipu's own file, which the exchange has just left at the path where anything may write to it, fails the second. Anything not proven is somebody else's, and stays on disk named in the error.

On Unix, where the platform or the filesystem has no exchange there is no conditional replacement to fall back on, so a save over an existing version is not committed at all and fails saying so. Some FUSE and network filesystems reach that branch on Linux and macOS too, so it is not only other platforms. A comparison followed by a rename is precisely the unconditional clobber all of this exists to avoid: it would still be atomic for anything reading the path and would still destroy a version nobody had seen, which is the bug rather than a mitigation of it. Being unable to save is a disappointment; overwriting an unseen version is not recoverable. Re-creating a file the caller expects to be absent needs no exchange and is unaffected, because `create_new` carries its own refusal.

##### Every version, at every boundary

The whole of the above is a claim about intervals, so the intervals are enumerated rather than argued. There are two of them - the seams the tests write through - and at each one an outsider can do one of four things: nothing, replace the path atomically, write into the file that is there, or delete the path.

- `P` is the document's path; `T` is the hidden temporary beside it, named from this process's id and a counter it never reuses.
- `E` is the version the save was authorised against (`expect`), in the inode `e` that was holding it when the save read the path.
- `Q` is the replacement, written into a fresh inode `q` that the save keeps **open** for as long as it runs.
- `B` is whatever the exchange displaced from `P`: `E` itself when nobody intervened, otherwise the version written after the comparison.
- `C` is a version written after the exchange, in a fresh inode `c` when it arrived by rename.
- **After the comparison** is the interval between reading `P` and swapping `Q` in. **After the exchange** is the interval between the swap and examining what it displaced.

| # | After the comparison | After the exchange | Operation | What the open handle proves | `P` at the end | `T` at the end | Cleanup | Answer | Recovery artifact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | nothing | nothing | exchange; displaced `== want` | not consulted | `q` / `Q` | `e` / `E` | `T` removed | `written` | none |
| 2 | in-place write of `B` into `e` | nothing | exchange; displaced `!= want`; restore | `T` is `q` and holds `Q` | `e` / `B` | gone | `T` removed | `refused` | none |
| 3 | atomic replacement, `B` in `b` | nothing | exchange; displaced `!= want`; restore | `T` is `q` and holds `Q` | `b` / `B` | gone | `T` removed | `refused` | none |
| 4 | atomic replacement whose bytes are exactly `E`, in `b` | nothing | exchange; displaced `== want` | not consulted | `q` / `Q` | `b` / `E` | `T` removed | `written` | none |
| 5 | deletion of `P` | - | exchange fails `NotFound`; nothing committed | not consulted; `T` was never exchanged | absent | gone | `T` removed | `refused` | none |
| 6 | atomic replacement, `B` in `b` | in-place write of `C` into `q`, which the swap left at `P` | restore; not ours; second exchange | `T` is `q`, and does not hold `Q` | `q` / `C` | `b` / `B` | `T` kept | `Err` | `T` holds `B`, named |
| 7 | atomic replacement, `B` in `b` | atomic replacement, `C` in `c` | restore; not ours; second exchange | `T` is `c`, not `q` | `c` / `C` | `b` / `B` | `T` kept | `Err` | `T` holds `B`, named |
| 8 | atomic replacement, `B` in `b` | atomic replacement whose bytes are exactly `Q`, in `c` | restore; not ours; second exchange | `T` is `c`, not `q`: the bytes match and the file does not | `c` / `Q`'s bytes | `b` / `B` | `T` kept | `Err` | `T` holds `B`, named |
| 9 | atomic replacement, `B` in `b` | deletion of `P` | restore; exchange fails `NotFound`; no-replace rename | not reached | `b` / `B` | gone (renamed back to `P`) | nothing left to remove | `refused` | none |
| 10 | atomic replacement, `B` in `b` | deletion of `P`, then something takes `P` | restore; no-replace rename refuses | not reached | theirs | `b` / `B` | `T` kept | `Err` | `T` holds `B`, named |
| 11 | atomic replacement, `B` in `b` | nothing, and the exchange stops being available | restore's exchange fails | not reached | `q` / `Q` | `b` / `B` | `T` kept | `Err` | `T` holds `B`, named |
| 12 | any | - | no exchange on this filesystem at all | not consulted; `T` was never exchanged | untouched, to the inode: whatever the interleaving left there - `e` / `E` when nobody intervened | gone | `T` removed | `Err` (`Unsupported`) | none |

What holds across every row:

- **No external inode or contents are overwritten or unlinked**, with one stated exception: a save that *commits* unlinks the inode holding exactly the bytes it was authorised to replace (rows 1 and 4), which is what Save means and is the hard-link consequence above. Everywhere else a version Quipu did not write ends up where its writer put it - `C` at `P` in rows 6 to 8 and 10, `B` back at `P` in rows 2, 3 and 9, `B` in `T` and named in the error otherwise.
- **A temporary is removed under exactly four licences**, and each row above says which one it used: (a) nothing was ever exchanged through it, so it can hold nothing but the replacement this save wrote (rows 5 and 12); (b) the exchange displaced exactly the bytes the save was authorised to replace (rows 1 and 4) - the committing licence, which is the bytes and deliberately not the identity, since a save asked to replace those bytes has replaced those bytes whoever's inode was holding them; (c) the restore proved the name still resolves to the file this save wrote its replacement into and that it still holds it (rows 2 and 3); (d) it no longer exists, having been renamed back to the path (row 9).
- **Byte equality alone is not ownership.** Row 8 is the whole reason the proof has an identity half: the bytes at the temporary are the replacement's bytes, and the file holding them is not the replacement. Row 6 is why it also has a contents half: the file *is* the one this save created, and what is in it is somebody else's text. An error where either half's answer should be is a failed proof, so an unreadable or unstatable temporary is treated as somebody else's and left alone.
- **A refusal or an error preserves every external version, and names the recovery artifact.** Two versions and one path is not something a save can resolve, so it does not choose: the version that was at the path goes back to the path, the displaced version stays in the temporary, and the error says which file that is. There is exactly one such artifact per refused save, and it is always a `.tmp` beside the document - which nothing in the project model counts as a rule file and no watch plan finds relevant.
- **An unsupported exchange commits nothing** (row 12): the path is never touched, so whatever occupies it when the save gives up is left there to the inode - the version the save was authorised against if nobody intervened, and somebody else's version, or nothing at all, if they did. The answer is a failure rather than `refused`, because being unable to make the save conditional is not the same as finding a version nobody was authorised against.
- **Writers targeting Quipu's private temporary names are out of scope.** The name is dot-prefixed, carries this process's id and a counter it never reuses, and is created with `create_new`, so anything that writes there is choosing names the same way Quipu does or watching it work. Three consequences are stated rather than defended against: a version written into `T` *before* the first exchange is committed to `P` by that exchange and reported as `written`, the save having no way to tell it from its own text; a version substituted at `T` during the restore fails the proof, so nothing is deleted and the only cost is an untidy file left beside the document; and a file created at `T` after the proof has succeeded, or after row 9's rename has emptied that name, is removed by the cleanup, because there is no unlink-this-inode operation to make the removal conditional the way the rename is.

To the frontend a refusal is the same answer a refused check gives. A manual Save writes nothing and the conflict stands, so Save says it again; a compile's auto-save ends its plan, and the compile names the document and never reaches the compiler. `app/src-tauri/src/fs/tests.rs` covers each branch - the version told to expect, a version not told to expect, re-creating a file that was expected to be gone, one that turns out to be there after all, the expected file having vanished, the mode of the replaced file, and writing through a symlink - and does it through seams that run an interleaved write in the very intervals this depends on: between the comparison and the commit, and between the commit and the restore that undoes it. The guarantee is about what happens when something writes *in there*, and a test that cannot write in there cannot tell a commit that decides from a comparison that merely looks, or a restore that puts a version back from one that overwrites whatever it finds. The losing cases have tests of their own: the competing version survives and it is that file that is put back rather than a copy of it; a version written before the restore is left where it is with the displaced one kept beside it and named in the error; a restore that cannot run at all does not take the displaced version down with it; and a filesystem with no exchange refuses rather than clobbering, with the competing file intact to the inode.

The rows of the table above are driven one at a time, and two of them are there to keep the ownership proof honest. A replacement installed by rename after the exchange, carrying the replacement's exact bytes, is neither deleted nor mistaken for Quipu's file, and the displaced version is still recoverable from the file the error names (row 8). An in-place write into Quipu's own file - which the exchange has just left at the path - is put back rather than removed (row 6). Dropping either half of the proof fails exactly one of those two, which is what makes them a pair rather than a repetition. Deletion is driven at both boundaries (rows 5 and 9), including the path being taken again before the displaced version can be renamed home (row 10); and the committing licence has a row of its own, where a version installed by rename that holds exactly the bytes the save was authorised to replace is replaced, its inode going with the save (row 4).

### Requested coverage and installed coverage

A plan is a request. What the OS accepted is what is being delivered, and the two differ whenever an auxiliary location cannot be watched - the parent directory of an external dependency nobody has created yet, a candidate location outside the project. An armed instance therefore records both, and the difference is not rounded off in either direction: not into "the plan is armed", which would claim coverage that was never installed, and not into "nothing is armed", which would throw away the root coverage that is doing most of the work. The root itself is not in that category: without its subtree there is no automatic refresh worth having, so failing to watch it fails the whole arm and leaves whatever was already live in place.

Three things follow from keeping them apart:

- A partly installed plan does not count as already armed, so the next analysis tries the locations that were skipped. A missing external dependency is retried for as long as it is missing rather than written off silently.
- What counts as newly covered is measured against what was **installed** before, not against what was requested before. Ground that was requested and skipped was watched by nothing, so it is newly covered on the day it finally arms.
- The notice is `partial`, never `covered`. Only `partial` carries a degradation message, and only `covered` states that the complete requested plan is live. Both carry the catch-up debt the handoff is owed as a separate field - the debt described at the end of "The catch-up that ends a fence" - because being complete and owing an analysis are independent facts.

Whether an analysis is owed is a fact the handoff states in its own right (`catch_up`), not something the frontend infers from the paths the notice happens to name, nor from the notice being the complete one. The paths are for display: which locations are newly watched, and which could not be. The debt is owed when the installed coverage **grew**, when the plan the installed watcher is filtering events against **changed** - a wider relevance filter inside the same directory adds no path at all and yet answers for files nothing was answering for before - or when narrowing a retained instance **interrupted** delivery of what it is being kept for, which is the paragraph on backends below. Inferring the debt from the paths would lose the middle case; announcing paths that were merely retried would owe an analysis on every retry, and the retry would never terminate.

The retry terminates on a location that can never be watched: the handoff installs the same set, adds nothing, derives the same plan, and so states that nothing is owed. Such a location degrades the watch for as long as it stays unwatchable, and analyses nothing repeatedly.

A replacement that cannot install everything the old watcher had must not leave the project with less coverage than it started with. The handoff therefore keeps the old instances covering ground the new plan still wants and the replacement could not take over, and reports what is genuinely missing separately. Coverage is composed rather than swapped: the retained instances go on delivering events under the same subscription, and are retired only when the plan stops wanting them or the project is left. A handoff that arms nothing at all is the same rule at its limit - it keeps what was live rather than ending up with none.

An instance is kept for *particular* locations, though, and never for everything it happened to be watching. Its own plan named more than the new one does - that is why it is being replaced - and the locations the new plan has dropped are ground nothing is supposed to be reporting any more: an event from one of them would schedule an analysis for a file the project no longer depends on, and a directory nobody wants would go on holding a native watch for as long as the instance did. So narrowing a retained instance is a real narrowing, in both halves. Its redundant native watches are **unwatched**, so the descriptors go rather than merely stopping being counted; and its events are filtered against the current plan *and* against the targets it was kept for, so anything from what it lost is inert whichever half notices first. What it was kept for goes on being delivered exactly as before, which is the whole point of keeping it.

That filtering is deliberately confined to retained instances. A live instance is filtered against its own plan alone, as it always was: it is watching precisely what that plan asked for, a second filter could only ever discard an event it should have delivered, and the cost of losing a real event is a project the user has to refresh by hand. The target test is ancestry rather than a scope decision, for the same reason - it errs towards delivering.

Dropping a watch is not free for the watches that remain on every backend. `notify`'s macOS backend keeps one FSEvents stream per watcher, so removing a path from it stops that stream and starts a fresh one from `kFSEventStreamEventIdSinceNow`: for an instant everything the instance is still kept for is watched by nothing, and an event in that instant is not late but gone. inotify and the Windows backend remove one watch and leave the others alone. Narrowing therefore reports whether it interrupted delivery, and the handoff that narrowed treats that as catch-up debt - the same debt as ground read before it was watched, which is exactly what the gap amounts to. It terminates for the same reason the retries do: the analysis the debt asks for derives the same plan, that plan narrows the same holder to the same targets, nothing is dropped the second time, and nothing is owed. Narrowing an instance to what it already watches is not a narrowing and costs nothing either way.

Which behaviour a backend has is a `cfg!` constant rather than a runtime probe, and the handoff tests set it both ways, so the platform the suite happens to run on does not decide which rule is exercised: shrinking a retained holder under an otherwise unchanged partial plan requests exactly one analysis where narrowing interrupts delivery, requests none where a watch can be dropped alone, and terminates in both cases.

`retain` is unit-tested with instances the harness can route events through by hand: an instance kept for one location while its own plan also covered another stops counting a native watch for the location it lost, delivers nothing for an event under it, and still delivers for the one it was kept for. One test does it against a real `notify` watcher, arming two locations, narrowing to one, and writing to both - the dropped location first, so that a still-installed watch would have queued its event ahead of the one being waited for.

### Degraded watching

A watcher that cannot be installed, or that the OS drops, is degraded operation and not a failed project open. The snapshot stays usable, Refresh Project stays available, and the status line carries a compact note - "Automatic refresh unavailable; use Refresh" - with the underlying reason in its tooltip. It is deliberately kept out of the project's own diagnostics: an inotify limit is not something wrong with the user's rules, and putting it in the Includes view would say that it was.

Degradation is a report, not a latch, and coverage can recover: a start that failed may be followed by an analysis whose handoff arms the plan, and a re-arm that failed leaves the stored plan for the catch-up's analysis to hand over again. Both of those leave nothing installed - the first never had anything, and the fence retired what the second was going to replace - so the next handoff has every target to arm, announces them all, and owes an analysis for the lot. A handoff that could only *partly* replace what was live is the other case: it keeps the rest, so recovery there adds the locations that were missing to coverage that never stopped, and owes an analysis for those.

Recovery can also owe nothing at all. A handoff completes a plan by having every target covered, and a target can be covered by an instance that was **already delivering it** for this project rather than by something newly installed - which is exactly what happens when the replacement cannot take a location over and the old instance is kept for it. Coverage is then complete, so the degradation is over; but nothing was read before a watcher would have reported a change to it, so no analysis is owed. Asking for one anyway would mean an analysis after every such recovery, for no news.

What withdraws the note is therefore a **current `covered` notice**, and only that. It is the one thing that proves the coverage this project asked for is live: the backend emits it exactly when the complete requested plan went in, and says `partial` otherwise. A `partial` never clears the note even when it did add coverage - half a watch is still a watch the window has to be honest about, and the location it names is watched by nobody. A delivered `changed` event proves that *something* is watching, which a plan that armed one location out of three also does. And a notice for a subscription the user has left proves nothing about the one on screen. Otherwise the note lasts until the project is re-opened.

Clearing the note and scheduling the catch-up are separate decisions taken on the same notice. Being complete is what clears the note, whatever the debt says; the debt is what decides whether an analysis runs, whether the notice was `covered` or `partial`. So a recovery that owes nothing clears the note and schedules nothing, and a `partial` that owes an analysis runs one while going on saying what is unwatched.

#### An error from an instance that has been replaced

Retiring a native instance does not stop its thread. It closes the gate its callbacks consult, and that makes inert only the callbacks that read the gate after it closed; one that read an open gate and was then descheduled runs afterwards. So a watcher failure can arrive *after* the notice announcing the instance that replaced it, and recording it would put "automatic refresh unavailable" back on screen on top of the proof that watching is working, where nothing would ever contradict it again. Fences make this ordinary rather than exotic: every save retires an instance and arms another.

The gate cannot decide this. Closing it and emitting a signal are separate steps on separate threads with no ordering between them to appeal to, and a callback must never take a lock the thread retiring it holds. What does have a total order is the notice channel, which is single and ordered, and the frontend, which is single-threaded and is the only place that knows everything it has been told. So every notice carries the native instance behind it, `AutoRefresh` remembers the highest instance it has been told about - a failure included, since a failure is itself news that its instance exists - and a notice naming an older one changes nothing. A failure raising the mark is what makes an *even older* instance's error stale in its turn, which is the order two retired threads can arrive in.

The ordering has a second direction, and that one exists because the native handler is live during the arm rather than after it. A handler is installed before the call installing it returns, so instance N can report trouble before N's own announcement is emitted. Answering that failure with N's coverage notice would clear it with news about the very watcher that failed: the coverage being announced *is* the coverage that failed, so it proves nothing about it. A degradation is therefore recorded together with the instance it is about, and only coverage from a **strictly newer** arm clears it. Anything else waits for the next arm or for the project to be re-opened - the safe direction, because a watch that is in fact working says so again at the next handoff, and every save makes one.

That holds only if identities are never reused, which is why one is taken *before* the arm that will carry it rather than after that arm succeeds. An attempt that reports trouble and then fails outright has already been heard from, and lending its number to the next attempt would leave the successful arm's announcement no newer than the failure - the frontend could not tell it from the failed instance announcing itself, and a live watch would go on saying it was unavailable. Spending the number on the attempt costs nothing, since identities are only ever compared, and it makes the next successful arm strictly newer by construction. Which identity is *live* is a separate question from which was last handed out: notices about coverage name the instance the armed watcher is delivering under, so an attempt that failed can never raise the frontend's mark past the instance still delivering events.

That is why **every** arm is announced - including one that installed its whole plan and owes no analysis, and including the arm that ends a fence. An arm nobody was told about would leave the mark behind and a stale error indistinguishable from a live one. The announcement travels on the event channel and deliberately never as the return value of `watch_project` or `watch_rearm`: the invoke channel and the event channel interleave unpredictably, which is the failure being fixed rather than a way of fixing it. The cost is one extra event per project open and per fence released, which is what buys an invariant that needs no case analysis.

An arm that *failed* does come back on the invoke channel, because the call that asked for it has to be answered, and it carries the identity its attempt reserved for exactly the reason above: the identity is what orders it against the channel it did not travel on. See "Ordering analyses, plans, arms and notices" below.

The mark only ever rises, and instance `0` means "no native instance at all" - a call that failed without reserving one, so that nothing armed and nothing can have superseded it. An arm that failed before taking an identity is one such call; `watch_project` reserves one, but a subscription's first arm cannot have an older notice of its own in flight, so its failure names none either. Such a failure is always recorded, never lowers the mark, and is superseded by any arm whatever - which is safe only because it is a *proved* statement that nothing was reserved. A failure whose identity is merely unknown is not that statement and is not reported as it: it names nothing at all, and nothing announced answers it. `watch_fence` is the call that looks like the first case and belongs to the second: it reserves no identity, but it retires the instance whose announcement may be in flight, so 0 would hand that announcement the power to clear it. Every order ends clean: a stale error arriving *before* the replacement announces itself is cleared by that announcement, `covered` clearing the degradation and `partial` replacing it with what is genuinely unwatched; one arriving after it is dropped; and a failure from the instance being announced survives its own announcement and is answered by the next arm.

A `changed` event carries no instance, deliberately. A retained instance is *older* than the live one and is the only thing delivering the location it is kept for, so ordering events by instance would discard exactly what retention exists to keep. Its errors are droppable for a different reason: a handoff only retains when it could not install everything, so it emitted `partial` and the degradation is on screen already. `app/src/watching.test.mjs` holds every direction against notices delivered by hand - an older instance's error is not shown, the live one's is, one naming no instance always is, a notice naming none does not un-order the arms already announced, the announcement of the instance that failed does not clear its failure, an error older than one already shown is ordered out in its turn, and coverage from a newer arm clears the failure the previous one reported. The backend's half is in `app/src-tauri/src/watch/tests.rs`: a notice names the instance it is news about, a failure reported while arming carries the identity that arm's announcement then carries, an arm that reported before it failed does not lend its identity to the next one, and a retained instance's changes stay unstamped.

#### Ordering analyses, plans, arms and notices

Two orderings meet in the watcher, and each has one rule.

The first is **which analysis may install a plan**. The frontend deliberately allows several analyses to be in flight at once - a Refresh while an automatic one is reading, a fence's catch-up beside either - and settles them by order: `ProjectSession.accept` takes only a response newer than the newest one it has already acted on. The plan travelled on the same response but was installed by a rule that knew nothing about that order, so an older analysis answering last would leave the watcher filtering events against a project the window had already replaced. So the ordering travels with the update: `analyze_project` is given the subscription **and** the analysis's own `order`, as one value, so that a subscription without an ordering cannot be expressed; the registry records the newest generation it has installed a plan from and refuses anything not newer. The same rule, on the same numbers, at both ends. The floor is reset where the subscription is claimed, because the frontend's numbering restarts with each project.

The second is **the order notices reach the frontend in**. A notice can only be built where the state that makes it true is locked - which instance is delivering, what is newly covered, what could not be armed - and it can only be *delivered* where that lock is not held, because the sink is the frontend's and a listener that called back in would deadlock the watcher. Between those two points is an interval, and two transitions racing through it deliver in whichever order they win: an arm's coverage could reach the frontend ahead of the coverage it replaced, and the frontend's rule that news about a replaced instance is not news would then discard the newer transition. Filtering at the far end cannot repair that, because the notice that would be discarded carries the catch-up debt.

So publication is serialized. Notices are queued as they are built, under the state lock, and delivered from that one queue by one deliverer at a time, oldest first. A transition marks itself as in progress, and nothing queued while one is running is delivered until it finishes: not by the thread that queued it - its own arm's callbacks are live from inside the arm onwards, and it is holding the state lock - and not by a deliverer that is already draining, which is not holding it but would be delivering news about a state still being decided. The last transition to finish takes the turn itself. The queue's order is therefore the order the transitions happened in; the sink is called with neither lock held, and only when no transition is in progress, so a sink may call back into the registry from any thread without waiting on a lock it cannot see. That last part is a fix in itself: the callback the armer is given used to call the frontend's sink directly, from inside the arm, with the registry's lock held.

Serializing publication orders the event channel with itself, and there is a second channel: the result of the invoke that asked for the arm. A failed `watch_rearm` is reported to its caller as a rejection - the caller is in the middle of a save, and the re-arm is that save's own business - and the two channels interleave unpredictably, so the coverage the fence retired may still be in flight when the rejection arrives. Nothing about coverage is ever *announced* on the invoke channel, for exactly that reason. What the rejection carries instead is the identity the attempt reserved, and that is enough on its own: the handoff spends a number before arming whether or not the arm succeeds, so the number is strictly newer than every notice built before the attempt and strictly older than every notice built after it. Ordering by identity then needs no ordering between the channels - both interleavings of a delayed `covered` and a rejection end in the same state - and it silences nothing, because no arm will ever announce that number. A call whose reservation is settled reports 0: `watch_project`, whose subscription can have no older notice of its own in flight, and an attempt that failed before it took an identity.

That last part is why the arming step's own panics are caught inside the call rather than left to the task boundary. Arming is foreign code and can unwind, and a panic after the identity was spent has spent it just as thoroughly as an error would have - possibly leaving an orphan watcher that emits under it - so reporting 0 there would hand the coverage the fence had just retired the power to answer the failure. Caught where the identity is known, with the lock that hands identities out still held, the panic is an ordinary rejection carrying an ordinary identity; only the counter's own value at the start of that hold decides between 0 and the number, and it is never reread after the task has exited, because by then another attempt may have advanced it. One path is left where nobody can attribute the failure at all: the task did not come back, which is a panic in the sink or the runtime rather than in the arm. There the counter cannot be consulted on its behalf - the next attempt may already have advanced it - so the answer is that there is no answer, and the rejection carries **no identity** rather than 0. Unknown is a weaker statement than none, and flattening the two would reintroduce the very bug the reserved identity prevents: 0 says nothing was reserved and nothing can be delivering, which is why any arm at all clears it, whereas an attempt whose identity is unknown may have installed a watcher under a number nobody can name. The frontend therefore holds that degradation as unplaceable. No announcement clears it - not the delayed coverage the fence retired, and not a later arm either, because telling those two apart is precisely what the missing identity would have been for - and the recovery is re-opening the project, which proves nothing about instances because the watcher in question goes with the subscription. It is the conservative direction on purpose: an explicitly correlated recovery would need a successful arm to report its identity on the invoke channel, which is exactly what that channel deliberately never carries.

`watch_fence` reaches that same state from the other side, and it is the call where 0 is most tempting: it reserves no identity at all, so there is none to report. What it does instead is *retire* one, and the notice announcing that instance's coverage travels on the channel the rejection did not, where it may be in flight this moment - so 0 would hand that notice the power to clear the degradation at the one moment when nothing is watching. The retired instance cannot be named either, and not for want of trying: the frontend's mark is a lower bound on what has been armed, so a fence can retire an arm whose announcement has not arrived, and naming the mark would name something older than the coverage in flight. A rejected fence therefore names nothing, exactly as a lost task does. It is also the case with the least to recover to. If the fence went up before the answer was lost, the token went with the answer: no release will ever lift it, every later mutation's release finds a fence still outstanding, and no arm is even attempted - so the degradation is not a conservative guess but the plain truth about the watcher, until the project is re-opened and the registry drops the outstanding tokens with the subscription.

- `S` is the subscription; `R1`, `R2` are analyses, sent with their `AnalysisRequest.order` as the generation.
- *Accepted* is `ProjectSession.settledOrder`, the frontend's newest settled analysis. *Installed* is the registry's newest installed-from generation.
- *Reserved* is the instance counter, taken before an arm; *live* is the instance actually delivering (`Armed::serial`). `N` stands for whichever instance an arm reserved.
- *Channel* is how the frontend is told: `event` for a `project_watch` notice, `invoke` for the rejection of the call that failed.
- *Outcome* is how a failed call ended, where one is involved: *rejection* for an arming step that returned an error, *panic before* and *panic after* for one that unwound, on either side of the moment its identity was reserved, and *unattributable* for one nobody could place at all - a re-arm whose task never came back, or a fence whose answer was lost.
- `Failed(0)` is a rejection proved to have reserved nothing; `Failed(?)` is one whose identity is unknown, which is a different statement and a stickier one.
- *Publisher* is the state of the queue as the notice is built: `idle` when nobody is delivering, `draining` when a deliverer is already inside a sink call.
- *Built / delivered* gives construction order first and delivery order second, which is the whole point of the second half.

| # | Step | S | Sent | Done | Accepted | Installed | Reserved | Live | Channel | Outcome | Publisher | Built / delivered | Degradation and debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1a | R1 issued and sent | 7 | `{7, 1}` | - | 0 | 0 | 4 | 4 | - | - | idle | - | - |
| 1b | R2 issued and sent, R1 still in flight | 7 | `{7, 2}` | - | 0 | 0 | 4 | 4 | - | - | idle | - | - |
| 1c | R2 answers first: newer at both ends, so it is displayed and its plan is armed | 7 | - | R2 | 2 | 2 | 5 | 5 | event | - | idle | `Covered(5)` / 1st | debt honoured for arm 5 |
| 1d | R1 answers last: `1 <= 2` at both ends | 7 | - | R1 | 2 | 2 | 5 | 5 | - | - | idle | none built | unchanged |
| 2a | a plan update builds `Covered(N)` under the lock and queues it | 7 | `{7, 3}` | R3 | 3 | 3 | N | N | event | - | idle | `Covered(N)` queued | debt honoured for arm N |
| 2b | while it is being delivered, a fence release arms again and queues `Covered(N+1)` | 7 | - | - | 3 | 3 | N+1 | N+1 | event | - | draining | `Covered(N+1)` queued behind it | - |
| 2c | the deliverer takes the queue as it finds it | 7 | - | - | 3 | 3 | N+1 | N+1 | event | - | draining | `Covered(N)` / 1st, `Covered(N+1)` / 2nd | mark N, then N+1 |
| 2d | a transition on **another thread** arms N+2, and its handler reports trouble from inside that arm, while the deliverer is inside the sink | 7 | - | - | 3 | 3 | N+2 | N+1 | event | - | draining | `Failed(N+2)` queued, held | - |
| 2e | that sink returns with the transition still open | 7 | - | - | 3 | 3 | N+2 | N+1 | - | - | draining | nothing delivered; the turn is given up | - |
| 2f | the transition finishes and takes the turn itself | 7 | - | - | 3 | 3 | N+2 | N+2 | event | - | idle | `Failed(N+2)` / 1st, `Covered(N+2)` / 2nd | degraded by N+2; equal identities, so its own announcement does not clear it |
| 3a | `Covered(N+1)` arrives | 7 | - | - | - | - | N+1 | N+1 | event | - | idle | / 1st | mark N+1; any older degradation cleared |
| 3b | a `Partial(N)` is delivered afterwards anyway | 7 | - | - | - | - | N+1 | N+1 | event | - | idle | / 2nd | message dropped - it is about coverage already replaced; debt honoured unless one has been honoured for a newer arm |
| 4a | `Partial(N+1)`, owing an analysis | 7 | - | - | - | - | N+1 | N+1 | event | - | idle | / 1st | degraded by N+1; debt honoured for arm N+1 |
| 4b | a `Covered(N)` is delivered afterwards anyway | 7 | - | - | - | - | N+1 | N+1 | event | - | idle | / 2nd | does not clear; debt subsumed by N+1's, so nothing is scheduled |
| 4c | as 4a but `Partial(N+1)` owed nothing, then `Covered(N)` owing an analysis | 7 | - | - | - | - | N+1 | N+1 | event | - | idle | / 2nd | does not clear; debt honoured - nothing newer has read the disk |
| 4d | a call whose reservation is settled degrades - a `watch_project` that failed outright - then `Covered(N)` is delivered with `N+1` the newest arm heard of | 7 | - | - | - | - | N+1 | N+1 | invoke, then event | - | idle | `Failed(0)` / 1st, `Covered(N)` / 2nd | does not clear; debt honoured |
| 5a | arm N's handler reports trouble from inside the arm | 7 | - | - | - | - | N | N | event | - | idle | `Failed(N)` / 1st | degraded by N |
| 5b | arm N's own announcement | 7 | - | - | - | - | N | N | event | - | idle | `Covered(N)` / 2nd | equal identities: the degradation stands; debt honoured |
| 5c | the next analysis arms again | 7 | - | `R4` | 4 | 4 | N+1 | N+1 | event | - | idle | `Covered(N+1)` / 3rd | strictly newer: cleared |
| 6a | an attempt reserves N, its handler reports trouble, then the arm fails | 7 | - | - | - | - | N | M (`< N`, still live) | event | rejection | idle | `Failed(N)` / 1st, `Failed(M)` / 2nd | degraded by N; `Failed(M)` dropped as older |
| 6b | the next analysis arms successfully with a distinct identity | 7 | - | `R5` | 5 | 5 | N+1 | N+1 | event | - | idle | `Covered(N+1)` / 3rd | strictly newer than N: cleared |
| 7a | a handoff installs part of its plan and keeps an older instance for the rest | 7 | - | - | - | - | N | N | event | - | idle | `Partial(N)` / 1st | degraded by N; debt honoured |
| 7b | the retained instance - older than N - reports a change | 7 | - | - | - | - | N | N | event | - | idle | `Changed` / 2nd | not ordered by instance, never dropped; invalidates and schedules |
| 7c | a change reported while a transition is running | 7 | - | - | - | - | N | N | event | - | idle or draining | `Changed` queued, delivered in place | as 7b, after whatever that transition queued first |
| 8a | arm N announces itself, and the notice has not reached the frontend yet | 7 | - | - | - | - | N | N | event | - | idle | `Covered(N)` / in flight | - |
| 8b | a fence retires N; the re-arm reserves N+1 and the arm fails, its handler having emitted nothing | 7 | - | - | - | - | N+1 | none | invoke | rejection | idle | nothing built | - |
| 8c | the rejection arrives first, carrying the identity the attempt reserved | 7 | - | - | - | - | N+1 | none | invoke | rejection | idle | `Failed(N+1)` / 1st | degraded by N+1; mark N+1 |
| 8d | the delayed `Covered(N)` arrives | 7 | - | - | - | - | N+1 | none | event | rejection | idle | `Covered(N)` / 2nd | ordered out: does not clear; debt honoured |
| 8e | the other interleaving - the delayed `Covered(N)` arrives before the rejection | 7 | - | - | - | - | N+1 | none | event, then invoke | rejection | idle | `Covered(N)` / 1st, `Failed(N+1)` / 2nd | mark N, then degraded by N+1: the same state as 8d |
| 8f | the catch-up's analysis arms again | 7 | - | `R6` | 6 | 6 | N+2 | N+2 | event | - | idle | `Covered(N+2)` / 3rd | strictly newer than N+1: cleared |
| 9a | as 8a: arm N announces itself, and the notice has not reached the frontend yet | 7 | - | - | - | - | N | N | event | - | idle | `Covered(N)` / in flight | - |
| 9b | a fence retires N; the re-arm reserves N+1 and the arming step **panics**, caught where that identity is known | 7 | - | - | - | - | N+1 | none | invoke | panic after | idle | nothing built | - |
| 9c | the rejection arrives first, carrying the identity the attempt reserved - the panic changes nothing about that | 7 | - | - | - | - | N+1 | none | invoke | panic after | idle | `Failed(N+1)` / 1st | degraded by N+1; mark N+1 |
| 9d | the delayed `Covered(N)` arrives | 7 | - | - | - | - | N+1 | none | event | panic after | idle | `Covered(N)` / 2nd | ordered out: does not clear; debt honoured |
| 9e | the other interleaving - the delayed `Covered(N)` arrives before the rejection | 7 | - | - | - | - | N+1 | none | event, then invoke | panic after | idle | `Covered(N)` / 1st, `Failed(N+1)` / 2nd | mark N, then degraded by N+1: the same state as 9d |
| 9f | an orphan watcher the panic left installed reports trouble, under N+1 - the only identity it has | 7 | - | - | - | - | N+1 | none | event | panic after | idle | `Failed(N+1)` / 3rd | equal identity, so not ordered out: its message replaces the panic's |
| 9g | the catch-up's analysis arms again | 7 | - | `R7` | 7 | 7 | N+2 | N+2 | event | - | idle | `Covered(N+2)` / 4th | strictly newer than N+1: cleared |
| 9h | a re-arm that panicked **before** reserving anything - the counter did not move, which is proof rather than an assumption | 7 | - | - | - | - | N | none | invoke | panic before | idle | `Failed(0)` / 1st | degraded naming no instance: any arm at all answers it, as row 4d |
| 10a | as 9a: arm N announces itself, and the notice has not reached the frontend yet | 7 | - | - | - | - | N | N | event | - | idle | `Covered(N)` / in flight | - |
| 10b | a fence retires N; the re-arm's task never comes back, so what it reserved cannot be told - reading the counter now would race the next attempt | 7 | - | - | - | - | N or N+1 | none | invoke | unattributable | idle | nothing built | - |
| 10c | the rejection arrives first, naming no identity at all - which is not the claim that it reserved none | 7 | - | - | - | - | N or N+1 | none | invoke | unattributable | idle | `Failed(?)` / 1st | degraded and unplaceable; the mark does not move |
| 10d | the delayed `Covered(N)` arrives | 7 | - | - | - | - | N or N+1 | none | event | unattributable | idle | `Covered(N)` / 2nd | does not clear - it may be news from before the attempt; mark N; debt honoured |
| 10e | the other interleaving - the delayed `Covered(N)` arrives before the rejection | 7 | - | - | - | - | N or N+1 | none | event, then invoke | unattributable | idle | `Covered(N)` / 1st, `Failed(?)` / 2nd | mark N, then degraded and unplaceable: the same state as 10d |
| 10f | the catch-up's analysis arms again and announces itself | 7 | - | `R8` | 8 | 8 | N+2 | N+2 | event | unattributable | idle | `Covered(N+2)` / 3rd | still does not clear: nothing distinguishes this from an announcement built before the attempt |
| 10g | the project is re-opened, claiming a subscription of its own | 8 | - | - | 0 | 0 | N+3 | N+3 | event | - | idle | `Covered(N+3)` for subscription 8 | cleared with the subscription: the watcher it was about is gone |
| 11a | as 10a: arm N announces itself, and the notice has not reached the frontend yet | 7 | - | - | - | - | N | N | event | - | idle | `Covered(N)` / in flight | - |
| 11b | a save's `watch_fence` retires N and takes its token, and the answer is lost on the way back | 7 | - | - | - | - | N | none | invoke | unattributable | idle | nothing built | - |
| 11c | the rejection arrives, naming no identity: a fence reserves none, and 0 would be a claim about the coverage it just retired | 7 | - | - | - | - | N | none | invoke | unattributable | idle | `Failed(?)` / 1st | degraded and unplaceable; the write goes ahead with the token 0 |
| 11d | the delayed `Covered(N)` arrives | 7 | - | - | - | - | N | none | event | unattributable | idle | `Covered(N)` / 2nd | does not clear - it is news from before the fence; mark N; debt honoured |
| 11e | the other interleaving - the delayed `Covered(N)` arrives before the rejection | 7 | - | - | - | - | N | none | event, then invoke | unattributable | idle | `Covered(N)` / 1st, `Failed(?)` / 2nd | mark N, then degraded and unplaceable: the same state as 11d |
| 11f | the next save fences and releases: its own token is lifted, the lost one is still outstanding | 7 | - | - | - | - | N | none | - | unattributable | idle | nothing built | unchanged - no arm was attempted, so there is nothing to announce |
| 11g | the project is re-opened, claiming a subscription of its own | 8 | - | - | 0 | 0 | N+1 | N+1 | event | - | idle | `Covered(N+1)` for subscription 8 | cleared, and the outstanding fences go with the old subscription |

What holds across every row:

- **The plan never regresses behind what the window shows.** Within a subscription, a plan is installed only from an analysis strictly newer than the newest one already installed from, and the frontend accepts by the same rule on the same numbers (rows 1c and 1d). The two ends need not agree on *when* a response is settled, only on the same total order.
- **A rejected analysis alters nothing.** The generation is checked before the plan is stored, so an older analysis answering last leaves the stored plan, the arm, the instance counter and the notices exactly as they were (row 1d) - not merely a stale plan that is later corrected.
- **Coverage and partial notices cannot apply out of transition order.** They are queued where they are built, which is under the lock that decided them, and delivered oldest first by one deliverer (rows 2a to 2c). An arm cannot announce itself before the arm it replaced.
- **A notice queued while a transition is in progress waits for it, whoever is holding the turn.** The thread that queued it is holding the state lock, so it does not deliver; a deliverer already draining is not holding that lock and does not deliver either, because what it would be delivering is news about a state still being decided by somebody else (rows 2d and 2e). The last transition to finish takes the turn itself (row 2f). What this buys is that the sink is only ever called with the registry settled, so a listener may call back in from any thread; what it must not cost is order or liveness, and it costs neither - the turn is given up and reclaimed in one hold of the queue lock, so nothing is stranded behind a turn nobody holds, and the notice keeps its place in the queue.
- **A stale `Partial` cannot restore degradation.** A `Partial` naming an instance older than the newest arm the frontend has heard of is news about coverage that has been replaced: its message is not recorded (row 3b). Serialized publication means the case does not arise from the registry at all; the frontend rule is what makes it unreachable rather than merely unlikely, and it is driven by hand.
- **A stale `Covered` clears nothing.** Clearing needs an arm strictly newer than the degradation, which an older instance is not (rows 4b and 4c), and an instance's own announcement is not newer than its own failure (row 5b). An arm already known to have been replaced clears nothing at all, including a degradation that names no instance and that any live arm would answer (rows 4d and 8d): coverage announced by an arm the frontend has already seen replaced is news from before whatever went wrong, whether that was a `watch_project` that armed nothing or a re-arm that left the project watched by nobody.
- **A failure delivered on the invoke channel is ordered by the identity its attempt reserved.** Coverage is announced only on the event channel, the two channels interleave unpredictably, and a re-arm's rejection is therefore ordered by identity rather than by arrival (rows 8b and 8c). The number is spent before the arm, so it is newer than every notice built before the attempt and older than every notice built after it: the delayed announcement of the coverage the fence retired is ordered out whichever way round the two arrive (rows 8d and 8e), and the next arm is newer still and does clear the degradation (row 8f). No arm will ever carry that number, so nothing is silenced by it. Only a call whose reservation is settled reports 0 (row 4d).
- **How the attempt failed does not change what it reserved.** The arming step is foreign code, so it can unwind rather than return an error, and a panic *after* the identity was reserved is not a failure that reserved nothing: a watcher installed moments before the panic is an orphan nothing will retire, and what it emits, it emits under that number (rows 9b, 9c and 9f). The panic is therefore caught where that identity is known - inside the call, while the lock that hands identities out is still held - rather than at the task boundary, where the counter may have moved on, and the rejection is placed exactly as an ordinary one is, in either interleaving (rows 9d and 9e). 0 is reserved for attempts proven to have reserved nothing, which is what a counter that did not move under the attempt's own lock proves (row 9h). Reporting a panic as 0 is the specific bug these rows exist for - a degradation naming no instance is answered by any arm at all, so the announcement of the coverage the fence had just retired would say automatic refresh was working while nothing was armed.
- **A failure nobody could attribute is unplaceable, and unplaceable is not 0.** Where the task never came back, the identity cannot be recovered afterwards, so the rejection carries none at all (row 10c). This is deliberately a third state rather than 0: an unknown attempt may have installed a watcher under a number nobody can name, so no announcement is evidence about it - not the coverage the fence retired, in either interleaving (rows 10d and 10e), and not a later arm either, since what would distinguish the two is the identity that is missing (row 10f). The degradation is held until the project is re-opened (row 10g), and it survives a later notice replacing what the window says, because a more specific message does not make the identity known. The conservative direction is the point: the alternative would be an explicitly correlated recovery, which needs a successful arm to name its identity on the invoke channel - the one thing that channel never carries.
- **A rejected fence is unplaceable for the same reason, arrived at from the other end.** It reserves no identity, but it retires the instance whose announcement may still be in flight, so 0 would let that announcement answer it (rows 11c to 11e), and the mark cannot stand in for the retired instance because it is only a lower bound on what has been armed. Here the degradation is not even conservative: if the fence went up before its answer was lost, the token went with the answer, so every later release finds a fence still outstanding and no arm is attempted at all (row 11f). Re-opening the project clears the note and drops the outstanding tokens with the subscription (row 11g), which is the same recovery doing both jobs.
- **Catch-up debt is never lost to ordering.** A debt is dropped in exactly one case: a debt has already been honoured for a **newer** arm, whose analysis therefore reads the disk after this arm's coverage went in and settles the same ground (row 4b). Ordering alone never drops one - rows 3b and 4c honour a debt from a notice whose message or clearing was refused - because an analysis nobody asked for costs one redundant read that derives the same plan and owes nothing further, while a debt discarded is a project that never refreshes.
- **Failed-instance ordering is intact.** A failure from inside an arm still carries that arm's reserved identity and is not answered by that arm's own announcement (rows 5a and 5b); an attempt that reported and then failed still spends its identity, so the next arm is strictly newer and does clear it (row 6); and a failure naming an instance older than the newest arm heard of is still dropped (row 6a).
- **Retained-instance changes remain deliverable.** `Changed` carries no instance and travels the same queue, so retention is not undone by ordering (rows 7b and 7c).
- **The sink is never called with either lock held, nor with a transition in progress**, from any path: a transition delivers after releasing the state lock, a callback made from inside an arm queues and leaves delivery to the transition it is running inside, and a deliverer that finds a transition open gives its turn up rather than delivering into it.

The frontend's half of these rows is driven by hand in `app/src/watching.test.mjs`, notices being delivered directly to `AutoRefresh`: a replaced arm's `Partial` degrades nothing and still asks for the analysis it owes, a catch-up honoured for a newer arm subsumes an older arm's, an older arm's catch-up is honoured when nothing newer has caught up, and a replaced arm's coverage answers neither a call that reserved no identity nor a re-arm that reserved one and failed - the latter in both orders of arrival, with the next arm clearing it, and again for a re-arm that panicked, where an orphan's trouble reported under the same identity is current news rather than something ordered out. A failure nothing could place is stated separately and in both orders of arrival: the coverage in flight does not answer it, nor does a later arm, a partial notice may replace the message without making it answerable, and re-opening the project is what clears it. That a request's own order is what travels with it is in `app/src/watchflow.test.mjs`, along with the wiring the invoke channel needs: a re-arm that fails while a save is ending carries the attempt's identity through to the coordinator, so the coverage that fence retired cannot answer it - stated for an ordinary rejection, for an arming step that panicked, and for a rejection nothing could attribute, each in both interleavings, the last of them outliving a later arm and clearing only when the project is re-opened. A transport error that never reached the command is normalised to the same unplaceable state, since it says even less. The fence's own rejection is driven there too, with a fault that retires the instance and takes its token before losing the answer: the write still goes through, the coverage the fence retired does not answer the degradation in either order of arrival, the save that follows lifts its own fence and leaves the lost one outstanding so that nothing arms, and re-opening the project clears both the note and the token nobody could release. The registry's half is in `app/src-tauri/src/watch/tests.rs`, where the generation rule is tested against an analysis that answers late - both while arming is free and while a fence holds it, and with a second subscription numbering from one again - the rejection is tested to carry the attempt's identity rather than the live instance's, and the publication order is tested against a sink that transitions again while it is being delivered (rows 2a to 2c, without a second thread to synchronise) and against a second thread that opens a transition while the first sink call is still running and keeps it open past that call's return (rows 2d to 2f, the two threads meeting at barriers so that the holdback is observed rather than waited for, and the snapshot taken between them being the assertion). A deliberately panicking armer covers rows 9b and 9c: the rejection names the identity that attempt reserved, nothing is left armed, no notice was built, and a later arm still announces itself - the registry outlives the panic, which is the other reason for catching it where it happens rather than at the task boundary. The three outcomes are pinned apart directly as well: the counter having moved under the attempt's own lock is what makes 0 a proof, and the conversion a lost task goes through names nothing rather than 0 (rows 9h and 10c).

### Reconciling open documents

A document open in the editor whose file changed underneath it is the case where getting it wrong loses work, in one of two directions: silently overwriting the buffer loses what the user typed, and silently overwriting the file on the next save loses what the other editor wrote. `app/src/documents.ts` therefore records, per document, the text last known to be on disk alongside the saved baseline, and answers a completed read with one of six outcomes (`app/src/documents.test.mjs` states them in order): the read is stale, the file is gone, nothing changed, both sides arrived at the same text, the two have diverged, or the document can be reloaded.

- A read is answered against the **document it was issued from**, not against whatever holds its key when it lands. The caller probes the document first and hands that probe back, and a different model under the key - a rename re-creates one - makes the read stale: nothing is recorded, because a conflict or a moved baseline would be recorded against a stranger. The model's *revision* deliberately does not have to match, because an edit during the read is exactly the conflict this exists to find.
- A read is also answered against the **disk operation it was issued from**. Each document counts a baseline - the identity of its current agreement with the file - the probe carries that count, and a read whose count has moved on is stale however unchanged the model's revision is. The two cannot be the same number, because a save changes what the disk holds without changing what the editor holds: an older read landing afterwards would otherwise report a change against the text the save itself had just written, or report the file missing after the save re-created it. The count advances on a completed save, a successful **Reload from Disk** and a reload that reconciliation applied - the three events that establish a new agreement with the file - and deliberately not on a user edit, which establishes nothing about the file and leaves the pending read to become the conflict above, nor on a `conflict` or `missing` outcome, which record a disagreement rather than settle one. A completed save is deliberately never itself refused by a pending read: the write happened, so it is the newest word on that file rather than an older one.
- A read is finally answered against **the reads of that document that have already been answered**, which is a third count and not either of the other two. Two reads of one file overlap whenever automatic reconciliation meets a manual Refresh, or a fence's catch-up meets either, and the outcomes that merely record a disagreement - `conflict`, `missing` - deliberately establish no new baseline, because a disagreement is not knowledge of what the file holds. So the baseline cannot order two reads taken against the same one, and without a third count their answers would take effect in whatever order they arrived: a later read finding the file present and changed, then an earlier read landing with "it was gone", would leave the document claiming that a file which exists has been deleted. Each document therefore counts the reads issued for it, each probe carries its number, and the document remembers the highest number whose answer has been applied; an answer from below that mark is stale and records nothing. What it orders is competing *questions*, where the baseline orders competing *facts* about the disk. Every answer given advances it, including the ones that establish no baseline; `stale` advances nothing, having given no answer, and neither does a user edit, which asks nothing. A `reload` is one answer given in two steps - decide, then apply - so applying refuses only a *strictly* newer read, or it would refuse every reload there is.
- What the reads **found** is counted as well, which is a fourth count and again not any of the other three. Those three order the answers; this one names them, so that a permission given for one state of the file cannot be spent on another. A document counts its *observations*: the count advances whenever an answer that was accepted found the file holding something other than what it was last seen to hold, and stays where it is otherwise - a repeated external version is not news twice over, a file that is still missing is not either, and a stale answer, having established nothing, advances nothing. Quipu's own completed save moves what the file was last seen to hold, deliberately without advancing the count: a write this window performed itself is not somebody else having been here, and counting it would have a save revoke the authorisation of the mutation queued behind it. A rename, re-creating the model, starts a fresh count, because the new document has its own history with its own file - and carries the conflict over, the rename having moved the file too.
- The times the document has **taken the file's side** is the fifth count, and the last. The ones above order the answers or name what they found; this one is about what the *document* did with them, and it exists because the observations cannot answer half of what an authorisation depends on. A queued write was authorised to put one particular revision on disk, and the user can withdraw that revision while it waits - not by editing, which leaves the write to be superseded by the next Save, but by resolving the conflict with **Reload from Disk**, which replaces the document with the file's version and discards exactly what the write was going to put back. The observations see nothing wrong with that: the version the reload adopted may well be one already observed, so the count that names what the disk holds does not move, and the write would go ahead and undo the user's resolution. So each replacement of a document's contents with its file's is counted - Reload from Disk, and a reload reconciliation applied - and an authorisation is spent only if that count still stands too. `diskAnswer(key)` reports all three parts together - the conflict, which observation it was about, and how many reloads had happened by then - and a key nothing is open under answers with no conflict and nothing having happened to it. What consumes it is the confirmation re-check in "Ordering Quipu's own mutations", which compares the counts and deliberately not the conflict kind.
- A **clean** document whose file changed is reloaded from disk. The reload applies only if the same document and the same revision are still there when the read lands, it does not activate the document or move the cursor - a file changing must not take the editor away from what the user is looking at - and the reloaded revision becomes the saved baseline, so the document is clean afterwards. The LSP is told exactly once. The reload drives the Monaco model, so the content-change listener is suppressed for its duration: without that, a reload would look like a user edit, mark the project stale and invalidate the compilation, and each automatic refresh would schedule the next one.
- If the user types **while the read is pending**, their text is not replaced. The outcome is computed from the document as it is when the read completes, so this is a conflict rather than a reload - and even if a caller went on to apply the reload it was about to, the model-and-revision guard refuses it.
- A **dirty** document whose file changed is never replaced automatically. It is marked as a conflict, and stays marked however many notices arrive.
- A file that has been **removed or renamed away** leaves its document open: the buffer is the only copy of that text left. It is marked missing rather than guessed to be some other path's rename source, because a delete plus a create is what a rename looks like and Quipu has no way to know which creation is the target.
- A notice for Quipu's **own completed save** is not a conflict: what is on disk is what was written.

Conflicts appear in the existing active-document and project status areas, and the file's row in Files gets a distinct mark and tooltip, separate from the ordinary dirty dot - one says the editor has unsaved work, the other says the two sides have diverged. Neither adds a row or a line that shifts the layout.

Resolving one is explicit. A **Reload from Disk** button appears beside Save for a conflicted active document (and is hidden, not disabled, when there is nothing to resolve). It confirms before discarding unsaved changes, reads asynchronously, and applies only if the project, the document model and that particular resolution request are all still current; a missing or unreadable file leaves the conflict standing and reports a scoped failure. **Saving** over a conflict confirms first, and cancelling changes nothing - including the case of re-creating a file that was deleted externally, which is offered but only behind the same confirmation. Save being *offered* there is the point: what enables Save, in the toolbar and in the File menu alike, is that the disk does not hold what the editor holds - unsaved edits, or any disagreement with the file - rather than the dirty flag alone. A document nobody edited whose file has gone would otherwise have its only copy behind a greyed-out button. A successful recreation clears the conflict and the catch-up re-reads the project, so the file is back in the views as well as on disk. Before a **compile**, the conflicted dirty files it would write are collected and confirmed once, naming all of them; cancelling aborts the compile before anything is written, rather than issuing one dialogue per file. The answer is re-checked against each document when that document's write reaches the front of the mutation queue, so one whose conflict state moved while the queue drained is skipped rather than written on the answer to a different question - see "Ordering Quipu's own mutations".

### The Files and Includes views

The explorer has two views of the same accepted snapshot, selected by tabs within the pane. View > Includes View reveals the pane if it is hidden and selects the Includes tab; the Explorer toggle still shows and hides the whole pane, and Reset Layout remains layout-only.

The **Files** view is a recursive tree built from the snapshot's `discovered` identities, with internal sources under their relative directory hierarchy and external discovered sources in a separate, labelled group. Ordering is deterministic: folders before files, each sorted by plain code-point comparison, never by locale. Readability comes from the snapshot's nodes, so an unreadable source is listed and marked rather than hidden - it is part of the project, and its absence from the tree would be the more confusing answer. Rename is offered only where its filesystem semantics are safe: an internal source, renamed in place within its own directory. An external source's path is a canonical target outside the project, so renaming it would move someone else's file and leave the include that named it resolving to nothing.

The **Includes** view renders the whole snapshot, including graphs that do not compile: entrypoints first in the snapshot's order, each source's include directives in their declared `order`, resolved edges navigating to their target, unresolved edges shown as the raw text they were written as, source-scoped issues with their source and project-scoped issues in a section of their own. Sources not reachable from any entrypoint appear under "Other sources", so an invalid rootless cycle cannot vanish from the view that exists to explain it.

Termination is structural rather than depth-limited. Each source's outgoing edges are expanded at most once; a target already expanded elsewhere becomes a reference leaf, and a target within the current ancestry becomes a cycle leaf. So a diamond is drawn once rather than exponentially, and a cycle is drawn as a cycle.

Both trees are pure functions of the analysis (`app/src/filestree.ts`, `app/src/includestree.ts`, both tested), with a thin renderer (`app/src/explorer.ts`) over them. Rows carry an index into a table built by the same render pass rather than a path in an attribute, so nothing has to parse a filesystem path back out of markup, and every user-controlled label is HTML-escaped. Disclosure state is the one thing that must outlive a render, so it is keyed by a stable node name - which is why attribute escaping is full escaping, `&` included, rather than just the quote.

A location is navigable when the snapshot gives it a byte span. Byte offsets are UTF-8 and Monaco positions are 1-based lines and UTF-16 columns, so the conversion is a tested function of its own (`app/src/bytepos.ts`): an astral character costs two columns, an offset inside a character clamps to that character's start, and a malformed or out-of-range offset clamps into the text rather than raising.

### Navigating to a document

Every gesture that takes the editor somewhere - a row in Files or Includes, a diagnostic in the Problems pane, a match in the results, the automatic open of a project's first source - may have to read a file before it can show anything, and a read is an await the user can outlive. By the time the bytes arrive the folder may have been switched or closed, or a refresh may have replaced the snapshot the gesture came from. Opening the document then is not a late success: it is another project's file appearing in the editor. Revealing a position afterwards is worse, because the position is then an offset into whatever document happens to be active.

So navigation is scoped, in one place (`app/src/navigation.ts`), and every gesture goes through it. A navigation captures its context before it starts - which **selection**, and which **accepted analysis**, by object identity - re-checks it after every await, and reports what it did (`shown`, `stale`, `failed`, `not-found`). Both halves of the context matter: the selection decides whether the document belongs to the project at all, and the snapshot decides whether the byte offsets and the candidate list the gesture was built from still describe it.

A third part of the context is which gesture the navigation is. Gestures are counted, and the count advances when one is *made*, not when its read lands: from that moment the newest gesture owns the editor and every older navigation is dead, including one whose read is still outstanding. Without that, two clicks in quick succession are decided by the disk - the older file landing second would leave the editor on the file the user asked for first, purely because it was slower to read - and a pending automatic open would still be able to plant its default source in front of a file the user has just asked for. A navigation's own gesture is the newest one from the moment it begins until the next one, so the check never rejects the navigation making it, and its own open cannot invalidate it before its reveal.

The reveal is handed *to* the navigation rather than performed by the caller afterwards. That is not a stylistic choice: "afterwards" is exactly where the bug lives, and an explicit result the caller has to inspect is easier to ignore than a reveal that simply never runs. A failure belonging to an abandoned navigation is dropped rather than shown, for the same reason a late save failure is: the Problems pane belongs to the project that is open.

Match navigation is the same rules over several files. A matched rule's source location is not in the results, so the project's sources are searched for its declaration; an unreadable candidate is skipped, because the rule may be in the next one, but a candidate read that lands out of context ends the search rather than opening a file the previous project listed. The text that was searched is the text the document is opened with, so nothing is read twice, and an open document is searched as the editor has it - an unsaved edit is what the user is looking at, and the line has to agree with it.

The **automatic** open of a project's first source has two extra conditions, because it is a courtesy rather than a request:

- It is scoped to *its own* analysis remaining the accepted snapshot, not merely to the folder remaining open. A refresh that has landed has already said what the project is, and this open belongs to the answer before it.
- It is abandoned if anything has activated a document while its read was pending. The count is of all activations, whoever caused them, which is precisely the question being asked: if the editor has moved, the user put it where it is, and taking it back is the bug. This is what catches a change of active document that is not a navigation at all - a rename re-activating its document, a tab click - which the gesture order cannot see. An explicit navigation is not withdrawn this way: it is the user's instruction, and only a newer instruction replaces it.

Both conditions apply to reporting a failure as well as to opening a file, by the same test: a read that failed for a gesture the user has already replaced would report on a file they are no longer waiting for, and overwrite what the newer one has to say about the one they are.

`app/src/navigation.test.mjs` holds each of these against a session whose folder can be switched, closed or refreshed while a read is held open by hand, and `app/src/switching.test.mjs` drives the auto-open through the same module rather than a copy of it.

### Saving a document

A write to disk is asynchronous and the user can keep typing during it, so a save has to answer one question honestly: which revision of the document is now on disk? The revision the model happens to hold when the write *finishes* is not it. Marking the document clean at that revision declares an edit saved that was never written - and because the Save the user presses next appears to have been serviced already, it is not written the next time either.

So a save is two steps over an opaque snapshot (`app/src/documents.ts`). `beginSave(key)` captures, before the write, the document, its model, the exact text to be written and which revision that text is; `completeSave(snapshot)` moves the saved baseline to **that captured revision**. The text handed to `save_text_file` is the snapshot's, never a fresh read of the model. An edit made while the write was in flight therefore leaves the document dirty, which is the truth - it is not on disk - and the next save, or the next wave of the compile's save plan, writes it. The version that write is allowed to replace travels with it, and comes from the pre-write read rather than from the snapshot: see "A save is conditional on the version it replaces".

`completeSave` also reports whether the snapshot still applies, and does nothing at all when it does not: the key may have been closed with the project, or a different model may hold it now, because a rename re-keys a document onto a new model. A save in flight across either must not mark whatever is there now as written, and must not fire the dirty-state notification, because as far as the editor is concerned nothing changed.

Manual Save has one further scope to respect. Its completion and above all its **failure** belong to the project that started it: a rejection arriving after the user has opened another folder would otherwise report a write the new project never asked for in that project's Problems pane. So the selection is captured alongside the snapshot and checked before anything is reported - the same counted identity as everywhere else, so a re-selection of the same folder counts as having left. It is checked once more once the save has its turn and the fence is up, along with the document's identity and the conflict answer the user gave, so a save that waited while the user moved on writes nothing at all - see "Ordering Quipu's own mutations". The compile's auto-save needs no selection check of its own; it runs inside an operation whose token is already tested at every await.

"Clean" is a comparison rather than a flag, because the baseline is Monaco's *alternative* version id: it returns to an earlier value when the user undoes back to an earlier state, so a document undone all the way back to what was written is clean again. A document carried across a rename is the deliberate exception - its model is new and reports no changes of its own, so it starts from a baseline no model can ever report, the file it now names never having been written.

What a rename carries is therefore three things, none of which the new model could derive: the unsaved edits, the text last known to be on disk - the file under the new path holds whatever the old path held, so that is still the truth about the disk, whereas taking it from the new model would claim the editor's unsaved text had been written - and any **conflict**. The conflict follows the document because the rename moved the file too: the version Quipu never saw is now at the new path, and moving the bytes settled nothing about whose version is right. Dropping it there would turn Rename Rule into a way of overwriting somebody else's version without being asked, in the interval before anything re-reads the disk - and if watching is degraded, nothing ever does.

This bookkeeping is Monaco-free (`DocumentSet`) precisely so the cases above can be tested rather than argued about: `app/src/documents.test.mjs` covers each of them against a model with a real undo history, and `app/src/switching.test.mjs` drives the same rules through the app's own Save, auto-save and folder-switch paths.

### Closing the workspace

File > Close Workspace returns the app to the state it starts in, through the same transition as a switch: unsaved changes are prompted for before anything is superseded or cleared, so declining leaves the project exactly as it was, and then the infallible prologue runs - the session closes, outstanding analyses and refreshes are superseded, any compilation is superseded, the ruleset reset is queued on the barrier, and the views, results, diagnostics, build state and documents are all cleared. What differs is only what follows: there is no folder to analyse, so the queued reset is the sole fallible step. The scratch buffer is put in the editor **before** the project's models are disposed, so Monaco is never left holding a destroyed model, and each disposal is announced to the LSP.

The close awaits that reset only in order to report a failure, and it reports one only while its own operation still owns the ruleset. A reset is slow enough for the user to open a folder while it is outstanding, and a rejection shown then would put the failure of a workspace they have closed into the new project's Problems pane, clearing whatever that project had put there. Nothing is lost by the silence: the barrier retains the rejection regardless, so the next compile refuses to run and reports it instead.

## Confirming a destructive step

`window.confirm` displays nothing at all in this webview and returns `true` (WebKitGTK 2.52.3 on Ubuntu 24.04; measured, not assumed). Every guard built on it therefore approved silently, which is the exact failure each was written to prevent. All of them are now the dialog plugin's `confirm` - a visible Ok/Cancel window - and that makes every one of them an IPC round trip: the question is asked across an **await**.

Which is the whole design problem. A synchronous question has nothing between the answer and the transition that acts on it. An awaited one has an interval in which the project can be switched, a document can be edited, closed or renamed, another program can write the file, a queued save can land, a reload can take the file's version, and the user can make a newer gesture of their own. So each confirmation is expressed as a gate with three steps, in this order (`app/src/authorising.ts`):

1. **claim** - captured synchronously, before anything is asked: which gesture, which project selection, which document and revision, which observations of the disk, and which documents are at risk *at which revision* (`RiskStamp`, `documents.ts` - a path cannot tell one revision of a document from another, nor one document from its replacement under the same path). Nothing is superseded, cleared or written here, which is what makes a cancelled gate a no-op.
2. **question** - the words the user sees, or nothing at all when nothing is at risk. A clean workspace and an unconflicted save are never asked anything, and no dialogue means no IPC and no visible gap.
3. **current** - re-checked after the answer, against the same identities the rest of the app orders itself by: the open-request serial, the session's counted selection, the document's model and revision, and `diskAnswer`'s observation and reload counts. False refuses, and refusing changes nothing.

Only then does the caller run its own infallible prologue, synchronously, on the claim it was handed - so the thing acted on is the thing asked about rather than whatever the UI says by then.

### Workspace departure

Open Folder, Open Example and Close Workspace are one transition with different endings, so they share one gate. Open Folder and Open Example each claim an open request before their picker or their copy starts; Close Workspace makes no request of its own and only **marks** the ordering (`OpenRequests.mark`), so that its question cannot cancel a picker the user is still looking at and its answer cannot cancel a newer open gesture. That choice is `closeGate`'s rather than the call site's, so it is a tested part of the protocol.

| Entry | Picker / preparation | Request and selection when answered | At-risk set shown | Answer | Concurrent event | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Close Workspace | - | current, project open | dirty a.yar | cancel | - | nothing at all: project, documents, views, compile and any pending open untouched |
| Close Workspace | - | current, project open | dirty a.yar, missing b.yar | approve | - | prologue runs: pending opens cancelled, session closed, compile superseded, reset queued, views cleared |
| Open Folder | dismissed | not reached | never computed | never asked | - | no-op; browsing is not a decision about unsaved work |
| Open Example | copy failed | not reached | never computed | never asked | - | project intact; the chooser reports the failure |
| Open Folder / Example | root obtained | superseded by a newer open request | dirty a.yar | approve | user asked for another folder | opens nothing; the newer request is untouched |
| Close Workspace | - | marked serial superseded | dirty a.yar | approve | user asked for another folder | closes nothing and cancels nothing; the newer open wins |
| Open Folder / Example | root obtained | selection no longer current | dirty a.yar | approve | another project accepted | opens nothing |
| Close Workspace | - | no project open | dirty a.yar | approve | the workspace was closed meanwhile | closes nothing |
| any | - | current | dirty a.yar | approve | a.yar saved while the question was up | proceeds: the answer covered more than is left, and a Save must not cancel it |
| any | - | current | dirty a.yar | approve | b.yar became dirty while the question was up | no-op: b.yar was never shown, so nothing is discarded |
| any | - | current | dirty a.yar at revision N | approve | a.yar edited again (revision N+1) | no-op: the revision approved is not the one that would be lost |
| any | - | current | dirty a.yar | approve | a.yar closed and re-created under the same path | no-op: a path is not a document identity |
| any | - | current | nothing at risk | not asked | - | proceeds with no dialogue and no IPC |
| any | - | current | dirty scratch buffer only | not asked | - | proceeds; the scratch buffer has no path and is kept across a departure |
| any | - | current | dirty a.yar | dialogue rejected | - | nothing changes; the failure is reported in the gesture's own scope, and dropped if that project has been left |

### Save and reload authorisation

| Operation | Identity and observation shown | Answer | Change while the dialogue is open | May it proceed? |
| --- | --- | --- | --- | --- |
| Save | snapshot of the active document; file in agreement | not asked | - | writes, subject to the pre-write checks |
| Save | snapshot at revision N; conflict at observation O | cancel | - | writes nothing; the document stays dirty and conflicted |
| Save | revision N, observation O | approve | - | proceeds, and the answer is re-checked once more when the write reaches the front of the mutation queue |
| Save | revision N, observation O | approve | another external version arrives (observation O+1) | refused: permission was for the version shown |
| Save | revision N | approve | the user edits (revision N+1) | refused: the confirmed text is not what is on screen |
| Save | revision N, reloads R | approve | Reload from Disk (reloads R+1) | refused: the confirmed revision has been withdrawn |
| Save | revision N | approve | document closed, renamed, or the project switched | refused |
| Compile auto-save | every dirty file, with each one's observation | cancel | - | nothing written and the compile never starts: no operation, no build-state change, no ruleset dropped |
| Compile auto-save | dirty set K | approve | a document outside K becomes dirty | the compile proceeds; that document is held to having no conflict, so it is written only if it has none |
| Compile auto-save | dirty set K | approve | a document in K gets a further external version | refused before the operation begins |
| Compile auto-save | dirty set K | approve | a compile starts by another route | no-op; the newer compile owns the ruleset |
| Reload from Disk | probe of the active document, no unsaved text | not asked | - | reloads; nothing of the user's is at stake |
| Reload from Disk | probe at revision N, text T | cancel | - | text and conflict kept exactly |
| Reload from Disk | revision N, text T | approve | the user edits | refused before the file is read at all |
| Reload from Disk | probe | approve | the user navigates to another document | refused: a reload must not replace text off screen |
| Reload from Disk | probe | approve | the project is switched | refused |
| Reload from Disk | probe | approve | the conflict is resolved by a save or by the file returning | nothing left to reload |
| Reload from Disk | probe | dialogue rejected | - | text and conflict kept; scoped failure reported |
| Reload from Disk | probe | approve | the read fails, or the document moves on before it lands | conflict left standing; `reload` refuses anything but the probe it was given |

### The invariants those tables hold

- **Cancel changes nothing and supersedes nothing.** No session change, no open request cancelled, no operation begun, no reset queued, no view cleared, no document mutated, no byte written. The gesture can simply be repeated.
- **A confirmation that could not be shown authorises nothing.** Answering for the user is the one thing a broken dialogue must not do. The failure is reported in the scope the gesture belongs to, and dropped if the user has left that project - a dialogue that failed about a workspace they have closed does not belong in the next one's Problems pane.
- **A stale answer changes nothing**, and **a newer user gesture beats an older answer**. Ordering is by the identities that already exist - the open-request serial, the counted selection, the document's model and revision, the observation and reload counts, the operation token - rather than by paths or by what the UI currently shows.
- **An approval is specific.** Approval for one at-risk set cannot discard a different one (a newly at-risk document is never covered, nor is a further edit to one that was named, nor another document created under the same path; work saved since is), and approval for one disk observation cannot overwrite a different one (`answerHolds` compares the observation and reload counts, never the conflict kind, because Quipu's own save resolves a conflict without anything having happened that the user did not ask for).
- **After the final check the prologue runs synchronously.** There is no await between `current` returning true and the transition that acts on it, so nothing can interleave in between.
- **Folder selection and example preparation still come first.** A dismissed picker or a failed copy never produces an unsaved-work question.
- **Clean paths stay prompt-free.** No dialogue, no IPC, and no added asynchronous gap where a question was not warranted.

Termination is held to the same rule by the same predicate; see "Terminating the application". `app/src/authorising.test.mjs` drives each row above against the real `ProjectSession`, `OpenRequests` and `DocumentSet`, putting a question up and letting the interleaving event happen while it is up. It also asserts that no browser-global `confirm` is left anywhere under `app/src`, subdirectories included, which is the defect itself rather than its consequences. The X11 scenario `close_workspace_confirms_discard` (`test/ui/menu_scenarios.py`) proves the dialogue is really on screen: it makes a file dirty, invokes Close Workspace, finds a native confirmation window, cancels it and shows the project and its text unchanged and the menus still working, then invokes it again and approves. Open Folder is driven the same way in the same scenario, since one gate reached from several menu items can still be miswired at one of them.

## Terminating the application

Exiting is the one transition with nothing after it, so it is the one where a missed confirmation is unrecoverable. There are three ways to make it: File > Quit, the title bar's close button or the window manager, and - on macOS - the application menu's Quit. All three converge on a single coordinator (`app/src/closing.ts`), because three copies of the same confirmation would be three chances for one of them to be wrong, and the one that is wrong would be the least exercised.

What makes convergence possible is Tauri's close-requested event: while the frontend has a listener registered, the native close is prevented and the window is destroyed only if the handler declines to prevent it. So the guard lives in that handler, the listener is registered before any other startup await (a window that could be closed during startup is a window that could be closed unguarded), and File > Quit asks the *window* to close rather than exiting the process - an unconditional exit would be a second way out with no guard on it. Destroying the window does not re-emit the request, so approving a close cannot loop.

What exiting puts at risk is not what leaving a project puts at risk. The classification is the same as everywhere else (`documents.ts`): a document is at risk when it has unsaved edits, or when its file has gone and the editor holds the only copy of its text. A clean document whose file merely changed on disk is not at risk, because the disk has a version of its own, and naming it would teach the user to click through the question. The difference is the scratch buffer: it has no path, so no folder change closes it and a switch cannot lose it - which is why `Workspace.atRiskFileStamps()` filters it out - whereas exiting destroys it along with the window. The exit path therefore asks an explicit exit-level query (`Workspace.atRiskExitStamps()`, over `atRiskOnExit`) rather than reusing the switch's filtered list, and the wording of the question is shared between the two so they cannot describe the same document differently.

| Entry point | At risk | State on arrival | Answer | Prompt | Outcome | State after |
| --- | --- | --- | --- | --- | --- | --- |
| Menu Quit, title bar/WM, macOS Quit | nothing | idle | - | none | window closes | closing |
| Menu Quit, title bar/WM, macOS Quit | clean file changed on disk | idle | - | none | window closes | closing |
| Menu Quit, title bar/WM, macOS Quit | dirty file | idle | cancel | "... and lose a.yar (unsaved)?" | close prevented; nothing changed | idle |
| Menu Quit, title bar/WM, macOS Quit | dirty file | idle | confirm | as above | window closes once | closing |
| Menu Quit, title bar/WM, macOS Quit | file missing on disk (clean) | idle | cancel | "... (not on disk)?" | close prevented; nothing changed | idle |
| Menu Quit, title bar/WM, macOS Quit | dirty scratch, no project | idle | cancel | "... the scratch buffer (unsaved)?", advising a copy rather than a save | close prevented; text intact | idle |
| duplicate request (second click, WM repeat) | any | closing | - | none | close permitted | closing |
| re-entrant request (arrives while the question is up) | any | prompting | - | none | close prevented | prompting, then whatever the outstanding answer decides |
| any, confirmation unavailable (throws) | any | idle | none obtainable | attempted | close prevented | idle |
| Menu Quit, title bar/WM, macOS Quit | dirty a.yar; b.yar goes at risk while the question is up | idle | confirm | named a.yar only | close prevented: b.yar was never shown | idle, and the next Quit names both |
| Menu Quit, title bar/WM, macOS Quit | dirty a.yar, edited again while the question is up | idle | confirm | named a.yar at the revision then | close prevented: that revision is not what would be lost | idle |
| Menu Quit, title bar/WM, macOS Quit | dirty a.yar, closed and re-created under the same path | idle | confirm | named a.yar | close prevented: the path is not the document | idle |
| Menu Quit, title bar/WM, macOS Quit | dirty a.yar and b.yar; a.yar saved while the question is up | idle | confirm | named both | window closes: a save must not cancel the answer | closing |

The invariants that table is there to hold:

- **A cancelled close changes nothing.** The project stays open and selected, the documents keep their text and their dirty state, the scratch buffer keeps its text, no analysis, compilation, watcher subscription or queued mutation is superseded, and the coordinator returns to `idle` so the next Quit asks again. Confirmation therefore comes strictly before the prologue that supersedes and clears, exactly as it does for a workspace switch.
- **No class of at-risk work is omitted.** Dirty documents, documents whose file has gone, and the dirty scratch buffer - the last being the case a filtered list would silently discard, and the only one with no file to recover from.
- **Every entry point converges on the one coordinator.** Nothing exits the process directly, so there is no route past the guard.
- **Approval cannot prompt recursively.** A request arriving while a question is on screen is refused without asking anything (nothing has been approved yet), and a request arriving after approval proceeds without asking again.
- **One gesture cannot close twice.** An approved close permits every later request rather than refusing it - refusing would strand a window that has been told to go - and destruction is idempotent, so a duplicate request destroys nothing a second time.
- **An approval is an answer about the set it named.** The dialogue is awaited, and a watcher noticing a deleted file, a queued reconciliation, a rename or an app-owned write can put a document at risk, or move one on to a revision nobody has been shown, while it is up. So the at-risk set is taken again after the answer and the approval must still cover it - the same document at the same revision, `coversRisk` in `documents.ts` - and work saved meanwhile has simply left the set rather than revoked anything. Uncovered work returns the coordinator to `idle`, where the next Quit asks about all of it. The identities are the same ones a workspace departure is held to; exiting has strictly more to lose, so it is not held to less.
- **A guard that cannot ask does not answer.** Any outcome other than an approved close prevents the default, failures included: refusing to exit costs a keystroke, exiting anyway costs the user's work.

Two things the guard needs are not obvious from the code that uses them, and both were established by running it rather than by reading about it:

- **The question has to be a native dialogue.** `window.confirm` returns `true` without displaying anything at all in this webview (WebKitGTK 2.52.3 on Ubuntu 24.04), so a guard built on it approves every close silently - the precise failure it exists to prevent. The confirmation is therefore the dialog plugin's `confirm` (Ok/Cancel, matching the question's advice to cancel and save), which makes it asynchronous; Tauri awaits the close-requested handler before deciding whether to destroy the window, so that is safe, and the coordinator's `prompting` state is what covers the gap it opens. Every other confirmation in the application was measured against the same finding and goes the same way; "Confirming a destructive step" is what holds them to their answers.
- **The capability has to grant `core:window:allow-destroy` as well as `allow-close`.** Tauri's frontend `onCloseRequested` wrapper is what destroys the window when the handler declines to prevent the close, so without that permission registering a listener makes the window *unclosable*: the native close is prevented, the guard approves, and the destroy call is rejected. A guard that cannot be got past is as much a bug as one that cannot be reached.

The platform-specific part is which menu item Quit is. muda accepts only a handful of predefined items on GTK, so a predefined Quit is silently dropped on Linux and File > Quit would not appear at all; on macOS it appears and maps to `terminate:`, which ends the process without the window ever being asked to close, so the guard would never run. Quit is therefore a regular item routed through the coordinator on every platform, at the cost of supplying its own label and Cmd+Q accelerator on macOS.

`app/src/closing.test.mjs` holds the table row by row against a real `DocumentSet` and a window that mirrors Tauri's prevent-or-destroy behaviour, so a cancelled close can be shown to have destroyed nothing. The X11 scenario `quit_guards_unsaved_work` (`test/ui/menu_scenarios.py`) drives the same path through the native menu and the real window, which is the only place the wiring between them - the menu item, the close listener and the confirmation dialogue - is exercised end to end.

## Example projects

The application ships a small catalog of example projects so that a first run has something real to open: a basic text match with no manifest, a two-level include graph with one, and one declaring several entrypoints. They live in `examples/` at the top of the source tree, one directory per example, each with its own `README.md`, its rules, and a sample target under `targets/`. They are ordinary projects - the same manifest, the same discovery, the same include resolution - and `app/src-tauri/src/examples/tests.rs` analyses, compiles and scans every one of them against the results its README documents, so an example that stops working fails the build rather than the user's first five minutes.

The catalog itself is a fixed Rust table in `app/src-tauri/src/examples.rs`: id, display name, description, working-copy revision, packaged directory, and the relative path of the sample target. There is no second list in TypeScript to drift from it - the chooser renders whatever `list_examples` returns - and an example crosses IPC as its id alone. `prepare_example` accepts nothing else: it looks the id up in that table and rejects anything it does not know, so no path the frontend holds decides what is copied or where it goes.

### Packaged template, editable working copy

Each example exists in three places, and only the third is ever opened:

1. `examples/<id>/` in the source tree - the version under review.
2. `<resources>/examples/<id>/` in the installed application - read-only, bundled by the `bundle.resources` map entry in `app/src-tauri/tauri.conf.json`, which puts the tree at a predictable resource path rather than the `_up_/_up_/` spelling the list form would produce. `tauri-build` copies the same tree into the Cargo target directory during development, and `resource_dir()` resolves to the executable's directory there, so development and a bundled application look the same to the code.
3. `<app-local-data>/examples/<id>/v<revision>/` - the user's own working copy, which is what Open Example opens. On Linux that data directory is `~/.local/share/com.corelight.quipu`; Tauri's `app_local_data_dir()` gives the per-platform equivalent.

The first open of an example copies the packaged tree recursively into that versioned path. Every later open of the same revision finds it there and reuses it exactly as it stands, edits and all: a working copy is never repaired, re-copied or diffed against the template, because any difference between them may be the user's work. Raising an example's `revision` in the catalog therefore does not overwrite anything - it names a *different* destination, so the updated example is copied fresh alongside the older edited copy.

The copy is committed rather than assembled in place, so that an interrupted one cannot be left looking finished. Every attempt claims a staging directory of its own beside the destination - a name carrying the process id and a counter, claimed by `create_dir`, which fails rather than joining in if the name is taken - copies the template into it, writes the marker file last, and only then moves the completed tree onto `v<revision>` with an **atomic no-replace rename**. The destination is therefore only ever absent or complete, and the marker inside it is what a reuse tests for. It has to be a regular file, checked without following links, so nothing outside the directory can decide whether it counts as a working copy.

No-replace is the load-bearing half of that, and atomicity alone would not do: an ordinary Unix rename replaces an existing *empty* directory, so a check followed by a plain rename would still destroy a directory that appeared in the window between the two. The refusal therefore comes from the rename itself - `renameat2` with `RENAME_NOREPLACE` on Linux, `renamex_np` with `RENAME_EXCL` on macOS, both reached through `rustix`; Windows uses `MoveFileExW` with replacement disabled. A platform offering no no-replace operation gets an explicit refusal to install, because there is no safe substitute: failing to open an example is a disappointment, and replacing somebody's directory is not.

Two attempts - two windows, two processes - meet nowhere but that rename. Whichever wins installs its copy; the loser reuses the winner's only after checking that what is there really is a marked working copy, and otherwise reports a refusal. Nothing is ever deleted or replaced to make room. A destination without an acceptable marker is *not* interrupted-copy debris - a copy in progress never has that name - so it is somebody's: a restored backup, a directory they created, or a working copy whose marker has gone. It is preserved exactly as it stands and the preparation fails saying which directory Quipu refused to replace and why. An attempt that dies leaves its own staging directory behind, and that is deliberate: the debris is inert and uniquely named, whereas deleting a staging directory this attempt does not own could destroy a copy another one is still making. Bounded cleanup of stale orphans can be designed separately.

Only regular files and directories are copied, and entry types are read without following links, so a symlink or any other special entry in a packaged example is refused rather than followed out of the resource tree; the catalog's own directory and target strings are validated as plain relative names before any of it starts. Nothing here is exposed as a general recursive-copy command over IPC - `prepare_example` copies one catalog entry, or fails.

The whole of that logic takes a resource root and a data root as arguments, so it is tested against temporary directories without a running Tauri application; the Tauri command is the thin wrapper that resolves those two roots and calls it on a blocking thread. Staging and installing are separate functions for the same reason: a test drives two attempts through them by hand, so the interleavings asserted on are the ones written in the test rather than ones a scheduler happened to produce.

### What happens after the chooser

`app/src/examples.ts` is a native `<dialog>`, like the About box, listing the backend's names and descriptions with one Open button each and no framework. Every piece of backend-provided text is set with `textContent`, activation is blocked while a preparation is in flight, and a failure is reported inside the chooser, which is where the user asked - the project that is open at the time is untouched, so it has nothing to say about it.

A successful preparation enters the project through `enterProject` exactly as a folder does, and preloads the working copy's sample target - not the packaged original - into the existing scan target area, shown by path and byte count like a file the user chose. Nothing is compiled and nothing is scanned: Scan stays disabled until a compile succeeds, and the next steps are in the example's README and in a comment at the top of the first rule file Quipu opens, since README files do not appear in the rule-files tree.

## Relationship to the compiled-rules cache

A valid `CompilationPlan` is the input a future cache key will be computed from: its ordered entrypoints, ordered include directories and identity-ordered closure are exactly what needs hashing, and they are stable by construction. Nothing so far adds hashing, `.yarc` serialization, cache metadata, cache paths or cache interfaces. `compile::project` is where a cache would sit: it obtains a validated plan and then compiles it, so a cache layer slots between those two steps without either the model or the compiler changing. See `docs/compiled-rules-cache-design.md` for the cache design itself.

## Phase boundaries and deferred work

Phase 1 was the model and its tests. Phase 2 wired it up: the analyzer is exposed over IPC, compilation runs from a plan, and the old command that accepted a list of sources plus one include directory is gone. Behaviour the frontend already had - build state, Scan enablement, the Problems pane, auto-save on compile, the menu actions - is unchanged.

Phase 3 moved project ownership into the frontend: the session described above, the recursive Files view, the Includes view, Close Workspace, and explicit refresh with staleness marking. The flat listing this replaced is gone entirely - `fs::list_rule_files`, its `RuleFile` type, its Tauri handler and its IPC wrapper - because a second, flatter account of what a project contains is exactly the thing that would drift from the analysis.

Phase 4 added the example projects and File > Open Example: the `examples/` tree, the resource bundling that carries it into installed applications, the fixed backend catalog and the versioned working copies described above, the chooser, and the counted open requests that order a materialisation against a folder picker. The menu item is no longer a stub. Opening an example is not a second way of opening a project - it obtains a root and then joins the transition Phase 3 established.

Phase 5 added native watching: the watch plan and the managed watcher in `app/src-tauri/src/watch/`, the debounce and request ordering in `app/src/watching.ts`, the disk baseline and reconciliation outcomes in `app/src/documents.ts`, the counted fence around app-owned writes with the catch-up that ends it, and the conflict presentation and resolution described above. Fencing is what made the last of the write path conditional rather than checked: a blind interval is where an unobserved external write belongs, so a mutation answers for its interval before opening it, `save_text_file` commits only against the version it was authorised against, and the frontend orders watcher errors against the arms it has been told about. "Incremental re-analysis" here means coalescing events and running the existing full analysis, not an incremental graph engine - the watcher decides *when* to analyse and nothing about *what* the project contains. `analyze_project` gained a subscription argument so the read that renders the views is also the read the watch plan widens from. Refresh Project is unchanged and remains the immediate manual path.

Deferred, in rough dependency order:

- **Caching.** Hashing plans and storing compiled rules, per `docs/compiled-rules-cache-design.md`. Nothing in Phase 5 hashes anything, and the watcher's notices are not a cache-invalidation signal.
- **Manifest authoring UI.** Nothing writes `quipu.toml`; it is hand-written and committed by the user.

## Windows filesystem behavior

Windows conditional saves use an exclusive read/write handle with sharing disabled
from the version comparison through the final flush. An incompatible open handle
causes Save to fail before changing bytes. The version read from that handle must
match the caller's expected text; an absent expected file is refused, while a file
expected to be absent is created with `CREATE_NEW`. Readers, writers, deletes and
renames cannot open the existing file while the save owns the handle. Writable
memory mappings that outlive their original handles are outside this guarantee.

Before modifying an existing file, Quipu creates and flushes a recovery copy in
the same directory, copying the original DACL before writing any bytes to it.
The file is updated in place, so its identity, ACL and hard links are preserved.
A write or flush failure triggers restoration through the still-exclusive handle.
If restoration fails, the original stays in the recovery file and the error names
it. A process crash can leave a partial rule and a `.NAME.quipuPID-N.tmp` recovery
file; recovery is manual, and startup never deletes those files. This differs
from the Unix exchange implementation's atomic visibility.

Windows renames use `MoveFileExW` with flags zero: destination replacement and
cross-volume copy/delete fallback are both disabled. The same operation installs
example directories, so an existing directory is preserved even when empty.
