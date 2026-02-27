// Channel commands: list, create, delete channels.
//
// Contract: SPEC_INTEGRATION.md#commands/channels

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::state::{AppState, CommandError};
use crate::domain::block::DateTime;
use crate::domain::channel::Channel;
use crate::storage::index;

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
    let vault_state = state.vault_state.lock().unwrap();
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
    let vault_state = state.vault_state.lock().unwrap();
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
#[tauri::command]
pub fn reorder_channels(
    state: State<'_, AppState>,
    items: Vec<ReorderItem>,
) -> Result<(), CommandError> {
    let vault_state = state.vault_state.lock().unwrap();
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let positions: Vec<(String, u32)> = items
        .into_iter()
        .map(|item| (item.tag, item.position))
        .collect();

    index::update_channel_positions(&vs.conn, &positions)?;
    Ok(())
}

/// Delete a channel (blocks are not affected, only the channel metadata).
#[tauri::command]
pub fn delete_channel(
    state: State<'_, AppState>,
    tag: String,
) -> Result<bool, CommandError> {
    let vault_state = state.vault_state.lock().unwrap();
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(index::remove_channel(&vs.conn, &tag)?)
}
