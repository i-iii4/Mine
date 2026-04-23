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
use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
use crate::domain::markdown::{rename_inline_media_references, rename_wikilink_targets};
use crate::domain::vault::{normalize_filename_stem, validate_slug, VaultLayout};
use crate::storage::index::IndexedBlock;
use crate::storage::{article_audio, db, files, index};
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

    rename_block_file_inner(Some(&app), &state, &vs.conn, &vs.vault, &old_slug, &new_stem)
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

    if vault.block_path(&new_slug).exists() || index::slug_exists(conn, &new_slug).map_err(internal_rename_error)? {
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
        .unwrap_or_else(|| rewrite_block_for_rename(&old_block, old_slug, &new_slug, &BTreeMap::new()));

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
        std::fs::rename(&rename.from, &rename.to).with_context(|| {
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
        std::fs::write(&write.target_path, serialized).with_context(|| {
            format!("failed to write updated block file: {}", write.target_path.display())
        })
        .map_err(internal_rename_error)?;
    }

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(internal_sqlite_rename_error)?;
    let db_result = (|| -> anyhow::Result<()> {
        let renamed = index::rename_slug(conn, old_slug, &new_slug)?;
        if !renamed {
            bail!("source slug '{}' missing from index during rename", old_slug);
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
    rewritten.frontmatter.file = rewrite_owned_filename_field(
        rewritten.frontmatter.file.as_deref(),
        media_name_map,
    );
    rewritten.frontmatter.thumbnail = rewrite_owned_filename_field(
        rewritten.frontmatter.thumbnail.as_deref(),
        media_name_map,
    );
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
            return Err(RenameBlockError::NameTaken { requested: new_name });
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

fn generated_inline_target(name: &str, old_slug: &str, new_slug: &str, kind: &str) -> Option<String> {
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

    fn make_vault() -> (tempfile::TempDir, tempfile::TempDir, VaultLayout, rusqlite::Connection) {
        let root = tempfile::tempdir().unwrap();
        let derived = tempfile::tempdir().unwrap();
        let vault = VaultLayout::with_derived_root(
            root.path().to_path_buf(),
            derived.path().to_path_buf(),
        );
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
    fn rename_block_file_rewrites_links_and_inline_media() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();

        let original = article("Old Name", "Intro\n\n![[Old Name (image 1).jpg]]");
        let reference = article("Reference Note", "See [[Old Name]].");
        persist_block(&conn, &vault, &original);
        persist_block(&conn, &vault, &reference);

        std::fs::write(vault.root().join("Old Name (image 1).jpg"), b"img").unwrap();

        let result = rename_block_file_inner(
            None,
            &state,
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

        let (_, renamed_content) = files::read_block_file(&vault.block_path("Renamed Name")).unwrap();
        let renamed = crate::domain::block::parse_block("Renamed Name", &renamed_content).unwrap();
        assert_eq!(renamed.frontmatter.title.as_deref(), Some("Renamed Name"));
        assert!(renamed.body.contains("![[Renamed Name (image 1).jpg]]"));

        let (_, ref_content) = files::read_block_file(&vault.block_path("Reference Note")).unwrap();
        let ref_block = crate::domain::block::parse_block("Reference Note", &ref_content).unwrap();
        assert!(ref_block.body.contains("[[Renamed Name]]"));

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

        rename_block_file_inner(None, &state, &conn, &vault, "Old Name", "Renamed Name")
            .unwrap();

        let (_, renamed_content) = files::read_block_file(&vault.block_path("Renamed Name")).unwrap();
        let renamed = crate::domain::block::parse_block("Renamed Name", &renamed_content).unwrap();
        let prepared = prepare_article_speech(&renamed).unwrap();
        let audio_state =
            article_audio_storage::resolve_state_for_prepared(&vault, "Renamed Name", &prepared)
                .unwrap();
        assert_eq!(audio_state.status, article_audio_storage::ArticleAudioStatus::Absent);
        assert!(audio_state.audio_path.is_none());
        assert!(!vault.article_audio_asset_path("Renamed Name", "wav").exists());
        assert!(!vault.article_audio_state_path("Renamed Name").exists());
    }

    #[test]
    fn rename_block_file_leaves_custom_media_filenames_untouched() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();

        let original = image("Old Name", "custom-cover.jpg");
        persist_block(&conn, &vault, &original);
        std::fs::write(vault.root().join("custom-cover.jpg"), b"img").unwrap();

        rename_block_file_inner(None, &state, &conn, &vault, "Old Name", "Renamed Name")
            .unwrap();

        let (_, content) = files::read_block_file(&vault.block_path("Renamed Name")).unwrap();
        let renamed = crate::domain::block::parse_block("Renamed Name", &content).unwrap();
        assert_eq!(renamed.frontmatter.file.as_deref(), Some("custom-cover.jpg"));
        assert!(vault.root().join("custom-cover.jpg").exists());
    }

    #[test]
    fn rename_block_file_rejects_taken_name() {
        let (_root, _derived, vault, conn) = make_vault();
        let state = AppState::new();

        persist_block(&conn, &vault, &article("One", "Body"));
        persist_block(&conn, &vault, &article("Taken", "Other"));

        let err = rename_block_file_inner(None, &state, &conn, &vault, "One", "Taken")
            .unwrap_err();
        assert!(matches!(err, RenameBlockError::NameTaken { .. }));
    }

    #[test]
    fn normalize_requested_stem_rejects_path_traversal() {
        let err = normalize_requested_stem("../escape").unwrap_err();
        assert!(matches!(err, RenameBlockError::InvalidFilename { .. }));
    }
}
