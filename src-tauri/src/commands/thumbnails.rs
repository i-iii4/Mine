// Thumbnail commands: WebView ↔ Rust bridge for the two-phase pipeline.
//
// Phase 2 (see SPEC_THUMBNAILS.md) runs decoded JPEG bytes back from a
// Web Worker in the frontend into the vault cache via `save_thumb`, and
// enumerates pending upgrades at startup via `list_pending_thumb_upgrades`.
//
// Contract: SPEC_THUMBNAILS.md#contracts

use serde::Serialize;
use std::borrow::Cow;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, State};

use crate::commands::state::{schedule_preview_reconcile, AppState, CommandError};
use crate::domain::vault::validate_slug;
use crate::storage::preview_plan::{resolve_upgrade_media, PreviewUpgradeInput};
use crate::storage::{db, files, index, thumbnails};

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
    /// `"image"` or `"video"`, selecting the browser decoder branch.
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
    let thumb_path = vault.thumb_path(&slug);

    if let Some(parent) = thumb_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CommandError::Internal(format!("create thumbs dir: {}", e)))?;
    }

    files::write_atomically(&thumb_path, &bytes)
        .map_err(|e| CommandError::Internal(format!("write decoded thumb: {e:#}")))?;

    // The WebView upgrade replaces the full thumbnail, so the reduced levels
    // beside it now describe the old picture. Rewriting them here keeps every
    // surface on the same image, whichever level it reads.
    thumbnails::generate_thumb_levels(&vault, &slug);

    let conn = db::open_or_create(&vault.index_db_path())
        .map_err(|e| CommandError::Internal(format!("open thumb metadata db: {e:#}")))?;
    index::sync_thumb_metadata(&conn, &slug, &thumb_path, Some(vault.root()))
        .map_err(|e| CommandError::Internal(format!("sync_thumb_metadata: {e:#}")))?;
    schedule_preview_reconcile(&app, vault, [slug.clone()], false)?;

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
    validate_slug(&slug).map_err(|error| CommandError::Internal(error.to_string()))?;

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
    let thumbs_dir = vault.thumbs_dir();
    let conn = db::open_or_create(&vault.index_db_path())
        .map_err(|error| CommandError::Internal(format!("open preview metadata db: {error:#}")))?;
    validate_tile_destination(&conn, &slug, &poster_name)?;

    let dest = thumbs_dir.join(&poster_name);
    // The destination mirrors the block's own folder, so the parent is not
    // necessarily the thumbs root.
    let dest_dir = dest.parent().unwrap_or(&thumbs_dir);
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| CommandError::Internal(format!("create thumbs dir: {e}")))?;

    files::write_atomically(&dest, &bytes)
        .map_err(|e| CommandError::Internal(format!("write decoded tile poster: {e:#}")))?;
    schedule_preview_reconcile(&app, vault, [slug.clone()], false)?;

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

fn validate_tile_destination(
    conn: &rusqlite::Connection,
    slug: &str,
    poster_name: &str,
) -> Result<(), CommandError> {
    let block = index::get_block(conn, slug)
        .map_err(|error| CommandError::Internal(format!("load preview owner: {error:#}")))?
        .ok_or_else(|| CommandError::Internal(format!("preview owner not found: {slug}")))?;
    let manifest = block
        .preview_manifest
        .as_deref()
        .and_then(|raw| serde_json::from_str::<index::FeedPreviewManifest>(raw).ok())
        .ok_or_else(|| CommandError::Internal(format!("preview manifest missing for {slug}")))?;
    if !manifest
        .tiles
        .iter()
        .any(|tile| tile.preview_path.as_deref() == Some(poster_name))
    {
        return Err(CommandError::Internal(format!(
            "preview destination {poster_name:?} does not belong to {slug:?}"
        )));
    }
    Ok(())
}

