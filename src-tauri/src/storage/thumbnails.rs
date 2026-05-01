// Thumbnails: image resize and caching.
//
// Generates thumbnail previews for block images.
// Max side = 480px (2x for Retina), saves as JPEG (quality 85).
// Does not upscale images smaller than max_size.
//
// Contract: SPEC_STORAGE.md#storage/thumbnails

use ab_glyph::{FontArc, PxScale};
use anyhow::{Context, Result};
use image::{DynamicImage, GenericImageView, RgbImage, Rgba, RgbaImage};
use imageproc::drawing::draw_text_mut;
use std::path::Path;
use std::sync::LazyLock;

use crate::domain::block::{
    derive_title_fields, iter_inline_media_references, iter_inline_media_sources,
    strip_first_markdown_h1, Block, BlockType,
};
use crate::domain::vault::VaultLayout;
use crate::storage::media_refs;

/// Default max side for thumbnails: 480px covers 240px CSS columns at 2x Retina.
pub const DEFAULT_MAX_SIZE: u32 = 480;
const COMPOSITE_TILE_LIMIT: usize = 4;

const JPEG_QUALITY: u8 = 85;

/// Write a thumbnail to `dest` atomically: encode into a per-process,
/// per-call temp file in the same directory, then rename onto the final
/// path. Same-directory rename is atomic on every filesystem we target
/// (APFS, HFS+, iCloud's overlay), so concurrent readers never observe
/// a partial file and concurrent writers cannot leave a half-encoded
/// JPEG/PNG behind if both call sites race to regenerate the same slug.
///
/// Used by every path that produces a thumb on disk (single-image,
/// composite, text, video). `save_thumb` already has its own atomic
/// rename path because it predates this helper; both patterns are
/// equivalent.
fn write_thumb_atomically<F>(dest: &Path, write_fn: F) -> Result<()>
where
    F: FnOnce(&mut std::io::BufWriter<std::fs::File>) -> Result<()>,
{
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let file_name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("thumb");
    let tmp = dest.with_file_name(format!(
        "{file_name}.tmp.{}.{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));

    let file = std::fs::File::create(&tmp)
        .with_context(|| format!("failed to create temp thumb: {}", tmp.display()))?;
    let mut writer = std::io::BufWriter::new(file);

    let write_result = write_fn(&mut writer);
    if let Err(err) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }

    let file = writer.into_inner().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        anyhow::anyhow!(
            "failed to flush temp thumb {}: {}",
            tmp.display(),
            e.error()
        )
    })?;
    if let Err(err) = file.sync_all() {
        let _ = std::fs::remove_file(&tmp);
        return Err(anyhow::Error::from(err)
            .context(format!("failed to fsync temp thumb {}", tmp.display())));
    }
    drop(file);

    std::fs::rename(&tmp, dest).with_context(|| {
        format!(
            "failed to rename temp thumb {} -> {}",
            tmp.display(),
            dest.display()
        )
    })?;
    Ok(())
}

// ─── Freshness check ────────────────────────────────────────────────────────

/// JPEG magic bytes: `FF D8 FF`.
const JPEG_MAGIC: [u8; 3] = [0xFF, 0xD8, 0xFF];
/// PNG magic bytes: `89 50 4E` (89 P N) — first 3 bytes of `89 50 4E 47`.
const PNG_MAGIC: [u8; 3] = [0x89, 0x50, 0x4E];

/// Actual thumb file state on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbDiskState {
    Missing,
    Jpeg,
    Png,
    Invalid,
}

/// What thumb file format a block is expected to have on disk. Used
/// by `is_thumb_fresh` to detect stale thumbs that were written by
/// an older version of the pipeline in a format the current code
/// wouldn't produce (e.g. pure-text articles that have a JPEG thumb
/// from pre-PNG-switch days).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpectedThumb {
    /// Rust can definitively produce a JPEG from the block's media
    /// (source is sniffed JPEG/PNG/GIF, or H.264 MP4 via openh264).
    /// Only a JPEG thumb is considered fresh.
    OnlyJpeg,
    /// Block has no usable media — only a text placeholder PNG makes
    /// sense. Only a PNG thumb is considered fresh.
    OnlyPng,
    /// Block has media the WebView can decode but Rust can't
    /// (HEIC / VP8X WebP / AVIF / HEVC video). Phase 1 writes PNG
    /// placeholder, Phase 2 may overwrite with JPEG. Both valid.
    Either,
}

/// Classify what thumb format is expected for `block`. Mirrors the
/// cascade logic in `generate_for_block` but returns the CLASSIFICATION
/// of the final result rather than producing a thumb.
pub fn expected_thumb(block: &Block, vault: &VaultLayout) -> ExpectedThumb {
    // 1. Block has an explicit media file. Use the filename from
    //    frontmatter directly — it IS the source of truth per
    //    Markdown File First principle. Do not construct from slug.
    if let Some(ref file_name) = block.frontmatter.file {
        let ext = ext_lower(file_name);
        if let Some(media_path) = resolve_block_media_path(block, vault, file_name) {
            if is_image_ext(&ext) {
                if is_rust_decodable(&media_path) {
                    return ExpectedThumb::OnlyJpeg;
                }
                // Non-decodable image (HEIC/WebP/AVIF) — Phase 2 may upgrade
                return ExpectedThumb::Either;
            }
            if is_video_ext(&ext) {
                // Video: Rust may or may not handle it. Accept either.
                return ExpectedThumb::Either;
            }
        }
    }

    // 2. Frontmatter thumbnail field (OG image for link, video poster).
    if let Some(ref thumb_file) = block.frontmatter.thumbnail {
        let ext = ext_lower(thumb_file);
        if is_image_ext(&ext) {
            if let Some(media_path) = resolve_block_media_path(block, vault, thumb_file) {
                if is_rust_decodable(&media_path) {
                    return ExpectedThumb::OnlyJpeg;
                }
                return ExpectedThumb::Either;
            }
        }
    }

    // 3. Article body: first embedded media in markdown order. If the
    //    article starts with a video and later includes images, the feed
    //    poster must still be derived from the video source.
    if block.frontmatter.block_type == BlockType::Article {
        if let Some((_media_name, media_path, media_kind)) =
            find_first_existing_article_media(block, vault)
        {
            if media_kind == "video" {
                return ExpectedThumb::Either;
            }
            debug_assert!(media_path.exists());
        }

        let article_images = collect_article_preview_images(block, vault, COMPOSITE_TILE_LIMIT);
        if article_images.len() >= 2 {
            return ExpectedThumb::OnlyJpeg;
        }
        if !article_images.is_empty() {
            return ExpectedThumb::OnlyJpeg;
        }
        // 4. Article body: first video.
        if find_first_existing_body_media(block, vault, is_video_ext).is_some() {
            // Video: Rust may succeed or fall through. Accept either.
            return ExpectedThumb::Either;
        }
    }

    // 5. No usable media — text placeholder PNG is the only valid state.
    ExpectedThumb::OnlyPng
}

/// Resolve the media dependencies that actually feed the current preview
/// cascade. Mirrors the precedence in `generate_for_block` / `expected_thumb`
/// so freshness only depends on files that the current thumbnail would use.
fn preview_dependency_paths(block: &Block, vault: &VaultLayout) -> Vec<std::path::PathBuf> {
    if let Some(ref file_name) = block.frontmatter.file {
        if let Some(media_path) = resolve_block_media_path(block, vault, file_name) {
            return vec![media_path];
        }
    }

    if let Some(ref thumb_file) = block.frontmatter.thumbnail {
        if let Some(media_path) = resolve_block_media_path(block, vault, thumb_file) {
            return vec![media_path];
        }
    }

    if block.frontmatter.block_type == BlockType::Article {
        if let Some((_media_name, media_path, media_kind)) =
            find_first_existing_article_media(block, vault)
        {
            if media_kind == "video" {
                return vec![media_path];
            }
        }

        let article_images = collect_article_preview_images(block, vault, COMPOSITE_TILE_LIMIT);
        if article_images.len() >= 2 {
            return article_images;
        }
        if let Some(media_path) = article_images.into_iter().next() {
            return vec![media_path];
        }
        if let Some((_first_video, media_path)) =
            find_first_existing_body_media(block, vault, is_video_ext)
        {
            return vec![media_path];
        }
    }

    Vec::new()
}

