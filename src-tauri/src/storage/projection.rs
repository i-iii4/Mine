//! Atomic route-facing snapshots of the rebuildable SQLite projection.
//!
//! Contract: SPEC_STORAGE.md#storageprojection--committed-generation-contract

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;

use crate::storage::index::{self, LightBlock};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GridSnapshot {
    pub generation: u64,
    pub blocks: Vec<LightBlock>,
    pub total_blocks: usize,
    pub has_more: bool,
}

/// Return the persisted identity of the currently committed projection.
pub fn current_generation(conn: &Connection) -> Result<u64> {
    let value: i64 = conn
        .query_row(
            "SELECT generation FROM projection_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .context("failed to read projection generation")?;
    u64::try_from(value).context("projection generation is negative")
}

/// Read one coherent route snapshot. The savepoint establishes one SQLite
/// snapshot for generation, rows and totals, and remains nestable for tests and
/// search paths that already own a transaction.
pub fn read_grid_snapshot(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
    query: Option<&str>,
) -> Result<GridSnapshot> {
    conn.execute_batch("SAVEPOINT read_grid_snapshot")
        .context("failed to begin Grid projection snapshot")?;
    let result = (|| -> Result<GridSnapshot> {
        let generation = current_generation(conn)?;
        let (blocks, has_more) =
            index::list_grid_blocks_with_query(conn, tag, offset, limit, query)?;
        Ok(GridSnapshot {
            generation,
            blocks,
            total_blocks: index::count_grid_blocks(conn)?,
            has_more,
        })
    })();

    match result {
        Ok(snapshot) => {
            conn.execute_batch("RELEASE SAVEPOINT read_grid_snapshot")
                .context("failed to release Grid projection snapshot")?;
            Ok(snapshot)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK TO SAVEPOINT read_grid_snapshot");
            let _ = conn.execute_batch("RELEASE SAVEPOINT read_grid_snapshot");
            Err(error)
        }
    }
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
                title: None,
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
            body: "Readable body".to_string(),
        }
    }

    #[test]
    fn block_and_preview_writes_advance_the_persisted_generation() {
        let conn = db::open_memory().unwrap();
        assert_eq!(current_generation(&conn).unwrap(), 0);

        index::upsert_block(&conn, &block("one"), None).unwrap();
        let after_insert = current_generation(&conn).unwrap();
        assert!(after_insert > 0);

        conn.execute(
            "UPDATE blocks SET preview_state = 'ready' WHERE slug = 'one'",
            [],
        )
        .unwrap();
        let after_preview = current_generation(&conn).unwrap();
        assert!(after_preview > after_insert);

        index::remove_block(&conn, "one").unwrap();
        assert!(current_generation(&conn).unwrap() > after_preview);
    }

    #[test]
    fn grid_snapshot_carries_the_committed_generation() {
        let conn = db::open_memory().unwrap();
        index::upsert_block(&conn, &block("one"), None).unwrap();

        let snapshot = read_grid_snapshot(&conn, None, 0, 20, None).unwrap();

        assert_eq!(snapshot.generation, current_generation(&conn).unwrap());
        assert_eq!(snapshot.total_blocks, 1);
        assert_eq!(snapshot.blocks[0].slug, "one");
        assert!(!snapshot.has_more);
    }

    #[test]
    fn search_uses_the_same_generation_envelope() {
        let conn = db::open_memory().unwrap();
        index::upsert_block(&conn, &block("searchable"), None).unwrap();

        let snapshot = read_grid_snapshot(&conn, None, 0, 20, Some("readable")).unwrap();

        assert_eq!(snapshot.generation, current_generation(&conn).unwrap());
        assert_eq!(snapshot.blocks.len(), 1);
        assert_eq!(snapshot.blocks[0].slug, "searchable");
        assert!(snapshot.blocks[0].search_match.is_some());
    }
}
