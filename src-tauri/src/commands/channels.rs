// Channel commands: list, create, delete channels.
//
// Contract: SPEC_INTEGRATION.md#commands/channels

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::state::{AppState, CommandError};
use crate::domain::block::{parse_block, serialize_block, Block, BlockType, DateTime, Frontmatter};
use crate::domain::channel::Channel;
use crate::domain::tag::normalize_tag;
use crate::storage::{files, index};

// ─── Types ──────────────────────────────────────────────────────────────────

/// Serializable channel data for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ChannelDto {
    pub tag: String,
    pub title: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub position: u32,
    pub created_at: String,
    /// Number of blocks with this tag.
    pub block_count: usize,
}

impl ChannelDto {
    fn from_channel(channel: &Channel, block_count: usize) -> Self {
        Self {
            tag: channel.tag.clone(),
            title: channel.title.clone(),
            description: channel.description.clone(),
            color: channel.color.clone(),
            icon: channel.icon.clone(),
            position: channel.position,
            created_at: channel.created_at.as_str().to_string(),
            block_count,
        }
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all channels with block counts.
#[tauri::command]
pub fn list_channels(state: State<'_, AppState>) -> Result<Vec<ChannelDto>, CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let channels = index::list_channels(&vs.conn)?;
    let tags = index::get_all_tags(&vs.conn)?;
    let tag_counts: HashMap<String, usize> = tags
        .into_iter()
        .map(|tag| (tag.tag, tag.count))
        .collect();

    let dtos = channels
        .iter()
        .map(|ch| {
            let count = tag_counts.get(&ch.tag).copied().unwrap_or(0);
            ChannelDto::from_channel(ch, count)
        })
        .collect();

    Ok(dtos)
}

/// Create a channel from a tag. Title is auto-generated if not provided.
#[tauri::command]
pub fn create_channel(
    state: State<'_, AppState>,
    tag: String,
    title: Option<String>,
) -> Result<ChannelDto, CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let now = crate::commands::state::now_iso8601();
    let dt = DateTime::new(&now).map_err(|e| CommandError::Internal(e.to_string()))?;

    let channel = Channel::new(&tag, title.as_deref(), dt)
        .map_err(|e| CommandError::Internal(e.to_string()))?;

    // Check uniqueness after normalization
    let existing = index::list_channels(&vs.conn)?;
    if existing.iter().any(|c| c.tag == channel.tag) {
        return Err(CommandError::Internal(format!("channel '{}' already exists", channel.tag)));
    }

    // Write channel .md file (source of truth)
    let block = channel_to_block(&channel);
    files::write_block_file(&vs.vault, &block)?;

    // Index immediately (don't wait for watcher)
    index::upsert_channel(&vs.conn, &channel)?;

    // Get block count for this tag
    let tags = index::get_all_tags(&vs.conn)?;
    let count = tags
        .iter()
        .find(|t| t.tag == channel.tag)
        .map(|t| t.count)
        .unwrap_or(0);

    Ok(ChannelDto::from_channel(&channel, count))
}

/// A single item in a reorder request: tag + new position.
#[derive(Debug, Deserialize)]
pub struct ReorderItem {
    pub tag: String,
    pub position: u32,
}

/// Reorder channels by setting new positions for each tag.
/// Tags without channel entries are auto-created.
#[tauri::command]
pub fn reorder_channels(
    state: State<'_, AppState>,
    items: Vec<ReorderItem>,
) -> Result<(), CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    // Find tags that don't have channel entries yet
    let existing = index::list_channels(&vs.conn)?;
    let existing_tags: std::collections::HashSet<&str> =
        existing.iter().map(|c| c.tag.as_str()).collect();

    let now = crate::commands::state::now_iso8601();
    for item in &items {
        if !existing_tags.contains(item.tag.as_str()) {
            let dt = DateTime::new(&now)
                .map_err(|e| CommandError::Internal(e.to_string()))?;
            let channel = Channel::new(&item.tag, None, dt)
                .map_err(|e| CommandError::Internal(e.to_string()))?;
            // Write .md file for new channel
            let block = channel_to_block(&channel);
            files::write_block_file(&vs.vault, &block)?;
            index::upsert_channel(&vs.conn, &channel)?;
        }
    }

    let positions: Vec<(String, u32)> = items
        .into_iter()
        .map(|item| (item.tag, item.position))
        .collect();

    index::update_channel_positions(&vs.conn, &positions)?;

