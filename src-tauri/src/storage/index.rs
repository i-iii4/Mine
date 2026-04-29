// Index: SQLite CRUD for blocks, channels, and tags.
//
// Converts domain::Block into database rows and reads them back.
// Handles FTS5 search queries with type and tag filters.
//
// Contract: SPEC_STORAGE.md#storage/index

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::domain::block::{
    extract_wikilinks, iter_inline_media_sources, normalize_local_markdown_url, Block, BlockType,
    DateTime, Frontmatter,
};
use crate::domain::channel::Channel;
use crate::domain::search::{SearchFilter, SearchQuery};
use crate::domain::vault::VaultLayout;
use crate::storage::media_dimensions::build_media_dimensions_json;

// ─── Types ──────────────────────────────────────────────────────────────────

/// A block as read from the database index.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IndexedBlock {
    pub id: i64,
    pub slug: String,
    pub block_type: BlockType,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub media_file: Option<String>,
    pub thumbnail: Option<String>,
    pub saved_at: String,
    pub source: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub author: Option<String>,
    pub body: String,
    pub media_dimensions: Option<String>,
    pub preview_manifest: Option<String>,
    pub feed_playback: Option<String>,
    pub related_notes: Vec<String>,
    pub origin: Option<String>,
    pub index_warning: Option<String>,
    pub tags: Vec<String>,
}

impl IndexedBlock {
    /// Project this DB snapshot back into a `domain::Block` suitable for
    /// thumb-pipeline consumers (`is_thumb_fresh`, `generate_for_block`,
    /// `preview_dependency_paths`).
    ///
    /// Channel-only frontmatter fields (`position`, `color`, `icon`) are
    /// not part of the `blocks` projection — they belong to channel docs
    /// which the thumb pipeline does not consult — so they default to
    /// `None`. Returns an error only when `saved_at` fails ISO-8601
    /// validation, which should not happen for rows written by this
    /// codebase but is guarded defensively.
    pub fn to_domain_block(&self) -> Result<Block, crate::domain::block::BlockError> {
        let saved_at = DateTime::new(&self.saved_at)?;
        Ok(Block {
            slug: self.slug.clone(),
            frontmatter: Frontmatter {
                block_type: self.block_type,
                title: self.title.clone(),
                description: self.description.clone(),
                url: self.url.clone(),
                file: self.media_file.clone(),
                thumbnail: self.thumbnail.clone(),
                tags: self.tags.clone(),
                related_notes: self.related_notes.clone(),
                source_media: None,
                saved_at,
                source: self.source.clone(),
                width: self.width,
                height: self.height,
                author: self.author.clone(),
                position: None,
                color: None,
                icon: None,
            },
            body: self.body.clone(),
        })
    }
}

/// A lightweight block for list/grid views. Body is truncated (max 500 chars),
/// description is omitted, source is omitted.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LightBlock {
    pub id: i64,
    pub slug: String,
    pub block_type: BlockType,
    pub title: Option<String>,
    pub url: Option<String>,
    pub media_file: Option<String>,
    pub thumbnail: Option<String>,
    pub saved_at: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub author: Option<String>,
    pub body: String,
    pub first_image: Option<String>,
    pub media_urls: Option<String>,
    pub media_dimensions: Option<String>,
    pub preview_manifest: Option<String>,
    pub feed_playback: Option<String>,
}

