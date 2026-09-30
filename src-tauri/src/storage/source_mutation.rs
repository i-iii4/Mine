//! Atomic multi-file source mutations with rollback retained through DB commit.
//!
//! Contract: SPEC_STORAGE.md#storagesource_mutation--atomicity-contract

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use thiserror::Error;

use crate::storage::files;

#[derive(Debug, Default)]
struct WriterState {
    active: usize,
    shutdown: bool,
}

/// A nonblocking gate: shutdown may begin only after every existing writer drains.
/// Nested write scopes are safe because shutdown never waits while holding a lock.
#[derive(Debug, Clone, Default)]
pub struct WriterGate(Arc<Mutex<WriterState>>);
#[derive(Debug)]
pub struct SourceWriteLease(Arc<Mutex<WriterState>>);
pub struct ShutdownLease(Arc<Mutex<WriterState>>);
static WRITERS: LazyLock<WriterGate> = LazyLock::new(WriterGate::default);

impl WriterGate {
    pub fn write(&self) -> Result<SourceWriteLease> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("writer gate poisoned"))?;
        anyhow::ensure!(
            !state.shutdown,
            "application update is preparing shutdown; new writes are disabled"
        );
        state.active += 1;
        Ok(SourceWriteLease(self.0.clone()))
    }
    pub fn shutdown(&self) -> Result<ShutdownLease> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("writer gate poisoned"))?;
        anyhow::ensure!(
            !state.shutdown && state.active == 0,
            "pending application operations must finish before update activation"
        );
        state.shutdown = true;
        Ok(ShutdownLease(self.0.clone()))
    }
}
impl Drop for SourceWriteLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock() {
            state.active -= 1;
        }
    }
}
impl Drop for ShutdownLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock() {
            state.shutdown = false;
        }
    }
}
pub fn begin_write() -> Result<SourceWriteLease> {
    WRITERS.write()
}
pub fn begin_shutdown() -> Result<ShutdownLease> {
    WRITERS.shutdown()
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    #[test]
    fn active_operation_blocks_activation_and_retains_lease_through_commit() {
        let gate = WriterGate::default();
        let staged = StagedSourceMutation {
            files: vec![],
            lease: Some(gate.write().unwrap()),
        };
        assert!(gate.shutdown().is_err());
        let committed = staged.commit().unwrap();
        assert!(gate.shutdown().is_err());
        committed.finalize();
        let shutdown = gate.shutdown().unwrap();
        assert!(gate.write().is_err());
        drop(shutdown);
        assert!(gate.write().is_ok());
    }
    #[test]
    fn failed_preparation_reopens_gate_without_rejecting_existing_rollback() {
        let gate = WriterGate::default();
        let outer = gate.write().unwrap();
        assert!(gate.shutdown().is_err());
        let nested = gate.write().unwrap();
        drop(nested);
        drop(outer);
        {
            let _shutdown = gate.shutdown().unwrap();
            assert!(gate.write().is_err());
        }
        assert!(gate.write().is_ok());
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFileMode {
    Create,
    Replace,
    Delete,
    Rename,
}

#[derive(Debug, Clone)]
pub struct SourceFileWrite {
    pub path: PathBuf,
    content: SourceFileContent,
    mode: SourceFileMode,
}

#[derive(Debug, Clone)]
enum SourceFileContent {
    Bytes(Vec<u8>),
    Copy(PathBuf),
    Replace {
        expected: Vec<u8>,
        bytes: Vec<u8>,
    },
    /// Move the file to the Trash; with `expected`, only while it holds
    /// those bytes.
    Delete {
        expected: Option<Vec<u8>>,
    },
    Rename {
        source: PathBuf,
        rewrite: Option<Rewrite>,
    },
}

#[derive(Debug, Clone)]
struct Rewrite {
    expected: Vec<u8>,
    bytes: Vec<u8>,
}

impl SourceFileWrite {
    pub fn create(path: PathBuf, bytes: Vec<u8>) -> Self {
        Self {
            path,
            content: SourceFileContent::Bytes(bytes),
            mode: SourceFileMode::Create,
        }
    }

    /// Replace the bytes of an existing file. `expected` is what the caller
    /// read and built `bytes` from: when the file holds anything else by the
    /// time the write would become visible, the operation is refused and the
    /// other version stays (SPEC_AUDIT_FIXES.md, Ф2).
    pub fn replace(path: PathBuf, expected: Vec<u8>, bytes: Vec<u8>) -> Self {
        Self {
            path,
            content: SourceFileContent::Replace { expected, bytes },
            mode: SourceFileMode::Replace,
        }
    }

    pub fn create_from_file(path: PathBuf, source: PathBuf) -> Self {
        Self {
            path,
            content: SourceFileContent::Copy(source),
            mode: SourceFileMode::Create,
        }
    }

    pub fn delete(path: PathBuf) -> Self {
        Self {
            path,
            content: SourceFileContent::Delete { expected: None },
            mode: SourceFileMode::Delete,
        }
    }

    /// Move a file to the Trash while it still holds `expected`, the bytes
    /// the caller read and built the operation from. A file that holds
    /// anything else, or is gone, refuses the whole operation and stays as it
    /// is (`SPEC_AUDIT_FIXES.md`, Ф2).
    pub fn delete_if_unchanged(path: PathBuf, expected: Vec<u8>) -> Self {
        Self {
            path,
            content: SourceFileContent::Delete {
                expected: Some(expected),
            },
            mode: SourceFileMode::Delete,
        }
    }

    /// Move a file under a new name. Its bytes move with it, including an
    /// edit made while the operation was prepared.
    pub fn rename(source: PathBuf, destination: PathBuf) -> Self {
        Self {
            path: destination,
            content: SourceFileContent::Rename {
                source,
                rewrite: None,
            },
            mode: SourceFileMode::Rename,
        }
    }

    /// Move a file under a new name and rewrite it, when the source still
    /// holds `expected`, the bytes the caller built `bytes` from.
    pub fn rename_with_bytes(
        source: PathBuf,
        destination: PathBuf,
        expected: Vec<u8>,
        bytes: Vec<u8>,
    ) -> Self {
        Self {
            path: destination,
            content: SourceFileContent::Rename {
                source,
                rewrite: Some(Rewrite { expected, bytes }),
            },
            mode: SourceFileMode::Rename,
        }
    }
}

#[derive(Debug, Error)]
pub enum SourceMutationError {
    #[error("invalid source mutation for {path}: {reason}")]
    Validate { path: PathBuf, reason: String },
    /// The file no longer holds what the operation was built from. Nothing
    /// was overwritten; the other version stays.
    #[error("{} changed outside Mine; nothing was overwritten{}", path.display(), preserved_note(preserved))]
    Changed {
        path: PathBuf,
        preserved: Option<PathBuf>,
    },
    #[error("failed to stage source mutation for {path}: {source}")]
    Stage {
        path: PathBuf,
        #[source]
        source: anyhow::Error,
    },
    #[error("failed to publish source mutation for {path}: {source}")]
    CommitFile {
        path: PathBuf,
        #[source]
        source: anyhow::Error,
    },
    #[error("failed to commit source index operation '{operation}': {source}")]
    CommitIndex {
        operation: &'static str,
        #[source]
        source: anyhow::Error,
    },
    #[error("source mutation rollback was incomplete after: {original}")]
    Rollback {
        original: String,
        failures: Vec<PathBuf>,
    },
}

fn preserved_note(preserved: &Option<PathBuf>) -> String {
    preserved
        .as_ref()
        .map(|path| format!("; displaced version kept at {}", path.display()))
        .unwrap_or_default()
}

/// A publication error, typed as `Changed` when an outside edit won.
fn commit_file_error(path: &Path, source: anyhow::Error) -> SourceMutationError {
    match files::source_changed(&source) {
        Some(changed) => SourceMutationError::Changed {
            path: changed.path.clone(),
            preserved: changed.preserved.clone(),
        },
        None => SourceMutationError::CommitFile {
            path: path.to_path_buf(),
            source,
        },
    }
}

#[derive(Debug)]
struct StagedSourceFile {
    path: PathBuf,
    temp: Option<PathBuf>,
    mode: SourceFileMode,
    original: OriginalSource,
}

/// What stood at a destination before the operation, and what the operation
/// put there: rollback restores the first only while the second is still in
/// place.
#[derive(Debug, Clone)]
enum OriginalSource {
    /// Nothing was there. Once published, the identity of the new file.
    Absent(Option<files::FileFingerprint>),
    /// The file held `expected`; the operation publishes `published`.
    Bytes {
        expected: Vec<u8>,
        published: Vec<u8>,
    },
    /// The deleted file, kept at `backup` until the operation is accepted.
    /// With `expected`, the file is deleted only while it holds those bytes
    /// and is still `read`, the file the backup was taken from.
    Backup {
        backup: PathBuf,
        expected: Option<Vec<u8>>,
        read: FileId,
    },
    /// The file moved here from `source` unchanged.
    Moved { source: PathBuf },
    /// The file moved here from `source` and was rewritten. Once published,
    /// the original is kept at `aside` and the new file has `published`.
    Rewritten {
        source: PathBuf,
        expected: Vec<u8>,
        aside: Option<PathBuf>,
        published: Option<files::FileFingerprint>,
    },
}

#[derive(Debug)]
pub struct StagedSourceMutation {
    files: Vec<StagedSourceFile>,
    lease: Option<SourceWriteLease>,
}

#[derive(Debug)]
pub struct CommittedSourceMutation {
    originals: Vec<(PathBuf, OriginalSource)>,
    finalized: bool,
    _lease: Option<SourceWriteLease>,
}

impl StagedSourceMutation {
    /// Stage every byte sequence before any destination becomes visible.
    pub fn stage(writes: Vec<SourceFileWrite>) -> std::result::Result<Self, SourceMutationError> {
        let lease = begin_write().map_err(|error| SourceMutationError::Validate {
            path: PathBuf::new(),
            reason: error.to_string(),
        })?;
        let mut staged = Vec::with_capacity(writes.len());
        let mut destinations = std::collections::BTreeSet::new();
        for write in writes {
            if !destinations.insert(write.path.clone()) {
                cleanup_staged(&staged);
                return Err(SourceMutationError::Validate {
                    path: write.path,
                    reason: "duplicate destination in source mutation".to_string(),
                });
            }
            let original = match stage_original(&write) {
                Ok(original) => original,
                Err(error) => {
                    cleanup_staged(&staged);
                    return Err(error);
                }
            };
            let temp = match stage_temp(&write) {
                Ok(temp) => temp,
                Err(source) => {
                    cleanup_original(&original);
                    cleanup_staged(&staged);
                    return Err(SourceMutationError::Stage {
                        path: write.path,
                        source,
                    });
                }
            };
            staged.push(StagedSourceFile {
                path: write.path,
                temp,
                mode: write.mode,
                original,
            });
        }
        Ok(Self {
            files: staged,
            lease: Some(lease),
        })
    }

    /// Publish the staged files. The returned guard must be finalized only
    /// after the matching SQLite transaction commits; otherwise Drop restores
    /// every original source file.
    pub fn commit(mut self) -> std::result::Result<CommittedSourceMutation, SourceMutationError> {
        let mut originals = Vec::with_capacity(self.files.len());
        for index in 0..self.files.len() {
            let file = &self.files[index];
            let published = publish(file);
            let original = match published {
                Ok(original) => original,
                Err(error) => {
                    // A failed checked replacement leaves any foreign bytes
                    // it met at its temp path; that file is not ours to drop.
                    if file.mode != SourceFileMode::Replace {
                        cleanup_staged(&self.files[index..=index]);
                    } else {
                        cleanup_original(&file.original);
                    }
                    cleanup_staged(&self.files[index + 1..]);
                    return Err(fail_commit(error, &originals, &mut self.files));
                }
            };
            if let Some(temp) = &file.temp {
                let _ = std::fs::remove_file(temp);
            }
            originals.push((file.path.clone(), original));
            let moved_from = match &file.original {
                OriginalSource::Moved { source } | OriginalSource::Rewritten { source, .. } => {
                    Some(source.clone())
                }
                _ => None,
            };
            let synced = files::sync_parent_directory(&file.path).and_then(|()| {
                moved_from
                    .as_deref()
                    .map_or(Ok(()), files::sync_parent_directory)
            });
            if let Err(source) = synced {
                let error = SourceMutationError::CommitFile {
                    path: file.path.clone(),
                    source,
                };
                cleanup_staged(&self.files[index + 1..]);
                return Err(fail_commit(error, &originals, &mut self.files));
            }
        }
        self.files.clear();
        Ok(CommittedSourceMutation {
            originals,
            finalized: false,
            _lease: self.lease.take(),
        })
    }

    /// Commit source files and their SQLite projection as one recoverable
    /// operation. The caller supplies only the index mutation; transaction
    /// ordering and source rollback remain owned by storage.
    pub fn commit_with_index<T>(
        self,
        conn: &Connection,
        operation: &'static str,
        apply_index: impl FnOnce(&Connection) -> Result<T>,
    ) -> std::result::Result<T, SourceMutationError> {
        conn.execute_batch("BEGIN IMMEDIATE").map_err(|source| {
            SourceMutationError::CommitIndex {
                operation,
                source: source.into(),
            }
        })?;

        let committed = match self.commit() {
            Ok(committed) => committed,
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error);
            }
        };
        let value = match apply_index(conn) {
            Ok(value) => value,
            Err(source) => {
                let _ = conn.execute_batch("ROLLBACK");
                let original = SourceMutationError::CommitIndex { operation, source };
                return rollback_after_index_failure(committed, original);
            }
        };
        if let Err(source) = conn.execute_batch("COMMIT") {
            let _ = conn.execute_batch("ROLLBACK");
            let original = SourceMutationError::CommitIndex {
                operation,
                source: source.into(),
            };
            return rollback_after_index_failure(committed, original);
        }
        committed.finalize();
        Ok(value)
    }
}

