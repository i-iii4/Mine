// Media dimensions extraction and serialization.
//
// At index time we walk every media file referenced by a block (main
// media_file, first_image extracted from body, every markdown image URL),
// read each file's image header via `image::ImageReader::into_dimensions`,
// and collect the results into a JSON object:
//
//     {"photo.jpg": [1920, 1080], "diagram.png": [800, 600]}
//
// This is cheap — ImageReader reads only the header bytes, typically ~1ms
// per file. Called once per block at index time and never at render time,
// so it has zero impact on runtime performance.
//
// The JSON string is stored in `blocks.media_dimensions` and returned to
// the frontend inside LightBlock, so ArticleCard and SocialCard can render
// every embedded image at its exact aspect ratio — no fixed aspect crops,
// no runtime image loading.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use image::ImageReader;

/// Extract (width, height) from an image file header. Returns None on any
/// error (missing file, unsupported format, corrupt header). Header-only
/// read — does not decode the full image.
pub fn extract_image_dimensions(path: &Path) -> Option<(u32, u32)> {
    ImageReader::open(path).ok()?.into_dimensions().ok()
}

/// Extract (width, height) from an MP4 video file. Reads only the MP4
/// container header and the AVC1 sample entry — no decoding. Returns the
/// display dimensions of the first video track, which is what the browser
/// will render at.
///
/// Returns None on any error (missing file, not an MP4, no video track,
/// corrupt header). Other container formats (WebM, MOV) are not supported
/// here; the frontend falls back to a 16:9 aspect ratio for them.
pub fn extract_video_dimensions(path: &Path) -> Option<(u32, u32)> {
    let file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let reader = std::io::BufReader::new(file);
    let mp4 = mp4::Mp4Reader::read_header(reader, size).ok()?;

    for (_, track) in mp4.tracks() {
        if track.track_type().ok() == Some(mp4::TrackType::Video) {
            let w = track.width();
            let h = track.height();
            if w > 0 && h > 0 {
                return Some((w as u32, h as u32));
            }
        }
    }
    None
}

/// Collect unique media filenames referenced by a block body.
///
/// Scans markdown image syntax `![alt](filename)` and returns filenames
/// in encounter order, deduplicated. URLs starting with `http://` or
/// `https://` are skipped — they are remote and cannot be measured from
/// the vault filesystem.
fn collect_body_media(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut search_from = 0usize;
    while let Some(offset) = body[search_from..].find("![") {
        let start = search_from + offset;
        let Some(bracket) = body[start + 2..].find("](") else {
            search_from = start + 2;
            continue;
        };
        let url_start = start + 2 + bracket + 2;
        let Some(paren_end) = body[url_start..].find(')') else {
            search_from = url_start;
            continue;
        };
        let url = &body[url_start..url_start + paren_end];
        search_from = url_start + paren_end + 1;
        if url.is_empty() {
            continue;
        }
        if url.starts_with("http://") || url.starts_with("https://") {
            continue;
        }
        if seen.insert(url.to_string()) {
            out.push(url.to_string());
        }
    }
    out
}

/// Build the `media_dimensions` JSON string for a block.
///
/// The set of files we measure is the union of:
///   - `primary_media`: the block's main `media_file` if it is an image or MP4 video
///   - every filename extracted from markdown image syntax in the body
///
/// For each file we resolve its absolute path relative to `vault_root` and
/// read the container header via [`extract_image_dimensions`] or
/// [`extract_video_dimensions`] depending on the extension. Files that fail
/// to open or have unsupported formats are silently skipped — their absence
/// means the frontend will fall back to a fixed aspect.
///
/// Returns `None` when no dimensions could be extracted at all (block has
/// no media, or all files failed to read). The caller stores the result
/// as a nullable TEXT column.
pub fn build_media_dimensions_json(
    vault_root: &Path,
    primary_media: Option<&str>,
    body: &str,
) -> Option<String> {
    let mut filenames: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if let Some(name) = primary_media {
        if !name.is_empty()
            && (is_image_extension(name) || is_video_extension(name))
            && seen.insert(name.to_string())
        {
            filenames.push(name.to_string());
        }
    }
    for name in collect_body_media(body) {
        if !is_image_extension(&name) && !is_video_extension(&name) {
            continue;
        }
        if seen.insert(name.clone()) {
            filenames.push(name);
        }
    }

    if filenames.is_empty() {
        return None;
    }

    // BTreeMap for deterministic key ordering in the serialized JSON —
    // stable across re-indexings, easier to diff in tests.
    let mut dims: BTreeMap<String, [u32; 2]> = BTreeMap::new();
    for name in filenames {
        let path = vault_root.join(&name);
        let extracted = if is_image_extension(&name) {
            extract_image_dimensions(&path)
        } else if is_video_extension(&name) {
            extract_video_dimensions(&path)
        } else {
            None
        };
        if let Some((w, h)) = extracted {
            dims.insert(name, [w, h]);
        }
    }
    if dims.is_empty() {
        return None;
    }
    serde_json::to_string(&dims).ok()
}

/// Fast check whether a filename has an image extension. We only call the
/// image decoder for files that look like images, so other file types don't
/// trigger decoder failures.
fn is_image_extension(name: &str) -> bool {
    let lower = name.to_lowercase();
    matches!(
        lower
            .rsplit_once('.')
            .map(|(_, ext)| ext)
            .unwrap_or(""),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif" | "heic" | "heif"
    )
}

