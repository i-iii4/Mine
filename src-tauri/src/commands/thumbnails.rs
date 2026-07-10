// Thumbnail commands: WebView ↔ Rust bridge for the two-phase pipeline.
//
// Phase 2 (see SPEC_THUMBNAILS.md) runs decoded JPEG bytes back from a
// Web Worker in the frontend into the vault cache via `save_thumb`, and
// enumerates pending upgrades at startup via `list_pending_thumb_upgrades`.
//
// Contract: SPEC_THUMBNAILS.md#contracts

use serde::Serialize;
use std::borrow::Cow;
use std::io::Write;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};
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
    /// Per-video gallery tile posters to (re)generate for this block, batched
    /// into the block's request so one upgrade pass decodes every video the
    /// card needs. Empty for non-gallery blocks. Each is decoded by the
    /// browser and saved via `save_tile_poster`. Note `slug`/`media_path`
    /// above may be empty when only tile posters are missing (the block thumb
    /// is already a real JPEG) — the frontend skips an empty `media_path`.
    #[serde(rename = "tilePosters")]
    pub tile_posters: Vec<TilePosterUpgrade>,
}

/// One per-video gallery tile poster to generate via the browser.
#[derive(Debug, Clone, Serialize)]
pub struct TilePosterUpgrade {
    /// Destination poster filename (`<media-stem>.jpg`) — the exact value
    /// carried in the tile's `preview_path`. Saved via `save_tile_poster`.
    #[serde(rename = "posterName")]
    pub poster_name: String,
    #[serde(rename = "mediaPath")]
    pub media_path: String,
    /// Always `"video"` today (image tiles render their source directly).
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
/// Transport: the JPEG travels as the raw IPC request body
/// (`application/octet-stream`), not a JSON number array, so a 40–80 KB
/// thumb no longer inflates ~4x into a JSON payload the main thread has to
/// build and Rust has to parse. `slug` rides in the percent-encoded
/// `x-slug` header (see `decode_header`).
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
    request: Request<'_>,
) -> Result<(), CommandError> {
    let slug = decode_header(&request, "x-slug")?;
    let bytes = request_jpeg_bytes(&request)?;
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

// ─── Binary IPC transport ─────────────────────────────────────────────────────

/// Percent-decode an IPC metadata header value into its original Unicode string.
///
/// The JPEG rides in the raw request body, so metadata (slug, poster name)
/// travels in request headers instead. HTTP header values are ASCII-only, yet
/// slugs are routinely Unicode (Cyrillic, symbols like `⊷`), so the frontend
/// percent-encodes them with `encodeURIComponent`. This reverses that.
fn percent_decode_header(name: &str, raw: &str) -> Result<String, CommandError> {
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .map_err(|_| CommandError::Internal(format!("{name} header is not valid UTF-8")))
}

/// Read a required metadata header off a raw-IPC request and percent-decode it.
fn decode_header(request: &Request<'_>, name: &str) -> Result<String, CommandError> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| CommandError::Internal(format!("missing {name} header")))?
        .to_str()
        .map_err(|_| CommandError::Internal(format!("{name} header value must be ASCII")))?;
    percent_decode_header(name, raw)
}

/// Extract the JPEG bytes carried as the raw IPC request body.
///
/// The desktop custom-protocol transport delivers them as `InvokeBody::Raw`
/// (the fast path — borrowed, zero-copy). The postMessage fallback, used only
/// when the custom protocol is unavailable (e.g. blocked by CSP), serializes
/// the payload to a JSON number array instead; accept that too so the command
/// stays transport-agnostic.
fn request_jpeg_bytes<'a>(request: &'a Request<'_>) -> Result<Cow<'a, [u8]>, CommandError> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes.as_slice())),
        InvokeBody::Json(value) => serde_json::from_value::<Vec<u8>>(value.clone())
            .map(Cow::Owned)
            .map_err(|_| CommandError::Internal("request body is not a JPEG byte array".into())),
    }
}

#[derive(Debug, Clone, Serialize)]
struct ThumbUpdatedPayload {
    slug: String,
    is_text: bool,
}

