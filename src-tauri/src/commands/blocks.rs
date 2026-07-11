// Block commands: list, get, create, delete blocks.
//
// Contract: SPEC_INTEGRATION.md#commands/blocks

use anyhow::bail;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;

use crate::commands::state::{current_vault_layout, ensure_vault_fresh, AppState, CommandError};
use crate::domain::block::{
    compute_body_hash, derive_card_kind, derive_title_fields, iter_inline_media_references,
    parse_markdown_document, suggest_slug, Block, BlockType, CardKind, DateTime, Frontmatter,
};
use crate::domain::collection::{normalize_collection_ref, validate_collection_ref};
use crate::domain::markdown::{
    remove_inline_media_reference_at, remove_inline_media_references,
    rename_inline_media_references, rename_wikilink_targets,
};
use crate::domain::vault::{normalize_filename_stem, validate_slug, VaultLayout};
use crate::storage::index::IndexedBlock;
use crate::storage::source_mutation::{SourceFileWrite, StagedSourceMutation};
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

#[derive(Debug, Clone, Serialize)]
pub struct MergeBlocksResult {
    pub block: IndexedBlock,
    pub merged_slug: String,
    pub removed_slugs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaAssetMutationResult {
    pub media_ref: String,
    pub new_media_ref: Option<String>,
    pub affected_slugs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaAssetReferenceBlock {
    pub slug: String,
    pub title: Option<String>,
    pub display_title: Option<String>,
    pub fallback_label: String,
    pub card_kind: CardKind,
    pub reference_kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteMediaAssetPlan {
    pub media_ref: String,
    pub media_kind: String,
    pub referenced_by: Vec<MediaAssetReferenceBlock>,
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
pub enum MediaAssetActionError {
    #[error("no vault selected")]
    NoVault,

    #[error("invalid media reference: {reason}")]
    InvalidMediaRef { reason: String },

    #[error("media '{media_ref}' not found")]
    MediaNotFound { media_ref: String },

    #[error("unsupported media kind for '{media_ref}'")]
    UnsupportedMediaKind { media_ref: String },

    #[error("filename already exists")]
    NameTaken { target: String },

    #[error("filename is invalid: {reason}")]
    InvalidFilename { reason: String },

    #[cfg_attr(target_os = "macos", allow(dead_code))]
    #[error("native media copy is not supported for '{media_ref}'")]
    ClipboardUnsupported { media_ref: String },

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

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MergeBlocksError {
    #[error("no vault selected")]
    NoVault,

    #[error("at least two cards are required")]
    TooFewCards,

    #[error("duplicate card '{slug}'")]
    DuplicateSlug { slug: String },

    #[error("card '{slug}' not found")]
    BlockNotFound { slug: String },

    #[error("card '{slug}' cannot be merged")]
    BlockNotMergeable { slug: String, block_type: String },

    #[error("invalid card slug '{slug}': {reason}")]
    InvalidSlug { slug: String, reason: String },

    #[error("failed to rewrite '{path}': {message}")]
    ReferenceRewriteFailed { path: String, message: String },

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
struct BlockRemovedPayload {
    slug: String,
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ThumbUpdatedPayload {
    slug: String,
    is_text: bool,
}

#[derive(Debug, Clone, Serialize)]
struct VaultChangedPayload {
    path: String,
}

struct PlannedBlockWrite {
    original_path: PathBuf,
    target_path: PathBuf,
    block: Block,
}

struct MediaAssetBlockWrite {
    path: PathBuf,
    block: Block,
}

struct FileRename {
    from: PathBuf,
    to: PathBuf,
}

#[derive(Debug)]
struct MergeSourceBlock {
    path: PathBuf,
    block: Block,
}

#[derive(Debug)]
struct MergeReferenceWrite {
    path: PathBuf,
    block: Block,
}

#[derive(Debug)]
struct MergeBlocksMutation {
    result: MergeBlocksResult,
    removed_events: Vec<BlockRemovedPayload>,
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
    query: Option<String>,
) -> Result<GridSnapshot, CommandError> {
    append_startup_trace(
        &app,
        "list_grid_blocks",
        &format!(
            "start tag={} offset={} limit={} query={}",
            current_tag.as_deref().unwrap_or("__all__"),
            offset.unwrap_or(0),
            limit.unwrap_or(200),
            query
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|_| "yes")
                .unwrap_or("no")
        ),
    );
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let page_offset = offset.unwrap_or(0);
    let page_limit = limit.unwrap_or(200).max(1);
    let db_path = vault.index_db_path();
    let current_tag_for_task = current_tag.clone();
    let query_for_task = query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || -> Result<GridSnapshot, CommandError> {
            let conn = if query_for_task.is_some() {
                db::open_or_create(&db_path)?
            } else {
                db::open_read_only(&db_path)?
            };
            let (blocks, has_more) = index::list_grid_blocks_with_query(
                &conn,
                current_tag_for_task.as_deref(),
                page_offset,
                page_limit,
                query_for_task.as_deref(),
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
pub async fn get_block(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
) -> Result<Option<IndexedBlock>, CommandError> {
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let db_path = vault.index_db_path();
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<IndexedBlock>, CommandError> {
        let conn = db::open_read_only(&db_path)?;
        Ok(index::get_block(&conn, &slug)?)
    })
    .await
    .map_err(|error| CommandError::Internal(format!("get_block task join failed: {error}")))?
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

    let media_ext = file_path.as_ref().map(|fp| {
        std::path::Path::new(fp)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_string()
    });

    // Generate unique slug across both the index and existing vault files.
    let raw_slug = crate::domain::block::suggest_slug(title.as_deref(), url.as_deref());
    let slug = resolve_unique_block_slug(&vs.conn, &vs.vault, &raw_slug, media_ext.as_deref())?;

    // Determine media file name
    let media_file = media_ext.as_ref().map(|ext| format!("{}.{}", slug, ext));

    let now = crate::commands::state::now_iso8601();
    let saved_at = DateTime::new(&now).map_err(|e| CommandError::Internal(e.to_string()))?;
    let mut collections = Vec::new();
    for tag in &tags {
        let collection_ref = normalize_collection_ref(tag);
        if collection_ref.is_empty() {
            continue;
        }
        let collection_ref =
            validate_collection_ref(&collection_ref).map_err(CommandError::Internal)?;
        if !collections.contains(&collection_ref) {
            collections.push(collection_ref);
        }
    }

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

/// Create a new standalone media card for a local media file, then connect that
/// media card to the selected collection. The source note/card is only
/// provenance context and is never connected as a side effect.
#[tauri::command(rename_all = "snake_case")]
pub async fn create_media_asset_card(
    app: AppHandle,
    state: State<'_, AppState>,
    media_ref: String,
    target_tag: String,
    source_slug: Option<String>,
) -> Result<IndexedBlock, MediaAssetActionError> {
    let vault = {
        let vault_state =
            state
                .vault_state
                .lock()
                .map_err(|_| MediaAssetActionError::Internal {
                    message: "vault state mutex poisoned".into(),
                })?;
        let vs = vault_state.as_ref().ok_or(MediaAssetActionError::NoVault)?;
        vs.vault.clone()
    };

    let indexed = tauri::async_runtime::spawn_blocking(move || {
        let conn =
            db::open_or_create(&vault.index_db_path()).map_err(internal_media_asset_error)?;
        create_media_asset_card_inner(&conn, &vault, media_ref, target_tag, source_slug)
    })
    .await
    .map_err(|e| MediaAssetActionError::Internal {
        message: format!("media asset create worker failed: {e}"),
    })??;

    app.emit(
        "block:added",
        BlockAddedPayload {
            slug: indexed.slug.clone(),
            tags: indexed.tags.clone(),
            is_text: false,
        },
    )
    .map_err(|e| MediaAssetActionError::Internal {
        message: format!("failed to emit block:added: {e}"),
    })?;
    app.emit(
        "thumb:updated",
        ThumbUpdatedPayload {
            slug: indexed.slug.clone(),
            is_text: false,
        },
    )
    .map_err(|e| MediaAssetActionError::Internal {
        message: format!("failed to emit thumb:updated: {e}"),
    })?;

    Ok(indexed)
}

/// Rename a local media file and rewrite media references. Card filenames,
/// titles, H1s and URLs remain unchanged.
#[tauri::command(rename_all = "snake_case")]
pub fn rename_media_asset(
    app: AppHandle,
    state: State<'_, AppState>,
    media_ref: String,
    new_stem: String,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| MediaAssetActionError::Internal {
            message: "vault state mutex poisoned".into(),
        })?;
    let vs = vault_state.as_ref().ok_or(MediaAssetActionError::NoVault)?;

    let result = rename_media_asset_inner(&state, &vs.conn, &vs.vault, media_ref, new_stem)?;
    for slug in &result.affected_slugs {
        app.emit(
            "thumb:updated",
            ThumbUpdatedPayload {
                slug: slug.clone(),
                is_text: false,
            },
        )
        .map_err(|e| MediaAssetActionError::Internal {
            message: format!("failed to emit thumb:updated: {e}"),
        })?;
    }
    app.emit(
        "vault-changed",
        VaultChangedPayload {
            path: vs.vault.root().to_string_lossy().to_string(),
        },
    )
    .map_err(|e| MediaAssetActionError::Internal {
        message: format!("failed to emit vault-changed: {e}"),
    })?;

    Ok(result)
}

/// Prepare a destructive media-file delete by listing every card/note whose
/// Markdown currently references the selected local file.
#[tauri::command(rename_all = "snake_case")]
pub fn prepare_delete_media_asset(
    state: State<'_, AppState>,
    media_ref: String,
) -> Result<DeleteMediaAssetPlan, MediaAssetActionError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| MediaAssetActionError::Internal {
            message: "vault state mutex poisoned".into(),
        })?;
    let vs = vault_state.as_ref().ok_or(MediaAssetActionError::NoVault)?;

    prepare_delete_media_asset_inner(&vs.vault, media_ref)
}

/// Delete the selected media file and remove references to it from every
/// parseable Markdown card/note. Cards and notes stay in place.
#[tauri::command(rename_all = "snake_case")]
pub fn delete_media_asset(
    app: AppHandle,
    state: State<'_, AppState>,
    media_ref: String,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| MediaAssetActionError::Internal {
            message: "vault state mutex poisoned".into(),
        })?;
    let vs = vault_state.as_ref().ok_or(MediaAssetActionError::NoVault)?;

    let result = delete_media_asset_inner(&state, &vs.conn, &vs.vault, media_ref)?;
    for slug in &result.affected_slugs {
        app.emit(
            "thumb:updated",
            ThumbUpdatedPayload {
                slug: slug.clone(),
                is_text: false,
            },
        )
        .map_err(|e| MediaAssetActionError::Internal {
            message: format!("failed to emit thumb:updated: {e}"),
        })?;
    }
    app.emit(
        "vault-changed",
        VaultChangedPayload {
            path: vs.vault.root().to_string_lossy().to_string(),
        },
    )
    .map_err(|e| MediaAssetActionError::Internal {
        message: format!("failed to emit vault-changed: {e}"),
    })?;

    Ok(result)
}

/// Remove the selected media reference from one source card. The media file
/// itself remains on disk, and every other card/note keeps its references.
#[tauri::command(rename_all = "snake_case")]
pub fn remove_media_asset_from_card(
    app: AppHandle,
    state: State<'_, AppState>,
    media_ref: String,
    source_slug: String,
    reference_kind: String,
    occurrence_index: Option<usize>,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| MediaAssetActionError::Internal {
            message: "vault state mutex poisoned".into(),
        })?;
    let vs = vault_state.as_ref().ok_or(MediaAssetActionError::NoVault)?;

    let result = remove_media_asset_from_card_inner(
        &state,
        &vs.conn,
        &vs.vault,
        media_ref,
        source_slug,
        reference_kind,
        occurrence_index,
    )?;
    for slug in &result.affected_slugs {
        app.emit(
            "thumb:updated",
            ThumbUpdatedPayload {
                slug: slug.clone(),
                is_text: false,
            },
        )
        .map_err(|e| MediaAssetActionError::Internal {
            message: format!("failed to emit thumb:updated: {e}"),
        })?;
    }
    app.emit(
        "vault-changed",
        VaultChangedPayload {
            path: vs.vault.root().to_string_lossy().to_string(),
        },
    )
    .map_err(|e| MediaAssetActionError::Internal {
        message: format!("failed to emit vault-changed: {e}"),
    })?;

    Ok(result)
}

/// Copy the selected local media file as a native media/file object. This is
/// intentionally separate from Copy Path, which copies a plain string path.
#[tauri::command(rename_all = "snake_case")]
pub fn copy_media_asset_to_clipboard(
    state: State<'_, AppState>,
    media_ref: String,
) -> Result<(), MediaAssetActionError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| MediaAssetActionError::Internal {
            message: "vault state mutex poisoned".into(),
        })?;
    let vs = vault_state.as_ref().ok_or(MediaAssetActionError::NoVault)?;
    let media_path = resolve_media_asset_path(&vs.vault, &media_ref)?;
    let media_ref = vs
        .vault
        .root_relative_reference(&media_path)
        .ok_or_else(|| MediaAssetActionError::InvalidMediaRef {
            reason: "media reference must stay inside the vault".to_string(),
        })?;

    copy_media_path_to_clipboard(&media_path, &media_ref)
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

#[tauri::command(rename_all = "snake_case")]
pub async fn delete_text_selection(
    app: AppHandle,
    state: State<'_, AppState>,
    source_slug: String,
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
        delete_text_selection_inner(
            &conn,
            &vault,
            source_slug,
            selected_text,
            first_block_start,
            first_block_end,
            source_body_hash,
        )
    })
    .await
    .map_err(|e| TextSelectionExtractError::Internal {
        message: format!("text selection deletion worker failed: {e}"),
    })??;

    app.emit(
        "thumb:updated",
        ThumbUpdatedPayload {
            slug: indexed.slug.clone(),
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
    validate_collection_ref(&target_tag)
        .map_err(|reason| InlineMediaExtractError::InvalidMediaRef { reason })?;

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
    let source_card_kind = derive_card_kind(&source_block);
    if source_card_kind != CardKind::Article {
        return Err(InlineMediaExtractError::SourceNotArticle {
            source_slug: source_block.slug,
            block_type: source_card_kind.as_str().to_string(),
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
        body: String::new(),
    };

    let indexed =
        files::persist_new_reference_block(conn, vault, &block).map_err(internal_extract_error)?;
    Ok(indexed)
}

fn create_media_asset_card_inner(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    media_ref: String,
    target_tag: String,
    source_slug: Option<String>,
) -> Result<IndexedBlock, MediaAssetActionError> {
    let media_path = resolve_media_asset_path(vault, &media_ref)?;
    let media_ref = vault.root_relative_reference(&media_path).ok_or_else(|| {
        MediaAssetActionError::InvalidMediaRef {
            reason: "media reference must stay inside the vault".to_string(),
        }
    })?;
    let media_kind = media_asset_kind(&media_ref);
    if media_kind != BlockType::Image
        && media_kind != BlockType::Video
        && media_kind != BlockType::File
    {
        return Err(MediaAssetActionError::UnsupportedMediaKind { media_ref });
    }

    let target_tag = normalize_collection_ref(&target_tag);
    if !target_tag.is_empty() {
        validate_collection_ref(&target_tag)
            .map_err(|reason| MediaAssetActionError::InvalidMediaRef { reason })?;
    }

    let source_block = source_slug
        .as_deref()
        .and_then(|slug| read_optional_source_block(vault, slug).ok().flatten());
    let raw_slug = suggest_slug(Some(&extraction_slug_seed(&media_ref)), None);
    let source_ext = media_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let slug = resolve_unique_extraction_slug(conn, vault, &raw_slug, source_ext)
        .map_err(internal_media_asset_error)?;
    let now = crate::commands::state::now_iso8601();
    let saved_at = DateTime::new(&now).map_err(|e| MediaAssetActionError::Internal {
        message: e.to_string(),
    })?;

    let block = Block {
        slug: slug.clone(),
        frontmatter: Frontmatter {
            block_type: media_kind,
            title: None,
            description: None,
            url: source_block
                .as_ref()
                .and_then(|block| block.frontmatter.url.clone()),
            file: Some(media_ref.clone()),
            thumbnail: None,
            tags: if target_tag.is_empty() {
                Vec::new()
            } else {
                vec![target_tag]
            },
            related_notes: source_block
                .as_ref()
                .map(|block| vec![block.slug.clone()])
                .unwrap_or_default(),
            source_media: Some(media_ref),
            saved_at,
            source: Some("media-asset-action".to_string()),
            width: None,
            height: None,
            author: None,
            position: None,
            color: None,
            icon: None,
        },
        body: String::new(),
    };

    files::persist_new_reference_block(conn, vault, &block).map_err(internal_media_asset_error)
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
    if !target_tag.is_empty() {
        validate_collection_ref(&target_tag)
            .map_err(|reason| TextSelectionExtractError::InvalidCollectionRef { reason })?;
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
    let source_block = parsed.block;
    let source_card_kind = derive_card_kind(&source_block);
    if source_card_kind != CardKind::Article {
        return Err(TextSelectionExtractError::SourceNotArticle {
            source_slug: source_block.slug,
            block_type: source_card_kind.as_str().to_string(),
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
            tags: if target_tag.is_empty() {
                Vec::new()
            } else {
                vec![target_tag.clone()]
            },
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

    let patched_parsed = patched_source
        .as_ref()
        .map(|updated| {
            parse_markdown_document(&read_slug, updated, file_saved_at(&source_path)).map_err(|e| {
                TextSelectionExtractError::Internal {
                    message: format!("failed to parse patched source block: {e}"),
                }
            })
        })
        .transpose()?;
    let mut writes = Vec::with_capacity(2);
    if let Some(updated) = patched_source {
        writes.push(SourceFileWrite::replace(source_path, updated.into_bytes()));
    }
    writes.push(SourceFileWrite::create(
        vault.block_path(&block.slug),
        crate::domain::block::serialize_block(&block).into_bytes(),
    ));
    let staged = StagedSourceMutation::stage(writes).map_err(internal_text_selection_error)?;
    let indexed = staged
        .commit_with_index(conn, "extract_text_selection", |index_conn| {
            if let Some(reparsed) = patched_parsed.as_ref() {
                index::upsert_block_with_diagnostics(
                    index_conn,
                    &reparsed.block,
                    Some(vault.root()),
                    Some(&reparsed.origin),
                    reparsed.index_warning.as_deref(),
                )?;
            }
            index::upsert_block(index_conn, &block, Some(vault.root()))?;
            index::get_block(index_conn, &block.slug)?.ok_or_else(|| {
                anyhow::anyhow!("extracted text block missing after transactional create")
            })
        })
        .map_err(internal_text_selection_error)?;
    let _ = thumbnails::generate_for_block(&block, vault);
    let _ = index::sync_thumb_metadata(
        conn,
        &block.slug,
        &vault.thumb_path(&block.slug),
        Some(vault.root()),
    );
    Ok(indexed)
}

#[allow(clippy::too_many_arguments)]
fn delete_text_selection_inner(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    source_slug: String,
    selected_text: String,
    first_block_start: usize,
    first_block_end: usize,
    source_body_hash: String,
) -> Result<IndexedBlock, TextSelectionExtractError> {
    validate_slug(&source_slug).map_err(|e| TextSelectionExtractError::UnsafeSourcePatch {
        reason: format!("invalid source slug: {e}"),
    })?;

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
    let source_block = parsed.block;
    let source_card_kind = derive_card_kind(&source_block);
    if source_card_kind != CardKind::Article {
        return Err(TextSelectionExtractError::SourceNotArticle {
            source_slug: source_block.slug,
            block_type: source_card_kind.as_str().to_string(),
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
    let (selection_start, selection_end) =
        selected_text_source_span(&source_block.body, selected_text).ok_or_else(|| {
            TextSelectionExtractError::UnsupportedSelectionShape {
                reason: "selected text could not be located in the current source body".to_string(),
            }
        })?;
    if selection_start < block_start || selection_start >= block_end {
        return Err(TextSelectionExtractError::UnsupportedSelectionShape {
            reason: "selected text does not belong to the provided source block range".to_string(),
        });
    }

    let body_start_offset = source_body_start_offset(&content, &source_origin)?;
    let content_start = body_start_offset
        .checked_add(selection_start)
        .ok_or_else(|| TextSelectionExtractError::UnsafeSourcePatch {
            reason: "source patch start offset overflowed".to_string(),
        })?;
    let content_end = body_start_offset
        .checked_add(selection_end)
        .ok_or_else(|| TextSelectionExtractError::UnsafeSourcePatch {
            reason: "source patch end offset overflowed".to_string(),
        })?;
    if content_start > content_end
        || content_end > content.len()
        || !content.is_char_boundary(content_start)
        || !content.is_char_boundary(content_end)
    {
        return Err(TextSelectionExtractError::UnsafeSourcePatch {
            reason: "source patch range is not a valid UTF-8 boundary".to_string(),
        });
    }

    let mut updated = content.clone();
    updated.replace_range(content_start..content_end, "");
    let reparsed = parse_markdown_document(&read_slug, &updated, file_saved_at(&source_path))
        .map_err(|e| TextSelectionExtractError::Internal {
            message: format!("failed to parse patched source block: {e}"),
        })?;
    let staged = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
        source_path,
        updated.into_bytes(),
    )])
    .map_err(internal_text_selection_error)?;
    let indexed = staged
        .commit_with_index(conn, "delete_text_selection", |index_conn| {
            index::upsert_block_with_diagnostics(
                index_conn,
                &reparsed.block,
                Some(vault.root()),
                Some(&reparsed.origin),
                reparsed.index_warning.as_deref(),
            )?;
            index::get_block(index_conn, &reparsed.block.slug)?.ok_or_else(|| {
                anyhow::anyhow!(
                    "source block '{}' missing after text deletion",
                    reparsed.block.slug
                )
            })
        })
        .map_err(internal_text_selection_error)?;
    let _ = thumbnails::generate_for_block(&reparsed.block, vault);
    let _ = index::sync_thumb_metadata(
        conn,
        &reparsed.block.slug,
        &vault.thumb_path(&reparsed.block.slug),
        Some(vault.root()),
    );
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

    delete_block_inner(&state, &vs.conn, &vs.vault, &slug, delete_unused_media)
}

fn delete_block_inner(
    state: &AppState,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    slug: &str,
    delete_unused_media: Option<bool>,
) -> Result<bool, CommandError> {
    validate_slug(slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let plan = build_delete_block_plan(conn, vault, slug)?;

    let media_paths: BTreeSet<PathBuf> = match delete_unused_media {
        Some(true) => plan
            .unused_media
            .iter()
            .map(|media| media.absolute_path.clone())
            .collect(),
        Some(false) => BTreeSet::new(),
        None => plan
            .unused_media
            .iter()
            .filter(|media| media.slug_owned_primary)
            .map(|media| media.absolute_path.clone())
            .collect(),
    };

    let markdown_path = vault.block_path(slug);
    let mut source_paths = BTreeSet::from([markdown_path]);
    source_paths.extend(media_paths);
    state.suppress_paths(
        source_paths.iter().cloned(),
        Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
    )?;

    let staged = StagedSourceMutation::stage(
        source_paths
            .iter()
            .filter(|path| path.exists())
            .cloned()
            .map(SourceFileWrite::delete)
            .collect(),
    )
    .map_err(|error| CommandError::Internal(error.to_string()))?;

    let removed = staged
        .commit_with_index(conn, "delete_block", |index_conn| {
            index::remove_block(index_conn, slug)
        })
        .map_err(|error| CommandError::Internal(error.to_string()))?;

    let thumb_path = vault.thumb_path(slug);
    if thumb_path.exists() {
        let _ = std::fs::remove_file(&thumb_path);
    }
    if let Err(e) = article_audio::delete_all_artifacts(vault, slug) {
        log::warn!("failed to delete article audio for {slug}: {e:#}");
    }

    Ok(removed)
}

/// Merge selected cards into one new article card while preserving media files
/// and rewriting external card-to-card references to the new card.
#[tauri::command(rename_all = "snake_case")]
pub fn merge_blocks(
    app: AppHandle,
    state: State<'_, AppState>,
    ordered_slugs: Vec<String>,
) -> Result<MergeBlocksResult, MergeBlocksError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| MergeBlocksError::Internal {
            message: "vault state mutex poisoned".into(),
        })?;
    let vs = vault_state.as_ref().ok_or(MergeBlocksError::NoVault)?;

    let mutation = merge_blocks_inner(&state, &vs.conn, &vs.vault, ordered_slugs)?;
    let result = mutation.result;

    app.emit(
        "block:added",
        BlockAddedPayload {
            slug: result.merged_slug.clone(),
            tags: result.block.tags.clone(),
            is_text: true,
        },
    )
    .map_err(internal_merge_error)?;
    app.emit(
        "thumb:updated",
        ThumbUpdatedPayload {
            slug: result.merged_slug.clone(),
            is_text: true,
        },
    )
    .map_err(internal_merge_error)?;
    for event in mutation.removed_events {
        app.emit("block:removed", event)
            .map_err(internal_merge_error)?;
    }
    app.emit(
        "vault-changed",
        VaultChangedPayload {
            path: vs.vault.root().to_string_lossy().to_string(),
        },
    )
    .map_err(internal_merge_error)?;

    Ok(result)
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

fn merge_blocks_inner(
    state: &AppState,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    ordered_slugs: Vec<String>,
) -> Result<MergeBlocksMutation, MergeBlocksError> {
    let ordered_slugs = validate_merge_slugs(ordered_slugs)?;
    let selected_slugs: BTreeSet<String> = ordered_slugs.iter().cloned().collect();
    let sources = load_merge_source_blocks(vault, &ordered_slugs)?;
    let removed_events = sources
        .iter()
        .map(|source| BlockRemovedPayload {
            slug: source.block.slug.clone(),
            tags: source.block.frontmatter.tags.clone(),
        })
        .collect();
    let mut merged_block = build_merged_block(conn, vault, &sources, &selected_slugs)?;
    merged_block.body =
        rewrite_body_selected_wikilinks(&merged_block.body, &selected_slugs, &merged_block.slug);
    let reference_writes =
        build_merge_reference_writes(vault, &selected_slugs, &merged_block.slug)?;

    let merged_path = vault.block_path(&merged_block.slug);
    let mut suppressed_paths = vec![merged_path.clone(), vault.thumb_path(&merged_block.slug)];
    suppressed_paths.extend(
        sources
            .iter()
            .flat_map(|source| [source.path.clone(), vault.thumb_path(&source.block.slug)]),
    );
    suppressed_paths.extend(
        reference_writes
            .iter()
            .flat_map(|write| [write.path.clone(), vault.thumb_path(&write.block.slug)]),
    );
    state
        .suppress_paths(
            suppressed_paths,
            Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
        )
        .map_err(internal_merge_error)?;

    let indexed = apply_merge_blocks(conn, vault, &merged_block, &sources, &reference_writes)?;
    let merged_slug = indexed.slug.clone();

    Ok(MergeBlocksMutation {
        result: MergeBlocksResult {
            block: indexed,
            merged_slug,
            removed_slugs: ordered_slugs,
        },
        removed_events,
    })
}

fn apply_merge_blocks(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    merged_block: &Block,
    sources: &[MergeSourceBlock],
    reference_writes: &[MergeReferenceWrite],
) -> Result<IndexedBlock, MergeBlocksError> {
    let mut writes = Vec::with_capacity(1 + reference_writes.len() + sources.len());
    writes.push(SourceFileWrite::create(
        vault.block_path(&merged_block.slug),
        crate::domain::block::serialize_block(merged_block).into_bytes(),
    ));
    writes.extend(reference_writes.iter().map(|write| {
        SourceFileWrite::replace(
            write.path.clone(),
            crate::domain::block::serialize_block(&write.block).into_bytes(),
        )
    }));
    writes.extend(
        sources
            .iter()
            .map(|source| SourceFileWrite::delete(source.path.clone())),
    );
    let staged = StagedSourceMutation::stage(writes).map_err(internal_merge_error)?;
    let indexed = staged
        .commit_with_index(conn, "merge_blocks", |index_conn| {
            index::upsert_block(index_conn, merged_block, Some(vault.root()))?;
            for write in reference_writes {
                index::upsert_block(index_conn, &write.block, Some(vault.root()))?;
            }
            for source in sources {
                index::remove_block(index_conn, &source.block.slug)?;
            }
            index::get_block(index_conn, &merged_block.slug)?.ok_or_else(|| {
                anyhow::anyhow!("merged block '{}' missing from index", merged_block.slug)
            })
        })
        .map_err(internal_merge_error)?;

    let thumb_path = vault.thumb_path(&merged_block.slug);
    let thumb_source = thumbnails::generate_for_block(merged_block, vault);
    if matches!(thumb_source, thumbnails::ThumbSource::None) && thumb_path.exists() {
        let _ = std::fs::remove_file(&thumb_path);
    }
    let _ = index::sync_thumb_metadata(conn, &merged_block.slug, &thumb_path, Some(vault.root()));

    for write in reference_writes {
        let reference_thumb = vault.thumb_path(&write.block.slug);
        let source = thumbnails::generate_for_block(&write.block, vault);
        if matches!(source, thumbnails::ThumbSource::None) && reference_thumb.exists() {
            let _ = std::fs::remove_file(&reference_thumb);
        }
        let _ = index::sync_thumb_metadata(
            conn,
            &write.block.slug,
            &reference_thumb,
            Some(vault.root()),
        );
    }
    for source in sources {
        let source_thumb_path = vault.thumb_path(&source.block.slug);
        if source_thumb_path.exists() {
            let _ = std::fs::remove_file(source_thumb_path);
        }
        if let Err(e) = article_audio::delete_all_artifacts(vault, &source.block.slug) {
            log::warn!(
                "failed to delete article audio for merged source {}: {e:#}",
                source.block.slug
            );
        }
    }

    Ok(indexed)
}

fn validate_merge_slugs(ordered_slugs: Vec<String>) -> Result<Vec<String>, MergeBlocksError> {
    if ordered_slugs.len() < 2 {
        return Err(MergeBlocksError::TooFewCards);
    }
    let mut seen = BTreeSet::new();
    for slug in &ordered_slugs {
        validate_slug(slug).map_err(|e| MergeBlocksError::InvalidSlug {
            slug: slug.clone(),
            reason: e.to_string(),
        })?;
        if !seen.insert(slug.clone()) {
            return Err(MergeBlocksError::DuplicateSlug { slug: slug.clone() });
        }
    }
    Ok(ordered_slugs)
}

fn load_merge_source_blocks(
    vault: &VaultLayout,
    ordered_slugs: &[String],
) -> Result<Vec<MergeSourceBlock>, MergeBlocksError> {
    let mut sources = Vec::with_capacity(ordered_slugs.len());
    for slug in ordered_slugs {
        let path = vault.block_path(slug);
        if !path.exists() {
            return Err(MergeBlocksError::BlockNotFound { slug: slug.clone() });
        }
        let (read_slug, content) =
            files::read_block_file(vault, &path).map_err(internal_merge_error)?;
        let parsed =
            parse_markdown_document(&read_slug, &content, file_saved_at(&path)).map_err(|e| {
                MergeBlocksError::Internal {
                    message: format!("failed to parse source card '{}': {e}", path.display()),
                }
            })?;
        if derive_card_kind(&parsed.block) == CardKind::Channel {
            return Err(MergeBlocksError::BlockNotMergeable {
                slug: parsed.block.slug,
                block_type: "channel".to_string(),
            });
        }
        sources.push(MergeSourceBlock {
            path,
            block: parsed.block,
        });
    }
    Ok(sources)
}

fn build_merged_block(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    sources: &[MergeSourceBlock],
    selected_slugs: &BTreeSet<String>,
) -> Result<Block, MergeBlocksError> {
    let first = sources.first().ok_or(MergeBlocksError::TooFewCards)?;
    let title_fields = derive_title_fields(
        &first.block.slug,
        first.block.frontmatter.title.as_deref(),
        &first.block.body,
    );
    let slug_seed = format!(
        "{} — merged",
        title_fields
            .display_title
            .as_deref()
            .unwrap_or(&title_fields.fallback_label)
    );
    let raw_slug = suggest_slug(Some(&slug_seed), None);
    let slug =
        resolve_unique_block_slug(conn, vault, &raw_slug, None).map_err(internal_merge_error)?;
    let now = crate::commands::state::now_iso8601();
    let saved_at = DateTime::new(&now).map_err(internal_merge_error)?;

    let mut tags = Vec::new();
    let mut related_notes = Vec::new();
    for source in sources {
        for tag in &source.block.frontmatter.tags {
            push_unique(&mut tags, tag.clone());
        }
        for note in &source.block.frontmatter.related_notes {
            if selected_slugs.contains(related_note_base(note)) {
                continue;
            }
            push_unique(&mut related_notes, note.clone());
        }
    }

    let body = sources
        .iter()
        .map(|source| merged_section_body(&source.block))
        .filter(|section| !section.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    Ok(Block {
        slug,
        frontmatter: Frontmatter {
            block_type: BlockType::Article,
            title: None,
            description: first_non_empty_frontmatter(sources, |frontmatter| {
                frontmatter.description.as_ref()
            }),
            url: first_safe_url_frontmatter(sources),
            file: None,
            thumbnail: None,
            tags,
            related_notes,
            source_media: None,
            saved_at,
            source: Some("card-merge".to_string()),
            width: None,
            height: None,
            author: first_non_empty_frontmatter(sources, |frontmatter| frontmatter.author.as_ref()),
            position: None,
            color: None,
            icon: None,
        },
        body,
    })
}

fn build_merge_reference_writes(
    vault: &VaultLayout,
    selected_slugs: &BTreeSet<String>,
    merged_slug: &str,
) -> Result<Vec<MergeReferenceWrite>, MergeBlocksError> {
    let mut writes = Vec::new();
    for path in files::scan_md_files(vault).map_err(internal_merge_error)? {
        let Some(slug) = vault.slug_for_path(&path).ok() else {
            continue;
        };
        if selected_slugs.contains(&slug) {
            continue;
        }
        let (_, content) = files::read_block_file(vault, &path).map_err(internal_merge_error)?;
        if !selected_slugs
            .iter()
            .any(|selected| content.contains(selected))
        {
            continue;
        }
        let parsed =
            parse_markdown_document(&slug, &content, file_saved_at(&path)).map_err(|e| {
                MergeBlocksError::ReferenceRewriteFailed {
                    path: path.to_string_lossy().to_string(),
                    message: e.to_string(),
                }
            })?;
        let rewritten = rewrite_merge_references(&parsed.block, selected_slugs, merged_slug);
        if rewritten.frontmatter != parsed.block.frontmatter || rewritten.body != parsed.block.body
        {
            writes.push(MergeReferenceWrite {
                path,
                block: rewritten,
            });
        }
    }
    Ok(writes)
}

fn rewrite_merge_references(
    block: &Block,
    selected_slugs: &BTreeSet<String>,
    merged_slug: &str,
) -> Block {
    let mut rewritten = block.clone();
    for note in &mut rewritten.frontmatter.related_notes {
        if let Some(selected_slug) = selected_slugs
            .iter()
            .find(|selected| related_note_base(note) == selected.as_str())
        {
            if let Some(updated) = rewrite_related_note_target(note, selected_slug, merged_slug) {
                *note = updated;
            }
        }
    }
    dedupe_strings(&mut rewritten.frontmatter.related_notes);
    rewritten.body = rewrite_body_selected_wikilinks(&rewritten.body, selected_slugs, merged_slug);
    rewritten
}

fn rewrite_body_selected_wikilinks(
    body: &str,
    selected_slugs: &BTreeSet<String>,
    merged_slug: &str,
) -> String {
    selected_slugs
        .iter()
        .fold(body.to_string(), |current, slug| {
            rename_wikilink_targets(&current, slug, merged_slug)
        })
}

fn merged_section_body(block: &Block) -> String {
    let mut parts = Vec::new();
    let body = block.body.trim();
    if let Some(file) = trimmed_option(block.frontmatter.file.as_deref()) {
        if body.is_empty() || !body.contains(file) {
            parts.push(format!("![[{file}]]"));
        }
    }
    if !body.is_empty() {
        parts.push(body.to_string());
    }
    if parts.is_empty() {
        if let Some(url) = safe_source_url(block.frontmatter.url.as_deref()) {
            parts.push(markdown_link(&merge_block_label(block), url));
        } else {
            parts.push(merge_block_label(block));
        }
    }
    if let Some(url) = safe_source_url(block.frontmatter.url.as_deref()) {
        parts.push(format!(
            "Source: {}",
            markdown_link(&source_markdown_label(url), url)
        ));
    }
    if let Some(author) = trimmed_option(block.frontmatter.author.as_deref()) {
        parts.push(format!("Author: {author}"));
    }
    parts.join("\n\n")
}

fn merge_block_label(block: &Block) -> String {
    let title_fields =
        derive_title_fields(&block.slug, block.frontmatter.title.as_deref(), &block.body);
    title_fields
        .display_title
        .unwrap_or(title_fields.fallback_label)
}

fn first_non_empty_frontmatter(
    sources: &[MergeSourceBlock],
    pick: impl for<'a> Fn(&'a Frontmatter) -> Option<&'a String>,
) -> Option<String> {
    sources.iter().find_map(|source| {
        pick(&source.block.frontmatter)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn first_safe_url_frontmatter(sources: &[MergeSourceBlock]) -> Option<String> {
    sources.iter().find_map(|source| {
        safe_source_url(source.block.frontmatter.url.as_deref()).map(ToOwned::to_owned)
    })
}

fn safe_source_url(value: Option<&str>) -> Option<&str> {
    let value = trimmed_option(value)?;
    let parsed = url::Url::parse(value).ok()?;
    matches!(parsed.scheme(), "http" | "https").then_some(value)
}

fn source_markdown_label(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(ToOwned::to_owned))
        .map(|host| host.strip_prefix("www.").unwrap_or(&host).to_string())
        .filter(|host| !host.trim().is_empty())
        .unwrap_or_else(|| "Source".to_string())
}

fn markdown_link(label: &str, url: &str) -> String {
    let safe_label = label.replace('[', "\\[").replace(']', "\\]");
    let safe_url = url.trim().replace('>', "%3E");
    format!("[{safe_label}](<{safe_url}>)")
}

fn trimmed_option(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn related_note_base(note: &str) -> &str {
    note.split_once('#').map_or(note, |(base, _)| base)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn dedupe_strings(values: &mut Vec<String>) {
    let mut seen = BTreeSet::new();
    values.retain(|value| seen.insert(value.clone()));
}

pub(crate) fn collect_delete_media_for_block(
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

fn rename_media_asset_inner(
    state: &AppState,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    media_ref: String,
    new_stem: String,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    let old_path = resolve_media_asset_path(vault, &media_ref)?;
    let old_ref = vault.root_relative_reference(&old_path).ok_or_else(|| {
        MediaAssetActionError::InvalidMediaRef {
            reason: "media reference must stay inside the vault".to_string(),
        }
    })?;
    let new_ref = renamed_media_ref(&old_ref, &new_stem)?;
    let new_path = vault.root().join(&new_ref);
    if new_path.exists() {
        return Err(MediaAssetActionError::NameTaken { target: new_ref });
    }

    let planned_writes = build_media_asset_reference_writes(vault, &old_path, &new_ref)?;
    state
        .suppress_paths(
            std::iter::once(old_path.clone())
                .chain(std::iter::once(new_path.clone()))
                .chain(planned_writes.iter().map(|write| write.path.clone())),
            Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
        )
        .map_err(internal_media_asset_error)?;

    let mut source_writes = planned_writes
        .iter()
        .map(|write| {
            SourceFileWrite::replace(
                write.path.clone(),
                crate::domain::block::serialize_block(&write.block).into_bytes(),
            )
        })
        .collect::<Vec<_>>();
    source_writes.push(SourceFileWrite::rename(old_path, new_path));
    let staged = StagedSourceMutation::stage(source_writes).map_err(internal_media_asset_error)?;
    staged
        .commit_with_index(conn, "rename_media_asset", |index_conn| {
            for write in &planned_writes {
                index::upsert_block(index_conn, &write.block, Some(vault.root()))?;
            }
            Ok(())
        })
        .map_err(internal_media_asset_error)?;

    let mut affected_slugs = Vec::new();
    for write in planned_writes {
        let _ = thumbnails::generate_for_block(&write.block, vault);
        let _ = index::sync_thumb_metadata(
            conn,
            &write.block.slug,
            &vault.thumb_path(&write.block.slug),
            Some(vault.root()),
        );
        affected_slugs.push(write.block.slug);
    }
    affected_slugs.sort();
    affected_slugs.dedup();

    Ok(MediaAssetMutationResult {
        media_ref: old_ref,
        new_media_ref: Some(new_ref),
        affected_slugs,
    })
}

fn delete_media_asset_inner(
    state: &AppState,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    media_ref: String,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    let media_path = resolve_media_asset_path(vault, &media_ref)?;
    let media_ref = vault.root_relative_reference(&media_path).ok_or_else(|| {
        MediaAssetActionError::InvalidMediaRef {
            reason: "media reference must stay inside the vault".to_string(),
        }
    })?;
    let planned_writes = build_media_asset_removal_writes(vault, &media_path)?;
    let mut suppressed_paths = vec![media_path.clone()];
    for write in &planned_writes {
        suppressed_paths.push(write.path.clone());
        suppressed_paths.push(vault.thumb_path(&write.block.slug));
    }
    state
        .suppress_paths(
            suppressed_paths,
            Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
        )
        .map_err(internal_media_asset_error)?;

    let source_writes = planned_writes
        .iter()
        .map(|write| {
            SourceFileWrite::replace(
                write.path.clone(),
                crate::domain::block::serialize_block(&write.block).into_bytes(),
            )
        })
        .chain(std::iter::once(SourceFileWrite::delete(media_path.clone())))
        .collect();
    let staged = StagedSourceMutation::stage(source_writes).map_err(internal_media_asset_error)?;
    staged
        .commit_with_index(conn, "delete_media_asset", |index_conn| {
            for write in &planned_writes {
                index::upsert_block(index_conn, &write.block, Some(vault.root()))?;
            }
            Ok(())
        })
        .map_err(internal_media_asset_error)?;

    let mut affected_slugs = Vec::new();
    for write in planned_writes {
        let thumb_path = vault.thumb_path(&write.block.slug);
        let thumb_source = thumbnails::generate_for_block(&write.block, vault);
        if matches!(thumb_source, thumbnails::ThumbSource::None) && thumb_path.exists() {
            let _ = std::fs::remove_file(&thumb_path);
        }
        let _ =
            index::sync_thumb_metadata(conn, &write.block.slug, &thumb_path, Some(vault.root()));
        affected_slugs.push(write.block.slug);
    }
    affected_slugs.sort();
    affected_slugs.dedup();

    Ok(MediaAssetMutationResult {
        media_ref,
        new_media_ref: None,
        affected_slugs,
    })
}

fn remove_media_asset_from_card_inner(
    state: &AppState,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    media_ref: String,
    source_slug: String,
    reference_kind: String,
    occurrence_index: Option<usize>,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    validate_slug(&source_slug).map_err(|e| MediaAssetActionError::InvalidMediaRef {
        reason: format!("invalid source slug: {e}"),
    })?;
    let media_path = resolve_media_asset_path(vault, &media_ref)?;
    let media_ref = vault.root_relative_reference(&media_path).ok_or_else(|| {
        MediaAssetActionError::InvalidMediaRef {
            reason: "media reference must stay inside the vault".to_string(),
        }
    })?;

    let source_path = vault.block_path(&source_slug);
    if !source_path.exists() {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: format!("source card not found: {source_slug}"),
        });
    }

    let (read_slug, content) =
        files::read_block_file(vault, &source_path).map_err(internal_media_asset_error)?;
    let parsed = parse_markdown_document(&read_slug, &content, file_saved_at(&source_path))
        .map_err(|e| MediaAssetActionError::Internal {
            message: format!("failed to parse source card: {e}"),
        })?;
    let mut block = parsed.block;
    let mut changed = false;

    match reference_kind.as_str() {
        "frontmatter_file" => {
            if block
                .frontmatter
                .file
                .as_deref()
                .and_then(|reference| {
                    media_refs::resolve_indexed_media(vault, &block.slug, reference)
                })
                .is_some_and(|path| same_path(&path, &media_path))
            {
                block.frontmatter.file = None;
                changed = true;
            }
            if block
                .frontmatter
                .thumbnail
                .as_deref()
                .and_then(|reference| {
                    media_refs::resolve_indexed_media(vault, &block.slug, reference)
                })
                .is_some_and(|path| same_path(&path, &media_path))
            {
                block.frontmatter.thumbnail = None;
                changed = true;
            }
        }
        "body_embed" => {
            let mut removals = BTreeSet::new();
            for reference in iter_inline_media_references(&block.body) {
                if media_refs::resolve_inline_media(vault, &block.slug, &reference)
                    .is_some_and(|path| same_path(&path, &media_path))
                {
                    removals.insert(reference.source);
                }
            }
            // With a specific occurrence (duplicate embed of the same media in
            // one card), drop only that embed; otherwise remove every match.
            let next_body = match occurrence_index {
                Some(index) => remove_inline_media_reference_at(&block.body, &removals, index),
                None => remove_inline_media_references(&block.body, &removals),
            };
            if next_body != block.body {
                block.body = next_body;
                changed = true;
            }
        }
        _ => {
            return Err(MediaAssetActionError::InvalidMediaRef {
                reason: "reference kind must be frontmatter_file or body_embed".to_string(),
            });
        }
    }

    if !changed {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: format!("media is not attached to source card: {source_slug}"),
        });
    }

    let thumb_path = vault.thumb_path(&block.slug);
    state
        .suppress_paths(
            [source_path.clone(), thumb_path.clone()],
            Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
        )
        .map_err(internal_media_asset_error)?;

    let serialized = crate::domain::block::serialize_block(&block);
    let staged = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
        source_path,
        serialized.into_bytes(),
    )])
    .map_err(internal_media_asset_error)?;
    staged
        .commit_with_index(conn, "detach_media_asset", |index_conn| {
            index::upsert_block(index_conn, &block, Some(vault.root())).map(|_| ())
        })
        .map_err(internal_media_asset_error)?;
    let thumb_source = thumbnails::generate_for_block(&block, vault);
    if matches!(thumb_source, thumbnails::ThumbSource::None) && thumb_path.exists() {
        let _ = std::fs::remove_file(&thumb_path);
    }
    let _ = index::sync_thumb_metadata(conn, &block.slug, &thumb_path, Some(vault.root()));

    Ok(MediaAssetMutationResult {
        media_ref,
        new_media_ref: None,
        affected_slugs: vec![block.slug],
    })
}

#[cfg(target_os = "macos")]
fn copy_media_path_to_clipboard(
    media_path: &Path,
    _media_ref: &str,
) -> Result<(), MediaAssetActionError> {
    let script = r#"
on run argv
  set mediaPath to item 1 of argv
  set the clipboard to (POSIX file mediaPath)
end run
"#;
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .arg(media_path.to_string_lossy().to_string())
        .output()
        .map_err(internal_media_asset_error)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(MediaAssetActionError::Internal {
        message: if stderr.is_empty() {
            "failed to copy media file to clipboard".to_string()
        } else {
            stderr
        },
    })
}

#[cfg(not(target_os = "macos"))]
fn copy_media_path_to_clipboard(
    _media_path: &Path,
    media_ref: &str,
) -> Result<(), MediaAssetActionError> {
    Err(MediaAssetActionError::ClipboardUnsupported {
        media_ref: media_ref.to_string(),
    })
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

fn validate_media_asset_ref(media_ref: &str) -> Result<(), MediaAssetActionError> {
    let trimmed = media_ref.trim();
    if trimmed.is_empty() {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: "media reference is empty".to_string(),
        });
    }
    if trimmed != media_ref {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: "media reference has leading or trailing whitespace".to_string(),
        });
    }
    if media_ref.starts_with("http://") || media_ref.starts_with("https://") {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: "remote media is not supported".to_string(),
        });
    }
    if Path::new(media_ref).is_absolute() {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: "absolute media paths are not supported".to_string(),
        });
    }
    if media_ref.contains('\\') || media_ref.contains('\0') {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: "media reference contains an invalid path separator".to_string(),
        });
    }
    for segment in media_ref.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(MediaAssetActionError::InvalidMediaRef {
                reason: "media reference cannot contain path traversal".to_string(),
            });
        }
    }
    Ok(())
}

