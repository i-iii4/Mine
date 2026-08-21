// Clipper recovery commands.
//
// This is a last-resort surface for unfinished browser-clipper saves: pending
// HTTP uploads that never reached save_block. It intentionally does not scan
// arbitrary unlinked source-vault media.

use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

use crate::commands::state::{current_vault_layout, AppState, CommandError};
use crate::domain::block::{suggest_slug, Block, BlockType, DateTime, Frontmatter};
use crate::domain::vault::{resolve_card_name_conflict, VaultLayout};
use crate::storage::{clipper_uploads, db, files, index, thumbnails};
use crate::util::now_iso8601;
use crate::watcher::handler;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ClipperRecoveryKind {
    PendingUpload,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipperRecoveryItem {
    pub id: String,
    pub kind: ClipperRecoveryKind,
    pub file_name: String,
    pub media_path: Option<String>,
    pub size: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredClipperBlock {
    pub slug: String,
}

#[derive(Debug, Clone, Serialize)]
struct BlockAddedPayload {
    slug: String,
    tags: Vec<String>,
    is_text: bool,
}

#[tauri::command]
pub async fn list_clipper_recovery_items(
    state: State<'_, AppState>,
) -> Result<Vec<ClipperRecoveryItem>, CommandError> {
    let vault = current_vault_layout(&state)?;
    tauri::async_runtime::spawn_blocking(move || list_recovery_items_for_vault(&vault))
        .await
        .map_err(|e| {
            CommandError::Internal(format!("list_clipper_recovery_items task failed: {e}"))
        })?
}

fn list_recovery_items_for_vault(
    vault: &VaultLayout,
) -> Result<Vec<ClipperRecoveryItem>, CommandError> {
    let mut items = Vec::new();

    for pending in clipper_uploads::list_uncommitted_pending_uploads(vault)
        .map_err(|e| CommandError::Internal(format!("failed to list pending uploads: {e:#}")))?
    {
        items.push(ClipperRecoveryItem {
            id: pending.upload_id,
            kind: ClipperRecoveryKind::PendingUpload,
            file_name: pending.original_filename,
            media_path: None,
            size: pending.size,
            created_at: pending.created_at,
        });
    }

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}

#[tauri::command]
pub fn recover_clipper_pending_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    upload_id: String,
) -> Result<RecoveredClipperBlock, CommandError> {
    let vault = current_vault_layout(&state)?;
    let manifest = clipper_uploads::load_pending_upload(&vault, &upload_id).map_err(|e| {
        CommandError::Internal(format!("failed to load pending upload {upload_id}: {e:#}"))
    })?;
    let slug = next_recovery_slug(&vault, file_stem_for_title(&manifest.original_filename))?;
    let finalized =
        clipper_uploads::finalize_pending_upload(&vault, &upload_id, &slug).map_err(|e| {
            CommandError::Internal(format!(
                "failed to recover pending upload {upload_id}: {e:#}"
            ))
        })?;

    let block = media_block(&slug, &finalized.filename)?;
    if let Err(e) = files::write_new_block_file(&vault, &block) {
        let _ = std::fs::remove_file(vault.root().join(&finalized.filename));
        return Err(CommandError::Internal(format!(
            "failed to write recovered block: {e:#}"
        )));
    }

    if let Err(e) = clipper_uploads::complete_pending_upload(&vault, &upload_id) {
        log::warn!("failed to clean up the recovered staged upload: {e:#}");
    }
    let _ = thumbnails::generate_for_block(&block, &vault);
    index_recovered_block(&app, &vault, &slug)?;
    emit_recovered_block(&app, &slug);
    Ok(RecoveredClipperBlock { slug })
}

#[tauri::command]
pub fn discard_clipper_pending_upload(
    state: State<'_, AppState>,
    upload_id: String,
) -> Result<(), CommandError> {
    let vault = current_vault_layout(&state)?;
    clipper_uploads::discard_pending_upload(&vault, &upload_id).map_err(|e| {
        CommandError::Internal(format!(
            "failed to discard pending upload {upload_id}: {e:#}"
        ))
    })
}

fn next_recovery_slug(vault: &VaultLayout, title: &str) -> Result<String, CommandError> {
    let conn = db::open_or_create(&vault.index_db_path())
        .map_err(|e| CommandError::Internal(format!("failed to open database: {e:#}")))?;
    let mut existing: HashSet<String> = index::list_blocks(&conn)
        .map_err(|e| CommandError::Internal(format!("failed to list blocks: {e:#}")))?
        .into_iter()
        .map(|block| block.slug)
        .collect();
    collect_vault_file_stems(vault, vault.root(), &mut existing)?;

    let raw_slug = suggest_slug(Some(title), None);
    resolve_card_name_conflict(vault, &raw_slug, &existing)
        .map_err(|e| CommandError::Internal(format!("failed to resolve recovered filename: {e}")))
}

fn collect_vault_file_stems(
    vault: &VaultLayout,
    dir: &Path,
    existing: &mut HashSet<String>,
) -> Result<(), CommandError> {
    for entry in std::fs::read_dir(dir)
        .map_err(|e| CommandError::Internal(format!("failed to read {}: {e}", dir.display())))?
    {
        let entry =
            entry.map_err(|e| CommandError::Internal(format!("failed to read dir entry: {e}")))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| CommandError::Internal(format!("failed to inspect file type: {e}")))?;
        if file_type.is_dir() {
            if files::is_ignored_vault_dir(&path) {
                continue;
            }
            collect_vault_file_stems(vault, &path, existing)?;
            continue;
        }
        if file_type.is_file() {
            if let Ok(slug) = vault.slug_for_path(&path) {
                existing.insert(slug);
            }
        }
    }
    Ok(())
}

fn file_stem_for_title(file_name: &str) -> &str {
    Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("Recovered media")
}

fn media_block(slug: &str, file: &str) -> Result<Block, CommandError> {
    let saved_at = DateTime::new(&now_iso8601())
        .map_err(|e| CommandError::Internal(format!("failed to create timestamp: {e}")))?;
    Ok(Block {
        slug: slug.to_string(),
        frontmatter: Frontmatter {
            block_type: BlockType::Image,
            title: None,
            description: None,
            url: None,
            file: Some(file.to_string()),
            thumbnail: None,
            tags: Vec::new(),
            related_notes: Vec::new(),
            source_media: None,
            saved_at,
            source: Some("web-clipper-recovery".to_string()),
            width: None,
            height: None,
            author: None,
            position: None,
            color: None,
            icon: None,
        },
        body: String::new(),
    })
}

fn index_recovered_block(
    app: &AppHandle,
    vault: &VaultLayout,
    slug: &str,
) -> Result<(), CommandError> {
    let conn = db::open_or_create(&vault.index_db_path())
        .map_err(|e| CommandError::Internal(format!("failed to open database: {e:#}")))?;
    let path = vault.block_path(slug);
    handler::index_md_file(&conn, vault, &path, Some(app))
        .map_err(|e| CommandError::Internal(format!("failed to index recovered block: {e:#}")))?;
    Ok(())
}

fn emit_recovered_block(app: &AppHandle, slug: &str) {
    let _ = app.emit(
        "block:added",
        BlockAddedPayload {
            slug: slug.to_string(),
            tags: Vec::new(),
            is_text: false,
        },
    );
    let _ = app.emit("clipper-recovery-changed", ());
}
