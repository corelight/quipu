# Compiled Rules Cache Design

## Status and terminology

This is the implementation contract for Quipu's implemented compiled-rules cache.
The project model it builds on is also implemented and provides `quipu.toml`,
`ProjectDefinition`, `ProjectSnapshot`, `CompilationPlan`, the Files and Includes
views, conditional auto-save, native watching, the frontend operation token and
reset barrier, and the backend ruleset generation, as described in
`docs/workspace-project-model.md`.

That document makes a distinction this older design did not: the backend object is a
**project** (a directory and its definition); `Workspace` is the frontend editor's
open-document collection. Cache types, paths and commands use *project*. User-facing
copy may continue to say “workspace”, matching **Compile Workspace** and **Close
Workspace**.

The current build uses YARA-X 1.20.0 with portable serialization:
`native-code-serialization` is disabled in `app/src-tauri/Cargo.toml`. Project
compilation currently follows:

```text
root -> ProjectDefinition -> ProjectSnapshot -> CompilationPlan
     -> yara_x::Compiler -> yara_x::Rules -> RuleStore
```

The cache belongs between a valid plan and the compiler, and beside `RuleStore`; it
does not replace any stage in that chain.

## Product decisions for the first implementation

These are settled so the cache implementation does not also have to invent startup
behaviour.

| Question | Decision |
| --- | --- |
| When is a cache entry restored? | Automatically during the initial analysis of a project, after the previous project's reset barrier has settled. |
| What does a miss do? | Leaves the project **Not compiled**. Opening does not start a real compilation; the user still chooses **Compile Workspace**. |
| Does **Compile Workspace** consult the cache too? | Yes. It derives a fresh plan, uses a valid entry if one exists, and otherwise compiles and attempts to persist the result. |
| Is the scratch buffer cached? | No. It has no durable project identity and compilation accepts live, unsaved text. `compile_scratch` remains memory-only. |
| What is restored with the rules? | Rule count and successful-compilation diagnostics, including warnings, so the build status and Problems view match a fresh compile. |
| What does a cache error do? | A read error is a miss; a write error leaves freshly compiled rules installed. Neither prevents opening, editing, compiling or scanning. |
| What does clearing disk state do to loaded rules? | Nothing. Rules in `RuleStore` remain scannable until the normal edit/reset/project-close lifecycle invalidates them. |
| What does disabling the cache do to existing files? | Stops future reads and writes but retains them until explicitly cleared. Re-enabling may use them after full validation. |
| What are the initial quota values? | 1 GiB high-water limit and 80% low-water target, provisional pending measurement. |
| Is native code stored? | Not in the current build. Compatibility metadata still distinguishes portable from native-enabled builds. |

## Goals

- Restore a successfully compiled, unchanged project without invoking YARA-X's
  compiler again.
- Detect every project-model input that can change compilation, including manifest
  order, include resolution, transitive and external sources, and inferred
  entrypoints.
- Reject artifacts from an incompatible YARA-X build or Quipu compilation contract,
  even if YARA-X's serialization version did not change.
- Preserve the existing stale-result guarantees: a project switch, edit, relevant
  filesystem event, refresh, reset or newer compile can supersede a restore.
- Keep generated state out of source-controlled projects.
- Make commits crash-safe, disk use bounded, and clear/disable operations ordered
  against in-flight cache work.
- Bound each artifact independently of the total-cache quota so one hostile or
  corrupt file cannot cause an excessive allocation, read, hash or deserialization.
- Treat corruption, incompatibility, interrupted writes and unavailable cache
  storage as misses or persistence failures, never as project or compile failures.
- Give users a small, accurate Preferences surface for settings, usage and clearing.

## Non-goals

- The cache is not a `.yarc` import feature or distribution format. Quipu never
  loads an artifact from a project directory or user-selected path.
- It does not cache scratch-buffer compilation or unsaved overlays.
- It does not provide incremental compilation.
- It retains one committed generation per project and target, not Git history.
- It does not make project analysis optional. A hit still requires a fresh valid
  `ProjectSnapshot` and `CompilationPlan`.
- It does not replace dirty-buffer, watcher, operation-token, reset-barrier or
  backend-generation ordering.
- Cross-process “Clear wins over a compilation that finishes later in another Quipu
  process” is not promised initially. Atomic files and advisory locking prevent
  corruption; strong clear/write ordering is process-local.
- Settings are atomic on disk but are not pushed into another Quipu process which is
  already running; that process observes them on its next start. Live multi-instance
  settings propagation is deferred with cross-process clear ordering.

## Existing lifecycle constraints

### The cache is another producer of `Rules`

Fresh compilation and cache restoration install through the same
`RuleStore::begin` / `RuleStore::finish` generation. A hit must never assign rules
directly. Otherwise a restore begun for project A could land after A was closed, or
after a compile for B, and make stale rules scannable.

The frontend operation token remains the authority over whether a response may set
the build status, diagnostics and rule count. The backend generation independently
decides whether the corresponding `Rules` may be installed. Both are required.

The reset barrier still orders resets before any operation that can install rules.
Initial restoration begins only after the reset queued by `enterProject` has settled.
A reset failure prevents the restore command from being issued, just as it prevents a
compile now.

### Restoring is an explicit build state

Add `restoring` to frontend `BuildState`, displayed as **Checking compiled cache…**.
Scan is disabled. Compile remains available and may supersede the automatic restore
rather than making the user wait for a large artifact.

`invalidateCompilation()` must treat `restoring` as an operation which may already
be installing rules: an edit, Refresh or watcher event moves the UI to **Stale**,
advances the operation revision and requests a backend reset. Without that reset, an
edit arriving before a hidden install could leave rules in `RuleStore` which the UI
never knew existed.

Retain the operation created in `enterProject` for restoration rather than discarding
it. A hit, miss or error changes the UI only while that operation and project
selection remain current.

### Analysis and restore use one snapshot

Do not add a second `open_project(root)` pass merely to perform lookup. Extend the
analysis command so the initial-project call can request restoration from the same
backend `ProjectSnapshot` it describes and gives to the watcher.

The wire result becomes conceptually:

```text
AnalyzeResponse {
    analysis: ProjectAnalysis,
    cache: not-requested | disabled | miss | unavailable
         | hit { rule_count, diagnostics }
         | superseded
}
```

`analyze_project` receives `restore_cache: bool`. Only initial analysis passes true;
refreshes, watcher catch-ups and compile-membership queries pass false. When true,
the command claims a `RuleStore` generation before blocking work, derives the
snapshot and plan once, attempts restoration, and installs a hit only through
`finish`. `not-requested` keeps ordinary analysis side-effect free.

Use a response wrapper rather than adding cache fields to each `ProjectAnalysis`
arm: configuration failure is still an analysis answer, while cache status is
independent. A configuration failure or plan rejection is simply a miss and never
reaches deserialization.

### Transition table

