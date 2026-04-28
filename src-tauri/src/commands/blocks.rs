// Block commands: list, get, create, delete blocks.
//
// Contract: SPEC_INTEGRATION.md#commands/blocks

use anyhow::{bail, Context};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;

use crate::commands::state::{current_vault_layout, AppState, CommandError};
use crate::domain::block::{
    iter_inline_media_sources, parse_markdown_document, suggest_slug, Block, BlockType, DateTime,
    Frontmatter,
};
use crate::domain::markdown::{rename_inline_media_references, rename_wikilink_targets};
use crate::domain::tag::normalize_tag;
use crate::domain::vault::{normalize_filename_stem, validate_slug, VaultLayout};
use crate::storage::index::IndexedBlock;
use crate::storage::{article_audio, db, files, index, thumbnails};
use crate::util::append_startup_trace;

#[derive(Debug, Serialize)]
pub struct GridSnapshot {
    pub blocks: Vec<index::LightBlock>,
    pub total_blocks: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RenameBlockResult {
    pub old_slug: String,
    pub new_slug: String,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RenameBlockError {
    #[error("no vault selected")]
    NoVault,

    #[error("block '{slug}' not found")]
    BlockNotFound { slug: String },

    #[error("filename is invalid: {reason}")]
    InvalidFilename { reason: String },

    #[error("filename already exists")]
    NameTaken { requested: String },

    #[error("{message}")]
    Internal { message: String },
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InlineMediaExtractError {
    #[error("no vault selected")]
    NoVault,

    #[error("source block '{source_slug}' not found")]
    SourceNotFound { source_slug: String },

    #[error("source block '{source_slug}' is not an article")]
    SourceNotArticle {
        source_slug: String,
        block_type: String,
    },

    #[error("invalid media reference: {reason}")]
    InvalidMediaRef { reason: String },

    #[error("media '{media_ref}' is not referenced by source block '{source_slug}'")]
    MediaNotReferenced {
        media_ref: String,
        source_slug: String,
    },

    #[error("media '{media_ref}' not found")]
    MediaNotFound { media_ref: String },

    #[error("unsupported media type for '{media_ref}'")]
    UnsupportedMediaType { media_ref: String },

    #[error("{message}")]
    Internal { message: String },
}

#[derive(Debug, Clone, Serialize)]
struct BlockAddedPayload {
    slug: String,
    tags: Vec<String>,
    is_text: bool,
}

#[derive(Debug, Clone, Serialize)]
struct ThumbUpdatedPayload {
    slug: String,
    is_text: bool,
}

struct PlannedBlockWrite {
    original_path: PathBuf,
    target_path: PathBuf,
    block: Block,
}

struct FileRename {
    from: PathBuf,
    to: PathBuf,
}

const IN_APP_RENAME_WATCHER_SUPPRESSION_MS: u64 = 1500;

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
            related_notes: Vec::new(),
            source_media: None,
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

/// Extract a local inline image from an article body into a new image block.
#[tauri::command(rename_all = "snake_case")]
pub fn extract_inline_media(
    app: AppHandle,
    state: State<'_, AppState>,
    source_slug: String,
    media_ref: String,
    target_tag: String,
    title: Option<String>,
) -> Result<IndexedBlock, InlineMediaExtractError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| InlineMediaExtractError::Internal {
            message: "vault state mutex poisoned".into(),
        })?;
    let vs = vault_state
        .as_ref()
        .ok_or(InlineMediaExtractError::NoVault)?;

    let indexed = extract_inline_media_inner(
        &vs.conn,
        &vs.vault,
        source_slug,
        media_ref,
        target_tag,
        title,
    )?;

    let slug = indexed.slug.clone();
    let tags = indexed.tags.clone();

    app.emit(
        "block:added",
        BlockAddedPayload {
            slug: slug.clone(),
            tags,
            is_text: false,
        },
    )
    .map_err(|e| InlineMediaExtractError::Internal {
        message: format!("failed to emit block:added: {e}"),
    })?;
    app.emit(
        "thumb:updated",
        ThumbUpdatedPayload {
            slug,
            is_text: false,
        },
    )
    .map_err(|e| InlineMediaExtractError::Internal {
        message: format!("failed to emit thumb:updated: {e}"),
    })?;

    Ok(indexed)
}

fn extract_inline_media_inner(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    source_slug: String,
    media_ref: String,
    target_tag: String,
    title: Option<String>,
) -> Result<IndexedBlock, InlineMediaExtractError> {
    validate_slug(&source_slug).map_err(|e| InlineMediaExtractError::InvalidMediaRef {
        reason: format!("invalid source slug: {e}"),
    })?;
    validate_inline_media_ref(&media_ref)?;

    let target_tag = normalize_tag(&target_tag);
    if target_tag.is_empty() {
        return Err(InlineMediaExtractError::InvalidMediaRef {
            reason: "target tag is empty after normalization".to_string(),
        });
    }

    let source_path = vault.block_path(&source_slug);
    if !source_path.exists() {
        return Err(InlineMediaExtractError::SourceNotFound { source_slug });
    }

    let (read_slug, content) =
        files::read_block_file(&source_path).map_err(internal_extract_error)?;
    let parsed = parse_markdown_document(&read_slug, &content, file_saved_at(&source_path))
        .map_err(|e| InlineMediaExtractError::Internal {
            message: format!("failed to parse source block: {e}"),
        })?;
    let source_block = parsed.block;
    if source_block.frontmatter.block_type != BlockType::Article {
        return Err(InlineMediaExtractError::SourceNotArticle {
            source_slug: source_block.slug,
            block_type: source_block.frontmatter.block_type.as_str().to_string(),
        });
    }

    let is_referenced = iter_inline_media_sources(&source_block.body)
        .into_iter()
        .any(|source| source == media_ref);
    if !is_referenced {
        return Err(InlineMediaExtractError::MediaNotReferenced {
            media_ref,
            source_slug: source_block.slug,
        });
    }

    let source_media_path = vault.root().join(&media_ref);
    if !source_media_path.is_file() {
        return Err(InlineMediaExtractError::MediaNotFound { media_ref });
    }

    let source_ext = source_media_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string();
    let ext_lower = source_ext.to_lowercase();
    if !thumbnails::is_image_ext(&ext_lower) {
        return Err(InlineMediaExtractError::UnsupportedMediaType { media_ref });
    }

    let resolved_title = extraction_title(title.as_deref(), &media_ref);
    let raw_slug = suggest_slug(Some(&resolved_title), None);
    let slug = resolve_unique_extraction_slug(conn, vault, &raw_slug, &source_ext)
        .map_err(internal_extract_error)?;
    let media_file = format!("{slug}.{source_ext}");
    let now = crate::commands::state::now_iso8601();
    let saved_at = DateTime::new(&now).map_err(|e| InlineMediaExtractError::Internal {
        message: e.to_string(),
    })?;

    let block = Block {
        slug: slug.clone(),
        frontmatter: Frontmatter {
            block_type: BlockType::Image,
            title: Some(resolved_title),
            description: None,
            url: source_block.frontmatter.url.clone(),
            file: Some(media_file.clone()),
            thumbnail: None,
            tags: vec![target_tag.clone()],
            related_notes: vec![source_block.slug.clone()],
            source_media: Some(media_ref.clone()),
            saved_at,
            source: Some("inline-media-extraction".to_string()),
            width: None,
            height: None,
            author: None,
            position: None,
            color: None,
            icon: None,
        },
        body: format!("![[{media_file}]]"),
    };

    files::persist_new_block(conn, vault, &block, Some(&source_media_path))
        .map_err(internal_extract_error)?;
    let _ = thumbnails::generate_for_block(&block, vault);
    let _ = index::sync_thumb_metadata(
        conn,
        &block.slug,
        &vault.thumb_path(&block.slug),
        Some(vault.root()),
    );
    let indexed = index::get_block(conn, &block.slug)
        .map_err(internal_extract_error)?
        .ok_or_else(|| InlineMediaExtractError::Internal {
            message: "block not found after extraction".to_string(),
        })?;
    Ok(indexed)
}

/// Rename a block's backing `.md` file while keeping filename-derived identity.
///
/// This is the canonical in-app rename path: it updates the source-of-truth
/// filename, rewrites block wikilinks and Mine-owned media references across
/// the vault, migrates derived artifacts, and preserves the existing DB row by
/// renaming its slug instead of creating a new block.
#[tauri::command(rename_all = "snake_case")]
pub fn rename_block_file(
    app: AppHandle,
    state: State<'_, AppState>,
    old_slug: String,
    new_stem: String,
) -> Result<RenameBlockResult, RenameBlockError> {
    validate_slug(&old_slug).map_err(|e| RenameBlockError::InvalidFilename {
        reason: e.to_string(),
    })?;

    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| RenameBlockError::Internal {
            message: "vault state mutex poisoned".into(),
        })?;
    let vs = vault_state.as_ref().ok_or(RenameBlockError::NoVault)?;

