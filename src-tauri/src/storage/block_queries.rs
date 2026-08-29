//! Route-facing and utility queries over the block index.
//!
//! Write/backfill ownership stays in storage::index; this module owns SQL read
//! models, row hydration and legacy structured search.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::search::{SearchFilter, SearchQuery};
use crate::storage::index::{
    parse_block_type_row, parse_card_kind_row, parse_related_notes_json, row_to_preview_block,
    IndexedBlock, LightBlock, PendingThumbUpgradeBlock, PreviewBlock, TagCount, ThumbFormat,
    LIGHT_BLOCK_BODY_PREVIEW_CHARS,
};
#[cfg(test)]
use crate::storage::search_engine;

/// List all blocks without description/source (lightweight for grid views).
/// Body is truncated to a short preview to reduce IPC payload for large vaults.
pub fn list_blocks_light(conn: &Connection) -> Result<Vec<LightBlock>> {
    let mut stmt = conn.prepare(
        "SELECT id, slug, block_type, card_kind, title, content_heading, display_title, COALESCE(fallback_label, slug), url, media_file,
                thumbnail, saved_at, width, height, author,
                SUBSTR(body, 1, ?1), preview_text, first_image, media_urls, media_dimensions, preview_manifest, feed_playback,
                CASE WHEN preview_state != 'ready' THEN preview_error_kind END
         FROM blocks
         ORDER BY saved_at DESC, slug COLLATE NOCASE ASC, slug ASC",
    )?;

    let blocks: Vec<LightBlock> = stmt
        .query_map([LIGHT_BLOCK_BODY_PREVIEW_CHARS], light_block_from_row)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(blocks)
}

