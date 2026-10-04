//! Tests for the explorer's filesystem commands, and for the one property that
//! cannot be added on top of them: they refuse to clobber *as they act*.
//!
//! For `create_file` and `rename_file` a race between the refusal and the act cannot
//! be provoked from a test - that is the nature of the window they close - so what is
//! asserted is the outcome a lost race used to produce and now cannot: an existing file
//! is never emptied, an existing destination is never replaced, and both sides are left
//! exactly as they were.
//!
//! Saving *can* have that race provoked, because it has seams for it (`super::Seams`:
//! one closure between the comparison and the commit, one between the commit and the
//! restore that may have to undo it, and the exchange itself). Those tests are the ones
//! that distinguish a save which decides at the instant it writes from one that merely
//! looked first, and a restore that puts a version back from one that overwrites
//! whatever it finds: the competing version is written after the comparison, or after
//! the exchange, has already passed.
//!
//! Both intervals, and each thing an outsider can do in either, are enumerated in
//! `docs/workspace-project-model.md`; the rows there are driven one at a time.

#[cfg(not(windows))]
use std::cell::Cell;
#[cfg(not(windows))]
use std::io::ErrorKind;
use std::path::Path;

use crate::testing::Fixture;

use super::Saved;
#[cfg(not(windows))]
use super::Seams;

fn text(path: &Path) -> String {
    std::fs::read_to_string(path).expect("read the file back")
}

fn name(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A save through the command, expecting `expect` on disk.
fn save(path: &Path, contents: &str, expect: Option<&str>) -> Saved {
    super::save_text_file(name(path), contents.to_string(), expect.map(str::to_string))
        .expect("the save ran")
}

/// A save with `compared` run between the comparison and the commit, and `exchanged`
/// between the commit and the restore. The real exchange, so what a competing writer
/// finds is a real one.
#[cfg(not(windows))]
fn racing(
    path: &Path,
    contents: &str,
    expect: Option<&str>,
    compared: &dyn Fn(),
    exchanged: &dyn Fn(),
) -> std::io::Result<Saved> {
    super::commit(
        path,
        contents,
        expect,
        &Seams {
            compared,
            exchanged,
            exchange: &super::exchange,
        },
    )
}

/// A competing save of the same shape as Quipu's own - written beside the file and
/// committed over it - so that the version which ends up at a path can be told apart
/// from a copy of its bytes.
#[cfg(not(windows))]
fn write_over(path: &Path, contents: &str) {
    let mut beside = path.as_os_str().to_owned();
    beside.push(".theirs");
    let beside = Path::new(&beside);
    std::fs::write(beside, contents).expect("a competing write");
    std::fs::rename(beside, path).expect("committed over the file");
}

#[cfg(unix)]
fn ino(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;

    std::fs::metadata(path).expect("metadata").ino()
}

/// What a directory holds, sorted. A save commits by rename, so "nothing left beside
/// the file" is part of what it has to do.
fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("read the directory")
        .map(|entry| {
            entry
                .expect("a directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

/// The files a save committed through and did not remove, by name.
#[cfg(not(windows))]
fn leftovers(dir: &Path) -> Vec<String> {
    entries(dir)
        .into_iter()
        .filter(|name| name.ends_with(".tmp"))
        .collect()
}

#[test]
fn creating_a_file_makes_it_empty() {
    let fixture = Fixture::new();
    let path = fixture.root.join("new.yar");

    super::create_file(name(&path)).expect("created");

    assert_eq!(text(&path), "");
}

#[test]
fn creating_a_file_that_exists_refuses_rather_than_emptying_it() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "rule main { condition: filesize > 0 }\n");
    let path = fixture.root.join("main.yar");

    let err = super::create_file(name(&path)).expect_err("refused");

    assert!(err.contains("already exists"), "{err}");
    assert!(err.contains("main.yar"), "{err}");
    // The whole point: the file the user already had is untouched. An exists-check
    // followed by a write can empty a file created in between; a create that carries
    // its own refusal cannot.
    assert!(text(&path).contains("rule main"), "{}", text(&path));
}

#[test]
fn creating_a_file_over_a_directory_refuses() {
    let fixture = Fixture::new();
    let path = fixture.root.join("nested");
    std::fs::create_dir(&path).expect("a directory in the way");

    let err = super::create_file(name(&path)).expect_err("refused");

    assert!(err.contains("already exists"), "{err}");
    assert!(path.is_dir(), "the directory is still a directory");
}

#[test]
fn creating_a_file_where_there_is_no_directory_reports_the_path() {
    let fixture = Fixture::new();
    let path = fixture.root.join("not/created/yet/new.yar");

    let err = super::create_file(name(&path)).expect_err("no such directory");

    assert!(err.contains("new.yar"), "{err}");
    // Not the no-clobber refusal: an error that is not "something is there" says what
    // the operating system said.
    assert!(!err.contains("already exists"), "{err}");
}

#[test]
fn renaming_moves_the_file() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "rule main { condition: filesize > 0 }\n");
    let from = fixture.root.join("main.yar");
    let to = fixture.root.join("renamed.yar");

    super::rename_file(name(&from), name(&to)).expect("renamed");

    assert!(!from.exists(), "the old path is gone");
    assert!(text(&to).contains("rule main"), "{}", text(&to));
}

