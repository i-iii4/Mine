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
    projection::read_projection_snapshot(conn, |conn, generation| {
        search_engine::sync_search_documents(conn)?;
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
        let (blocks, has_more) =
            search_engine::search_grid_blocks_prepared(conn, tag, offset, limit.max(1), query)?;
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
    fn cursor_cannot_be_reused_for_another_query() {
        let conn = seeded_connection();
        let first = read_search_snapshot(&conn, None, "searchable", 1, None).unwrap();
        let cursor = first.next_cursor.clone().unwrap();

        let restarted = read_search_snapshot(&conn, None, "alpha", 1, Some(&cursor)).unwrap();

        assert!(restarted.cursor_reset);
        assert_eq!(restarted.blocks[0].slug, "alpha");
    }
}