/// Returns `true` if the thumbnail at `thumb_path` is still usable for
/// `block`. False means the thumb must be regenerated.
///
/// Freshness checks, in order:
/// 1. File exists on disk.
/// 2. Thumb mtime is not older than source .md mtime.
/// 3. Thumb mtime is not older than the media dependency that currently
///    drives the preview cascade.
/// 3. Magic bytes match a recognized image format (JPEG or PNG).
/// 4. The on-disk format matches what the current pipeline would
///    produce for this block. Catches legacy thumbs written by earlier
///    code — e.g. JPEG text placeholders from before the switch to PNG
///    — so they auto-regenerate on the next full_scan without any
///    manual migration step.
pub fn is_thumb_fresh(
    thumb_path: &Path,
    source_path: &Path,
    block: &Block,
    vault: &VaultLayout,
) -> bool {
    let Ok(thumb_meta) = std::fs::metadata(thumb_path) else {
        log::debug!("is_thumb_fresh({}): thumb missing", block.slug);
        return false;
    };
    let Ok(source_meta) = std::fs::metadata(source_path) else {
        log::debug!("is_thumb_fresh({}): source missing", block.slug);
        return false;
    };
    let Ok(thumb_mtime) = thumb_meta.modified() else {
        return false;
    };
    let Ok(source_mtime) = source_meta.modified() else {
        return false;
    };
    if thumb_mtime < source_mtime {
        log::debug!(
            "is_thumb_fresh({}): thumb older than source .md",
            block.slug
        );
        return false;
    }
    for dependency in preview_dependency_paths(block, vault) {
        let Ok(dep_meta) = std::fs::metadata(&dependency) else {
            log::debug!(
                "is_thumb_fresh({}): dependency missing: {}",
                block.slug,
                dependency.display()
            );
            return false;
        };
        let Ok(dep_mtime) = dep_meta.modified() else {
            return false;
        };
        if thumb_mtime < dep_mtime {
            log::debug!(
                "is_thumb_fresh({}): thumb older than dep {}",
                block.slug,
                dependency.display()
            );
            return false;
        }
    }

    // Accept any thumb with valid magic bytes as fresh.
    //
    // The earlier, stricter rule compared `expected_thumb` (what the
    // cascade would pick based on *currently visible* dependencies)
    // against `thumb_disk_state` (the format actually written). On a
    // vault stored in iCloud Drive those two readings can disagree
    // purely because of placeholder materialization timing:
    // `collect_article_preview_images` needs `exists()` +
    // `is_rust_decodable()` to both succeed, and iCloud flips that
    // state back and forth as it offloads cold files and rehydrates
    // them on access. A block whose inline images are offloaded when
    // the sweep checks freshness, then rehydrated a millisecond later
    // when `generate_for_block` runs, produces a composite JPEG that
    // the next sweep reads back as "format mismatch" — a thrash loop
    // that touches the same slug every focus event without delivering
    // a different thumb.
    //
    // Mtime-based staleness (source or dependency newer than the
    // cached thumb) is still enforced above — that is the real signal
    // that the preview is out of date. The format equality check was
    // only meant to catch legacy JPEG text-placeholders written before
    // the PNG migration, and those are already covered by mtime drift
    // the first time `generate_for_block` rewrites them.
    match thumb_disk_state(thumb_path) {
        ThumbDiskState::Jpeg | ThumbDiskState::Png => true,
        ThumbDiskState::Missing | ThumbDiskState::Invalid => false,
    }
}

/// Classify the actual thumb content on disk.
pub fn thumb_disk_state(thumb_path: &Path) -> ThumbDiskState {
    if !thumb_path.exists() {
        return ThumbDiskState::Missing;
    }
    match read_thumb_magic(thumb_path) {
        Some(JPEG_MAGIC) => ThumbDiskState::Jpeg,
        Some(PNG_MAGIC) => ThumbDiskState::Png,
        Some(_) | None => ThumbDiskState::Invalid,
    }
}

/// Peek first 3 bytes of the thumb file and return them. Returns None
/// on I/O error or too-short file.
fn read_thumb_magic(thumb_path: &Path) -> Option<[u8; 3]> {
    use std::io::Read;
    let mut file = std::fs::File::open(thumb_path).ok()?;
    let mut buf = [0u8; 3];
    file.read_exact(&mut buf).ok()?;
    Some(buf)
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Generate a thumbnail from a source image.
///
/// - Reads source image (JPEG, PNG, WebP, GIF)
/// - Resizes with aspect ratio preserved: max side = `max_size`
/// - If image is smaller than max_size, saves as-is (no upscaling)
/// - Saves as JPEG (quality 80) to `dest`
/// - Creates destination directories if needed
/// - Returns (width, height) of the result
pub fn generate_thumbnail(source: &Path, dest: &Path, max_size: u32) -> Result<(u32, u32)> {
    let img = image::open(source)
        .with_context(|| format!("failed to open image: {}", source.display()))?;

    let (w, h) = img.dimensions();

    let resized = if w <= max_size && h <= max_size {
        img
    } else {
        img.resize(max_size, max_size, image::imageops::FilterType::Lanczos3)
    };

    let (rw, rh) = resized.dimensions();
    let rgb = resized.to_rgb8();

    write_thumb_atomically(dest, |writer| {
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, JPEG_QUALITY);
        rgb.write_with_encoder(encoder)
            .with_context(|| format!("failed to encode thumbnail: {}", dest.display()))
    })?;

    Ok((rw, rh))
}

fn composite_layout_slots(count: usize, size: u32) -> Vec<(u32, u32, u32, u32)> {
    match count {
        0 => Vec::new(),
        1 => vec![(0, 0, size, size)],
        2 => {
            let left = size / 2;
            vec![(0, 0, left, size), (left, 0, size - left, size)]
        }
        3 => {
            let left = size / 2;
            let right = size - left;
            let top = size / 2;
            vec![
                (0, 0, left, size),
                (left, 0, right, top),
                (left, top, right, size - top),
            ]
        }
        _ => {
            let left = size / 2;
            let top = size / 2;
            vec![
                (0, 0, left, top),
                (left, 0, size - left, top),
                (0, top, left, size - top),
                (left, top, size - left, size - top),
            ]
        }
    }
}

pub fn generate_composite_thumbnail(
    sources: &[std::path::PathBuf],
    dest: &Path,
    max_size: u32,
) -> Result<(u32, u32)> {
    let tile_count = sources.len().min(COMPOSITE_TILE_LIMIT);
    anyhow::ensure!(
        tile_count >= 2,
        "composite thumbnail needs at least two source images"
    );

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let mut canvas = RgbaImage::from_pixel(max_size, max_size, Rgba([24, 24, 27, 255]));
    for (source, (x, y, width, height)) in sources
        .iter()
        .take(tile_count)
        .zip(composite_layout_slots(tile_count, max_size).into_iter())
    {
        let img = image::open(source).with_context(|| {
            format!(
                "failed to open composite source image: {}",
                source.display()
            )
        })?;
        let tile = img
            .resize_to_fill(
                width.max(1),
                height.max(1),
                image::imageops::FilterType::Lanczos3,
            )
            .to_rgba8();
        image::imageops::overlay(&mut canvas, &tile, i64::from(x), i64::from(y));
    }

    let rgb = DynamicImage::ImageRgba8(canvas).to_rgb8();

    write_thumb_atomically(dest, |writer| {
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, JPEG_QUALITY);
        rgb.write_with_encoder(encoder)
            .with_context(|| format!("failed to encode composite thumbnail: {}", dest.display()))
    })?;

    Ok((max_size, max_size))
}

