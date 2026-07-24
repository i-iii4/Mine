//! SQLite connection ownership.
//!
//! Schema evolution is owned by `storage::migrations`; this module only opens
//! connections and applies connection-scoped PRAGMAs.
//!
//! Contract: SPEC_STORAGE.md#storage-db

use std::{path::Path, sync::Mutex};

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

use super::migrations;

pub use super::migrations::{CURRENT_SCHEMA_VERSION, GRAPH_LINK_INDEX_VERSION};

static CONNECTION_INIT_LOCK: Mutex<()> = Mutex::new(());

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
