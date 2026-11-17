//! Revision-safe hybrid search snapshots and pagination cursors.

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::storage::index::LightBlock;
use crate::storage::{projection, search_engine};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type,
)]
#[serde(transparent)]
#[specta(transparent)]
pub struct SearchRevision(pub u64);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SearchPageToken {
    pub projection_revision: projection::ProjectionRevision,
    pub search_revision: SearchRevision,
    pub offset: usize,
    pub query_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct SearchSnapshot {
    pub generation: projection::ProjectionRevision,
    pub search_generation: SearchRevision,
    pub blocks: Vec<LightBlock>,
    pub has_more: bool,
    pub next_cursor: Option<SearchPageToken>,
    pub cursor_reset: bool,
}

pub fn current_revision(conn: &Connection) -> Result<SearchRevision> {
    let value: i64 = conn
        .query_row(
            "SELECT revision FROM search_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .context("failed to read search revision")?;
    Ok(SearchRevision(
        u64::try_from(value).context("search revision is negative")?,
    ))
}

pub fn read_search_snapshot(
    conn: &Connection,
    tag: Option<&str>,
    query: &str,
    limit: usize,
    cursor: Option<&SearchPageToken>,
) -> Result<SearchSnapshot> {
    read_search_snapshot_observed(
        conn,
        tag,
        query,
        limit,
        cursor,
        &mut search_engine::SearchRun::unobserved(),
    )
}

/// [`read_search_snapshot`] followed by its caller: `run` stops the search
/// between its steps once a newer one took its place, and takes the time of
/// each step (SPEC_SEARCH.md, «Отмена устаревшего запроса», «Замер шагов»).
///
/// The documents are synced inside the snapshot: a snapshot that fails or is
/// stopped takes its sync back with it, the synced revision included, and the
/// next search syncs again.
///
/// A sync that cannot write because another connection is writing the index
/// (the warm-up rebuilding the documents) is left to the next search: this
/// one answers from the documents as they are, as a read-only search does,
/// instead of failing with a locked database.
pub fn read_search_snapshot_observed(
    conn: &Connection,
    tag: Option<&str>,
    query: &str,
    limit: usize,
    cursor: Option<&SearchPageToken>,
    run: &mut search_engine::SearchRun<'_>,
) -> Result<SearchSnapshot> {
    projection::read_projection_snapshot(conn, |conn, generation| {
        let synced = run.step(search_engine::SearchStep::Sync, |run| {
            search_engine::sync_search_documents_observed(conn, run)
        });
        match synced {
            Ok(_) => {}
            Err(error) if is_database_busy(&error) => {
                log::warn!("search documents are being written by another connection; searching them as they are: {error:#}");
            }
            Err(error) => return Err(error),
        }
        let search_generation = current_revision(conn)?;
        let query_fingerprint = search_query_fingerprint(tag, query);
        let cursor_matches = cursor.is_some_and(|token| {
            token.projection_revision == generation
                && token.search_revision == search_generation
                && token.query_fingerprint == query_fingerprint
        });
        let cursor_reset = cursor.is_some() && !cursor_matches;
        let offset = cursor
            .filter(|_| cursor_matches)
            .map_or(0, |token| token.offset);
        let (blocks, has_more) = search_engine::search_grid_blocks_prepared(
            conn,
            tag,
            offset,
            limit.max(1),
            query,
            run,
        )?;
        let next_cursor = has_more.then(|| SearchPageToken {
            projection_revision: generation,
            search_revision: search_generation,
            offset: offset.saturating_add(blocks.len()),
            query_fingerprint,
        });

        Ok(SearchSnapshot {
            generation,
            search_generation,
            blocks,
            has_more,
            next_cursor,
            cursor_reset,
        })
    })
}

/// Whether `error` is SQLite refusing a write because another connection
/// holds the write lock or has written since this one's snapshot began.
fn is_database_busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<rusqlite::Error>()
            .and_then(rusqlite::Error::sqlite_error_code)
            .is_some_and(|code| {
                matches!(
                    code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                )
            })
    })
}

