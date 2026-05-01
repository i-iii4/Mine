// Block commands: list, get, create, delete blocks.
//
// Contract: SPEC_INTEGRATION.md#commands/blocks

use anyhow::{bail, Context};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;

use crate::commands::state::{current_vault_layout, AppState, CommandError};
use crate::domain::block::{
    compute_body_hash, iter_inline_media_references, parse_markdown_document, suggest_slug, Block,
    BlockType, DateTime, Frontmatter,
};
use crate::domain::collection::normalize_collection_ref;
use crate::domain::markdown::{rename_inline_media_references, rename_wikilink_targets};
use crate::domain::vault::{normalize_filename_stem, validate_slug, VaultLayout};
use crate::storage::index::IndexedBlock;
use crate::storage::{article_audio, db, files, index, media_refs, thumbnails};
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

#[derive(Debug, Clone, Serialize)]
pub struct DeleteBlockMedia {
    pub path: String,
    pub file_name: String,
    pub kind: String,
    pub referenced_by: Vec<String>,
    #[serde(skip_serializing)]
    absolute_path: PathBuf,
    #[serde(skip_serializing)]
    slug_owned_primary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteBlockPlan {
    pub slug: String,
    pub markdown_file: String,
    pub unused_media: Vec<DeleteBlockMedia>,
    pub shared_media: Vec<DeleteBlockMedia>,
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

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TextSelectionExtractError {
    #[error("no vault selected")]
    NoVault,

    #[error("source block '{source_slug}' not found")]
    SourceNotFound { source_slug: String },

    #[error("source block '{source_slug}' is not an article")]
    SourceNotArticle {
        source_slug: String,
        block_type: String,
    },

    #[error("selection is empty")]
    EmptySelection,

    #[error("source text changed since selection started")]
    StaleSelection,

    #[error("unsupported selection shape: {reason}")]
    UnsupportedSelectionShape { reason: String },

    #[error("unsafe source patch: {reason}")]
    UnsafeSourcePatch { reason: String },

    #[error("invalid collection reference: {reason}")]
    InvalidCollectionRef { reason: String },

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
    let collections = tags
        .iter()
        .map(|tag| normalize_collection_ref(tag))
        .filter(|tag| !tag.is_empty())
        .collect();

    let block = Block {
        slug,
        frontmatter: Frontmatter {
            block_type: bt,
            title: None,
            description: None,
            url,
            file: media_file,
            thumbnail: None,
            tags: collections,
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
pub async fn extract_inline_media(
    app: AppHandle,
    state: State<'_, AppState>,
    source_slug: String,
    media_ref: String,
    target_tag: String,
) -> Result<IndexedBlock, InlineMediaExtractError> {
    let vault = {
        let vault_state =
            state
                .vault_state
                .lock()
                .map_err(|_| InlineMediaExtractError::Internal {
                    message: "vault state mutex poisoned".into(),
                })?;
        let vs = vault_state
            .as_ref()
            .ok_or(InlineMediaExtractError::NoVault)?;
        vs.vault.clone()
    };

    let indexed = tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open_or_create(&vault.index_db_path()).map_err(internal_extract_error)?;
        extract_inline_media_inner(&conn, &vault, source_slug, media_ref, target_tag)
    })
    .await
    .map_err(|e| InlineMediaExtractError::Internal {
        message: format!("inline media extraction worker failed: {e}"),
    })??;

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

#[tauri::command(rename_all = "snake_case")]
pub async fn extract_text_selection(
    app: AppHandle,
    state: State<'_, AppState>,
    source_slug: String,
    target_tag: String,
    selected_text: String,
    first_block_start: usize,
    first_block_end: usize,
    source_body_hash: String,
) -> Result<IndexedBlock, TextSelectionExtractError> {
    validate_slug(&source_slug).map_err(|e| TextSelectionExtractError::UnsafeSourcePatch {
        reason: format!("invalid source slug: {e}"),
    })?;
    let vault = {
        let vault_state =
            state
                .vault_state
                .lock()
                .map_err(|_| TextSelectionExtractError::Internal {
                    message: "vault state mutex poisoned".into(),
                })?;
        let vs = vault_state
            .as_ref()
            .ok_or(TextSelectionExtractError::NoVault)?;
        vs.vault.clone()
    };
    let source_path = vault.block_path(&source_slug);
    state
        .suppress_paths(
            [source_path],
            Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
        )
        .map_err(internal_text_selection_error)?;

    let indexed = tauri::async_runtime::spawn_blocking(move || {
        let conn =
            db::open_or_create(&vault.index_db_path()).map_err(internal_text_selection_error)?;
        extract_text_selection_inner(
            &conn,
            &vault,
            source_slug,
            target_tag,
            selected_text,
            first_block_start,
            first_block_end,
            source_body_hash,
        )
    })
    .await
    .map_err(|e| TextSelectionExtractError::Internal {
        message: format!("text selection extraction worker failed: {e}"),
    })??;

    let slug = indexed.slug.clone();
    let tags = indexed.tags.clone();

    app.emit(
        "block:added",
        BlockAddedPayload {
            slug: slug.clone(),
            tags,
            is_text: true,
        },
    )
    .map_err(|e| TextSelectionExtractError::Internal {
        message: format!("failed to emit block:added: {e}"),
    })?;
    app.emit(
        "thumb:updated",
        ThumbUpdatedPayload {
            slug,
            is_text: true,
        },
    )
    .map_err(|e| TextSelectionExtractError::Internal {
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
) -> Result<IndexedBlock, InlineMediaExtractError> {
    validate_slug(&source_slug).map_err(|e| InlineMediaExtractError::InvalidMediaRef {
        reason: format!("invalid source slug: {e}"),
    })?;
    validate_inline_media_ref(&media_ref)?;

    let target_tag = normalize_collection_ref(&target_tag);
    if target_tag.is_empty() {
        return Err(InlineMediaExtractError::InvalidMediaRef {
            reason: "target collection is empty".to_string(),
        });
    }

    let source_path = vault.block_path(&source_slug);
    if !source_path.exists() {
        return Err(InlineMediaExtractError::SourceNotFound { source_slug });
    }

    let (read_slug, content) =
        files::read_block_file(vault, &source_path).map_err(internal_extract_error)?;
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

    let referenced_media = iter_inline_media_references(&source_block.body)
        .into_iter()
        .find(|reference| reference.source == media_ref);
    let Some(referenced_media) = referenced_media else {
        return Err(InlineMediaExtractError::MediaNotReferenced {
            media_ref,
            source_slug: source_block.slug,
        });
    };

    let source_media_path = crate::storage::media_refs::resolve_inline_media(
        vault,
        &source_block.slug,
        &referenced_media,
    )
    .ok_or_else(|| InlineMediaExtractError::InvalidMediaRef {
        reason: "media reference must stay inside the vault".to_string(),
    })?;
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

    let raw_slug = suggest_slug(Some(&extraction_slug_seed(&media_ref)), None);
    let slug = resolve_unique_extraction_slug(conn, vault, &raw_slug, &source_ext)
        .map_err(internal_extract_error)?;
    let media_file = vault
        .root_relative_reference(&source_media_path)
        .unwrap_or_else(|| media_ref.clone());
    let now = crate::commands::state::now_iso8601();
    let saved_at = DateTime::new(&now).map_err(|e| InlineMediaExtractError::Internal {
        message: e.to_string(),
    })?;

    let block = Block {
        slug: slug.clone(),
        frontmatter: Frontmatter {
            block_type: BlockType::Image,
            title: None,
            description: None,
            url: source_block.frontmatter.url.clone(),
            file: Some(media_file.clone()),
            thumbnail: None,
            tags: vec![target_tag.clone()],
            related_notes: vec![source_block.slug.clone()],
            source_media: Some(media_file.clone()),
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

    let indexed =
        files::persist_new_reference_block(conn, vault, &block).map_err(internal_extract_error)?;
    Ok(indexed)
}

#[allow(clippy::too_many_arguments)]
fn extract_text_selection_inner(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    source_slug: String,
    target_tag: String,
    selected_text: String,
    first_block_start: usize,
    first_block_end: usize,
    source_body_hash: String,
) -> Result<IndexedBlock, TextSelectionExtractError> {
    validate_slug(&source_slug).map_err(|e| TextSelectionExtractError::UnsafeSourcePatch {
        reason: format!("invalid source slug: {e}"),
    })?;

    let target_tag = normalize_collection_ref(&target_tag);
    if target_tag.is_empty() {
        return Err(TextSelectionExtractError::InvalidCollectionRef {
            reason: "target collection is empty".to_string(),
        });
    }

    let selected_text = selected_text.trim();
    if selected_text.is_empty() {
        return Err(TextSelectionExtractError::EmptySelection);
    }

    let source_path = vault.block_path(&source_slug);
    if !source_path.exists() {
        return Err(TextSelectionExtractError::SourceNotFound { source_slug });
    }

    let (read_slug, content) =
        files::read_block_file(vault, &source_path).map_err(internal_text_selection_error)?;
    let parsed = parse_markdown_document(&read_slug, &content, file_saved_at(&source_path))
        .map_err(|e| TextSelectionExtractError::Internal {
            message: format!("failed to parse source block: {e}"),
        })?;
    let source_origin = parsed.origin.clone();
    let source_index_warning = parsed.index_warning.clone();
    let source_block = parsed.block;
    if source_block.frontmatter.block_type != BlockType::Article {
        return Err(TextSelectionExtractError::SourceNotArticle {
            source_slug: source_block.slug,
            block_type: source_block.frontmatter.block_type.as_str().to_string(),
        });
    }

    if compute_body_hash(&source_block.body) != source_body_hash.trim() {
        return Err(TextSelectionExtractError::StaleSelection);
    }

    let (block_start, block_end) = validated_source_block_range(
        &source_block.body,
        first_block_start,
        first_block_end,
        selected_text,
    )?;
    let source_block_slice = source_block
        .body
        .get(block_start..block_end)
        .ok_or_else(|| TextSelectionExtractError::UnsafeSourcePatch {
            reason: "source block range is out of bounds".to_string(),
        })?;
    if is_unsupported_anchor_block(source_block_slice) {
        return Err(TextSelectionExtractError::UnsupportedSelectionShape {
            reason: "first selected block cannot safely receive an Obsidian block id".to_string(),
        });
    }

    let mut patched_source = None;
    let block_id = if let Some(existing) = existing_block_id(source_block_slice) {
        existing
    } else {
        let block_id = generate_block_id(selected_text, &source_block.body);
        let insertion_offset =
            block_anchor_insert_offset(&source_block.body, block_start, block_end).ok_or_else(
                || TextSelectionExtractError::UnsafeSourcePatch {
                    reason: "cannot compute source block-id insertion point".to_string(),
                },
            )?;
        let body_start_offset = source_body_start_offset(&content, &source_origin)?;
        let content_offset = body_start_offset
            .checked_add(insertion_offset)
            .ok_or_else(|| TextSelectionExtractError::UnsafeSourcePatch {
                reason: "source patch offset overflowed".to_string(),
            })?;
        if content_offset > content.len() || !content.is_char_boundary(content_offset) {
            return Err(TextSelectionExtractError::UnsafeSourcePatch {
                reason: "source patch offset is not a valid UTF-8 boundary".to_string(),
            });
        }
        let mut updated = content.clone();
        updated.insert_str(content_offset, &format!(" ^{block_id}"));
        patched_source = Some(updated);
        block_id
    };

    let raw_slug = suggest_slug(Some(&text_selection_slug_seed(selected_text)), None);
    let slug = resolve_unique_text_selection_slug(conn, vault, &raw_slug)
        .map_err(internal_text_selection_error)?;
    let now = crate::commands::state::now_iso8601();
    let saved_at = DateTime::new(&now).map_err(|e| TextSelectionExtractError::Internal {
        message: e.to_string(),
    })?;

    let block = Block {
        slug: slug.clone(),
        frontmatter: Frontmatter {
            block_type: BlockType::Article,
            title: None,
            description: None,
            url: source_block.frontmatter.url.clone(),
            file: None,
            thumbnail: None,
            tags: vec![target_tag.clone()],
            related_notes: vec![format!("{}#^{}", source_block.slug, block_id)],
            source_media: None,
            saved_at,
            source: Some("text-selection-extraction".to_string()),
            width: None,
            height: None,
            author: source_block.frontmatter.author.clone(),
            position: None,
            color: None,
            icon: None,
        },
        body: selected_text.to_string(),
    };

    if let Some(updated) = patched_source.as_ref() {
        std::fs::write(&source_path, &updated).map_err(internal_text_selection_error)?;
        let reindex_result = (|| -> Result<(), TextSelectionExtractError> {
            let reparsed =
                parse_markdown_document(&read_slug, updated, file_saved_at(&source_path)).map_err(
                    |e| TextSelectionExtractError::Internal {
                        message: format!("failed to parse patched source block: {e}"),
                    },
                )?;
            index::upsert_block_with_diagnostics(
                conn,
                &reparsed.block,
                Some(vault.root()),
                Some(&reparsed.origin),
                reparsed.index_warning.as_deref(),
            )
            .map_err(internal_text_selection_error)?;
            Ok(())
        })();
        if let Err(error) = reindex_result {
            let _ = std::fs::write(&source_path, &content);
            return Err(error);
        }
    }

    match files::persist_new_reference_block(conn, vault, &block) {
        Ok(indexed) => Ok(indexed),
        Err(error) => {
            if patched_source.is_some() {
                let _ = std::fs::write(&source_path, &content);
                let _ = index::upsert_block_with_diagnostics(
                    conn,
                    &source_block,
                    Some(vault.root()),
                    Some(&source_origin),
                    source_index_warning.as_deref(),
                );
            }
            Err(internal_text_selection_error(error))
        }
    }
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

/// Prepare a user-visible deletion plan for a block.
#[tauri::command]
pub fn prepare_delete_block(
    state: State<'_, AppState>,
    slug: String,
) -> Result<DeleteBlockPlan, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    build_delete_block_plan(&vs.conn, &vs.vault, &slug)
}

/// Delete a block: remove .md, selected unused media, derived artifacts, and index row.
#[tauri::command(rename_all = "snake_case")]
pub fn delete_block(
    state: State<'_, AppState>,
    slug: String,
    delete_unused_media: Option<bool>,
) -> Result<bool, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let plan = build_delete_block_plan(&vs.conn, &vs.vault, &slug)?;

    let media_paths: Vec<PathBuf> = match delete_unused_media {
        Some(true) => plan
            .unused_media
            .iter()
            .map(|media| media.absolute_path.clone())
            .collect(),
        Some(false) => Vec::new(),
        None => plan
            .unused_media
            .iter()
            .filter(|media| media.slug_owned_primary)
            .map(|media| media.absolute_path.clone())
            .collect(),
    };

    files::delete_block_files_with_media_paths(&vs.vault, &slug, &media_paths)?;

    let removed = index::remove_block(&vs.conn, &slug)?;
    if let Err(e) = article_audio::delete_all_artifacts(&vs.vault, &slug) {
        log::warn!("failed to delete article audio for {slug}: {e:#}");
    }

    Ok(removed)
}

fn build_delete_block_plan(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    slug: &str,
) -> Result<DeleteBlockPlan, CommandError> {
    let block = index::get_block(conn, slug)?
        .ok_or_else(|| CommandError::Internal(format!("block not found: {slug}")))?;

    let mut current_resolver = media_refs::MediaResolver::new(vault);
    let current_media = collect_delete_media_for_block(vault, &block, &mut current_resolver);

    let mut other_refs: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut shared_resolver = media_refs::MediaResolver::new(vault);
    for other in index::list_blocks(conn)? {
        if other.slug == slug {
            continue;
        }
        for media in collect_delete_media_for_block(vault, &other, &mut shared_resolver).values() {
            other_refs
                .entry(media.path.clone())
                .or_default()
                .insert(other.slug.clone());
        }
    }

    let mut unused_media = Vec::new();
    let mut shared_media = Vec::new();
    for mut media in current_media.into_values() {
        if let Some(refs) = other_refs.get(&media.path) {
            media.referenced_by = refs.iter().cloned().collect();
            shared_media.push(media);
        } else {
            unused_media.push(media);
        }
    }

    Ok(DeleteBlockPlan {
        slug: slug.to_string(),
        markdown_file: format!("{slug}.md"),
        unused_media,
        shared_media,
    })
}

fn collect_delete_media_for_block(
    vault: &VaultLayout,
    block: &IndexedBlock,
    resolver: &mut media_refs::MediaResolver<'_>,
) -> BTreeMap<String, DeleteBlockMedia> {
    let mut media = BTreeMap::new();

    if let Err(error) = validate_slug(&block.slug) {
        log::warn!(
            "delete plan skipped invalid indexed block slug {:?}: {}",
            block.slug,
            error
        );
        return media;
    }

    if let Some(file_name) = block.media_file.as_deref() {
        if let Some(path) = media_refs::resolve_indexed_media(vault, &block.slug, file_name) {
            insert_delete_media(vault, &mut media, &block.slug, &path, true);
        }
    }

    if let Some(thumbnail) = block.thumbnail.as_deref() {
        if let Some(path) = media_refs::resolve_indexed_media(vault, &block.slug, thumbnail) {
            insert_delete_media(vault, &mut media, &block.slug, &path, false);
        }
    }

    for reference in iter_inline_media_references(&block.body) {
        if let Some(path) = resolver.resolve_inline_media(&block.slug, &reference) {
            insert_delete_media(vault, &mut media, &block.slug, &path, false);
        }
    }

    media
}

fn insert_delete_media(
    vault: &VaultLayout,
    media: &mut BTreeMap<String, DeleteBlockMedia>,
    block_slug: &str,
    path: &Path,
    primary: bool,
) {
    let Some(root_relative) = vault.root_relative_reference(path) else {
        return;
    };
    if !is_deletable_media_path(&root_relative) {
        return;
    }

    let slug_owned_primary = primary && is_slug_owned_primary_media(vault, block_slug, path);
    media
        .entry(root_relative.clone())
        .and_modify(|existing| {
            existing.slug_owned_primary |= slug_owned_primary;
        })
        .or_insert_with(|| DeleteBlockMedia {
            file_name: Path::new(&root_relative)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&root_relative)
                .to_string(),
            kind: delete_media_kind(&root_relative).to_string(),
            referenced_by: Vec::new(),
            absolute_path: path.to_path_buf(),
            slug_owned_primary,
            path: root_relative,
        });
}

fn is_slug_owned_primary_media(vault: &VaultLayout, block_slug: &str, path: &Path) -> bool {
    if validate_slug(block_slug).is_err() {
        return false;
    }
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    vault.media_path(block_slug, ext) == path
}

fn is_deletable_media_path(root_relative: &str) -> bool {
    if root_relative.is_empty()
        || root_relative.starts_with('.')
        || root_relative
            .split('/')
            .any(|segment| segment.starts_with('.'))
    {
        return false;
    }
    let ext = Path::new(root_relative)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();
    !ext.is_empty() && ext != "md"
}

fn delete_media_kind(root_relative: &str) -> &'static str {
    let ext = Path::new(root_relative)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();
    if thumbnails::is_image_ext(&ext) {
        "image"
    } else if thumbnails::is_video_ext(&ext) {
        "video"
    } else if matches!(ext.as_str(), "mp3" | "m4a" | "wav" | "aac" | "flac" | "ogg") {
        "audio"
    } else if ext == "pdf" {
        "document"
    } else {
        "file"
    }
}

fn rename_block_file_inner(
    app: Option<&AppHandle>,
    state: &AppState,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    old_slug: &str,
    new_stem: &str,
) -> Result<RenameBlockResult, RenameBlockError> {
    let requested_slug = normalize_requested_stem(new_stem)?;
    let new_slug = if requested_slug.contains('/') {
        requested_slug
    } else if let Some((parent, _)) = old_slug.rsplit_once('/') {
        format!("{parent}/{requested_slug}")
    } else {
        requested_slug
    };
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

    let (read_slug, content) =
        files::read_block_file(vault, &old_path).map_err(internal_rename_error)?;
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
        if let Some(parent) = rename.to.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create directory: {}", parent.display()))
                .map_err(internal_rename_error)?;
        }
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
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))
            .map_err(internal_rename_error)?;
    }
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
    if media_ref.contains('\\') || media_ref.contains('\0') {
        return Err(InlineMediaExtractError::InvalidMediaRef {
            reason: "media reference contains an invalid path separator".to_string(),
        });
    }
    for segment in media_ref.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(InlineMediaExtractError::InvalidMediaRef {
                reason: "media reference cannot contain path traversal".to_string(),
            });
        }
    }
    Ok(())
}

