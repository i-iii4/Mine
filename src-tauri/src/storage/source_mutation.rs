//! Atomic multi-file source mutations with rollback retained through DB commit.
//!
//! Contract: SPEC_STORAGE.md#storagesource_mutation--atomicity-contract

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, PoisonError};
use std::thread::ThreadId;
use std::time::{Duration, Instant};
use thiserror::Error;

use crate::storage::files;

#[derive(Debug, Default)]
struct WriterState {
    active: usize,
    shutdown: bool,
    /// Mine is quitting (SPEC_DEEP_AUDIT.md, Н3): a write that does not nest
    /// in one already running on its thread is refused.
    closing: bool,
    /// Leases held, by the thread that took them. A write nested in a running
    /// one on the same thread (a mutation that publishes a file through
    /// `files::write_atomically`) goes on while Mine quits: refusing it would
    /// leave the outer mutation half done.
    held: HashMap<ThreadId, usize>,
}

#[derive(Debug, Default)]
struct GateShared {
    state: Mutex<WriterState>,
    /// Signalled whenever a lease ends, for a quitting Mine that waits.
    ended: Condvar,
}

impl GateShared {
    fn state(&self) -> MutexGuard<'_, WriterState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A nonblocking gate: shutdown may begin only after every existing writer drains.
/// Nested write scopes are safe because shutdown never waits while holding a lock.
#[derive(Debug, Clone, Default)]
pub struct WriterGate(Arc<GateShared>);
#[derive(Debug)]
pub struct SourceWriteLease {
    gate: Arc<GateShared>,
    /// The thread that took the lease; a drop on another thread still
    /// counts it off that one.
    thread: ThreadId,
}
pub struct ShutdownLease(Arc<GateShared>);
static WRITERS: LazyLock<WriterGate> = LazyLock::new(WriterGate::default);

/// What waiting for the writes of a quitting Mine came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitDrain {
    /// Every write that had begun has ended.
    Drained,
    /// The deadline came first; this many writes were still running.
    TimedOut { running: usize },
}

impl WriterGate {
    pub fn write(&self) -> Result<SourceWriteLease> {
        let thread = std::thread::current().id();
        let mut state = self.0.state();
        anyhow::ensure!(
            !state.shutdown,
            "application update is preparing shutdown; new writes are disabled"
        );
        let nested = state.held.get(&thread).is_some_and(|held| *held > 0);
        anyhow::ensure!(
            !state.closing || nested,
            "Mine is quitting; new writes are not started"
        );
        state.active += 1;
        *state.held.entry(thread).or_default() += 1;
        Ok(SourceWriteLease {
            gate: self.0.clone(),
            thread,
        })
    }
    pub fn shutdown(&self) -> Result<ShutdownLease> {
        let mut state = self.0.state();
        anyhow::ensure!(
            !state.shutdown && state.active == 0,
            "pending application operations must finish before update activation"
        );
        state.shutdown = true;
        Ok(ShutdownLease(self.0.clone()))
    }

