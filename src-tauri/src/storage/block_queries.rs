//! Route-facing and utility queries over the block index.
//!
//! Write/backfill ownership stays in storage::index; this module owns SQL read
//! models, row hydration and legacy structured search.

use anyhow::{Context, Result};
use mine_core::links::{LinkIndex, LinkResolution, LinkSyntax};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, BTreeSet};

use crate::domain::card_association::author_key;
use crate::domain::search::{SearchFilter, SearchQuery};
use crate::domain::windows::TabLocation;
use crate::storage::index::{
    parse_block_type_row, parse_card_kind_row, parse_related_notes_json, row_to_preview_block,
    IndexedBlock, LightBlock, PendingThumbUpgradeBlock, PreviewBlock, TagCount, ThumbFormat,
    LIGHT_BLOCK_BODY_PREVIEW_CHARS,
};
#[cfg(test)]
use crate::storage::search_engine;

/// Order of the feed (SPEC_FEED_DISPLAY.md, Д6): by save date, newest or
/// oldest first; equal dates by card name the same way in both directions, so
/// pages never overlap or skip.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum FeedOrder {
    #[default]
    Newest,
    Oldest,
}

impl FeedOrder {
    pub(crate) fn order_by(self, column_prefix: &str) -> String {
        let direction = match self {
            FeedOrder::Newest => "DESC",
            FeedOrder::Oldest => "ASC",
        };
        format!(
            "{column_prefix}saved_at {direction}, {column_prefix}slug COLLATE NOCASE ASC, {column_prefix}slug ASC"
        )
    }
}

/// Name of the column every `LightBlock` query selects its collections into.
/// [`light_block_from_row`] reads it by name, so it does not depend on where a
/// query puts it among its positional columns.
const COLLECTIONS_COLUMN: &str = "collections";

/// The one condition that makes a `block_tags` row a collection membership
/// (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К9): a collection page with the same
/// ref is in `channels`. `block_tags` mirrors every `Mine Collections` link of
/// a file; a link whose name has no page stays there and is never shown or
/// counted, and a page that appears (created, restored from the Trash, synced)
/// makes its cards members again without touching or reindexing them (К3).
///
/// A link names its page by the page's ref (`[[Collection]]`) or by the
/// page's path (`[[Collections/Collection]]`, К4), as Obsidian opens both;
/// the collection is the page's, so reads take its name from `{page}.tag`,
/// never from the link. A card that names one page both ways joins it once:
/// the path form counts only while the card has no row with the ref.
///
/// Every read that shows or counts collections joins through this fragment
/// and has no filter of its own. `block_tags` is the alias of the
/// `block_tags` row, `page` the alias the join gives the collection page.
pub(crate) fn collection_membership_join_sql(block_tags: &str, page: &str) -> String {
    format!(
        "JOIN channels {page} ON ({page}.tag = {block_tags}.tag
             OR ({page}.source_slug = {block_tags}.tag
                 AND NOT EXISTS (SELECT 1 FROM block_tags {page}_by_ref
                                 WHERE {page}_by_ref.block_id = {block_tags}.block_id
                                   AND {page}_by_ref.tag = {page}.tag)))"
    )
}

/// The `collections` column of a `LightBlock` query: the card's collections
/// (memberships, [`collection_membership_join_sql`]) as a JSON array in
/// sidebar order, by the collection's `position` and then by name. Name order
/// is SQLite's binary order, the same byte order the sidebar list
/// (`list_channels`) breaks position ties with. A link whose name has no page
/// is not in the list.
///
/// One correlated aggregate per row over `block_tags`' `(block_id, tag)` key
/// and the unique `channels.tag`, so a page of cards stays one statement and
/// never one more query per card.
///
/// `block_id` is the outer query's qualified block id (`blocks.id`, `b.id`):
/// unqualified, `id` would bind to `channels.id` inside the subquery.
pub(crate) fn collections_column_sql(block_id: &str) -> String {
    let membership = collection_membership_join_sql("membership", "collection");
    format!(
        "(SELECT json_group_array(collection.tag
                    ORDER BY collection.position, collection.tag)
          FROM block_tags membership
          {membership}
          WHERE membership.block_id = {block_id}) AS {COLLECTIONS_COLUMN}"
    )
}