fn validated_source_block_range(
    body: &str,
    first_block_start: usize,
    first_block_end: usize,
    selected_text: &str,
) -> Result<(usize, usize), TextSelectionExtractError> {
    if first_block_start < first_block_end
        && first_block_end <= body.len()
        && body.is_char_boundary(first_block_start)
        && body.is_char_boundary(first_block_end)
    {
        if range_matches_selection_start(body, first_block_start, first_block_end, selected_text) {
            return Ok((first_block_start, first_block_end));
        }
        return Err(TextSelectionExtractError::UnsupportedSelectionShape {
            reason: "selected text does not match the provided source block range".to_string(),
        });
    }

    let Some(selection_start) = body.find(selected_text) else {
        return Err(TextSelectionExtractError::UnsupportedSelectionShape {
            reason: "selected text could not be located in the current source body".to_string(),
        });
    };
    Ok(markdown_block_range_containing(body, selection_start))
}

fn range_matches_selection_start(
    body: &str,
    block_start: usize,
    block_end: usize,
    selected_text: &str,
) -> bool {
    if let Some(selection_start) = body.find(selected_text) {
        return selection_start >= block_start && selection_start < block_end;
    }

    let Some(block) = body.get(block_start..block_end) else {
        return false;
    };
    let block_normalized = normalize_inline_whitespace(block);
    let selection_normalized = normalize_inline_whitespace(selected_text);
    if selection_normalized.is_empty() {
        return false;
    }
    if block_normalized.contains(&selection_normalized)
        || selection_normalized.starts_with(&block_normalized)
    {
        return true;
    }

    let selection_head = selection_normalized
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    !selection_head.is_empty() && block_normalized.contains(&selection_head)
}

