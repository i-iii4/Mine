// Block commands: list, get, create, delete blocks.
//
// Contract: SPEC_INTEGRATION.md#commands/blocks

use std::path::PathBuf;
use tauri::State;

use crate::commands::state::{AppState, CommandError};
use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
use crate::domain::vault::validate_slug;
use crate::storage::{files, index};
use crate::storage::index::IndexedBlock;

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all blocks (lightweight — without body/description), ordered by saved_at descending.
#[tauri::command]
pub fn list_blocks(state: State<'_, AppState>) -> Result<Vec<index::LightBlock>, CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(index::list_blocks_light(&vs.conn)?)
}

/// Get a single block by slug.
#[tauri::command]
pub fn get_block(
    state: State<'_, AppState>,
    slug: String,
) -> Result<Option<IndexedBlock>, CommandError> {
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(index::get_block(&vs.conn, &slug)?)
}

/// Create a new block: generate slug, write .md, copy media, index.
#[tauri::command(rename_all = "snake_case")]
pub fn create_block(
    state: State<'_, AppState>,
    block_type: String,
    title: Option<String>,
    url: Option<String>,
    tags: Vec<String>,
    file_path: Option<String>,
) -> Result<IndexedBlock, CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let bt = BlockType::from_str(&block_type)
        .map_err(|e| CommandError::Internal(e.to_string()))?;

    // Generate unique slug
    let raw_slug = crate::domain::block::suggest_slug(title.as_deref(), url.as_deref());
    let slug = index::resolve_unique_slug(&vs.conn, &raw_slug)?;

    // Determine media file name
    let media_file = file_path.as_ref().map(|fp| {
        let ext = std::path::Path::new(fp)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        format!("{}.{}", slug, ext)
    });

    let now = crate::commands::state::now_iso8601();
    let saved_at = DateTime::new(&now)
        .map_err(|e| CommandError::Internal(e.to_string()))?;

    let block = Block {
        slug,
        frontmatter: Frontmatter {
            block_type: bt,
            title,
            description: None,
            url,
            file: media_file,
            thumbnail: None,
            tags,
            saved_at,
            source: None,
            width: None,
            height: None,
            author: None,
        },
        body: String::new(),
    };

    let source = file_path.as_ref().map(|fp| PathBuf::from(fp));
    Ok(files::persist_new_block(&vs.conn, &vs.vault, &block, source.as_deref())?)
}

/// Delete a block: remove from index, delete .md and media files.
#[tauri::command]
pub fn delete_block(
    state: State<'_, AppState>,
    slug: String,
) -> Result<bool, CommandError> {
    let vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;

    // Get block info for media file extension
    let block = index::get_block(&vs.conn, &slug)?;
    let media_ext = block.as_ref().and_then(|b| {
        b.media_file.as_ref().and_then(|f| {
            std::path::Path::new(f)
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_string())
        })
    });

    // Delete files
    files::delete_block_files(&vs.vault, &slug, media_ext.as_deref())?;

    // Remove from index
    Ok(index::remove_block(&vs.conn, &slug)?)
}