/// Minimal block projection for Phase 2 thumbnail upgrade candidate scans.
/// Keeps only the fields needed to resolve the original media source
/// without touching thumbnail files or article bodies on the UI thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingThumbUpgradeBlock {
    pub slug: String,
    pub media_file: Option<String>,
    pub thumbnail: Option<String>,
    pub first_image: Option<String>,
    pub media_urls: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedPreviewKind {
    Text,
    Image,
    VideoPoster,
    Composite,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeedPreviewTile {
    pub source_path: String,
    pub preview_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub is_video: bool,
    pub is_video_poster: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeedPreviewManifest {
    pub kind: FeedPreviewKind,
    pub primary_preview_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub tiles: Vec<FeedPreviewTile>,
    pub overflow_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FeedPlaybackContainer {
    #[serde(rename = "mp4")]
    Mp4,
    #[serde(rename = "webm")]
    Webm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FeedPlaybackKind {
    #[serde(rename = "single_video")]
    SingleVideo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FeedPlaybackProfile {
    #[serde(rename = "standard")]
    Standard,
    #[serde(rename = "heavy")]
    Heavy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedPlaybackDescriptor {
    pub kind: FeedPlaybackKind,
    pub source_path: String,
    pub poster_preview_path: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub container: FeedPlaybackContainer,
    pub profile: FeedPlaybackProfile,
}

const LIGHT_BLOCK_BODY_PREVIEW_CHARS: i64 = 220;
const FEED_AUTOPLAY_STANDARD_MAX_SOURCE_BYTES: u64 = 10 * 1024 * 1024;
const FEED_AUTOPLAY_STANDARD_MAX_LONGEST_SIDE_PX: u32 = 2560;
const FEED_AUTOPLAY_STANDARD_MAX_PIXEL_AREA: u64 = 4_000_000;
const FEED_AUTOPLAY_HARD_MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const FEED_AUTOPLAY_HARD_MAX_LONGEST_SIDE_PX: u32 = 5120;
const FEED_AUTOPLAY_HARD_MAX_PIXEL_AREA: u64 = 12_000_000;

/// A tag with its usage count across blocks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbFormat {
    Jpeg,
    Png,
}

impl ThumbFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Png => "png",
        }
    }

    fn from_db(value: &str) -> Option<Self> {
        match value {
            "jpeg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewBlock {
    pub slug: String,
    pub thumb_format: Option<ThumbFormat>,
    pub thumb_mtime: u64,
}

/// Extract the first inline media reference from body text.
fn extract_first_image(body: &str) -> Option<String> {
    iter_inline_media_sources(body).into_iter().next()
}

/// Extract all inline media references from body text as a JSON array.
fn extract_media_urls(body: &str) -> Option<String> {
    let urls = iter_inline_media_sources(body);
    if urls.is_empty() {
        None
    } else {
        serde_json::to_string(&urls).ok()
    }
}

fn serialize_related_notes(related_notes: &[String]) -> Option<String> {
    if related_notes.is_empty() {
        None
    } else {
        serde_json::to_string(related_notes).ok()
    }
}

fn parse_related_notes_json(raw: Option<String>) -> Vec<String> {
    raw.and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .unwrap_or_default()
}

fn is_social_url(url: Option<&str>) -> bool {
    let Some(url) = url else {
        return false;
    };
    let lc = url.to_lowercase();
    (lc.contains("twitter.com/") || lc.contains("x.com/")) && lc.contains("/status/")
        || lc.contains("instagram.com/p/")
        || lc.contains("instagram.com/reel/")
        || lc.contains("instagram.com/stories/")
}

fn is_remote_media(src: &str) -> bool {
    src.starts_with("http://") || src.starts_with("https://")
}

fn media_ext_lower(src: &str) -> Option<String> {
    let clean = src.split('?').next().unwrap_or(src);
    clean.rsplit('.').next().map(str::to_lowercase)
}

fn is_image_media(src: &str) -> bool {
    matches!(
        media_ext_lower(src).as_deref(),
        Some(
            "jpg"
                | "jpeg"
                | "png"
                | "gif"
                | "webp"
                | "bmp"
                | "tiff"
                | "tif"
                | "heic"
                | "heif"
                | "avif"
        )
    )
}

fn is_video_media(src: &str) -> bool {
    matches!(
        media_ext_lower(src).as_deref(),
        Some("mp4" | "webm" | "m4v" | "mov")
    )
}

fn parse_media_dimensions_json(
    media_dimensions: Option<&str>,
) -> std::collections::HashMap<String, [u32; 2]> {
    media_dimensions
        .and_then(|raw| {
            serde_json::from_str::<std::collections::HashMap<String, [u32; 2]>>(raw).ok()
        })
        .unwrap_or_default()
}

fn media_tile(
    src: &str,
    dims: &std::collections::HashMap<String, [u32; 2]>,
    is_video: bool,
    is_video_poster: bool,
) -> FeedPreviewTile {
    let dims_entry = dims.get(src).copied();
    FeedPreviewTile {
        source_path: src.to_string(),
        preview_path: None,
        width: dims_entry.map(|[w, _]| w),
        height: dims_entry.map(|[_, h]| h),
        is_video,
        is_video_poster,
    }
}

fn primary_preview_path(slug: &str) -> String {
    format!("{slug}.jpg")
}

fn dimensions_for_src(
    dims: &std::collections::HashMap<String, [u32; 2]>,
    src: Option<&str>,
    width: Option<u32>,
    height: Option<u32>,
) -> (Option<u32>, Option<u32>) {
    if let Some([w, h]) = src.and_then(|s| dims.get(s)).copied() {
        return (Some(w), Some(h));
    }
    (width, height)
}

/// Parse a single inline-media reference from one markdown line.
///
/// Recognizes both `![[name]]` / `![[name|alt]]` wikilinks and legacy
/// `![alt](url)` markdown. Returns the resolved reference in filesystem
/// form: wikilink names pass through verbatim (they always match disk);
/// markdown URLs get percent-decoded when local so consumers do not
/// need to know the underlying syntax or apply decoding themselves.
fn parse_inline_media_src(line: &str) -> Option<String> {
    let start = line.find("![")?;
    let after_excl = start + 2;
    if line[after_excl..].starts_with('[') {
        // Wikilink `![[name]]` or `![[name|alt]]`
        let name_start = after_excl + 1;
        let close_offset = line[name_start..].find("]]")?;
        let inner = &line[name_start..name_start + close_offset];
        let name = inner.split('|').next().unwrap_or(inner).trim();
        (!name.is_empty()).then(|| name.to_string())
    } else {
        // Standard `![alt](url)`
        let bracket_offset = line[after_excl..].find("](")?;
        let url_start = after_excl + bracket_offset + 2;
        let paren_end = line[url_start..].find(')')?;
        let src = &line[url_start..url_start + paren_end];
        (!src.is_empty()).then(|| normalize_local_markdown_url(src))
    }
}

fn extract_social_preview_tiles(
    body: &str,
    dims: &std::collections::HashMap<String, [u32; 2]>,
) -> Vec<FeedPreviewTile> {
    let first_section = body.split("\n---").next().unwrap_or(body);
    let mut tiles = Vec::new();
    let mut next_is_video_poster = false;

    for line in first_section.lines() {
        if line.trim() == "<!-- tweet-video -->" {
            next_is_video_poster = true;
            continue;
        }
        let Some(src) = parse_inline_media_src(line) else {
            continue;
        };
        // `parse_inline_media_src` already returns a filesystem-form
        // string: wikilinks pass through, percent-encoded markdown URLs
        // are decoded. Downstream consumers can look the file up by
        // this string directly.
        tiles.push(media_tile(
            &src,
            dims,
            is_video_media(&src),
            next_is_video_poster,
        ));
        next_is_video_poster = false;
    }

    tiles
}

fn extract_local_media_items(media_urls: Option<&str>, predicate: fn(&str) -> bool) -> Vec<String> {
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

fn serialize_feed_preview_manifest(
    block: &Block,
    width: Option<u32>,
    height: Option<u32>,
    media_dimensions: Option<&str>,
    media_urls: Option<&str>,
) -> Option<String> {
    let dims = parse_media_dimensions_json(media_dimensions);

    let manifest = match block.frontmatter.block_type {
        BlockType::Image => {
            let (preview_width, preview_height) =
                dimensions_for_src(&dims, block.frontmatter.file.as_deref(), width, height);
            FeedPreviewManifest {
                kind: FeedPreviewKind::Image,
                primary_preview_path: Some(primary_preview_path(&block.slug)),
                width: preview_width,
                height: preview_height,
                tiles: Vec::new(),
                overflow_count: 0,
            }
        }
        BlockType::Link => FeedPreviewManifest {
            kind: if block.frontmatter.thumbnail.is_some() {
                FeedPreviewKind::Image
            } else {
                FeedPreviewKind::Text
            },
            primary_preview_path: block
                .frontmatter
                .thumbnail
                .as_ref()
                .map(|_| primary_preview_path(&block.slug)),
            width: None,
            height: None,
            tiles: Vec::new(),
            overflow_count: 0,
        },
        BlockType::Video => FeedPreviewManifest {
            kind: FeedPreviewKind::VideoPoster,
            primary_preview_path: Some(primary_preview_path(&block.slug)),
            width,
            height,
            tiles: block
                .frontmatter
                .file
                .as_deref()
                .map(|src| {
                    vec![FeedPreviewTile {
                        source_path: src.to_string(),
                        preview_path: Some(primary_preview_path(&block.slug)),
                        width,
                        height,
                        is_video: true,
                        is_video_poster: true,
                    }]
                })
                .or_else(|| {
                    block.frontmatter.thumbnail.as_deref().map(|src| {
                        vec![FeedPreviewTile {
                            source_path: src.to_string(),
                            preview_path: Some(primary_preview_path(&block.slug)),
                            width,
                            height,
                            is_video: false,
                            is_video_poster: true,
                        }]
                    })
                })
                .unwrap_or_default(),
            overflow_count: 0,
        },
        BlockType::File | BlockType::Channel => FeedPreviewManifest {
            kind: FeedPreviewKind::Text,
            primary_preview_path: None,
            width: None,
            height: None,
            tiles: Vec::new(),
            overflow_count: 0,
        },
        BlockType::Article => {
            if is_social_url(block.frontmatter.url.as_deref()) {
                let mut tiles = extract_social_preview_tiles(&block.body, &dims);
                if tiles.is_empty() {
                    tiles = extract_local_media_items(media_urls, |_| true)
                        .into_iter()
                        .map(|src| media_tile(&src, &dims, false, false))
                        .collect();
                }
                let overflow_count = tiles.len().saturating_sub(4);
                let tiles = tiles.into_iter().take(4).collect::<Vec<_>>();

                match tiles.as_slice() {
                    [] => FeedPreviewManifest {
                        kind: FeedPreviewKind::Text,
                        primary_preview_path: None,
                        width: None,
                        height: None,
                        tiles,
                        overflow_count: 0,
                    },
                    [single] => FeedPreviewManifest {
                        kind: if single.is_video {
                            FeedPreviewKind::VideoPoster
                        } else {
                            FeedPreviewKind::Image
                        },
                        primary_preview_path: Some(primary_preview_path(&block.slug)),
                        width: single.width,
                        height: single.height,
                        tiles,
                        overflow_count,
                    },
                    _ => FeedPreviewManifest {
                        kind: FeedPreviewKind::Composite,
                        primary_preview_path: Some(primary_preview_path(&block.slug)),
                        width: Some(1),
                        height: Some(1),
                        tiles,
                        overflow_count,
                    },
                }
            } else {
                let image_tiles = extract_local_media_items(media_urls, is_image_media)
                    .into_iter()
                    .map(|src| media_tile(&src, &dims, false, false))
                    .collect::<Vec<_>>();
                let overflow_count = image_tiles.len().saturating_sub(4);
                let image_tiles = image_tiles.into_iter().take(4).collect::<Vec<_>>();

                if image_tiles.len() >= 2 {
                    FeedPreviewManifest {
                        kind: FeedPreviewKind::Composite,
                        primary_preview_path: Some(primary_preview_path(&block.slug)),
                        width: Some(1),
                        height: Some(1),
                        tiles: image_tiles,
                        overflow_count,
                    }
                } else if let Some(single) = image_tiles.first() {
                    FeedPreviewManifest {
                        kind: FeedPreviewKind::Image,
                        primary_preview_path: Some(primary_preview_path(&block.slug)),
                        width: single.width,
                        height: single.height,
                        tiles: image_tiles,
                        overflow_count: 0,
                    }
                } else if let Some(video_src) =
                    extract_local_media_items(media_urls, is_video_media)
                        .into_iter()
                        .next()
                {
                    FeedPreviewManifest {
                        kind: FeedPreviewKind::VideoPoster,
                        primary_preview_path: Some(primary_preview_path(&block.slug)),
                        width: None,
                        height: None,
                        tiles: vec![media_tile(&video_src, &dims, true, true)],
                        overflow_count: 0,
                    }
                } else {
                    FeedPreviewManifest {
                        kind: FeedPreviewKind::Text,
                        primary_preview_path: None,
                        width: None,
                        height: None,
                        tiles: Vec::new(),
                        overflow_count: 0,
                    }
                }
            }
        }
    };

    serde_json::to_string(&manifest).ok()
}

fn serialize_feed_preview_manifest_from_index_row(
    slug: &str,
    block_type: BlockType,
    url: Option<&str>,
    media_file: Option<&str>,
    thumbnail: Option<&str>,
    width: Option<u32>,
    height: Option<u32>,
    body: &str,
    media_dimensions: Option<&str>,
    media_urls: Option<&str>,
) -> Option<String> {
    let block = Block {
        slug: slug.to_string(),
        frontmatter: Frontmatter {
            block_type,
            title: None,
            description: None,
            url: url.map(str::to_string),
            file: media_file.map(str::to_string),
            thumbnail: thumbnail.map(str::to_string),
            tags: Vec::new(),
            related_notes: Vec::new(),
            source_media: None,
            saved_at: DateTime::new("1970-01-01T00:00:00Z").ok()?,
            source: None,
            width,
            height,
            author: None,
            position: None,
            color: None,
            icon: None,
        },
        body: body.to_string(),
    };

    serialize_feed_preview_manifest(&block, width, height, media_dimensions, media_urls)
}

fn parse_feed_preview_manifest(raw: Option<&str>) -> Option<FeedPreviewManifest> {
    raw.and_then(|value| serde_json::from_str::<FeedPreviewManifest>(value).ok())
}

fn autoplay_container_for_source(src: &str) -> Option<FeedPlaybackContainer> {
    if is_remote_media(src) {
        return None;
    }
    match media_ext_lower(src).as_deref() {
        Some("mp4") => Some(FeedPlaybackContainer::Mp4),
        Some("webm") => Some(FeedPlaybackContainer::Webm),
        _ => None,
    }
}

fn local_media_file_size_bytes(vault_root: &Path, source_path: &str) -> Option<u64> {
    if is_remote_media(source_path) {
        return None;
    }
    let metadata = std::fs::metadata(vault_root.join(source_path)).ok()?;
    metadata.is_file().then_some(metadata.len())
}

fn feed_autoplay_dimensions_within_limits(
    width: Option<u32>,
    height: Option<u32>,
    longest_side_limit: u32,
    pixel_area_limit: u64,
) -> bool {
    if let Some(longest_side) = width.max(height) {
        if longest_side > longest_side_limit {
            return false;
        }
    }

    if let (Some(width), Some(height)) = (width, height) {
        if u64::from(width) * u64::from(height) > pixel_area_limit {
            return false;
        }
    }

    true
}

fn feed_autoplay_profile_for_source(
    vault_root: Option<&Path>,
    source_path: &str,
    width: Option<u32>,
    height: Option<u32>,
) -> Option<FeedPlaybackProfile> {
    if !feed_autoplay_dimensions_within_limits(
        width,
        height,
        FEED_AUTOPLAY_HARD_MAX_LONGEST_SIDE_PX,
        FEED_AUTOPLAY_HARD_MAX_PIXEL_AREA,
    ) {
        return None;
    }

    match vault_root {
        Some(root) => {
            let bytes = local_media_file_size_bytes(root, source_path)?;
            if bytes > FEED_AUTOPLAY_HARD_MAX_SOURCE_BYTES {
                return None;
            }
            if bytes <= FEED_AUTOPLAY_STANDARD_MAX_SOURCE_BYTES
                && feed_autoplay_dimensions_within_limits(
                    width,
                    height,
                    FEED_AUTOPLAY_STANDARD_MAX_LONGEST_SIDE_PX,
                    FEED_AUTOPLAY_STANDARD_MAX_PIXEL_AREA,
                )
            {
                Some(FeedPlaybackProfile::Standard)
            } else {
                Some(FeedPlaybackProfile::Heavy)
            }
        }
        None => {
            if feed_autoplay_dimensions_within_limits(
                width,
                height,
                FEED_AUTOPLAY_STANDARD_MAX_LONGEST_SIDE_PX,
                FEED_AUTOPLAY_STANDARD_MAX_PIXEL_AREA,
            ) {
                Some(FeedPlaybackProfile::Standard)
            } else {
                Some(FeedPlaybackProfile::Heavy)
            }
        }
    }
}

fn serialize_feed_playback(
    vault_root: Option<&Path>,
    block_type: BlockType,
    media_file: Option<&str>,
    width: Option<u32>,
    height: Option<u32>,
    preview_manifest: Option<&str>,
    thumb_format: Option<ThumbFormat>,
) -> Option<String> {
    if thumb_format.is_none() {
        return None;
    }

    let manifest = parse_feed_preview_manifest(preview_manifest)?;
    let poster_preview_path = manifest.primary_preview_path?;

    let (source_path, playback_width, playback_height) = match block_type {
        BlockType::Video => {
            let source_path = media_file?;
            let container = autoplay_container_for_source(source_path)?;
            let profile = feed_autoplay_profile_for_source(vault_root, source_path, width, height)?;
            let descriptor = FeedPlaybackDescriptor {
                kind: FeedPlaybackKind::SingleVideo,
                source_path: source_path.to_string(),
                poster_preview_path,
                width,
                height,
                container,
                profile,
            };
            return serde_json::to_string(&descriptor).ok();
        }
        BlockType::Article => {
            if manifest.kind != FeedPreviewKind::VideoPoster
                || manifest.overflow_count != 0
                || manifest.tiles.len() != 1
            {
                return None;
            }

            let tile = manifest.tiles.first()?;
            if !tile.is_video {
                return None;
            }
            (
                tile.source_path.clone(),
                tile.width.or(manifest.width),
                tile.height.or(manifest.height),
            )
        }
        _ => return None,
    };

    let container = autoplay_container_for_source(&source_path)?;
    let profile = feed_autoplay_profile_for_source(
        vault_root,
        &source_path,
        playback_width,
        playback_height,
    )?;
    let descriptor = FeedPlaybackDescriptor {
        kind: FeedPlaybackKind::SingleVideo,
        source_path,
        poster_preview_path,
        width: playback_width,
        height: playback_height,
        container,
        profile,
    };
    serde_json::to_string(&descriptor).ok()
}

fn read_thumb_metadata_from_disk(path: &Path) -> Option<(ThumbFormat, u64)> {
    use std::io::Read;

    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();

    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 3];
    file.read_exact(&mut buf).ok()?;

    let format = match buf {
        [0xFF, 0xD8, 0xFF] => ThumbFormat::Jpeg,
        [0x89, 0x50, 0x4E] => ThumbFormat::Png,
        _ => return None,
    };

    Some((format, mtime))
}

fn row_to_preview_block(
    row: &rusqlite::Row<'_>,
    slug_index: usize,
) -> rusqlite::Result<PreviewBlock> {
    let thumb_format = row
        .get::<_, Option<String>>(slug_index + 1)?
        .as_deref()
        .and_then(ThumbFormat::from_db);
    let thumb_mtime = row
        .get::<_, Option<i64>>(slug_index + 2)?
        .unwrap_or(0)
        .max(0) as u64;

    Ok(PreviewBlock {
        slug: row.get(slug_index)?,
        thumb_format,
        thumb_mtime,
    })
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Insert or update a block in the index. Returns the block's row id.
///
/// On conflict (same slug): updates all fields, replaces tags and wikilinks.
/// FTS5 is updated automatically through triggers.
///
/// `vault_root` is used to resolve media filenames when extracting image
/// dimensions for the `media_dimensions` JSON column. Callers that don't
/// have a vault path context (tests, migration tools) can pass `None`,
/// in which case the dimensions column is left NULL and the frontend
/// falls back to a fixed aspect ratio.
pub fn upsert_block(conn: &Connection, block: &Block, vault_root: Option<&Path>) -> Result<i64> {
    upsert_block_with_diagnostics(conn, block, vault_root, None, None)
}

pub fn upsert_block_with_diagnostics(
    conn: &Connection,
    block: &Block,
    vault_root: Option<&Path>,
    origin: Option<&str>,
    index_warning: Option<&str>,
) -> Result<i64> {
    // Use SAVEPOINT via raw SQL for nestability — this works both standalone
    // and inside an outer transaction (e.g. full_scan).
    conn.execute_batch("SAVEPOINT upsert_block")
        .context("failed to begin savepoint for upsert_block")?;

    let result = upsert_block_inner(conn, block, vault_root, origin, index_warning);

    match &result {
        Ok(_) => {
            conn.execute_batch("RELEASE SAVEPOINT upsert_block")
                .context("failed to release savepoint")?;
        }
        Err(_) => {
            let _ = conn.execute_batch("ROLLBACK TO SAVEPOINT upsert_block");
            let _ = conn.execute_batch("RELEASE SAVEPOINT upsert_block");
        }
    }

    result
}

fn upsert_block_inner(
    conn: &Connection,
    block: &Block,
    vault_root: Option<&Path>,
    origin: Option<&str>,
    index_warning: Option<&str>,
) -> Result<i64> {
    let first_image = extract_first_image(&block.body);
    let media_urls = extract_media_urls(&block.body);
    let media_dimensions = vault_root.and_then(|root| {
        build_media_dimensions_json(root, block.frontmatter.file.as_deref(), &block.body)
    });

    // Width/height priority: (1) existing DB row if present, (2) frontmatter,
    // (3) extract from file as last resort. Reading dimensions from image
    // files is expensive on main thread (image crate 0.25 reads whole JPEG,
    // not just header), so we avoid re-reading on every full_scan. File
    // extraction runs only for blocks that truly lack dimensions.
    let existing_row: Option<(Option<(u32, u32)>, Option<ThumbFormat>)> = conn
        .query_row(
            "SELECT width, height, thumb_format FROM blocks WHERE slug = ?1",
            [&block.slug],
            |row| {
                let w: Option<i64> = row.get(0)?;
                let h: Option<i64> = row.get(1)?;
                let thumb_format = row
                    .get::<_, Option<String>>(2)?
                    .as_deref()
                    .and_then(ThumbFormat::from_db);
                Ok((w.zip(h).map(|(w, h)| (w as u32, h as u32)), thumb_format))
            },
        )
        .ok();

    let existing_dims = existing_row.as_ref().and_then(|(dims, _)| *dims);
    let existing_thumb_format = existing_row.and_then(|(_, thumb_format)| thumb_format);

    let (width, height) = if let Some((w, h)) = existing_dims {
        (Some(w), Some(h))
    } else if let (Some(w), Some(h)) = (block.frontmatter.width, block.frontmatter.height) {
        (Some(w), Some(h))
    } else {
        // Last resort: read from file. One-time cost per block, cached in DB.
        vault_root
            .and_then(|root| {
                let file_name = block.frontmatter.file.as_deref()?;
                let path = root.join(file_name);
                use crate::storage::media_dimensions::{
                    extract_image_dimensions, extract_video_dimensions,
                };
                let ext = path.extension()?.to_str()?.to_lowercase();
                if matches!(ext.as_str(), "mp4" | "m4v") {
                    extract_video_dimensions(&path)
                } else {
                    extract_image_dimensions(&path)
                }
            })
            .map(|(w, h)| (Some(w), Some(h)))
            .unwrap_or((None, None))
    };
    let preview_manifest = serialize_feed_preview_manifest(
        block,
        width,
        height,
        media_dimensions.as_deref(),
        media_urls.as_deref(),
    );
    let feed_playback = serialize_feed_playback(
        vault_root,
        block.frontmatter.block_type,
        block.frontmatter.file.as_deref(),
        width,
        height,
        preview_manifest.as_deref(),
        existing_thumb_format,
    );
    let related_notes = serialize_related_notes(&block.frontmatter.related_notes);

    // Compute body hash at index time so watcher rename detection
    // (Phase 18.G) can match Remove+Create events without reading the
    // file off disk at event time.
    let body_hash = crate::domain::block::compute_body_hash(&block.body);

    conn.execute(
        "INSERT INTO blocks (slug, block_type, title, description, url, media_file,
            thumbnail, saved_at, source, width, height, author, body, first_image,
            media_urls, media_dimensions, preview_manifest, feed_playback, related_notes, body_hash,
            origin, index_warning)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
         ON CONFLICT(slug) DO UPDATE SET
            block_type = excluded.block_type,
            title = excluded.title,
            description = excluded.description,
            url = excluded.url,
            media_file = excluded.media_file,
            thumbnail = excluded.thumbnail,
            saved_at = excluded.saved_at,
            source = excluded.source,
            width = excluded.width,
            height = excluded.height,
            author = excluded.author,
            body = excluded.body,
            first_image = excluded.first_image,
            media_urls = excluded.media_urls,
            media_dimensions = excluded.media_dimensions,
            preview_manifest = excluded.preview_manifest,
            feed_playback = excluded.feed_playback,
            related_notes = excluded.related_notes,
            body_hash = excluded.body_hash,
            origin = excluded.origin,
            index_warning = excluded.index_warning,
            indexed_at = datetime('now')",
        params![
            block.slug,
            block.frontmatter.block_type.as_str(),
            block.frontmatter.title,
            block.frontmatter.description,
            block.frontmatter.url,
            block.frontmatter.file,
            block.frontmatter.thumbnail,
            block.frontmatter.saved_at.as_str(),
            block.frontmatter.source,
            width.map(|w| w as i64),
            height.map(|h| h as i64),
            block.frontmatter.author,
            block.body,
            first_image,
            media_urls,
            media_dimensions,
            preview_manifest,
            feed_playback,
            related_notes,
            body_hash,
            origin,
            index_warning,
        ],
    )
    .context("failed to upsert block")?;

    let block_id: i64 = conn
        .query_row(
            "SELECT id FROM blocks WHERE slug = ?1",
            [&block.slug],
            |row| row.get(0),
        )
        .context("failed to get block id after upsert")?;

    // Replace tags: delete old, insert new.
    conn.execute("DELETE FROM block_tags WHERE block_id = ?1", [block_id])
        .context("failed to delete old tags")?;
    for tag in &block.frontmatter.tags {
        conn.execute(
            "INSERT INTO block_tags (block_id, tag) VALUES (?1, ?2)",
            params![block_id, tag],
        )
        .context("failed to insert tag")?;
    }

    // Replace wikilinks: delete old, insert new.
    conn.execute("DELETE FROM wikilinks WHERE source_id = ?1", [block_id])
        .context("failed to delete old wikilinks")?;
    let mut links = extract_wikilinks(&block.body);
    for note in &block.frontmatter.related_notes {
        if !links.contains(note) {
            links.push(note.clone());
        }
    }
    for link in &links {
        conn.execute(
            "INSERT OR IGNORE INTO wikilinks (source_id, target_slug) VALUES (?1, ?2)",
            params![block_id, link],
        )
        .context("failed to insert wikilink")?;
    }

    Ok(block_id)
}

/// Remove a block from the index by slug. Returns true if a block was removed.
pub fn remove_block(conn: &Connection, slug: &str) -> Result<bool> {
    let count = conn
        .execute("DELETE FROM blocks WHERE slug = ?1", [slug])
        .context("failed to delete block")?;
    Ok(count > 0)
}

/// Sync thumbnail metadata columns from the on-disk thumb file.
/// Returns true when the row changed.
pub fn sync_thumb_metadata(
    conn: &Connection,
    slug: &str,
    thumb_path: &Path,
    vault_root: Option<&Path>,
) -> Result<bool> {
    let current = conn
        .query_row(
            "SELECT thumb_format, thumb_mtime FROM blocks WHERE slug = ?1",
            [slug],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                ))
            },
        )
        .optional()?;
    let Some((current_format, current_mtime)) = current else {
        return Ok(false);
    };

    let next = read_thumb_metadata_from_disk(thumb_path);
    let next_format = next.map(|(format, _)| format.as_str().to_string());
    let next_mtime = next.map(|(_, mtime)| mtime as i64);

    if current_format == next_format && current_mtime == next_mtime {
        return Ok(false);
    }

    let feed_playback = conn
        .query_row(
            "SELECT block_type, media_file, width, height, preview_manifest
             FROM blocks WHERE slug = ?1",
            [slug],
            |row| {
                let raw_type: String = row.get(0)?;
                let block_type = BlockType::from_str(&raw_type).map_err(|_| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        format!("unknown block_type: {}", raw_type).into(),
                    )
                })?;
                Ok(serialize_feed_playback(
                    vault_root,
                    block_type,
                    row.get::<_, Option<String>>(1)?.as_deref(),
                    row.get::<_, Option<i64>>(2)?.map(|v| v as u32),
                    row.get::<_, Option<i64>>(3)?.map(|v| v as u32),
                    row.get::<_, Option<String>>(4)?.as_deref(),
                    next.map(|(format, _)| format),
                ))
            },
        )
        .optional()?
        .flatten();

    conn.execute(
        "UPDATE blocks
         SET thumb_format = ?2, thumb_mtime = ?3, feed_playback = ?4
         WHERE slug = ?1",
        params![slug, next_format, next_mtime, feed_playback],
    )?;
    Ok(true)
}