/// Roll back what was already published and report the first error, or the
/// incomplete rollback.
fn fail_commit(
    error: SourceMutationError,
    originals: &[(PathBuf, OriginalSource)],
    staged: &mut Vec<StagedSourceFile>,
) -> SourceMutationError {
    let failures = rollback_originals(originals);
    staged.clear();
    if failures.is_empty() {
        error
    } else {
        SourceMutationError::Rollback {
            original: error.to_string(),
            failures,
        }
    }
}

/// Check the destination and record what stands there before staging.
fn stage_original(write: &SourceFileWrite) -> std::result::Result<OriginalSource, SourceMutationError> {
    match &write.content {
        SourceFileContent::Bytes(_) | SourceFileContent::Copy(_) => {
            if write.path.exists() {
                return Err(SourceMutationError::Validate {
                    path: write.path.clone(),
                    reason: "create destination already exists".to_string(),
                });
            }
            Ok(OriginalSource::Absent(None))
        }
        SourceFileContent::Replace { expected, bytes } => match std::fs::read(&write.path) {
            Ok(current) if current == *expected => Ok(OriginalSource::Bytes {
                expected: expected.clone(),
                published: bytes.clone(),
            }),
            Ok(_) => Err(SourceMutationError::Changed {
                path: write.path.clone(),
                preserved: None,
            }),
            Err(error) => Err(SourceMutationError::Validate {
                path: write.path.clone(),
                reason: format!("replace destination is unreadable: {error}"),
            }),
        },
        SourceFileContent::Delete { expected } => {
            let changed = || SourceMutationError::Changed {
                path: write.path.clone(),
                preserved: None,
            };
            let (backup, read) = match prepare_delete_backup(&write.path) {
                Ok(backup) => backup,
                Err(_) if expected.is_some() && !write.path.exists() => return Err(changed()),
                Err(source) => {
                    return Err(SourceMutationError::Stage {
                        path: write.path.clone(),
                        source,
                    })
                }
            };
            if let Some(expected) = expected {
                // The backup is what rollback restores, so it must be the
                // version the operation was built from.
                let held = std::fs::read(&backup);
                if !matches!(&held, Ok(bytes) if bytes == expected) {
                    let _ = std::fs::remove_file(&backup);
                    return Err(match held {
                        Err(error) => SourceMutationError::Validate {
                            path: write.path.clone(),
                            reason: format!("delete source is unreadable: {error}"),
                        },
                        Ok(_) => changed(),
                    });
                }
            }
            Ok(OriginalSource::Backup {
                backup,
                expected: expected.clone(),
                read,
            })
        }
        SourceFileContent::Rename { source, rewrite } => {
            if write.path.exists() {
                return Err(SourceMutationError::Validate {
                    path: write.path.clone(),
                    reason: "rename destination already exists".to_string(),
                });
            }
            match rewrite {
                None => {
                    std::fs::symlink_metadata(source).map_err(|error| {
                        SourceMutationError::Validate {
                            path: source.clone(),
                            reason: format!("rename source is unavailable: {error}"),
                        }
                    })?;
                    Ok(OriginalSource::Moved {
                        source: source.clone(),
                    })
                }
                Some(rewrite) => match std::fs::read(source) {
                    Ok(current) if current == rewrite.expected => Ok(OriginalSource::Rewritten {
                        source: source.clone(),
                        expected: rewrite.expected.clone(),
                        aside: None,
                        published: None,
                    }),
                    Ok(_) => Err(SourceMutationError::Changed {
                        path: source.clone(),
                        preserved: None,
                    }),
                    Err(error) => Err(SourceMutationError::Validate {
                        path: source.clone(),
                        reason: format!("rename source is unreadable: {error}"),
                    }),
                },
            }
        }
    }
}

