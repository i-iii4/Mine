//! Versioned SQLite schema migrations and validation.
//!
//! The derived index is rebuildable, but an upgrade must still fail atomically:
//! silently accepting a partial schema can make every route unreadable until the
//! user deletes local application data. `PRAGMA user_version` is the persisted
//! migration cursor and every schema step runs under one immediate transaction.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use rusqlite::Connection;

pub const CURRENT_SCHEMA_VERSION: i64 = 10;
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
    ("note_name", "TEXT"),
    ("extraction_source_name", "TEXT"),
    ("association_author", "TEXT"),
    ("association_author_key", "TEXT"),
    ("association_site", "TEXT"),
    ("association_address", "TEXT"),
    ("association_index_version", "INTEGER"),
];

const SOURCE_INDEX_STATE_COLUMNS: &[(&str, &str)] = &[
    ("slug", "TEXT"),
    ("source_kind", "TEXT"),
    ("source_stamp", "TEXT"),
    ("updated_at", "TEXT"),
];
const SOURCE_DEPENDENCY_NAME_COLUMNS: &[(&str, &str)] = &[("name", "TEXT"), ("slug", "TEXT")];
const PROJECTION_STATE_COLUMNS: &[(&str, &str)] =
    &[("singleton", "INTEGER"), ("generation", "INTEGER")];
const SEARCH_STATE_COLUMNS: &[(&str, &str)] = &[
    ("singleton", "INTEGER"),
    ("revision", "INTEGER"),
    ("source_revision", "INTEGER"),
    ("synced_source_revision", "INTEGER"),
];
const BLOCK_TAG_COLUMNS: &[(&str, &str)] = &[("block_id", "INTEGER"), ("tag", "TEXT")];
const CHANNEL_COLUMNS: &[(&str, &str)] = &[
    ("id", "INTEGER"),
    ("tag", "TEXT"),
    ("source_slug", "TEXT"),
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
    ("source_stamp", "TEXT"),
];
const SEARCH_WORD_COLUMNS: &[(&str, &str)] = &[("chars", "INTEGER"), ("word", "TEXT")];
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
const VAULT_CONFLICT_COLUMNS: &[(&str, &str)] = &[("path", "TEXT"), ("detected_at", "TEXT")];

const REQUIRED_TABLE_COLUMNS: &[(&str, &[(&str, &str)])] = &[
    ("blocks", BLOCK_COLUMNS),
    ("source_index_state", SOURCE_INDEX_STATE_COLUMNS),
    ("source_dependency_names", SOURCE_DEPENDENCY_NAME_COLUMNS),
    ("projection_state", PROJECTION_STATE_COLUMNS),
    ("search_state", SEARCH_STATE_COLUMNS),
    ("block_tags", BLOCK_TAG_COLUMNS),
    ("channels", CHANNEL_COLUMNS),
    ("wikilinks", LINK_COLUMNS),
    ("related_note_links", LINK_COLUMNS),
    ("search_document_state", SEARCH_DOCUMENT_STATE_COLUMNS),
    ("search_chunks", SEARCH_CHUNK_COLUMNS),
    ("search_words", SEARCH_WORD_COLUMNS),
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
    "idx_blocks_note_name",
    "idx_blocks_extraction_source_name",
    "idx_blocks_association_author",
    "idx_blocks_association_site",
    "idx_blocks_association_address",
    "idx_source_dependency_names_slug",
    "idx_blocks_feed_newest",
    "idx_blocks_feed_oldest",
    "idx_blocks_author_feed_newest",
    "idx_blocks_author_feed_oldest",
    "idx_channels_source_slug",
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
    "search_chunk_terms_ad",
    "search_source_ai",
    "search_source_au",
    "source_dependency_names_ad",
    "source_dependency_names_au",
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
                3 => migrate_v2_to_v3(conn)?,
                4 => migrate_v3_to_v4(conn)?,
                5 => conn
                    .execute_batch(
                        "CREATE TABLE index_build_state (
                        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                        ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1))
                    );
                    INSERT INTO index_build_state (singleton, ready) VALUES (1, 0);",
                    )
                    .context("failed to create index build state")?,
                6 => migrate_v5_to_v6(conn)?,
                7 => migrate_v6_to_v7(conn)?,
                8 => migrate_v7_to_v8(conn)?,
                9 => migrate_v8_to_v9(conn)?,
                10 => migrate_v9_to_v10(conn)?,
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