/// List all blocks without description/source (lightweight for grid views).
/// Body is truncated to a short preview to reduce IPC payload for large vaults.
pub fn list_blocks_light(conn: &Connection) -> Result<Vec<LightBlock>> {
    let collections = collections_column_sql("blocks.id");
    let mut stmt = conn.prepare(&format!(
        "SELECT id, slug, block_type, card_kind, title, content_heading, display_title, COALESCE(fallback_label, slug), url, media_file,
                thumbnail, saved_at, width, height, author,
                SUBSTR(body, 1, ?1), preview_text, first_image, media_urls, media_dimensions, preview_manifest, feed_playback,
                CASE WHEN preview_state != 'ready' THEN preview_error_kind END,
                {collections}
         FROM blocks
         ORDER BY saved_at DESC, slug COLLATE NOCASE ASC, slug ASC"
    ))?;

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
    let filter = tag.map_or(GridFilter::All, GridFilter::Collection);
    list_grid_blocks_filtered(conn, filter, offset, limit, FeedOrder::Newest)
}

/// The feed of a place in the person's chosen order: Everything, a
/// collection, or one author's cards (SPEC_CARD_ASSOCIATIONS.md, «Лента по
/// месту»). An author that normalizes to nothing has no cards.
pub fn list_grid_blocks_in_order(
    conn: &Connection,
    location: &TabLocation,
    offset: usize,
    limit: usize,
    order: FeedOrder,
) -> Result<(Vec<LightBlock>, bool)> {
    match location {
        TabLocation::Everything => {
            list_grid_blocks_filtered(conn, GridFilter::All, offset, limit, order)
        }
        TabLocation::Collection { tag } => {
            list_grid_blocks_filtered(conn, GridFilter::Collection(tag), offset, limit, order)
        }
        TabLocation::Author { author } => match author_key(author) {
            Some(key) => {
                list_grid_blocks_filtered(conn, GridFilter::AuthorKey(&key), offset, limit, order)
            }
            None => Ok((Vec::new(), false)),
        },
    }
}

/// Fetch only requested rows using exactly the feed's preview visibility rules.
pub fn grid_rows_by_slug(conn: &Connection, slugs: &[String]) -> Result<Vec<LightBlock>> {
    if slugs.is_empty() {
        return Ok(Vec::new());
    }
    Ok(list_grid_blocks_filtered(
        conn,
        GridFilter::Slugs(slugs),
        0,
        slugs.len(),
        FeedOrder::Newest,
    )?
    .0)
}

