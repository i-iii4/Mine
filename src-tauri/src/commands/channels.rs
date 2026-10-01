// Channel commands: list, create, delete channels.
//
// Contract: SPEC_INTEGRATION.md#commands/channels

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::commands::state::{
    current_vault_layout, ensure_vault_fresh, read_owned_projection, AppState, CommandError,
};
use crate::commands::tags::MembershipRewrite;
use crate::domain::block::{
    parse_markdown_document, serialize_block, Block, BlockType, DateTime, Frontmatter,
};
use crate::domain::channel::Channel;
use crate::domain::collection::{normalize_collection_ref, validate_collection_ref};
use crate::domain::source_patch::apply_block_changes;
use crate::domain::vault::VaultLayout;
#[cfg(test)]
use crate::storage::db;
use crate::storage::source_mutation::{SourceFileWrite, StagedSourceMutation};
use crate::storage::{files, index, projection};
use crate::util::append_startup_trace;

const SOURCE_MUTATION_WATCHER_SUPPRESSION_MS: u64 = 1500;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Serializable channel data for the frontend.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ChannelDto {
    pub tag: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub position: u32,
    pub created_at: String,
    /// Number of blocks with this tag.
    pub block_count: usize,
}

impl ChannelDto {
    fn from_channel(channel: &Channel, block_count: usize) -> Self {
        Self {
            tag: channel.tag.clone(),
            description: channel.description.clone(),
            color: channel.color.clone(),
            icon: channel.icon.clone(),
            position: channel.position,
            created_at: channel.created_at.as_str().to_string(),
            block_count,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TaxonomySnapshot {
    pub generation: projection::ProjectionRevision,
    pub tags: Vec<index::TagCount>,
    pub channels: Vec<ChannelDto>,
    pub total_blocks: usize,
    /// Which collections each card is in, from the same projection revision
    /// as `tags`. See SPEC_CARD_STATES.md, С3 and С4.
    pub memberships: Vec<BlockCollection>,
}

/// One card in one collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct BlockCollection {
    pub block_id: i64,
    pub tag: String,
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all channels with block counts.
#[tauri::command]
pub async fn list_channels(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<ChannelDto>, CommandError> {
    append_startup_trace(&app, "list_channels", "start");
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let app_for_query = app.clone();
    let dtos =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ChannelDto>, CommandError> {
            read_owned_projection(&app_for_query, &vault, load_channels)
        })
        .await
        .map_err(|e| CommandError::Internal(format!("list_channels task join failed: {e}")))??;

    append_startup_trace(&app, "list_channels", &format!("done count={}", dtos.len()));
    Ok(dtos)
}

#[tauri::command]
pub async fn list_taxonomy_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TaxonomySnapshot, CommandError> {
    append_startup_trace(&app, "list_taxonomy_snapshot", "start");
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let app_for_query = app.clone();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || -> Result<TaxonomySnapshot, CommandError> {
            read_owned_projection(&app_for_query, &vault, |conn| {
                Ok(projection::read_projection_snapshot(
                    conn,
                    |conn, generation| {
                        Ok(TaxonomySnapshot {
                            generation,
                            tags: index::get_all_tags(conn)?,
                            channels: load_channels(conn)?,
                            total_blocks: index::count_grid_blocks(conn)?,
                            memberships: crate::storage::block_queries::list_block_collections(conn)?
                                .into_iter()
                                .map(|(block_id, tag)| BlockCollection { block_id, tag })
                                .collect(),
                        })
                    },
                )?)
            })
        })
        .await
        .map_err(|e| {
            CommandError::Internal(format!("list_taxonomy_snapshot task join failed: {e}"))
        })??;
    append_startup_trace(
        &app,
        "list_taxonomy_snapshot",
        &format!(
            "done tags={} channels={} total={}",
            snapshot.tags.len(),
            snapshot.channels.len(),
            snapshot.total_blocks
        ),
    );
    Ok(snapshot)
}

/// Create a promoted collection from a Markdown collection ref.
#[tauri::command]
pub fn create_channel(
    state: State<'_, AppState>,
    tag: String,
    title: Option<String>,
) -> Result<ChannelDto, CommandError> {
    let _ = title;
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    let vault = files::layout_for_new_files(&vs.vault)?;
    create_channel_inner(&vs.conn, &vault, &tag)
}

pub(crate) fn create_channel_inner(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    tag: &str,
) -> Result<ChannelDto, CommandError> {
    let now = crate::commands::state::now_saved_at();
    let dt = DateTime::new(&now).map_err(|e| CommandError::Internal(e.to_string()))?;

    let tag = validate_collection_ref(tag).map_err(CommandError::Internal)?;
    if tag.contains('/') {
        return Err(CommandError::Internal(
            "new collection name must not contain a folder path".into(),
        ));
    }
    // Check uniqueness after collection-ref normalization
    let existing = index::list_channels(conn)?;
    if existing.iter().any(|c| c.tag == tag) {
        return Err(CommandError::Internal(format!(
            "channel '{}' already exists",
            tag
        )));
    }
    let occupied = files::scan_vault_file_paths(vault)?;
    let tag = mine_core::save::select_unique_file_stem(&tag, "md", &occupied)
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    let mut channel = Channel::new(&tag, dt).map_err(|e| CommandError::Internal(e.to_string()))?;
    channel.position = index::next_channel_position(conn)?;

    let block = channel_to_block(&channel);
    // Existing documents keep their paths; new ones follow the configured layout.
    let source_slug = vault.new_collection_slug(&channel.tag);
    let path = vault.block_path(&source_slug);
    let staged = StagedSourceMutation::stage(vec![SourceFileWrite::create(
        path,
        serialize_block(&block).into_bytes(),
    )])
    .map_err(CommandError::from)?;
    staged
        .commit_with_index(conn, "create_channel", |index_conn| {
            index::upsert_channel_with_source(index_conn, &channel, Some(source_slug.as_str()))
        })
        .map_err(CommandError::from)?;

    // Get block count for this tag
    let tags = index::get_all_tags(conn)?;
    let count = tags
        .iter()
        .find(|t| t.tag == channel.tag)
        .map(|t| t.count)
        .unwrap_or(0);

    Ok(ChannelDto::from_channel(&channel, count))
}

/// A single item in a reorder request: tag + new position.
#[derive(Debug, Deserialize)]
pub struct ReorderItem {
    pub tag: String,
    pub position: u32,
}

/// Reorder channels by setting new positions for each tag.
/// Tags without channel entries are auto-created.
///
/// Off the main thread: it writes one document per moved collection, and a
/// synchronous command held the window still until the last write landed,
/// right at the moment of the drop.
#[tauri::command]
pub async fn reorder_channels(app: AppHandle, items: Vec<ReorderItem>) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        reorder_channels_blocking(&state, items)
    })
    .await
    .map_err(|error| CommandError::Internal(format!("reorder worker failed: {error}")))?
}