/// Drop video preview manifests that were written without dimensions.
///
/// Those manifests are why a portrait clip was cropped to landscape: the feed
/// derives a card's aspect ratio from them and falls back to 16/9 when they say
/// nothing. Clearing the column marks them for the regular backfill, which
/// rewrites them from the indexed media dimensions on the next preview pass.
/// Manifests that already carry dimensions are left alone.
fn migrate_v2_to_v3(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE blocks
            SET preview_manifest = NULL
          WHERE preview_manifest IS NOT NULL
            AND json_extract(preview_manifest, '$.kind') = 'video_poster'
            AND json_extract(preview_manifest, '$.width') IS NULL",
        [],
    )
    .context("failed to clear dimensionless video preview manifests")?;
    Ok(())
}

/// Record the source page for each derived collection row. Existing rows are
/// filled by the next source reconciliation; this index remains rebuildable.
fn migrate_v3_to_v4(conn: &Connection) -> Result<()> {
    conn.execute_batch("ALTER TABLE channels ADD COLUMN source_slug TEXT")
        .context("failed to add channels.source_slug")?;
    Ok(())
}

/// Card association columns (SPEC_CARD_ASSOCIATIONS.md, «Модель данных»).
/// Existing rows keep them empty until `backfill_association_index` reads
/// their notes; until then no association is shown, none is wrong.
fn migrate_v5_to_v6(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "ALTER TABLE blocks ADD COLUMN note_name TEXT;
         ALTER TABLE blocks ADD COLUMN extraction_source_name TEXT;
         ALTER TABLE blocks ADD COLUMN association_author TEXT;
         ALTER TABLE blocks ADD COLUMN association_author_key TEXT;
         ALTER TABLE blocks ADD COLUMN association_site TEXT;
         ALTER TABLE blocks ADD COLUMN association_address TEXT;
         ALTER TABLE blocks ADD COLUMN association_index_version INTEGER;
         CREATE INDEX idx_blocks_note_name ON blocks(note_name);
         CREATE INDEX idx_blocks_extraction_source_name ON blocks(extraction_source_name)
             WHERE extraction_source_name IS NOT NULL;
         CREATE INDEX idx_blocks_association_author ON blocks(association_author_key, saved_at)
             WHERE association_author_key IS NOT NULL;
         CREATE INDEX idx_blocks_association_site ON blocks(association_site, saved_at)
             WHERE association_site IS NOT NULL;
         CREATE INDEX idx_blocks_association_address ON blocks(association_address, saved_at)
             WHERE association_address IS NOT NULL;",
    )
    .context("failed to add card association columns")?;
    Ok(())
}

/// Conflicts are the notes the system holds conflict versions of, by their
/// full path from the space root (SPEC_ICLOUD_CONFLICTS.md, ВК6). The rows of
/// the former guess by file name are derived data and are dropped; the next
/// check finds the real conflicts again.
fn migrate_v6_to_v7(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS vault_conflicts;
         CREATE TABLE vault_conflicts (
             path TEXT PRIMARY KEY,
             detected_at TEXT NOT NULL
         );",
    )
    .context("failed to replace vault_conflicts")?;
    Ok(())
}

