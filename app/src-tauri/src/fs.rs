//! Filesystem commands for the rules project explorer, and the no-clobber
//! primitives Quipu's own writes are built on.
//!
//! Paths come from the native directory/file dialogs (user-selected), so we
//! read/write directly here rather than going through the fs plugin and its
//! scoped-permission surface. Scope: the rules project tree only.
//!
//! # Refusing to clobber is part of the operation, not a check before it
//!
//! "Does it exist? then write it" is two operations, and anything at all may create
//! the path in between: another Quipu window, the editor the user also has open,
//! their shell, or a second command of this window's own. The window is short and
//! what it costs is somebody's file emptied or replaced, so the refusal is delegated
//! to the kernel. [`create_new`] and [`rename_noreplace`] fail *because* something
//! is already there, at the instant they act, and there is no moment in between at
//! which the answer could have changed.
//!
//! What keeps two of Quipu's own writes from interleaving on one path is ordering
//! rather than refusal - app-owned mutations are serialized per watcher subscription
//! in the order the user asked for them (see `app/src/mutations.ts`), so the last
//! gesture is the last write.
//!
//! # A save is conditional on the version it was authorised against
//!
//! Overwriting is what Save means, but overwriting *what* is not the caller's to
//! assume. The frontend reads the file before it writes and asks the user about
//! anything it did not expect (see `checkWritable` in `app/src/main.ts`), and that
//! read is an observation with a lifetime: between it and the write there is an
//! interval in which anything may replace the file, and a write issued against the
//! older observation would destroy a version nobody ever saw.
//!
//! So the expected version travels with the write. [`save_text_file`] is told what
//! the caller believes is on disk - the text, or nothing at all for a file it expects
//! to be absent - and commits only against that:
//!
//! * expected absent: [`create_new`], so the kernel refuses if anything is there;
//! * expected present: the new text is written beside the file and swapped in with an
//!   atomic exchange, which hands back the version it displaced. If that turns out
//!   not to be the expected version, it goes straight back and the save is refused.
//!
//! The exchange is what makes this more than looking first. A comparison followed by
//! a write, however close together, cannot say what was there at the instant of the
//! write; an exchange takes the old version away in the same operation that installs
//! the new one, so a competing version is always still in hand to be put back.
//!
//! Committing by rename has consequences worth knowing, all of them the price of that
//! guarantee: the file gets a new inode, so hard links to it stop following the save
//! and its owner becomes whoever is running Quipu; permissions are copied onto the
//! replacement and extended attributes are not; and for the moment between the
//! exchange and the restore, a refused save's text is what a reader would find.
//!
//! # Putting a version back is conditional too
//!
//! That last moment is an interval like any other, and the restore that ends it has
//! exactly the problem the save had: something may write the file again in there, and a
//! plain rename back would destroy that version to make room for one nobody asked to
//! see. So the restore is an exchange as well, and what it hands back is what decides.
//! If it is the replacement this save installed, nothing else wrote and the displaced
//! version is home. If it is anything else, a competing version has been taken out of
//! the way rather than overwritten: it goes back with a second exchange, the displaced
//! version stays in the file beside it, and the error says where. A version Quipu did
//! not write is not Quipu's to delete either.
//!
//! Which is what removing the file a save committed through is conditional on, and the
//! two sides of the save answer that differently because they are authorised
//! differently. A save that **commits** has just replaced exactly the bytes it was told
//! to replace, compared at the instant of the swap, so the file it swapped through may
//! go: the inode that goes with it is the one the save was authorised to replace, which
//! is the renaming consequence stated above rather than a second one. A save that
//! **refuses** has no such authorisation, so what it removes has to be *shown* to be its
//! own - and holding the right bytes does not show that. The save still has the file it
//! wrote its replacement into open, so the proof is that the temporary's name still
//! resolves to that same file - device and inode, against the open handle - *and* that
//! reading it back through that handle yields the replacement. A third party's atomic
//! replacement carrying exactly the replacement's bytes fails the first half; a write
//! into Quipu's own file, which the exchange has just left at the path where anything at
//! all may write to it, fails the second. Anything not proven is somebody else's: it
//! stays on disk and is named in the error, however untidy that is.
//!
//! Writers that go for Quipu's private temporary names are out of scope. The names are
//! hidden, carry this process's id and a counter it never uses twice, and something
//! choosing them is not racing the save but impersonating it. What that costs is stated
//! rather than guarded: a file created at the temporary's name after the proof has been
//! made is removed, there being no operation that unlinks a particular inode; and a
//! version written into the temporary before the first exchange is committed to the path
//! and reported as saved, which is the same impersonation seen from the other end.
//!
//! Where the platform or the filesystem has no exchange there is no conditional
//! replacement to fall back on, so a save over an existing version cannot be committed
//! at all and fails saying so. A comparison followed by a rename is precisely the
//! unconditional clobber all of this exists to avoid, and being unable to save is a
//! disappointment where overwriting a version nobody has seen is not recoverable.
//! Recreating a file the caller expects to be absent needs no exchange and is
//! unaffected: [`create_new`] carries its own refusal.

