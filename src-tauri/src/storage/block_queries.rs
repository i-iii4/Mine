//! Route-facing and utility queries over the block index.
//!
//! Write/backfill ownership stays in storage::index; this module owns SQL read
//! models, row hydration and legacy structured search.

use anyhow::{Context, Result};
use mine_core::links::{LinkIndex, LinkResolution, LinkSyntax};
use rusqlite::{Connection, OptionalExtension};
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

    /// [`Self::order_by`] read from its end: the cards nearest before a place
    /// come first.
    fn reversed_order_by(self, column_prefix: &str) -> String {
        let direction = match self {
            FeedOrder::Newest => "ASC",
            FeedOrder::Oldest => "DESC",
        };
        format!(
            "{column_prefix}saved_at {direction}, {column_prefix}slug COLLATE NOCASE DESC, {column_prefix}slug DESC"
        )
    }

    /// The condition that a row stands before the place (`saved_at`, `slug`)
    /// in this order. `column_prefix` qualifies the row's columns; `saved_at`
    /// and `slug` are SQL expressions of the place, a parameter or another
    /// row's column. The leading range on `saved_at` repeats what the rest
    /// implies, so an index on the date bounds the search.
    fn stands_before_sql(self, column_prefix: &str, saved_at: &str, slug: &str) -> String {
        let (within, strictly) = match self {
            FeedOrder::Newest => (">=", ">"),
            FeedOrder::Oldest => ("<=", "<"),
        };
        let c = column_prefix;
        format!(
            "({c}saved_at {within} {saved_at}
              AND ({c}saved_at {strictly} {saved_at}
                   OR {c}slug COLLATE NOCASE < {slug}
                   OR ({c}slug COLLATE NOCASE = {slug} AND {c}slug < {slug})))"
        )
    }

    /// The condition that a row stands after the place (`saved_at`, `slug`)
    /// in this order; see [`Self::stands_before_sql`].
    fn stands_after_sql(self, column_prefix: &str, saved_at: &str, slug: &str) -> String {
        let (within, strictly) = match self {
            FeedOrder::Newest => ("<=", "<"),
            FeedOrder::Oldest => (">=", ">"),
        };
        let c = column_prefix;
        format!(
            "({c}saved_at {within} {saved_at}
              AND ({c}saved_at {strictly} {saved_at}
                   OR {c}slug COLLATE NOCASE > {slug}
                   OR ({c}slug COLLATE NOCASE = {slug} AND {c}slug > {slug})))"
        )
    }
}

/// Where a page of the feed starts: after the card that has this place in
/// the feed's order (SPEC_STORAGE.md, «Страница ленты по ключу»). The page
/// takes both from the row of the last card it holds. The token names a
/// place, not a row: the card may be gone by the time the page is read.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct FeedPageToken {
    pub saved_at: String,
    pub slug: String,
}

impl FeedPageToken {
    /// The place of `block` in the feed's order.
    pub fn of(block: &LightBlock) -> Self {
        Self {
            saved_at: block.saved_at.clone(),
            slug: block.slug.clone(),
        }
    }
}

/// Where a feed read starts.
#[derive(Clone, Copy)]
enum PageStart<'a> {
    /// After the place `Some` names, or with the feed's first card: the
    /// app's pages. A place is found through the feed's order, whatever
    /// stands before it.
    After(Option<&'a FeedPageToken>),
    /// At a card's number in the feed: the command line's `--offset`. Every
    /// card before the number is read and dropped.
    Offset(usize),
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
    list_grid_blocks_filtered(conn, filter, PageStart::Offset(offset), limit, FeedOrder::Newest, None)
}

/// A page of the feed of a place in the person's chosen order: Everything,
/// a collection, or one author's cards (SPEC_CARD_ASSOCIATIONS.md, «Лента по
/// месту»). `after` is the place the page starts after, `None` for the
/// feed's first cards (SPEC_STORAGE.md, «Страница ленты по ключу»). An
/// author that normalizes to nothing has no cards.
pub fn list_grid_blocks_in_order(
    conn: &Connection,
    location: &TabLocation,
    after: Option<&FeedPageToken>,
    limit: usize,
    order: FeedOrder,
) -> Result<(Vec<LightBlock>, bool)> {
    list_place(conn, location, PageStart::After(after), limit, order, None)
}

/// [`list_grid_blocks_in_order`] for a reader that has counted the space's
/// cards (`count_grid_blocks`) for its own answer: `cards` is that count,
/// and it is not counted a second time to choose how a collection is read.
pub fn list_feed_page(
    conn: &Connection,
    location: &TabLocation,
    after: Option<&FeedPageToken>,
    limit: usize,
    order: FeedOrder,
    cards: usize,
) -> Result<(Vec<LightBlock>, bool)> {
    list_place(conn, location, PageStart::After(after), limit, order, Some(cards))
}