/// Search that reads no more text than it finds (SPEC_SEARCH.md, «Устройство
/// поиска на большом пространстве»).
///
/// `search_words` is the dictionary of the words the chunks hold and
/// `search_word_chunks` names the chunks of each word; `search_metadata_terms`
/// holds the words of the author and address chunks. Both FTS5 tables keep no
/// content and are keyed by the chunk's id, so a deleted chunk takes its row
/// out with one trigger, also when it goes with its deleted card. Their
/// `ascii` tokenizer leaves the words the search engine writes untouched.
///
/// `search_document_state.source_stamp` is the stamp of the card fields a
/// document was built from. `search_state.source_revision` counts the changes
/// of those fields, and `synced_source_revision` is the count the documents
/// were last compared at: while both are equal a search compares nothing.
/// Documents written before this version have no stamp and no words; the
/// next sync reads them once and keeps their chunks and vectors.
fn migrate_v7_to_v8(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "ALTER TABLE search_document_state ADD COLUMN source_stamp TEXT;
         ALTER TABLE search_state ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE search_state ADD COLUMN synced_source_revision INTEGER;

         CREATE TABLE search_words (
             chars INTEGER NOT NULL,
             word TEXT NOT NULL,
             PRIMARY KEY (chars, word)
         ) WITHOUT ROWID;
         CREATE VIRTUAL TABLE search_word_chunks USING fts5(
             words, content='', contentless_delete=1, detail=none, tokenize='ascii'
         );
         CREATE VIRTUAL TABLE search_metadata_terms USING fts5(
             terms, content='', contentless_delete=1, detail=none, tokenize='ascii'
         );

         CREATE TRIGGER search_chunk_terms_ad AFTER DELETE ON search_chunks BEGIN
             DELETE FROM search_word_chunks WHERE rowid = old.id;
             DELETE FROM search_metadata_terms WHERE rowid = old.id;
         END;
         CREATE TRIGGER search_source_ai AFTER INSERT ON blocks BEGIN
             UPDATE search_state SET source_revision = source_revision + 1 WHERE singleton = 1;
         END;
         CREATE TRIGGER search_source_au
         AFTER UPDATE OF slug, card_kind, description, author, url, body_hash ON blocks
         WHEN old.slug IS NOT new.slug
              OR old.card_kind IS NOT new.card_kind
              OR old.description IS NOT new.description
              OR old.author IS NOT new.author
              OR old.url IS NOT new.url
              OR old.body_hash IS NOT new.body_hash
         BEGIN
             UPDATE search_state SET source_revision = source_revision + 1 WHERE singleton = 1;
         END;",
    )
    .context("failed to add the search word index and document stamps")?;
    Ok(())
}

/// The notes that name a file, found by the file's name without reading
/// every source stamp (SPEC_STORAGE.md, `source_dependency_names`;
/// SPEC_INTEGRATION.md, «Точное перечитывание»).
///
/// `source_dependency_names` holds, for each note, the names of the files
/// its recorded dependencies end in. The code that writes a note's stamp
/// writes its names (`reconcile::write_source_state`); the two triggers take
/// a note's names out when its stamp row goes or changes, so names never
/// outlive the stamp they were read from. Stamps written before this version
/// have no names: they are dropped, and the next pass reads every note
/// again, as the first pass of a new index does.
fn migrate_v8_to_v9(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE source_dependency_names (
             name TEXT NOT NULL,
             slug TEXT NOT NULL,
             PRIMARY KEY (name, slug)
         ) WITHOUT ROWID;
         CREATE INDEX idx_source_dependency_names_slug ON source_dependency_names(slug);

         CREATE TRIGGER source_dependency_names_ad AFTER DELETE ON source_index_state BEGIN
             DELETE FROM source_dependency_names WHERE slug = old.slug;
         END;
         CREATE TRIGGER source_dependency_names_au
         AFTER UPDATE OF slug, source_stamp ON source_index_state BEGIN
             DELETE FROM source_dependency_names WHERE slug = old.slug;
         END;

         DELETE FROM source_index_state;",
    )
    .context("failed to add the names of source dependencies")?;
    Ok(())
}