use std::io::{ErrorKind, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

use crate::project::escaped;

#[cfg(test)]
mod tests;

/// Reads a rule file's UTF-8 text.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// What a conditional save did. Neither outcome is a failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Saved {
    /// The text is on disk because this wrote it.
    Written,
    /// Nothing was written: the file does not hold the version this save was
    /// authorised against, and whatever it does hold is still there.
    Refused,
}

/// Writes UTF-8 text to a rule file, over `expect` and nothing else.
///
/// `expect` is what the caller last read there, or `None` for a file it expects not to
/// exist at all - a document whose file has been deleted, which Save recreates.
#[tauri::command]
pub fn save_text_file(
    path: String,
    contents: String,
    expect: Option<String>,
) -> Result<Saved, String> {
    save_if_unchanged(Path::new(&path), &contents, expect.as_deref())
        .map_err(|e| format!("{path}: {e}"))
}

/// Creates a new empty file, refusing to touch anything already at `path`.
#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    create_new(Path::new(&path)).map_err(|e| about(&path, &e))
}

/// Renames a file within the project, refusing to replace the destination.
#[tauri::command]
pub fn rename_file(from: String, to: String) -> Result<(), String> {
    rename_noreplace(Path::new(&from), Path::new(&to)).map_err(|e| {
        if e.kind() == ErrorKind::AlreadyExists {
            about(&to, &e)
        } else {
            format!("{from} -> {to}: {e}")
        }
    })
}

/// Commits `contents` to `path` if - and only if - `path` still holds `expect`.
///
/// The comparison is made twice, and the second one is the one that counts: once here,
/// which refuses cheaply and without ever putting the new text where a reader could
/// see it, and once inside [`install`], against the version the commit itself
/// displaced. Only the second can speak for the instant of the write.
pub(crate) fn save_if_unchanged(
    path: &Path,
    contents: &str,
    expect: Option<&str>,
) -> std::io::Result<Saved> {
    commit(
        path,
        contents,
        expect,
        &Seams {
            compared: &|| {},
            exchanged: &|| {},
            exchange: &exchange,
        },
    )
}

/// Where a test gets inside a save that is in flight.
///
/// Production runs with two closures that do nothing and the platform's own exchange.
/// The seams are here because everything the comparisons and the restore guarantee is
/// about what happens when something else writes *in between*, and a test that cannot
/// write in between cannot tell a commit that decides from a comparison that merely
/// looks.
struct Seams<'a> {
    /// Runs after the comparison, before the commit.
    compared: &'a dyn Fn(),
    /// Runs after the exchange has installed the replacement, before the version it
    /// displaced is examined and put back.
    exchanged: &'a dyn Fn(),
    /// The exchange itself, so a test can be given a filesystem that has none - or one
    /// that stops having one halfway through a save.
    exchange: &'a dyn Fn(&Path, &Path) -> std::io::Result<()>,
}

