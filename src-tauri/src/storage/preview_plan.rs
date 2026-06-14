//! Shared preview-planning primitives.
//!
//! The app has two preview consumers for the same block:
//! - `<slug>.jpg` micro-preview thumbnail on disk;
//! - `preview_manifest` for full card rendering.
//!
//! Keep the stable asset path, media predicates, and preview budgets here so
//! the two pipelines cannot drift on the small-but-user-visible contract.

use std::path::{Path, PathBuf};

use crate::domain::block::{
    derive_card_kind, iter_inline_media_references, iter_inline_media_sources, Block, CardKind,
    InlineMediaReference,
};
use crate::domain::vault::VaultLayout;
use crate::storage::media_refs;

pub const PREVIEW_TILE_LIMIT: usize = 4;
pub const MICRO_PREVIEW_IMAGE_LIMIT: usize = 1;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "heic", "heif", "avif",
];
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "m4v", "mov"];

pub fn primary_preview_path(slug: &str) -> String {
    format!("{slug}.jpg")
}

/// Preview-path value for a per-media tile poster: the media filename with its
/// extension swapped for `.jpg`. Mirrors `Vault::media_thumb_path`; the value
/// goes into `FeedPreviewTile.preview_path` and is resolved on the frontend
/// via `previewAssetUrl(thumbsRoot, value)`.
pub fn media_poster_path(media_name: &str) -> String {
    let stem = media_name.rsplit_once('.').map_or(media_name, |(stem, _)| stem);
    format!("{stem}.jpg")
}

pub fn is_article_card(block: &Block) -> bool {
    derive_card_kind(block) == CardKind::Article
}

pub fn is_remote_media(src: &str) -> bool {
    src.starts_with("http://") || src.starts_with("https://")
}

pub fn media_ext_lower(src: &str) -> Option<String> {
    let clean = src.split('?').next().unwrap_or(src);
    Path::new(clean)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
}

pub fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

pub fn is_video_ext(ext: &str) -> bool {
    VIDEO_EXTS.contains(&ext)
}

pub fn is_image_media(src: &str) -> bool {
    media_ext_lower(src).as_deref().is_some_and(is_image_ext)
}

pub fn is_video_media(src: &str) -> bool {
    media_ext_lower(src).as_deref().is_some_and(is_video_ext)
}

