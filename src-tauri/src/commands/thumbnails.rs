// Thumbnail commands: WebView ↔ Rust bridge for the two-phase pipeline.
//
// Phase 2 (see SPEC_THUMBNAILS.md) runs decoded JPEG bytes back from a
// Web Worker in the frontend into the vault cache via `save_thumb`, and
// enumerates pending upgrades at startup via `list_pending_thumb_upgrades`.
//
// Contract: SPEC_THUMBNAILS.md#contracts

use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

use crate::commands::state::{AppState, CommandError};
use crate::domain::vault::validate_slug;
use crate::storage::{db, index, thumbnails};

// ─── Types ──────────────────────────────────────────────────────────────────

/// One entry in the startup upgrade queue. Describes a block whose current
/// on-disk thumb is a text placeholder (PNG) but whose block metadata or
/// body references an embedded media file that a browser decoder can
/// render.
#[derive(Debug, Clone, Serialize)]
pub struct ThumbUpgradeRequest {
    pub slug: String,
    /// Absolute path to the media file on disk. Frontend uses
    /// `convertFileSrc` to turn it into an `asset://` URL that `fetch()`
    /// can pull into the worker.
    #[serde(rename = "mediaPath")]
    pub media_path: String,
    /// `"image"` or `"video"` — tells the worker which decoder branch to
    /// use (`createImageBitmap` vs `<video>` frame capture).
    pub kind: String,
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Write a decoded JPEG thumbnail for `slug` into the vault cache.
///
/// Called by the frontend after a Web Worker decodes a media file that
/// Rust's `image` crate can't handle (VP8X WebP, HEIC, AVIF, HEVC video
/// frame, …). The worker does the actual decode via `createImageBitmap`
/// / `<video>` + `OffscreenCanvas.convertToBlob('image/jpeg', 0.85)`,
/// then ships the resulting bytes here.
///
/// Preconditions enforced in code:
///   - Vault is open
///   - `slug` is a safe filename stem (`validate_slug`)
///   - `bytes` starts with JPEG magic (FF D8 FF)
///
/// Writes atomically (temp file + rename) so a concurrent read of the
/// thumb from the sidebar never sees a half-written file. Emits
/// `thumb:updated { slug }` on success so any `<img>` element pointing
/// at `<slug>.jpg` can cache-bust itself.
#[tauri::command]
pub fn save_thumb(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
    bytes: Vec<u8>,
) -> Result<(), CommandError> {
    validate_thumb_write_request(&slug, &bytes)?;

    let (thumb_path, db_path, vault_root) = {
        let vault_state = state
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
        (
            vs.vault.thumb_path(&slug),
            vs.vault.index_db_path(),
            vs.vault.root().to_path_buf(),
        )
    };

    if let Some(parent) = thumb_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CommandError::Internal(format!("create thumbs dir: {}", e)))?;
    }

    // Atomic write: temp file in the same directory, then rename.
    // Same-directory rename is atomic on every filesystem we care about,
    // so the cache never observes a partial file.
    let tmp_path = thumb_path.with_extension("jpg.tmp");
    {
        let mut f = std::fs::File::create(&tmp_path)
            .map_err(|e| CommandError::Internal(format!("create tmp thumb: {}", e)))?;
        f.write_all(&bytes)
            .map_err(|e| CommandError::Internal(format!("write tmp thumb: {}", e)))?;
        f.sync_all()
            .map_err(|e| CommandError::Internal(format!("sync tmp thumb: {}", e)))?;
    }
    std::fs::rename(&tmp_path, &thumb_path)
        .map_err(|e| CommandError::Internal(format!("rename tmp thumb: {}", e)))?;

    let conn = db::open_or_create(&db_path)
        .map_err(|e| CommandError::Internal(format!("open thumb metadata db: {e:#}")))?;
    index::sync_thumb_metadata(&conn, &slug, &thumb_path, Some(&vault_root))
        .map_err(|e| CommandError::Internal(format!("sync_thumb_metadata: {e:#}")))?;

    // save_thumb always writes JPEG — never a text placeholder.
    let _ = app.emit(
        "thumb:updated",
        ThumbUpdatedPayload {
            slug,
            is_text: false,
        },
    );
    Ok(())
}