fn write_bytes(bytes: &[u8]) -> impl FnOnce(&mut std::fs::File) -> std::io::Result<()> + '_ {
    move |file| std::io::Write::write_all(file, bytes)
}

/// Write the new bytes to a hidden temp file next to the destination.
fn stage_temp(write: &SourceFileWrite) -> Result<Option<PathBuf>> {
    match &write.content {
        SourceFileContent::Delete { .. } | SourceFileContent::Rename { rewrite: None, .. } => {
            Ok(None)
        }
        SourceFileContent::Rename {
            rewrite: Some(rewrite),
            source,
        } => files::prepare_replacement_temp_file(&write.path, source, write_bytes(&rewrite.bytes))
            .map(Some),
        SourceFileContent::Replace { bytes, .. } => {
            files::prepare_replacement_temp_file(&write.path, &write.path, write_bytes(bytes))
                .map(Some)
        }
        SourceFileContent::Bytes(bytes) => {
            files::prepare_temp_file(&write.path, write_bytes(bytes)).map(Some)
        }
        SourceFileContent::Copy(source) => files::prepare_temp_file(&write.path, |file| {
            let mut input = std::fs::File::open(source)?;
            std::io::copy(&mut input, file).map(|_| ())
        })
        .map(Some),
    }
}

/// Make one staged file visible and return what rollback needs to undo it.
fn publish(file: &StagedSourceFile) -> std::result::Result<OriginalSource, SourceMutationError> {
    let failed = |source: anyhow::Error| commit_file_error(&file.path, source);
    match &file.original {
        OriginalSource::Absent(_) => {
            let temp = file.temp.as_ref().expect("create mutation has temp");
            let fingerprint = link_published(temp, &file.path)
                .with_context(|| format!("link {}", file.path.display()))
                .map_err(failed)?;
            Ok(OriginalSource::Absent(Some(fingerprint)))
        }
        OriginalSource::Bytes {
            expected,
            published,
        } => {
            let temp = file.temp.as_ref().expect("replace mutation has temp");
            files::exchange_if_unchanged(
                temp,
                &file.path,
                expected,
                published,
                &files::conflict_dir_for(&file.path),
            )
            .map_err(failed)?;
            Ok(file.original.clone())
        }
        OriginalSource::Backup {
            backup,
            expected,
            read,
        } => {
            match expected {
                Some(expected) => {
                    // A cheap refusal first; the check that holds follows.
                    ensure_unchanged(&file.path, expected).map_err(failed)?;
                    #[cfg(test)]
                    hooks::run_before_checked_trash(&file.path);
                    trash_if_unchanged(&file.path, backup, *read, expected).map_err(failed)?;
                }
                None => files::delete_user_file(&file.path)
                    .with_context(|| format!("delete {}", file.path.display()))
                    .map_err(failed)?,
            }
            Ok(file.original.clone())
        }
        OriginalSource::Moved { source } => {
            files::move_exclusive(source, &file.path).map_err(failed)?;
            Ok(file.original.clone())
        }
        OriginalSource::Rewritten {
            source, expected, ..
        } => {
            let temp = file.temp.as_ref().expect("rewritten rename has temp");
            let (aside, published) =
                publish_rewritten_rename(temp, source, &file.path, expected).map_err(failed)?;
            Ok(OriginalSource::Rewritten {
                source: source.clone(),
                expected: expected.clone(),
                aside: Some(aside),
                published: Some(published),
            })
        }
    }
}

