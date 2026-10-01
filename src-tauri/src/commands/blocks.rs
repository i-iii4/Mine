// Block commands: list, get, create, delete blocks.
//
// Contract: SPEC_INTEGRATION.md#commands/blocks

use anyhow::bail;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use thiserror::Error;

use crate::commands::state::{
    adopt_recovered_projection, current_vault_layout, ensure_vault_fresh, read_owned_projection,
    AppState, CommandError,
};
use crate::domain::block::{
    compute_body_hash, derive_card_kind, derive_title_fields, iter_file_references,
    iter_inline_media_references, parse_markdown_document, suggest_slug, Block, BlockType,
    CardKind, DateTime, FileReference, Frontmatter,
};
use crate::domain::collection::{normalize_collection_ref, validate_collection_ref};
use crate::domain::markdown::{
    remove_inline_media_reference_at_opener, remove_inline_media_references,
    rename_inline_media_references, retarget_markdown_destinations, retarget_wikilinks,
};
use crate::domain::source_patch::apply_block_changes;
use mine_core::links::{link_file_part, NoteMoves};
use unicode_normalization::UnicodeNormalization;
use crate::domain::vault::{normalize_filename_stem, validate_slug, VaultLayout};
use crate::storage::index::IndexedBlock;
use crate::storage::source_mutation::{SourceFileWrite, SourceMutationError, StagedSourceMutation};
use crate::storage::{
    article_audio, db, derived_preview, files, index, media_refs, projection, reconcile, thumbnails,
};
use crate::util::append_startup_trace;

pub use crate::storage::projection::GridSnapshot;

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CreateBlockParams {
    pub block_type: String,
    pub title: Option<String>,
    pub url: Option<String>,
    pub tags: Vec<String>,
    pub file_path: Option<String>,
    /// Markdown body for cards born from pasted text. Absent everywhere else.
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ExtractInlineMediaParams {
    pub source_slug: String,
    pub media_ref: String,
    pub target_tag: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CreateMediaAssetCardParams {
    pub media_ref: String,
    pub target_tag: String,
    pub source_slug: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct RenameMediaAssetParams {
    pub media_ref: String,
    pub new_stem: String,
}

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MediaAssetReferenceKind {
    FrontmatterFile,
    BodyEmbed,
}

impl MediaAssetReferenceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::FrontmatterFile => "frontmatter_file",
            Self::BodyEmbed => "body_embed",
        }
    }
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct RemoveMediaAssetFromCardParams {
    pub media_ref: String,
    pub source_slug: String,
    pub reference_kind: MediaAssetReferenceKind,
    /// The clicked image of a `body_embed`: how many `![` precede its own
    /// `![` in the card's body. `null` removes every image of the media.
    pub occurrence_index: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ExtractTextSelectionParams {
    pub source_slug: String,
    pub target_tag: String,
    pub selected_text: String,
    pub first_block_start: usize,
    pub first_block_end: usize,
    pub source_body_hash: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct DeleteTextSelectionParams {
    pub source_slug: String,
    pub selected_text: String,
    pub first_block_start: usize,
    pub first_block_end: usize,
    pub source_body_hash: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct RenameBlockResult {
    pub old_slug: String,
    pub new_slug: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DeleteMediaAssetKind {
    Image,
    Video,
    Audio,
    Document,
    File,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct DeleteBlockMedia {
    pub path: String,
    pub file_name: String,
    pub kind: DeleteMediaAssetKind,
    pub referenced_by: Vec<String>,
    #[serde(skip_serializing)]
    #[specta(skip)]
    absolute_path: PathBuf,
    #[serde(skip_serializing)]
    #[specta(skip)]
    slug_owned_primary: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct DeleteBlockPlan {
    pub slug: String,
    pub markdown_file: String,
    pub unused_media: Vec<DeleteBlockMedia>,
    pub shared_media: Vec<DeleteBlockMedia>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct MergeBlocksResult {
    pub block: IndexedBlock,
    pub merged_slug: String,
    pub removed_slugs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct MediaAssetMutationResult {
    pub media_ref: String,
    pub new_media_ref: Option<String>,
    pub affected_slugs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct MediaAssetReferenceBlock {
    pub slug: String,
    pub title: Option<String>,
    pub display_title: Option<String>,
    pub fallback_label: String,
    pub card_kind: CardKind,
    pub reference_kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct DeleteMediaAssetPlan {
    pub media_ref: String,
    pub media_kind: DeleteMediaAssetKind,
    pub referenced_by: Vec<MediaAssetReferenceBlock>,
}

#[derive(Debug, Error, Serialize, specta::Type)]
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

#[derive(Debug, Error, Serialize, specta::Type)]
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

#[derive(Debug, Error, Serialize, specta::Type)]
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

#[derive(Debug, Error, Serialize, specta::Type)]
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

#[derive(Debug, Error, Serialize, specta::Type)]
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

    /// A card or a linking note changed on disk after the merge read it.
    /// Nothing was merged, written or deleted (`SPEC_AUDIT_FIXES.md`, Ф2).
    #[error("'{path}' changed outside Mine; nothing was merged")]
    SourceChanged { path: String },

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
pub(crate) struct BlockRemovedPayload {
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
    /// The note as read: its text and model. The rewrite is carried into this
    /// text rather than rebuilt from the model (SPEC_AUDIT_FIXES.md, Ф1).
    source: String,
    before: Block,
    block: Block,
}

struct MediaAssetBlockWrite {
    path: PathBuf,
    source: String,
    before: Block,
    block: Block,
}

struct FileRename {
    from: PathBuf,
    to: PathBuf,
}

#[derive(Debug)]
struct MergeSourceBlock {
    path: PathBuf,
    /// The note as read: the merged card is built from it, so the note is
    /// deleted only while it still holds this text.
    source: String,
    block: Block,
}

#[derive(Debug)]
struct MergeReferenceWrite {
    path: PathBuf,
    source: String,
    before: Block,
    block: Block,
}

#[derive(Debug)]
pub(crate) struct MergeBlocksMutation {
    pub(crate) result: MergeBlocksResult,
    pub(crate) removed_events: Vec<BlockRemovedPayload>,
}

const IN_APP_RENAME_WATCHER_SUPPRESSION_MS: u64 = 1500;

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all blocks (lightweight — without body/description), ordered by saved_at descending.
#[tauri::command]
pub async fn list_blocks(app: AppHandle) -> Result<Vec<index::LightBlock>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (original, result) = {
            let state = app.state::<AppState>();
            let vault_state = state
                .vault_state
                .lock()
                .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
            let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
            (vs.vault.clone(), index::list_blocks_light(&vs.conn))
        };
        let (recovered, value) =
            db::recover_projection_read(&original, result, index::list_blocks_light)?;
        adopt_recovered_projection(&app, &original, recovered, value)
    })
    .await
    .map_err(|error| CommandError::Internal(format!("list_blocks task join failed: {error}")))?
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
    order: Option<crate::storage::block_queries::FeedOrder>,
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
    ensure_vault_fresh(&app, vault.clone()).await?;
    let page_offset = offset.unwrap_or(0);
    let page_limit = limit.unwrap_or(200).max(1);
    let app_for_query = app.clone();
    let current_tag_for_task = current_tag.clone();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || -> Result<GridSnapshot, CommandError> {
            read_owned_projection(&app_for_query, &vault, |conn| {
                Ok(projection::read_grid_snapshot(
                    conn,
                    current_tag_for_task.as_deref(),
                    page_offset,
                    page_limit,
                    order.unwrap_or_default(),
                )?)
            })
        })
        .await
        .map_err(|e| CommandError::Internal(format!("list_grid_blocks task join failed: {e}")))??;
    append_startup_trace(
        &app,
        "list_grid_blocks",
        &format!(
            "done generation={} blocks={} total={} has_more={}",
            snapshot.generation,
            snapshot.blocks.len(),
            snapshot.total_blocks,
            snapshot.has_more
        ),
    );
    Ok(snapshot)
}

/// Get a single block by slug.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_grid_rows(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    slugs: Vec<String>,
) -> Result<projection::GridRowsSnapshot, CommandError> {
    const MAX_BATCH: usize = 200;
    if slugs.len() > MAX_BATCH {
        return Err(CommandError::Internal(
            "preview row batch exceeds 200".into(),
        ));
    }
    let vault = current_vault_layout(&state)?;
    if vault.root().to_string_lossy() != path {
        return Err(CommandError::NoVault);
    }
    tauri::async_runtime::spawn_blocking(move || {
        read_owned_projection(&app, &vault, |conn| {
            projection::read_grid_rows(conn, path.clone(), &slugs)
        })
    })
    .await
    .map_err(|error| CommandError::Internal(format!("get_grid_rows task join failed: {error}")))?
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
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<IndexedBlock>, CommandError> {
        read_owned_projection(&app, &vault, |conn| index::get_block(conn, &slug))
    })
    .await
    .map_err(|error| CommandError::Internal(format!("get_block task join failed: {error}")))?
}

/// Resolve a note wikilink for navigation using the current indexed sources.
#[tauri::command]
pub async fn resolve_note_link(
    app: AppHandle,
    state: State<'_, AppState>,
    source_slug: String,
    raw_target: String,
) -> Result<Option<String>, CommandError> {
    validate_slug(&source_slug).map_err(|error| CommandError::Internal(error.to_string()))?;
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, CommandError> {
        read_owned_projection(&app, &vault, |conn| {
            crate::storage::block_queries::resolve_note_link(conn, &source_slug, &raw_target)
        })
    })
    .await
    .map_err(|error| {
        CommandError::Internal(format!("resolve_note_link task join failed: {error}"))
    })?
}

/// Create a new block through the shared capture rules and native transaction.
#[tauri::command(rename_all = "snake_case")]
pub fn create_block(
    state: State<'_, AppState>,
    params: CreateBlockParams,
) -> Result<IndexedBlock, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    let vault = files::layout_for_new_files(&vs.vault)?;
    create_block_inner(&vs.conn, &vault, params)
}

/// The desktop create adapter, also exercised without constructing a GUI.
pub(crate) fn create_block_inner(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    params: CreateBlockParams,
) -> Result<IndexedBlock, CommandError> {
    let name = if let Some(source) = params.file_path.as_deref() {
        let ext = Path::new(source)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("bin");
        let mut paths = files::scan_vault_file_paths(vault)?;
        let mut statement = conn
            .prepare("SELECT slug FROM blocks")
            .map_err(|error| CommandError::Internal(error.to_string()))?;
        for row in statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| CommandError::Internal(error.to_string()))?
        {
            paths.push(format!(
                "{}.md",
                row.map_err(|error| CommandError::Internal(error.to_string()))?
            ));
        }
        mine_core::save::select_unique_file_bundle_stem(
            &suggest_slug(params.title.as_deref(), params.url.as_deref()),
            &["md", ext],
            &paths,
        )
        .map_err(|error| CommandError::Internal(error.to_string()))?
    } else {
        select_capture_name(conn, vault, params.title.as_deref(), params.url.as_deref())?
    };
    let media_file = params
        .file_path
        .as_deref()
        .map(|source| {
            let ext = Path::new(source)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("bin");
            let filename = format!("{name}.{ext}");
            let target = vault.new_media_stem(&filename);
            let mut paths = files::scan_vault_file_paths(vault)?;
            paths.push(target.clone());
            mine_core::links::LinkIndex::new(paths)
                .shortest_link(&target, false)
                .ok_or_else(|| anyhow::anyhow!("new media link target is unavailable"))
        })
        .transpose()?;
    let block = mine_core::save::build_capture(&mine_core::save::CaptureRequest {
        slug: vault.new_card_slug(&name),
        intent: mine_core::save::CaptureIntent::Desktop,
        block_type: params.block_type,
        title: params.title,
        url: params.url,
        tags: params.tags,
        file: media_file,
        body: params.body.unwrap_or_default(),
        saved_at: crate::util::now_saved_at(),
        ..Default::default()
    })
    .map_err(|error| CommandError::Internal(error.to_string()))?;
    Ok(files::persist_new_block(
        conn,
        vault,
        &block,
        params.file_path.as_deref().map(Path::new),
    )?)
}

/// Collect native facts; the portable core owns the filename decision.
pub(crate) fn select_capture_name(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    title: Option<&str>,
    url: Option<&str>,
) -> anyhow::Result<String> {
    let mut existing = files::scan_vault_file_paths(vault)?;
    let mut statement = conn.prepare("SELECT slug FROM blocks")?;
    for row in statement.query_map([], |row| row.get::<_, String>(0))? {
        existing.push(format!("{}.md", row?));
    }
    Ok(mine_core::save::select_name(
        vault.write_layout(),
        title,
        url,
        &existing,
    )?)
}

/// Extract a local inline image from an article body into a new image block.
#[tauri::command(rename_all = "snake_case")]
pub async fn extract_inline_media(
    app: AppHandle,
    state: State<'_, AppState>,
    params: ExtractInlineMediaParams,
) -> Result<IndexedBlock, InlineMediaExtractError> {
    let ExtractInlineMediaParams {
        source_slug,
        media_ref,
        target_tag,
    } = params;
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
        files::layout_for_new_files(&vs.vault).map_err(internal_extract_error)?
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
    params: CreateMediaAssetCardParams,
) -> Result<IndexedBlock, MediaAssetActionError> {
    let CreateMediaAssetCardParams {
        media_ref,
        target_tag,
        source_slug,
    } = params;
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
    params: RenameMediaAssetParams,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    let RenameMediaAssetParams {
        media_ref,
        new_stem,
    } = params;
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
    params: RemoveMediaAssetFromCardParams,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    let RemoveMediaAssetFromCardParams {
        media_ref,
        source_slug,
        reference_kind,
        occurrence_index,
    } = params;
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
        reference_kind.as_str().to_string(),
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

/// Remove the card's source video: its YouTube `url`, its `thumbnail`
/// property, and the poster file when no other card references it. Title,
/// body, collections and the card file stay. See SPEC_MEDIA_ASSET_ACTIONS.md
/// «Меню видео источника».
#[tauri::command(rename_all = "snake_case")]
pub fn delete_source_video(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| MediaAssetActionError::Internal {
            message: "vault state mutex poisoned".into(),
        })?;
    let vs = vault_state.as_ref().ok_or(MediaAssetActionError::NoVault)?;

    let result = delete_source_video_inner(&state, &vs.conn, &vs.vault, &slug)?;
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

/// Publish a downloaded source video into the vault and embed it under the
/// card's heading. Called by the download job once the file is complete; the
/// card is re-read here, so edits made during the download are kept. See
/// `SPEC_MEDIA_ASSET_ACTIONS.md` «Download Media».
/// Publish a downloaded video into the space the download started in
/// (`SPEC_AUDIT_FIXES.md`, Ф9): through the open index when that space is open;
/// straight into its folder and index when another one is open; and when
/// its folder is not there, kept in its derived store until it opens again.
pub(crate) fn attach_downloaded_source_video(
    app: &AppHandle,
    vault: &VaultLayout,
    slug: &str,
    video_id: &str,
    downloaded: &Path,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    let state = app.state::<AppState>();
    let published = publish_downloaded_source_video(&state, vault, slug, video_id, downloaded)?;
    let Some(open_root) = published.open_root else {
        return Ok(published.result);
    };
    for slug in &published.result.affected_slugs {
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
            path: open_root.to_string_lossy().to_string(),
        },
    )
    .map_err(|e| MediaAssetActionError::Internal {
        message: format!("failed to emit vault-changed: {e}"),
    })?;
    Ok(published.result)
}

/// A downloaded video published into its space.
struct PublishedSourceVideo {
    result: MediaAssetMutationResult,
    /// The folder of the open space when the video went into it: the
    /// interface is told about it. `None` for a space that is not open.
    open_root: Option<PathBuf>,
}

/// The open space takes the video only when it is the space the download
/// started in, the same folder holding the same identity; a space placed at
/// that folder since is another space (`SPEC_AUDIT_FIXES.md`, Ф9, Б3.4).
fn publish_downloaded_source_video(
    state: &AppState,
    vault: &VaultLayout,
    slug: &str,
    video_id: &str,
    downloaded: &Path,
) -> Result<PublishedSourceVideo, MediaAssetActionError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| MediaAssetActionError::Internal {
            message: "vault state mutex poisoned".into(),
        })?;
    // The open session outlives its folder until the folder watch notices: a
    // disconnected disk still leaves the space "open". Only a folder still
    // there takes the video through the session; otherwise the closed-space
    // path keeps it for the space (`SPEC_AUDIT_FIXES.md`, Ф9, Г2.2).
    if let Some(vs) = vault_state.as_ref().filter(|vs| {
        crate::source_video_download::same_space(&vs.vault, vault)
            && !crate::storage::root_guard::root_gone(&vs.vault)
    }) {
        let result =
            attach_downloaded_source_video_inner(state, &vs.conn, &vs.vault, slug, video_id, downloaded)?;
        return Ok(PublishedSourceVideo {
            result,
            open_root: Some(vs.vault.root().to_path_buf()),
        });
    }
    drop(vault_state);
    Ok(PublishedSourceVideo {
        result: attach_into_closed_space(state, vault, slug, video_id, downloaded)?,
        open_root: None,
    })
}

