//! Tests for the example catalog and for materializing a working copy.
//!
//! Two kinds of test live here and they use different fixtures on purpose.
//!
//! The materialization tests build their own catalog entries and their own
//! packaged tree in a temporary directory, because the behaviour under test - a
//! nested copy, a reused copy, a new revision, a destination Quipu refuses to
//! replace, two attempts racing, a symlink - is about the mechanism and not about
//! any particular example. The concurrency ones drive [`stage`] and [`install`]
//! by hand rather than starting threads, so the interleaving they assert on is
//! the one written in the test and not one the scheduler happened to produce.
//!
//! The catalog tests use the real `examples/` directory from the source tree,
//! reached through `CARGO_MANIFEST_DIR`. That is also the resource directory a
//! built application gets, because `tauri-build` copies it; a test binary is not
//! itself in a resource directory, so it reads the source rather than going
//! through [`resource_root`]. Those tests assert what each example's README
//! documents - the entrypoints, the rule count, the matches - so a README and the
//! project it describes cannot drift apart silently.

use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::*;
use crate::project::{EntrypointOrigin, open_project};

/// The committed `examples/` directory: the source of both the packaged resource
/// and every working copy.
fn source_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples")
        .canonicalize()
        .expect("the examples directory is part of the source tree")
}

/// A catalog entry for the materialization tests, which supply their own tree.
const fn entry(dir: &'static str, revision: u32, target: &'static str) -> Example {
    Example {
        id: dir,
        name: "Test example",
        description: "Built by a test.",
        revision,
        dir,
        target,
    }
}

/// Writes `contents` to `root/relative`, creating parents.
fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// Every staging directory beside `example`'s working copy, sorted.
///
/// Found by name rather than predicted, because a staging name is not
/// reconstructible from outside: that is the point of it. What identifies one is
/// [`STAGING_INFIX`], which no working copy's name can contain.
fn staging_dirs(data_root: &Path, example: &Example) -> Vec<PathBuf> {
    let parent = family(data_root, example);
    let Ok(entries) = std::fs::read_dir(&parent) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(STAGING_INFIX))
        })
        .collect();
    found.sort();
    found
}

/// A packaged example with a nested tree, under a fresh resource root.
fn packaged(dir: &str) -> TempDir {
    let resources = TempDir::new().unwrap();
    let root = resources.path().join(dir);
    write(
        &root,
        "main.yar",
        "rule packaged { condition: filesize > 0 }\n",
    );
    write(&root, "shared/strings/keywords.yar", "// leaf\n");
    write(&root, "targets/sample.txt", "sample bytes\n");
    resources
}

// ---- the catalog itself ----

#[test]
fn catalog_ids_are_unique_and_usable_as_directory_names() {
    let mut seen = std::collections::BTreeSet::new();
    for example in EXAMPLES {
        assert!(
            is_id_like(example.id),
            "{}: id must be lowercase letters, digits and hyphens",
            example.id
        );
        assert!(
            seen.insert(example.id),
            "duplicate example id: {}",
            example.id
        );
        assert!(
            is_id_like(example.dir),
            "{}: dir must be lowercase letters, digits and hyphens",
            example.id
        );
        assert!(
            is_inside_relative(example.target),
            "{}: target must be a relative path inside the project",
            example.id
        );
        assert!(
            example.revision >= 1,
            "{}: revision starts at 1",
            example.id
        );
        assert!(!example.name.is_empty(), "{}: needs a name", example.id);
        assert!(
            !example.description.is_empty(),
            "{}: needs a description",
            example.id
        );
        for text in [example.name, example.description] {
            assert!(
                text.is_ascii(),
                "{}: chooser text must be ASCII: {text}",
                example.id
            );
        }
    }
}

#[test]
fn every_catalog_entry_names_a_packaged_project() {
    let resources = source_root();
    for example in EXAMPLES {
        let dir = resources.join(example.dir);
        assert!(dir.is_dir(), "{}: {} is missing", example.id, escaped(&dir));
        assert!(
            dir.join(example.target).is_file(),
            "{}: target {} is missing",
            example.id,
            example.target
        );
        assert!(
            dir.join("README.md").is_file(),
            "{}: needs a README.md",
            example.id
        );
    }
}

