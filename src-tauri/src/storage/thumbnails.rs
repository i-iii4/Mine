// Thumbnails: image resize and caching.
//
// Generates thumbnail previews for block images.
// Max side = 480px (2x for Retina), saves as JPEG (quality 85).
// Does not upscale images smaller than max_size.
//
// Contract: SPEC_STORAGE.md#storage/thumbnails

use anyhow::{Context, Result};
use image::GenericImageView;
use std::path::Path;

/// Default max side for thumbnails: 480px covers 240px CSS columns at 2x Retina.
pub const DEFAULT_MAX_SIZE: u32 = 480;

const JPEG_QUALITY: u8 = 85;

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
