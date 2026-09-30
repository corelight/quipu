//! The packaged example projects, and the editable working copies Quipu opens.
//!
//! An example ships twice. The **packaged copy** is a read-only template that
//! lives with the application: `examples/<dir>` under the bundle's resource
//! directory (see `bundle.resources` in `tauri.conf.json`). The **working copy**
//! is what the user actually opens, at
//! `<app-local-data>/examples/<id>/v<revision>/`, and it is theirs: the first
//! open copies the template, and every later open of the same revision reuses
//! the copy, edits included. Opening the template directly would either be
//! read-only - which makes an example useless as a place to experiment - or would
//! edit the installation.
//!
//! Nothing here takes a path from the frontend. [`prepare_example`] accepts a
//! catalog id, looks it up in [`EXAMPLES`], and derives both ends of the copy
//! from the entry it finds; an id that is not in the catalog is rejected before
//! any filesystem work happens. The recursive copy is deliberately not exposed
//! over IPC in any other form.
//!
//! The copy is committed rather than assembled in place. Every attempt claims a
//! staging directory of its own beside the destination, copies the template into
//! it, writes the marker file last, and only then moves the finished tree onto
//! `v<revision>` with an atomic no-replace rename. So the destination is only ever
//! absent or complete, and two attempts - two windows, two processes - meet nowhere
//! but that rename: whoever wins installs their copy, and the loser reuses it once
//! it has checked that what is there really is a marked working copy.
//!
//! No-replace is what makes the guarantee below hold, and it has to come from the
//! rename rather than from a look beforehand: an ordinary rename replaces an
//! existing empty directory on Unix, and a directory can appear in the window
//! between looking and renaming.
//!
//! Nothing is ever deleted to make room. A destination without an acceptable
//! marker cannot be a copy of ours interrupted halfway, because a copy in progress
//! never has that name; it is a restored backup, a directory someone made, or a
//! working copy whose marker has gone, and none of those are Quipu's to remove. It
//! is left exactly as it is and the preparation fails saying so. An attempt that
//! dies leaves its own staging directory behind: that debris is inert and uniquely
//! named, and deleting a staging directory this attempt does not own could destroy
//! a copy another one is still making.
//!
//! [`prepare`] takes the two roots as arguments so all of this is testable
//! without standing up a Tauri application; only [`resource_root`] and
//! [`prepare_example`] know how a running app finds them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::Manager;
use tauri::path::BaseDirectory;

use crate::project::{escaped, to_slash};

/// One packaged example project.
///
/// Fixed at compile time, and the only source of truth: the chooser asks the
/// backend for the list rather than keeping a copy of it, so the two cannot
/// disagree about what exists.
pub struct Example {
    /// Stable machine identity. Lowercase ASCII letters, digits and hyphens
    /// only, which is what makes it safe as a directory name (see
    /// [`is_id_like`]). It appears in the working copy's path, so changing one
    /// abandons the working copies made under the old id.
    pub id: &'static str,
    /// Shown in the chooser.
    pub name: &'static str,
    /// One sentence, shown under the name.
    pub description: &'static str,
    /// Raise this when the packaged project changes and users should get the new
    /// one. A new revision materializes into a new directory instead of
    /// overwriting the copy someone may have edited.
    pub revision: u32,
    /// Directory name under the packaged `examples` resource directory. Held
    /// separately from `id` because it names a file on disk rather than a
    /// protocol value, and validated the same way.
    pub dir: &'static str,
    /// The sample scan target, relative to the project root, `/`-separated. It is
    /// preloaded into the Scan target area so the documented scan is one click
    /// away.
    pub target: &'static str,
}

/// The catalog, in the order the chooser shows it: simplest first.
pub const EXAMPLES: &[Example] = &[
    Example {
        id: "basic-text-match",
        name: "Basic text match",
        description: "One rule file and no manifest, so Quipu infers the entrypoint. Two rules match the sample note.",
        revision: 1,
        dir: "basic-text-match",
        target: "targets/sample.txt",
    },
    Example {
        id: "nested-includes",
        name: "Nested includes",
        description: "A declared entrypoint and an include directory, with a two-level include graph to explore.",
        revision: 2,
        dir: "nested-includes",
        target: "targets/sample.txt",
    },
    Example {
        id: "multiple-entrypoints",
        name: "Multiple entrypoints",
        description: "Two independent entrypoints, compiled in the order the manifest declares rather than by path.",
        revision: 1,
        dir: "multiple-entrypoints",
        target: "targets/sample.txt",
    },
];

/// The packaged resource directory the catalog's `dir` entries are relative to.
const RESOURCE_DIR: &str = "examples";