fn list_place(
    conn: &Connection,
    location: &TabLocation,
    start: PageStart<'_>,
    limit: usize,
    order: FeedOrder,
    cards: Option<usize>,
) -> Result<(Vec<LightBlock>, bool)> {
    match location {
        TabLocation::Everything => {
            list_grid_blocks_filtered(conn, GridFilter::All, start, limit, order, cards)
        }
        TabLocation::Collection { tag } => {
            list_grid_blocks_filtered(conn, GridFilter::Collection(tag), start, limit, order, cards)
        }
        TabLocation::Author { author } => match author_key(author) {
            Some(key) => {
                list_grid_blocks_filtered(conn, GridFilter::AuthorKey(&key), start, limit, order, cards)
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
        PageStart::After(None),
        slugs.len(),
        FeedOrder::Newest,
        None,
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
    let token = FeedPageToken {
        saved_at: String::new(),
        slug: String::new(),
    };
    // Infallible: an author's key serializes to no JSON.
    feed_page_query(
        &GridFilter::AuthorKey(""),
        order,
        PageStart::After(Some(&token)),
        1,
        CollectionRead::FromMembers,
    )
    .map(|(sql, _)| sql)
    .unwrap_or_default()
}

/// The condition that makes a row of `blocks {block}` a card of the feed
/// `filter` reads, beside `card_kind != 'channel'`. `value` is the SQL
/// parameter the filter's value is bound to. The page query and the partial
/// read share it, so a card belongs to a feed by one rule.
///
/// A collection's cards are told by a test on the card
/// ([`collection_membership_join_sql`] inside `EXISTS`), so a read that goes
/// through the feed's order asks each card it meets and stops at the card it
/// wanted: the nearest card before a place is found beside that place.
fn feed_place_sql(filter: &GridFilter<'_>, block: &str, value: &str) -> String {
    match filter {
        GridFilter::All => String::new(),
        GridFilter::Collection(_) => {
            let tags = format!("{block}_tags");
            let page = format!("{block}_page");
            format!(
                "AND EXISTS (SELECT 1 FROM block_tags {tags} {}
                             WHERE {tags}.block_id = {block}.id AND {page}.tag = {value})",
                collection_membership_join_sql(&tags, &page)
            )
        }
        GridFilter::AuthorKey(_) => format!("AND {block}.association_author_key = {value}"),
        GridFilter::Slugs(_) => {
            format!("AND {block}.slug IN (SELECT value FROM json_each({value}))")
        }
    }
}

/// Which way a page of a collection is read. Both give the same page
/// (`both_ways_of_reading_a_collection_give_the_same_pages`); they differ in
/// what they visit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CollectionRead {
    /// From the collection's cards: all of them are visited, their places in
    /// the feed's order sorted, and the page's cards read. Visits as many
    /// cards as the collection holds, wherever in the feed they stand.
    FromMembers,
    /// Along the feed's order: each card after the page's start is asked
    /// whether it is in the collection, until the page is full. Visits at
    /// worst every card of the space that is not in the collection.
    AlongTheFeed,
}

impl CollectionRead {
    /// The way with the smaller worst case for the collection `tag` in a
    /// space of `cards` cards
    /// (SPEC_STORAGE.md, «Страница ленты по ключу»): from the members while
    /// they are at most half of the space's cards, along the feed once they
    /// are more. Either way a page visits at most half of the space's cards,
    /// however the collection's cards are spread over the feed.
    ///
    /// The collection's size is told by its links alone, read from their
    /// index and no further than half of the space: the links of a card by
    /// both of a page's names, or of a collection page itself, count a card
    /// too many, which moves the choice by that much and no page's cards.
    fn with_the_smaller_worst_case(conn: &Connection, tag: &str, cards: usize) -> Result<Self> {
        let half = cards / 2;
        let links: i64 = conn.query_row(
            "SELECT COUNT(*) FROM (
                 SELECT 1
                 FROM channels page
                 JOIN block_tags link ON link.tag = page.tag OR link.tag = page.source_slug
                 WHERE page.tag = ?1
                 LIMIT ?2
             )",
            rusqlite::params![tag, i64::try_from(half.saturating_add(1))?],
            |row| row.get(0),
        )?;
        Ok(Self::for_sizes(usize::try_from(links)?, half))
    }

    /// From the members while there are at most `half` of them.
    fn for_sizes(members: usize, half: usize) -> Self {
        if members <= half {
            Self::FromMembers
        } else {
            Self::AlongTheFeed
        }
    }
}

/// The query of one read of a feed and its values: `rows` cards of `filter`
/// in `order` from `start`. `collection` is the way a collection is read;
/// the other feeds have one way, along the index of their order.
fn feed_page_query(
    filter: &GridFilter<'_>,
    order: FeedOrder,
    start: PageStart<'_>,
    rows: usize,
    collection: CollectionRead,
) -> Result<(String, QueryValues)> {
    // `?1` is the body preview length of `grid_row_columns_sql`.
    let mut values = QueryValues(vec![rusqlite::types::Value::Integer(
        LIGHT_BLOCK_BODY_PREVIEW_CHARS,
    )]);
    let columns = grid_row_columns_sql("b");
    let place = match filter {
        GridFilter::All => String::new(),
        GridFilter::Collection(value) | GridFilter::AuthorKey(value) => {
            values.bind((*value).to_string())
        }
        GridFilter::Slugs(slugs) => values.bind(serde_json::to_string(slugs)?),
    };
    let token = match start {
        PageStart::After(Some(token)) => Some((
            values.bind(token.saved_at.clone()),
            values.bind(token.slug.clone()),
        )),
        PageStart::After(None) | PageStart::Offset(_) => None,
    };
    let after = |block: &str| {
        token.as_ref().map_or_else(String::new, |(saved_at, slug)| {
            format!("AND {}", order.stands_after_sql(block, saved_at, slug))
        })
    };
    let limit = values.bind(i64::try_from(rows)?);
    let offset = match start {
        PageStart::Offset(offset) => format!("OFFSET {}", values.bind(i64::try_from(offset)?)),
        PageStart::After(_) => String::new(),
    };
    let order_by = order.order_by("b.");
    let sql = if matches!(filter, GridFilter::Collection(_)) && collection == CollectionRead::FromMembers {
        // The page's cards are chosen from the collection's links, by their
        // places alone, and only those cards' rows are read in full: sorting
        // every member's whole row made a page of a collection of 5 000
        // cards cost as much as reading all of them. `CROSS JOIN` keeps the
        // links first: left to itself SQLite may walk every card of the
        // space instead.
        let membership = collection_membership_join_sql("m_tags", "m_page");
        let after = after("m.");
        let member_order = order.order_by("m.");
        format!(
            "SELECT {columns}
             FROM blocks b
             WHERE b.id IN (
                 SELECT m.id
                 FROM block_tags m_tags {membership}
                 CROSS JOIN blocks m ON m.id = m_tags.block_id
                 WHERE m_page.tag = {place} AND m.card_kind != 'channel' {after}
                 ORDER BY {member_order}
                 LIMIT {limit} {offset}
             )
             ORDER BY {order_by}"
        )
    } else {
        let condition = feed_place_sql(filter, "b", &place);
        let after = after("b.");
        format!(
            "SELECT {columns}
             FROM blocks b
             WHERE b.card_kind != 'channel' {condition} {after}
             ORDER BY {order_by}
             LIMIT {limit} {offset}"
        )
    };
    Ok((sql, values))
}

fn list_grid_blocks_filtered(
    conn: &Connection,
    filter: GridFilter<'_>,
    start: PageStart<'_>,
    limit: usize,
    order: FeedOrder,
    // The space's cards, when the caller has counted them.
    cards: Option<usize>,
) -> Result<(Vec<LightBlock>, bool)> {
    let collection = match filter {
        GridFilter::Collection(tag) => {
            let cards = match cards {
                Some(cards) => cards,
                None => count_grid_blocks(conn)?,
            };
            CollectionRead::with_the_smaller_worst_case(conn, tag, cards)?
        }
        GridFilter::All | GridFilter::AuthorKey(_) | GridFilter::Slugs(_) => CollectionRead::FromMembers,
    };
    // One card past the page tells whether the feed has more.
    let (sql, values) = feed_page_query(&filter, order, start, limit.saturating_add(1), collection)?;
    let mut stmt = conn.prepare(&sql)?;
    let mut blocks = stmt
        .query_map(rusqlite::params_from_iter(values.0.iter()), light_block_from_row)?
        .collect::<Result<Vec<_>, _>>()?;

    let has_more = blocks.len() > limit;
    if has_more {
        blocks.truncate(limit);
    }

    Ok((blocks, has_more))
}

/// One named card as the feed holds it now, and where it stands.
#[derive(Debug, Clone, PartialEq, serde::Serialize, specta::Type)]
pub struct FeedPatchRow {
    pub block: LightBlock,
    /// `blocks.id` of the nearest card before this one in the feed that is
    /// not among the named cards; `None` when no such card stands before it.
    pub after: Option<i64>,
}