#[test]
fn renaming_onto_an_existing_file_refuses_and_leaves_both() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "mine\n");
    fixture.write("theirs.yar", "theirs\n");
    let from = fixture.root.join("main.yar");
    let to = fixture.root.join("theirs.yar");

    let err = super::rename_file(name(&from), name(&to)).expect_err("refused");

    assert!(err.contains("already exists"), "{err}");
    assert!(err.contains("theirs.yar"), "{err}");
    // An ordinary rename replaces the destination without a word. Nothing here does:
    // both files are exactly as they were, so nobody's work has been thrown away.
    assert_eq!(text(&from), "mine\n");
    assert_eq!(text(&to), "theirs\n");
}

#[test]
fn renaming_onto_an_existing_directory_refuses() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "mine\n");
    let from = fixture.root.join("main.yar");
    let to = fixture.root.join("nested");
    std::fs::create_dir(&to).expect("a directory in the way");

    let err = super::rename_file(name(&from), name(&to)).expect_err("refused");

    assert!(err.contains("already exists"), "{err}");
    assert!(to.is_dir(), "the directory is still a directory");
    assert_eq!(text(&from), "mine\n");
}

#[test]
fn renaming_something_that_is_not_there_names_both_ends() {
    let fixture = Fixture::new();
    let from = fixture.root.join("gone.yar");
    let to = fixture.root.join("renamed.yar");

    let err = super::rename_file(name(&from), name(&to)).expect_err("no such file");

    assert!(err.contains("gone.yar"), "{err}");
    assert!(err.contains("renamed.yar"), "{err}");
    assert!(!err.contains("already exists"), "{err}");
    assert!(!to.exists(), "and nothing was created");
}

#[test]
fn saving_replaces_the_version_it_was_told_to_expect() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");

    assert_eq!(save(&path, "after\n", Some("before\n")), Saved::Written);

    // Overwriting is what Save means - the version it was authorised against is gone,
    // and deliberately so.
    assert_eq!(text(&path), "after\n");
    assert_eq!(
        super::read_text_file(name(&path)).expect("read back"),
        "after\n"
    );
    // Committing by rename must not leave the file it committed through behind.
    assert_eq!(entries(&fixture.root), vec!["main.yar".to_string()]);
}

#[test]
fn saving_refuses_a_version_it_was_not_told_to_expect() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "theirs\n");
    let path = fixture.root.join("main.yar");

    assert_eq!(save(&path, "mine\n", Some("what I read\n")), Saved::Refused);

    // Not a failure and not a write: the caller is told nothing happened, and the
    // version it did not know about is exactly as it was.
    assert_eq!(text(&path), "theirs\n");
    assert_eq!(entries(&fixture.root), vec!["main.yar".to_string()]);
}

#[test]
fn saving_recreates_a_file_that_was_expected_to_be_gone() {
    let fixture = Fixture::new();
    let path = fixture.root.join("deleted.yar");

    assert_eq!(save(&path, "back again\n", None), Saved::Written);

    assert_eq!(text(&path), "back again\n");
}

#[test]
fn saving_refuses_to_recreate_a_file_that_is_there_after_all() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "theirs\n");
    let path = fixture.root.join("main.yar");

    assert_eq!(save(&path, "mine\n", None), Saved::Refused);

    assert_eq!(text(&path), "theirs\n");
}

#[test]
fn saving_refuses_when_the_file_it_expected_has_gone() {
    let fixture = Fixture::new();
    let path = fixture.root.join("main.yar");

    assert_eq!(save(&path, "mine\n", Some("before\n")), Saved::Refused);

    // Nothing was created either: a save authorised against a version of a file is not
    // authorised to bring the file back.
    assert!(!path.exists(), "and nothing was created");
    assert!(entries(&fixture.root).is_empty(), "nor left beside it");
}

