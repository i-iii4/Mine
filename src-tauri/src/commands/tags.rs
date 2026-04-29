// Tag commands: list tags, add/remove tag from block.
//
// Contract: SPEC_INTEGRATION.md#commands/tags

use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, AppState, CommandError};
use crate::domain::block::{parse_markdown_document, DateTime};
use crate::domain::collection::normalize_collection_ref;
use crate::storage::index::TagCount;
use crate::storage::{db, files, index};
use crate::util::append_startup_trace;

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all tags with their block counts.
#[tauri::command]
pub async fn list_tags(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TagCount>, CommandError> {
    append_startup_trace(&app, "list_tags", "start");
    let db_path = current_vault_layout(&state)?.index_db_path();
    let tags =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TagCount>, CommandError> {
            let conn = db::open_read_only(&db_path)?;
            Ok(index::get_all_tags(&conn)?)
        })
        .await
        .map_err(|e| CommandError::Internal(format!("list_tags task join failed: {e}")))??;
    append_startup_trace(&app, "list_tags", &format!("done count={}", tags.len()));
    Ok(tags)
}

/// Add a tag to a block: read .md, update frontmatter, write back, re-index.
#[tauri::command]
pub fn add_tag(state: State<'_, AppState>, slug: String, tag: String) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let path = vs.vault.block_path(&slug);
    let (_, content) = files::read_block_file(&vs.vault, &path)?;
    let parsed = parse_markdown_document(&slug, &content, file_saved_at(&path))
        .map_err(|e| CommandError::Internal(e.to_string()))?;
    let mut block = parsed.block;

    let collection_ref = normalize_collection_ref(&tag);
    if collection_ref.is_empty() {
        return Err(CommandError::Internal(
            "collection ref is empty".to_string(),
        ));
    }

    if !block.frontmatter.tags.contains(&collection_ref) {
        block.frontmatter.tags.push(collection_ref);
    }
    files::normalize_block_media_refs_for_index(&vs.vault, &mut block);

    let content = patch_collections_frontmatter(&content, &block.frontmatter.tags)
        .map_err(CommandError::Internal)?;
    std::fs::write(&path, content)
        .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
    index::upsert_block_with_diagnostics(
        &vs.conn,
        &block,
        Some(vs.vault.root()),
        Some(parsed.origin.as_str()),
        parsed.index_warning.as_deref(),
    )?;

    Ok(())
}

/// Remove a tag from a block: read .md, update frontmatter, write back, re-index.
#[tauri::command]
pub fn remove_tag(
    state: State<'_, AppState>,
    slug: String,
    tag: String,
) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let path = vs.vault.block_path(&slug);
    let (_, content) = files::read_block_file(&vs.vault, &path)?;
    let parsed = parse_markdown_document(&slug, &content, file_saved_at(&path))
        .map_err(|e| CommandError::Internal(e.to_string()))?;
    let mut block = parsed.block;

    let collection_ref = normalize_collection_ref(&tag);
    block.frontmatter.tags.retain(|t| t != &collection_ref);
    files::normalize_block_media_refs_for_index(&vs.vault, &mut block);

    let content = patch_collections_frontmatter(&content, &block.frontmatter.tags)
        .map_err(CommandError::Internal)?;
    std::fs::write(&path, content)
        .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
    index::upsert_block_with_diagnostics(
        &vs.conn,
        &block,
        Some(vs.vault.root()),
        Some(parsed.origin.as_str()),
        parsed.index_warning.as_deref(),
    )?;

    Ok(())
}

/// Rename a tag in ALL blocks: find blocks with old_tag, replace with new_tag
/// in frontmatter, write back, re-index.
#[tauri::command(rename_all = "snake_case")]
pub fn rename_tag(
    state: State<'_, AppState>,
    old_tag: String,
    new_tag: String,
) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let normalized_old = normalize_collection_ref(&old_tag);
    let normalized_new = normalize_collection_ref(&new_tag);

    if normalized_new.is_empty() {
        return Err(CommandError::Internal("new collection ref is empty".into()));
    }
    if normalized_old == normalized_new {
        return Ok(());
    }

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized_old)?;
    for indexed_block in &affected_blocks {
        let path = vs.vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(&vs.vault, &path)?;
        let parsed = parse_markdown_document(&indexed_block.slug, &content, file_saved_at(&path))
            .map_err(|e| CommandError::Internal(e.to_string()))?;
        let mut block = parsed.block;

        block.frontmatter.tags.retain(|t| t != &normalized_old);
        if !block.frontmatter.tags.contains(&normalized_new) {
            block.frontmatter.tags.push(normalized_new.clone());
        }
        files::normalize_block_media_refs_for_index(&vs.vault, &mut block);

        let serialized = patch_collections_frontmatter(&content, &block.frontmatter.tags)
            .map_err(CommandError::Internal)?;
        std::fs::write(&path, serialized)
            .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
        index::upsert_block_with_diagnostics(
            &vs.conn,
            &block,
            Some(vs.vault.root()),
            Some(parsed.origin.as_str()),
            parsed.index_warning.as_deref(),
        )?;
    }

    Ok(())
}