| Entry and interleaving | Backend rules | Frontend result | Disk cache |
| --- | --- | --- | --- |
| Open; valid hit; operation current | hit installs under its claimed generation | `restoring -> compiled`; cached diagnostics/count shown | `last_used` touched coarsely |
| Open; disabled, absent, invalid or corrupt entry | remains empty after opening reset | `restoring -> not-compiled`; no cache problem in Problems | unchanged except safe cleanup |
| Opening reset fails before analysis is issued | no restore generation is claimed; the failed reset remains the compile barrier | current opening reports its infrastructure failure and leaves Scan disabled | untouched |
| Edit or watcher event during restore | reset advances generation; late `finish` refuses | `restoring -> stale`; late response inert | entry retained pending later fingerprint |
| New Compile during restore | compile's `begin` is newer | compile owns build state and diagnostics | compile may use or replace entry |
| Project switched/closed during restore | transition reset supersedes restore | response changes nothing | unchanged |
| Initial analysis loses view order to a coverage catch-up while its restore is in flight | a hit may install only if its generation remains current | rejected view response changes no snapshot, but its independently current restore still settles `restoring` | unchanged except a completed coarse touch |
| Hit arrives after newer change analysis | change's reset wins | older response rejected | unchanged |
| Compile Workspace, valid hit | rules install through compile generation | identical to successful compile, without `Compiler` | usage time updated |
| Compile Workspace, miss | normal compile runs | existing compile behaviour | current success offered to cache |
| Compile Workspace begins while caching is enabled and available | capture its global Clear, project Clear and monotonic settings/write epochs before lookup or compilation | normal compile lifecycle | only this operation-wide claim may authorize later serialization and commit |
| Compile starts; Clear Current completes; compile finishes | fresh rules may still install through the compile generation | compile remains successful | the older project epoch refuses serialization/commit; no entry reappears |
| Compile starts; Clear All completes; compile finishes | fresh rules may still install through the compile generation | compile remains successful | the older global epoch refuses serialization/commit; no entry reappears |
| Compile starts; Disable completes; cache is re-enabled; compile finishes | fresh rules may still install through the compile generation | compile remains successful | the monotonic settings/write epoch refuses the old claim despite the current enabled value |
| Compile starts after the latest Clear/settings change | fresh rules may install through its generation | compile remains successful | its newer claim may serialize and commit normally |
| Compile starts while caching is disabled or unavailable | normal compilation runs without a write claim | compile result is unaffected | serialization is skipped, not merely refused after doing the work |
| Sources differ before and after a real compile | compiled rules are discarded before `RuleStore::finish` | current operation becomes `stale`; no mixed/stale success or diagnostics are shown | no commit |
| Compile succeeds but cache write fails | fresh rules still install | compile remains successful | previous generation remains |
| Clear Current/All with loaded rules | `RuleStore` untouched | Scan remains enabled | selected entries removed |
| Clear races an earlier write in this process | clear epoch makes completion order explicit | no build-state change | once Clear resolves, earlier work cannot reappear |

### Restoration, analysis and document ownership

Analysis currency and restoration currency are independent. In the table below, `A1`
is the initial analysis, `B2` is a later analysis of the same selection, `R1@s/r`
is the restoration producer identified by its frontend operation serial/revision,
`C@s/r` is a compile producer, and `G1`, `G2`, ... are backend `RuleStore`
generations. `none` in the owner column means that no operation remains entitled to
change build state. A coverage catch-up is explicitly different from `Changed`: it
may replace the visible snapshot, but it neither invalidates compiled bytes nor
creates a build-state producer.

| Case | Selected project | Initial / newest accepted analysis order | Restore op | Build-state owner | Backend generation | Cache result | Watch event | Auto-open / LSP-open owner | Final project phase / build state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ordinary current hit | P1 | A1 / A1 | R1@1/0 current | R1 | G1 installs | hit | none | selection P1, claimed by A1 | ready / compiled |
| Ordinary current miss, disabled or unavailable | P1 | A1 / A1 | R1@1/0 current | R1 until response | G1 remains empty | miss-like terminal status | none | selection P1, claimed by A1 when openable | ready / not-compiled |
| Coverage catch-up B overtakes restoring A | P1 | A1 / B2 | R1@1/0 current | R1 (B2 creates no producer) | G1 may install | hit or miss-like | Covered, catch-up | selection P1, pending attempt owned by B2 (or the first later accepted snapshot) | ready with B2 view / compiled on hit, not-compiled on miss-like |
| B begins its automatic read; accepted C overtakes B before that read finishes | P1 | A1 / C3 | R1@1/0 current | R1 (B2 and C3 create no build producer) | G1 may install independently | any current restoration result | Covered, then a newer catch-up/refresh without `Changed` | B2's pending presentation attempt is superseded by C3; B's completion is inert and C opens one document exactly once | ready with C3 view / restoration result owned by R1 |
| Hit installed by A, but A is rejected only as an older view response | P1 | A1 / B2 | R1@1/0 current | R1 until its cache arm settles | G1 installed before response | hit | Covered, catch-up | selection P1, not analysis order A1 | ready with B2 view / compiled; A never replaces B2 view |
| Reported source change overtakes A | P1 | A1 / B2 or none yet | R1@1/0 stale after revision 1 | invalidation at revision 1 | reset advances past G1 | superseded or late hit response | Changed | first accepted post-change snapshot for P1 | ready (or opening until one lands) / stale |
| Manual Refresh overtakes A | P1 | A1 / B2 or none yet | R1@1/0 stale after revision 1 | manual-refresh invalidation | reset advances past G1 | superseded or late response | none | first accepted current snapshot for P1 | ready / stale until a newer compile |
| Newer Compile overtakes A | P1 | A1 / A1 or B2 | R1 superseded by C@2/0 | C | G2 supersedes G1 | superseded or late response | none or catch-up | selection P1, claimed by first accepted snapshot | ready / compiling, then C's terminal result |
| Project switch or close | P2 or none | P1:A1 / none | R1 project-stale | P2's restoration or none | reset/new generation supersedes G1 | any late result | old subscription retired | every P1 attempt retired; P2 begins with presentation available | opening/ready for P2 or closed / P2 state or not-compiled |
| Backend `superseded`, correlated newer producer | P1 | A1 / any | R1 no longer current | concrete C or invalidation owner | generation newer than G1 | superseded | any | selection claim independent | phase unchanged / concrete newer owner's state unchanged |
| Backend `superseded`, no correlated newer producer | P1 | A1 / A1 or B2 | R1 still frontend-current | R1 until response | G1 was lost without a frontend producer | superseded | none or catch-up | selection P1 presentation independently reaches a terminal outcome | ready / not-compiled (never `restoring`) |
| Response application throws before analysis acceptance | P1 | A1 / none | R1 current | R1 until failure handling | G1 may be installed or empty | response or invoke failure | any | selection claim remains available to a later accepted snapshot | failed / not-compiled; failure trace identifies the edge |
| Response application throws after analysis acceptance | P1 | A1 / A1 | R1 current | R1 until failure handling | G1 may be installed or empty | any | any | A1's selection claim is retained if opening did not finish; otherwise already consumed | ready / not-compiled unless a concrete newer producer owns build state |
| Duplicate/re-entrant open of the same folder | P1 selection 2 | old A1 / new A1 | old R1 project-stale; new R2 current | R2 | reset and new G2 supersede G1 | either response | old subscription retired, new one armed | old selection attempts retired; new selection has independent presentation ownership | opening/ready for selection 2 / result owned by R2 |

The rows establish these invariants:

- `restoring` is valid only while exactly one identifiable restoration owner remains
  capable of settling it. Losing that owner must either transition the build state
  immediately or identify the newer owner that will do so. `unchanged` is not a
  terminal answer by itself.
- Analysis acceptance controls the visible project snapshot only. A response rejected
  solely because a newer analysis of the same selection was accepted may still settle
  its independently current restoration owner. It must never repaint the project view.
- A restoration outcome can change build state only when its selection and restoration
  operation are current. A backend `superseded` result is quiet only when a concrete
  newer frontend build producer is known; otherwise the restoration owner settles to
  `not-compiled`.
- `Changed`, manual Refresh, Compile, project switch and close explicitly replace or
  invalidate the restoration producer. A coverage catch-up does neither.
- Document auto-open belongs to the project selection, not exclusively to its initial
  analysis request. It is an owned `available -> pending -> terminal` transition, not a
  one-shot Boolean set before an await. A newer accepted snapshot may replace an older
  pending attempt; completion from the obsolete attempt is inert. Showing a document is
  committed at the synchronous editor-open/activation edge, so no successful
  interleaving can open two project documents through the LSP.
- Explicit navigation or New Rule retires a pending automatic presentation before its
  own first await and cannot later be displaced by it. Project switch and close retire
  the old selection and all of its attempts. Read failure, configuration failure and no
  openable source are explicit terminal outcomes: they are not retried for the same
  snapshot, but a newer accepted snapshot may make one new attempt. A shown or
  user-owned terminal outcome is never retried within the selection.