// ─── Text thumbnail ─────────────────────────────────────────────────────────

/// Embedded font for text thumbnails (Noto Sans Regular, ~28 KB).
/// Parsed once via LazyLock — avoids re-parsing TTF tables on every call.
static FONT: LazyLock<FontArc> = LazyLock::new(|| {
    FontArc::try_from_slice(include_bytes!("../../assets/NotoSans-Regular.ttf"))
        .expect("embedded NotoSans font must be valid")
});

/// Thumbnail dimensions for text blocks (square, 2x Retina at 240 CSS px).
const TEXT_THUMB_SIZE: u32 = 480;

/// Font size in pixels for text rendering.
const FONT_SIZE: f32 = 24.0;

/// Padding from edges in pixels.
const PADDING: u32 = 32;

/// Line height multiplier.
const LINE_HEIGHT: f32 = 1.6;

/// Background color: transparent (PNG with alpha for theme-adaptive rendering).
const BG_COLOR: Rgba<u8> = Rgba([0, 0, 0, 0]);

/// Text color (dark gray — inverted via CSS `dark:invert` in dark mode).
const TEXT_COLOR: Rgba<u8> = Rgba([80, 80, 80, 255]);

/// Title text color (darker).
const TITLE_COLOR: Rgba<u8> = Rgba([51, 51, 51, 255]);

/// Generate a text thumbnail: renders article title + first lines of body as an image.
///
/// - Creates a 480x480 PNG with **transparent background**
/// - Renders title in larger text, then body lines below
/// - Strips markdown formatting before rendering
/// - Saves as PNG; the app asset protocol sniffs image magic bytes because
///   the stable thumbnail path is still `<slug>.jpg`
/// - Sidebar wraps in `bg-background` div + `dark:invert` for theme adaptation
pub fn generate_text_thumbnail(title: Option<&str>, body: &str, dest: &Path) -> Result<(u32, u32)> {
    let font = &*FONT;

    let size = TEXT_THUMB_SIZE;
    let mut img = RgbaImage::from_pixel(size, size, BG_COLOR);

    let usable_width = size - PADDING * 2;
    let line_step = (FONT_SIZE * LINE_HEIGHT) as u32;
    let mut y = PADDING;

    // Draw title (larger font)
    if let Some(title) = title {
        let title_scale = PxScale::from(FONT_SIZE * 1.3);
        let title_clean = strip_markdown(title);
        let wrapped = wrap_text(&title_clean, font, title_scale, usable_width as f32);
        for line in wrapped.iter().take(2) {
            if y + line_step > size - PADDING {
                break;
            }
            draw_text_mut(
                &mut img,
                TITLE_COLOR,
                PADDING as i32,
                y as i32,
                title_scale,
                font,
                line,
            );
            y += (FONT_SIZE * 1.3 * LINE_HEIGHT) as u32;
        }
        y += line_step / 2;
    }

    // Draw body lines
    let body_scale = PxScale::from(FONT_SIZE);
    let clean_body = strip_markdown(body);
    let wrapped = wrap_text(&clean_body, font, body_scale, usable_width as f32);

    for line in &wrapped {
        if y + line_step > size - PADDING {
            break;
        }
        draw_text_mut(
            &mut img,
            TEXT_COLOR,
            PADDING as i32,
            y as i32,
            body_scale,
            font,
            line,
        );
        y += line_step;
    }

    // Save as PNG (transparent background, theme-adaptive via CSS). The file
    // may have a .jpg extension; the app asset protocol serves the MIME type
    // from content magic bytes, not the extension.
    write_thumb_atomically(dest, |writer| {
        let encoder = image::codecs::png::PngEncoder::new(writer);
        img.write_with_encoder(encoder)
            .with_context(|| format!("failed to encode text thumbnail: {}", dest.display()))
    })?;

    Ok((size, size))
}

/// Generate a thumbnail from the first frame of an MP4 video.
///
/// - Parses MP4 container, finds H.264 video track
/// - Extracts SPS/PPS + first video sample
/// - Decodes H.264 to YUV via OpenH264, converts to RGB
/// - Resizes and saves as JPEG
#[cfg(not(target_os = "ios"))]
pub fn generate_video_thumbnail(source: &Path, dest: &Path, max_size: u32) -> Result<(u32, u32)> {
    use mp4::TrackType;
    use openh264::decoder::Decoder;
    use openh264::formats::YUVSource;

    let file = std::fs::File::open(source)
        .with_context(|| format!("failed to open video: {}", source.display()))?;
    let size = file.metadata()?.len();
    let reader = std::io::BufReader::new(file);
    let mut mp4_reader =
        mp4::Mp4Reader::read_header(reader, size).with_context(|| "failed to parse MP4 header")?;

    // Find H.264 video track
    let video_track_id = mp4_reader
        .tracks()
        .iter()
        .find(|(_, t)| t.track_type().ok() == Some(TrackType::Video))
        .map(|(&id, _)| id)
        .ok_or_else(|| anyhow::anyhow!("no video track found in MP4"))?;

    let track = mp4_reader
        .tracks()
        .get(&video_track_id)
        .ok_or_else(|| anyhow::anyhow!("track disappeared"))?;

    // Extract SPS/PPS from AVCC configuration (needed to initialize decoder)
    let avc1 = track
        .trak
        .mdia
        .minf
        .stbl
        .stsd
        .avc1
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("not an AVC/H.264 track"))?;

    let mut h264_stream: Vec<u8> = Vec::new();

    // Prepend SPS NAL units with Annex B start codes
    for sps in &avc1.avcc.sequence_parameter_sets {
        h264_stream.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        h264_stream.extend_from_slice(&sps.bytes);
    }
    // Prepend PPS NAL units
    for pps in &avc1.avcc.picture_parameter_sets {
        h264_stream.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        h264_stream.extend_from_slice(&pps.bytes);
    }

    let nal_length_size = avc1.avcc.length_size_minus_one + 1;
    let sample_count = mp4_reader.sample_count(video_track_id).unwrap_or(1).min(30); // Check up to 30 samples to skip black frames

    // Decode with OpenH264
    let mut decoder =
        Decoder::new().map_err(|e| anyhow::anyhow!("failed to create H.264 decoder: {:?}", e))?;

    // Feed SPS/PPS first
    for packet in openh264::nal_units(&h264_stream) {
        let _ = decoder.decode(packet);
    }

    let mut decoded_frame = None;
    for sample_id in 1..=sample_count {
        let Some(sample) = mp4_reader
            .read_sample(video_track_id, sample_id)
            .with_context(|| format!("failed to read video sample {}", sample_id))?
        else {
            continue;
        };

        // Convert AVCC → Annex B
        let mut sample_stream: Vec<u8> = Vec::new();
        let data = &sample.bytes;
        let mut offset = 0;
        while offset + nal_length_size as usize <= data.len() {
            let nal_len = match nal_length_size {
                4 => u32::from_be_bytes([
                    data[offset],
                    data[offset + 1],
                    data[offset + 2],
                    data[offset + 3],
                ]) as usize,
                2 => u16::from_be_bytes([data[offset], data[offset + 1]]) as usize,
                1 => data[offset] as usize,
                _ => {
                    return Err(anyhow::anyhow!(
                        "unsupported NAL length size: {}",
                        nal_length_size
                    ))
                }
            };
            offset += nal_length_size as usize;
            if offset + nal_len > data.len() {
                break;
            }
            sample_stream.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
            sample_stream.extend_from_slice(&data[offset..offset + nal_len]);
            offset += nal_len;
        }

        // Decode sample
        for packet in openh264::nal_units(&sample_stream) {
            if let Ok(Some(yuv)) = decoder.decode(packet) {
                let (w_usize, h_usize) = yuv.dimensions();
                let (w, h) = (w_usize as u32, h_usize as u32);
                let mut rgb_buf = vec![0u8; yuv.estimate_rgb_u8_size()];
                yuv.write_rgb8(&mut rgb_buf);

                // Skip near-black frames (average brightness < 40)
                let avg_brightness: u64 =
                    rgb_buf.iter().map(|&b| b as u64).sum::<u64>() / rgb_buf.len().max(1) as u64;
                if avg_brightness < 40 {
                    continue;
                }

                decoded_frame = Some((rgb_buf, w, h));
                break;
            }
        }
        if decoded_frame.is_some() {
            break;
        }
    }

    let (rgb_buf, w, h) = decoded_frame
        .ok_or_else(|| anyhow::anyhow!("failed to decode any frame from H.264 stream"))?;

    let img = RgbImage::from_raw(w, h, rgb_buf)
        .ok_or_else(|| anyhow::anyhow!("RGB buffer size mismatch"))?;

    let dyn_img = image::DynamicImage::ImageRgb8(img);
    let resized = if w <= max_size && h <= max_size {
        dyn_img
    } else {
        dyn_img.resize(max_size, max_size, image::imageops::FilterType::Lanczos3)
    };

    let (rw, rh) = resized.dimensions();

    let rgb = resized.to_rgb8();

    write_thumb_atomically(dest, |writer| {
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, JPEG_QUALITY);
        rgb.write_with_encoder(encoder)
            .with_context(|| format!("failed to encode video thumbnail: {}", dest.display()))
    })?;

    Ok((rw, rh))
}

