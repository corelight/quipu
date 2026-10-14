# Windows development

Windows x86-64 builds have CI coverage and completed Windows 11 desktop validation,
recorded [below](#validation-status). Daily development
can happen on Linux; GitHub Actions runs the Windows tests and builds
NSIS `.exe` and WiX `.msi` installers using the MSVC toolchain on `windows-2022`.
The CI workflow uploads `quipu-windows-x86_64` and
`quipu-windows-offline-x86_64` artifacts, each containing NSIS and MSI installers.
The release workflow uses the same Windows job, waits for both platforms, and
generates one combined `SHA256SUMS` covering standard and offline packages.

## Build locally on Windows

Install Visual Studio 2022 Build Tools with **Desktop development with C++** and
the Windows SDK, Rust 1.93 or newer with the `x86_64-pc-windows-msvc` toolchain,
Node.js 22.12 or newer, Git, and Zola 0.23.6 on `PATH`. MSI packaging requires the
Windows **VBSCRIPT** optional feature. Tauri downloads its installer toolchains
on the first build. Install the Evergreen WebView2 runtime for development.

From PowerShell in `app`:

```powershell
$env:YRX_REGENERATE_MODULES_RS = 'false'
npm ci
npm test
Push-Location src-tauri
cargo test --locked
Pop-Location
npm run tauri -- build --ci --target x86_64-pc-windows-msvc --bundles nsis,msi -- --locked
```

Installers are under
`app/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/{nsis,msi}`.
Both contain the application, examples, license, and third-party notices. The
documentation is embedded in the application. CI installs the NSIS package and
extracts the MSI administrative image to verify packaged resources against the
repository. This is package validation; interactive application testing remains
necessary.

To produce offline installers from the same application build, first copy the
standard installers elsewhere if you want to keep them, then run from `app`:

```powershell
npm run tauri -- bundle --ci --target x86_64-pc-windows-msvc --bundles nsis,msi --config src-tauri/tauri.windows.offline.conf.json
```

This downloads and embeds the full x86-64 Evergreen WebView2 installer at
packaging time. The build machine needs internet access. The command replaces
the installers in the same output directories; CI preserves the standard
packages first and adds `-offline` before each offline installer's extension.
The override retains the normal installation mode and MSI upgrade identity.

## Distribution

The NSIS installer installs for the current user. Standard NSIS and MSI packages
use Tauri's WebView2 download bootstrapper when the runtime is absent, so first
installation may require internet access.

For air-gapped systems, use the larger `-offline.exe` or `-offline.msi` package
from a release, or the `quipu-windows-offline-x86_64` CI artifact. These packages
include the full WebView2 runtime installer using Tauri's `offlineInstaller`
mode, so no runtime download is needed on the target machine. They also contain
the same application, examples, notices, and embedded documentation. Rule
compilation and scanning run locally. WebView2 security updates on disconnected
machines must be delivered through your offline software update process.

CI validates both package variants and checks that each offline package embeds
the standalone WebView2 installer. Hosted runners already have WebView2, so this
does not exercise runtime installation on a clean air-gapped machine. Before
deployment, test each chosen installer format on a disposable Windows VM with
WebView2 absent and networking disabled, then launch Quipu, open the bundled
documentation, and compile and scan a bundled example.

Installers are currently unsigned, matching the Linux distribution policy.
Authenticode signing can be configured separately with protected release
credentials. Keep `bundle.windows.wix.upgradeCode` stable across releases so MSI
upgrades recognise the existing installation.

## Saving and filesystem behavior

Windows Defender can quarantine serialized YARA detection patterns. The bundled
guide documents how to confirm this in Protection history and configure a
scoped cache exclusion: see
[Windows Defender and missing cache entries](../documentation/content/preferences-and-cache.md#windows-defender-and-missing-cache-entries).

Windows saves briefly acquire exclusive file access. An editor, scanner, or other
process holding an incompatible handle can make Save fail; retry after that
handle closes. The app compares the expected contents while holding exclusive
access and refuses to overwrite an unexpected version. Existing files are updated
in place, preserving their ACL and hard links.

Before changing an existing file, Quipu flushes a recovery copy beside it with
the original access restrictions. Successful saves remove this copy. Failed
writes attempt to restore the original; if recovery also fails, the error names
the retained copy. A crash during Save can leave a partial file and a recovery
file named `.NAME.quipuPID-N.tmp`. Close Quipu, preserve both files, and inspect
the recovery copy before restoring it. Recovery is manual; Quipu does not delete
these copies on startup.

For VM testing, keep workspaces on the guest's local NTFS volume. Host shared
folders have different filesystem behavior. Verbatim UNC include paths are
currently rejected by compilation; network-share support is not validated.

## Validation status

The following results have been confirmed on this branch:

| Environment | Confirmed coverage |
| --- | --- |
| GitHub Actions, Windows Server 2022 x86-64 | Rust tests, Clippy, frontend and documentation build, NSIS installation/uninstallation, and MSI administrative extraction with packaged-resource checks |
| Windows 11 Version 24H2, OS Build 26100.9457, desktop VM | User-confirmed completion of the desktop checklist below, including actual MSI installation, upgrades, file operations, scans, diagnostics, and window/quit regressions; Polaris compilation and cache restoration after a confirmed Defender quarantine was resolved with a cache exclusion |

The user confirmed the following desktop checks complete on 2026-10-04.
This supplements CI's MSI administrative extraction with actual installation
and interactive testing:

- Actual MSI installation/uninstallation and installer upgrades over an earlier
  build, including preservation of settings and cache.
- Bundled examples and scans, language-server diagnostics, file dialogs, menus,
  and keyboard shortcuts.
- Save and rename behavior, external-edit conflicts, and file watching on local
  NTFS storage.
- The full window-layout and unsaved-work regression sequence below.

Repository release validation:

- The GitHub `Protect main` ruleset requires
  `Windows x86-64 / Test and package Windows x86-64`, alongside the existing
  frontend, Rust, and security checks. Existing protections remain in place.
- The manual [Release workflow run for `aedf1b7`](https://github.com/corelight/quipu/actions/runs/36976404977)
  passed Linux and Windows package validation and combined artifact assembly.
  The downloaded `quipu-release` artifact contains AppImage, DEB, RPM, NSIS,
  and MSI packages; all five hashes match `SHA256SUMS`, with no missing or extra
  package entries. Publication was skipped, as expected for a branch run;
  publication requires a version tag.

Authenticode signing and automated Windows GUI acceptance tests remain follow-up
work.

For the window layout and help regression check:

1. Resize the main window, toggle the Results pane, and change View > Zoom. The
   outer window must have no scrollbars, and the results chevron must remain
   fully visible. Content inside panes should still scroll when necessary.
2. Open Help > Documentation and follow Quick Start. Verify actual page content,
   then close the help window with its title-bar X. The main window must respond.
3. Open Help > Quick Start again, then choose File > Quit with help still open.
   Both windows should close. Repeat using the main window's title-bar X.
4. Repeat the last step after editing the scratch rule. Cancel the unsaved-work
   prompt and check that both windows still respond, then quit and confirm.
