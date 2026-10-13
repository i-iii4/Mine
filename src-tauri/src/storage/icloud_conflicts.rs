//! iCloud conflict versions of a space's notes (SPEC_ICLOUD_CONFLICTS.md).
//!
//! A conflict is a note the system holds unresolved conflict versions of,
//! never a file name (ВК1). This module owns which spaces can have them
//! (ВК3), the bundled helper that sees, copies and settles them (ВК5), the
//! check pass that records them in `vault_conflicts` (ВК4, ВК6), the list the
//! window shows (ВК7) and the resolution (ВК8, ВК9). Tests stand a script in
//! the helper's place that answers set JSON: a real conflict cannot be made
//! outside a live iCloud.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

use crate::domain::vault::VaultLayout;
use crate::storage::source_mutation::{SourceFileWrite, SourceMutationError, StagedSourceMutation};
use crate::storage::vault_conflicts::{self, CheckResult};
use crate::storage::{files, reconcile};
use crate::tool_process::{classify_failure, run_to_exit, RunningTools, ToolFailure};

/// The helper's executable name, beside the bundle's other resources.
pub const HELPER_NAME: &str = "icloud-conflicts-helper";
/// `scan` deadline: twice the 8.5 s measured over the largest space, but no
/// less than 30 s (ВК5, live check of 11.10.2026, question 5).
pub const SCAN_DEADLINE: Duration = Duration::from_secs(30);
/// `read` deadline (ВК5).
pub const READ_DEADLINE: Duration = Duration::from_secs(10);
/// `settle` deadline (ВК5).
pub const SETTLE_DEADLINE: Duration = Duration::from_secs(10);
/// The device of a separate note when the version names none (ВК9).
const UNKNOWN_DEVICE: &str = "another device";
/// The helper's failure for a version that left the file's conflict
/// versions between the scan and the read.
const VERSION_MISSING: &str = "version_missing";

/// Whether the space at `root` can have iCloud conflicts (ВК3): the system
/// says iCloud keeps its folder, iCloud Drive or the Desktop and Documents it
/// syncs. The folder's path proves nothing (SPEC_DEEP_AUDIT.md, Н7, Е5.2).
pub fn is_icloud_space(root: &Path) -> bool {
    crate::storage::cloud_files::is_icloud_item(root)
}

/// One version of a note in conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ConflictVersion {
    /// The helper's handle of a conflict version; `None` for the version in
    /// the folder (ВК7).
    #[serde(default)]
    pub token: Option<String>,
    /// When it was saved, ISO 8601 with a zone; `None` when the system names
    /// no date.
    #[serde(default)]
    pub modified: Option<String>,
    /// The device that saved it; `None` when the system names none, which it
    /// does for every version in the folder (live check of 11.10.2026).
    #[serde(default)]
    pub device: Option<String>,
}

/// A note in conflict, as the window shows it (ВК7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct VaultConflict {
    /// From the space root, with folders: `Cards/Note.md`.
    pub path: String,
    /// The note's name: `Note`.
    pub name: String,
    pub detected_at: String,
    /// The version in the folder.
    pub current: ConflictVersion,
    /// The hidden conflict versions.
    pub versions: Vec<ConflictVersion>,
    /// iCloud did not answer about the note this time: the conflict stays
    /// recorded and counted, no version can be kept until it answers
    /// (SPEC_DEEP_AUDIT.md, Е5.12).
    pub unanswered: bool,
}

/// How the person resolves a conflict (ВК8).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConflictChoice {
    /// Keep one version in the note; `None` is the version in the folder.
    /// The others go to the Trash as separate notes.
    KeepVersion { token: Option<String> },
    /// Keep the note as it is and every other version as a separate note.
    KeepAll,
}