- Failure handling is valid before and after `ProjectSession.accept`. Once acceptance
  has settled an analysis order, failure bookkeeping for response application cannot
  depend on `failAnalysis` accepting that same request; it must still retire any
  restoration owner it holds and leave a terminal build state.
- Backend generation authority decides whether rules are installed; frontend producer
  authority decides whether installed rules may be advertised. Neither substitutes for
  the other.

### Polaris trace conclusion

The pre-correction `--debug` trace against an isolated copy of the reported Polaris
cache discriminated the failing interleaving. Initial A (analysis order 1) requested
restoration. The first coverage handoff reported `catchUp=true`; B (order 2,
`restoreCache=false`) completed and `session.accept(B)` returned true. A then finished
artifact deserialization, observed an equal second fingerprint, and
`finish_restoration` installed its claimed `RuleStore` generation with a hit. A's
frontend restoration operation was still current, but `session.accept(A)` returned
false and the old early return ran before any restoration decision or document open.
This proves the orphan was view-order rejection consuming an independently current
cache result, not slow deserialization, backend supersession or an apply exception.

After the correction, the same isolated release workflow produced the same A/B order.
B remained the visible snapshot, A was still rejected as a view response, and A's
current hit independently transitioned `restoring -> compiled`. The backend reported
19,809 rules and 4,344 diagnostics from the 29,034,140-byte artifact and
1,036,225-byte metadata; the selection's first document reached the LSP once. The
source tree and live cache were not modified, and the temporary profile and trace were
removed.

## What is fingerprinted

### Extending the implemented plan

`CompilationPlan` already contains the canonical project root, whether entrypoints
were declared or inferred, ordered entrypoints, ordered include directories, and an
identity-ordered transitive closure. Extend analysis/plan internally with:

- BLAKE3 digest and byte length for every readable source, computed from bytes
  `Builder::parse` already reads;
- resolved include-edge records for the plan closure: source identity, source-order
  index, raw include spelling and resolved target identity.

Edges are necessary even if source bytes and closure membership are unchanged. For
example, A can keep the raw spelling `include "common.yar"` while the first candidate
appears or disappears, switching resolution from B to C; if B and C are already in
the closure through other edges, source records alone do not say which one A used.

The frontend analysis DTO need not expose digests. They are backend compilation/cache
state, not presentation data.

### Per-input records

Each plan input contributes:

```text
SourceId (internal normalized relative identity, or canonical external identity)
byte length
BLAKE3 content digest
```

Modification times may be hints but never validity proof. External identities
contain sensitive paths and must not be persisted. Metadata uses a domain-separated
BLAKE3 pseudonym as a stable input reference. The validated current plan retains the
canonical external identity in memory so diagnostics can recover exact attribution
without placing that path in cache files, general logs or Preferences.

### Aggregate fingerprint

The aggregate fingerprint is BLAKE3 over an explicitly versioned canonical binary
encoding. Every variant/field has a tag; strings and bytes are length-prefixed;
integers have stated byte order. Do not hash JSON or Rust debug output.

Encode in this order:

1. domain separator `quipu-compiled-project`;
2. fingerprint encoding version;
3. Quipu compiler cache epoch;
4. exact `yara_x::VERSION`;
5. compiler profile constant (features/modules, wrapper strategy, include policy,
   optimization settings and native-serialization mode);
6. canonical project-root identity;
7. entrypoint origin and ordered entrypoint identities;
8. ordered canonical include-directory identities;
9. source records in `CompilationPlan::closure()` identity order;
10. closure edges ordered by `(from identity, source order)`;
11. future namespaces, globals or compile-time options when introduced.

The compiler epoch changes when semantics change without another encoded field. The
encoding version changes with the canonical encoding. The metadata schema changes
with storage JSON. They are separate numbers.

No extra discovered-inventory field is needed. With inferred entrypoints the current
plan already records the inferred roots and closure, so a relevant new file changes
them. With declared entrypoints an unrelated discovered file correctly does not
invalidate the plan. A broken project cannot hit because it produces no valid plan.

### Source consistency around load and compile

YARA-X follows includes and reads files after project analysis read them. Lookup also
takes time. A pre-operation fingerprint is therefore insufficient.

- Before installing a deserialized hit, re-open the project, derive a second valid
  plan and require the same fingerprint.
- After successful compilation, derive the plan/fingerprint again. The result may be
  installed and offered for persistence only if it equals the pre-compile
  fingerprint.
- Watcher/operation resets and the backend generation still supersede a result when a
  relevant event occurs during either interval.

A mismatch while loading is a transient miss. A mismatch after compilation discards
the newly built `Rules` **before** `RuleStore::finish`, returns a distinct
`source-changed` outcome, and commits nothing. If that response still owns
the frontend operation, the build state becomes **Stale** without presenting the
compile's diagnostics as current. Merely declining persistence is insufficient: the
compiler may have read a mixture of the two observations, and a watcher reset is not
guaranteed to have landed first. Never key an artifact under the later fingerprint:
the compilation occurred between observations.

This double observation inherits current compilation's unavoidable filesystem
boundary: a writer can change bytes and restore identical bytes while YARA-X reads.
The watcher normally observes that event and advances the generation. Eliminating the
ABA window completely requires an immutable filesystem snapshot or YARA-X include
loader API which 1.20.0 does not provide; this cache must not claim that guarantee.

| Source transition | First observation | Work performed | Second observation | Rules installed | Cache effect |
| --- | --- | --- | --- | --- | --- |
| unchanged before and during lookup | fingerprint A | validate and deserialize A | fingerprint A | hit may install through its claimed generation | coarse `last_used` touch |
| changed before lookup starts | fingerprint B | A fails the requested-fingerprint check or is absent | fingerprint B | none | miss; A is retained unless independently invalid |
| changed after lookup read, before second observation | fingerprint A | validate and deserialize A | fingerprint B | none | transient miss; A retained |
| changed after the load's second observation, before install | fingerprint A | validate and deserialize A | fingerprint A | only a still-current `RuleStore` generation may install | watcher/reset generation decides; entry retained |
| unchanged before and during compilation | fingerprint A | compile from the plan for A | fingerprint A | fresh rules may install through their claimed generation | stable/current success may commit A |
| changed before compilation analysis starts | fingerprint B | compile from the plan for B | fingerprint B | fresh B may install | stable/current success may commit B |
| changed after first observation, before or during compilation | fingerprint A | compiler may have read A, B, or a mixture | fingerprint B | none; discard before `RuleStore::finish` | no commit under either fingerprint |
| changed after the compile's second observation, before install/commit | fingerprint A | compile A | fingerprint A | only a still-current generation may install | watcher/reset and commit epoch/settings checks decide |
| bytes change and return to A between observations | fingerprint A | compiler/load may overlap an ABA write | fingerprint A | generation/reset is the available guard | allowed limitation; no stronger snapshot claim |

## Compatibility identity and serialization

YARA-X 1.20.0 provides `Rules::serialize` / `Rules::deserialize` and streaming
variants. Its data has magic bytes and an internal version, but Quipu additionally
validates:

- cache metadata schema and fingerprint encoding version;
- Quipu compiler cache epoch;
- exact `yara_x::VERSION` and compiler profile;
- project/target identity and fingerprint;
- artifact byte length and BLAKE3 digest;
- native-code mode and target information when applicable.

Any compatibility or metadata mismatch is a miss. Deserialize in a blocking worker
and contain panic with `catch_unwind`; malformed cache data must not poison
`RuleStore` or terminate the app. Failed compilations are never cached.

With native serialization disabled, artifacts contain portable WASM and YARA-X
rebuilds native code during deserialization. If enabled later, metadata records that
fact plus target identity. YARA-X can fall back to portable WASM, but a different
Quipu compiler profile still deliberately misses.