/// [`save_if_unchanged`], with the [`Seams`] a test writes through.
fn commit(
    path: &Path,
    contents: &str,
    expect: Option<&str>,
    seams: &Seams<'_>,
) -> std::io::Result<Saved> {
    // Through a symlink rather than over it: a rule file reached by a link is the file
    // the user is editing, and committing by rename would otherwise replace the link
    // and point the project somewhere else. A path with nothing at it stands for
    // itself, which is the case `expect: None` is for.
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let found = read_optional(&path)?;
    (seams.compared)();
    match (expect, found) {
        // Nothing was expected to be there, and the kernel decides whether anything
        // is: a file that appears between the read above and the creation below makes
        // this refuse instead of truncating it.
        (None, None) => match std::fs::File::create_new(&path) {
            Ok(mut file) => {
                file.write_all(contents.as_bytes())?;
                Ok(Saved::Written)
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => Ok(Saved::Refused),
            Err(err) => Err(err),
        },
        // A file where none was expected, or none where one was: what the caller was
        // authorised to replace is not what is there, and nothing is written.
        (None, Some(_)) | (Some(_), None) => Ok(Saved::Refused),
        (Some(want), Some(found)) if found != want.as_bytes() => Ok(Saved::Refused),
        (Some(want), Some(_)) => exchange_in(&path, contents, want.as_bytes(), seams),
    }
}

/// Installs `contents` over a file believed to hold `want`, and leaves nothing of
/// Quipu's own beside it either way.
fn exchange_in(
    path: &Path,
    contents: &str,
    want: &[u8],
    seams: &Seams<'_>,
) -> std::io::Result<Saved> {
    let (temp, mut file) = temp_beside(path)?;
    let (outcome, leftover) = install(&temp, &mut file, path, contents, want, seams);
    drop(file);
    // Only a file this save can account for is removed, and [`install`] is where that
    // account is kept. A refused save can end up holding a version somebody else wrote -
    // taken out of the way of the restore rather than overwritten - and deleting that
    // would be the clobber the exchange exists to avoid. Removing a path that has
    // already gone is not a failure worth reporting.
    if let Leftover::Ours = leftover {
        let _ = std::fs::remove_file(&temp);
    }
    outcome
}

/// Whose version the file a save committed through is left holding.
enum Leftover {
    /// Text this save wrote, or the very version it was authorised to replace. Shown
    /// rather than assumed: either the file has never been anywhere but beside `path`, or
    /// what is in it is the version the save was told to replace, or it has been proven -
    /// by identity as well as by contents - to be the file this save wrote through.
    Ours,
    /// A version this save neither wrote nor was authorised to replace, left there
    /// because putting it back would have overwritten a newer one. Not Quipu's to
    /// delete; the error says where it is.
    Theirs,
}

/// Writes the new version into `temp` and swaps it in, refusing if what the swap
/// displaced was not `want` after all - and saying whose version the file it swapped
/// through is left holding.
///
/// `file` stays open throughout, past the write it is here for: it is what a refused
/// save's restore proves the temporary against, and a name cannot stand in for it.
fn install(
    temp: &Path,
    file: &mut std::fs::File,
    path: &Path,
    contents: &str,
    want: &[u8],
    seams: &Seams<'_>,
) -> (std::io::Result<Saved>, Leftover) {
    if let Err(err) = file.write_all(contents.as_bytes()) {
        return (Err(err), Leftover::Ours);
    }
    // The mode of the file being replaced, so saving does not quietly make a rule file
    // world-readable or drop a bit somebody set on it. Ownership cannot be carried
    // across without privilege; see the module documentation.
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(temp, meta.permissions());
    }
    match (seams.exchange)(temp, path) {
        Ok(()) => {
            (seams.exchanged)();
            // `temp` now holds whatever was at `path` at the instant of the swap. That
            // is the one account of it nothing could have raced - and the only reason
            // this is an exchange and not a rename.
            match std::fs::read(temp) {
                // The version the caller was authorised to replace. Replacing it is
                // what Save means, so the file holding it may go.
                Ok(displaced) if displaced == want => (Ok(Saved::Written), Leftover::Ours),
                // Something wrote in the interval this exists to close. Their version
                // goes back, and the save is refused rather than reported as having
                // replaced a version the user never saw.
                Ok(_) => match restore(temp, path, file, contents.as_bytes(), seams.exchange) {
                    Restored::Put => (Ok(Saved::Refused), Leftover::Ours),
                    Restored::Kept(kept) => (Err(std::io::Error::other(kept)), Leftover::Theirs),
                },
                // The swap happened, but what it displaced cannot be read, so this
                // cannot say whether it replaced the right version. An unverifiable save
                // is not a save: put it back and report.
                Err(err) => match restore(temp, path, file, contents.as_bytes(), seams.exchange) {
                    Restored::Put => (Err(err), Leftover::Ours),
                    Restored::Kept(kept) => (
                        Err(std::io::Error::other(format!("{err}; {kept}"))),
                        Leftover::Theirs,
                    ),
                },
            }
        }
        // The file went away between the comparison and the swap.
        Err(err) if err.kind() == ErrorKind::NotFound => (Ok(Saved::Refused), Leftover::Ours),
        // No exchange to be had - another platform, or a filesystem that does not
        // implement one - and so no conditional way to replace the version on disk. A
        // comparison followed by a rename is the unconditional clobber this exists to
        // avoid, so the save fails instead. See the module documentation.
        Err(err) if unsupported(&err) => (
            Err(std::io::Error::new(
                ErrorKind::Unsupported,
                format!(
                    "this filesystem has no atomic exchange, so saving cannot be made \
                     conditional on the version on disk ({err})"
                ),
            )),
            Leftover::Ours,
        ),
        Err(err) => (Err(err), Leftover::Ours),
    }
}

