//! Versioned SQLite schema migrations and validation.
//!
//! The derived index is rebuildable, but an upgrade must still fail atomically:
//! silently accepting a partial schema can make every route unreadable until the
//! user deletes local application data. `PRAGMA user_version` is the persisted
//! migration cursor and every schema step runs under one immediate transaction.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use rusqlite::Connection;

pub const CURRENT_SCHEMA_VERSION: i64 = 2;
pub const GRAPH_LINK_INDEX_VERSION: i64 = 2;

const BLOCK_COLUMNS: &[(&str, &str)] = &[
    ("id", "INTEGER"),
    ("slug", "TEXT"),
    ("block_type", "TEXT"),
    ("card_kind", "TEXT"),
    ("title", "TEXT"),
    ("content_heading", "TEXT"),
    ("display_title", "TEXT"),
    ("fallback_label", "TEXT"),
    ("description", "TEXT"),
    ("url", "TEXT"),
    ("media_file", "TEXT"),
    ("thumbnail", "TEXT"),
    ("saved_at", "TEXT"),
    ("source", "TEXT"),
    ("width", "INTEGER"),
    ("height", "INTEGER"),
    ("author", "TEXT"),
    ("body", "TEXT"),
    ("first_image", "TEXT"),
    ("media_urls", "TEXT"),
    ("media_dimensions", "TEXT"),
    ("preview_text", "TEXT"),
    ("preview_text_cap", "INTEGER"),
    ("body_hash", "TEXT"),
    ("origin", "TEXT"),
    ("index_warning", "TEXT"),
    ("preview_manifest", "TEXT"),
    ("preview_state", "TEXT"),
    ("preview_source_stamp", "TEXT"),
    ("preview_error_kind", "TEXT"),
    ("preview_schema_version", "INTEGER"),
    ("feed_playback", "TEXT"),
    ("media_index_version", "INTEGER"),
    ("collection_index_version", "INTEGER"),
    ("graph_link_index_version", "INTEGER"),
    ("related_notes", "TEXT"),
    ("thumb_format", "TEXT"),
    ("thumb_mtime", "INTEGER"),
    ("indexed_at", "TEXT"),
];

const SOURCE_INDEX_STATE_COLUMNS: &[(&str, &str)] = &[
    ("slug", "TEXT"),
    ("source_kind", "TEXT"),
    ("source_stamp", "TEXT"),
    ("updated_at", "TEXT"),
];
const PROJECTION_STATE_COLUMNS: &[(&str, &str)] =
    &[("singleton", "INTEGER"), ("generation", "INTEGER")];
const SEARCH_STATE_COLUMNS: &[(&str, &str)] = &[("singleton", "INTEGER"), ("revision", "INTEGER")];
const BLOCK_TAG_COLUMNS: &[(&str, &str)] = &[("block_id", "INTEGER"), ("tag", "TEXT")];
const CHANNEL_COLUMNS: &[(&str, &str)] = &[
    ("id", "INTEGER"),
    ("tag", "TEXT"),
    ("title", "TEXT"),
    ("description", "TEXT"),
    ("color", "TEXT"),
    ("icon", "TEXT"),
    ("position", "INTEGER"),
    ("created_at", "TEXT"),
];
const LINK_COLUMNS: &[(&str, &str)] = &[("source_id", "INTEGER"), ("target_slug", "TEXT")];
const SEARCH_DOCUMENT_STATE_COLUMNS: &[(&str, &str)] = &[
    ("block_id", "INTEGER"),
    ("slug", "TEXT"),
    ("document_hash", "TEXT"),
    ("updated_at", "TEXT"),
];
const SEARCH_CHUNK_COLUMNS: &[(&str, &str)] = &[
    ("id", "INTEGER"),
    ("block_id", "INTEGER"),
    ("slug", "TEXT"),
    ("field", "TEXT"),
    ("chunk_index", "INTEGER"),
    ("text", "TEXT"),
    ("start_char", "INTEGER"),
    ("end_char", "INTEGER"),
    ("text_hash", "TEXT"),
    ("updated_at", "TEXT"),
];
const SEARCH_EMBEDDING_COLUMNS: &[(&str, &str)] = &[
    ("chunk_id", "INTEGER"),
    ("model_id", "TEXT"),
    ("dim", "INTEGER"),
    ("vector", "BLOB"),
    ("text_hash", "TEXT"),
    ("updated_at", "TEXT"),
];
const VAULT_CONFLICT_COLUMNS: &[(&str, &str)] = &[
    ("id", "INTEGER"),
    ("base_slug", "TEXT"),
    ("conflict_slug", "TEXT"),
    ("detected_at", "TEXT"),
];

