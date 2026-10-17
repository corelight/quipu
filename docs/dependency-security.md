# Dependency security exceptions

Quipu's automated dependency audit fails on known vulnerabilities unless an
exception is listed here with a specific rationale. Exceptions are temporary
and must be reconsidered whenever the affected dependency or its parent stack is
updated.

The assessments below cover the dependency graph locked on 2026-10-01, with
RUSTSEC-2026-0327 assessed against that unchanged graph on 2026-10-04. An
additional macOS review of the `quick-xml` exceptions was completed on 2026-10-07.
The Tauri 2.12.1 dependency update was reassessed on 2026-10-08: the GLib and
plist API checks below still hold, and the locked YARA-X/RSA/Wasmtime versions
are unchanged. The all-target Wasmtime feature graph still enables neither
WASI nor component support. The audit reports no new advisories; the existing
exceptions remain necessary. Updating `urlpattern` to 0.6.0 removes the
unmaintained `unic-*` family from the resolved graph.
The YARA-X 1.21.0 update was reassessed on 2026-10-10. RSA remains at 0.9.10
and Wasmtime at 45.0.3. The new YARA-X source still uses RSA public-key
verification and one process-global Wasmtime engine; the all-target feature
graph still enables neither WASI nor component support. The fresh audit reports
the same advisories and informational warnings, so no exceptions are added or
removed for this upgrade.
The October 14 Wasmtime advisories RUSTSEC-2026-0359, RUSTSEC-2026-0362, and
RUSTSEC-2026-0363 were assessed on 2026-10-15 against the same YARA-X 1.21.0 /
Wasmtime 45.0.3 graph. The exceptions below depend on disabled Wasmtime features,
YARA-X's scalar host bindings, and Quipu's explicit trusted-cache model.
Validation with CI's cargo-audit 0.22.2 and a freshly fetched advisory database
reported exactly these three unsuppressed findings under the previous policy.
With these exceptions applied, the audit passed with only the existing
unmaintained/yanked warnings.
An exception applies only to the described APIs, features, and dependency paths;
it must be reviewed if any of those change.

## Cache trust model

Quipu trusts compiled-cache contents, including serialized native code. Malicious
replacement of cache contents is outside the application's untrusted-input
security boundary. YARA source files and scan targets remain untrusted inputs.
Cache size, path, compatibility, and digest checks serve integrity and recovery
purposes; an unkeyed digest does not authenticate data against someone who can
replace both the artifact and its metadata.

The current build writes portable Wasm caches because YARA-X's
`native-code-serialization` feature is disabled. Its deserializer can still
accept native-code payloads. This is consistent with the trusted-cache model;
the serialization flag is not an input validation boundary. These exceptions
preserve native-cache capability and do not change cache behavior or performance.
Adding an untrusted compiled-rule import or changing the cache trust model
requires a new security assessment before extending these exceptions to it.

## Monaco 0.57 JavaScript audit (2026-10-09)