/// What became of the version a refused save displaced.
enum Restored {
    /// It is back at `path`, and nothing that is not this save's own is left in `temp`.
    Put,
    /// It could not be put back without overwriting a version that appeared in the
    /// meantime. Nothing was destroyed; the message says what was left where.
    Kept(String),
}

/// Puts the version the exchange displaced back at `path`, without overwriting or
/// unlinking a version this save did not write.
///
/// The restore has the interval the save had, so it is an exchange too and what it hands
/// back is what decides. `file` - still open on the file this save wrote its replacement
/// into - and `ours` - the replacement itself - are together the proof that nothing else
/// wrote: getting that same file back, still holding that text, means the displaced
/// version is home and `temp` holds only this save's own. Getting anything else means a
/// competing version was taken out of the way rather than destroyed, so it goes back the
/// same way and the displaced version stays in `temp`, which is then not Quipu's to
/// remove.
///
/// Both halves are needed and neither will do alone; see the module documentation. An
/// error where either proof should be is a failed proof, which costs a file left on disk
/// where mistaking one for Quipu's own costs a version nobody can get back.
fn restore(
    temp: &Path,
    path: &Path,
    file: &std::fs::File,
    ours: &[u8],
    exchange: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Restored {
    match exchange(temp, path) {
        Ok(()) => {
            if is_ours(temp, file, ours) {
                return Restored::Put;
            }
            // In hand rather than overwritten, which is what one more exchange is for:
            // it cannot destroy anything either, whatever has happened at `path` since.
            match exchange(temp, path) {
                Ok(()) => Restored::Kept(format!(
                    "something else wrote this file while it was being saved; that \
                     version is the one here now, and the one it replaced was kept at {}",
                    escaped(temp)
                )),
                Err(err) => Restored::Kept(format!(
                    "something else wrote this file while it was being saved; this file \
                     holds the version from before that write and theirs was kept at {} \
                     ({err})",
                    escaped(temp)
                )),
            }
        }
        // Nothing at `path` to exchange with any more. A no-replace rename is
        // conditional in exactly the way this needs: the displaced version goes back if
        // the path is still empty, and stays put if anything has taken it.
        Err(err) if err.kind() == ErrorKind::NotFound => match rename_noreplace(temp, path) {
            Ok(()) => Restored::Put,
            Err(err) => Restored::Kept(format!(
                "the version from before this save could not be put back and was kept at \
                 {} ({err})",
                escaped(temp)
            )),
        },
        Err(err) => Restored::Kept(format!(
            "this file holds the text just saved, which is not what was asked for: the \
             version it replaced could not be put back and was kept at {} ({err})",
            escaped(temp)
        )),
    }
}

/// Whether `temp` still names the file this save wrote its replacement into, and that
/// file still holds the replacement.
///
/// Two halves, because either one alone lets through exactly what the other catches.
/// Comparing only what is at the name against `ours` calls a third party's atomic
/// replacement carrying those same bytes Quipu's file, and unlinks it. Comparing only
/// identity calls Quipu's own file its own after somebody has written into it - which the
/// exchange has just made possible by putting it at `path`, where anything may - and
/// unlinks their version with it.
fn is_ours(temp: &Path, file: &std::fs::File, ours: &[u8]) -> bool {
    same_file(temp, file) && holds(file, ours)
}

/// Whether `temp` names the very file `file` is open on.
#[cfg(unix)]
fn same_file(temp: &Path, file: &std::fs::File) -> bool {
    use std::os::unix::fs::MetadataExt;

    // `symlink_metadata`, so a symlink planted at the name fails the proof rather than
    // answering for whatever it happens to point at.
    match (std::fs::symlink_metadata(temp), file.metadata()) {
        (Ok(named), Ok(open)) => named.dev() == open.dev() && named.ino() == open.ino(),
        _ => false,
    }
}

/// A platform with no stable file identity to compare has no atomic exchange either, so
/// nothing gets this far: the save is refused before anything is written and there is no
/// temporary to account for.
#[cfg(not(unix))]
fn same_file(_temp: &Path, _file: &std::fs::File) -> bool {
    false
}

/// Whether the file this save wrote still holds what it wrote.
///
/// Read back through the handle rather than through the name, which has been through two
/// renames since and is not what is being asked about.
fn holds(file: &std::fs::File, ours: &[u8]) -> bool {
    let mut handle = file;
    let mut back = Vec::with_capacity(ours.len());
    handle.rewind().is_ok() && handle.read_to_end(&mut back).is_ok() && back == ours
}

/// What is at `path`, or `None` if nothing is.
///
/// Bytes rather than text: a file the editor could not have read is not a version this
/// save was authorised against, and comparing bytes says so without having to decide
/// what invalid UTF-8 would have meant.
fn read_optional(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// Counts the replacement files this process has made, so that two saves - of one
/// file, or of two - never pick the same name.
static TEMPS: AtomicU64 = AtomicU64::new(0);

/// How many names to try before giving up. A name this process invented for a counter
/// value it will never use again can only be taken by something choosing names the
/// same way, and one more try is enough for that to be somebody else's problem.
const TEMP_NAMES: u32 = 8;

/// Creates the file the next version of `path` is written into, beside `path` itself.
///
/// Beside it because the swap that commits it is a rename, which cannot cross
/// filesystems. Hidden, and named as a temporary, so that a crash between creating it
/// and committing it leaves something recognisable rather than a file the project would
/// compile: nothing in the project model counts a `.tmp` as a rule file, and the
/// watcher's plan does not find one relevant.
fn temp_beside(path: &Path) -> std::io::Result<(PathBuf, std::fs::File)> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().unwrap_or(std::ffi::OsStr::new("save"));
    for _ in 0..TEMP_NAMES {
        let mut candidate = std::ffi::OsString::from(".");
        candidate.push(name);
        candidate.push(format!(
            ".quipu{}-{}.tmp",
            std::process::id(),
            TEMPS.fetch_add(1, Ordering::Relaxed)
        ));
        let temp = dir.join(candidate);
        match std::fs::File::create_new(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        "no free name for the file to save through",
    ))
}

/// Whether an exchange failed because there is no exchange to be had, rather than
/// because this one could not be done.
fn unsupported(err: &std::io::Error) -> bool {
    matches!(err.kind(), ErrorKind::Unsupported | ErrorKind::InvalidInput)
}

/// Swaps `from` and `to` in one operation, so that the version being replaced is
/// handed back rather than destroyed and nothing ever sees either path missing.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn exchange(from: &Path, to: &Path) -> std::io::Result<()> {
    // `RENAME_EXCHANGE` on Linux, `RENAME_SWAP` on macOS. A kernel or filesystem
    // without it reports an error like any other, and [`install`] classifies that.
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        from,
        rustix::fs::CWD,
        to,
        rustix::fs::RenameFlags::EXCHANGE,
    )
    .map_err(std::io::Error::from)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn exchange(_from: &Path, _to: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        ErrorKind::Unsupported,
        "this platform has no atomic exchange",
    ))
}