    rename_block_file_inner(
        Some(&app),
        &state,
        &vs.conn,
        &vs.vault,
        &old_slug,
        &new_stem,
    )
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

fn rename_block_file_inner(
    app: Option<&AppHandle>,
    state: &AppState,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    old_slug: &str,
    new_stem: &str,
) -> Result<RenameBlockResult, RenameBlockError> {
    let new_slug = normalize_requested_stem(new_stem)?;
    if old_slug == new_slug {
        return Ok(RenameBlockResult {
            old_slug: old_slug.to_string(),
            new_slug,
        });
    }

    let old_path = vault.block_path(old_slug);
    if !old_path.exists() {
        return Err(RenameBlockError::BlockNotFound {
            slug: old_slug.to_string(),
        });
    }

    if vault.block_path(&new_slug).exists()
        || index::slug_exists(conn, &new_slug).map_err(internal_rename_error)?
    {
        return Err(RenameBlockError::NameTaken {
            requested: new_slug,
        });
    }

    let (read_slug, content) = files::read_block_file(&old_path).map_err(internal_rename_error)?;
    let old_block = crate::domain::block::parse_block(&read_slug, &content).map_err(|e| {
        RenameBlockError::Internal {
            message: e.to_string(),
        }
    })?;
    let media_renames = collect_mine_owned_media_renames(vault, &old_block, old_slug, &new_slug)?;
    let planned_writes =
        build_planned_block_writes(vault, &old_block, old_slug, &new_slug, &media_renames)?;
    let renamed_root_block = planned_writes
        .iter()
        .find(|write| write.target_path == vault.block_path(&new_slug))
        .map(|write| write.block.clone())
        .unwrap_or_else(|| {
            rewrite_block_for_rename(&old_block, old_slug, &new_slug, &BTreeMap::new())
        });

    let mut suppressed_paths = BTreeSet::new();
    for write in &planned_writes {
        suppressed_paths.insert(write.original_path.clone());
        suppressed_paths.insert(write.target_path.clone());
    }
    for rename in &media_renames {
        suppressed_paths.insert(rename.from.clone());
        suppressed_paths.insert(rename.to.clone());
    }
    state
        .suppress_paths(
            suppressed_paths.into_iter(),
            Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
        )
        .map_err(|e| RenameBlockError::Internal {
            message: e.to_string(),
        })?;

    for rename in &media_renames {
        std::fs::rename(&rename.from, &rename.to)
            .with_context(|| {
                format!(
                    "failed to rename media file {} -> {}",
                    rename.from.display(),
                    rename.to.display()
                )
            })
            .map_err(internal_rename_error)?;
    }

    let new_path = vault.block_path(&new_slug);
    std::fs::rename(&old_path, &new_path)
        .with_context(|| {
            format!(
                "failed to rename block file {} -> {}",
                old_path.display(),
                new_path.display()
            )
        })
        .map_err(internal_rename_error)?;

    for write in &planned_writes {
        let serialized = crate::domain::block::serialize_block(&write.block);
        std::fs::write(&write.target_path, serialized)
            .with_context(|| {
                format!(
                    "failed to write updated block file: {}",
                    write.target_path.display()
                )
            })
            .map_err(internal_rename_error)?;
    }

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(internal_sqlite_rename_error)?;
    let db_result = (|| -> anyhow::Result<()> {
        let renamed = index::rename_slug(conn, old_slug, &new_slug)?;
        if !renamed {
            bail!(
                "source slug '{}' missing from index during rename",
                old_slug
            );
        }
        files::rename_derived_artifacts(vault, old_slug, &new_slug)?;
        if article_audio_should_invalidate_after_rename(&old_block, &renamed_root_block) {
            article_audio::delete_all_artifacts(vault, &new_slug)?;
        }

        for write in &planned_writes {
            if write.block.frontmatter.block_type == BlockType::Channel {
                index::upsert_channel_from_block(conn, &write.block)?;
            } else {
                index::upsert_block(conn, &write.block, Some(vault.root()))?;
            }
        }

        Ok(())
    })();

    match db_result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(internal_sqlite_rename_error)?,
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(internal_rename_error(error));
        }
    }

    if let Some(app) = app {
        app.emit(
            "block:renamed",
            RenameBlockResult {
                old_slug: old_slug.to_string(),
                new_slug: new_slug.clone(),
            },
        )
        .map_err(|e| RenameBlockError::Internal {
            message: format!("failed to emit block:renamed: {e}"),
        })?;
    }

    Ok(RenameBlockResult {
        old_slug: old_slug.to_string(),
        new_slug,
    })
}

