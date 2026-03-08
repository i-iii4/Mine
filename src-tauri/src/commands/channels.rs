// Channel commands: list, create, delete channels.
//
// Contract: SPEC_INTEGRATION.md#commands/channels

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::state::{AppState, CommandError};
use crate::domain::block::{parse_block, serialize_block, DateTime};
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

    let dtos = channels
        .iter()
        .map(|ch| {
            let count = tags
                .iter()
                .find(|t| t.tag == ch.tag)
                .map(|t| t.count)
                .unwrap_or(0);
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
            index::upsert_channel(&vs.conn, &channel)?;
        }
    }

    let positions: Vec<(String, u32)> = items
        .into_iter()
        .map(|item| (item.tag, item.position))
        .collect();

    index::update_channel_positions(&vs.conn, &positions)?;
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

    // Update all blocks that have the old tag
    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized_old)?;
    for indexed_block in &affected_blocks {
        let path = vs.vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(&path)?;
        let mut block = parse_block(&indexed_block.slug, &content)
            .map_err(|e| CommandError::Internal(e.to_string()))?;

        // Replace old tag with new tag
        block.frontmatter.tags.retain(|t| t != &normalized_old);
        if !block.frontmatter.tags.contains(&normalized_new) {
            block.frontmatter.tags.push(normalized_new.clone());
        }

        let serialized = serialize_block(&block);
        std::fs::write(&path, serialized)
            .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
        index::upsert_block(&vs.conn, &block)?;
    }

    // Create new channel with same metadata, remove old one
    let now = crate::commands::state::now_iso8601();
    let dt = DateTime::new(&now).map_err(|e| CommandError::Internal(e.to_string()))?;
    let mut new_channel = Channel::new(&normalized_new, None, dt)
        .map_err(|e| CommandError::Internal(e.to_string()))?;
    new_channel.description = existing.description.clone();
    new_channel.color = existing.color.clone();
    new_channel.icon = existing.icon.clone();
    new_channel.position = existing.position;

    index::upsert_channel(&vs.conn, &new_channel)?;
    index::remove_channel(&vs.conn, &normalized_old)?;

    let tags = index::get_all_tags(&vs.conn)?;
    let count = tags.iter().find(|t| t.tag == normalized_new).map(|t| t.count).unwrap_or(0);
    Ok(ChannelDto::from_channel(&new_channel, count))
}

/// Return thumbnail slugs per channel (only blocks with existing thumbnails).
/// Includes `__all__` key for all blocks regardless of channel.
/// Max `limit` thumbnails per channel.
#[tauri::command]
pub fn list_channel_previews(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<HashMap<String, Vec<String>>, CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let all_blocks = index::list_blocks_light(&vs.conn)?;
    let tags = index::get_all_tags(&vs.conn)?;

    // Use thumbnail field from DB instead of N filesystem checks.
    // For blocks without a DB thumbnail entry, fall back to checking disk
    // (covers thumbnails generated by background thread after initial indexing).
    let has_thumb: Vec<&index::LightBlock> = all_blocks.iter().filter(|b| {
        b.thumbnail.is_some() || vs.vault.thumb_path(&b.slug).exists()
    }).collect();

    let mut result = HashMap::new();

    // __all__: first `limit` blocks with thumbnails
    let all_slugs: Vec<String> = has_thumb.iter()
        .take(limit)
        .map(|b| b.slug.clone())
        .collect();
    result.insert("__all__".to_string(), all_slugs);

    // Per channel
    for tc in &tags {
        let slugs: Vec<String> = has_thumb.iter()
            .filter(|b| b.tags.contains(&tc.tag))
            .take(limit)
            .map(|b| b.slug.clone())
            .collect();
        result.insert(tc.tag.clone(), slugs);
    }

    Ok(result)
}

/// Delete a channel (blocks are not affected, only the channel metadata).
#[tauri::command]
pub fn delete_channel(
    state: State<'_, AppState>,
    tag: String,
) -> Result<bool, CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(index::remove_channel(&vs.conn, &tag)?)
}
