// Database: SQLite connection and schema management.
//
// Opens or creates the index database, applies pragmas (WAL, foreign keys),
// and initializes the schema with FTS5 content-sync triggers.
//
// Contract: SPEC_STORAGE.md#storage/db

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

pub const GRAPH_LINK_INDEX_VERSION: i64 = 1;

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

/// Open an existing database in read-only mode for hot query paths.
/// Uses a short-lived connection so WebView-triggered IPC never contends
/// on the shared mutable `vault_state` connection.
pub fn open_read_only(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("failed to open database read-only: {}", path.display()))?;
    init_read_only_connection(&conn)?;
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

fn init_read_only_connection(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA busy_timeout = 5000;
         PRAGMA query_only = ON;",
    )?;
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
    // Every process/worker may open its own SQLite connection. Serialize the
    // DDL migration across those connections so DROP/CREATE trigger sequences
    // cannot interleave during startup.
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let migration_result = (|| -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            block_type TEXT NOT NULL,
            card_kind TEXT NOT NULL DEFAULT 'media',
            title TEXT,
            content_heading TEXT,
            display_title TEXT,
            fallback_label TEXT,
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
            preview_text TEXT,
            preview_text_cap INTEGER,
            body_hash TEXT,
            origin TEXT,
            index_warning TEXT,
            preview_manifest TEXT,
            preview_state TEXT NOT NULL DEFAULT 'stale',
            preview_source_stamp TEXT,
            preview_error_kind TEXT,
            preview_schema_version INTEGER NOT NULL DEFAULT 1,
            feed_playback TEXT,
            media_index_version INTEGER,
            collection_index_version INTEGER,
            graph_link_index_version INTEGER,
            related_notes TEXT,
            thumb_format TEXT,
            thumb_mtime INTEGER,
            indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS source_index_state (
            slug TEXT PRIMARY KEY,
            source_kind TEXT NOT NULL,
            source_stamp TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

        CREATE TABLE IF NOT EXISTS related_note_links (
            source_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
            target_slug TEXT NOT NULL,
            PRIMARY KEY (source_id, target_slug)
        );

        CREATE INDEX IF NOT EXISTS idx_related_note_links_target
            ON related_note_links(target_slug);

        CREATE TABLE IF NOT EXISTS search_document_state (
            block_id INTEGER PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
            slug TEXT NOT NULL,
            document_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS search_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
            slug TEXT NOT NULL,
            field TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            text TEXT NOT NULL,
            start_char INTEGER NOT NULL,
            end_char INTEGER NOT NULL,
            text_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(block_id, field, chunk_index)
        );

        CREATE INDEX IF NOT EXISTS idx_search_chunks_block
            ON search_chunks(block_id);
        CREATE INDEX IF NOT EXISTS idx_search_chunks_slug
            ON search_chunks(slug);

        CREATE TABLE IF NOT EXISTS search_embeddings (
            chunk_id INTEGER NOT NULL REFERENCES search_chunks(id) ON DELETE CASCADE,
            model_id TEXT NOT NULL,
            dim INTEGER NOT NULL,
            vector BLOB NOT NULL,
            text_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY(chunk_id, model_id)
        );

        CREATE INDEX IF NOT EXISTS idx_search_embeddings_model
            ON search_embeddings(model_id);

        -- FTS5 content-sync triggers: keep index in sync with blocks table.
        DROP TRIGGER IF EXISTS blocks_ai;
        DROP TRIGGER IF EXISTS blocks_ad;
        DROP TRIGGER IF EXISTS blocks_au;

        CREATE TRIGGER blocks_ai AFTER INSERT ON blocks BEGIN
            INSERT INTO blocks_fts(rowid, title, description, body)
            VALUES (
                new.id,
                trim(
                    coalesce(new.display_title, '')
                    || ' ' || coalesce(new.title, '')
                    || ' ' || coalesce(new.fallback_label, '')
                ),
                new.description,
                new.body
            );
        END;

        CREATE TRIGGER blocks_ad AFTER DELETE ON blocks BEGIN
            INSERT INTO blocks_fts(blocks_fts, rowid, title, description, body)
            VALUES (
                'delete',
                old.id,
                trim(
                    coalesce(old.display_title, '')
                    || ' ' || coalesce(old.title, '')
                    || ' ' || coalesce(old.fallback_label, '')
                ),
                old.description,
                old.body
            );
        END;",
        )?;

        // Migration: add media_urls column (JSON array of image/video URLs from body)
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN first_image TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN media_urls TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN content_heading TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN display_title TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN fallback_label TEXT");

        // Migration: add media_dimensions column.
        // JSON object mapping each referenced media filename → [width, height] in
        // pixels. Populated at index time by reading the image header (fast, no
        // decoding). Enables the frontend to render embedded images at their
        // exact aspect ratio without runtime measurement.
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN media_dimensions TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN preview_text TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN preview_text_cap INTEGER");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN preview_manifest TEXT");
        let _ = conn.execute_batch(
            "ALTER TABLE blocks ADD COLUMN preview_state TEXT NOT NULL DEFAULT 'stale'",
        );
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN preview_source_stamp TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN preview_error_kind TEXT");
        let _ = conn.execute_batch(
            "ALTER TABLE blocks ADD COLUMN preview_schema_version INTEGER NOT NULL DEFAULT 0",
        );
        let _ = conn.execute_batch(
            "UPDATE blocks SET preview_state = 'stale'
         WHERE preview_state IS NULL
            OR preview_state NOT IN ('missing', 'stale', 'ready', 'failed')",
        );
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN feed_playback TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN media_index_version INTEGER");
        let _ =
            conn.execute_batch("ALTER TABLE blocks ADD COLUMN collection_index_version INTEGER");
        let _ =
            conn.execute_batch("ALTER TABLE blocks ADD COLUMN graph_link_index_version INTEGER");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN related_notes TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN thumb_format TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN thumb_mtime INTEGER");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN origin TEXT");
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN index_warning TEXT");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS source_index_state (
            slug TEXT PRIMARY KEY,
            source_kind TEXT NOT NULL,
            source_stamp TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
        )?;
        let _ = conn
            .execute_batch("ALTER TABLE blocks ADD COLUMN card_kind TEXT NOT NULL DEFAULT 'media'");
        let _ = conn.execute_batch(
            "UPDATE blocks
            SET card_kind = CASE
                WHEN block_type = 'channel' THEN 'channel'
                WHEN trim(coalesce(body, '')) != '' THEN 'article'
                WHEN media_file IS NOT NULL OR block_type IN ('image', 'video', 'file') THEN 'media'
                WHEN url IS NOT NULL OR block_type = 'link' THEN 'link'
                ELSE 'article'
            END",
        );
        let _ = conn
            .execute_batch("CREATE INDEX IF NOT EXISTS idx_blocks_card_kind ON blocks(card_kind)");

        conn.execute_batch(
            "CREATE TRIGGER blocks_au
            AFTER UPDATE OF title, display_title, fallback_label, description, body
            ON blocks BEGIN
            INSERT INTO blocks_fts(blocks_fts, rowid, title, description, body)
            VALUES (
                'delete',
                old.id,
                trim(
                    coalesce(old.display_title, '')
                    || ' ' || coalesce(old.title, '')
                    || ' ' || coalesce(old.fallback_label, '')
                ),
                old.description,
                old.body
            );
            INSERT INTO blocks_fts(rowid, title, description, body)
            VALUES (
                new.id,
                trim(
                    coalesce(new.display_title, '')
                    || ' ' || coalesce(new.title, '')
                    || ' ' || coalesce(new.fallback_label, '')
                ),
                new.description,
                new.body
            );
        END;",
        )?;

        // Migration: add body_hash column. SHA-256 over the block body, used by
        // Phase 18.G watcher rename detection to match a Remove+Create event
        // pair as a single rename without losing identity. Null for rows not
        // yet indexed after upgrade; backfilled incrementally on next scan.
        let _ = conn.execute_batch("ALTER TABLE blocks ADD COLUMN body_hash TEXT");

        // Migration: vault_conflicts table. Records iCloud-style filename
        // conflicts ("<name> (conflicted copy).md") so the UI can surface them
        // and let the user choose a resolution. Conflict files are never
        // automatically indexed as separate blocks.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vault_conflicts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            base_slug TEXT NOT NULL,
            conflict_slug TEXT NOT NULL,
            detected_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(base_slug, conflict_slug)
        );
        CREATE INDEX IF NOT EXISTS idx_vault_conflicts_base_slug
            ON vault_conflicts(base_slug);",
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS related_note_links (
            source_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
            target_slug TEXT NOT NULL,
            PRIMARY KEY (source_id, target_slug)
        );
        CREATE INDEX IF NOT EXISTS idx_related_note_links_target
            ON related_note_links(target_slug);",
        )?;
        Ok(())
    })();

    match migration_result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    }
    backfill_graph_link_index(conn)?;

    Ok(())
}