/// Why a conflict was not listed or resolved (ВК12).
#[derive(Debug, Error, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VaultConflictError {
    #[error("no space is open")]
    NoVault,
    /// The path is not a note of the space.
    #[error("Mine cannot use the path {path}")]
    InvalidPath { path: String },
    /// No conflict is recorded for the path any more.
    #[error("{path} has no pending conflict")]
    NotPending { path: String },
    /// The versions differ from those the window showed. Nothing changed.
    #[error("the versions of {path} changed")]
    VersionsChanged { path: String },
    /// The note changed on disk after it was read. Nothing changed.
    #[error("{path} changed outside Mine; nothing was changed")]
    SourceChanged { path: String },
    #[error("iCloud did not answer: {message}")]
    HelperFailed { message: String },
    /// The conflict is resolved, but the Trash refused the other versions:
    /// they stay next to the note as separate notes, `paths`.
    #[error("the Trash refused the other versions: {paths:?}")]
    TrashFailed { paths: Vec<String> },
    #[error("{message}")]
    Internal { message: String },
}

impl From<anyhow::Error> for VaultConflictError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal {
            message: format!("{error:#}"),
        }
    }
}

// ─── The helper ─────────────────────────────────────────────────────────────

/// Why the helper gave no usable answer.
#[derive(Debug, Error)]
pub enum HelperError {
    /// The helper ran and said why it failed.
    #[error("{message}")]
    Answered { kind: String, message: String },
    /// The helper did not run to its end, or failed without saying why.
    #[error("{0}")]
    Tool(ToolFailure),
    /// The answer does not follow the protocol.
    #[error("the iCloud helper's answer is not understood: {0}")]
    Protocol(String),
}

impl HelperError {
    /// The resolution's error for this failure of the note at `path`.
    fn into_resolution_error(self, path: &str) -> VaultConflictError {
        match self {
            Self::Answered { kind, .. } if kind == VERSION_MISSING => {
                VaultConflictError::VersionsChanged {
                    path: path.to_string(),
                }
            }
            error => VaultConflictError::HelperFailed {
                message: error.to_string(),
            },
        }
    }
}

impl From<HelperError> for VaultConflictError {
    fn from(error: HelperError) -> Self {
        Self::HelperFailed {
            message: error.to_string(),
        }
    }
}

/// A note with conflict versions, as `scan` saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedConflict {
    pub path: PathBuf,
    pub current: ConflictVersion,
    pub versions: Vec<ConflictVersion>,
}

/// What one `scan` answered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub conflicts: Vec<ScannedConflict>,
    /// Paths the helper could not answer for: what Mine knew of them stays.
    pub failed: BTreeSet<PathBuf>,
}

/// What one `settle` answered.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SettleReport {
    pub settled: Vec<String>,
    /// Versions already gone: another device resolved them. Not a failure.
    pub missing: Vec<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ScanLine {
    Conflict {
        path: String,
        current: ConflictVersion,
        versions: Vec<ConflictVersion>,
    },
    Done {
        done: bool,
        #[serde(default)]
        failed: Vec<String>,
    },
}

#[derive(Deserialize)]
struct FailureLine {
    error: String,
    message: String,
}

#[derive(Deserialize)]
struct ReadLine {
    sha256: String,
}

/// The bundled `icloud-conflicts-helper`, run through `tool_process` in a
/// process group of its own, under the deadlines of ВК5.
#[derive(Debug, Clone)]
pub struct ConflictsHelper {
    executable: PathBuf,
}

impl ConflictsHelper {
    #[must_use]
    pub fn new(executable: PathBuf) -> Self {
        Self { executable }
    }