/// Check whether a filename has a video extension. We currently only extract
/// dimensions for MP4 via the `mp4` crate; other containers (WebM, MOV) fall
/// back to the frontend's default aspect ratio.
fn is_video_extension(name: &str) -> bool {
    let lower = name.to_lowercase();
    matches!(
        lower
            .rsplit_once('.')
            .map(|(_, ext)| ext)
            .unwrap_or(""),
        "mp4" | "m4v"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn collect_body_media_extracts_local_filenames() {
        let body = "Some ![alt](photo.jpg) text ![](diagram.png) and ![](https://x.com/a.jpg)";
        let got = collect_body_media(body);
        assert_eq!(
            got,
            vec!["photo.jpg".to_string(), "diagram.png".to_string()]
        );
    }

    #[test]
    fn collect_body_media_skips_remote_urls() {
        let body = "![](https://example.com/a.jpg) ![](local.png)";
        let got = collect_body_media(body);
        assert_eq!(got, vec!["local.png".to_string()]);
    }

    #[test]
    fn collect_body_media_deduplicates() {
        let body = "![](a.jpg) and ![](a.jpg) and ![](b.jpg)";
        let got = collect_body_media(body);
        assert_eq!(got, vec!["a.jpg".to_string(), "b.jpg".to_string()]);
    }

    #[test]
    fn is_image_extension_recognizes_common_formats() {
        assert!(is_image_extension("photo.jpg"));
        assert!(is_image_extension("Photo.JPEG"));
        assert!(is_image_extension("diagram.png"));
        assert!(is_image_extension("pic.webp"));
        assert!(!is_image_extension("video.mp4"));
        assert!(!is_image_extension("file.txt"));
        assert!(!is_image_extension("noext"));
    }

    #[test]
    fn is_video_extension_recognizes_mp4() {
        assert!(is_video_extension("clip.mp4"));
        assert!(is_video_extension("Clip.MP4"));
        assert!(is_video_extension("movie.m4v"));
        assert!(!is_video_extension("photo.jpg"));
        assert!(!is_video_extension("webm-not-supported.webm"));
    }

    #[test]
    fn build_media_dimensions_returns_none_when_no_media() {
        let dir = tempdir().unwrap();
        let result = build_media_dimensions_json(dir.path(), None, "just plain text");
        assert!(result.is_none());
    }

    #[test]
    fn build_media_dimensions_returns_none_when_files_missing() {
        let dir = tempdir().unwrap();
        let result = build_media_dimensions_json(
            dir.path(),
            Some("missing.jpg"),
            "![](also_missing.png)",
        );
        assert!(result.is_none());
    }

    #[test]
    fn build_media_dimensions_reads_real_image_file() {
        let dir = tempdir().unwrap();
        // Create a minimal 2×3 PNG
        let img = image::RgbImage::from_fn(2, 3, |_, _| image::Rgb([0, 0, 0]));
        let path = dir.path().join("tiny.png");
        img.save(&path).unwrap();

        let result = build_media_dimensions_json(dir.path(), None, "![](tiny.png)");
        let json = result.expect("should return JSON for existing image");
        assert!(json.contains("\"tiny.png\""));
        assert!(json.contains("[2,3]"));
    }

    #[test]
    fn build_media_dimensions_includes_primary_media_and_body() {
        let dir = tempdir().unwrap();
        let img_a = image::RgbImage::from_fn(10, 20, |_, _| image::Rgb([0, 0, 0]));
        img_a.save(dir.path().join("primary.png")).unwrap();
        let img_b = image::RgbImage::from_fn(30, 40, |_, _| image::Rgb([0, 0, 0]));
        img_b.save(dir.path().join("secondary.png")).unwrap();

        let json = build_media_dimensions_json(
            dir.path(),
            Some("primary.png"),
            "![](secondary.png)",
        )
        .unwrap();

        assert!(json.contains("\"primary.png\""));
        assert!(json.contains("[10,20]"));
        assert!(json.contains("\"secondary.png\""));
        assert!(json.contains("[30,40]"));
    }

    #[test]
    fn build_media_dimensions_skips_unparseable_video() {
        // A file with a video extension but bogus contents should not panic;
        // extraction fails gracefully and the entry is skipped.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("broken.mp4"), b"not really mp4").unwrap();
        let result = build_media_dimensions_json(dir.path(), None, "![](broken.mp4)");
        assert!(result.is_none());
    }

    #[test]
    fn build_media_dimensions_skips_non_media_extensions() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("doc.txt"), b"hello").unwrap();
        let result = build_media_dimensions_json(dir.path(), None, "![](doc.txt)");
        assert!(result.is_none());
    }

    #[test]
    fn build_media_dimensions_deduplicates_primary_and_body() {
        let dir = tempdir().unwrap();
        let img = image::RgbImage::from_fn(5, 7, |_, _| image::Rgb([0, 0, 0]));
        img.save(dir.path().join("same.png")).unwrap();

        let json = build_media_dimensions_json(
            dir.path(),
            Some("same.png"),
            "![](same.png)",
        )
        .unwrap();

        // Only one key in the JSON object.
        let occurrences = json.matches("\"same.png\"").count();
        assert_eq!(occurrences, 1);
    }
}
