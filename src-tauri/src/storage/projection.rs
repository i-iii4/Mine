//! Atomic route-facing snapshots of the rebuildable SQLite projection.
//!
//! Contract: SPEC_STORAGE.md#storageprojection--committed-generation-contract

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::storage::index::{self, LightBlock};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type,
)]
#[serde(transparent)]
#[specta(transparent)]
pub struct ProjectionRevision(pub u64);

impl std::fmt::Display for ProjectionRevision {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct GridSnapshot {
    pub generation: ProjectionRevision,
    pub blocks: Vec<LightBlock>,
    pub total_blocks: usize,
    pub has_more: bool,
}

/// Return the persisted identity of the currently committed projection.
pub fn current_generation(conn: &Connection) -> Result<ProjectionRevision> {
    let value: i64 = conn
        .query_row(
            "SELECT generation FROM projection_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .context("failed to read projection generation")?;
    Ok(ProjectionRevision(
        u64::try_from(value).context("projection generation is negative")?,
    ))
}

/// Read one route-facing projection under a single SQLite snapshot.
///
/// The caller owns the DTO shape; this module owns the revision/read atomicity
/// shared by Grid, taxonomy, sidebar previews and Graph.
pub fn read_projection_snapshot<T>(
    conn: &Connection,
    read: impl FnOnce(&Connection, ProjectionRevision) -> Result<T>,
) -> Result<T> {
    conn.execute_batch("SAVEPOINT read_projection_snapshot")
        .context("failed to begin projection snapshot")?;
    let result = (|| -> Result<T> {
        let revision = current_generation(conn)?;
        read(conn, revision)
    })();

    match result {
        Ok(snapshot) => {
            conn.execute_batch("RELEASE SAVEPOINT read_projection_snapshot")
                .context("failed to release projection snapshot")?;
            Ok(snapshot)
        }
        Err(error) => {
            let rollback = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT read_projection_snapshot;
                 RELEASE SAVEPOINT read_projection_snapshot;",
            );
            match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(error.context(format!(
                    "projection snapshot rollback also failed: {rollback_error}"
                ))),
            }
        }
    }
}

/// Read one coherent route snapshot. The savepoint establishes one SQLite
/// snapshot for generation, rows and totals, and remains nestable for tests and
/// search paths that already own a transaction.
pub fn read_grid_snapshot(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<GridSnapshot> {
    read_projection_snapshot(conn, |conn, generation| {
        let (blocks, has_more) = index::list_grid_blocks(conn, tag, offset, limit)?;
        Ok(GridSnapshot {
            generation,
            blocks,
            total_blocks: index::count_grid_blocks(conn)?,
            has_more,
        })
    })
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
        assert_eq!(current_generation(&conn).unwrap(), ProjectionRevision(0));

        index::upsert_block(&conn, &block("one"), None).unwrap();
        let after_insert = current_generation(&conn).unwrap();
        assert!(after_insert > ProjectionRevision(0));

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

        let snapshot = read_grid_snapshot(&conn, None, 0, 20).unwrap();

        assert_eq!(snapshot.generation, current_generation(&conn).unwrap());
        assert_eq!(snapshot.total_blocks, 1);
        assert_eq!(snapshot.blocks[0].slug, "one");
        assert!(!snapshot.has_more);
    }

    #[test]
    fn shared_snapshot_helper_keeps_revision_and_rows_on_one_sqlite_view() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("projection.db");
        let writer = db::open_or_create(&db_path).unwrap();
        index::upsert_block(&writer, &block("one"), None).unwrap();
        drop(writer);

        let reader = db::open_read_only(&db_path).unwrap();
        let (read_started_tx, read_started_rx) = std::sync::mpsc::channel();
        let (write_done_tx, write_done_rx) = std::sync::mpsc::channel();
        let writer_path = db_path.clone();
        let writer_thread = std::thread::spawn(move || {
            read_started_rx.recv().unwrap();
            let writer = db::open_or_create(&writer_path).unwrap();
            index::upsert_block(&writer, &block("two"), None).unwrap();
            write_done_tx.send(()).unwrap();
        });

        let (revision, before, after) = read_projection_snapshot(&reader, |conn, revision| {
            let before = index::count_grid_blocks(conn)?;
            read_started_tx.send(()).unwrap();
            write_done_rx.recv().unwrap();
            let after = index::count_grid_blocks(conn)?;
            Ok((revision, before, after))
        })
        .unwrap();
        writer_thread.join().unwrap();

        assert_eq!((before, after), (1, 1));
        let latest = db::open_read_only(&db_path).unwrap();
        assert!(current_generation(&latest).unwrap() > revision);
        assert_eq!(index::count_grid_blocks(&latest).unwrap(), 2);
    }
}