    // Update position in .md files
    for (tag, pos) in &positions {
        let md_path = vs.vault.block_path(tag);
        if md_path.exists() {
            if let Ok((slug, content)) = files::read_block_file(&md_path) {
                if let Ok(mut block) = parse_block(&slug, &content) {
                    if block.frontmatter.block_type == BlockType::Channel {
                        block.frontmatter.position = Some(*pos);
                        let serialized = serialize_block(&block);
                        let _ = std::fs::write(&md_path, serialized);
                    }
                }
            }
        }
    }

    Ok(())
}

/// Rename a channel: update the tag in all blocks' frontmatter files,
/// re-index them, and update the channel record in the database.
#[tauri::command(rename_all = "snake_case")]
pub fn rename_channel(
    state: State<'_, AppState>,
    old_tag: String,
    new_tag: String,
) -> Result<ChannelDto, CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let normalized_new = normalize_tag(&new_tag);
    if normalized_new.is_empty() {
        return Err(CommandError::Internal("new tag is empty after normalization".into()));
    }

    let normalized_old = normalize_tag(&old_tag);
    if normalized_old == normalized_new {
        // Same tag after normalization — no-op
        let channels = index::list_channels(&vs.conn)?;
        let existing = channels.iter().find(|c| c.tag == normalized_old)
            .ok_or_else(|| CommandError::Internal(format!("channel '{}' not found", old_tag)))?;

        let tags = index::get_all_tags(&vs.conn)?;
        let count = tags.iter().find(|t| t.tag == normalized_old).map(|t| t.count).unwrap_or(0);
        return Ok(ChannelDto::from_channel(existing, count));
    }

    // Check that the new tag doesn't conflict with another channel
    let channels = index::list_channels(&vs.conn)?;
    if channels.iter().any(|c| c.tag == normalized_new) {
        return Err(CommandError::Internal(format!(
            "channel '{}' already exists", normalized_new
        )));
    }

    // Find the existing channel
    let existing = channels.iter().find(|c| c.tag == normalized_old)
        .ok_or_else(|| CommandError::Internal(format!("channel '{}' not found", old_tag)))?;

    // Wrap DB operations in a transaction to prevent partial renames
    vs.conn.execute("BEGIN", []).map_err(|e| CommandError::Internal(e.to_string()))?;

    // Update all blocks that have the old tag
    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized_old)?;
    for indexed_block in &affected_blocks {
        if indexed_block.slug.is_empty() { continue; }
        let path = vs.vault.block_path(&indexed_block.slug);
        let content = match files::read_block_file(&path) {
            Ok((_, c)) => c,
            Err(e) => {
                vs.conn.execute("ROLLBACK", []).ok();
                return Err(CommandError::Internal(format!("failed to read {}: {}", indexed_block.slug, e)));
            }
        };
        let mut block = parse_block(&indexed_block.slug, &content)
            .map_err(|e| { vs.conn.execute("ROLLBACK", []).ok(); CommandError::Internal(e.to_string()) })?;

        // Replace old tag with new tag (compare normalized to handle legacy non-normalized tags)
        block.frontmatter.tags.retain(|t| normalize_tag(t) != normalized_old);
        if !block.frontmatter.tags.contains(&normalized_new) {
            block.frontmatter.tags.push(normalized_new.clone());
        }

        let serialized = serialize_block(&block);
        if let Err(e) = std::fs::write(&path, serialized) {
            vs.conn.execute("ROLLBACK", []).ok();
            return Err(CommandError::Internal(format!("failed to write: {}", e)));
        }
        index::upsert_block(&vs.conn, &block, Some(vs.vault.root()))?;
    }

    // Create new channel with same metadata
    let mut new_channel = Channel {
        tag: normalized_new.clone(),
        title: {
            let mut chars = normalized_new.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => normalized_new.clone(),
            }
        },
        description: existing.description.clone(),
        color: existing.color.clone(),
        icon: existing.icon.clone(),
        position: existing.position,
        created_at: existing.created_at.clone(),
    };

    // Write new channel .md, delete old
    let new_block = channel_to_block(&new_channel);
    files::write_block_file(&vs.vault, &new_block)?;
    let old_path = vs.vault.block_path(&normalized_old);
    if old_path.exists() {
        let _ = std::fs::remove_file(&old_path);
    }

    index::upsert_channel(&vs.conn, &new_channel)?;
    index::remove_channel(&vs.conn, &normalized_old)?;

    vs.conn.execute("COMMIT", []).map_err(|e| CommandError::Internal(e.to_string()))?;

    let tags = index::get_all_tags(&vs.conn)?;
    let count = tags.iter().find(|t| t.tag == normalized_new).map(|t| t.count).unwrap_or(0);
    Ok(ChannelDto::from_channel(&new_channel, count))
}