const REQUIRED_TABLE_COLUMNS: &[(&str, &[(&str, &str)])] = &[
    ("blocks", BLOCK_COLUMNS),
    ("source_index_state", SOURCE_INDEX_STATE_COLUMNS),
    ("projection_state", PROJECTION_STATE_COLUMNS),
    ("search_state", SEARCH_STATE_COLUMNS),
    ("block_tags", BLOCK_TAG_COLUMNS),
    ("channels", CHANNEL_COLUMNS),
    ("wikilinks", LINK_COLUMNS),
    ("related_note_links", LINK_COLUMNS),
    ("search_document_state", SEARCH_DOCUMENT_STATE_COLUMNS),
    ("search_chunks", SEARCH_CHUNK_COLUMNS),
    ("search_embeddings", SEARCH_EMBEDDING_COLUMNS),
    ("vault_conflicts", VAULT_CONFLICT_COLUMNS),
];

const REQUIRED_INDEXES: &[&str] = &[
    "idx_blocks_saved_at",
    "idx_blocks_type",
    "idx_blocks_card_kind",
    "idx_block_tags_tag",
    "idx_block_tags_block_id",
    "idx_related_note_links_target",
    "idx_search_chunks_block",
    "idx_search_chunks_slug",
    "idx_search_embeddings_model",
    "idx_vault_conflicts_base_slug",
];

const REQUIRED_TRIGGERS: &[&str] = &[
    "blocks_ai",
    "blocks_ad",
    "blocks_au",
    "projection_blocks_ai",
    "projection_blocks_au",
    "projection_blocks_ad",
    "projection_channels_ai",
    "projection_channels_au",
    "projection_channels_ad",
    "projection_source_state_ai",
    "projection_source_state_au",
    "projection_source_state_ad",
    "projection_block_tags_ai",
    "projection_block_tags_au",
    "projection_block_tags_ad",
    "search_documents_ai",
    "search_documents_au",
    "search_documents_ad",
    "search_chunks_ai",
    "search_chunks_au",
    "search_chunks_ad",
    "search_embeddings_ai",
    "search_embeddings_au",
    "search_embeddings_ad",
];

pub fn migrate_and_validate(conn: &Connection) -> Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .context("failed to acquire SQLite migration lock")?;

    let result = (|| -> Result<()> {
        let installed = user_version(conn)?;
        if installed > CURRENT_SCHEMA_VERSION {
            bail!(
                "database schema version {installed} is newer than supported version {CURRENT_SCHEMA_VERSION}"
            );
        }

        for target in (installed + 1)..=CURRENT_SCHEMA_VERSION {
            match target {
                1 => migrate_v0_to_v1(conn)?,
                2 => migrate_v1_to_v2(conn)?,
                _ => bail!("missing SQLite migration implementation for version {target}"),
            }
            conn.pragma_update(None, "user_version", target)
                .with_context(|| format!("failed to persist SQLite schema version {target}"))?;
        }

        validate_schema(conn)
    })();

    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .context("failed to commit SQLite migrations")?,
        Err(error) => {
            if let Err(rollback_error) = conn.execute_batch("ROLLBACK") {
                return Err(error.context(format!(
                    "SQLite migration rollback also failed: {rollback_error}"
                )));
            }
            return Err(error);
        }
    }

    backfill_graph_link_index(conn)?;
    Ok(())
}

fn user_version(conn: &Connection) -> Result<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .context("failed to read SQLite user_version")
}

