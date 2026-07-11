// Channel commands: list, create, delete channels.
//
// Contract: SPEC_INTEGRATION.md#commands/channels

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, ensure_vault_fresh, AppState, CommandError};
use crate::commands::tags::patch_collections_frontmatter;
use crate::domain::block::{
    parse_markdown_document, serialize_block, Block, BlockType, DateTime, Frontmatter,
};
use crate::domain::channel::Channel;
use crate::domain::collection::{normalize_collection_ref, validate_collection_ref};
use crate::storage::source_mutation::{SourceFileWrite, SourceMutationError, StagedSourceMutation};
use crate::storage::{db, files, index};
use crate::util::append_startup_trace;

const SOURCE_MUTATION_WATCHER_SUPPRESSION_MS: u64 = 1500;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Serializable channel data for the frontend.
#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
pub struct TaxonomySnapshot {
    pub tags: Vec<index::TagCount>,
    pub channels: Vec<ChannelDto>,
    pub total_blocks: usize,
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
    let db_path = vault.index_db_path();
    let dtos =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ChannelDto>, CommandError> {
            let conn = db::open_read_only(&db_path)?;
            Ok(load_channels(&conn)?)
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
    let db_path = vault.index_db_path();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || -> Result<TaxonomySnapshot, CommandError> {
            let conn = db::open_read_only(&db_path)?;
            Ok(TaxonomySnapshot {
                tags: index::get_all_tags(&conn)?,
                channels: load_channels(&conn)?,
                total_blocks: index::count_grid_blocks(&conn)?,
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

    let now = crate::commands::state::now_iso8601();
    let dt = DateTime::new(&now).map_err(|e| CommandError::Internal(e.to_string()))?;

    let tag = validate_collection_ref(&tag).map_err(CommandError::Internal)?;
    let mut channel = Channel::new(&tag, dt).map_err(|e| CommandError::Internal(e.to_string()))?;

    // Check uniqueness after collection-ref normalization
    let existing = index::list_channels(&vs.conn)?;
    if existing.iter().any(|c| c.tag == channel.tag) {
        return Err(CommandError::Internal(format!(
            "channel '{}' already exists",
            channel.tag
        )));
    }
    channel.position = index::next_channel_position(&vs.conn)?;

    let block = channel_to_block(&channel);
    let path = vs.vault.block_path(&channel.tag);
    let staged = StagedSourceMutation::stage(vec![SourceFileWrite::create(
        path,
        serialize_block(&block).into_bytes(),
    )])
    .map_err(source_mutation_command_error)?;
    staged
        .commit_with_index(&vs.conn, "create_channel", |index_conn| {
            index::upsert_channel(index_conn, &channel)
        })
        .map_err(source_mutation_command_error)?;

    // Get block count for this tag
    let tags = index::get_all_tags(&vs.conn)?;
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
#[tauri::command]
pub fn reorder_channels(
    state: State<'_, AppState>,
    items: Vec<ReorderItem>,
) -> Result<(), CommandError> {
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
    let now = crate::commands::state::now_iso8601();
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
        let mut channel = if let Some(existing) = existing_by_tag.get(&tag) {
            existing.clone()
        } else {
            let dt = DateTime::new(&now).map_err(|e| CommandError::Internal(e.to_string()))?;
            Channel::new(&tag, dt).map_err(|e| CommandError::Internal(e.to_string()))?
        };
        channel.position = item.position;
        let path = vs.vault.block_path(&tag);
        let bytes = serialize_block(&channel_to_block(&channel)).into_bytes();
        writes.push(if path.exists() {
            SourceFileWrite::replace(path, bytes)
        } else {
            SourceFileWrite::create(path, bytes)
        });
        planned_channels.push(channel);
    }

    let staged = StagedSourceMutation::stage(writes).map_err(source_mutation_command_error)?;
    staged
        .commit_with_index(&vs.conn, "reorder_channels", |index_conn| {
            for channel in &planned_channels {
                index::upsert_channel(index_conn, channel)?;
            }
            Ok(())
        })
        .map_err(source_mutation_command_error)?;
    Ok(())
}

fn source_mutation_command_error(error: SourceMutationError) -> CommandError {
    CommandError::Internal(error.to_string())
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

    let normalized_new = normalize_collection_ref(&new_tag);
    if normalized_new.is_empty() {
        return Err(CommandError::Internal("new collection ref is empty".into()));
    }
    validate_collection_ref(&normalized_new).map_err(CommandError::Internal)?;

    let normalized_old = normalize_collection_ref(&old_tag);
    validate_collection_ref(&normalized_old).map_err(CommandError::Internal)?;
    if normalized_old == normalized_new {
        // Same tag after normalization — no-op
        let channels = index::list_channels(&vs.conn)?;
        let existing = channels
            .iter()
            .find(|c| c.tag == normalized_old)
            .ok_or_else(|| CommandError::Internal(format!("channel '{}' not found", old_tag)))?;

        let tags = index::get_all_tags(&vs.conn)?;
        let count = tags
            .iter()
            .find(|t| t.tag == normalized_old)
            .map(|t| t.count)
            .unwrap_or(0);
        return Ok(ChannelDto::from_channel(existing, count));
    }

    // Check that the new tag doesn't conflict with another channel
    let channels = index::list_channels(&vs.conn)?;
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

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized_old)?;
    let mut writes = Vec::with_capacity(affected_blocks.len() + 1);
    let mut prepared_blocks = Vec::with_capacity(affected_blocks.len());
    for indexed_block in &affected_blocks {
        if indexed_block.slug.is_empty() {
            continue;
        }
        let path = vs.vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(&vs.vault, &path)?;
        let parsed = parse_markdown_document(&indexed_block.slug, &content, file_saved_at(&path))
            .map_err(|error| CommandError::Internal(error.to_string()))?;
        let mut block = parsed.block;

        // Replace old collection ref with new collection ref.
        block.frontmatter.tags.retain(|t| t != &normalized_old);
        if !block.frontmatter.tags.contains(&normalized_new) {
            block.frontmatter.tags.push(normalized_new.clone());
        }
        files::normalize_block_media_refs_for_index(&vs.vault, &mut block);

        let serialized = patch_collections_frontmatter(&content, &block.frontmatter.tags)
            .map_err(CommandError::Internal)?;
        writes.push(SourceFileWrite::replace(path, serialized.into_bytes()));
        prepared_blocks.push((block, parsed.origin, parsed.index_warning));
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

    let new_block = channel_to_block(&new_channel);
    let old_path = vs.vault.block_path(&normalized_old);
    let new_path = vs.vault.block_path(&normalized_new);
    let page_bytes = serialize_block(&new_block).into_bytes();
    writes.push(if old_path.exists() {
        SourceFileWrite::rename_with_bytes(old_path.clone(), new_path, page_bytes)
    } else {
        SourceFileWrite::create(new_path, page_bytes)
    });

    state.suppress_paths(
        std::iter::once(old_path).chain(writes.iter().map(|write| write.path.clone())),
        Duration::from_millis(SOURCE_MUTATION_WATCHER_SUPPRESSION_MS),
    )?;
    let staged = StagedSourceMutation::stage(writes).map_err(source_mutation_command_error)?;
    staged
        .commit_with_index(&vs.conn, "rename_channel", |index_conn| {
            for (block, origin, index_warning) in &prepared_blocks {
                index::upsert_block_with_diagnostics(
                    index_conn,
                    block,
                    Some(vs.vault.root()),
                    Some(origin.as_str()),
                    index_warning.as_deref(),
                )?;
            }
            index::upsert_channel(index_conn, &new_channel)?;
            index::remove_channel(index_conn, &normalized_old)?;
            Ok(())
        })
        .map_err(source_mutation_command_error)?;

    let tags = index::get_all_tags(&vs.conn)?;
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
#[derive(Debug, Clone, Serialize)]
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

/// Return preview items per channel for sidebar thumbnails.
/// Includes `__all__` key for all blocks regardless of channel.
/// Max `limit` thumbnails per channel.
#[tauri::command]
pub async fn list_channel_previews(
    app: AppHandle,
    state: State<'_, AppState>,
    limit: usize,
) -> Result<HashMap<String, Vec<PreviewItem>>, CommandError> {
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let db_path = vault.index_db_path();
    tauri::async_runtime::spawn_blocking(
        move || -> Result<HashMap<String, Vec<PreviewItem>>, CommandError> {
            let conn = db::open_read_only(&db_path)?;
            let tags = index::get_all_tags(&conn)?;
            let all_previews = index::list_preview_blocks(&conn, limit)?;
            let per_tag_previews = index::list_preview_blocks_by_tag(&conn, limit)?;

            let to_item = |preview: &index::PreviewBlock| -> PreviewItem {
                PreviewItem {
                    slug: preview.slug.clone(),
                    text: preview.thumb_format == Some(index::ThumbFormat::Png),
                    mtime: preview.thumb_mtime,
                    has_thumb: preview.thumb_format.is_some(),
                }
            };

            let mut result = HashMap::new();
            let all_items: Vec<PreviewItem> = all_previews.iter().map(to_item).collect();
            result.insert("__all__".to_string(), all_items);

            for (tag, previews) in per_tag_previews {
                let items: Vec<PreviewItem> = previews.iter().map(to_item).collect();
                result.insert(tag, items);
            }

            for tag in &tags {
                result.entry(tag.tag.clone()).or_insert_with(Vec::new);
            }

            Ok(result)
        },
    )
    .await
    .map_err(|e| CommandError::Internal(format!("list_channel_previews task join failed: {e}")))?
}

/// Delete a channel: remove .md file and index entry.
/// Blocks are not affected (tags stay in block frontmatter).
#[tauri::command]
pub fn delete_channel(state: State<'_, AppState>, tag: String) -> Result<bool, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let tag = normalize_collection_ref(&tag);
    if tag.is_empty() {
        return Err(CommandError::Internal("collection ref is empty".into()));
    }
    validate_collection_ref(&tag).map_err(CommandError::Internal)?;

    let md_path = vs.vault.block_path(&tag);
    let writes = if md_path.exists() {
        vec![SourceFileWrite::delete(md_path)]
    } else {
        Vec::new()
    };
    let staged = StagedSourceMutation::stage(writes).map_err(source_mutation_command_error)?;
    staged
        .commit_with_index(&vs.conn, "delete_channel", |index_conn| {
            index::remove_channel(index_conn, &tag)
        })
        .map_err(source_mutation_command_error)
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
    fn channel_page_rename_never_overwrites_disk_only_target() {
        let dir = tempfile::tempdir().unwrap();
        let old_path = dir.path().join("Old.md");
        let new_path = dir.path().join("New.md");
        std::fs::write(&old_path, b"old page").unwrap();
        std::fs::write(&new_path, b"disk-only target").unwrap();

        let result = StagedSourceMutation::stage(vec![SourceFileWrite::rename_with_bytes(
            old_path.clone(),
            new_path.clone(),
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
}
