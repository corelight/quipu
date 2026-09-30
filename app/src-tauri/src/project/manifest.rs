//! The optional `quipu.toml` manifest and the [`ProjectDefinition`] it yields.
//!
//! The manifest holds *stable user intent* only. It never holds hashes, cache
//! paths, timestamps, engine versions or any other generated state, so
//! compiling (or, later, caching) a project can never dirty the user's
//! repository.
//!
//! Schema 1:
//!
//! ```toml
//! schema = 1
//! entrypoints = ["rules/main.yar"]
//! include_dirs = ["rules", "vendor"]
//! exclude = ["tests/**"]
//! ```
//!
//! A directory without a manifest is a valid project that uses the documented
//! defaults: infer entrypoints, search `.` for includes, exclude nothing.

use std::fmt;
use std::path::{Path, PathBuf};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Deserialize;

use super::issues::{IssueKind, ProjectIssue};
use super::paths::{self, PathProblem};

/// The manifest filename looked for in the project root.
pub(crate) const MANIFEST_FILE: &str = "quipu.toml";

/// The only manifest schema this build understands.
pub(crate) const SCHEMA_VERSION: u32 = 1;

/// Include search path used when the manifest does not declare one.
const DEFAULT_INCLUDE_DIR: &str = ".";

/// The manifest exactly as written, before any resolution.
///
/// Unknown keys are rejected: with the schema version gating format changes, a
/// stray or misspelled key is far more likely to be a mistake the user wants to
/// hear about than a forward-compatible extension.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFile {
    /// Never read here - [`SchemaProbe`] has already checked it. The field
    /// exists so `deny_unknown_fields` accepts the key it knows is required.
    #[allow(dead_code)]
    schema: u32,
    #[serde(default)]
    entrypoints: Vec<String>,
    include_dirs: Option<Vec<String>>,
    #[serde(default)]
    exclude: Vec<String>,
}

/// Reads just the schema version, tolerating fields this build does not know,
/// so an unsupported schema reports itself as such instead of as a stray key.
#[derive(Deserialize)]
struct SchemaProbe {
    schema: u32,
}

/// A resolved include search directory.
#[derive(Clone, Debug)]
pub(crate) struct IncludeDir {
    /// The manifest spelling, kept for diagnostics. Deferred: the Includes view
    /// will show the declaration next to what it resolved to; compilation only
    /// needs the resolved path.
    #[allow(dead_code)]
    spec: String,
    /// Canonical absolute directory. May sit outside the project root: that is
    /// how a shared sibling rule directory is supported.
    path: PathBuf,
}