fn normalize_requested_stem(raw: &str) -> Result<String, RenameBlockError> {
    let trimmed = raw.trim();
    let stem = if trimmed.to_lowercase().ends_with(".md") {
        &trimmed[..trimmed.len() - 3]
    } else {
        trimmed
    };
    let normalized = normalize_filename_stem(stem.trim());
    validate_slug(&normalized).map_err(|e| RenameBlockError::InvalidFilename {
        reason: e.to_string(),
    })?;
    Ok(normalized)
}

fn validate_inline_media_ref(media_ref: &str) -> Result<(), InlineMediaExtractError> {
    let trimmed = media_ref.trim();
    if trimmed.is_empty() {
        return Err(InlineMediaExtractError::InvalidMediaRef {
            reason: "media reference is empty".to_string(),
        });
    }
    if trimmed != media_ref {
        return Err(InlineMediaExtractError::InvalidMediaRef {
            reason: "media reference has leading or trailing whitespace".to_string(),
        });
    }
    if media_ref.starts_with("http://") || media_ref.starts_with("https://") {
        return Err(InlineMediaExtractError::InvalidMediaRef {
            reason: "remote media is not supported".to_string(),
        });
    }
    if media_ref.contains('/') || media_ref.contains('\\') || media_ref.contains('\0') {
        return Err(InlineMediaExtractError::InvalidMediaRef {
            reason: "media reference must be a leaf filename".to_string(),
        });
    }
    if media_ref == "." || media_ref == ".." {
        return Err(InlineMediaExtractError::InvalidMediaRef {
            reason: "media reference cannot be a path traversal segment".to_string(),
        });
    }
    Ok(())
}

