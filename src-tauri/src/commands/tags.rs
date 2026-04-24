// Tag commands: list tags, add/remove tag from block.
//
// Contract: SPEC_INTEGRATION.md#commands/tags

use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, AppState, CommandError};
use crate::domain::block::{parse_markdown_document, DateTime};
use crate::domain::tag::normalize_tag;
use crate::storage::index::TagCount;
use crate::storage::{db, files, index};
use crate::util::append_startup_trace;

const MINE_COLLECTIONS_FIELD: &str = "Mine Collections";

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
    let (_, content) = files::read_block_file(&path)?;
    let parsed = parse_markdown_document(&slug, &content, file_saved_at(&path))
        .map_err(|e| CommandError::Internal(e.to_string()))?;
    let mut block = parsed.block;

    let normalized = normalize_tag(&tag);
    if normalized.is_empty() {
        return Err(CommandError::Internal(
            "tag is empty after normalization".to_string(),
        ));
    }

    if !block.frontmatter.tags.contains(&normalized) {
        block.frontmatter.tags.push(normalized);
    }

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
    let (_, content) = files::read_block_file(&path)?;
    let parsed = parse_markdown_document(&slug, &content, file_saved_at(&path))
        .map_err(|e| CommandError::Internal(e.to_string()))?;
    let mut block = parsed.block;

    let normalized = normalize_tag(&tag);
    block.frontmatter.tags.retain(|t| t != &normalized);

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

    let normalized_old = normalize_tag(&old_tag);
    let normalized_new = normalize_tag(&new_tag);

    if normalized_new.is_empty() {
        return Err(CommandError::Internal(
            "new tag is empty after normalization".into(),
        ));
    }
    if normalized_old == normalized_new {
        return Ok(());
    }

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized_old)?;
    for indexed_block in &affected_blocks {
        let path = vs.vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(&path)?;
        let parsed = parse_markdown_document(&indexed_block.slug, &content, file_saved_at(&path))
            .map_err(|e| CommandError::Internal(e.to_string()))?;
        let mut block = parsed.block;

        block.frontmatter.tags.retain(|t| t != &normalized_old);
        if !block.frontmatter.tags.contains(&normalized_new) {
            block.frontmatter.tags.push(normalized_new.clone());
        }

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

    let normalized = normalize_tag(&tag);
    if normalized.is_empty() {
        return Ok(());
    }

    let affected_blocks = index::list_blocks_by_tag(&vs.conn, &normalized)?;
    for indexed_block in &affected_blocks {
        let path = vs.vault.block_path(&indexed_block.slug);
        let (_, content) = files::read_block_file(&path)?;
        let parsed = parse_markdown_document(&indexed_block.slug, &content, file_saved_at(&path))
            .map_err(|e| CommandError::Internal(e.to_string()))?;
        let mut block = parsed.block;

        block.frontmatter.tags.retain(|t| t != &normalized);

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
    match frontmatter_bounds(content) {
        FrontmatterBounds::None => {
            if collections.is_empty() {
                return Ok(content.to_string());
            }
            Ok(format!(
                "---\n{}---\n{}",
                render_collections(collections),
                content
            ))
        }
        FrontmatterBounds::Malformed => {
            Err("cannot safely patch collections: malformed frontmatter".to_string())
        }
        FrontmatterBounds::Valid {
            yaml_start,
            yaml_end,
            closing_start,
        } => {
            let yaml = &content[yaml_start..yaml_end];
            if !yaml.trim().is_empty() && serde_yaml::from_str::<serde_yaml::Value>(yaml).is_err() {
                return Err("cannot safely patch collections: malformed frontmatter".to_string());
            }
            let patched_yaml = patch_collections_yaml(yaml, collections)?;
            let mut out = String::with_capacity(content.len() + patched_yaml.len());
            out.push_str(&content[..yaml_start]);
            out.push_str(&patched_yaml);
            out.push_str(&content[closing_start..]);
            Ok(out)
        }
    }
}

enum FrontmatterBounds {
    None,
    Malformed,
    Valid {
        yaml_start: usize,
        yaml_end: usize,
        closing_start: usize,
    },
}

fn frontmatter_bounds(content: &str) -> FrontmatterBounds {
    let Some(first_line_end) = content.find('\n') else {
        return if content.trim_end_matches('\r') == "---" {
            FrontmatterBounds::Malformed
        } else {
            FrontmatterBounds::None
        };
    };
    if content[..first_line_end].trim_end_matches('\r') != "---" {
        return FrontmatterBounds::None;
    }

    let yaml_start = first_line_end + 1;
    let mut cursor = yaml_start;
    for (idx, line) in content[yaml_start..].split_inclusive('\n').enumerate() {
        if idx >= 20 {
            return FrontmatterBounds::None;
        }
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return FrontmatterBounds::Valid {
                yaml_start,
                yaml_end: cursor,
                closing_start: cursor,
            };
        }
        cursor += line.len();
    }
    FrontmatterBounds::None
}