#[cfg(target_os = "ios")]
pub fn generate_video_thumbnail(
    _source: &Path,
    _dest: &Path,
    _max_size: u32,
) -> Result<(u32, u32)> {
    anyhow::bail!("video thumbnail generation is unavailable on iOS builds");
}

/// Simple word-wrap: splits text into lines that fit within `max_width` pixels.
fn wrap_text(text: &str, font: &FontArc, scale: PxScale, max_width: f32) -> Vec<String> {
    use ab_glyph::Font;

    let mut lines = Vec::new();

    for paragraph in text.lines() {
        if paragraph.trim().is_empty() {
            lines.push(String::new());
            continue;
        }

        let words: Vec<&str> = paragraph.split_whitespace().collect();
        if words.is_empty() {
            lines.push(String::new());
            continue;
        }

        let mut current_line = String::new();
        let mut current_width: f32 = 0.0;
        let scale_factor = scale.x / font.height_unscaled();
        let space_width = font.h_advance_unscaled(font.glyph_id(' ')) * scale_factor;

        for word in words {
            let word_width: f32 = word
                .chars()
                .map(|c| font.h_advance_unscaled(font.glyph_id(c)) * scale_factor)
                .sum();

            if current_line.is_empty() {
                current_line = word.to_string();
                current_width = word_width;
            } else if current_width + space_width + word_width <= max_width {
                current_line.push(' ');
                current_line.push_str(word);
                current_width += space_width + word_width;
            } else {
                lines.push(current_line);
                current_line = word.to_string();
                current_width = word_width;
            }
        }
        if !current_line.is_empty() {
            lines.push(current_line);
        }
    }

    lines
}

/// Strip common markdown formatting for cleaner thumbnail text.
fn strip_markdown(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    for line in text.lines() {
        let trimmed = line.trim();
        // Skip headings markers but keep text
        let cleaned = if let Some(rest) = trimmed.strip_prefix("# ") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("## ") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("### ") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("- ") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("* ") {
            rest
        } else {
            trimmed
        };
        // Strip bold/italic markers
        let cleaned = cleaned
            .replace("**", "")
            .replace("__", "")
            .replace('*', "")
            .replace('_', " ");
        // Strip links: [text](url) -> text
        let cleaned = strip_links(&cleaned);
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(&cleaned);
    }
    result
}

