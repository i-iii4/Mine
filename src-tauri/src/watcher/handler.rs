// Handler: orchestrates file changes into index updates.
//
// Provides full_scan (initial vault indexing), index_md_file (single file),
// and handle_event (dispatch vault events to appropriate storage ops).
//
// Contract: SPEC_INTEGRATION.md#watcher/handler

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

use crate::domain::block::parse_block;
use crate::domain::vault::VaultLayout;
use crate::storage::{files, index, thumbnails};
use crate::watcher::events::VaultEvent;

const THUMB_MAX_SIZE: u32 = 240;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Result of a full vault scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScanResult {
    /// Number of blocks successfully indexed.
    pub indexed: usize,
    /// Number of files that failed to parse.
    pub errors: usize,
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Scan the entire vault: parse all .md files and index them.
///
/// - Errors on individual files are logged and counted, not propagated.
/// - Generates thumbnails for blocks with media files.
pub fn full_scan(conn: &Connection, vault: &VaultLayout) -> Result<ScanResult> {
    let paths = files::scan_md_files(vault)?;
    let mut indexed = 0;
    let mut errors = 0;

    for path in &paths {
        match index_md_file(conn, vault, path) {
            Ok(()) => indexed += 1,
            Err(e) => {
                log::warn!("failed to index {}: {:#}", path.display(), e);
                errors += 1;
            }
        }
    }

    Ok(ScanResult { indexed, errors })
}

/// Index a single .md file: read, parse, upsert, generate thumbnail.
pub fn index_md_file(conn: &Connection, vault: &VaultLayout, path: &Path) -> Result<()> {
    let (slug, content) = files::read_block_file(path)
        .with_context(|| format!("reading {}", path.display()))?;

    let block = parse_block(&slug, &content)
        .with_context(|| format!("parsing {}", path.display()))?;

    index::upsert_block(conn, &block)
        .with_context(|| format!("indexing {}", path.display()))?;

    // Generate thumbnail if block has a media file
    if let Some(ref file_name) = block.frontmatter.file {
        let ext = Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let media_path = vault.media_path(&slug, ext);

        if media_path.exists() && is_image_ext(ext) {
            let thumb_path = vault.thumb_path(&slug);
            if let Err(e) = thumbnails::generate_thumbnail(&media_path, &thumb_path, THUMB_MAX_SIZE)
            {
                log::warn!("thumbnail failed for {}: {}", slug, e);
            }
        }
    }

    Ok(())
}

/// Handle a single vault event: dispatch to the appropriate storage operation.
pub fn handle_event(conn: &Connection, vault: &VaultLayout, event: &VaultEvent) -> Result<()> {
    match event {
        VaultEvent::BlockChanged(path) => {
            index_md_file(conn, vault, path)?;
        }
        VaultEvent::BlockDeleted(path) => {
            if let Some(slug) = path_to_slug(path) {
                index::remove_block(conn, &slug)?;
            }
        }
        VaultEvent::MediaChanged(path) => {
            if let Some(slug) = path_to_slug(path) {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if is_image_ext(ext) {
                    let thumb_path = vault.thumb_path(&slug);
                    thumbnails::generate_thumbnail(path, &thumb_path, THUMB_MAX_SIZE)?;
                }
            }
        }
        VaultEvent::MediaDeleted(path) => {
            if let Some(slug) = path_to_slug(path) {
                let thumb_path = vault.thumb_path(&slug);
                if thumb_path.exists() {
                    let _ = std::fs::remove_file(&thumb_path);
                }
            }
        }
    }
    Ok(())
}

// ─── Private helpers ────────────────────────────────────────────────────────

/// Extract slug from a file path (file stem without extension).
fn path_to_slug(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
}

/// Check if a file extension represents an image format we can thumbnail.
fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | "tif"
    )
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{BlockType, DateTime, Frontmatter};
    use crate::storage::db;

    fn test_conn() -> Connection {
        db::open_memory().unwrap()
    }

    fn write_md_file(vault: &VaultLayout, slug: &str, block_type: &str, tags: &[&str]) {
        let block = crate::domain::block::Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::from_str(block_type).unwrap(),
                title: Some(slug.to_string()),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: tags.iter().map(|t| t.to_string()).collect(),
                saved_at: DateTime::new("2026-01-15T12:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
            },
            body: String::new(),
        };
        files::write_block_file(vault, &block).unwrap();
    }

    // ── full_scan ────────────────────────────────────────────────────────

    #[test]
    fn full_scan_empty_vault() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        let result = full_scan(&conn, &vault).unwrap();
        assert_eq!(result, ScanResult { indexed: 0, errors: 0 });
    }

    #[test]
    fn full_scan_indexes_all_files() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "alpha", "image", &["photo"]);
        write_md_file(&vault, "beta", "link", &["web"]);
        write_md_file(&vault, "gamma", "article", &[]);

        let result = full_scan(&conn, &vault).unwrap();
        assert_eq!(result, ScanResult { indexed: 3, errors: 0 });

        let blocks = index::list_blocks(&conn).unwrap();
        assert_eq!(blocks.len(), 3);
    }

    #[test]
    fn full_scan_counts_errors() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "good", "image", &[]);
        // Write an invalid .md file (no frontmatter)
        std::fs::write(vault.block_path("bad"), "not a valid block").unwrap();

        let result = full_scan(&conn, &vault).unwrap();
        assert_eq!(result.indexed, 1);
        assert_eq!(result.errors, 1);
    }

    // ── index_md_file ────────────────────────────────────────────────────

    #[test]
    fn index_single_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "note", "article", &["design"]);
        let path = vault.block_path("note");
        index_md_file(&conn, &vault, &path).unwrap();

        let block = index::get_block(&conn, "note").unwrap().unwrap();
        assert_eq!(block.block_type, BlockType::Article);
        assert_eq!(block.tags, vec!["design"]);
    }

    #[test]
    fn index_invalid_file_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        std::fs::write(vault.block_path("bad"), "garbage").unwrap();
        let path = vault.block_path("bad");
        assert!(index_md_file(&conn, &vault, &path).is_err());
    }

    // ── handle_event ─────────────────────────────────────────────────────

    #[test]
    fn handle_block_changed() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "note", "link", &[]);
        let path = vault.block_path("note");
        handle_event(&conn, &vault, &VaultEvent::BlockChanged(path)).unwrap();

        assert!(index::get_block(&conn, "note").unwrap().is_some());
    }

    #[test]
    fn handle_block_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        // First index a block
        write_md_file(&vault, "note", "link", &[]);
        let path = vault.block_path("note");
        index_md_file(&conn, &vault, &path).unwrap();

        // Then delete it
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path)).unwrap();
        assert!(index::get_block(&conn, "note").unwrap().is_none());
    }

    #[test]
    fn handle_media_deleted_removes_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        // Create a fake thumbnail
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        let thumb = vault.thumb_path("photo");
        std::fs::write(&thumb, b"fake thumb").unwrap();
        assert!(thumb.exists());

        // Media deleted event should remove thumbnail
        let media_path = vault.media_path("photo", "jpg");
        handle_event(&conn, &vault, &VaultEvent::MediaDeleted(media_path)).unwrap();
        assert!(!thumb.exists());
    }

    // ── helpers ──────────────────────────────────────────────────────────

    #[test]
    fn path_to_slug_extracts_stem() {
        assert_eq!(
            path_to_slug(Path::new("/vault/sunset-tokyo.md")),
            Some("sunset-tokyo".to_string())
        );
        assert_eq!(
            path_to_slug(Path::new("/vault/photo.jpg")),
            Some("photo".to_string())
        );
    }

    #[test]
    fn is_image_ext_recognized() {
        assert!(is_image_ext("jpg"));
        assert!(is_image_ext("PNG"));
        assert!(is_image_ext("webp"));
        assert!(!is_image_ext("mp4"));
        assert!(!is_image_ext("md"));
    }
}