fn migrate_v0_to_v1(conn: &Connection) -> Result<()> {
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
            first_image TEXT,
            media_urls TEXT,
            media_dimensions TEXT,
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

        DROP TRIGGER IF EXISTS blocks_ai;
        DROP TRIGGER IF EXISTS blocks_ad;
        DROP TRIGGER IF EXISTS blocks_au;
        DROP TRIGGER IF EXISTS projection_blocks_ai;
        DROP TRIGGER IF EXISTS projection_blocks_au;
        DROP TRIGGER IF EXISTS projection_blocks_ad;
        DROP TRIGGER IF EXISTS projection_channels_ai;
        DROP TRIGGER IF EXISTS projection_channels_au;
        DROP TRIGGER IF EXISTS projection_channels_ad;
        DROP TRIGGER IF EXISTS projection_source_state_ai;
        DROP TRIGGER IF EXISTS projection_source_state_au;
        DROP TRIGGER IF EXISTS projection_source_state_ad;
        DROP TRIGGER IF EXISTS projection_block_tags_ai;
        DROP TRIGGER IF EXISTS projection_block_tags_au;
        DROP TRIGGER IF EXISTS projection_block_tags_ad;",
    )
    .context("failed to establish SQLite v1 baseline")?;

    validate_legacy_block_baseline(conn)?;
    add_column_if_missing(conn, "title", "TEXT")?;
    add_column_if_missing(conn, "description", "TEXT")?;
    add_column_if_missing(conn, "url", "TEXT")?;
    add_column_if_missing(conn, "media_file", "TEXT")?;
    add_column_if_missing(conn, "thumbnail", "TEXT")?;
    add_column_if_missing(conn, "source", "TEXT")?;
    add_column_if_missing(conn, "width", "INTEGER")?;
    add_column_if_missing(conn, "height", "INTEGER")?;
    add_column_if_missing(conn, "author", "TEXT")?;
    add_column_if_missing(conn, "indexed_at", "TEXT")?;
    add_column_if_missing(conn, "first_image", "TEXT")?;
    add_column_if_missing(conn, "media_urls", "TEXT")?;
    add_column_if_missing(conn, "content_heading", "TEXT")?;
    add_column_if_missing(conn, "display_title", "TEXT")?;
    add_column_if_missing(conn, "fallback_label", "TEXT")?;
    add_column_if_missing(conn, "media_dimensions", "TEXT")?;
    add_column_if_missing(conn, "preview_text", "TEXT")?;
    add_column_if_missing(conn, "preview_text_cap", "INTEGER")?;
    add_column_if_missing(conn, "preview_manifest", "TEXT")?;
    add_column_if_missing(conn, "preview_state", "TEXT NOT NULL DEFAULT 'stale'")?;
    add_column_if_missing(conn, "preview_source_stamp", "TEXT")?;
    add_column_if_missing(conn, "preview_error_kind", "TEXT")?;
    add_column_if_missing(conn, "preview_schema_version", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(conn, "feed_playback", "TEXT")?;
    add_column_if_missing(conn, "media_index_version", "INTEGER")?;
    add_column_if_missing(conn, "collection_index_version", "INTEGER")?;
    add_column_if_missing(conn, "graph_link_index_version", "INTEGER")?;
    add_column_if_missing(conn, "related_notes", "TEXT")?;
    add_column_if_missing(conn, "thumb_format", "TEXT")?;
    add_column_if_missing(conn, "thumb_mtime", "INTEGER")?;
    add_column_if_missing(conn, "origin", "TEXT")?;
    add_column_if_missing(conn, "index_warning", "TEXT")?;
    add_column_if_missing(conn, "body_hash", "TEXT")?;
    let card_kind_added =
        add_column_if_missing(conn, "card_kind", "TEXT NOT NULL DEFAULT 'media'")?;

    if card_kind_added {
        conn.execute_batch(
            "UPDATE blocks
             SET card_kind = CASE
                WHEN block_type = 'channel' THEN 'channel'
                WHEN trim(coalesce(body, '')) != '' THEN 'article'
                WHEN media_file IS NOT NULL THEN 'media'
                WHEN url IS NOT NULL OR block_type = 'link' THEN 'link'
                WHEN block_type IN ('image', 'video', 'file') THEN 'media'
                ELSE 'article'
             END;",
        )
        .context("failed to backfill blocks.card_kind")?;
    }

    conn.execute_batch(
        "UPDATE blocks SET indexed_at = datetime('now') WHERE indexed_at IS NULL;
         UPDATE blocks SET preview_state = 'stale'
         WHERE preview_state IS NULL
            OR preview_state NOT IN ('missing', 'stale', 'ready', 'failed');

        CREATE TABLE IF NOT EXISTS source_index_state (
            slug TEXT PRIMARY KEY,
            source_kind TEXT NOT NULL,
            source_stamp TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS projection_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            generation INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO projection_state (singleton, generation) VALUES (1, 0);

        CREATE INDEX IF NOT EXISTS idx_blocks_saved_at ON blocks(saved_at DESC);
        CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(block_type);
        CREATE INDEX IF NOT EXISTS idx_blocks_card_kind ON blocks(card_kind);

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
        CREATE INDEX IF NOT EXISTS idx_search_chunks_block ON search_chunks(block_id);
        CREATE INDEX IF NOT EXISTS idx_search_chunks_slug ON search_chunks(slug);

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

        CREATE TABLE IF NOT EXISTS vault_conflicts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            base_slug TEXT NOT NULL,
            conflict_slug TEXT NOT NULL,
            detected_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(base_slug, conflict_slug)
        );
        CREATE INDEX IF NOT EXISTS idx_vault_conflicts_base_slug
            ON vault_conflicts(base_slug);",
    )
    .context("failed to create SQLite v1 tables and indexes")?;

    conn.execute_batch(
        "CREATE TRIGGER blocks_ai AFTER INSERT ON blocks BEGIN
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
        END;

        CREATE TRIGGER blocks_au
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
        END;

        CREATE TRIGGER projection_blocks_ai AFTER INSERT ON blocks BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_blocks_au AFTER UPDATE ON blocks BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_blocks_ad AFTER DELETE ON blocks BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_channels_ai AFTER INSERT ON channels BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_channels_au AFTER UPDATE ON channels BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_channels_ad AFTER DELETE ON channels BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_source_state_ai AFTER INSERT ON source_index_state BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_source_state_au AFTER UPDATE ON source_index_state BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_source_state_ad AFTER DELETE ON source_index_state BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_block_tags_ai AFTER INSERT ON block_tags BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_block_tags_au AFTER UPDATE ON block_tags BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER projection_block_tags_ad AFTER DELETE ON block_tags BEGIN
            UPDATE projection_state SET generation = generation + 1 WHERE singleton = 1;
        END;

        INSERT INTO blocks_fts(blocks_fts) VALUES ('rebuild');",
    )
    .context("failed to create SQLite v1 triggers and rebuild FTS")?;

    Ok(())
}

