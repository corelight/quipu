//! Evidence for app-owned writes that macOS can report to a later FSEvents stream.
//!
//! A receipt suppresses a notification only while the named regular file still has
//! exactly the bytes Quipu wrote (or the name Quipu removed is still absent). It is
//! not a timeout or an event count. A different state or any verification error
//! removes the receipt and lets the event through. Receipts are bounded and cleared
//! on project changes; eviction can cause an extra refresh, never hide a change.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_RECEIPTS: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Written {
    bytes: u64,
    digest: blake3::Hash,
}

impl Written {
    pub(crate) fn from_bytes(bytes: &[u8]) -> Self {
        Self {
            bytes: bytes.len() as u64,
            digest: blake3::hash(bytes),
        }
    }

    /// Capture the source before a rename, never a possibly competing version
    /// found at the destination after it. Failure simply disables suppression.
    pub(crate) fn read(path: &Path) -> io::Result<Self> {
        let file = regular_file(path)?;
        let bytes = file.metadata()?.len();
        let mut reader = file.take(bytes.saturating_add(1));
        let mut digest = blake3::Hasher::new();
        digest.update_reader(&mut reader)?;
        if reader.limit() != 1 {
            return Err(io::Error::other("file length changed while reading"));
        }
        Ok(Self {
            bytes,
            digest: digest.finalize(),
        })
    }

    fn matches(&self, path: &Path) -> bool {
        let Ok(file) = regular_file(path) else {
            return false;
        };
        if file.metadata().map(|m| m.len()).ok() != Some(self.bytes) {
            return false;
        }
        // Bound reads even if an external writer keeps extending the file.
        let mut reader = file.take(self.bytes.saturating_add(1));
        let mut digest = blake3::Hasher::new();
        digest.update_reader(&mut reader).is_ok()
            && reader.limit() == 1
            && digest.finalize() == self.digest
    }
}

fn regular_file(path: &Path) -> io::Result<File> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let file: File = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::NONBLOCK
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )?
    .into();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let file = {
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(io::Error::other("not a regular file"));
        }
        File::open(path)?
    };
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    Ok(file)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Receipt {
    Written(Written),
    Removed,
}

impl Receipt {
    fn matches(&self, path: &Path) -> bool {
        match self {
            Self::Written(written) => written.matches(path),
            Self::Removed => std::fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == io::ErrorKind::NotFound),
        }
    }
}

/// Resolve parent aliases such as macOS /var -> /private/var, but never follow
/// the final component: replacing a file with a symlink must remain observable.
fn key(path: &Path) -> Option<PathBuf> {
    Some(path.parent()?.canonicalize().ok()?.join(path.file_name()?))
}

#[derive(Default)]
pub(crate) struct OwnWrites(Mutex<BTreeMap<PathBuf, Receipt>>);

impl OwnWrites {
    pub(crate) fn clear(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    pub(crate) fn written(&self, path: &Path, written: Written) {
        self.insert(path, Receipt::Written(written));
    }

    pub(crate) fn renamed(&self, from: &Path, to: &Path, written: Written) {
        self.insert(from, Receipt::Removed);
        self.insert(to, Receipt::Written(written));
    }

    fn insert(&self, path: &Path, receipt: Receipt) {
        let Some(path) = key(path) else { return };
        let mut receipts = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if receipts.len() == MAX_RECEIPTS && !receipts.contains_key(&path) {
            receipts.pop_first();
        }
        receipts.insert(path, receipt);
    }

    pub(crate) fn unchanged(&self, path: &Path) -> bool {
        let Some(path) = key(path) else { return false };
        let receipt = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&path)
            .cloned();
        let Some(receipt) = receipt else { return false };
        // Never hold the receipts lock across filesystem I/O.
        let unchanged = receipt.matches(&path);
        let mut receipts = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if receipts.get(&path) != Some(&receipt) {
            return false;
        }
        if !unchanged {
            receipts.remove(&path);
        }
        unchanged
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delayed_duplicates_are_verified_against_bytes_not_length_or_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rule.yar");
        let receipts = OwnWrites::default();
        std::fs::write(&path, b"ours").unwrap();
        receipts.written(&path, Written::from_bytes(b"ours"));
        assert!(receipts.unchanged(&path));
        assert!(
            receipts.unchanged(&path),
            "duplicate callbacks are also harmless"
        );
        std::fs::write(&path, b"them").unwrap();
        assert!(
            !receipts.unchanged(&path),
            "same-length external edit is reported"
        );
        std::fs::write(&path, b"ours").unwrap();
        assert!(
            !receipts.unchanged(&path),
            "a changed receipt stays retired"
        );
    }

    #[test]
    fn renamed_source_recreation_and_destination_edits_are_observable() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("before.yar");
        let to = dir.path().join("after.yar");
        let receipts = OwnWrites::default();
        std::fs::write(&from, b"ours").unwrap();
        let evidence = Written::read(&from).unwrap();
        std::fs::rename(&from, &to).unwrap();
        receipts.renamed(&from, &to, evidence);
        assert!(receipts.unchanged(&from));
        assert!(receipts.unchanged(&to));
        std::fs::write(&from, b"new").unwrap();
        std::fs::write(&to, b"edited").unwrap();
        assert!(!receipts.unchanged(&from));
        assert!(!receipts.unchanged(&to));
    }

    #[test]
    fn rename_evidence_does_not_adopt_a_competing_write() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("before.yar");
        let to = dir.path().join("after.yar");
        let receipts = OwnWrites::default();
        std::fs::write(&from, b"ours").unwrap();
        let evidence = Written::read(&from).unwrap();
        std::fs::write(&from, b"theirs").unwrap();
        std::fs::rename(&from, &to).unwrap();
        receipts.renamed(&from, &to, evidence);
        assert!(!receipts.unchanged(&to));
    }

    #[test]
    fn removal_or_a_non_file_replacement_does_not_match_saved_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rule.yar");
        let receipts = OwnWrites::default();
        receipts.written(&path, Written::from_bytes(b""));
        assert!(!receipts.unchanged(&path), "missing is not an empty file");
        receipts.written(&path, Written::from_bytes(b""));
        std::fs::create_dir(&path).unwrap();
        assert!(
            !receipts.unchanged(&path),
            "a directory is not an empty file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_replacement_with_identical_bytes_is_not_suppressed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rule.yar");
        let target = dir.path().join("other.yar");
        std::fs::write(&target, b"ours").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let receipts = OwnWrites::default();
        receipts.written(&path, Written::from_bytes(b"ours"));
        assert!(!receipts.unchanged(&path));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_fifo_replacement_cannot_block_the_watcher() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rule.yar");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        let receipts = OwnWrites::default();
        receipts.written(&path, Written::from_bytes(b""));
        assert!(!receipts.unchanged(&path));
    }

    #[test]
    fn eviction_and_clear_only_remove_suppression() {
        let dir = tempfile::tempdir().unwrap();
        let receipts = OwnWrites::default();
        for index in 0..=MAX_RECEIPTS {
            receipts.insert(
                &dir.path().join(format!("{index:05}.yar")),
                Receipt::Removed,
            );
        }
        assert!(!receipts.unchanged(&dir.path().join("00000.yar")));
        assert!(receipts.unchanged(&dir.path().join("00001.yar")));
        assert_eq!(receipts.0.lock().unwrap().len(), MAX_RECEIPTS);
        receipts.clear();
        assert!(!receipts.unchanged(&dir.path().join("00001.yar")));
    }
}
