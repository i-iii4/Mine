// Handler: orchestrates file changes into index updates.
//
// Provides full_scan (initial vault indexing), index_md_file (single file),
// and handle_event (dispatch vault events to appropriate storage ops).
//
// Contract: SPEC_INTEGRATION.md#watcher/handler

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::domain::block::{parse_block, Block, BlockType};
use crate::domain::vault::VaultLayout;
use crate::storage::{files, index, thumbnails};
use crate::watcher::events::VaultEvent;

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
/// Indexing happens synchronously (fast). Thumbnail generation runs in a
/// background thread to avoid blocking app startup. Returns immediately
/// after indexing completes.
///
/// `on_thumbs_done` is called from the background thread when all thumbnails
/// have been generated. Use this to notify the frontend to refresh previews.
pub fn full_scan(
    conn: &Connection,
    vault: &VaultLayout,
    on_thumbs_done: Option<Box<dyn FnOnce() + Send>>,
) -> Result<ScanResult> {
    let paths = files::scan_md_files(vault)?;
    let mut indexed = 0;
    let mut errors = 0;

    // Collect thumbnail work items during indexing
    let mut thumb_jobs: Vec<ThumbJob> = Vec::new();

    // Wrap all indexing in a single transaction for performance (one commit
    // instead of N commits). Individual upsert_block calls use savepoints.
    let tx = conn.unchecked_transaction()
        .context("failed to begin transaction for full_scan")?;

    for path in &paths {
        match index_md_file_inner(&tx, vault, path) {
            Ok(job) => {
                indexed += 1;
                if let Some(j) = job {
                    thumb_jobs.push(j);
                }
            }
            Err(e) => {
                log::warn!("failed to index {}: {:#}", path.display(), e);
                errors += 1;
            }
        }
    }

    tx.commit().context("failed to commit full_scan transaction")?;

    // Spawn background thread for thumbnail generation
    if !thumb_jobs.is_empty() {
        let vault_clone = vault.clone();
        match std::thread::Builder::new()
            .name("thumb-gen".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut generated = 0;
                    let mut skipped = 0;
                    for job in &thumb_jobs {
                        let thumb_path = vault_clone.thumb_path(&job.slug);

                        // O1: skip if thumbnail is fresh
                        if thumbnails::is_thumb_fresh(&thumb_path, &job.source_path) {
                            skipped += 1;
                            continue;
                        }

                        let result = match &job.kind {
                            ThumbKind::Image { media_path } => {
                                thumbnails::generate_thumbnail(media_path, &thumb_path, thumbnails::DEFAULT_MAX_SIZE)
                            }
                            ThumbKind::Video { media_path } => {
                                thumbnails::generate_video_thumbnail(media_path, &thumb_path, thumbnails::DEFAULT_MAX_SIZE)
                            }
                            ThumbKind::Text { title, body } => {
                                thumbnails::generate_text_thumbnail(title.as_deref(), body, &thumb_path)
                            }
                        };

                        match result {
                            Ok(_) => generated += 1,
                            Err(e) => log::warn!("thumbnail failed for {}: {}", job.slug, e),
                        }
                    }
                    log::info!(
                        "thumbnails: {} generated, {} skipped (fresh), {} total",
                        generated, skipped, thumb_jobs.len()
                    );
                    generated
                }));
                match result {
                    Ok(generated) => {
                        if generated > 0 {
                            if let Some(cb) = on_thumbs_done {
                                cb();
                            }
                        }
                    }
                    Err(_) => {
                        log::error!("thumb-gen thread panicked");
                    }
                }
            })
        {
            Ok(_handle) => { /* detached: thumbnail generation runs in background */ }
            Err(e) => log::error!("failed to spawn thumb-gen thread: {}", e),
        }
    }

    Ok(ScanResult { indexed, errors })
}

