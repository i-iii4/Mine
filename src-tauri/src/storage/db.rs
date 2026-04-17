// Database: SQLite connection and schema management.
//
// Opens or creates the index database, applies pragmas (WAL, foreign keys),
// and initializes the schema with FTS5 content-sync triggers.
//
// Contract: SPEC_STORAGE.md#storage/db

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;

// ─── Public API ─────────────────────────────────────────────────────────────

/// Open an existing database or create a new one at the given path.
/// Creates parent directories if needed. Applies pragmas and schema.
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

/// Open an in-memory database for testing.
pub fn open_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory().context("failed to open in-memory database")?;
    init_connection(&conn)?;
    Ok(conn)
}

// ─── Private ────────────────────────────────────────────────────────────────

fn init_connection(conn: &Connection) -> Result<()> {
    apply_pragmas(conn)?;
    create_schema(conn)?;
    Ok(())
}

fn apply_pragmas(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

fn create_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS blocks (
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
            thumb_format TEXT,
            thumb_mtime INTEGER,
            indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_blocks_saved_at ON blocks(saved_at DESC);
        CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(block_type);

        CREATE TABLE IF NOT EXISTS block_tags (
            block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            PRIMARY KEY (block_id, tag)
        );

        CREATE INDEX IF NOT EXISTS idx_block_tags_tag ON block_tags(tag);
        CREATE INDEX IF NOT EXISTS idx_block_tags_block_id ON block_tags(block_id);

        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tag TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            color TEXT,
            icon TEXT,
            position INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
            title, description, body,
            content='blocks',
            content_rowid='id'
        );

        CREATE TABLE IF NOT EXISTS wikilinks (
            source_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
            target_slug TEXT NOT NULL,
            PRIMARY KEY (source_id, target_slug)
        );

        -- FTS5 content-sync triggers: keep index in sync with blocks table.
        CREATE TRIGGER IF NOT EXISTS blocks_ai AFTER INSERT ON blocks BEGIN
            INSERT INTO blocks_fts(rowid, title, description, body)
            VALUES (new.id, new.title, new.description, new.body);
        END;

        CREATE TRIGGER IF NOT EXISTS blocks_ad AFTER DELETE ON blocks BEGIN
            INSERT INTO blocks_fts(blocks_fts, rowid, title, description, body)
            VALUES ('delete', old.id, old.title, old.description, old.body);
        END;

        CREATE TRIGGER IF NOT EXISTS blocks_au AFTER UPDATE ON blocks BEGIN
            INSERT INTO blocks_fts(blocks_fts, rowid, title, description, body)
            VALUES ('delete', old.id, old.title, old.description, old.body);
            INSERT INTO blocks_fts(rowid, title, description, body)
            VALUES (new.id, new.title, new.description, new.body);
        END;",
    )?;

    // Migration: add media_urls column (JSON array of image/video URLs from body)
    let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN first_image TEXT");
    let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN media_urls TEXT");

    // Migration: add media_dimensions column.
    // JSON object mapping each referenced media filename → [width, height] in
    // pixels. Populated at index time by reading the image header (fast, no
    // decoding). Enables the frontend to render embedded images at their
    // exact aspect ratio without runtime measurement.
    let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN media_dimensions TEXT");
    let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN thumb_format TEXT");
    let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN thumb_mtime INTEGER");

    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_memory_succeeds() {
        let conn = open_memory().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='blocks'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn wal_mode_on_file_db() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = open_or_create(&db_path).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
    }

    #[test]
    fn foreign_keys_enabled() {
        let conn = open_memory().unwrap();
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fk, 1);
    }

    #[test]
    fn all_tables_created() {
        let conn = open_memory().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(tables.contains(&"blocks".to_string()));
        assert!(tables.contains(&"block_tags".to_string()));
        assert!(tables.contains(&"channels".to_string()));
        assert!(tables.contains(&"wikilinks".to_string()));
    }

    #[test]
    fn fts5_table_created() {
        let conn = open_memory().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='blocks_fts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn fts5_triggers_created() {
        let conn = open_memory().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
            .unwrap();
        let triggers: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(triggers.contains(&"blocks_ai".to_string()));
        assert!(triggers.contains(&"blocks_ad".to_string()));
        assert!(triggers.contains(&"blocks_au".to_string()));
    }

    #[test]
    fn cascade_delete_block_tags() {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, saved_at, body) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["test", "image", "2026-01-01T00:00:00Z", ""],
        )
        .unwrap();
        let block_id: i64 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO block_tags (block_id, tag) VALUES (?1, ?2)",
            rusqlite::params![block_id, "design"],
        )
        .unwrap();

        conn.execute("DELETE FROM blocks WHERE id = ?1", [block_id])
            .unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM block_tags", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn cascade_delete_wikilinks() {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, saved_at, body) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["source", "article", "2026-01-01T00:00:00Z", ""],
        )
        .unwrap();
        let block_id: i64 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO wikilinks (source_id, target_slug) VALUES (?1, ?2)",
            rusqlite::params![block_id, "target"],
        )
        .unwrap();

        conn.execute("DELETE FROM blocks WHERE id = ?1", [block_id])
            .unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM wikilinks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn idempotent_schema_creation() {
        let conn = open_memory().unwrap();
        create_schema(&conn).unwrap();
        create_schema(&conn).unwrap();
    }

    #[test]
    fn fts5_auto_index_on_insert() {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, title, description, saved_at, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "test",
                "article",
                "Hello World",
                "A description",
                "2026-01-01T00:00:00Z",
                "Some body text"
            ],
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM blocks_fts WHERE blocks_fts MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn fts5_auto_delete_on_remove() {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, title, saved_at, body)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params!["test", "article", "Hello World", "2026-01-01T00:00:00Z", ""],
        )
        .unwrap();

        conn.execute("DELETE FROM blocks WHERE slug = 'test'", [])
            .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM blocks_fts WHERE blocks_fts MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn fts5_auto_update() {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, title, saved_at, body)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params!["test", "article", "Hello", "2026-01-01T00:00:00Z", ""],
        )
        .unwrap();

        conn.execute(
            "UPDATE blocks SET title = 'Goodbye' WHERE slug = 'test'",
            [],
        )
        .unwrap();

        let old: i64 = conn
            .query_row(
                "SELECT count(*) FROM blocks_fts WHERE blocks_fts MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old, 0);

        let new: i64 = conn
            .query_row(
                "SELECT count(*) FROM blocks_fts WHERE blocks_fts MATCH 'goodbye'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(new, 1);
    }

    #[test]
    fn open_or_create_creates_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("sub").join("deep").join("index.db");
        let conn = open_or_create(&db_path).unwrap();
        assert!(db_path.exists());

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='blocks'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
