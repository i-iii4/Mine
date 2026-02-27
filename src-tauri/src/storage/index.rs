// Index: SQLite CRUD for blocks, channels, and tags.
//
// Converts domain::Block into database rows and reads them back.
// Handles FTS5 search queries with type and tag filters.
//
// Contract: SPEC_STORAGE.md#storage/index

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::domain::block::{extract_wikilinks, Block, BlockType, DateTime};
use crate::domain::channel::Channel;
use crate::domain::search::{SearchFilter, SearchQuery};

// ─── Types ──────────────────────────────────────────────────────────────────

/// A block as read from the database index.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IndexedBlock {
    pub id: i64,
    pub slug: String,
    pub block_type: BlockType,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub media_file: Option<String>,
    pub thumbnail: Option<String>,
    pub saved_at: String,
    pub source: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub author: Option<String>,
    pub body: String,
    pub tags: Vec<String>,
}

/// A tag with its usage count across blocks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Insert or update a block in the index. Returns the block's row id.
///
/// On conflict (same slug): updates all fields, replaces tags and wikilinks.
/// FTS5 is updated automatically through triggers.
pub fn upsert_block(conn: &Connection, block: &Block) -> Result<i64> {
    conn.execute(
        "INSERT INTO blocks (slug, block_type, title, description, url, media_file,
            thumbnail, saved_at, source, width, height, author, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(slug) DO UPDATE SET
            block_type = excluded.block_type,
            title = excluded.title,
            description = excluded.description,
            url = excluded.url,
            media_file = excluded.media_file,
            thumbnail = excluded.thumbnail,
            saved_at = excluded.saved_at,
            source = excluded.source,
            width = excluded.width,
            height = excluded.height,
            author = excluded.author,
            body = excluded.body,
            indexed_at = datetime('now')",
        params![
            block.slug,
            block.frontmatter.block_type.as_str(),
            block.frontmatter.title,
            block.frontmatter.description,
            block.frontmatter.url,
            block.frontmatter.file,
            block.frontmatter.thumbnail,
            block.frontmatter.saved_at.as_str(),
            block.frontmatter.source,
            block.frontmatter.width.map(|w| w as i64),
            block.frontmatter.height.map(|h| h as i64),
            block.frontmatter.author,
            block.body,
        ],
    )
    .context("failed to upsert block")?;

    let block_id: i64 = conn
        .query_row(
            "SELECT id FROM blocks WHERE slug = ?1",
            [&block.slug],
            |row| row.get(0),
        )
        .context("failed to get block id after upsert")?;

    // Replace tags: delete old, insert new.
    conn.execute("DELETE FROM block_tags WHERE block_id = ?1", [block_id])
        .context("failed to delete old tags")?;
    for tag in &block.frontmatter.tags {
        conn.execute(
            "INSERT INTO block_tags (block_id, tag) VALUES (?1, ?2)",
            params![block_id, tag],
        )
        .context("failed to insert tag")?;
    }

    // Replace wikilinks: delete old, insert new.
    conn.execute("DELETE FROM wikilinks WHERE source_id = ?1", [block_id])
        .context("failed to delete old wikilinks")?;
    let links = extract_wikilinks(&block.body);
    for link in &links {
        conn.execute(
            "INSERT OR IGNORE INTO wikilinks (source_id, target_slug) VALUES (?1, ?2)",
            params![block_id, link],
        )
        .context("failed to insert wikilink")?;
    }

    Ok(block_id)
}

/// Remove a block from the index by slug. Returns true if a block was removed.
pub fn remove_block(conn: &Connection, slug: &str) -> Result<bool> {
    let count = conn
        .execute("DELETE FROM blocks WHERE slug = ?1", [slug])
        .context("failed to delete block")?;
    Ok(count > 0)
}