impl IncludeDir {
    #[allow(dead_code)] // see the note on the field
    pub(crate) fn spec(&self) -> &str {
        &self.spec
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

/// A project's configuration: everything the analyzer needs before it touches
/// the include graph.
///
/// Construction validates the manifest completely, so an existing
/// `ProjectDefinition` always has a canonical root, normalized entrypoints,
/// existing include directories and a compiled exclusion set.
#[derive(Debug)]
pub(crate) struct ProjectDefinition {
    root: PathBuf,
    manifest: Option<PathBuf>,
    entrypoints: Vec<String>,
    include_dirs: Vec<IncludeDir>,
    /// The patterns as written. `exclude_set` is what discovery matches against;
    /// these are kept for the same reason as [`IncludeDir::spec`], so a future
    /// Includes view can explain why a file is not part of the project.
    #[allow(dead_code)]
    exclude: Vec<String>,
    exclude_set: GlobSet,
}

impl ProjectDefinition {
    /// Loads the definition for `root`, reading `quipu.toml` if it exists.
    pub(crate) fn load(root: &Path) -> Result<Self, ConfigError> {
        // The root's own path only ever appears in these two messages, so it is
        // escaped for display rather than required to be a valid identity.
        let root = std::fs::canonicalize(root).map_err(|e| ConfigError::RootUnavailable {
            path: paths::escaped(root),
            error: e.to_string(),
        })?;
        if !root.is_dir() {
            return Err(ConfigError::RootNotADirectory {
                path: paths::escaped(&root),
            });
        }

        let manifest_path = root.join(MANIFEST_FILE);
        let Some(text) = read_manifest(&manifest_path)? else {
            return Ok(Self::defaults(root));
        };

        let probe: SchemaProbe =
            toml::from_str(&text).map_err(|e| ConfigError::ManifestInvalid {
                path: MANIFEST_FILE.to_string(),
                error: e.to_string(),
            })?;
        if probe.schema != SCHEMA_VERSION {
            return Err(ConfigError::UnsupportedSchema {
                found: probe.schema,
                supported: SCHEMA_VERSION,
            });
        }

        let file: ManifestFile =
            toml::from_str(&text).map_err(|e| ConfigError::ManifestInvalid {
                path: MANIFEST_FILE.to_string(),
                error: e.to_string(),
            })?;

        // Exclusions are compiled first: an explicitly declared entrypoint that
        // the same manifest excludes is a contradiction we want to report as
        // such, which needs the glob set.
        let (exclude, exclude_set) = compile_excludes(&file.exclude)?;
        let entrypoints = normalize_entrypoints(&file.entrypoints, &exclude_set)?;
        let include_dirs = resolve_include_dirs(&root, file.include_dirs.as_deref())?;

        Ok(Self {
            root,
            manifest: Some(manifest_path),
            entrypoints,
            include_dirs,
            exclude,
            exclude_set,
        })
    }

    /// The definition for a project with no manifest.
    fn defaults(root: PathBuf) -> Self {
        let include_dirs = vec![IncludeDir {
            spec: DEFAULT_INCLUDE_DIR.to_string(),
            path: root.clone(),
        }];
        Self {
            root,
            manifest: None,
            entrypoints: Vec::new(),
            include_dirs,
            exclude: Vec::new(),
            exclude_set: GlobSet::empty(),
        }
    }

    /// Canonical project root.
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Canonical path of the manifest, when the project has one.
    pub(crate) fn manifest(&self) -> Option<&Path> {
        self.manifest.as_deref()
    }

    /// Declared entrypoints as normalized project-relative identities, in
    /// manifest order. Empty means "infer from the include graph".
    pub(crate) fn declared_entrypoints(&self) -> &[String] {
        &self.entrypoints
    }

    /// Include search directories in declared order. Order is significant:
    /// resolution stops at the first match.
    pub(crate) fn include_dirs(&self) -> &[IncludeDir] {
        &self.include_dirs
    }

    /// Exclusion patterns as written, in declared order.
    #[allow(dead_code)] // see the note on the field
    pub(crate) fn exclude_patterns(&self) -> &[String] {
        &self.exclude
    }

    /// Tests a normalized, `/`-separated, project-relative path against the
    /// exclusion set.
    pub(crate) fn is_excluded(&self, relative: &str) -> bool {
        self.exclude_set.is_match(relative)
    }
}

/// Reads the manifest, distinguishing "absent" from "unreadable".
fn read_manifest(path: &Path) -> Result<Option<String>, ConfigError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ConfigError::ManifestUnreadable {
            path: MANIFEST_FILE.to_string(),
            error: e.to_string(),
        }),
    }
}

/// Compiles the exclusion globs.
///
/// `literal_separator` is on, so `*` stops at a directory boundary and `**` is
/// required to cross one - the behaviour users expect from `tests/**`.
fn compile_excludes(patterns: &[String]) -> Result<(Vec<String>, GlobSet), ConfigError> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        paths::check_portable(pattern).map_err(|reason| ConfigError::ExcludePattern {
            pattern: pattern.clone(),
            error: reason.to_string(),
        })?;
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|e| ConfigError::ExcludePattern {
                pattern: pattern.clone(),
                error: e.to_string(),
            })?;
        builder.add(glob);
    }
    let set = builder.build().map_err(|e| ConfigError::ExcludePattern {
        pattern: patterns.join(", "),
        error: e.to_string(),
    })?;
    Ok((patterns.to_vec(), set))
}

/// Validates declared entrypoints and normalizes them to project-relative
/// identities, preserving manifest order.
fn normalize_entrypoints(
    specs: &[String],
    exclude_set: &GlobSet,
) -> Result<Vec<String>, ConfigError> {
    let mut normalized: Vec<String> = Vec::with_capacity(specs.len());
    for spec in specs {
        let relative =
            paths::normalize_inside_root(spec).map_err(|reason| ConfigError::EntrypointPath {
                spec: spec.clone(),
                reason,
            })?;
        if !paths::is_rule_file(Path::new(&relative)) {
            return Err(ConfigError::EntrypointPath {
                spec: spec.clone(),
                reason: PathProblem::NotARuleFile,
            });
        }
        // Uniqueness is checked after normalization, so `a.yar` and `./a.yar`
        // are recognized as the same declaration.
        if normalized.contains(&relative) {
            return Err(ConfigError::DuplicateEntrypoint { spec: spec.clone() });
        }
        if exclude_set.is_match(&relative) {
            return Err(ConfigError::ExcludedEntrypoint { spec: spec.clone() });
        }
        normalized.push(relative);
    }
    Ok(normalized)
}