/// Sidebar preview: slug + whether it's a text-only thumbnail (for dark mode invert).
#[derive(Debug, Clone, Serialize)]
pub struct PreviewItem {
    pub slug: String,
    /// True for text-only articles (baked text thumbnail needs CSS invert in dark mode).
    pub text: bool,
    /// Unix timestamp (seconds) of the thumb file's last modification.
    /// Frontend uses this as a cache-buster (`?m=<mtime>`) so the browser
    /// refetches when the file changes on disk (e.g. Phase 2 worker
    /// overwrites a PNG placeholder with a decoded JPEG).
    pub mtime: u64,
    /// True if the thumb file exists on disk. False means the block was
    /// just saved and Phase 1/2 hasn't produced a thumb yet. Frontend
    /// renders a neutral placeholder tile for `has_thumb=false` so the
    /// card never collapses to empty space. Renamed from camelCase at
    /// the serde boundary via the struct default (snake_case in JSON).
    pub has_thumb: bool,
}

/// Check if a thumb file is a PNG (text placeholder that needs dark:invert).
/// Returns false for JPEG, missing files, or any I/O error — those render
/// as-is without inversion.
fn thumb_is_png(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let mut buf = [0u8; 3];
    if f.read_exact(&mut buf).is_err() { return false }
    buf == [0x89, 0x50, 0x4E] // PNG magic
}

/// Read the mtime of a thumb file as unix seconds. Returns 0 on any error.
fn thumb_mtime(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Return preview items per channel for sidebar thumbnails.
/// Includes `__all__` key for all blocks regardless of channel.
/// Max `limit` thumbnails per channel.
#[tauri::command]
pub fn list_channel_previews(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<HashMap<String, Vec<PreviewItem>>, CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let tags = index::get_all_tags(&vs.conn)?;
    let all_slugs = index::list_preview_slugs(&vs.conn, limit)?;
    let per_tag_slugs = index::list_preview_slugs_by_tag(&vs.conn, limit)?;

    let to_item = |slug: &str| -> PreviewItem {
        let thumb_path = vs.vault.thumb_path(slug);
        let has_thumb = thumb_path.exists();
        let is_text = has_thumb && thumb_is_png(&thumb_path);
        let mtime = thumb_mtime(&thumb_path);
        PreviewItem {
            slug: slug.to_string(),
            text: is_text,
            mtime,
            has_thumb,
        }
    };

    let mut result = HashMap::new();

    let all_items: Vec<PreviewItem> = all_slugs.iter().map(|slug| to_item(slug)).collect();
    result.insert("__all__".to_string(), all_items);

    for (tag, slugs) in per_tag_slugs {
        let items: Vec<PreviewItem> = slugs.iter().map(|slug| to_item(slug)).collect();
        result.insert(tag, items);
    }

    for tag in &tags {
        result.entry(tag.tag.clone()).or_insert_with(Vec::new);
    }

    Ok(result)
}

/// Delete a channel: remove .md file and index entry.
/// Blocks are not affected (tags stay in block frontmatter).
#[tauri::command]
pub fn delete_channel(
    state: State<'_, AppState>,
    tag: String,
) -> Result<bool, CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    // Delete .md file
    let md_path = vs.vault.block_path(&tag);
    if md_path.exists() {
        let trashed = {
            #[cfg(not(target_os = "ios"))]
            { trash::delete(&md_path).is_ok() }
            #[cfg(target_os = "ios")]
            { false }
        };
        if !trashed {
            let _ = std::fs::remove_file(&md_path);
        }
    }

    Ok(index::remove_channel(&vs.conn, &tag)?)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Convert a Channel to a Block with type: channel for writing to .md file.
fn channel_to_block(channel: &Channel) -> Block {
    Block {
        slug: channel.tag.clone(),
        frontmatter: Frontmatter {
            block_type: BlockType::Channel,
            title: Some(channel.title.clone()),
            description: channel.description.clone(),
            url: None,
            file: None,
            thumbnail: None,
            tags: Vec::new(),
            saved_at: channel.created_at.clone(),
            source: None,
            width: None,
            height: None,
            author: None,
            position: Some(channel.position),
            color: channel.color.clone(),
            icon: channel.icon.clone(),
        },
        body: String::new(),
    }
}