/// Get a single block by slug. Returns None if not found.
pub fn get_block(conn: &Connection, slug: &str) -> Result<Option<IndexedBlock>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, slug, block_type, title, description, url, media_file,
                    thumbnail, saved_at, source, width, height, author, body
             FROM blocks WHERE slug = ?1",
        )
        .context("failed to prepare get_block")?;

    match stmt.query_row([slug], row_to_block) {
        Ok(mut block) => {
            block.tags = get_tags_for_block(conn, block.id)?;
            Ok(Some(block))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// List all blocks, ordered by saved_at descending (newest first).
pub fn list_blocks(conn: &Connection) -> Result<Vec<IndexedBlock>> {
    let mut stmt = conn.prepare(
        "SELECT id, slug, block_type, title, description, url, media_file,
                thumbnail, saved_at, source, width, height, author, body
         FROM blocks ORDER BY saved_at DESC",
    )?;
    collect_blocks(conn, &mut stmt, &[] as &[&dyn rusqlite::types::ToSql])
}

/// List blocks with a specific tag, ordered by saved_at descending.
pub fn list_blocks_by_tag(conn: &Connection, tag: &str) -> Result<Vec<IndexedBlock>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.slug, b.block_type, b.title, b.description, b.url,
                b.media_file, b.thumbnail, b.saved_at, b.source, b.width,
                b.height, b.author, b.body
         FROM blocks b
         JOIN block_tags bt ON bt.block_id = b.id
         WHERE bt.tag = ?1
         ORDER BY b.saved_at DESC",
    )?;
    collect_blocks(conn, &mut stmt, &[&tag as &dyn rusqlite::types::ToSql])
}