fn resolve_media_asset_path(
    vault: &VaultLayout,
    media_ref: &str,
) -> Result<PathBuf, MediaAssetActionError> {
    validate_media_asset_ref(media_ref)?;
    let root = vault
        .root()
        .canonicalize()
        .map_err(internal_media_asset_error)?;
    let candidate = vault.root().join(media_ref);
    let path = candidate
        .canonicalize()
        .map_err(|_| MediaAssetActionError::MediaNotFound {
            media_ref: media_ref.to_string(),
        })?;
    if !path.starts_with(&root) {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: "media reference must stay inside the vault".to_string(),
        });
    }
    if !path.is_file() {
        return Err(MediaAssetActionError::MediaNotFound {
            media_ref: media_ref.to_string(),
        });
    }
    Ok(candidate)
}

fn media_asset_kind(media_ref: &str) -> BlockType {
    let ext = Path::new(media_ref)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if thumbnails::is_image_ext(&ext) {
        BlockType::Image
    } else if thumbnails::is_video_ext(&ext) {
        BlockType::Video
    } else {
        BlockType::File
    }
}

fn read_optional_source_block(
    vault: &VaultLayout,
    source_slug: &str,
) -> Result<Option<Block>, MediaAssetActionError> {
    validate_slug(source_slug).map_err(|e| MediaAssetActionError::InvalidMediaRef {
        reason: format!("invalid source slug: {e}"),
    })?;
    let path = vault.block_path(source_slug);
    if !path.exists() {
        return Ok(None);
    }
    let (read_slug, content) =
        files::read_block_file(vault, &path).map_err(internal_media_asset_error)?;
    let parsed =
        parse_markdown_document(&read_slug, &content, file_saved_at(&path)).map_err(|e| {
            MediaAssetActionError::Internal {
                message: format!("failed to parse source block: {e}"),
            }
        })?;
    Ok(Some(parsed.block))
}