fn normalize_inline_whitespace(value: &str) -> String {
    let mut out = String::new();
    let mut last_space = false;
    for ch in value.trim().chars() {
        if ch.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out
}

fn markdown_block_range_containing(body: &str, index: usize) -> (usize, usize) {
    let mut start = body[..index].rfind("\n\n").map_or(0, |pos| pos + 2);
    let mut end = body[index..]
        .find("\n\n")
        .map_or(body.len(), |pos| index + pos);

    while start < end {
        let Some(ch) = body[start..end].chars().next() else {
            break;
        };
        if ch == '\n' || ch == '\r' {
            start += ch.len_utf8();
        } else {
            break;
        }
    }
    while start < end {
        let Some(ch) = body[start..end].chars().next_back() else {
            break;
        };
        if ch == '\n' || ch == '\r' {
            end -= ch.len_utf8();
        } else {
            break;
        }
    }

    (start, end)
}

fn is_unsupported_anchor_block(block: &str) -> bool {
    let trimmed = block.trim_start();
    trimmed.starts_with("```")
        || trimmed.starts_with("~~~")
        || trimmed.starts_with('<')
        || trimmed
            .lines()
            .next()
            .is_some_and(|line| line.trim_start().starts_with('|') && line.contains('|'))
}

fn existing_block_id(block: &str) -> Option<String> {
    let trimmed = block.trim_end();
    let candidate = trimmed.split_whitespace().last()?;
    let id = candidate.strip_prefix('^')?;
    if id.is_empty() || !id.chars().all(is_block_id_char) {
        return None;
    }
    Some(id.to_string())
}

fn generate_block_id(selected_text: &str, body: &str) -> String {
    let mut out = String::with_capacity(48);
    let mut last_dash = false;
    for ch in selected_text.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("selection");
    }

    for n in 1..=1000 {
        let candidate = if n == 1 {
            out.clone()
        } else {
            format!("{}-{n}", out.trim_end_matches('-'))
        };
        if !body.contains(&format!("^{candidate}")) {
            return candidate;
        }
    }
    format!("selection-{}", compute_body_hash(selected_text))
}

