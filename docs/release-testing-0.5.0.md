# Quipu 0.5.0 acceptance record

Status: **passed — maintainer confirmed all checks on all platforms**.
The maintainer reported: “All checks pass on all platforms.” This confirmation
covers the 0.5.0 candidate and checklist below, including the new YARA-X 1.22.1 /
Wasmtime 48.0.7 runtime. Exact OS versions, hardware models, and individual test
logs were not supplied; the result is recorded as maintainer-reported acceptance.

Release provenance:

- Tag: `v0.5.0`; source: `0ee9038b932701861333a8990f7d56bfa4d644b6`.
- Successful [main CI](https://github.com/corelight/quipu/actions/runs/40779220181)
  and [tag Release build](https://github.com/corelight/quipu/actions/runs/40779287888).
- Successful private signing run `40789286042`, signing commit
  `e9c44b5d9ebcc91c3d189792069e0cc08957568b`. Both apps and DMGs passed
  notarization, stapling, Gatekeeper assessment, and final package checks.
- The release helper verified archive digests, source/build/signing provenance,
  and all 13 release assets. The final `SHA256SUMS` covers all nine packages.
- [Release and packages](https://github.com/corelight/quipu/releases/tag/v0.5.0).

This acceptance record does not move the release tag or change the tested binaries.

| Platform | OS / hardware | Packages | Result |
| --- | --- | --- | --- |
| Linux x86-64 | Not recorded | AppImage, DEB, RPM | Passed (maintainer-reported) |
| Windows x86-64 | Not recorded | Standard/offline EXE and MSI; upgrade | Passed (maintainer-reported) |
| macOS Apple Silicon | Not recorded | Signed aarch64 DMG | Passed (maintainer-reported) |
| macOS Intel | Not recorded | Signed x64 DMG | Passed (maintainer-reported) |

Checklist covered by the maintainer's confirmation:

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

No failed checks were reported for this candidate. Future releases need their
own acceptance record; this report applies to the package hashes below.

## Final package checksums

```text
fa1345d66aa90d4e4027a0daf676fe57f912faba951182669eba9b80f3babfb2  Quipu-0.5.0-1.x86_64.rpm
0224d8d1a6f92dbdfc6284bb058da0f3f846f182af4a68d4c3c67e9473cea5a9  Quipu_0.5.0_aarch64.dmg
646f141cf2a5ceb54368b06d47ba0f7f4f8850061afbb1cdcfcc0508865497bd  Quipu_0.5.0_amd64.AppImage
2ab5898c66c60b6b13b70aa9e3d303bafa1cfe8574763e042376cf79229571e6  Quipu_0.5.0_amd64.deb
5baf23edcf2500a7a13b28e7d0174fb0196c30b8b1ca9fe360d549753bad708b  Quipu_0.5.0_x64-setup-offline.exe
287db617fe948fabe6ba6a466fde9ff66fb9015b15868e016a3c7d4e1c6d7f21  Quipu_0.5.0_x64-setup.exe
2cc16e348e1daa0f29890196dde08d44a88833d89b4cffb032e646ce2a0efc02  Quipu_0.5.0_x64.dmg
56d57577f0c24e6af2dae19aa7df2cd8d47d906e74c455b69ea3e464765d5437  Quipu_0.5.0_x64_en-US-offline.msi
76363edcefbb5f1ce653176ae75c39a2600642a0f983cd16ff0d07e706ec67ce  Quipu_0.5.0_x64_en-US.msi
```