fn renamed_media_ref(old_ref: &str, new_stem: &str) -> Result<String, MediaAssetActionError> {
    let trimmed = new_stem.trim();
    if trimmed.is_empty() {
        return Err(MediaAssetActionError::InvalidFilename {
            reason: "filename is empty".to_string(),
        });
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err(MediaAssetActionError::InvalidFilename {
            reason: "media filename cannot contain path separators".to_string(),
        });
    }
    let normalized_stem = normalize_filename_stem(trimmed.trim_end_matches('.').trim());
    if normalized_stem.is_empty() || normalized_stem == "." || normalized_stem == ".." {
        return Err(MediaAssetActionError::InvalidFilename {
            reason: "filename is invalid".to_string(),
        });
    }
    let old_path = Path::new(old_ref);
    let extension = old_path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| MediaAssetActionError::InvalidMediaRef {
            reason: "media file must have an extension".to_string(),
        })?;
    let file_name = format!("{normalized_stem}.{extension}");
    Ok(
        match old_path.parent().and_then(|parent| {
            if parent.as_os_str().is_empty() {
                None
            } else {
                parent.to_str()
            }
        }) {
            Some(parent) => format!("{parent}/{file_name}"),
            None => file_name,
        },
    )
}

fn build_media_asset_reference_writes(
    vault: &VaultLayout,
    old_path: &Path,
    new_ref: &str,
) -> Result<Vec<MediaAssetBlockWrite>, MediaAssetActionError> {
    let mut writes = Vec::new();
    for path in files::scan_md_files(vault).map_err(internal_media_asset_error)? {
        let block = read_media_asset_action_block(vault, &path)?;
        let rewritten = rewrite_block_media_asset_references(vault, &block, old_path, new_ref);
        if rewritten.frontmatter != block.frontmatter || rewritten.body != block.body {
            writes.push(MediaAssetBlockWrite {
                path,
                block: rewritten,
            });
        }
    }
    Ok(writes)
}

