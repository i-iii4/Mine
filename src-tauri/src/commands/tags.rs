// Tag commands: list tags, add/remove tag from block.
//
// Contract: SPEC_INTEGRATION.md#commands/tags

use rusqlite::Connection;
use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, ensure_vault_fresh, AppState, CommandError};
use crate::domain::block::{parse_markdown_document, DateTime};
use crate::domain::collection::{normalize_collection_ref, validate_collection_ref};
use crate::domain::vault::{validate_slug, VaultLayout};
use crate::storage::index::{IndexedBlock, TagCount};
use crate::storage::source_mutation::{SourceFileWrite, StagedSourceMutation};
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
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let db_path = vault.index_db_path();
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
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;

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
    validate_collection_ref(&collection_ref).map_err(CommandError::Internal)?;

    if !block.frontmatter.tags.contains(&collection_ref) {
        block.frontmatter.tags.push(collection_ref);
    }
    files::normalize_block_media_refs_for_index(&vs.vault, &mut block);

    let content = patch_collections_frontmatter(&content, &block.frontmatter.tags)
        .map_err(CommandError::Internal)?;
    commit_block_rewrite(
        &vs.conn,
        &vs.vault,
        &path,
        content.as_bytes(),
        &block,
        parsed.origin.as_str(),
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
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;

    let path = vs.vault.block_path(&slug);
    let (_, content) = files::read_block_file(&vs.vault, &path)?;
    let parsed = parse_markdown_document(&slug, &content, file_saved_at(&path))
        .map_err(|e| CommandError::Internal(e.to_string()))?;
    let mut block = parsed.block;

    let collection_ref = normalize_collection_ref(&tag);
    if !collection_ref.is_empty() {
        validate_collection_ref(&collection_ref).map_err(CommandError::Internal)?;
    }
    block.frontmatter.tags.retain(|t| t != &collection_ref);
    files::normalize_block_media_refs_for_index(&vs.vault, &mut block);

    let content = patch_collections_frontmatter(&content, &block.frontmatter.tags)
        .map_err(CommandError::Internal)?;
    commit_block_rewrite(
        &vs.conn,
        &vs.vault,
        &path,
        content.as_bytes(),
        &block,
        parsed.origin.as_str(),
        parsed.index_warning.as_deref(),
    )?;

    Ok(())
}

fn commit_block_rewrite(
    conn: &Connection,
    vault: &VaultLayout,
    path: &std::path::Path,
    content: &[u8],
    block: &crate::domain::block::Block,
    origin: &str,
    index_warning: Option<&str>,
) -> Result<(), CommandError> {
    let staged = StagedSourceMutation::stage(vec![SourceFileWrite::replace(
        path.to_path_buf(),
        content.to_vec(),
    )])
    .map_err(|error| CommandError::Internal(error.to_string()))?;
    staged
        .commit_with_index(conn, "rewrite_block_collections", |index_conn| {
            index::upsert_block_with_diagnostics(
                index_conn,
                block,
                Some(vault.root()),
                Some(origin),
                index_warning,
            )
            .map(|_| ())
        })
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    Ok(())
}

