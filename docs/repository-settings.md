# GitHub repository settings

These settings complement the files stored in the repository. Review them
before making the repository public and after material changes to GitHub's
security or Actions configuration.

## General

- Set the intended public branch as the default. `main` is recommended for a
  new repository with no inherited history.
- Enable Issues and disable unused features until they have an owner.
- Allow squash merging, automatically delete merged head branches, and use the
  pull request title and description for the squash commit message.
- Add a concise repository description, the topics `yara`, `yara-x`, `tauri`,
  `rust`, `typescript`, and `security-tools`, and a sanitized social preview.
- Do not enable Git LFS for release packages. GitHub Releases owns binary
  distribution.

## Rulesets

Protect the default branch after the initial import:

- require a pull request and at least one approval
- dismiss stale approvals and require review from Code Owners
- require conversation resolution and a linear history
- require the CI, CodeQL, and dependency-security checks
- block force pushes and branch deletion
- allow bypass only for the smallest practical maintainer team

Protect tags matching `v*` from updates and deletion, and limit tag creation to
release maintainers. A release tag must identify the exact reviewed commit and
match the version in `app/package.json`.

## Security

- Enable private vulnerability reporting before public visibility; the links in
  `SECURITY.md` and the issue chooser depend on it.
- Enable the dependency graph, Dependabot alerts, Dependabot security updates,
  secret scanning, push protection, and CodeQL default/setup alerts as available
  for the organization and repository plan.
- Keep GitHub Actions' default workflow token read-only. Individual jobs in this
  repository request their narrow write permissions explicitly.
- Restrict allowed Actions to GitHub-owned actions and the SHA-pinned third-party
  actions used by the workflows. Review Dependabot updates to those SHAs.

## Releases

Create an environment named `release`. Require a release maintainer's approval
before deployment and limit it to protected `v*` tags. The build job can then
finish and expose its short-lived package artifact for inspection while the
publish job waits for approval.

Follow [releasing.md](releasing.md) for versioning, test, tag, and post-release
steps.

## Ownership and conduct

`CODEOWNERS` initially routes review requests to `@simeonmiteff`. Replace that
individual owner with the Corelight Quipu Developers team after the team exists
and has explicit write access to the repository.

No code of conduct is published initially. Adopt one only after its scope,
enforcement process, and monitored private contact have been agreed. Do not
publish a template with placeholder or unmonitored contact information.
