use anyhow::Result;
use rusqlite::{params, Connection};

use crate::domain::block::{Block, DateTime};
use crate::domain::channel::Channel;

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
            channel.tag,
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
    // By name, not by path: cards tag themselves `[[Каталоги]]`, so a channel
    // registered as `Collections/Каталоги` would never match any of them.
    let collection_ref = crate::domain::collection::collection_ref_from_slug(&block.slug);
    let mut channel = Channel::new(&collection_ref, block.frontmatter.saved_at.clone())
        .map_err(|error| anyhow::anyhow!("invalid channel from block: {error}"))?;
    channel.description = block.frontmatter.description.clone();
    channel.color = block.frontmatter.color.clone();
    channel.icon = block.frontmatter.icon.clone();
    channel.position = block.frontmatter.position.unwrap_or(0);

    upsert_channel(conn, &channel)
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
