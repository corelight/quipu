# Quipu 0.5.0 acceptance record

Status: **pending**. Do not publish the stable release until the results below
are recorded. The earlier signed 0.4.0 Apple Silicon test passed, but does not
cover this YARA-X 1.22.1 / Wasmtime 48.0.7 build.

Record the source tag/SHA, public CI and Release run IDs, private signing run ID,
and the final package SHA-256 hashes here when available. Tests must use those
exact packaged binaries. If an app fix requires rebuilding, use a new tag/version
and repeat affected acceptance checks.

| Platform | OS / hardware | Packages | Result |
| --- | --- | --- | --- |
| Linux x86-64 | Pending | AppImage, DEB, RPM | Pending |
| Windows x86-64 | Pending | Standard/offline EXE and MSI; upgrade | Pending |
| macOS Apple Silicon | Pending | Signed aarch64 DMG | Pending |
| macOS Intel | Pending | Signed x64 DMG | Pending |

For each platform record:

- Install/upgrade and normal launch; on macOS browser download, Gatekeeper prompt,
  and installation into Applications without a security override.
- Open bundled examples, compile rules (including includes), scan text and files,
  and inspect expected matches. Check compiler errors and editor diagnostics.
- Save edits and recompile; quit/reopen and restore cached compiled rules, then
  scan again. Existing caches from 0.4.0 must recompile for the upgraded engine.
- Native menus, keyboard shortcuts, copy/paste, file dialogs, preferences,
  window/pane layout, and offline help.
- Unsaved edits: Cancel preserves work; explicit discard/quit behaves correctly.
- Windows: test actual MSI installation and standard/offline WebView2 behavior;
  macOS: record prior Quipu approval history and any managed-device security block.

Record any issue and its resolution before marking a row passed. A confirmation
that the old signing test worked does not mark the new candidate tested.
