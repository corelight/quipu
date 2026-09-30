# Release process

Quipu's Linux packages are built from a tag by GitHub Actions. Release binaries
must not be added to the repository or Git LFS.

## Prepare the release

1. Update `app/package.json` and `app/package-lock.json` to the same semantic
   version.
2. Move the relevant entries in `CHANGELOG.md` from **Unreleased** into a
   versioned section with the release date.
3. If either lockfile changed, run `npm run licenses:generate` from `app` and
   review the resulting third-party notice diff.
4. Run the complete checks in `CONTRIBUTING.md` and, for UI or packaging
   changes, the applicable native-menu acceptance scenarios.
5. Run the **Linux release** workflow manually and inspect its downloadable
   AppImage, DEB, RPM, and checksum artifacts. A manual run does not publish a
   release.
6. Merge the reviewed release preparation to the default branch.

## Publish

Create one annotated tag on the exact reviewed commit and push it:

```bash
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0
```

The tag must be `v` followed by the exact version in `app/package.json`. The
workflow refuses a mismatch, builds all three Linux x86-64 packages in a clean
runner, validates their metadata and legal notices, writes `SHA256SUMS`, and
creates a GitHub release.

After publication, inspect the release page and install each package format on
an appropriate clean Linux system. Edit the generated release notes when they
need user-facing context, but do not replace workflow-built artifacts with
local builds.

Quipu packages are not currently code-signed. The published SHA-256 file detects
accidental corruption but is not a substitute for an authenticated signature.