/// The space the download started in is not the open one. While its folder
/// is proven to still hold that space, the video goes straight in; otherwise
/// it is kept for when the space opens again.
///
/// Proof is an identity read on this Mac. One iCloud has not brought here is
/// no proof: another space may stand in the folder, and a write would put
/// this space's video into that space's card, or fail and lose the video
/// (`SPEC_AUDIT_FIXES.md`, Ф9, В3.3).
fn attach_into_closed_space(
    state: &AppState,
    vault: &VaultLayout,
    slug: &str,
    video_id: &str,
    downloaded: &Path,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    let identity = vault
        .derived_root()
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string);
    let holds = match crate::space_registry::space_identity(vault.root()) {
        crate::space_registry::SpaceIdentity::Known(found) => identity.as_deref() == Some(found.as_str()),
        crate::space_registry::SpaceIdentity::InCloud | crate::space_registry::SpaceIdentity::Absent => {
            false
        }
    };
    if !holds {
        crate::source_video_download::keep_download(vault, slug, video_id, downloaded)
            .map_err(|message| MediaAssetActionError::Internal { message })?;
        return Ok(MediaAssetMutationResult {
            media_ref: String::new(),
            new_media_ref: None,
            affected_slugs: Vec::new(),
        });
    }
    let conn = db::open_or_create(&vault.index_db_path()).map_err(internal_media_asset_error)?;
    attach_downloaded_source_video_inner(state, &conn, vault, slug, video_id, downloaded)
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
    params: ExtractTextSelectionParams,
) -> Result<IndexedBlock, TextSelectionExtractError> {
    let ExtractTextSelectionParams {
        source_slug,
        target_tag,
        selected_text,
        first_block_start,
        first_block_end,
        source_body_hash,
    } = params;
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
        files::layout_for_new_files(&vs.vault).map_err(internal_text_selection_error)?
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
    params: DeleteTextSelectionParams,
) -> Result<IndexedBlock, TextSelectionExtractError> {
    let DeleteTextSelectionParams {
        source_slug,
        selected_text,
        first_block_start,
        first_block_end,
        source_body_hash,
    } = params;
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
    let media_link =
        files::shortest_vault_link(vault, &media_file, false).map_err(internal_extract_error)?;
    let source_link = files::shortest_vault_link(vault, &format!("{}.md", source_block.slug), true)
        .map_err(internal_extract_error)?;
    let now = crate::commands::state::now_saved_at();
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
            file: Some(media_link.clone()),
            thumbnail: None,
            tags: vec![target_tag.clone()],
            related_notes: vec![source_link],
            source_media: Some(media_link),
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
    let media_link =
        files::shortest_vault_link(vault, &media_ref, false).map_err(internal_media_asset_error)?;
    let source_link = source_block
        .as_ref()
        .map(|block| files::shortest_vault_link(vault, &format!("{}.md", block.slug), true))
        .transpose()
        .map_err(internal_media_asset_error)?;
    let now = crate::commands::state::now_saved_at();
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
            file: Some(media_link.clone()),
            thumbnail: None,
            tags: if target_tag.is_empty() {
                Vec::new()
            } else {
                vec![target_tag]
            },
            related_notes: source_link.into_iter().collect(),
            source_media: Some(media_link),
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
    let source_link = files::shortest_vault_link(vault, &format!("{}.md", source_block.slug), true)
        .map_err(internal_text_selection_error)?;
    let now = crate::commands::state::now_saved_at();
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
            related_notes: vec![format!("{}#^{}", source_link, block_id)],
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
        writes.push(SourceFileWrite::replace(
            source_path,
            content.into_bytes(),
            updated.into_bytes(),
        ));
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
        selected_text_source_span(&source_block.body[block_start..], selected_text)
            .map(|(start, end)| (block_start + start, block_start + end))
            .ok_or_else(|| TextSelectionExtractError::UnsupportedSelectionShape {
                reason: "selected text could not be located in the current source body".to_string(),
            })?;
    if selection_start < block_start || selection_start >= block_end {
        return Err(TextSelectionExtractError::UnsupportedSelectionShape {
            reason: "selected text does not belong to the provided source block range".to_string(),
        });
    }
    if selection_end < block_end
        && selected_text_source_span(&source_block.body[selection_end..block_end], selected_text)
            .is_some()
    {
        return Err(TextSelectionExtractError::UnsupportedSelectionShape {
            reason: "selection is ambiguous inside the source block".into(),
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
        content.into_bytes(),
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
        Some(&state),
        &vs.conn,
        &vs.vault,
        &old_slug,
        &new_stem,
    )
}

/// Prepare a user-visible deletion plan for a block.
#[tauri::command]
pub async fn prepare_delete_block(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
) -> Result<DeleteBlockPlan, CommandError> {
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let vault = current_vault_layout(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (block, blocks) = super::state::read_owned_projection(&app, &vault, |conn| {
            Ok((index::get_block(conn, &slug)?, index::list_blocks(conn)?))
        })?;
        let block =
            block.ok_or_else(|| CommandError::Internal(format!("block not found: {slug}")))?;
        Ok(build_delete_block_plan_from_blocks(
            &vault, &slug, &block, blocks,
        ))
    })
    .await
    .map_err(|error| CommandError::Internal(format!("delete plan task failed: {error}")))?
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

    delete_block_inner(
        Some(&state),
        &vs.conn,
        &vs.vault,
        &slug,
        delete_unused_media,
    )
}

/// Delete a selection while retaining all media, in one rollback-safe batch.
#[tauri::command]
pub async fn delete_blocks(app: AppHandle, slugs: Vec<String>) -> Result<usize, CommandError> {
    let expected_vault = current_vault_layout(&app.state::<AppState>())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let guard = state
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        let vs = guard.as_ref().ok_or(CommandError::NoVault)?;
        if vs.vault.root() != expected_vault.root() {
            return Err(CommandError::Internal(
                "active space changed before deletion".into(),
            ));
        }
        delete_blocks_inner(Some(&state), &vs.conn, &vs.vault, slugs)
    })
    .await
    .map_err(|error| CommandError::Internal(error.to_string()))?
}

pub(crate) fn delete_blocks_inner(
    state: Option<&AppState>,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    slugs: Vec<String>,
) -> Result<usize, CommandError> {
    let slugs: BTreeSet<String> = slugs.into_iter().collect();
    for slug in &slugs {
        validate_slug(slug).map_err(|error| CommandError::Internal(error.to_string()))?;
    }
    if slugs.is_empty() {
        return Ok(0);
    }
    let paths: Vec<PathBuf> = slugs.iter().map(|slug| vault.block_path(slug)).collect();
    if let Some(state) = state {
        state.suppress_paths(
            paths.iter().cloned(),
            Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
        )?;
    }
    let staged = StagedSourceMutation::stage(
        paths
            .into_iter()
            .filter(|path| path.exists())
            .map(SourceFileWrite::delete)
            .collect(),
    )
    .map_err(|error| CommandError::Internal(error.to_string()))?;
    let removed = staged
        .commit_with_index(conn, "delete_blocks", |index_conn| {
            let mut removed = 0;
            for slug in &slugs {
                removed += usize::from(index::remove_block(index_conn, slug)?);
            }
            Ok(removed)
        })
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    for slug in &slugs {
        let thumb = vault.thumb_path(slug);
        if thumb.exists() {
            let _ = std::fs::remove_file(thumb);
        }
        if let Err(error) = article_audio::delete_all_artifacts(vault, slug) {
            log::warn!("failed to clean deleted card audio for {slug}: {error:#}");
        }
    }
    Ok(removed)
}