/// Which cards a feed query reads.
enum GridFilter<'a> {
    All,
    Collection(&'a str),
    /// Cards whose association author key is this one.
    AuthorKey(&'a str),
    Slugs(&'a [String]),
}

/// The columns of a `LightBlock` row of the blocks table aliased `alias`,
/// under the feed's preview visibility rules. `?1` is the body preview
/// length, so a query binds `LIGHT_BLOCK_BODY_PREVIEW_CHARS` first. The feed,
/// the open card's associations and every other `LightBlock` list read one
/// row model.
pub(crate) fn grid_row_columns_sql(alias: &str) -> String {
    let b = alias;
    let collections = collections_column_sql(&format!("{b}.id"));
    format!(
        "{b}.id, {b}.slug, {b}.block_type, {b}.card_kind, {b}.title, {b}.content_heading, {b}.display_title, COALESCE({b}.fallback_label, {b}.slug), {b}.url, {b}.media_file,
         {b}.thumbnail, {b}.saved_at, {b}.width, {b}.height, {b}.author,
         CASE WHEN {b}.card_kind = 'article' THEN SUBSTR({b}.body, 1, ?1) ELSE '' END,
         {b}.preview_text, {b}.first_image, {b}.media_urls, {b}.media_dimensions,
         CASE WHEN {b}.preview_state = 'ready'
                   OR ({b}.preview_state = 'stale' AND {b}.preview_source_stamp IS NOT NULL)
              THEN {b}.preview_manifest END,
         CASE WHEN {b}.preview_state = 'ready'
                   OR ({b}.preview_state = 'stale' AND {b}.preview_source_stamp IS NOT NULL)
              THEN {b}.feed_playback END,
         CASE WHEN {b}.preview_state != 'ready' THEN {b}.preview_error_kind END,
         {collections}"
    )
}

/// The page query of one author's feed, for query plan tests.
#[cfg(test)]
pub(crate) fn author_feed_sql(order: FeedOrder) -> String {
    grid_filter_sql(&GridFilter::AuthorKey(""), order)
}

/// A feed page query: `?1` body preview length, `?2` row limit, `?3` offset,
/// `?4` the filter's value.
fn grid_filter_sql(filter: &GridFilter<'_>, order: FeedOrder) -> String {
    let columns = grid_row_columns_sql("b");
    let order_by = order.order_by("b.");
    let (join, condition) = match filter {
        GridFilter::All => (String::new(), ""),
        GridFilter::Collection(_) => (
            format!(
                "INNER JOIN block_tags bt ON bt.block_id = b.id {}",
                collection_membership_join_sql("bt", "page")
            ),
            "AND page.tag = ?4",
        ),
        GridFilter::AuthorKey(_) => (String::new(), "AND b.association_author_key = ?4"),
        GridFilter::Slugs(_) => (
            String::new(),
            "AND b.slug IN (SELECT value FROM json_each(?4))",
        ),
    };
    format!(
        "SELECT {columns}
         FROM blocks b
         {join}
         WHERE b.card_kind != 'channel' {condition}
         ORDER BY {order_by}
         LIMIT ?2 OFFSET ?3"
    )
}

fn list_grid_blocks_filtered(
    conn: &Connection,
    filter: GridFilter<'_>,
    offset: usize,
    limit: usize,
    order: FeedOrder,
) -> Result<(Vec<LightBlock>, bool)> {
    let fetch_limit = limit.saturating_add(1);
    let sql = grid_filter_sql(&filter, order);

    let mut stmt = conn.prepare(&sql)?;
    let value = match filter {
        GridFilter::All => None,
        GridFilter::Collection(tag) => Some(tag.to_string()),
        GridFilter::AuthorKey(key) => Some(key.to_string()),
        GridFilter::Slugs(slugs) => Some(serde_json::to_string(slugs)?),
    };
    let mut blocks = match value {
        Some(value) => stmt
            .query_map(
                params![LIGHT_BLOCK_BODY_PREVIEW_CHARS, fetch_limit, offset, value],
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

/// Return every previewable block of the vault, newest first: the sidebar's
/// `Everything` strip takes as many as its width shows (SPEC_SIDEBAR_STRIP.md,
/// ЛМ1).
pub fn list_preview_blocks(conn: &Connection) -> Result<Vec<PreviewBlock>> {
    let mut stmt = conn.prepare(
        "SELECT slug, thumb_format, thumb_mtime, preview_manifest
         FROM blocks
         WHERE slug != '' AND card_kind != 'channel' AND thumb_format IS NOT NULL
         ORDER BY saved_at DESC",
    )?;

    let rows = stmt.query_map([], |row| row_to_preview_block(row, 0))?;
    let previews = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(previews)
}

/// What one indexed note says about files: its frontmatter file and
/// thumbnail as the index holds them, and the body the references are read
/// from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteFileMentions {
    pub slug: String,
    pub media_file: Option<String>,
    pub thumbnail: Option<String>,
    pub body: String,
}

/// Every indexed note but those in `except`, with what it says about files.
///
/// The delete window asks the index which notes use the media of a card, or
/// of a whole selection (decision of 11.10.2026): the four columns are all it
/// reads, so the answer needs neither the notes on disk nor the rest of each
/// row. `except` is the card or the selection going away.
pub fn list_note_file_mentions(
    conn: &Connection,
    except: &BTreeSet<String>,
) -> Result<Vec<NoteFileMentions>> {
    let mut stmt = conn.prepare(
        "SELECT slug, media_file, thumbnail, COALESCE(body, '') FROM blocks
         WHERE slug != '' ORDER BY slug",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(NoteFileMentions {
            slug: row.get(0)?,
            media_file: row.get(1)?,
            thumbnail: row.get(2)?,
            body: row.get(3)?,
        })
    })?;
    let mut notes = Vec::new();
    for note in rows {
        let note = note?;
        if !except.contains(&note.slug) {
            notes.push(note);
        }
    }
    Ok(notes)
}

/// What one indexed note says that may link to another note: its body, its
/// `Mine Related Notes`, its collections and its file and thumbnail, as the
/// index holds them, joined in one text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteLinkText {
    pub slug: String,
    pub text: String,
}

