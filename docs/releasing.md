# Release process

Public CI builds Linux/Windows x86-64 and macOS Apple Silicon/Intel. Apple
credentials stay in the maintainer's private signing repository. All platforms
must use the exact tagged source commit. Release binaries do not belong in Git
or Git LFS.

## Prepare and tag

1. Bump `app/package.json` and both root version fields in `app/package-lock.json`.
   Record the changes and release date in `CHANGELOG.md`.
2. Refresh third-party notices if dependencies changed. Run the checks in
   `CONTRIBUTING.md`, including release-tool tests (`python3 -m unittest discover
   -s tests -v`). Review the private signing workflow and its tests too.
3. Merge the release preparation and wait for the complete **push-to-main CI**
   run to pass. Record its run ID and full commit SHA. It supplies the macOS
   signing inputs; pull-request and feature-branch artifacts are ineligible.
4. Create an annotated `vMAJOR.MINOR.PATCH` tag at that exact SHA and push it.
   Do not move a published tag. If source changes are needed after tagging,
   prepare a new version/tag rather than silently replacing release binaries.
5. The tag's **Release** workflow builds Linux and Windows and validates exactly
   seven packages. Its combined `quipu-release` artifact contains `SHA256SUMS`
   and `RELEASE_BUILD.json` (source SHA, run/attempt, version and package hashes).
   After approval in the existing `release` environment it creates a **draft**.
   This approval stages packages; it does not publish them. A manually dispatched
   branch run remains a build-only dry run.

## Sign and assemble the draft

In `simeonmiteff/quipu-apple-signing`, dispatch **Verify or sign Quipu macOS
packages** on `main` with the successful public main CI run, exact SHA, version,
release tag, and signing enabled. The tag must resolve to that SHA. Signing must
finish successfully on both architectures. See [macOS signing](macos-signing.md)
for certificate setup and notarization timeout recovery.

From the private signing checkout on your Linux workstation, using your own
GitHub CLI login, run:

```bash
python3 scripts/release.py --tag v0.5.0 --sha FULL_SOURCE_SHA --signing-run SIGNING_RUN_ID
```

The helper validates the tag, successful source/build/signing runs, artifact
archive hashes, package hashes, provenance, and Apple's acceptance records. It
adds the two DMGs and provenance JSON files to the draft and replaces the draft's
seven-package checksum manifest with one covering all **nine** packages.
Existing identical assets are retained; conflicting binaries, incomplete runs,
and already-published releases are rejected. Only the draft checksum manifest
may be replaced. Avoid simultaneous release edits while the helper runs.

No cross-repository CI token is required. No public workflow gets Apple secrets
or access to the private signing repository. Public CI artifacts remain ad-hoc
signed on macOS and must never be uploaded as the final release DMGs.

## Manual acceptance and publication

Download the assembled draft with your GitHub login, or share the exact verified
packages through an appropriate browser-download location with testers. Drafts
are not publicly downloadable by ordinary users. Do not grant coworkers access
to the signing repository. If a public testing prerelease is needed, publish it
separately and retain the same package hashes/source provenance.

Record OS versions, architecture, package hashes, previous-install history, and
results in `docs/release-testing-0.5.0.md` (or the equivalent for the next release).
Test Linux packages; Windows standard/offline EXE and MSI installation/upgrade;
and both macOS architectures. Exercise rule compilation/scanning, includes and
errors, matching results, edits/saves, restart/cache restoration, native menus,
shortcuts, dialogs, and offline help. Use the [Windows](windows.md#validation-status)
and [macOS](macos.md#validation-status) checklists. Browser-downloaded DMGs must
install and launch with Gatekeeper enabled and without security overrides.

After all manual acceptance passes, update the draft's release notes and run:

```bash
python3 scripts/release.py --tag v0.5.0 --sha FULL_SOURCE_SHA --signing-run SIGNING_RUN_ID \
  --publish --manual-tests-passed
```

The helper revalidates the complete draft before making it the latest stable
release. The confirmation flag is the maintainer's explicit acceptance record,
not an automated GUI test. Verify the public page and downloadable hashes after
publication. Preserve build and signing provenance with the release assets.
Linux and Windows packages remain unsigned; the macOS app and DMG are Developer
ID signed, notarized, and stapled. Checksums cover all nine packages.