The upgrade introduces explicit `marked` 14.0.0 and `dompurify` 3.4.15
dependencies. npm reports two low-severity DOMPurify advisories,
[GHSA-p98j-92pf-mc4p](https://github.com/advisories/GHSA-p98j-92pf-mc4p) and
[GHSA-6688-9rhm-gjv2](https://github.com/advisories/GHSA-6688-9rhm-gjv2), also
attributed transitively to Monaco. Both require `IN_PLACE` sanitization. Monaco's
Markdown renderer passes strings through `domSanitize` without enabling that
option; Quipu does not call DOMPurify directly. Monaco also embeds its own copy
of DOMPurify 3.4.15, so overriding the npm dependency alone would not replace
the sanitizer used by editor hovers. Recheck this assessment when upgrading
Monaco or adding custom HTML sanitization. No audit suppression is added; the
existing high-severity CI audit threshold remains unchanged.

## RUSTSEC-2023-0071: `rsa` 0.9.10

- **Status:** Temporarily ignored in `.github/workflows/security.yml`; no
  patched `rsa` release exists.
- **Dependency path:** Quipu enables YARA-X's PE and Mach-O modules, which use
  YARA-X's cryptographic utility and therefore `rsa`.
- **Affected operation:** The Marvin attack recovers an RSA private key through
  timing observations of private-key operations such as decryption.
- **Exposure assessment:** YARA-X constructs only `rsa::RsaPublicKey` values in
  this path and calls `Pkcs1v15Sign::verify` while inspecting file signatures.
  It neither loads an RSA private key nor performs signing or decryption, so
  there is no private key for the affected side channel to disclose.
  Rechecked against YARA-X 1.21.0 on 2026-10-10.
- **Removal condition:** Remove the exception when YARA-X adopts a patched RSA
  implementation, removes this dependency, or starts using private-key
  operations. Recheck on every YARA-X or `rsa` update.

## RUSTSEC-2024-0429: `glib` 0.18.5

- **Status:** Temporarily ignored in `.github/workflows/security.yml`.
- **Dependency path:** Tauri 2's Linux GTK 3 stack depends on `gtk` 0.18, which
  in turn pins `glib` 0.18.5. Quipu does not select this version directly.
- **Affected API:** The advisory applies to `VariantStrIter` and
  `VariantTypeStrIter` for a specific non-Send iterator soundness issue.
- **Exposure assessment:** Neither Quipu nor GLib's consumers in the resolved
  dependency sources reference the affected iterator types or `array_iter_str`.
  Rechecked on 2026-10-08 for Tauri 2.12.1, Wry 0.57.0, and Tao 0.37.1.
  The dependency remains present because it supplies the Linux GUI stack.
- **Removal condition:** Remove the audit exception as soon as Tauri's supported
  Linux stack no longer resolves to the affected `glib` release. Recheck on
  every Tauri, Wry, WebKitGTK binding, or GTK binding update.

## RUSTSEC-2026-0194 and RUSTSEC-2026-0195: `quick-xml` 0.39.4

- **Status:** Temporarily ignored in `.github/workflows/security.yml`.
  `quick-xml` fixes both issues in 0.41.0, while `plist` 1.9.0 currently
  constrains it to the 0.39 release line.
- **Dependency path:** Tauri uses `plist`, which uses `quick-xml` for XML
  property lists. Quipu does not select either dependency directly.
- **Affected APIs:** RUSTSEC-2026-0194 affects duplicate-attribute checking via
  `BytesStart::attributes`, `try_get_attribute`, and `NsReader`.
  RUSTSEC-2026-0195 affects namespace declaration processing in `NsReader` and
  `NamespaceResolver::push`.
- **Exposure assessment:** `plist` 1.9.0 uses a plain `quick_xml::Reader`, reads
  element local names and text, and does not iterate attributes or construct an
  `NsReader`. Rechecked for macOS packaging on 2026-10-08 against locked
  `plist` 1.9.0 and Tauri 2.12.1: the parser still uses those unaffected APIs.
  Tauri's macOS restart code reads `Contents/Info.plist` from its own app bundle;
  this is package metadata, not a user-selected rule or scan target. Enabling
  macOS packaging does not introduce the affected attribute or namespace APIs.
- **Removal condition:** Remove both exceptions when Tauri/`plist` permits
  `quick-xml` 0.41.0 or newer. Reassess immediately if Quipu gains plist/XML
  input, Tauri's plist parsing changes, or the macOS package starts accepting
  external plist/XML input.

## RUSTSEC-2026-0222, RUSTSEC-2026-0269, and RUSTSEC-2026-0316: `wasmtime` 45.0.3

- **Status:** Temporarily ignored in `.github/workflows/security.yml`.
  YARA-X 1.21.0 constrains Wasmtime to the 45.x line, for which these advisories
  have no patched release.
- **Dependency path:** YARA-X uses Wasmtime to execute the WebAssembly it
  generates for compiled rules. Quipu does not use Wasmtime directly.
- **RUSTSEC-2026-0222 exposure:** The affected APIs can mix objects from
  different Wasmtime engines. YARA-X creates one process-global `Engine` in a
  `OnceLock`, and every linker and store is created from that same engine.
- **RUSTSEC-2026-0269 exposure:** The sandbox escape is in the `wasmtime-wasi`
  filesystem implementation. Neither `wasmtime-wasi` nor its `cap-std`
  filesystem stack is in Quipu's locked dependency graph; YARA-X enables only
  Wasmtime's `cranelift` and `runtime` features and grants no WASI preopens.
- **RUSTSEC-2026-0316 exposure:** The allocation issue affects the dynamically
  typed `wasmtime::component::Val` API. YARA-X does not enable Wasmtime's
  component-model feature or use its component API; it uses typed core-Wasm
  functions and values.
- **Removal condition:** Remove each exception when YARA-X adopts a Wasmtime
  release patched for it. Reassess immediately if YARA-X changes its Wasmtime
  features, introduces WASI/component APIs, or creates more than one engine.

## RUSTSEC-2026-0327: `wasmtime` 45.0.3

- **Status:** Temporarily ignored in `.github/workflows/security.yml`.
  The upstream fixes are in 48.0.4 and 49.0.2; YARA-X 1.21.0 constrains
  Wasmtime to the unpatched 45.x line.
- **Dependency path:** YARA-X uses Wasmtime for the core WebAssembly generated
  from rule conditions. Quipu does not use the component API.
- **Affected operation:** A malformed component's async-lifted callback can
  overflow the native stack because its result count is not validated.
- **Exposure assessment:** The upstream
  [advisory](https://github.com/bytecodealliance/wasmtime/security/advisories/GHSA-32h6-97mm-8q3c)
  explicitly identifies disabling `component-model-async` as a workaround.
  `cargo tree --locked --offline --target all -e features -i wasmtime` confirms
  that neither `component-model` nor `component-model-async` is enabled in
  Quipu's resolved graph, including Windows. YARA-X disables Wasmtime defaults
  and requests only `cranelift` and `runtime`; their transitive features do not
  enable component support. The affected execution path is therefore absent.
- **Removal condition:** Remove the exception when YARA-X permits a patched
  Wasmtime version. Reassess on every YARA-X/Wasmtime update or feature change;
  enabling component async support invalidates this exception and requires an
  upgrade to a patched version first.

## RUSTSEC-2026-0359: `wasmtime` 45.0.3

- **Status:** Temporarily ignored in `.github/workflows/security.yml`.
  The upstream fixes are in 48.0.6 and 49.0.3; YARA-X 1.21.0 constrains
  Wasmtime to the unpatched 45.x line.
- **Dependency path:** YARA-X compiles YARA conditions into core WebAssembly
  and supplies the Rust host bindings used during scanning.
- **Affected operation:** Dropping a long chain of concrete type references
  recursively can overflow the native stack and abort the process. The upstream
  [advisory](https://github.com/bytecodealliance/wasmtime/security/advisories/GHSA-wjc8-633q-pwxr)
  lists no general workaround. Its
  [fix and regression tests](https://github.com/bytecodealliance/wasmtime/pull/14735)
  cover both guest-defined and Rust host-defined function-type chains.
- **Exposure assessment:** The all-target Wasmtime feature graph enables no
  `gc` feature. In Wasmtime 45.0.3, typed function references are disabled by
  default and the `wasm_function_references` setter requires `gc`. YARA-X does
  not enable them. Its host `FuncType::new` call builds signatures from static
  exports whose arguments and results map to `i32`, `i64`, `f32`, and `f64`,
  including numeric handles for YARA objects. Neither YARA rules nor scan targets
  can supply concrete host type-reference chains. See the pinned
  [ABI mapping](https://github.com/VirusTotal/yara-x/blob/7b2637d4655155fdfaf68177edadb9a39406ece0/lib/src/wasm/mod.rs#L579)
  and [host linker](https://github.com/VirusTotal/yara-x/blob/7b2637d4655155fdfaf68177edadb9a39406ece0/lib/src/wasm/mod.rs#L847).
  Cache restoration is covered by the [trusted-cache model](#cache-trust-model).
- **Validation:** On 2026-10-15, a probe linked to Quipu's Wasmtime 45.0.3
  library and using YARA-X's Linux engine settings rejected both 2-type and
  20,000-type guest chains during validation and `Module::from_binary`, while
  scalar baselines compiled and dropped successfully. A separate process
  constructing 100,000 linked host types reproduced the stack-overflow abort.
  Thus disabled guest features alone are insufficient: this exception also
  depends on the scalar host ABI and trusted caches. `catch_unwind` does not
  contain a stack-overflow abort.
- **Removal condition:** Remove the exception when YARA-X permits a patched
  Wasmtime release. Reassess on every YARA-X/Wasmtime update, on enabling GC or
  typed function references, on introducing reference types or supertypes into
  host bindings, on adding another Wasmtime consumer, or on changing cache trust.

## RUSTSEC-2026-0362: `wasmtime` 45.0.3

- **Status:** Temporarily ignored in `.github/workflows/security.yml`.
  The upstream fixes are in 48.0.6 and 49.0.3; YARA-X 1.21.0 constrains
  Wasmtime to the unpatched 45.x line.
- **Dependency path:** YARA-X invokes Wasmtime while evaluating rule conditions.
- **Affected operation:** Entering Wasm asynchronously, then re-entering it
  synchronously from host callbacks, can suspend non-`Send` host values across
  threads or cause runtime panics. The upstream
  [advisory](https://github.com/bytecodealliance/wasmtime/security/advisories/GHSA-vcg5-q8m5-8379)
  explicitly states that embedders not using async are unaffected.
- **Exposure assessment:** Wasmtime's `async` feature is absent from the
  all-target feature graph. YARA-X's
  [native runtime adapter](https://github.com/VirusTotal/yara-x/blob/7b2637d4655155fdfaf68177edadb9a39406ece0/lib/src/wasm/runtime/native.rs)
  uses synchronous `Linker::instantiate` and `func_new_unchecked` host callbacks;
  its [scanner](https://github.com/VirusTotal/yara-x/blob/7b2637d4655155fdfaf68177edadb9a39406ece0/lib/src/scanner/context.rs#L480)
  invokes synchronous `TypedFunc::call`. Quipu's Tokio runtime does not enable
  Wasmtime's async execution machinery. Rechecked on 2026-10-15.
- **Removal condition:** Remove the exception when YARA-X permits a patched
  Wasmtime release. Reassess on every YARA-X/Wasmtime update or feature change,
  and before introducing async Wasm calls, async host callbacks, or another
  Wasmtime consumer.

## RUSTSEC-2026-0363: `wasmtime` 45.0.3

- **Status:** Temporarily ignored in `.github/workflows/security.yml`.
  The upstream fixes are in 36.0.18, 48.0.6, and 49.0.3; YARA-X 1.21.0
  constrains Wasmtime to the unpatched 45.x line.
- **Dependency path:** YARA-X uses Wasmtime's core-Wasm runtime for compiled rules.
- **Affected operation:** A malicious component can allocate unbounded host
  memory through resource-handle tables across repeated component instances,
  bypassing configured memory/table limits. See the upstream
  [advisory](https://github.com/bytecodealliance/wasmtime/security/advisories/GHSA-q554-3cjc-rx7p).
- **Exposure assessment:** Neither `component-model` nor
  `component-model-async` is enabled in the all-target Wasmtime feature graph.
  YARA-X constructs core-Wasm modules, not components, so the affected resource
  handle tables are not part of Quipu's execution path. Rechecked on 2026-10-15.
- **Removal condition:** Remove the exception when YARA-X permits a patched
  Wasmtime release. Reassess on every YARA-X/Wasmtime update or feature change,
  and before enabling any component support or adding another Wasmtime consumer.

To recheck the feature assumptions above, run from `app/src-tauri` after fetching
the locked dependencies:

```sh
cargo tree --locked --offline --target all -e features -i wasmtime
```

The resolved features must continue to exclude `async`, `gc`, `component-model`,
and `component-model-async`. This graph check supplements the source review of
YARA-X's host ABI and call sites; it does not establish those properties alone.

## Non-failing informational warnings

`cargo audit` also reports unmaintained or yanked crates. These warnings do not
represent known vulnerabilities and do not fail the audit, but they are still
reviewed as dependency-maintenance work:

- `bincode` 2.0.1 is unmaintained and comes from YARA-X. Replace it when
  YARA-X selects a maintained serialization implementation.
- `proc-macro-error` 1.0.4 is unmaintained and comes from the Tauri Linux GTK 3
  stack through `glib-macros` and `gtk3-macros`. Remove it when Tauri's
  supported Linux stack migrates away from those macros.
- `spin` 0.9.8 is yanked and comes from YARA-X's RSA/DSA bigint stack through
  `lazy_static`. A yanked crate is not itself a vulnerability, and the locked
  source remains reproducible; remove it when YARA-X's cryptography dependency
  stack no longer selects it.

Recheck these paths on every Tauri and YARA-X update. A warning that becomes a
vulnerability must either be fixed or receive its own narrowly scoped exception
above before the audit can pass.

These exceptions do not claim that the advisories are unimportant or that all
uses of an affected release are safe. They record the narrowly reviewed reasons
the current Quipu build is allowed to retain those dependencies.

## RUSTSEC-2026-0367, RUSTSEC-2026-0368, RUSTSEC-2026-0369: `zip` 8.6.0

- **Status:** Temporarily ignored in `.github/workflows/security.yml`, assessed
  on 2026-10-17 during 0.4.0 preparation. RustSec identifies `zip` 9.0.0 or later
  as patched; YARA-X 1.21.0 requires the incompatible 8.x series.
- **Dependency path:** `zip` is used only by YARA-X in the all-target locked
  dependency graph. The language server enables YARA-X's default modules,
  including `crx-module`; the exception does not assume this module is disabled.
- **Affected operations:** RUSTSEC-2026-0367 concerns preserving privileged Unix
  permission bits during filesystem extraction. RUSTSEC-2026-0368 concerns
  creating symlinks targeting paths outside the extraction directory.
  RUSTSEC-2026-0369 concerns applying permissions through extracted symlinks.
  These advisories affect `ZipArchive::extract()` and/or the stream extraction
  API, which materialize archive entries on disk.
- **Exposure assessment:** YARA-X's CRX parser constructs
  `ZipArchive<Cursor<&[u8]>>` over scan-target bytes. It reads `manifest.json`
  with `by_name`, and locale JSON with `index_for_path` and `by_index`, passing
  entry readers directly to `serde_json::from_reader`. It does not extract
  entries to disk, create archive-provided symlinks, or apply archive-provided
  permissions. No Quipu source calls the `zip` crate or its extraction APIs.
  YARA-X's separate ZIP/VBA modules use `tinyzip`, not this crate. The upstream
  test and benchmark helpers likewise read ZIP entries into memory.
- **Validation:** `cargo tree --locked --offline --target all -i zip` identifies
  YARA-X 1.21.0 as the sole direct consumer. The corresponding feature tree
  confirms `crx-module` is enabled through `yara-x-ls`. Source inspection of
  the pinned YARA-X release finds its production `zip` API calls only in the
  CRX parser and no filesystem extraction calls. The initial 0.4.0 audit
  reported exactly these three unsuppressed vulnerabilities. With the scoped
  exceptions, cargo-audit 0.22.2 and a freshly fetched database pass with only
  the existing three informational warnings. All 14 workflow exceptions have
  matching documentation. No dependency versions or application behavior are
  changed by these exceptions.
- **Removal condition:** Remove these exceptions when a supported coordinated
  YARA-X compiler/parser/language-server update uses patched `zip` or removes
  the dependency. Reassess before changing ZIP consumers, introducing archive
  extraction, or upgrading YARA-X. These exceptions cover only the three
  filesystem-extraction advisories, not arbitrary ZIP parsing vulnerabilities.

References:

- [RUSTSEC-2026-0367](https://rustsec.org/advisories/RUSTSEC-2026-0367.html)
- [RUSTSEC-2026-0368](https://rustsec.org/advisories/RUSTSEC-2026-0368.html)
- [RUSTSEC-2026-0369](https://rustsec.org/advisories/RUSTSEC-2026-0369.html)
- [YARA-X 1.21.0 CRX parser](https://github.com/VirusTotal/yara-x/blob/v1.21.0/lib/src/modules/crx/parser.rs)
- [YARA-X 1.21.0 dependency requirement](https://github.com/VirusTotal/yara-x/blob/v1.21.0/Cargo.toml)
