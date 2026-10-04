# Release process

Quipu's Linux and Windows x86-64 packages are built from a tag by GitHub Actions.
Release binaries must not be added to the repository or Git LFS.

## Prepare the release

1. Update `app/package.json` and `app/package-lock.json` to the same semantic
   version.
2. Move the relevant entries in `CHANGELOG.md` from **Unreleased** into a
   versioned section with the release date.
3. If either lockfile changed, run `npm run licenses:generate` from `app` and
   review the resulting third-party notice diff.
4. Run the complete checks in `CONTRIBUTING.md` and, for UI or packaging
   changes, the applicable native-menu acceptance scenarios.
5. Run the **Release** workflow manually on the preparation branch and inspect
   the combined `quipu-release` artifact. It must contain AppImage, DEB, RPM,
   NSIS `.exe`, MSI `.msi`, and a `SHA256SUMS` covering all five packages with
   matching hashes and versions. A manual run does not publish a release.
6. Merge the reviewed release preparation to the default branch.

## Publish

Create one annotated tag on the exact reviewed commit and push it:

```bash
git tag -a v0.3.0 -m "Release 0.3.0"
git push origin v0.3.0
```

The tag must be `v` followed by the exact version in `app/package.json`. The
workflow refuses a mismatch, builds Linux and Windows packages on clean runners,
validates their packaged resources and legal notices, and writes a combined
`SHA256SUMS`. The publish job then waits for approval in the protected `release`
environment. Inspect the tag run's artifacts before approving publication.

After publication, inspect the release page and install each package format on
appropriate clean Linux and Windows systems. Windows CI performs an NSIS
install/uninstall and MSI administrative extraction; actual MSI installation
and installer upgrades need desktop validation. Use the
[Windows checklist](windows.md#validation-status). Edit the generated release
notes when they need user-facing context, but do not replace workflow-built
artifacts with local builds.

Quipu packages are not currently code-signed. The published SHA-256 file detects
accidental corruption but is not a substitute for an authenticated signature.
