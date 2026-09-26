//! SQLite connection ownership.
//!
//! Schema evolution is owned by `storage::migrations`; this module only opens
//! connections and applies connection-scoped PRAGMAs.
//!
//! Contract: SPEC_STORAGE.md#storage-db

use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{Context, Result};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags};
use thiserror::Error;

use crate::domain::vault::VaultLayout;

use super::migrations;

pub use super::migrations::{CURRENT_SCHEMA_VERSION, GRAPH_LINK_INDEX_VERSION};

static CONNECTION_INIT_LOCK: Mutex<()> = Mutex::new(());

const ACTIVE_SLOT_FILE: &str = "active-slot";

/// Selection failures retain environmental causes instead of triggering recovery.
#[derive(Debug, Error)]
pub enum IndexSelectionError {
    #[error("index storage is unavailable at {path}: {source}")]
    Unavailable {
        path: PathBuf,
        #[source]
        source: anyhow::Error,
    },
    #[error("index recovery slots exhausted at {path}")]
    SlotsExhausted { path: PathBuf },
}

fn slot_path(directory: &Path, slot: u64) -> PathBuf {
    if slot == 0 {
        directory.join("index.db")
    } else {
        directory.join(format!("recovery-{slot}")).join("index.db")
    }
}

fn unavailable(path: &Path, source: impl Into<anyhow::Error>) -> IndexSelectionError {
    IndexSelectionError::Unavailable {
        path: path.to_path_buf(),
        source: source.into(),
    }
}

/// Choose a compatible generation under a process-safe, kernel-owned lock.
/// Damaged/foreign slots and their WAL stay in place, including open handles.
/// No cleanup of journals, history, shared legacy databases or old slots occurs.
pub fn resolve_vault_index(
    vault: VaultLayout,
) -> std::result::Result<VaultLayout, IndexSelectionError> {
    resolve_index_slot(vault, None)
}

/// Optional diagnostics inspect only an existing selected slot. They must not
/// create databases, repair pointers or change an unopened space's metadata.
pub fn existing_selected_index(vault: &VaultLayout) -> Result<Option<VaultLayout>> {
    let directory = vault.index_generation_dir();
    let slot = match std::fs::read(directory.join(ACTIVE_SLOT_FILE)) {
        Ok(bytes) => match std::str::from_utf8(&bytes)
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
        {
            Some(slot) => slot,
            None => return Ok(None),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.into()),
    };
    let path = slot_path(&directory, slot);
    if !path.is_file() || !compatible_slot(&path)? {
        return Ok(None);
    }
    Ok(Some(vault.clone().with_index_db_path(path)))
}

/// SQLite corruption is recoverable; busy, full disks and access errors are not.
pub fn is_index_corruption(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(cause.downcast_ref::<rusqlite::Error>(),
        Some(rusqlite::Error::SqliteFailure(code, _)) if matches!(code.code,
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase))
    })
}

/// Retire a corrupted slot without changing any bytes or active connections.
/// If another process already recovered it, reuse that process's selected slot.
pub fn recover_vault_index_after_error(
    vault: VaultLayout,
    error: &anyhow::Error,
) -> std::result::Result<VaultLayout, IndexSelectionError> {
    let damaged = vault.index_db_path();
    if !is_index_corruption(error) {
        return Err(unavailable(
            &damaged,
            anyhow::anyhow!("non-corruption index failure: {error:#}"),
        ));
    }
    resolve_index_slot(vault, Some(&damaged))
}

/// Open a vault snapshot with one automatic retry for detected data corruption.
/// The data read is the same block count required by the opening UI, not a full
/// SQLite integrity scan. Later query owners can use the same recovery signal.
pub fn open_vault_index(
    vault: VaultLayout,
) -> std::result::Result<(VaultLayout, Connection, usize), IndexSelectionError> {
    let selected = resolve_vault_index(vault)?;
    match open_snapshot(&selected.index_db_path()) {
        Ok((conn, count)) => Ok((selected, conn, count)),
        Err(error) if is_index_corruption(&error) => {
            let recovered = recover_vault_index_after_error(selected, &error)?;
            let path = recovered.index_db_path();
            let (conn, count) = open_snapshot(&path).map_err(|error| unavailable(&path, error))?;
            Ok((recovered, conn, count))
        }
        Err(error) => Err(unavailable(&selected.index_db_path(), error)),
    }
}