/// Apply a frontmatter collection rewrite through one staged source batch and
/// one SQLite transaction.
fn rewrite_collection_membership(
    conn: &Connection,
    vault: &VaultLayout,
    affected: &[IndexedBlock],
    mut transform: impl FnMut(&mut Vec<String>),
) -> Result<(), CommandError> {
    let mut writes = Vec::with_capacity(affected.len());
    let mut prepared = Vec::with_capacity(affected.len());
    for indexed_block in affected {
        let path = vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(vault, &path)?;
        let parsed = parse_markdown_document(&indexed_block.slug, &content, file_saved_at(&path))
            .map_err(|e| CommandError::Internal(e.to_string()))?;
        let mut block = parsed.block;
        transform(&mut block.frontmatter.tags);
        files::normalize_block_media_refs_for_index(vault, &mut block);
        let serialized = patch_collections_frontmatter(&content, &block.frontmatter.tags)
            .map_err(CommandError::Internal)?;
        writes.push(SourceFileWrite::replace(path, serialized.into_bytes()));
        prepared.push((block, parsed.origin, parsed.index_warning));
    }

    let staged = StagedSourceMutation::stage(writes)
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    staged
        .commit_with_index(conn, "rewrite_collection_membership", |index_conn| {
            for (block, origin, index_warning) in &prepared {
                index::upsert_block_with_diagnostics(
                    index_conn,
                    block,
                    Some(vault.root()),
                    Some(origin.as_str()),
                    index_warning.as_deref(),
                )?;
            }
            Ok(())
        })
        .map_err(|error| CommandError::Internal(error.to_string()))?;
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
    validate_collection_ref(&normalized_old).map_err(CommandError::Internal)?;
    validate_collection_ref(&normalized_new).map_err(CommandError::Internal)?;
    if normalized_old == normalized_new {
        return Ok(());
    }

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized_old)?;
    rewrite_collection_membership(&vs.conn, &vs.vault, &affected_blocks, |tags| {
        tags.retain(|t| t != &normalized_old);
        if !tags.contains(&normalized_new) {
            tags.push(normalized_new.clone());
        }
    })
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
    validate_collection_ref(&normalized).map_err(CommandError::Internal)?;

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized)?;
    rewrite_collection_membership(&vs.conn, &vs.vault, &affected_blocks, |tags| {
        tags.retain(|t| t != &normalized);
    })
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

pub(crate) fn patch_collections_frontmatter(
    content: &str,
    collections: &[String],
) -> Result<String, String> {
    crate::domain::collection::patch_collections_frontmatter(content, collections)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db;

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

    #[test]
    fn block_rewrite_restores_source_when_index_update_fails() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let path = vault.block_path("Note");
        let original = "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\nMine Collections:\n  - \"[[Old]]\"\n---\nBody";
        std::fs::write(&path, original).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let original_parsed =
            parse_markdown_document("Note", original, file_saved_at(&path)).unwrap();
        index::upsert_block(&conn, &original_parsed.block, Some(vault.root())).unwrap();
        let rewritten = patch_collections_frontmatter(original, &["New".to_string()]).unwrap();
        let rewritten_parsed =
            parse_markdown_document("Note", &rewritten, file_saved_at(&path)).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_tag_update
             BEFORE UPDATE ON blocks
             WHEN new.slug = 'Note'
             BEGIN
                 SELECT RAISE(ABORT, 'injected tag index failure');
             END;",
        )
        .unwrap();

        let result = commit_block_rewrite(
            &conn,
            &vault,
            &path,
            rewritten.as_bytes(),
            &rewritten_parsed.block,
            rewritten_parsed.origin.as_str(),
            rewritten_parsed.index_warning.as_deref(),
        );

        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert_eq!(
            index::get_block(&conn, "Note").unwrap().unwrap().tags,
            vec!["Old"]
        );
    }

    #[test]
    fn bulk_collection_rewrite_rolls_back_every_file_and_index_row() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let source = |slug: &str| {
            format!(
                "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\nMine Collections:\n  - \"[[Old]]\"\n---\n{slug} body"
            )
        };
        for slug in ["A", "B"] {
            let content = source(slug);
            let path = vault.block_path(slug);
            std::fs::write(&path, &content).unwrap();
            let parsed = parse_markdown_document(slug, &content, file_saved_at(&path)).unwrap();
            index::upsert_block(&conn, &parsed.block, Some(vault.root())).unwrap();
        }
        conn.execute_batch(
            "CREATE TRIGGER reject_second_bulk_update
             BEFORE UPDATE ON blocks
             WHEN new.slug = 'B'
             BEGIN
                 SELECT RAISE(ABORT, 'injected bulk index failure');
             END;",
        )
        .unwrap();
        let affected = index::list_blocks_by_tag(&conn, "Old").unwrap();

        let result = rewrite_collection_membership(&conn, &vault, &affected, |tags| {
            tags.clear();
            tags.push("New".to_string());
        });

        assert!(result.is_err());
        for slug in ["A", "B"] {
            assert_eq!(
                std::fs::read_to_string(vault.block_path(slug)).unwrap(),
                source(slug)
            );
            assert_eq!(
                index::get_block(&conn, slug).unwrap().unwrap().tags,
                vec!["Old"]
            );
        }
    }
}
