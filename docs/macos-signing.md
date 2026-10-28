# macOS Developer ID signing setup

This is the setup guide for the private
[`simeonmiteff/quipu-apple-signing`](https://github.com/simeonmiteff/quipu-apple-signing)
repository. Developer ID signing, notarization, stapling, and Gatekeeper checks
have passed for both 0.4.0 architectures as of 2026-10-23 Brisbane time.
Signed-app desktop acceptance testing remains outstanding before a normal release.
The signed packages are published in the
[macOS testing prerelease](https://github.com/corelight/quipu/releases/tag/macos-signing-test-1).
Public macOS CI continues to produce experimental ad-hoc-signed DMGs.
Distribution will remain through GitHub Releases, outside the Mac App Store.

You do not need a local Mac for certificate setup or signing. Generate the key
and CSR on Linux, use Apple's portal in a Linux browser, and run Apple's build,
signing, notarization, and verification tools on GitHub-hosted macOS runners.
Interactive acceptance testing needs a macOS desktop, which can belong to a
tester or be accessed remotely; the tester needs only the finished DMG.

## Where credentials belong

GitHub Actions secrets do not have a per-user access list. Stored values cannot
be read back through GitHub's UI or API, even by their creator, but workflow code
can use them and can disclose them. Log masking is not an access boundary.

In an organization repository, an environment with `simeonmiteff` as its sole
required reviewer can gate signing jobs. It cannot exclude repository admins or
organization owners: admins can change the environment configuration. Disabling
administrator bypass does not remove their ability to edit those settings.

To keep control with the individual account holder, use the
**private `simeonmiteff/quipu-apple-signing` repository, with no collaborators**, containing
the signing workflow and Apple secrets. Review GitHub Apps with write access as
well. This keeps other project maintainers outside the signing repository's
access boundary; GitHub remains the trusted CI service provider.

Use manual dispatch on its reviewed default branch, and select an exact reviewed
40-character source commit and successful push-to-main CI run from
`corelight/quipu`. Do not execute a moving copy of
an upstream signing workflow, automatically sign pull requests, or grant the
Corelight repository access to the Apple secrets. A username check in a workflow
is an additional check, not a substitute for repository access control.

Keep compilation and tests in the public repository, without Apple credentials.
The private workflow checks the selected CI run's repository, event, branch,
commit and result, verifies GitHub's artifact digests and the enclosed checksums,
then extracts the app from each existing DMG. It runs only the reviewed private
signing scripts, not downloaded app code or source build hooks. A temporary
keychain holds the certificate during signing. The app gets hardened runtime
and the reviewed Wasmtime entitlement; the app and final DMG are notarized and
stapled, then verified before upload. Cleanup deletes the keychain and temporary
certificate on success or failure. The current single-executable bundle is
supported; unexpected nested code fails for review rather than being signed
automatically. No caches or diagnostic bundles containing keys are uploaded.

Start with the workflow's default **verification-only** mode. Supply a public CI
run ID, its exact source SHA, and the expected stable version, leaving **Sign
and notarize** unchecked. This tests the handoff on a Linux runner without Apple
secrets or macOS signing jobs. After configuring secrets, enable signing for a
reviewed build. See the private repository's README for the runbook.

The [initial verification-only run](https://github.com/simeonmiteff/quipu-apple-signing/actions/runs/39541451541)
passed on 2026-10-21 using signing workflow commit `b931fd7`. It fetched and
verified both 0.4.0 DMGs from public CI run `39364365849`, source commit
`7940dde280080bae3260bd9f487e3544d87c75ae`, using only the private repository's
`GITHUB_TOKEN`. No additional GitHub token was needed. Signing and collection
jobs were skipped, so this establishes the artifact handoff only, not Apple
certificate import, notarization, or signed-app runtime behavior.

The [first successful app-signing run](https://github.com/simeonmiteff/quipu-apple-signing/actions/runs/39745793116)
on 2026-10-22 used signing commit `6f4b622` and the same public 0.4.0 build. Both
architectures imported the certificate, authenticated with Apple, signed the app
with Developer ID/hardened runtime, and passed signature and entitlement checks.
Earlier attempts exposed two workflow issues, now fixed: the temporary keychain
must be in the user search list, and app signing needs the runner filesystem's
working space instead of the tightly sized mounted DMG. The original search
list is restored during cleanup, and the image gets extra room before the
signed/stapled app is copied back.

Both initial notarization waits reached their ten-minute limits. The
[status-only check](https://github.com/simeonmiteff/quipu-apple-signing/actions/runs/39747505330)
confirmed **In Progress**, not rejection, for these app submissions:

- Apple Silicon: `997a0028-e129-4814-9f80-a1c49e77a72c`
- Intel: `36df9fd0-c885-465b-bad7-dd7a156cce3e`

The [subsequent status check](https://github.com/simeonmiteff/quipu-apple-signing/actions/runs/39870719568)
confirmed both **Accepted** at 2026-10-22 23:16 UTC. A fresh
[complete signing run](https://github.com/simeonmiteff/quipu-apple-signing/actions/runs/39870818723)
then passed using signing commit `de557f9` and the same public source commit.
Apple accepted both newly signed apps and both final DMGs. Stapling, Gatekeeper
assessment, final mounted-app signature checks, and cleanup passed on both
architectures. The downloaded DMGs also match `SHA256SUMS` and their provenance
records.

The [combined signed artifact](https://github.com/simeonmiteff/quipu-apple-signing/actions/runs/39870818723/artifacts/12465654652)
contains `Quipu_0.4.0_aarch64.dmg`, `Quipu_0.4.0_x64.dmg`, `SHA256SUMS`, and two
provenance JSON files. Artifact retention is seven days. The same DMGs and
`SHA256SUMS` are also published as release assets under `macos-signing-test-1`,
at the exact source commit above. That prerelease is separate from `v0.4.0`,
which points to `a3c7caeb3e3846964b419c9092b6a6bc34ad0d40`; the signed build
includes subsequent dependency updates despite retaining app version 0.4.0.

On 2026-10-23, the maintainer confirmed installation, launch, signature checks,
and notarization/Gatekeeper assessments in a macOS VM. Transfer used `scp`, so
this does not establish fresh browser-download Gatekeeper behavior. The public
prerelease includes a coworker checklist for first-download installation and
actual compilation/scanning under hardened runtime on both architectures.
These desktop acceptance checks remain outstanding before a normal release.

For future timeouts, use the private repository's **Check existing Apple
notarization submissions** workflow on `main` with the pending UUIDs separated
by spaces.
This short job does not load the signing certificate or submit new copies. A
successful status job means the queries succeeded; read the actual Apple status.
Investigate `Invalid`/`Rejected` results using the notarization log it retrieves.
Wait for acceptance before another signing run. The timed-out run retains no
signed app ZIP or finished DMG, so it cannot resume that exact submission; a
new signing run must produce and notarize the release artifacts. The 0.4.0
recovery above completed this process. Publication is a separate manual step;
the signing workflow itself does not publish releases.

Start with downloading the finished packages from the personal repository and
publishing them through the account holder's authenticated release process.
Automated cross-repository publication can be added separately with narrowly
scoped GitHub permissions. Record the source SHA and signing run alongside each
release, and regenerate the combined release checksums after signing/stapling.

Repository Actions secrets work without relying on environment protection
features. Private-repository environments require an eligible GitHub plan, and
required-reviewer availability has additional restrictions; check the plan
before depending on them. Private macOS runner usage also consumes the personal
account's Actions allowance/budget.

## Production release handoff

Use the [release runbook](releasing.md). Production signing requires an existing
`vMAJOR.MINOR.PATCH` tag resolving to the exact successful main CI commit. Supply
`release_tag` along with the source SHA, version and CI run ID. Both the initial
and final fetch checks resolve annotated or lightweight tags; provenance records
the selected tag. Ordinary source builds remain credential-free.

The private checkout's `scripts/release.py` runs locally with your GitHub login
and assembles a matching public draft. It verifies artifact archive digests,
complete successful workflow runs, signing provenance, Apple acceptance, and
package hashes before uploading. Nine packages are required for final publication.
Identical uploads can be retried; conflicting binaries are never overwritten.
Only the draft checksum manifest changes from seven to nine packages.

Maintain the encrypted certificate backup and password separately. Check the
certificate expiry before release work; renew the Developer ID certificate and
replace the P12 secrets before it expires. If notarization authentication fails,
check the Apple account and replace its app-specific password when needed.
Use the status-only workflow after a timeout; do not submit repeated copies while
Apple is still processing. Download candidates before their seven-day retention
expires, and retain public release assets/provenance permanently.

The account holder confirmed the initial signed DMG worked for an Apple Silicon
coworker. That validates the distribution mechanism, not the newer engine;
0.5.0 manual checks are tracked separately in [release testing](release-testing-0.5.0.md).

## Create the certificate on Linux

Keep all private material on your own Linux machine and in your own GitHub
secret-entry form. Do not paste it into chat, an issue, a pull request, or the
source repository.

Use OpenSSL to create an encrypted RSA 2048-bit private key and a certificate
signing request (CSR). Run these commands in your own terminal, outside the
checkout. The new directory avoids overwriting an existing signing key:

```bash
umask 077
quipu_signing_dir="$(mktemp -d "$HOME/quipu-signing.XXXXXXXX")"
cd "$quipu_signing_dir"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -aes-256-cbc -out quipu-developer-id.key.pem
openssl req -new -sha256 -key quipu-developer-id.key.pem \
  -out quipu-developer-id.certSigningRequest
```

OpenSSL prompts for a new key passphrase, then asks for it again when creating
the CSR. Save it in your password manager. For the CSR subject, enter your own
details, a descriptive Common Name such as `Quipu Developer ID`, and your Apple
account email. Leave the optional challenge password and optional company name
blank. Do not put passwords in command-line arguments.

Next, use your Linux browser:

1. Sign into [Apple Developer](https://developer.apple.com/account/), then open
   **Certificates, Identifiers & Profiles → Certificates → +**.
2. Under Software choose **Developer ID Application** (some portal versions
   first show **Developer ID**, then the Application/Installer choice). Follow
   the current certificate authority selection offered for modern Xcode.
   Developer ID Installer is for `.pkg` installers; Quipu's `.app`/DMG needs
   Developer ID Application. Do not choose Apple Distribution or Mac App
   Distribution.
3. Upload `quipu-developer-id.certSigningRequest`, click **Continue**, then
   **Download**. Only the CSR is uploaded; the private key stays on Linux.
4. Save the downloaded certificate in the signing directory as
   `developerID_application.cer`. The `.cer` alone is not enough for CI signing;
   it must be paired with the private key that generated the CSR.

Back in the same Linux terminal, convert Apple's DER certificate to PEM, then
package it with the private key into a password-protected PKCS#12 (`.p12`) file:

```bash
openssl x509 -inform DER -in developerID_application.cer \
  -out quipu-developer-id.cert.pem
openssl pkcs12 -export -inkey quipu-developer-id.key.pem \
  -in quipu-developer-id.cert.pem -out quipu-developer-id.p12 \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
openssl x509 -in quipu-developer-id.cert.pem -noout -subject -nameopt multiline
```

The explicit PKCS#12 algorithms provide compatibility with Apple's keychain
importer instead of relying on OpenSSL 3's newer export defaults. They affect
the encrypted transport file, not the app's code-signature algorithm. OpenSSL
asks for the existing private-key passphrase and a new **Export Password**;
save the latter as `APPLE_CERTIFICATE_PASSWORD`. Use a strong, distinct export
password, not your Linux login or Apple account password.

From the displayed certificate subject, record the full Common Name,
`Developer ID Application: Your Name (TEAMID)`, as `APPLE_SIGNING_IDENTITY`.
The identity and Team ID are public metadata and will be visible in the
distributed signature. An individual membership identifies you personally as
the signer. No local Keychain Access or Xcode installation is needed. The
macOS CI signing job will import the `.p12` and confirm the identity using
`security find-identity -v -p codesigning` before signing.

## Set up notarization authentication

For an initial setup, an Apple **app-specific password** works with `notarytool`
and Tauri and requires no App Store listing or API-key setup:

1. Sign in at [account.apple.com](https://account.apple.com/).
2. Open **Sign-In and Security → App-Specific Passwords → Generate an
   app-specific password**. Label it `Quipu notarization`.
3. Save the generated password in your password manager. This is the value for
   `APPLE_PASSWORD`; never put your primary Apple account password into CI.
4. In your Apple Developer account's **Membership details**, record the
   **Team ID**. It is not the App Store Connect issuer ID.

The label is for your bookkeeping; it does not make an app-specific password
cryptographically exclusive to Quipu. An App Store Connect API key is an
alternative authentication method, with different key/issuer fields, but the
initial private workflow implements the app-specific-password method. Changing
the main Apple account password automatically revokes app-specific passwords.

## Enter GitHub secrets

In **`simeonmiteff/quipu-apple-signing`**, open **Settings → Secrets and
variables → Actions → Secrets → New repository secret**. Use Secrets, not
Variables, for the private material. Do not add these credentials to
`corelight/quipu` under the individual-only access requirement.

The workflow uses these secret names:

| Name | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the exported `.p12`, including its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full `Developer ID Application: Your Name (TEAMID)` name |
| `APPLE_ID` | Apple account email used for notarization |
| `APPLE_PASSWORD` | Generated app-specific password |
| `APPLE_TEAM_ID` | Team ID from Apple Developer Membership details |

On Linux with Wayland and `wl-clipboard` installed, copy the base64 value
directly to the clipboard from your signing directory:

```bash
openssl base64 -A -in quipu-developer-id.p12 | wl-copy
```

Paste into the `APPLE_CERTIFICATE` secret form and save. Clear the clipboard
afterwards:

```bash
wl-copy --clear
```

For an X11 desktop with `xclip` installed, use `xclip -selection clipboard`
instead of `wl-copy`, and clear it with `xclip -selection clipboard < /dev/null`.
If your desktop keeps clipboard history, remove the entry from that history too.

Alternatively, with GitHub CLI authenticated as your personal user, send the
value straight to the secret without using the clipboard:

```bash
openssl base64 -A -in quipu-developer-id.p12 | \
  gh secret set APPLE_CERTIFICATE --repo simeonmiteff/quipu-apple-signing
```

Base64 is an encoding, not encryption. Retain an encrypted backup of the `.p12`
and its password under your control. A temporary CI keychain password should be
generated by each signing job; it does not need to be another persistent secret.

## Quipu-specific implementation and validation

The current `tauri.macos.conf.json` sets `signingIdentity` to `-` and disables
hardened runtime. The package validator explicitly requires that ad-hoc setup.
The private workflow applies the separate Developer ID signing configuration
and validation path after the public build, while ordinary pull-request builds
remain credential-free.

Quipu uses Wasmtime 48.0.7 through YARA-X. Its Unix code-memory implementation
uses `mprotect` to make generated code executable. The private workflow includes
`com.apple.security.cs.allow-unsigned-executable-memory` for that implementation;
do not assume `com.apple.security.cs.allow-jit` alone covers a runtime that does
not use `MAP_JIT`. Limit exceptions to those actually needed, and verify real
rule compilation/scanning under hardened runtime on both architectures.

Run automated signing and package checks on GitHub's macOS runners; Linux does
not provide Apple's `security`, `codesign`, `hdiutil`, `notarytool`, `stapler`,
or Gatekeeper tools used by this workflow. The existing macOS build matrix
already covers Apple Silicon and Intel.

Before publishing signed testing packages:

- Check the app and DMG signatures, expected Developer ID identity/Team ID,
  secure timestamp, hardened runtime flag, and signed entitlements.
- Submit to Apple's notary service and require an **Accepted** result. A
  successfully queued submission is not acceptance.
- Staple and validate the applicable tickets, then mount the final DMG and
  validate its enclosed app, resources, architecture, and version. Perform
  Gatekeeper assessment on the signed distribution.
- Generate SHA-256 checksums only after all signing and stapling changes.

Before promoting macOS support into a normal release:

- Download the final DMG through a browser onto a Mac, install and launch with
  Gatekeeper enabled, and compile/scan rules, including after restarting and
  restoring compiled rules. Cover Apple Silicon and Intel. Unsigned Rust unit
  tests do not establish that the signed app's JIT works.

The interactive download/install/launch check can be done by a colleague or
on a remotely accessible Mac. It requires only the finished DMG, not your Apple
account or signing keys. Automated CI checks do not fully establish the normal
desktop experience, and an Intel VM does not establish Apple Silicon coverage.
No local macOS VM is needed for certificate setup or the signing pipeline.

## Private Actions usage

The private repository performs verification/signing only; builds and dependency
caches remain public. Input artifacts expire after one day, and signed outputs
after seven days. Current DMGs total about 29 MiB per pair. Keeping both the
per-architecture outputs and the combined output doubles signed-artifact storage
to about 58 MiB per run, plus the temporary input pair. Account-wide artifact
storage is shared with other repositories and GitHub Packages. No cache is used
in the signing repository.

Notarization waits consume macOS runner time. Each submission has a ten-minute
wait limit and each macOS job a thirty-minute timeout; failure or timeout never
produces a publishable combined artifact. Check actual allowance consumption
after the first signing run and configure the personal account's Actions budget.

## Eventual Corelight handover

Corelight should issue its own Developer ID certificate and notarization
credentials under its own Apple team. Do not transfer your individual private
key. Keep `com.corelight.quipu` stable, but test installation over a personally
signed version: changing Team ID changes signing identity and can affect
Keychain access, privacy permissions, and any future team-bound capabilities.
There is no App Store listing to transfer in this distribution model.

App Store apps are not universally nontransferable: Apple supports transfers
subject to eligibility criteria. Remaining outside the store is the chosen
distribution policy, not a claim that all App Store transfers are impossible.

Apple's agreement addresses third-party service providers in section 2.9 and
account access in section 2.1. The design above addresses technical credential
control; check the agreement actually accepted by the account holder for the
contractual obligations that apply.

## References

- [Apple Developer Program License Agreement](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)
- [Apple: create a CSR](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/)
- [Apple Codesign: certificate creation without Keychain Access](https://gregoryszorc.com/docs/apple-codesign/stable/apple_codesign_certificate_management.html)
- [Apple: Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Apple: app-specific passwords](https://support.apple.com/en-us/102654)
- [Apple: app transfers](https://developer.apple.com/help/app-store-connect/transfer-an-app/overview-of-app-transfer/)
- [GitHub: managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [GitHub: using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [Tauri: macOS signing and notarization](https://v2.tauri.app/distribute/sign/macos/)
