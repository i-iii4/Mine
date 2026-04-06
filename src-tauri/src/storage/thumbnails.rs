// Thumbnails: image resize and caching.
//
// Generates thumbnail previews for block images.
// Max side = 480px (2x for Retina), saves as JPEG (quality 85).
// Does not upscale images smaller than max_size.
//
// Contract: SPEC_STORAGE.md#storage/thumbnails

use ab_glyph::{FontArc, PxScale};
use anyhow::{Context, Result};
use image::{GenericImageView, Rgb, Rgba, RgbImage, RgbaImage};
use imageproc::drawing::draw_text_mut;
use std::path::Path;
use std::sync::LazyLock;

/// Default max side for thumbnails: 480px covers 240px CSS columns at 2x Retina.
pub const DEFAULT_MAX_SIZE: u32 = 480;

const JPEG_QUALITY: u8 = 85;

// ─── Freshness check ────────────────────────────────────────────────────────

/// Returns `true` if the thumbnail at `thumb_path` exists and is at least as
/// new as `source_path`. Used to skip redundant regeneration during full_scan.
pub fn is_thumb_fresh(thumb_path: &Path, source_path: &Path) -> bool {
    let Ok(thumb_meta) = std::fs::metadata(thumb_path) else {
        return false;
    };
    let Ok(source_meta) = std::fs::metadata(source_path) else {
        return false;
    };
    let Ok(thumb_mtime) = thumb_meta.modified() else {
        return false;
    };
    let Ok(source_mtime) = source_meta.modified() else {
        return false;
    };
    thumb_mtime >= source_mtime
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

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let rgb = resized.to_rgb8();
    let file = std::fs::File::create(dest)
        .with_context(|| format!("failed to create thumbnail file: {}", dest.display()))?;
    let mut writer = std::io::BufWriter::new(file);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY);
    rgb.write_with_encoder(encoder)
        .with_context(|| format!("failed to encode thumbnail: {}", dest.display()))?;

    Ok((rw, rh))
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
/// - Saves as PNG (browser reads format from content, not extension)
/// - Sidebar wraps in `bg-background` div + `dark:invert` for theme adaptation
pub fn generate_text_thumbnail(
    title: Option<&str>,
    body: &str,
    dest: &Path,
) -> Result<(u32, u32)> {
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
            draw_text_mut(&mut img, TITLE_COLOR, PADDING as i32, y as i32, title_scale, font, line);
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
        draw_text_mut(&mut img, TEXT_COLOR, PADDING as i32, y as i32, body_scale, font, line);
        y += line_step;
    }

    // Save as PNG (transparent background, theme-adaptive via CSS).
    // File may have .jpg extension — browsers detect format from content, not extension.
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let file = std::fs::File::create(dest)
        .with_context(|| format!("failed to create text thumbnail: {}", dest.display()))?;
    let mut writer = std::io::BufWriter::new(file);
    let encoder = image::codecs::png::PngEncoder::new(&mut writer);
    img.write_with_encoder(encoder)
        .with_context(|| format!("failed to encode text thumbnail: {}", dest.display()))?;

    Ok((size, size))
}

/// Generate a thumbnail from the first frame of an MP4 video.
///
/// - Parses MP4 container, finds H.264 video track
/// - Extracts SPS/PPS + first video sample
/// - Decodes H.264 to YUV via OpenH264, converts to RGB
/// - Resizes and saves as JPEG
pub fn generate_video_thumbnail(source: &Path, dest: &Path, max_size: u32) -> Result<(u32, u32)> {
    use mp4::TrackType;
    use openh264::decoder::Decoder;
    use openh264::formats::YUVSource;

    let file = std::fs::File::open(source)
        .with_context(|| format!("failed to open video: {}", source.display()))?;
    let size = file.metadata()?.len();
    let reader = std::io::BufReader::new(file);
    let mut mp4_reader = mp4::Mp4Reader::read_header(reader, size)
        .with_context(|| "failed to parse MP4 header")?;

    // Find H.264 video track
    let video_track_id = mp4_reader.tracks().iter()
        .find(|(_, t)| t.track_type().ok() == Some(TrackType::Video))
        .map(|(&id, _)| id)
        .ok_or_else(|| anyhow::anyhow!("no video track found in MP4"))?;

    let track = mp4_reader.tracks().get(&video_track_id)
        .ok_or_else(|| anyhow::anyhow!("track disappeared"))?;

    // Extract SPS/PPS from AVCC configuration (needed to initialize decoder)
    let avc1 = track.trak.mdia.minf.stbl.stsd.avc1.as_ref()
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
    let sample_count = mp4_reader.sample_count(video_track_id)
        .unwrap_or(1)
        .min(30); // Check up to 30 samples to skip black frames

    // Decode with OpenH264
    let mut decoder = Decoder::new()
        .map_err(|e| anyhow::anyhow!("failed to create H.264 decoder: {:?}", e))?;

    // Feed SPS/PPS first
    for packet in openh264::nal_units(&h264_stream) {
        let _ = decoder.decode(packet);
    }

    let mut decoded_frame = None;
    for sample_id in 1..=sample_count {
        let Some(sample) = mp4_reader.read_sample(video_track_id, sample_id)
            .with_context(|| format!("failed to read video sample {}", sample_id))? else { continue };

        // Convert AVCC → Annex B
        let mut sample_stream: Vec<u8> = Vec::new();
        let data = &sample.bytes;
        let mut offset = 0;
        while offset + nal_length_size as usize <= data.len() {
            let nal_len = match nal_length_size {
                4 => u32::from_be_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]) as usize,
                2 => u16::from_be_bytes([data[offset], data[offset+1]]) as usize,
                1 => data[offset] as usize,
                _ => return Err(anyhow::anyhow!("unsupported NAL length size: {}", nal_length_size)),
            };
            offset += nal_length_size as usize;
            if offset + nal_len > data.len() { break; }
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
                let avg_brightness: u64 = rgb_buf.iter().map(|&b| b as u64).sum::<u64>()
                    / rgb_buf.len().max(1) as u64;
                if avg_brightness < 40 {
                    continue;
                }

                decoded_frame = Some((rgb_buf, w, h));
                break;
            }
        }
        if decoded_frame.is_some() { break; }
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

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let rgb = resized.to_rgb8();
    let file = std::fs::File::create(dest)
        .with_context(|| format!("failed to create video thumbnail: {}", dest.display()))?;
    let mut writer = std::io::BufWriter::new(file);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY);
    rgb.write_with_encoder(encoder)
        .with_context(|| format!("failed to encode video thumbnail: {}", dest.display()))?;

    Ok((rw, rh))
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
        let cleaned = cleaned.replace("**", "").replace("__", "").replace('*', "").replace('_', " ");
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

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a solid-color test image of given dimensions.
    fn create_test_image(path: &Path, width: u32, height: u32) {
        let img = image::RgbImage::from_fn(width, height, |_, _| image::Rgb([100, 150, 200]));
        img.save(path).unwrap();
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

        // Verify it's a valid image
        let img = image::open(&dest).unwrap();
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
}
