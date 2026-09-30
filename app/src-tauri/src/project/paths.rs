//! Path normalization for the project model.
//!
//! Two path forms live side by side and must not be confused:
//!
//! * **canonical absolute paths** (`std::fs::canonicalize`) are used for every
//!   filesystem access and to decide whether two spellings name the same file;
//! * **normalized identities** (`/`-separated strings, see
//!   [`super::SourceId`]) are used for ordering, deduplication, issue
//!   attribution and, later, hashing.
//!
//! Identities never depend on the host separator, so a project analyzed on
//! Windows and on Linux produces the same identity strings.
//!
//! Identities are also *lossless*: a path that is not valid Unicode has no
//! identity at all (see [`to_slash`]), because a lossy conversion would let two
//! different files share one identity. Such paths are reported and excluded
//! from the project rather than silently merged.

use std::path::Path;

/// Renders `path` as a `/`-separated identity, or `None` when the path is not
/// valid Unicode.
///
/// Returning `None` rather than substituting replacement characters is what
/// keeps identities unique: `a<0xff>.yar` and `a<0xfe>.yar` are different files
/// and must never produce the same string. Callers report the rejection with
/// [`escaped`] and leave the path out of the graph.
///
/// The identity is also required to be valid Unicode because it is destined for
/// JSON over Tauri IPC and, later, for cache fingerprints, neither of which can
/// carry arbitrary bytes.
pub(crate) fn to_slash(path: &Path) -> Option<String> {
    path.to_str().map(separators_to_slash)
}

/// Renders `path` for a human-readable message. Never used as an identity.
///
/// A valid-Unicode path renders as its identity would. Anything else is escaped
/// rather than replaced, so two different paths still read differently in a
/// diagnostic. The escaped form is not parseable and must not be fed back into
/// the filesystem.
pub(crate) fn escaped(path: &Path) -> String {
    to_slash(path).unwrap_or_else(|| {
        // `OsStr`'s Debug escapes the offending bytes (`\xNN` on Unix, a
        // `\u{...}` surrogate on Windows) and quotes the result; the quotes are
        // trimmed for readability.
        format!("{path:?}").trim_matches('"').to_string()
    })
}

/// On Windows, rewrites separators and strips the `\\?\` verbatim prefix that
/// `canonicalize` adds, so identities stay readable and host-independent.
#[cfg(windows)]
fn separators_to_slash(text: &str) -> String {
    text.strip_prefix(r"\\?\")
        .unwrap_or(text)
        .replace('\\', "/")
}

/// On Unix a backslash is a legal filename character, so nothing is rewritten.
#[cfg(not(windows))]
fn separators_to_slash(text: &str) -> String {
    text.to_string()
}

/// Why a manifest path was rejected.
///
/// Manifest paths are validated without touching the filesystem so the error
/// says what is wrong with the *declaration*, not what is missing on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathProblem {
    Empty,
    Absolute,
    Backslash,
    EscapesRoot,
    NotARuleFile,
}

impl std::fmt::Display for PathProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = match self {
            Self::Empty => "must not be empty",
            Self::Absolute => "must be relative to the project root",
            Self::Backslash => "must use '/' as the path separator",
            Self::EscapesRoot => "must not escape the project root",
            Self::NotARuleFile => "must be a .yar or .yara file",
        };
        f.write_str(reason)
    }
}

/// Validates and normalizes a manifest path that must stay inside the project.
///
/// Purely lexical: `.` components are dropped and `..` is resolved against
/// earlier components, so `rules/../rules/main.yar` normalizes to
/// `rules/main.yar`. A `..` that would climb above the root is rejected -
/// unlike include directories, an entrypoint may not leave the project.
pub(crate) fn normalize_inside_root(spec: &str) -> Result<String, PathProblem> {
    check_portable(spec)?;
    let mut parts: Vec<&str> = Vec::new();
    for part in spec.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                if parts.pop().is_none() {
                    return Err(PathProblem::EscapesRoot);
                }
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return Err(PathProblem::Empty);
    }
    Ok(parts.join("/"))
}

/// Validates a manifest path that is allowed to resolve outside the project
/// (an include directory). `..` is permitted; the caller resolves the result
/// against the project root on the filesystem.
pub(crate) fn check_portable(spec: &str) -> Result<(), PathProblem> {
    if spec.is_empty() {
        return Err(PathProblem::Empty);
    }
    if spec.contains('\\') {
        return Err(PathProblem::Backslash);
    }
    // A leading separator or a `C:`-style prefix would make the manifest
    // machine-specific, which defeats the point of a committed manifest.
    if spec.starts_with('/') || spec.as_bytes().get(1) == Some(&b':') {
        return Err(PathProblem::Absolute);
    }
    Ok(())
}

/// True when `path` has a YARA rule extension. Matching is case-insensitive:
/// `Rules.YAR` is a rule file, and the compiler will accept it as one.
pub(crate) fn is_rule_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("yar") || e.eq_ignore_ascii_case("yara"))
}