fn validate_tile_poster_request(poster_name: &str, bytes: &[u8]) -> Result<(), CommandError> {
    // poster_name is a preview destination derived from the block slug, so it
    // carries the block's folder: `Cards/Note.preview-1.jpg`. Forbidding the
    // separator outright — as this used to — rejected every card that lives in
    // a subfolder, which is every card in a vault laid out into Cards/ and
    // Media/. What must stay forbidden is escaping the thumbs directory:
    // traversal, absolute paths, backslashes and NUL. Ownership is a separate
    // gate: `validate_tile_destination` requires the name to be exactly what
    // the block's own manifest asks for.
    if poster_name.is_empty()
        || poster_name.starts_with('/')
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
                let slug_upgrade = resolve_upgrade_media(
                    &vault,
                    PreviewUpgradeInput {
                        slug: &block.slug,
                        media_file: block.media_file.as_deref(),
                        thumbnail: block.thumbnail.as_deref(),
                        media_urls: block.media_urls.as_deref(),
                        first_image: block.first_image.as_deref(),
                    },
                )
                .map(|media| (media.path, media.kind.as_str()))
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
    match thumbnails::thumb_disk_state(&vault.thumb_path(&block.slug)) {
        thumbnails::ThumbDiskState::Jpeg => false,
        // A PNG thumbnail is not evidence of an unfinished one. Phase 1 writes
        // PNG whenever the picture actually uses its alpha channel (rule П6),
        // and re-encoding that through the browser flattens the transparency
        // onto white. Phase 2 exists for formats Rust cannot decode, so that —
        // not the output format — is what decides.
        thumbnails::ThumbDiskState::Png => !rust_decodable_primary_media(vault, block),
        _ => true,
    }
}

/// Whether the block's own picture is one Rust already decoded successfully.
/// A block with no media of its own has nothing waiting on a decoder, but it
/// also has no finished picture, so it stays in the queue.
fn rust_decodable_primary_media(
    vault: &crate::domain::vault::VaultLayout,
    block: &index::PendingThumbUpgradeBlock,
) -> bool {
    let reference = block.media_file.as_deref().or(block.thumbnail.as_deref());
    reference.is_some()
        && thumbnails::media_reference_is_rust_decodable(vault, &block.slug, reference)
}

