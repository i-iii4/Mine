// Tag commands: list tags, add/remove tag from block.
//
// Contract: SPEC_INTEGRATION.md#commands/tags

use tauri::State;

use crate::commands::state::{AppState, CommandError};
use crate::domain::block::parse_block;
use crate::domain::block::serialize_block;
use crate::domain::tag::normalize_tag;
use crate::storage::{files, index};
use crate::storage::index::TagCount;

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all tags with their block counts.
#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> Result<Vec<TagCount>, CommandError> {
    let vault_state = state.vault_state.lock().unwrap();
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(index::get_all_tags(&vs.conn)?)
}

/// Add a tag to a block: read .md, update frontmatter, write back, re-index.
#[tauri::command]
pub fn add_tag(
    state: State<'_, AppState>,
    slug: String,
    tag: String,
) -> Result<(), CommandError> {
    let vault_state = state.vault_state.lock().unwrap();
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let path = vs.vault.block_path(&slug);
    let (_, content) = files::read_block_file(&path)?;
    let mut block = parse_block(&slug, &content)
        .map_err(|e| CommandError::Internal(e.to_string()))?;

    let normalized = normalize_tag(&tag);
    if normalized.is_empty() {
        return Err(CommandError::Internal("tag is empty after normalization".to_string()));
    }

    if !block.frontmatter.tags.contains(&normalized) {
        block.frontmatter.tags.push(normalized);
    }

    // Write updated .md and re-index
    let content = serialize_block(&block);
    std::fs::write(&path, content)
        .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
    index::upsert_block(&vs.conn, &block)?;

    Ok(())
}

/// Remove a tag from a block: read .md, update frontmatter, write back, re-index.
#[tauri::command]
pub fn remove_tag(
    state: State<'_, AppState>,
    slug: String,
    tag: String,
) -> Result<(), CommandError> {
    let vault_state = state.vault_state.lock().unwrap();
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let path = vs.vault.block_path(&slug);
    let (_, content) = files::read_block_file(&path)?;
    let mut block = parse_block(&slug, &content)
        .map_err(|e| CommandError::Internal(e.to_string()))?;

    let normalized = normalize_tag(&tag);
    block.frontmatter.tags.retain(|t| t != &normalized);

    let content = serialize_block(&block);
    std::fs::write(&path, content)
        .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
    index::upsert_block(&vs.conn, &block)?;

    Ok(())
}
