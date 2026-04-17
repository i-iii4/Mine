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
///   - `slug` matches `^[a-zA-Z0-9_-]+$` (no path traversal, no separators)
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
    // Slug validation — prevent path traversal and unexpected separators.
    if slug.is_empty() || !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(CommandError::Internal(format!("invalid slug: {}", slug)));
    }

    // Magic byte check — reject anything that isn't a real JPEG. Protects
    // the cache from corrupt bytes and enforces the contract that thumbs
    // written through this path are always decodable JPEGs.
    if bytes.len() < 3 || bytes[0] != 0xFF || bytes[1] != 0xD8 || bytes[2] != 0xFF {
        return Err(CommandError::Internal(
            "save_thumb: bytes are not a JPEG (missing FF D8 FF magic)".into(),
        ));
    }

    let (thumb_path, db_path) = {
        let vault_state = state
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
        (vs.vault.thumb_path(&slug), vs.vault.index_db_path())
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
    index::sync_thumb_metadata(&conn, &slug, &thumb_path)
        .map_err(|e| CommandError::Internal(format!("sync_thumb_metadata: {e:#}")))?;

    // save_thumb always writes JPEG — never a text placeholder.
    let _ = app.emit("thumb:updated", ThumbUpdatedPayload { slug, is_text: false });
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
struct ThumbUpdatedPayload {
    slug: String,
    is_text: bool,
}

/// Enumerate every indexed block whose on-disk thumb is a text placeholder
/// (PNG magic bytes) but which references an embedded media file the
/// browser can decode. Returned list is what the frontend feeds into the
/// worker queue at startup — each entry is a pending Phase 2 upgrade.
///
/// Detection strategy:
///   1. Walk `list_blocks_light` (already ordered by saved_at desc — the
///      newest blocks upgrade first, which matches visual priority in
///      the sidebar).
///   2. For each block, peek the first 3 bytes of its thumb file. Skip
///      if no thumb (nothing to upgrade), skip if JPEG (already a real
///      image), proceed only on PNG (= text placeholder written by
///      `generate_text_thumbnail`).
///   3. Resolve which media file the upgrade should render. Priority:
///      `frontmatter.file` (image blocks) → `frontmatter.thumbnail` (link
///      OG image, video poster) → first local `![](...)` in body (article
///      branch). Same priority order as `generate_for_block`'s cascade,
///      so the upgrade replaces the placeholder with the same media that
///      Rust would have used if it could decode it.
///   4. Classify as image or video by file extension, using the single
///      source of truth (`is_image_ext` / `is_video_ext`).
///
/// Blocks without embedded media (pure-text articles) are skipped —
/// the text placeholder IS the final thumb for them, there's nothing
/// better we could produce.
#[tauri::command]
pub fn list_pending_thumb_upgrades(
    state: State<'_, AppState>,
) -> Result<Vec<ThumbUpgradeRequest>, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let blocks = index::list_blocks_light(&vs.conn)
        .map_err(|e| CommandError::Internal(format!("list_blocks_light: {}", e)))?;

    let mut out: Vec<ThumbUpgradeRequest> = Vec::new();
    for b in &blocks {
        // Skip blocks without a valid slug (corrupt index rows) and
        // channel rows (they don't render thumbs in the sidebar).
        // `vault.thumb_path("")` panics, so filtering here is load-bearing.
        if b.slug.is_empty() || b.block_type == crate::domain::block::BlockType::Channel {
            continue;
        }
        let thumb_path = vs.vault.thumb_path(&b.slug);
        if !is_png_placeholder(&thumb_path) {
            continue;
        }
        if let Some((media_path, kind)) = resolve_upgrade_media(&vs.vault, b) {
            out.push(ThumbUpgradeRequest {
                slug: b.slug.clone(),
                media_path: media_path.to_string_lossy().into_owned(),
                kind: kind.into(),
            });
        }
    }

    log::info!("list_pending_thumb_upgrades: {} block(s) queued", out.len());
    Ok(out)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Peek the first three bytes of a file and check whether it is PNG.
/// Returns `false` on any I/O error (missing, unreadable, too short) —
/// caller treats those as "no placeholder here, skip".
fn is_png_placeholder(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 3];
    if f.read_exact(&mut buf).is_err() {
        return false;
    }
    // PNG magic: 89 50 4E (\x89 P N). JPEG would be FF D8 FF, which
    // `generate_for_block` writes when Rust decode succeeded — we
    // deliberately skip those.
    buf == [0x89, 0x50, 0x4E]
}