/// Written into a working copy once it is complete, and the only thing that makes
/// a directory count as one.
///
/// It has to be a regular file, and the check does not follow links, so a symlink
/// left in its place makes the directory unacceptable rather than lending it
/// whatever it points at. Its absence is never permission to delete anything.
const MARKER: &str = ".quipu-example";

/// What a staging directory's name carries between `v<revision>` and the part that
/// makes it unique. The `.` is the point: no destination name contains one, so a
/// staging directory can never be mistaken for a working copy, nor a working copy
/// for staging debris.
const STAGING_INFIX: &str = ".staging-";

/// How many names to try when claiming a staging directory.
///
/// A name is claimed by creating it, so a collision means another attempt - or the
/// orphan of one that died - already has it. Two or three tries would do; this is
/// the count at which the answer is that something else is wrong.
const CLAIM_ATTEMPTS: u32 = 256;

/// How deep the packaged tree may be. An example is a handful of directories; a
/// limit that generous can only be reached by something pathological, and the
/// recursion should not be the thing that discovers it.
const MAX_DEPTH: usize = 32;

/// An example as the chooser needs it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// A working copy that is ready to be opened, with its sample target.
///
/// The target's bytes travel with it so the frontend needs no second call and no
/// general-purpose read: the one file an example preloads is the one the catalog
/// names.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedExample {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The working copy's root, in the spelling the frontend opens projects with.
    pub root: String,
    pub target: PreparedTarget,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTarget {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// Why an example could not be prepared.
///
/// Every variant is a closed door rather than a fallback: an unknown id, a
/// catalog entry that does not describe a usable path, a resource directory that
/// is not there, or something in the packaged tree that is not a plain file or
/// directory. Preparing is expected to fail loudly, because the caller is holding
/// a project it has not abandoned yet.
#[derive(Debug)]
pub enum PrepareError {
    /// Not in [`EXAMPLES`]. The id came over IPC, so this is the guard that makes
    /// the destination path independent of anything the frontend said.
    UnknownExample(String),
    /// A catalog entry's `dir` or `target` is not a path this may use. A bug in
    /// the catalog, caught here rather than resolved against the filesystem.
    InvalidCatalog {
        id: &'static str,
        field: &'static str,
        value: &'static str,
    },
    /// The application cannot say where its own resources are.
    NoResourceDir(String),
    /// The packaged example is not where the resource directory says it is.
    MissingResource(PathBuf),
    /// The packaged tree contains something that is neither a regular file nor a
    /// directory - a symlink, a socket, a device. Copying it could follow a link
    /// out of the resource tree, so it is refused instead.
    SpecialEntry(PathBuf),
    /// The packaged tree is nested deeper than [`MAX_DEPTH`].
    TooDeep(PathBuf),
    /// Something is at the working copy's path that is not a complete working
    /// copy. It may be the user's own directory, a restored backup, or a copy whose
    /// marker has been removed; Quipu does not know and will not guess, so it
    /// refuses rather than replacing it.
    Occupied { path: PathBuf, reason: String },
    /// Every candidate staging name beside the destination was taken. Reachable
    /// only if [`CLAIM_ATTEMPTS`] worth of orphans have accumulated there.
    NoStagingName(PathBuf),
    /// A path with no valid-Unicode spelling, which cannot be sent over IPC.
    Unrepresentable(PathBuf),
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl std::fmt::Display for PrepareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownExample(id) => write!(f, "no such example: {id}"),
            Self::InvalidCatalog { id, field, value } => {
                write!(f, "example {id}: invalid {field} in the catalog: {value}")
            }
            Self::NoResourceDir(message) => {
                write!(f, "cannot locate the packaged examples: {message}")
            }
            Self::MissingResource(path) => {
                write!(
                    f,
                    "{}: the packaged example is missing from this installation",
                    escaped(path)
                )
            }
            Self::SpecialEntry(path) => {
                write!(f, "{}: not a regular file or directory", escaped(path))
            }
            Self::TooDeep(path) => write!(f, "{}: nested too deeply", escaped(path)),
            Self::Occupied { path, reason } => write!(
                f,
                "{}: refusing to replace this directory, because {reason}. \
                 Move it or delete it, then open the example again.",
                escaped(path)
            ),
            Self::NoStagingName(path) => write!(
                f,
                "{}: cannot claim a private directory to copy the example into",
                escaped(path)
            ),
            Self::Unrepresentable(path) => {
                write!(f, "{}: path is not valid Unicode", escaped(path))
            }
            Self::Io { path, source } => write!(f, "{}: {source}", escaped(path)),
        }
    }
}