/// Resolves include directories against the project root, in declared order.
///
/// Each must exist: an include search path that is not there is a
/// configuration error rather than a silent miss on every include.
fn resolve_include_dirs(
    root: &Path,
    specs: Option<&[String]>,
) -> Result<Vec<IncludeDir>, ConfigError> {
    let owned_default = [DEFAULT_INCLUDE_DIR.to_string()];
    let specs = specs.unwrap_or(&owned_default);
    let mut dirs = Vec::with_capacity(specs.len());
    for spec in specs {
        // `..` is allowed and may resolve outside the project: that is how a
        // shared sibling rule directory is declared.
        paths::check_portable(spec).map_err(|reason| ConfigError::IncludeDirPath {
            spec: spec.clone(),
            reason,
        })?;
        let path = std::fs::canonicalize(root.join(spec)).map_err(|e| {
            ConfigError::IncludeDirUnavailable {
                spec: spec.clone(),
                error: e.to_string(),
            }
        })?;
        if !path.is_dir() {
            return Err(ConfigError::IncludeDirNotADirectory { spec: spec.clone() });
        }
        dirs.push(IncludeDir {
            spec: spec.clone(),
            path,
        });
    }
    Ok(dirs)
}

/// A problem that prevents a [`ProjectDefinition`] from being built at all.
///
/// These are separate from [`ProjectIssue`] because without a definition there
/// is nothing to analyze; [`ConfigError::as_issue`] converts one for callers
/// that want to present it in the same list as graph problems.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ConfigError {
    RootUnavailable { path: String, error: String },
    RootNotADirectory { path: String },
    ManifestUnreadable { path: String, error: String },
    ManifestInvalid { path: String, error: String },
    UnsupportedSchema { found: u32, supported: u32 },
    EntrypointPath { spec: String, reason: PathProblem },
    DuplicateEntrypoint { spec: String },
    ExcludedEntrypoint { spec: String },
    IncludeDirPath { spec: String, reason: PathProblem },
    IncludeDirUnavailable { spec: String, error: String },
    IncludeDirNotADirectory { spec: String },
    ExcludePattern { pattern: String, error: String },
}

impl ConfigError {
    /// A stable identifier for IPC and UI mapping.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::RootUnavailable { .. } => "root-unavailable",
            Self::RootNotADirectory { .. } => "root-not-a-directory",
            Self::ManifestUnreadable { .. } => "manifest-unreadable",
            Self::ManifestInvalid { .. } => "manifest-invalid",
            Self::UnsupportedSchema { .. } => "manifest-unsupported-schema",
            Self::EntrypointPath { .. } => "entrypoint-invalid-path",
            Self::DuplicateEntrypoint { .. } => "entrypoint-duplicate",
            Self::ExcludedEntrypoint { .. } => "entrypoint-excluded",
            Self::IncludeDirPath { .. } => "include-dir-invalid-path",
            Self::IncludeDirUnavailable { .. } => "include-dir-unavailable",
            Self::IncludeDirNotADirectory { .. } => "include-dir-not-a-directory",
            Self::ExcludePattern { .. } => "exclude-invalid-pattern",
        }
    }

    /// Presents the error as a blocking, project-scoped issue, for a caller that
    /// wants one list of `ProjectIssue`s.
    ///
    /// The IPC boundary does not use this: it keeps [`Self::code`] instead, so a
    /// UI can tell an unsupported schema from an unreadable manifest rather than
    /// seeing `invalid-configuration` for both.
    #[allow(dead_code)] // exercised by the model's tests
    pub(crate) fn as_issue(&self) -> ProjectIssue {
        ProjectIssue::project(IssueKind::InvalidConfiguration {
            detail: self.to_string(),
        })
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RootUnavailable { path, error } => {
                write!(f, "project root {path} is unavailable: {error}")
            }
            Self::RootNotADirectory { path } => {
                write!(f, "project root {path} is not a directory")
            }
            Self::ManifestUnreadable { path, error } => {
                write!(f, "cannot read {path}: {error}")
            }
            Self::ManifestInvalid { path, error } => write!(f, "{path} is invalid: {error}"),
            Self::UnsupportedSchema { found, supported } => write!(
                f,
                "{MANIFEST_FILE} declares schema {found}; this build supports schema {supported}"
            ),
            Self::EntrypointPath { spec, reason } => {
                write!(f, "entrypoint \"{spec}\" {reason}")
            }
            Self::DuplicateEntrypoint { spec } => {
                write!(f, "entrypoint \"{spec}\" is declared more than once")
            }
            Self::ExcludedEntrypoint { spec } => {
                write!(
                    f,
                    "entrypoint \"{spec}\" is also matched by an exclude pattern"
                )
            }
            Self::IncludeDirPath { spec, reason } => {
                write!(f, "include directory \"{spec}\" {reason}")
            }
            Self::IncludeDirUnavailable { spec, error } => {
                write!(f, "include directory \"{spec}\" is unavailable: {error}")
            }
            Self::IncludeDirNotADirectory { spec } => {
                write!(f, "include directory \"{spec}\" is not a directory")
            }
            Self::ExcludePattern { pattern, error } => {
                write!(f, "exclude pattern \"{pattern}\" is invalid: {error}")
            }
        }
    }
}