/// Publish the rewritten file under its new name, then take the source away
/// only if it still holds the bytes the rewrite was built from. The source is
/// moved aside in one step first, so an edit that lands meanwhile is never
/// deleted: a mismatch moves it back and withdraws the new file.
fn publish_rewritten_rename(
    temp: &Path,
    source: &Path,
    destination: &Path,
    expected: &[u8],
) -> Result<(PathBuf, files::FileFingerprint)> {
    let published = link_published(temp, destination).with_context(|| {
        format!(
            "failed to publish rewritten rename {} -> {}",
            source.display(),
            destination.display()
        )
    })?;
    let aside = files::aside_path(source, "rename-original");
    if let Err(error) = std::fs::rename(source, &aside) {
        files::remove_if_unchanged(destination, &published)?;
        return Err(files::SourceChanged {
            path: source.to_path_buf(),
            preserved: None,
        })
        .with_context(|| format!("rename source vanished: {error}"));
    }
    if std::fs::read(&aside)? == expected {
        return Ok((aside, published));
    }
    let preserved = match files::rename_exclusive(&aside, source) {
        Ok(()) => None,
        Err(_) => Some(aside),
    };
    files::remove_if_unchanged(destination, &published)?;
    Err(files::SourceChanged {
        path: source.to_path_buf(),
        preserved,
    }
    .into())
}

