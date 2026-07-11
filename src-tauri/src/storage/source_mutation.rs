//! Atomic multi-file source mutations with rollback retained through DB commit.
//!
//! Contract: SPEC_STORAGE.md#storagesource_mutation--atomicity-contract

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use thiserror::Error;

use crate::storage::files;

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
    Delete,
    Rename {
        source: PathBuf,
        replacement: Option<Vec<u8>>,
    },
}

impl SourceFileWrite {
    pub fn create(path: PathBuf, bytes: Vec<u8>) -> Self {
        Self {
            path,
            content: SourceFileContent::Bytes(bytes),
            mode: SourceFileMode::Create,
        }
    }

    pub fn replace(path: PathBuf, bytes: Vec<u8>) -> Self {
        Self {
            path,
            content: SourceFileContent::Bytes(bytes),
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
            content: SourceFileContent::Delete,
            mode: SourceFileMode::Delete,
        }
    }

    pub fn rename(source: PathBuf, destination: PathBuf) -> Self {
        Self {
            path: destination,
            content: SourceFileContent::Rename {
                source,
                replacement: None,
            },
            mode: SourceFileMode::Rename,
        }
    }

    pub fn rename_with_bytes(source: PathBuf, destination: PathBuf, bytes: Vec<u8>) -> Self {
        Self {
            path: destination,
            content: SourceFileContent::Rename {
                source,
                replacement: Some(bytes),
            },
            mode: SourceFileMode::Rename,
        }
    }
}

#[derive(Debug, Error)]
pub enum SourceMutationError {
    #[error("invalid source mutation for {path}: {reason}")]
    Validate { path: PathBuf, reason: String },
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

#[derive(Debug)]
struct StagedSourceFile {
    path: PathBuf,
    temp: Option<PathBuf>,
    mode: SourceFileMode,
    original: OriginalSource,
}

#[derive(Debug, Clone)]
enum OriginalSource {
    Absent,
    Bytes(Vec<u8>),
    Backup(PathBuf),
    Renamed { source: PathBuf, backup: PathBuf },
}

#[derive(Debug)]
pub struct StagedSourceMutation {
    files: Vec<StagedSourceFile>,
}

#[derive(Debug)]
pub struct CommittedSourceMutation {
    originals: Vec<(PathBuf, OriginalSource)>,
    finalized: bool,
}

impl StagedSourceMutation {
    /// Stage every byte sequence before any destination becomes visible.
    pub fn stage(writes: Vec<SourceFileWrite>) -> std::result::Result<Self, SourceMutationError> {
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
            let original = match write.mode {
                SourceFileMode::Create => {
                    if write.path.exists() {
                        cleanup_staged(&staged);
                        return Err(SourceMutationError::Validate {
                            path: write.path,
                            reason: "create destination already exists".to_string(),
                        });
                    }
                    OriginalSource::Absent
                }
                SourceFileMode::Replace => match std::fs::read(&write.path) {
                    Ok(bytes) => OriginalSource::Bytes(bytes),
                    Err(error) => {
                        cleanup_staged(&staged);
                        return Err(SourceMutationError::Validate {
                            path: write.path,
                            reason: format!("replace destination is unreadable: {error}"),
                        });
                    }
                },
                SourceFileMode::Delete => match prepare_delete_backup(&write.path) {
                    Ok(backup) => OriginalSource::Backup(backup),
                    Err(source) => {
                        cleanup_staged(&staged);
                        return Err(SourceMutationError::Stage {
                            path: write.path,
                            source,
                        });
                    }
                },
                SourceFileMode::Rename => {
                    if write.path.exists() {
                        cleanup_staged(&staged);
                        return Err(SourceMutationError::Validate {
                            path: write.path,
                            reason: "rename destination already exists".to_string(),
                        });
                    }
                    let source = match &write.content {
                        SourceFileContent::Rename { source, .. } => source,
                        _ => unreachable!("rename mode has rename content"),
                    };
                    match prepare_delete_backup(source) {
                        Ok(backup) => OriginalSource::Renamed {
                            source: source.clone(),
                            backup,
                        },
                        Err(source_error) => {
                            cleanup_staged(&staged);
                            return Err(SourceMutationError::Stage {
                                path: source.clone(),
                                source: source_error,
                            });
                        }
                    }
                }
            };
            let temp = match &write.content {
                SourceFileContent::Delete => None,
                SourceFileContent::Rename {
                    replacement: None, ..
                } => None,
                SourceFileContent::Rename {
                    replacement: Some(bytes),
                    ..
                } => match files::prepare_temp_file(&write.path, |file| {
                    std::io::Write::write_all(file, bytes)
                }) {
                    Ok(temp) => Some(temp),
                    Err(source) => {
                        cleanup_original(&original);
                        cleanup_staged(&staged);
                        return Err(SourceMutationError::Stage {
                            path: write.path,
                            source,
                        });
                    }
                },
                SourceFileContent::Bytes(bytes) => {
                    match files::prepare_temp_file(&write.path, |file| {
                        std::io::Write::write_all(file, bytes)
                    }) {
                        Ok(temp) => Some(temp),
                        Err(source) => {
                            cleanup_original(&original);
                            cleanup_staged(&staged);
                            return Err(SourceMutationError::Stage {
                                path: write.path,
                                source,
                            });
                        }
                    }
                }
                SourceFileContent::Copy(source) => {
                    match files::prepare_temp_file(&write.path, |file| {
                        let mut input = std::fs::File::open(source)?;
                        std::io::copy(&mut input, file).map(|_| ())
                    }) {
                        Ok(temp) => Some(temp),
                        Err(source) => {
                            cleanup_original(&original);
                            cleanup_staged(&staged);
                            return Err(SourceMutationError::Stage {
                                path: write.path,
                                source,
                            });
                        }
                    }
                }
            };
            staged.push(StagedSourceFile {
                path: write.path,
                temp,
                mode: write.mode,
                original,
            });
        }
        Ok(Self { files: staged })
    }