/// Replace `[text](url)` with just `text`.
fn strip_links(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '[' {
            let mut link_text = String::new();
            let mut found_close = false;
            for inner in chars.by_ref() {
                if inner == ']' {
                    found_close = true;
                    break;
                }
                link_text.push(inner);
            }
            if found_close && chars.peek() == Some(&'(') {
                chars.next(); // skip '('
                              // skip until ')'
                for inner in chars.by_ref() {
                    if inner == ')' {
                        break;
                    }
                }
                result.push_str(&link_text);
            } else {
                result.push('[');
                result.push_str(&link_text);
                if found_close {
                    result.push(']');
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}

// ─── Unified dispatch ───────────────────────────────────────────────────────

/// Extensions recognized as still images that `generate_thumbnail` can process.
const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "heic", "heif", "avif",
];
/// Extensions recognized as video containers that `generate_video_thumbnail` can process.
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mov"];

fn ext_lower(path_str: &str) -> String {
    Path::new(path_str)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

pub fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

pub fn is_video_ext(ext: &str) -> bool {
    VIDEO_EXTS.contains(&ext)
}

/// Sniff the first bytes of a file and check whether it is a raster image
/// format that Rust's `image` crate (version 0.25, default features) can
/// actually decode in production: **JPEG**, **PNG**, or **GIF**. All other
/// formats (VP8 / VP8L / VP8X WebP, HEIC/HEIF, AVIF, BMP variants, TIFF,
/// etc.) should go through the WebView upgrade path instead — Rust decode
/// attempts will either fail outright (VP8X WebP) or produce wrong results.
///
/// This is the critical gate for Phase 1 of the two-phase pipeline (see
/// SPEC_THUMBNAILS.md): if the media file is not one of these three
/// formats, `generate_for_block` must NOT call `generate_thumbnail` on it
/// — instead it falls through the cascade to the text placeholder and the
/// block gets queued for WebView upgrade in Phase 2.
///
/// We deliberately check content bytes rather than file extension because
/// the clipper can save files with misleading extensions (e.g. a PNG
/// served as `.jpg`), and because `is_image_ext` accepts formats our
/// decoder cannot handle.
pub fn is_rust_decodable(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 6];
    if file.read_exact(&mut buf).is_err() {
        return false;
    }
    // JPEG: FF D8 FF
    if buf[0] == 0xFF && buf[1] == 0xD8 && buf[2] == 0xFF {
        return true;
    }
    // PNG: 89 50 4E 47 0D 0A (89 P N G \r \n), first 6 bytes are enough
    if buf[0] == 0x89 && buf[1] == 0x50 && buf[2] == 0x4E && buf[3] == 0x47 {
        return true;
    }
    // GIF: 47 49 46 38 (GIF8) — covers GIF87a and GIF89a
    if buf[0] == 0x47 && buf[1] == 0x49 && buf[2] == 0x46 && buf[3] == 0x38 {
        return true;
    }
    false
}

/// Outcome of `generate_for_block` — which source pipeline produced the thumb.
/// Returned for telemetry and tests; callers can ignore it.
#[derive(Debug, PartialEq, Eq)]
pub enum ThumbSource {
    /// Resized from a raster image file (JPEG/PNG/GIF/etc).
    Image,
    /// Composited from multiple embedded images into a single JPEG preview.
    Composite,
    /// Extracted first visible frame from an H.264 MP4.
    Video,
    /// Baked from article title + body when no usable media was found,
    /// or when video frame extraction failed and we fell back.
    Text,
    /// No thumbnail was produced (not an article, no media) — valid for
    /// non-article blocks that have no visible preview.
    None,
}

/// Generate a thumbnail for a block following the full cascade:
///
/// 1. `frontmatter.file` points to an existing image or video
/// 2. `frontmatter.thumbnail` points to an existing image
/// 3. First `![](...)` in body is an existing local image
/// 4. First `![](...)` in body is an existing local video (frame extraction)
/// 5. Article → text-only baked PNG from title + body
///
/// At each step a failure falls through to the next source. Video frame
/// extraction specifically falls through to text fallback on failure,
/// because openh264 can fail on exotic profiles (HEVC, fragmented MP4)
/// and we don't want the block to disappear from sidebar previews.
///
/// This is the SINGLE source of truth for thumbnail generation — both
/// the native host (at clip time) and the watcher handler (at full_scan
/// and on file change) call this function. Previously each had its own
/// copy of the dispatch logic and they drifted.
pub fn generate_for_block(block: &Block, vault: &VaultLayout) -> ThumbSource {
    let slug = &block.slug;
    let thumb_path = vault.thumb_path(slug);
    let title_fields = derive_title_fields(slug, block.frontmatter.title.as_deref(), &block.body);
    let preview_body = strip_first_markdown_h1(&block.body);

    // 1. Block has an explicit media file. We only try Rust decode if the
    //    file bytes start with one of the formats image crate can actually
    //    handle (JPEG/PNG/GIF). Everything else — VP8X WebP, HEIC, AVIF,
    //    TIFF — goes through the cascade so text placeholder can be written
    //    and the block gets queued for WebView upgrade in Phase 2.
    if let Some(ref file_name) = block.frontmatter.file {
        let ext = ext_lower(file_name);
        if let Some(media_path) = resolve_block_media_path(block, vault, file_name) {
            if is_image_ext(&ext) && is_rust_decodable(&media_path) {
                match generate_thumbnail(&media_path, &thumb_path, DEFAULT_MAX_SIZE) {
                    Ok(_) => return ThumbSource::Image,
                    Err(e) => log::warn!("image thumb failed for {}: {}", slug, e),
                }
            } else if is_video_ext(&ext) {
                match generate_video_thumbnail(&media_path, &thumb_path, DEFAULT_MAX_SIZE) {
                    Ok(_) => return ThumbSource::Video,
                    Err(e) => log::warn!("video thumb failed for {}: {}", slug, e),
                }
            }
        }
    }

    // 2. Frontmatter thumbnail field (video poster, OG image). Same
    //    content-sniff gate as above.
    if let Some(thumb_file) = block.frontmatter.thumbnail.as_ref() {
        let ext = ext_lower(thumb_file);
        if is_image_ext(&ext) {
            if let Some(media_path) = resolve_block_media_path(block, vault, thumb_file) {
                if is_rust_decodable(&media_path) {
                    match generate_thumbnail(&media_path, &thumb_path, DEFAULT_MAX_SIZE) {
                        Ok(_) => return ThumbSource::Image,
                        Err(e) => log::warn!("thumbnail-field thumb failed for {}: {}", slug, e),
                    }
                }
            }
        }
    }

    // 3-5. Scan body for embedded image/video previews (articles). If the
    //      first existing embedded media is a video, use its frame as the
    //      poster even when later images exist. Otherwise multi-image
    //      articles/social posts prefer a composite JPEG preview; then a
    //      single image; then a later video frame.
    if block.frontmatter.block_type == BlockType::Article {
        if let Some((_media_name, media_path, media_kind)) =
            find_first_existing_article_media(block, vault)
        {
            if media_kind == "video" {
                match generate_video_thumbnail(&media_path, &thumb_path, DEFAULT_MAX_SIZE) {
                    Ok(_) => return ThumbSource::Video,
                    Err(e) => log::warn!(
                        "first-video thumb failed for {}, falling back through article media cascade: {}",
                        slug,
                        e
                    ),
                }
            }
        }

        let article_images = collect_article_preview_images(block, vault, COMPOSITE_TILE_LIMIT);
        if article_images.len() >= 2 {
            match generate_composite_thumbnail(&article_images, &thumb_path, DEFAULT_MAX_SIZE) {
                Ok(_) => return ThumbSource::Composite,
                Err(e) => log::warn!("composite thumb failed for {}: {}", slug, e),
            }
        }
        if let Some(media_path) = article_images.into_iter().next() {
            match generate_thumbnail(&media_path, &thumb_path, DEFAULT_MAX_SIZE) {
                Ok(_) => return ThumbSource::Image,
                Err(e) => log::warn!("first-image thumb failed for {}: {}", slug, e),
            }
        }
        if let Some((_first_video, media_path)) =
            find_first_existing_body_media(block, vault, is_video_ext)
        {
            match generate_video_thumbnail(&media_path, &thumb_path, DEFAULT_MAX_SIZE) {
                Ok(_) => return ThumbSource::Video,
                Err(e) => log::warn!(
                    "first-video thumb failed for {}, falling back to text: {}",
                    slug,
                    e
                ),
            }
        }

        // 5. Text fallback — runs for pure-text articles AND for articles
        //    whose embedded media isn't Rust-decodable. In the latter case
        //    the placeholder is temporary: Phase 2 will overwrite it with
        //    a WebView-decoded JPEG.
        let title = title_fields.display_title.as_deref();
        match generate_text_thumbnail(title, &preview_body, &thumb_path) {
            Ok(_) => return ThumbSource::Text,
            Err(e) => log::warn!("text thumb failed for {}: {}", slug, e),
        }
    }

    // 6. Universal fallback for image/link/video/file blocks with
    //    non-Rust-decodable media (HEIC, VP8X WebP, AVIF, HEVC video,
    //    missing file, etc.): write a text placeholder with just the
    //    title. Maintains the invariant "Phase 1 always leaves a thumb
    //    file on disk" so Phase 2 (list_pending_thumb_upgrades) can
    //    pick it up and upgrade to a real decoded JPEG via the WebView.
    //    Without this, image blocks with HEIC media were left with no
    //    thumb at all → broken-image icon in the sidebar forever.
    let title = title_fields.display_title.as_deref();
    if title.is_some() || !preview_body.is_empty() {
        match generate_text_thumbnail(title, &preview_body, &thumb_path) {
            Ok(_) => return ThumbSource::Text,
            Err(e) => log::warn!("fallback text thumb failed for {}: {}", slug, e),
        }
    }

    ThumbSource::None
}

/// Scan a markdown body for the first local embedded media reference whose
/// extension matches `ext_predicate`. Supports both `![[name]]` and
/// legacy `![](name)` syntax via the shared domain parser.
pub fn find_first_local_media(body: &str, ext_predicate: fn(&str) -> bool) -> Option<String> {
    find_local_media(body, ext_predicate, 1).into_iter().next()
}

pub fn find_first_local_media_any(body: &str) -> Option<(String, &'static str)> {
    for src in iter_inline_media_sources(body) {
        if src.is_empty() || src.starts_with("http://") || src.starts_with("https://") {
            continue;
        }
        let ext = ext_lower(&src);
        if is_image_ext(&ext) {
            return Some((src, "image"));
        }
        if is_video_ext(&ext) {
            return Some((src, "video"));
        }
    }
    None
}

fn find_local_media(body: &str, ext_predicate: fn(&str) -> bool, limit: usize) -> Vec<String> {
    if limit == 0 {
        return Vec::new();
    }

    let mut results = Vec::new();
    for src in iter_inline_media_sources(body) {
        if src.is_empty() || src.starts_with("http://") || src.starts_with("https://") {
            continue;
        }
        let ext = ext_lower(&src);
        if ext_predicate(&ext) {
            results.push(src);
            if results.len() >= limit {
                break;
            }
        }
    }
    results
}

fn find_local_media_refs(
    body: &str,
    ext_predicate: fn(&str) -> bool,
    limit: usize,
) -> Vec<crate::domain::block::InlineMediaReference> {
    if limit == 0 {
        return Vec::new();
    }

    let mut results = Vec::new();
    for reference in iter_inline_media_references(body) {
        if reference.source.is_empty()
            || reference.source.starts_with("http://")
            || reference.source.starts_with("https://")
        {
            continue;
        }
        let ext = ext_lower(&reference.source);
        if ext_predicate(&ext) {
            results.push(reference);
            if results.len() >= limit {
                break;
            }
        }
    }
    results
}

fn find_first_existing_body_media(
    block: &Block,
    vault: &VaultLayout,
    ext_predicate: fn(&str) -> bool,
) -> Option<(String, std::path::PathBuf)> {
    for reference in find_local_media_refs(&block.body, ext_predicate, usize::MAX) {
        if let Some(path) = media_refs::resolve_inline_media(vault, &block.slug, &reference) {
            return Some((reference.source, path));
        }
    }
    None
}

fn find_first_existing_article_media(
    block: &Block,
    vault: &VaultLayout,
) -> Option<(String, std::path::PathBuf, &'static str)> {
    if block.frontmatter.block_type != BlockType::Article {
        return None;
    }
    for reference in iter_inline_media_references(&block.body) {
        if reference.source.is_empty()
            || reference.source.starts_with("http://")
            || reference.source.starts_with("https://")
        {
            continue;
        }
        let ext = ext_lower(&reference.source);
        let kind = if is_image_ext(&ext) {
            "image"
        } else if is_video_ext(&ext) {
            "video"
        } else {
            continue;
        };
        if let Some(path) = media_refs::resolve_inline_media(vault, &block.slug, &reference) {
            return Some((reference.source, path, kind));
        }
    }
    None
}

fn collect_article_preview_images(
    block: &Block,
    vault: &VaultLayout,
    limit: usize,
) -> Vec<std::path::PathBuf> {
    if block.frontmatter.block_type != BlockType::Article || limit == 0 {
        return Vec::new();
    }

    let mut seen = std::collections::HashSet::<String>::new();
    let mut paths = Vec::new();
    for reference in find_local_media_refs(&block.body, is_image_ext, limit.saturating_mul(3)) {
        if !seen.insert(reference.source.clone()) {
            continue;
        }
        if let Some(path) = media_refs::resolve_inline_media(vault, &block.slug, &reference) {
            if is_rust_decodable(&path) {
                paths.push(path);
                if paths.len() >= limit {
                    break;
                }
            }
        }
    }
    paths
}

fn resolve_block_media_path(
    block: &Block,
    vault: &VaultLayout,
    reference: &str,
) -> Option<std::path::PathBuf> {
    media_refs::resolve_indexed_media(vault, &block.slug, reference)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a solid-color test image of given dimensions.
    fn create_test_image_with_color(path: &Path, width: u32, height: u32, color: [u8; 3]) {
        let img = image::RgbImage::from_fn(width, height, |_, _| image::Rgb(color));
        img.save(path).unwrap();
    }

    fn create_test_image(path: &Path, width: u32, height: u32) {
        create_test_image_with_color(path, width, height, [100, 150, 200]);
    }

    #[test]
    fn resize_large_image() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("big.png");
        let dest = dir.path().join("thumb.jpg");

        create_test_image(&source, 800, 600);
        let (w, h) = generate_thumbnail(&source, &dest, 240).unwrap();

        assert!(dest.exists());
        assert!(w <= 240);
        assert!(h <= 240);
        // 800x600 scaled to fit 240: 240x180
        assert_eq!(w, 240);
        assert_eq!(h, 180);
    }

    #[test]
    fn small_image_no_upscale() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("small.png");
        let dest = dir.path().join("thumb.jpg");

        create_test_image(&source, 100, 80);
        let (w, h) = generate_thumbnail(&source, &dest, 240).unwrap();

        assert!(dest.exists());
        assert_eq!(w, 100);
        assert_eq!(h, 80);
    }

    #[test]
    fn creates_destination_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.png");
        let dest = dir.path().join("sub").join("deep").join("thumb.jpg");

        create_test_image(&source, 400, 400);
        let (w, h) = generate_thumbnail(&source, &dest, 240).unwrap();

        assert!(dest.exists());
        assert_eq!(w, 240);
        assert_eq!(h, 240);
    }

    #[test]
    fn invalid_source_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("nonexistent.png");
        let dest = dir.path().join("thumb.jpg");

        let result = generate_thumbnail(&source, &dest, 240);
        assert!(result.is_err());
    }

    #[test]
    fn text_thumbnail_generates_valid_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("text-thumb.jpg");

        let (w, h) = generate_text_thumbnail(
            Some("Design Patterns in Rust"),
            "This is a sample article body.\n\nIt has multiple paragraphs with **bold** and [links](http://example.com).\n\n## Section Header\n\nMore content follows here.",
            &dest,
        ).unwrap();

        assert!(dest.exists());
        assert_eq!(w, 480);
        assert_eq!(h, 480);

        // Verify it's a valid image. Text thumbnails are encoded as PNG
        // (even when the destination path has a .jpg extension) to preserve
        // transparency for the dark-mode invert CSS effect. Use a format
        // detector instead of image::open which trusts the file extension.
        let img = image::ImageReader::open(&dest)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap();
        let (iw, ih) = img.dimensions();
        assert_eq!(iw, 480);
        assert_eq!(ih, 480);
    }

    #[test]
    fn text_thumbnail_empty_body() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("empty-thumb.jpg");

        let (w, h) = generate_text_thumbnail(Some("Title Only"), "", &dest).unwrap();
        assert!(dest.exists());
        assert_eq!(w, 480);
        assert_eq!(h, 480);
    }

    #[test]
    fn output_is_valid_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("test.png");
        let dest = dir.path().join("thumb.jpg");

        create_test_image(&source, 500, 300);
        generate_thumbnail(&source, &dest, 240).unwrap();

        // Read back and verify it's a valid image
        let img = image::open(&dest).unwrap();
        let (w, h) = img.dimensions();
        assert_eq!(w, 240);
        assert_eq!(h, 144); // 500x300 → 240x144
    }

    // ─── Tests for generate_for_block cascade ──────────────────────────────

    fn make_vault(root: &Path) -> VaultLayout {
        std::fs::create_dir_all(root.join(".arena/cache/thumbs")).unwrap();
        VaultLayout::new(root.to_path_buf())
    }

    fn make_article(slug: &str, body: &str) -> Block {
        use crate::domain::block::{DateTime, Frontmatter};
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: Some(format!("Title of {}", slug)),
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

    #[test]
    fn generate_for_block_article_with_first_image() {
        // Article with an inline image that actually exists on disk
        // should produce a JPEG image thumbnail, not a text fallback.
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        let img_path = dir.path().join("my-article-img0.jpg");
        create_test_image(&img_path, 800, 600);

        let block = make_article(
            "my-article",
            "Hello world\n\n![](my-article-img0.jpg)\n\nMore text.",
        );

        let source = generate_for_block(&block, &vault);
        assert_eq!(source, ThumbSource::Image);

        let thumb_path = vault.thumb_path("my-article");
        assert!(thumb_path.exists());

        // Verify thumb content is JPEG (not text PNG fallback)
        let mut header = [0u8; 3];
        use std::io::Read;
        let mut f = std::fs::File::open(&thumb_path).unwrap();
        f.read_exact(&mut header).unwrap();
        assert_eq!(header, JPEG_MAGIC);
    }

    #[test]
    fn generate_for_block_article_with_multiple_images_writes_composite_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        let red = dir.path().join("img-red.jpg");
        let green = dir.path().join("img-green.jpg");
        let blue = dir.path().join("img-blue.jpg");
        create_test_image_with_color(&red, 240, 480, [240, 20, 20]);
        create_test_image_with_color(&green, 480, 240, [20, 240, 20]);
        create_test_image_with_color(&blue, 360, 360, [20, 20, 240]);

        let block = make_article(
            "multi-image",
            "![](img-red.jpg)\n![](img-green.jpg)\n![](img-blue.jpg)\n",
        );

        let source = generate_for_block(&block, &vault);
        assert_eq!(source, ThumbSource::Composite);

        let thumb_path = vault.thumb_path("multi-image");
        let mut header = [0u8; 3];
        use std::io::Read;
        let mut f = std::fs::File::open(&thumb_path).unwrap();
        f.read_exact(&mut header).unwrap();
        assert_eq!(header, JPEG_MAGIC);

        let composite = image::open(&thumb_path).unwrap().to_rgb8();
        assert_eq!(composite.dimensions(), (DEFAULT_MAX_SIZE, DEFAULT_MAX_SIZE));

        let left = composite.get_pixel(DEFAULT_MAX_SIZE / 4, DEFAULT_MAX_SIZE / 2);
        let right_top = composite.get_pixel(DEFAULT_MAX_SIZE * 3 / 4, DEFAULT_MAX_SIZE / 4);
        let right_bottom = composite.get_pixel(DEFAULT_MAX_SIZE * 3 / 4, DEFAULT_MAX_SIZE * 3 / 4);

        assert!(left[0] > left[1] && left[0] > left[2]);
        assert!(right_top[1] > right_top[0] && right_top[1] > right_top[2]);
        assert!(right_bottom[2] > right_bottom[0] && right_bottom[2] > right_bottom[1]);
    }

    #[test]
    fn article_video_first_preview_depends_on_video_before_later_images() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        let video = dir.path().join("clip.mp4");
        let image = dir.path().join("later.jpg");
        std::fs::write(&video, b"fake mp4").unwrap();
        create_test_image(&image, 120, 80);

        let block = make_article("video-first", "![](clip.mp4)\n\n![](later.jpg)\n");

        assert_eq!(expected_thumb(&block, &vault), ExpectedThumb::Either);
        assert_eq!(preview_dependency_paths(&block, &vault), vec![video]);
    }

    #[test]
    fn generate_for_block_article_pure_text_falls_back_to_text_png() {
        // Article with no media — falls through the whole cascade to
        // text thumbnail (which is PNG with transparency for dark-mode
        // invert effect).
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        let block = make_article("pure-text", "Just some plain text, no images or videos.");

        let source = generate_for_block(&block, &vault);
        assert_eq!(source, ThumbSource::Text);

        let thumb_path = vault.thumb_path("pure-text");
        assert!(thumb_path.exists());

        // Text thumb is PNG — first 3 bytes are PNG magic
        let mut header = [0u8; 3];
        use std::io::Read;
        let mut f = std::fs::File::open(&thumb_path).unwrap();
        f.read_exact(&mut header).unwrap();
        assert_eq!(header, PNG_MAGIC);
    }

    #[test]
    fn generate_for_block_article_with_missing_image_falls_back_to_text() {
        // Body references an image that doesn't exist on disk — cascade
        // should skip it and land on text fallback without panicking.
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        let block = make_article(
            "ghost-image",
            "See this image:\n\n![](does-not-exist.jpg)\n\nEnd.",
        );

        let source = generate_for_block(&block, &vault);
        assert_eq!(source, ThumbSource::Text);
        assert!(vault.thumb_path("ghost-image").exists());
    }

    #[test]
    fn generate_for_block_article_skips_non_decodable_first_image_and_uses_next_decodable_image() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        let undecodable = dir.path().join("cover.webp");
        std::fs::write(&undecodable, b"RIFFxxxxWEBPVP8X").unwrap();

        let decodable = dir.path().join("fallback.jpg");
        create_test_image(&decodable, 640, 480);

        let block = make_article("mixed-article", "![](cover.webp)\n![](fallback.jpg)\n");

        let source = generate_for_block(&block, &vault);
        assert_eq!(source, ThumbSource::Image);

        let thumb_path = vault.thumb_path("mixed-article");
        let mut header = [0u8; 3];
        use std::io::Read;
        let mut f = std::fs::File::open(&thumb_path).unwrap();
        f.read_exact(&mut header).unwrap();
        assert_eq!(header, JPEG_MAGIC);
    }

    #[test]
    fn is_thumb_fresh_rejects_non_image_content() {
        // Thumb file with a newer mtime but wrong content (plain text,
        // not JPEG or PNG) must NOT be considered fresh — forces the
        // pipeline to regenerate it.
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let source = dir.path().join("source.md");
        std::fs::write(&source, "# Source\n").unwrap();

        // Article where the first image is non-Rust-decodable but a later
        // image is decodable. The new preview pipeline must still classify
        // the block as JPEG-backed via the later image, so this test keeps
        // exercising the magic-bytes freshness gate rather than the format
        // classifier itself.
        let webp = dir.path().join("source-img0.webp");
        std::fs::write(&webp, b"RIFF\x00\x00\x00\x00WEBPVP8X").unwrap();
        let fallback = dir.path().join("source-img1.jpg");
        create_test_image(&fallback, 100, 100);
        let block = make_article("source", "![](source-img0.webp)\n![](source-img1.jpg)");

        let thumb = vault.thumb_path("source");
        std::fs::create_dir_all(thumb.parent().unwrap()).unwrap();
        std::fs::write(&thumb, b"\x00\x01\x02garbage").unwrap();
        assert!(!is_thumb_fresh(&thumb, &source, &block, &vault));

        // Write a real JPEG — freshness check passes because the preview
        // classifier now resolves to the later decodable image.
        create_test_image(&dir.path().join("real.png"), 100, 100);
        generate_thumbnail(&dir.path().join("real.png"), &thumb, 240).unwrap();
        assert!(is_thumb_fresh(&thumb, &source, &block, &vault));
    }

    #[test]
    fn is_thumb_fresh_accepts_any_valid_magic_bytes_regardless_of_expected_format() {
        // The freshness check deliberately ignores the "expected"
        // format (JPEG vs PNG) when the thumb magic is valid. Reason:
        // on iCloud Drive the `exists()` + decodability checks that
        // drive `expected_thumb` flip between offloaded and hydrated
        // states, which would otherwise thrash the cache by demanding
        // regeneration of thumbs that are perfectly correct just in a
        // different encoding than the cascade currently thinks it would
        // produce. Legacy format migrations still happen, but through
        // the mtime comparison above — the next `.md` edit bumps the
        // source mtime and forces regeneration.
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let source = dir.path().join("pure.md");
        std::fs::write(&source, "# Source\n").unwrap();
        let block = make_article("pure", "Just plain text, no images.");

        let thumb = vault.thumb_path("pure");
        // JPEG thumb for a pure-text article — previously rejected,
        // now accepted as long as the magic bytes are valid.
        create_test_image(&dir.path().join("real.png"), 100, 100);
        generate_thumbnail(&dir.path().join("real.png"), &thumb, 240).unwrap();
        assert!(is_thumb_fresh(&thumb, &source, &block, &vault));

        // PNG thumb — also accepted.
        generate_text_thumbnail(Some("pure"), "body", &thumb).unwrap();
        assert!(is_thumb_fresh(&thumb, &source, &block, &vault));
    }

    #[test]
    fn is_thumb_fresh_rejects_thumb_older_than_embedded_preview_dependency() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let source = dir.path().join("article.md");
        std::fs::write(&source, "# Source\n").unwrap();

        let embedded = dir.path().join("hero.png");
        create_test_image(&embedded, 80, 80);
        let block = make_article("article", "![](hero.png)");

        let thumb = vault.thumb_path("article");
        generate_thumbnail(&embedded, &thumb, 240).unwrap();
        assert!(is_thumb_fresh(&thumb, &source, &block, &vault));

        std::thread::sleep(std::time::Duration::from_millis(20));
        create_test_image(&embedded, 120, 120);

        assert!(!is_thumb_fresh(&thumb, &source, &block, &vault));
    }

    #[test]
    fn is_thumb_fresh_rejects_thumb_older_than_any_composite_dependency() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let source = dir.path().join("article.md");
        std::fs::write(&source, "# Source\n").unwrap();

        let first = dir.path().join("first.png");
        let second = dir.path().join("second.png");
        create_test_image(&first, 80, 80);
        create_test_image(&second, 90, 90);
        let block = make_article("article", "![](first.png)\n![](second.png)\n");

        let thumb = vault.thumb_path("article");
        generate_composite_thumbnail(&[first.clone(), second.clone()], &thumb, 240).unwrap();
        assert!(is_thumb_fresh(&thumb, &source, &block, &vault));

        std::thread::sleep(std::time::Duration::from_millis(20));
        create_test_image(&second, 120, 120);

        assert!(!is_thumb_fresh(&thumb, &source, &block, &vault));
    }

    #[test]
    fn is_thumb_fresh_rejects_thumb_older_than_frontmatter_thumbnail_dependency() {
        use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};

        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let source = dir.path().join("link.md");
        std::fs::write(&source, "# Source\n").unwrap();

        let poster = dir.path().join("poster.jpg");
        create_test_image(&poster, 80, 80);

        let block = Block {
            slug: "link".into(),
            frontmatter: Frontmatter {
                block_type: BlockType::Link,
                title: Some("Link".into()),
                description: None,
                url: Some("https://example.com".into()),
                file: None,
                thumbnail: Some("poster.jpg".into()),
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

        let thumb = vault.thumb_path("link");
        generate_thumbnail(&poster, &thumb, 240).unwrap();
        assert!(is_thumb_fresh(&thumb, &source, &block, &vault));

        std::thread::sleep(std::time::Duration::from_millis(20));
        create_test_image(&poster, 120, 120);

        assert!(!is_thumb_fresh(&thumb, &source, &block, &vault));
    }

    // ─── Tests for is_rust_decodable content sniff ─────────────────────────

    #[test]
    fn is_rust_decodable_accepts_jpeg_png_gif() {
        let dir = tempfile::tempdir().unwrap();

        // Real JPEG — produce via generate_thumbnail from a synthetic PNG
        let src_png = dir.path().join("src.png");
        create_test_image(&src_png, 20, 20);
        let jpeg = dir.path().join("real.jpg");
        generate_thumbnail(&src_png, &jpeg, 240).unwrap();
        assert!(is_rust_decodable(&jpeg));

        // Synthetic PNG from create_test_image
        assert!(is_rust_decodable(&src_png));

        // GIF — write minimal GIF89a header (we only sniff first 4 bytes)
        let gif = dir.path().join("anim.gif");
        std::fs::write(&gif, b"GIF89a\x01\x00\x01\x00").unwrap();
        assert!(is_rust_decodable(&gif));
    }

    #[test]
    fn is_rust_decodable_rejects_webp_heic_avif_and_garbage() {
        let dir = tempfile::tempdir().unwrap();

        // VP8X WebP: RIFF....WEBP
        let webp = dir.path().join("anim.webp");
        std::fs::write(&webp, b"RIFF\x00\x00\x00\x00WEBPVP8X").unwrap();
        assert!(!is_rust_decodable(&webp));

        // HEIC: starts with `\x00\x00\x00\x20ftypheic`
        let heic = dir.path().join("pic.heic");
        std::fs::write(&heic, b"\x00\x00\x00\x20ftypheic").unwrap();
        assert!(!is_rust_decodable(&heic));

        // AVIF: `\x00\x00\x00\x1cftypavif`
        let avif = dir.path().join("pic.avif");
        std::fs::write(&avif, b"\x00\x00\x00\x1cftypavif").unwrap();
        assert!(!is_rust_decodable(&avif));

        // Arbitrary garbage
        let junk = dir.path().join("junk.bin");
        std::fs::write(&junk, b"hello world, not an image").unwrap();
        assert!(!is_rust_decodable(&junk));

        // Missing file
        assert!(!is_rust_decodable(&dir.path().join("does-not-exist")));

        // Too-short file (<6 bytes)
        let tiny = dir.path().join("tiny.bin");
        std::fs::write(&tiny, b"abc").unwrap();
        assert!(!is_rust_decodable(&tiny));
    }

    #[test]
    fn find_first_local_media_reads_wikilink_image() {
        let body = "intro\n\n![[Title (image 1).jpg]]\n\nmore";
        assert_eq!(
            find_first_local_media(body, is_image_ext),
            Some("Title (image 1).jpg".to_string())
        );
    }

    #[test]
    fn find_first_local_media_reads_wikilink_with_alt() {
        let body = "![[Title (image 1).jpg|caption]]";
        assert_eq!(
            find_first_local_media(body, is_image_ext),
            Some("Title (image 1).jpg".to_string())
        );
    }

    #[test]
    fn find_first_local_media_reads_mixed_markdown_and_wikilink_in_order() {
        let body = "![](legacy.png)\n\n![[Later (image 1).jpg]]";
        assert_eq!(
            find_first_local_media(body, is_image_ext),
            Some("legacy.png".to_string())
        );
    }

    #[test]
    fn find_first_local_media_any_preserves_video_first_order() {
        let body = "![[Title (video 1).mp4]]\n\n![[Title (image 1).jpg]]";
        assert_eq!(
            find_first_local_media_any(body),
            Some(("Title (video 1).mp4".to_string(), "video"))
        );
    }

    #[test]
    fn generate_for_block_resolves_obsidian_attachment_by_basename() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        std::fs::create_dir_all(dir.path().join("Библиотека/images/images")).unwrap();
        create_test_image(&dir.path().join("Библиотека/images/images/01.jpg"), 120, 80);
        let block = make_article("Библиотека/Азбука", "![[01.jpg]]");

        let source = generate_for_block(&block, &vault);

        assert_eq!(source, ThumbSource::Image);
        assert!(vault.thumb_path("Библиотека/Азбука").exists());
    }

    #[test]
    fn generate_for_block_article_with_non_decodable_webp_falls_back_to_text() {
        // Article embeds a WebP file that Rust's image crate cannot decode
        // (VP8X with alpha, animation, etc). The cascade must NOT attempt
        // Rust decode — instead it should fall through to the text
        // placeholder. Phase 2 (WebView upgrade) will overwrite the
        // placeholder with a real decoded JPEG later.
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        // Write a file with WebP magic bytes (RIFF....WEBP) — is_rust_decodable
        // must reject it on content sniff, regardless of extension.
        let webp_path = dir.path().join("webp-article-img0.webp");
        std::fs::write(&webp_path, b"RIFF\x00\x00\x00\x00WEBPVP8X\x00\x00").unwrap();

        let block = make_article(
            "webp-article",
            "Article with unsupported image:\n\n![](webp-article-img0.webp)\n\nEnd.",
        );

        let source = generate_for_block(&block, &vault);
        assert_eq!(source, ThumbSource::Text);

        let thumb_path = vault.thumb_path("webp-article");
        assert!(thumb_path.exists());

        // Text placeholder is PNG (transparent background for dark-mode invert)
        let mut header = [0u8; 3];
        use std::io::Read;
        let mut f = std::fs::File::open(&thumb_path).unwrap();
        f.read_exact(&mut header).unwrap();
        assert_eq!(header, PNG_MAGIC);
    }

    #[test]
    fn generate_for_block_article_with_wikilink_image_returns_image() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        let image_path = dir.path().join("Title (image 1).jpg");
        create_test_image(&image_path, 120, 80);

        let block = make_article(
            "Human Readable Title",
            "Article with image\n\n![[Title (image 1).jpg]]\n",
        );

        let source = generate_for_block(&block, &vault);
        assert_eq!(source, ThumbSource::Image);

        let thumb_path = vault.thumb_path("Human Readable Title");
        let mut header = [0u8; 3];
        use std::io::Read;
        let mut f = std::fs::File::open(&thumb_path).unwrap();
        f.read_exact(&mut header).unwrap();
        assert_eq!(header, JPEG_MAGIC);
    }

    #[test]
    fn generate_for_block_article_with_two_wikilink_images_writes_composite_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        create_test_image(&dir.path().join("First (image 1).jpg"), 120, 80);
        create_test_image(&dir.path().join("Second (image 2).jpg"), 90, 90);

        let block = make_article(
            "Human Readable Title",
            "![[First (image 1).jpg]]\n\n![[Second (image 2).jpg]]",
        );

        let source = generate_for_block(&block, &vault);
        assert_eq!(source, ThumbSource::Composite);

        let thumb_path = vault.thumb_path("Human Readable Title");
        let mut header = [0u8; 3];
        use std::io::Read;
        let mut f = std::fs::File::open(&thumb_path).unwrap();
        f.read_exact(&mut header).unwrap();
        assert_eq!(header, JPEG_MAGIC);
    }
}
