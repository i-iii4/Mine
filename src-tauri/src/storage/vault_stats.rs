// Vault statistics read model for the main secondary statistics bar.
//
// Counts physical source-vault files and route-scoped indexed cards. This
// module is storage-only: no Tauri state, no UI formatting, no event emission.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::domain::vault::VaultLayout;
use crate::storage::{files, index};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceVaultFileStats {
    pub total_file_count: u64,
    pub markdown_file_count: u64,
    pub media_file_count: u64,
    pub source_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStats {
    pub total_file_count: u64,
    pub markdown_file_count: u64,
    pub media_file_count: u64,
    pub source_bytes: u64,
    pub current_collection_card_count: u64,
    pub current_collection: Option<String>,
    pub updated_at_ms: u64,
}

pub fn get_vault_stats(
    conn: &Connection,
    vault: &VaultLayout,
    current_collection: Option<&str>,
) -> Result<VaultStats> {
    let source = scan_source_vault_file_stats(vault)?;
    Ok(VaultStats {
        total_file_count: source.total_file_count,
        markdown_file_count: source.markdown_file_count,
        media_file_count: source.media_file_count,
        source_bytes: source.source_bytes,
        current_collection_card_count: count_current_collection_cards(conn, current_collection)?,
        current_collection: current_collection.map(str::to_string),
        updated_at_ms: now_ms(),
    })
}

pub fn count_current_collection_cards(
    conn: &Connection,
    current_collection: Option<&str>,
) -> Result<u64> {
    if let Some(collection_ref) = current_collection {
        let count: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT b.id)
             FROM blocks b
             JOIN block_tags bt ON bt.block_id = b.id
             WHERE b.card_kind != 'channel' AND bt.tag = ?1",
            params![collection_ref],
            |row| row.get(0),
        )?;
        return Ok(count as u64);
    }

    Ok(index::count_grid_blocks(conn)? as u64)
}

pub fn scan_source_vault_file_stats(vault: &VaultLayout) -> Result<SourceVaultFileStats> {
    let mut stats = SourceVaultFileStats {
        total_file_count: 0,
        markdown_file_count: 0,
        media_file_count: 0,
        source_bytes: 0,
    };
    scan_source_vault_file_stats_inner(vault.root(), &mut stats, true).with_context(|| {
        format!(
            "failed to scan source vault stats: {}",
            vault.root().display()
        )
    })?;
    Ok(stats)
}

fn scan_source_vault_file_stats_inner(
    dir: &Path,
    stats: &mut SourceVaultFileStats,
    include_in_source_breakdown: bool,
) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            scan_source_vault_file_stats_inner(
                &path,
                stats,
                include_in_source_breakdown && !files::is_ignored_vault_dir(&path),
            )?;
            continue;
        }

        if file_type.is_file() || file_type.is_symlink() {
            stats.total_file_count += 1;

            if !include_in_source_breakdown || hidden_file_name(&path) {
                continue;
            }

            let metadata = std::fs::symlink_metadata(&path)
                .with_context(|| format!("failed to read metadata: {}", path.display()))?;
            if is_markdown_path(&path) {
                stats.markdown_file_count += 1;
            } else {
                stats.media_file_count += 1;
            }
            stats.source_bytes = stats.source_bytes.saturating_add(metadata.len());
        }
    }
    Ok(())
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn hidden_file_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::storage::{db, index};

    fn make_block(slug: &str, block_type: BlockType, body: &str, tags: &[&str]) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type,
                title: Some(slug.to_string()),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-01-01T00:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
                tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
            },
            body: body.to_string(),
        }
    }

    fn insert_block(conn: &Connection, block: &Block, vault: &VaultLayout) {
        index::upsert_block_with_diagnostics(conn, block, Some(vault.root()), None, None).unwrap();
    }

    #[test]
    fn source_stats_count_markdown_media_and_bytes_outside_service_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::write(vault.root().join("A.md"), b"note").unwrap();
        std::fs::write(vault.root().join("image.jpg"), [0_u8; 7]).unwrap();
        std::fs::write(vault.root().join(".hidden"), [0_u8; 3]).unwrap();
        std::fs::create_dir(vault.root().join("Nested")).unwrap();
        std::fs::write(vault.root().join("Nested").join("B.MD"), b"nested").unwrap();
        std::fs::create_dir(vault.root().join(".arena")).unwrap();
        std::fs::write(vault.root().join(".arena").join("derived.jpg"), [0_u8; 100]).unwrap();

        let stats = scan_source_vault_file_stats(&vault).unwrap();

        assert_eq!(stats.total_file_count, 5);
        assert_eq!(stats.markdown_file_count, 2);
        assert_eq!(stats.media_file_count, 1);
        assert_eq!(stats.source_bytes, 4 + 7 + 6);
    }

    #[test]
    fn vault_stats_count_everything_and_current_collection_from_index() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = db::open_memory().unwrap();
        insert_block(
            &conn,
            &make_block("alpha", BlockType::Article, "body", &["Design"]),
            &vault,
        );
        insert_block(
            &conn,
            &make_block("beta", BlockType::Image, "", &["Other"]),
            &vault,
        );
        insert_block(
            &conn,
            &make_block("Design", BlockType::Channel, "", &[]),
            &vault,
        );

        assert_eq!(count_current_collection_cards(&conn, None).unwrap(), 2);
        assert_eq!(
            count_current_collection_cards(&conn, Some("Design")).unwrap(),
            1,
        );
    }
}