fn reorder_channels_blocking(state: &AppState, items: Vec<ReorderItem>) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let existing = index::list_channels(&vs.conn)?;
    let existing_by_tag = existing
        .into_iter()
        .map(|channel| (channel.tag.clone(), channel))
        .collect::<HashMap<_, _>>();
    let now = crate::commands::state::now_saved_at();
    let mut seen = std::collections::HashSet::new();
    let mut planned_channels = Vec::with_capacity(items.len());
    let mut writes = Vec::with_capacity(items.len());
    for item in items {
        let tag = normalize_collection_ref(&item.tag);
        if tag.is_empty() {
            continue;
        }
        validate_collection_ref(&tag).map_err(CommandError::Internal)?;
        if !seen.insert(tag.clone()) {
            return Err(CommandError::Internal(format!(
                "duplicate collection in reorder: {tag}"
            )));
        }
        // A collection that keeps its place keeps its document untouched.
        if existing_by_tag
            .get(&tag)
            .is_some_and(|existing| existing.position == item.position)
        {
            continue;
        }
        let mut channel = if let Some(existing) = existing_by_tag.get(&tag) {
            existing.clone()
        } else {
            let dt = DateTime::new(&now).map_err(|e| CommandError::Internal(e.to_string()))?;
            Channel::new(&tag, dt).map_err(|e| CommandError::Internal(e.to_string()))?
        };
        channel.position = item.position;
        let path = match collection_document_for_mutation(&vs.conn, &vs.vault, &tag)? {
            Some(page) => page.path,
            None if !tag.contains('/') => vs.vault.block_path(&vs.vault.new_collection_slug(&tag)),
            None => {
                return Err(CommandError::Internal(format!(
                    "collection document '{tag}' not found"
                )))
            }
        };
        // A reorder may only write the collection's own document: the file's
        // stem is the collection's name. A tag that resolves to a file with a
        // different stem is a stale index row aimed at another collection's
        // document — before this guard, such a row (e.g. a pre-rename
        // `Collections/Видео` phantom next to the real `Видео`) produced two
        // writes to one path, the staged mutation refused the duplicate, and
        // every reorder in the space rolled back. The phantom row itself is
        // swept out by reconciliation; skipping it here keeps the positions of
        // every real collection applying meanwhile.
        let owns_document = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem == tag.rsplit('/').next().unwrap_or(&tag));
        if !owns_document {
            continue;
        }
        let source_slug = vs
            .vault
            .slug_for_path(&path)
            .map_err(|error| CommandError::Internal(error.to_string()))?;
        // The page is the user's note: its text, properties and membership
        // stay; only `position` changes.
        writes.push(if path.exists() {
            let (_, content) = files::read_block_file(&vs.vault, &path)?;
            let before = parse_markdown_document(&source_slug, &content, channel.created_at.clone())
                .map_err(|error| CommandError::Internal(error.to_string()))?
                .block;
            let mut after = before.clone();
            after.frontmatter.position = Some(channel.position);
            let patched = apply_block_changes(&content, &before, &after).map_err(|_| {
                CommandError::FrontmatterNotWritable {
                    path: path.display().to_string(),
                }
            })?;
            SourceFileWrite::replace(path, content.into_bytes(), patched.into_bytes())
        } else {
            SourceFileWrite::create(path, serialize_block(&channel_to_block(&channel)).into_bytes())
        });
        planned_channels.push((channel, source_slug));
    }

    let staged = StagedSourceMutation::stage(writes).map_err(CommandError::from)?;
    staged
        .commit_with_index(&vs.conn, "reorder_channels", |index_conn| {
            for (channel, source_slug) in &planned_channels {
                index::upsert_channel_with_source(index_conn, channel, Some(source_slug.as_str()))?;
            }
            Ok(())
        })
        .map_err(CommandError::from)?;
    Ok(())
}