    fn run(
        &self,
        arguments: &[&OsStr],
        input: Option<Vec<u8>>,
        deadline: Duration,
    ) -> Result<String, HelperError> {
        let running = RunningTools::new();
        let mut command = Command::new(&self.executable);
        command.args(arguments);
        let exit = run_to_exit(&mut command, input, deadline, &running).map_err(HelperError::Tool)?;
        if exit.success {
            return Ok(exit.stdout);
        }
        // The helper tells its own failure on stdout; without that line the
        // failure is the tool's, read from stderr like any tool's.
        let told = exit
            .stdout
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str::<FailureLine>(line).ok());
        Err(match told {
            Some(line) => HelperError::Answered {
                kind: line.error,
                message: line.message,
            },
            None => HelperError::Tool(classify_failure(&exit.stderr)),
        })
    }

    /// The conflict versions of `paths`, absolute. A path the protocol cannot
    /// carry (a line break in its name) is reported failed.
    pub fn scan(&self, paths: &[PathBuf]) -> Result<ScanReport, HelperError> {
        let mut report = ScanReport::default();
        let mut asked: HashMap<String, PathBuf> = HashMap::new();
        let mut input = String::new();
        for path in paths {
            match path.to_str() {
                Some(text) if !text.contains(['\n', '\r']) => {
                    input.push_str(text);
                    input.push('\n');
                    asked.insert(text.nfc().collect(), path.clone());
                }
                _ => {
                    report.failed.insert(path.clone());
                }
            }
        }
        if asked.is_empty() {
            return Ok(report);
        }
        let stdout = self.run(&[OsStr::new("scan")], Some(input.into_bytes()), SCAN_DEADLINE)?;
        let mut done = false;
        let mut garbled = false;
        for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
            // One line Mine cannot read does not lose the others (Е5.11):
            // it is logged, and the notes it may have been about keep what
            // Mine knew of them.
            let parsed: ScanLine = match serde_json::from_str(line) {
                Ok(parsed) => parsed,
                Err(error) => {
                    log::warn!("the iCloud conflicts helper answered a line Mine cannot read ({error}): {line}");
                    garbled = true;
                    continue;
                }
            };
            match parsed {
                ScanLine::Conflict {
                    path,
                    current,
                    versions,
                } => {
                    let key: String = path.nfc().collect();
                    let asked_path = asked.get(&key).ok_or_else(|| {
                        HelperError::Protocol(format!("an answer for a path not asked: {path}"))
                    })?;
                    report.conflicts.push(ScannedConflict {
                        path: asked_path.clone(),
                        current,
                        versions,
                    });
                }
                ScanLine::Done { done: true, failed } => {
                    done = true;
                    for path in failed {
                        let key: String = path.nfc().collect();
                        if let Some(asked_path) = asked.get(&key) {
                            report.failed.insert(asked_path.clone());
                        }
                    }
                }
                ScanLine::Done { done: false, .. } => {
                    return Err(HelperError::Protocol("a last line that is not done".into()));
                }
            }
        }
        if !done {
            return Err(HelperError::Protocol(
                "the answer ended before its last line".into(),
            ));
        }
        if garbled {
            let answered: BTreeSet<PathBuf> = report
                .conflicts
                .iter()
                .map(|conflict| conflict.path.clone())
                .collect();
            report.failed.extend(
                asked
                    .into_values()
                    .filter(|path| !answered.contains(path)),
            );
        }
        Ok(report)
    }

    /// Write the bytes of the version `token` of `path` to `destination`, a
    /// new file. Returns their SHA-256, hex.
    pub fn read(&self, path: &Path, token: &str, destination: &Path) -> Result<String, HelperError> {
        let stdout = self.run(
            &[
                OsStr::new("read"),
                path.as_os_str(),
                OsStr::new(token),
                destination.as_os_str(),
            ],
            None,
            READ_DEADLINE,
        )?;
        let line = last_line(&stdout)?;
        let parsed: ReadLine = serde_json::from_str(line)
            .map_err(|error| HelperError::Protocol(format!("{error}: {line}")))?;
        Ok(parsed.sha256)
    }

    /// Mark the versions `tokens` of `path` resolved and remove them.
    pub fn settle(&self, path: &Path, tokens: &[String]) -> Result<SettleReport, HelperError> {
        let mut arguments = vec![OsStr::new("settle"), path.as_os_str()];
        arguments.extend(tokens.iter().map(OsStr::new));
        let stdout = self.run(&arguments, None, SETTLE_DEADLINE)?;
        let line = last_line(&stdout)?;
        serde_json::from_str(line).map_err(|error| HelperError::Protocol(format!("{error}: {line}")))
    }
}

fn last_line(stdout: &str) -> Result<&str, HelperError> {
    stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| HelperError::Protocol("no answer".into()))
}