#[test]
#[cfg(not(windows))]
fn saving_preserves_a_version_written_after_the_comparison() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");

    // The interval this is all for: the comparison has already found what the save
    // expected, and *then* somebody else replaces the file.
    let outcome = racing(
        &path,
        "mine\n",
        Some("before\n"),
        &|| {
            std::fs::write(&path, "theirs\n").expect("a competing write");
        },
        &|| {},
    )
    .expect("the save ran");

    // The commit, not the comparison, is what decides. A save that wrote here would
    // have destroyed a version nobody had ever seen.
    assert_eq!(outcome, Saved::Refused);
    assert_eq!(text(&path), "theirs\n");
    assert_eq!(entries(&fixture.root), vec!["main.yar".to_string()]);
}

#[cfg(unix)]
#[test]
fn refusing_a_save_puts_the_competing_file_back_rather_than_a_copy_of_it() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");
    let theirs = Cell::new(0);

    let outcome = racing(
        &path,
        "mine\n",
        Some("before\n"),
        &|| {
            write_over(&path, "theirs\n");
            theirs.set(ino(&path));
        },
        &|| {},
    )
    .expect("the save ran");

    assert_eq!(outcome, Saved::Refused);
    // Their file, not their contents copied into one of ours: a descriptor somebody else
    // is holding open still refers to the file at this path.
    assert_eq!(text(&path), "theirs\n");
    assert_eq!(ino(&path), theirs.get());
    assert_eq!(entries(&fixture.root), vec!["main.yar".to_string()]);
}

#[test]
#[cfg(not(windows))]
fn saving_refuses_a_file_created_after_the_comparison() {
    let fixture = Fixture::new();
    let path = fixture.root.join("deleted.yar");

    // The same interval, for the file the save expected to be absent: it was, and then
    // it was not.
    let outcome = racing(
        &path,
        "mine\n",
        None,
        &|| {
            std::fs::write(&path, "theirs\n").expect("a competing write");
        },
        &|| {},
    )
    .expect("the save ran");

    assert_eq!(outcome, Saved::Refused);
    assert_eq!(text(&path), "theirs\n");
}

#[cfg(unix)]
#[test]
fn saving_replaces_a_version_installed_after_the_comparison_that_holds_what_it_expected() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");
    let theirs = Cell::new(0);

    let outcome = racing(
        &path,
        "mine\n",
        Some("before\n"),
        // Somebody else's file, holding exactly the version this save was authorised to
        // replace.
        &|| {
            write_over(&path, "before\n");
            theirs.set(ino(&path));
        },
        &|| {},
    )
    .expect("the save ran");

    // Replacing those bytes is what the save was told to do and what it has done, so it
    // commits. The inode that was holding them goes with the commit - the consequence
    // every committed save has for hard links, and the reason the licence to remove the
    // file it swapped through is about the bytes and deliberately not the identity.
    assert_eq!(outcome, Saved::Written);
    assert_eq!(text(&path), "mine\n");
    assert_ne!(ino(&path), theirs.get());
    assert_eq!(entries(&fixture.root), vec!["main.yar".to_string()]);
}

#[test]
#[cfg(not(windows))]
fn saving_refuses_when_the_file_is_deleted_after_the_comparison() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");

    let outcome = racing(
        &path,
        "mine\n",
        Some("before\n"),
        &|| std::fs::remove_file(&path).expect("a competing deletion"),
        &|| {},
    )
    .expect("the save ran");

    // There is nothing to exchange with, and a save authorised against a version on disk
    // is not authorised to put the file back: the deletion stands and the document stays
    // unsaved until the user is asked.
    assert_eq!(outcome, Saved::Refused);
    assert!(!path.exists(), "the deletion stands");
    // Nothing was ever exchanged through the file this save wrote into, so it can hold
    // nothing but this save's own text and needs no proof to go.
    let left = entries(&fixture.root);
    assert!(left.is_empty(), "{left:?}");
}

// ---- Undoing a refused save without clobbering ----
//
// A refused save has already committed by the time it knows it is refused: that is what
// makes the comparison answer for the instant of the write. So it has to put the version
// it displaced back, and the interval it does that in is as open as the one it was
// closing. A rename back would destroy whatever appeared in there.