fn is_block_id_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'
}

fn block_anchor_insert_offset(body: &str, start: usize, end: usize) -> Option<usize> {
    let slice = body.get(start..end)?;
    let trimmed_len = slice.trim_end_matches(|ch| ch == '\n' || ch == '\r').len();
    Some(start + trimmed_len)
}

fn source_body_start_offset(
    content: &str,
    origin: &str,
) -> Result<usize, TextSelectionExtractError> {
    if origin != "partial_frontmatter" {
        return Ok(0);
    }
    frontmatter_body_start_offset(content).ok_or_else(|| {
        TextSelectionExtractError::UnsafeSourcePatch {
            reason: "could not locate source frontmatter boundary".to_string(),
        }
    })
}

fn frontmatter_body_start_offset(content: &str) -> Option<usize> {
    let mut iter = content.split_inclusive('\n');
    let first = iter.next()?;
    if first.trim_end_matches(|ch| ch == '\r' || ch == '\n') != "---" {
        return None;
    }
    let mut cursor = first.len();
    for (idx, line) in iter.enumerate() {
        if idx >= 100 {
            break;
        }
        let line_body = line.trim_end_matches(|ch| ch == '\r' || ch == '\n');
        if line_body == "---" {
            return Some(cursor + line.len());
        }
        cursor += line.len();
    }
    None
}