fn search_query_fingerprint(tag: Option<&str>, query: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(tag.unwrap_or_default().trim().as_bytes());
    hasher.update([0]);
    hasher.update(query.trim().as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::storage::{db, index};

    fn block(slug: &str) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: Some(format!("Search {slug}")),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: Vec::new(),
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-07-11T00:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: "shared searchable phrase".to_string(),
        }
    }

    fn seeded_connection() -> Connection {
        let conn = db::open_memory().unwrap();
        for slug in ["alpha", "beta", "gamma"] {
            index::upsert_block(&conn, &block(slug), None).unwrap();
        }
        conn
    }

    #[test]
    fn stable_cursor_continues_the_same_projection_and_search_revisions() {
        let conn = seeded_connection();
        let first = read_search_snapshot(&conn, None, "searchable", 2, None).unwrap();
        let cursor = first.next_cursor.clone().unwrap();

        let second = read_search_snapshot(&conn, None, "searchable", 2, Some(&cursor)).unwrap();

        assert!(!second.cursor_reset);
        assert_eq!(second.generation, first.generation);
        assert_eq!(second.search_generation, first.search_generation);
        assert_eq!(first.blocks.len(), 2);
        assert_eq!(second.blocks.len(), 1);
        assert!(first
            .blocks
            .iter()
            .all(|block| !second.blocks.iter().any(|next| next.slug == block.slug)));
    }

    #[test]
    fn search_index_change_resets_cursor_without_changing_projection_revision() {
        let conn = seeded_connection();
        let first = read_search_snapshot(&conn, None, "searchable", 1, None).unwrap();
        let cursor = first.next_cursor.clone().unwrap();
        let chunk_id: i64 = conn
            .query_row(
                "SELECT id FROM search_chunks ORDER BY id LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO search_embeddings(chunk_id, model_id, dim, vector, text_hash)
             SELECT id, 'test-model', 1, x'00000000', text_hash
             FROM search_chunks WHERE id = ?1",
            [chunk_id],
        )
        .unwrap();

        let restarted = read_search_snapshot(&conn, None, "searchable", 1, Some(&cursor)).unwrap();

        assert!(restarted.cursor_reset);
        assert_eq!(restarted.generation, first.generation);
        assert!(restarted.search_generation > first.search_generation);
        assert_eq!(restarted.blocks[0].slug, first.blocks[0].slug);
    }

    #[test]
    fn projection_change_resets_cursor_and_returns_a_fresh_first_page() {
        let conn = seeded_connection();
        let first = read_search_snapshot(&conn, None, "searchable", 1, None).unwrap();
        let cursor = first.next_cursor.clone().unwrap();
        index::upsert_block(&conn, &block("delta"), None).unwrap();

        let restarted = read_search_snapshot(&conn, None, "searchable", 1, Some(&cursor)).unwrap();

        assert!(restarted.cursor_reset);
        assert!(restarted.generation > first.generation);
        assert_eq!(restarted.blocks.len(), 1);
    }

    #[test]
    fn a_sync_rolled_back_with_its_snapshot_is_redone_by_the_next_search() {
        // Б2.5: a search that synced an edited card and then failed rolls
        // the new chunks back; the next search must write them again rather
        // than trust that this process already synced them.
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open_or_create(&dir.path().join("index.db")).unwrap();
        let mut edited = block("alpha");
        index::upsert_block(&conn, &edited, None).unwrap();
        read_search_snapshot(&conn, None, "searchable", 5, None).unwrap();

        edited.body = "rewritten lighthouse passage".to_string();
        index::upsert_block(&conn, &edited, None).unwrap();
        // The step after the sync fails inside the snapshot: its search
        // revision cannot be read.
        conn.execute("UPDATE search_state SET revision = -1000000 WHERE singleton = 1", [])
            .unwrap();
        assert!(read_search_snapshot(&conn, None, "lighthouse", 5, None).is_err());
        conn.execute("UPDATE search_state SET revision = 0 WHERE singleton = 1", [])
            .unwrap();

        read_search_snapshot(&conn, None, "lighthouse", 5, None).unwrap();
        let text: String = conn
            .query_row(
                "SELECT group_concat(text, ' ') FROM search_chunks WHERE slug = 'alpha'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(text.contains("rewritten lighthouse passage"), "{text}");
    }

    #[test]
    fn a_search_answers_from_the_documents_as_they_are_while_another_connection_writes() {
        // The warm-up rebuilds the documents in its own transactions. A
        // search that cannot sync meanwhile still answers, and syncs once
        // the index is free.
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.db");
        let writer = db::open_or_create(&index).unwrap();
        index::upsert_block(&writer, &block("alpha"), None).unwrap();
        let conn = db::open_or_create(&index).unwrap();
        conn.busy_timeout(std::time::Duration::from_millis(20)).unwrap();
        let synced_revision = |conn: &Connection| -> Option<i64> {
            conn.query_row(
                "SELECT synced_source_revision FROM search_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };

        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        index::upsert_block(&writer, &block("beta"), None).unwrap();
        let busy = read_search_snapshot(&conn, None, "searchable", 5, None).unwrap();
        assert_eq!(busy.blocks.len(), 1);
        assert_eq!(busy.blocks[0].slug, "alpha");
        assert_eq!(synced_revision(&conn), None);
        writer.execute_batch("COMMIT").unwrap();

        let free = read_search_snapshot(&conn, None, "searchable", 5, None).unwrap();
        assert_eq!(free.blocks.len(), 2);
        assert!(synced_revision(&conn).is_some());
    }

    #[test]
    fn cursor_cannot_be_reused_for_another_query() {
        let conn = seeded_connection();
        let first = read_search_snapshot(&conn, None, "searchable", 1, None).unwrap();
        let cursor = first.next_cursor.clone().unwrap();

        let restarted = read_search_snapshot(&conn, None, "alpha", 1, Some(&cursor)).unwrap();

        assert!(restarted.cursor_reset);
        assert_eq!(restarted.blocks[0].slug, "alpha");
    }
}