fn open_snapshot(path: &Path) -> Result<(Connection, usize)> {
    let conn = open_or_create(path)?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM blocks", [], |row| row.get(0))?;
    Ok((conn, count.try_into().context("invalid block count")?))
}

/// Execute a read-only projection query and rebuild once on a detected corrupt
/// data/FTS page. Source writes cannot run on either query connection.
/// The returned layout tells the session owner which recovered slot to adopt.
pub fn read_vault_projection<T>(
    vault: &VaultLayout,
    query: impl Fn(&Connection) -> Result<T>,
) -> Result<(VaultLayout, T)> {
    read_projection_with_recovery(vault, query, false)
}

/// Preserve a session's existing connection/cache on a successful first read.
pub fn read_vault_projection_from<T>(
    conn: &Connection,
    vault: &VaultLayout,
    query: impl Fn(&Connection) -> Result<T>,
) -> Result<(VaultLayout, T)> {
    recover_projection_read(vault, query(conn), query)
}

/// Recover after the caller releases its active-session lock following a read.
pub fn recover_projection_read<T>(
    vault: &VaultLayout,
    result: Result<T>,
    query: impl Fn(&Connection) -> Result<T>,
) -> Result<(VaultLayout, T)> {
    match result {
        Ok(value) => Ok((vault.clone(), value)),
        Err(error) if is_index_corruption(&error) => {
            let recovered = recover_vault_index_after_error(vault.clone(), &error)?;
            let writer = open_or_create(&recovered.index_db_path())?;
            super::reconcile::reconcile_vault(&writer, &recovered)?;
            drop(writer);
            let reader = open_read_only(&recovered.index_db_path())?;
            Ok((recovered, query(&reader)?))
        }
        Err(error) => Err(error),
    }
}

/// Search queries may refresh only derived search chunks/embeddings as before.
/// This retry boundary must never wrap a source mutation or save operation.
pub fn read_search_projection<T>(
    vault: &VaultLayout,
    query: impl Fn(&Connection) -> Result<T>,
) -> Result<(VaultLayout, T)> {
    read_projection_with_recovery(vault, query, true)
}

fn read_projection_with_recovery<T>(
    vault: &VaultLayout,
    query: impl Fn(&Connection) -> Result<T>,
    derived_search_writes: bool,
) -> Result<(VaultLayout, T)> {
    let attempt = |layout: &VaultLayout| -> Result<T> {
        let conn = if derived_search_writes {
            open_or_create(&layout.index_db_path())?
        } else {
            open_read_only(&layout.index_db_path())?
        };
        query(&conn)
    };
    match attempt(vault) {
        Ok(value) => Ok((vault.clone(), value)),
        Err(error) if is_index_corruption(&error) => {
            let recovered = recover_vault_index_after_error(vault.clone(), &error)?;
            let conn = open_or_create(&recovered.index_db_path())?;
            super::reconcile::reconcile_vault(&conn, &recovered)?;
            drop(conn);
            let value = attempt(&recovered)?;
            Ok((recovered, value))
        }
        Err(error) => Err(error),
    }
}

