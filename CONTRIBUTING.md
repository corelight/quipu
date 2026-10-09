# Contributing to Quipu

Thanks for helping improve Quipu. Contributions can include bug reports,
feature ideas, documentation, testing, design feedback, and code.

## Before you start

- Search the [issue tracker](https://github.com/corelight/quipu/issues) for an
  existing report or proposal.
- Open an issue before investing in a substantial feature or architectural
  change so its scope can be agreed first.
- Report vulnerabilities through the private process in
  [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Development can happen on Linux or Windows x86-64. Install the prerequisites
in [README.md](README.md#build-from-source) for Linux or
[Windows development](docs/windows.md#build-locally-on-windows) for Windows, then:

```bash
cd app
npm ci
npm run tauri -- dev
```

The first Rust build takes longer because it compiles YARA-X and its
dependencies from source.

Experimental Apple Silicon and Intel macOS builds are described in
[macOS development](docs/macos.md), including prerequisites and desktop checks.

## Required checks

Run the checks relevant to your change. Before requesting review, a complete
code change should pass the checks below.

Set the YARA-X build environment first. In Bash:

```bash
export YRX_REGENERATE_MODULES_RS=false
```

Or in PowerShell:

```powershell
$env:YRX_REGENERATE_MODULES_RS = 'false'
```

Then run these commands in either shell, starting at the repository root:

```bash
cd app
npm test
npm run build

cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

On Linux, also run the UI harness unit tests from the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test/ui -p '*_test.py' -v
```

The native-menu acceptance suite runs on Linux, has extra display-server
requirements, and can be run selectively for affected UI work. See
[test/README.md](test/README.md). Windows contributors can rely on CI for the
Linux harness checks, but should manually exercise affected Windows UI behavior
using the [Windows validation checklist](docs/windows.md#validation-status).

If a Cargo or npm lockfile changes, install
[`cargo-about`](https://github.com/EmbarkStudios/cargo-about) 0.9.2 and refresh
the committed runtime notices:

```bash
cd app
npm ci
npm run licenses:generate
```

Review license changes as carefully as code changes. The generator fails if a
Rust dependency uses a license outside the reviewed set in
`app/src-tauri/about.toml`, or if a production npm package has no packaged
license or notice file.

## Dependency update groups

[Dependabot configuration](.github/dependabot.yml) groups packages by the changes
that need to be tested together:

- **Tauri:** one cross-ecosystem PR for `@tauri-apps/*` in npm and `tauri`/`tauri-*`
  in Cargo. Ordinary ecosystem entries exclude these version updates so there
  is no second, independently mergeable half of the update. The exclusions use
  version-update types, which do not suppress security updates.
- **YARA-X:** `yara-x`, `yara-x-parser`, and `yara-x-ls` share one Cargo group.
  It intentionally has no SemVer filter, so git-tag updates are grouped too.
  Review that all three tags still point at the same upstream release.
- **Monaco:** its own npm group, since 0.x minor updates can require editor
  migrations. This keeps that work out of routine frontend dependency updates.
- Other npm/Cargo minor and patch updates retain their ecosystem groups; other
  major upgrades remain separate. GitHub Actions retain their existing group.

All version-update groups run weekly on Monday. Cross-ecosystem grouping
coordinates available updates in one review; it cannot guarantee that upstream
publishes compatible versions simultaneously. Packaging and integration checks
still decide whether the proposed combination works. Security updates remain
eligible independently and may need manual coordination across ecosystems.

The cross-ecosystem layout follows GitHub's
[multi-ecosystem configuration](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/configuring-multi-ecosystem-updates)
and the maintainers' [example for grouping only selected packages](https://github.com/dependabot/dependabot-core/discussions/12437#discussioncomment-13449744).
After merging a configuration change, verify the jobs in **Insights → Dependency
graph → Dependabot**. Existing PRs are not retroactively combined; close older
split PRs only once their replacement is available or their updates are merged.
Generated license notices still need refreshing when a dependency PR changes
runtime packages.

## Platform workflows

CI calls reusable [Linux](.github/workflows/linux-build.yml),
[Windows](.github/workflows/windows-build.yml), and
[macOS](.github/workflows/macos-build.yml) workflows. Linux and Windows are also
called by Release; macOS remains experimental and outside release publication.

Linux tests and packages on Ubuntu 22.04 to preserve the release glibc baseline.
It checks formatting, Clippy, frontend/Rust tests and license notices, builds
AppImage/DEB/RPM packages, validates their contents, and runs native menu smoke
tests against the resulting release binary. The `quipu-linux-x86_64` artifact is
uploaded only after those checks pass, including on pull requests. The workflow
also supports manual dispatch once present on the default branch.

The existing required **Rust** check is a compatibility gate: it succeeds only
when the complete reusable Linux job succeeds. Failures, cancellations and skips
cannot satisfy it. This retains branch protection without duplicating the build.
Release waits for both Linux and Windows before assembling checksums; publication
remains restricted to version tags and the existing release environment.

## Change guidelines

- Keep each pull request focused on one coherent change.
- Add or update tests when behavior changes.
- Update the bundled documentation and [CHANGELOG.md](CHANGELOG.md) when a
  user-visible change warrants it.
- Do not commit generated output from `app/dist`, `app/generated`,
  `app/src-tauri/gen`, `app/node_modules`, or Cargo `target` directories.
- Use only sanitized, redistributable fixtures and screenshots. Never submit
  customer data, proprietary rules, malware samples, credentials, or local
  paths that reveal private information.
- Preserve the lockfiles and use locked or clean-install commands in tests and
  automation.
- Regenerate `THIRD_PARTY_LICENSES/` whenever a runtime dependency changes.

For a visual change, include a sanitized screenshot or short recording and
describe any keyboard or accessibility impact.

## Pull requests

In the pull request description, explain:

- what changed and why
- how you tested it
- any user-visible, compatibility, packaging, or security impact

Reviewers may ask for a change to be split, simplified, documented, or covered
by additional tests.

By submitting a contribution, you agree that it may be distributed under
Quipu's [BSD 3-Clause License](LICENSE).