    /// Mine is quitting (Н3): from now on no write starts, except one nested
    /// in a write already running on its thread, and this waits up to
    /// `deadline` for the writes that began. The gate stays closed: the
    /// process ends after this.
    pub fn close_for_exit(&self, deadline: Duration) -> ExitDrain {
        let started = Instant::now();
        let mut state = self.0.state();
        state.closing = true;
        while state.active > 0 {
            let Some(left) = deadline.checked_sub(started.elapsed()) else {
                return ExitDrain::TimedOut {
                    running: state.active,
                };
            };
            state = self
                .0
                .ended
                .wait_timeout(state, left)
                .map_or_else(|poisoned| poisoned.into_inner().0, |(state, _)| state);
        }
        ExitDrain::Drained
    }
}
impl Drop for SourceWriteLease {
    fn drop(&mut self) {
        {
            let mut state = self.gate.state();
            state.active -= 1;
            if let Some(held) = state.held.get_mut(&self.thread) {
                *held -= 1;
                if *held == 0 {
                    state.held.remove(&self.thread);
                }
            }
        }
        self.gate.ended.notify_all();
    }
}
impl Drop for ShutdownLease {
    fn drop(&mut self) {
        self.0.state().shutdown = false;
    }
}
pub fn begin_write() -> Result<SourceWriteLease> {
    WRITERS.write()
}
pub fn begin_shutdown() -> Result<ShutdownLease> {
    WRITERS.shutdown()
}
/// Mine is quitting: refuse new writes and wait for the running ones
/// (SPEC_DEEP_AUDIT.md, Н3).
pub fn close_for_exit(deadline: Duration) -> ExitDrain {
    WRITERS.close_for_exit(deadline)
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

    /// Е2.1: quitting waits for a write that has begun, and no new one starts
    /// meanwhile; a write nested in the running one still goes on.
    #[test]
    fn quitting_waits_for_a_running_write_and_starts_no_new_one() {
        let gate = WriterGate::default();
        let outer = gate.write().unwrap();
        let begun = std::sync::Barrier::new(2);
        let drained = std::thread::scope(|scope| {
            let waiting = scope.spawn(|| {
                begun.wait();
                gate.close_for_exit(Duration::from_secs(10))
            });
            begun.wait();
            std::thread::sleep(Duration::from_millis(200));
            // A write on another thread is refused while the app quits...
            let elsewhere = std::thread::scope(|inner| inner.spawn(|| gate.write().is_err()).join().unwrap());
            assert!(elsewhere, "a new write began while the app was quitting");
            // ...one nested in the running write on its thread is not.
            let nested = gate.write().expect("a nested write finishes the running mutation");
            drop(nested);
            assert!(!waiting.is_finished(), "the exit did not wait for the running write");
            drop(outer);
            waiting.join().unwrap()
        });
        assert_eq!(drained, ExitDrain::Drained);
        assert!(gate.write().is_err(), "the gate stays closed after the exit");
    }

    #[test]
    fn quitting_stops_waiting_at_its_deadline() {
        let gate = WriterGate::default();
        let _stuck = gate.write().unwrap();
        let started = Instant::now();
        assert_eq!(
            gate.close_for_exit(Duration::from_millis(200)),
            ExitDrain::TimedOut { running: 1 }
        );
        assert!(started.elapsed() < Duration::from_secs(5));
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
    Validate { path: PathBuf, reason: String },
    /// The file no longer holds what the operation was built from. Nothing
    /// was overwritten; the other version stays.
    Changed {
        path: PathBuf,
        preserved: Option<PathBuf>,
    },
    /// The Trash answered that it took the file at `path`, and the file is
    /// still there (SPEC_DEEP_AUDIT.md, Е1.11). It is back at `path`, or at
    /// `kept` when a new file took its path meanwhile.
    NotTrashed {
        path: PathBuf,
        kept: Option<PathBuf>,
    },
    /// The Trash refused the file at `path`; nothing was deleted.
    /// `permission`: macOS denied Mine access to it.
    TrashRefused {
        path: PathBuf,
        permission: bool,
    },
    Stage {
        path: PathBuf,
        #[source]
        source: anyhow::Error,
    },
    CommitFile {
        path: PathBuf,
        #[source]
        source: anyhow::Error,
    },
    CommitIndex {
        operation: &'static str,
        #[source]
        source: anyhow::Error,
    },
    Rollback {
        original: String,
        failures: Vec<PathBuf>,
    },
}

/// `{}` names the failure and Mine's own step under it, such as
/// `delete <path>`; `{:#}` goes on down the causes to the reason the system
/// gave, the way anyhow renders a chain. A person reads the alternate form:
/// the plain one showed a failed delete with no reason at all (08.10.2026).
/// The causes stay reachable through `source()`, so code that walks them
/// still finds the error it looks for.
impl std::fmt::Display for SourceMutationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let cause = match self {
            Self::Validate { path, reason } => {
                return write!(f, "invalid source mutation for {}: {reason}", path.display());
            }
            Self::Changed { path, preserved } => {
                return write!(
                    f,
                    "{} changed outside Mine; nothing was overwritten{}",
                    path.display(),
                    preserved_note(preserved)
                );
            }
            // The words the person reads (decision of 14.10.2026); the
            // system's own words and where a displaced file went are in the
            // log (`commit_file_error`).
            Self::NotTrashed { path, .. } => return f.write_str(&trash_refusal_text(path, false)),
            Self::TrashRefused { path, permission } => {
                return f.write_str(&trash_refusal_text(path, *permission));
            }
            Self::Rollback { original, .. } => {
                return write!(f, "source mutation rollback was incomplete after: {original}");
            }
            Self::Stage { path, source } => {
                write!(f, "failed to stage source mutation for {}", path.display())?;
                source
            }
            Self::CommitFile { path, source } => {
                write!(f, "failed to publish source mutation for {}", path.display())?;
                source
            }
            Self::CommitIndex { operation, source } => {
                write!(f, "failed to commit source index operation '{operation}'")?;
                source
            }
        };
        if f.alternate() {
            write!(f, ": {cause:#}")
        } else {
            write!(f, ": {cause}")
        }
    }
}

