# Dependency security exceptions

Quipu's automated dependency audit fails on known vulnerabilities unless an
exception is listed here with a specific rationale. Exceptions are temporary
and must be reconsidered whenever the affected dependency or its parent stack is
updated.

The YARA-X 1.22.1 update was assessed on 2026-10-27 with cargo-audit 0.22.2
and a freshly fetched advisory database. The lockfile now has one YARA-X
release, Wasmtime 48.0.7, crypto-bigint 0.7.10, RSA 0.10.0-rc.19, and ZIP 9.1.2.
The remaining exceptions cover RSA public-key verification, GLib, and plist's
quick-xml usage. No new exceptions are added.

The upgrade removes the seven Wasmtime exceptions (RUSTSEC-2026-0222,
RUSTSEC-2026-0269, RUSTSEC-2026-0316, RUSTSEC-2026-0327, RUSTSEC-2026-0359,
RUSTSEC-2026-0362, RUSTSEC-2026-0363) and the three ZIP extraction exceptions
(RUSTSEC-2026-0367, RUSTSEC-2026-0368, RUSTSEC-2026-0369), because the locked
versions include the fixes. It also fixes the newly reported AArch64 Wasmtime
advisory RUSTSEC-2026-0379 and crypto-bigint advisory RUSTSEC-2026-0387.
The yanked spin 0.9.8 dependency is no longer present.

The all-target Wasmtime feature graph still excludes async, GC, WASI, and
component support. An exception applies only to the described APIs, features,
and dependency paths; it must be reviewed if any of those change.

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
the serialization flag is not an input validation boundary. The dependency
upgrade preserves native-cache capability and the existing cache trust model.
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

## RUSTSEC-2023-0071: `rsa` 0.10.0-rc.19

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
  Rechecked against YARA-X 1.22.1 on 2026-10-27; the RSA prerelease is
  still affected according to RustSec, and the public-key-only usage remains.
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

## Non-failing informational warnings

`cargo audit` also reports unmaintained or yanked crates. These warnings do not
represent known vulnerabilities and do not fail the audit, but they are still
reviewed as dependency-maintenance work:

- `bincode` 2.0.1 is unmaintained and comes from YARA-X. Replace it when
  YARA-X selects a maintained serialization implementation.
- `proc-macro-error` 1.0.4 is unmaintained and comes from the Tauri Linux GTK 3
  stack through `glib-macros` and `gtk3-macros`. Remove it when Tauri's
  supported Linux stack migrates away from those macros.
- `zbus_names` 4.3.4, `zvariant` 5.15.0, and `zvariant_derive` 5.15.0 are
  unmaintained and come from the Tauri dialog/portal stack. Revisit when its
  upstream dependencies offer a maintained replacement.

Recheck these paths on every Tauri and YARA-X update. A warning that becomes a
vulnerability must either be fixed or receive its own narrowly scoped exception
above before the audit can pass.

These exceptions do not claim that the advisories are unimportant or that all
uses of an affected release are safe. They record the narrowly reviewed reasons
the current Quipu build is allowed to retain those dependencies.