Store successful diagnostics with owned fields sufficient to reconstruct the current
`Diagnostic` DTO. YARA-X does not serialize warnings in `Rules`; dropping them would
make Problems depend on whether the result was cached. Diagnostic source attribution
is exact: metadata stores a stable input reference, never an external path, and load
resolves that reference through the validated current `CompilationPlan`. Failure to
resolve it uniquely is a corrupt miss rather than a partially attributed hit.

## Storage and trust boundary

### Locations

Resolve paths through the Tauri app handle:

```text
<app-cache>/compiled/v1/
    .global.lock
    locks/<project-id>.lock
    projects/<project-id>/default/
        metadata.json
        rules-<fingerprint>-<generation-token>.yarc

<app-config>/
    cache.json
    cache.lock
```

`project-id` is BLAKE3 over a domain-separated, platform-defined encoding of the
canonical root `OsStr` (Unix bytes; Windows wide units). It is local, not portable.
Moving a project causes a miss; its old entry is later evicted.

`default` is the only target now. Retaining that level avoids a layout migration if
manifests later gain multiple targets.

Never accept a cache path from the frontend or load `.yarc` from a project. Derive an
artifact basename from a validated lowercase fingerprint and a fixed-width lowercase
hex generation token created by the backend; do not accept an arbitrary metadata
filename. Reject symlinks/non-regular metadata and artifact files, never follow
symlinked directories during cleanup, and create private files/directories with
restrictive permissions where supported. The structural lock root, lock files and
cache-version directory are never entries and are never deleted by Clear or
maintenance. `cache.lock` is likewise structural configuration state, not a cache
entry.

`Rules::deserialize` warns against untrusted bytes. Digests detect corruption, not an
attacker able to rewrite artifact and metadata. The first implementation trusts the
private per-user cache against other same-user processes; cache files are not
authenticated.

### Managed cache state

Add backend `CacheManager` as Tauri managed state beside `SharedRules`. It owns:

- resolved cache/config roots and loaded settings;
- process-local serialization of load, commit, clear and quota operations;
- global and per-project Clear epochs plus a monotonic settings/write epoch captured
  by operation-wide write claims;
- coarse last-used updates, usage and the last availability/maintenance warning.

Filesystem work stays off the async/UI thread. Do not hold a cache lock while YARA-X
compiles or serializes. Before cache lookup or compilation can begin, the compile
operation asks the manager for a write claim containing the current global Clear,
project Clear and settings/write epochs. No claim is issued while caching is disabled
or its storage is already unavailable. A no-claim operation still compiles normally
but never serializes rules for the cache.

Before serialization, preparation takes the process-local filesystem-operation
permit and re-checks every captured epoch, the enabled setting, storage availability
and the current maximum. It refuses stale/ineligible claims before serialization.
The final commit repeats those checks after serialization. Clear increments the
applicable epoch before waiting for the permit and deletes while holding it. A
successful settings replacement monotonically advances the settings/write epoch,
including both Disable and re-enable. Therefore an old claim cannot be revived by a
later enabled value. Either an earlier commit finishes before Clear deletes it, or an
epoch refuses it; once Clear resolves, an earlier in-process operation cannot
recreate the entry.

Loads linearize under the same permit. If Clear or Disable gets there first, the load
is absent or disabled. If a load has already read and validated the artifact first,
Clear/Disable does not revoke those in-memory `Rules`: they may still install only if
their `RuleStore` generation remains current. This is the same rule as clearing an
already loaded ruleset, not an exception that bypasses generation ordering.

Cross-process filesystem operations take advisory locks in one order:

1. the global lock, shared for a one-project load/commit/Clear Current and exclusive
   for Clear All or a full maintenance/quota scan;
2. any project locks, in lexicographic project-ID order when there is more than one.

Clear All stops after acquiring the global lock exclusively. This is sufficient,
rather than an exception to lock ordering: every cooperating load, commit and Clear
Current must acquire the global lock shared before its project lock, so exclusive
global ownership excludes all of them. Taking every project lock as well would add no
mutual exclusion or cleanup proof. Operations which do take both lock levels always
retain global-then-project order.

Do not hold the manager's short-lived settings/epoch mutex while acquiring advisory
locks. Clear Current deletes only the target entry. Clear All and maintenance delete
only descendants of `projects/`; they preserve `.global.lock`, `locks/` and its lock
files. If either lock kind is unavailable, that cache operation is unavailable; do
not fall back to an unsafe multi-writer sequence. These locks prevent corruption and
make one Clear internally coherent, but do not strengthen the explicitly deferred
cross-process rule that an older proposal in another process may commit after Clear
has returned.

A settings command first takes the process-local filesystem-operation permit, then
uses the separate `<app-config>/cache.lock` for replacement and releases that config
lock before any lowered-limit maintenance takes cache locks. The config lock and
cache locks are never nested. This lets Preferences save “disabled” or a new limit
even when the cache directory is unavailable, while still preventing two processes
from tearing `cache.json`. After the config file commits, the command publishes the
new settings and advances the monotonic settings/write epoch while it still owns the
local permit. It does not return until lowered-limit maintenance has run. Thus local
settings commands cannot publish out of file order, and an older local commit either
linearizes before the settings command or is checked against the new values; it
cannot land after that command returns.

The project currently open is supplied to quota/management operations and converted
to a backend-derived ID, so it can be pinned from automatic eviction. Failure to
canonicalize this optional root removes the pin; it does not reject a global settings
change which does not otherwise depend on that project. No cache path or project ID
from the webview is trusted directly.

## Metadata and commit protocol

The concrete versioned metadata contains at least:

```json
{
  "schema": 3,
  "fingerprintEncoding": 1,
  "compilerCacheEpoch": 1,
  "yaraXVersion": "1.20.0",
  "compilerProfile": "quipu-yara-x-portable-v1",
  "projectId": "...",
  "target": "default",
  "fingerprint": "...",
  "inputs": [
    { "identity": { "external": false, "path": "rules/main.yar" },
      "bytes": 1234, "digest": "..." }
  ],
  "artifact": {
    "generation": "0123456789abcdef0123456789abcdef",
    "bytes": 456789, "digest": "...",
    "nativeCode": false, "target": null
  },
  "ruleCount": 42,
  "diagnostics": [
    { "inputReference": { "external": true, "path": "external:<pseudonym>" },
      "severity": "warning", "code": "...", "title": "...",
      "line": 1, "column": 1, "span": { "start": 0, "end": 1 } }
  ],
  "createdUnixSeconds": 1787683200,
  "lastUsedUnixSeconds": 1787683200
}
```

The example's `identity.path` and each diagnostic `inputReference.path` are literal
only for project-internal identities. A diagnostic reference retains the complete
tagged identity (`external` plus `path`); the path string alone is not unique because
a valid internal relative identity may equal an external pseudonym string. Storing
an external identity's canonical path would
contradict the privacy requirement that external source paths never enter the cache.
External identities therefore use the same domain-separated BLAKE3 pseudonym in
input records and diagnostic references, while the plan fingerprint still covers
the canonical identity bytes. During load, validated current-plan inputs provide a
one-to-one reference-to-`SourceId` map. Reconstructing the diagnostic obtains the
same canonical/openable `file` value as fresh compilation from that in-memory map.
Thus metadata fidelity and external-path privacy are both required; replacing the
file with `None` is not compliant.

Metadata and artifacts have separate hard ceilings, both distinct from the
configurable total-cache quota. `MAX_METADATA_BYTES` is 16 MiB. The reported Polaris
project produced 1,557,906 bytes of metadata for 4,344 diagnostics and 19,809 rules,
so this is more than ten times the observed real-project metadata and allows roughly
40,000 diagnostics at that aggregate density. It is nevertheless only one sixteenth
of the artifact ceiling and bounds both the serialized buffer and the untrusted JSON
read/parser exposure. Metadata is compact JSON streamed through a fallible
ceiling-enforcing writer. It is never pretty-printed into an unbounded `Vec` and then
measured. Crossing the ceiling stops serialization without truncating or omitting an
input or diagnostic.