/// Delete a tag from ALL blocks: find blocks with tag, remove it from
/// frontmatter, write back, re-index.
#[tauri::command]
pub fn delete_tag_from_all(state: State<'_, AppState>, tag: String) -> Result<(), CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let normalized = normalize_collection_ref(&tag);
    if normalized.is_empty() {
        return Ok(());
    }

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized)?;
    for indexed_block in &affected_blocks {
        let path = vs.vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(&vs.vault, &path)?;
        let parsed = parse_markdown_document(&indexed_block.slug, &content, file_saved_at(&path))
            .map_err(|e| CommandError::Internal(e.to_string()))?;
        let mut block = parsed.block;

        block.frontmatter.tags.retain(|t| t != &normalized);
        files::normalize_block_media_refs_for_index(&vs.vault, &mut block);

        let serialized = patch_collections_frontmatter(&content, &block.frontmatter.tags)
            .map_err(CommandError::Internal)?;
        std::fs::write(&path, serialized)
            .map_err(|e| CommandError::Internal(format!("failed to write: {}", e)))?;
        index::upsert_block_with_diagnostics(
            &vs.conn,
            &block,
            Some(vs.vault.root()),
            Some(parsed.origin.as_str()),
            parsed.index_warning.as_deref(),
        )?;
    }

    Ok(())
}

fn file_saved_at(path: &std::path::Path) -> DateTime {
    let time = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().ok().or_else(|| metadata.modified().ok()))
        .unwrap_or_else(std::time::SystemTime::now);
    DateTime::new(&crate::util::system_time_to_iso8601(time))
        .unwrap_or_else(|_| DateTime::new("1970-01-01T00:00:00Z").unwrap())
}

pub(crate) fn patch_collections_frontmatter(
    content: &str,
    collections: &[String],
) -> Result<String, String> {
    crate::domain::collection::patch_collections_frontmatter(content, collections)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_collections_frontmatter_inserts_minimal_frontmatter_for_foreign_markdown() {
        let input = "# Note\n\nBody";
        let output = patch_collections_frontmatter(input, &["design".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\nMine Collections:\n  - \"[[design]]\"\n---\n# Note\n\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_preserves_unknown_fields_and_obsidian_tags() {
        let input = "---\naliases:\n  - A\n# keep me\ntags:\n  - old\ncssclasses: wide\n---\nBody";
        let output =
            patch_collections_frontmatter(input, &["design/typography".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\naliases:\n  - A\n# keep me\ntags:\n  - old\ncssclasses: wide\nMine Collections:\n  - \"[[design/typography]]\"\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_preserves_scalar_obsidian_tags() {
        let input = "---\ntype: meeting\ntags: \"design typography\"\n---\nBody";
        let output = patch_collections_frontmatter(
            input,
            &[
                "design".to_string(),
                "typography".to_string(),
                "аркада".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            output,
            "---\ntype: meeting\ntags: \"design typography\"\nMine Collections:\n  - \"[[design]]\"\n  - \"[[typography]]\"\n  - \"[[аркада]]\"\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_updates_existing_mine_collections() {
        let input = "---\ntags: design typography\nMine Collections:\n  - old\n---\nBody";
        let output = patch_collections_frontmatter(
            input,
            &[
                "design".to_string(),
                "typography".to_string(),
                "local-first".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            output,
            "---\ntags: design typography\nMine Collections:\n  - \"[[design]]\"\n  - \"[[typography]]\"\n  - \"[[local-first]]\"\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_removes_collections_but_preserves_obsidian_tags() {
        let input = "---\ntags:\n  - old\nMine Collections:\n  - design\n---\nBody";
        let output = patch_collections_frontmatter(input, &[]).unwrap();
        assert_eq!(
            output,
            "---\ntags:\n  - old\nMine Collections: []\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_writes_empty_override_for_legacy_tags() {
        let input = "---\ntags:\n  - old\n---\nBody";
        let output = patch_collections_frontmatter(input, &[]).unwrap();
        assert_eq!(
            output,
            "---\ntags:\n  - old\nMine Collections: []\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_treats_unclosed_fence_as_body() {
        let input = "---\ntags:\n  - old";
        let output = patch_collections_frontmatter(input, &["new".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\nMine Collections:\n  - \"[[new]]\"\n---\n---\ntags:\n  - old"
        );
    }

    #[test]
    fn patch_collections_frontmatter_rejects_invalid_yaml_inside_fence() {
        let input = "---\ntype: article\n\tbad\n---\nBody";
        let err = patch_collections_frontmatter(input, &["new".to_string()]).unwrap_err();
        assert!(err.contains("malformed frontmatter"));
    }
}