#[test]
fn plain_names_reject_anything_that_could_leave_a_directory() {
    for bad in [
        "",
        ".",
        "..",
        "a/b",
        "a\\b",
        "/abs",
        "C:x",
        "Upper",
        "with space",
    ] {
        assert!(
            !is_id_like(bad),
            "{bad} should not be usable as a directory name"
        );
    }
    assert!(is_id_like("basic-text-match"));
    assert!(is_id_like("v2"));
}

#[test]
fn relative_targets_reject_anything_that_could_leave_the_project() {
    for bad in [
        "",
        "/targets/sample.txt",
        "../sample.txt",
        "targets/../../sample.txt",
        "targets\\sample.txt",
        "C:/sample.txt",
        "targets//sample.txt",
        "targets/./sample.txt",
    ] {
        assert!(!is_inside_relative(bad), "{bad} should be rejected");
    }
    assert!(is_inside_relative("targets/sample.txt"));
    assert!(is_inside_relative("sample.txt"));
}

#[test]
fn an_unknown_id_is_rejected() {
    let resources = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    let err = prepare(resources.path(), data.path(), "no-such-example").unwrap_err();
    assert!(matches!(err, PrepareError::UnknownExample(id) if id == "no-such-example"));
    // Nothing was created for it, so an id that is not in the catalog cannot even
    // decide where a directory appears.
    assert!(!data.path().join("examples").exists());
}

#[test]
fn an_unknown_id_cannot_traverse_out_of_the_data_directory() {
    let resources = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    for id in ["../escape", "/etc", "..", "basic-text-match/../../escape"] {
        let err = prepare(resources.path(), data.path(), id).unwrap_err();
        assert!(
            matches!(err, PrepareError::UnknownExample(_)),
            "{id} should be rejected as an unknown example, got {err}"
        );
    }
    assert!(!data.path().join("escape").exists());
}

// ---- materializing a working copy ----

#[test]
fn the_first_open_copies_the_nested_tree() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");

    let root = materialize(resources.path(), data.path(), &example).unwrap();

    assert_eq!(root, destination(data.path(), &example));
    assert_eq!(
        root,
        data.path().join("examples").join("nested").join("v1"),
        "the working copy is versioned under the example's own id"
    );
    assert!(root.join("main.yar").is_file());
    assert_eq!(
        std::fs::read_to_string(root.join("shared/strings/keywords.yar")).unwrap(),
        "// leaf\n",
        "nested directories are copied, not flattened or skipped"
    );
    assert!(root.join(MARKER).is_file(), "a finished copy is marked");
    assert!(
        staging_dirs(data.path(), &example).is_empty(),
        "the staging directory is renamed into place, not left behind"
    );
}

#[test]
fn the_prepared_target_belongs_to_the_working_copy_and_is_readable() {
    let data = TempDir::new().unwrap();
    // Prepared through `prepare` rather than `materialize`, so the catalog lookup
    // is exercised too; that means the entry has to be a real one, with a
    // stand-in packaged tree under its own directory name.
    let example = EXAMPLES.first().unwrap();
    let resources = TempDir::new().unwrap();
    let packaged_root = resources.path().join(example.dir);
    write(
        &packaged_root,
        "rules.yar",
        "rule r { condition: filesize > 0 }\n",
    );
    write(&packaged_root, example.target, "target bytes\n");

    let prepared = prepare(resources.path(), data.path(), example.id).unwrap();

    assert_eq!(prepared.id, example.id);
    assert_eq!(prepared.name, example.name);
    let root = PathBuf::from(&prepared.root);
    assert_eq!(root, destination(data.path(), example));
    assert_eq!(
        PathBuf::from(&prepared.target.path),
        root.join(example.target),
        "the target is the working copy's, not the packaged one's"
    );
    assert_eq!(prepared.target.bytes, b"target bytes\n");
}

#[test]
fn a_missing_packaged_example_fails_without_creating_anything() {
    let resources = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    let example = entry("absent", 1, "targets/sample.txt");

    let err = materialize(resources.path(), data.path(), &example).unwrap_err();

    assert!(matches!(err, PrepareError::MissingResource(_)), "{err}");
    assert!(!destination(data.path(), &example).exists());
}