// ─── The check pass ─────────────────────────────────────────────────────────

/// Which notes one check pass looks at (ВК4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckScope {
    /// Every note of the space, after a reconciliation pass.
    Full,
    /// The notes of one batch of watcher events, absolute.
    Paths(BTreeSet<PathBuf>),
}

impl CheckScope {
    /// One pass that covers both.
    #[must_use]
    pub fn merge(self, other: Self) -> Self {
        match (self, other) {
            (Self::Paths(mut paths), Self::Paths(more)) => {
                paths.extend(more);
                Self::Paths(paths)
            }
            _ => Self::Full,
        }
    }
}

/// What a check pass did to the recorded conflicts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckOutcome {
    /// Whether the set of conflict paths changed.
    pub changed: bool,
    /// How many notes are in conflict now.
    pub count: usize,
}

/// The path of a note from the space root, as `vault_conflicts` keeps it:
/// folders, NFC, `.md`. `None` for a file that is not a note of the space.
pub fn note_path(vault: &VaultLayout, absolute: &Path) -> Option<String> {
    if absolute.extension().and_then(OsStr::to_str) != Some("md") {
        return None;
    }
    vault
        .slug_for_path(absolute)
        .ok()
        .map(|slug| format!("{slug}.md"))
}

/// The note's name from its path: `Cards/Note.md` is `Note`.
fn note_name(path: &str) -> String {
    let file = path.rsplit('/').next().unwrap_or(path);
    file.strip_suffix(".md").unwrap_or(file).to_string()
}

/// Check the notes of `scope` with the helper and record what it found
/// (ВК4, ВК6). `now` dates a conflict found for the first time.
pub fn run_check(
    conn: &Connection,
    vault: &VaultLayout,
    helper: &ConflictsHelper,
    scope: &CheckScope,
    now: &str,
) -> anyhow::Result<CheckOutcome> {
    let (absolute, full) = match scope {
        CheckScope::Full => (files::scan_md_files(vault)?, true),
        CheckScope::Paths(paths) => (paths.iter().cloned().collect::<Vec<_>>(), false),
    };
    let relative: BTreeMap<PathBuf, String> = absolute
        .into_iter()
        .filter_map(|path| note_path(vault, &path).map(|note| (path, note)))
        .collect();
    let asked: Vec<PathBuf> = relative.keys().cloned().collect();
    let report = helper.scan(&asked)?;
    let checked: BTreeSet<String> = relative
        .iter()
        .filter(|(path, _)| !report.failed.contains(*path))
        .map(|(_, note)| note.clone())
        .collect();
    let found: BTreeSet<String> = report
        .conflicts
        .iter()
        .filter_map(|conflict| relative.get(&conflict.path).cloned())
        .collect();
    let inventory = full.then(|| relative.values().cloned().collect::<BTreeSet<_>>());
    let changed = vault_conflicts::apply_check(
        conn,
        CheckResult {
            checked: &checked,
            found: &found,
            inventory: inventory.as_ref(),
        },
        now,
    )?;
    let count = vault_conflicts::list_conflict_paths(conn)?.len();
    Ok(CheckOutcome { changed, count })
}

// ─── The list ───────────────────────────────────────────────────────────────

/// The window's list, and whether reading it dropped resolved conflicts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConflictList {
    pub conflicts: Vec<VaultConflict>,
    /// Paths whose versions are gone (resolved on another device): their
    /// rows were removed.
    pub removed: Vec<String>,
}

