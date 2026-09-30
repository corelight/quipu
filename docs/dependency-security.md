# Dependency security exceptions

Quipu's automated dependency audit fails on known vulnerabilities unless an
exception is listed here with a specific rationale. Exceptions are temporary
and must be reconsidered whenever the affected dependency or its parent stack is
updated.

## RUSTSEC-2024-0429: `glib` 0.18.5

- **Status:** Temporarily ignored in `.github/workflows/security.yml`.
- **Dependency path:** Tauri 2's Linux GTK 3 stack depends on `gtk` 0.18, which
  in turn pins `glib` 0.18.5. Quipu does not select this version directly.
- **Affected API:** The advisory applies to `VariantStrIter` and
  `VariantTypeStrIter` for a specific non-Send iterator soundness issue.
- **Exposure assessment:** Neither Quipu nor any crate in its resolved
  dependency source calls the affected iterator types. The dependency remains
  present because it supplies the Linux GUI stack.
- **Removal condition:** Remove the audit exception as soon as Tauri's supported
  Linux stack no longer resolves to the affected `glib` release. Recheck on
  every Tauri, Wry, WebKitGTK binding, or GTK binding update.

This exception does not claim that the advisory is unimportant or that all use
of the affected release is safe. It records the narrowly reviewed reason the
current Quipu build is allowed to retain it.
