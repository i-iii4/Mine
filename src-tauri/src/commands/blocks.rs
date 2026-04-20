// Block commands: list, get, create, delete blocks.
//
// Contract: SPEC_INTEGRATION.md#commands/blocks

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, AppState, CommandError};
use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
use crate::domain::vault::validate_slug;
use crate::storage::index::IndexedBlock;
use crate::storage::{article_audio, db, files, index};
use crate::util::append_startup_trace;

#[derive(Debug, Serialize)]
pub struct GridSnapshot {
    pub blocks: Vec<index::LightBlock>,
    pub total_blocks: usize,
    pub has_more: bool,
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all blocks (lightweight — without body/description), ordered by saved_at descending.
#[tauri::command]
pub fn list_blocks(state: State<'_, AppState>) -> Result<Vec<index::LightBlock>, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(index::list_blocks_light(&vs.conn)?)
}

/// List only the blocks required by the current grid route, plus the total
/// non-channel block count for the sidebar "Everything" row.
#[tauri::command(rename_all = "snake_case")]
pub async fn list_grid_blocks(
    app: AppHandle,
    state: State<'_, AppState>,
    current_tag: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<GridSnapshot, CommandError> {
    append_startup_trace(
        &app,
        "list_grid_blocks",
        &format!(
            "start tag={} offset={} limit={}",
            current_tag.as_deref().unwrap_or("__all__"),
            offset.unwrap_or(0),
            limit.unwrap_or(200)
        ),
    );
    let vault = current_vault_layout(&state)?;
    if !vault.index_db_path().exists() {
        append_startup_trace(&app, "list_grid_blocks", "no_vault");
        return Err(CommandError::NoVault);
    }
    let page_offset = offset.unwrap_or(0);
    let page_limit = limit.unwrap_or(200).max(1);
    let db_path = vault.index_db_path();
    let current_tag_for_task = current_tag.clone();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || -> Result<GridSnapshot, CommandError> {
            let conn = db::open_read_only(&db_path)?;
            let (blocks, has_more) = index::list_grid_blocks(
                &conn,
                current_tag_for_task.as_deref(),
                page_offset,
                page_limit,
            )?;
            Ok(GridSnapshot {
                blocks,
                total_blocks: index::count_grid_blocks(&conn)?,
                has_more,
            })
        })
        .await
        .map_err(|e| CommandError::Internal(format!("list_grid_blocks task join failed: {e}")))??;
    append_startup_trace(
        &app,
        "list_grid_blocks",
        &format!(
            "done blocks={} total={} has_more={}",
            snapshot.blocks.len(),
            snapshot.total_blocks,
            snapshot.has_more
        ),
    );
    Ok(snapshot)
}

/// Get a single block by slug.
#[tauri::command]
pub fn get_block(
    state: State<'_, AppState>,
    slug: String,
) -> Result<Option<IndexedBlock>, CommandError> {
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let vault_state = state
        .vault_state
        .lock()
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
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let bt = BlockType::from_str(&block_type).map_err(|e| CommandError::Internal(e.to_string()))?;

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
    let saved_at = DateTime::new(&now).map_err(|e| CommandError::Internal(e.to_string()))?;

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
            position: None,
            color: None,
            icon: None,
        },
        body: String::new(),
    };

    let source = file_path.as_ref().map(|fp| PathBuf::from(fp));
    Ok(files::persist_new_block(
        &vs.conn,
        &vs.vault,
        &block,
        source.as_deref(),
    )?)
}

/// Delete a block: remove from index, delete .md and media files.
#[tauri::command]
pub fn delete_block(state: State<'_, AppState>, slug: String) -> Result<bool, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
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

    // Remove from index first (UI updates immediately)
    let removed = index::remove_block(&vs.conn, &slug)?;

    // Then delete files (may be slow for iCloud placeholders)
    if let Err(e) = files::delete_block_files(&vs.vault, &slug, media_ext.as_deref()) {
        log::warn!("failed to delete files for {slug}: {e:#}");
    }
    if let Err(e) = article_audio::delete_all_artifacts(&vs.vault, &slug) {
        log::warn!("failed to delete article audio for {slug}: {e:#}");
    }

    Ok(removed)
}