fn resolve_index_slot(
    vault: VaultLayout,
    damaged: Option<&Path>,
) -> std::result::Result<VaultLayout, IndexSelectionError> {
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| unavailable(&vault.index_generation_dir(), error))?;
    let directory = vault.index_generation_dir();
    std::fs::create_dir_all(&directory).map_err(|error| unavailable(&directory, error))?;
    let lock_path = directory.join("selection.lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| unavailable(&lock_path, error))?;
    lock.lock_exclusive()
        .map_err(|error| unavailable(&lock_path, error))?;
    let selector = directory.join(ACTIVE_SLOT_FILE);
    let mut initial_slot = None;
    let mut slot = match std::fs::read(&selector) {
        Ok(value) => match std::str::from_utf8(&value)
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
        {
            Some(slot) => {
                initial_slot = Some(slot);
                slot
            }
            None => {
                let mut random = [0u8; 16];
                getrandom::fill(&mut random)
                    .map_err(|error| unavailable(&selector, anyhow::anyhow!(error.to_string())))?;
                let evidence = directory.join(format!(
                    "invalid-selector-{:032x}",
                    u128::from_le_bytes(random)
                ));
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&evidence)
                    .map_err(|error| unavailable(&evidence, error))?;
                file.write_all(&value)
                    .and_then(|()| file.sync_all())
                    .map_err(|error| unavailable(&evidence, error))?;
                next_unused_slot(&directory).map_err(|error| unavailable(&directory, error))?
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(unavailable(&selector, error)),
    };
    let mut rejected = 0usize;
    const MAX_REJECTED_SLOTS: usize = 16;
    loop {
        let path = slot_path(&directory, slot);
        if !path.exists() {
            // A failed creation is environmental and is never retried in a loop.
            drop(open_or_create(&path).map_err(|error| unavailable(&path, error))?);
            super::files::write_atomically(&selector, slot.to_string().as_bytes())
                .map_err(|error| unavailable(&selector, error))?;
            return Ok(vault.with_index_db_path(path));
        }
        match if damaged == Some(path.as_path()) {
            Ok(false)
        } else {
            compatible_slot(&path)
        } {
            Ok(true) => {
                if initial_slot != Some(slot) {
                    super::files::write_atomically(&selector, slot.to_string().as_bytes())
                        .map_err(|error| unavailable(&selector, error))?;
                }
                return Ok(vault.with_index_db_path(path));
            }
            Ok(false) => {
                log::warn!(
                    "preserving incompatible or damaged index at {}",
                    path.display()
                );
                rejected += 1;
                slot = if rejected == MAX_REJECTED_SLOTS {
                    next_unused_slot(&directory).map_err(|error| unavailable(&directory, error))?
                } else {
                    slot.checked_add(1)
                        .ok_or_else(|| IndexSelectionError::SlotsExhausted {
                            path: directory.clone(),
                        })?
                };
            }
            Err(error) => return Err(unavailable(&path, error)),
        }
    }
}

fn next_unused_slot(directory: &Path) -> Result<u64> {
    let mut maximum = 0u64;
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if let Some(slot) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_prefix("recovery-"))
            .and_then(|value| value.parse::<u64>().ok())
        {
            maximum = maximum.max(slot);
        }
    }
    maximum
        .checked_add(1)
        .context("index recovery slots exhausted")
}

fn compatible_slot(path: &Path) -> Result<bool> {
    let check = (|| -> Result<bool> {
        let conn = open_read_only(path)?;
        let installed: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if installed != CURRENT_SCHEMA_VERSION {
            return Ok(false);
        }
        if let Err(error) = migrations::validate_schema(&conn) {
            // Missing tables/columns are incompatible. Access, busy, I/O and
            // disk-full failures must reach the caller without abandoning data.
            if error
                .chain()
                .any(|cause| cause.downcast_ref::<rusqlite::Error>().is_some())
            {
                return Err(error);
            }
            return Ok(false);
        }
        // Read only bounded schema metadata on the ordinary startup path.
        Ok(true)
    })();
    match check {
        Err(error) if is_index_corruption(&error) => Ok(false),
        other => other,
    }
}

/// A database exists before its first verified source reconciliation is ready.
pub fn index_is_ready(conn: &Connection) -> Result<bool> {
    conn.query_row(
        "SELECT ready FROM index_build_state WHERE singleton = 1",
        [],
        |row| row.get(0),
    )
    .context("failed to read index readiness")
}

/// Persist readiness only after a final source pass confirms the read model.
pub(crate) fn set_index_ready(conn: &Connection, ready: bool) -> Result<()> {
    conn.execute(
        "UPDATE index_build_state SET ready = ?1 WHERE singleton = 1",
        [ready],
    )
    .context("failed to publish index readiness")?;
    Ok(())
}

/// Open an existing database or create a new one at the given path.
pub fn open_or_create(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }
    let conn = Connection::open(path)
        .with_context(|| format!("failed to open database: {}", path.display()))?;
    init_connection(&conn)?;
    Ok(conn)
}

/// Open an existing database in read-only mode for route query paths.
pub fn open_read_only(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("failed to open database read-only: {}", path.display()))?;
    init_read_only_connection(&conn)?;
    Ok(conn)
}

/// Open a fully migrated in-memory database for tests.
pub fn open_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory().context("failed to open in-memory database")?;
    init_connection(&conn)?;
    Ok(conn)
}

fn init_connection(conn: &Connection) -> Result<()> {
    // SQLite's busy handler does not serialize concurrent journal-mode changes.
    // Keep connection PRAGMAs and migrations inside one process-owned boundary;
    // BEGIN IMMEDIATE remains the cross-process migration lock.
    let _guard = CONNECTION_INIT_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Refuse newer databases before journal PRAGMAs can change their bytes.
    let installed: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    anyhow::ensure!(installed <= CURRENT_SCHEMA_VERSION,
        "database schema version {installed} is newer than supported version {CURRENT_SCHEMA_VERSION}");
    apply_pragmas(conn)?;
    migrations::migrate_and_validate(conn)
}