/// The feed's order read through an index (SPEC_STORAGE.md, «Страница ленты
/// по ключу»; `AUDIT_PERFORMANCE.md`, Л4).
///
/// A page of the feed is the cards after a place in the feed's order
/// (`FeedOrder::order_by`): the save date, then the name without regard to
/// ASCII case, then the name. Until this version no index held that order,
/// and every page walked the whole table and sorted it. Each index holds the
/// order of one direction, for the cards alone (collection pages are no
/// cards of the feed): the date runs one way or the other while the name
/// runs the same way in both, so one index read backwards cannot serve the
/// second direction. The author's feed has the same two behind the author's
/// key, for the cards that have an author: without that condition the open
/// card's group of a site, which asks for cards with no author in the feed's
/// order, was read through the author's index, every card without an author
/// in turn. `idx_blocks_association_author` stays for the open card's
/// groups.
///
/// `idx_channels_source_slug`: a card's link names a collection's page by
/// the page's ref or by its path (`collection_membership_join_sql`). The ref
/// had an index and the path had none, so every row of the feed went
/// through every collection page of the space for each of its links to find
/// its collections: 200 rows of a space of 300 collections, some 150 000
/// pages looked at for one page of the feed.
fn migrate_v9_to_v10(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE INDEX idx_blocks_feed_newest
             ON blocks(saved_at DESC, slug COLLATE NOCASE, slug)
             WHERE card_kind != 'channel';
         CREATE INDEX idx_blocks_feed_oldest
             ON blocks(saved_at, slug COLLATE NOCASE, slug)
             WHERE card_kind != 'channel';
         CREATE INDEX idx_blocks_author_feed_newest
             ON blocks(association_author_key, saved_at DESC, slug COLLATE NOCASE, slug)
             WHERE card_kind != 'channel' AND association_author_key IS NOT NULL;
         CREATE INDEX idx_blocks_author_feed_oldest
             ON blocks(association_author_key, saved_at, slug COLLATE NOCASE, slug)
             WHERE card_kind != 'channel' AND association_author_key IS NOT NULL;
         CREATE INDEX idx_channels_source_slug ON channels(source_slug);",
    )
    .context("failed to index the feed's order")?;
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