#[cfg(unix)]
#[test]
fn a_version_written_before_the_restore_is_kept_and_the_displaced_one_preserved() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");
    let theirs = Cell::new(0);

    let err = racing(
        &path,
        "mine\n",
        Some("before\n"),
        // B, which the save is not authorised to replace, so it will be refused.
        &|| write_over(&path, "b\n"),
        // C, in the interval between the commit and the restore that undoes it.
        &|| {
            write_over(&path, "c\n");
            theirs.set(ino(&path));
        },
    )
    .expect_err("a save that cannot be undone without destroying C reports it");

    // C is exactly as it was: the same bytes, and the same file rather than a copy of
    // it. A rename back would have replaced it with a version nobody ever saw.
    assert_eq!(text(&path), "c\n");
    assert_eq!(ino(&path), theirs.get());
    // And B was not destroyed to make room for C. It is beside the file, and the error
    // says which file it is - the only recovery there is once two versions exist and
    // only one path.
    let kept = leftovers(&fixture.root);
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(text(&fixture.root.join(&kept[0])), "b\n");
    assert!(err.to_string().contains(&kept[0]), "{err}");
}

// The next two are a pair, and each is what stops the ownership proof collapsing into a
// byte comparison. Dropping the identity half leaves the first passing and the second
// deleting a file it does not own; dropping the contents half does the reverse. Either
// costs a version nobody can get back, which is why both are driven and neither stands in
// for the other.

#[cfg(unix)]
#[test]
fn a_replacement_holding_the_saved_text_is_not_mistaken_for_the_file_the_save_wrote() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");
    let theirs = Cell::new(0);

    let err = racing(
        &path,
        "mine\n",
        Some("before\n"),
        // B, which the save was not authorised to replace, so it will be refused.
        &|| write_over(&path, "b\n"),
        // C: somebody else's file, carrying byte for byte what this save wrote. Whatever
        // they meant by it, the bytes are all a reader of the temporary would have to
        // compare, and they say the wrong thing.
        &|| {
            write_over(&path, "mine\n");
            theirs.set(ino(&path));
        },
    )
    .expect_err("a save that cannot be undone without destroying C reports it");

    // Their file is where they put it, holding what they put in it. It was not unlinked
    // for resembling this save's own, and it was not overwritten either.
    assert_eq!(text(&path), "mine\n");
    assert_eq!(ino(&path), theirs.get());
    // And B, which this save had no business replacing, is still recoverable from the file
    // the error names.
    let kept = leftovers(&fixture.root);
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(text(&fixture.root.join(&kept[0])), "b\n");
    assert!(err.to_string().contains(&kept[0]), "{err}");
}

#[cfg(unix)]
#[test]
fn a_write_into_the_file_a_save_committed_through_is_put_back_rather_than_removed() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");
    let ours = Cell::new(0);

    let err = racing(
        &path,
        "mine\n",
        Some("before\n"),
        &|| write_over(&path, "b\n"),
        // The exchange has just put this save's own file at the path, where anything at
        // all may write to it - and something writes into it rather than over it. So the
        // file is still the one the save created and what is in it is somebody else's.
        &|| {
            ours.set(ino(&path));
            std::fs::write(&path, "c\n").expect("a competing write in place");
        },
    )
    .expect_err("a save that cannot be undone without destroying C reports it");

    // Their text, in this save's own inode: identity is exactly what cannot decide here.
    assert_eq!(text(&path), "c\n");
    assert_eq!(ino(&path), ours.get());
    let kept = leftovers(&fixture.root);
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(text(&fixture.root.join(&kept[0])), "b\n");
    assert!(err.to_string().contains(&kept[0]), "{err}");
}

#[test]
#[cfg(not(windows))]
fn a_deletion_before_the_restore_puts_the_displaced_version_back() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");

    let outcome = racing(
        &path,
        "mine\n",
        Some("before\n"),
        &|| write_over(&path, "b\n"),
        // The path goes away while the save is holding the version it displaced. There is
        // nothing to exchange with, and a no-replace rename is conditional in the way the
        // restore needs: the displaced version goes home only if nothing has taken it.
        &|| std::fs::remove_file(&path).expect("a competing deletion"),
    )
    .expect("the save ran");

    assert_eq!(outcome, Saved::Refused);
    assert_eq!(text(&path), "b\n");
    let kept = leftovers(&fixture.root);
    assert!(kept.is_empty(), "{kept:?}");
}

