# Quipu 0.5.1 acceptance record

Status: **passed**. On 2026-10-29, the maintainer confirmed: "Verified on all
platforms." This records manual acceptance of the final 0.5.1 packages on Linux,
Windows, macOS Apple Silicon, and macOS Intel. Exact OS versions, hardware models,
and previous-install history were not supplied with the confirmation.

The accepted packages are identified by:

- Source: `v0.5.1` at `333209b7aa9013768f681516b15de7aa77ebb06f`.
- [Public main CI run 40832972702](https://github.com/corelight/quipu/actions/runs/40832972702), attempt 1: passed.
- [Release build run 40834543727](https://github.com/corelight/quipu/actions/runs/40834543727), attempt 1: passed.
- Private macOS signing run `40834552821`, attempt 1, signing commit
  `b56747906571804652f012cff12c0b4f01f2c6a6`: passed for both architectures.
  Both apps and both DMGs were accepted by Apple and stapled.
- [Release assets](https://github.com/corelight/quipu/releases/tag/v0.5.1):
  `RELEASE_BUILD.json`, two macOS provenance records, and `SHA256SUMS` covering all
  nine packages. All 13 downloaded assets matched GitHub's asset digests.
- `SHA256SUMS` SHA-256:
  `1edaaf9098054e86d030c836d35c1f2f73f844920d5a85c5be50a5239b745ffb`.

| Platform | OS / hardware | Packages | Result |
| --- | --- | --- | --- |
| Linux x86-64 | Details not supplied | AppImage, DEB, RPM | Passed; maintainer confirmed |
| Windows x86-64 | Details not supplied | Standard/offline EXE and MSI; upgrade | Passed; maintainer confirmed |
| macOS Apple Silicon | Details not supplied | Signed aarch64 DMG | Passed; maintainer confirmed |
| macOS Intel | Details not supplied | Signed x64 DMG | Passed; maintainer confirmed |

Final package SHA-256 hashes:

```text
7c8f5084386914ed3b519a1a13c880ad20a46c4b2bbda8577ef032076a8685b3  Quipu-0.5.1-1.x86_64.rpm
5f10891110ceaa1d5eb0129474d4560ca3dc89741f9da082b607df542064786f  Quipu_0.5.1_aarch64.dmg
7c49826df41dbfcbf695a9e76ce1df54bfb49cbf26cb8afaa35b399b21312fd7  Quipu_0.5.1_amd64.AppImage
8ff6a2f8448f099721fc871a639dc4a83fea9feb39cd0aea77dc26ae41f0d27b  Quipu_0.5.1_amd64.deb
a45217153a2ff090f46d34c4ec2ad5f7f3da0fa69de972a344827330df7ca13a  Quipu_0.5.1_x64-setup-offline.exe
80750540e32e28df6b3d8fbd8e6b9d0a40dae9b0a83e66f85da40257883675e6  Quipu_0.5.1_x64-setup.exe
0c41ac14088a0faec48a9721f85327325e80219c115bbf0ff626fe7d094d20f6  Quipu_0.5.1_x64.dmg
3e0ad8ecc5ca1f02f415f4f92e1369ec6328c20a50361a5727e219a41a0384e2  Quipu_0.5.1_x64_en-US-offline.msi
5cbb945693648e72ba3d222af3cb3fa1e078550f855547f2846bda8b7d142766  Quipu_0.5.1_x64_en-US.msi
```

The following checklist defines the acceptance scope. The platform results above
record the maintainer's confirmation rather than automated GUI test results.
Do not replace tagged source or published binaries if a code fix is needed;
prepare a new version instead.

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

Automated build/signature checks and earlier release acceptance do not replace
manual acceptance against the final 0.5.1 packages.