pub(crate) fn validate_schema(conn: &Connection) -> Result<()> {
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
        "index_build_state",
        &[("singleton", "INTEGER"), ("ready", "INTEGER")],
    )?;
    let _: bool = conn
        .query_row(
            "SELECT ready FROM index_build_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .context("failed to validate index build state")?;
    validate_table_columns(
        conn,
        "blocks_fts",
        &[("title", ""), ("description", ""), ("body", "")],
    )?;
    validate_table_columns(conn, "search_word_chunks", &[("words", "")])?;
    validate_table_columns(conn, "search_metadata_terms", &[("terms", "")])?;

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
    fn version_three_adds_collection_source_without_losing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
            .unwrap();
        migrate_v0_to_v1(&conn).unwrap();
        migrate_v1_to_v2(&conn).unwrap();
        migrate_v2_to_v3(&conn).unwrap();
        conn.pragma_update(None, "user_version", 3).unwrap();
        conn.execute_batch("COMMIT").unwrap();
        conn.execute(
            "INSERT INTO channels (tag, title, created_at) VALUES ('Design', 'Design', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        migrate_and_validate(&conn).unwrap();

        assert_eq!(user_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM channels WHERE tag = 'Design'",
                [],
                |row| { row.get::<_, i64>(0) }
            )
            .unwrap(),
            1
        );
        assert!(conn
            .query_row(
                "SELECT source_slug IS NULL FROM channels WHERE tag = 'Design'",
                [],
                |row| row.get::<_, bool>(0)
            )
            .unwrap());
    }

    #[test]
    fn version_six_adds_empty_association_columns_without_losing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
            .unwrap();
        migrate_v0_to_v1(&conn).unwrap();
        migrate_v1_to_v2(&conn).unwrap();
        migrate_v2_to_v3(&conn).unwrap();
        migrate_v3_to_v4(&conn).unwrap();
        conn.pragma_update(None, "user_version", 4).unwrap();
        conn.execute_batch("COMMIT").unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, saved_at, author, url)
             VALUES ('Cards/Post', 'article', '2026-01-01T00:00:00Z', '@a', 'https://x.com/a/status/1')",
            [],
        )
        .unwrap();

        migrate_and_validate(&conn).unwrap();

        assert_eq!(user_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        let (author, version): (Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT association_author_key, association_index_version
                 FROM blocks WHERE slug = 'Cards/Post'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((author, version), (None, None));
    }

    /// ВК6, ВК13: version 7 replaces the guessed pairs with conflict paths;
    /// the former rows go, the new table is empty.
    #[test]
    fn version_seven_replaces_guessed_conflict_pairs_with_an_empty_path_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
            .unwrap();
        migrate_v0_to_v1(&conn).unwrap();
        migrate_v1_to_v2(&conn).unwrap();
        migrate_v2_to_v3(&conn).unwrap();
        migrate_v3_to_v4(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE index_build_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1))
            );
            INSERT INTO index_build_state (singleton, ready) VALUES (1, 1);",
        )
        .unwrap();
        migrate_v5_to_v6(&conn).unwrap();
        conn.pragma_update(None, "user_version", 6).unwrap();
        conn.execute_batch("COMMIT").unwrap();
        conn.execute(
            "INSERT INTO vault_conflicts (base_slug, conflict_slug) VALUES ('Note', 'Note (conflicted copy)')",
            [],
        )
        .unwrap();

        migrate_and_validate(&conn).unwrap();

        assert_eq!(user_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        let columns: Vec<String> = table_columns(&conn, "vault_conflicts")
            .unwrap()
            .into_keys()
            .collect();
        assert_eq!(columns, vec!["detected_at".to_string(), "path".to_string()]);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_conflicts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        assert!(validate_schema_object(&conn, "index", "idx_vault_conflicts_base_slug").is_err());
        conn.execute(
            "INSERT INTO vault_conflicts (path, detected_at) VALUES ('Cards/Note.md', '2026-10-11T09:00:00Z')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn a_schema_without_an_association_index_is_refused() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_and_validate(&conn).unwrap();
        conn.execute_batch("DROP INDEX idx_blocks_association_author").unwrap();
        assert!(validate_schema(&conn).is_err());
    }

    #[test]
    fn v3_clears_only_video_manifests_that_lack_dimensions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate_and_validate(&conn).unwrap();

        let rows = [
            (
                "stale-video",
                r#"{"kind":"video_poster","width":null,"height":null}"#,
            ),
            (
                "measured-video",
                r#"{"kind":"video_poster","width":588,"height":720}"#,
            ),
            ("image", r#"{"kind":"image","width":null,"height":null}"#),
        ];
        for (slug, manifest) in rows {
            conn.execute(
                "INSERT INTO blocks (slug, block_type, saved_at, body, preview_manifest)
                 VALUES (?1, 'article', '2026-01-01T00:00:00Z', '', ?2)",
                rusqlite::params![slug, manifest],
            )
            .unwrap();
        }

        migrate_v2_to_v3(&conn).unwrap();

        let cleared = |slug: &str| -> bool {
            conn.query_row(
                "SELECT preview_manifest IS NULL FROM blocks WHERE slug = ?1",
                [slug],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()
        };
        assert!(cleared("stale-video"));
        // An image manifest without dimensions is a different case and is not
        // this migration's business; a measured video needs no rewrite.
        assert!(!cleared("measured-video"));
        assert!(!cleared("image"));
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

    /// SPEC_SEARCH.md, «Отметка документа» and «Словарь слов»: version 8
    /// keeps the search documents written before it, without a stamp, and
    /// starts counting the changes a document depends on.
    #[test]
    fn version_eight_keeps_search_documents_and_counts_their_source_changes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
            .unwrap();
        migrate_v0_to_v1(&conn).unwrap();
        migrate_v1_to_v2(&conn).unwrap();
        migrate_v2_to_v3(&conn).unwrap();
        migrate_v3_to_v4(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE index_build_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1))
            );
            INSERT INTO index_build_state (singleton, ready) VALUES (1, 1);",
        )
        .unwrap();
        migrate_v5_to_v6(&conn).unwrap();
        migrate_v6_to_v7(&conn).unwrap();
        conn.pragma_update(None, "user_version", 7).unwrap();
        conn.execute_batch("COMMIT").unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, card_kind, saved_at, body, body_hash)
             VALUES ('legacy-search', 'article', 'article', '2026-07-11T00:00:00Z', 'body', 'hash-1')",
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
        let chunk_id = conn.last_insert_rowid();

        migrate_and_validate(&conn).unwrap();

        assert_eq!(user_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        let (hash, stamp): (String, Option<String>) = conn
            .query_row(
                "SELECT document_hash, source_stamp FROM search_document_state WHERE block_id = ?1",
                [block_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((hash.as_str(), stamp), ("document-hash", None));
        let revisions = |conn: &Connection| -> (i64, Option<i64>) {
            conn.query_row(
                "SELECT source_revision, synced_source_revision FROM search_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(revisions(&conn), (0, None));

        // A field no document depends on leaves the count alone.
        conn.execute("UPDATE blocks SET preview_state = 'ready' WHERE id = ?1", [block_id])
            .unwrap();
        // So does a write that changes none of the fields it names.
        conn.execute("UPDATE blocks SET body_hash = 'hash-1', author = NULL WHERE id = ?1", [block_id])
            .unwrap();
        assert_eq!(revisions(&conn).0, 0);
        conn.execute("UPDATE blocks SET body_hash = 'hash-2' WHERE id = ?1", [block_id])
            .unwrap();
        assert_eq!(revisions(&conn).0, 1);
        conn.execute(
            "INSERT INTO blocks (slug, block_type, card_kind, saved_at, body)
             VALUES ('new-card', 'article', 'article', '2026-07-12T00:00:00Z', '')",
            [],
        )
        .unwrap();
        assert_eq!(revisions(&conn).0, 2);

        // A chunk takes its rows of both word indexes with it, also when it
        // goes with its card.
        conn.execute(
            "INSERT INTO search_word_chunks (rowid, words) VALUES (?1, 'legacy text')",
            [chunk_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO search_metadata_terms (rowid, terms) VALUES (?1, 'legacy')",
            [chunk_id],
        )
        .unwrap();
        let indexed = |conn: &Connection, table: &str| -> i64 {
            conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {table} MATCH '\"legacy\"'"),
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(indexed(&conn, "search_word_chunks"), 1);
        assert_eq!(indexed(&conn, "search_metadata_terms"), 1);
        conn.execute("DELETE FROM blocks WHERE id = ?1", [block_id])
            .unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM search_chunks", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(indexed(&conn, "search_word_chunks"), 0);
        assert_eq!(indexed(&conn, "search_metadata_terms"), 0);
    }

    /// SPEC_STORAGE.md, `source_dependency_names`: version 9 drops the source
    /// stamps written before it, which carry no names, so the next pass
    /// reads every note again; and names never outlive the stamp row they
    /// were written with.
    #[test]
    fn version_nine_drops_stamps_without_names_and_keeps_names_with_their_stamp() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
            .unwrap();
        migrate_v0_to_v1(&conn).unwrap();
        migrate_v1_to_v2(&conn).unwrap();
        migrate_v2_to_v3(&conn).unwrap();
        migrate_v3_to_v4(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE index_build_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1))
            );
            INSERT INTO index_build_state (singleton, ready) VALUES (1, 1);",
        )
        .unwrap();
        migrate_v5_to_v6(&conn).unwrap();
        migrate_v6_to_v7(&conn).unwrap();
        migrate_v7_to_v8(&conn).unwrap();
        conn.pragma_update(None, "user_version", 8).unwrap();
        conn.execute_batch("COMMIT").unwrap();
        conn.execute(
            "INSERT INTO source_index_state (slug, source_kind, source_stamp)
             VALUES ('Legacy', 'block', '{}')",
            [],
        )
        .unwrap();

        migrate_and_validate(&conn).unwrap();

        assert_eq!(user_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        let count = |conn: &Connection, table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(count(&conn, "source_index_state"), 0, "a stamp without names stayed");

        let write_names = |conn: &Connection, slug: &str| {
            conn.execute(
                "INSERT INTO source_dependency_names (name, slug) VALUES ('photo.jpg', ?1)",
                [slug],
            )
            .unwrap();
        };
        for slug in ["Kept", "Changed", "Gone"] {
            conn.execute(
                "INSERT INTO source_index_state (slug, source_kind, source_stamp)
                 VALUES (?1, 'block', 'first')",
                [slug],
            )
            .unwrap();
            write_names(&conn, slug);
        }
        // A write that leaves the stamp as it is leaves the names.
        conn.execute(
            "UPDATE source_index_state SET updated_at = datetime('now') WHERE slug = 'Kept'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE source_index_state SET source_stamp = 'second' WHERE slug = 'Changed'",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM source_index_state WHERE slug = 'Gone'", [])
            .unwrap();
        let named: Vec<String> = conn
            .prepare("SELECT slug FROM source_dependency_names ORDER BY slug")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(named, ["Kept"]);
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