#[test]
#[cfg(not(windows))]
fn a_path_taken_before_the_displaced_version_can_go_home_keeps_it_beside_the_file() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");
    let exchanges = Cell::new(0u32);
    // The restore finds nothing at the path, and by the time its rename runs something has
    // taken it. Those two cannot be made one operation, so the rename carries the refusal
    // rather than looking first.
    let taken = |from: &Path, to: &Path| {
        exchanges.set(exchanges.get() + 1);
        if exchanges.get() == 1 {
            return super::exchange(from, to);
        }
        std::fs::write(&path, "c\n").expect("a competing write");
        Err(std::io::Error::from(ErrorKind::NotFound))
    };

    let err = super::commit(
        &path,
        "mine\n",
        Some("before\n"),
        &Seams {
            compared: &|| write_over(&path, "b\n"),
            exchanged: &|| {},
            exchange: &taken,
        },
    )
    .expect_err("a save that could not put the displaced version back reports it");

    // Theirs stands, and B is beside the file rather than on top of it.
    assert_eq!(text(&path), "c\n");
    let kept = leftovers(&fixture.root);
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(text(&fixture.root.join(&kept[0])), "b\n");
    assert!(err.to_string().contains(&kept[0]), "{err}");
}

#[test]
#[cfg(not(windows))]
fn a_restore_that_cannot_run_keeps_the_displaced_version_rather_than_tidying_it_away() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");
    let exchanges = Cell::new(0u32);
    // A filesystem that exchanges once and then refuses: the save commits, and the
    // restore that would undo it cannot run.
    let once = |from: &Path, to: &Path| {
        exchanges.set(exchanges.get() + 1);
        if exchanges.get() == 1 {
            super::exchange(from, to)
        } else {
            Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "the test's filesystem refuses",
            ))
        }
    };

    let err = super::commit(
        &path,
        "mine\n",
        Some("before\n"),
        &Seams {
            compared: &|| write_over(&path, "theirs\n"),
            exchanged: &|| {},
            exchange: &once,
        },
    )
    .expect_err("a save that could not be undone reports it");

    // The version this save had no business replacing is still on disk. Removing it
    // because the save is over would destroy the only copy of it there is.
    let kept = leftovers(&fixture.root);
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(text(&fixture.root.join(&kept[0])), "theirs\n");
    assert!(err.to_string().contains(&kept[0]), "{err}");
    // And the error says what is at the path, because what is there is not what anybody
    // asked for.
    assert_eq!(text(&path), "mine\n");
}

#[cfg(unix)]
#[test]
fn a_filesystem_without_an_exchange_refuses_to_save_over_a_version_it_cannot_check() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");
    let theirs = Cell::new(0);

    let err = super::commit(
        &path,
        "mine\n",
        Some("before\n"),
        &Seams {
            compared: &|| {
                write_over(&path, "theirs\n");
                theirs.set(ino(&path));
            },
            exchanged: &|| {},
            // Some FUSE and network filesystems, and every platform without the flag.
            exchange: &|_from, _to| {
                Err(std::io::Error::new(
                    ErrorKind::Unsupported,
                    "no exchange on this filesystem",
                ))
            },
        },
    )
    .expect_err("a save that cannot be made conditional does not happen");

    // Told apart from any other failure, because it is not about this file or this
    // moment: no save over an existing version can be committed here at all.
    assert_eq!(err.kind(), ErrorKind::Unsupported);
    assert!(err.to_string().contains("exchange"), "{err}");
    // Byte for byte and file for file. Committing by rename would have been atomic for
    // anything reading the path and would still have destroyed a version nobody saw,
    // which is the bug and not the mitigation.
    assert_eq!(text(&path), "theirs\n");
    assert_eq!(ino(&path), theirs.get());
    assert_eq!(entries(&fixture.root), vec!["main.yar".to_string()]);
}

#[cfg(unix)]
#[test]
fn saving_keeps_the_mode_of_the_file_it_replaces() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    fixture.write("main.yar", "before\n");
    let path = fixture.root.join("main.yar");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .expect("a mode somebody chose");

    assert_eq!(save(&path, "after\n", Some("before\n")), Saved::Written);

    // The save commits a file of its own making, so the mode has to be carried across
    // deliberately: a rule file the user made private must not come back readable by
    // everybody.
    let mode = std::fs::metadata(&path)
        .expect("metadata")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600, "{mode:o}");
}

#[cfg(unix)]
#[test]
fn saving_writes_through_a_symlink_rather_than_over_it() {
    let fixture = Fixture::new();
    fixture.write_outside("shared.yar", "before\n");
    let link = fixture.root.join("main.yar");
    std::os::unix::fs::symlink(fixture.base.join("shared.yar"), &link).expect("a linked rule file");

    assert_eq!(save(&link, "after\n", Some("before\n")), Saved::Written);

    // The file the user is editing is the one the link names. Replacing the link would
    // leave their file behind and point the project at a copy.
    assert!(
        std::fs::symlink_metadata(&link)
            .expect("metadata")
            .file_type()
            .is_symlink(),
        "still a symlink"
    );
    assert_eq!(text(&fixture.base.join("shared.yar")), "after\n");
}