`MAX_ARTIFACT_BYTES` is a hard 256 MiB per-artifact ceiling. Portable YARA-X
deserialization materializes code and supporting structures in one process, so
accepting a single artifact near the 1 TiB settings ceiling would make the quota an
unsafe read bound. 256 MiB is deliberately generous compared with the measured 20
KiB/250-rule representative artifact while bounding temporary memory multiplication.
Changing either independent ceiling requires new measurements and a contract/version
review.

The artifact filename is derived as
`rules-<fingerprint>-<generation-token>.yarc`. The token names this validated
serialization, not the source state; two serializations with the same fingerprint
still receive different tokens. It is 128 bits from the operating system's random
source, encoded as exactly 32 lowercase hexadecimal characters; inability to obtain
one makes persistence unavailable.

A compile captures its write claim before lookup or compilation. Given that claim, a
commit is:

1. revalidate the write claim and storage eligibility under the local permit; refuse
   before serialization if stale, disabled, unavailable or already ineligible;
2. serialize through a ceiling-enforcing writer while computing artifact
   length/digest; stop once `MAX_ARTIFACT_BYTES` would be exceeded;
3. generate a fresh safe generation token and stream complete compact metadata into
   a fallible buffer that refuses the byte which would cross `MAX_METADATA_BYTES`;
   then refuse persistence if the proposed live entry (artifact plus metadata)
   exceeds the current maximum;
4. create a unique same-directory temporary with create-new semantics;
5. write/flush it and `sync_all` the file;
6. atomically install its unique fingerprint-and-token artifact name without
   replacing another file (a token collision retries rather than overwrites);
7. write complete metadata to another create-new temporary and sync it;
8. atomically replace `metadata.json` and sync the directory where supported—this is
   the commit point;
9. remove only the previous generation named by replaced metadata;
10. enforce quota.

The initial eligibility check runs under the process-local permit and releases it
before serialization. The final epoch/settings check and steps 4-10 run under that
permit and the global-shared/project advisory locks described above. Serialization
does not hold them, so Clear/settings changes can proceed and invalidate the claim.

Use one tested platform abstraction for atomic replacement; do not assume Unix rename
replacement on Windows. Metadata committed last means a crash before step 7 leaves
the previous generation and its distinct artifact readable, even when the new
serialization has the same fingerprint. A new unreferenced artifact is an orphan,
removed once maintenance holds the locks and proves that no committed metadata names
it. Temporary names carry process/random/counter identity and are likewise removable
once those locks prove that no writer can still own them. Never append, overwrite or
write an artifact in place.

In this transition table, O is the old metadata/artifact generation and N is the new
one. “Live” means named by the one committed `metadata.json`; mere byte equality or a
matching fingerprint is not ownership.

| Boundary or interleaving | Committed metadata | Cache files after the operation | API result and cleanup licence |
| --- | --- | --- | --- |
| No previous entry; claim is absent/stale or serialization/token generation fails | absent | no final artifact | serialization is skipped for an ineligible claim; otherwise persistence is unavailable and fresh in-memory rules remain |
| O exists; writing/syncing N's temporary fails | O | O plus at most Quipu's create-new temporary | O remains readable; that uniquely named temporary may be removed under the locks |
| O exists; N's final artifact is installed, then metadata writing/sync fails or the process crashes | O | O and unreferenced N | O remains readable; N may be removed only after maintenance holds the locks and sees that metadata still names O |
| Metadata replacement commits | N | O and N until cleanup | N is the sole live generation; only O's validated artifact name from the displaced metadata may be removed |
| O and N have the same fingerprint | O before metadata commit, N after it | distinct tokenized artifacts | exactly the same rules as above; N never overwrites O merely because their source fingerprint matches |
| Removing O after N commits fails | N | N plus unreferenced O | commit still succeeds; O is a maintenance orphan and counts toward usage until removed |
| A compile with an older operation-wide claim reaches preparation/commit after Clear | O or absent | ordered by the local permit and epochs | either it committed first and Clear removed it, or Clear's advanced global/project epoch refuses it; after Clear returns it cannot reappear |
| Cache is disabled while a claimed compile runs or serializes | O | O only | monotonic settings/write epoch refuses the claim; disabling retains O and loads nothing from it |
| Cache is disabled then re-enabled before an older compile finishes | O | O only | the current enabled value does not revive the claim because both settings changes advanced the monotonic epoch |
| Compile begins while disabled/unavailable | O or absent | unchanged | no write claim is issued and no cache serialization occurs |
| Legitimate metadata is above the former 1 MiB limit but at or below 16 MiB, and the entry fits the configured maximum | N | N after cleanup | compact bounded serialization completes; every diagnostic and tagged internal/external attribution commits and a subsequent load is a hit |
| Artifact serialization crosses 256 MiB | O or absent | unchanged | `artifact-over-limit`; ceiling-enforcing serialization aborts without creating a project/target entry; fresh rules remain installed and Preferences receives the artifact-specific warning |
| Compact metadata serialization reaches the 16 MiB boundary exactly | N | N after cleanup | the final byte is accepted and the complete metadata may commit if the entry fits the configured maximum |
| Compact metadata serialization attempts one byte beyond 16 MiB | O or absent | unchanged | `metadata-over-limit`; the writer refuses that byte, no truncated metadata or project/target entry is created, and Preferences receives the metadata-specific warning |
| Artifact and metadata each fit their independent ceilings but their sum exceeds the configured maximum | O or absent | unchanged | `quota-exceeded`; no project/target entry is created and Preferences reports the configured-quota rejection rather than an independent safety rejection |
| Preparation cannot build diagnostic metadata, allocate, or serialize the artifact | O or absent | unchanged | `unavailable`; compilation remains successful and Preferences receives a preparation/serialization warning without source text or paths |
| Commit cannot create/lock/write/sync storage or serialize metadata for a non-size reason | O or absent | O plus only protocol-licensed temporary/orphan debris | `unavailable`; compilation remains successful, O stays authoritative, and Preferences receives a storage/serialization warning |
| Clear/Disable wins the permit before a load | O or absent | retained on Disable, removed on Clear | the load answers disabled/miss and installs nothing |
| A load validates O before Clear/Disable wins the permit | O or absent afterwards | retained on Disable, removed on Clear | O is already in memory and may still install only through its claimed `RuleStore` generation |
| Clear Current/All while O's rules are loaded | absent for the selected entries | artifacts/metadata removed; structural locks retained | clear succeeds without touching `RuleStore`; the already loaded rules remain scannable |
| Another process made its proposal before Clear but commits after it | absent, then N | N | safe and uncorrupted but allowed by the stated cross-process non-goal; Preferences must not claim otherwise |
| Clear, Disable, or a newer settings epoch invalidates preparation/commit | O or absent | Clear removes the selected entry; Disable/settings supersession retains O | `declined(clear|disable|superseded)`; this is expected ordering, produces no warning, and does not clear an unrelated earlier warning |
| A later eligible persistence commits after an earlier persistence warning | N | N after cleanup | `committed`; the persistence warning is cleared because current storage and policy accepted a complete entry; unrelated settings/maintenance warnings remain until their own successful operation supersedes them |

The persistence rows establish these invariants:

- every eligible preparation and commit returns one typed class: committed, expected
  decline, independent artifact rejection, independent metadata rejection,
  configured-quota rejection, or unavailable storage/serialization;
- expected Clear/Disable/settings supersession is quiet, while every safety, quota,
  allocation, serialization, lock, write and sync rejection records a backend-owned
  cache warning available through cache status and Preferences;
- preparation and commit outcomes are consumed explicitly by the compile pipeline;
  no `.ok()`, discarded result or generic over-limit arm may erase their class;
