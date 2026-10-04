# Experimental macOS builds

macOS builds target Apple Silicon (`aarch64`) and Intel (`x86_64`) separately,
using native GitHub-hosted `macos-15` and `macos-15-intel` runners. The initial
minimum OS version is macOS 15, matching CI; older versions are not validated.
The reusable [macOS workflow](../.github/workflows/macos-build.yml) runs from CI
on pushes and pull requests, and also supports manual dispatch. These packages
are experimental CI artifacts, not part of the release workflow.

## Download and run

From a successful [CI run](https://github.com/corelight/quipu/actions/workflows/ci.yml),
download `quipu-macos-aarch64` for Apple Silicon or `quipu-macos-x86_64` for Intel.
Extract the artifact ZIP and, in that directory, verify the DMG:

```bash
shasum -a 256 --check SHA256SUMS
```

Open the DMG and drag Quipu to Applications before launching it. These builds
have an **ad-hoc signature**, not a Developer ID signature, and are **not
notarized**. The signature and checksum detect changes but do not authenticate
Corelight as the publisher. Gatekeeper may block the first launch. For a build
you trust from this repository, attempt to open it, then use **System Settings
→ Privacy & Security → Open Anyway** if offered. Organization policies can
prevent this override. Do not disable Gatekeeper globally.

## Building without an Apple Developer membership

An Apple Developer Program membership is not needed to compile the app, create
a DMG, or apply the local ad-hoc signature (`signingIdentity: "-"`). No Apple
account or signing secrets are used by CI. Membership is needed for Developer ID
distribution and notarization, which would remove this development-build
installation friction.

The platform config deliberately disables hardened runtime for these ad-hoc
builds: YARA-X uses Wasmtime to execute generated code. Before enabling hardened
runtime for Developer ID distribution, review Wasmtime's JIT entitlement needs,
add the appropriate entitlements, and test real compilation/scanning in the
signed app. Signing and notarization are separate follow-up work.

Install Xcode Command Line Tools (`xcode-select --install`), Rust 1.93 or newer,
Node.js 22.6 or newer, Git, and Zola 0.23.6 on `PATH`. On macOS 15 or newer,
from the repository root:

```bash
export YRX_REGENERATE_MODULES_RS=false
export MACOSX_DEPLOYMENT_TARGET=15.0
cd app
npm ci
npm test
cd src-tauri
cargo test --locked
cd ..
npm run tauri -- build --ci --bundles app,dmg -- --locked
```

Tauri automatically merges `tauri.macos.conf.json` on macOS. Packages are under
`app/src-tauri/target/release/bundle/{macos,dmg}`. CI passes an explicit Rust
target, so its packages are under `target/<target>/release/bundle/` instead.
Use `npm run tauri -- dev` to develop locally.

## Validation status

The workflow runs frontend tests, builds the frontend and bundled documentation,
runs Clippy and Rust tests (including YARA compilation/scanning and filesystem
operations), and builds the app and DMG. Package validation mounts the final DMG
read-only, verifies its integrity, executable architecture, bundle metadata and
ad-hoc signature, and compares the bundled examples and license notices with
the source tree.

Three filesystem fixtures that create non-UTF-8 filenames are ignored on macOS
because APFS rejects those names with `EILSEQ`. They still run on Linux; the
in-memory non-Unicode path identity test also runs on macOS.

The first native CI run passed Clippy and 296 Rust tests on both architectures;
the three APFS-incompatible fixtures above were the only test failures. Package
validation is pending the follow-up run. Interactive desktop validation is also
pending; a successful package build does not establish full
macOS support. On each architecture, check:

- Install from a downloaded DMG, launch through Gatekeeper, and reopen the app.
- Open bundled examples, compile rules, scan text and files, and restore a
  compiled ruleset after restarting (including Wasmtime JIT execution).
- Edit and save rules; test rename conflicts and external edits on default,
  case-insensitive APFS, plus file-watcher refreshes.
- Exercise native menus, Command-key shortcuts, text copy/paste, file dialogs,
  preferences, zoom, and pane layout.
- Open offline help, close and reopen it, and quit with help open. Repeat with
  unsaved work and confirm Cancel preserves the windows and edits.

The automated GUI acceptance harness currently runs on Linux only.

References: [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/),
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#macos), and
[Apple's guidance for apps from unidentified developers](https://support.apple.com/en-us/102445).