/// Refuse unless `path` still holds `expected`.
fn ensure_unchanged(path: &Path, expected: &[u8]) -> Result<()> {
    match std::fs::read(path) {
        Ok(current) if current == expected => Ok(()),
        Ok(_) => Err(files::SourceChanged {
            path: path.to_path_buf(),
            preserved: None,
        }
        .into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(files::SourceChanged {
            path: path.to_path_buf(),
            preserved: None,
        }
        .into()),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

/// Which file a path names, whatever its bytes: its device and inode. An
/// in-place edit keeps them; an atomic save puts another file at the path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileId {
    dev: u64,
    ino: u64,
}

impl FileId {
    fn of(metadata: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
        }
    }

    fn at(path: &Path) -> Result<Self> {
        std::fs::symlink_metadata(path)
            .map(|metadata| Self::of(&metadata))
            .with_context(|| format!("stat {}", path.display()))
    }
}

/// Move `path` to the Trash only while it is still the file the operation
/// read: the file `read` names, holding `expected` (`SPEC_AUDIT_FIXES.md`,
/// Ф2, В1.2).
///
/// A comparison at the path proves nothing about the moment the Trash takes
/// the file: an editor that saves by replacing the file (iCloud, safe-save
/// editors, git) puts a new file there, and the Trash takes whatever stands
/// at the path when it moves. So the file first leaves the path in one step,
/// for a folder of its own next to it where no editor writes, and is checked
/// there. A file that is not the one read goes back and the operation
/// refuses; the one read goes to the Trash under its own name.
fn trash_if_unchanged(path: &Path, backup: &Path, read: FileId, expected: &[u8]) -> Result<()> {
    let name = path
        .file_name()
        .with_context(|| format!("delete source has no file name: {}", path.display()))?;
    let holder = files::aside_path(path, "checked-delete");
    std::fs::create_dir(&holder).with_context(|| format!("create {}", holder.display()))?;
    let aside = holder.join(name);
    if let Err(error) = std::fs::rename(path, &aside) {
        remove_holder(&holder);
        if error.kind() == std::io::ErrorKind::NotFound {
            return Err(files::SourceChanged {
                path: path.to_path_buf(),
                preserved: None,
            }
            .into());
        }
        return Err(error).with_context(|| format!("move aside {}", path.display()));
    }
    let still_read = FileId::at(&aside).is_ok_and(|found| found == read)
        && std::fs::read(&aside).is_ok_and(|bytes| bytes == expected);
    if !still_read {
        let preserved = put_back(path, &holder, &aside);
        return Err(files::SourceChanged {
            path: path.to_path_buf(),
            preserved,
        }
        .into());
    }
    if let Err(error) = files::delete_user_file(&aside) {
        // Nothing reached the Trash: the file returns to its path.
        return Err(match put_back(path, &holder, &aside) {
            None => error,
            Some(kept) => error.context(format!("the file is kept at {}", kept.display())),
        })
        .with_context(|| format!("delete {}", path.display()));
    }
    remove_holder(&holder);
    ensure_trashed_unchanged(path, backup, expected)
}

/// Return a file moved aside to its path, unless a new file stands there
/// now; then it stays aside and its place is returned.
fn put_back(path: &Path, holder: &Path, aside: &Path) -> Option<PathBuf> {
    match files::rename_exclusive(aside, path) {
        Ok(()) => {
            remove_holder(holder);
            None
        }
        Err(_) => Some(aside.to_path_buf()),
    }
}

/// Remove the emptied folder a checked delete set its file aside in.
fn remove_holder(holder: &Path) {
    if let Err(error) = std::fs::remove_dir(holder) {
        log::warn!("checked delete left {}: {error}", holder.display());
    }
}

/// After a checked delete: an edit written into the file in place while it
/// was moving to the Trash shows through the backup, a hard link to the same
/// file. Such a file is put back and the operation refused. A backup that is
/// a copy holds the checked bytes and passes.
fn ensure_trashed_unchanged(path: &Path, backup: &Path, expected: &[u8]) -> Result<()> {
    let held = std::fs::read(backup).with_context(|| format!("read {}", backup.display()))?;
    if held == expected {
        return Ok(());
    }
    // When a newer version already stands at `path` again, the put-back is
    // refused and the edited file stays in the Trash.
    let _ = restore_delete_backup(path, backup);
    Err(files::SourceChanged {
        path: path.to_path_buf(),
        preserved: None,
    }
    .into())
}

/// Link the staged `temp` under `destination`, which must not exist yet, and
/// return the identity of the published file for rollback.
///
/// The identity is taken from the temp before the link: a hard link shares
/// device, inode, size and modification time, so this is the identity of
/// exactly the file this operation publishes. Read from the destination after
/// the link instead, it would record a foreign file that replaced ours in
/// between as ours, and rollback would delete it. A destination that no
/// longer matches right after the link is refused and left as it is.
fn link_published(temp: &Path, destination: &Path) -> Result<files::FileFingerprint> {
    let published = files::fingerprint(temp)?;
    std::fs::hard_link(temp, destination)
        .with_context(|| format!("link {} -> {}", temp.display(), destination.display()))?;
    #[cfg(test)]
    tests::run_after_link_hook(destination);
    match files::fingerprint(destination) {
        Ok(live) if live == published => Ok(published),
        Ok(_) => Err(files::SourceChanged {
            path: destination.to_path_buf(),
            preserved: None,
        }
        .into()),
        Err(error) => {
            // Withdraw the link only while it is still ours.
            let _ = files::remove_if_unchanged(destination, &published);
            Err(error)
        }
    }
}

impl Drop for StagedSourceMutation {
    fn drop(&mut self) {
        cleanup_staged(&self.files);
    }
}

impl CommittedSourceMutation {
    /// Accept the visible files after the SQLite transaction commits.
    pub fn finalize(mut self) {
        cleanup_originals(&self.originals);
        self.finalized = true;
    }

    /// Restore source bytes explicitly so rollback failures can be surfaced.
    pub fn rollback(mut self, original: impl Into<String>) -> Result<(), SourceMutationError> {
        let failures = rollback_originals(&self.originals);
        self.finalized = true;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(SourceMutationError::Rollback {
                original: original.into(),
                failures,
            })
        }
    }
}

impl Drop for CommittedSourceMutation {
    fn drop(&mut self) {
        if !self.finalized {
            let _ = rollback_originals(&self.originals);
        }
    }
}

fn cleanup_staged(files: &[StagedSourceFile]) {
    for file in files {
        if let Some(temp) = &file.temp {
            let _ = std::fs::remove_file(temp);
        }
        cleanup_original(&file.original);
    }
}