fn migrate_v1_to_v2(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE search_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            revision INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO search_state (singleton, revision) VALUES (1, 0);

        CREATE TRIGGER search_documents_ai AFTER INSERT ON search_document_state BEGIN
            UPDATE search_state SET revision = revision + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER search_documents_au AFTER UPDATE ON search_document_state BEGIN
            UPDATE search_state SET revision = revision + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER search_documents_ad AFTER DELETE ON search_document_state BEGIN
            UPDATE search_state SET revision = revision + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER search_chunks_ai AFTER INSERT ON search_chunks BEGIN
            UPDATE search_state SET revision = revision + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER search_chunks_au AFTER UPDATE ON search_chunks BEGIN
            UPDATE search_state SET revision = revision + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER search_chunks_ad AFTER DELETE ON search_chunks BEGIN
            UPDATE search_state SET revision = revision + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER search_embeddings_ai AFTER INSERT ON search_embeddings BEGIN
            UPDATE search_state SET revision = revision + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER search_embeddings_au AFTER UPDATE ON search_embeddings BEGIN
            UPDATE search_state SET revision = revision + 1 WHERE singleton = 1;
        END;
        CREATE TRIGGER search_embeddings_ad AFTER DELETE ON search_embeddings BEGIN
            UPDATE search_state SET revision = revision + 1 WHERE singleton = 1;
        END;",
    )
    .context("failed to install SQLite search revision contract")?;
    Ok(())
}