/// Resolve which media file should replace a text placeholder for `block`.
/// Mirrors the cascade priority in `storage::thumbnails::generate_for_block`,
/// so Phase 2 upgrades the same source Rust would have used if it had a
/// capable decoder. Returns `None` for pure-text blocks (nothing to upgrade).
fn resolve_upgrade_media(
    vault: &crate::domain::vault::VaultLayout,
    block: &index::LightBlock,
) -> Option<(PathBuf, &'static str)> {
    // 1. frontmatter.file — explicit media for image/video blocks
    if let Some(ref file_name) = block.media_file {
        let ext = file_name
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_lowercase();
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

    // 3. First local `![](...)` image in body — article branch
    if let Some(ref first_image) = block.first_image {
        let ext = first_image
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_lowercase();
        if thumbnails::is_image_ext(&ext) {
            let media_path = vault.root().join(first_image);
            if media_path.exists() {
                return Some((media_path, "image"));
            }
        }
    }

    // 4. First local video in body — article branch. `first_image` is
    //    image-only; we need a fresh scan of the body for video.
    if let Some(first_video) = thumbnails::find_first_local_media(&block.body, thumbnails::is_video_ext) {
        let media_path = vault.root().join(&first_video);
        if media_path.exists() {
            return Some((media_path, "video"));
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

    // ── is_png_placeholder ───────────────────────────────────────────────

    #[test]
    fn is_png_placeholder_true_for_png_false_for_jpeg_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.jpg");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n").unwrap();
        assert!(is_png_placeholder(&png));

        let jpg = dir.path().join("b.jpg");
        std::fs::write(&jpg, b"\xFF\xD8\xFFsome jpeg").unwrap();
        assert!(!is_png_placeholder(&jpg));

        assert!(!is_png_placeholder(&dir.path().join("does-not-exist")));
    }

    // ── resolve_upgrade_media ────────────────────────────────────────────

    #[test]
    fn resolve_upgrade_media_picks_body_image_for_article() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let conn = db::open_memory().unwrap();

        // Write a WebP body-image next to the article
        let webp = dir.path().join("artx-img0.webp");
        std::fs::write(&webp, b"RIFF\x00\x00\x00\x00WEBPVP8X").unwrap();

        let block = make_article("artx", "text\n\n![](artx-img0.webp)\n\nmore");
        write_block(&vault, &conn, block);

        let light = index::list_blocks_light(&conn).unwrap();
        let target = light.iter().find(|b| b.slug == "artx").unwrap();

        let resolved = resolve_upgrade_media(&vault, target);
        let (path, kind) = resolved.expect("must resolve");
        assert_eq!(kind, "image");
        assert_eq!(path, webp);
    }

    #[test]
    fn resolve_upgrade_media_none_for_pure_text() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let conn = db::open_memory().unwrap();

        let block = make_article("pure", "just text, no media at all.");
        write_block(&vault, &conn, block);

        let light = index::list_blocks_light(&conn).unwrap();
        let target = light.iter().find(|b| b.slug == "pure").unwrap();

        assert!(resolve_upgrade_media(&vault, target).is_none());
    }

    #[test]
    fn resolve_upgrade_media_skips_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let conn = db::open_memory().unwrap();

        // Article references a file that doesn't exist on disk
        let block = make_article("ghost", "![](ghost-img0.heic)");
        write_block(&vault, &conn, block);

        let light = index::list_blocks_light(&conn).unwrap();
        let target = light.iter().find(|b| b.slug == "ghost").unwrap();

        assert!(resolve_upgrade_media(&vault, target).is_none());
    }

    // ── integration: full cascade + placeholder detection ───────────────

    #[test]
    fn full_pipeline_article_with_webp_lands_in_upgrade_queue() {
        // Simulate the real Phase A → Phase B boundary:
        //   1. Article with WebP body image gets indexed
        //   2. generate_for_block falls through to text placeholder (PNG)
        //   3. is_png_placeholder detects it
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
        assert!(is_png_placeholder(&thumb));

        // Phase B startup enumeration must pick it up
        let light = index::list_blocks_light(&conn).unwrap();
        let target = light.iter().find(|b| b.slug == "art").unwrap();
        let (path, kind) = resolve_upgrade_media(&vault, target).unwrap();
        assert_eq!(kind, "image");
        assert_eq!(path, webp);
    }
}
