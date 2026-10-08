//! Card associations in the index: the derived columns of every card, the
//! author an extracted card inherits, and the groups the open card shows.
//!
//! Nothing here touches a note: the columns are derived from the indexed
//! card and rebuilt with the index. Rows change only through
//! `storage::index` (`upsert_block_inner`, `remove_block`, `rename_slug`),
//! which call [`write_row_keys`] and [`refresh_inherited_authors`] inside
//! their own savepoint.
//!
//! Contract: SPEC_CARD_ASSOCIATIONS.md

use std::collections::{HashSet, VecDeque};

use anyhow::{Context, Result};
use mine_core::links::{note_name_key, obsidian_target_name_keys, LinkIndex, LinkResolution, LinkSyntax};
use rusqlite::{params, types::Value, Connection, OptionalExtension};
use serde::Serialize;

use crate::domain::block::{parse_markdown_document, Block, DateTime};
use crate::domain::card_association::{
    address_key, author_key, author_label, card_association_keys, extraction_source_name,
    is_extracted_card, site_key,
};
use crate::domain::vault::VaultLayout;
use crate::storage::block_queries::{grid_row_columns_sql, light_block_from_row, FeedOrder};
use crate::storage::index::{parse_related_notes_json, LightBlock, LIGHT_BLOCK_BODY_PREVIEW_CHARS};
use crate::storage::projection::{read_projection_snapshot, ProjectionRevision};

/// Version of the association rules the columns were derived by. Raise it
/// with every change to normalization, the platform list or inheritance:
/// [`backfill_association_index`] derives older rows again.
pub const ASSOCIATION_INDEX_VERSION: i64 = 1;
/// Rows a group of the open card shows: all of them up to the search's bound.
/// Past it the newest stay; the author's others are in the author's feed.
pub const CARD_ASSOCIATION_MAX_ROWS: usize = 200;
/// Steps an inherited author is followed back through extracted cards.
pub const ASSOCIATION_SOURCE_CHAIN_MAX_STEPS: usize = 8;
/// The order of the open card's association groups, top to bottom. A card is
/// shown once, in the first group it belongs to.
pub const CARD_ASSOCIATION_ORDER: [CardAssociationKind; 3] = [
    CardAssociationKind::Address,
    CardAssociationKind::Author,
    CardAssociationKind::Site,
];

const CHANNEL_CARD_KIND: &str = "channel";

/// One rule relating two cards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CardAssociationKind {
    Address,
    Author,
    Site,
}

/// The cards related to the open card by one rule.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct CardAssociationGroup {
    pub kind: CardAssociationKind,
    /// The author as written on the open card (own or inherited), the site,
    /// or the address key.
    pub label: String,
    /// Cards of the group after every exclusion, newest first: all of them,
    /// at most [`CARD_ASSOCIATION_MAX_ROWS`].
    pub blocks: Vec<LightBlock>,
}

/// The open card's association groups under one projection revision.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct CardAssociations {
    pub generation: ProjectionRevision,
    pub slug: String,
    /// In [`CARD_ASSOCIATION_ORDER`]; a group with no cards is left out.
    pub groups: Vec<CardAssociationGroup>,
}

/// The association author of one row, before and after a write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthorChange {
    pub before: Option<String>,
    pub after: Option<String>,
}

impl AuthorChange {
    /// Whether the cards extracted from this one may inherit another author.
    pub fn changed(&self) -> bool {
        self.before != self.after
    }
}

/// Write the association columns of the row `block_id` from its card, then
/// its association author (own, or inherited along its sources).
pub(crate) fn write_row_keys(conn: &Connection, block_id: i64, block: &Block) -> Result<AuthorChange> {
    let keys = card_association_keys(block);
    let before = association_author_of(conn, block_id)?;
    conn.execute(
        "UPDATE blocks
            SET note_name = ?2,
                extraction_source_name = ?3,
                association_site = ?4,
                association_address = ?5,
                association_index_version = ?6
          WHERE id = ?1",
        params![
            block_id,
            keys.note_name,
            keys.extraction_source_name,
            keys.site,
            keys.address,
            ASSOCIATION_INDEX_VERSION,
        ],
    )
    .context("failed to write card association keys")?;
    let after = write_association_author(conn, block_id)?;
    Ok(AuthorChange { before, after })
}

/// Recompute the inherited author of every extracted card without its own
/// author whose source may be one of the notes named `names`, and of the
/// cards extracted from those whose author changed. Returns the rows written.
pub(crate) fn refresh_inherited_authors(conn: &Connection, names: &[String]) -> Result<usize> {
    let mut queue: VecDeque<String> = names.iter().cloned().collect();
    let mut seen_names = HashSet::new();
    let mut visited = HashSet::new();
    let mut written = 0;
    while let Some(name) = queue.pop_front() {
        if !seen_names.insert(name.clone()) {
            continue;
        }
        for (id, own_author, note_name) in cards_extracted_from(conn, &name)? {
            if own_author.as_deref().and_then(author_label).is_some() || !visited.insert(id) {
                continue;
            }
            let before = association_author_of(conn, id)?;
            let after = write_association_author(conn, id)?;
            if before != after {
                written += 1;
                if let Some(note_name) = note_name {
                    queue.push_back(note_name);
                }
            }
        }
    }
    Ok(written)
}