/// Every indexed note with the text its links can stand in
/// ([`NoteLinkText`]). A rename or a merge takes from it the notes that may
/// link to the notes it moves, and reads only those (SPEC_DEEP_AUDIT.md, Н5).
pub fn list_note_link_texts(conn: &Connection) -> Result<Vec<NoteLinkText>> {
    let mut stmt = conn.prepare(
        "SELECT b.slug,
                COALESCE(b.body, '') || char(10) || COALESCE(b.related_notes, '') || char(10)
                || COALESCE(b.media_file, '') || char(10) || COALESCE(b.thumbnail, '') || char(10)
                || COALESCE((SELECT group_concat(t.tag, char(10)) FROM block_tags t WHERE t.block_id = b.id), '')
         FROM blocks b
         WHERE b.slug != '' ORDER BY b.slug",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(NoteLinkText {
            slug: row.get(0)?,
            text: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The slugs of the collection pages the last reconciliation saw. The index
/// does not hold their text, so an action that reads the notes that may name
/// something reads every collection page as well (SPEC_DEEP_AUDIT.md, Н5).
pub fn list_collection_page_slugs(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT slug FROM source_index_state WHERE source_kind = 'channel' ORDER BY slug",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Every indexed card with a media file, as the index holds it: the path
/// from the space root when the file was found, the reference as written
/// when it was not (yet).
pub fn list_media_files(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT slug, media_file FROM blocks
         WHERE slug != '' AND media_file IS NOT NULL AND media_file != '' ORDER BY slug",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Return every previewable block of each collection, newest first, members
/// only ([`collection_membership_join_sql`]): a strip takes as many as its
/// width shows (SPEC_SIDEBAR_STRIP.md, ЛМ1). A collection without one has no
/// key here.
pub fn list_preview_blocks_by_tag(
    conn: &Connection,
) -> Result<std::collections::HashMap<String, Vec<PreviewBlock>>> {
    let membership = collection_membership_join_sql("bt", "page");
    let mut stmt = conn.prepare(&format!(
        "SELECT page.tag, b.slug, b.thumb_format, b.thumb_mtime, b.preview_manifest
         FROM block_tags bt
         {membership}
         JOIN blocks b ON b.id = bt.block_id
         WHERE b.slug != '' AND b.card_kind != 'channel' AND b.thumb_format IS NOT NULL
         ORDER BY page.tag, b.saved_at DESC"
    ))?;

    let rows = stmt.query_map([], |row| {
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

/// Every note whose `Mine Collections` names `tag`, ordered by saved_at
/// descending, whether the collection has a page or not.
///
/// This is the mirror of the files, not membership: the rename and deletion
/// of a collection read it to find each file they rewrite. Reads that show or
/// count collections go through [`collection_membership_join_sql`] instead.
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

/// Every collection with members and how many notes are in it, ordered by
/// count descending, then by name. Only memberships count
/// ([`collection_membership_join_sql`]): a link whose name has no page is in
/// no count, and a page no note names is not here (the collection list itself
/// comes from `channels`).
pub fn get_all_tags(conn: &Connection) -> Result<Vec<TagCount>> {
    let membership = collection_membership_join_sql("bt", "page");
    let mut stmt = conn.prepare(&format!(
        "SELECT page.tag, count(*) as cnt FROM block_tags bt
         {membership}
         GROUP BY page.tag ORDER BY cnt DESC, page.tag ASC"
    ))?;
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

/// Every card's collections as `(block id, collection)` pairs, collection
/// documents excluded, members only ([`collection_membership_join_sql`]).
/// The interface keeps them to answer, instantly and in both directions,
/// which collections a hovered card is in and which cards a hovered
/// collection holds (SPEC_CARD_STATES.md, С3 and С4).
pub fn list_block_collections(conn: &Connection) -> Result<Vec<(i64, String)>> {
    let membership = collection_membership_join_sql("bt", "page");
    let mut stmt = conn.prepare(&format!(
        "SELECT bt.block_id, page.tag FROM block_tags bt
         {membership}
         JOIN blocks b ON b.id = bt.block_id
         WHERE b.card_kind != 'channel'
         ORDER BY bt.block_id, page.tag"
    ))?;
    let pairs = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(pairs)
}

/// Search blocks using a structured query (free text + filters).
///
/// Builds SQL dynamically:
/// - Free text: JOIN blocks_fts WHERE MATCH ?
/// - Type filter: WHERE card_kind = ?
/// - Tag filter: JOIN block_tags WHERE tag = ?, members only
///   ([`collection_membership_join_sql`])
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
                    "JOIN block_tags {a} ON {a}.block_id = b.id {membership}",
                    a = alias,
                    membership =
                        collection_membership_join_sql(&alias, &format!("page{tag_alias_idx}"))
                ));
                conditions.push(format!("page{}.tag = ?{}", tag_alias_idx, param_values.len() + 1));
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
        content_in_cloud: row.get::<_, Option<String>>(22).unwrap_or(None).as_deref()
            == Some("content_in_cloud"),
        preview_unreadable: row.get::<_, Option<String>>(22).unwrap_or(None).as_deref()
            == Some("unreadable_artifact"),
        collections: collections_from_row(row)?,
        search_match: None,
    })
}

/// Decode the [`collections_column_sql`] column. SQLite built the array, so a
/// value that is not one is a broken query, reported rather than shown as a
/// card in no collection.
fn collections_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Vec<String>> {
    let index = row.as_ref().column_index(COLLECTIONS_COLUMN)?;
    let raw: String = row.get(index)?;
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(error))
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

/// Resolve one author-written Obsidian note link against the current source projection.
pub fn resolve_note_link(
    conn: &Connection,
    source_slug: &str,
    raw_target: &str,
) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT slug FROM blocks")?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .map(|slug| format!("{slug}.md"))
        .collect::<Vec<_>>();
    let index = LinkIndex::new(paths);
    let LinkResolution::Resolved(path) = index.resolve(
        &format!("{source_slug}.md"),
        raw_target,
        LinkSyntax::Obsidian,
    ) else {
        return Ok(None);
    };
    let Some(slug) = path.strip_suffix(".md") else {
        return Ok(None);
    };
    let is_card: Option<bool> = conn
        .query_row(
            "SELECT card_kind != 'channel' FROM blocks WHERE slug = ?1",
            [slug],
            |row| row.get(0),
        )
        .optional()?;
    Ok(is_card.filter(|value| *value).map(|_| slug.to_string()))
}

fn load_bidirectional_related_notes(
    conn: &Connection,
    _block_id: i64,
    slug: &str,
) -> Result<Vec<String>> {
    let mut block_stmt = conn.prepare("SELECT slug, saved_at, card_kind FROM blocks")?;
    let blocks = block_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let link_index = LinkIndex::new(blocks.iter().map(|(path, _, _)| format!("{path}.md")));
    let card_dates = blocks
        .into_iter()
        .filter(|(_, _, kind)| kind != "channel")
        .map(|(slug, date, _)| (slug, date))
        .collect::<BTreeMap<_, _>>();
    let mut link_stmt = conn.prepare(
        "SELECT sb.slug, w.target_slug FROM (
             SELECT source_id, target_slug FROM wikilinks
             UNION ALL
             SELECT source_id, target_slug FROM related_note_links
         ) w JOIN blocks sb ON sb.id = w.source_id",
    )?;
    let links = link_stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut related = BTreeSet::new();
    for link in links {
        let (source, raw_target) = link?;
        let LinkResolution::Resolved(path) =
            link_index.resolve(&format!("{source}.md"), &raw_target, LinkSyntax::Obsidian)
        else {
            continue;
        };
        let Some(target) = path.strip_suffix(".md") else {
            continue;
        };
        if source == slug && target != slug && card_dates.contains_key(target) {
            related.insert(target.to_string());
        } else if target == slug && source != slug && card_dates.contains_key(&source) {
            related.insert(source);
        }
    }
    let mut related = related.into_iter().collect::<Vec<_>>();
    related.sort_by(|left, right| {
        card_dates[right]
            .cmp(&card_dates[left])
            .then_with(|| left.cmp(right))
    });
    Ok(related)
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

/// The collections of one note, members only ([`collection_membership_join_sql`]).
pub(crate) fn get_tags_for_block(conn: &Connection, block_id: i64) -> Result<Vec<String>> {
    let membership = collection_membership_join_sql("bt", "page");
    let mut stmt = conn.prepare(&format!(
        "SELECT page.tag FROM block_tags bt {membership} WHERE bt.block_id = ?1 ORDER BY page.tag"
    ))?;
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

    // Batch: fetch all collections (members only) in one query instead of N+1
    let ids: Vec<i64> = blocks.iter().map(|b| b.id).collect();
    let placeholders: String = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT bt.block_id, page.tag FROM block_tags bt {membership}
         WHERE bt.block_id IN ({placeholders}) ORDER BY page.tag",
        membership = collection_membership_join_sql("bt", "page"),
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
