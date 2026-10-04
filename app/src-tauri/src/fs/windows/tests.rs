use super::*;
use crate::testing::Fixture;

fn recovery_files(dir: &Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "tmp"))
        .collect()
}

#[test]
fn comparison_and_write_exclude_other_file_access() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "original");
    let path = fixture.root.join("main.yar");
    let result = save_with(&path, "new", Some("original"), &mut |file, bytes| {
        for error in [
            std::fs::read(&path).unwrap_err(),
            std::fs::write(&path, "competitor").unwrap_err(),
            std::fs::remove_file(&path).unwrap_err(),
            rename_noreplace(&path, &fixture.root.join("moved.yar")).unwrap_err(),
        ] {
            assert_eq!(error.raw_os_error(), Some(32), "{error}");
        }
        overwrite(file, bytes)
    })
    .unwrap();
    assert_eq!(result, Saved::Written);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    assert!(recovery_files(&fixture.root).is_empty());
}

#[test]
fn an_existing_reader_prevents_a_save_without_changing_bytes() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "original");
    let path = fixture.root.join("main.yar");
    let reader = File::open(&path).unwrap();
    assert_eq!(
        save(&path, "new", Some("original"))
            .unwrap_err()
            .raw_os_error(),
        Some(32)
    );
    drop(reader);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
    assert!(recovery_files(&fixture.root).is_empty());
}

#[test]
fn partial_write_failure_restores_the_original() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "original");
    let path = fixture.root.join("main.yar");
    let mut attempts = 0;
    let error = save_with(
        &path,
        "replacement",
        Some("original"),
        &mut |file, bytes| {
            attempts += 1;
            if attempts == 1 {
                overwrite(file, b"partial")?;
                return Err(io::Error::other("injected write failure"));
            }
            overwrite(file, bytes)
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("injected write failure"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
    assert!(recovery_files(&fixture.root).is_empty());
}

#[test]
fn failed_restoration_retains_and_names_the_original() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "original");
    let path = fixture.root.join("main.yar");
    let error = save_with(&path, "replacement", Some("original"), &mut |file, _| {
        overwrite(file, b"partial")?;
        Err(io::Error::other("injected persistent failure"))
    })
    .unwrap_err();
    let copies = recovery_files(&fixture.root);
    assert_eq!(copies.len(), 1);
    assert_eq!(std::fs::read_to_string(&copies[0]).unwrap(), "original");
    assert!(error.to_string().contains(&escaped(&copies[0])));
}

#[test]
fn saves_preserve_hard_links_and_handle_shorter_and_empty_text() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "original");
    let path = fixture.root.join("main.yar");
    let link = fixture.root.join("linked.yar");
    std::fs::hard_link(&path, &link).unwrap();
    assert_eq!(
        save(&path, "new", Some("original")).unwrap(),
        Saved::Written
    );
    assert_eq!(std::fs::read_to_string(&link).unwrap(), "new");
    assert_eq!(save(&path, "", Some("new")).unwrap(), Saved::Written);
    assert!(std::fs::read(&link).unwrap().is_empty());
}

#[test]
fn installing_a_directory_refuses_an_existing_empty_directory() {
    let fixture = Fixture::new();
    let source = fixture.root.join("staged");
    let destination = fixture.root.join("installed");
    std::fs::create_dir(&source).unwrap();
    std::fs::create_dir(&destination).unwrap();
    std::fs::write(source.join("marker"), "ours").unwrap();
    assert_eq!(
        rename_noreplace(&source, &destination).unwrap_err().kind(),
        ErrorKind::AlreadyExists
    );
    assert!(source.join("marker").exists());
    assert!(std::fs::read_dir(&destination).unwrap().next().is_none());
}