pub fn local_media_items(media_urls: Option<&str>, predicate: fn(&str) -> bool) -> Vec<String> {
    let Some(media_urls) = media_urls else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(media_urls)
        .map(|urls| {
            urls.into_iter()
                .filter(|src| !is_remote_media(src) && predicate(src))
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewMediaKind {
    Image,
    Video,
}

impl PreviewMediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPreviewMedia {
    pub source: String,
    pub path: PathBuf,
    pub kind: PreviewMediaKind,
}

pub fn find_local_media(body: &str, ext_predicate: fn(&str) -> bool, limit: usize) -> Vec<String> {
    if limit == 0 {
        return Vec::new();
    }

    let mut results = Vec::new();
    for src in iter_inline_media_sources(body) {
        if src.is_empty() || is_remote_media(&src) {
            continue;
        }
        let ext = media_ext_lower(&src).unwrap_or_default();
        if ext_predicate(&ext) {
            results.push(src);
            if results.len() >= limit {
                break;
            }
        }
    }
    results
}

pub fn find_first_local_media(body: &str, ext_predicate: fn(&str) -> bool) -> Option<String> {
    find_local_media(body, ext_predicate, 1).into_iter().next()
}

pub fn find_first_local_media_any(body: &str) -> Option<(String, PreviewMediaKind)> {
    for src in iter_inline_media_sources(body) {
        if src.is_empty() || is_remote_media(&src) {
            continue;
        }
        let ext = media_ext_lower(&src).unwrap_or_default();
        if is_image_ext(&ext) {
            return Some((src, PreviewMediaKind::Image));
        }
        if is_video_ext(&ext) {
            return Some((src, PreviewMediaKind::Video));
        }
    }
    None
}

fn find_local_media_refs(
    body: &str,
    ext_predicate: fn(&str) -> bool,
    limit: usize,
) -> Vec<InlineMediaReference> {
    if limit == 0 {
        return Vec::new();
    }

    let mut results = Vec::new();
    for reference in iter_inline_media_references(body) {
        if reference.source.is_empty() || is_remote_media(&reference.source) {
            continue;
        }
        let ext = media_ext_lower(&reference.source).unwrap_or_default();
        if ext_predicate(&ext) {
            results.push(reference);
            if results.len() >= limit {
                break;
            }
        }
    }
    results
}

pub fn find_first_existing_body_media(
    block: &Block,
    vault: &VaultLayout,
    ext_predicate: fn(&str) -> bool,
) -> Option<(String, PathBuf)> {
    for reference in find_local_media_refs(&block.body, ext_predicate, usize::MAX) {
        if let Some(path) = media_refs::resolve_inline_media(vault, &block.slug, &reference) {
            return Some((reference.source, path));
        }
    }
    None
}

pub fn find_first_existing_article_media(
    block: &Block,
    vault: &VaultLayout,
) -> Option<ResolvedPreviewMedia> {
    if !is_article_card(block) {
        return None;
    }
    for reference in iter_inline_media_references(&block.body) {
        if reference.source.is_empty() || is_remote_media(&reference.source) {
            continue;
        }
        let ext = media_ext_lower(&reference.source).unwrap_or_default();
        let kind = if is_image_ext(&ext) {
            PreviewMediaKind::Image
        } else if is_video_ext(&ext) {
            PreviewMediaKind::Video
        } else {
            continue;
        };
        if let Some(path) = media_refs::resolve_inline_media(vault, &block.slug, &reference) {
            return Some(ResolvedPreviewMedia {
                source: reference.source,
                path,
                kind,
            });
        }
    }
    None
}

pub fn collect_article_preview_images(
    block: &Block,
    vault: &VaultLayout,
    limit: usize,
    is_decodable: fn(&Path) -> bool,
) -> Vec<PathBuf> {
    if !is_article_card(block) || limit == 0 {
        return Vec::new();
    }

    let mut seen = std::collections::HashSet::<String>::new();
    let mut paths = Vec::new();
    for reference in find_local_media_refs(&block.body, is_image_ext, limit.saturating_mul(3)) {
        if !seen.insert(reference.source.clone()) {
            continue;
        }
        if let Some(path) = media_refs::resolve_inline_media(vault, &block.slug, &reference) {
            if is_decodable(&path) {
                paths.push(path);
                if paths.len() >= limit {
                    break;
                }
            }
        }
    }
    paths
}

/// Resolve the body videos that occupy a visible gallery tile and therefore
/// need their own poster frame, as `(source, path)` pairs in document order.
///
/// Mirrors the manifest tile window — the first `PREVIEW_TILE_LIMIT` media
/// items (images and videos alike each consume a slot) — so the generated
/// posters line up 1:1 with the tiles the card renders. A video file cannot be
/// drawn into an `<img>`, so each such tile needs a `<media-stem>.jpg` poster,
/// distinct from the block's representative `<slug>.jpg`.
pub fn collect_gallery_video_posters(
    block: &Block,
    vault: &VaultLayout,
) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut tile_count = 0usize;
    for reference in iter_inline_media_references(&block.body) {
        if tile_count >= PREVIEW_TILE_LIMIT {
            break;
        }
        if reference.source.is_empty() || is_remote_media(&reference.source) {
            continue;
        }
        let ext = media_ext_lower(&reference.source).unwrap_or_default();
        let is_image = is_image_ext(&ext);
        let is_video = is_video_ext(&ext);
        if !is_image && !is_video {
            continue;
        }
        tile_count += 1;
        if is_video {
            if let Some(path) = media_refs::resolve_inline_media(vault, &block.slug, &reference) {
                out.push((reference.source, path));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primary_preview_path_is_slug_jpg() {
        assert_eq!(primary_preview_path("Sunset Tokyo"), "Sunset Tokyo.jpg");
    }

    #[test]
    fn media_poster_path_swaps_extension_for_jpg() {
        assert_eq!(media_poster_path("clip (video 1).mp4"), "clip (video 1).jpg");
        // Only the final extension is replaced.
        assert_eq!(media_poster_path("a.b.mov"), "a.b.jpg");
        // No extension → append .jpg.
        assert_eq!(media_poster_path("noext"), "noext.jpg");
    }

    #[test]
    fn is_remote_media_only_http_schemes() {
        assert!(is_remote_media("http://x.com/a.jpg"));
        assert!(is_remote_media("https://x.com/a.jpg"));
        assert!(!is_remote_media("a.jpg"));
        assert!(!is_remote_media("sub/a.jpg"));
    }

    #[test]
    fn media_ext_lower_strips_query_and_lowercases() {
        assert_eq!(media_ext_lower("photo.JPG").as_deref(), Some("jpg"));
        assert_eq!(media_ext_lower("clip.MP4?name=large").as_deref(), Some("mp4"));
        assert_eq!(media_ext_lower("noext"), None);
    }

    #[test]
    fn image_and_video_ext_predicates() {
        assert!(is_image_ext("png"));
        assert!(is_image_ext("avif"));
        assert!(!is_image_ext("mp4"));
        assert!(is_video_ext("mp4"));
        assert!(is_video_ext("webm"));
        assert!(!is_video_ext("png"));
    }

    #[test]
    fn image_and_video_media_classify_by_extension() {
        assert!(is_image_media("a/b.png"));
        assert!(!is_image_media("a/b.mp4"));
        assert!(is_video_media("a/b.mov"));
        assert!(!is_video_media("a/b.txt"));
    }

    #[test]
    fn local_media_items_filters_remote_and_predicate() {
        let json = r#"["local.png","https://x.com/remote.png","clip.mp4"]"#;
        assert_eq!(
            local_media_items(Some(json), is_image_media),
            vec!["local.png".to_string()]
        );
        assert_eq!(
            local_media_items(Some(json), is_video_media),
            vec!["clip.mp4".to_string()]
        );
        assert!(local_media_items(None, is_image_media).is_empty());
    }
}