/// The recorded conflicts with their versions read again by one `scan`
/// (ВК7), newest first. A path without versions any more leaves the table
/// and the list. A path the helper could not answer for stays in the table
/// and in the list, `unanswered` and without versions: the notice counts the
/// table, so a list without it showed «1 conflict» and an empty window
/// (SPEC_DEEP_AUDIT.md, Е5.12).
pub fn list_conflicts(
    conn: &Connection,
    vault: &VaultLayout,
    helper: &ConflictsHelper,
) -> Result<ConflictList, VaultConflictError> {
    let rows = vault_conflicts::list_conflict_rows(conn)?;
    if rows.is_empty() {
        return Ok(ConflictList::default());
    }
    let absolute: Vec<PathBuf> = rows.iter().map(|row| vault.root().join(&row.path)).collect();
    let report = helper.scan(&absolute)?;
    let mut scanned: HashMap<PathBuf, ScannedConflict> = report
        .conflicts
        .into_iter()
        .map(|conflict| (conflict.path.clone(), conflict))
        .collect();
    let mut list = ConflictList::default();
    for (row, path) in rows.into_iter().zip(&absolute) {
        match scanned.remove(path) {
            Some(conflict) if !conflict.versions.is_empty() => list.conflicts.push(VaultConflict {
                name: note_name(&row.path),
                path: row.path,
                detected_at: row.detected_at,
                current: ConflictVersion {
                    token: None,
                    ..conflict.current
                },
                versions: conflict.versions,
                unanswered: false,
            }),
            _ if report.failed.contains(path) => list.conflicts.push(VaultConflict {
                name: note_name(&row.path),
                path: row.path,
                detected_at: row.detected_at,
                current: ConflictVersion {
                    token: None,
                    modified: None,
                    device: None,
                },
                versions: Vec::new(),
                unanswered: true,
            }),
            _ => list.removed.push(row.path),
        }
    }
    vault_conflicts::remove_conflicts(conn, &list.removed)?;
    Ok(list)
}

// ─── The resolution ─────────────────────────────────────────────────────────

/// What the resolution asks for: the window's path, choice, and the versions
/// it showed.
#[derive(Debug, Clone, Copy)]
pub struct ResolveRequest<'a> {
    pub path: &'a str,
    pub choice: &'a ConflictChoice,
    pub expected_tokens: &'a [String],
}

/// What a resolution left behind.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resolution {
    /// The note, from the space root.
    pub path: String,
    /// Separate notes in the space: every other version for `KeepAll`; for
    /// `KeepVersion`, the ones the Trash refused.
    pub kept_separately: Vec<String>,
    /// For `KeepVersion`: the separate notes that went to the Trash.
    pub trashed: Vec<String>,
}

/// A separate note a version becomes (ВК9).
struct SeparateNote {
    absolute: PathBuf,
    relative: String,
    bytes: Vec<u8>,
    /// An earlier resolution of the same conflict already wrote it: a
    /// settle that failed after it (ВК8), retried (SPEC_DEEP_AUDIT.md, Е5.10).
    existing: bool,
}

/// The working folder for the copies of versions, removed with everything in
/// it when the resolution ends, whatever its outcome.
struct Staging(PathBuf);

impl Staging {
    fn new(vault: &VaultLayout) -> Result<Self, VaultConflictError> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let folder = vault
            .derived_root()
            .join("tmp")
            .join("conflicts")
            .join(format!(
                "{}-{nonce}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&folder).map_err(|error| VaultConflictError::Internal {
            message: format!("failed to create {}: {error}", folder.display()),
        })?;
        Ok(Self(folder))
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            log::warn!("conflict staging left {}: {error}", self.0.display());
        }
    }
}

/// The path a person sent, as a note path of the space, or `InvalidPath`.
fn validated_note_path(vault: &VaultLayout, raw: &str) -> Result<String, VaultConflictError> {
    let invalid = || VaultConflictError::InvalidPath {
        path: raw.to_string(),
    };
    let candidate = Path::new(raw);
    if raw.is_empty()
        || !candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(invalid());
    }
    note_path(vault, &vault.root().join(candidate)).ok_or_else(invalid)
}

/// `YYYY-MM-DD HH-MM` of an ISO 8601 time, local (ВК9).
fn local_minute(modified: &str) -> Option<String> {
    let local = crate::util::saved_at_local(modified);
    let date = local.get(..10)?;
    let hours = local.get(11..13)?;
    let minutes = local.get(14..16)?;
    (local.as_bytes().get(10) == Some(&b'T')).then(|| format!("{date} {hours}-{minutes}"))
}