fn text_selection_slug_seed(selected_text: &str) -> String {
    let mut normalized = String::new();
    let mut last_space = false;
    for ch in selected_text.trim().chars() {
        if ch.is_whitespace() {
            if !last_space && !normalized.is_empty() {
                normalized.push(' ');
                last_space = true;
            }
        } else {
            normalized.push(ch);
            last_space = false;
        }
        if normalized.chars().count() >= 72 {
            break;
        }
    }
    let normalized = normalized.trim();
    if normalized.is_empty() {
        "Text selection".to_string()
    } else if selected_text.trim().chars().count() > normalized.chars().count() {
        format!("{}...", normalized.trim_end_matches('.'))
    } else {
        normalized.to_string()
    }
}

fn resolve_unique_text_selection_slug(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    raw_slug: &str,
) -> anyhow::Result<String> {
    let first = index::resolve_unique_slug(conn, raw_slug)?;
    for candidate in std::iter::once(first).chain((2..=1000).map(|n| format!("{raw_slug} ({n})"))) {
        if index::slug_exists(conn, &candidate)? || vault.block_path(&candidate).exists() {
            continue;
        }
        return Ok(candidate);
    }
    anyhow::bail!(
        "could not resolve text selection filename for '{}'",
        raw_slug
    )
}

fn extraction_slug_seed(media_ref: &str) -> String {
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

fn internal_text_selection_error(error: impl std::fmt::Display) -> TextSelectionExtractError {
    TextSelectionExtractError::Internal {
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
        let (_, content) = files::read_block_file(vault, &path).map_err(internal_rename_error)?;
        let should_consider = path == vault.block_path(old_slug)
            || content.contains(old_slug)
            || media_name_map.keys().any(|name| content.contains(name));
        if !should_consider {
            continue;
        }

        let (slug, content) =
            files::read_block_file(vault, &path).map_err(internal_rename_error)?;
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
        if let Some(updated) = rewrite_related_note_target(note, old_slug, new_slug) {
            *note = updated;
        }
    }
    rewritten.body = rename_inline_media_references(&rewritten.body, media_name_map);
    rewritten.body = rename_wikilink_targets(&rewritten.body, old_slug, new_slug);
    rewritten
}

fn rewrite_related_note_target(note: &str, old_slug: &str, new_slug: &str) -> Option<String> {
    let (base, fragment) = note
        .split_once('#')
        .map_or((note, None), |(base, fragment)| (base, Some(fragment)));
    if base != old_slug {
        return None;
    }
    Some(match fragment {
        Some(fragment) => format!("{new_slug}#{fragment}"),
        None => new_slug.to_string(),
    })
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
    fn extract_inline_media_inner_references_existing_image_and_indexes_related_note() {
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
        )
        .unwrap();

        assert_eq!(indexed.slug, "photo (2)");
        assert_eq!(indexed.block_type, BlockType::Image);
        assert!(indexed.title.is_none());
        assert_eq!(indexed.url.as_deref(), Some("https://example.com/article"));
        assert_eq!(indexed.media_file.as_deref(), Some("photo.png"));
        assert_eq!(indexed.tags, vec!["Mood Board".to_string()]);
        assert_eq!(indexed.related_notes, vec!["Source Article".to_string()]);
        assert_eq!(indexed.source.as_deref(), Some("inline-media-extraction"));
        assert_eq!(
            std::fs::read(vault.root().join("photo.png")).unwrap(),
            b"image-bytes"
        );
        assert!(!vault.root().join("Pulled Frame.png").exists());

        let (_, extracted_content) = files::read_block_file(&vault, &vault.block_path("photo (2)"))
            .unwrap();
        let extracted =
            crate::domain::block::parse_block("photo (2)", &extracted_content).unwrap();
        assert_eq!(
            extracted.frontmatter.related_notes,
            vec!["Source Article".to_string()]
        );
        assert!(extracted.frontmatter.title.is_none());
        assert_eq!(
            extracted.frontmatter.source_media.as_deref(),
            Some("photo.png")
        );
        assert_eq!(extracted.body, "![[photo.png]]");

        let (_, source_content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        assert!(source_content.contains("![[photo.png]]"));
    }

    #[test]
    fn extract_inline_media_inner_avoids_owned_filename_collision_for_shared_media() {
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
        )
        .unwrap();

        assert_eq!(indexed.slug, "photo (2)");
        assert_eq!(indexed.media_file.as_deref(), Some("photo.png"));

        files::delete_block_files(&vault, &indexed.slug, Some("png")).unwrap();
        assert_eq!(
            std::fs::read(vault.root().join("photo.png")).unwrap(),
            b"image-bytes"
        );
    }

    #[test]
    fn delete_plan_keeps_media_referenced_by_another_block() {
        let (_root, _derived, vault, conn) = make_vault();
        persist_block(
            &conn,
            &vault,
            &article("Source Article", "Intro\n\n![[photo.png]]\n\nOutro"),
        );
        persist_block(
            &conn,
            &vault,
            &article("Other Article", "Still uses ![[photo.png]]."),
        );
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let plan = build_delete_block_plan(&conn, &vault, "Source Article").unwrap();

        assert!(plan.unused_media.is_empty());
        assert_eq!(plan.shared_media.len(), 1);
        assert_eq!(plan.shared_media[0].path, "photo.png");
        assert_eq!(
            plan.shared_media[0].referenced_by,
            vec!["Other Article".to_string()]
        );
    }

    #[test]
    fn delete_plan_splits_unused_and_shared_embedded_media() {
        let (_root, _derived, vault, conn) = make_vault();
        persist_block(
            &conn,
            &vault,
            &article("Source Article", "![[unused.png]]\n\n![[shared.png]]"),
        );
        persist_block(
            &conn,
            &vault,
            &article("Other Article", "Still uses ![[shared.png]]."),
        );
        std::fs::write(vault.root().join("unused.png"), b"unused").unwrap();
        std::fs::write(vault.root().join("shared.png"), b"shared").unwrap();

        let plan = build_delete_block_plan(&conn, &vault, "Source Article").unwrap();
        let media_paths: Vec<PathBuf> = plan
            .unused_media
            .iter()
            .map(|media| media.absolute_path.clone())
            .collect();

        assert_eq!(plan.unused_media.len(), 1);
        assert_eq!(plan.unused_media[0].path, "unused.png");
        assert_eq!(plan.shared_media.len(), 1);
        assert_eq!(plan.shared_media[0].path, "shared.png");

        files::delete_block_files_with_media_paths(&vault, "Source Article", &media_paths).unwrap();
        index::remove_block(&conn, "Source Article").unwrap();

        assert!(!vault.block_path("Source Article").exists());
        assert!(!vault.root().join("unused.png").exists());
        assert!(vault.root().join("shared.png").exists());
    }

    #[test]
    fn delete_plan_skips_invalid_indexed_slugs_instead_of_panicking() {
        let (_root, _derived, vault, conn) = make_vault();
        persist_block(
            &conn,
            &vault,
            &article("Source Article", "Intro\n\n![[unused.png]]\n\nOutro"),
        );
        std::fs::write(vault.root().join("unused.png"), b"unused").unwrap();

        conn.execute(
            "INSERT INTO blocks (slug, block_type, title, saved_at, body)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                "../corrupt",
                "article",
                "Corrupt index row",
                "2026-04-23T00:00:00Z",
                "![[unused.png]]"
            ],
        )
        .unwrap();

        let plan = build_delete_block_plan(&conn, &vault, "Source Article").unwrap();

        assert_eq!(plan.unused_media.len(), 1);
        assert_eq!(plan.unused_media[0].path, "unused.png");
        assert!(plan.shared_media.is_empty());
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
        )
        .unwrap_err();

        assert!(matches!(
            err,
            InlineMediaExtractError::MediaNotReferenced { .. }
        ));
    }

    #[test]
    fn extract_text_selection_inner_creates_snapshot_and_anchors_source() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article(
            "Source Article",
            "First paragraph with useful sentence.\n\nSecond paragraph.",
        );
        let body_hash = compute_body_hash(&source.body);
        persist_block(&conn, &vault, &source);

        let indexed = extract_text_selection_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            "Quotes".to_string(),
            "useful sentence".to_string(),
            0,
            0,
            body_hash.clone(),
        )
        .unwrap();

        assert_eq!(indexed.block_type, BlockType::Article);
        assert_eq!(indexed.body, "useful sentence");
        assert!(indexed.title.is_none());
        assert_eq!(indexed.tags, vec!["Quotes".to_string()]);
        assert_eq!(indexed.source.as_deref(), Some("text-selection-extraction"));
        assert_eq!(
            indexed.related_notes,
            vec!["Source Article#^useful-sentence"]
        );

        let (_, source_content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        assert!(source_content.contains("First paragraph with useful sentence. ^useful-sentence"));

        let (_, extracted_content) =
            files::read_block_file(&vault, &vault.block_path(&indexed.slug)).unwrap();
        let extracted =
            crate::domain::block::parse_block(&indexed.slug, &extracted_content).unwrap();
        assert_eq!(
            extracted.frontmatter.related_notes,
            vec!["Source Article#^useful-sentence"]
        );
        assert!(extracted.frontmatter.title.is_none());

        let source_after = index::get_block(&conn, "Source Article").unwrap().unwrap();
        assert_ne!(source_after.body_hash.as_deref(), Some(body_hash.as_str()));
    }

    #[test]
    fn extract_text_selection_inner_reuses_existing_block_id() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article(
            "Source Article",
            "Paragraph with anchor. ^manual-anchor\n\nOther paragraph.",
        );
        let body_hash = compute_body_hash(&source.body);
        persist_block(&conn, &vault, &source);

        let indexed = extract_text_selection_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            "Quotes".to_string(),
            "Paragraph with anchor.".to_string(),
            0,
            0,
            body_hash,
        )
        .unwrap();

        assert_eq!(indexed.related_notes, vec!["Source Article#^manual-anchor"]);
        let (_, source_content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        assert_eq!(source_content.matches("^manual-anchor").count(), 1);
    }

    #[test]
    fn extract_text_selection_inner_rejects_stale_hash() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article("Source Article", "Current body.");
        persist_block(&conn, &vault, &source);

        let err = extract_text_selection_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            "Quotes".to_string(),
            "Current".to_string(),
            0,
            0,
            "stale".to_string(),
        )
        .unwrap_err();

        assert!(matches!(err, TextSelectionExtractError::StaleSelection));
    }

    #[test]
    fn rename_block_file_rewrites_links_and_inline_media() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();

        let original = article("Old Name", "Intro\n\n![[Old Name (image 1).jpg]]");
        let reference = article("Reference Note", "See [[Old Name#^anchor]].");
        let mut related = image("Related Image", "Related Image.jpg");
        related.frontmatter.related_notes = vec!["Old Name#^anchor".to_string()];
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
            files::read_block_file(&vault, &vault.block_path("Renamed Name")).unwrap();
        let renamed = crate::domain::block::parse_block("Renamed Name", &renamed_content).unwrap();
        assert_eq!(renamed.frontmatter.title.as_deref(), Some("Old Name"));
        assert!(renamed.body.contains("![[Renamed Name (image 1).jpg]]"));

        let (_, ref_content) =
            files::read_block_file(&vault, &vault.block_path("Reference Note")).unwrap();
        let ref_block = crate::domain::block::parse_block("Reference Note", &ref_content).unwrap();
        assert!(ref_block.body.contains("[[Renamed Name#^anchor]]"));

        let (_, related_content) =
            files::read_block_file(&vault, &vault.block_path("Related Image")).unwrap();
        let related_block =
            crate::domain::block::parse_block("Related Image", &related_content).unwrap();
        assert_eq!(
            related_block.frontmatter.related_notes,
            vec!["Renamed Name#^anchor".to_string()]
        );

        assert!(index::get_block(&conn, "Old Name").unwrap().is_none());
        assert!(index::get_block(&conn, "Renamed Name").unwrap().is_some());
    }

    #[test]
    fn rename_block_file_preserves_article_audio_when_filename_only_changes() {
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
            files::read_block_file(&vault, &vault.block_path("Renamed Name")).unwrap();
        let renamed = crate::domain::block::parse_block("Renamed Name", &renamed_content).unwrap();
        let prepared = prepare_article_speech(&renamed).unwrap();
        let audio_state =
            article_audio_storage::resolve_state_for_prepared(&vault, "Renamed Name", &prepared)
                .unwrap();
        assert_eq!(
            audio_state.status,
            article_audio_storage::ArticleAudioStatus::Ready
        );
        assert_eq!(
            audio_state.audio_path.as_deref(),
            Some(
                vault
                    .article_audio_asset_path("Renamed Name", "wav")
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(vault.article_audio_asset_path("Renamed Name", "wav").exists());
        assert!(vault.article_audio_state_path("Renamed Name").exists());
    }

    #[test]
    fn rename_block_file_leaves_custom_media_filenames_untouched() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();

        let original = image("Old Name", "custom-cover.jpg");
        persist_block(&conn, &vault, &original);
        std::fs::write(vault.root().join("custom-cover.jpg"), b"img").unwrap();

        rename_block_file_inner(None, &state, &conn, &vault, "Old Name", "Renamed Name").unwrap();

        let (_, content) =
            files::read_block_file(&vault, &vault.block_path("Renamed Name")).unwrap();
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