fn validate_thumb_write_request(slug: &str, bytes: &[u8]) -> Result<(), CommandError> {
    validate_slug(slug).map_err(|e| CommandError::Internal(e.to_string()))?;

    if bytes.len() < 3 || bytes[0] != 0xFF || bytes[1] != 0xD8 || bytes[2] != 0xFF {
        return Err(CommandError::Internal(
            "save_thumb: bytes are not a JPEG (missing FF D8 FF magic)".into(),
        ));
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize)]
struct ThumbUpdatedPayload {
    slug: String,
    is_text: bool,
}

/// Enumerate every indexed block whose current on-disk thumb is missing or
/// is not a real JPEG, and which references media the browser can decode.
/// Returned list is what the frontend feeds into the worker queue at startup
/// — each entry is a pending Phase 2 upgrade.
///
/// Runs in `spawn_blocking` and re-opens SQLite from disk, so the startup
/// backlog scan never blocks the WebView/main thread.
///
/// Blocks without embedded media (pure-text articles) are skipped —
/// the text placeholder IS the final thumb for them, there's nothing
/// better we could produce.
#[tauri::command]
pub async fn list_pending_thumb_upgrades(
    state: State<'_, AppState>,
) -> Result<Vec<ThumbUpgradeRequest>, CommandError> {
    let vault = {
        let vault_state = state
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        vault_state
            .as_ref()
            .ok_or(CommandError::NoVault)?
            .vault
            .clone()
    };

    let db_path = vault.index_db_path();
    let requests = tauri::async_runtime::spawn_blocking(
        move || -> Result<Vec<ThumbUpgradeRequest>, CommandError> {
            let conn = db::open_or_create(&db_path)
                .map_err(|e| CommandError::Internal(format!("open thumb upgrade db: {e:#}")))?;
            let blocks = index::list_pending_thumb_upgrade_blocks(&conn).map_err(|e| {
                CommandError::Internal(format!("list_pending_thumb_upgrade_blocks: {e:#}"))
            })?;

            let mut out: Vec<ThumbUpgradeRequest> = Vec::new();
            for block in &blocks {
                if let Some((media_path, kind)) = resolve_upgrade_media(&vault, block) {
                    if !needs_browser_thumb_upgrade(&vault, block) {
                        continue;
                    }
                    out.push(ThumbUpgradeRequest {
                        slug: block.slug.clone(),
                        media_path: media_path.to_string_lossy().into_owned(),
                        kind: kind.into(),
                    });
                }
            }

            log::info!("list_pending_thumb_upgrades: {} block(s) queued", out.len());
            Ok(out)
        },
    )
    .await
    .map_err(|e| CommandError::Internal(format!("list_pending_thumb_upgrades join: {e}")))??;

    Ok(requests)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn needs_browser_thumb_upgrade(
    vault: &crate::domain::vault::VaultLayout,
    block: &index::PendingThumbUpgradeBlock,
) -> bool {
    !matches!(
        thumbnails::thumb_disk_state(&vault.thumb_path(&block.slug)),
        thumbnails::ThumbDiskState::Jpeg
    )
}

/// Resolve which media file should replace a text placeholder for `block`.
/// Mirrors the cascade priority in `storage::thumbnails::generate_for_block`,
/// so Phase 2 upgrades the same source Rust would have used if it had a
/// capable decoder. Returns `None` for pure-text blocks (nothing to upgrade).
fn resolve_upgrade_media(
    vault: &crate::domain::vault::VaultLayout,
    block: &index::PendingThumbUpgradeBlock,
) -> Option<(PathBuf, &'static str)> {
    // 1. frontmatter.file — explicit media for image/video blocks
    if let Some(ref file_name) = block.media_file {
        let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
        let media_path = vault.root().join(file_name);
        if media_path.exists() {
            if thumbnails::is_image_ext(&ext) {
                return Some((media_path, "image"));
            }
            if thumbnails::is_video_ext(&ext) {
                return Some((media_path, "video"));
            }
        }
    }

    // 2. frontmatter.thumbnail — video poster / OG image for link blocks
    if let Some(ref thumb_file) = block.thumbnail {
        let ext = thumb_file.rsplit('.').next().unwrap_or("").to_lowercase();
        if thumbnails::is_image_ext(&ext) {
            let media_path = vault.root().join(thumb_file);
            if media_path.exists() {
                return Some((media_path, "image"));
            }
        }
    }

    // 3. First local media from indexed media_urls in markdown order —
    //    article branch. Video-first social posts must upgrade the same
    //    source that the feed playback uses, even when later images exist.
    if let Some(ref media_urls) = block.media_urls {
        if let Ok(urls) = serde_json::from_str::<Vec<String>>(media_urls) {
            for url in urls {
                let ext = url.rsplit('.').next().unwrap_or("").to_lowercase();
                if thumbnails::is_image_ext(&ext) {
                    let media_path = vault.root().join(&url);
                    if media_path.exists() {
                        return Some((media_path, "image"));
                    }
                }
                if thumbnails::is_video_ext(&ext) {
                    let media_path = vault.root().join(&url);
                    if media_path.exists() {
                        return Some((media_path, "video"));
                    }
                }
            }
        }
    }

    // 4. Legacy indexes may only have first_image populated.
    if let Some(ref first_image) = block.first_image {
        let ext = first_image.rsplit('.').next().unwrap_or("").to_lowercase();
        if thumbnails::is_image_ext(&ext) {
            let media_path = vault.root().join(first_image);
            if media_path.exists() {
                return Some((media_path, "image"));
            }
        }
    }

    None
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::domain::vault::VaultLayout;
    use crate::storage::{db, files, index, thumbnails};

    fn make_vault(path: &std::path::Path) -> VaultLayout {
        std::fs::create_dir_all(path.join(".arena/cache/thumbs")).unwrap();
        VaultLayout::new(path.to_path_buf())
    }

    fn create_test_image(path: &std::path::Path, width: u32, height: u32) {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb([120, 180, 200]));
        img.save(path).unwrap();
    }

    fn write_block(vault: &VaultLayout, conn: &rusqlite::Connection, block: Block) {
        files::write_block_file(vault, &block).unwrap();
        index::upsert_block(conn, &block, Some(vault.root())).unwrap();
    }

    fn make_article(slug: &str, body: &str) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: Some(slug.into()),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: vec![],
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-01-15T12:00:00Z").unwrap(),
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

    // ── resolve_upgrade_media ────────────────────────────────────────────

    #[test]
    fn resolve_upgrade_media_picks_body_image_for_article() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        // Write a WebP body-image next to the article
        let webp = dir.path().join("artx-img0.webp");
        std::fs::write(&webp, b"RIFF\x00\x00\x00\x00WEBPVP8X").unwrap();

        let target = index::PendingThumbUpgradeBlock {
            slug: "artx".into(),
            media_file: None,
            thumbnail: None,
            first_image: Some("artx-img0.webp".into()),
            media_urls: Some(r#"["artx-img0.webp"]"#.into()),
        };
        let resolved = resolve_upgrade_media(&vault, &target);
        let (path, kind) = resolved.expect("must resolve");
        assert_eq!(kind, "image");
        assert_eq!(path, webp);
    }

    #[test]
    fn resolve_upgrade_media_none_for_pure_text() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let target = index::PendingThumbUpgradeBlock {
            slug: "pure".into(),
            media_file: None,
            thumbnail: None,
            first_image: None,
            media_urls: None,
        };

        assert!(resolve_upgrade_media(&vault, &target).is_none());
    }

    #[test]
    fn resolve_upgrade_media_skips_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let target = index::PendingThumbUpgradeBlock {
            slug: "ghost".into(),
            media_file: None,
            thumbnail: None,
            first_image: Some("ghost-img0.heic".into()),
            media_urls: Some(r#"["ghost-img0.heic"]"#.into()),
        };

        assert!(resolve_upgrade_media(&vault, &target).is_none());
    }

    // ── integration: full cascade + DB-backed pending detection ─────────

    #[test]
    fn full_pipeline_article_with_webp_lands_in_upgrade_queue() {
        // Simulate the real Phase A → Phase B boundary:
        //   1. Article with WebP body image gets indexed
        //   2. generate_for_block falls through to text placeholder (PNG)
        //   3. sync_thumb_metadata marks it as PNG in SQLite
        //   4. resolve_upgrade_media finds the WebP
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let conn = db::open_memory().unwrap();

        let webp = dir.path().join("art-img0.webp");
        std::fs::write(&webp, b"RIFF\x00\x00\x00\x00WEBPVP8X\x00\x00\x00\x00").unwrap();

        let block = make_article("art", "![](art-img0.webp)");
        write_block(&vault, &conn, block.clone());

        // Phase 1 cascade — writes text placeholder (PNG) to thumb_path
        let src = thumbnails::generate_for_block(&block, &vault);
        assert_eq!(src, thumbnails::ThumbSource::Text);

        let thumb = vault.thumb_path("art");
        index::sync_thumb_metadata(&conn, "art", &thumb, Some(vault.root())).unwrap();

        // Phase B startup enumeration must pick it up
        let light = index::list_pending_thumb_upgrade_blocks(&conn).unwrap();
        let target = light.iter().find(|b| b.slug == "art").unwrap();
        let (path, kind) = resolve_upgrade_media(&vault, target).unwrap();
        assert_eq!(kind, "image");
        assert_eq!(path, webp);
        assert!(needs_browser_thumb_upgrade(&vault, target));
    }

    #[test]
    fn resolve_upgrade_media_picks_video_from_indexed_media_urls() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let conn = db::open_memory().unwrap();

        let video = dir.path().join("clip.mp4");
        std::fs::write(&video, b"fake mp4").unwrap();

        let block = make_article("clip", "text\n\n![](clip.mp4)\n\nmore");
        write_block(&vault, &conn, block.clone());
        let _ = thumbnails::generate_for_block(&block, &vault);
        index::sync_thumb_metadata(&conn, "clip", &vault.thumb_path("clip"), Some(vault.root()))
            .unwrap();

        let light = index::list_pending_thumb_upgrade_blocks(&conn).unwrap();
        let target = light.iter().find(|b| b.slug == "clip").unwrap();

        let (path, kind) = resolve_upgrade_media(&vault, target).unwrap();
        assert_eq!(kind, "video");
        assert_eq!(path, video);
    }

    #[test]
    fn resolve_upgrade_media_preserves_media_urls_order_for_video_first_article() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        let video = dir.path().join("clip.mp4");
        let image = dir.path().join("later.jpg");
        std::fs::write(&video, b"fake mp4").unwrap();
        create_test_image(&image, 100, 100);

        let block = index::PendingThumbUpgradeBlock {
            slug: "clip".into(),
            media_file: None,
            thumbnail: None,
            first_image: Some("later.jpg".into()),
            media_urls: Some(r#"["clip.mp4","later.jpg"]"#.into()),
        };

        let (path, kind) = resolve_upgrade_media(&vault, &block).unwrap();
        assert_eq!(kind, "video");
        assert_eq!(path, video);
    }

    #[test]
    fn needs_browser_thumb_upgrade_rejects_real_jpeg_thumb() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let media = dir.path().join("poster.avif");
        std::fs::write(&media, b"fake avif").unwrap();
        let src_png = dir.path().join("src.png");
        create_test_image(&src_png, 100, 100);
        thumbnails::generate_thumbnail(&src_png, &vault.thumb_path("poster"), 240).unwrap();

        let block = index::PendingThumbUpgradeBlock {
            slug: "poster".into(),
            media_file: Some("poster.avif".into()),
            thumbnail: None,
            first_image: None,
            media_urls: None,
        };

        assert!(!needs_browser_thumb_upgrade(&vault, &block));
    }

    #[test]
    fn needs_browser_thumb_upgrade_accepts_missing_thumb() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let media = dir.path().join("poster.avif");
        std::fs::write(&media, b"fake avif").unwrap();

        let block = index::PendingThumbUpgradeBlock {
            slug: "poster".into(),
            media_file: Some("poster.avif".into()),
            thumbnail: None,
            first_image: None,
            media_urls: None,
        };

        assert!(needs_browser_thumb_upgrade(&vault, &block));
    }

    #[test]
    fn list_pending_thumb_upgrades_queues_stale_png_for_image_block_even_if_db_was_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let conn = db::open_memory().unwrap();

        std::fs::write(dir.path().join("poster.avif"), b"fake avif").unwrap();
        let block = Block {
            slug: "poster".into(),
            frontmatter: Frontmatter {
                block_type: BlockType::Image,
                title: Some("poster".into()),
                description: None,
                url: None,
                file: Some("poster.avif".into()),
                thumbnail: None,
                tags: vec![],
                related_notes: Vec::new(),
                source_media: None,
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
        write_block(&vault, &conn, block);

        thumbnails::generate_text_thumbnail(Some("poster"), "fallback", &vault.thumb_path("poster"))
            .unwrap();
        // Simulate stale DB metadata claiming the thumb is already JPEG.
        conn.execute(
            "UPDATE blocks SET thumb_format = 'jpeg', thumb_mtime = 123 WHERE slug = 'poster'",
            [],
        )
        .unwrap();

        let candidates = index::list_pending_thumb_upgrade_blocks(&conn).unwrap();
        let target = candidates.iter().find(|candidate| candidate.slug == "poster").unwrap();
        let (path, kind) = resolve_upgrade_media(&vault, target).unwrap();

        assert_eq!(kind, "image");
        assert_eq!(path, dir.path().join("poster.avif"));
        assert!(needs_browser_thumb_upgrade(&vault, target));
    }

    #[test]
    fn validate_thumb_write_request_accepts_human_readable_slug() {
        let slug = "Announcing USVC AngelList exists to power the innovation economy. To date, we";
        assert!(validate_thumb_write_request(slug, &[0xFF, 0xD8, 0xFF, 0x00]).is_ok());
    }

    #[test]
    fn validate_thumb_write_request_accepts_unicode_slug() {
        assert!(validate_thumb_write_request("続きを描いてます", &[0xFF, 0xD8, 0xFF, 0x00]).is_ok());
    }

    #[test]
    fn validate_thumb_write_request_rejects_path_traversal_and_separators() {
        for slug in ["foo/bar", "foo\\bar", "..", "../x", ""] {
            assert!(validate_thumb_write_request(slug, &[0xFF, 0xD8, 0xFF, 0x00]).is_err());
        }
    }

    #[test]
    fn validate_thumb_write_request_rejects_nul_byte() {
        assert!(validate_thumb_write_request("foo\0bar", &[0xFF, 0xD8, 0xFF, 0x00]).is_err());
    }

    #[test]
    fn validate_thumb_write_request_rejects_non_jpeg_bytes() {
        assert!(validate_thumb_write_request("valid slug", &[0x89, 0x50, 0x4E]).is_err());
    }
}