pub(crate) fn delete_block_inner(
    state: Option<&AppState>,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    slug: &str,
    delete_unused_media: Option<bool>,
) -> Result<bool, CommandError> {
    validate_slug(slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    // Retaining media needs no vault-wide media reference analysis.
    if delete_unused_media == Some(false) {
        return delete_blocks_inner(state, conn, vault, vec![slug.to_string()])
            .map(|removed| removed > 0);
    }
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
    // No watcher lives in a CLI process; the app's own watcher must in fact
    // see an out-of-process mutation, so suppression applies only in-app.
    if let Some(state) = state {
        state.suppress_paths(
            source_paths.iter().cloned(),
            Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
        )?;
    }

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
    let vault = files::layout_for_new_files(&vs.vault).map_err(internal_merge_error)?;
    let mutation = merge_blocks_inner(Some(&state), &vs.conn, &vault, ordered_slugs)?;
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

pub(crate) fn build_delete_block_plan(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    slug: &str,
) -> Result<DeleteBlockPlan, CommandError> {
    let block = index::get_block(conn, slug)?
        .ok_or_else(|| CommandError::Internal(format!("block not found: {slug}")))?;
    let mut plan = build_delete_block_plan_from_blocks(vault, slug, &block, index::list_blocks(conn)?);
    // The index may not have caught up with a note saved a moment ago: media
    // it calls unused is checked against the notes on disk before it may go.
    let candidates: Vec<PathBuf> = plan
        .unused_media
        .iter()
        .map(|media| media.absolute_path.clone())
        .collect();
    let users = media_users_on_disk(vault, &candidates, Some(&vault.block_path(slug)))?;
    let (still_used, unused): (Vec<_>, Vec<_>) = std::mem::take(&mut plan.unused_media)
        .into_iter()
        .partition(|media| users.contains_key(&media.absolute_path));
    plan.unused_media = unused;
    for mut media in still_used {
        media.referenced_by = users[&media.absolute_path].iter().cloned().collect();
        plan.shared_media.push(media);
    }
    Ok(plan)
}

/// The notes on disk that use each of `media`, by slug (SPEC_AUDIT_FIXES.md,
/// Ф4). Every note is read and parsed, so a reference counts in whatever form
/// the parser reads it: a percent-encoded Markdown path, an escaped YAML
/// value, another Unicode normalization, and any link form Obsidian reads, not
/// only an embed (`iter_file_references`, Г1.1). Path resolution, the
/// expensive step, runs only for a note whose references hold a candidate's
/// name. `skip` is a note that is going away with the media.
pub(crate) fn media_users_on_disk(
    vault: &VaultLayout,
    media: &[PathBuf],
    skip: Option<&Path>,
) -> anyhow::Result<BTreeMap<PathBuf, BTreeSet<String>>> {
    let mut users: BTreeMap<PathBuf, BTreeSet<String>> = BTreeMap::new();
    let names: Vec<(&PathBuf, String)> = media
        .iter()
        .filter_map(|path| Some((path, fold_media_name(path.file_name()?.to_str()?))))
        .collect();
    if names.is_empty() {
        return Ok(users);
    }
    let mut resolver = media_refs::MediaResolver::new(vault);
    for note in files::scan_md_files(vault)? {
        if skip == Some(note.as_path()) {
            continue;
        }
        let (slug, content) = files::read_block_file(vault, &note)?;
        let block = parse_markdown_document(&slug, &content, file_saved_at(&note))?.block;
        let references = iter_file_references(&block.body);
        let forms = media_reference_forms(&block, &references);
        for (path, name) in &names {
            if forms.iter().any(|form| form.contains(name.as_str()))
                && note_uses_media(&mut resolver, &block, &references, path)
            {
                users.entry((*path).clone()).or_default().insert(slug.clone());
            }
        }
    }
    Ok(users)
}

/// Whether `block`, whose body makes `references`, names `media_path` in its
/// file or thumbnail or in any reference of its body.
fn note_uses_media(
    resolver: &mut media_refs::MediaResolver<'_>,
    block: &Block,
    references: &[FileReference],
    media_path: &Path,
) -> bool {
    let frontmatter = [&block.frontmatter.file, &block.frontmatter.thumbnail];
    frontmatter
        .into_iter()
        .flatten()
        .any(|reference| {
            resolver
                .resolve_indexed_media(&block.slug, reference)
                .is_some_and(|path| same_path(&path, media_path))
        })
        || references.iter().any(|reference| {
            resolver
                .resolve_file_reference(&block.slug, reference)
                .is_some_and(|path| same_path(&path, media_path))
        })
}

/// A file name or a reference in one Unicode normalization and one letter
/// case: the way the file system compares names, so the pre-resolution match
/// never misses a reference the resolver would accept.
fn fold_media_name(text: &str) -> String {
    text.nfc().collect::<String>().to_lowercase()
}

/// Every reference of `block` that `note_uses_media` resolves (the
/// frontmatter file and thumbnail, each of `references`), as written and
/// percent-decoded, folded by `fold_media_name`.
fn media_reference_forms(block: &Block, references: &[FileReference]) -> Vec<String> {
    block
        .frontmatter
        .file
        .iter()
        .chain(block.frontmatter.thumbnail.iter())
        .map(String::as_str)
        .chain(references.iter().map(|reference| reference.target.as_str()))
        .flat_map(|reference| {
            let decoded = percent_encoding::percent_decode_str(reference).decode_utf8_lossy();
            [fold_media_name(reference), fold_media_name(&decoded)]
        })
        .collect()
}

fn build_delete_block_plan_from_blocks(
    vault: &VaultLayout,
    slug: &str,
    block: &IndexedBlock,
    blocks: Vec<IndexedBlock>,
) -> DeleteBlockPlan {
    let mut current_resolver = media_refs::MediaResolver::new(vault);
    let current_media = collect_delete_media_for_block(vault, &block, &mut current_resolver);

    let mut other_refs: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut shared_resolver = media_refs::MediaResolver::new(vault);
    for other in blocks {
        if other.slug == slug {
            continue;
        }
        for media in collect_used_media_for_block(vault, &other, &mut shared_resolver).values() {
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

    DeleteBlockPlan {
        slug: slug.to_string(),
        markdown_file: format!("{slug}.md"),
        unused_media,
        shared_media,
    }
}

pub(crate) fn merge_blocks_inner(
    state: Option<&AppState>,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    ordered_slugs: Vec<String>,
) -> Result<MergeBlocksMutation, MergeBlocksError> {
    let plan = plan_merge_blocks(conn, vault, ordered_slugs)?;
    apply_merge_plan(state, conn, vault, plan)
}

/// A merge read from disk and ready to write. It carries the text of every
/// note it was built from: the write goes ahead only while the notes still
/// hold that text.
struct MergePlan {
    ordered_slugs: Vec<String>,
    sources: Vec<MergeSourceBlock>,
    merged_block: Block,
    reference_writes: Vec<MergeReferenceWrite>,
}

fn plan_merge_blocks(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    ordered_slugs: Vec<String>,
) -> Result<MergePlan, MergeBlocksError> {
    let ordered_slugs = validate_merge_slugs(ordered_slugs)?;
    let selected_slugs: BTreeSet<String> = ordered_slugs.iter().cloned().collect();
    let sources = load_merge_source_blocks(vault, &ordered_slugs)?;
    let merged_slug = merged_block_slug(conn, vault, &sources)?;
    let moves = merge_note_moves(vault, &sources, &merged_slug)?;
    let mut merged_block = build_merged_block(&sources, &moves, merged_slug)?;
    merged_block.body = retarget_wikilinks(&merged_block.body, |target| moves.retarget(target));
    let reference_writes = build_merge_reference_writes(vault, &selected_slugs, &moves)?;
    Ok(MergePlan {
        ordered_slugs,
        sources,
        merged_block,
        reference_writes,
    })
}

fn apply_merge_plan(
    state: Option<&AppState>,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    plan: MergePlan,
) -> Result<MergeBlocksMutation, MergeBlocksError> {
    let MergePlan {
        ordered_slugs,
        sources,
        merged_block,
        reference_writes,
    } = plan;
    let removed_events = sources
        .iter()
        .map(|source| BlockRemovedPayload {
            slug: source.block.slug.clone(),
            tags: source.block.frontmatter.tags.clone(),
        })
        .collect();

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
    if let Some(state) = state {
        state
            .suppress_paths(
                suppressed_paths.iter().cloned(),
                Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
            )
            .map_err(internal_merge_error)?;
    }

    let indexed = match apply_merge_blocks(conn, vault, &merged_block, &sources, &reference_writes) {
        Ok(indexed) => indexed,
        Err(error) => {
            let notes: Vec<PathBuf> = std::iter::once(merged_path)
                .chain(sources.iter().map(|source| source.path.clone()))
                .chain(reference_writes.iter().map(|write| write.path.clone()))
                .collect();
            follow_notes_after_refused_write(state, conn, vault, &suppressed_paths, &notes);
            return Err(error);
        }
    };
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

/// A write that did not go through leaves every note as it is on disk now,
/// which may include an edit made outside Mine while the write ran: the very
/// edit that made it refuse. The watcher events of that edit fell inside the
/// suppression the write set up, so the index takes the notes from disk here,
/// and the suppression is lifted for whatever comes next
/// (`SPEC_AUDIT_FIXES.md`, Ф7, Б1.7).
fn follow_notes_after_refused_write(
    state: Option<&AppState>,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    suppressed: &[PathBuf],
    notes: &[PathBuf],
) {
    if let Some(state) = state {
        match state.suppressed_paths.lock() {
            Ok(mut paths) => {
                for path in suppressed {
                    paths.remove(path);
                }
            }
            Err(_) => log::warn!("suppressed_paths mutex poisoned; watcher events resume at their deadline"),
        }
    }
    if let Err(error) = project_notes_from_disk(conn, vault, notes) {
        log::warn!("the index follows the refused write's notes at the next reconciliation: {error:#}");
    }
}

/// Index each of `notes` as it is on disk: present ones are projected, absent
/// ones removed, in one transaction.
fn project_notes_from_disk(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    notes: &[PathBuf],
) -> anyhow::Result<()> {
    let transaction = conn.unchecked_transaction()?;
    for path in notes {
        if path.is_file() {
            reconcile::project_source_path(&transaction, vault, path)?;
        } else {
            reconcile::remove_source_projection(&transaction, vault, &vault.slug_for_path(path)?)?;
        }
    }
    transaction.commit()?;
    Ok(())
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
    for write in reference_writes {
        let patched = apply_block_changes(&write.source, &write.before, &write.block)
            .map_err(|error| MergeBlocksError::ReferenceRewriteFailed {
                path: write.path.to_string_lossy().to_string(),
                message: error.to_string(),
            })?;
        writes.push(SourceFileWrite::replace(
            write.path.clone(),
            write.source.clone().into_bytes(),
            patched.into_bytes(),
        ));
    }
    writes.extend(sources.iter().map(|source| {
        SourceFileWrite::delete_if_unchanged(source.path.clone(), source.source.clone().into_bytes())
    }));
    let staged = StagedSourceMutation::stage(writes).map_err(merge_mutation_error)?;
    let merged_path = vault.block_path(&merged_block.slug);
    staged
        .commit_with_index(conn, "merge_blocks", |index_conn| {
            reconcile::project_source_path(index_conn, vault, &merged_path)?;
            for write in reference_writes {
                reconcile::project_source_path(index_conn, vault, &write.path)?;
            }
            for source in sources {
                reconcile::remove_source_projection(index_conn, vault, &source.block.slug)?;
            }
            Ok(())
        })
        .map_err(merge_mutation_error)?;

    reconcile_committed_preview(conn, vault, &merged_block.slug);

    for write in reference_writes {
        reconcile_committed_preview(conn, vault, &write.block.slug);
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

    index::get_block(conn, &merged_block.slug)
        .map_err(internal_merge_error)?
        .ok_or_else(|| {
            internal_merge_error(anyhow::anyhow!(
                "merged block '{}' missing from index after preview reconciliation",
                merged_block.slug
            ))
        })
}

fn reconcile_committed_preview(conn: &rusqlite::Connection, vault: &VaultLayout, slug: &str) {
    if let Err(error) = derived_preview::reconcile_preview_for_slug(conn, vault, slug) {
        log::warn!("failed to reconcile committed preview for {slug}: {error:#}");
    }
    let _ = index::sync_thumb_metadata(conn, slug, &vault.thumb_path(slug), Some(vault.root()));
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
            source: content,
            block: parsed.block,
        });
    }
    Ok(sources)
}

/// The name of the merged card: the first card's title, marked as merged.
fn merged_block_slug(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    sources: &[MergeSourceBlock],
) -> Result<String, MergeBlocksError> {
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
    resolve_unique_block_slug(conn, vault, &raw_slug, None).map_err(internal_merge_error)
}

/// Every merged card's links now lead to the merged card.
fn merge_note_moves(
    vault: &VaultLayout,
    sources: &[MergeSourceBlock],
    merged_slug: &str,
) -> Result<NoteMoves, MergeBlocksError> {
    let merged_path = format!("{merged_slug}.md");
    let moves: Vec<(String, String)> = sources
        .iter()
        .map(|source| (format!("{}.md", source.block.slug), merged_path.clone()))
        .collect();
    Ok(NoteMoves::new(
        files::scan_vault_file_paths(vault).map_err(internal_merge_error)?,
        &moves,
    ))
}

fn build_merged_block(
    sources: &[MergeSourceBlock],
    moves: &NoteMoves,
    slug: String,
) -> Result<Block, MergeBlocksError> {
    let now = crate::commands::state::now_saved_at();
    let saved_at = DateTime::new(&now).map_err(internal_merge_error)?;

    let mut tags = Vec::new();
    let mut related_notes = Vec::new();
    for source in sources {
        for tag in &source.block.frontmatter.tags {
            push_unique(&mut tags, tag.clone());
        }
        for note in &source.block.frontmatter.related_notes {
            // A link between merged cards would point the card at itself.
            if moves.retarget(link_file_part(note)).is_some() {
                continue;
            }
            push_unique(&mut related_notes, note.clone());
        }
    }

    // Each section moves from its note's folder into the merged card's: its
    // Markdown paths are written again from there (`SPEC_AUDIT_FIXES.md`,
    // В1.3).
    let merged_note = format!("{slug}.md");
    let body = sources
        .iter()
        .map(|source| {
            let note = format!("{}.md", source.block.slug);
            retarget_markdown_destinations(&merged_section_body(&source.block), |destination| {
                moves.retarget_markdown(&note, &merged_note, destination)
            })
        })
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
    moves: &NoteMoves,
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
        if !moves.may_be_linked_from(&content) {
            continue;
        }
        let parsed =
            parse_markdown_document(&slug, &content, file_saved_at(&path)).map_err(|e| {
                MergeBlocksError::ReferenceRewriteFailed {
                    path: path.to_string_lossy().to_string(),
                    message: e.to_string(),
                }
            })?;
        let note = format!("{slug}.md");
        let rewritten = rewrite_note_links(&parsed.block, moves, &note, &note);
        if rewritten.frontmatter != parsed.block.frontmatter || rewritten.body != parsed.block.body
        {
            writes.push(MergeReferenceWrite {
                path,
                source: content,
                before: parsed.block,
                block: rewritten,
            });
        }
    }
    Ok(writes)
}

/// Point a note's links at the notes and media that move (`SPEC_AUDIT_FIXES.md`,
/// Ф3, В1.3): wikilinks in the body and `Mine Related Notes`, resolved the
/// way Obsidian resolves them; Markdown links and images, and a `file` or
/// `thumbnail` property written as a path from the note, resolved from the
/// note's folder. `note_before` and `note_after` are the note's own path
/// before and after the operation: when its folder changes, each such path
/// is written again from the new folder, so it names the same file.
fn rewrite_note_links(block: &Block, moves: &NoteMoves, note_before: &str, note_after: &str) -> Block {
    let mut rewritten = block.clone();
    for note in &mut rewritten.frontmatter.related_notes {
        if let Some(updated) = retarget_related_note(note, moves) {
            *note = updated;
        }
    }
    dedupe_strings(&mut rewritten.frontmatter.related_notes);
    rewritten.body = retarget_wikilinks(&rewritten.body, |target| moves.retarget(target));
    rewritten.body = retarget_markdown_destinations(&rewritten.body, |destination| {
        moves.retarget_markdown(note_before, note_after, destination)
    });
    for property in [&mut rewritten.frontmatter.file, &mut rewritten.frontmatter.thumbnail] {
        let updated = property
            .as_deref()
            .and_then(|reference| retarget_note_relative_property(reference, moves, note_before, note_after));
        if updated.is_some() {
            *property = updated;
        }
    }
    rewritten
}

/// Whether a `file` or `thumbnail` property names its file by a path from
/// the note, which is how `media_refs::resolve_frontmatter_media` reads it.
fn is_note_relative_property(reference: &str) -> bool {
    reference.starts_with("./") || reference.starts_with("../")
}

/// The new value of a property written as a path from the note: resolved and
/// written again like a Markdown destination, and still a path from the note.
fn retarget_note_relative_property(
    reference: &str,
    moves: &NoteMoves,
    note_before: &str,
    note_after: &str,
) -> Option<String> {
    if !is_note_relative_property(reference) {
        return None;
    }
    let path = moves.retarget_markdown(note_before, note_after, reference)?;
    Some(if is_note_relative_property(&path) {
        path
    } else {
        format!("./{path}")
    })
}

/// A related note keeps its heading or block fragment when its note moves.
fn retarget_related_note(note: &str, moves: &NoteMoves) -> Option<String> {
    let (base, fragment) = mine_core::links::split_link_fragment(note);
    let target = moves.retarget(base)?;
    Some(match fragment {
        Some(fragment) => format!("{target}#{fragment}"),
        None => target,
    })
}

fn merged_section_body(block: &Block) -> String {
    let mut parts = Vec::new();
    let body = block.body.trim();
    if let Some(file) = trimmed_option(block.frontmatter.file.as_deref()) {
        if body.is_empty() || !body.contains(file) {
            // A path from the note stays one, as a Markdown image the merge
            // writes again from the merged card's folder; a wikilink would
            // not resolve it.
            parts.push(if is_note_relative_property(file) {
                format!("![](<{}>)", file.replace('<', "%3C").replace('>', "%3E"))
            } else {
                format!("![[{file}]]")
            });
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

/// Every file `block` uses, as far as deleting media is concerned
/// (SPEC_AUDIT_FIXES.md, Ф4, Г1.1): its own media
/// (`collect_delete_media_for_block`) and every other file its body links in
/// a form Obsidian reads (`iter_file_references`). What a card shows goes
/// with it; what any other note merely links stays. The notes on disk are
/// asked the same question by `media_users_on_disk`.
pub(crate) fn collect_used_media_for_block(
    vault: &VaultLayout,
    block: &IndexedBlock,
    resolver: &mut media_refs::MediaResolver<'_>,
) -> BTreeMap<String, DeleteBlockMedia> {
    let mut media = collect_delete_media_for_block(vault, block, resolver);
    if validate_slug(&block.slug).is_err() {
        return media;
    }
    for reference in iter_file_references(&block.body) {
        if let Some(path) = resolver.resolve_file_reference(&block.slug, &reference) {
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
            kind: delete_media_kind(&root_relative),
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
        .map(media_asset_source_write)
        .collect::<Result<Vec<_>, _>>()?;
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

    let mut source_writes = planned_writes
        .iter()
        .map(media_asset_source_write)
        .collect::<Result<Vec<_>, _>>()?;
    source_writes.push(SourceFileWrite::delete(media_path.clone()));
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
    let before = parsed.block.clone();
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
            // With an opener index the reader clicked one image: exactly that
            // reference goes, and only while it still shows this media
            // (SPEC_AUDIT_FIXES.md, Г1.4). Without one every reference to the
            // media goes.
            let next_body = match occurrence_index {
                Some(opener) => {
                    let (next_body, reference) =
                        remove_inline_media_reference_at_opener(&block.body, opener).ok_or_else(
                            || MediaAssetActionError::InvalidMediaRef {
                                reason: format!(
                                    "no image starts at opener {opener} of {source_slug}: the card changed"
                                ),
                            },
                        )?;
                    if !media_refs::resolve_inline_media(vault, &block.slug, &reference)
                        .is_some_and(|path| same_path(&path, &media_path))
                    {
                        return Err(MediaAssetActionError::InvalidMediaRef {
                            reason: format!(
                                "the image at opener {opener} of {source_slug} shows other media: the card changed"
                            ),
                        });
                    }
                    next_body
                }
                None => {
                    let mut removals = BTreeSet::new();
                    for reference in iter_inline_media_references(&block.body) {
                        if media_refs::resolve_inline_media(vault, &block.slug, &reference)
                            .is_some_and(|path| same_path(&path, &media_path))
                        {
                            removals.insert(reference.source);
                        }
                    }
                    remove_inline_media_references(&block.body, &removals)
                }
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

    let patched =
        apply_block_changes(&content, &before, &block).map_err(internal_media_asset_error)?;
    let staged = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
        source_path,
        content.into_bytes(),
        patched.into_bytes(),
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

fn delete_source_video_inner(
    state: &AppState,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    slug: &str,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    validate_slug(slug).map_err(|e| MediaAssetActionError::InvalidMediaRef {
        reason: format!("invalid card slug: {e}"),
    })?;
    let source_path = vault.block_path(slug);
    if !source_path.exists() {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: format!("card not found: {slug}"),
        });
    }
    let (read_slug, content) =
        files::read_block_file(vault, &source_path).map_err(internal_media_asset_error)?;
    let mut block = parse_markdown_document(&read_slug, &content, file_saved_at(&source_path))
        .map_err(|e| MediaAssetActionError::Internal {
            message: format!("failed to parse card: {e}"),
        })?
        .block;
    let before = block.clone();
    let source_url = block.frontmatter.url.clone().unwrap_or_default();
    if mine_core::domain::video_source::parse_youtube_source(&source_url).is_none() {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: format!("card has no source video: {slug}"),
        });
    }

    // The poster goes with the video only when nothing else shows it: not
    // another card, and not this card's own text or media field either.
    let poster_path = block
        .frontmatter
        .thumbnail
        .as_deref()
        .and_then(|reference| media_refs::resolve_indexed_media(vault, &block.slug, reference));
    let poster_to_delete = match &poster_path {
        Some(path) => {
            let shared = collect_media_asset_reference_blocks(vault, path)?
                .iter()
                .any(|reference| {
                    reference.slug != block.slug
                        || reference
                            .reference_kinds
                            .iter()
                            .any(|kind| kind != "frontmatter_thumbnail")
                });
            (!shared).then(|| path.clone())
        }
        None => None,
    };
    let media_ref = poster_to_delete
        .as_deref()
        .and_then(|path| vault.root_relative_reference(path))
        .unwrap_or_default();

    block.frontmatter.url = None;
    block.frontmatter.thumbnail = None;

    let thumb_path = vault.thumb_path(&block.slug);
    let mut suppressed = vec![source_path.clone(), thumb_path.clone()];
    suppressed.extend(poster_to_delete.iter().cloned());
    state
        .suppress_paths(
            suppressed,
            Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
        )
        .map_err(internal_media_asset_error)?;

    let patched =
        apply_block_changes(&content, &before, &block).map_err(internal_media_asset_error)?;
    let writes = std::iter::once(SourceFileWrite::replace(
        source_path,
        content.into_bytes(),
        patched.into_bytes(),
    ))
    .chain(poster_to_delete.into_iter().map(SourceFileWrite::delete))
    .collect();
    let staged = StagedSourceMutation::stage(writes).map_err(internal_media_asset_error)?;
    staged
        .commit_with_index(conn, "delete_source_video", |index_conn| {
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

fn is_remote_media_reference(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

fn is_video_file_name(source: &str) -> bool {
    Path::new(mine_core::links::link_file_part(source.split('|').next().unwrap_or(source)))
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "mp4" | "m4v" | "mov" | "webm"))
}

/// Put the video right under the card's heading, or first when there is none,
/// so it leads the card the way a saved post's video does.
fn insert_video_embed(body: &str, link: &str) -> String {
    let embed = format!("![[{link}]]");
    let trimmed = body.trim_start_matches('\n');
    if trimmed.starts_with("# ") {
        let (heading, rest) = trimmed.split_once('\n').unwrap_or((trimmed, ""));
        let rest = rest.trim_start_matches('\n');
        if rest.is_empty() {
            return format!("{heading}\n\n{embed}\n");
        }
        return format!("{heading}\n\n{embed}\n\n{rest}");
    }
    if trimmed.is_empty() {
        return format!("{embed}\n");
    }
    format!("{embed}\n\n{trimmed}")
}

fn attach_downloaded_source_video_inner(
    state: &AppState,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    slug: &str,
    video_id: &str,
    downloaded: &Path,
) -> Result<MediaAssetMutationResult, MediaAssetActionError> {
    validate_slug(slug).map_err(|e| MediaAssetActionError::InvalidMediaRef {
        reason: format!("invalid card slug: {e}"),
    })?;
    let source_path = vault.block_path(slug);
    // Only a card that is not there is gone for good. A folder that cannot
    // be read now (no access, an I/O error) says nothing about the card, and
    // an answer taken as final would discard the video (`SPEC_AUDIT_FIXES.md`,
    // Ф9, В3.1).
    match source_path.try_exists() {
        Ok(true) => {}
        // A card is gone only from a space proven present. A disk
        // disconnected or a folder renamed hides every card: that answer
        // passes, and the video is kept for the space (`SPEC_AUDIT_FIXES.md`,
        // Ф9, Г2.2).
        Ok(false) => {
            if let Err(unavailable) = crate::storage::root_guard::ensure_root_present(vault) {
                return Err(MediaAssetActionError::Internal {
                    message: format!("card {slug} cannot be looked for now: {unavailable}"),
                });
            }
            return Err(MediaAssetActionError::InvalidMediaRef {
                reason: format!("card not found: {slug}"),
            });
        }
        Err(error) => {
            return Err(MediaAssetActionError::Internal {
                message: format!("card {slug} cannot be read now: {error}"),
            })
        }
    }
    let (read_slug, content) =
        files::read_block_file(vault, &source_path).map_err(internal_media_asset_error)?;
    #[cfg(test)]
    tests::run_after_card_read_hook(&source_path);
    let mut block = parse_markdown_document(&read_slug, &content, file_saved_at(&source_path))
        .map_err(|e| MediaAssetActionError::Internal {
            message: format!("failed to parse card: {e}"),
        })?
        .block;
    let before = block.clone();
    // The card must still be the one the download started from.
    let still_same_video = block
        .frontmatter
        .url
        .as_deref()
        .and_then(mine_core::domain::video_source::parse_youtube_source)
        .is_some_and(|source| source.video_id == video_id);
    if !still_same_video {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: "the card no longer links to this video".into(),
        });
    }
    let has_body_video = iter_inline_media_references(&block.body)
        .iter()
        .any(|reference| !is_remote_media_reference(&reference.source) && is_video_file_name(&reference.source));
    if block.frontmatter.file.is_some() || has_body_video {
        return Err(MediaAssetActionError::InvalidMediaRef {
            reason: "the card already has its own video".into(),
        });
    }

    // Media is named after the card, unique across the whole space.
    let card_name = slug.rsplit('/').next().unwrap_or(slug);
    let occupied = files::scan_vault_file_paths(vault).map_err(internal_media_asset_error)?;
    let stem = mine_core::save::select_unique_file_stem(card_name, "mp4", &occupied)
        .map_err(|e| MediaAssetActionError::Internal {
            message: format!("failed to name the video file: {e}"),
        })?;
    let target = vault.new_media_stem(&format!("{stem}.mp4"));
    let media_path = vault.root().join(&target);
    let mut paths = occupied;
    paths.push(target.clone());
    let link = mine_core::links::LinkIndex::new(paths)
        .shortest_link(&target, false)
        .ok_or_else(|| MediaAssetActionError::Internal {
            message: "new video link target is unavailable".into(),
        })?;
    // The video goes into the body as an embed, the way the clipper saves a
    // post's video: that is what makes the feed show its frame and autoplay
    // it, and Detail play it inline in place of the YouTube player.
    block.body = insert_video_embed(&block.body, &link);

    let thumb_path = vault.thumb_path(&block.slug);
    state
        .suppress_paths(
            [source_path.clone(), thumb_path.clone(), media_path.clone()],
            Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
        )
        .map_err(internal_media_asset_error)?;
    if let Some(parent) = media_path.parent() {
        std::fs::create_dir_all(parent).map_err(internal_media_asset_error)?;
    }
    let patched =
        apply_block_changes(&content, &before, &block).map_err(internal_media_asset_error)?;
    let staged = StagedSourceMutation::stage(vec![
        SourceFileWrite::rename(downloaded.to_path_buf(), media_path.clone()),
        SourceFileWrite::replace(source_path, content.into_bytes(), patched.into_bytes()),
    ])
    .map_err(internal_media_asset_error)?;
    staged
        .commit_with_index(conn, "attach_downloaded_source_video", |index_conn| {
            index::upsert_block(index_conn, &block, Some(vault.root())).map(|_| ())
        })
        .map_err(internal_media_asset_error)?;
    let _ = thumbnails::generate_for_block(&block, vault);
    let _ = index::sync_thumb_metadata(conn, &block.slug, &thumb_path, Some(vault.root()));

    Ok(MediaAssetMutationResult {
        media_ref: vault.root_relative_reference(&media_path).unwrap_or(target),
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

fn delete_media_kind(root_relative: &str) -> DeleteMediaAssetKind {
    let ext = Path::new(root_relative)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();
    if thumbnails::is_image_ext(&ext) {
        DeleteMediaAssetKind::Image
    } else if thumbnails::is_video_ext(&ext) {
        DeleteMediaAssetKind::Video
    } else if matches!(ext.as_str(), "mp3" | "m4a" | "wav" | "aac" | "flac" | "ogg") {
        DeleteMediaAssetKind::Audio
    } else if ext == "pdf" {
        DeleteMediaAssetKind::Document
    } else {
        DeleteMediaAssetKind::File
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
    let candidate = if !media_ref.contains('/') {
        media_refs::MediaResolver::new(vault)
            .unique_basename(media_ref)
            .map_err(|error| MediaAssetActionError::InvalidMediaRef {
                reason: error.to_string(),
            })?
            .ok_or_else(|| MediaAssetActionError::MediaNotFound {
                media_ref: media_ref.into(),
            })?
    } else {
        vault.root().join(media_ref)
    };
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
        let (source, block) = read_media_asset_action_note(vault, &path)?;
        let rewritten = rewrite_block_media_asset_references(vault, &block, old_path, new_ref);
        if rewritten.frontmatter != block.frontmatter || rewritten.body != block.body {
            writes.push(MediaAssetBlockWrite {
                path,
                source,
                before: block,
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
    let media_kind = delete_media_kind(&media_ref);
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
        let (source, block) = read_media_asset_action_note(vault, &path)?;
        if let Some(rewritten) = remove_block_media_asset_references(vault, &block, media_path) {
            writes.push(MediaAssetBlockWrite {
                path,
                source,
                before: block,
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
    read_media_asset_action_note(vault, path).map(|(_, block)| block)
}

/// A note's text together with its model, for a write that patches the text.
fn read_media_asset_action_note(
    vault: &VaultLayout,
    path: &Path,
) -> Result<(String, Block), MediaAssetActionError> {
    let (slug, content) =
        files::read_block_file(vault, path).map_err(internal_media_asset_error)?;
    let parsed = parse_markdown_document(&slug, &content, file_saved_at(path)).map_err(|e| {
        MediaAssetActionError::Internal {
            message: format!("failed to parse {}: {e}", path.display()),
        }
    })?;
    Ok((content, parsed.block))
}

/// The write that carries a media change into a note's own text.
fn media_asset_source_write(
    write: &MediaAssetBlockWrite,
) -> Result<SourceFileWrite, MediaAssetActionError> {
    let patched = apply_block_changes(&write.source, &write.before, &write.block)
        .map_err(internal_media_asset_error)?;
    Ok(SourceFileWrite::replace(
        write.path.clone(),
        write.source.clone().into_bytes(),
        patched.into_bytes(),
    ))
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

pub(crate) fn rename_block_file_inner(
    app: Option<&AppHandle>,
    state: Option<&AppState>,
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
    // A plain Obsidian note without properties is renamed like any card.
    let old_block = parse_markdown_document(&read_slug, &content, file_saved_at(&old_path))
        .map_err(|e| RenameBlockError::Internal {
            message: e.to_string(),
        })?
        .block;
    let media_renames = collect_mine_owned_media_renames(vault, &old_block, old_slug, &new_slug)?;
    let planned_writes = build_planned_block_writes(vault, old_slug, &new_slug, &media_renames)?;
    // A name with a folder moves the card there, as Obsidian does; a folder
    // made for it and left empty by a refused rename goes again.
    let new_folder = NewFolder::make(&vault.block_path(&new_slug)).map_err(internal_rename_error)?;
    let renamed_root_block = planned_writes
        .iter()
        .find(|write| write.target_path == vault.block_path(&new_slug))
        .map(|write| write.block.clone())
        .ok_or_else(|| RenameBlockError::Internal {
            message: format!("renamed card {old_slug} is missing from the write plan"),
        })?;

    let mut source_writes = Vec::with_capacity(planned_writes.len() + media_renames.len());
    for write in &planned_writes {
        let patched = apply_block_changes(&write.source, &write.before, &write.block)
            .map_err(internal_rename_error)?;
        let unchanged = patched == write.source;
        let expected = write.source.clone().into_bytes();
        source_writes.push(match (write.original_path == old_path, unchanged) {
            // Renaming alone moves the file; its bytes stay as they are.
            (true, true) => {
                SourceFileWrite::rename(write.original_path.clone(), write.target_path.clone())
            }
            (true, false) => SourceFileWrite::rename_with_bytes(
                write.original_path.clone(),
                write.target_path.clone(),
                expected,
                patched.into_bytes(),
            ),
            (false, _) => {
                SourceFileWrite::replace(write.target_path.clone(), expected, patched.into_bytes())
            }
        });
    }
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
    if let Some(state) = state {
        state
            .suppress_paths(
                suppressed_paths.into_iter(),
                Duration::from_millis(IN_APP_RENAME_WATCHER_SUPPRESSION_MS),
            )
            .map_err(|e| RenameBlockError::Internal {
                message: e.to_string(),
            })?;
    }

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
                    index::upsert_channel_from_block_in_vault(index_conn, vault, &write.block)?;
                } else {
                    index::upsert_block(index_conn, &write.block, Some(vault.root()))?;
                }
            }
            Ok(())
        })
        .map_err(internal_rename_error)?;
    new_folder.keep();
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

/// The folders made for a file about to move in. Unless the move is kept,
/// they are removed again, each only while it is still empty.
struct NewFolder {
    made: Vec<PathBuf>,
    kept: bool,
}

impl NewFolder {
    /// Make every missing folder above `file`.
    fn make(file: &Path) -> std::io::Result<Self> {
        let mut missing = Vec::new();
        let mut folder = file.parent();
        while let Some(dir) = folder {
            if dir.try_exists()? {
                break;
            }
            missing.push(dir.to_path_buf());
            folder = dir.parent();
        }
        let mut made = Self {
            made: Vec::with_capacity(missing.len()),
            kept: false,
        };
        for dir in missing.into_iter().rev() {
            std::fs::create_dir(&dir)?;
            made.made.push(dir);
        }
        Ok(made)
    }

    fn keep(mut self) {
        self.kept = true;
    }
}

impl Drop for NewFolder {
    fn drop(&mut self) {
        if self.kept {
            return;
        }
        for dir in self.made.iter().rev() {
            let _ = std::fs::remove_dir(dir);
        }
    }
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

    if first_block_start == 0 && first_block_end == 0 {
        if let Some((selection_start, selection_end)) =
            selected_text_source_span(body, selected_text)
        {
            if selected_text_source_span(&body[selection_end..], selected_text).is_none() {
                return Ok(markdown_block_range_containing(body, selection_start));
            }
        }
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
    if let Some(tail) = body.get(block_start..) {
        if let Some(selection_start) = find_selection_start(tail, selected_text) {
            return block_start + selection_start < block_end;
        }
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
    unique_new_card_slug(conn, vault, raw_slug)
}

fn unique_new_card_slug(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    raw_name: &str,
) -> anyhow::Result<String> {
    let mut existing = files::scan_vault_file_paths(vault)?;
    let mut statement = conn.prepare("SELECT slug FROM blocks")?;
    for row in statement.query_map([], |row| row.get::<_, String>(0))? {
        existing.push(format!("{}.md", row?));
    }
    let name = mine_core::save::select_unique_file_stem(raw_name, "md", &existing)?;
    let slug = vault.new_card_slug(&name);
    validate_slug(&slug)?;
    Ok(slug)
}

#[cfg(test)]
#[test]
fn derived_card_names_follow_configured_layout() {
    use crate::domain::vault::VaultWriteLayout;
    for layout in [
        VaultWriteLayout::flat(),
        VaultWriteLayout::standard(),
        VaultWriteLayout {
            cards: "Notes/Clips".into(),
            media: "Assets".into(),
            collections: "Sets".into(),
        },
    ] {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf()).with_write_layout(layout);
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let expected = vault.new_card_slug("Example");
        assert_eq!(
            resolve_unique_block_slug(&conn, &vault, "Example", None).unwrap(),
            expected
        );
        assert_eq!(
            resolve_unique_text_selection_slug(&conn, &vault, "Example").unwrap(),
            expected
        );
        assert_eq!(
            resolve_unique_extraction_slug(&conn, &vault, "Example", "png").unwrap(),
            expected
        );
        std::fs::create_dir_all(vault.cards_dir()).unwrap();
        std::fs::write(vault.block_path(&expected), "existing").unwrap();
        let next = resolve_unique_block_slug(&conn, &vault, "Example", None).unwrap();
        assert_ne!(next, expected);
        assert_eq!(vault.block_path(&next).parent().unwrap(), vault.cards_dir());
    }
}

#[cfg(test)]
#[test]
fn extraction_and_merge_names_respect_other_folders() {
    let dir = tempfile::tempdir().unwrap();
    let vault = VaultLayout::new(dir.path().to_path_buf())
        .with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
    let conn = db::open_or_create(&vault.index_db_path()).unwrap();
    std::fs::create_dir_all(dir.path().join("Elsewhere")).unwrap();
    std::fs::write(dir.path().join("Elsewhere/Example.md"), b"User note").unwrap();
    assert_eq!(
        resolve_unique_extraction_slug(&conn, &vault, "Example", "png").unwrap(),
        "Cards/Example (2)"
    );
    assert_eq!(
        resolve_unique_text_selection_slug(&conn, &vault, "Example").unwrap(),
        "Cards/Example (2)"
    );
    assert_eq!(
        resolve_unique_block_slug(&conn, &vault, "Example", None).unwrap(),
        "Cards/Example (2)"
    );
}

pub(crate) fn resolve_unique_block_slug(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    raw_slug: &str,
    _media_ext: Option<&str>,
) -> anyhow::Result<String> {
    unique_new_card_slug(conn, vault, raw_slug)
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
    _ext: &str,
) -> anyhow::Result<String> {
    unique_new_card_slug(conn, vault, raw_slug)
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

/// A refused source mutation, typed when an outside edit won.
fn merge_mutation_error(error: SourceMutationError) -> MergeBlocksError {
    match error {
        SourceMutationError::Changed { path, .. } => MergeBlocksError::SourceChanged {
            path: path.to_string_lossy().to_string(),
        },
        error => internal_merge_error(error),
    }
}

fn internal_rename_error(error: impl std::fmt::Display) -> RenameBlockError {
    RenameBlockError::Internal {
        message: error.to_string(),
    }
}

fn build_planned_block_writes(
    vault: &VaultLayout,
    old_slug: &str,
    new_slug: &str,
    media_renames: &[FileRename],
) -> Result<Vec<PlannedBlockWrite>, RenameBlockError> {
    let old_path = vault.block_path(old_slug);
    let mut relocations = vec![(format!("{old_slug}.md"), format!("{new_slug}.md"))];
    for rename in media_renames {
        let (Some(from), Some(to)) = (
            vault.root_relative_reference(&rename.from),
            vault.root_relative_reference(&rename.to),
        ) else {
            return Err(RenameBlockError::Internal {
                message: format!("media {} is outside the space", rename.from.display()),
            });
        };
        relocations.push((from, to));
    }
    // Wikilinks and embeds of the card and of its media are retargeted the
    // way Obsidian resolves them.
    let moves = NoteMoves::new(
        files::scan_vault_file_paths(vault).map_err(internal_rename_error)?,
        &relocations,
    );
    let moved_media_names: Vec<String> = media_renames
        .iter()
        .filter_map(|rename| Some(fold_media_name(rename.from.file_name()?.to_str()?)))
        .collect();
    let mut resolver = media_refs::MediaResolver::new(vault);
    let mut writes = Vec::new();
    for path in files::scan_md_files(vault).map_err(internal_rename_error)? {
        let is_root = path == old_path;
        let (slug, content) =
            files::read_block_file(vault, &path).map_err(internal_rename_error)?;
        // A media name can hide behind percent-encoding or a YAML escape, so
        // while media moves every note is parsed, as `media_users_on_disk`
        // does (SPEC_AUDIT_FIXES.md, Ф4).
        if !is_root && moved_media_names.is_empty() && !moves.may_be_linked_from(&content) {
            continue;
        }
        let block = parse_markdown_document(&slug, &content, file_saved_at(&path))
            .map_err(|e| RenameBlockError::Internal {
                message: format!("failed to parse {}: {e}", path.display()),
            })?
            .block;

        // The renamed card may move to a folder of another depth: its own
        // Markdown paths are written again from there (`SPEC_AUDIT_FIXES.md`,
        // В1.3).
        let note_before = format!("{slug}.md");
        let note_after = if is_root {
            format!("{new_slug}.md")
        } else {
            note_before.clone()
        };
        let mut rewritten = rewrite_note_links(&block, &moves, &note_before, &note_after);
        let mentions_moved_media = media_reference_forms(&block, &iter_file_references(&block.body))
            .iter()
            .any(|form| moved_media_names.iter().any(|name| form.contains(name.as_str())));
        if mentions_moved_media {
            retarget_moved_media_properties(vault, &mut resolver, &block, &mut rewritten, media_renames, &moves);
        }
        if is_root {
            rewritten.slug = new_slug.to_string();
        }

        let changed = rewritten.frontmatter != block.frontmatter || rewritten.body != block.body;
        if is_root || changed {
            writes.push(PlannedBlockWrite {
                original_path: path.clone(),
                target_path: if is_root {
                    vault.block_path(new_slug)
                } else {
                    path
                },
                source: content,
                before: block,
                block: rewritten,
            });
        }
    }
    Ok(writes)
}

/// Point `rewritten`, the note `block` with its links already retargeted by
/// `rewrite_note_links`, at the media a card rename moves, for the one kind of
/// reference that pass leaves: a `file` or `thumbnail` property that names
/// its file the way a wikilink does. Resolved from the note, a property that
/// names a moved file follows it (`SPEC_AUDIT_FIXES.md`, Ф3, Б1.6). Markdown
/// images and properties written as a path from the note are Markdown paths,
/// and `rewrite_note_links` rewrote them already.
fn retarget_moved_media_properties(
    vault: &VaultLayout,
    resolver: &mut media_refs::MediaResolver<'_>,
    block: &Block,
    rewritten: &mut Block,
    media_renames: &[FileRename],
    moves: &NoteMoves,
) {
    let moved_to = |path: &Path| {
        media_renames
            .iter()
            .find(|rename| same_path(path, &rename.from))
            .map(|rename| rename.to.clone())
    };
    let mut retarget_property = |reference: Option<&str>| -> Option<String> {
        let reference = reference.filter(|reference| !is_note_relative_property(reference))?;
        let to = moved_to(&resolver.resolve_indexed_media(&block.slug, reference)?)?;
        moves
            .retarget(reference)
            .or_else(|| vault.root_relative_reference(&to))
    };
    if let Some(file) = retarget_property(block.frontmatter.file.as_deref()) {
        rewritten.frontmatter.file = Some(file);
    }
    if let Some(thumbnail) = retarget_property(block.frontmatter.thumbnail.as_deref()) {
        rewritten.frontmatter.thumbnail = Some(thumbnail);
    }
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

/// The card's own media, which a rename renames with it: the files its
/// references resolve to whose names follow the card's name (`Foo.jpg`,
/// `Foo (image 1).jpg` for the card `Foo`). A card in a folder owns media
/// named after its file name, wherever the media folder is
/// (`VaultLayout::media_path`), and each file keeps its folder
/// (`SPEC_AUDIT_FIXES.md`, Ф3, Б1.6).
fn collect_mine_owned_media_renames(
    vault: &VaultLayout,
    block: &Block,
    old_slug: &str,
    new_slug: &str,
) -> Result<Vec<FileRename>, RenameBlockError> {
    let old_name = old_slug.rsplit('/').next().unwrap_or(old_slug);
    let new_name = new_slug.rsplit('/').next().unwrap_or(new_slug);
    let mut resolver = media_refs::MediaResolver::new(vault);
    let mut owned = BTreeSet::new();
    for reference in [&block.frontmatter.file, &block.frontmatter.thumbnail]
        .into_iter()
        .flatten()
    {
        owned.extend(resolver.resolve_indexed_media(&block.slug, reference));
    }
    for reference in iter_inline_media_references(&block.body) {
        owned.extend(resolver.resolve_inline_media(&block.slug, &reference));
    }

    let mut renames = Vec::new();
    for from in owned {
        let Some(file_name) = from.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(target) = mine_owned_rename_family_target(file_name, old_name, new_name) else {
            continue;
        };
        if target == file_name {
            continue;
        }
        let to = from.with_file_name(&target);
        if to.exists() {
            return Err(RenameBlockError::NameTaken {
                requested: vault.root_relative_reference(&to).unwrap_or(target),
            });
        }
        renames.push(FileRename { from, to });
    }
    Ok(renames)
}

/// The new file name of `name` when it belongs to the rename family of the
/// card file name `old_name`; `None` for any other file, and for notes.
fn mine_owned_rename_family_target(name: &str, old_name: &str, new_name: &str) -> Option<String> {
    if let Some(ext) = primary_media_extension(name, old_name) {
        return Some(format!("{new_name}.{ext}"));
    }
    generated_inline_target(name, old_name, new_name, "image")
        .or_else(|| generated_inline_target(name, old_name, new_name, "video"))
}

fn primary_media_extension<'a>(name: &'a str, card_name: &str) -> Option<&'a str> {
    let rest = name.strip_prefix(card_name)?;
    let ext = rest.strip_prefix('.')?;
    if ext.is_empty() || ext.contains('/') || ext.contains('\\') || ext.eq_ignore_ascii_case("md") {
        return None;
    }
    Some(ext)
}

fn generated_inline_target(
    name: &str,
    old_name: &str,
    new_name: &str,
    kind: &str,
) -> Option<String> {
    let prefix = format!("{old_name} ({kind} ");
    let rest = name.strip_prefix(&prefix)?;
    let (index, ext) = rest.split_once(").")?;
    if index.is_empty() || !index.chars().all(|ch| ch.is_ascii_digit()) || ext.is_empty() {
        return None;
    }
    Some(format!("{new_name} ({kind} {index}).{ext}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    type CardReadHook = Box<dyn FnOnce(&Path)>;

    thread_local! {
        /// Runs once after attaching a downloaded video has read the card and
        /// before it writes it: the window an edit in Obsidian can hit.
        static AFTER_CARD_READ: RefCell<Option<CardReadHook>> = const { RefCell::new(None) };
    }

    pub(super) fn run_after_card_read_hook(path: &Path) {
        if let Some(hook) = AFTER_CARD_READ.with(|slot| slot.borrow_mut().take()) {
            hook(path);
        }
    }

    fn after_next_card_read(hook: impl FnOnce(&Path) + 'static) {
        AFTER_CARD_READ.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    #[test]
    fn batch_delete_retains_media_and_deduplicates_slugs() {
        let (_root, _derived, vault, conn) = make_vault();
        for slug in ["one", "two", "keep"] {
            persist_block(&conn, &vault, &article(slug, "![[shared.jpg]]"));
        }
        let media = vault.root().join("shared.jpg");
        std::fs::write(&media, b"source bytes").unwrap();
        assert_eq!(
            delete_blocks_inner(
                None,
                &conn,
                &vault,
                vec!["one".into(), "two".into(), "one".into()]
            )
            .unwrap(),
            2
        );
        assert!(!vault.block_path("one").exists());
        assert!(!vault.block_path("two").exists());
        assert!(vault.block_path("keep").exists());
        assert_eq!(std::fs::read(media).unwrap(), b"source bytes");
        assert_eq!(
            delete_blocks_inner(None, &conn, &vault, vec!["one".into()]).unwrap(),
            0
        );
    }

    #[test]
    fn batch_delete_failure_restores_entire_selection() {
        let (_root, _derived, vault, conn) = make_vault();
        for slug in ["one", "two"] {
            persist_block(&conn, &vault, &article(slug, "Keep me"));
        }
        conn.execute_batch(
            "CREATE TRIGGER reject_batch_delete BEFORE DELETE ON blocks
            WHEN OLD.slug = 'two' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
        .unwrap();
        assert!(
            delete_blocks_inner(None, &conn, &vault, vec!["one".into(), "two".into()]).is_err()
        );
        for slug in ["one", "two"] {
            assert!(vault.block_path(slug).exists());
            assert!(index::get_block(&conn, slug).unwrap().is_some());
        }
    }
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
    fn desktop_create_uses_shared_names_for_disk_only_card_and_media_conflicts() {
        let (_root, _derived, vault, conn) = make_vault();
        let vault = vault.with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        std::fs::create_dir_all(vault.cards_dir()).unwrap();
        std::fs::create_dir_all(vault.media_dir()).unwrap();
        std::fs::write(vault.block_path("Cards/Note"), b"external card").unwrap();
        std::fs::write(vault.new_media_path("Note (2).png"), b"external media").unwrap();

        let created = create_block_inner(
            &conn,
            &vault,
            CreateBlockParams {
                block_type: "obsolete".into(),
                title: Some("Note".into()),
                url: None,
                tags: vec![],
                file_path: None,
                body: None,
            },
        )
        .unwrap();

        assert_eq!(created.slug, "Cards/Note (2)");
        assert_eq!(
            std::fs::read(vault.block_path("Cards/Note")).unwrap(),
            b"external card"
        );
        assert_eq!(
            std::fs::read(vault.new_media_path("Note (2).png")).unwrap(),
            b"external media"
        );
        assert!(vault.block_path(&created.slug).is_file());
    }

    #[test]
    fn desktop_create_preserves_pasted_body_and_shared_collection_normalization() {
        let (_root, _derived, vault, conn) = make_vault();
        let created = create_block_inner(
            &conn,
            &vault,
            CreateBlockParams {
                block_type: "article".into(),
                title: Some("A filename seed".into()),
                url: None,
                tags: vec![" [[Чтение]] ".into(), "Чтение".into()],
                file_path: None,
                body: Some("A one-line quote".into()),
            },
        )
        .unwrap();
        let raw = std::fs::read_to_string(vault.block_path(&created.slug)).unwrap();
        let block = crate::domain::block::parse_block(&created.slug, &raw).unwrap();
        assert_eq!(block.body, "A one-line quote");
        assert_eq!(block.frontmatter.title, None);
        assert_eq!(block.frontmatter.tags, ["Чтение"]);
        assert!(!raw.contains("type:"));
    }

    #[test]
    fn desktop_create_keeps_source_rollback_when_index_commit_fails() {
        let (_root, _derived, vault, conn) = make_vault();
        let source_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("input.jpg");
        std::fs::write(&source, b"owned source remains").unwrap();
        conn.execute_batch("CREATE TRIGGER fail_capture BEFORE INSERT ON blocks BEGIN SELECT RAISE(FAIL, 'injected index failure'); END;").unwrap();
        let result = create_block_inner(
            &conn,
            &vault,
            CreateBlockParams {
                block_type: "image".into(),
                title: Some("Rollback".into()),
                url: None,
                tags: vec![],
                file_path: Some(source.to_string_lossy().into_owned()),
                body: None,
            },
        );
        assert!(result.is_err());
        assert!(!vault.block_path("Rollback").exists());
        assert!(!vault.new_media_path("Rollback.jpg").exists());
        assert_eq!(std::fs::read(&source).unwrap(), b"owned source remains");
    }

    #[test]
    fn desktop_create_rejects_collection_traversal_before_source_write() {
        let (_root, _derived, vault, conn) = make_vault();
        assert!(create_block_inner(
            &conn,
            &vault,
            CreateBlockParams {
                block_type: "article".into(),
                title: Some("Unsafe".into()),
                url: None,
                tags: vec!["../outside".into()],
                file_path: None,
                body: Some("Body".into()),
            }
        )
        .is_err());
        assert!(!vault.block_path("Unsafe").exists());
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
        image::RgbImage::from_pixel(8, 8, image::Rgb([24, 48, 72]))
            .save(vault.root().join("second.png"))
            .unwrap();

        let mutation = merge_blocks_inner(
            Some(&state),
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
        assert!(
            std::fs::metadata(vault.root().join("second.png"))
                .unwrap()
                .len()
                > 0
        );
        assert!(index::get_block(&conn, "First Card").unwrap().is_none());
        assert!(index::get_block(&conn, "Second Image").unwrap().is_none());
        let removed_source_states: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM source_index_state
                 WHERE slug IN ('First Card', 'Second Image')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(removed_source_states, 0);
        assert!(index::get_block(&conn, "First Card — merged")
            .unwrap()
            .is_some());
        let (preview_state, preview_source_stamp, source_stamp): (String, Option<String>, String) =
            conn.query_row(
                "SELECT b.preview_state, b.preview_source_stamp, source.source_stamp
                 FROM blocks b
                 JOIN source_index_state source ON source.slug = b.slug
                 WHERE b.slug = 'First Card — merged'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(preview_state, "ready");
        assert_eq!(preview_source_stamp.as_deref(), Some(source_stamp.as_str()));
        let (external_preview_state, external_preview_stamp, external_source_stamp): (
            String,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT b.preview_state, b.preview_source_stamp, source.source_stamp
                 FROM blocks b
                 JOIN source_index_state source ON source.slug = b.slug
                 WHERE b.slug = 'External Note'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(external_preview_state, "ready");
        assert_eq!(
            external_preview_stamp.as_deref(),
            Some(external_source_stamp.as_str())
        );
        let grid = index::list_grid_blocks(&conn, None, 0, 20).unwrap().0;
        let merged_grid_block = grid
            .iter()
            .find(|block| block.slug == "First Card — merged")
            .unwrap();
        let manifest: index::FeedPreviewManifest =
            serde_json::from_str(merged_grid_block.preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.kind, index::FeedPreviewKind::Image);
        assert_eq!(manifest.tiles.len(), 1);
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
    fn merge_blocks_publishes_multi_image_preview_in_first_grid_snapshot() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let first = image("First Image", "first.png");
        let second = image("Second Image", "second.png");
        persist_block(&conn, &vault, &first);
        persist_block(&conn, &vault, &second);
        image::RgbImage::from_pixel(8, 8, image::Rgb([220, 32, 64]))
            .save(vault.root().join("first.png"))
            .unwrap();
        image::RgbImage::from_pixel(12, 8, image::Rgb([32, 96, 220]))
            .save(vault.root().join("second.png"))
            .unwrap();

        let mutation = merge_blocks_inner(
            Some(&state),
            &conn,
            &vault,
            vec!["First Image".to_string(), "Second Image".to_string()],
        )
        .unwrap();

        let grid = index::list_grid_blocks(&conn, None, 0, 20).unwrap().0;
        let merged = grid
            .iter()
            .find(|block| block.slug == mutation.result.merged_slug)
            .unwrap();
        let manifest: index::FeedPreviewManifest =
            serde_json::from_str(merged.preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.kind, index::FeedPreviewKind::Composite);
        assert_eq!(
            manifest
                .tiles
                .iter()
                .map(|tile| tile.source_path.as_str())
                .collect::<Vec<_>>(),
            vec!["first.png", "second.png"]
        );
        assert!(vault.thumb_path(&mutation.result.merged_slug).is_file());
        for tile in &manifest.tiles {
            let preview = tile.preview_path.as_deref().unwrap();
            assert!(vault.thumbs_dir().join(preview).is_file());
        }
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
            Some(&state),
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
        let merged_slug = merged_block_slug(&conn, &vault, &sources).unwrap();
        let moves = merge_note_moves(&vault, &sources, &merged_slug).unwrap();
        let mut merged_block = build_merged_block(&sources, &moves, merged_slug).unwrap();
        merged_block.body =
            retarget_wikilinks(&merged_block.body, |target| moves.retarget(target));
        let mut reference_writes =
            build_merge_reference_writes(&vault, &selected_slugs, &moves).unwrap();
        // Inject a write failure: a path whose parent is an existing FILE, so
        // neither create_dir_all nor the write can succeed. (write_atomically
        // creates missing parent dirs, so a merely-missing parent now succeeds.)
        let blocker = vault.root().join("blocker-file");
        std::fs::write(&blocker, b"x").unwrap();
        reference_writes.push(MergeReferenceWrite {
            path: blocker.join("Broken.md"),
            source: String::new(),
            before: article("Broken", "Broken body"),
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
            Some(&state),
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
            Some(&state),
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

        assert_eq!(indexed.slug, "photo");
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
            files::read_block_file(&vault, &vault.block_path("photo")).unwrap();
        let extracted = crate::domain::block::parse_block("photo", &extracted_content).unwrap();
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

        assert_eq!(indexed.slug, "photo");
        assert_eq!(indexed.media_file.as_deref(), Some("photo.png"));

        let plan = build_delete_block_plan(&conn, &vault, &indexed.slug).unwrap();
        assert!(plan.unused_media.is_empty());
        assert_eq!(plan.shared_media.len(), 1);
        assert_eq!(plan.shared_media[0].path, "photo.png");
        assert_eq!(plan.shared_media[0].referenced_by, vec!["Source Article"]);
        assert!(delete_block_inner(None, &conn, &vault, &indexed.slug, Some(true)).unwrap());
        assert!(!vault.block_path(&indexed.slug).exists());
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
        assert_eq!(indexed.source, None, "new cards carry no source");

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
    fn rename_media_asset_keeps_nested_markdown_links_resolving() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        std::fs::create_dir_all(vault.root().join("Media")).unwrap();
        std::fs::write(vault.root().join("Media/old.jpg"), b"image-bytes").unwrap();
        write_note(
            &vault,
            "Cards/Note",
            "---\nsaved_at: 2026-04-22T00:00:00Z\n---\nA ![shot](../Media/old.jpg) and ![[old.jpg]].\n",
        );
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        let result = rename_media_asset_inner(
            &state,
            &conn,
            &vault,
            "Media/old.jpg".to_string(),
            "new".to_string(),
        )
        .unwrap();

        assert_eq!(result.new_media_ref.as_deref(), Some("Media/new.jpg"));
        let note = read_note(&vault, "Cards/Note");
        assert_eq!(
            note,
            "---\nsaved_at: 2026-04-22T00:00:00Z\n---\nA ![shot](../Media/new.jpg) and ![[Media/new.jpg]].\n"
        );
        let block = parse_markdown_document(
            "Cards/Note",
            &note,
            DateTime::new("2026-04-22T00:00:00Z").unwrap(),
        )
        .unwrap()
        .block;
        let new_path = vault.root().join("Media/new.jpg");
        let references = iter_inline_media_references(&block.body);
        assert_eq!(references.len(), 2);
        for reference in &references {
            let resolved = media_refs::resolve_inline_media(&vault, "Cards/Note", reference);
            assert!(
                resolved.is_some_and(|path| same_path(&path, &new_path)),
                "{reference:?} must resolve to the renamed file"
            );
        }
        assert_eq!(std::fs::read(&new_path).unwrap(), b"image-bytes");
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
        assert_eq!(plan.media_kind, DeleteMediaAssetKind::Image);
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

    fn youtube_card(slug: &str, poster: &str) -> Block {
        let mut block = article(slug, "# Film\n\nTranscript stays.");
        block.frontmatter.url = Some("https://www.youtube.com/watch?v=9KDDhAOyv9k".to_string());
        block.frontmatter.thumbnail = Some(poster.to_string());
        block
    }

    #[test]
    fn delete_source_video_inner_clears_link_and_deletes_unshared_poster() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        std::fs::write(vault.root().join("poster.jpg"), b"poster-bytes").unwrap();

        let result = delete_source_video_inner(&state, &conn, &vault, "Film").unwrap();

        assert_eq!(result.media_ref, "poster.jpg");
        assert_eq!(result.affected_slugs, vec!["Film".to_string()]);
        assert!(!vault.root().join("poster.jpg").exists());
        let (_, content) = files::read_block_file(&vault, &vault.block_path("Film")).unwrap();
        let parsed = crate::domain::block::parse_block("Film", &content).unwrap();
        assert!(parsed.frontmatter.url.is_none());
        assert!(parsed.frontmatter.thumbnail.is_none());
        assert_eq!(parsed.frontmatter.tags, vec!["notes".to_string()]);
        assert!(parsed.body.contains("Transcript stays."));
    }

    #[test]
    fn delete_source_video_inner_keeps_a_poster_another_card_shows() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        persist_block(&conn, &vault, &image("Poster Card", "poster.jpg"));
        std::fs::write(vault.root().join("poster.jpg"), b"poster-bytes").unwrap();

        let result = delete_source_video_inner(&state, &conn, &vault, "Film").unwrap();

        assert_eq!(result.media_ref, "");
        assert_eq!(std::fs::read(vault.root().join("poster.jpg")).unwrap(), b"poster-bytes");
        let (_, content) = files::read_block_file(&vault, &vault.block_path("Film")).unwrap();
        let parsed = crate::domain::block::parse_block("Film", &content).unwrap();
        assert!(parsed.frontmatter.url.is_none());
        assert!(parsed.frontmatter.thumbnail.is_none());
        let (_, other) = files::read_block_file(&vault, &vault.block_path("Poster Card")).unwrap();
        assert!(other.contains("poster.jpg"));
    }

    #[test]
    fn attach_downloaded_source_video_inner_moves_the_file_in_and_links_it() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        std::fs::write(vault.root().join("poster.jpg"), b"poster-bytes").unwrap();
        std::fs::write(vault.root().join("Film.mp4"), b"someone else's file").unwrap();
        let staging = tempfile::tempdir().unwrap();
        let downloaded = staging.path().join("joined.mp4");
        std::fs::write(&downloaded, b"video-bytes").unwrap();

        let result =
            attach_downloaded_source_video_inner(&state, &conn, &vault, "Film", "9KDDhAOyv9k", &downloaded)
                .unwrap();

        assert_eq!(result.affected_slugs, vec!["Film".to_string()]);
        assert!(!downloaded.exists());
        let published = vault.root().join(&result.media_ref);
        assert_eq!(std::fs::read(&published).unwrap(), b"video-bytes");
        assert_ne!(result.media_ref, "Film.mp4", "an existing file keeps its name");
        assert_eq!(std::fs::read(vault.root().join("Film.mp4")).unwrap(), b"someone else's file");
        let (_, content) = files::read_block_file(&vault, &vault.block_path("Film")).unwrap();
        let parsed = crate::domain::block::parse_block("Film", &content).unwrap();
        assert!(parsed.frontmatter.file.is_none(), "the video is an embed, as a saved post's video is");
        let file_name = Path::new(&result.media_ref).file_name().unwrap().to_str().unwrap();
        assert_eq!(parsed.body, format!("# Film\n\n![[{file_name}]]\n\nTranscript stays."));
        assert!(parsed.frontmatter.url.is_some(), "the source link stays");

        // The feed sees a video poster and can autoplay the card.
        let indexed = index::get_block(&conn, "Film").unwrap().unwrap();
        assert!(indexed.preview_manifest.as_deref().unwrap_or("").contains("\"kind\":\"video_poster\""), "{:?}", indexed.preview_manifest);
    }

    #[test]
    fn attach_downloaded_source_video_inner_refuses_a_card_that_already_has_a_video() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let mut card = youtube_card("Film", "poster.jpg");
        card.body = "# Film\n\n![[clip.mp4]]\n\nTranscript stays.".to_string();
        persist_block(&conn, &vault, &card);
        let staging = tempfile::tempdir().unwrap();
        let downloaded = staging.path().join("joined.mp4");
        std::fs::write(&downloaded, b"video-bytes").unwrap();

        let error =
            attach_downloaded_source_video_inner(&state, &conn, &vault, "Film", "9KDDhAOyv9k", &downloaded)
                .unwrap_err();

        assert!(matches!(error, MediaAssetActionError::InvalidMediaRef { .. }));
        assert!(downloaded.exists());
    }

    #[test]
    fn video_embed_goes_under_the_heading_or_first() {
        assert_eq!(insert_video_embed("# Film\n\nText", "a.mp4"), "# Film\n\n![[a.mp4]]\n\nText");
        assert_eq!(insert_video_embed("# Film", "a.mp4"), "# Film\n\n![[a.mp4]]\n");
        assert_eq!(insert_video_embed("Text only", "a.mp4"), "![[a.mp4]]\n\nText only");
        assert_eq!(insert_video_embed("", "a.mp4"), "![[a.mp4]]\n");
        assert_eq!(insert_video_embed("## Section\n\nText", "a.mp4"), "![[a.mp4]]\n\n## Section\n\nText");
    }

    #[test]
    fn attach_downloaded_source_video_inner_refuses_a_card_that_changed_video() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        let staging = tempfile::tempdir().unwrap();
        let downloaded = staging.path().join("joined.mp4");
        std::fs::write(&downloaded, b"video-bytes").unwrap();

        let error =
            attach_downloaded_source_video_inner(&state, &conn, &vault, "Film", "abcdefghijk", &downloaded)
                .unwrap_err();

        assert!(matches!(error, MediaAssetActionError::InvalidMediaRef { .. }));
        assert!(downloaded.exists(), "the download is left for the job to clean up");
        let (_, content) = files::read_block_file(&vault, &vault.block_path("Film")).unwrap();
        assert!(!content.contains(".mp4"));
    }

    #[test]
    fn delete_source_video_inner_refuses_a_card_without_a_source_video() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let plain = article("Plain", "Body");
        persist_block(&conn, &vault, &plain);

        let error = delete_source_video_inner(&state, &conn, &vault, "Plain").unwrap_err();

        assert!(matches!(error, MediaAssetActionError::InvalidMediaRef { .. }));
        let (_, content) = files::read_block_file(&vault, &vault.block_path("Plain")).unwrap();
        assert!(content.contains("https://example.com/article"));
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

    /// Г1.4: Remove takes away the image the reader clicked, named by the
    /// index of its `![` among the body's openers. A title, angle brackets,
    /// parentheses in the name, another spelling of the same file and an
    /// image of another file between them do not move it, and every other
    /// image stays byte for byte.
    #[test]
    fn removing_one_image_of_a_file_keeps_its_other_images_byte_for_byte() {
        let cases = [
            ("p.jpg", "![a](p.jpg \"t1\")\n\n![b](p.jpg \"t2\")\n", 1, "![a](p.jpg \"t1\")\n"),
            ("p q.jpg", "![a](<p q.jpg>)\n\n![b](<p q.jpg> 't')\n", 1, "![a](<p q.jpg>)\n"),
            ("Foo (1).jpg", "![a](Foo (1).jpg)\n\n![b](Foo (1).jpg (t))\n", 1, "![a](Foo (1).jpg)\n"),
            (
                "p.jpg",
                "Intro ![[p.jpg]] mid ![x](p.jpg) end ![y](./p%2Ejpg)\n",
                1,
                "Intro ![[p.jpg]] mid  end ![y](./p%2Ejpg)\n",
            ),
            (
                "p.jpg",
                "![a](p.jpg) ![o](other.jpg) ![b](p.jpg \"t\")\n",
                2,
                "![a](p.jpg) ![o](other.jpg) \n",
            ),
        ];
        for (file, body, opener, expected) in cases {
            let (_root, _derived, vault, conn) = make_vault();
            let state = AppState::new();
            for name in [file, "other.jpg"] {
                std::fs::write(vault.root().join(name), b"image-bytes").unwrap();
            }
            write_note(&vault, "Card", body);
            crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

            remove_media_asset_from_card_inner(
                &state,
                &conn,
                &vault,
                file.to_string(),
                "Card".to_string(),
                "body_embed".to_string(),
                Some(opener),
            )
            .unwrap_or_else(|error| panic!("{body}: {error}"));

            assert_eq!(read_note(&vault, "Card"), expected, "{body}");
            assert!(vault.root().join(file).is_file());
        }
    }

    /// Г1.4: an index that no longer names an image of that file (the card
    /// changed after it was shown) removes nothing.
    #[test]
    fn removing_an_image_the_card_no_longer_has_there_changes_nothing() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        for name in ["p.jpg", "other.jpg"] {
            std::fs::write(vault.root().join(name), b"image-bytes").unwrap();
        }
        let body = "![o](other.jpg)\n\n![a](p.jpg)\n";
        write_note(&vault, "Card", body);
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        for opener in [0, 5] {
            let error = remove_media_asset_from_card_inner(
                &state,
                &conn,
                &vault,
                "p.jpg".to_string(),
                "Card".to_string(),
                "body_embed".to_string(),
                Some(opener),
            )
            .unwrap_err();
            assert!(matches!(error, MediaAssetActionError::InvalidMediaRef { .. }), "{error}");
            assert_eq!(read_note(&vault, "Card"), body);
        }
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

        assert!(
            delete_block_inner(Some(&state), &conn, &vault, "Source Article", Some(true)).unwrap()
        );

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

        let error = delete_block_inner(Some(&state), &conn, &vault, "Source Article", Some(true))
            .unwrap_err();

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
    fn selection_actions_target_second_duplicate_and_preserve_frontmatter() {
        let (_root, _derived, vault, conn) = make_vault();
        let body = "![[Media/Камень.jpg]]\n\nAuthor: @test\n\nAuthor: @test";
        let source = article("Source", body);
        persist_block(&conn, &vault, &source);
        let path = vault.block_path("Source");
        let before = std::fs::read_to_string(&path).unwrap();
        let start = body.rfind("Author:").unwrap();
        assert_eq!(
            validated_source_block_range(body, start, body.len(), "Author: @test").unwrap(),
            (start, body.len())
        );
        assert!(validated_source_block_range(body, 0, 0, "Author: @test").is_err());
        assert!(validated_source_block_range(body, 1, 4, "Author: @test").is_err());
        let result = delete_text_selection_inner(
            &conn,
            &vault,
            "Source".into(),
            "Author: @test".into(),
            start,
            body.len(),
            compute_body_hash(body),
        )
        .unwrap();
        assert_eq!(result.body.trim_end(), body[..start].trim_end());
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(after, before.replacen(body, &body[..start], 1));
    }

    #[test]
    fn selection_delete_rejects_changed_source_without_writing() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article("Source", "Текст **жирный** и [ссылка](https://example.org)");
        persist_block(&conn, &vault, &source);
        let path = vault.block_path("Source");
        let before = std::fs::read(&path).unwrap();
        let error = delete_text_selection_inner(
            &conn,
            &vault,
            "Source".into(),
            "жирный".into(),
            0,
            source.body.len(),
            "old hash".into(),
        )
        .unwrap_err();
        assert!(matches!(error, TextSelectionExtractError::StaleSelection));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let result = delete_text_selection_inner(
            &conn,
            &vault,
            "Source".into(),
            "ссылка".into(),
            0,
            source.body.len(),
            compute_body_hash(&source.body),
        )
        .unwrap();
        assert_eq!(result.body, "Текст **жирный** и [](https://example.org)");
    }

    #[test]
    fn media_actions_resolve_all_six_short_embeds_without_previews() {
        let (_root, _derived, vault, conn) = make_vault();
        std::fs::create_dir(vault.root().join("Media")).unwrap();
        let body = (0..6)
            .map(|i| format!("![[image{i}.jpg]]"))
            .collect::<Vec<_>>()
            .join("\n\n");
        persist_block(&conn, &vault, &article("Source", &body));
        for i in 0..6 {
            let name = format!("image{i}.jpg");
            std::fs::write(vault.root().join("Media").join(&name), b"image").unwrap();
            let plan = prepare_delete_media_asset_inner(&vault, name).unwrap();
            assert_eq!(plan.media_ref, format!("Media/image{i}.jpg"));
            assert_eq!(plan.referenced_by.len(), 1);
            assert_eq!(plan.referenced_by[0].slug, "Source");
            assert_eq!(
                resolve_media_asset_path(&vault, &plan.media_ref).unwrap(),
                vault.root().join(&plan.media_ref)
            );
        }
        delete_media_asset_inner(&AppState::new(), &conn, &vault, "Media/image5.jpg".into())
            .unwrap();
        assert!(!vault.root().join("Media/image5.jpg").exists());
        for i in 0..5 {
            assert!(vault.root().join(format!("Media/image{i}.jpg")).exists());
        }
        let remaining = std::fs::read_to_string(vault.block_path("Source")).unwrap();
        assert!(!remaining.contains("![[image5.jpg]]"));
        assert!(remaining.contains("![[image4.jpg]]"));
    }

    #[test]
    fn media_actions_reject_ambiguous_missing_and_escaping_paths() {
        let (_root, _derived, vault, _conn) = make_vault();
        for dir in ["Media", "Other"] {
            std::fs::create_dir(vault.root().join(dir)).unwrap();
            std::fs::write(vault.root().join(dir).join("same.jpg"), b"keep").unwrap();
        }
        assert!(matches!(
            resolve_media_asset_path(&vault, "same.jpg"),
            Err(MediaAssetActionError::InvalidMediaRef { .. })
        ));
        assert!(matches!(
            resolve_media_asset_path(&vault, "missing.jpg"),
            Err(MediaAssetActionError::MediaNotFound { .. })
        ));
        assert!(resolve_media_asset_path(&vault, "../same.jpg").is_err());
        assert!(resolve_media_asset_path(&vault, "Media/same.jpg").is_ok());
        assert_eq!(
            std::fs::read(vault.root().join("Other/same.jpg")).unwrap(),
            b"keep"
        );
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
    fn extract_text_selection_inner_accepts_japanese_with_source_byte_range() {
        let (_root, _derived, vault, conn) = make_vault();
        let source = article(
            "Source Article",
            "これは日本語の文章です。\n\nSecond paragraph.",
        );
        let body_hash = compute_body_hash(&source.body);
        persist_block(&conn, &vault, &source);

        let source_first_block_end = "これは日本語の文章です。".len();
        let indexed = extract_text_selection_inner(
            &conn,
            &vault,
            "Source Article".to_string(),
            "Quotes".to_string(),
            "文章".to_string(),
            0,
            source_first_block_end,
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
            source.body.find("\n\n").unwrap(),
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

        let result = rename_block_file_inner(
            None,
            Some(&state),
            &conn,
            &vault,
            "Old Name",
            "Renamed Name",
        )
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

        let error = rename_block_file_inner(
            None,
            Some(&state),
            &conn,
            &vault,
            "Old Name",
            "Renamed Name",
        )
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

        rename_block_file_inner(
            None,
            Some(&state),
            &conn,
            &vault,
            "Old Name",
            "Renamed Name",
        )
        .unwrap();

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

        rename_block_file_inner(
            None,
            Some(&state),
            &conn,
            &vault,
            "Old Name",
            "Renamed Name",
        )
        .unwrap();

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

        let err =
            rename_block_file_inner(None, Some(&state), &conn, &vault, "One", "Taken").unwrap_err();
        assert!(matches!(err, RenameBlockError::NameTaken { .. }));
    }

    #[test]
    fn normalize_requested_stem_rejects_path_traversal() {
        let err = normalize_requested_stem("../escape").unwrap_err();
        assert!(matches!(err, RenameBlockError::InvalidFilename { .. }));
    }

    /// Properties Mine does not know, a YAML comment and a blank line: what an
    /// Obsidian user's note carries and a write must not drop.
    const USER_PROPERTIES: &str =
        "aliases:\n  - Alias\n# kept comment\ntags:\n  - personal\n\nrating: 5\n";

    fn write_note(vault: &VaultLayout, slug: &str, text: &str) {
        let path = vault.block_path(slug);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read_note(vault: &VaultLayout, slug: &str) -> String {
        std::fs::read_to_string(vault.block_path(slug)).unwrap()
    }

    #[test]
    fn rename_moves_the_note_unchanged_and_retargets_short_links() {
        let (_root, _derived, vault, conn) = make_vault();
        let foo = format!(
            "---\n{USER_PROPERTIES}saved_at: 2026-04-22T00:00:00Z\n---\n# Foo\n\nText.\n\n\n\nEnd.\n"
        );
        write_note(&vault, "Cards/Foo", &foo);
        let other = format!(
            "---\n{USER_PROPERTIES}Mine Related Notes:\n  - \"[[Foo#^abc]]\"\nsaved_at: 2026-04-22T00:00:00Z\n---\nSee [[Foo]], [[Foo#Part|alias]] and [[Cards/Foo]].\n\n\n\nKeep [[Other]].\n"
        );
        write_note(&vault, "Cards/Other", &other);
        write_note(&vault, "Notes/Plain", "# Plain\n\nLinks [[Foo]].\n");
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        rename_block_file_inner(None, None, &conn, &vault, "Cards/Foo", "Bar").unwrap();

        assert!(!vault.block_path("Cards/Foo").exists());
        assert_eq!(read_note(&vault, "Cards/Bar"), foo);
        assert_eq!(
            read_note(&vault, "Cards/Other"),
            other
                .replace("[[Foo#^abc]]", "[[Bar#^abc]]")
                .replace("[[Foo]]", "[[Bar]]")
                .replace("[[Foo#Part|alias]]", "[[Bar#Part|alias]]")
                .replace("[[Cards/Foo]]", "[[Bar]]")
        );
        // A plain note gets its link and nothing else: no properties appear.
        assert_eq!(read_note(&vault, "Notes/Plain"), "# Plain\n\nLinks [[Bar]].\n");
        assert!(index::get_block(&conn, "Cards/Bar").unwrap().is_some());
    }

    /// Б1.6: in the standard layout a card's media sits in `Media/`, and a
    /// note next to the card links it by a relative Markdown path, plain or
    /// percent-encoded. Renaming the card renames the media, and each link
    /// keeps its prefix and its encoding and still resolves.
    #[test]
    fn renaming_a_card_keeps_relative_markdown_links_to_its_media() {
        let (_root, _derived, vault, conn) = make_vault();
        let photo = vault.root().join("Media/Фото.jpg");
        std::fs::create_dir_all(photo.parent().unwrap()).unwrap();
        std::fs::write(&photo, b"photo bytes").unwrap();
        write_note(
            &vault,
            "Cards/Фото",
            "---\nfile: \"[[Фото.jpg]]\"\nsaved_at: 2026-04-22T00:00:00Z\n---\n",
        );
        write_note(&vault, "Cards/Plain", "Look: ![](../Media/Фото.jpg)\n");
        write_note(
            &vault,
            "Cards/Encoded",
            "Look: ![](../Media/%D0%A4%D0%BE%D1%82%D0%BE.jpg)\n",
        );
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        rename_block_file_inner(None, None, &conn, &vault, "Cards/Фото", "Снимок").unwrap();

        let renamed = vault.root().join("Media/Снимок.jpg");
        assert!(!photo.exists());
        assert_eq!(std::fs::read(&renamed).unwrap(), b"photo bytes");
        assert_eq!(read_note(&vault, "Cards/Plain"), "Look: ![](../Media/Снимок.jpg)\n");
        assert_eq!(
            read_note(&vault, "Cards/Encoded"),
            "Look: ![](../Media/%D0%A1%D0%BD%D0%B8%D0%BC%D0%BE%D0%BA.jpg)\n"
        );
        for slug in ["Cards/Plain", "Cards/Encoded"] {
            // Plain notes: the whole text is the body.
            let reference = iter_inline_media_references(&read_note(&vault, slug)).remove(0);
            assert_eq!(
                media_refs::resolve_inline_media(&vault, slug, &reference),
                Some(renamed.clone()),
                "{slug}"
            );
        }
        let card = read_note(&vault, "Cards/Снимок");
        assert!(card.contains("[[Снимок.jpg]]"), "{card}");
        assert!(!card.contains("Фото"), "{card}");
    }

    #[test]
    fn rename_refuses_when_a_linking_note_was_edited_since_it_was_read() {
        let (_root, _derived, vault, conn) = make_vault();
        write_note(&vault, "Foo", "---\nsaved_at: 2026-04-22T00:00:00Z\n---\nFoo\n");
        write_note(&vault, "Other", "See [[Foo]].\n");
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let planned =
            build_planned_block_writes(&vault, "Foo", "Bar", &[]).unwrap();
        write_note(&vault, "Other", "Edited in Obsidian: [[Foo]].\n");

        let writes = planned
            .iter()
            .filter(|write| write.original_path == vault.block_path("Other"))
            .map(|write| {
                let patched =
                    apply_block_changes(&write.source, &write.before, &write.block).unwrap();
                SourceFileWrite::replace(
                    write.target_path.clone(),
                    write.source.clone().into_bytes(),
                    patched.into_bytes(),
                )
            })
            .collect::<Vec<_>>();
        let error = StagedSourceMutation::stage(writes).unwrap_err();

        assert!(matches!(
            error,
            crate::storage::source_mutation::SourceMutationError::Changed { .. }
        ));
        assert_eq!(read_note(&vault, "Other"), "Edited in Obsidian: [[Foo]].\n");
    }

    #[test]
    fn merge_retargets_short_links_and_keeps_the_linking_note_text() {
        let (_root, _derived, vault, conn) = make_vault();
        write_note(
            &vault,
            "Cards/First",
            "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# First\n\nAlpha.\n",
        );
        write_note(
            &vault,
            "Cards/Second",
            "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# Second\n\nBeta.\n",
        );
        let external = format!(
            "---\n{USER_PROPERTIES}saved_at: 2026-04-22T00:00:00Z\n---\nSee [[First]] and [[Cards/Second|the second]].\n\n\n\nEnd.\n"
        );
        write_note(&vault, "Notes/External", &external);
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        let mutation = merge_blocks_inner(
            None,
            &conn,
            &vault,
            vec!["Cards/First".to_string(), "Cards/Second".to_string()],
        )
        .unwrap();

        let merged = mutation.result.merged_slug;
        let link = merged.rsplit('/').next().unwrap();
        assert_eq!(
            read_note(&vault, "Notes/External"),
            external
                .replace("[[First]]", &format!("[[{link}]]"))
                .replace("[[Cards/Second|the second]]", &format!("[[{link}|the second]]"))
        );
    }

    /// `![](../Media/фото.jpg)` written the way a Markdown editor writes it.
    const ENCODED_PHOTO_LINK: &str = "![](../Media/%D1%84%D0%BE%D1%82%D0%BE.jpg)";

    #[test]
    fn deleting_a_card_keeps_media_an_unindexed_note_links_percent_encoded() {
        let (_root, _derived, vault, conn) = make_vault();
        let photo = vault.root().join("Media/фото.jpg");
        std::fs::create_dir_all(photo.parent().unwrap()).unwrap();
        std::fs::write(&photo, b"photo bytes").unwrap();
        write_note(
            &vault,
            "Cards/Owner",
            "---\nfile: \"[[фото.jpg]]\"\nsaved_at: 2026-04-22T00:00:00Z\n---\n",
        );
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        // Saved a moment ago: on disk, not yet in the index.
        write_note(&vault, "Cards/Note", &format!("Look: {ENCODED_PHOTO_LINK}\n"));

        let plan = build_delete_block_plan(&conn, &vault, "Cards/Owner").unwrap();
        assert!(plan.unused_media.is_empty());
        assert_eq!(plan.shared_media.len(), 1);
        assert_eq!(plan.shared_media[0].referenced_by, vec!["Cards/Note".to_string()]);

        assert!(delete_block_inner(None, &conn, &vault, "Cards/Owner", Some(true)).unwrap());

        assert!(!vault.block_path("Cards/Owner").exists());
        assert_eq!(std::fs::read(&photo).unwrap(), b"photo bytes");
    }

    #[test]
    fn media_users_on_disk_reads_references_in_any_encoding() {
        let (_root, _derived, vault, _conn) = make_vault();
        let photo = vault.root().join("Media/фото.jpg");
        std::fs::create_dir_all(photo.parent().unwrap()).unwrap();
        std::fs::write(&photo, b"photo bytes").unwrap();
        let nfd: String = "фото.jpg".nfd().collect();
        write_note(&vault, "Cards/Encoded", &format!("{ENCODED_PHOTO_LINK}\n"));
        write_note(
            &vault,
            "Cards/Escaped",
            "---\nthumbnail: \"Media/\\u0444\\u043e\\u0442\\u043e.jpg\"\nsaved_at: 2026-04-22T00:00:00Z\n---\n",
        );
        write_note(&vault, "Cards/Decomposed", &format!("![[{nfd}]]\n"));
        write_note(&vault, "Cards/Unrelated", "![](../Media/%D1%84.jpg) and фото elsewhere\n");

        let users = media_users_on_disk(&vault, std::slice::from_ref(&photo), None).unwrap();

        assert_eq!(
            users.get(&photo).cloned().unwrap_or_default(),
            BTreeSet::from([
                "Cards/Decomposed".to_string(),
                "Cards/Encoded".to_string(),
                "Cards/Escaped".to_string(),
            ])
        );
    }

    /// Г1.1: a note that links a file in any form Obsidian reads as a link
    /// to it, not only an embed, keeps the file from going with the card
    /// that shows it: whether the index already knows the note or not.
    #[test]
    fn deleting_a_card_keeps_a_file_another_note_only_links() {
        let links = [
            "[[doc.pdf]]",
            "[[doc.pdf|the paper]]",
            "[[doc.pdf#page=2]]",
            "[doc](../Media/doc.pdf)",
            "![a][r]\n\n[r]: ../Media/doc.pdf",
            "[a][r]\n\n  [r]:\n  <../Media/doc.pdf> \"title\"",
        ];
        for indexed in [true, false] {
            for link in links {
                let (_root, _derived, vault, conn) = make_vault();
                let doc = vault.root().join("Media/doc.pdf");
                std::fs::create_dir_all(doc.parent().unwrap()).unwrap();
                std::fs::write(&doc, b"pdf bytes").unwrap();
                write_note(
                    &vault,
                    "Cards/Owner",
                    "---\nfile: \"[[doc.pdf]]\"\nsaved_at: 2026-04-22T00:00:00Z\n---\n",
                );
                let reader = format!("Read {link}\n");
                if indexed {
                    write_note(&vault, "Cards/Reader", &reader);
                }
                crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
                if !indexed {
                    write_note(&vault, "Cards/Reader", &reader);
                }

                let plan = build_delete_block_plan(&conn, &vault, "Cards/Owner").unwrap();
                assert!(plan.unused_media.is_empty(), "{link} (indexed: {indexed})");
                assert_eq!(
                    plan.shared_media
                        .iter()
                        .map(|media| (media.path.as_str(), media.referenced_by.clone()))
                        .collect::<Vec<_>>(),
                    vec![("Media/doc.pdf", vec!["Cards/Reader".to_string()])],
                    "{link} (indexed: {indexed})"
                );
                assert!(delete_block_inner(None, &conn, &vault, "Cards/Owner", Some(true)).unwrap());
                assert_eq!(std::fs::read(&doc).unwrap(), b"pdf bytes", "{link} (indexed: {indexed})");
            }
        }
    }

    /// Г1.2: a destination is decoded exactly once. `%23` is part of the
    /// name, not a fragment, and `%2520` names `a%20b.jpg`, never the decoy
    /// `a b.jpg`: the card offers its own files and nothing else.
    #[test]
    fn a_percent_encoded_destination_names_its_own_file() {
        let (_root, _derived, vault, conn) = make_vault();
        for name in ["photo#tag.jpg", "a%20b.jpg", "a b.jpg"] {
            let path = vault.root().join("Media").join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, name.as_bytes()).unwrap();
        }
        let body = "![](../Media/photo%23tag.jpg)\n\n![](../Media/a%2520b.jpg)\n";
        write_note(&vault, "Cards/Lone", body);
        write_note(&vault, "Cards/Owner", body);
        write_note(&vault, "Cards/Reader", &format!("Same pictures:\n\n{body}"));
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        // Owner shares both with Reader; Lone too. Nothing goes, the decoy
        // least of all.
        let plan = build_delete_block_plan(&conn, &vault, "Cards/Owner").unwrap();
        assert!(plan.unused_media.is_empty());
        assert_eq!(
            plan.shared_media.iter().map(|media| media.path.as_str()).collect::<BTreeSet<_>>(),
            BTreeSet::from(["Media/a%20b.jpg", "Media/photo#tag.jpg"])
        );
        assert!(delete_block_inner(None, &conn, &vault, "Cards/Owner", Some(true)).unwrap());
        assert!(delete_block_inner(None, &conn, &vault, "Cards/Reader", Some(true)).unwrap());
        for name in ["photo#tag.jpg", "a%20b.jpg", "a b.jpg"] {
            assert!(vault.root().join("Media").join(name).is_file(), "{name}");
        }

        // The last card that shows them offers exactly its two files.
        let plan = build_delete_block_plan(&conn, &vault, "Cards/Lone").unwrap();
        assert!(plan.shared_media.is_empty());
        assert_eq!(
            plan.unused_media.iter().map(|media| media.path.as_str()).collect::<BTreeSet<_>>(),
            BTreeSet::from(["Media/a%20b.jpg", "Media/photo#tag.jpg"])
        );
        assert!(vault.root().join("Media/a b.jpg").is_file());
    }

    #[test]
    fn merge_refuses_when_a_source_was_edited_after_it_was_read() {
        let (_root, _derived, vault, conn) = make_vault();
        let first = "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# First\n\nAlpha.\n";
        let second = "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# Second\n\nBeta.\n";
        write_note(&vault, "Cards/First", first);
        write_note(&vault, "Cards/Second", second);
        write_note(&vault, "Notes/External", "See [[First]].\n");
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let plan = plan_merge_blocks(
            &conn,
            &vault,
            vec!["Cards/First".to_string(), "Cards/Second".to_string()],
        )
        .unwrap();
        let merged_slug = plan.merged_block.slug.clone();
        // Obsidian appends to a source after the merge read it.
        let edited = format!("{second}\nWritten in Obsidian meanwhile.\n");
        std::fs::OpenOptions::new()
            .append(true)
            .open(vault.block_path("Cards/Second"))
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, b"\nWritten in Obsidian meanwhile.\n")
            })
            .unwrap();

        let error = apply_merge_plan(None, &conn, &vault, plan).unwrap_err();

        assert!(matches!(error, MergeBlocksError::SourceChanged { .. }), "{error}");
        assert_eq!(read_note(&vault, "Cards/Second"), edited);
        assert_eq!(read_note(&vault, "Cards/First"), first);
        assert_eq!(read_note(&vault, "Notes/External"), "See [[First]].\n");
        assert!(!vault.block_path(&merged_slug).exists());
        assert!(index::get_block(&conn, &merged_slug).unwrap().is_none());
        assert!(index::get_block(&conn, "Cards/Second").unwrap().is_some());
    }

    /// Б1.7: the outside edit that made a merge refuse reaches the index at
    /// once, without a watcher event, and the watcher is not held off the
    /// notes any longer.
    #[test]
    fn a_refused_merge_leaves_the_outside_edit_in_the_index() {
        let (_root, _derived, vault, conn) = make_vault();
        write_note(
            &vault,
            "Cards/First",
            "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# First\n\nAlpha.\n",
        );
        write_note(
            &vault,
            "Cards/Second",
            "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# Second\n\nBeta.\n",
        );
        write_note(&vault, "Notes/External", "See [[First]].\n");
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let state = AppState::new();
        let plan = plan_merge_blocks(
            &conn,
            &vault,
            vec!["Cards/First".to_string(), "Cards/Second".to_string()],
        )
        .unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(vault.block_path("Cards/Second"))
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, b"\nWritten in Obsidian meanwhile.\n")
            })
            .unwrap();

        let error = apply_merge_plan(Some(&state), &conn, &vault, plan).unwrap_err();

        assert!(matches!(error, MergeBlocksError::SourceChanged { .. }), "{error}");
        let indexed = index::get_block(&conn, "Cards/Second").unwrap().unwrap();
        assert!(indexed.body.contains("Written in Obsidian meanwhile."), "{}", indexed.body);
        for slug in ["Cards/First", "Cards/Second", "Notes/External"] {
            assert!(!state.is_path_suppressed(&vault.block_path(slug)), "{slug}");
        }
        assert!(index::get_block(&conn, "Cards/First").unwrap().is_some());
    }

    #[test]
    fn detaching_media_keeps_user_properties_and_blank_lines() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let card = format!(
            "---\n{USER_PROPERTIES}saved_at: 2026-04-22T00:00:00Z\n---\nIntro\n\n![[photo.png]]\n\nOutro\n\n\n\nEnd\n"
        );
        write_note(&vault, "Card", &card);
        std::fs::write(vault.root().join("photo.png"), b"image-bytes").unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        remove_media_asset_from_card_inner(
            &state,
            &conn,
            &vault,
            "photo.png".to_string(),
            "Card".to_string(),
            "body_embed".to_string(),
            None,
        )
        .unwrap();

        let after = read_note(&vault, "Card");
        let (frontmatter, body) = after.split_at(after.find("---\nIntro").unwrap());
        assert_eq!(
            frontmatter,
            format!("---\n{USER_PROPERTIES}saved_at: 2026-04-22T00:00:00Z\n")
        );
        assert!(!body.contains("photo.png"));
        assert!(body.ends_with("Outro\n\n\n\nEnd\n"), "{body}");
    }

    #[test]
    fn delete_source_video_keeps_a_poster_this_card_embeds_in_its_text() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let mut film = youtube_card("Film", "poster.jpg");
        film.body = "# Film\n\n![[poster.jpg]]\n\nTranscript stays.".to_string();
        persist_block(&conn, &vault, &film);
        std::fs::write(vault.root().join("poster.jpg"), b"poster-bytes").unwrap();

        let result = delete_source_video_inner(&state, &conn, &vault, "Film").unwrap();

        assert_eq!(result.media_ref, "");
        assert_eq!(
            std::fs::read(vault.root().join("poster.jpg")).unwrap(),
            b"poster-bytes"
        );
        assert!(read_note(&vault, "Film").contains("![[poster.jpg]]"));
    }

    #[test]
    fn delete_source_video_keeps_user_properties() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        let film = format!(
            "---\n{USER_PROPERTIES}url: \"https://www.youtube.com/watch?v=9KDDhAOyv9k\"\nthumbnail: poster.jpg\nsaved_at: 2026-04-22T00:00:00Z\n---\n# Film\n"
        );
        write_note(&vault, "Film", &film);
        std::fs::write(vault.root().join("poster.jpg"), b"poster-bytes").unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        delete_source_video_inner(&state, &conn, &vault, "Film").unwrap();

        assert_eq!(
            read_note(&vault, "Film"),
            format!("---\n{USER_PROPERTIES}saved_at: 2026-04-22T00:00:00Z\n---\n# Film\n")
        );
    }

    #[test]
    fn delete_plan_keeps_media_a_note_uses_before_the_index_knows_it() {
        let (_root, _derived, vault, conn) = make_vault();
        persist_block(&conn, &vault, &image("Photo", "Photo.png"));
        std::fs::write(vault.root().join("Photo.png"), b"image-bytes").unwrap();
        // Saved a moment ago: on disk, not yet in the index.
        write_note(&vault, "Fresh", "Look: ![[Photo.png]]\n");

        let plan = build_delete_block_plan(&conn, &vault, "Photo").unwrap();

        assert!(plan.unused_media.is_empty());
        assert_eq!(plan.shared_media.len(), 1);
        assert_eq!(plan.shared_media[0].referenced_by, vec!["Fresh".to_string()]);
    }

    /// A space whose derived store is named by its identity, like the app's.
    fn identified_vault(dir: &Path, id: &str) -> (VaultLayout, rusqlite::Connection) {
        let vault = VaultLayout::with_derived_root(dir.join("space"), dir.join("vaults").join(id));
        std::fs::create_dir_all(vault.root().join(".mine")).unwrap();
        std::fs::write(vault.root().join(".mine/vault-id"), id).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        (vault, conn)
    }

    #[test]
    fn a_video_finished_after_switching_spaces_goes_into_its_own_space() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, conn) = identified_vault(dir.path(), "0123456789abcdef0123456789abcdef");
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        drop(conn);
        let downloaded = dir.path().join("joined.mp4");
        std::fs::write(&downloaded, b"video-bytes").unwrap();

        let result = attach_into_closed_space(&AppState::new(), &vault, "Film", "9KDDhAOyv9k", &downloaded).unwrap();

        assert_eq!(result.affected_slugs, vec!["Film".to_string()]);
        assert_eq!(std::fs::read(vault.root().join(&result.media_ref)).unwrap(), b"video-bytes");
        let (_, content) = files::read_block_file(&vault, &vault.block_path("Film")).unwrap();
        let name = Path::new(&result.media_ref).file_name().unwrap().to_str().unwrap().to_string();
        assert!(content.contains(&format!("![[{name}]]")), "{content}");
    }

    #[test]
    fn a_video_for_a_space_that_is_not_there_is_kept_for_its_return() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, conn) = identified_vault(dir.path(), "0123456789abcdef0123456789abcdef");
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        drop(conn);
        // Another space took the folder's place.
        std::fs::write(vault.root().join(".mine/vault-id"), "fedcba9876543210fedcba9876543210").unwrap();
        let downloaded = dir.path().join("joined.mp4");
        std::fs::write(&downloaded, b"video-bytes").unwrap();

        let result = attach_into_closed_space(&AppState::new(), &vault, "Film", "9KDDhAOyv9k", &downloaded).unwrap();

        assert!(result.affected_slugs.is_empty());
        let kept = crate::source_video_download::kept_downloads(&vault);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].slug, "Film");
        let (_, content) = files::read_block_file(&vault, &vault.block_path("Film")).unwrap();
        assert!(!content.contains(".mp4"), "the other space's card is untouched");
    }

    /// Б3.4: space A's folder now holds space B, which is open and has a card
    /// of the same name and clip. A's video stays A's.
    #[test]
    fn a_video_for_a_space_whose_folder_another_open_space_took_is_kept_for_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let (first, _) = identified_vault(dir.path(), "0123456789abcdef0123456789abcdef");
        let (second, conn) = identified_vault(dir.path(), "fedcba9876543210fedcba9876543210");
        assert_eq!(first.root(), second.root());
        persist_block(&conn, &second, &youtube_card("Film", "poster.jpg"));
        let card_before = std::fs::read(second.block_path("Film")).unwrap();
        let state = AppState::new();
        *state.vault_state.lock().unwrap() = Some(crate::commands::state::VaultState {
            conn,
            vault: second.clone(),
        });
        let downloaded = dir.path().join("joined.mp4");
        std::fs::write(&downloaded, b"video-bytes").unwrap();

        let published =
            publish_downloaded_source_video(&state, &first, "Film", "9KDDhAOyv9k", &downloaded).unwrap();

        assert!(published.open_root.is_none());
        assert!(published.result.affected_slugs.is_empty());
        assert_eq!(std::fs::read(second.block_path("Film")).unwrap(), card_before);
        let kept = crate::source_video_download::kept_downloads(&first);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].slug, "Film");
        assert!(crate::source_video_download::kept_downloads(&second).is_empty());
        assert!(!downloaded.exists());
    }

    /// Г2.2: the open space's disk is disconnected while its download runs.
    /// The session still names the space, but its folder is gone: the card
    /// that cannot be found there is no final answer, and the finished video
    /// is kept for that space with its record instead of being deleted.
    #[test]
    fn a_video_for_the_open_space_whose_folder_went_away_is_kept_for_it() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, conn) = identified_vault(dir.path(), "0123456789abcdef0123456789abcdef");
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        let state = AppState::new();
        *state.vault_state.lock().unwrap() = Some(crate::commands::state::VaultState {
            conn,
            vault: vault.clone(),
        });
        let unmounted = dir.path().join("unmounted");
        std::fs::rename(vault.root(), &unmounted).unwrap();
        let finished = dir.path().join("joined.mp4");
        std::fs::write(&finished, b"video-bytes").unwrap();

        let delivered = crate::source_video_download::deliver_download(
            &vault,
            "Film",
            "9KDDhAOyv9k",
            &finished,
            |finished| {
                publish_downloaded_source_video(&state, &vault, "Film", "9KDDhAOyv9k", finished)
                    .map(|published| published.result)
            },
        );

        let kept = crate::source_video_download::kept_downloads(&vault);
        assert_eq!(kept.len(), 1, "{delivered:?}");
        assert_eq!(kept[0].slug, "Film");
        assert_eq!(
            std::fs::read(vault.derived_root().join("source-videos").join(&kept[0].file)).unwrap(),
            b"video-bytes"
        );
        assert!(!finished.exists());
        let card = std::fs::read_to_string(unmounted.join("Film.md")).unwrap();
        assert!(!card.contains(".mp4"), "{card}");
    }

    /// Г2.2: the folder goes between the choice of the open space and the
    /// look for the card. A card missing from a folder that is not there is
    /// a passing failure: the video is kept, not discarded.
    #[test]
    fn a_card_missing_from_a_folder_that_went_away_does_not_discard_the_video() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, conn) = identified_vault(dir.path(), "0123456789abcdef0123456789abcdef");
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        std::fs::rename(vault.root(), dir.path().join("unmounted")).unwrap();
        let finished = dir.path().join("joined.mp4");
        std::fs::write(&finished, b"video-bytes").unwrap();
        let state = AppState::new();

        let outcome =
            attach_downloaded_source_video_inner(&state, &conn, &vault, "Film", "9KDDhAOyv9k", &finished);
        assert!(
            !matches!(outcome, Err(MediaAssetActionError::InvalidMediaRef { .. })),
            "{outcome:?}"
        );
        let delivered = crate::source_video_download::deliver_download(
            &vault,
            "Film",
            "9KDDhAOyv9k",
            &finished,
            |finished| {
                attach_downloaded_source_video_inner(&state, &conn, &vault, "Film", "9KDDhAOyv9k", finished)
            },
        );

        assert!(delivered.is_err());
        let kept = crate::source_video_download::kept_downloads(&vault);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(!finished.exists());
    }

    /// Б3.1: a kept video for a card that now links another clip is a final
    /// answer: the video and its record go.
    #[test]
    fn a_kept_video_for_a_card_that_changed_clip_is_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, conn) = identified_vault(dir.path(), "0123456789abcdef0123456789abcdef");
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        let downloaded = dir.path().join("joined.mp4");
        std::fs::write(&downloaded, b"video-bytes").unwrap();
        crate::source_video_download::keep_download(&vault, "Film", "abcdefghijk", &downloaded).unwrap();
        let kept = crate::source_video_download::kept_downloads(&vault).remove(0);

        let outcome = attach_downloaded_source_video_inner(
            &AppState::new(),
            &conn,
            &vault,
            &kept.slug,
            &kept.video_id,
            &vault.derived_root().join("source-videos").join(&kept.file),
        );
        crate::source_video_download::settle_kept_download(&vault, &kept, &outcome);

        assert!(matches!(outcome, Err(MediaAssetActionError::InvalidMediaRef { .. })));
        assert!(crate::source_video_download::kept_downloads(&vault).is_empty());
        assert!(!vault.derived_root().join("source-videos").join(&kept.file).exists());
    }

    /// Images a note links in every `CommonMark` form Mine has to read: a
    /// title in quotes, apostrophes or parentheses, a destination in angle
    /// brackets, parentheses in the file name.
    const TITLED_IMAGES: [&str; 5] = ["p.jpg", "p q.jpg", "Foo (image 1).jpg", "s.jpg", "r.jpg"];
    const TITLED_IMAGE_LINKS: &str = "![x](../Media/p.jpg \"t\")\n\
         ![x](<../Media/p q.jpg>)\n\
         ![x](../Media/Foo (image 1).jpg)\n\
         ![x](../Media/s.jpg 't')\n\
         ![x](../Media/r.jpg (t))\n";

    fn write_media(vault: &VaultLayout, relative: &str) -> PathBuf {
        let path = vault.root().join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, relative.as_bytes()).unwrap();
        path
    }

    /// В1.1: deleting a card with its unused media keeps every image another
    /// note links, whatever `CommonMark` form the link takes.
    #[test]
    fn deleting_a_card_keeps_images_linked_with_titles_angle_brackets_and_parentheses() {
        let (_root, _derived, vault, conn) = make_vault();
        for name in TITLED_IMAGES {
            write_media(&vault, &format!("Media/{name}"));
        }
        let owner_body: String = TITLED_IMAGES.iter().map(|name| ["![[", name, "]]\n"].concat()).collect();
        write_note(
            &vault,
            "Cards/Owner",
            &format!("---\nsaved_at: 2026-04-22T00:00:00Z\n---\n{owner_body}"),
        );
        write_note(&vault, "Cards/Note", TITLED_IMAGE_LINKS);
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        let plan = build_delete_block_plan(&conn, &vault, "Cards/Owner").unwrap();
        assert!(plan.unused_media.is_empty(), "{:?}", plan.unused_media);
        assert_eq!(plan.shared_media.len(), TITLED_IMAGES.len());
        assert!(delete_block_inner(None, &conn, &vault, "Cards/Owner", Some(true)).unwrap());

        for name in TITLED_IMAGES {
            let relative = format!("Media/{name}");
            assert_eq!(std::fs::read(vault.root().join(&relative)).unwrap(), relative.as_bytes());
        }
    }

    /// В1.1: renaming an image rewrites only the file name inside each
    /// Markdown destination; the title and the angle brackets stay.
    #[test]
    fn renaming_media_keeps_the_title_and_angle_brackets_of_markdown_images() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();
        for name in ["p.jpg", "a b.jpg", "Foo (image 1).jpg"] {
            write_media(&vault, &format!("Media/{name}"));
        }
        write_note(
            &vault,
            "Cards/Note",
            "![x](../Media/p.jpg \"t\") ![y](<../Media/a b.jpg> 't') ![z](../Media/Foo (image 1).jpg (t))\n",
        );
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        for (media, stem) in [("Media/p.jpg", "new"), ("Media/a b.jpg", "c d"), ("Media/Foo (image 1).jpg", "Bar (image 1)")] {
            rename_media_asset_inner(&state, &conn, &vault, media.to_string(), stem.to_string()).unwrap();
        }

        assert_eq!(
            read_note(&vault, "Cards/Note"),
            "![x](../Media/new.jpg \"t\") ![y](<../Media/c d.jpg> 't') ![z](../Media/Bar%20%28image%201%29.jpg (t))\n"
        );
    }

    /// В1.2: an editor saves a note being merged by replacing its file (a new
    /// inode) after the merge compared the note and before it went to the
    /// Trash. The merge refuses: the saved version stays in place, out of the
    /// Trash, and no merged card appears.
    #[test]
    fn merge_refuses_an_atomic_save_between_the_check_and_the_trash() {
        let (_root, _derived, vault, conn) = make_vault();
        let first = "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# First\n\nAlpha.\n";
        let second = "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# Second\n\nBeta.\n";
        write_note(&vault, "Cards/First", first);
        write_note(&vault, "Cards/Second", second);
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let saved = format!("{first}\nSaved by an editor.\n");
        let saved_by_editor = saved.clone();
        crate::storage::source_mutation::hooks::before_next_checked_trash(move |path| {
            let staged = path.with_file_name("editor-save.tmp");
            std::fs::write(&staged, saved_by_editor).unwrap();
            std::fs::rename(&staged, path).unwrap();
        });

        let error = merge_blocks_inner(
            None,
            &conn,
            &vault,
            vec!["Cards/First".to_string(), "Cards/Second".to_string()],
        )
        .unwrap_err();

        assert!(matches!(error, MergeBlocksError::SourceChanged { .. }), "{error}");
        assert_eq!(read_note(&vault, "Cards/First"), saved);
        assert_eq!(read_note(&vault, "Cards/Second"), second);
        let notes: Vec<PathBuf> = files::scan_md_files(&vault).unwrap();
        assert_eq!(
            notes,
            vec![vault.block_path("Cards/First"), vault.block_path("Cards/Second")]
        );
    }

    /// В1.3: a card moved into a folder of another depth keeps its own
    /// relative Markdown links and a relative property working, and Markdown
    /// links to it from other notes follow it in the form each note wrote.
    #[test]
    fn moving_a_card_into_another_folder_keeps_markdown_links_resolving() {
        let (_root, _derived, vault, conn) = make_vault();
        write_media(&vault, "Media/a.jpg");
        write_media(&vault, "Media/t.jpg");
        write_note(
            &vault,
            "Foo",
            "---\nthumbnail: ./Media/t.jpg\nsaved_at: 2026-04-22T00:00:00Z\n---\n![](Media/a.jpg)\n\nSee [n](Other.md \"the other\").\n",
        );
        write_note(
            &vault,
            "Other",
            "Back to [f](Foo.md), [short](Foo) and [part](Foo.md#Heading).\n",
        );
        write_note(&vault, "Deep/Linker", "Up to [f](../Foo.md).\n");
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        rename_block_file_inner(None, None, &conn, &vault, "Foo", "Archive/Foo").unwrap();

        assert!(!vault.block_path("Foo").exists());
        assert_eq!(
            read_note(&vault, "Archive/Foo"),
            "---\nthumbnail: ../Media/t.jpg\nsaved_at: 2026-04-22T00:00:00Z\n---\n![](../Media/a.jpg)\n\nSee [n](../Other.md \"the other\").\n"
        );
        assert_eq!(
            read_note(&vault, "Other"),
            "Back to [f](Archive/Foo.md), [short](Archive/Foo) and [part](Archive/Foo.md#Heading).\n"
        );
        assert_eq!(read_note(&vault, "Deep/Linker"), "Up to [f](../Archive/Foo.md).\n");
        let index = mine_core::links::LinkIndex::new(files::scan_vault_file_paths(&vault).unwrap());
        for (note, destination, target) in [
            ("Archive/Foo.md", "../Media/a.jpg", "Media/a.jpg"),
            ("Archive/Foo.md", "../Media/t.jpg", "Media/t.jpg"),
            ("Archive/Foo.md", "../Other.md", "Other.md"),
            ("Other.md", "Archive/Foo.md", "Archive/Foo.md"),
            ("Other.md", "Archive/Foo", "Archive/Foo.md"),
            ("Deep/Linker.md", "../Archive/Foo.md", "Archive/Foo.md"),
        ] {
            assert_eq!(
                index.resolve(note, destination, mine_core::links::LinkSyntax::Markdown),
                mine_core::links::LinkResolution::Resolved(target.to_string()),
                "{note}: {destination}"
            );
        }
    }

    /// В1.3: a plain rename in place rewrites Markdown links to the card as
    /// well as wikilinks.
    #[test]
    fn renaming_a_card_rewrites_markdown_links_to_it() {
        let (_root, _derived, vault, conn) = make_vault();
        write_note(&vault, "Cards/Foo", "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# Foo\n");
        write_note(&vault, "Notes/Other", "[f](../Cards/Foo.md) [g](<../Cards/Foo.md> \"t\") [[Foo]]\n");
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        rename_block_file_inner(None, None, &conn, &vault, "Cards/Foo", "Bar Baz").unwrap();

        assert_eq!(
            read_note(&vault, "Notes/Other"),
            "[f](../Cards/Bar%20Baz.md) [g](<../Cards/Bar Baz.md> \"t\") [[Bar Baz]]\n"
        );
    }

    /// В1.3: merging a card of the cards folder with a note from the space's
    /// root into the cards folder keeps every image of both resolving.
    #[test]
    fn merging_notes_from_different_folders_keeps_their_images_resolving() {
        let (_root, _derived, vault, conn) = make_vault();
        let vault = vault.with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        let x = write_media(&vault, "Media/x.jpg");
        let y = write_media(&vault, "Media/y.jpg");
        write_note(
            &vault,
            "Cards/A",
            "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# A\n\n![](../Media/x.jpg)\n",
        );
        write_note(&vault, "B", "# B\n\n![](Media/y.jpg \"why\")\n");
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        let mutation =
            merge_blocks_inner(None, &conn, &vault, vec!["Cards/A".to_string(), "B".to_string()])
                .unwrap();

        let merged = mutation.result.merged_slug;
        assert!(merged.starts_with("Cards/"), "{merged}");
        let text = read_note(&vault, &merged);
        assert!(text.contains("![](../Media/y.jpg \"why\")"), "{text}");
        let resolved: Vec<Option<PathBuf>> = iter_inline_media_references(&text)
            .iter()
            .map(|reference| media_refs::resolve_inline_media(&vault, &merged, reference))
            .collect();
        assert_eq!(resolved, vec![Some(x), Some(y)], "{text}");
    }

    /// Г1.6: an image inside a link is a reference of its own: moving its
    /// card to another depth and merging its note into another folder write
    /// its path again, and the outer link stays as written.
    #[test]
    fn an_image_inside_a_link_keeps_resolving_after_a_move_and_a_merge() {
        let (_root, _derived, vault, conn) = make_vault();
        let a = write_media(&vault, "Media/a.jpg");
        write_note(
            &vault,
            "Foo",
            "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n[![x](Media/a.jpg)](https://e.com/page)\n",
        );
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        rename_block_file_inner(None, None, &conn, &vault, "Foo", "Archive/Foo").unwrap();

        let moved = read_note(&vault, "Archive/Foo");
        assert_eq!(
            moved,
            "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n[![x](../Media/a.jpg)](https://e.com/page)\n"
        );
        let reference = iter_inline_media_references(&moved).remove(0);
        assert_eq!(media_refs::resolve_inline_media(&vault, "Archive/Foo", &reference), Some(a));

        let (_root, _derived, vault, conn) = make_vault();
        let vault = vault.with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        let x = write_media(&vault, "Media/x.jpg");
        let y = write_media(&vault, "Media/y.jpg");
        write_note(
            &vault,
            "Cards/A",
            "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# A\n\n![](../Media/x.jpg)\n",
        );
        write_note(&vault, "B", "# B\n\n[![y](Media/y.jpg)](https://e.com/y)\n");
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        let mutation =
            merge_blocks_inner(None, &conn, &vault, vec!["Cards/A".to_string(), "B".to_string()])
                .unwrap();

        let merged = mutation.result.merged_slug;
        let text = read_note(&vault, &merged);
        assert!(text.contains("[![y](../Media/y.jpg)](https://e.com/y)"), "{text}");
        let resolved: Vec<Option<PathBuf>> = iter_inline_media_references(&text)
            .iter()
            .map(|reference| media_refs::resolve_inline_media(&vault, &merged, reference))
            .collect();
        assert_eq!(resolved, vec![Some(x), Some(y)], "{text}");
    }

    /// Г1.7: a rename leaves `[[Foo]]` in fenced, inline and indented code
    /// of other notes as written and rewrites the real link.
    #[test]
    fn renaming_a_card_leaves_its_name_in_code_alone() {
        let (_root, _derived, vault, conn) = make_vault();
        write_note(&vault, "Cards/Foo", "---\nsaved_at: 2026-04-22T00:00:00Z\n---\n# Foo\n");
        let other = "See [[Foo]] and [f](../Cards/Foo.md).\n\n```\n[[Foo]] [f](../Cards/Foo.md)\n```\n\n`[[Foo]]`\n\n    [[Foo]] [f](../Cards/Foo.md)\n";
        write_note(&vault, "Notes/Other", other);
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        rename_block_file_inner(None, None, &conn, &vault, "Cards/Foo", "Bar").unwrap();

        assert_eq!(
            read_note(&vault, "Notes/Other"),
            other.replacen("See [[Foo]] and [f](../Cards/Foo.md)", "See [[Bar]] and [f](../Cards/Bar.md)", 1)
        );
    }

    /// Restores a folder's permissions however the test ends, so the
    /// temporary space can be removed.
    struct PermissionsBack(PathBuf, std::fs::Permissions);

    impl Drop for PermissionsBack {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, self.1.clone());
        }
    }

    /// В3.1: while the card's folder cannot be read, recovering a kept video
    /// is a passing failure: the video and its record stay. Once the folder
    /// can be read again, the next recovery attaches the video.
    #[test]
    fn an_unreadable_card_folder_keeps_the_kept_video_for_the_next_recovery() {
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: `geteuid` only reads the credentials of this process.
        if unsafe { libc::geteuid() } == 0 {
            // The superuser reads any folder: there is no denial to observe.
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let (vault, conn) = identified_vault(dir.path(), "0123456789abcdef0123456789abcdef");
        persist_block(&conn, &vault, &youtube_card("Cards/Film", "poster.jpg"));
        let downloaded = dir.path().join("joined.mp4");
        std::fs::write(&downloaded, b"video-bytes").unwrap();
        crate::source_video_download::keep_download(&vault, "Cards/Film", "9KDDhAOyv9k", &downloaded)
            .unwrap();
        let kept = crate::source_video_download::kept_downloads(&vault).remove(0);
        let kept_path = vault.derived_root().join("source-videos").join(&kept.file);
        let cards = vault.root().join("Cards");
        let permissions = std::fs::metadata(&cards).unwrap().permissions();
        let restore = PermissionsBack(cards.clone(), permissions);
        std::fs::set_permissions(&cards, std::fs::Permissions::from_mode(0o000)).unwrap();

        let outcome = attach_downloaded_source_video_inner(
            &AppState::new(),
            &conn,
            &vault,
            &kept.slug,
            &kept.video_id,
            &kept_path,
        );
        crate::source_video_download::settle_kept_download(&vault, &kept, &outcome);
        drop(restore);

        assert!(outcome.is_err());
        assert!(
            !matches!(outcome, Err(MediaAssetActionError::InvalidMediaRef { .. })),
            "{outcome:?}"
        );
        assert_eq!(crate::source_video_download::kept_downloads(&vault), vec![kept.clone()]);
        assert_eq!(std::fs::read(&kept_path).unwrap(), b"video-bytes");

        let outcome = attach_downloaded_source_video_inner(
            &AppState::new(),
            &conn,
            &vault,
            &kept.slug,
            &kept.video_id,
            &kept_path,
        );
        crate::source_video_download::settle_kept_download(&vault, &kept, &outcome);

        let attached = outcome.unwrap();
        assert!(crate::source_video_download::kept_downloads(&vault).is_empty());
        assert_eq!(
            std::fs::read(vault.root().join(&attached.media_ref)).unwrap(),
            b"video-bytes"
        );
    }

    /// В3.2: a download finishes while the card is being edited in Obsidian:
    /// attaching it meets the edit and refuses. The video is kept for its
    /// space, with its record, to be attached when the space opens again, and
    /// the edit stays.
    #[test]
    fn a_live_download_that_meets_an_outside_edit_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, conn) = identified_vault(dir.path(), "0123456789abcdef0123456789abcdef");
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        let finished = dir.path().join("joined.mp4");
        std::fs::write(&finished, b"video-bytes").unwrap();
        after_next_card_read(|card| {
            let mut text = std::fs::read_to_string(card).unwrap();
            text.push_str("\nEdited in Obsidian.\n");
            std::fs::write(card, text).unwrap();
        });
        let state = AppState::new();

        let delivered = crate::source_video_download::deliver_download(
            &vault,
            "Film",
            "9KDDhAOyv9k",
            &finished,
            |finished| {
                attach_downloaded_source_video_inner(&state, &conn, &vault, "Film", "9KDDhAOyv9k", finished)
            },
        );

        assert!(delivered.is_err());
        let kept = crate::source_video_download::kept_downloads(&vault);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(kept[0].slug, "Film");
        assert_eq!(
            std::fs::read(vault.derived_root().join("source-videos").join(&kept[0].file)).unwrap(),
            b"video-bytes"
        );
        let card = read_note(&vault, "Film");
        assert!(card.contains("Edited in Obsidian."), "{card}");
        assert!(!card.contains(".mp4"), "{card}");
    }

    /// В3.2: a card that links another clip by the time its download ends is
    /// a final answer: nothing is kept and nothing reaches the space.
    #[test]
    fn a_live_download_for_a_card_that_changed_clip_is_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, conn) = identified_vault(dir.path(), "0123456789abcdef0123456789abcdef");
        persist_block(&conn, &vault, &youtube_card("Film", "poster.jpg"));
        let card_before = read_note(&vault, "Film");
        let finished = dir.path().join("joined.mp4");
        std::fs::write(&finished, b"video-bytes").unwrap();
        let state = AppState::new();

        let delivered = crate::source_video_download::deliver_download(
            &vault,
            "Film",
            "abcdefghijk",
            &finished,
            |finished| {
                attach_downloaded_source_video_inner(&state, &conn, &vault, "Film", "abcdefghijk", finished)
            },
        );

        assert!(delivered.is_err());
        assert!(crate::source_video_download::kept_downloads(&vault).is_empty());
        assert_eq!(read_note(&vault, "Film"), card_before);
        assert!(files::scan_vault_file_paths(&vault)
            .unwrap()
            .iter()
            .all(|path| !is_video_file_name(path)));
    }

    /// В3.3: space A's download ends while space B, open, stands in A's
    /// folder with an identity iCloud has not brought to this Mac, and holds a
    /// card of the same name and clip. An identity that cannot be read proves
    /// nothing: A's video is kept for A and B's card is left alone.
    #[test]
    fn a_video_for_a_folder_whose_identity_is_only_in_icloud_is_kept_for_its_own_space() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Mobile Documents").join("space");
        let first = VaultLayout::with_derived_root(
            root.clone(),
            dir.path().join("vaults").join("0123456789abcdef0123456789abcdef"),
        );
        let second = VaultLayout::with_derived_root(
            root.clone(),
            dir.path().join("vaults").join("fedcba9876543210fedcba9876543210"),
        );
        std::fs::create_dir_all(root.join(".mine")).unwrap();
        // iCloud keeps the name and size of a file it moved off this Mac.
        std::fs::File::create(root.join(".mine/vault-id"))
            .unwrap()
            .set_len(32)
            .unwrap();
        assert_eq!(
            crate::space_registry::space_identity(&root),
            crate::space_registry::SpaceIdentity::InCloud
        );
        let conn = db::open_or_create(&second.index_db_path()).unwrap();
        persist_block(&conn, &second, &youtube_card("Film", "poster.jpg"));
        let card_before = std::fs::read(second.block_path("Film")).unwrap();
        let state = AppState::new();
        *state.vault_state.lock().unwrap() = Some(crate::commands::state::VaultState {
            conn,
            vault: second.clone(),
        });
        let downloaded = dir.path().join("joined.mp4");
        std::fs::write(&downloaded, b"video-bytes").unwrap();

        let published =
            publish_downloaded_source_video(&state, &first, "Film", "9KDDhAOyv9k", &downloaded).unwrap();

        assert!(published.open_root.is_none());
        assert!(published.result.affected_slugs.is_empty());
        assert_eq!(std::fs::read(second.block_path("Film")).unwrap(), card_before);
        let kept = crate::source_video_download::kept_downloads(&first);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].slug, "Film");
        assert!(crate::source_video_download::kept_downloads(&second).is_empty());
        assert!(files::scan_vault_file_paths(&second)
            .unwrap()
            .iter()
            .all(|path| !is_video_file_name(path)));
    }
}
