// Thumbnails: image resize and caching.
//
// Generates thumbnail previews for block images.
// Max side = 480px (2x for Retina), saves as JPEG (quality 85).
// Does not upscale images smaller than max_size.
//
// Contract: SPEC_STORAGE.md#storage/thumbnails

use ab_glyph::{FontArc, PxScale};
use anyhow::{Context, Result};
use image::{GenericImageView, Rgb, RgbImage};
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

/// Background color (warm white).
const BG_COLOR: Rgb<u8> = Rgb([248, 248, 248]);

/// Text color (dark gray, matches --foreground light theme).
const TEXT_COLOR: Rgb<u8> = Rgb([80, 80, 80]);

/// Title text color (darker).
const TITLE_COLOR: Rgb<u8> = Rgb([51, 51, 51]);

/// Generate a text thumbnail: renders article title + first lines of body as an image.
///
/// - Creates a 480x480 JPEG with warm-white background
/// - Renders title in larger/bolder text, then body lines below
/// - Strips markdown formatting before rendering
/// - Saves as JPEG to `dest`
pub fn generate_text_thumbnail(
    title: Option<&str>,
    body: &str,
    dest: &Path,
) -> Result<(u32, u32)> {
    let font = &*FONT;

    let size = TEXT_THUMB_SIZE;
    let mut img = RgbImage::from_pixel(size, size, BG_COLOR);

    let usable_width = size - PADDING * 2;
    let line_step = (FONT_SIZE * LINE_HEIGHT) as u32;
    let mut y = PADDING;

    // Draw title (larger font)
    if let Some(title) = title {
        let title_scale = PxScale::from(FONT_SIZE * 1.3);
        let title_clean = strip_markdown(title);
        let wrapped = wrap_text(&title_clean, &font, title_scale, usable_width as f32);
        for line in wrapped.iter().take(2) {
            if y + line_step > size - PADDING {
                break;
            }
            draw_text_mut(&mut img, TITLE_COLOR, PADDING as i32, y as i32, title_scale, &font, line);
            y += (FONT_SIZE * 1.3 * LINE_HEIGHT) as u32;
        }
        y += line_step / 2; // gap after title
    }

    // Draw body lines
    let body_scale = PxScale::from(FONT_SIZE);
    let clean_body = strip_markdown(body);
    let wrapped = wrap_text(&clean_body, &font, body_scale, usable_width as f32);

    for line in &wrapped {
        if y + line_step > size - PADDING {
            break;
        }
        draw_text_mut(&mut img, TEXT_COLOR, PADDING as i32, y as i32, body_scale, &font, line);
        y += line_step;
    }

    // Save as JPEG
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let file = std::fs::File::create(dest)
        .with_context(|| format!("failed to create text thumbnail: {}", dest.display()))?;
    let mut writer = std::io::BufWriter::new(file);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY);
    img.write_with_encoder(encoder)
        .with_context(|| format!("failed to encode text thumbnail: {}", dest.display()))?;

    Ok((size, size))
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