fn backfill_graph_link_index(conn: &Connection) -> Result<()> {
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM blocks
         WHERE graph_link_index_version IS NULL OR graph_link_index_version != ?1",
        [GRAPH_LINK_INDEX_VERSION],
        |row| row.get(0),
    )?;
    if pending == 0 {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;
    let rows = {
        let mut stmt = tx.prepare(
            "SELECT id, body, related_notes
             FROM blocks
             WHERE graph_link_index_version IS NULL OR graph_link_index_version != ?1",
        )?;
        let rows = stmt.query_map([GRAPH_LINK_INDEX_VERSION], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    for (block_id, body, raw_related) in rows {
        tx.execute("DELETE FROM wikilinks WHERE source_id = ?1", [block_id])?;
        tx.execute(
            "DELETE FROM related_note_links WHERE source_id = ?1",
            [block_id],
        )?;
        for target in crate::domain::block::extract_wikilinks(&body) {
            tx.execute(
                "INSERT OR IGNORE INTO wikilinks (source_id, target_slug) VALUES (?1, ?2)",
                rusqlite::params![block_id, target],
            )?;
        }
        let related = raw_related
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
            .unwrap_or_default();
        for target in related {
            tx.execute(
                "INSERT OR IGNORE INTO related_note_links (source_id, target_slug)
                 VALUES (?1, ?2)",
                rusqlite::params![block_id, target],
            )?;
        }
        tx.execute(
            "UPDATE blocks SET graph_link_index_version = ?2 WHERE id = ?1",
            rusqlite::params![block_id, GRAPH_LINK_INDEX_VERSION],
        )?;
    }
    tx.commit()?;
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
    fn concurrent_open_serializes_schema_trigger_migration() {
        use std::sync::{Arc, Barrier};

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
                    conn.query_row(
                        "SELECT COUNT(*) FROM sqlite_master
                         WHERE type = 'trigger' AND name IN ('blocks_ai', 'blocks_ad', 'blocks_au')",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            assert_eq!(handle.join().unwrap(), 3);
        }
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
    fn open_read_only_succeeds_for_existing_db() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let _rw = open_or_create(&db_path).unwrap();
        let ro = open_read_only(&db_path).unwrap();
        let query_only: i64 = ro
            .query_row("PRAGMA query_only", [], |row| row.get(0))
            .unwrap();
        assert_eq!(query_only, 1);
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
        assert!(tables.contains(&"related_note_links".to_string()));
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

        backfill_graph_link_index(&conn).unwrap();

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
        assert_eq!(body_target, "body-target");
        assert_eq!(related_target, "related-target#^block");
        let version: i64 = conn
            .query_row(
                "SELECT graph_link_index_version FROM blocks WHERE id = ?1",
                [block_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, GRAPH_LINK_INDEX_VERSION);
    }

    #[test]
    fn idempotent_schema_creation() {
        let conn = open_memory().unwrap();
        create_schema(&conn).unwrap();
        create_schema(&conn).unwrap();
    }

    #[test]
    fn migrates_existing_blocks_table_without_card_kind() {
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
                    content_heading TEXT,
                    display_title TEXT,
                    fallback_label TEXT,
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
                    preview_text TEXT,
                    preview_text_cap INTEGER,
                    body_hash TEXT,
                    origin TEXT,
                    index_warning TEXT,
                    preview_manifest TEXT,
                    feed_playback TEXT,
                    media_index_version INTEGER,
                    collection_index_version INTEGER,
                    related_notes TEXT,
                    thumb_format TEXT,
                    thumb_mtime INTEGER,
                    indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO blocks (slug, block_type, saved_at, body)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["legacy-media", "image", "2026-01-01T00:00:00Z", ""],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO blocks (slug, block_type, saved_at, body)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    "legacy-article",
                    "image",
                    "2026-01-01T00:00:00Z",
                    "# Heading"
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO blocks (slug, block_type, saved_at, body)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["legacy-channel", "channel", "2026-01-01T00:00:00Z", ""],
            )
            .unwrap();
        }

        let conn = open_or_create(&db_path).unwrap();

        let media: String = conn
            .query_row(
                "SELECT card_kind FROM blocks WHERE slug = 'legacy-media'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let article: String = conn
            .query_row(
                "SELECT card_kind FROM blocks WHERE slug = 'legacy-article'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let channel: String = conn
            .query_row(
                "SELECT card_kind FROM blocks WHERE slug = 'legacy-channel'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let index_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_blocks_card_kind'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(media, "media");
        assert_eq!(article, "article");
        assert_eq!(channel, "channel");
        assert_eq!(index_count, 1);
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
