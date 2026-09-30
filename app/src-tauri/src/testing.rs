//! Helpers shared by the backend's tests.
//!
//! Every test that needs a project builds a throwaway tree on disk rather than
//! using checked-in fixtures: what is being tested is the interpretation of a
//! directory, so keeping each case's layout next to its assertions is what makes
//! the test readable.
//!
//! The project root is a `project/` subdirectory of the temporary directory, so a
//! test can also create files *outside* the project - which is how external
//! dependencies and shared sibling include directories are exercised.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A throwaway project tree.
pub(crate) struct Fixture {
    /// Kept alive so the directory outlives the test.
    _dir: tempfile::TempDir,
    /// Canonical temporary directory; the project root's parent.
    pub base: PathBuf,
    /// Canonical project root.
    pub root: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let base = std::fs::canonicalize(dir.path()).expect("canonical temp dir");
        let root = base.join("project");
        std::fs::create_dir(&root).expect("project dir");
        Self {
            _dir: dir,
            base,
            root,
        }
    }

    /// Writes a file inside the project, creating parent directories.
    pub fn write(&self, relative: &str, contents: &str) -> &Self {
        write_at(&self.root.join(relative), contents);
        self
    }

    /// Writes a file next to the project, outside its root.
    pub fn write_outside(&self, relative: &str, contents: &str) -> &Self {
        write_at(&self.base.join(relative), contents);
        self
    }

    pub fn manifest(&self, contents: &str) -> &Self {
        self.write(crate::project::MANIFEST_FILE, contents)
    }

    /// The project root as the wire and the diagnostics spell it.
    pub fn root_text(&self) -> String {
        crate::project::to_slash(&self.root).expect("a representable temporary path")
    }

    /// The canonical, `/`-separated path of a project file, as a diagnostic's
    /// `file` field carries it.
    pub fn path_text(&self, relative: &str) -> String {
        crate::project::to_slash(&self.root.join(relative)).expect("a representable path")
    }
}

fn write_at(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent dir");
    }
    std::fs::write(path, contents).expect("write file");
}

/// A rule with a name that identifies the file it came from.
///
/// Resolution tests turn on *which* of two same-named files was compiled, so the
/// rule identifiers in the built ruleset are the observation: nothing about the
/// implementation has to be inspected to tell them apart.
///
/// The condition is deliberately not a constant: `condition: true` earns YARA-X's
/// `invariant_expr` warning, which would then show up in every test that asserts a
/// clean compilation.
pub(crate) fn rule(name: &str) -> String {
    format!("rule {name} {{ condition: filesize > 0 }}\n")
}

/// Serializes the tests that change the process working directory, which is
/// process-global and would otherwise leak between parallel tests.
static CWD: Mutex<()> = Mutex::new(());

/// Runs `body` with the process working directory set to `dir`, restoring it
/// afterwards even if `body` panics.
pub(crate) fn with_cwd<T>(dir: &Path, body: impl FnOnce() -> T) -> T {
    // A panic inside another cwd test poisons the lock; the directory has still
    // been restored, so the guard is recovered rather than cascading failures.
    let _guard = CWD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let previous = std::env::current_dir().expect("current dir");
    std::env::set_current_dir(dir).expect("set current dir");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    std::env::set_current_dir(&previous).expect("restore current dir");
    match result {
        Ok(value) => value,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