    /// Publish the staged files. The returned guard must be finalized only
    /// after the matching SQLite transaction commits; otherwise Drop restores
    /// every original source file.
    pub fn commit(mut self) -> std::result::Result<CommittedSourceMutation, SourceMutationError> {
        let mut originals = Vec::with_capacity(self.files.len());
        for index in 0..self.files.len() {
            let file = &self.files[index];
            let publish = match file.mode {
                SourceFileMode::Create => std::fs::hard_link(
                    file.temp.as_ref().expect("create mutation has temp"),
                    &file.path,
                )
                .with_context(|| format!("link {}", file.path.display())),
                SourceFileMode::Replace => std::fs::rename(
                    file.temp.as_ref().expect("replace mutation has temp"),
                    &file.path,
                )
                .with_context(|| format!("rename {}", file.path.display())),
                SourceFileMode::Delete => files::delete_user_file(&file.path)
                    .with_context(|| format!("delete {}", file.path.display())),
                SourceFileMode::Rename => publish_renamed_source(file),
            };
            if let Err(source) = publish {
                let original = SourceMutationError::CommitFile {
                    path: file.path.clone(),
                    source,
                };
                cleanup_staged(&self.files[index..]);
                let failures = rollback_originals(&originals);
                self.files.clear();
                if failures.is_empty() {
                    return Err(original);
                }
                return Err(SourceMutationError::Rollback {
                    original: original.to_string(),
                    failures,
                });
            }
            if let Some(temp) = &file.temp {
                let _ = std::fs::remove_file(temp);
            }
            if let Err(source) = files::sync_parent_directory(&file.path) {
                let original = SourceMutationError::CommitFile {
                    path: file.path.clone(),
                    source,
                };
                originals.push((file.path.clone(), file.original.clone()));
                cleanup_staged(&self.files[index + 1..]);
                let failures = rollback_originals(&originals);
                self.files.clear();
                if failures.is_empty() {
                    return Err(original);
                }
                return Err(SourceMutationError::Rollback {
                    original: original.to_string(),
                    failures,
                });
            }
            if let OriginalSource::Renamed { source, .. } = &file.original {
                if let Err(source_error) = files::sync_parent_directory(source) {
                    let original = SourceMutationError::CommitFile {
                        path: file.path.clone(),
                        source: source_error,
                    };
                    originals.push((file.path.clone(), file.original.clone()));
                    cleanup_staged(&self.files[index + 1..]);
                    let failures = rollback_originals(&originals);
                    self.files.clear();
                    if failures.is_empty() {
                        return Err(original);
                    }
                    return Err(SourceMutationError::Rollback {
                        original: original.to_string(),
                        failures,
                    });
                }
            }
            originals.push((file.path.clone(), file.original.clone()));
        }
        self.files.clear();
        Ok(CommittedSourceMutation {
            originals,
            finalized: false,
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

fn rollback_originals(originals: &[(PathBuf, OriginalSource)]) -> Vec<PathBuf> {
    let mut failures = Vec::new();
    for (path, original) in originals.iter().rev() {
        let result = match original {
            OriginalSource::Absent => remove_created_file(path),
            OriginalSource::Bytes(bytes) => files::write_atomically(path, bytes),
            OriginalSource::Backup(backup) => restore_delete_backup(path, backup),
            OriginalSource::Renamed { source, backup } => {
                restore_renamed_source(path, source, backup)
            }
        };
        if result.is_err() {
            failures.push(path.clone());
        }
    }
    failures
}

fn prepare_delete_backup(path: &Path) -> Result<PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static BACKUP_SEQ: AtomicU64 = AtomicU64::new(0);

    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("file has no parent directory: {}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("source");
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let backup = parent.join(format!(
        ".{name}.mine-delete-backup.{}.{}.{}",
        std::process::id(),
        nonce,
        BACKUP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));

    match std::fs::hard_link(path, &backup) {
        Ok(()) => {
            if let Err(error) = files::sync_parent_directory(&backup) {
                let _ = std::fs::remove_file(&backup);
                return Err(error);
            }
            Ok(backup)
        }
        Err(_) => {
            let mut source = std::fs::File::open(path)
                .with_context(|| format!("failed to open delete source: {}", path.display()))?;
            files::prepare_temp_file(path, |target| {
                std::io::copy(&mut source, target).map(|_| ())
            })
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
        OriginalSource::Backup(path) | OriginalSource::Renamed { backup: path, .. } => {
            if std::fs::remove_file(path).is_ok() {
                let _ = files::sync_parent_directory(path);
            }
        }
        OriginalSource::Absent | OriginalSource::Bytes(_) => {}
    }
}

fn cleanup_originals(originals: &[(PathBuf, OriginalSource)]) {
    for (_, original) in originals {
        cleanup_original(original);
    }
}

fn publish_renamed_source(file: &StagedSourceFile) -> Result<()> {
    let OriginalSource::Renamed { source, .. } = &file.original else {
        unreachable!("rename mode has rename content")
    };
    let publish = if let Some(temp) = &file.temp {
        std::fs::hard_link(temp, &file.path).with_context(|| {
            format!(
                "failed to publish rewritten rename {} -> {}",
                source.display(),
                file.path.display()
            )
        })
    } else {
        match std::fs::hard_link(source, &file.path) {
            Ok(()) => Ok(()),
            Err(_) => files::copy_new_atomically(source, &file.path),
        }
    };
    publish?;
    if let Err(error) = std::fs::remove_file(source)
        .with_context(|| format!("failed to remove rename source: {}", source.display()))
    {
        let _ = std::fs::remove_file(&file.path);
        return Err(error);
    }
    Ok(())
}

fn restore_renamed_source(destination: &Path, source: &Path, backup: &Path) -> Result<()> {
    remove_created_file(destination)?;
    if source.exists() {
        std::fs::remove_file(backup)
            .with_context(|| format!("failed to remove rename backup: {}", backup.display()))?;
        return Ok(());
    }
    restore_delete_backup(source, backup)
}

fn remove_created_file(path: &Path) -> Result<()> {
    if path.exists() {
        std::fs::remove_file(path)
            .with_context(|| format!("failed to remove created file: {}", path.display()))?;
        files::sync_parent_directory(path)?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_then_rollback_restores_replacements_and_removes_creates() {
        let dir = tempfile::tempdir().unwrap();
        let replaced = dir.path().join("replaced.md");
        let created = dir.path().join("created.md");
        std::fs::write(&replaced, b"old").unwrap();
        let staged = StagedSourceMutation::stage(vec![
            SourceFileWrite::replace(replaced.clone(), b"new".to_vec()),
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
}
