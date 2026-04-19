// Tag commands: list tags, add/remove tag from block.
//
// Contract: SPEC_INTEGRATION.md#commands/tags

use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, AppState, CommandError};
use crate::domain::block::parse_block;
use crate::domain::block::serialize_block;
use crate::domain::tag::normalize_tag;
use crate::storage::index::TagCount;
use crate::storage::{db, files, index};
use crate::util::append_startup_trace;

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all tags with their block counts.
#[tauri::command]
pub async fn list_tags(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TagCount>, CommandError> {
    append_startup_trace(&app, "list_tags", "start");
    let db_path = current_vault_layout(&state)?.index_db_path();
    let tags =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TagCount>, CommandError> {
            let conn = db::open_read_only(&db_path)?;
            Ok(index::get_all_tags(&conn)?)
        })
        .await
        .map_err(|e| CommandError::Internal(format!("list_tags task join failed: {e}")))??;
    append_startup_trace(&app, "list_tags", &format!("done count={}", tags.len()));
    Ok(tags)
}

/// Add a tag to a block: read .md, update frontmatter, write back, re-index.
#[tauri::command]
pub fn add_tag(state: State<'_, AppState>, slug: String, tag: String) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let path = vs.vault.block_path(&slug);
    let (_, content) = files::read_block_file(&path)?;
    let mut block =
        parse_block(&slug, &content).map_err(|e| CommandError::Internal(e.to_string()))?;

    let normalized = normalize_tag(&tag);
    if normalized.is_empty() {
        return Err(CommandError::Internal(
            "tag is empty after normalization".to_string(),
        ));
    }

    if !block.frontmatter.tags.contains(&normalized) {
        block.frontmatter.tags.push(normalized);
    }

    // Write updated .md and re-index
    let content = serialize_block(&block);
    std::fs::write(&path, content)
        .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
    index::upsert_block(&vs.conn, &block, Some(vs.vault.root()))?;

    Ok(())
}

/// Remove a tag from a block: read .md, update frontmatter, write back, re-index.
#[tauri::command]
pub fn remove_tag(
    state: State<'_, AppState>,
    slug: String,
    tag: String,
) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let path = vs.vault.block_path(&slug);
    let (_, content) = files::read_block_file(&path)?;
    let mut block =
        parse_block(&slug, &content).map_err(|e| CommandError::Internal(e.to_string()))?;

    let normalized = normalize_tag(&tag);
    block.frontmatter.tags.retain(|t| t != &normalized);

    let content = serialize_block(&block);
    std::fs::write(&path, content)
        .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
    index::upsert_block(&vs.conn, &block, Some(vs.vault.root()))?;

    Ok(())
}

/// Rename a tag in ALL blocks: find blocks with old_tag, replace with new_tag
/// in frontmatter, write back, re-index.
#[tauri::command(rename_all = "snake_case")]
pub fn rename_tag(
    state: State<'_, AppState>,
    old_tag: String,
    new_tag: String,
) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let normalized_old = normalize_tag(&old_tag);
    let normalized_new = normalize_tag(&new_tag);

    if normalized_new.is_empty() {
        return Err(CommandError::Internal(
            "new tag is empty after normalization".into(),
        ));
    }
    if normalized_old == normalized_new {
        return Ok(());
    }

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized_old)?;
    for indexed_block in &affected_blocks {
        let path = vs.vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(&path)?;
        let mut block = parse_block(&indexed_block.slug, &content)
            .map_err(|e| CommandError::Internal(e.to_string()))?;

        block.frontmatter.tags.retain(|t| t != &normalized_old);
        if !block.frontmatter.tags.contains(&normalized_new) {
            block.frontmatter.tags.push(normalized_new.clone());
        }

        let serialized = serialize_block(&block);
        std::fs::write(&path, serialized)
            .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
        index::upsert_block(&vs.conn, &block, Some(vs.vault.root()))?;
    }

    Ok(())
}

/// Delete a tag from ALL blocks: find blocks with tag, remove it from
/// frontmatter, write back, re-index.
#[tauri::command]
pub fn delete_tag_from_all(state: State<'_, AppState>, tag: String) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let normalized = normalize_tag(&tag);
    if normalized.is_empty() {
        return Ok(());
    }

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized)?;
    for indexed_block in &affected_blocks {
        let path = vs.vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(&path)?;
        let mut block = parse_block(&indexed_block.slug, &content)
            .map_err(|e| CommandError::Internal(e.to_string()))?;

        block.frontmatter.tags.retain(|t| t != &normalized);

        let serialized = serialize_block(&block);
        std::fs::write(&path, serialized)
            .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
        index::upsert_block(&vs.conn, &block, Some(vs.vault.root()))?;
    }

    Ok(())
}
