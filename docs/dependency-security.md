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
An exception applies only to the described APIs, features, and dependency paths;
it must be reviewed if any of those change.

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