/// List only the blocks needed by the visible grid, optionally filtered by tag.
/// Excludes channel documents and omits per-block tag arrays to keep the
/// startup/switch payload small; tag membership is fetched lazily for menus/detail.
///
/// A `stale` preview is still served. `stale` means "worth recomputing", not
/// "wrong": every write to a block marks it, including one that only edited
/// frontmatter tags, and the source stamp covers the whole `.md` — so
/// connecting a card to a collection invalidated a poster that no medium had
/// touched. Withholding the manifest turned such a card into a text-only one
/// until the preview queue reached it, which on a large vault is minutes of a
/// video simply gone from the feed.
///
/// The worst case of serving it is a poster one generation behind, visible
/// until reconciliation replaces it. `missing` and `failed` are still withheld:
/// there the artifact genuinely is not on disk.
pub fn list_grid_blocks(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<(Vec<LightBlock>, bool)> {
    let fetch_limit = limit.saturating_add(1);
    let sql = match tag {
        Some(_) => {
            "SELECT b.id, b.slug, b.block_type, b.card_kind, b.title, b.content_heading, b.display_title, COALESCE(b.fallback_label, b.slug), b.url, b.media_file,
                    b.thumbnail, b.saved_at, b.width, b.height, b.author,
                    CASE WHEN b.card_kind = 'article' THEN SUBSTR(b.body, 1, ?1) ELSE '' END,
                    b.preview_text, b.first_image, b.media_urls, b.media_dimensions,
                    CASE WHEN b.preview_state = 'ready'
                              OR (b.preview_state = 'stale' AND b.preview_source_stamp IS NOT NULL)
                         THEN b.preview_manifest END,
                    CASE WHEN b.preview_state = 'ready'
                              OR (b.preview_state = 'stale' AND b.preview_source_stamp IS NOT NULL)
                         THEN b.feed_playback END,
                    CASE WHEN b.preview_state != 'ready' THEN b.preview_error_kind END
             FROM blocks b
             INNER JOIN block_tags bt ON bt.block_id = b.id
             WHERE b.card_kind != 'channel' AND bt.tag = ?2
             ORDER BY b.saved_at DESC, b.slug COLLATE NOCASE ASC, b.slug ASC
             LIMIT ?3 OFFSET ?4"
        }
        None => {
            "SELECT id, slug, block_type, card_kind, title, content_heading, display_title, COALESCE(fallback_label, slug), url, media_file,
                    thumbnail, saved_at, width, height, author,
                    CASE WHEN card_kind = 'article' THEN SUBSTR(body, 1, ?1) ELSE '' END,
                    preview_text, first_image, media_urls, media_dimensions,
                    CASE WHEN preview_state = 'ready'
                              OR (preview_state = 'stale' AND preview_source_stamp IS NOT NULL)
                         THEN preview_manifest END,
                    CASE WHEN preview_state = 'ready'
                              OR (preview_state = 'stale' AND preview_source_stamp IS NOT NULL)
                         THEN feed_playback END,
                    CASE WHEN preview_state != 'ready' THEN preview_error_kind END
             FROM blocks
             WHERE card_kind != 'channel'
             ORDER BY saved_at DESC, slug COLLATE NOCASE ASC, slug ASC
             LIMIT ?2 OFFSET ?3"
        }
    };

    let mut stmt = conn.prepare(sql)?;

    let mut blocks = match tag {
        Some(tag) => stmt
            .query_map(
                params![LIGHT_BLOCK_BODY_PREVIEW_CHARS, tag, fetch_limit, offset],
                light_block_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?,
        None => stmt
            .query_map(
                params![LIGHT_BLOCK_BODY_PREVIEW_CHARS, fetch_limit, offset],
                light_block_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?,
    };

    let has_more = blocks.len() > limit;
    if has_more {
        blocks.truncate(limit);
    }

    Ok((blocks, has_more))
}

#[cfg(test)]
pub(crate) fn list_grid_blocks_with_query(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
    query: Option<&str>,
) -> Result<(Vec<LightBlock>, bool)> {
    let normalized_query = normalize_search_query(query.unwrap_or(""));
    if normalized_query.is_empty() {
        return list_grid_blocks(conn, tag, offset, limit);
    }
    search_engine::search_grid_blocks(conn, tag, offset, limit, &normalized_query)
}

/// Count non-channel blocks for the "Everything" sidebar row.
pub fn count_grid_blocks(conn: &Connection) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM blocks WHERE card_kind != 'channel'",
        [],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

/// Return `slug -> indexed_at` (unix seconds) for non-channel blocks.
pub fn get_block_indexed_at_map(
    conn: &Connection,
) -> Result<std::collections::HashMap<String, u64>> {
    let mut stmt = conn.prepare(
        "SELECT slug, COALESCE(CAST(strftime('%s', indexed_at) AS INTEGER), 0)
         FROM blocks
         WHERE slug != '' AND card_kind != 'channel'",
    )?;
    let rows = stmt.query_map([], |row| {
        let slug: String = row.get(0)?;
        let indexed_at: i64 = row.get(1)?;
        Ok((slug, indexed_at.max(0) as u64))
    })?;
    let entries = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(entries.into_iter().collect())
}

/// Return the newest previewable blocks across the whole vault.
pub fn list_preview_blocks(conn: &Connection, limit: usize) -> Result<Vec<PreviewBlock>> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let limit = i64::try_from(limit).context("preview limit does not fit i64")?;
    let mut stmt = conn.prepare(
        "SELECT slug, thumb_format, thumb_mtime, preview_manifest
         FROM blocks
         WHERE slug != '' AND card_kind != 'channel' AND thumb_format IS NOT NULL
         ORDER BY saved_at DESC
         LIMIT ?1",
    )?;

    let rows = stmt.query_map([limit], |row| row_to_preview_block(row, 0))?;
    let previews = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(previews)
}

/// Slugs of the blocks whose primary media is this file name.
///
/// The watcher sees a media file land and has to reach the card that shows
/// it. In a flat vault the two share a slug, so the path alone was enough;
/// once a vault is laid out in folders they do not (`Media/x` against
/// `Cards/x`), and the owner has to be looked up by the indexed file name
/// instead of guessed from the path.
pub fn list_slugs_by_media_file(conn: &Connection, media_file: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT slug FROM blocks WHERE media_file = ?1 AND slug != '' ORDER BY slug",
    )?;
    let rows = stmt.query_map([media_file], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Return the newest previewable blocks per tag.
pub fn list_preview_blocks_by_tag(
    conn: &Connection,
    limit: usize,
) -> Result<std::collections::HashMap<String, Vec<PreviewBlock>>> {
    if limit == 0 {
        return Ok(std::collections::HashMap::new());
    }

    let limit = i64::try_from(limit).context("preview limit does not fit i64")?;
    let mut stmt = conn.prepare(
        "SELECT tag, slug, thumb_format, thumb_mtime, preview_manifest
         FROM (
             SELECT bt.tag AS tag,
                    b.slug AS slug,
                    b.thumb_format AS thumb_format,
                    b.thumb_mtime AS thumb_mtime,
                    b.preview_manifest AS preview_manifest,
                    ROW_NUMBER() OVER (
                        PARTITION BY bt.tag
                        ORDER BY b.saved_at DESC
                    ) AS row_num
             FROM block_tags bt
             JOIN blocks b ON b.id = bt.block_id
             WHERE b.slug != '' AND b.card_kind != 'channel' AND b.thumb_format IS NOT NULL
         )
         WHERE row_num <= ?1
         ORDER BY tag, row_num",
    )?;

    let rows = stmt.query_map([limit], |row| {
        Ok((row.get::<_, String>(0)?, row_to_preview_block(row, 1)?))
    })?;

    let mut grouped = std::collections::HashMap::<String, Vec<PreviewBlock>>::new();
    for row in rows {
        let (tag, preview) = row?;
        grouped.entry(tag).or_default().push(preview);
    }

    Ok(grouped)
}

/// List blocks that may need a Phase 2 browser-decoded upgrade. The command
/// layer verifies the on-disk thumb state, so this intentionally includes
/// missing/NULL thumb metadata rows as well as PNG placeholder rows.
pub fn list_pending_thumb_upgrade_blocks(
    conn: &Connection,
) -> Result<Vec<PendingThumbUpgradeBlock>> {
    let mut stmt = conn.prepare(
        "SELECT slug, media_file, thumbnail, first_image, media_urls, preview_manifest
         FROM blocks
         WHERE slug != ''
           AND card_kind != 'channel'
         ORDER BY saved_at DESC",
    )?;

    let blocks = stmt
        .query_map([], |row| {
            Ok(PendingThumbUpgradeBlock {
                slug: row.get(0)?,
                media_file: row.get(1)?,
                thumbnail: row.get(2)?,
                first_image: row.get(3)?,
                media_urls: row.get(4)?,
                preview_manifest: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(blocks)
}

pub fn get_pending_thumb_upgrade_block(
    conn: &Connection,
    slug: &str,
) -> Result<Option<PendingThumbUpgradeBlock>> {
    conn.query_row(
        "SELECT slug, media_file, thumbnail, first_image, media_urls, preview_manifest
         FROM blocks
         WHERE slug = ?1 AND card_kind != 'channel'",
        [slug],
        |row| {
            Ok(PendingThumbUpgradeBlock {
                slug: row.get(0)?,
                media_file: row.get(1)?,
                thumbnail: row.get(2)?,
                first_image: row.get(3)?,
                media_urls: row.get(4)?,
                preview_manifest: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// Get a single block by slug. Returns None if not found.
pub fn get_block(conn: &Connection, slug: &str) -> Result<Option<IndexedBlock>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, slug, block_type, card_kind, title, content_heading, display_title, COALESCE(fallback_label, slug), description, url, media_file,
                    thumbnail, saved_at, source, width, height, author, body, preview_text, first_image, media_urls,
                    media_dimensions, preview_manifest, feed_playback, related_notes, body_hash, origin, index_warning,
                    thumb_format, thumb_mtime
             FROM blocks WHERE slug = ?1",
        )
        .context("failed to prepare get_block")?;

    match stmt.query_row([slug], row_to_block) {
        Ok(mut block) => {
            block.tags = get_tags_for_block(conn, block.id)?;
            block.related_notes = load_bidirectional_related_notes(conn, block.id, &block.slug)?;
            Ok(Some(block))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// List all blocks, ordered by saved_at descending (newest first).
pub fn list_blocks(conn: &Connection) -> Result<Vec<IndexedBlock>> {
    let mut stmt = conn.prepare(
        "SELECT id, slug, block_type, card_kind, title, content_heading, display_title, COALESCE(fallback_label, slug), description, url, media_file,
                thumbnail, saved_at, source, width, height, author, body, preview_text, first_image, media_urls,
                media_dimensions, preview_manifest, feed_playback, related_notes, body_hash, origin, index_warning,
                thumb_format, thumb_mtime
         FROM blocks ORDER BY saved_at DESC",
    )?;
    collect_blocks(conn, &mut stmt, &[] as &[&dyn rusqlite::types::ToSql])
}

/// List blocks with a specific tag, ordered by saved_at descending.
pub fn list_blocks_by_tag(conn: &Connection, tag: &str) -> Result<Vec<IndexedBlock>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.slug, b.block_type, b.card_kind, b.title, b.content_heading, b.display_title, COALESCE(b.fallback_label, b.slug), b.description, b.url,
                b.media_file, b.thumbnail, b.saved_at, b.source, b.width,
                b.height, b.author, b.body, b.preview_text, b.first_image, b.media_urls, b.media_dimensions, b.preview_manifest,
                b.feed_playback, b.related_notes, b.body_hash, b.origin, b.index_warning,
                b.thumb_format, b.thumb_mtime
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
/// - Type filter: WHERE card_kind = ?
/// - Tag filter: JOIN block_tags WHERE tag = ?
/// - Multiple filters: AND between all conditions
pub fn search_blocks(conn: &Connection, query: &SearchQuery) -> Result<Vec<IndexedBlock>> {
    if query.is_empty() {
        return list_blocks(conn);
    }

    let mut joins = Vec::new();
    let mut conditions = Vec::new();
    let mut param_values: Vec<String> = Vec::new();

    // FTS5 free-text search (escape special characters)
    if !query.text.is_empty() {
        joins.push("JOIN blocks_fts ON blocks_fts.rowid = b.id".to_string());
        conditions.push(format!("blocks_fts MATCH ?{}", param_values.len() + 1));
        param_values.push(escape_fts5(&query.text));
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
            SearchFilter::Type(card_kind) => {
                conditions.push(format!("b.card_kind = ?{}", param_values.len() + 1));
                param_values.push(card_kind.as_str().to_string());
            }
        }
    }

    let mut sql = String::from(
        "SELECT DISTINCT b.id, b.slug, b.block_type, b.card_kind, b.title, b.content_heading, b.display_title, COALESCE(b.fallback_label, b.slug), b.description, b.url,
                b.media_file, b.thumbnail, b.saved_at, b.source, b.width,
                b.height, b.author, b.body, b.preview_text, b.first_image, b.media_urls, b.media_dimensions, b.preview_manifest,
                b.feed_playback, b.related_notes, b.body_hash, b.origin, b.index_warning,
                b.thumb_format, b.thumb_mtime
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
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = param_values
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();
    collect_blocks(conn, &mut stmt, &param_refs)
}

// ─── Private helpers ────────────────────────────────────────────────────────

pub(crate) fn light_block_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LightBlock> {
    Ok(LightBlock {
        id: row.get(0)?,
        slug: row.get(1)?,
        block_type: parse_block_type_row(row, 2)?,
        card_kind: parse_card_kind_row(row, 3)?,
        title: row.get(4)?,
        content_heading: row.get(5)?,
        display_title: row.get(6)?,
        fallback_label: row.get(7)?,
        url: row.get(8)?,
        media_file: row.get(9)?,
        thumbnail: row.get(10)?,
        saved_at: row.get(11)?,
        width: row.get::<_, Option<i64>>(12)?.map(|v| v as u32),
        height: row.get::<_, Option<i64>>(13)?.map(|v| v as u32),
        author: row.get(14)?,
        body: row.get(15)?,
        preview_text: row.get(16)?,
        first_image: row.get(17)?,
        media_urls: row.get(18)?,
        media_dimensions: row.get(19)?,
        preview_manifest: row.get(20)?,
        feed_playback: row.get(21)?,
        content_in_cloud: row
            .get::<_, Option<String>>(22)
            .unwrap_or(None)
            .as_deref()
            == Some("content_in_cloud"),
        preview_unreadable: row
            .get::<_, Option<String>>(22)
            .unwrap_or(None)
            .as_deref()
            == Some("unreadable_artifact"),
        search_match: None,
    })
}

#[cfg(test)]
fn normalize_search_query(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Escape FTS5 special characters in user input.
/// Wraps each word in double quotes to treat them as literal tokens.
fn escape_fts5(input: &str) -> String {
    input
        .split_whitespace()
        .map(|word| {
            // Escape internal double quotes by doubling them
            let escaped = word.replace('"', "\"\"");
            format!("\"{}\"", escaped)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalized_wikilink_target_sql(column: &str) -> String {
    format!(
        "TRIM(
            CASE
                WHEN instr({column}, '#') > 0 AND instr({column}, '|') > 0
                    THEN substr({column}, 1, MIN(instr({column}, '#'), instr({column}, '|')) - 1)
                WHEN instr({column}, '#') > 0
                    THEN substr({column}, 1, instr({column}, '#') - 1)
                WHEN instr({column}, '|') > 0
                    THEN substr({column}, 1, instr({column}, '|') - 1)
                ELSE {column}
            END
        )",
    )
}

fn load_bidirectional_related_notes(
    conn: &Connection,
    block_id: i64,
    slug: &str,
) -> Result<Vec<String>> {
    let normalized_target = normalized_wikilink_target_sql("w.target_slug");
    let sql = format!(
        "WITH all_links AS (
             SELECT source_id, target_slug FROM wikilinks
             UNION ALL
             SELECT source_id, target_slug FROM related_note_links
         )
         SELECT slug
         FROM (
             SELECT tb.slug AS slug, tb.saved_at AS saved_at
             FROM all_links w
             JOIN blocks tb
               ON tb.slug = {normalized_target}
             WHERE w.source_id = ?1
               AND tb.card_kind != 'channel'
               AND tb.slug != ?2

             UNION

             SELECT sb.slug AS slug, sb.saved_at AS saved_at
             FROM all_links w
             JOIN blocks sb
               ON sb.id = w.source_id
             WHERE {normalized_target} = ?2
               AND sb.card_kind != 'channel'
               AND sb.slug != ?2
         )
         ORDER BY saved_at DESC, slug ASC",
    );

    let mut stmt = conn
        .prepare(&sql)
        .context("failed to prepare bidirectional related notes query")?;
    let rows = stmt
        .query_map(params![block_id, slug], |row| row.get::<_, String>(0))
        .context("failed to query bidirectional related notes")?;

    let mut related_notes = Vec::new();
    for row in rows {
        related_notes.push(row?);
    }
    Ok(related_notes)
}

fn row_to_block(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedBlock> {
    let raw_thumb_format = row.get::<_, Option<String>>(28)?;
    let thumb_mtime = row.get::<_, Option<i64>>(29)?.unwrap_or(0).max(0) as u64;
    Ok(IndexedBlock {
        id: row.get(0)?,
        slug: row.get(1)?,
        block_type: parse_block_type_row(row, 2)?,
        card_kind: parse_card_kind_row(row, 3)?,
        title: row.get(4)?,
        content_heading: row.get(5)?,
        display_title: row.get(6)?,
        fallback_label: row.get(7)?,
        description: row.get(8)?,
        url: row.get(9)?,
        media_file: row.get(10)?,
        thumbnail: row.get(11)?,
        saved_at: row.get(12)?,
        source: row.get(13)?,
        width: row.get::<_, Option<i64>>(14)?.map(|v| v as u32),
        height: row.get::<_, Option<i64>>(15)?.map(|v| v as u32),
        author: row.get(16)?,
        body: row.get(17)?,
        preview_text: row.get(18)?,
        first_image: row.get(19)?,
        media_urls: row.get(20)?,
        media_dimensions: row.get(21)?,
        preview_manifest: row.get(22)?,
        feed_playback: row.get(23)?,
        thumb_format: raw_thumb_format.as_deref().and_then(ThumbFormat::from_db),
        thumb_mtime,
        related_notes: parse_related_notes_json(row.get(24)?),
        body_hash: row.get(25)?,
        origin: row.get(26)?,
        index_warning: row.get(27)?,
        tags: Vec::new(), // filled by caller
    })
}

pub(crate) fn get_tags_for_block(conn: &Connection, block_id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM block_tags WHERE block_id = ?1 ORDER BY tag")?;
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
    let mut blocks: Vec<IndexedBlock> = stmt
        .query_map(params, row_to_block)?
        .collect::<Result<Vec<_>, _>>()?;

    if blocks.is_empty() {
        return Ok(blocks);
    }

    // Batch: fetch all tags in one query instead of N+1
    let ids: Vec<i64> = blocks.iter().map(|b| b.id).collect();
    let placeholders: String = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT block_id, tag FROM block_tags WHERE block_id IN ({}) ORDER BY tag",
        placeholders
    );
    let mut tag_stmt = conn.prepare(&sql)?;
    let id_params: Vec<&dyn rusqlite::types::ToSql> = ids
        .iter()
        .map(|id| id as &dyn rusqlite::types::ToSql)
        .collect();
    let rows = tag_stmt.query_map(&*id_params, |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut tag_map: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
    for row in rows {
        let (block_id, tag) = row?;
        tag_map.entry(block_id).or_default().push(tag);
    }

    for block in &mut blocks {
        block.tags = tag_map.remove(&block.id).unwrap_or_default();
    }

    Ok(blocks)
}