#[test]
fn a_catalog_target_outside_the_project_is_refused_before_anything_is_copied() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "../../../etc/passwd");

    let err = materialize(resources.path(), data.path(), &example).unwrap_err();

    assert!(
        matches!(
            err,
            PrepareError::InvalidCatalog {
                field: "target",
                ..
            }
        ),
        "{err}"
    );
    assert!(
        !destination(data.path(), &example).exists(),
        "the project is still the caller's until preparation succeeds"
    );
}

#[test]
fn reopening_the_same_revision_keeps_the_users_edits() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");

    let first = materialize(resources.path(), data.path(), &example).unwrap();
    std::fs::write(first.join("main.yar"), "rule edited { condition: false }\n").unwrap();
    std::fs::write(first.join("mine.yar"), "rule mine { condition: false }\n").unwrap();
    std::fs::remove_file(first.join("shared/strings/keywords.yar")).unwrap();

    let second = materialize(resources.path(), data.path(), &example).unwrap();

    assert_eq!(first, second);
    assert_eq!(
        std::fs::read_to_string(second.join("main.yar")).unwrap(),
        "rule edited { condition: false }\n",
        "an edited file is not overwritten from the template"
    );
    assert!(second.join("mine.yar").is_file(), "an added file survives");
    assert!(
        !second.join("shared/strings/keywords.yar").exists(),
        "a deleted file is not restored: a complete copy is never repaired"
    );
}

#[test]
fn a_new_revision_gets_its_own_directory() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let v1 = entry("nested", 1, "targets/sample.txt");
    let v2 = entry("nested", 2, "targets/sample.txt");

    let first = materialize(resources.path(), data.path(), &v1).unwrap();
    std::fs::write(first.join("main.yar"), "rule edited { condition: false }\n").unwrap();

    let second = materialize(resources.path(), data.path(), &v2).unwrap();

    assert_ne!(first, second);
    assert_eq!(second.file_name().unwrap(), "v2");
    assert_eq!(
        std::fs::read_to_string(second.join("main.yar")).unwrap(),
        "rule packaged { condition: filesize > 0 }\n",
        "the new revision is the packaged one"
    );
    assert_eq!(
        std::fs::read_to_string(first.join("main.yar")).unwrap(),
        "rule edited { condition: false }\n",
        "and the old revision's edits are still there"
    );
}

#[test]
fn an_unmarked_destination_is_preserved_rather_than_replaced() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");

    // Something with the working copy's name and no marker. Quipu cannot have left
    // it: a copy in progress is never called this. So it is somebody's - a restored
    // backup, a directory they made, a working copy whose marker went - and its
    // contents are not Quipu's to weigh up.
    let dest = destination(data.path(), &example);
    write(&dest, "main.yar", "mine, not the template's");
    write(&dest, "notes/keep.txt", "irreplaceable");

    let err = materialize(resources.path(), data.path(), &example).unwrap_err();

    assert!(
        matches!(err, PrepareError::Occupied { ref path, .. } if *path == dest),
        "{err}"
    );
    let message = err.to_string();
    assert!(
        message.contains("refusing to replace") && message.contains(MARKER),
        "the message has to say what Quipu refused and why: {message}"
    );
    assert_eq!(
        std::fs::read_to_string(dest.join("main.yar")).unwrap(),
        "mine, not the template's",
        "not one byte of it is touched"
    );
    assert_eq!(
        std::fs::read_to_string(dest.join("notes/keep.txt")).unwrap(),
        "irreplaceable"
    );
    assert!(
        !dest.join(MARKER).exists(),
        "and it is not adopted by being marked either"
    );
    assert!(
        staging_dirs(data.path(), &example).is_empty(),
        "a refusal copies nothing, so there is nothing to clean up"
    );
}

