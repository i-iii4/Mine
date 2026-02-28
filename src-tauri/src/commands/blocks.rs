// Block commands: list, get, create, delete blocks.
//
// Contract: SPEC_INTEGRATION.md#commands/blocks

use std::collections::HashSet;
use std::path::PathBuf;
use tauri::State;

use crate::commands::state::{AppState, CommandError};
use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
use crate::domain::vault::resolve_slug_conflict;
use crate::storage::{files, index, thumbnails};
use crate::storage::index::IndexedBlock;

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all blocks, ordered by saved_at descending.
#[tauri::command]
pub fn list_blocks(state: State<'_, AppState>) -> Result<Vec<IndexedBlock>, CommandError> {
    let vault_state = state.vault_state.lock().unwrap();
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(index::list_blocks(&vs.conn)?)
}

/// Get a single block by slug.
#[tauri::command]
pub fn get_block(
    state: State<'_, AppState>,
    slug: String,
) -> Result<Option<IndexedBlock>, CommandError> {
    let vault_state = state.vault_state.lock().unwrap();
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
    let vault_state = state.vault_state.lock().unwrap();
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let bt = BlockType::from_str(&block_type)
        .map_err(|e| CommandError::Internal(e.to_string()))?;

    // Generate slug
    let raw_slug = crate::domain::block::suggest_slug(
        title.as_deref(),
        url.as_deref(),
    );

    // Resolve conflicts with existing slugs
    let existing: HashSet<String> = index::list_blocks(&vs.conn)?
        .iter()
        .map(|b| b.slug.clone())
        .collect();
    let slug = resolve_slug_conflict(&raw_slug, &existing);

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
        slug: slug.clone(),
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

    // Write .md file
    files::write_block_file(&vs.vault, &block)?;

    // Copy media file if provided
    if let Some(ref fp) = file_path {
        let source = PathBuf::from(fp);
        files::copy_media_file(&source, &vs.vault, &slug)?;

        // Generate thumbnail for images
        let ext = source
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if is_image_ext(ext) {
            let media_dest = vs.vault.media_path(&slug, ext);
            let thumb_dest = vs.vault.thumb_path(&slug);
            let _ = thumbnails::generate_thumbnail(&media_dest, &thumb_dest, thumbnails::DEFAULT_MAX_SIZE);
        }
    }

    // Index
    index::upsert_block(&vs.conn, &block)?;

    // Return the indexed block
    index::get_block(&vs.conn, &slug)?
        .ok_or_else(|| CommandError::Internal("block not found after creation".to_string()))
}

/// Delete a block: remove from index, delete .md and media files.
#[tauri::command]
pub fn delete_block(
    state: State<'_, AppState>,
    slug: String,
) -> Result<bool, CommandError> {
    let vault_state = state.vault_state.lock().unwrap();
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

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

// ─── Private helpers ────────────────────────────────────────────────────────

fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | "tif"
    )
}