fn extraction_title(title: Option<&str>, media_ref: &str) -> String {
    if let Some(title) = title.map(str::trim).filter(|value| !value.is_empty()) {
        return title.to_string();
    }
    std::path::Path::new(media_ref)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| "Untitled image".to_string())
}

fn resolve_unique_extraction_slug(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    raw_slug: &str,
    ext: &str,
) -> anyhow::Result<String> {
    let first = index::resolve_unique_slug(conn, raw_slug)?;
    for candidate in std::iter::once(first).chain((2..=1000).map(|n| format!("{raw_slug} ({n})"))) {
        if index::slug_exists(conn, &candidate)? {
            continue;
        }
        if vault.block_path(&candidate).exists() || vault.media_path(&candidate, ext).exists() {
            continue;
        }
        return Ok(candidate);
    }
    anyhow::bail!("could not resolve extraction filename for '{}'", raw_slug)
}

fn file_saved_at(path: &std::path::Path) -> DateTime {
    let time = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().ok().or_else(|| metadata.modified().ok()))
        .unwrap_or_else(std::time::SystemTime::now);
    DateTime::new(&crate::util::system_time_to_iso8601(time))
        .unwrap_or_else(|_| DateTime::new("1970-01-01T00:00:00Z").unwrap())
}

fn internal_extract_error(error: impl std::fmt::Display) -> InlineMediaExtractError {
    InlineMediaExtractError::Internal {
        message: error.to_string(),
    }
}