- no size/policy rejection creates a project/target directory that could be mistaken
  for a committed entry, and no failure replaces the prior authoritative metadata;
- a cache persistence failure never changes compile success, installed rules,
  diagnostics, or rule count, and never becomes a Problems diagnostic;
- a successful later persistence clears the last persistence warning. Expected
  declines leave it intact. Successful settings, maintenance, load-touch and clear
  operations may clear only warnings owned by that operation class, so one success
  cannot hide a still-current unrelated failure.

| Owned path/state | Before metadata commit | After metadata commit | Cleanup owner and proof |
| --- | --- | --- | --- |
| artifact temporary created by this proposal | may be removed by this proposal while it still owns its create-new name; otherwise retained | never referenced | maintenance may remove only while holding global-exclusive and all affected project locks |
| final artifact N, metadata still names O | unreferenced orphan; never replaces O, including at the same fingerprint | not applicable | maintenance proves no metadata names N before removal |
| final artifact N, metadata names N | not yet live | sole live artifact | only later committed metadata, Clear, or maintenance of invalid metadata may license removal |
| displaced artifact O, metadata now names N | live until the commit point | orphan named by validated displaced metadata | committing proposal may remove exactly O; failed removal belongs to maintenance |
| malformed or unsafe metadata/artifact name | never trusted to derive an arbitrary path | never live | remove only the cache-owned regular file itself; never follow a symlink or descend through it |
| structural global/project/config lock | always infrastructure | always infrastructure | no Clear or maintenance operation removes it |

### Clear, disable and in-flight operations

| Operation that reaches the local permit first | Concurrent operation | Linearized result |
| --- | --- | --- |
| load | Clear Current/All | validated rules may leave the permit in memory; Clear removes disk state and does not revoke them; generation still controls installation |
| Clear Current | load for that project | load observes absence after Clear and misses |
| Clear All | any load | load observes absence after Clear and misses |
| load | Disable | validated rules may leave the permit in memory; Disable retains files and does not revoke them; generation still controls installation |
| Disable | load | load observes disabled and reads nothing |
| commit with matching captured epochs | Clear Current/All | commit lands first; Clear removes it before returning |
| Clear Current | compile with an older claim for that project | project epoch advances before waiting; preparation/commit is refused even if compilation had not reached serialization |
| Clear All | compile with any older claim | global epoch advances before waiting; preparation/commit is refused even if compilation had not reached serialization |
| commit | Disable | commit lands first; Disable retains it and prevents later proposals |
| Disable | compile with an older claim | enabled is published and the settings/write epoch advances under the permit; preparation/commit is refused |
| Disable then re-enable | compile whose claim predates Disable | enabled is true but the monotonically newer settings/write epoch still refuses the claim |
| Any successful settings change | compile with an older claim | monotonically advancing settings/write epoch refuses the old policy snapshot; a later compile may capture the new one |
| newer compile after Clear/settings change | earlier operation is complete | it captures current epochs and may prepare/commit normally |
| Clear Current | loaded current-project rules | disk entry removed; `RuleStore` untouched and Scan remains available |
| Clear All | loaded rules from any project | disk entries removed; `RuleStore` untouched and Scan remains available |
| any operation cannot acquire its required lock | any | this cache operation is unavailable; project opening, compilation and installed rules remain usable |

## Read protocol and failures

Under the global-shared and project locks:

1. read bounded metadata (reject excessive size before JSON parsing);
2. validate schema, compatibility, project, target and fingerprint;
3. validate the fixed grammar of the generation token and derive the artifact path
   from the validated fingerprint and token;
4. require regular non-symlink files and reject either declared or actual artifact
   length above `MAX_ARTIFACT_BYTES` before allocation, reading or hashing;
5. reserve the accepted exact length fallibly, fill exactly that initialized vector
   without any capacity-growing read helper, then probe one additional byte into a
   fixed stack buffer; truncation, growth or allocation failure is a corrupt miss;
6. deserialize inside `catch_unwind`;

Then release the cache locks before touching project sources again:

7. re-derive current plan/fingerprint;
8. install only through the claimed rules generation.

| Failure | Behaviour |
| --- | --- |
| absent entry, disabled cache, fingerprint/compatibility mismatch | ordinary miss; retain unless maintenance proves invalid |
| malformed/oversized metadata, declared or actual artifact above 256 MiB, digest mismatch, truncated artifact, allocation failure, deserialize error/panic | delete or quarantine only cache-owned generation without reading/hash/deserialization; miss |
| cache directory, permission or lock unavailable | continue without cache; expose status in Preferences/logging |
| source fingerprint changes during load | miss; install nothing |
| source fingerprint changes during compile | discard the new rules before installation, return source-changed, and do not persist |
| artifact or metadata safety ceiling after compile | keep fresh rules; preserve previous generation; record the specific independent-ceiling warning |
| configured entry quota after compile | keep fresh rules; preserve previous generation; record a distinct configured-quota warning |
| preparation/serialization/commit unavailable after compile | keep fresh rules; preserve previous generation; record the stage-specific persistence warning |
| Clear/Disable/newer-settings invalidation after compile | quiet expected decline; keep fresh rules and the disk state selected by the winning operation |
| interrupted write | previous metadata remains authoritative; orphan cleaned later |

Cache failures do not go in Problems, which is for project, compiler and watcher
problems. Preferences shows availability and last maintenance error; logs use terse
reasons without source text or external paths.

## Quota and maintenance

Only one metadata-referenced generation is live per project/target. A failed compile
does not delete the last good entry; its fingerprint simply will not match changed
sources.

An I/O failure while inspecting metadata or hashing an artifact is not evidence
of corruption. Maintenance leaves that entry untouched and reports incomplete
maintenance, so a later lookup can retry. This includes Windows sharing violations
when another process temporarily holds either file open exclusively. Proven
corruption, missing artifacts and digest mismatches remain eligible for cleanup.

Maintenance runs after commit, after lowering the limit, when Preferences refreshes
usage, and once in the background at startup. With the global-exclusive lock held,
and project locks taken in ID order, it:

1. remove cache temporaries, metadata-unreferenced artifacts and proven-invalid
   entries, without following symlinks;
2. reject a live entry whose declared or actual artifact exceeds
   `MAX_ARTIFACT_BYTES` using file metadata alone, before any artifact allocation,
   read, hash or deserialization;
3. total every remaining regular file beneath `projects/`, including an orphan or
   temporary whose deletion failed, while separately identifying each live entry's
   metadata-plus-artifact size;
4. sort eligible live entries by `lastUsedUnixSeconds` (absent/invalid oldest);
5. skip the current project supplied to the operation;
6. evict LRU entries until total managed usage is at or below 80% of maximum or no
   eligible entry remains.

If only a pinned entry remains, usage may exceed the low-water target (for example,
after the user lowers the limit). An unremovable orphan can do the same and is
reported as a maintenance warning rather than hidden from usage. A newly compiled
entry larger than the maximum, including its metadata, is usable in memory but never
committed. Structural lock files are excluded from managed usage. Directory scanning
is sufficient; do not add a database before measurement.

Update `lastUsedUnixSeconds` atomically at most once per hour. A failed timestamp
touch does not turn a hit into a miss.

### Quota and usage transition table

