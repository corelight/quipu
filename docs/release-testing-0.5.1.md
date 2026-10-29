# Quipu 0.5.1 acceptance record

Status: **pending**. The release remains a draft until the final packages have
passed platform acceptance. The maintainer verified the diagnostics fix in the
local `0.5.1-issue47.1` Debian test build; that does not mark the final release
packages or other platforms tested.

Record the `v0.5.1` source SHA, successful public main CI and Release run IDs,
private signing run ID, and final package hashes alongside the results below.
Use the draft's `RELEASE_BUILD.json`, macOS provenance records, and nine-package
`SHA256SUMS` to identify the exact binaries tested. Do not replace tagged source
or published binaries if a code fix is needed; prepare a new version instead.

| Platform | OS / hardware | Packages | Result |
| --- | --- | --- | --- |
| Linux x86-64 | Pending | AppImage, DEB, RPM | Pending |
| Windows x86-64 | Pending | Standard/offline EXE and MSI; upgrade | Pending |
| macOS Apple Silicon | Pending | Signed aarch64 DMG | Pending |
| macOS Intel | Pending | Signed x64 DMG | Pending |

For each platform:

- Install or upgrade from 0.5.0 and launch normally. On macOS, use a browser
  download, keep Gatekeeper enabled, install into Applications, and record prior
  Quipu approval history. No security override should be needed.
- Verify [#47](https://github.com/corelight/quipu/issues/47): an invalid UTF-8
  file and an ordinary syntax error must still allow recoverable semantic
  errors and warnings from other selected files to appear in Problems. Confirm
  file/line navigation works for readable files and Scan stays unavailable
  after a failed compile, including after a previous successful compile.
- Open bundled examples, compile rules with includes, scan text and files,
  and inspect expected matches. Check editor diagnostics and structural errors
  such as missing includes and cycles.
- Edit, save, recompile, quit, and reopen. Restore cached compiled rules and
  scan again. Exercise native menus, shortcuts, copy/paste, file dialogs,
  preferences, pane layout, and offline help.
- Check unsaved edits: Cancel preserves work and explicit discard/quit works.
  On Windows, cover actual standard/offline EXE and MSI installation and
  WebView2 behavior. On both macOS architectures, compile and scan in the final
  signed app to exercise the hardened-runtime JIT.

Record issues and their resolutions before marking any row passed. Automated
build/signature checks and earlier release acceptance do not replace these
checks against the final 0.5.1 packages.