/// Index a single .md file: read, parse, upsert, generate thumbnail.
///
/// Used by handle_event for individual file changes. Thumbnail is generated
/// in a background thread to avoid blocking the file watcher.
pub fn index_md_file(conn: &Connection, vault: &VaultLayout, path: &Path) -> Result<()> {
    let job = index_md_file_inner(conn, vault, path)?;

    if let Some(job) = job {
        let thumb_path = vault.thumb_path(&job.slug);

        if thumbnails::is_thumb_fresh(&thumb_path, &job.source_path) {
            return Ok(());
        }

        // Generate thumbnail in background thread to avoid blocking file watcher
        let slug = job.slug.clone();
        std::thread::Builder::new()
            .name(format!("thumb-{}", &slug))
            .spawn(move || {
                let result = match &job.kind {
                    ThumbKind::Image { media_path } => {
                        thumbnails::generate_thumbnail(media_path, &thumb_path, thumbnails::DEFAULT_MAX_SIZE)
                    }
                    ThumbKind::Video { media_path } => {
                        thumbnails::generate_video_thumbnail(media_path, &thumb_path, thumbnails::DEFAULT_MAX_SIZE)
                    }
                    ThumbKind::Text { title, body } => {
                        thumbnails::generate_text_thumbnail(title.as_deref(), body, &thumb_path)
                    }
                };
                if let Err(e) = result {
                    log::warn!("thumbnail failed for {}: {}", slug, e);
                }
            })
            .ok();
    }

    Ok(())
}

// ─── Internal ───────────────────────────────────────────────────────────────

/// Describes a pending thumbnail generation job.
struct ThumbJob {
    slug: String,
    /// Path to the source file (.md) for mtime comparison.
    source_path: PathBuf,
    kind: ThumbKind,
}

enum ThumbKind {
    Image { media_path: PathBuf },
    Video { media_path: PathBuf },
    Text { title: Option<String>, body: String },
}

/// Core indexing logic: parse + upsert. Returns a ThumbJob if a thumbnail
/// should be (re-)generated.
fn index_md_file_inner(
    conn: &Connection,
    vault: &VaultLayout,
    path: &Path,
) -> Result<Option<ThumbJob>> {
    let (slug, content) = files::read_block_file(path)
        .with_context(|| format!("reading {}", path.display()))?;

    let block = parse_block(&slug, &content)
        .with_context(|| format!("parsing {}", path.display()))?;

    // Channel files → index as channel, no thumbnail
    if block.frontmatter.block_type == BlockType::Channel {
        index::upsert_channel_from_block(conn, &block)
            .with_context(|| format!("indexing channel {}", path.display()))?;
        return Ok(None);
    }

    index::upsert_block(conn, &block)
        .with_context(|| format!("indexing {}", path.display()))?;

    // Determine thumbnail work — prefer images over text
    let job = if let Some(ref file_name) = block.frontmatter.file {
        // Block has a media file (image, video, etc.)
        let ext = Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let media_path = vault.media_path(&slug, ext);
        if media_path.exists() && is_image_ext(ext) {
            Some(ThumbJob {
                slug,
                source_path: path.to_path_buf(),
                kind: ThumbKind::Image { media_path },
            })
        } else if is_video_ext(ext) && media_path.exists() {
            Some(ThumbJob {
                slug,
                source_path: path.to_path_buf(),
                kind: ThumbKind::Video { media_path },
            })
        } else {
            try_thumbnail_field(&block, vault, slug, path)
        }
    } else if let Some(job) = try_thumbnail_field(&block, vault, slug.clone(), path) {
        // No media file, but has a thumbnail field (video poster, OG image)
        Some(job)
    } else if let Some(job) = try_first_image(&block, vault, slug.clone(), path) {
        // Article with embedded images — use first image
        Some(job)
    } else if let Some(job) = try_first_video(&block, vault, slug.clone(), path) {
        // Article with embedded video — extract first frame
        Some(job)
    } else if block.frontmatter.block_type == BlockType::Article {
        // Pure text article — baked text thumbnail (inverted via CSS in dark mode)
        Some(ThumbJob {
            slug,
            source_path: path.to_path_buf(),
            kind: ThumbKind::Text {
                title: block.frontmatter.title.clone(),
                body: block.body.clone(),
            },
        })
    } else {
        None
    };

    Ok(job)
}