| Observed managed state | Active-project pin | Maintenance action | Reported result |
| --- | --- | --- | --- |
| Total is at or below the maximum | any or none | clean proven temporaries/orphans/invalid entries; do not evict a live entry | exact remaining total and per-current-project usage |
| Total exceeds the maximum and eligible live entries exist | skip the pinned project | order by `lastUsedUnixSeconds`, then project ID and target; evict until total is at or below 80% of maximum | exact post-eviction usage |
| Two eligible entries have the same last-used second | neither pinned | the lexicographically smaller project ID/target tuple is evicted first | deterministic usage and survivor set |
| The oldest entry is the active project | oldest is pinned | skip it and consider the next eligible entry | active entry retained even if a newer entry is evicted |
| Only the pinned entry remains above the low-water target | sole live entry pinned | retain it; stop with no eligible victim | over-target usage remains visible with a maintenance warning |
| A regular orphan/temporary cannot be removed | any | retain and count its exact bytes; continue with other safe work | usage includes it and warning reports incomplete maintenance |
| A new entry alone exceeds the configured maximum | new project is active | refuse before creating its artifact or metadata | fresh in-memory rules remain usable; old committed entry survives |
| Metadata is above 1 MiB but no more than 16 MiB and the entry fits the maximum | new project is active | stream compact complete metadata and commit normally | exact diagnostics/count/attribution are available on the next hit |
| Metadata attempts to cross 16 MiB | any | bounded writer refuses before entry-directory creation | independent metadata warning; no partial entry and no quota misclassification |
| Metadata declares, or the filesystem reports, an artifact above 256 MiB | any or none | invalidate/remove the cache-owned entry from lengths alone; never allocate, read, hash or deserialize the artifact | exact remaining usage, or retained bytes plus warning if cleanup fails |
| Commit crosses the high-water limit | committed project pinned | the commit remains authoritative, then quota runs under the same local permit | other eligible entries are evicted toward low water; current commit is retained |
| Limit is lowered below current usage | supplied current project pinned | publish settings in file order, then run maintenance before returning | exact post-maintenance usage; pin/failure excess remains visible |
| Preferences refresh or startup maintenance sees no cache directory | supplied current project or none | create/inspect the managed layout if available; otherwise degrade without project failure | zero usage or unavailable status, never a Problems diagnostic |
| Valid hit is less than one hour since the last touch | that entry | deserialize normally; do not rewrite metadata | hit and unchanged timestamp |
| Valid hit is at least one hour since the last touch | that entry | atomically replace metadata after full validation | hit and updated timestamp; touch failure leaves the hit valid and records a warning |

## Settings and Preferences

Backend settings live in `<app-config>/cache.json`, not webview storage:

```text
schema = 1
enabled = true
maximum_bytes = 1073741824
```

Missing config uses defaults. Malformed/unwritable config also uses safe runtime
defaults and exposes a warning. Writes use create-new temporary plus atomic replace
under `cache.lock`; a successful write updates the running manager only after the
replacement commits. The enabled switch is authoritative; maximum zero is not a
second spelling of disabled. The first UI accepts whole MiB from 1 MiB through 1 TiB
(inclusive), converts with binary units, and the backend enforces the same byte range;
zero, non-MiB byte values, fractions, overflow and values outside that range are
validation errors rather than silently changed values. Backend validation requires
`maximum_bytes % 1,048,576 == 0`; frontend conversion is not trusted as proof.

Backend commands provide:

- settings, effective path, total/current-project usage and last warning;
- update enabled/maximum and enforce a lowered limit immediately;
- clear current project;
- clear all.

Commands accept a project root only where current-project identity or eviction
pinning needs it; backend canonicalizes and hashes it. They never accept cache paths,
project IDs or artifact names.

Implement **File > Preferences…** as bundled modal `<dialog>` following About's
accessibility pattern. Initial controls:

- **Enable compiled-rules cache**;
- **Maximum size** with validated units;
- **Current usage** and **Current workspace usage**;
- read-only effective location;
- **Clear Current Workspace Cache** (disabled without project/entry);
- **Clear All Caches**;
- inline availability/settings errors and Close.

Show the dialog before asynchronous usage scanning finishes, with a loading state.
Settings-save failure keeps entered values and displays the error. Clears ask through
the native dialog helper. Capture the root named by a current-project question and
send that root, so switching while the question is open cannot clear the new project.

Cache clears are acceleration changes, not document changes, so they do not use
`authorising.ts`'s destructive-document gates. They are still ordered by
`CacheManager`; Cancel changes nothing.

### Preferences request transition table

| Request/interleaving | Backend authority | Dialog result | Rules/build state |
| --- | --- | --- | --- |
| Preferences opens | status/usage command receives the root current at request creation | modal is visible and focused immediately with usage loading | unchanged |
| Status/usage succeeds and its request/root are still current | backend settings, effective path, exact usage and warning | replace loading fields; enable Clear Current only for a live current entry | unchanged |
| Status/usage fails or cache is unavailable | backend error/availability status | keep dialog open and show inline error/unavailable warning; never add a Problem | unchanged |
| Project switches while status/usage is pending | old response still describes only its captured root | discard it and refresh for the new current root; an older request never repaints newer data | unchanged |
| Valid settings save succeeds | config lock plus atomic replacement commits before runtime publication; lowering waits for pinned maintenance | controls retain backend-returned normalized settings and refreshed usage | unchanged; disabling does not unload rules |
| Backend receives an in-range maximum not divisible by one MiB | current settings remain authoritative | save fails validation and entered values remain visible | unchanged |
| Optional active root cannot be canonicalized during a global settings save | save proceeds without an eviction pin; all other validation and atomic ordering still apply | normalized settings and refreshed global usage are shown | unchanged |
| Settings validation or write fails | old backend settings remain authoritative | keep the user's entered values and show inline error | unchanged |
| A newer settings/status request overtakes an older one | backend operations remain serialized independently | only the newest dialog request may repaint fields or errors | unchanged |
| Clear Current clicked with no current live entry | no command issued | control disabled | unchanged |
| Clear Current confirmation is cancelled | no command issued | values unchanged | unchanged |
| Project switches while Clear Current confirmation is open, then user confirms | command receives the root captured by that question, never the new root | old project's entry is cleared, then status refreshes for the project current now | unchanged; no reset |
| Clear All confirmation is cancelled | no command issued | values unchanged | unchanged |
| Clear Current/All succeeds | manager clear epoch and local permit define completion | refresh exact usage and show no cache error | loaded rules remain scannable |
| Clear Current/All fails | cache state is not claimed cleared | keep dialog open and show inline error/warning | loaded rules remain scannable |
| Escape or Close while a Clear request is pending, then Preferences reopens | pending backend work may finish safely under the old dialog generation | old failure and old busy-state completion cannot repaint the reopened dialog | unchanged |
| An old Clear succeeds after Preferences closes/reopens | clear remains authoritative backend work | do not apply old busy/error state; start a new status request owned by the current dialog generation | unchanged |
| Escape or Close while any request/confirmation is pending | pending backend work may finish safely | dialog closes; dialog/request tokens prevent a late repaint on next open | unchanged |

## Observability

Internal outcomes distinguish: not requested, disabled, hit, absent/fingerprint/
compatibility miss, corrupt entry removed, restore superseded, source changed during
compile, committed persistence, expected persistence decline (Clear, Disable or a
newer settings epoch), independent artifact over-limit, independent metadata
over-limit, configured entry-quota rejection, unavailable preparation/serialization
or storage, evicted, and current/all cleared.

The manager owns warnings by class. A genuine persistence rejection replaces the
previous persistence warning with specific path-free copy. A later committed entry
clears that persistence warning; an expected decline neither sets nor clears it.
Warnings from invalid settings, maintenance, last-used touching or an unavailable
cache location have separate ownership and are cleared only when the corresponding
later operation demonstrates recovery. Cache status returns the currently relevant
warning for Preferences. None is emitted as a Problems diagnostic, and warning text
contains neither project source nor internal/external filesystem paths.

The build line exposes only **Checking compiled cache…**, **Compiled**, **Not
compiled**, and existing **Stale**. Detailed cache reasons belong in logs, tests and
Preferences, never Problems. Never log source bytes or external include paths unless
an existing project diagnostic owns them.

### Opt-in troubleshooting trace