fn patch_collections_yaml(yaml: &str, collections: &[String]) -> Result<String, String> {
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    let mut start = None;
    let mut has_legacy_tags = false;
    for (idx, line) in lines.iter().enumerate() {
        if is_top_level_collection_key(line) {
            start = Some(idx);
            break;
        }
        if is_top_level_legacy_tags_key(line) {
            has_legacy_tags = true;
        }
    }

    let Some(start_idx) = start else {
        if collections.is_empty() {
            if has_legacy_tags {
                let mut out = yaml.to_string();
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&render_collections(collections));
                return Ok(out);
            }
            return Ok(yaml.to_string());
        }
        let mut out = yaml.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&render_collections(collections));
        return Ok(out);
    };

    let mut end_idx = start_idx + 1;
    while end_idx < lines.len() {
        let line = lines[end_idx];
        let trimmed = line.trim();
        if trimmed.is_empty() || line.starts_with(' ') || line.starts_with('\t') {
            end_idx += 1;
            continue;
        }
        break;
    }

    let mut out = String::new();
    for line in &lines[..start_idx] {
        if is_top_level_legacy_tags_key(line) {
            has_legacy_tags = true;
        }
        out.push_str(line);
    }
    if !collections.is_empty() || has_legacy_tags {
        out.push_str(&render_collections(collections));
    }
    for line in &lines[end_idx..] {
        out.push_str(line);
    }
    Ok(out)
}

fn is_top_level_collection_key(line: &str) -> bool {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    line == format!("{MINE_COLLECTIONS_FIELD}:")
        || line.starts_with(&format!("{MINE_COLLECTIONS_FIELD}: "))
}

fn is_top_level_legacy_tags_key(line: &str) -> bool {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    line == "tags:" || line.starts_with("tags: ")
}

fn render_collections(collections: &[String]) -> String {
    if collections.is_empty() {
        return format!("{MINE_COLLECTIONS_FIELD}: []\n");
    }
    let mut out = format!("{MINE_COLLECTIONS_FIELD}:\n");
    for tag in collections {
        out.push_str("  - ");
        out.push_str(&yaml_quote_tag(tag));
        out.push('\n');
    }
    out
}

fn yaml_quote_tag(tag: &str) -> String {
    if tag
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '/'))
    {
        tag.to_string()
    } else {
        format!("\"{}\"", tag.replace('\\', "\\\\").replace('"', "\\\""))
    }
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
            "---\nMine Collections:\n  - design\n---\n# Note\n\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_preserves_unknown_fields_and_obsidian_tags() {
        let input = "---\naliases:\n  - A\n# keep me\ntags:\n  - old\ncssclasses: wide\n---\nBody";
        let output =
            patch_collections_frontmatter(input, &["design/typography".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\naliases:\n  - A\n# keep me\ntags:\n  - old\ncssclasses: wide\nMine Collections:\n  - design/typography\n---\nBody"
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
            "---\ntype: meeting\ntags: \"design typography\"\nMine Collections:\n  - design\n  - typography\n  - аркада\n---\nBody"
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
            "---\ntags: design typography\nMine Collections:\n  - design\n  - typography\n  - local-first\n---\nBody"
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
            "---\nMine Collections:\n  - new\n---\n---\ntags:\n  - old"
        );
    }

    #[test]
    fn patch_collections_frontmatter_rejects_invalid_yaml_inside_fence() {
        let input = "---\ntype: article\n\tbad\n---\nBody";
        let err = patch_collections_frontmatter(input, &["new".to_string()]).unwrap_err();
        assert!(err.contains("malformed frontmatter"));
    }
}