/// Undo published files in reverse order. A destination that no longer holds
/// what this operation published is left as it is and reported: the outside
/// version wins over the restore.
fn rollback_originals(originals: &[(PathBuf, OriginalSource)]) -> Vec<PathBuf> {
    let mut failures = Vec::new();
    for (path, original) in originals.iter().rev() {
        let result = match original {
            OriginalSource::Absent(None) => Ok(()),
            OriginalSource::Absent(Some(published)) => files::remove_if_unchanged(path, published),
            OriginalSource::Bytes {
                expected,
                published,
            } => restore_replaced(path, expected, published),
            OriginalSource::Backup { backup, .. } => restore_delete_backup(path, backup),
            OriginalSource::Moved { source } => files::move_exclusive(path, source),
            OriginalSource::Rewritten {
                source,
                aside: Some(aside),
                published: Some(published),
                ..
            } => files::remove_if_unchanged(path, published)
                .and_then(|()| files::rename_exclusive(aside, source)),
            OriginalSource::Rewritten { .. } => Ok(()),
        };
        if result.is_err() {
            failures.push(path.clone());
        }
    }
    failures
}

/// Put the original bytes back while the file still holds what the
/// operation published.
fn restore_replaced(path: &Path, original: &[u8], published: &[u8]) -> Result<()> {
    let temp = files::prepare_replacement_temp_file(path, path, |file| {
        std::io::Write::write_all(file, original)
    })?;
    files::exchange_if_unchanged(
        &temp,
        path,
        published,
        original,
        &files::conflict_dir_for(path),
    )
}

/// Keep the file about to be deleted, and say which file that is: a hard
/// link is the file itself; a copy is read through one open handle, whose
/// identity is the identity of exactly the bytes copied.
fn prepare_delete_backup(path: &Path) -> Result<(PathBuf, FileId)> {
    let backup = files::aside_path(path, "delete-backup");
    match std::fs::hard_link(path, &backup) {
        Ok(()) => {
            let identity = files::sync_parent_directory(&backup).and_then(|()| FileId::at(&backup));
            match identity {
                Ok(identity) => Ok((backup, identity)),
                Err(error) => {
                    let _ = std::fs::remove_file(&backup);
                    Err(error)
                }
            }
        }
        Err(_) => {
            let mut source = std::fs::File::open(path)
                .with_context(|| format!("failed to open delete source: {}", path.display()))?;
            let identity = FileId::of(
                &source
                    .metadata()
                    .with_context(|| format!("stat delete source: {}", path.display()))?,
            );
            let copy = files::prepare_temp_file(path, |target| {
                std::io::copy(&mut source, target).map(|_| ())
            })?;
            Ok((copy, identity))
        }
    }
}

fn restore_delete_backup(path: &Path, backup: &Path) -> Result<()> {
    if path.exists() {
        anyhow::bail!(
            "cannot restore deleted source because destination exists: {}",
            path.display()
        );
    }
    match std::fs::hard_link(backup, path) {
        Ok(()) => {}
        Err(_) => files::copy_new_atomically(backup, path)?,
    }
    files::sync_parent_directory(path)?;
    std::fs::remove_file(backup)
        .with_context(|| format!("failed to remove delete backup: {}", backup.display()))?;
    files::sync_parent_directory(backup)?;
    Ok(())
}

fn cleanup_original(original: &OriginalSource) {
    match original {
        OriginalSource::Backup { backup: path, .. }
        | OriginalSource::Rewritten {
            aside: Some(path), ..
        } => {
            if std::fs::remove_file(path).is_ok() {
                let _ = files::sync_parent_directory(path);
            }
        }
        OriginalSource::Absent(_)
        | OriginalSource::Bytes { .. }
        | OriginalSource::Moved { .. }
        | OriginalSource::Rewritten { aside: None, .. } => {}
    }
}

fn cleanup_originals(originals: &[(PathBuf, OriginalSource)]) {
    for (_, original) in originals {
        cleanup_original(original);
    }
}

fn rollback_after_index_failure<T>(
    committed: CommittedSourceMutation,
    original: SourceMutationError,
) -> std::result::Result<T, SourceMutationError> {
    let original_message = original.to_string();
    match committed.rollback(&original_message) {
        Ok(()) => Err(original),
        Err(SourceMutationError::Rollback { failures, .. }) => Err(SourceMutationError::Rollback {
            original: original_message,
            failures,
        }),
        Err(error) => Err(error),
    }
}

/// Moments inside a publication where a test acts as an outside writer.
#[cfg(test)]
pub(crate) mod hooks {
    use std::cell::RefCell;
    use std::path::Path;

    type Hook = Box<dyn FnOnce(&Path)>;