fn add_column_if_missing(conn: &Connection, name: &str, declaration: &str) -> Result<bool> {
    if block_columns(conn)?.contains_key(name) {
        return Ok(false);
    }
    let sql = format!("ALTER TABLE blocks ADD COLUMN {name} {declaration}");
    conn.execute_batch(&sql)
        .with_context(|| format!("failed to add blocks.{name}"))?;
    Ok(true)
}

fn validate_legacy_block_baseline(conn: &Connection) -> Result<()> {
    let columns = block_columns(conn)?;
    for required in ["id", "slug", "block_type", "saved_at", "body"] {
        if !columns.contains_key(required) {
            bail!("legacy SQLite blocks table is missing required column {required}");
        }
    }
    Ok(())
}

fn validate_schema(conn: &Connection) -> Result<()> {
    let installed = user_version(conn)?;
    if installed != CURRENT_SCHEMA_VERSION {
        bail!(
            "SQLite schema version mismatch: expected {CURRENT_SCHEMA_VERSION}, found {installed}"
        );
    }

    for (table, expected_columns) in REQUIRED_TABLE_COLUMNS {
        validate_table_columns(conn, table, expected_columns)?;
    }
    validate_table_columns(
        conn,
        "blocks_fts",
        &[("title", ""), ("description", ""), ("body", "")],
    )?;

    for index in REQUIRED_INDEXES {
        validate_schema_object(conn, "index", index)?;
    }
    for trigger in REQUIRED_TRIGGERS {
        validate_schema_object(conn, "trigger", trigger)?;
    }

    let projection_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM projection_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .context("failed to validate projection_state singleton")?;
    if projection_rows != 1 {
        bail!("projection_state must contain exactly one singleton row");
    }
    let search_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .context("failed to validate search_state singleton")?;
    if search_rows != 1 {
        bail!("search_state must contain exactly one singleton row");
    }
    Ok(())
}

fn validate_table_columns(
    conn: &Connection,
    table: &str,
    expected_columns: &[(&str, &str)],
) -> Result<()> {
    let columns = table_columns(conn, table)?;
    if columns.is_empty() {
        bail!("required SQLite table {table} is missing");
    }
    for (name, expected_type) in expected_columns {
        let actual_type = columns
            .get(*name)
            .with_context(|| format!("required SQLite column {table}.{name} is missing"))?;
        if !expected_type.is_empty() && !actual_type.eq_ignore_ascii_case(expected_type) {
            bail!("SQLite column {table}.{name} has type {actual_type}, expected {expected_type}");
        }
    }
    Ok(())
}

fn validate_schema_object(conn: &Connection, object_type: &str, name: &str) -> Result<()> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2
             )",
            [object_type, name],
            |row| row.get(0),
        )
        .with_context(|| format!("failed to inspect SQLite {object_type} {name}"))?;
    if !exists {
        bail!("required SQLite {object_type} {name} is missing");
    }
    Ok(())
}

fn block_columns(conn: &Connection) -> Result<BTreeMap<String, String>> {
    table_columns(conn, "blocks")
}

fn table_columns(conn: &Connection, table: &str) -> Result<BTreeMap<String, String>> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn
        .prepare(&sql)
        .with_context(|| format!("failed to inspect SQLite table {table}"))?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })?;
    rows.collect::<rusqlite::Result<BTreeMap<_, _>>>()
        .with_context(|| format!("failed to read SQLite columns for {table}"))
}

