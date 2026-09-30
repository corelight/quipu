//! Recursive discovery of the rule files a project contains.
//!
//! Discovery answers "which files does the user consider part of this project",
//! independently of the include graph. It is deliberately conservative:
//!
//! * only `.yar`/`.yara` files are project files, matched case-insensitively;
//! * directory symlinks are never followed, which is both the symlink-loop
//!   guard and the reason the walk always terminates;
//! * exclusion globs prune matching directories and skip matching files;
//! * results are sorted by identity, so the output never depends on the order
//!   the filesystem happened to hand back.
//!
//! A file that is *not* discovered can still enter the graph by being included
//! from a reachable source - discovery decides project membership, not
//! compilation inputs.
//!
//! # Failing closed
//!
//! Discovery never skips an entry silently. Every entry is either accounted for
//! or reported, because an unaccounted-for entry could have been a rule file -
//! even the project's only entrypoint - and a snapshot missing it would still
//! look valid. Every such report is *project-scoped* (see
//! [`super::IssueScope`]): the entry never becomes a graph node, so an issue
//! attributed to it would sit outside every plan's closure and block nothing.
//! The snapshot itself stays displayable; it is plan construction that rejects
//! the incomplete result.

use std::ffi::{OsStr, OsString};
use std::fs::{DirEntry, FileType};
use std::path::{Path, PathBuf};

use super::issues::{IssueKind, ProjectIssue};
use super::manifest::ProjectDefinition;
use super::paths;

/// Directory nesting depth at which the walk stops descending.
///
/// Not following directory symlinks already makes the walk finite on a normal
/// filesystem; this bounds the pathological cases (deeply recursive mounts, or
/// simply an accidentally enormous tree) as well. Hitting it is reported as a
/// blocking issue rather than silently truncating the project.
pub(crate) const MAX_DEPTH: usize = 64;

/// One discovered project file.
pub(crate) struct DiscoveredFile {
    /// Normalized, `/`-separated path relative to the project root, as walked.
    pub relative: String,
    /// Canonical absolute path. May differ from `root/relative` when the entry
    /// is a symlink to a file elsewhere.
    pub canonical: PathBuf,
}

/// The result of a discovery pass.
pub(crate) struct Discovery {
    /// Discovered files, sorted by `relative`.
    pub files: Vec<DiscoveredFile>,
    /// Problems that made discovery incomplete, sorted.
    pub issues: Vec<ProjectIssue>,
}

/// Walks the project root and returns its rule files.
pub(crate) fn discover(definition: &ProjectDefinition) -> Discovery {
    let mut files: Vec<DiscoveredFile> = Vec::new();
    let mut issues: Vec<ProjectIssue> = Vec::new();

    // Explicit stack rather than recursion: depth is user-controlled input.
    let mut pending: Vec<(PathBuf, String, usize)> =
        vec![(definition.root().to_path_buf(), String::new(), 0)];

    while let Some((dir, prefix, depth)) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            // Nothing in this directory is accounted for, so its whole subtree is
            // missing from discovery.
            Err(err) => {
                issues.push(entry_issue(&prefix, None, &err));
                continue;
            }
        };

        // Sorting each directory's entries keeps the walk itself deterministic,
        // which matters for the order issues are reported in.
        let mut names: Vec<(OsString, FileType)> = Vec::new();
        for entry in entries {
            match classify(entry) {
                Ok(inspected) => names.push(inspected),
                Err((name, err)) => issues.push(entry_issue(&prefix, name.as_deref(), &err)),
            }
        }
        names.sort_by(|a, b| a.0.cmp(&b.0));

        for (name, file_type) in names {
            let path = dir.join(&name);
            let Some(name_text) = paths::to_slash(Path::new(&name)) else {
                // Without an identity the entry can be neither a project file
                // nor a walked prefix, so it is reported - but only when it
                // could have belonged to the project at all. A non-Unicode
                // `notes.txt` is simply not a rule file, exactly as a
                // representable one would not be.
                if file_type.is_dir() || paths::is_rule_file(&path) {
                    issues.push(ProjectIssue::project(IssueKind::NonUnicodePath {
                        path: join_prefix(&prefix, &paths::escaped(Path::new(&name))),
                    }));
                }
                continue;
            };
            let relative = join_prefix(&prefix, &name_text);
            if definition.is_excluded(&relative) {
                continue;
            }

            // `file_type` comes from the directory entry and never follows a
            // symlink, so a symlinked directory is visible as a symlink here
            // and is not descended into.
            if file_type.is_dir() {
                if depth + 1 > MAX_DEPTH {
                    issues.push(ProjectIssue::project(IssueKind::DiscoveryDepthExceeded {
                        path: relative,
                        limit: MAX_DEPTH,
                    }));
                    continue;
                }
                pending.push((path, relative, depth + 1));
                continue;
            }

            // A symlink is followed only to decide what it points at: to a file
            // it is a candidate rule file, to a directory it is skipped. When
            // that fails - a dangling link, most often - the entry is treated as
            // a possible file so it reaches the canonicalization below and is
            // reported there, rather than dropped on the strength of a failed
            // check.
            let is_file = if file_type.is_symlink() {
                std::fs::metadata(&path)
                    .map(|m| m.is_file())
                    .unwrap_or(true)
            } else {
                file_type.is_file()
            };
            if !is_file || !paths::is_rule_file(&path) {
                continue;
            }

            match std::fs::canonicalize(&path) {
                Ok(canonical) => files.push(DiscoveredFile {
                    relative,
                    canonical,
                }),
                Err(err) => issues.push(ProjectIssue::project(IssueKind::UnreadableEntry {
                    path: relative,
                    error: err.to_string(),
                })),
            }
        }
    }

    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    issues.sort();
    Discovery { files, issues }
}

/// Inspects one entry yielded by [`std::fs::read_dir`].
///
/// The failure carries the entry's name when the platform got far enough to
/// report one - the iterator itself can fail before yielding anything nameable -
/// so the issue can attribute the problem as precisely as the error allows.
pub(super) fn classify(
    entry: std::io::Result<DirEntry>,
) -> Result<(OsString, FileType), (Option<OsString>, std::io::Error)> {
    let entry = entry.map_err(|err| (None, err))?;
    let name = entry.file_name();
    match entry.file_type() {
        Ok(file_type) => Ok((name, file_type)),
        Err(err) => Err((Some(name), err)),
    }
}

/// The issue for a directory listing that failed, in whole or for one entry.
///
/// Both forms are blocking and project-scoped (see the module note on failing
/// closed). A named entry is reported as `unreadable-entry`, which points at the
/// file. A failure with nothing nameable - the listing itself, or an iterator that
/// fails before yielding an entry - can only be attributed to the directory, so it
/// is reported as `unreadable-directory`.
pub(super) fn entry_issue(
    prefix: &str,
    name: Option<&OsStr>,
    error: &std::io::Error,
) -> ProjectIssue {
    match name {
        Some(name) => ProjectIssue::project(IssueKind::UnreadableEntry {
            path: join_prefix(prefix, &paths::escaped(Path::new(name))),
            error: error.to_string(),
        }),
        None => ProjectIssue::project(IssueKind::UnreadableDirectory {
            path: display_dir(prefix),
            error: error.to_string(),
        }),
    }
}

/// Joins a walked prefix and an entry name into a project-relative path.
fn join_prefix(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Renders a walked directory prefix for a message; the root itself has none.
fn display_dir(prefix: &str) -> String {
    if prefix.is_empty() {
        ".".to_string()
    } else {
        prefix.to_string()
    }
}
