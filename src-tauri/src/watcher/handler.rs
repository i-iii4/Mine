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
use tauri::{AppHandle, Emitter};

use crate::domain::block::{parse_block, Block, BlockType};
use crate::domain::vault::VaultLayout;
use crate::storage::{files, index, thumbnails};
use crate::watcher::events::VaultEvent;

// ─── Event payloads (Rust → Frontend) ───────────────────────────────────────

/// Emitted after `index_md_file` upserts a block into the index. Carries
/// just enough for `useChannelPreviewsEvents` to add a `PreviewCard` to
/// every affected channel without refetching anything.
#[derive(Debug, Clone, Serialize)]
struct BlockAddedPayload {
    slug: String,
    tags: Vec<String>,
    is_text: bool,
}

/// Emitted after `handle_event(BlockDeleted)` strips a block from the
/// index. Carries the tags the block HAD at delete time so the sidebar
/// can drop the preview card from each matching channel.
#[derive(Debug, Clone, Serialize)]
struct BlockRemovedPayload {
    slug: String,
    tags: Vec<String>,
}

/// Emitted after a Phase 1 thumbnail write (Rust cascade). Frontend
/// cache-busts `<img>` elements pointing at `<slug>.jpg`.
#[derive(Debug, Clone, Serialize)]
struct ThumbUpdatedPayload {
    slug: String,
}

