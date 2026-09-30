# Dependency security exceptions

Quipu's automated dependency audit fails on known vulnerabilities unless an
exception is listed here with a specific rationale. Exceptions are temporary
and must be reconsidered whenever the affected dependency or its parent stack is
updated.

The assessments below cover the dependency graph locked on 2026-10-01. An
exception applies only to the described APIs, features, and dependency paths;
it must be reviewed if any of those change.

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
- **Removal condition:** Remove the exception when YARA-X adopts a patched RSA
  implementation, removes this dependency, or starts using private-key
  operations. Recheck on every YARA-X or `rsa` update.

## RUSTSEC-2024-0429: `glib` 0.18.5

- **Status:** Temporarily ignored in `.github/workflows/security.yml`.
- **Dependency path:** Tauri 2's Linux GTK 3 stack depends on `gtk` 0.18, which
  in turn pins `glib` 0.18.5. Quipu does not select this version directly.
- **Affected API:** The advisory applies to `VariantStrIter` and
  `VariantTypeStrIter` for a specific non-Send iterator soundness issue.
- **Exposure assessment:** Neither Quipu nor any crate in its resolved
  dependency source calls the affected iterator types. The dependency remains
  present because it supplies the Linux GUI stack.
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
  `NsReader`. Tauri's plist reads are additionally limited to macOS
  developer- or package-controlled `Info.plist` files; the initial Linux build
  has no runtime XML input through this dependency path.
- **Removal condition:** Remove both exceptions when Tauri/`plist` permits
  `quick-xml` 0.41.0 or newer. Reassess immediately if Quipu gains plist/XML
  input, Tauri's plist parsing changes, or macOS packaging is enabled.

## RUSTSEC-2026-0222, RUSTSEC-2026-0269, and RUSTSEC-2026-0316: `wasmtime` 45.0.3

- **Status:** Temporarily ignored in `.github/workflows/security.yml`.
  YARA-X 1.20.0 constrains Wasmtime to the 45.x line, for which these advisories
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

## Non-failing informational warnings

`cargo audit` also reports unmaintained or yanked crates. These warnings do not
represent known vulnerabilities and do not fail the audit, but they are still
reviewed as dependency-maintenance work:

- `bincode` 2.0.1 is unmaintained and comes from YARA-X. Replace it when
  YARA-X selects a maintained serialization implementation.
- `proc-macro-error` 1.0.4 is unmaintained and comes from the Tauri Linux GTK 3
  stack through `glib-macros` and `gtk3-macros`. Remove it when Tauri's
  supported Linux stack migrates away from those macros.
- `unic-char-property`, `unic-char-range`, `unic-common`, `unic-ucd-ident`, and
  `unic-ucd-version` 0.9.0 are one unmaintained crate family pulled in by
  Tauri's `urlpattern` dependency. Remove them when Tauri or `urlpattern`
  adopts maintained Unicode-property crates.
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