fn preserved_note(preserved: &Option<PathBuf>) -> String {
    preserved
        .as_ref()
        .map(|path| format!("; displaced version kept at {}", path.display()))
        .unwrap_or_default()
}

/// What a refused move to the Trash says: the file's name, never its path,
/// and, when macOS denied access, where to allow it (SPEC_DEEP_AUDIT.md,
/// «Решения пользователя 14.10.2026»).
#[must_use]
pub fn trash_refusal_text(path: &Path, permission: bool) -> String {
    let name = path
        .file_name()
        .map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned());
    let mut text = format!("Could not move “{name}” to the Trash. Nothing was deleted.");
    if permission {
        text.push('\n');
        text.push_str(TRASH_PERMISSION_HINT);
    }
    text
}

/// The second line of a refusal macOS gave for lack of access.
pub const TRASH_PERMISSION_HINT: &str =
    "Allow Mine to access iCloud Drive in System Settings, Privacy & Security, Files and Folders.";

/// A publication error, typed as `Changed` when an outside edit won, as
/// `NotTrashed` when the Trash left the file and as `TrashRefused` when it
/// would not take it. The Trash's own words go to the log only.
fn commit_file_error(path: &Path, source: anyhow::Error) -> SourceMutationError {
    if let Some(left) = source.chain().find_map(|cause| cause.downcast_ref::<NotTrashed>()) {
        log::warn!("{source:#}");
        return SourceMutationError::NotTrashed {
            path: left.path.clone(),
            kept: left.kept.clone(),
        };
    }
    if let Some(refused) = source.chain().find_map(|cause| cause.downcast_ref::<files::TrashRefused>()) {
        log::warn!("{source:#}");
        return SourceMutationError::TrashRefused {
            path: refused.path.clone(),
            permission: refused.permission,
        };
    }
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
    /// The file sent to the Trash. With `expected`, it goes only while it
    /// holds those bytes and is still `read`, the file they were read from.
    /// Nothing is kept beside it: a second name of the file let the iCloud
    /// Trash take that name and leave the file (SPEC_DEEP_AUDIT.md, Е1.11).
    /// Once published, `trashed` is where the Trash put it, `None` when the
    /// file was already gone; rollback moves it back from there.
    Trashed {
        expected: Option<Vec<u8>>,
        read: FileId,
        trashed: Option<files::TrashedTo>,
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
            original: format!("{error:#}"),
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
            let read = match expected {
                Some(expected) => read_delete_source(&write.path, expected)?,
                None => FileId::at(&write.path).map_err(|source| SourceMutationError::Stage {
                    path: write.path.clone(),
                    source: source.context("failed to open delete source"),
                })?,
            };
            Ok(OriginalSource::Trashed {
                expected: expected.clone(),
                read,
                trashed: None,
            })
        }
        SourceFileContent::Rename { source, rewrite } => {
            // The source's own name in other letter case finds the source
            // where the disk ignores case: no other file stands there.
            if write.path.exists() && !files::names_same_entry(source, &write.path) {
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

/// Which file a checked delete takes: the one at `path` now, if it holds
/// `expected`. Its identity and bytes are read through one open handle, so
/// they are the identity of exactly the bytes compared.
fn read_delete_source(
    path: &Path,
    expected: &[u8],
) -> std::result::Result<FileId, SourceMutationError> {
    use std::io::Read;
    let changed = || SourceMutationError::Changed {
        path: path.to_path_buf(),
        preserved: None,
    };
    let unreadable = |error: std::io::Error| SourceMutationError::Validate {
        path: path.to_path_buf(),
        reason: format!("delete source is unreadable: {error}"),
    };
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(changed()),
        Err(error) => return Err(unreadable(error)),
    };
    let read = FileId::of(&file.metadata().map_err(unreadable)?);
    let mut held = Vec::with_capacity(expected.len());
    file.read_to_end(&mut held).map_err(unreadable)?;
    if held == expected {
        Ok(read)
    } else {
        Err(changed())
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
        OriginalSource::Trashed { expected, read, .. } => {
            let trashed = match expected {
                Some(expected) => {
                    // A cheap refusal first; the check that holds follows.
                    ensure_unchanged(&file.path, expected).map_err(failed)?;
                    #[cfg(test)]
                    hooks::run_before_checked_trash(&file.path);
                    Some(trash_if_unchanged(&file.path, *read, expected).map_err(failed)?)
                }
                None => trash_as_is(&file.path)
                    .with_context(|| format!("delete {}", file.path.display()))
                    .map_err(failed)?,
            };
            Ok(OriginalSource::Trashed {
                expected: expected.clone(),
                read: *read,
                trashed,
            })
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
///
/// Once the source is aside, every way out but success undoes the rename
/// here: the caller's rollback knows only what publication returned, and an
/// error leaves it nothing to restore (`SPEC_AUDIT_FIXES.md`, Ф2, Г1.9).
fn publish_rewritten_rename(
    temp: &Path,
    source: &Path,
    destination: &Path,
    expected: &[u8],
) -> Result<(PathBuf, files::FileFingerprint)> {
    if files::names_same_entry(source, destination) {
        return publish_rewritten_respelling(temp, source, destination, expected);
    }
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
    #[cfg(test)]
    hooks::run_after_move_aside(&aside);
    let read = std::fs::read(&aside);
    if matches!(&read, Ok(bytes) if bytes == expected) {
        return Ok((aside, published));
    }
    let preserved = match files::rename_exclusive(&aside, source) {
        Ok(()) => None,
        Err(_) => Some(aside.clone()),
    };
    files::remove_if_unchanged(destination, &published)?;
    match read {
        Ok(_) => Err(files::SourceChanged {
            path: source.to_path_buf(),
            preserved,
        }
        .into()),
        Err(error) => {
            let error = anyhow::Error::new(error)
                .context(format!("read back rename source {}", aside.display()));
            Err(match preserved {
                None => error,
                Some(kept) => {
                    error.context(format!("the source is kept at {}", kept.display()))
                }
            })
        }
    }
}

/// [`publish_rewritten_rename`] when the new name is the source's own name in
/// other letter case, on a disk that ignores case (06.10.2026). The new name
/// finds the source until the source leaves it, so nothing can be linked there
/// first: the source moves aside in one step, is checked there, and only then
/// the rewritten file takes the new name. Every way out but success puts the
/// source back under its name; a file that took the name meanwhile keeps it,
/// and the source stays aside.
fn publish_rewritten_respelling(
    temp: &Path,
    source: &Path,
    destination: &Path,
    expected: &[u8],
) -> Result<(PathBuf, files::FileFingerprint)> {
    let aside = files::aside_path(source, "rename-original");
    if let Err(error) = std::fs::rename(source, &aside) {
        return Err(files::SourceChanged {
            path: source.to_path_buf(),
            preserved: None,
        })
        .with_context(|| format!("rename source vanished: {error}"));
    }
    #[cfg(test)]
    hooks::run_after_move_aside(&aside);
    let failure = match std::fs::read(&aside) {
        Ok(bytes) if bytes == expected => match link_published(temp, destination) {
            Ok(published) => return Ok((aside, published)),
            Err(error) => error,
        },
        Ok(_) => files::SourceChanged {
            path: source.to_path_buf(),
            preserved: None,
        }
        .into(),
        Err(error) => anyhow::Error::new(error)
            .context(format!("read back rename source {}", aside.display())),
    };
    if files::rename_exclusive(&aside, source).is_ok() {
        return Err(failure);
    }
    Err(anyhow::Error::new(files::SourceChanged {
        path: source.to_path_buf(),
        preserved: Some(aside),
    })
    .context(format!("{failure:#}")))
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
/// Ф2, В1.2), and say where the Trash put it.
///
/// The Trash takes the file from its own place, so Finder's Put Back has a
/// place to return it to (SPEC_DEEP_AUDIT.md, Е5.9). Until 13.10.2026 the
/// file first left for a hidden folder beside it and was trashed from there:
/// Put Back pointed at that folder, gone a moment later. A comparison at the
/// path proves nothing about the moment the Trash takes the file: an editor
/// that saves by replacing the file (iCloud, safe-save editors, git) puts a
/// new file there, and the Trash takes whatever stands at the path. So the
/// file the Trash took is compared with the bytes read; another one goes
/// back to the path and the operation refuses.
///
/// The file has one name when the Trash is asked to take it, and the Trash
/// must have taken it: the iCloud Trash once took a second name of a page and
/// left the page (SPEC_DEEP_AUDIT.md, Е1.11). A file the Trash left where it
/// was refuses the operation.
fn trash_if_unchanged(path: &Path, read: FileId, expected: &[u8]) -> Result<files::TrashedTo> {
    let found = match std::fs::symlink_metadata(path) {
        Ok(found) => FileId::of(&found),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(files::SourceChanged {
                path: path.to_path_buf(),
                preserved: None,
            }
            .into());
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    };
    if found != read || !std::fs::read(path).is_ok_and(|bytes| bytes == expected) {
        return Err(files::SourceChanged {
            path: path.to_path_buf(),
            preserved: None,
        }
        .into());
    }
    let trashed = files::trash_user_file(path).with_context(|| format!("delete {}", path.display()))?;
    if FileId::at(path).is_ok_and(|now| now == read) {
        return Err(NotTrashed {
            path: path.to_path_buf(),
            kept: None,
        }
        .into());
    }
    ensure_trashed_unchanged(path, &trashed, expected)?;
    Ok(trashed)
}

/// Move `path` to the Trash whatever it holds, and say where the Trash put
/// it; `None` when no file stands there. A file the Trash left in its place
/// refuses the operation, as for a checked delete (Е1.11). A new file
/// written at the path once this one left is someone else's, not a refusal.
fn trash_as_is(path: &Path) -> Result<Option<files::TrashedTo>> {
    let before = match std::fs::symlink_metadata(path) {
        Ok(found) => FileId::of(&found),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    };
    let trashed = files::trash_user_file(path)?;
    if FileId::at(path).is_ok_and(|now| now == before) {
        return Err(NotTrashed {
            path: path.to_path_buf(),
            kept: None,
        }
        .into());
    }
    Ok(Some(trashed))
}

/// The Trash answered that it took a file, and the file is still there
/// (SPEC_DEEP_AUDIT.md, Е1.11). The file is back at `path`, or at `kept`
/// when a new file took its path meanwhile.
#[derive(Debug, Error)]
#[error("the Trash did not take {}{}", path.display(), kept_note(kept))]
struct NotTrashed {
    path: PathBuf,
    kept: Option<PathBuf>,
}

fn kept_note(kept: &Option<PathBuf>) -> String {
    kept.as_ref().map_or_else(
        || "; the file stays where it was".to_string(),
        |kept| format!("; the file is kept at {}", kept.display()),
    )
}

/// After a checked delete: an edit written into the file in place while it
/// was moving to the Trash shows in the file the Trash holds. Such a file is
/// put back and the operation refused. A Trash that did not say where it put
/// the file, or whose file cannot be read, leaves nothing to compare: the
/// file left its path for the Trash, and the delete stands.
fn ensure_trashed_unchanged(path: &Path, trashed: &files::TrashedTo, expected: &[u8]) -> Result<()> {
    let files::TrashedTo::Path(at) = trashed else {
        return Ok(());
    };
    match std::fs::read(at) {
        Ok(held) if held == expected => Ok(()),
        Ok(_) => {
            // When a newer version already stands at `path` again, the
            // put-back is refused and the edited file stays in the Trash.
            let _ = bring_back_from_trash(at, path);
            Err(files::SourceChanged {
                path: path.to_path_buf(),
                preserved: None,
            }
            .into())
        }
        Err(error) => {
            log::warn!("cannot read {} back from the Trash: {error}", at.display());
            Ok(())
        }
    }
}

/// Move a file the Trash took back to `path`, unless a file stands there.
fn bring_back_from_trash(at: &Path, path: &Path) -> Result<()> {
    files::move_exclusive(at, path)?;
    files::sync_parent_directory(path)
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
            OriginalSource::Trashed { trashed: None, .. } => Ok(()),
            OriginalSource::Trashed {
                trashed: Some(files::TrashedTo::Path(at)),
                ..
            } => bring_back_from_trash(at, path),
            OriginalSource::Trashed {
                trashed: Some(files::TrashedTo::Unreported),
                ..
            } => Err(anyhow::anyhow!(
                "the Trash did not say where it put {}",
                path.display()
            )),
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

fn cleanup_original(original: &OriginalSource) {
    match original {
        OriginalSource::Rewritten {
            aside: Some(path), ..
        } => {
            if std::fs::remove_file(path).is_ok() {
                let _ = files::sync_parent_directory(path);
            }
        }
        // A deleted file stays in the Trash; nothing of it is kept here.
        OriginalSource::Absent(_)
        | OriginalSource::Bytes { .. }
        | OriginalSource::Trashed { .. }
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
    let original_message = format!("{original:#}");
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

    thread_local! {
        /// Runs once after a rewritten rename has published the new file and
        /// moved the source aside, before it reads the source back.
        static AFTER_MOVE_ASIDE: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    pub(crate) fn run_after_move_aside(aside: &Path) {
        if let Some(hook) = AFTER_MOVE_ASIDE.with(|slot| slot.borrow_mut().take()) {
            hook(aside);
        }
    }

    /// Run `hook` with the place the next rewritten rename moves its source
    /// aside to, right after the move.
    pub(crate) fn after_next_move_aside(hook: impl FnOnce(&Path) + 'static) {
        AFTER_MOVE_ASIDE.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
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

    /// The dialog showed `delete <path>` and no reason: the plain form stops
    /// at Mine's own step (08.10.2026).
    #[test]
    fn failed_publication_reads_down_to_the_system_reason() {
        let refusal = std::io::Error::other("Not authorized to send Apple events to Finder. (-1743)");
        let error = SourceMutationError::CommitFile {
            path: PathBuf::from("/vault/Cards/Note.md"),
            source: anyhow::Error::new(refusal)
                .context("failed to move files to the system Trash")
                .context("delete /vault/Cards/Note.md"),
        };
        assert_eq!(
            format!("{error:#}"),
            "failed to publish source mutation for /vault/Cards/Note.md: \
             delete /vault/Cards/Note.md: failed to move files to the system Trash: \
             Not authorized to send Apple events to Finder. (-1743)"
        );
        // Code that walks the causes still finds them, each once.
        assert!(std::error::Error::source(&error).is_some());
        let walked = format!("{:#}", anyhow::Error::new(error));
        assert_eq!(walked.matches("(-1743)").count(), 1, "{walked}");
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
    /// one, not the one read. The new version stays where it is and the
    /// operation refuses.
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

    /// Whether the test Trash of this process holds a file with `bytes`.
    fn trash_holds(bytes: &[u8]) -> bool {
        let folder = std::env::temp_dir()
            .join("mine-test-trash")
            .join(std::process::id().to_string());
        std::fs::read_dir(folder).is_ok_and(|entries| {
            entries
                .flatten()
                .any(|entry| std::fs::read(entry.path()).is_ok_and(|held| held == bytes))
        })
    }

    /// Bytes no other test writes, so the Trash shared by the tests of this
    /// process tells this test's file apart.
    fn unique_bytes(label: &str) -> Vec<u8> {
        format!(
            "{label} {:?} {}",
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
        .into_bytes()
    }

    /// SPEC_DEEP_AUDIT.md, Е1.11: the iCloud Trash took the second name a
    /// delete kept of a collection page and left the page in its hidden
    /// holder. The test Trash takes another name of a file whenever there is
    /// one; a delete gives it none, and the page itself goes, nothing hidden
    /// is left beside it.
    #[test]
    fn a_checked_delete_sends_the_file_itself_to_the_trash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Проба 2.md");
        let page = unique_bytes("page");
        std::fs::write(&path, &page).unwrap();
        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::delete_if_unchanged(
            path.clone(),
            page.clone(),
        )])
        .unwrap();

        staged.commit().unwrap().finalize();

        assert!(!path.exists());
        assert!(hidden_leftovers(dir.path()).is_empty(), "{:?}", hidden_leftovers(dir.path()));
        assert!(trash_holds(&page));
    }

    /// Е5.9: a checked delete asks the Trash for the file at its own place.
    /// Finder's Put Back returns a file to where the Trash took it from;
    /// until 13.10.2026 that was a hidden folder beside the note, gone a
    /// moment later.
    #[test]
    fn a_checked_delete_trashes_the_file_from_its_own_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Put back.md");
        let page = unique_bytes("put back");
        std::fs::write(&path, &page).unwrap();
        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::delete_if_unchanged(
            path.clone(),
            page.clone(),
        )])
        .unwrap();
        files::test_trash::hooks::take_asked();

        staged.commit().unwrap().finalize();

        assert_eq!(files::test_trash::hooks::take_asked(), vec![path]);
        assert!(trash_holds(&page));
    }

    /// Е1.11 for a delete that takes a file whatever it holds (media).
    #[test]
    fn a_delete_sends_the_file_itself_to_the_trash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.jpg");
        let media = unique_bytes("media");
        std::fs::write(&path, &media).unwrap();
        let staged =
            StagedSourceMutation::stage(vec![SourceFileWrite::delete(path.clone())]).unwrap();

        staged.commit().unwrap().finalize();

        assert!(!path.exists());
        assert!(hidden_leftovers(dir.path()).is_empty(), "{:?}", hidden_leftovers(dir.path()));
        assert!(trash_holds(&media));
    }

    /// Е1.11: the Trash answers that it took the page and leaves it. The page
    /// is back in its place, the files published before it are withdrawn,
    /// nothing hidden is left, and the refusal names the page.
    #[test]
    fn a_file_the_trash_left_goes_back_and_nothing_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let created = dir.path().join("merged.md");
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"read by Mine").unwrap();
        let staged = StagedSourceMutation::stage(vec![
            SourceFileWrite::create(created.clone(), b"merged".to_vec()),
            SourceFileWrite::delete_if_unchanged(path.clone(), b"read by Mine".to_vec()),
        ])
        .unwrap();
        files::test_trash::hooks::leave_next_in_place();

        let error = staged.commit().unwrap_err();

        assert!(
            matches!(&error, SourceMutationError::NotTrashed { path: left, kept: None } if left == &path),
            "{error}"
        );
        // Decision of 14.10.2026: the file's name, never its path.
        assert_eq!(format!("{error:#}"), "Could not move “note.md” to the Trash. Nothing was deleted.");
        assert_eq!(std::fs::read(&path).unwrap(), b"read by Mine");
        assert!(!created.exists());
        assert!(hidden_leftovers(dir.path()).is_empty(), "{:?}", hidden_leftovers(dir.path()));
    }

    /// Decision of 14.10.2026: a Trash that refuses the file says so in one
    /// sentence with the file's name; a refusal for lack of access adds where
    /// to allow it; the system's own words go to the log only. Nothing is
    /// deleted.
    #[test]
    fn a_file_the_trash_refused_names_the_file_and_the_permission() {
        let capture = crate::test_log::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DOWN THE SPINAL LADDER.md");
        std::fs::write(&path, b"card").unwrap();
        let staged =
            StagedSourceMutation::stage(vec![SourceFileWrite::delete_if_unchanged(path.clone(), b"card".to_vec())])
                .unwrap();
        files::test_trash::hooks::refuse_next(true);

        let error = staged.commit().unwrap_err();

        assert!(matches!(error, SourceMutationError::TrashRefused { permission: true, .. }), "{error}");
        assert_eq!(
            format!("{error:#}"),
            "Could not move “DOWN THE SPINAL LADDER.md” to the Trash. Nothing was deleted.\nAllow Mine to access iCloud Drive in System Settings, Privacy & Security, Files and Folders."
        );
        assert!(!format!("{error:#}").contains(&dir.path().display().to_string()));
        assert_eq!(std::fs::read(&path).unwrap(), b"card");
        let warnings = capture.warnings();
        assert!(warnings.iter().any(|line| line.contains("don’t have permission")), "{warnings:?}");

        // Refused for another reason: the one sentence alone.
        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::delete(path.clone())]).unwrap();
        files::test_trash::hooks::refuse_next(false);
        let error = staged.commit().unwrap_err();
        assert_eq!(
            format!("{error:#}"),
            "Could not move “DOWN THE SPINAL LADDER.md” to the Trash. Nothing was deleted."
        );
        assert!(path.exists());
    }

    /// Е1.11 for a delete that takes a file whatever it holds.
    #[test]
    fn a_media_file_the_trash_left_refuses_the_delete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.jpg");
        std::fs::write(&path, b"media").unwrap();
        let staged =
            StagedSourceMutation::stage(vec![SourceFileWrite::delete(path.clone())]).unwrap();
        files::test_trash::hooks::leave_next_in_place();

        let error = staged.commit().unwrap_err();

        assert!(matches!(error, SourceMutationError::NotTrashed { .. }), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"media");
    }

    /// В1.2 without a second name of the file: an edit written into the page
    /// in place while it moved to the Trash shows in the Trash's file. The
    /// edited page comes back to its path and the delete refuses.
    #[test]
    fn an_edit_written_while_the_file_moved_to_the_trash_brings_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"read by Mine").unwrap();
        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::delete_if_unchanged(
            path.clone(),
            b"read by Mine".to_vec(),
        )])
        .unwrap();
        files::test_trash::hooks::after_next_move(|trashed| {
            std::fs::write(trashed, b"edited while it moved").unwrap();
        });

        let error = staged.commit().unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"edited while it moved");
        assert!(hidden_leftovers(dir.path()).is_empty(), "{:?}", hidden_leftovers(dir.path()));
    }

    /// Rollback brings a deleted file back from the Trash: the same file at
    /// its path, and the Trash no longer holds it.
    #[test]
    fn delete_rollback_brings_the_file_back_from_the_trash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large-media.bin");
        let media = unique_bytes("rolled back");
        std::fs::write(&path, &media).unwrap();
        let staged =
            StagedSourceMutation::stage(vec![SourceFileWrite::delete(path.clone())]).unwrap();

        let committed = staged.commit().unwrap();
        assert!(!path.exists());
        assert!(trash_holds(&media));
        committed.rollback("injected database failure").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), media);
        assert!(!trash_holds(&media));
        assert!(hidden_leftovers(dir.path()).is_empty(), "{:?}", hidden_leftovers(dir.path()));
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

    /// Г1.9: the source, already moved aside, cannot be read back. The rename
    /// is undone like a mismatch: the source returns to its name with its
    /// bytes, the new file is withdrawn, nothing hidden is left.
    #[test]
    fn rewritten_rename_restores_the_source_when_it_cannot_be_read_back() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        std::fs::write(&old, b"original").unwrap();
        let readable = std::fs::metadata(&old).unwrap().permissions();
        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old.clone(),
            new.clone(),
            b"original".to_vec(),
            b"rewritten".to_vec(),
        )])
        .unwrap();
        hooks::after_next_move_aside(|aside| {
            std::fs::set_permissions(aside, std::fs::Permissions::from_mode(0o000)).unwrap();
        });

        let error = staged.commit().unwrap_err();

        assert!(matches!(error, SourceMutationError::CommitFile { .. }), "{error}");
        assert!(!new.exists());
        std::fs::set_permissions(&old, readable).unwrap();
        assert_eq!(std::fs::read(&old).unwrap(), b"original");
        assert!(hidden_leftovers(dir.path()).is_empty(), "{:?}", hidden_leftovers(dir.path()));
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

    fn visible_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| !name.starts_with('.'))
            .collect();
        names.sort();
        names
    }

    /// 06.10.2026: a new name that is the source's own name in other letter
    /// case finds the source where the disk ignores case (the macOS default).
    /// The rename respells the file, moved as it is or rewritten; rollback
    /// brings back the old spelling and bytes, and nothing hidden stays. On a
    /// disk that tells case apart it is an ordinary rename.
    #[test]
    fn a_rename_to_another_case_of_its_own_name_respells_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.md");
        let rewritten = dir.path().join("rewritten.md");
        let respell = || {
            std::fs::write(&plain, b"plain").unwrap();
            std::fs::write(&rewritten, b"original").unwrap();
            StagedSourceMutation::stage(vec![
                SourceFileWrite::rename(plain.clone(), dir.path().join("Plain.md")),
                SourceFileWrite::rename_with_bytes(
                    rewritten.clone(),
                    dir.path().join("Rewritten.md"),
                    b"original".to_vec(),
                    b"respelled".to_vec(),
                ),
            ])
            .unwrap()
            .commit()
            .unwrap()
        };

        let committed = respell();
        assert_eq!(visible_names(dir.path()), ["Plain.md", "Rewritten.md"]);
        assert_eq!(std::fs::read(dir.path().join("Rewritten.md")).unwrap(), b"respelled");
        committed.rollback("injected index failure").unwrap();
        assert_eq!(visible_names(dir.path()), ["plain.md", "rewritten.md"]);
        assert_eq!(std::fs::read(&plain).unwrap(), b"plain");
        assert_eq!(std::fs::read(&rewritten).unwrap(), b"original");
        assert!(hidden_leftovers(dir.path()).is_empty(), "{:?}", hidden_leftovers(dir.path()));

        respell().finalize();
        assert_eq!(visible_names(dir.path()), ["Plain.md", "Rewritten.md"]);
        assert_eq!(std::fs::read(dir.path().join("Plain.md")).unwrap(), b"plain");
        assert!(hidden_leftovers(dir.path()).is_empty(), "{:?}", hidden_leftovers(dir.path()));
    }

    /// 06.10.2026: a respelling whose source changed after it was read is
    /// refused, and the edited source keeps its name.
    #[test]
    fn a_respelling_refuses_when_the_source_was_edited_meanwhile() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("note.md");
        std::fs::write(&old, b"read by Mine").unwrap();
        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old.clone(),
            dir.path().join("Note.md"),
            b"read by Mine".to_vec(),
            b"Mine rewrite".to_vec(),
        )])
        .unwrap();
        replace_from_outside(&old, b"edited meanwhile");

        let error = staged.commit().unwrap_err();

        assert!(matches!(error, SourceMutationError::Changed { .. }), "{error}");
        assert_eq!(visible_names(dir.path()), ["note.md"]);
        assert_eq!(std::fs::read(&old).unwrap(), b"edited meanwhile");
        assert!(hidden_leftovers(dir.path()).is_empty(), "{:?}", hidden_leftovers(dir.path()));
    }
}