pub(crate) fn backfill_graph_link_index(conn: &Connection) -> Result<()> {
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
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for (block_id, body, raw_related) in rows {
        tx.execute("DELETE FROM wikilinks WHERE source_id = ?1", [block_id])?;
        tx.execute(
            "DELETE FROM related_note_links WHERE source_id = ?1",
            [block_id],
        )?;
        for target in crate::domain::block::extract_note_wikilinks(&body) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_schema_sets_version_and_validates() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();

        migrate_and_validate(&conn).unwrap();

        assert_eq!(user_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        validate_schema(&conn).unwrap();
    }

    #[test]
    fn graph_link_backfill_replaces_media_embeds_with_plain_note_links() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate_and_validate(&conn).unwrap();
        conn.execute(
            "INSERT INTO blocks (
                slug, block_type, card_kind, saved_at, body, related_notes,
                graph_link_index_version
             ) VALUES (
                'source', 'article', 'article', '2026-07-25T00:00:00Z',
                '[[Note#^block-id|Label]] ![[image #1.jpg|Caption]]',
                '[\"Related\"]', ?1
             )",
            [GRAPH_LINK_INDEX_VERSION - 1],
        )
        .unwrap();
        let block_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO wikilinks (source_id, target_slug)
             VALUES (?1, 'image #1.jpg|Caption')",
            [block_id],
        )
        .unwrap();

        backfill_graph_link_index(&conn).unwrap();

        let note_targets = conn
            .prepare(
                "SELECT target_slug FROM wikilinks
                 WHERE source_id = ?1 ORDER BY target_slug",
            )
            .unwrap()
            .query_map([block_id], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(note_targets, vec!["Note#^block-id|Label"]);
        let related_targets = conn
            .prepare(
                "SELECT target_slug FROM related_note_links
                 WHERE source_id = ?1 ORDER BY target_slug",
            )
            .unwrap()
            .query_map([block_id], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(related_targets, vec!["Related"]);
        assert_eq!(
            conn.query_row(
                "SELECT graph_link_index_version FROM blocks WHERE id = ?1",
                [block_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            GRAPH_LINK_INDEX_VERSION
        );
    }

    #[test]
    fn incompatible_legacy_column_rolls_back_every_schema_change() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE blocks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT UNIQUE NOT NULL,
                block_type TEXT NOT NULL,
                card_kind INTEGER,
                saved_at TEXT NOT NULL,
                body TEXT DEFAULT ''
            );",
        )
        .unwrap();

        let error = migrate_and_validate(&conn).unwrap_err().to_string();

        assert!(error.contains("blocks.card_kind has type INTEGER, expected TEXT"));
        assert_eq!(user_version(&conn).unwrap(), 0);
        assert!(!block_columns(&conn).unwrap().contains_key("first_image"));
    }

    #[test]
    fn version_one_upgrades_to_search_revision_without_losing_search_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
            .unwrap();
        migrate_v0_to_v1(&conn).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute_batch("COMMIT").unwrap();

        conn.execute(
            "INSERT INTO blocks (slug, block_type, card_kind, saved_at, body)
             VALUES ('legacy-search', 'article', 'article', '2026-07-11T00:00:00Z', 'body')",
            [],
        )
        .unwrap();
        let block_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO search_document_state (block_id, slug, document_hash)
             VALUES (?1, 'legacy-search', 'document-hash')",
            [block_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO search_chunks (
                block_id, slug, field, chunk_index, text, start_char, end_char, text_hash
             ) VALUES (?1, 'legacy-search', 'body', 0, 'legacy text', 0, 11, 'text-hash')",
            [block_id],
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'search_state'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );

        migrate_and_validate(&conn).unwrap();

        assert_eq!(user_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM search_chunks", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT revision FROM search_state WHERE singleton = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        conn.execute(
            "UPDATE search_chunks SET text = 'updated text' WHERE slug = 'legacy-search'",
            [],
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT revision FROM search_state WHERE singleton = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn current_version_with_schema_drift_is_rejected() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
            .unwrap();

        let error = migrate_and_validate(&conn).unwrap_err().to_string();

        assert!(error.contains("required SQLite table blocks is missing"));
        assert_eq!(user_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn newer_schema_version_is_rejected_without_modification() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
            .unwrap();

        let error = migrate_and_validate(&conn).unwrap_err().to_string();

        assert!(error.contains("is newer than supported version"));
        assert_eq!(user_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION + 1);
    }
}
