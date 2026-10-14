// How many cards a route shows: Everything or one collection.
//
// Storage-only: no Tauri state, no UI formatting, no event emission.

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::storage::index;

/// The cards of a route: the collection's members, or every card of the feed
/// for Everything (`None`).
pub fn count_current_collection_cards(
    conn: &Connection,
    current_collection: Option<&str>,
) -> Result<u64> {
    if let Some(collection_ref) = current_collection {
        // Members only: a name without a collection page is no place
        // (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К9).
        let membership =
            crate::storage::block_queries::collection_membership_join_sql("bt", "page");
        let count: i64 = conn.query_row(
            &format!(
                "SELECT COUNT(DISTINCT b.id)
                 FROM blocks b
                 JOIN block_tags bt ON bt.block_id = b.id
                 {membership}
                 WHERE b.card_kind != 'channel' AND page.tag = ?1"
            ),
            params![collection_ref],
            |row| row.get(0),
        )?;
        return Ok(count as u64);
    }

    Ok(index::count_grid_blocks(conn)? as u64)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::domain::vault::VaultLayout;
    use crate::storage::{db, index};

    fn make_block(slug: &str, block_type: BlockType, body: &str, tags: &[&str]) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type,
                title: Some(slug.to_string()),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                related_notes: Vec::new(),
                source_media: None,
                // infallible: parsing a hardcoded valid ISO-8601 literal.
                saved_at: DateTime::new("2026-01-01T00:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
                tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
            },
            body: body.to_string(),
        }
    }

    fn insert_block(conn: &Connection, block: &Block, vault: &VaultLayout) {
        index::upsert_block_with_diagnostics(conn, block, Some(vault.root()), None, None).unwrap();
    }

    #[test]
    fn vault_stats_count_everything_and_current_collection_from_index() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_memory().unwrap();
        insert_block(
            &conn,
            &make_block("alpha", BlockType::Article, "body", &["Design"]),
            &vault,
        );
        insert_block(
            &conn,
            &make_block("beta", BlockType::Image, "", &["Other"]),
            &vault,
        );
        let page = make_block("Design", BlockType::Channel, "", &[]);
        insert_block(&conn, &page, &vault);
        index::upsert_channel_from_block(&conn, &page).unwrap();

        assert_eq!(count_current_collection_cards(&conn, None).unwrap(), 2);
        assert_eq!(
            count_current_collection_cards(&conn, Some("Design")).unwrap(),
            1,
        );
        // "Other" has no page: no collection, no members
        // (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К9).
        assert_eq!(count_current_collection_cards(&conn, Some("Other")).unwrap(), 0);
    }
}