fn prepare_delete_media_asset_inner(
    vault: &VaultLayout,
    media_ref: String,
) -> Result<DeleteMediaAssetPlan, MediaAssetActionError> {
    let media_path = resolve_media_asset_path(vault, &media_ref)?;
    let media_ref = vault.root_relative_reference(&media_path).ok_or_else(|| {
        MediaAssetActionError::InvalidMediaRef {
            reason: "media reference must stay inside the vault".to_string(),
        }
    })?;
    let media_kind = delete_media_kind(&media_ref).to_string();
    let referenced_by = collect_media_asset_reference_blocks(vault, &media_path)?;

    Ok(DeleteMediaAssetPlan {
        media_ref,
        media_kind,
        referenced_by,
    })
}

fn build_media_asset_removal_writes(
    vault: &VaultLayout,
    media_path: &Path,
) -> Result<Vec<MediaAssetBlockWrite>, MediaAssetActionError> {
    let mut writes = Vec::new();
    for path in files::scan_md_files(vault).map_err(internal_media_asset_error)? {
        let block = read_media_asset_action_block(vault, &path)?;
        if let Some(rewritten) = remove_block_media_asset_references(vault, &block, media_path) {
            writes.push(MediaAssetBlockWrite {
                path,
                block: rewritten,
            });
        }
    }
    Ok(writes)
}