/// Write a decoded JPEG poster for a single gallery video tile into the vault
/// cache. `poster_name` is the tile's `preview_path` value (`<media-stem>.jpg`)
/// — a media filename, not a block slug, so it is validated as a plain
/// filename rather than via `validate_slug`. `slug` is the owning block, used
/// only to emit `thumb:updated` so its card refreshes the tile.
///
/// Transport mirrors `save_thumb`: the JPEG is the raw request body while
/// `poster_name` and `slug` ride in the percent-encoded `x-poster-name` and
/// `x-slug` headers.
#[tauri::command]
pub fn save_tile_poster(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<(), CommandError> {
    let poster_name = decode_header(&request, "x-poster-name")?;
    let slug = decode_header(&request, "x-slug")?;
    let bytes = request_jpeg_bytes(&request)?;
    validate_tile_poster_request(&poster_name, &bytes)?;

    let thumbs_dir = {
        let vault_state = state
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        vault_state
            .as_ref()
            .ok_or(CommandError::NoVault)?
            .vault
            .thumbs_dir()
    };

    std::fs::create_dir_all(&thumbs_dir)
        .map_err(|e| CommandError::Internal(format!("create thumbs dir: {e}")))?;
    let dest = thumbs_dir.join(&poster_name);

    // Atomic write: same-directory temp file then rename.
    let tmp_path = dest.with_extension("jpg.tmp");
    {
        let mut f = std::fs::File::create(&tmp_path)
            .map_err(|e| CommandError::Internal(format!("create tmp tile poster: {e}")))?;
        f.write_all(&bytes)
            .map_err(|e| CommandError::Internal(format!("write tmp tile poster: {e}")))?;
        f.sync_all()
            .map_err(|e| CommandError::Internal(format!("sync tmp tile poster: {e}")))?;
    }
    std::fs::rename(&tmp_path, &dest)
        .map_err(|e| CommandError::Internal(format!("rename tmp tile poster: {e}")))?;

    // The tile lives inside the block's card; refresh it.
    let _ = app.emit(
        "thumb:updated",
        ThumbUpdatedPayload {
            slug,
            is_text: false,
        },
    );
    Ok(())
}

fn validate_tile_poster_request(poster_name: &str, bytes: &[u8]) -> Result<(), CommandError> {
    // poster_name is a media-derived filename (spaces and parens allowed), not
    // a slug. Reject path separators, traversal, NUL, and non-`.jpg` names.
    if poster_name.is_empty()
        || poster_name.contains('/')
        || poster_name.contains('\\')
        || poster_name.contains('\0')
        || poster_name.contains("..")
        || !poster_name.ends_with(".jpg")
    {
        return Err(CommandError::Internal(format!(
            "save_tile_poster: unsafe poster name {poster_name:?}"
        )));
    }
    if bytes.len() < 3 || bytes[0] != 0xFF || bytes[1] != 0xD8 || bytes[2] != 0xFF {
        return Err(CommandError::Internal(
            "save_tile_poster: bytes are not a JPEG (missing FF D8 FF magic)".into(),
        ));
    }
    Ok(())
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
                // Block <slug>.jpg upgrade — only when the current thumb is not
                // already a real JPEG.
                let slug_upgrade = resolve_upgrade_media(&vault, block)
                    .filter(|_| needs_browser_thumb_upgrade(&vault, block));
                // Per-video gallery tile posters that are still missing. These
                // are independent of the block thumb: a block can have a real
                // <slug>.jpg yet still be missing its tile posters.
                let tile_posters = resolve_tile_posters(&vault, block);

                if slug_upgrade.is_none() && tile_posters.is_empty() {
                    continue;
                }

                let (media_path, kind) = slug_upgrade
                    .map(|(path, kind)| (path.to_string_lossy().into_owned(), kind.to_string()))
                    .unwrap_or_default();
                out.push(ThumbUpgradeRequest {
                    slug: block.slug.clone(),
                    media_path,
                    kind,
                    tile_posters,
                });
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
        if let Some(media_path) = resolve_block_reference(vault, &block.slug, file_name) {
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
            if let Some(media_path) = resolve_block_reference(vault, &block.slug, thumb_file) {
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
                    if let Some(media_path) = resolve_block_reference(vault, &block.slug, &url) {
                        return Some((media_path, "image"));
                    }
                }
                if thumbnails::is_video_ext(&ext) {
                    if let Some(media_path) = resolve_block_reference(vault, &block.slug, &url) {
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
            if let Some(media_path) = resolve_block_reference(vault, &block.slug, first_image) {
                return Some((media_path, "image"));
            }
        }
    }

    None
}

/// Resolve per-video gallery tile posters still missing for `block`. For each
/// video tile in the block's preview manifest whose `<media-stem>.jpg` poster
/// is not yet a real JPEG, return the destination poster name and the resolved
/// source video path for the browser to decode. Image tiles are skipped — they
/// render their real source directly.
fn resolve_tile_posters(
    vault: &crate::domain::vault::VaultLayout,
    block: &index::PendingThumbUpgradeBlock,
) -> Vec<TilePosterUpgrade> {
    let Some(ref manifest_json) = block.preview_manifest else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_str::<index::FeedPreviewManifest>(manifest_json) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for tile in &manifest.tiles {
        if !tile.is_video {
            continue;
        }
        // Derive the poster name from the source rather than `tile.preview_path`
        // so existing gallery blocks resolve too: their manifest predates
        // per-video posters and carries `preview_path: null`, but the backend
        // always names a video poster `<media-stem>.jpg`, matching the frontend.
        let poster_name = crate::storage::preview_plan::media_poster_path(&tile.source_path);
        // Skip posters already on disk as a real JPEG.
        let poster_path = vault.thumbs_dir().join(&poster_name);
        if matches!(
            thumbnails::thumb_disk_state(&poster_path),
            thumbnails::ThumbDiskState::Jpeg
        ) {
            continue;
        }
        if let Some(media_path) = resolve_block_reference(vault, &block.slug, &tile.source_path) {
            out.push(TilePosterUpgrade {
                poster_name,
                media_path: media_path.to_string_lossy().into_owned(),
                kind: "video".into(),
            });
        }
    }
    out
}

fn resolve_block_reference(
    vault: &crate::domain::vault::VaultLayout,
    slug: &str,
    reference: &str,
) -> Option<PathBuf> {
    crate::storage::media_refs::resolve_indexed_media(vault, slug, reference)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::domain::vault::VaultLayout;
    use crate::storage::{db, files, index, thumbnails};

    fn make_vault(path: &std::path::Path) -> VaultLayout {
        let vault = VaultLayout::new(path.to_path_buf());
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        vault
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
            preview_manifest: None,
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
            preview_manifest: None,
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
            preview_manifest: None,
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
            preview_manifest: None,
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
            preview_manifest: None,
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
            preview_manifest: None,
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

        thumbnails::generate_text_thumbnail(
            Some("poster"),
            "fallback",
            &vault.thumb_path("poster"),
        )
        .unwrap();
        // Simulate stale DB metadata claiming the thumb is already JPEG.
        conn.execute(
            "UPDATE blocks SET thumb_format = 'jpeg', thumb_mtime = 123 WHERE slug = 'poster'",
            [],
        )
        .unwrap();

        let candidates = index::list_pending_thumb_upgrade_blocks(&conn).unwrap();
        let target = candidates
            .iter()
            .find(|candidate| candidate.slug == "poster")
            .unwrap();
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
        assert!(
            validate_thumb_write_request("続きを描いてます", &[0xFF, 0xD8, 0xFF, 0x00]).is_ok()
        );
    }

    #[test]
    fn validate_thumb_write_request_rejects_path_traversal_and_separators() {
        assert!(validate_thumb_write_request("foo/bar", &[0xFF, 0xD8, 0xFF, 0x00]).is_ok());
        for slug in ["foo//bar", "foo\\bar", "..", "../x", ""] {
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

    // ── header percent-decode (binary IPC metadata) ──────────────────────

    #[test]
    fn percent_decode_header_roundtrips_cyrillic() {
        // encodeURIComponent("привет")
        assert_eq!(
            percent_decode_header("x-slug", "%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82").unwrap(),
            "привет"
        );
    }

    #[test]
    fn percent_decode_header_roundtrips_multibyte_symbol() {
        // encodeURIComponent("⊷") — U+22B7, a 3-byte UTF-8 sequence
        assert_eq!(percent_decode_header("x-slug", "%E2%8A%B7").unwrap(), "⊷");
    }

    #[test]
    fn percent_decode_header_roundtrips_spaces_and_bare_ascii() {
        assert_eq!(
            percent_decode_header("x-slug", "a%20b%20c").unwrap(),
            "a b c"
        );
        assert_eq!(
            percent_decode_header("x-slug", "plain-ascii_slug").unwrap(),
            "plain-ascii_slug"
        );
    }

    #[test]
    fn percent_decode_header_roundtrips_poster_filename_with_parens() {
        // encodeURIComponent("clip (video 1).jpg") — parens stay literal, space → %20
        assert_eq!(
            percent_decode_header("x-poster-name", "clip%20(video%201).jpg").unwrap(),
            "clip (video 1).jpg"
        );
    }

    #[test]
    fn percent_decode_header_rejects_invalid_utf8() {
        // %FF %FE is not a valid UTF-8 sequence
        assert!(percent_decode_header("x-slug", "%FF%FE").is_err());
    }

    // ── tile posters ─────────────────────────────────────────────────────

    #[test]
    fn validate_tile_poster_request_accepts_media_filename() {
        assert!(
            validate_tile_poster_request("clip (video 1).jpg", &[0xFF, 0xD8, 0xFF, 0x00]).is_ok()
        );
    }

    #[test]
    fn validate_tile_poster_request_rejects_unsafe_names_and_non_jpeg() {
        for name in ["../x.jpg", "a/b.jpg", "a\\b.jpg", "x.png", "", "foo\0.jpg"] {
            assert!(
                validate_tile_poster_request(name, &[0xFF, 0xD8, 0xFF, 0x00]).is_err(),
                "should reject {name:?}"
            );
        }
        // valid name, but not JPEG bytes
        assert!(validate_tile_poster_request("x.jpg", &[0x89, 0x50, 0x4E]).is_err());
    }

    #[test]
    fn resolve_tile_posters_returns_video_tiles_missing_posters() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        std::fs::write(dir.path().join("clip-a.mp4"), b"fake").unwrap();
        std::fs::write(dir.path().join("clip-b.mp4"), b"fake").unwrap();

        let manifest = serde_json::json!({
            "kind": "composite",
            "primary_preview_path": "g.jpg",
            "width": 1, "height": 1,
            "tiles": [
                {"source_path": "clip-a.mp4", "preview_path": "clip-a.jpg", "width": 800, "height": 600, "is_video": true, "is_video_poster": false},
                {"source_path": "still.jpg", "preview_path": null, "width": 800, "height": 600, "is_video": false, "is_video_poster": false},
                {"source_path": "clip-b.mp4", "preview_path": "clip-b.jpg", "width": 800, "height": 600, "is_video": true, "is_video_poster": false}
            ],
            "overflow_count": 0
        })
        .to_string();

        let block = index::PendingThumbUpgradeBlock {
            slug: "g".into(),
            media_file: None,
            thumbnail: None,
            first_image: None,
            media_urls: Some(r#"["clip-a.mp4","still.jpg","clip-b.mp4"]"#.into()),
            preview_manifest: Some(manifest),
        };

        let posters = resolve_tile_posters(&vault, &block);
        // Only the two video tiles; the image tile is skipped.
        assert_eq!(posters.len(), 2);
        assert_eq!(posters[0].poster_name, "clip-a.jpg");
        assert_eq!(posters[1].poster_name, "clip-b.jpg");
        assert!(posters.iter().all(|p| p.kind == "video"));
    }

    #[test]
    fn resolve_tile_posters_skips_existing_jpeg_poster() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        std::fs::write(dir.path().join("clip-a.mp4"), b"fake").unwrap();
        // Poster already on disk as a real JPEG.
        create_test_image(&vault.thumbs_dir().join("clip-a.jpg"), 80, 60);

        let manifest = serde_json::json!({
            "kind": "video_poster",
            "primary_preview_path": "g.jpg",
            "width": 1, "height": 1,
            "tiles": [
                {"source_path": "clip-a.mp4", "preview_path": "clip-a.jpg", "width": 800, "height": 600, "is_video": true, "is_video_poster": false}
            ],
            "overflow_count": 0
        })
        .to_string();

        let block = index::PendingThumbUpgradeBlock {
            slug: "g".into(),
            media_file: None,
            thumbnail: None,
            first_image: None,
            media_urls: Some(r#"["clip-a.mp4"]"#.into()),
            preview_manifest: Some(manifest),
        };

        assert!(resolve_tile_posters(&vault, &block).is_empty());
    }
}