/// Resolve every derived tile still missing for `block`. Rust handles formats
/// supported by the `image` crate and common videos first; this queue is the
/// decoder-independent fallback for any image or video still absent.
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
        let Some(poster_name) = tile.preview_path.clone() else {
            continue;
        };
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
                kind: if tile.is_video { "video" } else { "image" }.into(),
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

    fn resolve_target_upgrade(
        vault: &VaultLayout,
        target: &index::PendingThumbUpgradeBlock,
    ) -> Option<crate::storage::preview_plan::ResolvedPreviewMedia> {
        resolve_upgrade_media(
            vault,
            PreviewUpgradeInput {
                slug: &target.slug,
                media_file: target.media_file.as_deref(),
                thumbnail: target.thumbnail.as_deref(),
                media_urls: target.media_urls.as_deref(),
                first_image: target.first_image.as_deref(),
            },
        )
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
        let media = resolve_target_upgrade(&vault, &target).expect("must resolve");
        assert_eq!(media.kind.as_str(), "image");
        assert_eq!(media.path, webp);
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

        assert!(resolve_target_upgrade(&vault, &target).is_none());
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

        assert!(resolve_target_upgrade(&vault, &target).is_none());
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
        let media = resolve_target_upgrade(&vault, target).unwrap();
        assert_eq!(media.kind.as_str(), "image");
        assert_eq!(media.path, webp);
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

        let media = resolve_target_upgrade(&vault, target).unwrap();
        assert_eq!(media.kind.as_str(), "video");
        assert_eq!(media.path, video);
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

        let media = resolve_target_upgrade(&vault, &block).unwrap();
        assert_eq!(media.kind.as_str(), "video");
        assert_eq!(media.path, video);
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

    /// A screenshot with rounded, transparent corners legitimately produces a
    /// PNG thumbnail (rule П6). Queueing it for the browser upgrade sent that
    /// picture through a white canvas and put a white frame around it.
    #[test]
    fn needs_browser_thumb_upgrade_keeps_a_transparent_png_thumb() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let media = dir.path().join("shot.png");
        let transparent =
            image::RgbaImage::from_pixel(64, 64, image::Rgba([10, 20, 30, 0]));
        transparent.save(&media).unwrap();
        thumbnails::generate_thumbnail(&media, &vault.thumb_path("shot"), 240).unwrap();
        assert!(matches!(
            thumbnails::thumb_disk_state(&vault.thumb_path("shot")),
            thumbnails::ThumbDiskState::Png
        ));

        let block = index::PendingThumbUpgradeBlock {
            slug: "shot".into(),
            media_file: Some("shot.png".into()),
            thumbnail: None,
            first_image: None,
            media_urls: None,
            preview_manifest: None,
        };

        assert!(!needs_browser_thumb_upgrade(&vault, &block));
    }

    /// The placeholder case still has to reach Phase 2: a PNG written for
    /// media Rust cannot decode is unfinished work, not a finished picture.
    #[test]
    fn needs_browser_thumb_upgrade_still_queues_a_placeholder_over_undecodable_media() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        std::fs::write(dir.path().join("poster.avif"), b"fake avif").unwrap();
        thumbnails::generate_text_thumbnail(
            Some("poster"),
            "",
            &vault.thumb_path("poster"),
        )
        .unwrap();

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
        let media = resolve_target_upgrade(&vault, target).unwrap();

        assert_eq!(media.kind.as_str(), "image");
        assert_eq!(media.path, dir.path().join("poster.avif"));
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
        // `a/b.jpg` is no longer here: a nested destination is the normal case
        // for a card in a subfolder. Escaping the thumbs directory is what
        // stays refused — see the test below.
        for name in ["../x.jpg", "a\\b.jpg", "x.png", "", "foo\0.jpg"] {
            assert!(
                validate_tile_poster_request(name, &[0xFF, 0xD8, 0xFF, 0x00]).is_err(),
                "should reject {name:?}"
            );
        }
        // valid name, but not JPEG bytes
        assert!(validate_tile_poster_request("x.jpg", &[0x89, 0x50, 0x4E]).is_err());
    }

    #[test]
    fn accepts_a_poster_name_that_carries_the_block_folder() {
        // Every card in a laid-out vault has a slug like `Cards/Note`, so its
        // tile destination has a folder in it. Rejecting the separator here
        // meant a gallery card in a subfolder never got its tiles.
        let jpeg = [0xFF, 0xD8, 0xFF, 0x00];
        assert!(validate_tile_poster_request("Cards/Note.preview-1.jpg", &jpeg).is_ok());
        assert!(validate_tile_poster_request("Note.preview-1.jpg", &jpeg).is_ok());
    }

    #[test]
    fn still_refuses_a_poster_name_that_escapes_the_thumbs_directory() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0x00];
        for unsafe_name in [
            "../outside.jpg",
            "Cards/../../outside.jpg",
            "/absolute/outside.jpg",
            "Cards\\Note.preview-1.jpg",
            "Cards/Note.preview-1.png",
            "",
        ] {
            assert!(
                validate_tile_poster_request(unsafe_name, &jpeg).is_err(),
                "{unsafe_name:?} should be refused"
            );
        }
    }

    #[test]
    fn validate_tile_destination_requires_manifest_ownership() {
        let conn = db::open_memory().unwrap();
        let block = make_article("Gallery", "![](photo.jpg)");
        index::upsert_block(&conn, &block, None).unwrap();

        assert!(validate_tile_destination(&conn, "Gallery", "Gallery.preview-1.jpg").is_ok());
        assert!(validate_tile_destination(&conn, "Gallery", "Other.preview-1.jpg").is_err());
        assert!(validate_tile_destination(&conn, "Missing", "Gallery.preview-1.jpg").is_err());
    }

    #[test]
    fn resolve_tile_posters_returns_every_missing_derived_tile() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        std::fs::write(dir.path().join("clip-a.mp4"), b"fake").unwrap();
        std::fs::write(dir.path().join("clip-b.mp4"), b"fake").unwrap();
        std::fs::write(dir.path().join("still.jpg"), b"fake").unwrap();

        let manifest = serde_json::json!({
            "kind": "composite",
            "primary_preview_path": "g.jpg",
            "width": 1, "height": 1,
            "tiles": [
                {"source_path": "clip-a.mp4", "preview_path": "g.preview-1.jpg", "width": 800, "height": 600, "is_video": true, "is_video_poster": false},
                {"source_path": "still.jpg", "preview_path": "g.preview-2.jpg", "width": 800, "height": 600, "is_video": false, "is_video_poster": false},
                {"source_path": "clip-b.mp4", "preview_path": "g.preview-3.jpg", "width": 800, "height": 600, "is_video": true, "is_video_poster": false}
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
        assert_eq!(posters.len(), 3);
        assert_eq!(posters[0].poster_name, "g.preview-1.jpg");
        assert_eq!(posters[0].kind, "video");
        assert_eq!(posters[1].poster_name, "g.preview-2.jpg");
        assert_eq!(posters[1].kind, "image");
        assert_eq!(posters[2].poster_name, "g.preview-3.jpg");
        assert_eq!(posters[2].kind, "video");
    }

    #[test]
    fn resolve_tile_posters_skips_existing_jpeg_poster() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        std::fs::write(dir.path().join("clip-a.mp4"), b"fake").unwrap();
        // Poster already on disk as a real JPEG.
        create_test_image(&vault.thumbs_dir().join("g.preview-1.jpg"), 80, 60);

        let manifest = serde_json::json!({
            "kind": "video_poster",
            "primary_preview_path": "g.jpg",
            "width": 1, "height": 1,
            "tiles": [
                {"source_path": "clip-a.mp4", "preview_path": "g.preview-1.jpg", "width": 800, "height": 600, "is_video": true, "is_video_poster": false}
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