/// Clear thumbnail metadata for an indexed block. Returns true when changed.
pub fn clear_thumb_metadata(conn: &Connection, slug: &str) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE blocks
         SET thumb_format = NULL, thumb_mtime = NULL, feed_playback = NULL
         WHERE slug = ?1
           AND (thumb_format IS NOT NULL OR thumb_mtime IS NOT NULL)",
        [slug],
    )?;
    Ok(changed > 0)
}

/// Backfill thumbnail metadata for legacy vaults that already have thumb files
/// on disk but predate the `thumb_format` / `thumb_mtime` columns.
/// Returns the number of rows updated.
pub fn backfill_missing_thumb_metadata(conn: &Connection, vault: &VaultLayout) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT slug
         FROM blocks
         WHERE slug != ''
           AND block_type != 'channel'
           AND (thumb_format IS NULL OR thumb_mtime IS NULL)",
    )?;

    let slugs = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut updated = 0usize;
    for slug in slugs {
        if sync_thumb_metadata(conn, &slug, &vault.thumb_path(&slug), Some(vault.root()))? {
            updated += 1;
        }
    }

    Ok(updated)
}

/// Backfill preview manifests for legacy rows that predate the
/// `preview_manifest` column but already have enough indexed content to derive
/// the current feed preview contract.
pub fn backfill_missing_preview_manifest(conn: &Connection) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT slug, block_type, url, media_file, thumbnail, width, height, body, media_dimensions, media_urls
         FROM blocks
         WHERE slug != ''
           AND block_type != 'channel'
           AND preview_manifest IS NULL",
    )?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut updated = 0usize;
    for (
        slug,
        raw_type,
        url,
        media_file,
        thumbnail,
        width,
        height,
        body,
        media_dimensions,
        media_urls,
    ) in rows
    {
        let block_type = BlockType::from_str(&raw_type).with_context(|| {
            format!("unknown block_type in preview manifest backfill: {raw_type}")
        })?;
        let Some(preview_manifest) = serialize_feed_preview_manifest_from_index_row(
            &slug,
            block_type,
            url.as_deref(),
            media_file.as_deref(),
            thumbnail.as_deref(),
            width.map(|value| value as u32),
            height.map(|value| value as u32),
            &body,
            media_dimensions.as_deref(),
            media_urls.as_deref(),
        ) else {
            continue;
        };

        updated += conn.execute(
            "UPDATE blocks
             SET preview_manifest = ?2
             WHERE slug = ?1
               AND preview_manifest IS NULL",
            params![slug, preview_manifest],
        )?;
    }

    Ok(updated)
}

/// Reconcile feed playback descriptors against the current autoplay policy.
///
/// This restores missing descriptors for legacy rows and clears stale ones
/// when the current policy no longer allows autoplay for a block.
pub fn backfill_missing_feed_playback(conn: &Connection, vault: &VaultLayout) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT slug, block_type, media_file, width, height, preview_manifest, thumb_format, feed_playback
         FROM blocks
         WHERE slug != ''
           AND block_type IN ('video', 'article')",
    )?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut updated = 0usize;
    for (
        slug,
        raw_type,
        media_file,
        width,
        height,
        preview_manifest,
        raw_thumb_format,
        current_feed_playback,
    ) in rows
    {
        let block_type = BlockType::from_str(&raw_type)
            .with_context(|| format!("unknown block_type in feed playback backfill: {raw_type}"))?;
        let thumb_format = raw_thumb_format.as_deref().and_then(ThumbFormat::from_db);
        let next_feed_playback = serialize_feed_playback(
            Some(vault.root()),
            block_type,
            media_file.as_deref(),
            width.map(|value| value as u32),
            height.map(|value| value as u32),
            preview_manifest.as_deref(),
            thumb_format,
        );

        if current_feed_playback == next_feed_playback {
            continue;
        }

        updated += conn.execute(
            "UPDATE blocks
             SET feed_playback = ?2
             WHERE slug = ?1",
            params![slug, next_feed_playback],
        )?;
    }

    Ok(updated)
}

/// Check if a slug already exists in the index.
pub fn slug_exists(conn: &Connection, slug: &str) -> Result<bool> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM blocks WHERE slug = ?1)",
            [slug],
            |row| row.get(0),
        )
        .context("failed to check slug existence")?;
    Ok(exists)
}

/// Escape SQL LIKE wildcards so they match as literal characters.
///
/// SQLite LIKE treats `%` as "any sequence" and `_` as "any single char".
/// A slug that itself contains `%`, `_`, or `\` would otherwise cause the
/// LIKE pattern to match far more than intended (e.g. a slug "50%" would
/// silently match every other slug in the table).
///
/// Paired with `ESCAPE '\'` in the SQL statement.
fn escape_like_pattern(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Given a raw slug, return a unique variant that does not collide with existing slugs.
/// Tries `raw_slug` first, then `raw_slug (2)`, `raw_slug (3)`, ..., up to `raw_slug (1000)`.
///
/// The parenthetical suffix matches the human-readable filename convention
/// established in Phase 18.C and the Obsidian duplicate-rename behavior.
/// Safe for slugs containing Unicode, spaces, parentheses, and any characters
/// allowed by filesystem naming. LIKE wildcards (`%`, `_`, `\`) in the slug
/// are escaped so they match literally.
pub fn resolve_unique_slug(conn: &Connection, raw_slug: &str) -> Result<String> {
    let escaped = escape_like_pattern(raw_slug);
    let pattern = format!("{escaped} (%)");
    let mut stmt = conn.prepare(
        "SELECT slug
         FROM blocks
         WHERE slug = ?1 OR slug LIKE ?2 ESCAPE '\\'",
    )?;

    let rows = stmt.query_map(params![raw_slug, pattern], |row| row.get::<_, String>(0))?;

    let mut exact_exists = false;
    let mut used_suffixes = std::collections::HashSet::<u32>::new();
    for row in rows {
        let slug = row?;
        if slug == raw_slug {
            exact_exists = true;
            continue;
        }
        // Parse `<raw_slug> (N)` suffix — strip the literal " (" prefix
        // and the trailing ")", then parse N.
        let Some(tail) = slug
            .strip_prefix(raw_slug)
            .and_then(|rest| rest.strip_prefix(" ("))
            .and_then(|rest| rest.strip_suffix(')'))
        else {
            continue;
        };
        if let Ok(n) = tail.parse::<u32>() {
            used_suffixes.insert(n);
        }
    }

    if !exact_exists {
        return Ok(raw_slug.to_string());
    }

    for n in 2..=1000u32 {
        if !used_suffixes.contains(&n) {
            return Ok(format!("{} ({})", raw_slug, n));
        }
    }

    anyhow::bail!(
        "could not resolve slug conflict for '{}' after 1000 attempts",
        raw_slug
    );
}

/// Look up the stored body hash for a given slug.
///
/// Returns `None` if the slug does not exist or its `body_hash` column is
/// NULL (e.g. a pre-18.G row that has not been re-indexed yet). Used by
/// watcher rename detection to match a pending Remove against a later
/// Create with identical content.
pub fn lookup_body_hash(conn: &Connection, slug: &str) -> Result<Option<String>> {
    let hash: Option<String> = conn
        .query_row(
            "SELECT body_hash FROM blocks WHERE slug = ?1",
            [slug],
            |row| row.get(0),
        )
        .optional()
        .context("failed to look up body_hash")?
        .flatten();
    Ok(hash)
}

/// Rename a block's slug in place, preserving its `id` and all relations
/// (tags, wikilinks, preview_manifest, feed_playback, cached metadata).
///
/// Returns `Ok(true)` if the rename was performed, `Ok(false)` if
/// `old_slug` does not exist. Returns an error if `new_slug` is already
/// taken by another block (caller should either finalize as two separate
/// blocks or resolve conflict beforehand).
///
/// Contract: Phase 18.G watcher invokes this when a Remove+Create event
/// pair shares the same body_hash in the pending debounce window.
pub fn rename_slug(conn: &Connection, old_slug: &str, new_slug: &str) -> Result<bool> {
    if old_slug == new_slug {
        return Ok(false);
    }
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM blocks WHERE slug = ?1", [new_slug], |row| {
            row.get(0)
        })
        .optional()
        .context("failed to check target slug availability")?;
    if existing.is_some() {
        anyhow::bail!("rename target slug '{}' already exists in index", new_slug);
    }

    let affected = conn
        .execute(
            "UPDATE blocks SET slug = ?1, indexed_at = datetime('now') WHERE slug = ?2",
            params![new_slug, old_slug],
        )
        .context("failed to update slug")?;
    Ok(affected > 0)
}