fn collect_media_asset_reference_blocks(
    vault: &VaultLayout,
    media_path: &Path,
) -> Result<Vec<MediaAssetReferenceBlock>, MediaAssetActionError> {
    let mut blocks = Vec::new();
    for path in files::scan_md_files(vault).map_err(internal_media_asset_error)? {
        let block = read_media_asset_action_block(vault, &path)?;
        let reference_kinds = media_asset_reference_kinds(vault, &block, media_path);
        if reference_kinds.is_empty() {
            continue;
        }

        let title_fields =
            derive_title_fields(&block.slug, block.frontmatter.title.as_deref(), &block.body);
        blocks.push(MediaAssetReferenceBlock {
            slug: block.slug.clone(),
            title: title_fields.legacy_title,
            display_title: title_fields.display_title,
            fallback_label: title_fields.fallback_label,
            card_kind: derive_card_kind(&block),
            reference_kinds,
        });
    }
    blocks.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(blocks)
}

fn read_media_asset_action_block(
    vault: &VaultLayout,
    path: &Path,
) -> Result<Block, MediaAssetActionError> {
    let (slug, content) =
        files::read_block_file(vault, path).map_err(internal_media_asset_error)?;
    let parsed = parse_markdown_document(&slug, &content, file_saved_at(path)).map_err(|e| {
        MediaAssetActionError::Internal {
            message: format!("failed to parse {}: {e}", path.display()),
        }
    })?;
    Ok(parsed.block)
}

fn rewrite_block_media_asset_references(
    vault: &VaultLayout,
    block: &Block,
    old_path: &Path,
    new_ref: &str,
) -> Block {
    let mut rewritten = block.clone();
    if block
        .frontmatter
        .file
        .as_deref()
        .and_then(|reference| media_refs::resolve_indexed_media(vault, &block.slug, reference))
        .is_some_and(|path| same_path(&path, old_path))
    {
        rewritten.frontmatter.file = Some(new_ref.to_string());
    }
    if block
        .frontmatter
        .thumbnail
        .as_deref()
        .and_then(|reference| media_refs::resolve_indexed_media(vault, &block.slug, reference))
        .is_some_and(|path| same_path(&path, old_path))
    {
        rewritten.frontmatter.thumbnail = Some(new_ref.to_string());
    }

    let mut body_renames = BTreeMap::new();
    for reference in iter_inline_media_references(&block.body) {
        if media_refs::resolve_inline_media(vault, &block.slug, &reference)
            .is_some_and(|path| same_path(&path, old_path))
        {
            body_renames.insert(reference.source, new_ref.to_string());
        }
    }
    rewritten.body = rename_inline_media_references(&rewritten.body, &body_renames);
    rewritten
}

fn remove_block_media_asset_references(
    vault: &VaultLayout,
    block: &Block,
    media_path: &Path,
) -> Option<Block> {
    let mut rewritten = block.clone();
    let mut changed = false;

    if block
        .frontmatter
        .file
        .as_deref()
        .and_then(|reference| media_refs::resolve_indexed_media(vault, &block.slug, reference))
        .is_some_and(|path| same_path(&path, media_path))
    {
        rewritten.frontmatter.file = None;
        changed = true;
    }
    if block
        .frontmatter
        .thumbnail
        .as_deref()
        .and_then(|reference| media_refs::resolve_indexed_media(vault, &block.slug, reference))
        .is_some_and(|path| same_path(&path, media_path))
    {
        rewritten.frontmatter.thumbnail = None;
        changed = true;
    }

    let mut body_removals = BTreeSet::new();
    for reference in iter_inline_media_references(&block.body) {
        if media_refs::resolve_inline_media(vault, &block.slug, &reference)
            .is_some_and(|path| same_path(&path, media_path))
        {
            body_removals.insert(reference.source);
        }
    }
    let next_body = remove_inline_media_references(&rewritten.body, &body_removals);
    if next_body != rewritten.body {
        rewritten.body = next_body;
        changed = true;
    }

    changed.then_some(rewritten)
}