#[test]
fn a_destination_whose_marker_is_not_a_regular_file_is_refused() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");

    // A directory named like the marker is the version of this a plain
    // `Path::exists` would accept. On Unix a symlink is the sharper case, since
    // following it would let something outside decide whether this counts as a
    // working copy.
    let dest = destination(data.path(), &example);
    write(&dest, "mine.yar", "rule mine { condition: false }\n");
    #[cfg(unix)]
    std::os::unix::fs::symlink(resources.path().join("nested/main.yar"), dest.join(MARKER))
        .unwrap();
    #[cfg(not(unix))]
    std::fs::create_dir(dest.join(MARKER)).unwrap();

    let err = materialize(resources.path(), data.path(), &example).unwrap_err();

    assert!(matches!(err, PrepareError::Occupied { .. }), "{err}");
    assert_eq!(
        std::fs::read_to_string(dest.join("mine.yar")).unwrap(),
        "rule mine { condition: false }\n",
        "the directory is left as it was found"
    );
}

#[cfg(unix)]
#[test]
fn an_occupied_destination_is_what_gets_reported_because_it_is_checked_first() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");

    // Two things wrong at once: a destination Quipu may not replace, and a packaged
    // tree it would refuse to copy anyway. The destination is inspected before the
    // template is touched, so what the user is told is the thing they can do
    // something about, rather than the copy's own complaint.
    let dest = destination(data.path(), &example);
    write(&dest, "mine.yar", "rule mine { condition: false }\n");
    std::os::unix::fs::symlink("/etc/passwd", resources.path().join("nested/link.txt")).unwrap();

    let err = materialize(resources.path(), data.path(), &example).unwrap_err();

    assert!(matches!(err, PrepareError::Occupied { .. }), "{err}");
}

#[test]
fn a_file_where_the_working_copy_should_be_is_refused() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");

    let dest = destination(data.path(), &example);
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::write(&dest, "not a directory at all\n").unwrap();

    let err = materialize(resources.path(), data.path(), &example).unwrap_err();

    assert!(matches!(err, PrepareError::Occupied { .. }), "{err}");
    assert_eq!(
        std::fs::read_to_string(&dest).unwrap(),
        "not a directory at all\n"
    );
}

#[test]
fn two_attempts_never_share_a_staging_directory() {
    // No packaged tree: claiming is what is under test, and it happens before
    // anything is read.
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");

    let first = Staging::claim(data.path(), &example).unwrap();
    let second = Staging::claim(data.path(), &example).unwrap();

    assert_ne!(
        first.path(),
        second.path(),
        "each attempt copies into a directory only it knows about"
    );
    assert_eq!(
        staging_dirs(data.path(), &example),
        vec![first.path().to_path_buf(), second.path().to_path_buf()],
        "both claims exist at once, so neither took the other's"
    );
    for claimed in [first.path(), second.path()] {
        let name = claimed.file_name().unwrap().to_str().unwrap();
        assert!(
            name.contains(STAGING_INFIX),
            "{name} must be recognisable as staging"
        );
        assert_ne!(
            claimed,
            destination(data.path(), &example),
            "and can never be the destination itself"
        );
    }
}

#[test]
fn cleanup_removes_only_the_attempts_own_staging_directory() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");

    let mine = stage(
        &source_dir(resources.path(), &example).unwrap(),
        data.path(),
        &example,
    )
    .unwrap();
    // Their attempt is still going, so its value stays alive across the drop of
    // mine: ownership is the whole of what decides which directory goes.
    let theirs = Staging::claim(data.path(), &example).unwrap();
    write(theirs.path(), "main.yar", "still being copied");
    let mine_path = mine.path().to_path_buf();
    drop(mine);

    assert!(
        !mine_path.exists(),
        "an abandoned attempt takes its own tree"
    );
    assert_eq!(
        std::fs::read_to_string(theirs.path().join("main.yar")).unwrap(),
        "still being copied",
        "and leaves a live attempt's alone"
    );
}