/// The `note_name` column of `slug`, read before a row goes or moves.
pub(crate) fn note_name_of(conn: &Connection, slug: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT note_name FROM blocks WHERE slug = ?1", [slug], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()
        .context("failed to read note name")?
        .flatten())
}

/// Give a renamed row the name of its new path.
pub(crate) fn write_note_name(conn: &Connection, slug: &str) -> Result<Option<String>> {
    let name = note_name_key(slug);
    conn.execute(
        "UPDATE blocks SET note_name = ?2 WHERE slug = ?1",
        params![slug, name],
    )
    .context("failed to write note name")?;
    Ok(name)
}

/// Derive the association columns of rows indexed by older rules, then the
/// author of every derived row and of every extracted card. Idempotent:
/// a second run finds nothing to do. Returns the rows derived.
///
/// The index holds everything except `Mine Source Media`, so a note is read
/// only when its card links a related note without naming an extraction in
/// `source`; a note that cannot be read keeps its older version and is tried
/// again on the next pass.
pub fn backfill_association_index(conn: &Connection, vault: &VaultLayout) -> Result<usize> {
    struct Pending {
        id: i64,
        slug: String,
        card_kind: String,
        url: Option<String>,
        source: Option<String>,
        related_notes: Vec<String>,
    }
    let pending = {
        let mut stmt = conn.prepare(
            "SELECT id, slug, card_kind, url, source, related_notes
               FROM blocks
              WHERE association_index_version IS NULL OR association_index_version < ?1",
        )?;
        let rows = stmt.query_map([ASSOCIATION_INDEX_VERSION], |row| {
            Ok(Pending {
                id: row.get(0)?,
                slug: row.get(1)?,
                card_kind: row.get(2)?,
                url: row.get(3)?,
                source: row.get(4)?,
                related_notes: parse_related_notes_json(row.get(5)?),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if pending.is_empty() {
        return Ok(0);
    }

    let fallback_saved_at = DateTime::new("1970-01-01T00:00:00Z")?;
    let tx = conn.unchecked_transaction()?;
    let mut derived = Vec::with_capacity(pending.len());
    for row in pending {
        let is_card = row.card_kind != CHANNEL_CARD_KIND;
        let first_related = row.related_notes.first();
        let extracted = if !is_card || first_related.is_none() {
            false
        } else if is_extracted_card(row.source.as_deref(), false) {
            true
        } else {
            match source_media_of(vault, &row.slug, &fallback_saved_at) {
                Some(has_source_media) => has_source_media,
                None => continue,
            }
        };
        let url = row.url.as_deref().filter(|_| is_card);
        tx.execute(
            "UPDATE blocks
                SET note_name = ?2,
                    extraction_source_name = ?3,
                    association_site = ?4,
                    association_address = ?5,
                    association_index_version = ?6
              WHERE id = ?1",
            params![
                row.id,
                note_name_key(&row.slug),
                first_related
                    .filter(|_| extracted)
                    .map(String::as_str)
                    .and_then(extraction_source_name),
                url.and_then(site_key),
                url.and_then(address_key),
                ASSOCIATION_INDEX_VERSION,
            ],
        )
        .with_context(|| format!("failed to derive association keys for {}", row.slug))?;
        derived.push(row.id);
    }

    // Every name is in place now, so sources resolve; extracted cards
    // indexed earlier are derived again in case their source was not.
    let extracted: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM blocks WHERE extraction_source_name IS NOT NULL")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut authored = HashSet::new();
    for id in derived.iter().chain(&extracted) {
        if authored.insert(*id) {
            write_association_author(&tx, *id)?;
        }
    }
    tx.commit().context("failed to commit association backfill")?;
    Ok(derived.len())
}

/// Read the open card's association groups under one projection snapshot.
pub fn read_card_associations(
    conn: &Connection,
    slug: &str,
    exclude_slugs: &[String],
) -> Result<CardAssociations> {
    read_projection_snapshot(conn, |conn, generation| {
        Ok(CardAssociations {
            generation,
            slug: slug.to_string(),
            groups: association_groups(conn, slug, exclude_slugs)?,
        })
    })
}

// ─── Inheritance ────────────────────────────────────────────────────────────

/// What following a source needs of a row.
struct ChainRow {
    id: i64,
    slug: String,
    card_kind: String,
    author: Option<String>,
    related_notes: Option<String>,
    extraction_source_name: Option<String>,
}

const CHAIN_ROW_COLUMNS: &str =
    "id, slug, card_kind, author, related_notes, extraction_source_name";

fn chain_row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChainRow> {
    Ok(ChainRow {
        id: row.get(0)?,
        slug: row.get(1)?,
        card_kind: row.get(2)?,
        author: row.get(3)?,
        related_notes: row.get(4)?,
        extraction_source_name: row.get(5)?,
    })
}

fn association_author_of(conn: &Connection, block_id: i64) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT association_author FROM blocks WHERE id = ?1",
            [block_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .context("failed to read association author")?
        .flatten())
}

/// Write the association author of `block_id` and return it.
fn write_association_author(conn: &Connection, block_id: i64) -> Result<Option<String>> {
    let row = conn
        .query_row(
            &format!("SELECT {CHAIN_ROW_COLUMNS} FROM blocks WHERE id = ?1"),
            [block_id],
            chain_row_from,
        )
        .optional()
        .context("failed to read a card for its association author")?;
    let author = match row {
        Some(row) => association_author(conn, row)?,
        None => None,
    };
    conn.execute(
        "UPDATE blocks SET association_author = ?2, association_author_key = ?3
          WHERE id = ?1
            AND (association_author IS NOT ?2 OR association_author_key IS NOT ?3)",
        params![block_id, author, author.as_deref().and_then(author_key)],
    )
    .context("failed to write association author")?;
    Ok(author)
}

/// The author of a card for associations: its own, else the first own author
/// along its sources, at most [`ASSOCIATION_SOURCE_CHAIN_MAX_STEPS`] away.
/// The chain is walked every time instead of reading a source's stored
/// inherited author: a stored value could survive a cycle that removed it.
fn association_author(conn: &Connection, start: ChainRow) -> Result<Option<String>> {
    if start.card_kind == CHANNEL_CARD_KIND {
        return Ok(None);
    }
    let mut visited = HashSet::new();
    let mut current = start;
    let mut steps = 0;
    loop {
        if let Some(label) = current.author.as_deref().and_then(author_label) {
            return Ok(Some(label));
        }
        if current.extraction_source_name.is_none()
            || steps == ASSOCIATION_SOURCE_CHAIN_MAX_STEPS
            || !visited.insert(current.id)
        {
            return Ok(None);
        }
        let Some(source) = resolve_source(conn, &current)? else {
            return Ok(None);
        };
        steps += 1;
        current = source;
    }
}

/// The card `row` was extracted from: its first related note, resolved by
/// Obsidian rules among the notes the link can name (equal to resolving among
/// every note, `links::obsidian_target_name_keys`). Missing, ambiguous, the
/// card itself or a collection is no source.
fn resolve_source(conn: &Connection, row: &ChainRow) -> Result<Option<ChainRow>> {
    let Some(target) = parse_related_notes_json(row.related_notes.clone()).into_iter().next() else {
        return Ok(None);
    };
    let names = obsidian_target_name_keys(&target);
    if names.is_empty() {
        return Ok(None);
    }
    let candidates = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {CHAIN_ROW_COLUMNS} FROM blocks
              WHERE note_name IN (SELECT value FROM json_each(?1))"
        ))?;
        let rows = stmt.query_map([serde_json::to_string(&names)?], chain_row_from)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let index = LinkIndex::new(candidates.iter().map(|candidate| format!("{}.md", candidate.slug)));
    let LinkResolution::Resolved(path) =
        index.resolve(&format!("{}.md", row.slug), &target, LinkSyntax::Obsidian)
    else {
        return Ok(None);
    };
    Ok(candidates.into_iter().find(|candidate| {
        format!("{}.md", candidate.slug) == path
            && candidate.id != row.id
            && candidate.card_kind != CHANNEL_CARD_KIND
    }))
}

/// An extracted card found by its source name: its id, own author and name.
type ExtractedCard = (i64, Option<String>, Option<String>);

/// Extracted cards whose source link may name the note `name`.
fn cards_extracted_from(conn: &Connection, name: &str) -> Result<Vec<ExtractedCard>> {
    // A link names the note `name` by its stem, or names a note called
    // `name` without its `.md` when the name itself ends in `.md`.
    let mut names = vec![name.to_string()];
    if let Some(stem) = name.strip_suffix(".md").filter(|stem| !stem.is_empty()) {
        names.push(stem.to_string());
    }
    let mut stmt = conn.prepare(
        "SELECT id, author, note_name FROM blocks
          WHERE extraction_source_name IN (SELECT value FROM json_each(?1))
            AND card_kind != 'channel'",
    )?;
    let rows = stmt.query_map([serde_json::to_string(&names)?], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Whether the note of `slug` carries `Mine Source Media`, or `None` when it
/// cannot be read now.
fn source_media_of(vault: &VaultLayout, slug: &str, fallback_saved_at: &DateTime) -> Option<bool> {
    let path = vault.block_path(slug);
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            log::warn!("association backfill: failed to read {}: {error}", path.display());
            return None;
        }
    };
    match parse_markdown_document(slug, &content, fallback_saved_at.clone()) {
        Ok(parsed) => Some(parsed.block.frontmatter.source_media.is_some()),
        Err(error) => {
            log::warn!("association backfill: failed to parse {}: {error}", path.display());
            None
        }
    }
}

// ─── Reading ────────────────────────────────────────────────────────────────

/// The open card's own keys.
struct OpenCard {
    id: i64,
    card_kind: String,
    author: Option<String>,
    author_key: Option<String>,
    site: Option<String>,
    address: Option<String>,
}

/// One group the open card belongs to: which rows it holds and how to leave
/// them out of later groups.
struct GroupRule {
    kind: CardAssociationKind,
    label: String,
    value: String,
}

impl GroupRule {
    /// Rows of this group; `?{n}` is its value.
    fn member_sql(&self, n: usize) -> String {
        match self.kind {
            CardAssociationKind::Address => format!("b.association_address = ?{n}"),
            CardAssociationKind::Author => format!("b.association_author_key = ?{n}"),
            CardAssociationKind::Site => {
                format!("b.association_site = ?{n} AND b.association_author_key IS NULL")
            }
        }
    }

    /// Rows outside this group, `NULL`-safe.
    fn outside_sql(&self, n: usize) -> String {
        match self.kind {
            CardAssociationKind::Address => format!("b.association_address IS NOT ?{n}"),
            CardAssociationKind::Author => format!("b.association_author_key IS NOT ?{n}"),
            CardAssociationKind::Site => {
                format!("NOT (b.association_site IS ?{n} AND b.association_author_key IS NULL)")
            }
        }
    }
}

/// The query of one group and its values: the group's rows outside every
/// earlier group, newest first.
/// `?1` body preview length, `?2` open card id, `?3` excluded slugs as JSON,
/// `?4` row limit, `?5` this group's value, `?6` on earlier groups' values.
fn group_query(
    rule: &GroupRule,
    earlier: &[GroupRule],
    open_id: i64,
    exclude: &str,
) -> Result<(String, Vec<Value>)> {
    let mut conditions = vec![rule.member_sql(5)];
    let mut values: Vec<Value> = vec![
        Value::Integer(LIGHT_BLOCK_BODY_PREVIEW_CHARS),
        Value::Integer(open_id),
        Value::Text(exclude.to_string()),
        Value::Integer(i64::try_from(CARD_ASSOCIATION_MAX_ROWS)?),
        Value::Text(rule.value.clone()),
    ];
    for group in earlier {
        values.push(Value::Text(group.value.clone()));
        conditions.push(group.outside_sql(values.len()));
    }
    let sql = format!(
        "SELECT {columns}
           FROM blocks b
          WHERE b.card_kind != 'channel'
            AND b.id != ?2
            AND b.slug NOT IN (SELECT value FROM json_each(?3))
            AND {conditions}
          ORDER BY {order}
          LIMIT ?4",
        columns = grid_row_columns_sql("b"),
        conditions = conditions.join(" AND "),
        order = FeedOrder::Newest.order_by("b."),
    );
    Ok((sql, values))
}

fn association_groups(
    conn: &Connection,
    slug: &str,
    exclude_slugs: &[String],
) -> Result<Vec<CardAssociationGroup>> {
    let open = conn
        .query_row(
            "SELECT id, card_kind, association_author, association_author_key,
                    association_site, association_address
               FROM blocks WHERE slug = ?1",
            [slug],
            |row| {
                Ok(OpenCard {
                    id: row.get(0)?,
                    card_kind: row.get(1)?,
                    author: row.get(2)?,
                    author_key: row.get(3)?,
                    site: row.get(4)?,
                    address: row.get(5)?,
                })
            },
        )
        .optional()
        .context("failed to read the open card's association keys")?;
    let Some(open) = open else {
        return Ok(Vec::new());
    };
    if open.card_kind == CHANNEL_CARD_KIND {
        return Ok(Vec::new());
    }

    let rules: Vec<GroupRule> = CARD_ASSOCIATION_ORDER
        .iter()
        .filter_map(|kind| match kind {
            CardAssociationKind::Address => open.address.clone().map(|address| GroupRule {
                kind: *kind,
                label: address.clone(),
                value: address,
            }),
            CardAssociationKind::Author => open.author_key.clone().map(|key| GroupRule {
                kind: *kind,
                label: open.author.clone().unwrap_or_else(|| key.clone()),
                value: key,
            }),
            // Symmetric: only a card without an author has a site group.
            CardAssociationKind::Site => match (&open.author_key, &open.site) {
                (None, Some(site)) => Some(GroupRule {
                    kind: *kind,
                    label: site.clone(),
                    value: site.clone(),
                }),
                _ => None,
            },
        })
        .collect();

    let exclude = serde_json::to_string(exclude_slugs)?;
    let mut groups = Vec::new();
    for (position, rule) in rules.iter().enumerate() {
        let (sql, values) = group_query(rule, &rules[..position], open.id, &exclude)?;
        let mut stmt = conn.prepare(&sql)?;
        let blocks = stmt
            .query_map(rusqlite::params_from_iter(values), light_block_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .with_context(|| format!("failed to read the {:?} group of {slug}", rule.kind))?;
        if blocks.is_empty() {
            continue;
        }
        groups.push(CardAssociationGroup {
            kind: rule.kind,
            label: rule.label.clone(),
            blocks,
        });
    }
    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{BlockType, Frontmatter};
    use crate::domain::card_association::INLINE_MEDIA_EXTRACTION_SOURCE;
    use crate::domain::windows::TabLocation;
    use crate::storage::block_queries::{author_feed_sql, list_grid_blocks_in_order};
    use crate::storage::projection::current_generation;
    use crate::storage::{db, index};

    struct Card<'a> {
        slug: &'a str,
        author: Option<&'a str>,
        url: Option<&'a str>,
        saved_at: &'a str,
        source_link: Option<&'a str>,
        kind: BlockType,
    }

    impl<'a> Card<'a> {
        fn new(slug: &'a str) -> Self {
            Card {
                slug,
                author: None,
                url: None,
                saved_at: "2026-01-01T00:00:00Z",
                source_link: None,
                kind: BlockType::Article,
            }
        }
        fn author(mut self, author: &'a str) -> Self {
            self.author = Some(author);
            self
        }
        fn url(mut self, url: &'a str) -> Self {
            self.url = Some(url);
            self
        }
        fn at(mut self, saved_at: &'a str) -> Self {
            self.saved_at = saved_at;
            self
        }
        /// Extracted from the note `link` names.
        fn from(mut self, link: &'a str) -> Self {
            self.source_link = Some(link);
            self
        }
        fn collection(mut self) -> Self {
            self.kind = BlockType::Channel;
            self
        }
        fn block(&self) -> Block {
            Block {
                slug: self.slug.to_string(),
                frontmatter: Frontmatter {
                    block_type: self.kind,
                    title: None,
                    description: None,
                    url: self.url.map(str::to_string),
                    file: None,
                    thumbnail: None,
                    tags: Vec::new(),
                    related_notes: self.source_link.map(str::to_string).into_iter().collect(),
                    source_media: None,
                    saved_at: DateTime::new(self.saved_at).unwrap(),
                    source: self
                        .source_link
                        .map(|_| INLINE_MEDIA_EXTRACTION_SOURCE.to_string()),
                    width: None,
                    height: None,
                    author: self.author.map(str::to_string),
                    position: None,
                    color: None,
                    icon: None,
                },
                body: "text".to_string(),
            }
        }
        fn write(self, conn: &Connection) {
            index::upsert_block(conn, &self.block(), None).unwrap();
        }
    }

    type GroupView = (CardAssociationKind, String, Vec<String>);

    fn author_of(conn: &Connection, slug: &str) -> Option<String> {
        conn.query_row(
            "SELECT association_author FROM blocks WHERE slug = ?1",
            [slug],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn groups(conn: &Connection, slug: &str) -> Vec<GroupView> {
        groups_with(conn, slug, &[])
    }

    fn groups_with(conn: &Connection, slug: &str, exclude: &[&str]) -> Vec<GroupView> {
        let exclude: Vec<String> = exclude.iter().map(|slug| slug.to_string()).collect();
        read_card_associations(conn, slug, &exclude)
            .unwrap()
            .groups
            .into_iter()
            .map(|group| {
                (
                    group.kind,
                    group.label,
                    group.blocks.into_iter().map(|block| block.slug).collect(),
                )
            })
            .collect()
    }

    fn view(kind: CardAssociationKind, label: &str, slugs: &[&str]) -> GroupView {
        (
            kind,
            label.to_string(),
            slugs.iter().map(|slug| slug.to_string()).collect(),
        )
    }

    // ─── Keys and inheritance ───────────────────────────────────────────

    #[test]
    fn a_written_card_carries_its_keys() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Post")
            .author(" @Kotecinho ")
            .url("https://www.mek.gallery/item?utm_source=x")
            .write(&conn);
        type Row = (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
        );
        let row: Row = conn
            .query_row(
                "SELECT note_name, association_author, association_author_key, association_site,
                        association_address, association_index_version
                   FROM blocks WHERE slug = 'Cards/Post'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (
                Some("Post".into()),
                Some("@Kotecinho".into()),
                Some("@kotecinho".into()),
                Some("mek.gallery".into()),
                Some("https://mek.gallery/item".into()),
                Some(ASSOCIATION_INDEX_VERSION),
            )
        );
    }

    #[test]
    fn an_extracted_card_takes_the_author_of_its_source() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Notebook").author("@kotecinho").write(&conn);
        Card::new("Cards/Notebook (image 1)").from("Notebook").write(&conn);
        Card::new("Cards/Own").author("@someone").from("Notebook").write(&conn);

        assert_eq!(author_of(&conn, "Cards/Notebook (image 1)").as_deref(), Some("@kotecinho"));
        assert_eq!(author_of(&conn, "Cards/Own").as_deref(), Some("@someone"));
    }

    #[test]
    fn a_missing_ambiguous_or_own_source_gives_no_author() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Twin").author("@a").write(&conn);
        Card::new("Archive/Twin").author("@b").write(&conn);
        Card::new("Cards/From twin").from("Twin").write(&conn);
        Card::new("Cards/From nothing").from("Nothing").write(&conn);
        Card::new("Cards/Self").author("").from("Self").write(&conn);
        Card::new("Collections/Ideas").author("@c").collection().write(&conn);
        Card::new("Cards/From collection").from("Ideas").write(&conn);

        for slug in ["Cards/From twin", "Cards/From nothing", "Cards/Self", "Cards/From collection"] {
            assert_eq!(author_of(&conn, slug), None, "{slug}");
        }
    }

    #[test]
    fn a_chain_of_extractions_reaches_the_first_own_author() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Root").author("@root").write(&conn);
        Card::new("Cards/Middle").from("Root").write(&conn);
        Card::new("Cards/Leaf").from("Middle").write(&conn);
        assert_eq!(author_of(&conn, "Cards/Leaf").as_deref(), Some("@root"));
    }

    #[test]
    fn a_chain_longer_than_the_limit_gives_no_author() {
        let conn = db::open_memory().unwrap();
        let steps = ASSOCIATION_SOURCE_CHAIN_MAX_STEPS + 1;
        let slugs: Vec<String> = (0..=steps).map(|step| format!("Cards/c{step}")).collect();
        let links: Vec<String> = (0..=steps).map(|step| format!("c{step}")).collect();
        Card::new(&slugs[0]).author("@root").write(&conn);
        for step in 1..=steps {
            Card::new(&slugs[step]).from(&links[step - 1]).write(&conn);
        }
        assert_eq!(
            author_of(&conn, &slugs[ASSOCIATION_SOURCE_CHAIN_MAX_STEPS]).as_deref(),
            Some("@root")
        );
        assert_eq!(author_of(&conn, &slugs[steps]), None);
    }

    #[test]
    fn an_author_removed_inside_a_cycle_does_not_stay() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/A").author("@x").from("B").write(&conn);
        Card::new("Cards/B").from("A").write(&conn);
        assert_eq!(author_of(&conn, "Cards/B").as_deref(), Some("@x"));

        Card::new("Cards/A").from("B").write(&conn);
        assert_eq!(author_of(&conn, "Cards/A"), None);
        assert_eq!(author_of(&conn, "Cards/B"), None);
    }

    #[test]
    fn a_new_author_of_the_source_reaches_every_card_extracted_from_it() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Root").author("@old").write(&conn);
        Card::new("Cards/Middle").from("Root").write(&conn);
        Card::new("Cards/Leaf").from("Middle").write(&conn);

        Card::new("Cards/Root").author("@New").write(&conn);
        assert_eq!(author_of(&conn, "Cards/Middle").as_deref(), Some("@New"));
        assert_eq!(author_of(&conn, "Cards/Leaf").as_deref(), Some("@New"));

        Card::new("Cards/Root").write(&conn);
        assert_eq!(author_of(&conn, "Cards/Leaf"), None);
    }

    #[test]
    fn a_source_written_after_its_extraction_still_gives_its_author() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Piece").from("Source").write(&conn);
        assert_eq!(author_of(&conn, "Cards/Piece"), None);
        Card::new("Cards/Source").author("@late").write(&conn);
        assert_eq!(author_of(&conn, "Cards/Piece").as_deref(), Some("@late"));
    }

    #[test]
    fn deleting_a_source_clears_or_moves_the_inherited_author() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Source").author("@a").write(&conn);
        Card::new("Cards/Piece").from("Source").write(&conn);
        index::remove_block(&conn, "Cards/Source").unwrap();
        assert_eq!(author_of(&conn, "Cards/Piece"), None);

        // Two notes named alike: the bare link is ambiguous until one goes.
        Card::new("Cards/Twin").author("@kept").write(&conn);
        Card::new("Archive/Twin").author("@gone").write(&conn);
        Card::new("Cards/From twin").from("Twin").write(&conn);
        assert_eq!(author_of(&conn, "Cards/From twin"), None);
        index::remove_block(&conn, "Archive/Twin").unwrap();
        assert_eq!(author_of(&conn, "Cards/From twin").as_deref(), Some("@kept"));
    }

    #[test]
    fn a_new_note_of_the_same_name_makes_the_source_ambiguous() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Source").author("@a").write(&conn);
        Card::new("Cards/Piece").from("Source").write(&conn);
        Card::new("Archive/Source").author("@b").write(&conn);
        assert_eq!(author_of(&conn, "Cards/Piece"), None);
    }

    #[test]
    fn renaming_a_source_follows_its_links() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Source").author("@a").write(&conn);
        Card::new("Cards/Piece").from("Source").write(&conn);

        index::rename_slug(&conn, "Cards/Source", "Cards/Renamed").unwrap();
        assert_eq!(author_of(&conn, "Cards/Piece"), None);
        // The in-app rename rewrites the link; the rewritten card follows.
        Card::new("Cards/Piece").from("Renamed").write(&conn);
        assert_eq!(author_of(&conn, "Cards/Piece").as_deref(), Some("@a"));

        // A note taking the old name back becomes the source again.
        Card::new("Cards/Other").from("Source").write(&conn);
        assert_eq!(author_of(&conn, "Cards/Other"), None);
        index::rename_slug(&conn, "Cards/Renamed", "Cards/Source").unwrap();
        assert_eq!(author_of(&conn, "Cards/Other").as_deref(), Some("@a"));
    }

    #[test]
    fn an_inherited_author_written_alone_advances_the_projection() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Source").author("@a").write(&conn);
        Card::new("Cards/Piece").from("Source").write(&conn);
        conn.execute("UPDATE blocks SET author = '@b' WHERE slug = 'Cards/Source'", [])
            .unwrap();
        let before = current_generation(&conn).unwrap();
        assert_eq!(refresh_inherited_authors(&conn, &["Source".to_string()]).unwrap(), 1);
        assert!(current_generation(&conn).unwrap() > before);
        assert_eq!(author_of(&conn, "Cards/Piece").as_deref(), Some("@b"));
    }

    #[test]
    fn the_backfill_derives_older_rows_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let vault =
            VaultLayout::with_derived_root(dir.path().join("vault"), dir.path().join("derived"));
        std::fs::create_dir_all(vault.root().join("Cards")).unwrap();
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Source").author("@a").url("https://www.a.com/x#top").write(&conn);
        // A media card made from an open card: `source` is empty, only the
        // note's `Mine Source Media` says it was extracted.
        let mut media_card = Card::new("Cards/Photo").block();
        media_card.frontmatter.related_notes = vec!["Source".into()];
        index::upsert_block(&conn, &media_card, None).unwrap();
        std::fs::write(
            vault.block_path("Cards/Photo"),
            "---\nMine Related Notes:\n  - \"[[Source]]\"\nMine Source Media: \"[[photo.jpg]]\"\nsaved_at: 2026-01-01T00:00:00Z\n---\n",
        )
        .unwrap();
        conn.execute_batch(
            "UPDATE blocks SET note_name = NULL, extraction_source_name = NULL,
                    association_author = NULL, association_author_key = NULL,
                    association_site = NULL, association_address = NULL,
                    association_index_version = NULL",
        )
        .unwrap();

        assert_eq!(backfill_association_index(&conn, &vault).unwrap(), 2);
        assert_eq!(author_of(&conn, "Cards/Photo").as_deref(), Some("@a"));
        let address: Option<String> = conn
            .query_row(
                "SELECT association_address FROM blocks WHERE slug = 'Cards/Source'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(address.as_deref(), Some("https://a.com/x"));
        assert_eq!(backfill_association_index(&conn, &vault).unwrap(), 0);
    }

    // ─── Groups of the open card ────────────────────────────────────────

    #[test]
    fn the_open_card_sees_the_same_address_then_the_same_author() {
        let conn = db::open_memory().unwrap();
        let post = "https://x.com/kotecinho/status/1";
        let fragment = format!("{post}#m");
        Card::new("Cards/Open").author("@kotecinho").url(post).at("2026-01-05T00:00:00Z").write(&conn);
        Card::new("Cards/Piece").author("@Kotecinho").url(&fragment).at("2026-01-04T00:00:00Z").write(&conn);
        Card::new("Cards/Other post")
            .author("@kotecinho")
            .url("https://x.com/kotecinho/status/2")
            .at("2026-01-03T00:00:00Z")
            .write(&conn);
        Card::new("Cards/No address").author("@kotecinho").at("2026-01-02T00:00:00Z").write(&conn);
        Card::new("Cards/Stranger").author("@other").url("https://x.com/other/status/3").write(&conn);

        assert_eq!(
            groups(&conn, "Cards/Open"),
            vec![
                view(CardAssociationKind::Address, post, &["Cards/Piece"]),
                view(CardAssociationKind::Author, "@kotecinho", &["Cards/Other post", "Cards/No address"]),
            ]
        );
        // Without an address the author group keeps cards without one.
        assert_eq!(
            groups(&conn, "Cards/No address"),
            vec![view(
                CardAssociationKind::Author,
                "@kotecinho",
                &["Cards/Open", "Cards/Piece", "Cards/Other post"],
            )]
        );
    }

    #[test]
    fn related_notes_the_card_itself_and_collections_stay_out() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Open").author("@a").write(&conn);
        Card::new("Cards/Related").author("@a").write(&conn);
        Card::new("Cards/Kept").author("@a").write(&conn);
        Card::new("Collections/A").author("@a").collection().write(&conn);
        assert_eq!(
            groups_with(&conn, "Cards/Open", &["Cards/Related"]),
            vec![view(CardAssociationKind::Author, "@a", &["Cards/Kept"])]
        );
    }

    #[test]
    fn a_site_groups_only_cards_without_an_author() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Open").url("https://www.niklasrosen.se/a").write(&conn);
        Card::new("Cards/Page").url("https://niklasrosen.se/b").write(&conn);
        Card::new("Cards/Authored").author("@niklas").url("https://niklasrosen.se/c").write(&conn);
        Card::new("Cards/Same").url("https://niklasrosen.se/a#x").write(&conn);
        Card::new("Cards/Platform").url("https://x.com/a").write(&conn);
        Card::new("Cards/Platform 2").url("https://x.com/b").write(&conn);

        assert_eq!(
            groups(&conn, "Cards/Open"),
            vec![
                view(CardAssociationKind::Address, "https://niklasrosen.se/a", &["Cards/Same"]),
                view(CardAssociationKind::Site, "niklasrosen.se", &["Cards/Page"]),
            ]
        );
        assert!(groups(&conn, "Cards/Authored").is_empty());
        assert!(groups(&conn, "Cards/Platform").is_empty());
    }

    #[test]
    fn a_group_shows_all_its_rows_newest_first_up_to_its_bound() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Open").url("https://door.link/").at("2026-02-01T00:00:00Z").write(&conn);
        let save = |step: usize| {
            let slug = format!("Cards/Save {step}");
            let date = format!("2026-01-01T{:02}:{:02}:00Z", step / 60, step % 60);
            Card::new(&slug).url("https://door.link").at(&date).write(&conn);
        };
        for step in 1..=8 {
            save(step);
        }
        assert_eq!(
            groups(&conn, "Cards/Open")[0].2,
            (1..=8).rev().map(|step| format!("Cards/Save {step}")).collect::<Vec<_>>()
        );

        // Past the bound the newest stay and the oldest is left out.
        for step in 9..=CARD_ASSOCIATION_MAX_ROWS + 1 {
            save(step);
        }
        let bounded = &groups(&conn, "Cards/Open")[0].2;
        assert_eq!(bounded.len(), CARD_ASSOCIATION_MAX_ROWS);
        assert_eq!(bounded[0], format!("Cards/Save {}", CARD_ASSOCIATION_MAX_ROWS + 1));
        assert_eq!(bounded[CARD_ASSOCIATION_MAX_ROWS - 1], "Cards/Save 2");
    }

    #[test]
    fn cards_without_keys_and_unknown_cards_have_no_groups() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/Bare").write(&conn);
        Card::new("Cards/Bare 2").write(&conn);
        assert!(groups(&conn, "Cards/Bare").is_empty());
        assert!(groups(&conn, "Cards/Unknown").is_empty());
    }

    // ─── The author's feed ──────────────────────────────────────────────

    #[test]
    fn the_author_feed_reads_every_card_of_the_author_in_feed_order() {
        let conn = db::open_memory().unwrap();
        Card::new("Cards/One").author("@Kotecinho").at("2026-01-01T00:00:00Z").write(&conn);
        Card::new("Cards/Two").author("@kotecinho").at("2026-01-02T00:00:00Z").write(&conn);
        Card::new("Cards/Piece").from("Two").at("2026-01-03T00:00:00Z").write(&conn);
        Card::new("Cards/Other").author("@other").write(&conn);
        let location = TabLocation::Author { author: "@KOTECINHO".into() };
        let slugs = |order, offset, limit| {
            let (blocks, has_more) =
                list_grid_blocks_in_order(&conn, &location, offset, limit, order).unwrap();
            (blocks.into_iter().map(|block| block.slug).collect::<Vec<_>>(), has_more)
        };
        assert_eq!(slugs(FeedOrder::Newest, 0, 10).0, ["Cards/Piece", "Cards/Two", "Cards/One"]);
        assert_eq!(
            slugs(FeedOrder::Oldest, 0, 2),
            (vec!["Cards/One".to_string(), "Cards/Two".to_string()], true)
        );
        let empty = TabLocation::Author { author: "  ".into() };
        assert!(list_grid_blocks_in_order(&conn, &empty, 0, 10, FeedOrder::Newest)
            .unwrap()
            .0
            .is_empty());
    }

    #[test]
    fn groups_and_the_author_feed_read_through_their_indexes() {
        let conn = db::open_memory().unwrap();
        for step in 0..50 {
            let slug = format!("Cards/Card {step}");
            let author = format!("@author{}", step % 5);
            let url = format!("https://site{}.com/page{}", step % 7, step % 11);
            Card::new(&slug).author(&author).url(&url).write(&conn);
        }
        let plan = |sql: &str| -> String {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let values = vec![Value::Null; stmt.parameter_count()];
            stmt.query_map(rusqlite::params_from_iter(values), |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
                .join("\n")
        };
        let feed = plan(&author_feed_sql(FeedOrder::Newest));
        assert!(feed.contains("idx_blocks_association_author"), "{feed}");

        let rule = |kind, value: &str| GroupRule { kind, label: value.into(), value: value.into() };
        let cases = [
            (rule(CardAssociationKind::Address, "x"), vec![], "idx_blocks_association_address"),
            (
                rule(CardAssociationKind::Author, "x"),
                vec![rule(CardAssociationKind::Address, "y")],
                "idx_blocks_association_author",
            ),
            (rule(CardAssociationKind::Site, "x"), vec![], "idx_blocks_association_site"),
        ];
        for (current, earlier, index) in cases {
            let (sql, _) = group_query(&current, &earlier, 1, "[]").unwrap();
            let group = plan(&sql);
            assert!(group.contains(index), "{group}");
            assert!(!group.lines().any(|line| line.trim() == "SCAN b"), "{group}");
        }
    }
}