/// Try to use the `thumbnail` frontmatter field (video poster, OG image) as thumbnail source.
fn try_thumbnail_field(block: &Block, vault: &VaultLayout, slug: String, source: &Path) -> Option<ThumbJob> {
    let thumb_file = block.frontmatter.thumbnail.as_ref()?;
    let ext = Path::new(thumb_file.as_str())
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !is_image_ext(ext) { return None; }
    let media_path = vault.root().join(thumb_file);
    if !media_path.exists() { return None; }
    Some(ThumbJob {
        slug,
        source_path: source.to_path_buf(),
        kind: ThumbKind::Image { media_path },
    })
}

/// Try to use the first embedded image from article body as thumbnail source.
fn try_first_image(block: &Block, vault: &VaultLayout, slug: String, source: &Path) -> Option<ThumbJob> {
    if block.frontmatter.block_type != BlockType::Article { return None; }
    let first_img = extract_first_image_filename(&block.body)?;
    let ext = Path::new(&first_img)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !is_image_ext(ext) { return None; }
    let media_path = vault.root().join(&first_img);
    if !media_path.exists() { return None; }
    Some(ThumbJob {
        slug,
        source_path: source.to_path_buf(),
        kind: ThumbKind::Image { media_path },
    })
}

/// Try to use the first embedded video from article body as thumbnail source.
fn try_first_video(block: &Block, vault: &VaultLayout, slug: String, source: &Path) -> Option<ThumbJob> {
    if block.frontmatter.block_type != BlockType::Article { return None; }
    let first_vid = extract_first_video_filename(&block.body)?;
    let media_path = vault.root().join(&first_vid);
    if !media_path.exists() { return None; }
    Some(ThumbJob {
        slug,
        source_path: source.to_path_buf(),
        kind: ThumbKind::Video { media_path },
    })
}

/// Extract the filename of the first video from markdown body.
/// Returns local filenames only (not URLs).
fn extract_first_video_filename(body: &str) -> Option<String> {
    let mut search_from = 0;
    while let Some(start) = body[search_from..].find("![") {
        let abs_start = search_from + start;
        let rest = &body[abs_start + 2..];
        let Some(bracket) = rest.find("](") else { break };
        let url_start = abs_start + 2 + bracket + 2;
        let Some(paren_end) = body[url_start..].find(')') else { break };
        let url = &body[url_start..url_start + paren_end];
        search_from = url_start + paren_end + 1;

        if url.is_empty() || url.starts_with("http://") || url.starts_with("https://") {
            continue;
        }
        let ext = Path::new(url).extension().and_then(|e| e.to_str()).unwrap_or("");
        if is_video_ext(ext) {
            return Some(url.to_string());
        }
    }
    None
}

/// Extract the filename of the first image (not video) from markdown body.
/// Skips URLs and non-image files (.mp4, .webm).
fn extract_first_image_filename(body: &str) -> Option<String> {
    let mut search_from = 0;
    while let Some(start) = body[search_from..].find("![") {
        let abs_start = search_from + start;
        let rest = &body[abs_start + 2..];
        let Some(bracket) = rest.find("](") else { break };
        let url_start = abs_start + 2 + bracket + 2;
        let Some(paren_end) = body[url_start..].find(')') else { break };
        let url = &body[url_start..url_start + paren_end];
        search_from = url_start + paren_end + 1;

        if url.is_empty() || url.starts_with("http://") || url.starts_with("https://") {
            continue;
        }
        let ext = Path::new(url).extension().and_then(|e| e.to_str()).unwrap_or("");
        if is_image_ext(ext) {
            return Some(url.to_string());
        }
    }
    None
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
                    let path_owned = path.to_path_buf();
                    std::thread::Builder::new()
                        .name(format!("thumb-media-{}", &slug))
                        .spawn(move || {
                            if let Err(e) = thumbnails::generate_thumbnail(&path_owned, &thumb_path, thumbnails::DEFAULT_MAX_SIZE) {
                                log::warn!("thumbnail failed for {}: {}", slug, e);
                            }
                        })
                        .ok();
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

fn is_video_ext(ext: &str) -> bool {
    matches!(ext.to_lowercase().as_str(), "mp4" | "webm" | "mov")
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
                position: None,
                color: None,
                icon: None,
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

        let result = full_scan(&conn, &vault, None).unwrap();
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

        let result = full_scan(&conn, &vault, None).unwrap();
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

        let result = full_scan(&conn, &vault, None).unwrap();
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