#[test]
fn an_orphan_staging_directory_is_left_alone() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");

    // What an attempt killed mid-copy leaves behind. Nothing can tell it from an
    // attempt still running, so nothing removes it: inert debris is the cheaper
    // mistake.
    let orphan = family(data.path(), &example).join(format!("v1{STAGING_INFIX}999999-0"));
    write(&orphan, "main.yar", "half a file");

    // First an attempt that fails partway, which is when cleanup runs. A tree past
    // MAX_DEPTH is refused by the copy, after this attempt has claimed staging of
    // its own.
    let deep = "nested/".to_string() + &"d/".repeat(MAX_DEPTH + 1) + "leaf.yar";
    write(resources.path(), &deep, "// too deep\n");
    let err = materialize(resources.path(), data.path(), &example).unwrap_err();
    assert!(matches!(err, PrepareError::TooDeep(_)), "{err}");
    assert_eq!(
        staging_dirs(data.path(), &example),
        vec![orphan.clone()],
        "a failed attempt clears up after itself and nobody else"
    );

    // Then one that succeeds. Nothing about installing a working copy tidies the
    // family directory either.
    std::fs::remove_dir_all(resources.path().join("nested/d")).unwrap();
    let root = materialize(resources.path(), data.path(), &example).unwrap();

    assert_eq!(root, destination(data.path(), &example));
    assert!(root.join(MARKER).is_file(), "the copy still succeeds");
    assert_eq!(
        std::fs::read_to_string(orphan.join("main.yar")).unwrap(),
        "half a file",
        "and does not sweep up something that might be another attempt"
    );
}

#[test]
fn concurrent_attempts_resolve_to_one_working_copy() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");
    let source = source_dir(resources.path(), &example).unwrap();
    let dest = destination(data.path(), &example);

    // Both attempts get as far as a complete, marked staging tree before either
    // commits: the interleaving where the fixed path used to be a hazard.
    let first = stage(&source, data.path(), &example).unwrap();
    let second = stage(&source, data.path(), &example).unwrap();
    let first_path = first.path().to_path_buf();
    let second_path = second.path().to_path_buf();
    for staged in [&first_path, &second_path] {
        assert!(
            staged.join(MARKER).is_file() && staged.join("shared/strings/keywords.yar").is_file(),
            "neither attempt's copy is disturbed by the other's"
        );
    }

    let winner = install(first, &dest).unwrap();
    let loser = install(second, &dest).unwrap();

    assert_eq!(winner, dest);
    assert_eq!(loser, dest, "the loser reuses what won rather than failing");
    assert!(dest.join(MARKER).is_file());
    assert_eq!(
        std::fs::read_to_string(dest.join("main.yar")).unwrap(),
        "rule packaged { condition: filesize > 0 }\n"
    );
    assert!(
        staging_dirs(data.path(), &example).is_empty(),
        "the winner's directory became the working copy and the loser's went with it"
    );
    assert!(!second_path.exists());
}

#[test]
fn a_loser_will_not_reuse_a_destination_that_is_not_a_working_copy() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");
    let source = source_dir(resources.path(), &example).unwrap();
    let dest = destination(data.path(), &example);

    let staged = stage(&source, data.path(), &example).unwrap();
    let staged_path = staged.path().to_path_buf();
    // Between the check and the commit, something else appears under the working
    // copy's name. Whatever it is, it is not a copy Quipu finished, so losing to it
    // is a refusal rather than a reuse.
    write(&dest, "theirs.txt", "not a working copy");

    let err = install(staged, &dest).unwrap_err();

    assert!(matches!(err, PrepareError::Occupied { .. }), "{err}");
    assert_eq!(
        std::fs::read_to_string(dest.join("theirs.txt")).unwrap(),
        "not a working copy",
        "the occupant survives the attempt that lost to it"
    );
    assert!(!dest.join(MARKER).exists());
    assert!(
        !staged_path.exists(),
        "and the attempt cleans up after itself"
    );
}

#[test]
fn an_empty_destination_that_appears_before_the_commit_is_refused() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");
    let source = source_dir(resources.path(), &example).unwrap();
    let dest = destination(data.path(), &example);

    let staged = stage(&source, data.path(), &example).unwrap();
    let staged_path = staged.path().to_path_buf();
    // An empty directory, appearing in the same window as the occupant above. This
    // is the case a plain rename would swallow whole on Unix, silently, leaving no
    // sign that anything had been there. An empty directory is no more Quipu's to
    // remove than a full one: somebody made it, or something is about to fill it.
    std::fs::create_dir_all(&dest).unwrap();

    let err = install(staged, &dest).unwrap_err();

    assert!(matches!(err, PrepareError::Occupied { .. }), "{err}");
    assert!(dest.is_dir(), "the directory that was there is still there");
    assert_eq!(
        std::fs::read_dir(&dest).unwrap().count(),
        0,
        "with nothing added to it: no marker, and none of the packaged files"
    );
    assert!(
        !staged_path.exists(),
        "and the attempt cleans up after itself"
    );
    assert!(staging_dirs(data.path(), &example).is_empty());
}