/// Creates `path` as an empty file, failing if anything is already there.
///
/// One operation: the creation carries the refusal with it, so nothing that appears
/// while it runs can be truncated by it.
pub(crate) fn create_new(path: &Path) -> std::io::Result<()> {
    std::fs::File::create_new(path).map(|_| ())
}

/// Renames `from` to `to`, failing rather than replacing anything already there.
///
/// The refusal has to be part of the rename itself. An ordinary rename replaces an
/// existing file, and an existing empty directory, on Unix; no amount of looking
/// first closes that window, because something can appear between the look and the
/// rename.
///
/// Where the platform offers no such operation there is no safe substitute, so the
/// answer is that the rename cannot be done. Being unable to rename a file is a
/// disappointment; overwriting one somebody else just wrote is not recoverable.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    // `RENAME_NOREPLACE` on Linux, `RENAME_EXCL` on macOS. A kernel or filesystem
    // that does not implement it reports an error like any other, and callers
    // classify that by looking at the destination - never by trying again without it.
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        from,
        rustix::fs::CWD,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(std::io::Error::from)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn rename_noreplace(_from: &Path, _to: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        ErrorKind::Unsupported,
        "this platform has no atomic no-replace rename",
    ))
}

/// What to show the user for an operation that refused to touch `path`.
///
/// The kernel's own words for a destination that exists are about file descriptors
/// ("File exists"); the path and what was refused are what the user needs.
fn about(path: &str, err: &std::io::Error) -> String {
    if err.kind() == ErrorKind::AlreadyExists {
        format!("{path}: already exists")
    } else {
        format!("{path}: {err}")
    }
}