fn media_asset_reference_kinds(
    vault: &VaultLayout,
    block: &Block,
    media_path: &Path,
) -> Vec<String> {
    let mut kinds = BTreeSet::new();
    if block
        .frontmatter
        .file
        .as_deref()
        .and_then(|reference| media_refs::resolve_indexed_media(vault, &block.slug, reference))
        .is_some_and(|path| same_path(&path, media_path))
    {
        kinds.insert("frontmatter_file".to_string());
    }
    if block
        .frontmatter
        .thumbnail
        .as_deref()
        .and_then(|reference| media_refs::resolve_indexed_media(vault, &block.slug, reference))
        .is_some_and(|path| same_path(&path, media_path))
    {
        kinds.insert("frontmatter_thumbnail".to_string());
    }
    if iter_inline_media_references(&block.body)
        .into_iter()
        .any(|reference| {
            media_refs::resolve_inline_media(vault, &block.slug, &reference)
                .is_some_and(|path| same_path(&path, media_path))
        })
    {
        kinds.insert("body_embed".to_string());
    }
    kinds.into_iter().collect()
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
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

    let mut source_writes = planned_writes
        .iter()
        .map(|write| {
            let bytes = crate::domain::block::serialize_block(&write.block).into_bytes();
            if write.original_path == old_path {
                SourceFileWrite::rename_with_bytes(
                    write.original_path.clone(),
                    write.target_path.clone(),
                    bytes,
                )
            } else {
                SourceFileWrite::replace(write.target_path.clone(), bytes)
            }
        })
        .collect::<Vec<_>>();
    source_writes.extend(
        media_renames
            .iter()
            .map(|rename| SourceFileWrite::rename(rename.from.clone(), rename.to.clone())),
    );
    let staged_source =
        StagedSourceMutation::stage(source_writes).map_err(internal_rename_error)?;

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

    staged_source
        .commit_with_index(conn, "rename_block", |index_conn| {
            let renamed = index::rename_slug(index_conn, old_slug, &new_slug)?;
            if !renamed {
                bail!(
                    "source slug '{}' missing from index during rename",
                    old_slug
                );
            }
            for write in &planned_writes {
                if write.block.frontmatter.block_type == BlockType::Channel {
                    index::upsert_channel_from_block(index_conn, &write.block)?;
                } else {
                    index::upsert_block(index_conn, &write.block, Some(vault.root()))?;
                }
            }
            Ok(())
        })
        .map_err(internal_rename_error)?;
    if let Err(error) = files::rename_derived_artifacts(vault, old_slug, &new_slug) {
        log::warn!("rename derived artifacts will self-heal for {new_slug}: {error:#}");
    }
    if article_audio_should_invalidate_after_rename(&old_block, &renamed_root_block) {
        let _ = article_audio::delete_all_artifacts(vault, &new_slug);
    }

    if let Some(app) = app {
        let _ = app.emit(
            "block:renamed",
            RenameBlockResult {
                old_slug: old_slug.to_string(),
                new_slug: new_slug.clone(),
            },
        );
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
    if let Some(selection_start) = find_selection_start(body, selected_text) {
        return Ok(markdown_block_range_containing(body, selection_start));
    }

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

    Err(TextSelectionExtractError::UnsupportedSelectionShape {
        reason: "selected text could not be located in the current source body".to_string(),
    })
}

fn find_selection_start(body: &str, selected_text: &str) -> Option<usize> {
    body.find(selected_text)
        .or_else(|| find_normalized_selection_start(body, selected_text))
}

fn find_normalized_selection_start(body: &str, selected_text: &str) -> Option<usize> {
    let needle = normalize_inline_whitespace(selected_text);
    if needle.is_empty() {
        return None;
    }
    let normalized = normalize_inline_whitespace_with_offsets(body);
    let normalized_start = normalized.text.find(&needle)?;
    let char_start = normalized.text[..normalized_start].chars().count();
    normalized.offsets.get(char_start).copied()
}

fn selected_text_source_span(body: &str, selected_text: &str) -> Option<(usize, usize)> {
    if let Some(start) = body.find(selected_text) {
        return Some((start, start + selected_text.len()));
    }

    let needle = normalize_inline_whitespace(selected_text);
    if needle.is_empty() {
        return None;
    }
    let normalized = normalize_inline_whitespace_with_spans(body);
    let normalized_start = normalized.text.find(&needle)?;
    let char_start = normalized.text[..normalized_start].chars().count();
    let char_count = needle.chars().count();
    let char_end = char_start.checked_add(char_count)?;
    let source_start = normalized.spans.get(char_start)?.0;
    let source_end = normalized.spans.get(char_end.checked_sub(1)?)?.1;
    Some((source_start, source_end))
}

struct NormalizedSource {
    text: String,
    offsets: Vec<usize>,
}

struct NormalizedSpanSource {
    text: String,
    spans: Vec<(usize, usize)>,
}

fn normalize_inline_whitespace_with_offsets(value: &str) -> NormalizedSource {
    let mut text = String::new();
    let mut offsets = Vec::new();
    let mut last_space = false;

    for (offset, ch) in value.char_indices() {
        if ch.is_whitespace() {
            if !last_space && !text.is_empty() {
                text.push(' ');
                offsets.push(offset);
                last_space = true;
            }
        } else {
            text.push(ch);
            offsets.push(offset);
            last_space = false;
        }
    }

    while text.ends_with(' ') {
        text.pop();
        offsets.pop();
    }

    NormalizedSource { text, offsets }
}

fn normalize_inline_whitespace_with_spans(value: &str) -> NormalizedSpanSource {
    let mut text = String::new();
    let mut spans = Vec::new();
    let mut pending_space_start: Option<usize> = None;
    let mut pending_space_end = 0;

    for (offset, ch) in value.char_indices() {
        let ch_end = offset + ch.len_utf8();
        if ch.is_whitespace() {
            if !text.is_empty() {
                if pending_space_start.is_none() {
                    pending_space_start = Some(offset);
                }
                pending_space_end = ch_end;
            }
            continue;
        }

        if let Some(space_start) = pending_space_start.take() {
            if !text.ends_with(' ') {
                text.push(' ');
                spans.push((space_start, pending_space_end));
            }
        }
        text.push(ch);
        spans.push((offset, ch_end));
    }

    NormalizedSpanSource { text, spans }
}

fn range_matches_selection_start(
    body: &str,
    block_start: usize,
    block_end: usize,
    selected_text: &str,
) -> bool {
    if let Some(selection_start) = find_selection_start(body, selected_text) {
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

pub(crate) fn resolve_unique_block_slug(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    raw_slug: &str,
    media_ext: Option<&str>,
) -> anyhow::Result<String> {
    let first = index::resolve_unique_slug(conn, raw_slug)?;
    for candidate in std::iter::once(first).chain((2..=1000).map(|n| format!("{raw_slug} ({n})"))) {
        validate_slug(&candidate)?;
        if index::slug_exists(conn, &candidate)? || vault.block_path(&candidate).exists() {
            continue;
        }
        if media_ext.is_some_and(|ext| vault.media_path(&candidate, ext).exists()) {
            continue;
        }
        return Ok(candidate);
    }
    anyhow::bail!("could not resolve block filename for '{}'", raw_slug)
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
        // infallible inner unwrap: parsing a hardcoded valid ISO-8601 literal.
        .unwrap_or_else(|_| DateTime::new("1970-01-01T00:00:00Z").unwrap())
}

fn internal_extract_error(error: impl std::fmt::Display) -> InlineMediaExtractError {
    InlineMediaExtractError::Internal {
        message: error.to_string(),
    }
}

fn internal_media_asset_error(error: impl std::fmt::Display) -> MediaAssetActionError {
    MediaAssetActionError::Internal {
        message: error.to_string(),
    }
}

fn internal_text_selection_error(error: impl std::fmt::Display) -> TextSelectionExtractError {
    TextSelectionExtractError::Internal {
        message: error.to_string(),
    }
}

fn internal_merge_error(error: impl std::fmt::Display) -> MergeBlocksError {
    MergeBlocksError::Internal {
        message: error.to_string(),
    }
}

fn internal_rename_error(error: impl std::fmt::Display) -> RenameBlockError {
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
    fn merge_blocks_inner_creates_ordered_article_and_preserves_media_files() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let mut first = article("First Card", "Alpha body");
        first.frontmatter.author = Some("Alice".to_string());
        let mut second = image("Second Image", "second.png");
        second.frontmatter.tags = vec!["visual".to_string()];
        second.frontmatter.url = Some("https://assets.example/image".to_string());
        second.frontmatter.related_notes = vec!["External Note".to_string()];
        let external = article(
            "External Note",
            "See [[First Card#^alpha]] and [[Second Image|image card]].",
        );
        persist_block(&conn, &vault, &first);
        persist_block(&conn, &vault, &second);
        persist_block(&conn, &vault, &external);
        std::fs::write(vault.root().join("second.png"), b"image-bytes").unwrap();

        let mutation = merge_blocks_inner(
            &state,
            &conn,
            &vault,
            vec!["First Card".to_string(), "Second Image".to_string()],
        )
        .unwrap();

        assert_eq!(mutation.result.merged_slug, "First Card — merged");
        assert_eq!(
            mutation.result.removed_slugs,
            vec!["First Card".to_string(), "Second Image".to_string()]
        );
        assert_eq!(mutation.result.block.block_type, BlockType::Article);
        assert_eq!(mutation.result.block.source.as_deref(), Some("card-merge"));
        assert_eq!(
            mutation.result.block.url.as_deref(),
            Some("https://example.com/article")
        );
        assert_eq!(mutation.result.block.tags, vec!["notes", "visual"]);
        assert_eq!(
            mutation.result.block.related_notes,
            vec!["External Note".to_string()]
        );
        assert!(mutation.result.block.body.contains("Alpha body"));
        assert!(mutation
            .result
            .block
            .body
            .contains("\n\n---\n\n![[second.png]]"));
        assert!(mutation.result.block.body.contains("Author: Alice"));
        assert!(mutation
            .result
            .block
            .body
            .contains("Source: [example.com](<https://example.com/article>)"));

        assert!(!vault.block_path("First Card").exists());
        assert!(!vault.block_path("Second Image").exists());
        assert!(vault.block_path("First Card — merged").exists());
        assert_eq!(
            std::fs::read(vault.root().join("second.png")).unwrap(),
            b"image-bytes"
        );
        assert!(index::get_block(&conn, "First Card").unwrap().is_none());
        assert!(index::get_block(&conn, "Second Image").unwrap().is_none());
        assert!(index::get_block(&conn, "First Card — merged")
            .unwrap()
            .is_some());
        let merged_content =
            std::fs::read_to_string(vault.block_path("First Card — merged")).unwrap();
        assert!(merged_content.contains("Mine Collections:\n  - \"[[notes]]\"\n  - \"[[visual]]\""));
        assert!(merged_content.contains("url: https://example.com/article"));
        assert!(merged_content.contains("author: Alice"));

        let (_, external_content) =
            files::read_block_file(&vault, &vault.block_path("External Note")).unwrap();
        assert!(external_content.contains("[[First Card — merged#^alpha]]"));
        assert!(external_content.contains("[[First Card — merged|image card]]"));
        assert!(!external_content.contains("[[First Card#^alpha]]"));
        assert!(!external_content.contains("[[Second Image|image card]]"));
    }

    #[test]
    fn merge_blocks_uses_first_safe_source_url_and_author_in_merge_order() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let mut first = article("First Card", "Alpha body");
        first.frontmatter.url = Some("/".to_string());
        first.frontmatter.author = None;
        let mut second = article("Second Card", "Beta body");
        second.frontmatter.url = Some("https://example.com/second".to_string());
        second.frontmatter.author = Some("Bob".to_string());
        persist_block(&conn, &vault, &first);
        persist_block(&conn, &vault, &second);

        let mutation = merge_blocks_inner(
            &state,
            &conn,
            &vault,
            vec!["First Card".to_string(), "Second Card".to_string()],
        )
        .unwrap();

        assert_eq!(
            mutation.result.block.url.as_deref(),
            Some("https://example.com/second")
        );
        assert_eq!(mutation.result.block.author.as_deref(), Some("Bob"));
        assert!(!mutation.result.block.body.contains("Source: [Source](</>)"));
        assert!(mutation
            .result
            .block
            .body
            .contains("Source: [example.com](<https://example.com/second>)"));
        assert!(mutation.result.block.body.contains("Author: Bob"));
    }

    #[test]
    fn merge_blocks_stage_failure_keeps_sources_references_and_index_unchanged() {
        let (_root, _derived, vault, conn) = make_vault();
        let first = article("First Card", "Alpha body");
        let second = article("Second Card", "Beta body");
        let external = article("External Note", "See [[First Card]] and [[Second Card]].");
        persist_block(&conn, &vault, &first);
        persist_block(&conn, &vault, &second);
        persist_block(&conn, &vault, &external);
        let external_path = vault.block_path("External Note");
        let original_external_content = std::fs::read_to_string(&external_path).unwrap();

        let ordered_slugs = vec!["First Card".to_string(), "Second Card".to_string()];
        let selected_slugs: BTreeSet<String> = ordered_slugs.iter().cloned().collect();
        let sources = load_merge_source_blocks(&vault, &ordered_slugs).unwrap();
        let mut merged_block =
            build_merged_block(&conn, &vault, &sources, &selected_slugs).unwrap();
        merged_block.body = rewrite_body_selected_wikilinks(
            &merged_block.body,
            &selected_slugs,
            &merged_block.slug,
        );
        let mut reference_writes =
            build_merge_reference_writes(&vault, &selected_slugs, &merged_block.slug).unwrap();
        // Inject a write failure: a path whose parent is an existing FILE, so
        // neither create_dir_all nor the write can succeed. (write_atomically
        // creates missing parent dirs, so a merely-missing parent now succeeds.)
        let blocker = vault.root().join("blocker-file");
        std::fs::write(&blocker, b"x").unwrap();
        reference_writes.push(MergeReferenceWrite {
            path: blocker.join("Broken.md"),
            block: article("Broken", "Broken body"),
        });

        let error = apply_merge_blocks(&conn, &vault, &merged_block, &sources, &reference_writes)
            .unwrap_err();
        assert!(matches!(error, MergeBlocksError::Internal { .. }));

        assert!(!vault.block_path("First Card — merged").exists());
        assert!(vault.block_path("First Card").exists());
        assert!(vault.block_path("Second Card").exists());
        assert_eq!(
            std::fs::read_to_string(external_path).unwrap(),
            original_external_content
        );
        assert!(index::get_block(&conn, "First Card").unwrap().is_some());
        assert!(index::get_block(&conn, "Second Card").unwrap().is_some());
        assert!(index::get_block(&conn, "First Card — merged")
            .unwrap()
            .is_none());
    }

    #[test]
    fn merge_blocks_inner_rejects_channels_and_duplicate_slugs() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let first = article("First Card", "Alpha body");
        let mut channel = article("Channel Card", "");
        channel.frontmatter.block_type = BlockType::Channel;
        persist_block(&conn, &vault, &first);
        persist_block(&conn, &vault, &channel);

        let duplicate_error = merge_blocks_inner(
            &state,
            &conn,
            &vault,
            vec!["First Card".to_string(), "First Card".to_string()],
        )
        .unwrap_err();
        assert!(matches!(
            duplicate_error,
            MergeBlocksError::DuplicateSlug { .. }
        ));

        let channel_error = merge_blocks_inner(
            &state,
            &conn,
            &vault,
            vec!["First Card".to_string(), "Channel Card".to_string()],
        )
        .unwrap_err();
        assert!(matches!(
            channel_error,
            MergeBlocksError::BlockNotMergeable { .. }
        ));
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

        let (_, extracted_content) =
            files::read_block_file(&vault, &vault.block_path("photo (2)")).unwrap();
        let extracted = crate::domain::block::parse_block("photo (2)", &extracted_content).unwrap();
        assert_eq!(
            extracted.frontmatter.related_notes,
            vec!["Source Article".to_string()]
        );
        assert!(extracted.frontmatter.title.is_none());
        assert_eq!(
            extracted.frontmatter.source_media.as_deref(),
            Some("photo.png")
        );
        assert!(extracted.body.is_empty());

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
    fn create_media_asset_card_inner_creates_standalone_media_card_without_connecting_source() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article("Source Article", "Intro\n\n![[photo.png]]\n\nOutro");
        persist_block(&conn, &vault, &source);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let indexed = create_media_asset_card_inner(
            &conn,
            &vault,
            "photo.png".to_string(),
            "Mood Board".to_string(),
            Some("Source Article".to_string()),
        )
        .unwrap();

        assert_eq!(indexed.block_type, BlockType::Image);
        assert!(indexed.body.is_empty());
        assert_eq!(indexed.media_file.as_deref(), Some("photo.png"));
        assert_eq!(indexed.tags, vec!["Mood Board".to_string()]);
        assert_eq!(indexed.related_notes, vec!["Source Article".to_string()]);
        assert_eq!(indexed.source.as_deref(), Some("media-asset-action"));

        let source_after = index::get_block(&conn, "Source Article").unwrap().unwrap();
        assert_eq!(source_after.tags, vec!["notes".to_string()]);
        let (_, source_content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        assert!(source_content.contains("![[photo.png]]"));
    }

    #[test]
    fn create_media_asset_card_inner_always_creates_a_new_media_card() {
        let (_root, _derived, vault, conn) = make_vault();
        let mut existing = image("Existing Photo", "photo.png");
        existing.frontmatter.tags = vec!["Existing".to_string()];
        persist_block(&conn, &vault, &existing);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let indexed = create_media_asset_card_inner(
            &conn,
            &vault,
            "photo.png".to_string(),
            "Mood Board".to_string(),
            None,
        )
        .unwrap();

        assert_ne!(indexed.slug, "Existing Photo");
        assert_eq!(indexed.media_file.as_deref(), Some("photo.png"));
        assert_eq!(indexed.tags, vec!["Mood Board".to_string()]);

        let (_, content) =
            files::read_block_file(&vault, &vault.block_path("Existing Photo")).unwrap();
        let parsed = crate::domain::block::parse_block("Existing Photo", &content).unwrap();
        assert_eq!(parsed.frontmatter.tags, vec!["Existing".to_string()]);
        assert!(parsed.body.is_empty());
    }

    #[test]
    fn create_media_asset_card_inner_allows_everything_without_tags() {
        let (_root, _derived, vault, conn) = make_vault();
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let indexed = create_media_asset_card_inner(
            &conn,
            &vault,
            "photo.png".to_string(),
            String::new(),
            None,
        )
        .unwrap();

        assert_eq!(indexed.media_file.as_deref(), Some("photo.png"));
        assert!(indexed.tags.is_empty());
    }

    #[test]
    fn rename_media_asset_inner_rewrites_frontmatter_and_inline_refs_only() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let source = article("Source Article", "Intro\n\n![[photo.png]]\n\nOutro");
        let media = image("Photo Card", "photo.png");
        persist_block(&conn, &vault, &source);
        persist_block(&conn, &vault, &media);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let result = rename_media_asset_inner(
            &state,
            &conn,
            &vault,
            "photo.png".to_string(),
            "renamed".to_string(),
        )
        .unwrap();

        assert_eq!(result.media_ref, "photo.png");
        assert_eq!(result.new_media_ref.as_deref(), Some("renamed.png"));
        assert!(result
            .affected_slugs
            .contains(&"Source Article".to_string()));
        assert!(result.affected_slugs.contains(&"Photo Card".to_string()));
        assert!(!vault.root().join("photo.png").exists());
        assert_eq!(
            std::fs::read(vault.root().join("renamed.png")).unwrap(),
            b"image-bytes"
        );
        assert!(vault.block_path("Photo Card").exists());

        let (_, source_content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        assert!(source_content.contains("![[renamed.png]]"));
        assert!(!source_content.contains("![[photo.png]]"));

        let (_, media_content) =
            files::read_block_file(&vault, &vault.block_path("Photo Card")).unwrap();
        let parsed = crate::domain::block::parse_block("Photo Card", &media_content).unwrap();
        assert_eq!(parsed.frontmatter.file.as_deref(), Some("renamed.png"));
        assert_eq!(parsed.frontmatter.title.as_deref(), Some("Photo Card"));
    }

    #[test]
    fn rename_media_asset_sql_failure_restores_media_references_and_index() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let source = article("Source Article", "Intro\n\n![[photo.png]]\n\nOutro");
        persist_block(&conn, &vault, &source);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();
        let markdown = std::fs::read(vault.block_path("Source Article")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_media_rename_index
             BEFORE UPDATE ON blocks
             WHEN OLD.slug = 'Source Article'
             BEGIN
                 SELECT RAISE(FAIL, 'injected media rename failure');
             END;",
        )
        .unwrap();

        let error = rename_media_asset_inner(
            &state,
            &conn,
            &vault,
            "photo.png".to_string(),
            "renamed".to_string(),
        )
        .unwrap_err();

        assert!(matches!(error, MediaAssetActionError::Internal { .. }));
        assert_eq!(
            std::fs::read(vault.root().join("photo.png")).unwrap(),
            b"image-bytes"
        );
        assert!(!vault.root().join("renamed.png").exists());
        assert_eq!(
            std::fs::read(vault.block_path("Source Article")).unwrap(),
            markdown
        );
        assert_eq!(
            index::get_block(&conn, "Source Article")
                .unwrap()
                .unwrap()
                .body,
            source.body
        );
    }

    #[test]
    fn prepare_delete_media_asset_inner_lists_referencing_cards() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article("Source Article", "Intro\n\n![[photo.png]]\n\nOutro");
        let media = image("Photo Card", "photo.png");
        persist_block(&conn, &vault, &source);
        persist_block(&conn, &vault, &media);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let plan = prepare_delete_media_asset_inner(&vault, "photo.png".to_string()).unwrap();

        assert_eq!(plan.media_ref, "photo.png");
        assert_eq!(plan.media_kind, "image");
        assert_eq!(plan.referenced_by.len(), 2);
        assert_eq!(plan.referenced_by[0].slug, "Photo Card");
        assert_eq!(
            plan.referenced_by[0].reference_kinds,
            vec!["frontmatter_file".to_string()]
        );
        assert_eq!(
            plan.referenced_by[1].reference_kinds,
            vec!["body_embed".to_string()]
        );
    }

    #[test]
    fn prepare_delete_media_asset_inner_accepts_partial_frontmatter_without_type() {
        let (_root, _derived, vault, _conn) = make_vault();
        std::fs::write(
            vault.block_path("Partial Note"),
            "---\nsaved_at: 2026-05-05T22:28:06Z\n---\n# Partial Note\n\n![[photo.png]]\n",
        )
        .unwrap();
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let plan = prepare_delete_media_asset_inner(&vault, "photo.png".to_string()).unwrap();

        assert_eq!(plan.referenced_by.len(), 1);
        assert_eq!(plan.referenced_by[0].slug, "Partial Note");
        assert_eq!(
            plan.referenced_by[0].reference_kinds,
            vec!["body_embed".to_string()]
        );
    }

    #[test]
    fn delete_media_asset_inner_deletes_file_and_cleans_card_references() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let source = article("Source Article", "Intro\n\n![[photo.png]]\n\nOutro");
        let media = image("Photo Card", "photo.png");
        persist_block(&conn, &vault, &source);
        persist_block(&conn, &vault, &media);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let result =
            delete_media_asset_inner(&state, &conn, &vault, "photo.png".to_string()).unwrap();

        assert_eq!(result.media_ref, "photo.png");
        assert!(result.new_media_ref.is_none());
        assert!(result
            .affected_slugs
            .contains(&"Source Article".to_string()));
        assert!(result.affected_slugs.contains(&"Photo Card".to_string()));
        assert!(!vault.root().join("photo.png").exists());
        assert!(vault.block_path("Source Article").exists());
        assert!(vault.block_path("Photo Card").exists());

        let (_, source_content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        assert!(!source_content.contains("![[photo.png]]"));
        assert!(source_content.contains("Intro"));
        assert!(source_content.contains("Outro"));

        let (_, media_content) =
            files::read_block_file(&vault, &vault.block_path("Photo Card")).unwrap();
        let parsed = crate::domain::block::parse_block("Photo Card", &media_content).unwrap();
        assert_eq!(parsed.frontmatter.file.as_deref(), None);
        assert!(parsed.body.is_empty());
    }

    #[test]
    fn delete_media_asset_sql_failure_restores_media_references_and_index() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let source = article("Source Article", "Intro\n\n![[photo.png]]\n\nOutro");
        persist_block(&conn, &vault, &source);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();
        let markdown = std::fs::read(vault.block_path("Source Article")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_media_delete_index
             BEFORE UPDATE ON blocks
             WHEN OLD.slug = 'Source Article'
             BEGIN
                 SELECT RAISE(FAIL, 'injected media delete failure');
             END;",
        )
        .unwrap();

        let error =
            delete_media_asset_inner(&state, &conn, &vault, "photo.png".to_string()).unwrap_err();

        assert!(matches!(error, MediaAssetActionError::Internal { .. }));
        assert_eq!(
            std::fs::read(vault.root().join("photo.png")).unwrap(),
            b"image-bytes"
        );
        assert_eq!(
            std::fs::read(vault.block_path("Source Article")).unwrap(),
            markdown
        );
        assert_eq!(
            index::get_block(&conn, "Source Article")
                .unwrap()
                .unwrap()
                .body,
            source.body
        );
    }

    #[test]
    fn delete_media_asset_inner_ignores_unrelated_markdown_without_type() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        std::fs::write(
            vault.block_path("CleanShot 2026 05 05 at 19.17.00@2x"),
            "---\nsaved_at: 2026-05-05T22:28:06Z\n---\n# Screenshot note\n\nNo matching media here.\n",
        )
        .unwrap();
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let result =
            delete_media_asset_inner(&state, &conn, &vault, "photo.png".to_string()).unwrap();

        assert_eq!(result.media_ref, "photo.png");
        assert!(result.affected_slugs.is_empty());
        assert!(!vault.root().join("photo.png").exists());
        assert!(vault
            .block_path("CleanShot 2026 05 05 at 19.17.00@2x")
            .exists());
    }

    #[test]
    fn rename_media_asset_inner_ignores_unrelated_markdown_without_type() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        std::fs::write(
            vault.block_path("Partial Note"),
            "---\nsaved_at: 2026-05-05T22:28:06Z\n---\n# Partial Note\n\nNo matching media here.\n",
        )
        .unwrap();
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let result = rename_media_asset_inner(
            &state,
            &conn,
            &vault,
            "photo.png".to_string(),
            "renamed".to_string(),
        )
        .unwrap();

        assert_eq!(result.media_ref, "photo.png");
        assert_eq!(result.new_media_ref.as_deref(), Some("renamed.png"));
        assert!(result.affected_slugs.is_empty());
        assert!(!vault.root().join("photo.png").exists());
        assert_eq!(
            std::fs::read(vault.root().join("renamed.png")).unwrap(),
            b"image-bytes"
        );
    }

    #[test]
    fn remove_media_asset_from_card_inner_removes_frontmatter_file_without_deleting_media() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let media = image("Photo Card", "photo.png");
        persist_block(&conn, &vault, &media);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let result = remove_media_asset_from_card_inner(
            &state,
            &conn,
            &vault,
            "photo.png".to_string(),
            "Photo Card".to_string(),
            "frontmatter_file".to_string(),
            None,
        )
        .unwrap();

        assert_eq!(result.media_ref, "photo.png");
        assert_eq!(result.affected_slugs, vec!["Photo Card".to_string()]);
        assert_eq!(
            std::fs::read(vault.root().join("photo.png")).unwrap(),
            b"image-bytes"
        );

        let (_, content) = files::read_block_file(&vault, &vault.block_path("Photo Card")).unwrap();
        let parsed = crate::domain::block::parse_block("Photo Card", &content).unwrap();
        assert!(parsed.frontmatter.file.is_none());
        assert!(parsed.body.is_empty());
    }

    #[test]
    fn remove_media_asset_from_card_inner_removes_body_embed_without_deleting_media() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let source = article("Source Article", "Intro\n\n![[photo.png]]\n\nOutro");
        persist_block(&conn, &vault, &source);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        let result = remove_media_asset_from_card_inner(
            &state,
            &conn,
            &vault,
            "photo.png".to_string(),
            "Source Article".to_string(),
            "body_embed".to_string(),
            None,
        )
        .unwrap();

        assert_eq!(result.media_ref, "photo.png");
        assert_eq!(result.affected_slugs, vec!["Source Article".to_string()]);
        assert_eq!(
            std::fs::read(vault.root().join("photo.png")).unwrap(),
            b"image-bytes"
        );

        let (_, content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        let parsed = crate::domain::block::parse_block("Source Article", &content).unwrap();
        assert_eq!(parsed.body, "Intro\n\nOutro");
    }

    #[test]
    fn remove_media_asset_from_card_inner_removes_only_one_duplicate_body_embed() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let source = article(
            "Source Article",
            "First\n\n![[photo.png]]\n\nMiddle\n\n![[photo.png]]\n\nLast",
        );
        persist_block(&conn, &vault, &source);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();

        // Remove only the second of two identical embeds.
        let result = remove_media_asset_from_card_inner(
            &state,
            &conn,
            &vault,
            "photo.png".to_string(),
            "Source Article".to_string(),
            "body_embed".to_string(),
            Some(1),
        )
        .unwrap();

        assert_eq!(result.affected_slugs, vec!["Source Article".to_string()]);
        let (_, content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        let parsed = crate::domain::block::parse_block("Source Article", &content).unwrap();
        // One identical embed remains; the media file is untouched.
        assert_eq!(parsed.body.matches("![[photo.png]]").count(), 1);
        assert!(vault.root().join("photo.png").exists());
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
        let state = AppState::new();
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
        assert_eq!(plan.unused_media.len(), 1);
        assert_eq!(plan.unused_media[0].path, "unused.png");
        assert_eq!(plan.shared_media.len(), 1);
        assert_eq!(plan.shared_media[0].path, "shared.png");

        assert!(delete_block_inner(&state, &conn, &vault, "Source Article", Some(true)).unwrap());

        assert!(!vault.block_path("Source Article").exists());
        assert!(!vault.root().join("unused.png").exists());
        assert!(vault.root().join("shared.png").exists());
    }

    #[test]
    fn delete_block_sql_failure_restores_markdown_media_and_index() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        persist_block(&conn, &vault, &article("Source Article", "![[unused.png]]"));
        std::fs::write(vault.root().join("unused.png"), b"media-bytes").unwrap();
        let markdown = std::fs::read(vault.block_path("Source Article")).unwrap();

        conn.execute_batch(
            "CREATE TRIGGER fail_block_delete
             BEFORE DELETE ON blocks
             WHEN OLD.slug = 'Source Article'
             BEGIN
                 SELECT RAISE(FAIL, 'injected delete failure');
             END;",
        )
        .unwrap();

        let error =
            delete_block_inner(&state, &conn, &vault, "Source Article", Some(true)).unwrap_err();

        assert!(matches!(error, CommandError::Internal(_)));
        assert_eq!(
            std::fs::read(vault.block_path("Source Article")).unwrap(),
            markdown
        );
        assert_eq!(
            std::fs::read(vault.root().join("unused.png")).unwrap(),
            b"media-bytes"
        );
        assert!(index::get_block(&conn, "Source Article").unwrap().is_some());
        assert!(std::fs::read_dir(vault.root()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("mine-delete-backup")
        }));
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
        assert_eq!(indexed.related_notes, vec!["Source Article"]);

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

        assert_eq!(indexed.related_notes, vec!["Source Article"]);
        let (_, source_content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        assert_eq!(source_content.matches("^manual-anchor").count(), 1);
    }

    #[test]
    fn extract_text_selection_inner_allows_everything_target() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article("Source Article", "First paragraph with useful sentence.");
        let body_hash = compute_body_hash(&source.body);
        persist_block(&conn, &vault, &source);

        let indexed = extract_text_selection_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            String::new(),
            "useful sentence".to_string(),
            0,
            0,
            body_hash,
        )
        .unwrap();

        assert!(indexed.tags.is_empty());
    }

    #[test]
    fn delete_text_selection_inner_removes_selection_and_reindexes_source() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article(
            "Source Article",
            "First paragraph with useful sentence.\n\nSecond paragraph.",
        );
        let body_hash = compute_body_hash(&source.body);
        persist_block(&conn, &vault, &source);

        let indexed = delete_text_selection_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            "useful sentence".to_string(),
            0,
            0,
            body_hash.clone(),
        )
        .unwrap();

        assert_eq!(indexed.body, "First paragraph with .\n\nSecond paragraph.");
        assert_ne!(indexed.body_hash.as_deref(), Some(body_hash.as_str()));

        let (_, source_content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        assert!(source_content.contains("First paragraph with ."));
        assert!(!source_content.contains("useful sentence"));
    }

    #[test]
    fn delete_text_selection_inner_removes_normalized_multiline_selection() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article(
            "Source Article",
            "Alpha beta\nGamma delta.\n\nSecond paragraph.",
        );
        let body_hash = compute_body_hash(&source.body);
        persist_block(&conn, &vault, &source);

        let indexed = delete_text_selection_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            "beta Gamma".to_string(),
            0,
            "Alpha beta\nGamma delta.".len(),
            body_hash,
        )
        .unwrap();

        assert_eq!(indexed.body, "Alpha  delta.\n\nSecond paragraph.");
    }

    #[test]
    fn extract_text_selection_inner_accepts_japanese_with_utf16_like_range() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article(
            "Source Article",
            "これは日本語の文章です。\n\nSecond paragraph.",
        );
        let body_hash = compute_body_hash(&source.body);
        persist_block(&conn, &vault, &source);

        let utf16_like_first_block_end = "これは日本語の文章です。".chars().count();
        let indexed = extract_text_selection_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            "Quotes".to_string(),
            "文章".to_string(),
            0,
            utf16_like_first_block_end,
            body_hash,
        )
        .unwrap();

        assert_eq!(indexed.body, "文章");
        assert_eq!(indexed.tags, vec!["Quotes".to_string()]);

        let (_, source_content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        assert!(source_content.contains("これは日本語の文章です。 ^selection"));
    }

    #[test]
    fn extract_text_selection_inner_accepts_japanese_rendered_paragraph_selection() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article(
            "Source Article",
            "コットンのように粗野な質感でもなく、ナイロンのような光沢感もない、周囲の環境に馴染むような控えめな質感が特徴のコットン・ナイロン。\n軽量でありながら適度にハリのある素材感は、着用した時のシルエット形成にも寄与している。 ^this-cot-2\n\nThis cotton-nylon blend is characterized by a subtle text.",
        );
        let body_hash = compute_body_hash(&source.body);
        persist_block(&conn, &vault, &source);

        let selected_text = "コットンのように粗野な質感でもなく、ナイロンのような光沢感もない、周囲の環境に馴染むような控えめな質感が特徴のコットン・ナイロン。 軽量でありながら適度にハリのある素材感は、着用した時のシルエット形成にも寄与している。 ^this-cot-2";
        let indexed = extract_text_selection_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            "Quotes".to_string(),
            selected_text.to_string(),
            0,
            selected_text.chars().count(),
            body_hash,
        )
        .unwrap();

        assert_eq!(indexed.body, selected_text);
        assert_eq!(indexed.related_notes, vec!["Source Article"]);

        let (_, source_content) =
            files::read_block_file(&vault, &vault.block_path("Source Article")).unwrap();
        assert_eq!(source_content.matches("^this-cot-2").count(), 1);
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
    fn rename_block_file_sql_failure_restores_vault_and_index() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();

        let original = article("Old Name", "Intro\n\n![[Old Name (image 1).jpg]]");
        let reference = article("Reference Note", "See [[Old Name#^anchor]].");
        persist_block(&conn, &vault, &original);
        persist_block(&conn, &vault, &reference);
        std::fs::write(vault.root().join("Old Name (image 1).jpg"), b"img").unwrap();

        let old_content = std::fs::read(vault.block_path("Old Name")).unwrap();
        let reference_content = std::fs::read(vault.block_path("Reference Note")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_block_rename
             BEFORE UPDATE OF slug ON blocks
             WHEN OLD.slug = 'Old Name'
             BEGIN
                 SELECT RAISE(FAIL, 'injected rename failure');
             END;",
        )
        .unwrap();

        let error =
            rename_block_file_inner(None, &state, &conn, &vault, "Old Name", "Renamed Name")
                .unwrap_err();

        assert!(matches!(error, RenameBlockError::Internal { .. }));
        assert_eq!(
            std::fs::read(vault.block_path("Old Name")).unwrap(),
            old_content
        );
        assert_eq!(
            std::fs::read(vault.block_path("Reference Note")).unwrap(),
            reference_content
        );
        assert!(!vault.block_path("Renamed Name").exists());
        assert!(vault.root().join("Old Name (image 1).jpg").exists());
        assert!(!vault.root().join("Renamed Name (image 1).jpg").exists());
        assert!(index::get_block(&conn, "Old Name").unwrap().is_some());
        assert!(index::get_block(&conn, "Renamed Name").unwrap().is_none());
        assert!(std::fs::read_dir(vault.root()).unwrap().all(|entry| {
            let name = entry.unwrap().file_name();
            let name = name.to_string_lossy();
            !name.contains("mine-rename")
                && !name.contains("mine-delete-backup")
                && !name.contains("mine-tmp")
        }));
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
        assert!(vault
            .article_audio_asset_path("Renamed Name", "wav")
            .exists());
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