`quipu --debug` enables the permanent cross-layer troubleshooting mode. The first
stdout record states that tracing is enabled, and every later record is one compact
JSON object on one line with schema `quipu-debug-v1`, layer, trace ID, monotonic
layer-local sequence number, layer-local elapsed milliseconds, event name and
structured fields. Frontend and backend elapsed clocks have independent origins;
neither elapsed values nor their sequence numbers globally order the combined file.
Stdout line order is backend receipt/write order, not exact event chronology. Causal
selection, analysis, operation, generation and subscription identities are the
authoritative cross-layer correlation. Backend records are written to stdout and
flushed promptly; frontend records go to the Web Inspector console and are also
mirrored to stdout. Release builds programmatically open the Inspector only in this
mode. Without the exact argument the backend emits no trace records, evaluates no
trace-only field producers, the bounded frontend startup buffer and document identity
state are discarded, and the Inspector is not opened.

`cache_persistence` records preparation and commit outcomes separately from compile
success. They also report whether post-commit maintenance retained the active entry.
Storage failures include a fixed operation label and, where available, a numeric
OS error code; OS error text, project paths, source and diagnostic bodies are omitted.

Tracing is observation only. Its sink is injectable in tests, frontend callbacks are
contained, and backend records use a fixed-capacity non-blocking queue without
acquiring application locks or calling trace consumers while such locks are held.
Blocked output drops records instead of blocking application work or growing memory;
the writer emits at most one redacted `trace_records_dropped` count after each
dequeued data record, so sustained overload cannot starve retained records. The
frontend mirror likewise has a bounded in-flight backlog, contains rejected IPC
promises, and emits its own `trace_records_dropped` count for overflow and rejected
delivery after a retained record makes room. A rejected final data record makes one
terminal summary attempt; a rejected summary preserves its count but does not retry
itself until later data arrives. Records use project fingerprints,
opaque project/document IDs, operation
identities and counts. Mirrored frontend input is parsed through a strict event and
field allowlist with bounded identity/numeric/string values and no extra top-level
keys; arbitrary event names, object keys and free-form strings cannot cross the
boundary. The trace boundary redacts path-, source-, target-, text-, message- and
diagnostic-bearing fields and absolute paths in exception stacks. Source contents,
diagnostic bodies, scan-target bytes, external paths and unrestricted absolute paths
are forbidden.

The restoration sequence records both authorities needed to diagnose an orphan:
project selection and analysis order; operation serial/revision before invocation and
after response; `restoreCache`; `RuleStore` generation before/after begin, reset and
finish; watcher coverage, `Changed` and catch-up edges; `session.accept`, failure and
finish results; restoration decisions; every build-state transition and owner; and
LSP readiness, document identities and diagnostic counts. A cache lookup records
lock, bounded metadata read, bounded artifact read/hash, deserialization, rule-count
validation, both fingerprints, and final install/supersession without recording the
underlying paths or diagnostic text.

## Testing and mutation requirements

Most tests are Rust tests over temporary cache/config roots with injected clock,
compiler, filesystem/commit and failure seams.

### Fingerprints

- stable across repeated analysis and enumeration order;
- invalidated by source content/identity, entrypoint order/origin, include-directory
  order, compiler profile, YARA-X version and epoch;
- transitive/external inputs included;
- edge-target change invalidates even with unchanged closure membership;
- explicit entrypoints ignore unrelated files; inferred roots change for relevant
  additions;
- invalid projects produce no restorable fingerprint.

### Storage and compatibility

- serialize/deserialize with equivalent scan results;
- cached warnings/count and complete `Diagnostic` DTOs equal fresh response,
  including openable external-source file attribution without a persisted external
  path;
- corrupt, truncated, oversized and symlink metadata/artifacts;
- sparse artifacts above the independent 256 MiB ceiling are rejected from file
  metadata without allocation, reading, hashing or deserialization;
- incompatible schema/version/profile/epoch/native mode;
- deserialize panic contained as miss;
- crash injection before artifact install, before metadata commit and after commit;
- previous generation survives each pre-commit failure;
- replacing a corrupt or nondeterministic artifact at the same fingerprint uses a
  distinct generation token, and every pre-commit crash retains the old artifact;
- cleanup removes only cache-owned old/orphan files;
- Clear Current preserves structural locks and takes global-shared before its project
  lock; Clear All preserves structural locks and its global-exclusive lock is proven
  sufficient because it excludes every cooperating global-shared project operation;
- read-only/unavailable roots and failed lock degrade safely.

### Ordering

- switch, edit/watcher reset and newer compile supersede restore at backend and UI;
- opening miss never invokes compiler;
- Compile hit invokes no compiler; miss invokes it once;
- post-load fingerprint change installs nothing; post-compile fingerprint change
  installs and commits nothing and reports **Stale** for a still-current operation;
- Clear completion prevents an older proposal reappearing;
- a write claim captured before lookup/compilation is invalidated by Clear Current,
  Clear All and the monotonic settings/write epoch; Disable/re-enable cannot revive
  it, while a genuinely newer compile may commit;
- disabled/unavailable compile operations and claims invalidated before preparation
  do not serialize;
- clearing disk leaves loaded rules scannable;
- disabling during a proposal prevents commit and retains existing files;
- persistence failure does not change compile success.

### Quota and UI

- one generation/project, exact usage, high/low-water eviction, deterministic LRU
  ties, active pinning and oversized artifacts;
- coarse last-used writes and failed touch;
- settings defaults, malformed config, atomic update and lowered-limit enforcement;
- backend whole-MiB validation and a non-canonical optional active root which removes
  only the eviction pin;
- Preferences focus/Escape, loading/errors, validation, no-project state,
  confirmations, clear-request dialog currency and menu wiring;
- one app-level smoke test reopens unchanged project into scan-capable cached rules
  without compiler invocation.

Mutation probes must weaken at least one fingerprint field, artifact digest,
post-operation fingerprint check (including allowing a changed compile to install),
generation check, `restoring` reset, metadata-last/unique-generation commit, clear
epoch, quota pin and unavailable fallback. Additional probes move write-claim capture
back to post-compile preparation, remove the monotonic Disable/re-enable barrier,
remove the per-artifact ceiling, degrade external diagnostic attribution, accept a
non-MiB backend maximum, reject settings when only the optional pin cannot be
canonicalized, and allow stale clear UI work to repaint a reopened dialog. Each must
fail an intended test and be reverted textually. The artifact-ceiling probe uses only
safe sparse-file observation and must not attempt memory exhaustion.

Native/pixel tests are not cache-correctness authority. A focused X11 menu scenario
should still prove Preferences is enabled, opens, reports the isolated test cache
location, and closes with Escape.

## Implementation sequence

Keep each phase green; do not start with Preferences, which depends on stable backend
semantics.

1. **Plan evidence and fingerprint.** Add BLAKE3, digest/length and closure-edge
   evidence; implement canonical encoding and compatibility constants with tests.
2. **Cache core.** Add settings, project IDs, metadata, bounded reads,
   serialize/deserialize, unique-generation metadata-last commit, structural
   global/project locking, clear epochs and failure seams in a Tauri-free `cache`
   module.
3. **Compile integration.** Lookup before compiling, retain diagnostics, revalidate
   post-compile fingerprint, discard rather than install a changed result, commit only
   a current stable result, and make persistence non-fatal. Leave scratch unchanged.
4. **Open/restore integration.** Extend analysis IPC/response, add `restoring`, retain
   opening operation and prove operation/reset/generation interleavings.
5. **Maintenance.** Add generation/orphan cleanup, usage, coarse LRU, high/low-water,
   active pinning and oversized handling.
6. **Preferences and commands.** Add management IPC, modal dialog, File-menu item,
   native clear confirmations, menu-shape tests and focused X11 scenario.
7. **Measurement.** Record representative portable artifact sizes,
   serialization/deserialization and fresh-compile times; revisit 1 GiB and decide
   separately whether native serialization is worthwhile later.

## Decisions deliberately deferred

- More than one generation per project/target.
- A cache database/index.
- Complete elimination of the external-writer ABA window pending immutable inputs or
  a YARA-X include-loader API.
- Native-code serialization in release builds.
- Multiple manifest compilation targets.