#[test]
fn a_marked_copy_is_reused_even_when_it_no_longer_resembles_the_template() {
    let resources = packaged("nested");
    let data = TempDir::new().unwrap();
    let example = entry("nested", 1, "targets/sample.txt");

    let dest = destination(data.path(), &example);
    write(&dest, MARKER, "complete");
    write(&dest, "only-mine.yar", "rule mine { condition: false }\n");

    let root = materialize(resources.path(), data.path(), &example).unwrap();

    assert_eq!(root, dest);
    assert!(
        !root.join("main.yar").exists(),
        "nothing was copied over it"
    );
    assert!(root.join("only-mine.yar").is_file());
}

#[cfg(unix)]
#[test]
fn a_symlink_in_the_packaged_tree_is_refused() {
    let outside = TempDir::new().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "not yours\n").unwrap();

    let resources = packaged("nested");
    let example = entry("nested", 1, "targets/sample.txt");
    let data = TempDir::new().unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        resources.path().join("nested/link.txt"),
    )
    .unwrap();

    let err = materialize(resources.path(), data.path(), &example).unwrap_err();

    assert!(matches!(err, PrepareError::SpecialEntry(_)), "{err}");
    assert!(
        !destination(data.path(), &example).exists(),
        "a refused copy leaves no working copy behind"
    );
    assert!(
        staging_dirs(data.path(), &example).is_empty(),
        "and no half-copied staging directory either"
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_directory_in_the_packaged_tree_is_not_followed() {
    let outside = TempDir::new().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "not yours\n").unwrap();

    let resources = packaged("nested");
    let example = entry("nested", 1, "targets/sample.txt");
    let data = TempDir::new().unwrap();
    std::os::unix::fs::symlink(outside.path(), resources.path().join("nested/elsewhere")).unwrap();

    let err = materialize(resources.path(), data.path(), &example).unwrap_err();

    assert!(matches!(err, PrepareError::SpecialEntry(_)), "{err}");
    assert!(!destination(data.path(), &example).exists());
}

// ---- the real examples ----

/// What an example's README promises, asserted against the working copy Quipu
/// actually opens.
struct Expectation {
    id: &'static str,
    origin: EntrypointOrigin,
    /// Entrypoint identities, in the order the snapshot reports them.
    entrypoints: &'static [&'static str],
    /// Every discovered rule file, in identity order. The first is what Quipu
    /// opens, so it is the file the in-app instructions have to be in.
    discovered: &'static [&'static str],
    /// Rules the compiler produces, private ones included: what the build status
    /// line counts.
    rule_count: usize,
    /// Rules reported for the catalog's sample target, sorted.
    matches: &'static [&'static str],
}

const EXPECTED: &[Expectation] = &[
    Expectation {
        id: "basic-text-match",
        origin: EntrypointOrigin::Inferred,
        entrypoints: &["text_indicators.yar"],
        discovered: &["text_indicators.yar"],
        rule_count: 2,
        matches: &["example_encoded_command", "example_suspicious_url"],
    },
    Expectation {
        id: "nested-includes",
        origin: EntrypointOrigin::Declared,
        entrypoints: &["main.yar"],
        discovered: &["main.yar", "shared/base.yar", "shared/strings/keywords.yar"],
        rule_count: 4,
        matches: &["example_staged_downloader"],
    },
    Expectation {
        id: "multiple-entrypoints",
        origin: EntrypointOrigin::Declared,
        // Manifest order, which is deliberately not path order.
        entrypoints: &["scripts.yar", "documents.yar"],
        discovered: &[
            "documents.yar",
            "parts/document_keywords.yar",
            "parts/script_keywords.yar",
            "scripts.yar",
        ],
        rule_count: 4,
        matches: &["example_office_macro_note", "example_shell_script_note"],
    },
];

#[test]
fn every_example_has_an_expectation_and_the_other_way_round() {
    let catalog: Vec<&str> = EXAMPLES.iter().map(|e| e.id).collect();
    let expected: Vec<&str> = EXPECTED.iter().map(|e| e.id).collect();
    assert_eq!(catalog, expected, "keep the catalog and EXPECTED in step");
}