fn internal_rename_error(error: impl std::fmt::Display) -> RenameBlockError {
    RenameBlockError::Internal {
        message: error.to_string(),
    }
}

fn internal_sqlite_rename_error(error: rusqlite::Error) -> RenameBlockError {
    RenameBlockError::Internal {
        message: error.to_string(),
    }
}

fn build_planned_block_writes(
    vault: &VaultLayout,
    root_block: &Block,
    old_slug: &str,
    new_slug: &str,
    media_renames: &[FileRename],
) -> Result<Vec<PlannedBlockWrite>, RenameBlockError> {
    let media_name_map: BTreeMap<String, String> = media_renames
        .iter()
        .filter_map(|rename| {
            let old_name = rename.from.file_name()?.to_str()?.to_string();
            let new_name = rename.to.file_name()?.to_str()?.to_string();
            Some((old_name, new_name))
        })
        .collect();

    let mut writes = Vec::new();
    for path in files::scan_md_files(vault).map_err(internal_rename_error)? {
        let (_, content) = files::read_block_file(&path).map_err(internal_rename_error)?;
        let should_consider = path == vault.block_path(old_slug)
            || content.contains(old_slug)
            || media_name_map.keys().any(|name| content.contains(name));
        if !should_consider {
            continue;
        }

        let (slug, content) = files::read_block_file(&path).map_err(internal_rename_error)?;
        let block = crate::domain::block::parse_block(&slug, &content).map_err(|e| {
            RenameBlockError::Internal {
                message: format!("failed to parse {}: {e}", path.display()),
            }
        })?;

        let rewritten = if path == vault.block_path(old_slug) {
            rewrite_block_for_rename(root_block, old_slug, new_slug, &media_name_map)
        } else {
            rewrite_block_references(&block, old_slug, new_slug, &media_name_map)
        };

        let changed = rewritten.frontmatter != block.frontmatter || rewritten.body != block.body;
        if path == vault.block_path(old_slug) || changed {
            writes.push(PlannedBlockWrite {
                original_path: path.clone(),
                target_path: if path == vault.block_path(old_slug) {
                    vault.block_path(new_slug)
                } else {
                    path
                },
                block: rewritten,
            });
        }
    }
    Ok(writes)
}

fn rewrite_block_for_rename(
    block: &Block,
    old_slug: &str,
    new_slug: &str,
    media_name_map: &BTreeMap<String, String>,
) -> Block {
    let mut rewritten = rewrite_block_references(block, old_slug, new_slug, media_name_map);
    rewritten.slug = new_slug.to_string();
    rewritten.frontmatter.title = Some(new_slug.to_string());
    rewritten
}

fn rewrite_block_references(
    block: &Block,
    old_slug: &str,
    new_slug: &str,
    media_name_map: &BTreeMap<String, String>,
) -> Block {
    let mut rewritten = block.clone();
    rewritten.frontmatter.file =
        rewrite_owned_filename_field(rewritten.frontmatter.file.as_deref(), media_name_map);
    rewritten.frontmatter.thumbnail =
        rewrite_owned_filename_field(rewritten.frontmatter.thumbnail.as_deref(), media_name_map);
    for note in &mut rewritten.frontmatter.related_notes {
        if note == old_slug {
            *note = new_slug.to_string();
        }
    }
    rewritten.body = rename_inline_media_references(&rewritten.body, media_name_map);
    rewritten.body = rename_wikilink_targets(&rewritten.body, old_slug, new_slug);
    rewritten
}