/// The stem of the separate note a version becomes:
/// `{name} ({device} {YYYY-MM-DD HH-MM})`, cleaned of what a file name
/// cannot hold (ВК9).
fn separate_stem(name: &str, version: &ConflictVersion) -> String {
    let device = version
        .device
        .as_deref()
        .map(str::trim)
        .filter(|device| !device.is_empty())
        .unwrap_or(UNKNOWN_DEVICE);
    let raw = match version.modified.as_deref().and_then(local_minute) {
        Some(minute) => format!("{name} ({device} {minute})"),
        None => format!("{name} ({device})"),
    };
    mine_core::domain::block::suggest_slug(Some(&raw), None)
}

/// The separate note of `folder` an earlier resolution wrote for a version
/// with this stem and these bytes: `{stem}.md` or the unique name the shared
/// rule gave it, `{stem} (2).md` and on (ВК9). A retry after a failed settle
/// uses it instead of writing a second copy (SPEC_DEEP_AUDIT.md, Е5.10).
fn earlier_separate_note(vault: &VaultLayout, folder: &str, stem: &str, bytes: &[u8]) -> Option<String> {
    let directory = if folder.is_empty() {
        vault.root().to_path_buf()
    } else {
        vault.root().join(folder)
    };
    let mut names: Vec<String> = std::fs::read_dir(&directory)
        .ok()?
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|file| {
            let Some(file_stem) = file.strip_suffix(".md") else {
                return false;
            };
            let file_stem: String = file_stem.nfc().collect();
            let stem: String = stem.nfc().collect();
            file_stem == stem
                || file_stem
                    .strip_prefix(&stem)
                    .and_then(|rest| rest.strip_prefix(" ("))
                    .and_then(|rest| rest.strip_suffix(')'))
                    .is_some_and(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .collect();
    names.sort();
    names.into_iter().find_map(|file| {
        let held = std::fs::read(directory.join(&file)).ok()?;
        (held == bytes).then(|| {
            if folder.is_empty() {
                file
            } else {
                format!("{folder}/{file}")
            }
        })
    })
}

/// Claim a name for a separate note in `folder`, unique in the whole space
/// by the shared rule (ВК9).
fn claim_separate_path(
    occupied: &mut Vec<String>,
    folder: &str,
    stem: &str,
) -> Result<String, VaultConflictError> {
    let unique = mine_core::save::select_unique_file_stem(stem, "md", occupied).map_err(|error| {
        VaultConflictError::Internal {
            message: format!("no free name for a separate note {stem}: {error}"),
        }
    })?;
    let relative = if folder.is_empty() {
        format!("{unique}.md")
    } else {
        format!("{folder}/{unique}.md")
    };
    occupied.push(relative.clone());
    Ok(relative)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn mutation_error(error: SourceMutationError, path: &str) -> VaultConflictError {
    match error {
        SourceMutationError::Changed { .. } => VaultConflictError::SourceChanged {
            path: path.to_string(),
        },
        error => VaultConflictError::Internal {
            message: format!("{error:#}"),
        },
    }
}

/// Resolve the conflict of one note (ВК8).
///
/// The versions are checked against those the window showed, every byte is
/// read before anything is written, and the writes are one source mutation
/// checked against the bytes read. `suppress` hears every path the
/// resolution is about to write, before it writes, so the watcher drops
/// Mine's own changes. Settling comes last: a failure before it leaves the
/// conflict recorded and the resolution can be repeated.
pub fn resolve_conflict(
    conn: &Connection,
    vault: &VaultLayout,
    helper: &ConflictsHelper,
    request: ResolveRequest<'_>,
    suppress: &dyn Fn(&[PathBuf]),
) -> Result<Resolution, VaultConflictError> {
    // 1. A note of the space with a recorded conflict.
    let relative = validated_note_path(vault, request.path)?;
    if vault_conflicts::conflict_detected_at(conn, &relative)?.is_none() {
        return Err(VaultConflictError::NotPending { path: relative });
    }
    let absolute = vault.root().join(&relative);
    let versions_changed = || VaultConflictError::VersionsChanged {
        path: relative.clone(),
    };

    // 2. The versions are the ones the window showed.
    let report = helper.scan(std::slice::from_ref(&absolute))?;
    if report.failed.contains(&absolute) {
        return Err(VaultConflictError::HelperFailed {
            message: format!("no answer about {relative}"),
        });
    }
    let Some(scanned) = report
        .conflicts
        .into_iter()
        .find(|conflict| conflict.path == absolute && !conflict.versions.is_empty())
    else {
        return Err(versions_changed());
    };
    let tokens: Vec<String> = scanned
        .versions
        .iter()
        .filter_map(|version| version.token.clone())
        .collect();
    let shown: BTreeSet<&String> = request.expected_tokens.iter().collect();
    if tokens.len() != scanned.versions.len() || tokens.iter().collect::<BTreeSet<_>>() != shown {
        return Err(versions_changed());
    }
    if let ConflictChoice::KeepVersion { token: Some(token) } = request.choice {
        if !tokens.contains(token) {
            return Err(versions_changed());
        }
    }

    // 3. Every byte, before anything is written.
    let note_bytes = std::fs::read(&absolute).map_err(|error| VaultConflictError::Internal {
        message: format!("failed to read {relative}: {error}"),
    })?;
    let staging = Staging::new(vault)?;
    let mut version_bytes = Vec::with_capacity(scanned.versions.len());
    for (index, version) in scanned.versions.iter().enumerate() {
        let token = version.token.as_deref().ok_or_else(versions_changed)?;
        let copy = staging.0.join(format!("{index}.md"));
        let digest = helper
            .read(&absolute, token, &copy)
            .map_err(|error| error.into_resolution_error(&relative))?;
        let bytes = std::fs::read(&copy).map_err(|error| VaultConflictError::Internal {
            message: format!("failed to read the copy of a version of {relative}: {error}"),
        })?;
        if sha256_hex(&bytes) != digest {
            return Err(VaultConflictError::HelperFailed {
                message: format!("the copy of a version of {relative} does not match what iCloud read"),
            });
        }
        version_bytes.push((version, bytes));
    }
    drop(staging);

    // 4. One source mutation.
    let name = note_name(&relative);
    let folder = relative
        .rsplit_once('/')
        .map_or("", |(folder, _)| folder)
        .to_string();
    let mut occupied = files::scan_vault_file_paths(vault)?;
    let mut separate_versions: Vec<(&ConflictVersion, Vec<u8>)> = Vec::new();
    let mut writes = Vec::new();
    let kept = match request.choice {
        ConflictChoice::KeepVersion { token: Some(token) } => version_bytes
            .iter()
            .find(|(version, _)| version.token.as_deref() == Some(token.as_str()))
            .map(|(_, bytes)| bytes.clone()),
        ConflictChoice::KeepVersion { token: None } | ConflictChoice::KeepAll => None,
    };
    if let Some(kept) = kept {
        writes.push(SourceFileWrite::replace(
            absolute.clone(),
            note_bytes.clone(),
            kept,
        ));
        separate_versions.push((&scanned.current, note_bytes));
    }
    let chosen = match request.choice {
        ConflictChoice::KeepVersion { token } => token.as_deref(),
        ConflictChoice::KeepAll => None,
    };
    for (version, bytes) in version_bytes {
        if chosen.is_none() || version.token.as_deref() != chosen {
            separate_versions.push((version, bytes));
        }
    }
    let mut separate = Vec::with_capacity(separate_versions.len());
    for (version, bytes) in separate_versions {
        let stem = separate_stem(&name, version);
        if let Some(path) = earlier_separate_note(vault, &folder, &stem, &bytes) {
            separate.push(SeparateNote {
                absolute: vault.root().join(&path),
                relative: path,
                bytes,
                existing: true,
            });
            continue;
        }
        let path = claim_separate_path(&mut occupied, &folder, &stem)?;
        separate.push(SeparateNote {
            absolute: vault.root().join(&path),
            relative: path,
            bytes,
            existing: false,
        });
    }
    writes.extend(
        separate
            .iter()
            .filter(|note| !note.existing)
            .map(|note| SourceFileWrite::create(note.absolute.clone(), note.bytes.clone())),
    );
    let mut touched = vec![absolute.clone()];
    touched.extend(separate.iter().map(|note| note.absolute.clone()));
    suppress(&touched);
    let replaced = chosen.is_some();
    let keep_all = matches!(request.choice, ConflictChoice::KeepAll);
    StagedSourceMutation::stage(writes)
        .and_then(|staged| {
            staged.commit_with_index(conn, "resolve_vault_conflict", |index| {
                if replaced {
                    reconcile::project_source_path(index, vault, &absolute)?;
                }
                if keep_all {
                    for note in &separate {
                        reconcile::project_source_path(index, vault, &note.absolute)?;
                    }
                }
                Ok(())
            })
        })
        .map_err(|error| mutation_error(error, &relative))?;

    // 5. The versions not kept go to the Trash from the note's own folder.
    let mut resolution = Resolution {
        path: relative.clone(),
        ..Resolution::default()
    };
    if keep_all {
        resolution.kept_separately = separate.iter().map(|note| note.relative.clone()).collect();
    } else {
        let (trashed, refused) = trash_separate_notes(&separate);
        if !refused.is_empty() {
            index_separate_notes(conn, vault, &refused)?;
        }
        resolution.trashed = trashed.iter().map(|note| note.relative.clone()).collect();
        resolution.kept_separately = refused.iter().map(|note| note.relative.clone()).collect();
    }

    // 6. Settle every version, the chosen one too: its bytes are in the note.
    // The report is read (Е5.11): a version neither settled nor already gone
    // is still a conflict version, and the conflict stays recorded.
    let settled = helper
        .settle(&absolute, &tokens)
        .map_err(|error| error.into_resolution_error(&relative))?;
    let accounted: BTreeSet<&String> = settled.settled.iter().chain(&settled.missing).collect();
    let left = tokens.iter().filter(|token| !accounted.contains(token)).count();
    if left > 0 {
        return Err(VaultConflictError::HelperFailed {
            // The window puts this after «iCloud did not answer:» (ВК12).
            message: format!("versions of {relative} left unsettled: {left}"),
        });
    }

    // 7. The conflict is over.
    vault_conflicts::remove_conflicts(conn, std::slice::from_ref(&relative))?;
    Ok(resolution)
}

/// Move the separate notes to the Trash from where they were made, next to
/// the note, so Put Back in Finder returns them there. A note that no longer
/// holds the bytes written a moment ago is someone's edit and stays. Returns
/// the trashed and the kept.
fn trash_separate_notes(notes: &[SeparateNote]) -> (Vec<&SeparateNote>, Vec<&SeparateNote>) {
    let (unchanged, edited): (Vec<&SeparateNote>, Vec<&SeparateNote>) = notes
        .iter()
        .partition(|note| std::fs::read(&note.absolute).is_ok_and(|bytes| bytes == note.bytes));
    let paths: Vec<PathBuf> = unchanged.iter().map(|note| note.absolute.clone()).collect();
    if let Err(error) = files::delete_user_files(&paths) {
        log::warn!("the Trash refused separate conflict notes: {error:#}");
    }
    let (kept, trashed): (Vec<&SeparateNote>, Vec<&SeparateNote>) =
        unchanged.into_iter().partition(|note| note.absolute.exists());
    let mut refused = edited;
    refused.extend(kept);
    (trashed, refused)
}

/// Index separate notes that stay in the space.
fn index_separate_notes(
    conn: &Connection,
    vault: &VaultLayout,
    notes: &[&SeparateNote],
) -> Result<(), VaultConflictError> {
    let transaction = conn.unchecked_transaction().map_err(anyhow::Error::from)?;
    for note in notes {
        reconcile::project_source_path(&transaction, vault, &note.absolute)?;
    }
    transaction.commit().map_err(anyhow::Error::from)?;
    Ok(())
}

#[cfg(test)]
mod tests;