#[test]
fn every_example_analyzes_compiles_and_scans_as_documented() {
    let resources = source_root();
    let data = TempDir::new().unwrap();

    for expectation in EXPECTED {
        let example = find(expectation.id).unwrap();
        let prepared = prepare(&resources, data.path(), example.id).unwrap();
        let root = PathBuf::from(&prepared.root);

        // Analysis: the project model sees what the README describes.
        let snapshot = open_project(&root)
            .unwrap_or_else(|e| panic!("{}: configuration error: {e}", example.id));
        let blocking: Vec<&str> = snapshot.blocking_issues().map(|i| i.code()).collect();
        assert!(
            blocking.is_empty(),
            "{}: blocking issues {blocking:?}",
            example.id
        );
        assert_eq!(
            snapshot.entrypoint_origin(),
            expectation.origin,
            "{}: entrypoint origin",
            example.id
        );
        let entrypoints: Vec<&str> = snapshot
            .entrypoints()
            .iter()
            .map(|id| id.path.as_str())
            .collect();
        assert_eq!(
            entrypoints, expectation.entrypoints,
            "{}: entrypoints",
            example.id
        );
        let discovered: Vec<&str> = snapshot
            .discovered()
            .iter()
            .map(|id| id.path.as_str())
            .collect();
        assert_eq!(
            discovered, expectation.discovered,
            "{}: discovered rule files",
            example.id
        );

        // The file Quipu opens first is the one carrying the in-app instructions,
        // because README.md is not a rule file and never appears in the tree.
        let first = snapshot
            .discovered()
            .iter()
            .find(|id| snapshot.node(id).is_some_and(|node| node.readable))
            .unwrap_or_else(|| panic!("{}: no readable source", example.id));
        assert_eq!(
            first.path, expectation.discovered[0],
            "{}: the first readable source",
            example.id
        );
        let opened = std::fs::read_to_string(root.join(&first.path)).unwrap();
        assert!(
            opened.contains("Rules > Compile Workspace"),
            "{}: {} must tell the user how to compile and scan",
            example.id,
            first.path
        );

        // Compilation: through the real project compile path, warnings included.
        let compiled = crate::compile::project(&root);
        let reported: Vec<&str> = compiled
            .diagnostics
            .iter()
            .map(|d| d.title.as_str())
            .collect();
        assert!(
            reported.is_empty(),
            "{}: compiled with diagnostics {reported:?}",
            example.id
        );
        assert_eq!(
            compiled.rule_count, expectation.rule_count,
            "{}: rule count",
            example.id
        );
        let rules = compiled
            .rules
            .unwrap_or_else(|| panic!("{}: produced no rules", example.id));

        // The scan the README documents, over the bytes the frontend is handed.
        let mut scanner = yara_x::Scanner::new(&rules);
        let results = scanner
            .scan(&prepared.target.bytes)
            .unwrap_or_else(|e| panic!("{}: scan failed: {e}", example.id));
        let mut matched: Vec<&str> = results
            .matching_rules()
            .map(|rule| rule.identifier())
            .collect();
        matched.sort_unstable();
        assert_eq!(matched, expectation.matches, "{}: matches", example.id);
    }
}

#[test]
fn the_basic_examples_second_target_matches_nothing() {
    let resources = source_root();
    let data = TempDir::new().unwrap();
    let prepared = prepare(&resources, data.path(), "basic-text-match").unwrap();
    let root = PathBuf::from(&prepared.root);

    let rules = crate::compile::project(&root).rules.unwrap();
    let clean = std::fs::read(root.join("targets/clean.txt")).unwrap();

    let mut scanner = yara_x::Scanner::new(&rules);
    let results = scanner.scan(&clean).unwrap();
    assert_eq!(results.matching_rules().count(), 0);
}

#[test]
fn no_packaged_example_contains_a_symlink_or_an_absolute_path() {
    // What the copy would refuse at run time, refused in the source tree instead:
    // an example that cannot be materialized is not an example.
    let resources = source_root();
    let data = TempDir::new().unwrap();
    for example in EXAMPLES {
        materialize(&resources, data.path(), example)
            .unwrap_or_else(|e| panic!("{}: {e}", example.id));
    }
}