/// The named cards of a feed within a page's range
/// (SPEC_STORAGE.md, «Частичное чтение ленты»).
#[derive(Debug, Clone, PartialEq)]
pub struct FeedPatchRows {
    /// The named cards that stand in the feed within the range, in feed order.
    pub rows: Vec<FeedPatchRow>,
    /// Whether the feed holds cards after the range.
    pub has_more: bool,
    /// The card the range ends at is not in the feed: the range is unknown.
    pub range_lost: bool,
}

/// Parameters of a query built piece by piece: each bound value takes the
/// next number.
struct QueryValues(Vec<rusqlite::types::Value>);

impl QueryValues {
    /// Bind `value` and return its placeholder.
    fn bind(&mut self, value: impl Into<rusqlite::types::Value>) -> String {
        self.0.push(value.into());
        format!("?{}", self.0.len())
    }
}

/// Read the cards `cards` (`blocks.id`) as the feed of `location` holds them
/// now: the ones that stand in it within the page's range, each with the
/// card it stands after. `end` is the last card the page holds that is not
/// among `cards`, or `None` when the page holds the whole feed.
///
/// Membership and order come from the SQL of the full read
/// ([`feed_place_sql`], [`FeedOrder::order_by`]) and the rows from its row
/// model ([`grid_row_columns_sql`]), so a list patched with the answer equals
/// the list a full read gives.
pub fn feed_patch_rows(
    conn: &Connection,
    location: &TabLocation,
    order: FeedOrder,
    cards: &[i64],
    end: Option<i64>,
) -> Result<FeedPatchRows> {
    let author_key_value;
    let filter = match location {
        TabLocation::Everything => GridFilter::All,
        TabLocation::Collection { tag } => GridFilter::Collection(tag),
        TabLocation::Author { author } => match author_key(author) {
            Some(key) => {
                author_key_value = key;
                GridFilter::AuthorKey(&author_key_value)
            }
            // An author that normalizes to nothing has no cards.
            None => {
                return Ok(FeedPatchRows {
                    rows: Vec::new(),
                    has_more: false,
                    range_lost: end.is_some(),
                })
            }
        },
    };
    let place_value = match filter {
        GridFilter::All | GridFilter::Slugs(_) => None,
        GridFilter::Collection(value) | GridFilter::AuthorKey(value) => Some(value.to_string()),
    };
    let cards_json = serde_json::to_string(cards)?;

    // Where the range ends: before the first card after `end` that is not
    // named. Named cards right after `end` stay within it.
    let mut bound: Option<(String, String)> = None;
    if let Some(end) = end {
        let mut values = QueryValues(Vec::new());
        let place = place_value.clone().map(|value| values.bind(value)).unwrap_or_default();
        let condition = feed_place_sql(&filter, "b", &place);
        let end_id = values.bind(end);
        let end_place: Option<(String, String)> = conn
            .query_row(
                &format!(
                    "SELECT b.saved_at, b.slug FROM blocks b
                     WHERE b.card_kind != 'channel' {condition} AND b.id = {end_id}"
                ),
                rusqlite::params_from_iter(values.0.iter()),
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((end_saved_at, end_slug)) = end_place else {
            return Ok(FeedPatchRows {
                rows: Vec::new(),
                has_more: false,
                range_lost: true,
            });
        };

        let mut values = QueryValues(Vec::new());
        let place = place_value.clone().map(|value| values.bind(value)).unwrap_or_default();
        let condition = feed_place_sql(&filter, "b", &place);
        let named = values.bind(cards_json.clone());
        let saved_at = values.bind(end_saved_at);
        let slug = values.bind(end_slug);
        let after_end = order.stands_after_sql("b.", &saved_at, &slug);
        let order_by = order.order_by("b.");
        bound = conn
            .query_row(
                &format!(
                    "SELECT b.saved_at, b.slug FROM blocks b
                     WHERE b.card_kind != 'channel' {condition}
                       AND {after_end}
                       AND b.id NOT IN (SELECT value FROM json_each({named}))
                     ORDER BY {order_by}
                     LIMIT 1"
                ),
                rusqlite::params_from_iter(values.0.iter()),
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
    }

    // `?1` is the body preview length of `grid_row_columns_sql`.
    let mut values = QueryValues(vec![rusqlite::types::Value::Integer(
        LIGHT_BLOCK_BODY_PREVIEW_CHARS,
    )]);
    let columns = grid_row_columns_sql("b");
    let place = place_value.map(|value| values.bind(value)).unwrap_or_default();
    let condition = feed_place_sql(&filter, "b", &place);
    let before_condition = feed_place_sql(&filter, "p", &place);
    let named = values.bind(cards_json);
    let within_range = match &bound {
        Some((saved_at, slug)) => {
            let saved_at = values.bind(saved_at.clone());
            let slug = values.bind(slug.clone());
            format!("AND {}", order.stands_before_sql("b.", &saved_at, &slug))
        }
        None => String::new(),
    };
    let stands_before = order.stands_before_sql("p.", "b.saved_at", "b.slug");
    let nearest_first = order.reversed_order_by("p.");
    let order_by = order.order_by("b.");
    let sql = format!(
        "SELECT {columns},
                (SELECT p.id FROM blocks p
                 WHERE p.card_kind != 'channel' {before_condition}
                   AND {stands_before}
                   AND p.id NOT IN (SELECT value FROM json_each({named}))
                 ORDER BY {nearest_first}
                 LIMIT 1) AS stands_after
         FROM blocks b
         WHERE b.card_kind != 'channel' {condition}
           AND b.id IN (SELECT value FROM json_each({named}))
           {within_range}
         ORDER BY {order_by}"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.0.iter()), |row| {
            let after_index = row.as_ref().column_index("stands_after")?;
            Ok(FeedPatchRow {
                block: light_block_from_row(row)?,
                after: row.get(after_index)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(FeedPatchRows {
        rows,
        has_more: bound.is_some(),
        range_lost: false,
    })
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

#[cfg(test)]
mod feed_patch_tests {
    //! The partial read of the feed gives the list a full read gives
    //! (SPEC_STORAGE.md, «Частичное чтение ленты»; the user's condition of
    //! 15.11.2026).

    use super::*;
    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::domain::channel::Channel;
    use crate::storage::{channel_index, db, index, projection};

    fn card(slug: &str, saved_at: &str, collections: &[&str], author: Option<&str>) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: None,
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: collections.iter().map(|tag| (*tag).to_string()).collect(),
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new(saved_at).unwrap(),
                source: None,
                width: None,
                height: None,
                author: author.map(str::to_string),
                position: None,
                color: None,
                icon: None,
            },
            body: format!("Body of {slug}"),
        }
    }

    fn collection(conn: &Connection, tag: &str, position: i64) {
        channel_index::upsert_channel(
            conn,
            &Channel {
                tag: tag.to_string(),
                description: None,
                color: None,
                icon: None,
                position,
                created_at: DateTime::new("2026-01-01T00:00:00Z").unwrap(),
            },
        )
        .unwrap();
    }

    fn put(conn: &Connection, block: &Block) {
        index::upsert_block(conn, block, None).unwrap();
    }

    /// Twelve cards over six dates, two per date so the name breaks ties, in
    /// two collections and by two authors.
    fn space() -> Connection {
        let conn = db::open_memory().unwrap();
        collection(&conn, "Alpha", 1);
        collection(&conn, "Beta", 2);
        for day in 1..=6 {
            let saved_at = format!("2026-03-{day:02}T10:00:00Z");
            let even = day % 2 == 0;
            put(
                &conn,
                &card(
                    &format!("card-{day}-a"),
                    &saved_at,
                    if even { &["Alpha"] } else { &["Alpha", "Beta"] },
                    Some("Ada"),
                ),
            );
            put(
                &conn,
                &card(
                    &format!("Card-{day}-B"),
                    &saved_at,
                    if even { &["Beta"] } else { &[] },
                    if even { Some("Ada") } else { Some("Grace") },
                ),
            );
        }
        conn
    }

    /// A read limit past every card of the test space.
    const EVERY_CARD: usize = 1_000;

    fn id_of(conn: &Connection, slug: &str) -> i64 {
        conn.query_row("SELECT id FROM blocks WHERE slug = ?1", [slug], |row| row.get(0))
            .unwrap()
    }

    /// Every card row of the space as the feed reads it, by id.
    fn rows_by_id(conn: &Connection) -> BTreeMap<i64, LightBlock> {
        let (rows, _) =
            list_grid_blocks_filtered(conn, GridFilter::All, PageStart::After(None), EVERY_CARD, FeedOrder::Newest, None)
                .unwrap();
        rows.into_iter().map(|row| (row.id, row)).collect()
    }

    /// The cards a change touched: every card whose feed row differs, came or
    /// went. The oracle the named cards are held to, independent of any
    /// command's own account of what it wrote.
    fn changed_cards(before: &BTreeMap<i64, LightBlock>, after: &BTreeMap<i64, LightBlock>) -> Vec<i64> {
        let ids: BTreeSet<i64> = before.keys().chain(after.keys()).copied().collect();
        ids.into_iter()
            .filter(|id| before.get(id) != after.get(id))
            .collect()
    }

    /// A page's list of a feed: what it holds and whether the feed has more.
    #[derive(Debug, Clone, PartialEq)]
    struct PageList {
        cards: Vec<LightBlock>,
        has_more: bool,
        total: usize,
    }

    fn full_read(conn: &Connection, location: &TabLocation, order: FeedOrder, limit: usize) -> PageList {
        let snapshot = projection::read_grid_snapshot(conn, location, None, limit.max(1), order).unwrap();
        let mut cards = snapshot.blocks;
        let has_more = snapshot.has_more || cards.len() > limit;
        cards.truncate(limit);
        PageList {
            cards,
            has_more,
            total: snapshot.total_blocks,
        }
    }

    /// The page's partial path: drop the named cards, then put each answered
    /// row after the card the answer names (`applyFeedPatch` on the page).
    /// `None` when the page has to read in full.
    fn partial_read(
        conn: &Connection,
        location: &TabLocation,
        order: FeedOrder,
        page: &PageList,
        named: &[i64],
    ) -> Option<PageList> {
        let kept: Vec<LightBlock> = page
            .cards
            .iter()
            .filter(|card| !named.contains(&card.id))
            .cloned()
            .collect();
        let end = if page.has_more {
            Some(kept.last()?.id)
        } else {
            None
        };
        let patch =
            projection::read_feed_patch(conn, "/space".into(), location, order, named, end).unwrap();
        if patch.range_lost {
            return None;
        }
        let mut cards = Vec::with_capacity(kept.len() + patch.rows.len());
        let mut rows = patch.rows.into_iter().peekable();
        while let Some(row) = rows.next_if(|row| row.after.is_none()) {
            cards.push(row.block);
        }
        for card in kept {
            let id = card.id;
            cards.push(card);
            while let Some(row) = rows.next_if(|row| row.after == Some(id)) {
                cards.push(row.block);
            }
        }
        assert!(rows.next().is_none(), "a row names a card the page does not hold");
        Some(PageList {
            cards,
            has_more: patch.has_more,
            total: patch.total_blocks,
        })
    }

    fn places() -> Vec<TabLocation> {
        vec![
            TabLocation::Everything,
            TabLocation::Collection { tag: "Alpha".into() },
            TabLocation::Collection { tag: "Beta".into() },
            TabLocation::Author { author: "Ada".into() },
        ]
    }

    /// For every place, both orders and every length of the page's list:
    /// after `change`, the partial read gives the list a full read of the
    /// same length gives. Returns how many lists were compared.
    fn assert_partial_equals_full(name: &str, change: impl Fn(&Connection)) -> usize {
        let conn = space();
        let before = rows_by_id(&conn);
        let mut compared = 0;
        for location in places() {
            for order in [FeedOrder::Newest, FeedOrder::Oldest] {
                let whole = full_read(&conn, &location, order, EVERY_CARD).cards.len();
                for loaded in 0..=whole {
                    let page = full_read(&conn, &location, order, loaded);
                    // Each list meets the change on the space as it was.
                    conn.execute_batch("SAVEPOINT one_change").unwrap();
                    change(&conn);
                    let named = changed_cards(&before, &rows_by_id(&conn));
                    assert!(!named.is_empty(), "{name}: the change touched no card");
                    match partial_read(&conn, &location, order, &page, &named) {
                        Some(patched) => {
                            let expected = full_read(&conn, &location, order, patched.cards.len());
                            assert_eq!(
                                patched, expected,
                                "{name}: {location:?} {order:?} loaded {loaded}"
                            );
                            // The list never ends before the cards it kept.
                            let kept =
                                page.cards.iter().filter(|card| !named.contains(&card.id)).count();
                            assert!(patched.cards.len() >= kept, "{name}: the list lost kept cards");
                            compared += 1;
                        }
                        // Every card of the list was named: the page reads in full.
                        None => assert!(
                            page.has_more && page.cards.iter().all(|card| named.contains(&card.id)),
                            "{name}: {location:?} {order:?} loaded {loaded}: the range was lost"
                        ),
                    }
                    conn.execute_batch("ROLLBACK TO one_change; RELEASE one_change").unwrap();
                }
            }
        }
        compared
    }

    #[test]
    fn partial_read_gives_the_feed_a_full_read_gives() {
        let mut compared = 0;
        compared += assert_partial_equals_full("connect a card", |conn| {
            put(conn, &card("Card-3-B", "2026-03-03T10:00:00Z", &["Alpha"], Some("Grace")));
        });
        compared += assert_partial_equals_full("disconnect a card", |conn| {
            put(conn, &card("card-3-a", "2026-03-03T10:00:00Z", &["Beta"], Some("Ada")));
        });
        compared += assert_partial_equals_full("create the newest card", |conn| {
            put(conn, &card("new-card", "2026-03-09T10:00:00Z", &["Alpha"], Some("Ada")));
        });
        compared += assert_partial_equals_full("create the oldest card", |conn| {
            put(conn, &card("old-card", "2026-02-01T10:00:00Z", &["Beta"], Some("Ada")));
        });
        compared += assert_partial_equals_full("create a card between two dates", |conn| {
            put(conn, &card("mid-card", "2026-03-03T12:00:00Z", &["Alpha", "Beta"], Some("Ada")));
        });
        compared += assert_partial_equals_full("delete a card", |conn| {
            index::remove_block(conn, "card-4-a").unwrap();
        });
        compared += assert_partial_equals_full("delete several cards", |conn| {
            for slug in ["card-6-a", "Card-6-B", "card-3-a", "card-1-a"] {
                index::remove_block(conn, slug).unwrap();
            }
        });
        compared += assert_partial_equals_full("rename a card past its neighbour", |conn| {
            // `card-4-a` stood before `Card-4-B` of the same date; `zeta` stands after it.
            index::rename_slug(conn, "card-4-a", "zeta").unwrap();
        });
        compared += assert_partial_equals_full("rename a card in letter case only", |conn| {
            index::rename_slug(conn, "card-2-a", "CARD-2-A").unwrap();
        });
        compared += assert_partial_equals_full("merge cards", |conn| {
            index::remove_block(conn, "card-5-a").unwrap();
            index::remove_block(conn, "Card-5-B").unwrap();
            put(conn, &card("merged", "2026-03-05T10:00:00Z", &["Alpha", "Beta"], Some("Ada")));
        });
        compared += assert_partial_equals_full("change a card's date", |conn| {
            put(conn, &card("card-2-a", "2026-03-05T18:00:00Z", &["Alpha"], Some("Ada")));
        });
        compared += assert_partial_equals_full("change a card's author", |conn| {
            put(conn, &card("card-4-a", "2026-03-04T10:00:00Z", &["Alpha"], Some("Grace")));
        });
        compared += assert_partial_equals_full("a collection's page appears", |conn| {
            // No card is written: the cards that link `Gamma` join it.
            put(conn, &card("card-6-a", "2026-03-06T10:00:00Z", &["Alpha", "Gamma"], Some("Ada")));
            collection(conn, "Gamma", 0);
        });
        compared += assert_partial_equals_full("several kinds at once", |conn| {
            index::remove_block(conn, "card-1-a").unwrap();
            index::rename_slug(conn, "Card-3-B", "another").unwrap();
            put(conn, &card("brand-new", "2026-03-04T10:00:00Z", &["Beta"], Some("Ada")));
            put(conn, &card("card-6-a", "2026-03-06T10:00:00Z", &[], Some("Ada")));
        });
        // 14 changes, 4 places, 2 orders, every list length.
        assert!(compared > 800, "only {compared} lists were compared");
    }

    /// Cards of the timed space, their collections and how many of the
    /// space's cards the page holds (`AUDIT_PERFORMANCE.md`, раздел 6: the
    /// plan's limits are for 10 000 cards; a deep feed holds 7 000).
    const TIMED_CARDS: usize = 10_000;
    const TIMED_COLLECTIONS: usize = 100;
    const TIMED_LOADED: usize = 7_000;
    /// Reads timed; the limit holds for the slowest of them.
    const TIMED_READS: usize = 9;
    /// Item 10 of the plan: the feed shows a change within 50 ms. The read
    /// and its JSON for the page take at most 20 ms of that, for one changed
    /// card and for as many as a command may name (`FEED_CHANGE_LIMIT`); the
    /// rest is the page's, which puts the rows into its list and lays the
    /// feed out. Measured 15.11.2026: 0.3 ms for one card, 7.4 ms for 500.
    const PATCH_READ_LIMIT: std::time::Duration = std::time::Duration::from_millis(20);

    /// A space of `TIMED_CARDS` cards with a body of text, two per second of
    /// save time so the name breaks ties, each in up to three collections.
    fn timed_space() -> Connection {
        let conn = db::open_memory().unwrap();
        for index in 0..TIMED_COLLECTIONS {
            collection(&conn, &format!("Collection {index:03}"), i64::try_from(index).unwrap());
        }
        let text = "A sentence of the card's text that the feed shows as its preview. ".repeat(12);
        conn.execute_batch("BEGIN").unwrap();
        for index in 0..TIMED_CARDS {
            let second = index / 2;
            let saved_at = format!(
                "2026-03-{:02}T{:02}:{:02}:{:02}Z",
                1 + second / 86_400,
                (second / 3_600) % 24,
                (second / 60) % 60,
                second % 60
            );
            let collections: Vec<String> = (0..index % 4)
                .map(|offset| format!("Collection {:03}", (index * 3 + offset) % TIMED_COLLECTIONS))
                .collect();
            let collections: Vec<&str> = collections.iter().map(String::as_str).collect();
            let mut block = card(&format!("card-{index:05}"), &saved_at, &collections, Some("Ada"));
            block.body = text.clone();
            put(&conn, &block);
        }
        conn.execute_batch("COMMIT").unwrap();
        conn
    }

    /// The partial read of `named` cards and its JSON, `TIMED_READS` times:
    /// the median, the slowest and the bytes.
    fn time_patch_reads(
        conn: &Connection,
        named: &[i64],
        end: Option<i64>,
    ) -> (std::time::Duration, std::time::Duration, usize, usize) {
        let mut timings = Vec::with_capacity(TIMED_READS);
        let (mut bytes, mut rows) = (0, 0);
        for _ in 0..TIMED_READS {
            let started = std::time::Instant::now();
            let patch = projection::read_feed_patch(
                conn,
                "/space".into(),
                &TabLocation::Everything,
                FeedOrder::Newest,
                named,
                end,
            )
            .unwrap();
            bytes = serde_json::to_vec(&patch).unwrap().len();
            rows = patch.rows.len();
            timings.push(started.elapsed());
        }
        timings.sort();
        (timings[timings.len() / 2], timings[timings.len() - 1], bytes, rows)
    }

    /// Item 10 of the plan: the partial read of a deep feed, the read and
    /// the JSON that crosses the IPC, answers within `PATCH_READ_LIMIT` for
    /// one changed card and for as many as a command may name. The limit is
    /// the app's, an optimised build's: a speed test, run by
    /// `test:rust-speed` (ARCHITECTURE.md, «Тесты скорости Rust»).
    #[test]
    #[ignore = "asserts a speed limit of an optimised build: bun run test:rust-speed"]
    fn a_partial_read_of_a_deep_feed_answers_within_its_limit() {
        let conn = timed_space();
        let feed = full_read(&conn, &TabLocation::Everything, FeedOrder::Newest, TIMED_CARDS).cards;
        assert_eq!(feed.len(), TIMED_CARDS);
        let end = Some(feed[TIMED_LOADED - 1].id);
        // The full read the partial one replaces, for the same loaded range.
        let started = std::time::Instant::now();
        let full = projection::read_grid_snapshot(&conn, &TabLocation::Everything, None, TIMED_LOADED, FeedOrder::Newest)
            .unwrap();
        let full_bytes = serde_json::to_vec(&full).unwrap().len();
        eprintln!(
            "list_grid_blocks, {TIMED_LOADED} of {TIMED_CARDS} cards, {full_bytes} B: {:?}",
            started.elapsed()
        );

        for count in [1, 10, 100, crate::storage::feed_changes::FEED_CHANGE_LIMIT, 2_000] {
            // The named cards spread evenly over the range the page holds.
            let named: Vec<i64> = (0..count).map(|index| feed[index * (TIMED_LOADED - 1) / count].id).collect();
            let (median, slowest, bytes, rows) = time_patch_reads(&conn, &named, end);
            assert_eq!(rows, count);
            let asserted = count <= crate::storage::feed_changes::FEED_CHANGE_LIMIT;
            eprintln!(
                "read_feed_changes, {count} of {TIMED_LOADED} loaded cards, {bytes} B: median {median:?}, slowest {slowest:?}, limit {PATCH_READ_LIMIT:?}{}",
                if asserted { ", asserted" } else { "" }
            );
            if asserted {
                assert!(
                    slowest <= PATCH_READ_LIMIT,
                    "read_feed_changes of {count} cards {slowest:?} over {PATCH_READ_LIMIT:?} (median {median:?})"
                );
            }
        }
    }

    /// Item 7 of the plan (`AUDIT_PERFORMANCE.md`, Л4): cards of the space
    /// the pages are timed in, the cards of a page, the collections every
    /// card is spread over and the one large collection.
    const PAGED_CARDS: usize = 30_000;
    const PAGE_ROWS: usize = 200;
    const PAGED_COLLECTIONS: usize = 300;
    const LARGE_COLLECTION: &str = "Imported";
    /// Every sixth card is in the large collection: 5 000 cards, a channel
    /// brought in whole.
    const LARGE_COLLECTION_EVERY: usize = 6;
    /// The oldest third of the space, 10 000 cards: every card of it stands
    /// after every other card when the feed reads newest first.
    const OLD_COLLECTION: &str = "Archive";
    /// Two cards of three, 20 000 cards: more than half of the space.
    const WIDE_COLLECTION: &str = "Most";
    /// Any page of the feed, the read and its JSON for the page.
    const PAGE_READ_LIMIT: std::time::Duration = std::time::Duration::from_millis(15);

    /// A space of `PAGED_CARDS` cards with a body of text, two per second of
    /// save time, half of them by one author, each in up to three of
    /// `PAGED_COLLECTIONS` collections and every sixth in the large one.
    fn paged_space() -> Connection {
        let conn = db::open_memory().unwrap();
        for index in 0..PAGED_COLLECTIONS {
            collection(&conn, &format!("Collection {index:03}"), i64::try_from(index).unwrap());
        }
        collection(&conn, LARGE_COLLECTION, -1);
        collection(&conn, OLD_COLLECTION, -2);
        collection(&conn, WIDE_COLLECTION, -3);
        let text = "A sentence of the card's text that the feed shows as its preview. ".repeat(12);
        conn.execute_batch("BEGIN").unwrap();
        for index in 0..PAGED_CARDS {
            let second = index / 2;
            let saved_at = format!(
                "2026-03-{:02}T{:02}:{:02}:{:02}Z",
                1 + second / 86_400,
                (second / 3_600) % 24,
                (second / 60) % 60,
                second % 60
            );
            let mut collections: Vec<String> = (0..index % 4)
                .map(|offset| format!("Collection {:03}", (index * 3 + offset) % PAGED_COLLECTIONS))
                .collect();
            if index % LARGE_COLLECTION_EVERY == 0 {
                collections.push(LARGE_COLLECTION.to_string());
            }
            if index < PAGED_CARDS / 3 {
                collections.push(OLD_COLLECTION.to_string());
            }
            if index % 3 != 0 {
                collections.push(WIDE_COLLECTION.to_string());
            }
            let collections: Vec<&str> = collections.iter().map(String::as_str).collect();
            let author = if index % 2 == 0 { "Ada".to_string() } else { format!("Author {}", index % 500) };
            let mut block = card(&format!("card-{index:05}"), &saved_at, &collections, Some(&author));
            block.body = text.clone();
            put(&conn, &block);
        }
        conn.execute_batch("COMMIT").unwrap();
        conn
    }

    /// Walk the whole feed of `location` page by page, each page after the
    /// place of the last card of the one before, and time every page, the
    /// read and its JSON: how many cards, the median and the slowest page.
    fn time_every_page(
        conn: &Connection,
        location: &TabLocation,
        order: FeedOrder,
    ) -> (usize, usize, std::time::Duration, std::time::Duration) {
        let mut timings = Vec::new();
        let mut cards = 0;
        let mut after: Option<FeedPageToken> = None;
        loop {
            let started = std::time::Instant::now();
            let page = projection::read_grid_snapshot(conn, location, after.as_ref(), PAGE_ROWS, order).unwrap();
            let bytes = serde_json::to_vec(&page).unwrap().len();
            timings.push(started.elapsed());
            assert!(bytes > 0);
            cards += page.blocks.len();
            match page.blocks.last() {
                Some(last) if page.has_more => after = Some(FeedPageToken::of(last)),
                _ => break,
            }
        }
        let pages = timings.len();
        timings.sort();
        (cards, pages, timings[pages / 2], timings[pages - 1])
    }

    /// Item 7 of the plan: any page of 200 cards of a space of 30 000, the
    /// first, the last and every one between, answers within
    /// `PAGE_READ_LIMIT`: Everything, an author's feed, a collection of the
    /// usual size and a large one, in both orders. Until schema 10 a page
    /// from the middle of Everything took over a second there. The limit is
    /// the app's, an optimised build's: a speed test, run by
    /// `test:rust-speed` (ARCHITECTURE.md, «Тесты скорости Rust»).
    #[test]
    #[ignore = "asserts a speed limit of an optimised build: bun run test:rust-speed"]
    fn a_feed_page_at_any_depth_answers_within_its_limit() {
        let conn = paged_space();
        let places = [
            ("Everything", TabLocation::Everything, PAGED_CARDS),
            ("an author's feed", TabLocation::Author { author: "Ada".into() }, PAGED_CARDS / 2),
            (
                "a large collection",
                TabLocation::Collection { tag: LARGE_COLLECTION.into() },
                PAGED_CARDS / LARGE_COLLECTION_EVERY,
            ),
            (
                "a collection of the oldest third",
                TabLocation::Collection { tag: OLD_COLLECTION.into() },
                PAGED_CARDS / 3,
            ),
            (
                "a collection of two cards of three",
                TabLocation::Collection { tag: WIDE_COLLECTION.into() },
                PAGED_CARDS / 3 * 2,
            ),
            ("a collection", TabLocation::Collection { tag: "Collection 007".into() }, 0),
        ];
        let mut over = Vec::new();
        for (name, location, expected) in places {
            for order in [FeedOrder::Newest, FeedOrder::Oldest] {
                let (cards, pages, median, slowest) = time_every_page(&conn, &location, order);
                if expected > 0 {
                    assert_eq!(cards, expected, "{name}: the pages hold every card once");
                }
                eprintln!(
                    "list_grid_blocks, {name}, {order:?}, {cards} cards of {PAGED_CARDS} in {pages} pages of {PAGE_ROWS}: median {median:?}, slowest {slowest:?}, limit {PAGE_READ_LIMIT:?}, asserted"
                );
                if slowest > PAGE_READ_LIMIT {
                    over.push(format!("{name}, {order:?}: {slowest:?} (median {median:?})"));
                }
            }
        }
        assert!(over.is_empty(), "pages over {PAGE_READ_LIMIT:?}: {over:?}");

        // The query of a collection's page as it was until 16.11.2026, said
        // beside the numbers above and asserted nowhere: the page by a
        // card's number, the whole row of every card of the collection
        // sorted. It runs on today's indexes, so the collections of each row
        // are found as fast as they are now.
        let columns = grid_row_columns_sql("b");
        let membership = collection_membership_join_sql("bt", "page");
        let order_by = FeedOrder::Newest.order_by("b.");
        let mut former = conn
            .prepare(&format!(
                "SELECT {columns} FROM blocks b
                 INNER JOIN block_tags bt ON bt.block_id = b.id {membership}
                 WHERE b.card_kind != 'channel' AND page.tag = ?4
                 ORDER BY {order_by} LIMIT ?2 OFFSET ?3"
            ))
            .unwrap();
        for offset in [0_i64, 2_400, 4_800] {
            let started = std::time::Instant::now();
            let rows: Vec<LightBlock> = former
                .query_map(
                    rusqlite::params![
                        LIGHT_BLOCK_BODY_PREVIEW_CHARS,
                        i64::try_from(PAGE_ROWS + 1).unwrap(),
                        offset,
                        LARGE_COLLECTION
                    ],
                    light_block_from_row,
                )
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert!(!serde_json::to_vec(&rows).unwrap().is_empty());
            eprintln!(
                "the query of until 16.11.2026, a large collection, a page from card {offset}: {:?}",
                started.elapsed()
            );
        }

        // The partial read finds each named card's place beside it, in a
        // collection as in Everything: 100 cards of the large collection,
        // with the page holding the collection's first 3 000.
        let location = TabLocation::Collection { tag: LARGE_COLLECTION.into() };
        let held = full_read(&conn, &location, FeedOrder::Newest, 3_000).cards;
        let named: Vec<i64> = (0..100).map(|index| held[index * 29].id).collect();
        let end = Some(held[held.len() - 1].id);
        let mut timings = Vec::with_capacity(TIMED_READS);
        for _ in 0..TIMED_READS {
            let started = std::time::Instant::now();
            let patch =
                projection::read_feed_patch(&conn, "/space".into(), &location, FeedOrder::Newest, &named, end)
                    .unwrap();
            assert!(!serde_json::to_vec(&patch).unwrap().is_empty());
            assert_eq!(patch.rows.len(), named.len());
            timings.push(started.elapsed());
        }
        timings.sort();
        let (median, slowest) = (timings[timings.len() / 2], timings[timings.len() - 1]);
        eprintln!(
            "read_feed_changes, 100 of 3000 loaded cards of a collection of {}: median {median:?}, slowest {slowest:?}, limit {PATCH_READ_LIMIT:?}, asserted",
            PAGED_CARDS / LARGE_COLLECTION_EVERY
        );
        assert!(slowest <= PATCH_READ_LIMIT, "read_feed_changes in a collection {slowest:?} over {PATCH_READ_LIMIT:?}");
    }

    /// The plan SQLite makes for a page of `filter` in `order`, the first
    /// page or one after a place.
    fn page_plan(
        conn: &Connection,
        filter: &GridFilter<'_>,
        order: FeedOrder,
        after_a_place: bool,
        collection: CollectionRead,
    ) -> String {
        let token = FeedPageToken {
            saved_at: "2026-03-03T10:00:00Z".into(),
            slug: "card-3-a".into(),
        };
        let start = PageStart::After(after_a_place.then_some(&token));
        let (sql, values) = feed_page_query(filter, order, start, 201, collection).unwrap();
        let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        statement
            .query_map(rusqlite::params_from_iter(values.0.iter()), |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n")
    }

    /// `AUDIT_PERFORMANCE.md`, Л4: a page of Everything and of an author's
    /// feed is read through the index of the feed's order, in both orders,
    /// the first page and any page after a place: no pass over the whole
    /// table and no sort of what it found. Until schema 10 the plan was `SCAN
    /// b` and `USE TEMP B-TREE FOR ORDER BY`.
    #[test]
    fn a_feed_page_is_read_through_the_index_of_its_order() {
        let conn = space();
        let cases = [
            (GridFilter::All, FeedOrder::Newest, "idx_blocks_feed_newest"),
            (GridFilter::All, FeedOrder::Oldest, "idx_blocks_feed_oldest"),
            (GridFilter::AuthorKey("ada"), FeedOrder::Newest, "idx_blocks_author_feed_newest"),
            (GridFilter::AuthorKey("ada"), FeedOrder::Oldest, "idx_blocks_author_feed_oldest"),
        ];
        for (filter, order, index) in cases {
            for after_a_place in [false, true] {
                let plan = page_plan(&conn, &filter, order, after_a_place, CollectionRead::FromMembers);
                assert!(plan.contains(index), "{index}, after a place: {after_a_place}\n{plan}");
                assert!(
                    !plan.lines().any(|line| line.trim() == "SCAN b"),
                    "{index}: a pass over the whole table\n{plan}"
                );
                assert!(
                    !plan.contains("USE TEMP B-TREE FOR ORDER BY"),
                    "{index}: the page is sorted after it is found\n{plan}"
                );
            }
        }
    }

    /// A collection's page is read from the collection's cards or along the
    /// feed's order, and neither way passes over the whole table of cards:
    /// from the members SQLite starts at the collection's links and sorts
    /// the places of its cards; along the feed it goes through the index of
    /// the feed's order and sorts nothing.
    #[test]
    fn a_collection_page_is_read_from_its_cards_or_along_the_feed() {
        let conn = space();
        let filter = GridFilter::Collection("Alpha");
        for order in [FeedOrder::Newest, FeedOrder::Oldest] {
            let feed_index = match order {
                FeedOrder::Newest => "idx_blocks_feed_newest",
                FeedOrder::Oldest => "idx_blocks_feed_oldest",
            };
            for after_a_place in [false, true] {
                let from_members = page_plan(&conn, &filter, order, after_a_place, CollectionRead::FromMembers);
                assert!(from_members.contains("idx_block_tags_tag"), "{from_members}");
                assert!(
                    from_members.contains("SEARCH m USING INTEGER PRIMARY KEY"),
                    "the members are not the start\n{from_members}"
                );
                let along = page_plan(&conn, &filter, order, after_a_place, CollectionRead::AlongTheFeed);
                assert!(along.contains(feed_index), "{along}");
                assert!(!along.contains("USE TEMP B-TREE FOR ORDER BY"), "{along}");
                for plan in [&from_members, &along] {
                    assert!(
                        !plan.lines().any(|line| matches!(line.trim(), "SCAN b" | "SCAN m")),
                        "a pass over the whole table\n{plan}"
                    );
                }
            }
        }
    }

    /// Every page of `rows` cards of the collection `tag`, read `way`.
    fn pages_of(
        conn: &Connection,
        way: CollectionRead,
        tag: &str,
        order: FeedOrder,
        rows: usize,
    ) -> Vec<Vec<LightBlock>> {
        let mut pages = Vec::new();
        let mut after: Option<FeedPageToken> = None;
        loop {
            let (sql, values) =
                feed_page_query(&GridFilter::Collection(tag), order, PageStart::After(after.as_ref()), rows, way)
                    .unwrap();
            let page: Vec<LightBlock> = conn
                .prepare(&sql)
                .unwrap()
                .query_map(rusqlite::params_from_iter(values.0.iter()), light_block_from_row)
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            let Some(last) = page.last() else { break };
            after = Some(FeedPageToken::of(last));
            pages.push(page);
        }
        pages
    }

    /// The two ways of reading a collection give the same pages, page after
    /// page, in both orders: the way is chosen by the collection's size
    /// alone and never changes what the feed shows.
    #[test]
    fn both_ways_of_reading_a_collection_give_the_same_pages() {
        let conn = space();
        let pages = |way: CollectionRead, tag: &str, order: FeedOrder| pages_of(&conn, way, tag, order, 3);
        for tag in ["Alpha", "Beta"] {
            for order in [FeedOrder::Newest, FeedOrder::Oldest] {
                let from_members = pages(CollectionRead::FromMembers, tag, order);
                assert!(from_members.len() > 1, "{tag}: one page tells nothing about the next");
                assert_eq!(from_members, pages(CollectionRead::AlongTheFeed, tag, order), "{tag} {order:?}");
            }
        }
        // The way with the smaller worst case: a page visits at most half of
        // the space's cards.
        assert_eq!(CollectionRead::for_sizes(150, 15_000), CollectionRead::FromMembers);
        assert_eq!(CollectionRead::for_sizes(15_000, 15_000), CollectionRead::FromMembers);
        assert_eq!(CollectionRead::for_sizes(15_001, 15_000), CollectionRead::AlongTheFeed);
        // The test space: 12 cards, Alpha and Beta hold 6 each, half of it.
        assert_eq!(
            CollectionRead::with_the_smaller_worst_case(&conn, "Alpha", 12).unwrap(),
            CollectionRead::FromMembers
        );
        // A seventh card joins Alpha: more than half of the space.
        put(&conn, &card("Card-1-B", "2026-03-01T10:00:00Z", &["Alpha"], Some("Grace")));
        assert_eq!(
            CollectionRead::with_the_smaller_worst_case(&conn, "Alpha", 12).unwrap(),
            CollectionRead::AlongTheFeed
        );
        assert_eq!(
            CollectionRead::with_the_smaller_worst_case(&conn, "Beta", 12).unwrap(),
            CollectionRead::FromMembers
        );
        // The feed reads the larger collection the other way and shows the
        // same cards.
        let alpha = TabLocation::Collection { tag: "Alpha".into() };
        let shown = full_read(&conn, &alpha, FeedOrder::Newest, EVERY_CARD).cards;
        assert_eq!(shown.len(), 7);
        assert_eq!(
            vec![shown],
            pages_of(&conn, CollectionRead::FromMembers, "Alpha", FeedOrder::Newest, EVERY_CARD)
        );
    }

    /// The cards named right after the page's last kept card stay in the list
    /// rather than leaving until the next page.
    #[test]
    fn named_cards_at_the_end_of_the_list_stay() {
        let conn = space();
        let location = TabLocation::Everything;
        let page = full_read(&conn, &location, FeedOrder::Newest, 4);
        let last = page.cards.last().unwrap().clone();
        put(&conn, &card(&last.slug, &last.saved_at, &["Alpha", "Beta"], Some("Ada")));
        let patched = partial_read(&conn, &location, FeedOrder::Newest, &page, &[last.id]).unwrap();
        assert_eq!(patched.cards.len(), 4);
        assert_eq!(patched.cards[3].id, last.id);
        assert!(patched.has_more);
    }

    /// The page's last card left the feed by a change the page has not heard
    /// of: the range cannot be told, and the page reads in full.
    #[test]
    fn a_missing_last_card_loses_the_range() {
        let conn = space();
        let location = TabLocation::Collection { tag: "Alpha".into() };
        let page = full_read(&conn, &location, FeedOrder::Newest, 3);
        let end = page.cards.last().unwrap().id;
        index::remove_block(&conn, &page.cards.last().unwrap().slug).unwrap();
        let named = [id_of(&conn, "card-6-a")];
        let patch = projection::read_feed_patch(
            &conn,
            "/space".into(),
            &location,
            FeedOrder::Newest,
            &named,
            Some(end),
        )
        .unwrap();
        assert!(patch.range_lost);
        assert!(patch.rows.is_empty());
    }

    /// A named card that is gone, or never was, is in no answer.
    #[test]
    fn cards_that_are_not_there_are_not_answered() {
        let conn = space();
        let patch = projection::read_feed_patch(
            &conn,
            "/space".into(),
            &TabLocation::Everything,
            FeedOrder::Newest,
            &[9_999, id_of(&conn, "card-2-a")],
            None,
        )
        .unwrap();
        assert_eq!(patch.rows.len(), 1);
        assert_eq!(patch.rows[0].block.slug, "card-2-a");
        assert!(!patch.has_more);
        assert_eq!(patch.total_blocks, 12);
        assert!(projection::read_feed_patch(
            &conn,
            "/space".into(),
            &TabLocation::Everything,
            FeedOrder::Newest,
            &[],
            None
        )
        .unwrap()
        .rows
        .is_empty());
    }
}