/// Emitted when Phase 1 produced a text placeholder for a block whose
/// embedded media could, in principle, be rendered by the WebView
/// decoder. Frontend worker picks it up and produces a real JPEG via
/// `createImageBitmap` / `<video>` → `save_thumb`.
#[derive(Debug, Clone, Serialize)]
struct ThumbUpgradeRequestedPayload {
    slug: String,
    #[serde(rename = "mediaPath")]
    media_path: String,
    kind: String,
}

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

    // Collect thumbnail work items during indexing.
    // Each job owns its parsed Block so the background thread can
    // delegate the full cascade to thumbnails::generate_for_block.
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
                    let total = thumb_jobs.len();
                    let mut generated = 0;
                    let mut skipped = 0;
                    for job in &thumb_jobs {
                        let thumb_path = vault_clone.thumb_path(&job.block.slug);

                        // O1: skip if thumbnail is fresh AND has valid image magic bytes
                        if thumbnails::is_thumb_fresh(&thumb_path, &job.source_path) {
                            skipped += 1;
                            continue;
                        }

                        match thumbnails::generate_for_block(&job.block, &vault_clone) {
                            thumbnails::ThumbSource::None => {
                                // Non-article block without resolvable media — silent skip
                            }
                            _ => {
                                generated += 1;
                            }
                        }
                    }
                    log::info!(
                        "thumbnails: {} generated, {} skipped (fresh), {} total",
                        generated, skipped, total
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
///
/// When `app` is `Some`, emits `block:added` immediately after upsert and
/// `thumb:updated` / `thumb:upgrade-requested` from the background thumb
/// thread. These events drive the event-driven sidebar (SPEC_THUMBNAILS.md
/// Phase 3). `None` is used by unit tests that don't need emit plumbing.
pub fn index_md_file(
    conn: &Connection,
    vault: &VaultLayout,
    path: &Path,
    app: Option<&AppHandle>,
) -> Result<()> {
    let job = index_md_file_inner(conn, vault, path)?;

    if let Some(job) = job {
        // Emit block:added synchronously — frontend wants this latency to
        // be as low as possible so newly-clipped blocks appear in the
        // sidebar before the background thumb thread even wakes up. The
        // text-ness classification mirrors list_channel_previews so
        // incremental updates and the initial bulk load agree.
        if let Some(app) = app {
            let is_text = job.block.frontmatter.block_type == BlockType::Article
                && job.block.frontmatter.file.is_none()
                && job.block.frontmatter.thumbnail.is_none()
                && thumbnails::find_first_local_media(&job.block.body, thumbnails::is_image_ext)
                    .is_none();
            let _ = app.emit(
                "block:added",
                BlockAddedPayload {
                    slug: job.block.slug.clone(),
                    tags: job.block.frontmatter.tags.clone(),
                    is_text,
                },
            );
        }

        let thumb_path = vault.thumb_path(&job.block.slug);

        if thumbnails::is_thumb_fresh(&thumb_path, &job.source_path) {
            return Ok(());
        }

        // Generate thumbnail in background thread to avoid blocking file
        // watcher. After the cascade runs, inspect the result and fire
        // follow-up events (thumb:updated always, upgrade-requested if
        // the thumb is a text placeholder and the block has upgradable
        // media).
        let vault = vault.clone();
        let slug = job.block.slug.clone();
        let app_clone = app.cloned();
        std::thread::Builder::new()
            .name(format!("thumb-{}", &slug))
            .spawn(move || {
                let source = thumbnails::generate_for_block(&job.block, &vault);
                if let Some(app) = app_clone {
                    emit_thumb_events(&app, &vault, &job.block, source);
                }
            })
            .ok();
    }

    Ok(())
}

/// Emit `thumb:updated` and (when applicable) `thumb:upgrade-requested`
/// after a Phase 1 cascade run. Lives as a free function so tests can
/// call `generate_for_block` directly without an AppHandle.
fn emit_thumb_events(
    app: &AppHandle,
    vault: &VaultLayout,
    block: &Block,
    source: thumbnails::ThumbSource,
) {
    // `None` means the cascade decided not to write any thumb (non-article
    // block with no resolvable media). Nothing for the sidebar to refresh.
    if source == thumbnails::ThumbSource::None {
        return;
    }
    let _ = app.emit(
        "thumb:updated",
        ThumbUpdatedPayload {
            slug: block.slug.clone(),
        },
    );

    // Only text placeholders trigger upgrade requests. Real JPEG thumbs
    // from Rust decode are already the final result.
    if source != thumbnails::ThumbSource::Text {
        return;
    }
    if let Some((media_path, kind)) = resolve_upgrade_media_for_block(vault, block) {
        let _ = app.emit(
            "thumb:upgrade-requested",
            ThumbUpgradeRequestedPayload {
                slug: block.slug.clone(),
                media_path: media_path.to_string_lossy().into_owned(),
                kind: kind.into(),
            },
        );
    }
}

/// Mirror of `commands::thumbnails::resolve_upgrade_media` but working
/// off a full `Block` (the version we have after parse). Priority matches
/// `generate_for_block`'s cascade so the Phase 2 upgrade replaces the
/// placeholder with the same media Rust would have used.
fn resolve_upgrade_media_for_block(
    vault: &VaultLayout,
    block: &Block,
) -> Option<(PathBuf, &'static str)> {
    // 1. frontmatter.file
    if let Some(ref file_name) = block.frontmatter.file {
        let ext = file_name
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_lowercase();
        let media_path = vault.media_path(&block.slug, &ext);
        if media_path.exists() {
            if thumbnails::is_image_ext(&ext) {
                return Some((media_path, "image"));
            }
            if thumbnails::is_video_ext(&ext) {
                return Some((media_path, "video"));
            }
        }
    }

    // 2. frontmatter.thumbnail
    if let Some(ref thumb_file) = block.frontmatter.thumbnail {
        let ext = thumb_file
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_lowercase();
        if thumbnails::is_image_ext(&ext) {
            let media_path = vault.root().join(thumb_file);
            if media_path.exists() {
                return Some((media_path, "image"));
            }
        }
    }

    // 3. First body image / 4. first body video
    if let Some(first_image) =
        thumbnails::find_first_local_media(&block.body, thumbnails::is_image_ext)
    {
        let media_path = vault.root().join(&first_image);
        if media_path.exists() {
            return Some((media_path, "image"));
        }
    }
    if let Some(first_video) =
        thumbnails::find_first_local_media(&block.body, thumbnails::is_video_ext)
    {
        let media_path = vault.root().join(&first_video);
        if media_path.exists() {
            return Some((media_path, "video"));
        }
    }

    None
}

// ─── Internal ───────────────────────────────────────────────────────────────

/// Describes a pending thumbnail generation job. Owns the parsed Block —
/// background thread calls `thumbnails::generate_for_block(&block, vault)`
/// which contains the full cascade (media file → thumbnail field → first
/// body image → first body video → text fallback).
struct ThumbJob {
    block: Block,
    /// Path to the source file (.md) for mtime comparison in is_thumb_fresh.
    source_path: PathBuf,
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

    index::upsert_block(conn, &block, Some(vault.root()))
        .with_context(|| format!("indexing {}", path.display()))?;

    Ok(Some(ThumbJob {
        block,
        source_path: path.to_path_buf(),
    }))
}

/// Handle a single vault event: dispatch to the appropriate storage operation.
///
/// When `app` is `Some`, emits Tauri events (`block:added`, `block:removed`,
/// `thumb:updated`, `thumb:upgrade-requested`) to drive the event-driven
/// sidebar in the frontend. Tests pass `None` to exercise the pure logic.
pub fn handle_event(
    conn: &Connection,
    vault: &VaultLayout,
    event: &VaultEvent,
    app: Option<&AppHandle>,
) -> Result<()> {
    match event {
        VaultEvent::BlockChanged(path) => {
            index_md_file(conn, vault, path, app)?;
        }
        VaultEvent::BlockDeleted(path) => {
            if let Some(slug) = path_to_slug(path) {
                // Snapshot the block's tag list BEFORE removing it so the
                // frontend can drop the preview from each affected channel.
                // After remove_block the tags are gone from the index.
                let tags = index::get_block(conn, &slug)
                    .ok()
                    .flatten()
                    .map(|b| b.tags)
                    .unwrap_or_default();
                index::remove_block(conn, &slug)?;
                if let Some(app) = app {
                    let _ = app.emit(
                        "block:removed",
                        BlockRemovedPayload {
                            slug: slug.clone(),
                            tags,
                        },
                    );
                    // Also fire thumb:updated so sidebars currently
                    // displaying this slug's thumb re-render (the cache
                    // bust will turn into a 404 → placeholder state).
                    let _ = app.emit("thumb:updated", ThumbUpdatedPayload { slug });
                }
            }
        }
        VaultEvent::MediaChanged(path) => {
            if let Some(slug) = path_to_slug(path) {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if thumbnails::is_image_ext(&ext) {
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

// Extension predicates (is_image_ext, is_video_ext) live in
// storage::thumbnails as the single source of truth.

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
        index_md_file(&conn, &vault, &path, None).unwrap();

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
        assert!(index_md_file(&conn, &vault, &path, None).is_err());
    }

    // ── handle_event ─────────────────────────────────────────────────────

    #[test]
    fn handle_block_changed() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();

        write_md_file(&vault, "note", "link", &[]);
        let path = vault.block_path("note");
        handle_event(&conn, &vault, &VaultEvent::BlockChanged(path), None).unwrap();

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
        index_md_file(&conn, &vault, &path, None).unwrap();

        // Then delete it
        handle_event(&conn, &vault, &VaultEvent::BlockDeleted(path), None).unwrap();
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
        handle_event(&conn, &vault, &VaultEvent::MediaDeleted(media_path), None).unwrap();
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
        // NOTE: thumbnails::is_image_ext expects already-lowercased ext.
        assert!(thumbnails::is_image_ext("jpg"));
        assert!(thumbnails::is_image_ext("png"));
        assert!(thumbnails::is_image_ext("webp"));
        assert!(!thumbnails::is_image_ext("mp4"));
        assert!(!thumbnails::is_image_ext("md"));
    }
}