/// Rename a channel: update the tag in all blocks' frontmatter files,
/// re-index them, and update the channel record in the database.
#[tauri::command(rename_all = "snake_case")]
pub fn rename_channel(
    state: State<'_, AppState>,
    old_tag: String,
    new_tag: String,
) -> Result<ChannelDto, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    rename_channel_inner(Some(&state), &vs.conn, &vs.vault, &old_tag, &new_tag)
}

pub(crate) fn rename_channel_inner(
    state: Option<&AppState>,
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    old_tag: &str,
    new_tag: &str,
) -> Result<ChannelDto, CommandError> {
    let requested_new = normalize_collection_ref(new_tag);
    let normalized_old = normalize_collection_ref(old_tag);
    if requested_new.is_empty() {
        return Err(CommandError::Internal("new collection ref is empty".into()));
    }
    if requested_new.contains('/') {
        let old_parent = normalized_old.rsplit_once('/').map(|(parent, _)| parent);
        let new_parent = requested_new.rsplit_once('/').map(|(parent, _)| parent);
        if old_parent != new_parent {
            return Err(CommandError::Internal(
                "collection rename cannot change its folder".into(),
            ));
        }
    }
    let normalized_new = if !requested_new.contains('/') && normalized_old.contains('/') {
        let parent = normalized_old
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        format!("{parent}/{requested_new}")
    } else {
        requested_new
    };
    if normalized_new.is_empty() {
        return Err(CommandError::Internal("new collection ref is empty".into()));
    }
    validate_collection_ref(&normalized_new).map_err(CommandError::Internal)?;

    validate_collection_ref(&normalized_old).map_err(CommandError::Internal)?;
    if normalized_old == normalized_new {
        // Same tag after normalization — no-op
        let channels = index::list_channels(conn)?;
        let existing = channels
            .iter()
            .find(|c| c.tag == normalized_old)
            .ok_or_else(|| CommandError::Internal(format!("channel '{}' not found", old_tag)))?;

        let tags = index::get_all_tags(conn)?;
        let count = tags
            .iter()
            .find(|t| t.tag == normalized_old)
            .map(|t| t.count)
            .unwrap_or(0);
        return Ok(ChannelDto::from_channel(existing, count));
    }

    // Check that the new tag doesn't conflict with another channel
    let channels = index::list_channels(conn)?;
    if channels.iter().any(|c| c.tag == normalized_new) {
        return Err(CommandError::Internal(format!(
            "channel '{}' already exists",
            normalized_new
        )));
    }

    // Find the existing channel
    let existing = channels
        .iter()
        .find(|c| c.tag == normalized_old)
        .ok_or_else(|| CommandError::Internal(format!("channel '{}' not found", old_tag)))?;

    // Rename in place: a collection that lives in its own folder must stay
    // there, so the new document is written beside the old one rather than in
    // the vault root.
    let old_path = collection_document_for_mutation(conn, vault, &normalized_old)?
        .map(|page| page.path)
        .ok_or_else(|| {
            CommandError::Internal(format!("collection document '{normalized_old}' not found"))
        })?;

    let affected_blocks = index::list_blocks_by_tag(conn, &normalized_old)?;
    let mut writes = Vec::with_capacity(affected_blocks.len() + 1);
    let mut prepared_blocks = Vec::with_capacity(affected_blocks.len());
    // A page that is a member of itself changes its membership as it moves.
    let mut page_rewrite = None;
    for indexed_block in &affected_blocks {
        if indexed_block.slug.is_empty() {
            continue;
        }
        let path = vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(vault, &path)?;
        let parsed = parse_markdown_document(&indexed_block.slug, &content, file_saved_at(&path))
            .map_err(|error| CommandError::Internal(error.to_string()))?;

        // Replace old collection ref with new collection ref.
        let mut collections = parsed.block.frontmatter.tags;
        collections.retain(|t| t != &normalized_old);
        if !collections.contains(&normalized_new) {
            collections.push(normalized_new.clone());
        }
        let is_page = path == old_path;
        let rewrite =
            MembershipRewrite::prepare(vault, &indexed_block.slug, path, content, &collections)?;
        if is_page {
            page_rewrite = Some((rewrite.expected, rewrite.bytes));
            continue;
        }
        let (write, projection) = rewrite.into_source_write();
        writes.push(write);
        prepared_blocks.push(projection);
    }

    // Create new channel with same metadata
    let new_channel = Channel {
        tag: normalized_new.clone(),
        description: existing.description.clone(),
        color: existing.color.clone(),
        icon: existing.icon.clone(),
        position: existing.position,
        created_at: existing.created_at.clone(),
    };

    let new_path = old_path
        .parent()
        .map(|parent| {
            parent.join(format!(
                "{}.md",
                normalized_new.rsplit('/').next().unwrap_or(&normalized_new)
            ))
        })
        .unwrap_or_else(|| vault.block_path(&normalized_new));
    let new_slug = vault
        .slug_for_path(&new_path)
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    // The page carries no name inside it: renaming the collection is
    // renaming the file, its text and properties move unchanged.
    writes.push(match page_rewrite {
        _ if !old_path.exists() => SourceFileWrite::create(
            new_path,
            serialize_block(&channel_to_block(&new_channel)).into_bytes(),
        ),
        Some((expected, bytes)) => {
            SourceFileWrite::rename_with_bytes(old_path.clone(), new_path, expected, bytes)
        }
        None => SourceFileWrite::rename(old_path.clone(), new_path),
    });

    // Watcher suppression is only meaningful inside the app process; a CLI
    // mutation must stay visible to the app's watcher.
    if let Some(state) = state {
        state.suppress_paths(
            std::iter::once(old_path).chain(writes.iter().map(|write| write.path.clone())),
            Duration::from_millis(SOURCE_MUTATION_WATCHER_SUPPRESSION_MS),
        )?;
    }
    let staged = StagedSourceMutation::stage(writes).map_err(CommandError::from)?;
    staged
        .commit_with_index(conn, "rename_channel", |index_conn| {
            for projection in &prepared_blocks {
                projection.upsert(index_conn, vault)?;
            }
            index::upsert_channel_with_source(index_conn, &new_channel, Some(new_slug.as_str()))?;
            index::remove_channel(index_conn, &normalized_old)?;
            Ok(())
        })
        .map_err(CommandError::from)?;

    let tags = index::get_all_tags(conn)?;
    let count = tags
        .iter()
        .find(|t| t.tag == normalized_new)
        .map(|t| t.count)
        .unwrap_or(0);
    Ok(ChannelDto::from_channel(&new_channel, count))
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

/// Sidebar preview: slug + whether it's a text-only thumbnail (for dark mode invert).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PreviewItem {
    pub slug: String,
    /// True for text-only articles (baked text thumbnail needs CSS invert in dark mode).
    pub text: bool,
    /// Unix timestamp (seconds) of the thumb file's last modification.
    /// Frontend uses this as a cache-buster (`?m=<mtime>`) so the browser
    /// refetches when the file changes on disk (e.g. Phase 2 worker
    /// overwrites a PNG placeholder with a decoded JPEG).
    pub mtime: u64,
    /// True if the thumb file exists on disk. False means the block was
    /// just saved and Phase 1/2 hasn't produced a thumb yet. Frontend
    /// renders a neutral placeholder tile for `has_thumb=false` so the
    /// card never collapses to empty space. Renamed from camelCase at
    /// the serde boundary via the struct default (snake_case in JSON).
    pub has_thumb: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ChannelPreviewsSnapshot {
    pub generation: projection::ProjectionRevision,
    pub previews: HashMap<String, Vec<PreviewItem>>,
}

/// Return preview items per channel for sidebar thumbnails.
/// Includes `__all__` key for all blocks regardless of channel.
/// Max `limit` thumbnails per channel.
#[tauri::command]
pub async fn list_channel_previews(
    app: AppHandle,
    state: State<'_, AppState>,
    limit: usize,
) -> Result<ChannelPreviewsSnapshot, CommandError> {
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    tauri::async_runtime::spawn_blocking(
        move || -> Result<ChannelPreviewsSnapshot, CommandError> {
            read_owned_projection(&app, &vault, |conn| {
                Ok(projection::read_projection_snapshot(
                    conn,
                    |conn, generation| {
                        let tags = index::get_all_tags(conn)?;
                        let all_previews = index::list_preview_blocks(conn, limit)?;
                        let per_tag_previews = index::list_preview_blocks_by_tag(conn, limit)?;

                        let to_item = |preview: &index::PreviewBlock| -> PreviewItem {
                            PreviewItem {
                                slug: preview.slug.clone(),
                                // Text-ness comes from the preview manifest, not
                                // from the thumbnail's format: a transparent
                                // picture is stored as PNG as well.
                                text: preview.is_text,
                                mtime: preview.thumb_mtime,
                                has_thumb: preview.thumb_format.is_some(),
                            }
                        };

                        let mut previews = HashMap::new();
                        previews.insert(
                            "__all__".to_string(),
                            all_previews.iter().map(to_item).collect(),
                        );
                        for (tag, items) in per_tag_previews {
                            previews.insert(tag, items.iter().map(to_item).collect());
                        }
                        for tag in &tags {
                            previews.entry(tag.tag.clone()).or_default();
                        }

                        Ok(ChannelPreviewsSnapshot {
                            generation,
                            previews,
                        })
                    },
                )?)
            })
        },
    )
    .await
    .map_err(|e| CommandError::Internal(format!("list_channel_previews task join failed: {e}")))?
}

/// Delete a channel: move its page to the Trash, as it was read, and remove
/// its index entry. Blocks are not affected (tags stay in block frontmatter).
#[tauri::command]
pub fn delete_channel(state: State<'_, AppState>, tag: String) -> Result<bool, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    delete_channel_inner(&vs.conn, &vs.vault, &tag)
}

pub(crate) fn delete_channel_inner(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    tag: &str,
) -> Result<bool, CommandError> {
    ChannelDeletion::plan(conn, vault, tag)?.apply(conn)
}

/// A collection deletion, planned from the collection's page as it was read
/// (`SPEC_AUDIT_FIXES.md`, Ф2, Д2.6).
struct ChannelDeletion {
    tag: String,
    page: Option<CollectionPage>,
}

impl ChannelDeletion {
    fn plan(
        conn: &rusqlite::Connection,
        vault: &VaultLayout,
        tag: &str,
    ) -> Result<Self, CommandError> {
        let tag = normalize_collection_ref(tag);
        if tag.is_empty() {
            return Err(CommandError::Internal("collection ref is empty".into()));
        }
        validate_collection_ref(&tag).map_err(CommandError::Internal)?;
        let page = collection_document_for_mutation(conn, vault, &tag)?;
        Ok(Self { tag, page })
    }

    /// Send the page to the Trash only as the plan read it: an edit made
    /// since, in Obsidian or by iCloud, stays, and the deletion refuses with
    /// `SourceChanged`, leaving the page and the collection's record as they
    /// are.
    fn apply(self, conn: &rusqlite::Connection) -> Result<bool, CommandError> {
        let mut writes = Vec::new();
        let mut slugs = Vec::new();
        if let Some(page) = self.page {
            writes.push(SourceFileWrite::delete_if_unchanged(page.path, page.read));
            slugs.push(page.slug);
        }
        let tag = self.tag;
        let staged = StagedSourceMutation::stage(writes).map_err(CommandError::from)?;
        staged
            .commit_with_index(conn, "delete_channel", |index_conn| {
                for slug in &slugs {
                    index::remove_block(index_conn, slug)?;
                }
                let removed = index::remove_channel(index_conn, &tag)?;
                Ok(removed || !slugs.is_empty())
            })
            .map_err(CommandError::from)
    }
}

/// A collection's page as a mutation found it.
struct CollectionPage {
    path: std::path::PathBuf,
    slug: String,
    /// The bytes read and found to be a collection page.
    read: Vec<u8>,
}

/// Resolve a collection mutation to one source page. A bare name shared by
/// multiple collection pages is ambiguous and must not mutate either page.
fn collection_document_for_mutation(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    collection_ref: &str,
) -> Result<Option<CollectionPage>, CommandError> {
    let candidates =
        crate::storage::media_refs::collection_document_candidates(vault, collection_ref).map_err(
            |error| CommandError::Internal(format!("find collection documents: {error}")),
        )?;
    let fallback_date = DateTime::new(&crate::commands::state::now_saved_at())
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    let mut pages = Vec::new();
    for path in candidates {
        let (slug, content) = files::read_block_file(vault, &path)?;
        let parsed = parse_markdown_document(&slug, &content, fallback_date.clone())
            .map_err(|error| CommandError::Internal(error.to_string()))?;
        if parsed.block.frontmatter.block_type == BlockType::Channel {
            pages.push(CollectionPage {
                path,
                slug,
                read: content.into_bytes(),
            });
        }
    }
    if let Some(source_slug) = index::channel_source_slug(conn, collection_ref)? {
        if let Some(position) = pages.iter().position(|page| page.slug == source_slug) {
            return Ok(Some(pages.swap_remove(position)));
        }
    }
    let page_count = pages.len();
    let mut slugs: std::collections::BTreeSet<String> =
        pages.iter().map(|page| page.slug.clone()).collect();
    for path in files::scan_vault_file_paths(vault)? {
        if let Some(slug) = path.strip_suffix(".md") {
            slugs.insert(slug.to_string());
        }
    }
    let mut matches = pages.into_iter().filter(|page| {
        crate::domain::collection::collection_ref_for_slug(&page.slug, &slugs) == collection_ref
    });
    let result = matches.next();
    if matches.next().is_some()
        || (result.is_none() && page_count > 1 && !collection_ref.contains('/'))
    {
        return Err(CommandError::Internal(format!(
            "collection reference '{collection_ref}' is ambiguous; use its path"
        )));
    }
    Ok(result)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Convert a Channel to a Block with type: channel for writing to .md file.
fn channel_to_block(channel: &Channel) -> Block {
    Block {
        slug: channel.tag.clone(),
        frontmatter: Frontmatter {
            block_type: BlockType::Channel,
            title: None,
            description: channel.description.clone(),
            url: None,
            file: None,
            thumbnail: None,
            tags: Vec::new(),
            related_notes: Vec::new(),
            source_media: None,
            saved_at: channel.created_at.clone(),
            source: None,
            width: None,
            height: None,
            author: None,
            position: Some(channel.position),
            color: channel.color.clone(),
            icon: channel.icon.clone(),
        },
        body: String::new(),
    }
}

fn load_channels(conn: &rusqlite::Connection) -> anyhow::Result<Vec<ChannelDto>> {
    let channels = index::list_channels(conn)?;
    let tags = index::get_all_tags(conn)?;
    let tag_counts: HashMap<String, usize> =
        tags.into_iter().map(|tag| (tag.tag, tag.count)).collect();

    Ok(channels
        .iter()
        .map(|ch| {
            let count = tag_counts.get(&ch.tag).copied().unwrap_or(0);
            ChannelDto::from_channel(ch, count)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reorder_writes_only_the_collections_that_moved() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::with_derived_root(dir.path().join("space"), dir.path().join("derived"))
            .with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        std::fs::create_dir_all(vault.root().join("Collections")).unwrap();
        for (name, position) in [("Art", 0), ("Cities", 1), ("Games", 2)] {
            std::fs::write(
                vault.block_path(&format!("Collections/{name}")),
                format!("---\ntype: channel\nposition: {position}\nsaved_at: 2026-04-25T14:00:40Z\n---\n"),
            )
            .unwrap();
        }
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let state = AppState::new();
        *state.vault_state.lock().unwrap() = Some(crate::commands::state::VaultState {
            conn,
            vault: vault.clone(),
        });
        let art_before = std::fs::read(vault.block_path("Collections/Art")).unwrap();

        // Games moves above Cities; Art keeps its place.
        reorder_channels_blocking(
            &state,
            vec![
                ReorderItem { tag: "Art".into(), position: 0 },
                ReorderItem { tag: "Games".into(), position: 1 },
                ReorderItem { tag: "Cities".into(), position: 2 },
            ],
        )
        .unwrap();

        assert_eq!(std::fs::read(vault.block_path("Collections/Art")).unwrap(), art_before);
        let games = std::fs::read_to_string(vault.block_path("Collections/Games")).unwrap();
        assert!(games.contains("position: 1"), "{games}");
        let cities = std::fs::read_to_string(vault.block_path("Collections/Cities")).unwrap();
        assert!(cities.contains("position: 2"), "{cities}");
    }

    #[test]
    fn new_collection_uses_layout_despite_legacy_root_collection() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf()).with_write_layout(
            crate::domain::vault::VaultWriteLayout {
                cards: "Notes".into(),
                media: "Assets".into(),
                collections: "Groups/Sets".into(),
            },
        );
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let legacy = "---\ntype: channel\nsaved_at: 2026-04-25T14:00:40Z\n---\n";
        std::fs::write(vault.block_path("Legacy"), legacy).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        create_channel_inner(&conn, &vault, "New").unwrap();
        assert!(vault.block_path("Groups/Sets/New").exists());
        assert!(!vault.block_path("New").exists());
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Legacy")).unwrap(),
            legacy
        );
    }

    #[test]
    fn collection_delete_requires_exact_ref_when_pages_share_a_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Collections")).unwrap();
        std::fs::create_dir_all(dir.path().join("Cards")).unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let channel = "---\ntype: channel\nsaved_at: 2026-04-25T14:00:40Z\n---\n";
        let article = "---\ntype: article\nsaved_at: 2026-04-25T14:00:40Z\n---\nKeep this note";
        for name in ["Design", "Collections/Design"] {
            std::fs::write(vault.block_path(name), channel).unwrap();
        }
        std::fs::write(vault.block_path("Cards/Design"), article).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();

        assert!(delete_channel_inner(&conn, &vault, "Design").unwrap());
        assert!(!vault.block_path("Design").exists());
        assert!(vault.block_path("Collections/Design").exists());
        assert!(delete_channel_inner(&conn, &vault, "Collections/Design").unwrap());
        assert!(!vault.block_path("Collections/Design").exists());
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Cards/Design")).unwrap(),
            article
        );
        for _ in 0..2 {
            crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
            assert!(index::list_channels(&conn).unwrap().is_empty());
        }
        assert!(!delete_channel_inner(&conn, &vault, "Design").unwrap());
    }

    /// Д2.6: the page is edited after the deletion read it. The edit is not
    /// sent to the Trash: the deletion refuses, the page stays as edited and
    /// the collection stays listed.
    #[test]
    fn deleting_a_collection_refuses_when_its_page_changed_after_it_was_read() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        let deletion = ChannelDeletion::plan(&conn, &vault, "Photos").unwrap();
        let edited = WRITTEN_PAGE.replace("Why I keep these.", "Why I keep these, edited in Obsidian.");
        std::fs::write(vault.block_path("Collections/Photos"), &edited).unwrap();

        let refused = deletion.apply(&conn);

        assert!(matches!(refused, Err(CommandError::SourceChanged { .. })), "{refused:?}");
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Collections/Photos")).unwrap(),
            edited
        );
        let listed: Vec<String> = index::list_channels(&conn)
            .unwrap()
            .into_iter()
            .map(|channel| channel.tag)
            .collect();
        assert_eq!(listed, ["Photos"]);
    }

    #[test]
    fn ambiguous_short_ref_never_deletes_nested_collection_pages() {
        let dir = tempfile::tempdir().unwrap();
        for folder in ["A", "B"] {
            std::fs::create_dir_all(dir.path().join(folder)).unwrap();
            std::fs::write(
                dir.path().join(folder).join("Design.md"),
                "---\ntype: channel\nsaved_at: 2026-04-25T14:00:40Z\n---\n",
            )
            .unwrap();
        }
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        assert!(delete_channel_inner(&conn, &vault, "Design").is_err());
        assert!(vault.block_path("A/Design").exists());
        assert!(vault.block_path("B/Design").exists());
    }

    #[test]
    fn collection_sync_never_materializes_a_root_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Collections")).unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        std::fs::write(
            vault.block_path("Collections/Design"),
            "---\ntype: channel\nsaved_at: 2026-04-25T14:00:40Z\n---\n",
        )
        .unwrap();
        for _ in 0..2 {
            crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
            assert!(!vault.block_path("Design").exists());
            assert_eq!(index::list_channels(&conn).unwrap().len(), 1);
        }
        std::fs::remove_file(vault.block_path("Collections/Design")).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert!(index::list_channels(&conn).unwrap().is_empty());
        assert!(!vault.block_path("Design").exists());
    }

    #[test]
    fn channel_page_rename_never_overwrites_disk_only_target() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("Old.md");
        let new_path = dir.path().join("New.md");
        std::fs::write(&old_path, b"old page").unwrap();
        std::fs::write(&new_path, b"disk-only target").unwrap();

        let result = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old_path.clone(),
            new_path.clone(),
            b"old page".to_vec(),
            b"new page".to_vec(),
        )]);

        assert!(result.is_err());
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old page");
        assert_eq!(std::fs::read(&new_path).unwrap(), b"disk-only target");
    }

    #[test]
    fn channel_page_rename_can_be_rolled_back_after_index_failure() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("Old.md");
        let new_path = dir.path().join("New.md");
        std::fs::write(&old_path, b"old page").unwrap();

        let staged = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old_path.clone(),
            new_path.clone(),
            b"old page".to_vec(),
            b"new page".to_vec(),
        )])
        .unwrap();
        staged
            .commit()
            .unwrap()
            .rollback("injected index failure")
            .unwrap();

        assert_eq!(std::fs::read(&old_path).unwrap(), b"old page");
        assert!(!new_path.exists());
    }

    fn standard_space(dir: &std::path::Path) -> VaultLayout {
        let vault = VaultLayout::with_derived_root(dir.join("space"), dir.join("derived"))
            .with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        std::fs::create_dir_all(vault.root().join("Collections")).unwrap();
        std::fs::create_dir_all(vault.root().join("Cards")).unwrap();
        vault
    }

    fn app_state(vault: &VaultLayout) -> AppState {
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        crate::storage::reconcile::reconcile_vault(&conn, vault).unwrap();
        let state = AppState::new();
        *state.vault_state.lock().unwrap() = Some(crate::commands::state::VaultState {
            conn,
            vault: vault.clone(),
        });
        state
    }

    /// A collection page the user wrote into: text, own properties, a
    /// comment, blank lines, and its own membership in another collection.
    const WRITTEN_PAGE: &str = "---\ntype: channel\n# my note on this collection\naliases:\n  - Pics\nMine Collections:\n  - \"[[Archive]]\"\n\nposition: 0\nsaved_at: 2026-04-25T14:00:40Z\n---\n# Photos\n\nWhy I keep these.\n\n\n\nEnd.\n";

    #[test]
    fn a_reorder_changes_only_the_position_of_a_written_page() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        std::fs::write(
            vault.block_path("Collections/Art"),
            "---\ntype: channel\nposition: 1\nsaved_at: 2026-04-25T14:00:40Z\n---\n",
        )
        .unwrap();
        let state = app_state(&vault);

        reorder_channels_blocking(
            &state,
            vec![
                ReorderItem { tag: "Art".into(), position: 0 },
                ReorderItem { tag: "Photos".into(), position: 1 },
            ],
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(vault.block_path("Collections/Photos")).unwrap(),
            WRITTEN_PAGE.replace("position: 0", "position: 1")
        );
    }

    #[test]
    fn a_rename_moves_a_written_page_unchanged_and_updates_member_cards() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let card = "---\naliases:\n  - Sunset\n# kept\nMine Collections:\n  - \"[[Photos]]\"\n\nrating: 5\nsaved_at: 2026-04-25T14:00:40Z\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Sunset"), card).unwrap();
        let state = app_state(&vault);
        let guard = state.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", "Pictures").unwrap();

        assert!(!vault.block_path("Collections/Photos").exists());
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Collections/Pictures")).unwrap(),
            WRITTEN_PAGE
        );
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Cards/Sunset")).unwrap(),
            card.replace("[[Photos]]", "[[Pictures]]")
        );
    }

    /// Г1.5: a member card whose properties are a flow mapping is renamed
    /// inside the braces and indexed as the file reads.
    #[test]
    fn a_rename_keeps_a_flow_mapping_card_valid() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let card = "---\n{aliases: [Sunset], Mine Collections: [\"[[Photos]]\"], saved_at: 2026-04-25T14:00:40Z}\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Sunset"), card).unwrap();
        let state = app_state(&vault);
        let guard = state.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", "Pictures").unwrap();

        let written = std::fs::read_to_string(vault.block_path("Cards/Sunset")).unwrap();
        assert_eq!(written, card.replace("[[Photos]]", "[[Pictures]]"));
        let fallback = DateTime::new("2026-01-01").unwrap();
        let read = parse_markdown_document("Cards/Sunset", &written, fallback).unwrap();
        assert_eq!(read.origin, "partial_frontmatter");
        assert_eq!(read.block.frontmatter.tags, vec!["Pictures"]);
        assert_eq!(
            index::get_block(&vs.conn, "Cards/Sunset").unwrap().unwrap().tags,
            vec!["Pictures"]
        );
    }

    /// Г1.5: a member card whose properties cannot take the rename refuses
    /// the whole rename: no card, no page moves.
    #[test]
    fn a_rename_with_an_unwritable_member_card_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let vault = standard_space(dir.path());
        std::fs::write(vault.block_path("Collections/Photos"), WRITTEN_PAGE).unwrap();
        let card = "---\n  Mine Collections: [\"[[Photos]]\"]\n  saved_at: 2026-04-25T14:00:40Z\n---\nBody\n";
        std::fs::write(vault.block_path("Cards/Sunset"), card).unwrap();
        let state = app_state(&vault);
        let guard = state.vault_state.lock().unwrap();
        let vs = guard.as_ref().unwrap();

        let refused = rename_channel_inner(None, &vs.conn, &vs.vault, "Photos", "Pictures");

        assert!(
            matches!(refused, Err(CommandError::FrontmatterNotWritable { .. })),
            "{refused:?}"
        );
        assert_eq!(std::fs::read_to_string(vault.block_path("Cards/Sunset")).unwrap(), card);
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Collections/Photos")).unwrap(),
            WRITTEN_PAGE
        );
        assert!(!vault.block_path("Collections/Pictures").exists());
    }
}
