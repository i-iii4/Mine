use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeSet;

use crate::domain::block::{parse_markdown_document, Block, BlockType, DateTime};
use crate::domain::channel::Channel;
use crate::domain::vault::VaultLayout;
use crate::storage::{files, media_refs};

pub fn upsert_channel(conn: &Connection, channel: &Channel) -> Result<i64> {
    upsert_channel_with_source(conn, channel, None)
}

/// Persist collection metadata and its exact source page when known.
pub fn upsert_channel_with_source(
    conn: &Connection,
    channel: &Channel,
    source_slug: Option<&str>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO channels (tag, source_slug, title, description, color, icon, position, created_at)
         VALUES (?1, ?2, ?1, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(tag) DO UPDATE SET
            source_slug = COALESCE(excluded.source_slug, channels.source_slug),
            title = excluded.title,
            description = excluded.description,
            color = excluded.color,
            icon = excluded.icon,
            position = excluded.position",
        params![
            channel.tag,
            source_slug,
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

pub fn upsert_channel_from_block(conn: &Connection, block: &Block) -> Result<i64> {
    let collection_ref = crate::domain::collection::collection_ref_from_slug(&block.slug);
    upsert_channel_from_block_with_ref(conn, block, &collection_ref)
}

/// Resolve the page's target against all same-named collection documents on
/// disk before indexing an individual watcher or command write.
pub fn upsert_channel_from_block_in_vault(
    conn: &Connection,
    vault: &VaultLayout,
    block: &Block,
) -> Result<i64> {
    let short = crate::domain::collection::collection_ref_from_slug(&block.slug);
    let candidates = media_refs::collection_document_candidates(vault, &short)?;
    let mut collection_slugs = BTreeSet::new();
    let mut pages = Vec::new();
    for path in candidates {
        let (slug, content) = files::read_block_file(vault, &path)?;
        let parsed = parse_markdown_document(&slug, &content, block.frontmatter.saved_at.clone())?;
        if parsed.block.frontmatter.block_type == BlockType::Channel {
            collection_slugs.insert(slug);
            pages.push(parsed.block);
        }
    }
    collection_slugs.insert(block.slug.clone());
    let collection_ref =
        crate::domain::collection::collection_ref_for_slug(&block.slug, &collection_slugs);
    if collection_slugs.len() > 1 {
        for page in &pages {
            if page.slug != block.slug {
                let sibling_ref = crate::domain::collection::collection_ref_for_slug(
                    &page.slug,
                    &collection_slugs,
                );
                upsert_channel_from_block_with_ref(conn, page, &sibling_ref)?;
            }
        }
        if !collection_slugs.contains(&short) {
            remove_channel(conn, &short)?;
        }
    }
    upsert_channel_from_block_with_ref(conn, block, &collection_ref)
}

/// Index a collection page under its resolved Obsidian target. The caller
/// supplies a path-qualified target when the filename is shared by two pages.
pub fn upsert_channel_from_block_with_ref(
    conn: &Connection,
    block: &Block,
    collection_ref: &str,
) -> Result<i64> {
    let mut channel = Channel::new(collection_ref, block.frontmatter.saved_at.clone())
        .map_err(|error| anyhow::anyhow!("invalid channel from block: {error}"))?;
    channel.description = block.frontmatter.description.clone();
    channel.color = block.frontmatter.color.clone();
    channel.icon = block.frontmatter.icon.clone();
    channel.position = block.frontmatter.position.unwrap_or(0);

    upsert_channel_with_source(conn, &channel, Some(&block.slug))
}

/// Exact collection document slug stored for a channel projection.
pub fn channel_source_slug(conn: &Connection, tag: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT source_slug FROM channels WHERE tag = ?1")?;
    let source = stmt.query_row([tag], |row| row.get(0)).optional()?;
    Ok(source.flatten())
}

pub fn list_channels(conn: &Connection) -> Result<Vec<Channel>> {
    let mut stmt = conn.prepare(
        "SELECT tag, description, color, icon, position, created_at
         FROM channels ORDER BY position ASC, tag ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut channels = Vec::new();
    for (raw_tag, description, color, icon, position, created_at) in rows {
        let date_time = DateTime::new(&created_at)
            .map_err(|error| anyhow::anyhow!("invalid datetime in channel: {error}"))?;
        let mut channel = Channel::new(&raw_tag, date_time)
            .map_err(|error| anyhow::anyhow!("invalid channel from db: {error}"))?;
        channel.description = description;
        channel.color = color;
        channel.icon = icon;
        channel.position = position as u32;
        channels.push(channel);
    }

    channels.sort_by(|left, right| {
        left.position
            .cmp(&right.position)
            .then_with(|| left.tag.cmp(&right.tag))
    });
    Ok(channels)
}

pub fn next_channel_position(conn: &Connection) -> Result<u32> {
    let max_position: Option<i64> =
        conn.query_row("SELECT MAX(position) FROM channels", [], |row| row.get(0))?;
    Ok(max_position
        .and_then(|value| u32::try_from(value).ok())
        .map_or(0, |value| value.saturating_add(1)))
}

pub fn update_channel_positions(conn: &Connection, positions: &[(String, u32)]) -> Result<()> {
    let transaction = conn.unchecked_transaction()?;
    {
        let mut statement =
            transaction.prepare("UPDATE channels SET position = ?1 WHERE tag = ?2")?;
        for (tag, position) in positions {
            statement.execute(params![*position as i64, tag])?;
        }
    }
    transaction.commit()?;
    Ok(())
}

/// Deletes channel rows whose collection is not backed by any live channel
/// document, returning the removed tags.
///
/// `live_refs` is the set of collection names derived from the channel
/// documents a reconciliation pass actually saw on disk. Anything else in the
/// table is a phantom — most often a row keyed by a folder-qualified slug from
/// before collections were identified by name. The per-file cleanup cannot
/// reach such rows: it fires when a file vanishes, and a row that never
/// matched any file outlives every vanishing.
pub fn sweep_channels_without_documents(
    conn: &Connection,
    live_refs: &std::collections::BTreeSet<String>,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM channels")?;
    let tags = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut swept = Vec::new();
    for tag in tags {
        if live_refs.contains(&tag) {
            continue;
        }
        conn.execute("DELETE FROM channels WHERE tag = ?1", [&tag])?;
        swept.push(tag);
    }
    Ok(swept)
}

pub fn remove_channel(conn: &Connection, tag: &str) -> Result<bool> {
    let count = conn.execute("DELETE FROM channels WHERE tag = ?1", [tag])?;
    Ok(count > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::parse_markdown_document;
    use crate::storage::db;

    #[test]
    fn path_qualified_collection_pages_keep_independent_rows() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let date = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let pages = [("A/Design", "First"), ("B/Design", "Second")];
        for (slug, description) in pages {
            let source = format!("---\ntype: channel\ndescription: {description}\nsaved_at: 2026-01-01T00:00:00Z\n---\n");
            let path = vault.block_path(slug);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &source).unwrap();
        }
        for (slug, description) in pages {
            let source = format!("---\ntype: channel\ndescription: {description}\nsaved_at: 2026-01-01T00:00:00Z\n---\n");
            let block = parse_markdown_document(slug, &source, date.clone())
                .unwrap()
                .block;
            upsert_channel_from_block_in_vault(&conn, &vault, &block).unwrap();
        }
        let channels = list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].tag, "A/Design");
        assert_eq!(channels[1].tag, "B/Design");
        assert_eq!(
            channel_source_slug(&conn, "A/Design").unwrap().as_deref(),
            Some("A/Design")
        );
        assert_eq!(
            channel_source_slug(&conn, "B/Design").unwrap().as_deref(),
            Some("B/Design")
        );
        assert_eq!(channels[0].description.as_deref(), Some("First"));
        assert_eq!(channels[1].description.as_deref(), Some("Second"));
    }

    #[test]
    fn adding_a_same_named_page_rekeys_the_existing_collection() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let date = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let source = "---\ntype: channel\nsaved_at: 2026-01-01T00:00:00Z\n---\n";
        let first = parse_markdown_document("A/Design", source, date.clone())
            .unwrap()
            .block;
        let second = parse_markdown_document("B/Design", source, date)
            .unwrap()
            .block;
        for block in [&first, &second] {
            let path = vault.block_path(&block.slug);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, source).unwrap();
            if block.slug == first.slug {
                upsert_channel_from_block_in_vault(&conn, &vault, block).unwrap();
                assert_eq!(list_channels(&conn).unwrap()[0].tag, "Design");
            }
        }
        upsert_channel_from_block_in_vault(&conn, &vault, &second).unwrap();
        let tags = list_channels(&conn)
            .unwrap()
            .into_iter()
            .map(|channel| channel.tag)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            tags,
            BTreeSet::from(["A/Design".to_string(), "B/Design".to_string()])
        );
    }
}
