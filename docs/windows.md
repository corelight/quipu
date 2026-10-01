# Windows development

Windows x86-64 builds are experimental pending interactive validation. Daily
development can happen on Linux; GitHub Actions runs the Windows tests and builds
NSIS `.exe` and WiX `.msi` installers using the MSVC toolchain on `windows-2022`.
The CI workflow uploads `quipu-windows-x86_64` artifacts. The release workflow
uses the same Windows job, waits for both platforms, and generates one combined
`SHA256SUMS` for the release packages.

## Build locally on Windows

Install Visual Studio 2022 Build Tools with **Desktop development with C++** and
the Windows SDK, Rust 1.93 or newer with the `x86_64-pc-windows-msvc` toolchain,
Node.js 22.6 or newer, Git, and Zola 0.23.0 on `PATH`. MSI packaging requires the
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

## Distribution

The NSIS installer installs for the current user. Both installers use Tauri's
WebView2 download bootstrapper when the runtime is absent, so first installation
may require internet access. Rule compilation and scanning run locally. For a
deployment requiring offline runtime installation, build with
`bundle.windows.webviewInstallMode.type` set to `offlineInstaller`.

Installers are currently unsigned, matching the Linux distribution policy.
Authenticode signing can be configured separately with protected release
credentials. Keep `bundle.windows.wix.upgradeCode` stable across releases so MSI
upgrades recognise the existing installation.

## Saving and filesystem behavior

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

Before declaring Windows supported, validate installation and upgrades, launch,
menus and shortcuts, file dialogs, save/rename conflicts, bundled examples,
compilation/scanning, language-server diagnostics, watching, cache restoration,
and offline documentation in a Windows desktop session.