/// The whole catalog, for the chooser.
#[tauri::command]
pub fn list_examples() -> Vec<ExampleInfo> {
    EXAMPLES
        .iter()
        .map(|example| ExampleInfo {
            id: example.id.to_string(),
            name: example.name.to_string(),
            description: example.description.to_string(),
        })
        .collect()
}

/// Materializes the working copy of one catalog example and returns it, ready to
/// be opened as an ordinary project.
///
/// `id` is the only thing this takes from the frontend, and it is looked up
/// rather than used: both the source and the destination come from the catalog
/// entry.
#[tauri::command]
pub async fn prepare_example(id: String, app: tauri::AppHandle) -> Result<PreparedExample, String> {
    let resources = resource_root(&app).map_err(|e| e.to_string())?;
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("cannot locate the application data directory: {e}"))?;
    // Copying a directory tree is blocking work, and it happens while the user is
    // waiting to see the example, so it stays off the UI thread.
    tauri::async_runtime::spawn_blocking(move || prepare(&resources, &data, &id))
        .await
        .map_err(|e| format!("example task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Where this build's packaged examples are.
///
/// One lookup, because there is only one answer: `tauri-build` copies the
/// declared resources into the Cargo target directory, and Tauri's resource
/// directory *is* the target directory for a binary run from it, so a
/// development run and a bundled application resolve the same path. Unit tests
/// are the exception - a test binary lives in `target/<profile>/deps`, which is
/// not a resource directory - and they read the source tree directly instead of
/// going through here.
fn resource_root(app: &tauri::AppHandle) -> Result<PathBuf, PrepareError> {
    let root = app
        .path()
        .resolve(RESOURCE_DIR, BaseDirectory::Resource)
        .map_err(|e| PrepareError::NoResourceDir(e.to_string()))?;
    if !root.is_dir() {
        return Err(PrepareError::MissingResource(root));
    }
    Ok(root)
}

/// Prepares the working copy of the catalog example called `id`.
///
/// The roots are arguments rather than looked up, so the whole of this - the
/// lookup, the copy, the reuse, the recovery and the target - is exercised by
/// tests against temporary directories.
pub(crate) fn prepare(
    resource_root: &Path,
    data_root: &Path,
    id: &str,
) -> Result<PreparedExample, PrepareError> {
    let example = find(id).ok_or_else(|| PrepareError::UnknownExample(id.to_string()))?;
    let root = materialize(resource_root, data_root, example)?;
    // The working copy's target, never the packaged one: the user may edit it,
    // and a scan should see what the project they are looking at contains.
    let target = root.join(example.target);
    let bytes = std::fs::read(&target).map_err(|source| PrepareError::Io {
        path: target.clone(),
        source,
    })?;
    Ok(PreparedExample {
        id: example.id.to_string(),
        name: example.name.to_string(),
        description: example.description.to_string(),
        root: representable(&root)?,
        target: PreparedTarget {
            path: representable(&target)?,
            bytes,
        },
    })
}

/// The catalog entry with this id, if there is one.
pub(crate) fn find(id: &str) -> Option<&'static Example> {
    EXAMPLES.iter().find(|example| example.id == id)
}

/// The directory holding every revision of `example`'s working copy, and every
/// staging directory an attempt at one claims.
fn family(data_root: &Path, example: &Example) -> PathBuf {
    data_root.join(RESOURCE_DIR).join(example.id)
}

/// Where `example`'s working copy lives.
///
/// Every component is derived from the catalog: the id is validated to be a plain
/// name and the revision is a number, so no part of this can be steered by a
/// caller. The revision is a directory rather than a field inside one because
/// that is what makes an update non-destructive - the copy the user has been
/// editing keeps its own directory.
pub(crate) fn destination(data_root: &Path, example: &Example) -> PathBuf {
    family(data_root, example).join(format!("v{}", example.revision))
}

/// What is at a working copy's path.
enum Destination {
    /// Nothing is there, so a copy may be installed.
    Vacant,
    /// A complete working copy, to be used exactly as it stands.
    Complete,
    /// Something else, which Quipu will not replace. Carries the sentence fragment
    /// that says why, for the user who has to decide what to do about it.
    Occupied(String),
}

/// Classifies the destination, following no links and changing nothing.
fn inspect(dest: &Path) -> Result<Destination, PrepareError> {
    let found = match std::fs::symlink_metadata(dest) {
        Ok(found) => found,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Destination::Vacant);
        }
        Err(source) => {
            return Err(PrepareError::Io {
                path: dest.to_path_buf(),
                source,
            });
        }
    };
    // A file or a symlink where the working copy should be. Renaming onto it would
    // replace it, so it is refused like any other occupant.
    if !found.is_dir() {
        return Ok(Destination::Occupied("it is not a directory".to_string()));
    }
    let marker = dest.join(MARKER);
    match std::fs::symlink_metadata(&marker) {
        Ok(found) if found.is_file() => Ok(Destination::Complete),
        Ok(_) => Ok(Destination::Occupied(format!(
            "its {MARKER} marker is not a regular file"
        ))),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(Destination::Occupied(
            format!("it has no {MARKER} marker and so is not a working copy Quipu completed"),
        )),
        Err(source) => Err(PrepareError::Io {
            path: marker,
            source,
        }),
    }
}