    thread_local! {
        /// Runs once after a checked delete has compared the file with what
        /// the operation read and before the file goes: the window an editor's
        /// atomic save can hit.
        static BEFORE_CHECKED_TRASH: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    pub(crate) fn run_before_checked_trash(path: &Path) {
        if let Some(hook) = BEFORE_CHECKED_TRASH.with(|slot| slot.borrow_mut().take()) {
            hook(path);
        }
    }

    /// Run `hook` with the path of the next checked delete, at that moment.
    pub(crate) fn before_next_checked_trash(hook: impl FnOnce(&Path) + 'static) {
        BEFORE_CHECKED_TRASH.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    type AfterLinkHook = Box<dyn FnOnce(&Path)>;

    thread_local! {
        /// Runs once between the link of a published file and the check of
        /// its destination: the window an outside writer can hit.
        static AFTER_LINK: RefCell<Option<AfterLinkHook>> = const { RefCell::new(None) };
    }

    pub(super) fn run_after_link_hook(destination: &Path) {
        if let Some(hook) = AFTER_LINK.with(|slot| slot.borrow_mut().take()) {
            hook(destination);
        }
    }

    fn after_next_link(hook: impl FnOnce(&Path) + 'static) {
        AFTER_LINK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    /// An editor's atomic save: write a sibling, rename it over `path`.
    fn replace_from_outside(path: &Path, bytes: &'static [u8]) {
        let staged = path.with_file_name("outside-editor.tmp");
        std::fs::write(&staged, bytes).unwrap();
        std::fs::rename(&staged, path).unwrap();
    }

    fn failing_index(conn: &Connection) -> Result<()> {
        conn.execute_batch("SELECT 1")?;
        anyhow::bail!("injected index failure")
    }

    #[test]
    fn created_file_replaced_right_after_its_link_is_never_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let created = dir.path().join("created.md");
        let staged =
            StagedSourceMutation::stage(vec![SourceFileWrite::create(created.clone(), b"ours".to_vec())])
                .unwrap();
        after_next_link(|destination| replace_from_outside(destination, b"foreign"));
        let conn = Connection::open_in_memory().unwrap();

        let error = staged
            .commit_with_index(&conn, "test_projection", failing_index)
            .unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }), "{error}");
        assert_eq!(std::fs::read(&created).unwrap(), b"foreign");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn rewritten_rename_replaced_right_after_its_link_keeps_both_files() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        std::fs::write(&old, b"original").unwrap();
        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old.clone(),
            new.clone(),
            b"original".to_vec(),
            b"rewritten".to_vec(),
        )])
        .unwrap();
        after_next_link(|destination| replace_from_outside(destination, b"foreign"));
        let conn = Connection::open_in_memory().unwrap();

        let error = staged
            .commit_with_index(&conn, "test_projection", failing_index)
            .unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }), "{error}");
        assert_eq!(std::fs::read(&new).unwrap(), b"foreign");
        assert_eq!(std::fs::read(&old).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    fn hidden_leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with('.'))
            .collect()
    }

    #[test]
    fn checked_delete_refuses_at_staging_when_the_file_was_edited() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"read by Mine\nedited in Obsidian").unwrap();

        let error = StagedSourceMutation::stage(vec![SourceFileWrite::delete_if_unchanged(
            path.clone(),
            b"read by Mine".to_vec(),
        )])
        .unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"read by Mine\nedited in Obsidian");
        assert!(hidden_leftovers(dir.path()).is_empty());
    }

    #[test]
    fn checked_delete_refuses_when_the_file_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");

        let error = StagedSourceMutation::stage(vec![SourceFileWrite::delete_if_unchanged(
            path,
            b"read by Mine".to_vec(),
        )])
        .unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }), "{error}");
    }

    #[test]
    fn checked_delete_refuses_at_publication_and_rolls_back_earlier_files() {
        let dir = tempfile::tempdir().unwrap();
        let created = dir.path().join("merged.md");
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"read by Mine").unwrap();
        let staged = StagedSourceMutation::stage(vec![
            SourceFileWrite::create(created.clone(), b"merged".to_vec()),
            SourceFileWrite::delete_if_unchanged(path.clone(), b"read by Mine".to_vec()),
        ])
        .unwrap();
        replace_from_outside(&path, b"edited in Obsidian");

        let error = staged.commit().unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"edited in Obsidian");
        assert!(!created.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    /// В1.2: an editor's atomic save lands after the checked delete compared
    /// the file and before it went to the Trash. The file at the path is a new
    /// one; the backup still names the old one, so comparing the backup proves
    /// nothing. The new version stays where it is and the operation refuses.
    #[test]
    fn checked_delete_refuses_an_atomic_replace_after_the_check() {
        let dir = tempfile::tempdir().unwrap();
        let created = dir.path().join("merged.md");
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"read by Mine").unwrap();
        let staged = StagedSourceMutation::stage(vec![
            SourceFileWrite::create(created.clone(), b"merged".to_vec()),
            SourceFileWrite::delete_if_unchanged(path.clone(), b"read by Mine".to_vec()),
        ])
        .unwrap();
        hooks::before_next_checked_trash(|path| replace_from_outside(path, b"saved by an editor"));

        let error = staged.commit().unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"saved by an editor");
        assert!(!created.exists());
        assert!(hidden_leftovers(dir.path()).is_empty(), "{:?}", hidden_leftovers(dir.path()));
    }

    #[test]
    fn commit_then_rollback_restores_replacements_and_removes_creates() {
        let dir = tempfile::tempdir().unwrap();
        let replaced = dir.path().join("replaced.md");
        let created = dir.path().join("created.md");
        std::fs::write(&replaced, b"old").unwrap();
        let staged = StagedSourceMutation::stage(vec![
            SourceFileWrite::replace(replaced.clone(), b"old".to_vec(), b"new".to_vec()),
            SourceFileWrite::create(created.clone(), b"created".to_vec()),
        ])
        .unwrap();

        let committed = staged.commit().unwrap();
        assert_eq!(std::fs::read(&replaced).unwrap(), b"new");
        assert_eq!(std::fs::read(&created).unwrap(), b"created");
        committed.rollback("injected database failure").unwrap();

        assert_eq!(std::fs::read(&replaced).unwrap(), b"old");
        assert!(!created.exists());
    }

    #[test]
    fn mid_commit_collision_rolls_back_files_already_published() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first.md");
        let second = dir.path().join("second.md");
        let staged = StagedSourceMutation::stage(vec![
            SourceFileWrite::create(first.clone(), b"first".to_vec()),
            SourceFileWrite::create(second.clone(), b"second".to_vec()),
        ])
        .unwrap();
        std::fs::write(&second, b"external winner").unwrap();

        let error = staged.commit().unwrap_err();

        assert!(matches!(error, SourceMutationError::CommitFile { .. }));
        assert!(!first.exists());
        assert_eq!(std::fs::read(&second).unwrap(), b"external winner");
    }

    #[test]
    fn dropping_committed_guard_rolls_back_unfinalized_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"before").unwrap();
        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
            path.clone(),
            b"before".to_vec(),
            b"after".to_vec(),
        )])
        .unwrap();

        drop(staged.commit().unwrap());

        assert_eq!(std::fs::read(path).unwrap(), b"before");
    }

    #[test]
    fn delete_rolls_back_without_copying_source_into_memory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large-media.bin");
        std::fs::write(&path, b"media-bytes").unwrap();
        let staged =
            StagedSourceMutation::stage(vec![SourceFileWrite::delete(path.clone())]).unwrap();

        let committed = staged.commit().unwrap();
        assert!(!path.exists());
        committed.rollback("injected database failure").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"media-bytes");
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("mine-delete-backup")
        }));
    }

    #[test]
    fn finalized_delete_removes_source_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"source").unwrap();
        let staged =
            StagedSourceMutation::stage(vec![SourceFileWrite::delete(path.clone())]).unwrap();

        staged.commit().unwrap().finalize();

        assert!(!path.exists());
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("mine-delete-backup")
        }));
    }

    #[test]
    fn indexed_commit_failure_rolls_back_source_and_sql() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"before").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE projection (value TEXT NOT NULL);")
            .unwrap();
        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
            path.clone(),
            b"before".to_vec(),
            b"after".to_vec(),
        )])
        .unwrap();

        let error = staged
            .commit_with_index(&conn, "test_projection", |index_conn| -> Result<()> {
                index_conn.execute("INSERT INTO projection (value) VALUES ('partial')", [])?;
                anyhow::bail!("injected index failure")
            })
            .unwrap_err();

        assert!(matches!(error, SourceMutationError::CommitIndex { .. }));
        assert_eq!(std::fs::read(path).unwrap(), b"before");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM projection", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn replace_refuses_at_staging_when_the_file_differs_from_what_was_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"edited in Obsidian").unwrap();

        let error = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
            path.clone(),
            b"read by Mine".to_vec(),
            b"Mine rewrite".to_vec(),
        )])
        .unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"edited in Obsidian");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn replace_refuses_at_publication_and_rolls_back_earlier_files() {
        let dir = tempfile::tempdir().unwrap();
        let created = dir.path().join("created.md");
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"read by Mine").unwrap();
        let staged = StagedSourceMutation::stage(vec![
            SourceFileWrite::create(created.clone(), b"created".to_vec()),
            SourceFileWrite::replace(
                path.clone(),
                b"read by Mine".to_vec(),
                b"Mine rewrite".to_vec(),
            ),
        ])
        .unwrap();
        std::fs::write(&path, b"edited in Obsidian").unwrap();

        let error = staged.commit().unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"edited in Obsidian");
        assert!(!created.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn rollback_keeps_an_edit_made_after_publication() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"before").unwrap();
        let committed = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
            path.clone(),
            b"before".to_vec(),
            b"after".to_vec(),
        )])
        .unwrap()
        .commit()
        .unwrap();
        std::fs::write(dir.path().join("editor.md"), b"edited after publication").unwrap();
        std::fs::rename(dir.path().join("editor.md"), &path).unwrap();

        let error = committed.rollback("injected index failure").unwrap_err();

        assert!(matches!(error, SourceMutationError::Rollback { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"edited after publication");
    }

    #[test]
    fn rollback_keeps_a_created_file_edited_after_publication() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("created.md");
        let committed =
            StagedSourceMutation::stage(vec![SourceFileWrite::create(path.clone(), b"new".to_vec())])
                .unwrap()
                .commit()
                .unwrap();
        std::fs::write(dir.path().join("editor.md"), b"edited").unwrap();
        std::fs::rename(dir.path().join("editor.md"), &path).unwrap();

        assert!(committed.rollback("injected index failure").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"edited");
    }

    #[test]
    fn plain_rename_moves_the_file_with_an_edit_made_meanwhile() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        std::fs::write(&old, b"read by Mine").unwrap();
        let staged =
            StagedSourceMutation::stage(vec![SourceFileWrite::rename(old.clone(), new.clone())])
                .unwrap();
        std::fs::write(dir.path().join("editor.md"), b"edited meanwhile").unwrap();
        std::fs::rename(dir.path().join("editor.md"), &old).unwrap();

        let committed = staged.commit().unwrap();
        assert!(!old.exists());
        assert_eq!(std::fs::read(&new).unwrap(), b"edited meanwhile");
        committed.rollback("injected index failure").unwrap();
        assert_eq!(std::fs::read(&old).unwrap(), b"edited meanwhile");
        assert!(!new.exists());
    }

    #[test]
    fn rewritten_rename_refuses_when_the_source_was_edited_meanwhile() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        std::fs::write(&old, b"read by Mine").unwrap();
        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old.clone(),
            new.clone(),
            b"read by Mine".to_vec(),
            b"Mine rewrite".to_vec(),
        )])
        .unwrap();
        std::fs::write(dir.path().join("editor.md"), b"edited meanwhile").unwrap();
        std::fs::rename(dir.path().join("editor.md"), &old).unwrap();

        let error = staged.commit().unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }));
        assert_eq!(std::fs::read(&old).unwrap(), b"edited meanwhile");
        assert!(!new.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn rewritten_rename_rolls_back_to_the_original_name_and_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        std::fs::write(&old, b"original").unwrap();
        let committed = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old.clone(),
            new.clone(),
            b"original".to_vec(),
            b"rewritten".to_vec(),
        )])
        .unwrap()
        .commit()
        .unwrap();
        assert_eq!(std::fs::read(&new).unwrap(), b"rewritten");
        assert!(!old.exists());

        committed.rollback("injected index failure").unwrap();

        assert_eq!(std::fs::read(&old).unwrap(), b"original");
        assert!(!new.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn finalized_rewritten_rename_leaves_no_hidden_original() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        std::fs::write(&old, b"original").unwrap();
        StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old.clone(),
            new.clone(),
            b"original".to_vec(),
            b"rewritten".to_vec(),
        )])
        .unwrap()
        .commit()
        .unwrap()
        .finalize();

        assert_eq!(std::fs::read(&new).unwrap(), b"rewritten");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