fn rewrite_owned_filename_field(
    value: Option<&str>,
    media_name_map: &BTreeMap<String, String>,
) -> Option<String> {
    value.map(|current| {
        media_name_map
            .get(current)
            .cloned()
            .unwrap_or_else(|| current.to_string())
    })
}

fn article_audio_should_invalidate_after_rename(old_block: &Block, new_block: &Block) -> bool {
    match (
        crate::domain::article_audio::prepare_article_speech(old_block),
        crate::domain::article_audio::prepare_article_speech(new_block),
    ) {
        (Ok(old), Ok(new)) => old.text_hash != new.text_hash,
        (Ok(_), Err(_)) => true,
        _ => false,
    }
}

fn collect_mine_owned_media_renames(
    vault: &VaultLayout,
    block: &Block,
    old_slug: &str,
    new_slug: &str,
) -> Result<Vec<FileRename>, RenameBlockError> {
    let mut by_source_name = BTreeMap::<String, FileRename>::new();

    let mut register = |name: &str| -> Result<(), RenameBlockError> {
        let Some(new_name) = mine_owned_rename_family_target(name, old_slug, new_slug) else {
            return Ok(());
        };
        let from = vault.root().join(name);
        if !from.exists() {
            return Ok(());
        }
        let to = vault.root().join(&new_name);
        if to.exists() {
            return Err(RenameBlockError::NameTaken {
                requested: new_name,
            });
        }
        by_source_name.insert(name.to_string(), FileRename { from, to });
        Ok(())
    };

    if let Some(file) = block.frontmatter.file.as_deref() {
        register(file)?;
    }
    if let Some(thumbnail) = block.frontmatter.thumbnail.as_deref() {
        register(thumbnail)?;
    }
    for source in crate::domain::block::iter_inline_media_sources(&block.body) {
        register(&source)?;
    }

    Ok(by_source_name.into_values().collect())
}

fn mine_owned_rename_family_target(name: &str, old_slug: &str, new_slug: &str) -> Option<String> {
    if let Some(ext) = primary_media_extension(name, old_slug) {
        return Some(format!("{new_slug}.{ext}"));
    }
    generated_inline_target(name, old_slug, new_slug, "image")
        .or_else(|| generated_inline_target(name, old_slug, new_slug, "video"))
}

fn primary_media_extension<'a>(name: &'a str, slug: &str) -> Option<&'a str> {
    let rest = name.strip_prefix(slug)?;
    let ext = rest.strip_prefix('.')?;
    if ext.is_empty() || ext.contains('/') || ext.contains('\\') {
        return None;
    }
    Some(ext)
}