// ─── vault_conflicts surface ────────────────────────────────────────────────

/// Record a pending iCloud-style conflict between `base_slug` and `conflict_slug`.
/// Idempotent — repeated detection during scans does not duplicate rows.
pub fn record_vault_conflict(
    conn: &Connection,
    base_slug: &str,
    conflict_slug: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO vault_conflicts (base_slug, conflict_slug)
         VALUES (?1, ?2)",
        params![base_slug, conflict_slug],
    )
    .context("failed to record vault conflict")?;
    Ok(())
}

/// A pending iCloud conflict awaiting user resolution.
#[derive(Debug, Clone)]
pub struct VaultConflict {
    pub base_slug: String,
    pub conflict_slug: String,
    pub detected_at: String,
}

/// List all pending conflicts, newest first.
pub fn list_vault_conflicts(conn: &Connection) -> Result<Vec<VaultConflict>> {
    let mut stmt = conn.prepare(
        "SELECT base_slug, conflict_slug, detected_at
         FROM vault_conflicts
         ORDER BY detected_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(VaultConflict {
            base_slug: row.get(0)?,
            conflict_slug: row.get(1)?,
            detected_at: row.get(2)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("failed to list vault conflicts")
}

/// Clear a single conflict entry after user resolution.
pub fn clear_vault_conflict(conn: &Connection, base_slug: &str, conflict_slug: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM vault_conflicts
         WHERE base_slug = ?1 AND conflict_slug = ?2",
        params![base_slug, conflict_slug],
    )
    .context("failed to clear vault conflict")?;
    Ok(())
}

/// List all blocks without description/source (lightweight for grid views).
/// Body is truncated to a short preview to reduce IPC payload for large vaults.
pub fn list_blocks_light(conn: &Connection) -> Result<Vec<LightBlock>> {
    let mut stmt = conn.prepare(
        "SELECT id, slug, block_type, title, url, media_file,
                thumbnail, saved_at, width, height, author,
                SUBSTR(body, 1, ?1), first_image, media_urls, media_dimensions, preview_manifest, feed_playback
         FROM blocks ORDER BY saved_at DESC",
    )?;

    let blocks: Vec<LightBlock> = stmt
        .query_map([LIGHT_BLOCK_BODY_PREVIEW_CHARS], |row| {
            Ok(LightBlock {
                id: row.get(0)?,
                slug: row.get(1)?,
                block_type: {
                    let raw: String = row.get(2)?;
                    BlockType::from_str(&raw).map_err(|_| {
                        rusqlite::Error::FromSqlConversionFailure(
                            2,
                            rusqlite::types::Type::Text,
                            format!("unknown block_type: {}", raw).into(),
                        )
                    })?
                },
                title: row.get(3)?,
                url: row.get(4)?,
                media_file: row.get(5)?,
                thumbnail: row.get(6)?,
                saved_at: row.get(7)?,
                width: row.get::<_, Option<i64>>(8)?.map(|v| v as u32),
                height: row.get::<_, Option<i64>>(9)?.map(|v| v as u32),
                author: row.get(10)?,
                body: row.get(11)?,
                first_image: row.get(12)?,
                media_urls: row.get(13)?,
                media_dimensions: row.get(14)?,
                preview_manifest: row.get(15)?,
                feed_playback: row.get(16)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(blocks)
}

/// List only the blocks needed by the visible grid, optionally filtered by tag.
/// Excludes channel documents and omits per-block tag arrays to keep the
/// startup/switch payload small; tag membership is fetched lazily for menus/detail.
pub fn list_grid_blocks(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<(Vec<LightBlock>, bool)> {
    let fetch_limit = limit.saturating_add(1);
    let sql = match tag {
        Some(_) => {
            "SELECT b.id, b.slug, b.block_type, b.title, b.url, b.media_file,
                    b.thumbnail, b.saved_at, b.width, b.height, b.author,
                    CASE WHEN b.block_type = 'article' THEN SUBSTR(b.body, 1, ?1) ELSE '' END,
                    b.first_image, b.media_urls, b.media_dimensions, b.preview_manifest, b.feed_playback
             FROM blocks b
             INNER JOIN block_tags bt ON bt.block_id = b.id
             WHERE b.block_type != 'channel' AND bt.tag = ?2
             ORDER BY b.saved_at DESC
             LIMIT ?3 OFFSET ?4"
        }
        None => {
            "SELECT id, slug, block_type, title, url, media_file,
                    thumbnail, saved_at, width, height, author,
                    CASE WHEN block_type = 'article' THEN SUBSTR(body, 1, ?1) ELSE '' END,
                    first_image, media_urls, media_dimensions, preview_manifest, feed_playback
             FROM blocks
             WHERE block_type != 'channel'
             ORDER BY saved_at DESC
             LIMIT ?2 OFFSET ?3"
        }
    };

    let mut stmt = conn.prepare(sql)?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(LightBlock {
            id: row.get(0)?,
            slug: row.get(1)?,
            block_type: {
                let raw: String = row.get(2)?;
                BlockType::from_str(&raw).map_err(|_| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        format!("unknown block_type: {}", raw).into(),
                    )
                })?
            },
            title: row.get(3)?,
            url: row.get(4)?,
            media_file: row.get(5)?,
            thumbnail: row.get(6)?,
            saved_at: row.get(7)?,
            width: row.get::<_, Option<i64>>(8)?.map(|v| v as u32),
            height: row.get::<_, Option<i64>>(9)?.map(|v| v as u32),
            author: row.get(10)?,
            body: row.get(11)?,
            first_image: row.get(12)?,
            media_urls: row.get(13)?,
            media_dimensions: row.get(14)?,
            preview_manifest: row.get(15)?,
            feed_playback: row.get(16)?,
        })
    };

    let mut blocks = match tag {
        Some(tag) => stmt
            .query_map(
                params![LIGHT_BLOCK_BODY_PREVIEW_CHARS, tag, fetch_limit, offset],
                map_row,
            )?
            .collect::<Result<Vec<_>, _>>()?,
        None => stmt
            .query_map(
                params![LIGHT_BLOCK_BODY_PREVIEW_CHARS, fetch_limit, offset],
                map_row,
            )?
            .collect::<Result<Vec<_>, _>>()?,
    };

    let has_more = blocks.len() > limit;
    if has_more {
        blocks.truncate(limit);
    }

    Ok((blocks, has_more))
}

/// Count non-channel blocks for the "Everything" sidebar row.
pub fn count_grid_blocks(conn: &Connection) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM blocks WHERE block_type != 'channel'",
        [],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

/// Return `slug -> indexed_at` (unix seconds) for non-channel blocks.
pub fn get_block_indexed_at_map(
    conn: &Connection,
) -> Result<std::collections::HashMap<String, u64>> {
    let mut stmt = conn.prepare(
        "SELECT slug, COALESCE(CAST(strftime('%s', indexed_at) AS INTEGER), 0)
         FROM blocks
         WHERE slug != '' AND block_type != 'channel'",
    )?;
    let rows = stmt.query_map([], |row| {
        let slug: String = row.get(0)?;
        let indexed_at: i64 = row.get(1)?;
        Ok((slug, indexed_at.max(0) as u64))
    })?;
    let entries = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(entries.into_iter().collect())
}

/// Return the newest previewable blocks across the whole vault.
pub fn list_preview_blocks(conn: &Connection, limit: usize) -> Result<Vec<PreviewBlock>> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let limit = i64::try_from(limit).context("preview limit does not fit i64")?;
    let mut stmt = conn.prepare(
        "SELECT slug, thumb_format, thumb_mtime
         FROM blocks
         WHERE slug != '' AND block_type != 'channel'
         ORDER BY saved_at DESC
         LIMIT ?1",
    )?;

    let rows = stmt.query_map([limit], |row| row_to_preview_block(row, 0))?;
    let previews = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(previews)
}

/// Return the newest previewable blocks per tag.
pub fn list_preview_blocks_by_tag(
    conn: &Connection,
    limit: usize,
) -> Result<std::collections::HashMap<String, Vec<PreviewBlock>>> {
    if limit == 0 {
        return Ok(std::collections::HashMap::new());
    }

    let limit = i64::try_from(limit).context("preview limit does not fit i64")?;
    let mut stmt = conn.prepare(
        "SELECT tag, slug, thumb_format, thumb_mtime
         FROM (
             SELECT bt.tag AS tag,
                    b.slug AS slug,
                    b.thumb_format AS thumb_format,
                    b.thumb_mtime AS thumb_mtime,
                    ROW_NUMBER() OVER (
                        PARTITION BY bt.tag
                        ORDER BY b.saved_at DESC
                    ) AS row_num
             FROM block_tags bt
             JOIN blocks b ON b.id = bt.block_id
             WHERE b.slug != '' AND b.block_type != 'channel'
         )
         WHERE row_num <= ?1
         ORDER BY tag, row_num",
    )?;

    let rows = stmt.query_map([limit], |row| {
        Ok((row.get::<_, String>(0)?, row_to_preview_block(row, 1)?))
    })?;

    let mut grouped = std::collections::HashMap::<String, Vec<PreviewBlock>>::new();
    for row in rows {
        let (tag, preview) = row?;
        grouped.entry(tag).or_default().push(preview);
    }

    Ok(grouped)
}

/// List only blocks whose thumbnail metadata says the on-disk thumb is still
/// a PNG text placeholder and may need a Phase 2 browser-decoded upgrade.
pub fn list_pending_thumb_upgrade_blocks(
    conn: &Connection,
) -> Result<Vec<PendingThumbUpgradeBlock>> {
    let mut stmt = conn.prepare(
        "SELECT slug, media_file, thumbnail, first_image, media_urls
         FROM blocks
         WHERE slug != ''
           AND block_type != 'channel'
         ORDER BY saved_at DESC",
    )?;

    let blocks = stmt
        .query_map([], |row| {
            Ok(PendingThumbUpgradeBlock {
                slug: row.get(0)?,
                media_file: row.get(1)?,
                thumbnail: row.get(2)?,
                first_image: row.get(3)?,
                media_urls: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(blocks)
}

/// Get a single block by slug. Returns None if not found.
pub fn get_block(conn: &Connection, slug: &str) -> Result<Option<IndexedBlock>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, slug, block_type, title, description, url, media_file,
                    thumbnail, saved_at, source, width, height, author, body, media_dimensions, preview_manifest, feed_playback, related_notes, origin, index_warning
             FROM blocks WHERE slug = ?1",
        )
        .context("failed to prepare get_block")?;

    match stmt.query_row([slug], row_to_block) {
        Ok(mut block) => {
            block.tags = get_tags_for_block(conn, block.id)?;
            Ok(Some(block))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// List all blocks, ordered by saved_at descending (newest first).
pub fn list_blocks(conn: &Connection) -> Result<Vec<IndexedBlock>> {
    let mut stmt = conn.prepare(
        "SELECT id, slug, block_type, title, description, url, media_file,
                thumbnail, saved_at, source, width, height, author, body, media_dimensions, preview_manifest, feed_playback, related_notes, origin, index_warning
         FROM blocks ORDER BY saved_at DESC",
    )?;
    collect_blocks(conn, &mut stmt, &[] as &[&dyn rusqlite::types::ToSql])
}

/// List blocks with a specific tag, ordered by saved_at descending.
pub fn list_blocks_by_tag(conn: &Connection, tag: &str) -> Result<Vec<IndexedBlock>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.slug, b.block_type, b.title, b.description, b.url,
                b.media_file, b.thumbnail, b.saved_at, b.source, b.width,
                b.height, b.author, b.body, b.media_dimensions, b.preview_manifest, b.feed_playback, b.related_notes, b.origin, b.index_warning
         FROM blocks b
         JOIN block_tags bt ON bt.block_id = b.id
         WHERE bt.tag = ?1
         ORDER BY b.saved_at DESC",
    )?;
    collect_blocks(conn, &mut stmt, &[&tag as &dyn rusqlite::types::ToSql])
}

/// Get all tags with their block counts, ordered by count descending.
pub fn get_all_tags(conn: &Connection) -> Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT tag, count(*) as cnt FROM block_tags
         GROUP BY tag ORDER BY cnt DESC, tag ASC",
    )?;
    let tags = stmt
        .query_map([], |row| {
            Ok(TagCount {
                tag: row.get(0)?,
                count: row.get::<_, i64>(1)? as usize,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(tags)
}

/// Search blocks using a structured query (free text + filters).
///
/// Builds SQL dynamically:
/// - Free text: JOIN blocks_fts WHERE MATCH ?
/// - Type filter: WHERE block_type = ?
/// - Tag filter: JOIN block_tags WHERE tag = ?
/// - Multiple filters: AND between all conditions
pub fn search_blocks(conn: &Connection, query: &SearchQuery) -> Result<Vec<IndexedBlock>> {
    if query.is_empty() {
        return list_blocks(conn);
    }

    let mut joins = Vec::new();
    let mut conditions = Vec::new();
    let mut param_values: Vec<String> = Vec::new();

    // FTS5 free-text search (escape special characters)
    if !query.text.is_empty() {
        joins.push("JOIN blocks_fts ON blocks_fts.rowid = b.id".to_string());
        conditions.push(format!("blocks_fts MATCH ?{}", param_values.len() + 1));
        param_values.push(escape_fts5(&query.text));
    }

    // Filters
    let mut tag_alias_idx = 0;
    for filter in &query.filters {
        match filter {
            SearchFilter::Tag(tag) => {
                let alias = format!("bt{}", tag_alias_idx);
                joins.push(format!(
                    "JOIN block_tags {a} ON {a}.block_id = b.id",
                    a = alias
                ));
                conditions.push(format!("{}.tag = ?{}", alias, param_values.len() + 1));
                param_values.push(tag.clone());
                tag_alias_idx += 1;
            }
            SearchFilter::Type(bt) => {
                conditions.push(format!("b.block_type = ?{}", param_values.len() + 1));
                param_values.push(bt.as_str().to_string());
            }
        }
    }

    let mut sql = String::from(
        "SELECT DISTINCT b.id, b.slug, b.block_type, b.title, b.description, b.url,
                b.media_file, b.thumbnail, b.saved_at, b.source, b.width,
                b.height, b.author, b.body, b.media_dimensions, b.preview_manifest, b.feed_playback, b.related_notes, b.origin, b.index_warning
         FROM blocks b",
    );

    for join in &joins {
        sql.push(' ');
        sql.push_str(join);
    }
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    sql.push_str(" ORDER BY b.saved_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = param_values
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();
    collect_blocks(conn, &mut stmt, &param_refs)
}

/// Insert or update a channel. Returns the channel's row id.
pub fn upsert_channel(conn: &Connection, channel: &Channel) -> Result<i64> {
    conn.execute(
        "INSERT INTO channels (tag, title, description, color, icon, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(tag) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            color = excluded.color,
            icon = excluded.icon,
            position = excluded.position",
        params![
            channel.tag,
            channel.title,
            channel.description,
            channel.color,
            channel.icon,
            channel.position as i64,
            channel.created_at.as_str(),
        ],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM channels WHERE tag = ?1",
        [&channel.tag],
        |row| row.get(0),
    )?;
    Ok(id)
}

/// Index a channel from a parsed Block with type: channel.
/// Maps frontmatter fields to Channel struct and upserts.
pub fn upsert_channel_from_block(conn: &Connection, block: &Block) -> Result<i64> {
    let raw_tag = block.slug.clone();
    let mut channel = Channel::new(
        &raw_tag,
        block.frontmatter.title.as_deref(),
        block.frontmatter.saved_at.clone(),
    )
    .map_err(|e| anyhow::anyhow!("invalid channel from block: {}", e))?;
    channel.description = block.frontmatter.description.clone();
    channel.color = block.frontmatter.color.clone();
    channel.icon = block.frontmatter.icon.clone();
    channel.position = block.frontmatter.position.unwrap_or(0);

    let id = upsert_channel(conn, &channel)?;
    if raw_tag != channel.tag {
        remove_channel(conn, &raw_tag)?;
    }
    Ok(id)
}

/// List all channels ordered by position, then title.
pub fn list_channels(conn: &Connection) -> Result<Vec<Channel>> {
    let mut stmt = conn.prepare(
        "SELECT tag, title, description, color, icon, position, created_at
         FROM channels ORDER BY position ASC, title ASC, tag ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut merged: Vec<(String, Channel)> = Vec::new();
    for (raw_tag, title, description, color, icon, position, created_at) in rows {
        let dt = DateTime::new(&created_at)
            .map_err(|e| anyhow::anyhow!("invalid datetime in channel: {}", e))?;
        let mut ch = Channel::new(&raw_tag, Some(&title), dt)
            .map_err(|e| anyhow::anyhow!("invalid channel from db: {}", e))?;
        ch.description = description;
        ch.color = color;
        ch.icon = icon;
        ch.position = position as u32;

        if let Some(idx) = merged
            .iter()
            .position(|(_, existing)| existing.tag == ch.tag)
        {
            let existing_is_canonical = merged[idx].0 == merged[idx].1.tag;
            let candidate_is_canonical = raw_tag == ch.tag;
            if candidate_is_canonical && !existing_is_canonical {
                merged[idx] = (raw_tag, ch);
            }
        } else {
            merged.push((raw_tag, ch));
        }
    }

    let mut channels: Vec<Channel> = merged.into_iter().map(|(_, channel)| channel).collect();
    channels.sort_by(|a, b| {
        a.position
            .cmp(&b.position)
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.tag.cmp(&b.tag))
    });
    Ok(channels)
}

/// Return the next append position for a newly-created channel.
pub fn next_channel_position(conn: &Connection) -> Result<u32> {
    let max_position: Option<i64> =
        conn.query_row("SELECT MAX(position) FROM channels", [], |row| row.get(0))?;
    Ok(max_position
        .and_then(|value| u32::try_from(value).ok())
        .map_or(0, |value| value.saturating_add(1)))
}

/// Batch-update channel positions. Each pair is (tag, new_position).
///
/// Uses a single transaction for atomicity. Tags that don't exist are skipped.
pub fn update_channel_positions(conn: &Connection, positions: &[(String, u32)]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE channels SET position = ?1 WHERE tag = ?2")?;
        for (tag, pos) in positions {
            stmt.execute(params![*pos as i64, tag])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Remove a channel by tag. Returns true if removed.
pub fn remove_channel(conn: &Connection, tag: &str) -> Result<bool> {
    let count = conn.execute("DELETE FROM channels WHERE tag = ?1", [tag])?;
    Ok(count > 0)
}

// ─── Private helpers ────────────────────────────────────────────────────────

/// Escape FTS5 special characters in user input.
/// Wraps each word in double quotes to treat them as literal tokens.
fn escape_fts5(input: &str) -> String {
    input
        .split_whitespace()
        .map(|word| {
            // Escape internal double quotes by doubling them
            let escaped = word.replace('"', "\"\"");
            format!("\"{}\"", escaped)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn row_to_block(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedBlock> {
    Ok(IndexedBlock {
        id: row.get(0)?,
        slug: row.get(1)?,
        block_type: {
            let raw: String = row.get(2)?;
            BlockType::from_str(&raw).map_err(|_| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    format!("unknown block_type: {}", raw).into(),
                )
            })?
        },
        title: row.get(3)?,
        description: row.get(4)?,
        url: row.get(5)?,
        media_file: row.get(6)?,
        thumbnail: row.get(7)?,
        saved_at: row.get(8)?,
        source: row.get(9)?,
        width: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
        height: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
        author: row.get(12)?,
        body: row.get(13)?,
        media_dimensions: row.get(14)?,
        preview_manifest: row.get(15)?,
        feed_playback: row.get(16)?,
        related_notes: parse_related_notes_json(row.get(17)?),
        origin: row.get(18)?,
        index_warning: row.get(19)?,
        tags: Vec::new(), // filled by caller
    })
}

fn get_tags_for_block(conn: &Connection, block_id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM block_tags WHERE block_id = ?1 ORDER BY tag")?;
    let tags = stmt
        .query_map([block_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(tags)
}

fn collect_blocks(
    conn: &Connection,
    stmt: &mut rusqlite::Statement<'_>,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<IndexedBlock>> {
    let mut blocks: Vec<IndexedBlock> = stmt
        .query_map(params, row_to_block)?
        .collect::<Result<Vec<_>, _>>()?;

    if blocks.is_empty() {
        return Ok(blocks);
    }

    // Batch: fetch all tags in one query instead of N+1
    let ids: Vec<i64> = blocks.iter().map(|b| b.id).collect();
    let placeholders: String = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT block_id, tag FROM block_tags WHERE block_id IN ({}) ORDER BY tag",
        placeholders
    );
    let mut tag_stmt = conn.prepare(&sql)?;
    let id_params: Vec<&dyn rusqlite::types::ToSql> = ids
        .iter()
        .map(|id| id as &dyn rusqlite::types::ToSql)
        .collect();
    let rows = tag_stmt.query_map(&*id_params, |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut tag_map: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
    for row in rows {
        let (block_id, tag) = row?;
        tag_map.entry(block_id).or_default().push(tag);
    }

    for block in &mut blocks {
        block.tags = tag_map.remove(&block.id).unwrap_or_default();
    }

    Ok(blocks)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::Frontmatter;
    use crate::storage::db;

    fn test_conn() -> Connection {
        db::open_memory().unwrap()
    }

    fn make_block(slug: &str, tags: &[&str]) -> Block {
        make_block_full(slug, "image", None, "2026-01-15T12:00:00Z", tags, "")
    }

    fn make_block_full(
        slug: &str,
        block_type: &str,
        title: Option<&str>,
        saved_at: &str,
        tags: &[&str],
        body: &str,
    ) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::from_str(block_type).unwrap(),
                title: title.map(|t| t.to_string()),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: tags.iter().map(|t| t.to_string()).collect(),
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new(saved_at).unwrap(),
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

    fn sync_test_jpeg_thumb(conn: &Connection, slug: &str) {
        let dir = tempfile::tempdir().unwrap();
        let thumb_path = dir.path().join(format!("{slug}.jpg"));
        std::fs::write(&thumb_path, [0xFF, 0xD8, 0xFF, 0x00]).unwrap();
        assert!(sync_thumb_metadata(conn, slug, &thumb_path, None).unwrap());
    }

    fn write_test_media(vault: &VaultLayout, name: &str, size_bytes: usize) {
        std::fs::write(vault.root().join(name), vec![0u8; size_bytes]).unwrap();
    }

    fn write_test_image(vault: &VaultLayout, name: &str, width: u32, height: u32) {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb([120, 180, 200]));
        img.save(vault.root().join(name)).unwrap();
    }

    // ── upsert_block ─────────────────────────────────────────────────────

    #[test]
    fn upsert_insert_new_block() {
        let conn = test_conn();
        let block = make_block("sunset", &["photography"]);
        let id = upsert_block(&conn, &block, None).unwrap();
        assert!(id > 0);

        let got = get_block(&conn, "sunset").unwrap().unwrap();
        assert_eq!(got.slug, "sunset");
        assert_eq!(got.block_type, BlockType::Image);
        assert_eq!(got.tags, vec!["photography"]);
    }

    #[test]
    fn upsert_update_existing_block() {
        let conn = test_conn();
        let block1 = make_block_full(
            "sunset",
            "image",
            Some("Old"),
            "2026-01-01T00:00:00Z",
            &["old-tag"],
            "",
        );
        upsert_block(&conn, &block1, None).unwrap();

        let block2 = make_block_full(
            "sunset",
            "link",
            Some("New"),
            "2026-02-01T00:00:00Z",
            &["new-tag"],
            "body",
        );
        upsert_block(&conn, &block2, None).unwrap();

        let got = get_block(&conn, "sunset").unwrap().unwrap();
        assert_eq!(got.block_type, BlockType::Link);
        assert_eq!(got.title.as_deref(), Some("New"));
        assert_eq!(got.tags, vec!["new-tag"]);
        assert_eq!(got.body, "body");
    }

    #[test]
    fn upsert_replaces_tags() {
        let conn = test_conn();
        let block = make_block("test", &["a", "b", "c"]);
        upsert_block(&conn, &block, None).unwrap();

        let block2 = make_block("test", &["x", "y"]);
        upsert_block(&conn, &block2, None).unwrap();

        let got = get_block(&conn, "test").unwrap().unwrap();
        assert_eq!(got.tags, vec!["x", "y"]);
    }

    #[test]
    fn upsert_replaces_wikilinks() {
        let conn = test_conn();
        let block = make_block_full(
            "src",
            "article",
            None,
            "2026-01-01T00:00:00Z",
            &[],
            "See [[target-a]]",
        );
        upsert_block(&conn, &block, None).unwrap();

        let count1: i64 = conn
            .query_row("SELECT count(*) FROM wikilinks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count1, 1);

        let block2 = make_block_full(
            "src",
            "article",
            None,
            "2026-01-01T00:00:00Z",
            &[],
            "See [[target-b]] and [[target-c]]",
        );
        upsert_block(&conn, &block2, None).unwrap();

        let count2: i64 = conn
            .query_row("SELECT count(*) FROM wikilinks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count2, 2);
    }

    #[test]
    fn upsert_indexes_related_notes_as_wikilinks() {
        let conn = test_conn();
        let mut block = make_block_full(
            "extracted",
            "image",
            Some("Extracted"),
            "2026-01-01T00:00:00Z",
            &["inspiration"],
            "![[extracted.jpg]]",
        );
        block.frontmatter.related_notes = vec!["Source Article".to_string()];
        upsert_block(&conn, &block, None).unwrap();

        let got = get_block(&conn, "extracted").unwrap().unwrap();
        assert_eq!(got.related_notes, vec!["Source Article"]);

        let targets = conn
            .prepare(
                "SELECT target_slug FROM wikilinks
                 JOIN blocks ON blocks.id = wikilinks.source_id
                 WHERE blocks.slug = ?1
                 ORDER BY target_slug",
            )
            .unwrap()
            .query_map(["extracted"], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(targets, vec!["Source Article", "extracted.jpg"]);
    }

    // ── remove_block ─────────────────────────────────────────────────────

    #[test]
    fn remove_existing_block() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("test", &["tag"]), None).unwrap();
        assert!(remove_block(&conn, "test").unwrap());
        assert!(get_block(&conn, "test").unwrap().is_none());
    }

    #[test]
    fn remove_nonexistent_block() {
        let conn = test_conn();
        assert!(!remove_block(&conn, "nope").unwrap());
    }

    // ── get_block ────────────────────────────────────────────────────────

    #[test]
    fn get_block_not_found() {
        let conn = test_conn();
        assert!(get_block(&conn, "nope").unwrap().is_none());
    }

    #[test]
    fn get_block_with_all_fields() {
        let conn = test_conn();
        let mut block = make_block_full(
            "full",
            "article",
            Some("Title"),
            "2026-03-15T10:00:00Z",
            &["design", "web"],
            "Body text",
        );
        block.frontmatter.description = Some("Desc".to_string());
        block.frontmatter.url = Some("https://example.com".to_string());
        block.frontmatter.file = Some("full.png".to_string());
        block.frontmatter.thumbnail = Some("thumb.jpg".to_string());
        block.frontmatter.source = Some("browser-extension".to_string());
        block.frontmatter.width = Some(1920);
        block.frontmatter.height = Some(1080);
        block.frontmatter.author = Some("Author".to_string());
        upsert_block(&conn, &block, None).unwrap();

        let got = get_block(&conn, "full").unwrap().unwrap();
        assert_eq!(got.title.as_deref(), Some("Title"));
        assert_eq!(got.description.as_deref(), Some("Desc"));
        assert_eq!(got.url.as_deref(), Some("https://example.com"));
        assert_eq!(got.media_file.as_deref(), Some("full.png"));
        assert_eq!(got.thumbnail.as_deref(), Some("thumb.jpg"));
        assert_eq!(got.source.as_deref(), Some("browser-extension"));
        assert_eq!(got.width, Some(1920));
        assert_eq!(got.height, Some(1080));
        assert_eq!(got.author.as_deref(), Some("Author"));
        assert_eq!(got.body, "Body text");
        assert_eq!(got.tags, vec!["design", "web"]);
    }

    // ── list_blocks ──────────────────────────────────────────────────────

    #[test]
    fn list_blocks_empty() {
        let conn = test_conn();
        let blocks = list_blocks(&conn).unwrap();
        assert!(blocks.is_empty());
    }

    #[test]
    fn list_blocks_ordered_by_saved_at() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full("old", "image", None, "2026-01-01T00:00:00Z", &[], ""),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full("new", "image", None, "2026-03-01T00:00:00Z", &[], ""),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full("mid", "image", None, "2026-02-01T00:00:00Z", &[], ""),
            None,
        )
        .unwrap();

        let blocks = list_blocks(&conn).unwrap();
        let slugs: Vec<&str> = blocks.iter().map(|b| b.slug.as_str()).collect();
        assert_eq!(slugs, vec!["new", "mid", "old"]);
    }

    // ── list_blocks_by_tag ───────────────────────────────────────────────

    #[test]
    fn list_by_tag_filters_correctly() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("a", &["design"]), None).unwrap();
        upsert_block(&conn, &make_block("b", &["design", "web"]), None).unwrap();
        upsert_block(&conn, &make_block("c", &["web"]), None).unwrap();

        let design = list_blocks_by_tag(&conn, "design").unwrap();
        let slugs: Vec<&str> = design.iter().map(|b| b.slug.as_str()).collect();
        assert_eq!(slugs.len(), 2);
        assert!(slugs.contains(&"a"));
        assert!(slugs.contains(&"b"));
    }

    #[test]
    fn list_by_tag_empty_result() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("a", &["design"]), None).unwrap();
        let result = list_blocks_by_tag(&conn, "nonexistent").unwrap();
        assert!(result.is_empty());
    }

    // ── get_all_tags ─────────────────────────────────────────────────────

    #[test]
    fn get_all_tags_with_counts() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("a", &["design", "web"]), None).unwrap();
        upsert_block(&conn, &make_block("b", &["design"]), None).unwrap();
        upsert_block(&conn, &make_block("c", &["photo"]), None).unwrap();

        let tags = get_all_tags(&conn).unwrap();
        assert_eq!(
            tags[0],
            TagCount {
                tag: "design".to_string(),
                count: 2
            }
        );
        assert_eq!(tags.len(), 3);
    }

    #[test]
    fn get_all_tags_empty() {
        let conn = test_conn();
        let tags = get_all_tags(&conn).unwrap();
        assert!(tags.is_empty());
    }

    // ── search_blocks ────────────────────────────────────────────────────

    #[test]
    fn search_empty_returns_all() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("a", &[]), None).unwrap();
        upsert_block(&conn, &make_block("b", &[]), None).unwrap();

        let query = SearchQuery {
            text: String::new(),
            filters: vec![],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn search_by_text() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "sunset",
                "image",
                Some("Sunset in Tokyo"),
                "2026-01-01T00:00:00Z",
                &[],
                "",
            ),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "coffee",
                "image",
                Some("Morning Coffee"),
                "2026-01-02T00:00:00Z",
                &[],
                "",
            ),
            None,
        )
        .unwrap();

        let query = SearchQuery {
            text: "sunset".to_string(),
            filters: vec![],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "sunset");
    }

    #[test]
    fn search_by_type_filter() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full("img", "image", None, "2026-01-01T00:00:00Z", &[], ""),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full("art", "article", None, "2026-01-01T00:00:00Z", &[], ""),
            None,
        )
        .unwrap();

        let query = SearchQuery {
            text: String::new(),
            filters: vec![SearchFilter::Type(BlockType::Image)],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "img");
    }

    #[test]
    fn search_by_tag_filter() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("a", &["design"]), None).unwrap();
        upsert_block(&conn, &make_block("b", &["web"]), None).unwrap();

        let query = SearchQuery {
            text: String::new(),
            filters: vec![SearchFilter::Tag("design".to_string())],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "a");
    }

    #[test]
    fn search_combined_text_and_filters() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "match",
                "image",
                Some("Beautiful sunset"),
                "2026-01-01T00:00:00Z",
                &["photo"],
                "",
            ),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "no-tag",
                "image",
                Some("Another sunset"),
                "2026-01-01T00:00:00Z",
                &[],
                "",
            ),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "no-text",
                "image",
                Some("Morning coffee"),
                "2026-01-01T00:00:00Z",
                &["photo"],
                "",
            ),
            None,
        )
        .unwrap();

        let query = SearchQuery {
            text: "sunset".to_string(),
            filters: vec![SearchFilter::Tag("photo".to_string())],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "match");
    }

    #[test]
    fn search_multiple_tag_filters_is_and() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("both", &["design", "web"]), None).unwrap();
        upsert_block(&conn, &make_block("one", &["design"]), None).unwrap();

        let query = SearchQuery {
            text: String::new(),
            filters: vec![
                SearchFilter::Tag("design".to_string()),
                SearchFilter::Tag("web".to_string()),
            ],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "both");
    }

    // ── list_blocks_light ─────────────────────────────────────────────────

    #[test]
    fn list_blocks_light_truncates_body() {
        let conn = test_conn();
        let long_body = "x".repeat(1000);
        upsert_block(
            &conn,
            &make_block_full(
                "article",
                "article",
                Some("Test"),
                "2026-01-01T00:00:00Z",
                &[],
                &long_body,
            ),
            None,
        )
        .unwrap();

        let light = list_blocks_light(&conn).unwrap();
        assert_eq!(light.len(), 1);
        assert!(light[0].body.len() <= LIGHT_BLOCK_BODY_PREVIEW_CHARS as usize);
    }

    #[test]
    fn image_preview_manifest_prefers_media_dimensions_over_stale_frontmatter_size() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        write_test_image(&vault, "wide-screenshot.jpg", 2880, 980);

        let mut block = make_block_full(
            "wide-screenshot",
            "image",
            Some("Wide Screenshot"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("wide-screenshot.jpg".to_string());
        block.frontmatter.width = Some(4036);
        block.frontmatter.height = Some(2578);
        upsert_block(&conn, &block, Some(vault.root())).unwrap();

        let light = list_blocks_light(&conn).unwrap();
        let manifest: FeedPreviewManifest =
            serde_json::from_str(light[0].preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.width, Some(2880));
        assert_eq!(manifest.height, Some(980));
    }

    #[test]
    fn list_blocks_light_persists_article_preview_manifest() {
        let conn = test_conn();
        let block = make_block_full(
            "gallery-article",
            "article",
            Some("Gallery"),
            "2026-01-01T00:00:00Z",
            &[],
            "hello\n![](a.jpg)\n![](b.jpg)\n![](c.jpg)",
        );
        upsert_block(&conn, &block, None).unwrap();

        let light = list_blocks_light(&conn).unwrap();
        let manifest: FeedPreviewManifest =
            serde_json::from_str(light[0].preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.kind, FeedPreviewKind::Composite);
        assert_eq!(
            manifest.primary_preview_path.as_deref(),
            Some("gallery-article.jpg")
        );
        assert_eq!(manifest.tiles.len(), 3);
        assert_eq!(manifest.overflow_count, 0);
    }

    #[test]
    fn list_blocks_light_persists_social_video_preview_manifest() {
        let conn = test_conn();
        let mut block = make_block_full(
            "tweet-video",
            "article",
            Some("Tweet"),
            "2026-01-01T00:00:00Z",
            &[],
            "hello\n<!-- tweet-video -->\n![](clip.mp4)",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());
        upsert_block(&conn, &block, None).unwrap();

        let light = list_blocks_light(&conn).unwrap();
        let manifest: FeedPreviewManifest =
            serde_json::from_str(light[0].preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.kind, FeedPreviewKind::VideoPoster);
        assert_eq!(manifest.tiles.len(), 1);
        assert!(manifest.tiles[0].is_video);
        assert!(manifest.tiles[0].is_video_poster);
        assert_eq!(manifest.tiles[0].preview_path, None);
    }

    #[test]
    fn list_blocks_light_serializes_feed_playback_for_dedicated_mp4_video() {
        let conn = test_conn();
        let mut block = make_block_full(
            "feed-video",
            "video",
            Some("Demo"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("demo.mp4".to_string());
        block.frontmatter.width = Some(1280);
        block.frontmatter.height = Some(720);
        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "feed-video");

        let light = list_blocks_light(&conn).unwrap();
        let playback: FeedPlaybackDescriptor =
            serde_json::from_str(light[0].feed_playback.as_deref().unwrap()).unwrap();
        assert_eq!(playback.kind, FeedPlaybackKind::SingleVideo);
        assert_eq!(playback.source_path, "demo.mp4");
        assert_eq!(playback.poster_preview_path, "feed-video.jpg");
        assert_eq!(playback.width, Some(1280));
        assert_eq!(playback.height, Some(720));
        assert_eq!(playback.container, FeedPlaybackContainer::Mp4);
        assert_eq!(playback.profile, FeedPlaybackProfile::Standard);
    }

    #[test]
    fn list_blocks_light_serializes_feed_playback_for_dedicated_webm_video() {
        let conn = test_conn();
        let mut block = make_block_full(
            "feed-video-webm",
            "video",
            Some("Demo"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("demo.webm".to_string());
        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "feed-video-webm");

        let light = list_blocks_light(&conn).unwrap();
        let playback: FeedPlaybackDescriptor =
            serde_json::from_str(light[0].feed_playback.as_deref().unwrap()).unwrap();
        assert_eq!(playback.source_path, "demo.webm");
        assert_eq!(playback.container, FeedPlaybackContainer::Webm);
        assert_eq!(playback.profile, FeedPlaybackProfile::Standard);
    }

    #[test]
    fn list_blocks_light_keeps_feed_playback_null_for_dedicated_mov_video() {
        let conn = test_conn();
        let mut block = make_block_full(
            "feed-video-mov",
            "video",
            Some("Demo"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("demo.mov".to_string());
        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "feed-video-mov");

        let light = list_blocks_light(&conn).unwrap();
        assert_eq!(light[0].feed_playback, None);
    }

    #[test]
    fn list_blocks_light_serializes_feed_playback_for_single_video_social_preview() {
        let conn = test_conn();
        let mut block = make_block_full(
            "tweet-video-playback",
            "article",
            Some("Tweet"),
            "2026-01-01T00:00:00Z",
            &[],
            "hello\n<!-- tweet-video -->\n![](clip.mp4)",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());
        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "tweet-video-playback");

        let light = list_blocks_light(&conn).unwrap();
        let playback: FeedPlaybackDescriptor =
            serde_json::from_str(light[0].feed_playback.as_deref().unwrap()).unwrap();
        assert_eq!(playback.source_path, "clip.mp4");
        assert_eq!(playback.poster_preview_path, "tweet-video-playback.jpg");
        assert_eq!(playback.container, FeedPlaybackContainer::Mp4);
        assert_eq!(playback.profile, FeedPlaybackProfile::Standard);
    }

    #[test]
    fn list_blocks_light_keeps_feed_playback_null_for_multi_media_social_preview() {
        let conn = test_conn();
        let mut block = make_block_full(
            "tweet-gallery",
            "article",
            Some("Tweet"),
            "2026-01-01T00:00:00Z",
            &[],
            "hello\n<!-- tweet-video -->\n![](clip.mp4)\n![](still.jpg)",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());
        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "tweet-gallery");

        let light = list_blocks_light(&conn).unwrap();
        let manifest: FeedPreviewManifest =
            serde_json::from_str(light[0].preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.tiles.len(), 2);
        assert!(manifest.tiles[0].is_video);
        assert_eq!(manifest.tiles[0].preview_path, None);
        assert_eq!(light[0].feed_playback, None);
    }

    #[test]
    fn list_blocks_light_keeps_feed_playback_null_for_remote_video_sources() {
        let conn = test_conn();
        let mut block = make_block_full(
            "tweet-remote-video",
            "article",
            Some("Tweet"),
            "2026-01-01T00:00:00Z",
            &[],
            "hello\n<!-- tweet-video -->\n![](https://cdn.example.com/clip.mp4)",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());
        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "tweet-remote-video");

        let light = list_blocks_light(&conn).unwrap();
        assert_eq!(light[0].feed_playback, None);
    }

    #[test]
    fn clear_thumb_metadata_clears_feed_playback() {
        let conn = test_conn();
        let mut block = make_block_full(
            "feed-video-clear",
            "video",
            Some("Demo"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("demo.mp4".to_string());
        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "feed-video-clear");

        let before = list_blocks_light(&conn).unwrap();
        assert!(before[0].feed_playback.is_some());

        assert!(clear_thumb_metadata(&conn, "feed-video-clear").unwrap());

        let after = list_blocks_light(&conn).unwrap();
        assert_eq!(after[0].feed_playback, None);
    }

    #[test]
    fn list_grid_blocks_filters_channels_and_tag() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("design-a", &["design"]), None).unwrap();
        upsert_block(&conn, &make_block("design-b", &["design", "web"]), None).unwrap();
        upsert_block(&conn, &make_block("web-only", &["web"]), None).unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "channel",
                "channel",
                Some("Design"),
                "2026-01-01T00:00:00Z",
                &[],
                "",
            ),
            None,
        )
        .unwrap();

        let (all, has_more_all) = list_grid_blocks(&conn, None, 0, 50).unwrap();
        assert_eq!(all.len(), 3);
        assert!(!has_more_all);
        assert!(all
            .iter()
            .all(|block| block.block_type != BlockType::Channel));

        let (design, has_more_design) = list_grid_blocks(&conn, Some("design"), 0, 50).unwrap();
        assert_eq!(design.len(), 2);
        assert!(!has_more_design);
        assert!(design.iter().all(|block| block.slug.starts_with("design")));
    }

    #[test]
    fn list_grid_blocks_paginates() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("one", &[]), None).unwrap();
        upsert_block(&conn, &make_block("two", &[]), None).unwrap();
        upsert_block(&conn, &make_block("three", &[]), None).unwrap();

        let (page1, has_more1) = list_grid_blocks(&conn, None, 0, 2).unwrap();
        let (page2, has_more2) = list_grid_blocks(&conn, None, 2, 2).unwrap();

        assert_eq!(page1.len(), 2);
        assert!(has_more1);
        assert_eq!(page2.len(), 1);
        assert!(!has_more2);
    }

    #[test]
    fn sync_thumb_metadata_and_preview_queries_use_db_columns() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("design-a", &["design"]), None).unwrap();
        upsert_block(&conn, &make_block("design-b", &["design"]), None).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let png_thumb = dir.path().join("design-a.jpg");
        std::fs::write(&png_thumb, [0x89, 0x50, 0x4E, 0x47]).unwrap();
        let jpeg_thumb = dir.path().join("design-b.jpg");
        std::fs::write(&jpeg_thumb, [0xFF, 0xD8, 0xFF, 0x00]).unwrap();

        assert!(sync_thumb_metadata(&conn, "design-a", &png_thumb, None).unwrap());
        assert!(sync_thumb_metadata(&conn, "design-b", &jpeg_thumb, None).unwrap());

        let all = list_preview_blocks(&conn, 10).unwrap();
        assert_eq!(all.len(), 2);
        let all_by_slug = all
            .iter()
            .map(|item| (item.slug.clone(), item.thumb_format))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(all_by_slug["design-a"], Some(ThumbFormat::Png));
        assert_eq!(all_by_slug["design-b"], Some(ThumbFormat::Jpeg));
        assert!(all.iter().all(|item| item.thumb_mtime > 0));

        let by_tag = list_preview_blocks_by_tag(&conn, 10).unwrap();
        let design = by_tag.get("design").unwrap();
        assert_eq!(design.len(), 2);
        let design_by_slug = design
            .iter()
            .map(|item| (item.slug.clone(), item.thumb_format))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(design_by_slug["design-a"], Some(ThumbFormat::Png));
        assert_eq!(design_by_slug["design-b"], Some(ThumbFormat::Jpeg));

        assert!(clear_thumb_metadata(&conn, "design-a").unwrap());
        let cleared = list_preview_blocks(&conn, 10).unwrap();
        let cleared_a = cleared.iter().find(|item| item.slug == "design-a").unwrap();
        assert_eq!(cleared_a.thumb_format, None);
        assert_eq!(cleared_a.thumb_mtime, 0);
    }

    #[test]
    fn backfill_missing_thumb_metadata_restores_legacy_preview_rows() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();

        let conn = test_conn();
        upsert_block(&conn, &make_block("legacy-thumb", &["design"]), None).unwrap();

        let before = list_preview_blocks(&conn, 10).unwrap();
        let legacy_before = before
            .iter()
            .find(|item| item.slug == "legacy-thumb")
            .unwrap();
        assert_eq!(legacy_before.thumb_format, None);
        assert_eq!(legacy_before.thumb_mtime, 0);

        std::fs::write(vault.thumb_path("legacy-thumb"), [0xFF, 0xD8, 0xFF, 0x00]).unwrap();

        let updated = backfill_missing_thumb_metadata(&conn, &vault).unwrap();
        assert_eq!(updated, 1);

        let after = list_preview_blocks(&conn, 10).unwrap();
        let legacy_after = after
            .iter()
            .find(|item| item.slug == "legacy-thumb")
            .unwrap();
        assert_eq!(legacy_after.thumb_format, Some(ThumbFormat::Jpeg));
        assert!(legacy_after.thumb_mtime > 0);
    }

    #[test]
    fn backfill_missing_preview_manifest_restores_legacy_social_video_rows() {
        let conn = test_conn();
        let mut block = make_block_full(
            "legacy-social-video",
            "article",
            Some("Tweet"),
            "2026-01-01T00:00:00Z",
            &[],
            "hello\n<!-- tweet-video -->\n![](clip.mp4)",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());
        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "legacy-social-video");

        conn.execute(
            "UPDATE blocks SET preview_manifest = NULL, feed_playback = NULL WHERE slug = ?1",
            ["legacy-social-video"],
        )
        .unwrap();

        let updated = backfill_missing_preview_manifest(&conn).unwrap();
        assert_eq!(updated, 1);

        let light = list_blocks_light(&conn).unwrap();
        let manifest: FeedPreviewManifest =
            serde_json::from_str(light[0].preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.kind, FeedPreviewKind::VideoPoster);
        assert_eq!(manifest.tiles.len(), 1);
        assert!(manifest.tiles[0].is_video);
    }

    #[test]
    fn backfill_missing_feed_playback_restores_legacy_rows_with_existing_thumb_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        let mut block = make_block_full(
            "legacy-feed-video",
            "video",
            Some("Demo"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("demo.mp4".to_string());
        block.frontmatter.width = Some(1280);
        block.frontmatter.height = Some(720);
        write_test_media(&vault, "demo.mp4", 256 * 1024);
        upsert_block(&conn, &block, Some(vault.root())).unwrap();
        sync_test_jpeg_thumb(&conn, "legacy-feed-video");

        conn.execute(
            "UPDATE blocks SET feed_playback = NULL WHERE slug = ?1",
            ["legacy-feed-video"],
        )
        .unwrap();

        let updated = backfill_missing_feed_playback(&conn, &vault).unwrap();
        assert_eq!(updated, 1);

        let light = list_blocks_light(&conn).unwrap();
        let playback: FeedPlaybackDescriptor =
            serde_json::from_str(light[0].feed_playback.as_deref().unwrap()).unwrap();
        assert_eq!(playback.source_path, "demo.mp4");
        assert_eq!(playback.container, FeedPlaybackContainer::Mp4);
        assert_eq!(playback.profile, FeedPlaybackProfile::Standard);
    }

    #[test]
    fn combined_metadata_backfills_restore_feed_video_contract_for_legacy_rows() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        let mut block = make_block_full(
            "legacy-contract-video",
            "article",
            Some("Tweet"),
            "2026-01-01T00:00:00Z",
            &[],
            "hello\n<!-- tweet-video -->\n![](clip.mp4)",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());
        write_test_media(&vault, "clip.mp4", 256 * 1024);
        upsert_block(&conn, &block, Some(vault.root())).unwrap();
        sync_test_jpeg_thumb(&conn, "legacy-contract-video");

        conn.execute(
            "UPDATE blocks
             SET preview_manifest = NULL, feed_playback = NULL
             WHERE slug = ?1",
            ["legacy-contract-video"],
        )
        .unwrap();

        assert_eq!(backfill_missing_preview_manifest(&conn).unwrap(), 1);
        assert_eq!(backfill_missing_feed_playback(&conn, &vault).unwrap(), 1);

        let light = list_blocks_light(&conn).unwrap();
        let manifest: FeedPreviewManifest =
            serde_json::from_str(light[0].preview_manifest.as_deref().unwrap()).unwrap();
        let playback: FeedPlaybackDescriptor =
            serde_json::from_str(light[0].feed_playback.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.kind, FeedPreviewKind::VideoPoster);
        assert_eq!(playback.source_path, "clip.mp4");
        assert_eq!(playback.poster_preview_path, "legacy-contract-video.jpg");
        assert_eq!(playback.profile, FeedPlaybackProfile::Standard);
    }

    #[test]
    fn backfill_missing_feed_playback_skips_multi_media_social_rows() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        let mut block = make_block_full(
            "legacy-multi-social",
            "article",
            Some("Tweet"),
            "2026-01-01T00:00:00Z",
            &[],
            "hello\n<!-- tweet-video -->\n![](clip.mp4)\n![](still.jpg)",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());
        write_test_media(&vault, "clip.mp4", 256 * 1024);
        write_test_media(&vault, "still.jpg", 64 * 1024);
        upsert_block(&conn, &block, Some(vault.root())).unwrap();
        sync_test_jpeg_thumb(&conn, "legacy-multi-social");

        conn.execute(
            "UPDATE blocks SET feed_playback = NULL WHERE slug = ?1",
            ["legacy-multi-social"],
        )
        .unwrap();

        assert_eq!(backfill_missing_feed_playback(&conn, &vault).unwrap(), 0);

        let light = list_blocks_light(&conn).unwrap();
        assert_eq!(light[0].feed_playback, None);
    }

    #[test]
    fn upsert_block_with_vault_root_marks_large_but_valid_videos_as_heavy_profile() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        let mut block = make_block_full(
            "heavy-feed-video",
            "video",
            Some("Heavy clip"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("heavy.mp4".to_string());
        block.frontmatter.width = Some(4096);
        block.frontmatter.height = Some(1956);
        write_test_media(&vault, "heavy.mp4", 24 * 1024 * 1024);

        upsert_block(&conn, &block, Some(vault.root())).unwrap();
        sync_test_jpeg_thumb(&conn, "heavy-feed-video");

        let light = list_blocks_light(&conn).unwrap();
        let playback: FeedPlaybackDescriptor =
            serde_json::from_str(light[0].feed_playback.as_deref().unwrap()).unwrap();
        assert_eq!(playback.profile, FeedPlaybackProfile::Heavy);
    }

    #[test]
    fn backfill_missing_feed_playback_clears_stale_truly_excessive_video_descriptors() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        let mut block = make_block_full(
            "stale-heavy-video",
            "video",
            Some("Heavy clip"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("heavy.mp4".to_string());
        block.frontmatter.width = Some(4096);
        block.frontmatter.height = Some(1956);
        write_test_media(
            &vault,
            "heavy.mp4",
            (FEED_AUTOPLAY_HARD_MAX_SOURCE_BYTES + 1) as usize,
        );

        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "stale-heavy-video");

        let before = list_blocks_light(&conn).unwrap();
        assert!(before[0].feed_playback.is_some());

        assert_eq!(backfill_missing_feed_playback(&conn, &vault).unwrap(), 1);

        let after = list_blocks_light(&conn).unwrap();
        assert_eq!(after[0].feed_playback, None);
    }

    // ── resolve_unique_slug ─────────────────────────────────────────────

    #[test]
    fn resolve_unique_slug_no_conflict() {
        let conn = test_conn();
        let slug = resolve_unique_slug(&conn, "fresh").unwrap();
        assert_eq!(slug, "fresh");
    }

    #[test]
    fn resolve_unique_slug_with_conflict() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("taken", &[]), None).unwrap();
        let slug = resolve_unique_slug(&conn, "taken").unwrap();
        assert_eq!(slug, "taken (2)");
    }

    #[test]
    fn resolve_unique_slug_multiple_conflicts() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("doc", &[]), None).unwrap();
        upsert_block(&conn, &make_block("doc (2)", &[]), None).unwrap();
        upsert_block(&conn, &make_block("doc (3)", &[]), None).unwrap();
        let slug = resolve_unique_slug(&conn, "doc").unwrap();
        assert_eq!(slug, "doc (4)");
    }

    #[test]
    fn resolve_unique_slug_fills_first_gap() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("note", &[]), None).unwrap();
        upsert_block(&conn, &make_block("note (2)", &[]), None).unwrap();
        upsert_block(&conn, &make_block("note (4)", &[]), None).unwrap();
        upsert_block(&conn, &make_block("note-archive", &[]), None).unwrap();

        let slug = resolve_unique_slug(&conn, "note").unwrap();
        assert_eq!(slug, "note (3)");
    }

    #[test]
    fn resolve_unique_slug_ignores_legacy_kebab_suffix() {
        // Pre-Phase-18.D files with `-N` kebab suffix must not be counted
        // as parenthetical suffix owners, so the new sequence starts at (2).
        let conn = test_conn();
        upsert_block(&conn, &make_block("clip", &[]), None).unwrap();
        upsert_block(&conn, &make_block("clip-2", &[]), None).unwrap();
        upsert_block(&conn, &make_block("clip-3", &[]), None).unwrap();
        let slug = resolve_unique_slug(&conn, "clip").unwrap();
        assert_eq!(slug, "clip (2)");
    }

    // ── resolve_unique_slug: LIKE pattern safety ────────────────────────

    #[test]
    fn resolve_unique_slug_with_percent_does_not_match_unrelated_slugs() {
        // A raw slug "50%" must NOT match "50abc-5" via LIKE wildcard expansion.
        let conn = test_conn();
        upsert_block(&conn, &make_block("50abc-5", &[]), None).unwrap();
        let slug = resolve_unique_slug(&conn, "50%").unwrap();
        // No conflict: "50%" itself is not in DB and "50abc-5" is unrelated.
        assert_eq!(slug, "50%");
    }

    #[test]
    fn resolve_unique_slug_with_percent_still_detects_literal_conflict() {
        // If the raw slug "50%" itself exists, collision must still be detected.
        let conn = test_conn();
        upsert_block(&conn, &make_block("50%", &[]), None).unwrap();
        let slug = resolve_unique_slug(&conn, "50%").unwrap();
        assert_eq!(slug, "50% (2)");
    }

    #[test]
    fn resolve_unique_slug_with_underscore_is_literal() {
        // Underscore is a LIKE single-char wildcard; must be escaped.
        let conn = test_conn();
        upsert_block(&conn, &make_block("foo_bar", &[]), None).unwrap();
        upsert_block(&conn, &make_block("fooXbar (2)", &[]), None).unwrap();
        let slug = resolve_unique_slug(&conn, "foo_bar").unwrap();
        // Only the literal "foo_bar" and "foo_bar (N)" may count; "fooXbar (2)" does not.
        assert_eq!(slug, "foo_bar (2)");
    }

    #[test]
    fn resolve_unique_slug_with_backslash_is_literal() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("path\\segment", &[]), None).unwrap();
        let slug = resolve_unique_slug(&conn, "path\\segment").unwrap();
        assert_eq!(slug, "path\\segment (2)");
    }

    #[test]
    fn resolve_unique_slug_with_unicode_and_spaces() {
        let conn = test_conn();
        upsert_block(&conn, &make_block("Закат в Токио", &[]), None).unwrap();
        let slug = resolve_unique_slug(&conn, "Закат в Токио").unwrap();
        assert_eq!(slug, "Закат в Токио (2)");
    }

    #[test]
    fn resolve_unique_slug_with_parentheses_in_base() {
        // Base contains parens from user content; suffix still appends
        // as a new parenthetical group.
        let conn = test_conn();
        upsert_block(&conn, &make_block("Note (draft)", &[]), None).unwrap();
        let slug = resolve_unique_slug(&conn, "Note (draft)").unwrap();
        assert_eq!(slug, "Note (draft) (2)");
    }

    // ── normalize_local_markdown_url (18.F.2) ───────────────────────────

    #[test]
    fn normalize_url_decodes_local_percent_encoded_parens_and_spaces() {
        let encoded = "Title%20%28image%201%29.jpg";
        assert_eq!(normalize_local_markdown_url(encoded), "Title (image 1).jpg");
    }

    #[test]
    fn normalize_url_decodes_cyrillic_names() {
        let encoded = "Закат%20%28image%201%29.jpg";
        assert_eq!(normalize_local_markdown_url(encoded), "Закат (image 1).jpg");
    }

    #[test]
    fn normalize_url_passes_remote_urls_through_unchanged() {
        // Remote URLs may have legitimate percent-encoded query strings
        // that must survive unchanged.
        let url = "https://cdn.example.com/path?x=%20y&z=%28";
        assert_eq!(normalize_local_markdown_url(url), url);
    }

    #[test]
    fn normalize_url_is_noop_for_plain_ascii_names() {
        assert_eq!(normalize_local_markdown_url("photo.jpg"), "photo.jpg");
    }

    #[test]
    fn extract_media_urls_decodes_local_filenames() {
        let body = "![](Title%20%28image%201%29.jpg)\n\nsome text\n\n\
                    ![](Other%20%28video%201%29.mp4)";
        let json = extract_media_urls(body).unwrap();
        assert_eq!(json, "[\"Title (image 1).jpg\",\"Other (video 1).mp4\"]");
    }

    #[test]
    fn extract_first_image_decodes_local_filename() {
        let body = "prelude\n\n![alt](Title%20%28image%201%29.jpg)\n\nend";
        assert_eq!(
            extract_first_image(body),
            Some("Title (image 1).jpg".to_string())
        );
    }

    #[test]
    fn extract_media_urls_preserves_remote_encoded_urls() {
        let body = "![](https://cdn.example.com/path%20with%20space.jpg)";
        let json = extract_media_urls(body).unwrap();
        assert_eq!(
            json,
            "[\"https://cdn.example.com/path%20with%20space.jpg\"]"
        );
    }

    // ── Wikilink syntax parsing (18.H.1) ────────────────────────────────

    #[test]
    fn extract_media_urls_reads_wikilink() {
        let body = "intro\n\n![[Title (image 1).jpg]]\n\nmore text";
        let json = extract_media_urls(body).unwrap();
        assert_eq!(json, "[\"Title (image 1).jpg\"]");
    }

    #[test]
    fn extract_media_urls_reads_wikilink_with_alt() {
        let body = "![[Title (image 1).jpg|a caption]]";
        let json = extract_media_urls(body).unwrap();
        assert_eq!(json, "[\"Title (image 1).jpg\"]");
    }

    #[test]
    fn extract_media_urls_reads_mixed_wikilink_and_markdown() {
        // Both syntaxes in one body; order preserved.
        let body = "![[Note (image 1).png]]\n\ncontext\n\n\
                    ![](https://cdn.example.com/remote.jpg)\n\n\
                    ![[Other (video 1).mp4]]";
        let json = extract_media_urls(body).unwrap();
        assert_eq!(
            json,
            "[\"Note (image 1).png\",\"https://cdn.example.com/remote.jpg\",\"Other (video 1).mp4\"]"
        );
    }

    #[test]
    fn extract_first_image_picks_wikilink_when_first() {
        let body = "![[First (image 1).jpg]]\n\n![](later.png)";
        assert_eq!(
            extract_first_image(body),
            Some("First (image 1).jpg".to_string())
        );
    }

    #[test]
    fn extract_first_image_picks_markdown_when_first() {
        let body = "![alt](early.png)\n\n![[Later (image 1).jpg]]";
        assert_eq!(extract_first_image(body), Some("early.png".to_string()));
    }

    #[test]
    fn extract_ignores_malformed_wikilink_without_closing() {
        let body = "![[Unclosed wikilink";
        assert_eq!(extract_media_urls(body), None);
    }

    #[test]
    fn extract_ignores_empty_wikilink() {
        let body = "![[]] and ![[  ]]";
        assert_eq!(extract_media_urls(body), None);
    }

    // ── FTS5 escaping ───────────────────────────────────────────────────

    #[test]
    fn search_with_special_characters_does_not_error() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "test",
                "article",
                Some("Hello World"),
                "2026-01-01T00:00:00Z",
                &[],
                "body",
            ),
            None,
        )
        .unwrap();

        // These would cause FTS5 syntax errors without escaping
        for query_text in &["\"quoted\"", "hello*world", "(parens)", "a OR b", "prefix*"] {
            let query = SearchQuery {
                text: query_text.to_string(),
                filters: vec![],
            };
            let result = search_blocks(&conn, &query);
            assert!(result.is_ok(), "query '{}' should not error", query_text);
        }
    }

    // ── channels ─────────────────────────────────────────────────────────

    #[test]
    fn upsert_and_list_channels() {
        let conn = test_conn();
        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let ch = Channel::new("design", Some("Design Inspiration"), dt).unwrap();
        let id = upsert_channel(&conn, &ch).unwrap();
        assert!(id > 0);

        let channels = list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].tag, "design");
        assert_eq!(channels[0].title, "Design Inspiration");
    }

    #[test]
    fn upsert_channel_updates_existing() {
        let conn = test_conn();
        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let ch1 = Channel::new("design", Some("Old Title"), dt.clone()).unwrap();
        upsert_channel(&conn, &ch1).unwrap();

        let mut ch2 = Channel::new("design", Some("New Title"), dt).unwrap();
        ch2.position = 5;
        upsert_channel(&conn, &ch2).unwrap();

        let channels = list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].title, "New Title");
        assert_eq!(channels[0].position, 5);
    }

    #[test]
    fn list_channels_dedupes_legacy_alias_rows_by_normalized_tag() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO channels (tag, title, description, color, icon, position, created_at)
             VALUES (?1, ?2, NULL, NULL, NULL, ?3, ?4)",
            params!["Красивый веб", "Legacy Alias", 0i64, "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (tag, title, description, color, icon, position, created_at)
             VALUES (?1, ?2, NULL, NULL, NULL, ?3, ?4)",
            params!["красивый-веб", "Canonical", 5i64, "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        let channels = list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].tag, "красивый-веб");
        assert_eq!(channels[0].title, "Canonical");
        assert_eq!(channels[0].position, 5);
    }

    #[test]
    fn upsert_channel_from_block_normalizes_filename_alias_tag() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO channels (tag, title, description, color, icon, position, created_at)
             VALUES (?1, ?2, NULL, NULL, NULL, ?3, ?4)",
            params!["Красивый веб", "Legacy Alias", 0i64, "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        let mut block = make_block_full(
            "Красивый веб",
            "channel",
            Some("Красивый веб"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.position = Some(3);
        upsert_channel_from_block(&conn, &block).unwrap();

        let channels = list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].tag, "красивый-веб");
        assert_eq!(channels[0].title, "Красивый веб");
        assert_eq!(channels[0].position, 3);

        let raw_alias_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM channels WHERE tag = ?1",
                ["Красивый веб"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(raw_alias_count, 0);
    }

    #[test]
    fn remove_channel_existing() {
        let conn = test_conn();
        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let ch = Channel::new("design", None, dt).unwrap();
        upsert_channel(&conn, &ch).unwrap();
        assert!(remove_channel(&conn, "design").unwrap());
        assert!(list_channels(&conn).unwrap().is_empty());
    }

    #[test]
    fn remove_channel_nonexistent() {
        let conn = test_conn();
        assert!(!remove_channel(&conn, "nope").unwrap());
    }

    #[test]
    fn channels_ordered_by_position() {
        let conn = test_conn();
        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();

        let mut ch_b = Channel::new("beta", None, dt.clone()).unwrap();
        ch_b.position = 2;
        upsert_channel(&conn, &ch_b).unwrap();

        let mut ch_a = Channel::new("alpha", None, dt.clone()).unwrap();
        ch_a.position = 1;
        upsert_channel(&conn, &ch_a).unwrap();

        let mut ch_c = Channel::new("gamma", None, dt).unwrap();
        ch_c.position = 0;
        upsert_channel(&conn, &ch_c).unwrap();

        let channels = list_channels(&conn).unwrap();
        let tags: Vec<&str> = channels.iter().map(|c| c.tag.as_str()).collect();
        assert_eq!(tags, vec!["gamma", "alpha", "beta"]);
    }

    #[test]
    fn next_channel_position_appends_after_current_max() {
        let conn = test_conn();
        assert_eq!(next_channel_position(&conn).unwrap(), 0);

        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let mut ch_a = Channel::new("alpha", None, dt.clone()).unwrap();
        ch_a.position = 4;
        upsert_channel(&conn, &ch_a).unwrap();

        let mut ch_b = Channel::new("beta", None, dt).unwrap();
        ch_b.position = 9;
        upsert_channel(&conn, &ch_b).unwrap();

        assert_eq!(next_channel_position(&conn).unwrap(), 10);
    }
}