fn init_read_only_connection(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA busy_timeout = 5000;
         PRAGMA query_only = ON;",
    )?;
    Ok(())
}

fn apply_pragmas(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA busy_timeout = 5000;
         PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
        ",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;

    fn scalar(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn fixture_vault(directory: &Path) -> VaultLayout {
        let source = directory.join("source");
        std::fs::create_dir_all(&source).unwrap();
        VaultLayout::with_derived_root(source, directory.join("derived"))
    }

    #[test]
    fn reliability_optional_diagnostics_never_create_or_repair_index() {
        let directory = tempfile::tempdir().unwrap();
        let vault = fixture_vault(directory.path());
        assert!(existing_selected_index(&vault).unwrap().is_none());
        assert!(!vault.derived_root().exists());
        let generation = vault.index_generation_dir();
        std::fs::create_dir_all(&generation).unwrap();
        let pointer = generation.join(ACTIVE_SLOT_FILE);
        std::fs::write(&pointer, b"malformed pointer").unwrap();
        assert!(existing_selected_index(&vault).unwrap().is_none());
        assert_eq!(std::fs::read(pointer).unwrap(), b"malformed pointer");
        assert!(!vault.index_db_path().exists());
    }

    #[test]
    fn reliability_optional_diagnostics_use_selected_recovery_slot() {
        let directory = tempfile::tempdir().unwrap();
        let vault = fixture_vault(directory.path());
        std::fs::create_dir_all(vault.index_generation_dir()).unwrap();
        std::fs::write(vault.index_db_path(), b"preserved damage").unwrap();
        let selected = resolve_vault_index(vault.clone()).unwrap();
        let diagnostic = existing_selected_index(&vault).unwrap().unwrap();
        assert_eq!(diagnostic.index_db_path(), selected.index_db_path());
        assert_eq!(
            std::fs::read(vault.index_db_path()).unwrap(),
            b"preserved damage"
        );
    }

    #[test]
    fn reliability_newer_shared_index_is_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let vault = fixture_vault(directory.path());
        std::fs::create_dir_all(vault.derived_root()).unwrap();
        let shared = vault.derived_root().join("index.db");
        let old = Connection::open(&shared).unwrap();
        old.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
            .unwrap();
        drop(old);
        let before = std::fs::read(&shared).unwrap();
        let selected = resolve_vault_index(vault).unwrap();
        let conn = open_or_create(&selected.index_db_path()).unwrap();
        assert!(!index_is_ready(&conn).unwrap());
        assert_eq!(std::fs::read(&shared).unwrap(), before);
        assert_ne!(selected.index_db_path(), shared);
    }

    #[test]
    fn reliability_corrupt_slot_is_preserved_and_recovery_is_reused() {
        let directory = tempfile::tempdir().unwrap();
        let vault = fixture_vault(directory.path());
        let original = vault.index_db_path();
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        std::fs::write(&original, b"corrupt database evidence").unwrap();
        std::fs::write(vault.derived_root().join("save-journal.json"), b"pending").unwrap();
        let selected = resolve_vault_index(vault.clone()).unwrap();
        assert_ne!(selected.index_db_path(), original);
        assert_eq!(
            std::fs::read(&original).unwrap(),
            b"corrupt database evidence"
        );
        assert_eq!(
            std::fs::read(vault.derived_root().join("save-journal.json")).unwrap(),
            b"pending"
        );
        assert_eq!(
            resolve_vault_index(vault).unwrap().index_db_path(),
            selected.index_db_path()
        );
    }

    #[test]
    fn reliability_newer_managed_slot_and_live_connection_are_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let vault = fixture_vault(directory.path());
        let old = open_or_create(&vault.index_db_path()).unwrap();
        old.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
            .unwrap();
        old.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        let before = std::fs::read(vault.index_db_path()).unwrap();
        let selected = resolve_vault_index(vault.clone()).unwrap();
        assert_ne!(selected.index_db_path(), vault.index_db_path());
        assert_eq!(
            scalar(&old, "PRAGMA user_version"),
            CURRENT_SCHEMA_VERSION + 1
        );
        assert_eq!(std::fs::read(vault.index_db_path()).unwrap(), before);
        assert!(open_or_create(&vault.index_db_path()).is_err());
        assert_eq!(std::fs::read(vault.index_db_path()).unwrap(), before);
    }

    #[test]
    fn reliability_valid_schema_with_corrupt_data_page_recovers_on_snapshot_read() {
        let directory = tempfile::tempdir().unwrap();
        let vault = resolve_vault_index(fixture_vault(directory.path())).unwrap();
        let conn = open_or_create(&vault.index_db_path()).unwrap();
        conn.execute("INSERT INTO blocks (slug, block_type, saved_at, body) VALUES ('broken', 'article', '2026-01-01T00:00:00Z', 'content')", []).unwrap();
        let page_size = scalar(&conn, "PRAGMA page_size") as usize;
        let root_page: i64 = conn
            .query_row(
                "SELECT rootpage FROM sqlite_master WHERE name = 'blocks'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        drop(conn);
        let mut bytes = std::fs::read(vault.index_db_path()).unwrap();
        bytes[(root_page as usize - 1) * page_size] = 0xff;
        std::fs::write(vault.index_db_path(), &bytes).unwrap();
        // sqlite_master and required table definitions remain readable.
        assert!(compatible_slot(&vault.index_db_path()).unwrap());
        let (recovered, conn, count) = open_vault_index(vault.clone()).unwrap();
        assert_ne!(recovered.index_db_path(), vault.index_db_path());
        assert_eq!(count, 0);
        assert!(!index_is_ready(&conn).unwrap());
        assert_eq!(std::fs::read(vault.index_db_path()).unwrap(), bytes);
    }

    #[test]
    fn reliability_busy_and_disk_full_do_not_trigger_slot_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let vault = resolve_vault_index(fixture_vault(directory.path())).unwrap();
        for code in [
            rusqlite::ffi::SQLITE_BUSY,
            rusqlite::ffi::SQLITE_FULL,
            rusqlite::ffi::SQLITE_IOERR,
        ] {
            let error: anyhow::Error =
                rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), None).into();
            assert!(!is_index_corruption(&error));
            assert!(recover_vault_index_after_error(vault.clone(), &error).is_err());
        }
        assert!(!vault.index_generation_dir().join("recovery-1").exists());
    }

    #[test]
    fn reliability_late_fts_read_recovers_once_without_source_changes() {
        let directory = tempfile::tempdir().unwrap();
        let vault = resolve_vault_index(fixture_vault(directory.path())).unwrap();
        let source = vault.root().join("Source.md");
        std::fs::write(&source, "# Search document\nneedle").unwrap();
        let original_source = std::fs::read(&source).unwrap();
        let conn = open_or_create(&vault.index_db_path()).unwrap();
        super::super::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let page_size = scalar(&conn, "PRAGMA page_size") as usize;
        let root_page: i64 = conn
            .query_row(
                "SELECT rootpage FROM sqlite_master WHERE name = 'blocks_fts_data'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        drop(conn);
        let mut evidence = std::fs::read(vault.index_db_path()).unwrap();
        evidence[(root_page as usize - 1) * page_size] = 0xff;
        std::fs::write(vault.index_db_path(), &evidence).unwrap();
        assert!(compatible_slot(&vault.index_db_path()).unwrap());
        let attempts = std::sync::atomic::AtomicUsize::new(0);
        let (recovered, count) = read_vault_projection(&vault, |conn| {
            attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM blocks_fts WHERE blocks_fts MATCH 'needle'",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(count, 1);
        assert_ne!(recovered.index_db_path(), vault.index_db_path());
        assert_eq!(std::fs::read(vault.index_db_path()).unwrap(), evidence);
        assert_eq!(std::fs::read(source).unwrap(), original_source);
        assert!(!vault.mine_dir().join("file-identity.json").exists());
    }

    #[test]
    fn reliability_late_busy_read_is_not_retried_and_read_owner_rejects_sql_writes() {
        let directory = tempfile::tempdir().unwrap();
        let vault = resolve_vault_index(fixture_vault(directory.path())).unwrap();
        let attempts = std::sync::atomic::AtomicUsize::new(0);
        let result: Result<(VaultLayout, ())> = read_vault_projection(&vault, |_| {
            attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                None,
            )
            .into())
        });
        assert!(result.is_err());
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!vault.index_generation_dir().join("recovery-1").exists());
        assert!(
            read_vault_projection(&vault, |conn| Ok(conn.execute("DELETE FROM blocks", [])?))
                .is_err()
        );
        assert!(!vault.index_generation_dir().join("recovery-1").exists());
    }

    #[test]
    fn reliability_concurrent_resolvers_share_one_recovery_slot() {
        let directory = tempfile::tempdir().unwrap();
        let vault = fixture_vault(directory.path());
        std::fs::create_dir_all(vault.index_generation_dir()).unwrap();
        std::fs::write(vault.index_db_path(), b"damaged").unwrap();
        let handles = (0..4)
            .map(|_| {
                let vault = vault.clone();
                std::thread::spawn(move || resolve_vault_index(vault).unwrap().index_db_path())
            })
            .collect::<Vec<_>>();
        let selected = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert!(selected.iter().all(|path| path == &selected[0]));
    }

    #[test]
    fn reliability_child_resolver() {
        let Some(root) = std::env::var_os("MINE_INDEX_PROCESS_FIXTURE") else {
            return;
        };
        let vault = fixture_vault(Path::new(&root));
        let vault = resolve_vault_index(vault).unwrap();
        let conn = open_or_create(&vault.index_db_path()).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert!(index_is_ready(&conn).unwrap());
    }

    #[test]
    fn reliability_processes_build_one_generation_without_duplicates() {
        let directory = tempfile::tempdir().unwrap();
        let vault = fixture_vault(directory.path());
        std::fs::write(vault.root().join("Plain.md"), "# One document").unwrap();
        std::fs::create_dir_all(vault.index_generation_dir()).unwrap();
        std::fs::write(vault.index_db_path(), b"damaged").unwrap();
        let children = (0..3)
            .map(|_| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "storage::db::tests::reliability_child_resolver"])
                    .env("MINE_INDEX_PROCESS_FIXTURE", directory.path())
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        for mut child in children {
            assert!(child.wait().unwrap().success());
        }
        let selected = resolve_vault_index(vault.clone()).unwrap();
        let conn = open_read_only(&selected.index_db_path()).unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM blocks"), 1);
        assert!(index_is_ready(&conn).unwrap());
        assert_eq!(std::fs::read(vault.index_db_path()).unwrap(), b"damaged");
    }

    #[test]
    fn reliability_environment_error_does_not_allocate_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let vault = fixture_vault(directory.path());
        std::fs::create_dir_all(vault.index_db_path()).unwrap();
        assert!(matches!(
            resolve_vault_index(vault.clone()),
            Err(IndexSelectionError::Unavailable { .. })
        ));
        assert!(!vault.index_generation_dir().join("recovery-1").exists());
    }

    #[test]
    fn reliability_interrupted_build_resumes_and_checks_changes_during_scan() {
        let directory = tempfile::tempdir().unwrap();
        let vault = resolve_vault_index(fixture_vault(directory.path())).unwrap();
        std::fs::write(vault.root().join("a.md"), "# Before").unwrap();
        std::fs::write(vault.root().join("b.md"), "# Second").unwrap();
        let conn = open_or_create(&vault.index_db_path()).unwrap();
        assert!(!index_is_ready(&conn).unwrap());
        drop(conn);
        let conn = open_or_create(&vault.index_db_path()).unwrap();
        let changed = std::sync::atomic::AtomicBool::new(false);
        let report = crate::storage::reconcile::reconcile_vault_with_progress(
            &conn,
            &vault,
            &|processed, _| {
                if processed == 2 && !changed.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    std::fs::write(vault.root().join("a.md"), "# Changed during build").unwrap();
                }
            },
        )
        .unwrap();
        assert!(report.is_fresh());
        assert!(index_is_ready(&conn).unwrap());
        let body: String = conn
            .query_row("SELECT body FROM blocks WHERE slug = 'a'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(body.contains("Changed during build"));
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM blocks"), 2);
    }

    #[test]
    fn reliability_unknown_selector_is_preserved_and_space_remains_available() {
        let directory = tempfile::tempdir().unwrap();
        let vault = fixture_vault(directory.path());
        std::fs::create_dir_all(vault.index_generation_dir()).unwrap();
        let selector = vault.index_generation_dir().join(ACTIVE_SLOT_FILE);
        std::fs::write(&selector, b"future format").unwrap();
        let selected = resolve_vault_index(vault.clone()).unwrap();
        assert!(selected.index_db_path().exists());
        let evidence = std::fs::read_dir(vault.index_generation_dir())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("invalid-selector-")
            })
            .unwrap();
        assert_eq!(std::fs::read(evidence).unwrap(), b"future format");
        assert_eq!(std::fs::read_to_string(selector).unwrap(), "1");
    }

    #[test]
    fn reliability_external_fixture() {
        let directory = tempfile::tempdir().unwrap();
        let vault = match (
            std::env::var_os("MINE_RELIABILITY_SOURCE"),
            std::env::var_os("MINE_RELIABILITY_DERIVED"),
        ) {
            (Some(source), Some(derived)) => {
                VaultLayout::with_derived_root(source.into(), derived.into())
            }
            (None, None) => {
                let vault = fixture_vault(directory.path());
                std::fs::write(
                    vault.root().join("Plain.md"),
                    "# Ordinary Markdown\nUnknown [[target]]",
                )
                .unwrap();
                vault
            }
            _ => panic!("fixture requires both source and derived paths"),
        };
        let vault = resolve_vault_index(vault).unwrap();
        let conn = open_or_create(&vault.index_db_path()).unwrap();
        let first = crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert!(first.is_fresh(), "{:?}", first.errors);
        let second = crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert_eq!(second.content_reads, 0);
        assert!(index_is_ready(&conn).unwrap());
        drop(conn);
        let reopened = resolve_vault_index(vault.clone()).unwrap();
        assert_eq!(reopened.index_db_path(), vault.index_db_path());
    }

    #[test]
    fn open_memory_applies_schema_and_connection_contract() {
        let conn = open_memory().unwrap();

        assert_eq!(scalar(&conn, "PRAGMA foreign_keys"), 1);
        assert_eq!(scalar(&conn, "PRAGMA user_version"), CURRENT_SCHEMA_VERSION);
        assert_eq!(
            scalar(
                &conn,
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='blocks'",
            ),
            1
        );
        assert_eq!(
            scalar(
                &conn,
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='trigger' AND name IN ('blocks_ai', 'blocks_ad', 'blocks_au')",
            ),
            3
        );
    }

    #[test]
    fn file_database_uses_wal_and_read_only_connections_use_query_only() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let writer = open_or_create(&db_path).unwrap();
        let mode: String = writer
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");

        let reader = open_read_only(&db_path).unwrap();
        assert_eq!(scalar(&reader, "PRAGMA query_only"), 1);
    }

    #[test]
    fn concurrent_open_serializes_versioned_migrations() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("concurrent.db");
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|_| {
                let db_path = db_path.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    let conn = open_or_create(&db_path).unwrap();
                    (
                        scalar(&conn, "PRAGMA user_version"),
                        scalar(
                            &conn,
                            "SELECT COUNT(*) FROM sqlite_master
                             WHERE type='trigger' AND name IN ('blocks_ai', 'blocks_ad', 'blocks_au')",
                        ),
                    )
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            assert_eq!(handle.join().unwrap(), (CURRENT_SCHEMA_VERSION, 3));
        }
    }

    #[test]
    fn foreign_keys_cascade_owned_relations() {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, saved_at, body)
             VALUES ('source', 'article', '2026-01-01T00:00:00Z', '')",
            [],
        )
        .unwrap();
        let block_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO block_tags (block_id, tag) VALUES (?1, 'design')",
            [block_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wikilinks (source_id, target_slug) VALUES (?1, 'target')",
            [block_id],
        )
        .unwrap();

        conn.execute("DELETE FROM blocks WHERE id = ?1", [block_id])
            .unwrap();

        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM block_tags"), 0);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM wikilinks"), 0);
    }

    #[test]
    fn graph_link_backfill_restores_provenance_from_indexed_columns() {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO blocks (
                slug, block_type, saved_at, body, related_notes, graph_link_index_version
             ) VALUES (?1, 'article', '2026-01-01T00:00:00Z', ?2, ?3, NULL)",
            rusqlite::params![
                "source",
                "See [[body-target]]",
                r#"["related-target#^block"]"#
            ],
        )
        .unwrap();
        let block_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO wikilinks (source_id, target_slug) VALUES (?1, 'legacy-mixed')",
            [block_id],
        )
        .unwrap();

        migrations::backfill_graph_link_index(&conn).unwrap();

        let body_target: String = conn
            .query_row(
                "SELECT target_slug FROM wikilinks WHERE source_id = ?1",
                [block_id],
                |row| row.get(0),
            )
            .unwrap();
        let related_target: String = conn
            .query_row(
                "SELECT target_slug FROM related_note_links WHERE source_id = ?1",
                [block_id],
                |row| row.get(0),
            )
            .unwrap();
        let version: i64 = conn
            .query_row(
                "SELECT graph_link_index_version FROM blocks WHERE id = ?1",
                [block_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(body_target, "body-target");
        assert_eq!(related_target, "related-target#^block");
        assert_eq!(version, GRAPH_LINK_INDEX_VERSION);
    }

    #[test]
    fn reopening_schema_is_idempotent_and_preserves_projection_generation() {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO blocks (
                slug, block_type, saved_at, body, graph_link_index_version
             ) VALUES ('stable', 'article', '2026-07-11T00:00:00Z', 'body', ?1)",
            [GRAPH_LINK_INDEX_VERSION],
        )
        .unwrap();
        let before = crate::storage::projection::current_generation(&conn).unwrap();

        migrations::migrate_and_validate(&conn).unwrap();
        migrations::migrate_and_validate(&conn).unwrap();

        assert_eq!(
            crate::storage::projection::current_generation(&conn).unwrap(),
            before
        );
        assert_eq!(scalar(&conn, "PRAGMA user_version"), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn upgrades_representative_unversioned_database_without_card_kind() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("legacy.db");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE blocks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT UNIQUE NOT NULL,
                    block_type TEXT NOT NULL,
                    title TEXT,
                    description TEXT,
                    url TEXT,
                    media_file TEXT,
                    thumbnail TEXT,
                    saved_at TEXT NOT NULL,
                    source TEXT,
                    width INTEGER,
                    height INTEGER,
                    author TEXT,
                    body TEXT DEFAULT '',
                    indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT INTO blocks (slug, block_type, saved_at, body)
                    VALUES ('legacy-media', 'image', '2026-01-01T00:00:00Z', '');
                INSERT INTO blocks (slug, block_type, saved_at, body)
                    VALUES ('legacy-article', 'image', '2026-01-01T00:00:00Z', '# Heading');
                INSERT INTO blocks (slug, block_type, saved_at, body)
                    VALUES ('legacy-channel', 'channel', '2026-01-01T00:00:00Z', '');
                INSERT INTO blocks (slug, block_type, saved_at, body, url)
                    VALUES ('legacy-link', 'video', '2026-01-01T00:00:00Z', '', 'https://example.test');",
            )
            .unwrap();
        }

        let conn = open_or_create(&db_path).unwrap();
        let kind = |slug: &str| -> String {
            conn.query_row(
                "SELECT card_kind FROM blocks WHERE slug = ?1",
                [slug],
                |row| row.get(0),
            )
            .unwrap()
        };

        assert_eq!(kind("legacy-media"), "media");
        assert_eq!(kind("legacy-article"), "article");
        assert_eq!(kind("legacy-channel"), "channel");
        assert_eq!(kind("legacy-link"), "link");
        assert_eq!(scalar(&conn, "PRAGMA user_version"), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn fts_triggers_cover_insert_update_and_delete() {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, title, saved_at, body)
             VALUES ('test', 'article', 'Hello', '2026-01-01T00:00:00Z', '')",
            [],
        )
        .unwrap();
        assert_eq!(
            scalar(
                &conn,
                "SELECT COUNT(*) FROM blocks_fts WHERE blocks_fts MATCH 'hello'",
            ),
            1
        );

        conn.execute(
            "UPDATE blocks SET title = 'Goodbye' WHERE slug = 'test'",
            [],
        )
        .unwrap();
        assert_eq!(
            scalar(
                &conn,
                "SELECT COUNT(*) FROM blocks_fts WHERE blocks_fts MATCH 'hello'",
            ),
            0
        );
        assert_eq!(
            scalar(
                &conn,
                "SELECT COUNT(*) FROM blocks_fts WHERE blocks_fts MATCH 'goodbye'",
            ),
            1
        );

        conn.execute("DELETE FROM blocks WHERE slug = 'test'", [])
            .unwrap();
        assert_eq!(
            scalar(
                &conn,
                "SELECT COUNT(*) FROM blocks_fts WHERE blocks_fts MATCH 'goodbye'",
            ),
            0
        );
    }

    #[test]
    fn open_or_create_creates_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("sub").join("deep").join("index.db");

        let _conn = open_or_create(&db_path).unwrap();

        assert!(db_path.exists());
    }
}