/// A staging directory one attempt owns.
///
/// Created by claiming a name nobody else has, and removed again when this value is
/// dropped - unless it was installed, in which case it has become the working copy
/// and there is nothing left to remove. Nothing else is ever deleted: another
/// attempt's staging directory, and the orphan of one that died, look exactly like
/// this one from the outside.
struct Staging {
    path: PathBuf,
    installed: bool,
}

impl Staging {
    /// Claims an unused staging directory beside `example`'s destination.
    ///
    /// The name carries the process id and a counter, so two attempts in one
    /// process, or in two, propose different names. The claim itself is
    /// `create_dir`, which fails rather than joining in when the name is taken, so
    /// the proposal only has to be usually unique for the claim to be exclusive.
    ///
    /// A sibling of the destination, so the rename that installs it stays within one
    /// filesystem and is therefore a single step.
    fn claim(data_root: &Path, example: &Example) -> Result<Self, PrepareError> {
        static NEXT: AtomicU64 = AtomicU64::new(0);

        let parent = family(data_root, example);
        create_dir(&parent)?;
        for _ in 0..CLAIM_ATTEMPTS {
            let path = parent.join(format!(
                "v{}{STAGING_INFIX}{}-{}",
                example.revision,
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&path) {
                Ok(()) => {
                    return Ok(Self {
                        path,
                        installed: false,
                    });
                }
                Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(source) => return Err(PrepareError::Io { path, source }),
            }
        }
        Err(PrepareError::NoStagingName(parent))
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if self.installed {
            return;
        }
        // Best effort, and only ever this attempt's own directory. The caller is
        // already reporting whatever went wrong, and what is left if this fails is
        // inert: it is not a working copy, and no other attempt will touch it.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Ensures `example` has a complete working copy and returns its root.
fn materialize(
    resource_root: &Path,
    data_root: &Path,
    example: &Example,
) -> Result<PathBuf, PrepareError> {
    let source = source_dir(resource_root, example)?;
    let dest = destination(data_root, example);

    match inspect(&dest)? {
        // Complete, and therefore the user's. Their edits are the reason not to look
        // any closer than this: a copy that differs from the template is the normal
        // case, not damage to be repaired.
        Destination::Complete => return Ok(dest),
        Destination::Occupied(reason) => return Err(PrepareError::Occupied { path: dest, reason }),
        Destination::Vacant => {}
    }

    install(stage(&source, data_root, example)?, &dest)
}

/// Copies the template into a staging directory of this attempt's own, and marks it
/// complete.
///
/// Nothing outside that directory is touched, so an attempt that fails here - or is
/// killed here - can affect neither a working copy nor another attempt.
fn stage(source: &Path, data_root: &Path, example: &Example) -> Result<Staging, PrepareError> {
    let staging = Staging::claim(data_root, example)?;
    copy_tree(source, staging.path(), 0)?;
    // Last, so that the marker being there means the whole tree is there.
    write_file(
        &staging.path().join(MARKER),
        marker_text(example).as_bytes(),
    )?;
    Ok(staging)
}

/// Commits a staged copy to `dest`, or explains why it may not.
///
/// The atomic no-replace rename is the entire commit: either the finished tree
/// arrives under the name a reuse looks for, or something is already there and
/// nothing has been touched. Losing that race is not a failure when what won is a
/// complete working copy - it is the copy this attempt was making - but anything
/// else at the destination is left as it stands and reported, and the staging
/// directory this attempt owns goes either way.
///
/// The rename is [`crate::fs::rename_noreplace`], shared with the explorer's own
/// no-clobber commands: one implementation of "move this, but never over anything".
fn install(mut staged: Staging, dest: &Path) -> Result<PathBuf, PrepareError> {
    match crate::fs::rename_noreplace(staged.path(), dest) {
        Ok(()) => {
            staged.installed = true;
            Ok(dest.to_path_buf())
        }
        Err(source) => match inspect(dest)? {
            Destination::Complete => Ok(dest.to_path_buf()),
            Destination::Occupied(reason) => Err(PrepareError::Occupied {
                path: dest.to_path_buf(),
                reason,
            }),
            // Nothing is there to have lost the race to, so the rename failed on its
            // own account: a full disk, a permission, a filesystem boundary, or a
            // platform with no no-replace rename to offer.
            Destination::Vacant => Err(PrepareError::Io {
                path: dest.to_path_buf(),
                source,
            }),
        },
    }
}

/// The packaged directory for `example`, with the catalog's own paths checked
/// first.
///
/// Both paths are validated here, before anything is copied, so a catalog entry
/// whose target is unusable fails while the caller still holds the project it
/// was about to replace.
fn source_dir(resource_root: &Path, example: &Example) -> Result<PathBuf, PrepareError> {
    if !is_id_like(example.dir) {
        return Err(PrepareError::InvalidCatalog {
            id: example.id,
            field: "dir",
            value: example.dir,
        });
    }
    if !is_inside_relative(example.target) {
        return Err(PrepareError::InvalidCatalog {
            id: example.id,
            field: "target",
            value: example.target,
        });
    }
    let source = resource_root.join(example.dir);
    if !source.is_dir() {
        return Err(PrepareError::MissingResource(source));
    }
    Ok(source)
}

/// Copies a packaged directory tree.
///
/// Regular files and directories only. Entry types come from the directory entry
/// itself, which does not follow symlinks, so a link in the packaged tree is
/// reported rather than resolved: following one is how a copy rooted at the
/// resource directory could read or write outside it.
///
/// Entries are copied in name order. Nothing depends on it, but a deterministic
/// order makes a failure reproducible.
fn copy_tree(from: &Path, to: &Path, depth: usize) -> Result<(), PrepareError> {
    if depth > MAX_DEPTH {
        return Err(PrepareError::TooDeep(from.to_path_buf()));
    }
    create_dir(to)?;
    let mut entries = Vec::new();
    for entry in read_dir(from)? {
        entries.push(entry.map_err(|source| PrepareError::Io {
            path: from.to_path_buf(),
            source,
        })?);
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let kind = entry.file_type().map_err(|source| PrepareError::Io {
            path: path.clone(),
            source,
        })?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&path, &target, depth + 1)?;
        } else if kind.is_file() {
            std::fs::copy(&path, &target).map_err(|source| PrepareError::Io {
                path: path.clone(),
                source,
            })?;
        } else {
            return Err(PrepareError::SpecialEntry(path));
        }
    }
    Ok(())
}

/// What the marker file says, for whoever finds it in their data directory.
fn marker_text(example: &Example) -> String {
    format!(
        "Quipu working copy of the packaged example \"{}\", revision {}.\n\
         Quipu never overwrites this directory; it is yours to edit.\n\
         Delete the whole directory to start again from the packaged copy.\n\
         Deleting only this file does not: Quipu will then refuse to use the\n\
         directory, rather than replace it.\n",
        example.id, example.revision
    )
}

/// True for a name made only of lowercase ASCII letters, digits and hyphens.
///
/// Used for both the catalog id and the packaged directory name. It is what lets
/// either be joined onto a path without further thought: no separator, no drive
/// letter, and neither `.` nor `..` can be spelled with it.
pub(crate) fn is_id_like(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// True for a `/`-separated relative path that cannot leave the directory it is
/// resolved against.
pub(crate) fn is_inside_relative(value: &str) -> bool {
    if value.is_empty() || value.contains('\\') || value.starts_with('/') {
        return false;
    }
    // A `C:`-style prefix would make the catalog machine-specific and would
    // resolve outside the working copy on Windows.
    if value.as_bytes().get(1) == Some(&b':') {
        return false;
    }
    value
        .split('/')
        .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn representable(path: &Path) -> Result<String, PrepareError> {
    to_slash(path).ok_or_else(|| PrepareError::Unrepresentable(path.to_path_buf()))
}

// The `std::fs` calls, each wrapped once so the path that failed is in the
// message. Errors from these are reported to the user, who has no other way of
// knowing which file the application could not get at.

fn create_dir(path: &Path) -> Result<(), PrepareError> {
    std::fs::create_dir_all(path).map_err(|source| PrepareError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn read_dir(path: &Path) -> Result<std::fs::ReadDir, PrepareError> {
    std::fs::read_dir(path).map_err(|source| PrepareError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), PrepareError> {
    std::fs::write(path, bytes).map_err(|source| PrepareError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests;