/// Get all tags with their block counts, ordered by count descending.
pub fn get_all_tags(conn: &Connection) -> Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT tag, count(*) as cnt FROM block_tags
         GROUP BY tag ORDER BY cnt DESC, tag ASC",
    )?;
    let tags = stmt
        .query_map([], |row| {
            Ok(TagCount {
                tag: row.get(0)?,
                count: row.get::<_, i64>(1)? as usize,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(tags)
}

/// Search blocks using a structured query (free text + filters).
///
/// Builds SQL dynamically:
/// - Free text: JOIN blocks_fts WHERE MATCH ?
/// - Type filter: WHERE block_type = ?
/// - Tag filter: JOIN block_tags WHERE tag = ?
/// - Multiple filters: AND between all conditions
pub fn search_blocks(conn: &Connection, query: &SearchQuery) -> Result<Vec<IndexedBlock>> {
    if query.is_empty() {
        return list_blocks(conn);
    }

    let mut joins = Vec::new();
    let mut conditions = Vec::new();
    let mut param_values: Vec<String> = Vec::new();

    // FTS5 free-text search
    if !query.text.is_empty() {
        joins.push("JOIN blocks_fts ON blocks_fts.rowid = b.id".to_string());
        conditions.push(format!("blocks_fts MATCH ?{}", param_values.len() + 1));
        param_values.push(query.text.clone());
    }

    // Filters
    let mut tag_alias_idx = 0;
    for filter in &query.filters {
        match filter {
            SearchFilter::Tag(tag) => {
                let alias = format!("bt{}", tag_alias_idx);
                joins.push(format!(
                    "JOIN block_tags {a} ON {a}.block_id = b.id",
                    a = alias
                ));
                conditions.push(format!("{}.tag = ?{}", alias, param_values.len() + 1));
                param_values.push(tag.clone());
                tag_alias_idx += 1;
            }
            SearchFilter::Type(bt) => {
                conditions.push(format!("b.block_type = ?{}", param_values.len() + 1));
                param_values.push(bt.as_str().to_string());
            }
        }
    }

    let mut sql = String::from(
        "SELECT DISTINCT b.id, b.slug, b.block_type, b.title, b.description, b.url,
                b.media_file, b.thumbnail, b.saved_at, b.source, b.width,
                b.height, b.author, b.body
         FROM blocks b",
    );

    for join in &joins {
        sql.push(' ');
        sql.push_str(join);
    }
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    sql.push_str(" ORDER BY b.saved_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    collect_blocks(conn, &mut stmt, &param_refs)
}

/// Insert or update a channel. Returns the channel's row id.
pub fn upsert_channel(conn: &Connection, channel: &Channel) -> Result<i64> {
    conn.execute(
        "INSERT INTO channels (tag, title, description, color, icon, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(tag) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            color = excluded.color,
            icon = excluded.icon,
            position = excluded.position",
        params![
            channel.tag,
            channel.title,
            channel.description,
            channel.color,
            channel.icon,
            channel.position as i64,
            channel.created_at.as_str(),
        ],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM channels WHERE tag = ?1",
        [&channel.tag],
        |row| row.get(0),
    )?;
    Ok(id)
}

/// List all channels ordered by position, then title.
pub fn list_channels(conn: &Connection) -> Result<Vec<Channel>> {
    let mut stmt = conn.prepare(
        "SELECT tag, title, description, color, icon, position, created_at
         FROM channels ORDER BY position ASC, title ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    rows.into_iter()
        .map(|(tag, title, description, color, icon, position, created_at)| {
            let dt = DateTime::new(&created_at)
                .map_err(|e| anyhow::anyhow!("invalid datetime in channel: {}", e))?;
            let mut ch = Channel::new(&tag, Some(&title), dt)
                .map_err(|e| anyhow::anyhow!("invalid channel from db: {}", e))?;
            ch.description = description;
            ch.color = color;
            ch.icon = icon;
            ch.position = position as u32;
            Ok(ch)
        })
        .collect()
}

/// Batch-update channel positions. Each pair is (tag, new_position).
///
/// Uses a single transaction for atomicity. Tags that don't exist are skipped.
pub fn update_channel_positions(conn: &Connection, positions: &[(String, u32)]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt =
            tx.prepare("UPDATE channels SET position = ?1 WHERE tag = ?2")?;
        for (tag, pos) in positions {
            stmt.execute(params![*pos as i64, tag])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Remove a channel by tag. Returns true if removed.
pub fn remove_channel(conn: &Connection, tag: &str) -> Result<bool> {
    let count = conn.execute("DELETE FROM channels WHERE tag = ?1", [tag])?;
    Ok(count > 0)
}

// ─── Private helpers ────────────────────────────────────────────────────────

fn row_to_block(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedBlock> {
    Ok(IndexedBlock {
        id: row.get(0)?,
        slug: row.get(1)?,
        block_type: BlockType::from_str(&row.get::<_, String>(2)?).unwrap_or(BlockType::File),
        title: row.get(3)?,
        description: row.get(4)?,
        url: row.get(5)?,
        media_file: row.get(6)?,
        thumbnail: row.get(7)?,
        saved_at: row.get(8)?,
        source: row.get(9)?,
        width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
        height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
        author: row.get(12)?,
        body: row.get(13)?,
        tags: Vec::new(), // filled by caller
    })
}

fn get_tags_for_block(conn: &Connection, block_id: i64) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT tag FROM block_tags WHERE block_id = ?1 ORDER BY tag")?;
    let tags = stmt
        .query_map([block_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(tags)
}

fn collect_blocks(
    conn: &Connection,
    stmt: &mut rusqlite::Statement<'_>,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<IndexedBlock>> {
    let blocks = stmt
        .query_map(params, row_to_block)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = blocks;
    for block in &mut result {
        block.tags = get_tags_for_block(conn, block.id)?;
    }
    Ok(result)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::Frontmatter;
    use crate::storage::db;

    fn test_conn() -> Connection {
        db::open_memory().unwrap()
    }

    fn make_block(slug: &str, tags: &[&str]) -> Block {
        make_block_full(slug, "image", None, "2026-01-15T12:00:00Z", tags, "")
    }

    fn make_block_full(
        slug: &str,
        block_type: &str,
        title: Option<&str>,
        saved_at: &str,
        tags: &[&str],
        body: &str,
    ) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::from_str(block_type).unwrap(),
                title: title.map(|t| t.to_string()),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: tags.iter().map(|t| t.to_string()).collect(),
                saved_at: DateTime::new(saved_at).unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
            },
            body: body.to_string(),
        }
    }

    // ── upsert_block ─────────────────────────────────────────────────────

    #[test]
    fn upsert_insert_new_block() {
        let conn = test_conn();
        let block = make_block("sunset", &["photography"]);
        let id = upsert_block(&conn, &block).unwrap();
        assert!(id > 0);

        let got = get_block(&conn, "sunset").unwrap().unwrap();
        assert_eq!(got.slug, "sunset");
        assert_eq!(got.block_type, BlockType::Image);
        assert_eq!(got.tags, vec!["photography"]);
    }

    #[test]
    fn upsert_update_existing_block() {
        let conn = test_conn();
        let block1 = make_block_full("sunset", "image", Some("Old"), "2026-01-01T00:00:00Z", &["old-tag"], "");
        upsert_block(&conn, &block1).unwrap();

        let block2 = make_block_full("sunset", "link", Some("New"), "2026-02-01T00:00:00Z", &["new-tag"], "body");
        upsert_block(&conn, &block2).unwrap();

        let got = get_block(&conn, "sunset").unwrap().unwrap();
        assert_eq!(got.block_type, BlockType::Link);
        assert_eq!(got.title.as_deref(), Some("New"));
        assert_eq!(got.tags, vec!["new-tag"]);
        assert_eq!(got.body, "body");
    }

    #[test]
    fn upsert_replaces_tags() {
        let conn = test_conn();
        let block = make_block("test", &["a", "b", "c"]);
        upsert_block(&conn, &block).unwrap();

        let block2 = make_block("test", &["x", "y"]);
        upsert_block(&conn, &block2).unwrap();

        let got = get_block(&conn, "test").unwrap().unwrap();
        assert_eq!(got.tags, vec!["x", "y"]);
    }

    #[test]
    fn upsert_replaces_wikilinks() {
        let conn = test_conn();
        let block = make_block_full("src", "article", None, "2026-01-01T00:00:00Z", &[], "See [[target-a]]");
        upsert_block(&conn, &block).unwrap();

        let count1: i64 = conn
            .query_row("SELECT count(*) FROM wikilinks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count1, 1);

        let block2 = make_block_full("src", "article", None, "2026-01-01T00:00:00Z", &[], "See [[target-b]] and [[target-c]]");
        upsert_block(&conn, &block2).unwrap();

        let count2: i64 = conn
            .query_row("SELECT count(*) FROM wikilinks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count2, 2);
    }

    // ── remove_block ─────────────────────────────────────────────────────

    #[test]
    fn remove_existing_block() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("test", &["tag"])).unwrap();
        assert!(remove_block(&conn, "test").unwrap());
        assert!(get_block(&conn, "test").unwrap().is_none());
    }

    #[test]
    fn remove_nonexistent_block() {
        let conn = test_conn();
        assert!(!remove_block(&conn, "nope").unwrap());
    }

    // ── get_block ────────────────────────────────────────────────────────

    #[test]
    fn get_block_not_found() {
        let conn = test_conn();
        assert!(get_block(&conn, "nope").unwrap().is_none());
    }

    #[test]
    fn get_block_with_all_fields() {
        let conn = test_conn();
        let mut block = make_block_full(
            "full",
            "article",
            Some("Title"),
            "2026-03-15T10:00:00Z",
            &["design", "web"],
            "Body text",
        );
        block.frontmatter.description = Some("Desc".to_string());
        block.frontmatter.url = Some("https://example.com".to_string());
        block.frontmatter.file = Some("full.png".to_string());
        block.frontmatter.thumbnail = Some("thumb.jpg".to_string());
        block.frontmatter.source = Some("browser-extension".to_string());
        block.frontmatter.width = Some(1920);
        block.frontmatter.height = Some(1080);
        block.frontmatter.author = Some("Author".to_string());
        upsert_block(&conn, &block).unwrap();

        let got = get_block(&conn, "full").unwrap().unwrap();
        assert_eq!(got.title.as_deref(), Some("Title"));
        assert_eq!(got.description.as_deref(), Some("Desc"));
        assert_eq!(got.url.as_deref(), Some("https://example.com"));
        assert_eq!(got.media_file.as_deref(), Some("full.png"));
        assert_eq!(got.thumbnail.as_deref(), Some("thumb.jpg"));
        assert_eq!(got.source.as_deref(), Some("browser-extension"));
        assert_eq!(got.width, Some(1920));
        assert_eq!(got.height, Some(1080));
        assert_eq!(got.author.as_deref(), Some("Author"));
        assert_eq!(got.body, "Body text");
        assert_eq!(got.tags, vec!["design", "web"]);
    }

    // ── list_blocks ──────────────────────────────────────────────────────

    #[test]
    fn list_blocks_empty() {
        let conn = test_conn();
        let blocks = list_blocks(&conn).unwrap();
        assert!(blocks.is_empty());
    }

    #[test]
    fn list_blocks_ordered_by_saved_at() {
        let conn = test_conn();
        upsert_block(&conn, &make_block_full("old", "image", None, "2026-01-01T00:00:00Z", &[], "")).unwrap();
        upsert_block(&conn, &make_block_full("new", "image", None, "2026-03-01T00:00:00Z", &[], "")).unwrap();
        upsert_block(&conn, &make_block_full("mid", "image", None, "2026-02-01T00:00:00Z", &[], "")).unwrap();

        let blocks = list_blocks(&conn).unwrap();
        let slugs: Vec<&str> = blocks.iter().map(|b| b.slug.as_str()).collect();
        assert_eq!(slugs, vec!["new", "mid", "old"]);
    }

    // ── list_blocks_by_tag ───────────────────────────────────────────────

    #[test]
    fn list_by_tag_filters_correctly() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("a", &["design"])).unwrap();
        upsert_block(&conn, &make_block("b", &["design", "web"])).unwrap();
        upsert_block(&conn, &make_block("c", &["web"])).unwrap();

        let design = list_blocks_by_tag(&conn, "design").unwrap();
        let slugs: Vec<&str> = design.iter().map(|b| b.slug.as_str()).collect();
        assert_eq!(slugs.len(), 2);
        assert!(slugs.contains(&"a"));
        assert!(slugs.contains(&"b"));
    }

    #[test]
    fn list_by_tag_empty_result() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("a", &["design"])).unwrap();
        let result = list_blocks_by_tag(&conn, "nonexistent").unwrap();
        assert!(result.is_empty());
    }

    // ── get_all_tags ─────────────────────────────────────────────────────

    #[test]
    fn get_all_tags_with_counts() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("a", &["design", "web"])).unwrap();
        upsert_block(&conn, &make_block("b", &["design"])).unwrap();
        upsert_block(&conn, &make_block("c", &["photo"])).unwrap();

        let tags = get_all_tags(&conn).unwrap();
        assert_eq!(tags[0], TagCount { tag: "design".to_string(), count: 2 });
        assert_eq!(tags.len(), 3);
    }

    #[test]
    fn get_all_tags_empty() {
        let conn = test_conn();
        let tags = get_all_tags(&conn).unwrap();
        assert!(tags.is_empty());
    }

    // ── search_blocks ────────────────────────────────────────────────────

    #[test]
    fn search_empty_returns_all() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("a", &[])).unwrap();
        upsert_block(&conn, &make_block("b", &[])).unwrap();

        let query = SearchQuery {
            text: String::new(),
            filters: vec![],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn search_by_text() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full("sunset", "image", Some("Sunset in Tokyo"), "2026-01-01T00:00:00Z", &[], ""),
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full("coffee", "image", Some("Morning Coffee"), "2026-01-02T00:00:00Z", &[], ""),
        )
        .unwrap();

        let query = SearchQuery {
            text: "sunset".to_string(),
            filters: vec![],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "sunset");
    }

    #[test]
    fn search_by_type_filter() {
        let conn = test_conn();
        upsert_block(&conn, &make_block_full("img", "image", None, "2026-01-01T00:00:00Z", &[], "")).unwrap();
        upsert_block(&conn, &make_block_full("art", "article", None, "2026-01-01T00:00:00Z", &[], "")).unwrap();

        let query = SearchQuery {
            text: String::new(),
            filters: vec![SearchFilter::Type(BlockType::Image)],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "img");
    }

    #[test]
    fn search_by_tag_filter() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("a", &["design"])).unwrap();
        upsert_block(&conn, &make_block("b", &["web"])).unwrap();

        let query = SearchQuery {
            text: String::new(),
            filters: vec![SearchFilter::Tag("design".to_string())],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "a");
    }

    #[test]
    fn search_combined_text_and_filters() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full("match", "image", Some("Beautiful sunset"), "2026-01-01T00:00:00Z", &["photo"], ""),
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full("no-tag", "image", Some("Another sunset"), "2026-01-01T00:00:00Z", &[], ""),
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full("no-text", "image", Some("Morning coffee"), "2026-01-01T00:00:00Z", &["photo"], ""),
        )
        .unwrap();

        let query = SearchQuery {
            text: "sunset".to_string(),
            filters: vec![SearchFilter::Tag("photo".to_string())],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "match");
    }

    #[test]
    fn search_multiple_tag_filters_is_and() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("both", &["design", "web"])).unwrap();
        upsert_block(&conn, &make_block("one", &["design"])).unwrap();

        let query = SearchQuery {
            text: String::new(),
            filters: vec![
                SearchFilter::Tag("design".to_string()),
                SearchFilter::Tag("web".to_string()),
            ],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "both");
    }

    // ── channels ─────────────────────────────────────────────────────────

    #[test]
    fn upsert_and_list_channels() {
        let conn = test_conn();
        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let ch = Channel::new("design", Some("Design Inspiration"), dt).unwrap();
        let id = upsert_channel(&conn, &ch).unwrap();
        assert!(id > 0);

        let channels = list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].tag, "design");
        assert_eq!(channels[0].title, "Design Inspiration");
    }

    #[test]
    fn upsert_channel_updates_existing() {
        let conn = test_conn();
        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let ch1 = Channel::new("design", Some("Old Title"), dt.clone()).unwrap();
        upsert_channel(&conn, &ch1).unwrap();

        let mut ch2 = Channel::new("design", Some("New Title"), dt).unwrap();
        ch2.position = 5;
        upsert_channel(&conn, &ch2).unwrap();

        let channels = list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].title, "New Title");
        assert_eq!(channels[0].position, 5);
    }

    #[test]
    fn remove_channel_existing() {
        let conn = test_conn();
        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let ch = Channel::new("design", None, dt).unwrap();
        upsert_channel(&conn, &ch).unwrap();
        assert!(remove_channel(&conn, "design").unwrap());
        assert!(list_channels(&conn).unwrap().is_empty());
    }

    #[test]
    fn remove_channel_nonexistent() {
        let conn = test_conn();
        assert!(!remove_channel(&conn, "nope").unwrap());
    }

    #[test]
    fn channels_ordered_by_position() {
        let conn = test_conn();
        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();

        let mut ch_b = Channel::new("beta", None, dt.clone()).unwrap();
        ch_b.position = 2;
        upsert_channel(&conn, &ch_b).unwrap();

        let mut ch_a = Channel::new("alpha", None, dt.clone()).unwrap();
        ch_a.position = 1;
        upsert_channel(&conn, &ch_a).unwrap();

        let mut ch_c = Channel::new("gamma", None, dt).unwrap();
        ch_c.position = 0;
        upsert_channel(&conn, &ch_c).unwrap();

        let channels = list_channels(&conn).unwrap();
        let tags: Vec<&str> = channels.iter().map(|c| c.tag.as_str()).collect();
        assert_eq!(tags, vec!["gamma", "alpha", "beta"]);
    }
}