fn generated_inline_target(
    name: &str,
    old_slug: &str,
    new_slug: &str,
    kind: &str,
) -> Option<String> {
    let prefix = format!("{old_slug} ({kind} ");
    let rest = name.strip_prefix(&prefix)?;
    let (index, ext) = rest.split_once(").")?;
    if index.is_empty() || !index.chars().all(|ch| ch.is_ascii_digit()) || ext.is_empty() {
        return None;
    }
    Some(format!("{new_slug} ({kind} {index}).{ext}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::article_audio::prepare_article_speech;
    use crate::storage::{article_audio as article_audio_storage, db};

    fn make_vault() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        VaultLayout,
        rusqlite::Connection,
    ) {
        let root = tempfile::tempdir().unwrap();
        let derived = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(root.path().to_path_buf(), derived.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        (root, derived, vault, conn)
    }

    fn article(slug: &str, body: &str) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: Some(slug.to_string()),
                description: None,
                url: Some("https://example.com/article".to_string()),
                file: None,
                thumbnail: None,
                tags: vec!["notes".to_string()],
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-04-22T00:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: body.to_string(),
        }
    }

    fn image(slug: &str, file_name: &str) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Image,
                title: Some(slug.to_string()),
                description: None,
                url: None,
                file: Some(file_name.to_string()),
                thumbnail: None,
                tags: vec![],
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-04-22T00:00:00Z").unwrap(),
                source: None,
                width: Some(1200),
                height: Some(900),
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: String::new(),
        }
    }

    fn persist_block(conn: &rusqlite::Connection, vault: &VaultLayout, block: &Block) {
        files::write_block_file(vault, block).unwrap();
        index::upsert_block(conn, block, Some(vault.root())).unwrap();
    }

    #[test]
    fn extract_inline_media_inner_copies_image_and_indexes_related_note() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article("Source Article", "Intro\n\n![[photo.png]]\n\nOutro");
        persist_block(&conn, &vault, &source);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let indexed = extract_inline_media_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            "photo.png".to_string(),
            "Mood Board".to_string(),
            Some("Pulled Frame".to_string()),
        )
        .unwrap();

        assert_eq!(indexed.slug, "Pulled Frame");
        assert_eq!(indexed.block_type, BlockType::Image);
        assert_eq!(indexed.title.as_deref(), Some("Pulled Frame"));
        assert_eq!(indexed.url.as_deref(), Some("https://example.com/article"));
        assert_eq!(indexed.media_file.as_deref(), Some("Pulled Frame.png"));
        assert_eq!(indexed.tags, vec!["mood-board".to_string()]);
        assert_eq!(indexed.related_notes, vec!["Source Article".to_string()]);
        assert_eq!(indexed.source.as_deref(), Some("inline-media-extraction"));
        assert_eq!(
            std::fs::read(vault.root().join("Pulled Frame.png")).unwrap(),
            b"image-bytes"
        );

        let (_, extracted_content) =
            files::read_block_file(&vault.block_path("Pulled Frame")).unwrap();
        let extracted =
            crate::domain::block::parse_block("Pulled Frame", &extracted_content).unwrap();
        assert_eq!(
            extracted.frontmatter.related_notes,
            vec!["Source Article".to_string()]
        );
        assert_eq!(
            extracted.frontmatter.source_media.as_deref(),
            Some("photo.png")
        );
        assert_eq!(extracted.body, "![[Pulled Frame.png]]");

        let (_, source_content) =
            files::read_block_file(&vault.block_path("Source Article")).unwrap();
        assert!(source_content.contains("![[photo.png]]"));
    }

    #[test]
    fn extract_inline_media_inner_rejects_unreferenced_media() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article("Source Article", "No embeds here.");
        persist_block(&conn, &vault, &source);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let err = extract_inline_media_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            "photo.png".to_string(),
            "Mood Board".to_string(),
            None,
        )
        .unwrap_err();

        assert!(matches!(
            err,
            InlineMediaExtractError::MediaNotReferenced { .. }
        ));
    }

    #[test]
    fn rename_block_file_rewrites_links_and_inline_media() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();

        let original = article("Old Name", "Intro\n\n![[Old Name (image 1).jpg]]");
        let reference = article("Reference Note", "See [[Old Name]].");
        let mut related = image("Related Image", "Related Image.jpg");
        related.frontmatter.related_notes = vec!["Old Name".to_string()];
        persist_block(&conn, &vault, &original);
        persist_block(&conn, &vault, &reference);
        persist_block(&conn, &vault, &related);

        std::fs::write(vault.root().join("Old Name (image 1).jpg"), b"img").unwrap();

        let result =
            rename_block_file_inner(None, &state, &conn, &vault, "Old Name", "Renamed Name")
                .unwrap();
        assert_eq!(result.old_slug, "Old Name");
        assert_eq!(result.new_slug, "Renamed Name");

        assert!(!vault.block_path("Old Name").exists());
        assert!(vault.block_path("Renamed Name").exists());
        assert!(!vault.root().join("Old Name (image 1).jpg").exists());
        assert!(vault.root().join("Renamed Name (image 1).jpg").exists());

        let (_, renamed_content) =
            files::read_block_file(&vault.block_path("Renamed Name")).unwrap();
        let renamed = crate::domain::block::parse_block("Renamed Name", &renamed_content).unwrap();
        assert_eq!(renamed.frontmatter.title.as_deref(), Some("Renamed Name"));
        assert!(renamed.body.contains("![[Renamed Name (image 1).jpg]]"));

        let (_, ref_content) = files::read_block_file(&vault.block_path("Reference Note")).unwrap();
        let ref_block = crate::domain::block::parse_block("Reference Note", &ref_content).unwrap();
        assert!(ref_block.body.contains("[[Renamed Name]]"));

        let (_, related_content) =
            files::read_block_file(&vault.block_path("Related Image")).unwrap();
        let related_block =
            crate::domain::block::parse_block("Related Image", &related_content).unwrap();
        assert_eq!(
            related_block.frontmatter.related_notes,
            vec!["Renamed Name".to_string()]
        );

        assert!(index::get_block(&conn, "Old Name").unwrap().is_none());
        assert!(index::get_block(&conn, "Renamed Name").unwrap().is_some());
    }

    #[test]
    fn rename_block_file_invalidates_article_audio_when_title_changes_speech_text() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let original = article("Old Name", "Plain article body");
        persist_block(&conn, &vault, &original);

        article_audio_storage::ensure_audio_dir(&vault).unwrap();
        std::fs::write(vault.article_audio_asset_path("Old Name", "wav"), b"wav").unwrap();
        article_audio_storage::write_test_state_file(
            &vault,
            "Old Name",
            &prepare_article_speech(&original).unwrap().text_hash,
            "Old Name.wav",
            Some(10),
            7,
            None,
        )
        .unwrap();

        rename_block_file_inner(None, &state, &conn, &vault, "Old Name", "Renamed Name").unwrap();

        let (_, renamed_content) =
            files::read_block_file(&vault.block_path("Renamed Name")).unwrap();
        let renamed = crate::domain::block::parse_block("Renamed Name", &renamed_content).unwrap();
        let prepared = prepare_article_speech(&renamed).unwrap();
        let audio_state =
            article_audio_storage::resolve_state_for_prepared(&vault, "Renamed Name", &prepared)
                .unwrap();
        assert_eq!(
            audio_state.status,
            article_audio_storage::ArticleAudioStatus::Absent
        );
        assert!(audio_state.audio_path.is_none());
        assert!(!vault
            .article_audio_asset_path("Renamed Name", "wav")
            .exists());
        assert!(!vault.article_audio_state_path("Renamed Name").exists());
    }

    #[test]
    fn rename_block_file_leaves_custom_media_filenames_untouched() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();

        let original = image("Old Name", "custom-cover.jpg");
        persist_block(&conn, &vault, &original);
        std::fs::write(vault.root().join("custom-cover.jpg"), b"img").unwrap();

        rename_block_file_inner(None, &state, &conn, &vault, "Old Name", "Renamed Name").unwrap();

        let (_, content) = files::read_block_file(&vault.block_path("Renamed Name")).unwrap();
        let renamed = crate::domain::block::parse_block("Renamed Name", &content).unwrap();
        assert_eq!(
            renamed.frontmatter.file.as_deref(),
            Some("custom-cover.jpg")
        );
        assert!(vault.root().join("custom-cover.jpg").exists());
    }

    #[test]
    fn rename_block_file_rejects_taken_name() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();

        persist_block(&conn, &vault, &article("One", "Body"));
        persist_block(&conn, &vault, &article("Taken", "Other"));

        let err = rename_block_file_inner(None, &state, &conn, &vault, "One", "Taken").unwrap_err();
        assert!(matches!(err, RenameBlockError::NameTaken { .. }));
    }

    #[test]
    fn normalize_requested_stem_rejects_path_traversal() {
        let err = normalize_requested_stem("../escape").unwrap_err();
        assert!(matches!(err, RenameBlockError::InvalidFilename { .. }));
    }
}
