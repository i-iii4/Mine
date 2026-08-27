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
    build_preview_text, derive_card_kind, derive_title_fields, extract_note_wikilinks,
    iter_inline_media_references, normalize_local_markdown_url, parse_markdown_document,
    strip_first_markdown_h1, Block, BlockType, CardKind, DateTime, Frontmatter,
    FEED_PREVIEW_TEXT_BUFFER_CHARS,
};
#[cfg(test)]
use crate::domain::channel::Channel;
#[cfg(test)]
use crate::domain::search::{SearchFilter, SearchQuery};
use crate::domain::vault::{validate_slug, VaultLayout};
use crate::storage::db;
use crate::storage::media_dimensions::{
    build_media_dimensions_json, build_media_dimensions_json_from_sources, PreviewDimensions,
    SourceDimensions,
};
use crate::storage::media_refs;
use crate::storage::preview_plan::{
    is_image_media, is_remote_media, is_video_media, local_media_items, media_ext_lower,
    primary_preview_path, tile_preview_path, PREVIEW_TILE_LIMIT,
};

pub(crate) use crate::storage::block_queries::light_block_from_row;
pub use crate::storage::block_queries::{
    count_grid_blocks, get_all_tags, get_block, get_block_indexed_at_map,
    get_pending_thumb_upgrade_block, list_blocks, list_blocks_by_tag, list_blocks_light,
    list_grid_blocks, list_pending_thumb_upgrade_blocks, list_preview_blocks,
    list_preview_blocks_by_tag, search_blocks,
};
#[cfg(test)]
pub(crate) use crate::storage::block_queries::{get_tags_for_block, list_grid_blocks_with_query};
pub use crate::storage::channel_index::{
    list_channels, next_channel_position, remove_channel, sweep_channels_without_documents,
    update_channel_positions, upsert_channel, upsert_channel_from_block,
};
pub use crate::storage::vault_conflicts::{
    clear_vault_conflict, list_vault_conflicts, record_vault_conflict, vault_conflict_exists,
    VaultConflict,
};

// ─── Types ──────────────────────────────────────────────────────────────────

const MEDIA_INDEX_VERSION: i64 = 5;
const COLLECTION_INDEX_VERSION: i64 = 1;
pub const PREVIEW_SCHEMA_VERSION: i64 = 2;

/// A block as read from the database index.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct IndexedBlock {
    pub id: i64,
    pub slug: String,
    pub block_type: BlockType,
    pub card_kind: CardKind,
    pub title: Option<String>,
    pub content_heading: Option<String>,
    pub display_title: Option<String>,
    pub fallback_label: String,
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
    pub preview_text: Option<String>,
    pub first_image: Option<String>,
    pub media_urls: Option<String>,
    pub media_dimensions: Option<String>,
    pub preview_manifest: Option<String>,
    pub feed_playback: Option<String>,
    pub thumb_format: Option<ThumbFormat>,
    pub thumb_mtime: u64,
    pub related_notes: Vec<String>,
    pub body_hash: Option<String>,
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
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct LightBlock {
    pub id: i64,
    pub slug: String,
    pub block_type: BlockType,
    pub card_kind: CardKind,
    pub title: Option<String>,
    pub content_heading: Option<String>,
    pub display_title: Option<String>,
    pub fallback_label: String,
    pub url: Option<String>,
    pub media_file: Option<String>,
    pub thumbnail: Option<String>,
    pub saved_at: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub author: Option<String>,
    pub body: String,
    pub preview_text: Option<String>,
    pub first_image: Option<String>,
    pub media_urls: Option<String>,
    pub media_dimensions: Option<String>,
    pub preview_manifest: Option<String>,
    pub feed_playback: Option<String>,
    /// The card's own media exists, but iCloud is holding its contents.
    ///
    /// Only ever true while a preview could not be built: once a preview
    /// exists the card draws from it and no longer cares where the original
    /// lives. See SPEC_CLOUD_STORAGE.md Х5–Х6.
    #[serde(default)]
    pub content_in_cloud: bool,
    /// The preview artifact is on disk but cannot be read out of it.
    ///
    /// A distinct state, not a flavour of "missing": the file exists, passed
    /// the readiness check by its header, and gave up no pixels. Without its
    /// own name on the card, a damaged cache file looks like a design
    /// decision. See SPEC_CARD_MEDIA_GEOMETRY.md.
    #[serde(default)]
    pub preview_unreadable: bool,
    pub search_match: Option<SearchMatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SearchMatchField {
    Title,
    Description,
    Author,
    Body,
    Url,
    Semantic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SearchMatchKind {
    Exact,
    Prefix,
    Fuzzy,
    Alias,
    Semantic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct SearchTextRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct SearchMatch {
    pub field: SearchMatchField,
    pub kind: SearchMatchKind,
    pub excerpt: String,
    pub ranges: Vec<SearchTextRange>,
    pub score: f64,
    pub explanation: Option<String>,
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
    /// Serialized feed preview manifest — its video tiles drive per-video
    /// gallery poster upgrades (each video tile's `preview_path` poster).
    pub preview_manifest: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum FeedPreviewKind {
    Text,
    Image,
    VideoPoster,
    Composite,
}

impl FeedPreviewKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::VideoPoster => "video_poster",
            Self::Composite => "composite",
        }
    }
}

/// One preview tile.
///
/// `width`/`height` describe the **source** file and exist for playback
/// budgets. `preview_width`/`preview_height` describe the **derived artifact**
/// this tile actually paints and are the only legitimate input to card
/// geometry. For composite previews the two differ by design: collage tiles are
/// cropped to fixed slots. See `SPEC_CARD_MEDIA_GEOMETRY.md`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct FeedPreviewTile {
    pub source_path: String,
    pub preview_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default)]
    pub preview_width: Option<u32>,
    #[serde(default)]
    pub preview_height: Option<u32>,
    pub is_video: bool,
    pub is_video_poster: bool,
}

/// Preview plan for one card.
///
/// Same split as [`FeedPreviewTile`]: `width`/`height` are the source,
/// `preview_width`/`preview_height` are the artifact the feed paints. Absent
/// preview dimensions mean "geometry not known yet" — a legitimate state for
/// formats Rust cannot decode — and must never be substituted with a default
/// aspect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct FeedPreviewManifest {
    pub kind: FeedPreviewKind,
    pub primary_preview_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default)]
    pub preview_width: Option<u32>,
    #[serde(default)]
    pub preview_height: Option<u32>,
    pub tiles: Vec<FeedPreviewTile>,
    pub overflow_count: usize,
}

impl FeedPreviewManifest {
    /// Dimensions of the artifact this card paints, when known.
    pub fn preview_dimensions(&self) -> Option<PreviewDimensions> {
        PreviewDimensions::from_parts(self.preview_width, self.preview_height)
    }
}

impl FeedPreviewTile {
    /// Dimensions of the artifact this tile paints, when known.
    pub fn preview_dimensions(&self) -> Option<PreviewDimensions> {
        PreviewDimensions::from_parts(self.preview_width, self.preview_height)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub enum FeedPlaybackContainer {
    #[serde(rename = "mp4")]
    Mp4,
    #[serde(rename = "webm")]
    Webm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub enum FeedPlaybackKind {
    #[serde(rename = "single_video")]
    SingleVideo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub enum FeedPlaybackProfile {
    #[serde(rename = "standard")]
    Standard,
    #[serde(rename = "heavy")]
    Heavy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct FeedPlaybackDescriptor {
    pub kind: FeedPlaybackKind,
    pub source_path: String,
    pub poster_preview_path: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub container: FeedPlaybackContainer,
    pub profile: FeedPlaybackProfile,
}

pub(crate) const LIGHT_BLOCK_BODY_PREVIEW_CHARS: i64 = 220;
// The standard profile plays through a blob URL (fully buffered in memory), so
// its byte ceiling bounds that allocation. The heavy profile streams from disk
// with bounded memory, so within its own much larger byte ceiling only the
// decoder's pixel limits (longest side / area) can force a block out.
const FEED_AUTOPLAY_STANDARD_MAX_SOURCE_BYTES: u64 = 24 * 1024 * 1024;
const FEED_AUTOPLAY_STANDARD_MAX_LONGEST_SIDE_PX: u32 = 2560;
const FEED_AUTOPLAY_STANDARD_MAX_PIXEL_AREA: u64 = 4_000_000;
// Upper byte bound for the heavy profile. A source larger than this is never
// autoplayed in the feed (feed_playback = null, poster only): on an iCloud
// vault a `<video src>` pointed at a dataless multi-gigabyte file forces the
// system to download the entire file just to scroll past it. Sized to clear
// legitimate large clips (≈100 MB DNA-repair reference footage, long phone
// recordings) while cutting off multi-gigabyte files; oversized videos stay
// playable on demand from the Detail view.
const FEED_AUTOPLAY_HARD_MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const FEED_AUTOPLAY_HARD_MAX_LONGEST_SIDE_PX: u32 = 5120;
const FEED_AUTOPLAY_HARD_MAX_PIXEL_AREA: u64 = 12_000_000;

/// A tag with its usage count across blocks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
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

    pub(crate) fn from_db(value: &str) -> Option<Self> {
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
fn extract_first_image(block: &Block, vault_root: Option<&Path>) -> Option<String> {
    extract_media_sources(block, vault_root).into_iter().next()
}

/// Extract all inline media references from body text as a JSON array.
fn extract_media_urls(block: &Block, vault_root: Option<&Path>) -> Option<String> {
    let urls = extract_media_sources(block, vault_root);
    media_urls_from_sources(&urls)
}

fn extract_media_sources(block: &Block, vault_root: Option<&Path>) -> Vec<String> {
    iter_inline_media_references(&block.body)
        .into_iter()
        .map(|reference| resolve_index_media_source(block, vault_root, &reference))
        .collect()
}

fn extract_media_sources_with_resolver(
    block: &Block,
    resolver: &mut media_refs::MediaResolver<'_>,
) -> Vec<String> {
    iter_inline_media_references(&block.body)
        .into_iter()
        .map(|reference| {
            if is_remote_media(&reference.source) {
                reference.source.clone()
            } else {
                resolver
                    .resolve_inline_media_root_relative(&block.slug, &reference)
                    .unwrap_or(reference.source)
            }
        })
        .collect()
}

fn media_urls_from_sources(sources: &[String]) -> Option<String> {
    if sources.is_empty() {
        None
    } else {
        serde_json::to_string(sources).ok()
    }
}

fn resolve_index_media_source(
    block: &Block,
    vault_root: Option<&Path>,
    reference: &crate::domain::block::InlineMediaReference,
) -> String {
    if is_remote_media(&reference.source) {
        return reference.source.clone();
    }
    let Some(root) = vault_root else {
        return reference.source.clone();
    };
    let vault = VaultLayout::new(root.to_path_buf());
    media_refs::resolve_inline_media_root_relative(&vault, &block.slug, reference)
        .unwrap_or_else(|| reference.source.clone())
}

fn serialize_related_notes(related_notes: &[String]) -> Option<String> {
    if related_notes.is_empty() {
        None
    } else {
        serde_json::to_string(related_notes).ok()
    }
}

pub(crate) fn parse_related_notes_json(raw: Option<String>) -> Vec<String> {
    raw.and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .unwrap_or_default()
}

pub(crate) fn is_social_url(url: Option<&str>) -> bool {
    let Some(url) = url else {
        return false;
    };
    let lc = url.to_lowercase();
    (lc.contains("twitter.com/") || lc.contains("x.com/")) && lc.contains("/status/")
        || lc.contains("instagram.com/p/")
        || lc.contains("instagram.com/reel/")
        || lc.contains("instagram.com/stories/")
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
        // Every visual tile receives its final derived path after the manifest
        // shape is known. Grid never falls back to `source_path`.
        preview_path: None,
        width: dims_entry.map(|[w, _]| w),
        height: dims_entry.map(|[_, h]| h),
        // The plan does not know artifact geometry — the generator writes it.
        preview_width: None,
        preview_height: None,
        is_video,
        is_video_poster,
    }
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
    media_urls: Option<&str>,
) -> Vec<FeedPreviewTile> {
    // Scan the whole body, across every `---` section. Two producers emit
    // multi-section social bodies: a Twitter thread clip (one section per
    // tweet) and a card merge (one section per merged card, joined by
    // `\n\n---\n\n`). Both carry real media in later sections, so restricting
    // to the first section drops those tiles and their posters. Quoted tweets
    // are not separate sections — the clipper blockquotes them inside the
    // parent tweet's section — so no quoted media is excluded by design here.
    let mut tiles = Vec::new();
    let mut next_is_video_poster = false;
    // Index into the UNFILTERED media_urls list. media_urls records every
    // inline reference in body order, including remote URLs stored verbatim,
    // so its positions line up 1:1 with the body media scan below. Using the
    // remote-filtered list here instead would compact away remote entries and
    // shift every following local tile onto the wrong source_path/poster.
    let all_media = media_urls
        .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
        .unwrap_or_default();
    let mut media_index = 0usize;

    for line in body.lines() {
        // A tweet-video marker never spans sections; reset it at each `---`
        // boundary so it cannot bleed into the next merged card / tweet.
        if line.trim() == "---" {
            next_is_video_poster = false;
            continue;
        }
        if line.trim() == "<!-- tweet-video -->" {
            next_is_video_poster = true;
            continue;
        }
        let Some(src) = parse_inline_media_src(line) else {
            continue;
        };
        // Prefer media_urls because it has already passed through the canonical
        // backend resolver; fall back to the raw body src only if the lists
        // somehow diverge in length.
        let resolved_src = all_media.get(media_index).cloned().unwrap_or(src);
        media_index += 1;
        if is_remote_media(&resolved_src) {
            // Remote media cannot render as a local preview tile. Skip it, but
            // media_index already advanced so later local tiles keep aligning
            // to their real media_urls entry. Consume any pending marker too.
            next_is_video_poster = false;
            continue;
        }
        tiles.push(media_tile(
            &resolved_src,
            dims,
            is_video_media(&resolved_src),
            next_is_video_poster,
        ));
        next_is_video_poster = false;
    }

    tiles
}

fn serialize_feed_preview_manifest(
    block: &Block,
    width: Option<u32>,
    height: Option<u32>,
    media_dimensions: Option<&str>,
    media_urls: Option<&str>,
) -> Option<String> {
    let dims = parse_media_dimensions_json(media_dimensions);
    let card_kind = derive_card_kind(block);

    // Body-driven planning, shared by articles and by media cards whose
    // pictures live in the body as embeds (decision 044: such a card shows as
    // the image alone, but its gallery manifest is built the same way).
    let plan_from_body = || {

            if is_social_url(block.frontmatter.url.as_deref()) {
                let mut tiles = extract_social_preview_tiles(&block.body, &dims, media_urls);
                if tiles.is_empty() {
                    tiles = local_media_items(media_urls, |_| true)
                        .into_iter()
                        .map(|src| media_tile(&src, &dims, false, false))
                        .collect();
                }
                let overflow_count = tiles.len().saturating_sub(PREVIEW_TILE_LIMIT);
                let tiles = tiles
                    .into_iter()
                    .take(PREVIEW_TILE_LIMIT)
                    .collect::<Vec<_>>();

                match tiles.as_slice() {
                    // Nothing local in the body, but the block may still have a
                    // thumbnail — a poster kept for a video too large to store.
                    // Without this the card falls back to text and the post
                    // looks empty in the feed.
                    [] => match block
                        .frontmatter
                        .thumbnail
                        .as_deref()
                        .filter(|source| is_image_media(source))
                    {
                        Some(source) => {
                            let tile = media_tile(source, &dims, false, false);
                            FeedPreviewManifest {
                                kind: FeedPreviewKind::Image,
                                primary_preview_path: Some(primary_preview_path(&block.slug)),
                                width: tile.width,
                                height: tile.height,
                                preview_width: None,
                                preview_height: None,
                                tiles: vec![tile],
                                overflow_count: 0,
                            }
                        }
                        None => FeedPreviewManifest {
                            preview_width: None,
                            preview_height: None,
                            kind: FeedPreviewKind::Text,
                            primary_preview_path: None,
                            width: None,
                            height: None,
                            tiles,
                            overflow_count: 0,
                        },
                    },
                    [single] => FeedPreviewManifest {
                        preview_width: None,
                        preview_height: None,
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
                        preview_width: None,
                        preview_height: None,
                        kind: FeedPreviewKind::Composite,
                        primary_preview_path: Some(primary_preview_path(&block.slug)),
                        width: Some(1),
                        height: Some(1),
                        tiles,
                        overflow_count,
                    },
                }
            } else {
                let image_tiles = local_media_items(media_urls, is_image_media)
                    .into_iter()
                    .map(|src| media_tile(&src, &dims, false, false))
                    .collect::<Vec<_>>();
                let overflow_count = image_tiles.len().saturating_sub(PREVIEW_TILE_LIMIT);
                let image_tiles = image_tiles
                    .into_iter()
                    .take(PREVIEW_TILE_LIMIT)
                    .collect::<Vec<_>>();

                if image_tiles.len() >= 2 {
                    FeedPreviewManifest {
                        kind: FeedPreviewKind::Composite,
                        primary_preview_path: Some(primary_preview_path(&block.slug)),
                        width: Some(1),
                        height: Some(1),
                        preview_width: None,
                        preview_height: None,
                        tiles: image_tiles,
                        overflow_count,
                    }
                } else if let Some(single) = image_tiles.first() {
                    FeedPreviewManifest {
                        kind: FeedPreviewKind::Image,
                        primary_preview_path: Some(primary_preview_path(&block.slug)),
                        width: single.width,
                        height: single.height,
                        preview_width: None,
                        preview_height: None,
                        tiles: image_tiles,
                        overflow_count: 0,
                    }
                } else if let Some(video_src) = local_media_items(media_urls, is_video_media)
                    .into_iter()
                    .next()
                {
                    // Carry the tile's dimensions up, exactly as the image arm
                    // above does: the feed derives a card's aspect ratio from
                    // the manifest, and a manifest without dimensions makes it
                    // fall back to 16/9 — cropping portrait video to landscape.
                    let tile = media_tile(&video_src, &dims, true, true);
                    FeedPreviewManifest {
                        kind: FeedPreviewKind::VideoPoster,
                        primary_preview_path: Some(primary_preview_path(&block.slug)),
                        width: tile.width,
                        height: tile.height,
                        preview_width: None,
                        preview_height: None,
                        tiles: vec![tile],
                        overflow_count: 0,
                    }
                } else {
                    FeedPreviewManifest {
                        kind: FeedPreviewKind::Text,
                        primary_preview_path: None,
                        width: None,
                        height: None,
                        preview_width: None,
                        preview_height: None,
                        tiles: Vec::new(),
                        overflow_count: 0,
                    }
                }
            }
        
    };

    let mut manifest = match card_kind {
        CardKind::Media => {
            let visual_source = block
                .frontmatter
                .file
                .as_deref()
                .filter(|source| is_image_media(source) || is_video_media(source))
                .or_else(|| {
                    block
                        .frontmatter
                        .thumbnail
                        .as_deref()
                        .filter(|source| is_image_media(source))
                });
            let (preview_width, preview_height) =
                dimensions_for_src(&dims, visual_source, width, height);

            if let Some(source) = visual_source {
                let is_video = is_video_media(source);
                FeedPreviewManifest {
                    kind: if is_video {
                        FeedPreviewKind::VideoPoster
                    } else {
                        FeedPreviewKind::Image
                    },
                    primary_preview_path: Some(primary_preview_path(&block.slug)),
                    width: preview_width,
                    height: preview_height,
                    preview_width: None,
                    preview_height: None,
                    tiles: vec![FeedPreviewTile {
                        preview_width: None,
                        preview_height: None,
                        source_path: source.to_string(),
                        preview_path: None,
                        width: preview_width,
                        height: preview_height,
                        is_video,
                        is_video_poster: is_video,
                    }],
                    overflow_count: 0,
                }
            } else if crate::domain::block::iter_inline_media_sources(&block.body)
                .iter()
                .any(|source| !source.is_empty())
            {
                // A media card with no frontmatter file: its pictures are body
                // embeds, and the gallery manifest comes from them.
                plan_from_body()
            } else {
                FeedPreviewManifest {
                    kind: FeedPreviewKind::Text,
                    primary_preview_path: None,
                    width: None,
                    height: None,
                    preview_width: None,
                    preview_height: None,
                    tiles: Vec::new(),
                    overflow_count: 0,
                }
            }
        }
        CardKind::Channel => FeedPreviewManifest {
            kind: FeedPreviewKind::Text,
            primary_preview_path: None,
            width: None,
            height: None,
            preview_width: None,
            preview_height: None,
            tiles: Vec::new(),
            overflow_count: 0,
        },
        CardKind::Link => {
            let visual_source = block
                .frontmatter
                .thumbnail
                .as_deref()
                .filter(|source| is_image_media(source));
            if let Some(source) = visual_source {
                let (preview_width, preview_height) =
                    dimensions_for_src(&dims, Some(source), width, height);
                FeedPreviewManifest {
                    kind: FeedPreviewKind::Image,
                    primary_preview_path: Some(primary_preview_path(&block.slug)),
                    width: preview_width,
                    height: preview_height,
                    preview_width: None,
                    preview_height: None,
                    tiles: vec![FeedPreviewTile {
                        source_path: source.to_string(),
                        preview_path: None,
                        width: preview_width,
                        height: preview_height,
                        preview_width: None,
                        preview_height: None,
                        is_video: false,
                        is_video_poster: false,
                    }],
                    overflow_count: 0,
                }
            } else {
                FeedPreviewManifest {
                    kind: FeedPreviewKind::Text,
                    primary_preview_path: None,
                    width: None,
                    height: None,
                    preview_width: None,
                    preview_height: None,
                    tiles: Vec::new(),
                    overflow_count: 0,
                }
            }
        }
        CardKind::Article => plan_from_body(),
    };

    for (index, tile) in manifest.tiles.iter_mut().enumerate() {
        tile.preview_path = Some(tile_preview_path(&block.slug, index));
    }

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
        // m4v is a plain MP4 container and mov (QuickTime) plays natively in
        // WKWebView; both share the mp4-family playback path. Mapping them onto
        // the existing Mp4 container keeps the descriptor's JSON schema and the
        // frontend container whitelist unchanged — playback resolves the real
        // `source_path` extension, so no new container value is needed.
        Some("mp4" | "m4v" | "mov") => Some(FeedPlaybackContainer::Mp4),
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

/// Autoplay profile for a feed video.
///
/// Takes [`SourceDimensions`] and nothing else on purpose: every budget here is
/// a statement about the original file. Preview dimensions are a different type
/// and cannot reach this function, so the mistake of relaxing all limits by
/// handing it a downscaled artifact is a compile error. See
/// `SPEC_CARD_MEDIA_GEOMETRY.md`.
fn feed_autoplay_profile_for_source(
    vault_root: Option<&Path>,
    source_path: &str,
    source: Option<SourceDimensions>,
) -> Option<FeedPlaybackProfile> {
    let width = source.map(|dims| dims.width);
    let height = source.map(|dims| dims.height);
    // Hard pixel caps disqualify autoplay outright, but only when a dimension
    // is actually known: a missing width/height passes this check trivially.
    if !feed_autoplay_dimensions_within_limits(
        width,
        height,
        FEED_AUTOPLAY_HARD_MAX_LONGEST_SIDE_PX,
        FEED_AUTOPLAY_HARD_MAX_PIXEL_AREA,
    ) {
        return None;
    }

    // The standard profile buffers the whole source in an in-memory blob and
    // decodes it in the feed, so it is only safe when the frame size is fully
    // known AND within the standard pixel budget. A video whose dimensions we
    // could not extract (any non-MP4 container, or an MP4 with an unreadable
    // header) must never be decoded blind at standard cost — it could be 4K/8K
    // — so it falls through to the heavy profile (direct disk streaming with
    // bounded memory) instead.
    let standard_dimensions_ok = width.is_some()
        && height.is_some()
        && feed_autoplay_dimensions_within_limits(
            width,
            height,
            FEED_AUTOPLAY_STANDARD_MAX_LONGEST_SIDE_PX,
            FEED_AUTOPLAY_STANDARD_MAX_PIXEL_AREA,
        );

    match vault_root {
        Some(root) => {
            // Contents in iCloud: never autoplay. A <video src> materializes the
            // whole file, so scrolling past a clip would silently pull it down
            // in full — iCloud has no partial materialization, a one-byte read
            // fetches everything. The card shows its poster, which is local, and
            // the file is fetched only when the user asks for it.
            // See SPEC_CLOUD_STORAGE.md Х7.
            if crate::storage::media_dimensions::is_content_offloaded(&root.join(source_path)) {
                return None;
            }
            // A missing (evicted) source cannot be played back, so drop the
            // descriptor.
            let bytes = local_media_file_size_bytes(root, source_path)?;
            // Files above the heavy byte ceiling are never autoplayed: on an
            // iCloud vault a `<video src>` to a dataless multi-gigabyte file
            // forces a full download just to scroll past it.
            if bytes > FEED_AUTOPLAY_HARD_MAX_SOURCE_BYTES {
                return None;
            }
            if bytes <= FEED_AUTOPLAY_STANDARD_MAX_SOURCE_BYTES && standard_dimensions_ok {
                Some(FeedPlaybackProfile::Standard)
            } else {
                Some(FeedPlaybackProfile::Heavy)
            }
        }
        None => {
            if standard_dimensions_ok {
                Some(FeedPlaybackProfile::Standard)
            } else {
                Some(FeedPlaybackProfile::Heavy)
            }
        }
    }
}

fn serialize_feed_playback(
    vault_root: Option<&Path>,
    card_kind: CardKind,
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

    let (source_path, playback_source) = match card_kind {
        CardKind::Media => {
            let source_path = media_file?;
            let container = autoplay_container_for_source(source_path)?;
            let profile = feed_autoplay_profile_for_source(
                vault_root,
                source_path,
                SourceDimensions::from_parts(width, height),
            )?;
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
        CardKind::Article => {
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
            // Source dimensions, never the tile's preview dimensions: this
            // feeds the autoplay pixel budget.
            (
                tile.source_path.clone(),
                SourceDimensions::from_parts(tile.width, tile.height)
                    .or_else(|| SourceDimensions::from_parts(manifest.width, manifest.height)),
            )
        }
        CardKind::Link | CardKind::Channel => return None,
    };

    let container = autoplay_container_for_source(&source_path)?;
    let profile = feed_autoplay_profile_for_source(vault_root, &source_path, playback_source)?;
    let descriptor = FeedPlaybackDescriptor {
        kind: FeedPlaybackKind::SingleVideo,
        source_path,
        poster_preview_path,
        width: playback_source.map(|dims| dims.width),
        height: playback_source.map(|dims| dims.height),
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

pub(crate) fn row_to_preview_block(
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

pub(crate) fn parse_block_type_row(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<BlockType> {
    let raw: String = row.get(index)?;
    BlockType::from_str(&raw).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            format!("unknown block_type: {}", raw).into(),
        )
    })
}

pub(crate) fn parse_card_kind_row(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<CardKind> {
    let raw: String = row.get(index)?;
    CardKind::from_str(&raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            format!("unknown card_kind: {}", raw).into(),
        )
    })
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Insert or update a block in the index. Returns the block's row id.
///
/// On conflict (same slug): updates all fields, replaces tags and note wikilinks.
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
    let title_fields =
        derive_title_fields(&block.slug, block.frontmatter.title.as_deref(), &block.body);
    let card_kind = derive_card_kind(block);
    let preview_body = strip_first_markdown_h1(&block.body);
    let first_image = extract_first_image(block, vault_root);
    let media_urls = extract_media_urls(block, vault_root);
    let media_dimensions = vault_root.and_then(|root| {
        build_media_dimensions_json(
            root,
            &block.slug,
            block.frontmatter.file.as_deref(),
            &block.body,
        )
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
        card_kind,
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
    let preview_text = build_preview_text(&preview_body, FEED_PREVIEW_TEXT_BUFFER_CHARS);

    conn.execute(
        "INSERT INTO blocks (slug, block_type, card_kind, title, content_heading, display_title, fallback_label, description, url, media_file,
            thumbnail, saved_at, source, width, height, author, body, first_image,
            media_urls, media_dimensions, preview_manifest, feed_playback, related_notes, preview_text, preview_text_cap,
            body_hash, origin, index_warning, media_index_version, collection_index_version, graph_link_index_version, preview_schema_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32)
         ON CONFLICT(slug) DO UPDATE SET
            block_type = excluded.block_type,
            card_kind = excluded.card_kind,
            title = excluded.title,
            content_heading = excluded.content_heading,
            display_title = excluded.display_title,
            fallback_label = excluded.fallback_label,
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
            preview_state = 'stale',
            preview_source_stamp = blocks.preview_source_stamp,
            preview_error_kind = NULL,
            feed_playback = excluded.feed_playback,
            related_notes = excluded.related_notes,
            preview_text = excluded.preview_text,
            preview_text_cap = excluded.preview_text_cap,
            body_hash = excluded.body_hash,
            origin = excluded.origin,
            index_warning = excluded.index_warning,
            media_index_version = excluded.media_index_version,
            collection_index_version = excluded.collection_index_version,
            graph_link_index_version = excluded.graph_link_index_version,
            preview_schema_version = excluded.preview_schema_version,
            indexed_at = datetime('now')",
        params![
            block.slug,
            block.frontmatter.block_type.as_str(),
            card_kind.as_str(),
            title_fields.legacy_title,
            title_fields.content_heading,
            title_fields.display_title,
            title_fields.fallback_label,
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
            preview_text,
            FEED_PREVIEW_TEXT_BUFFER_CHARS as i64,
            body_hash,
            origin,
            index_warning,
            MEDIA_INDEX_VERSION,
            COLLECTION_INDEX_VERSION,
            db::GRAPH_LINK_INDEX_VERSION,
            PREVIEW_SCHEMA_VERSION,
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

    // Replace plain note links and related-note provenance independently.
    // Inline media embeds stay in the media pipeline and never become graph
    // relations.
    conn.execute("DELETE FROM wikilinks WHERE source_id = ?1", [block_id])
        .context("failed to delete old wikilinks")?;
    conn.execute(
        "DELETE FROM related_note_links WHERE source_id = ?1",
        [block_id],
    )
    .context("failed to delete old related-note links")?;
    for link in extract_note_wikilinks(&block.body) {
        conn.execute(
            "INSERT OR IGNORE INTO wikilinks (source_id, target_slug) VALUES (?1, ?2)",
            params![block_id, link],
        )
        .context("failed to insert wikilink")?;
    }
    for note in &block.frontmatter.related_notes {
        conn.execute(
            "INSERT OR IGNORE INTO related_note_links (source_id, target_slug)
             VALUES (?1, ?2)",
            params![block_id, note],
        )
        .context("failed to insert related-note link")?;
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
            "SELECT card_kind, media_file, width, height, preview_manifest
             FROM blocks WHERE slug = ?1",
            [slug],
            |row| {
                let card_kind = parse_card_kind_row(row, 0)?;
                Ok(serialize_feed_playback(
                    vault_root,
                    card_kind,
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
           AND card_kind != 'channel'
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

/// Rebuild media-derived read-model columns after media resolution rules
/// change. Source Markdown stays untouched; only the SQLite cache is updated.
///
/// This is versioned because fields such as `media_urls` and
/// `preview_manifest` may be non-null but stale after a resolver migration.
pub fn backfill_media_index(conn: &Connection, vault: &VaultLayout) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT slug, block_type, url, media_file, thumbnail, width, height, body, thumb_format, body_hash
         FROM blocks
         WHERE slug != ''
           AND card_kind != 'channel'
           AND (media_index_version IS NULL OR media_index_version < ?1)",
    )?;

    let rows = stmt
        .query_map([MEDIA_INDEX_VERSION], |row| {
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
    drop(stmt);

    let mut resolver = media_refs::MediaResolver::new(vault);
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
        raw_thumb_format,
        body_hash,
    ) in rows
    {
        let block_type = BlockType::from_str(&raw_type)
            .with_context(|| format!("unknown block_type in media index backfill: {raw_type}"))?;
        let width = width.map(|value| value as u32);
        let height = height.map(|value| value as u32);
        let block = Block {
            slug: slug.clone(),
            frontmatter: Frontmatter {
                block_type,
                title: None,
                description: None,
                url,
                file: media_file,
                thumbnail,
                tags: Vec::new(),
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("1970-01-01T00:00:00Z")?,
                source: None,
                width,
                height,
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body,
        };
        let media_sources = extract_media_sources_with_resolver(&block, &mut resolver);
        let first_image = media_sources.first().cloned();
        let media_urls = media_urls_from_sources(&media_sources);
        let media_dimensions = build_media_dimensions_json_from_sources(
            vault.root(),
            block.frontmatter.file.as_deref(),
            &media_sources,
        );
        let preview_manifest = serialize_feed_preview_manifest(
            &block,
            width,
            height,
            media_dimensions.as_deref(),
            media_urls.as_deref(),
        );
        let thumb_format = raw_thumb_format.as_deref().and_then(ThumbFormat::from_db);
        let feed_playback = serialize_feed_playback(
            Some(vault.root()),
            derive_card_kind(&block),
            block.frontmatter.file.as_deref(),
            width,
            height,
            preview_manifest.as_deref(),
            thumb_format,
        );

        // Guard against a concurrent full_scan/watcher having reindexed this
        // file between the snapshot SELECT above and this UPDATE: if it did,
        // the row's body_hash no longer matches the snapshot, so skip it and
        // leave the fresh data (and its version stamp) in place. `IS` matches
        // NULL == NULL so legacy rows with no stored hash still backfill.
        let card_kind = derive_card_kind(&block);
        updated += conn.execute(
            "UPDATE blocks
             SET first_image = ?2,
                 media_urls = ?3,
                 media_dimensions = ?4,
                 preview_manifest = ?5,
                 preview_state = 'stale',
                 preview_source_stamp = NULL,
                 preview_error_kind = NULL,
                 feed_playback = ?6,
                 media_index_version = ?7,
                 card_kind = ?9,
                 preview_schema_version = ?10
             WHERE slug = ?1 AND body_hash IS ?8",
            params![
                slug,
                first_image,
                media_urls,
                media_dimensions,
                preview_manifest,
                feed_playback,
                MEDIA_INDEX_VERSION,
                body_hash,
                card_kind.as_str(),
                PREVIEW_SCHEMA_VERSION,
            ],
        )?;
    }

    Ok(updated)
}

/// Rebuild Mine collection memberships after collection parsing rules change.
///
/// Older indexes treated Obsidian's user-owned `tags` frontmatter as Mine
/// collection membership. The source of truth is now only `Mine Collections`,
/// so this reparses Markdown files once and replaces the `block_tags` read
/// model without touching user files.
pub fn backfill_collection_index(conn: &Connection, vault: &VaultLayout) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT slug
         FROM blocks
         WHERE slug != ''
           AND card_kind != 'channel'
           AND (collection_index_version IS NULL OR collection_index_version < ?1)",
    )?;

    let slugs = stmt
        .query_map([COLLECTION_INDEX_VERSION], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    let fallback_saved_at = DateTime::new("1970-01-01T00:00:00Z")?;
    let mut updated = 0usize;

    for slug in slugs {
        let path = vault.block_path(&slug);
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(err) => {
                log::warn!(
                    "collection index backfill: failed to read {}: {err:#}",
                    path.display()
                );
                continue;
            }
        };

        let parsed = parse_markdown_document(&slug, &content, fallback_saved_at.clone())
            .with_context(|| format!("failed to parse collection membership for {slug}"))?;

        let block_id: i64 = conn
            .query_row("SELECT id FROM blocks WHERE slug = ?1", [&slug], |row| {
                row.get(0)
            })
            .with_context(|| format!("failed to get block id for {slug}"))?;

        conn.execute_batch("SAVEPOINT collection_index_backfill")
            .with_context(|| format!("failed to begin collection index savepoint for {slug}"))?;

        let result = (|| -> Result<()> {
            conn.execute("DELETE FROM block_tags WHERE block_id = ?1", [block_id])
                .with_context(|| format!("failed to clear collection tags for {slug}"))?;

            for tag in parsed.block.frontmatter.tags {
                conn.execute(
                    "INSERT INTO block_tags (block_id, tag) VALUES (?1, ?2)",
                    params![block_id, tag],
                )
                .with_context(|| format!("failed to insert collection tag for {slug}"))?;
            }

            conn.execute(
                "UPDATE blocks SET collection_index_version = ?2 WHERE id = ?1",
                params![block_id, COLLECTION_INDEX_VERSION],
            )
            .with_context(|| format!("failed to mark collection index version for {slug}"))?;

            Ok(())
        })();

        if let Err(err) = result {
            let _ = conn.execute_batch("ROLLBACK TO SAVEPOINT collection_index_backfill");
            let _ = conn.execute_batch("RELEASE SAVEPOINT collection_index_backfill");
            return Err(err);
        }

        conn.execute_batch("RELEASE SAVEPOINT collection_index_backfill")
            .with_context(|| format!("failed to release collection index savepoint for {slug}"))?;
        updated += 1;
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
           AND card_kind != 'channel'
           AND (preview_manifest IS NULL OR preview_schema_version != ?1)",
    )?;

    let rows = stmt
        .query_map([PREVIEW_SCHEMA_VERSION], |row| {
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
             SET preview_manifest = ?2,
                 preview_state = 'stale',
                 preview_source_stamp = NULL,
                 preview_error_kind = NULL,
                 preview_schema_version = ?3
             WHERE slug = ?1
               AND (preview_manifest IS NULL OR preview_schema_version != ?3)",
            params![slug, preview_manifest, PREVIEW_SCHEMA_VERSION],
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
        "SELECT slug, card_kind, media_file, width, height, preview_manifest, thumb_format, feed_playback
         FROM blocks
         WHERE slug != ''
           AND card_kind IN ('media', 'article')",
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
        raw_card_kind,
        media_file,
        width,
        height,
        preview_manifest,
        raw_thumb_format,
        current_feed_playback,
    ) in rows
    {
        let card_kind = CardKind::from_str(&raw_card_kind).with_context(|| {
            format!("unknown card_kind in feed playback backfill: {raw_card_kind}")
        })?;
        let thumb_format = raw_thumb_format.as_deref().and_then(ThumbFormat::from_db);
        let next_feed_playback = serialize_feed_playback(
            Some(vault.root()),
            card_kind,
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

/// Backfill title + preview read-model fields introduced after older indexes
/// were created.
///
/// Re-parses source `.md` files when available so `legacy_title` can recover
/// from older index rows that had a synthetic fallback copied into `title`.
/// Falls back to the current SQLite snapshot when the file is missing or
/// unreadable.
pub fn backfill_missing_preview_text(conn: &Connection, vault: &VaultLayout) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT id, slug, title, body, content_heading, display_title, fallback_label
         FROM blocks
         WHERE slug != ''
           AND (preview_text IS NULL
            OR preview_text_cap IS NULL
            OR preview_text_cap < ?1
            OR content_heading IS NULL
            OR display_title IS NULL
            OR fallback_label IS NULL)",
    )?;
    let rows = stmt
        .query_map([FEED_PREVIEW_TEXT_BUFFER_CHARS as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    let fallback_saved_at = DateTime::new("1970-01-01T00:00:00Z")?;
    let mut updated = 0usize;

    for (
        id,
        slug,
        stored_title,
        stored_body,
        stored_heading,
        stored_display_title,
        stored_fallback_label,
    ) in rows
    {
        if let Err(err) = validate_slug(&slug) {
            log::warn!(
                "preview text backfill: skipping block with invalid slug {:?}: {}",
                slug,
                err
            );
            continue;
        }

        let (legacy_title, body) = match std::fs::read_to_string(vault.block_path(&slug)) {
            Ok(content) => {
                match parse_markdown_document(&slug, &content, fallback_saved_at.clone()) {
                    Ok(parsed) => (parsed.block.frontmatter.title, parsed.block.body),
                    Err(_) => (stored_title.clone(), stored_body.clone()),
                }
            }
            Err(_) => (stored_title.clone(), stored_body.clone()),
        };
        let title_fields = derive_title_fields(&slug, legacy_title.as_deref(), &body);
        let preview_body = strip_first_markdown_h1(&body);
        let preview_text = build_preview_text(&preview_body, FEED_PREVIEW_TEXT_BUFFER_CHARS);

        if stored_title == title_fields.legacy_title
            && stored_heading == title_fields.content_heading
            && stored_display_title == title_fields.display_title
            && stored_fallback_label.as_deref() == Some(title_fields.fallback_label.as_str())
        {
            updated += conn.execute(
                "UPDATE blocks
                 SET preview_text = ?1,
                     preview_text_cap = ?2
                 WHERE id = ?3",
                params![preview_text, FEED_PREVIEW_TEXT_BUFFER_CHARS as i64, id],
            )?;
            continue;
        }

        updated += conn.execute(
            "UPDATE blocks
             SET preview_text = ?1,
                 preview_text_cap = ?2,
                 title = ?3,
                 content_heading = ?4,
                 display_title = ?5,
                 fallback_label = ?6
             WHERE id = ?7",
            params![
                preview_text,
                FEED_PREVIEW_TEXT_BUFFER_CHARS as i64,
                title_fields.legacy_title,
                title_fields.content_heading,
                title_fields.display_title,
                title_fields.fallback_label,
                id
            ],
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

    fn media_test_block(body: &str) -> Block {
        make_block_full("note", "article", None, "2026-01-15T12:00:00Z", &[], body)
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
    fn upsert_separates_media_embeds_from_note_link_and_related_provenance() {
        let conn = test_conn();
        let mut block = make_block_full(
            "extracted",
            "image",
            Some("Extracted"),
            "2026-01-01T00:00:00Z",
            &["inspiration"],
            "![[extracted #1.jpg|Preview]]\nSee [[Source Note#^block-id|Source]]",
        );
        block.frontmatter.related_notes = vec!["Source Article".to_string()];
        upsert_block(&conn, &block, None).unwrap();

        let raw_related_notes: Option<String> = conn
            .query_row(
                "SELECT related_notes FROM blocks WHERE slug = ?1",
                ["extracted"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            parse_related_notes_json(raw_related_notes),
            vec!["Source Article".to_string()]
        );

        let got = get_block(&conn, "extracted").unwrap().unwrap();
        assert!(got.related_notes.is_empty());

        let wikilink_targets = conn
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
        assert_eq!(wikilink_targets, vec!["Source Note#^block-id|Source"]);
        let related_targets = conn
            .prepare(
                "SELECT target_slug FROM related_note_links
                 JOIN blocks ON blocks.id = related_note_links.source_id
                 WHERE blocks.slug = ?1
                 ORDER BY target_slug",
            )
            .unwrap()
            .query_map(["extracted"], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(related_targets, vec!["Source Article"]);
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

    #[test]
    fn get_block_related_notes_are_bidirectional() {
        let conn = test_conn();

        let current = make_block_full(
            "current",
            "article",
            Some("Current"),
            "2026-01-01T00:00:00Z",
            &[],
            "See [[outgoing]] [[aliased|Shown]] [[current]] [[channel-home]]",
        );
        upsert_block(&conn, &current, None).unwrap();

        let outgoing = make_block_full(
            "outgoing",
            "article",
            Some("Outgoing"),
            "2026-01-04T00:00:00Z",
            &[],
            "",
        );
        upsert_block(&conn, &outgoing, None).unwrap();

        let aliased = make_block_full(
            "aliased",
            "article",
            Some("Aliased"),
            "2026-01-03T00:00:00Z",
            &[],
            "",
        );
        upsert_block(&conn, &aliased, None).unwrap();

        let mut extracted = make_block_full(
            "extracted",
            "image",
            Some("Extracted"),
            "2026-01-06T00:00:00Z",
            &[],
            "![[extracted.jpg]]",
        );
        extracted.frontmatter.related_notes = vec!["current#^source".to_string()];
        upsert_block(&conn, &extracted, None).unwrap();

        let incoming = make_block_full(
            "incoming",
            "article",
            Some("Incoming"),
            "2026-01-05T00:00:00Z",
            &[],
            "Backlink [[current#Heading]] and [[current|Alias]]",
        );
        upsert_block(&conn, &incoming, None).unwrap();

        let channel = make_block_full(
            "channel-home",
            "channel",
            Some("Channel"),
            "2026-01-07T00:00:00Z",
            &[],
            "[[current]]",
        );
        upsert_block(&conn, &channel, None).unwrap();

        let got = get_block(&conn, "current").unwrap().unwrap();
        assert_eq!(
            got.related_notes,
            vec![
                "extracted".to_string(),
                "incoming".to_string(),
                "outgoing".to_string(),
                "aliased".to_string(),
            ]
        );
    }

    #[test]
    fn get_block_related_notes_exclude_nonexistent_targets_and_channels() {
        let conn = test_conn();

        let mut current = make_block_full(
            "current",
            "article",
            Some("Current"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        current.frontmatter.related_notes = vec![
            "missing note".to_string(),
            "channel-home".to_string(),
            "existing note".to_string(),
        ];
        upsert_block(&conn, &current, None).unwrap();

        let existing = make_block_full(
            "existing note",
            "article",
            Some("Existing"),
            "2026-01-03T00:00:00Z",
            &[],
            "",
        );
        upsert_block(&conn, &existing, None).unwrap();

        let channel = make_block_full(
            "channel-home",
            "channel",
            Some("Channel"),
            "2026-01-04T00:00:00Z",
            &[],
            "",
        );
        upsert_block(&conn, &channel, None).unwrap();

        let got = get_block(&conn, "current").unwrap().unwrap();
        assert_eq!(got.related_notes, vec!["existing note".to_string()]);
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
    fn search_by_type_filter_uses_derived_card_kind() {
        let conn = test_conn();
        upsert_block(
            &conn,
            // Decision 044: kind comes from content, so the media fixture needs
            // real media — a bare embed — rather than a `type: image` claim.
            &make_block_full("img", "image", None, "2026-01-01T00:00:00Z", &[], "![[img.jpg]]"),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full("art", "image", None, "2026-01-01T00:00:00Z", &[], "body"),
            None,
        )
        .unwrap();

        let query = SearchQuery {
            text: String::new(),
            filters: vec![SearchFilter::Type(CardKind::Article)],
        };
        let results = search_blocks(&conn, &query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].slug, "art");
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
    fn list_grid_blocks_returns_indexed_preview_text() {
        let conn = test_conn();
        let body = "## Мои задачи\n\n- [ ] Создать **plan.md** проекта — формализовать все договорённости и роудмап в одном документе\n- [ ] Dogfood всех сценариев: пройти полный путь игрока, разработчика, фандера и спекулянта на платформе";
        upsert_block(
            &conn,
            &make_block_full(
                "Gaming Platform/Встречи/12.04.2026 Встреча с Владом",
                "article",
                None,
                "2026-01-01T00:00:00Z",
                &[],
                body,
            ),
            None,
        )
        .unwrap();

        let (blocks, has_more) = list_grid_blocks(&conn, None, 0, 20).unwrap();
        assert!(!has_more);
        assert_eq!(blocks.len(), 1);
        let preview = blocks[0].preview_text.as_deref().unwrap();
        assert!(preview.starts_with("Мои задачи Создать plan.md проекта"));
        assert!(!preview.contains("[ ]"));
        assert!(!preview.contains("**"));

        let preview_text_cap: Option<i64> = conn
            .query_row(
                "SELECT preview_text_cap FROM blocks WHERE slug = ?1",
                ["Gaming Platform/Встречи/12.04.2026 Встреча с Владом"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            preview_text_cap,
            Some(FEED_PREVIEW_TEXT_BUFFER_CHARS as i64)
        );
    }

    #[test]
    fn list_grid_blocks_exposes_previews_only_after_ready_state() {
        let conn = test_conn();
        let mut block = make_block_full(
            "ready-gate",
            "image",
            Some("Ready gate"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("photo.jpg".to_string());
        upsert_block(&conn, &block, None).unwrap();

        let (stale, _) = list_grid_blocks(&conn, None, 0, 20).unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].preview_manifest, None);
        assert_eq!(stale[0].feed_playback, None);

        conn.execute(
            "INSERT INTO source_index_state (slug, source_kind, source_stamp)
             VALUES ('ready-gate', 'block', 'source-v1')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE blocks
             SET preview_state = 'ready', preview_source_stamp = 'source-v1'
             WHERE slug = 'ready-gate'",
            [],
        )
        .unwrap();
        let (ready, _) = list_grid_blocks(&conn, None, 0, 20).unwrap();
        assert!(ready[0].preview_manifest.is_some());
    }

    #[test]
    fn list_grid_blocks_keeps_serving_a_preview_that_only_went_stale() {
        // Editing frontmatter tags marks every block stale, and the source
        // stamp covers the whole `.md`, so connecting a card to a collection
        // invalidated a poster no medium had touched. Withholding it left the
        // card text-only until the preview queue came round — minutes of a
        // video missing from the feed for an edit that changed no media.
        let conn = test_conn();
        let mut block = make_block_full(
            "stale-but-drawn",
            "image",
            Some("Stale but drawn"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("photo.jpg".to_string());
        upsert_block(&conn, &block, None).unwrap();
        conn.execute(
            "INSERT INTO source_index_state (slug, source_kind, source_stamp)
             VALUES ('stale-but-drawn', 'block', 'source-v1')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE blocks SET preview_state = 'ready', preview_source_stamp = 'source-v1'
             WHERE slug = 'stale-but-drawn'",
            [],
        )
        .unwrap();

        // A tag edit: the block is rewritten, which marks the preview stale
        // while leaving the stamp of the artifact already on disk.
        block.frontmatter.tags.push("Красивый веб".to_string());
        upsert_block(&conn, &block, None).unwrap();

        let state: String = conn
            .query_row(
                "SELECT preview_state FROM blocks WHERE slug = 'stale-but-drawn'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "stale");

        let (blocks, _) = list_grid_blocks(&conn, None, 0, 20).unwrap();
        assert!(
            blocks[0].preview_manifest.is_some(),
            "a stale preview that exists on disk must still be drawn",
        );
    }

    #[test]
    fn list_grid_blocks_with_query_filters_route_and_returns_match_excerpt() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "alpha-title",
                "article",
                Some("Aristotle notes"),
                "2026-01-01T00:00:00Z",
                &["alpha"],
                "",
            ),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "alpha-body",
                "article",
                Some("Greek philosophy"),
                "2026-01-03T00:00:00Z",
                &["alpha"],
                "Plato opens the section. Aristotle appears in the body excerpt and should be highlighted.",
            ),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "beta-title",
                "article",
                Some("Aristotle elsewhere"),
                "2026-01-04T00:00:00Z",
                &["beta"],
                "",
            ),
            None,
        )
        .unwrap();

        let (blocks, has_more) =
            list_grid_blocks_with_query(&conn, Some("alpha"), 0, 20, Some("Aristotle")).unwrap();

        assert!(!has_more);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].slug, "alpha-title");
        assert_eq!(
            blocks[0].search_match.as_ref().unwrap().field,
            SearchMatchField::Title
        );
        let body_match = blocks
            .iter()
            .find(|block| block.slug == "alpha-body")
            .and_then(|block| block.search_match.as_ref())
            .unwrap();
        assert_eq!(body_match.field, SearchMatchField::Body);
        assert!(body_match.excerpt.contains("Aristotle"));
        assert_eq!(body_match.ranges.len(), 1);

        let (prefix_blocks, prefix_has_more) =
            list_grid_blocks_with_query(&conn, Some("alpha"), 0, 20, Some("Aris")).unwrap();
        assert!(!prefix_has_more);
        assert_eq!(prefix_blocks.len(), 2);
        assert!(prefix_blocks
            .iter()
            .any(|block| block.slug == "alpha-title"));
        assert!(prefix_blocks.iter().any(|block| block.slug == "alpha-body"));
    }

    #[test]
    fn list_grid_blocks_with_query_uses_visible_body_match_before_fallback_label() {
        let conn = test_conn();
        let mut block = make_block_full(
            "memory-in-slug",
            "article",
            Some("Memory Machines hidden social title"),
            "2026-01-01T00:00:00Z",
            &[],
            "Social card body contains Memory and must be highlighted.",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());
        upsert_block(&conn, &block, None).unwrap();

        let (blocks, has_more) =
            list_grid_blocks_with_query(&conn, None, 0, 20, Some("memo")).unwrap();

        assert!(!has_more);
        assert_eq!(blocks.len(), 1);
        let search_match = blocks[0].search_match.as_ref().unwrap();
        assert_eq!(search_match.field, SearchMatchField::Body);
        assert!(search_match.excerpt.contains("Memory"));
        let range = search_match.ranges.first().unwrap();
        let highlighted = search_match
            .excerpt
            .chars()
            .skip(range.start)
            .take(range.end - range.start)
            .collect::<String>();
        assert_eq!(highlighted, "Memo");
    }

    #[test]
    fn list_grid_blocks_with_query_matches_cross_language_alias_phrase() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "memory-flock",
                "article",
                Some("Hopfield sketch"),
                "2026-01-01T00:00:00Z",
                &["research"],
                "Memory is a flock of birds in a small Hopfield network.",
            ),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "unrelated-memory",
                "article",
                Some("Memory table"),
                "2026-01-02T00:00:00Z",
                &["other"],
                "Memory appears here without birds or flock context.",
            ),
            None,
        )
        .unwrap();

        let (blocks, has_more) = list_grid_blocks_with_query(
            &conn,
            Some("research"),
            0,
            20,
            Some("память как стая птиц"),
        )
        .unwrap();

        assert!(!has_more);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].slug, "memory-flock");
        let search_match = blocks[0].search_match.as_ref().unwrap();
        assert_eq!(search_match.field, SearchMatchField::Body);
        assert_eq!(search_match.kind, SearchMatchKind::Alias);
        assert!(search_match.excerpt.contains("Memory"));
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
    fn social_post_falls_back_to_its_poster_when_the_video_stayed_remote() {
        // A video too large to store leaves only a remote URL in the body, which
        // never becomes a tile. The poster is what keeps the card from going
        // text-only in the feed.
        let mut block = make_block_full(
            "oversized-clip",
            "article",
            Some("Oversized clip"),
            "2026-01-01T00:00:00Z",
            &[],
            "text\n\n![](https://video.twimg.com/amplify_video/1/vid/720x1280/a.mp4)",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());
        block.frontmatter.thumbnail = Some("oversized-clip (poster).jpg".to_string());

        let manifest: FeedPreviewManifest = serde_json::from_str(
            &serialize_feed_preview_manifest(
                &block,
                None,
                None,
                Some(r#"{"oversized-clip (poster).jpg":[720,1280]}"#),
                Some("[]"),
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(manifest.kind, FeedPreviewKind::Image);
        assert_eq!((manifest.width, manifest.height), (Some(720), Some(1280)));
        assert_eq!(
            manifest.tiles[0].source_path,
            "oversized-clip (poster).jpg"
        );
    }

    #[test]
    fn social_post_without_media_or_poster_stays_text() {
        let mut block = make_block_full(
            "plain-post",
            "article",
            Some("Plain post"),
            "2026-01-01T00:00:00Z",
            &[],
            "just text",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());

        let manifest: FeedPreviewManifest = serde_json::from_str(
            &serialize_feed_preview_manifest(&block, None, None, None, Some("[]")).unwrap(),
        )
        .unwrap();

        assert_eq!(manifest.kind, FeedPreviewKind::Text);
    }

    #[test]
    fn article_video_manifest_carries_the_clip_dimensions() {
        // Without these the feed has nothing to derive an aspect ratio from and
        // falls back to 16/9, cropping a portrait clip to landscape while the
        // image next to it keeps its own proportions.
        let block = make_block_full(
            "portrait-clip",
            "article",
            Some("Portrait clip"),
            "2026-01-01T00:00:00Z",
            &[],
            "text\n\n![[clip.mp4]]",
        );
        let manifest: FeedPreviewManifest = serde_json::from_str(
            &serialize_feed_preview_manifest(
                &block,
                None,
                None,
                Some(r#"{"clip.mp4":[588,720]}"#),
                Some(r#"["clip.mp4"]"#),
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(manifest.kind, FeedPreviewKind::VideoPoster);
        assert_eq!((manifest.width, manifest.height), (Some(588), Some(720)));
        assert_eq!(
            (manifest.tiles[0].width, manifest.tiles[0].height),
            (Some(588), Some(720))
        );
    }

    #[test]
    fn article_video_manifest_without_dimensions_stays_empty() {
        let block = make_block_full(
            "unmeasured-clip",
            "article",
            Some("Unmeasured clip"),
            "2026-01-01T00:00:00Z",
            &[],
            "text\n\n![[clip.mp4]]",
        );
        let manifest: FeedPreviewManifest = serde_json::from_str(
            &serialize_feed_preview_manifest(&block, None, None, None, Some(r#"["clip.mp4"]"#))
                .unwrap(),
        )
        .unwrap();

        assert_eq!(manifest.kind, FeedPreviewKind::VideoPoster);
        assert_eq!((manifest.width, manifest.height), (None, None));
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
        assert_eq!(
            manifest.tiles[0].preview_path.as_deref(),
            Some("tweet-video.preview-1.jpg")
        );
    }

    #[test]
    fn social_gallery_assigns_unique_derived_path_to_every_tile() {
        let conn = test_conn();
        let mut block = make_block_full(
            "ig-mixed",
            "article",
            Some("Mixed"),
            "2026-01-01T00:00:00Z",
            &[],
            "![](one.mp4)\n![](two.jpg)\n![](three.mp4)",
        );
        block.frontmatter.url = Some("https://www.instagram.com/p/X/".to_string());
        upsert_block(&conn, &block, None).unwrap();

        let light = list_blocks_light(&conn).unwrap();
        let manifest: FeedPreviewManifest =
            serde_json::from_str(light[0].preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.kind, FeedPreviewKind::Composite);
        assert_eq!(manifest.tiles.len(), 3);
        assert_eq!(
            manifest.tiles[0].preview_path.as_deref(),
            Some("ig-mixed.preview-1.jpg")
        );
        assert_eq!(
            manifest.tiles[1].preview_path.as_deref(),
            Some("ig-mixed.preview-2.jpg")
        );
        assert_eq!(
            manifest.tiles[2].preview_path.as_deref(),
            Some("ig-mixed.preview-3.jpg")
        );
    }

    #[test]
    fn social_preview_collects_tiles_across_all_dash_sections() {
        // A card merge (or a threaded tweet) joins sections with `\n\n---\n\n`.
        // Media in later sections must still become tiles and posters, not be
        // dropped by a first-section-only scan.
        let conn = test_conn();
        let mut block = make_block_full(
            "merged-social",
            "article",
            Some("Merged"),
            "2026-01-01T00:00:00Z",
            &[],
            "first tweet\n<!-- tweet-video -->\n![](a.mp4)\n\n---\n\n![](b.jpg)\n\n---\n\nlast tweet\n![](c.mp4)",
        );
        block.frontmatter.url = Some("https://x.com/user/status/1".to_string());
        upsert_block(&conn, &block, None).unwrap();

        let light = list_blocks_light(&conn).unwrap();
        let manifest: FeedPreviewManifest =
            serde_json::from_str(light[0].preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.kind, FeedPreviewKind::Composite);
        assert_eq!(manifest.tiles.len(), 3);
        assert_eq!(manifest.tiles[0].source_path, "a.mp4");
        assert!(manifest.tiles[0].is_video);
        assert_eq!(
            manifest.tiles[0].preview_path.as_deref(),
            Some("merged-social.preview-1.jpg")
        );
        assert_eq!(manifest.tiles[1].source_path, "b.jpg");
        assert!(!manifest.tiles[1].is_video);
        assert_eq!(
            manifest.tiles[1].preview_path.as_deref(),
            Some("merged-social.preview-2.jpg")
        );
        // Third section: the video that a first-section scan used to drop.
        assert_eq!(manifest.tiles[2].source_path, "c.mp4");
        assert!(manifest.tiles[2].is_video);
        assert_eq!(
            manifest.tiles[2].preview_path.as_deref(),
            Some("merged-social.preview-3.jpg")
        );
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
        // WebM dimensions are never extracted (no frontmatter, no probe), so
        // the frame size is unknown and the source must stream as heavy rather
        // than be buffered/decoded blind at standard cost.
        assert_eq!(playback.profile, FeedPlaybackProfile::Heavy);
    }

    #[test]
    fn list_blocks_light_serializes_feed_playback_for_dedicated_mov_video() {
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
        let playback: FeedPlaybackDescriptor =
            serde_json::from_str(light[0].feed_playback.as_deref().unwrap()).unwrap();
        assert_eq!(playback.source_path, "demo.mov");
        // QuickTime `.mov` plays natively; it maps onto the mp4-family path.
        assert_eq!(playback.container, FeedPlaybackContainer::Mp4);
        // `.mov` dimensions are not probed, so the unknown frame size forces
        // the heavy (direct-stream) profile rather than the in-memory standard.
        assert_eq!(playback.profile, FeedPlaybackProfile::Heavy);
    }

    #[test]
    fn list_blocks_light_serializes_feed_playback_for_dedicated_m4v_video() {
        let conn = test_conn();
        let mut block = make_block_full(
            "feed-video-m4v",
            "video",
            Some("Demo"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("demo.m4v".to_string());
        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "feed-video-m4v");

        let light = list_blocks_light(&conn).unwrap();
        let playback: FeedPlaybackDescriptor =
            serde_json::from_str(light[0].feed_playback.as_deref().unwrap()).unwrap();
        assert_eq!(playback.source_path, "demo.m4v");
        // `.m4v` is a plain MP4 container.
        assert_eq!(playback.container, FeedPlaybackContainer::Mp4);
        // No frontmatter dimensions and no on-disk file to probe in this test,
        // so the unknown frame size resolves to the heavy profile.
        assert_eq!(playback.profile, FeedPlaybackProfile::Heavy);
    }

    #[test]
    fn feed_autoplay_profile_unknown_dimensions_never_uses_standard() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        write_test_media(&vault, "clip.mov", 4 * 1024 * 1024);

        // Unknown frame size (e.g. a `.mov` we cannot probe) must stream as
        // heavy, never buffer/decode blind at standard cost, even when small.
        assert_eq!(
            feed_autoplay_profile_for_source(Some(vault.root()), "clip.mov", None),
            Some(FeedPlaybackProfile::Heavy)
        );
        // The same small file with known, in-limit dimensions is standard.
        assert_eq!(
            feed_autoplay_profile_for_source(Some(vault.root()), "clip.mov", SourceDimensions::new(1280, 720)),
            Some(FeedPlaybackProfile::Standard)
        );
    }

    #[test]
    fn feed_autoplay_profile_byte_ceiling_streams_large_but_drops_oversized() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());

        // Sparse files report a large logical size without writing the bytes.
        let write_sparse = |name: &str, len: u64| {
            let file = std::fs::File::create(dir.path().join(name)).unwrap();
            file.set_len(len).unwrap();
        };

        // 200 MiB with known in-limit dimensions is a valid heavy clip.
        write_sparse("big.mp4", 200 * 1024 * 1024);
        assert_eq!(
            feed_autoplay_profile_for_source(Some(vault.root()), "big.mp4", SourceDimensions::new(1920, 1080)),
            Some(FeedPlaybackProfile::Heavy)
        );

        // Beyond the 512 MiB ceiling autoplay is dropped entirely (poster only,
        // playable on demand from Detail).
        write_sparse("huge.mp4", 600 * 1024 * 1024);
        assert_eq!(
            feed_autoplay_profile_for_source(
                Some(vault.root()),
                "huge.mp4",
                SourceDimensions::new(1920, 1080)
            ),
            None
        );
    }

    #[test]
    fn extract_social_preview_tiles_skips_remote_media_without_shifting_local_tiles() {
        let dims = std::collections::HashMap::new();
        // A remote image sits between two local videos. It must be dropped as a
        // tile WITHOUT shifting the second video onto the first video's source.
        let body = "![](vid1.mp4)\n![](https://cdn.example.com/remote.jpg)\n![](vid2.mp4)";
        let media_urls =
            serde_json::to_string(&["vid1.mp4", "https://cdn.example.com/remote.jpg", "vid2.mp4"])
                .unwrap();

        let tiles = extract_social_preview_tiles(body, &dims, Some(&media_urls));

        assert_eq!(tiles.len(), 2);
        assert_eq!(tiles[0].source_path, "vid1.mp4");
        assert!(tiles[0].is_video);
        assert_eq!(tiles[0].preview_path, None);
        assert_eq!(tiles[1].source_path, "vid2.mp4");
        assert!(tiles[1].is_video);
        assert_eq!(tiles[1].preview_path, None);
    }

    #[test]
    fn extract_social_preview_tiles_resets_video_poster_marker_at_section_break() {
        let dims = std::collections::HashMap::new();
        // A tweet-video marker precedes a `---` section break with no media in
        // between: it must not leak onto the media in the next section.
        let body = "<!-- tweet-video -->\n---\n![](a.mp4)\n![](b.jpg)";
        let media_urls = serde_json::to_string(&["a.mp4", "b.jpg"]).unwrap();

        let tiles = extract_social_preview_tiles(body, &dims, Some(&media_urls));

        assert_eq!(tiles.len(), 2);
        assert_eq!(tiles[0].source_path, "a.mp4");
        assert!(!tiles[0].is_video_poster);
        assert_eq!(tiles[1].source_path, "b.jpg");
        assert!(!tiles[1].is_video_poster);
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
        // The inline clip carries no extracted dimensions, so playback streams
        // as heavy rather than buffering an unknown frame size in memory.
        assert_eq!(playback.profile, FeedPlaybackProfile::Heavy);
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
        assert_eq!(
            manifest.tiles[0].preview_path.as_deref(),
            Some("tweet-gallery.preview-1.jpg")
        );
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
    fn list_grid_blocks_breaks_saved_at_ties_by_slug() {
        let conn = test_conn();
        for slug in ["Zulu", "alpha", "Beta"] {
            upsert_block(
                &conn,
                &make_block_full(
                    slug,
                    "article",
                    Some(slug),
                    "2026-01-01T00:00:00Z",
                    &[],
                    "body",
                ),
                None,
            )
            .unwrap();
        }

        let (blocks, has_more) = list_grid_blocks(&conn, None, 0, 20).unwrap();

        assert!(!has_more);
        assert_eq!(
            blocks
                .iter()
                .map(|block| block.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "Beta", "Zulu"]
        );
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

        let full_block = get_block(&conn, "design-a").unwrap().unwrap();
        assert_eq!(full_block.thumb_format, Some(ThumbFormat::Png));
        assert!(full_block.thumb_mtime > 0);

        assert!(clear_thumb_metadata(&conn, "design-a").unwrap());
        let cleared = list_preview_blocks(&conn, 10).unwrap();
        assert!(cleared.iter().all(|item| item.slug != "design-a"));
        assert!(cleared.iter().any(|item| item.slug == "design-b"));
    }

    #[test]
    fn backfill_missing_thumb_metadata_restores_legacy_preview_rows() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();

        let conn = test_conn();
        upsert_block(&conn, &make_block("legacy-thumb", &["design"]), None).unwrap();

        let before = list_preview_blocks(&conn, 10).unwrap();
        assert!(before.iter().all(|item| item.slug != "legacy-thumb"));

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
    fn backfill_media_index_rebuilds_stale_obsidian_attachment_paths() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(vault.root().join("Журнал")).unwrap();
        std::fs::create_dir_all(vault.root().join("Медиафайлы")).unwrap();
        write_test_image(
            &vault,
            "Медиафайлы/telegram-cloud-photo-size-2-5298783204590424341-x.jpg",
            388,
            340,
        );

        let conn = test_conn();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, title, saved_at, body, first_image, media_urls, preview_manifest)
             VALUES (?1, 'article', '04.12.2025', '2025-12-04T00:00:00Z', ?2, ?3, ?4, ?5)",
            params![
                "Журнал/04.12.2025",
                "![[telegram-cloud-photo-size-2-5298783204590424341-x.jpg]]",
                "Журнал/telegram-cloud-photo-size-2-5298783204590424341-x.jpg",
                "[\"Журнал/telegram-cloud-photo-size-2-5298783204590424341-x.jpg\"]",
                "{\"kind\":\"image\",\"primary_preview_path\":\"Журнал/04.12.2025.jpg\",\"width\":null,\"height\":null,\"tiles\":[{\"source_path\":\"Журнал/telegram-cloud-photo-size-2-5298783204590424341-x.jpg\",\"preview_path\":null,\"width\":null,\"height\":null,\"is_video\":false,\"is_video_poster\":false}],\"overflow_count\":0}",
            ],
        )
        .unwrap();

        let updated = backfill_media_index(&conn, &vault).unwrap();
        assert_eq!(updated, 1);

        let (first_image, media_urls, media_dimensions, preview_manifest, media_index_version): (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
        ) = conn
            .query_row(
                "SELECT first_image, media_urls, media_dimensions, preview_manifest, media_index_version
                 FROM blocks WHERE slug = 'Журнал/04.12.2025'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(
            first_image.as_deref(),
            Some("Медиафайлы/telegram-cloud-photo-size-2-5298783204590424341-x.jpg")
        );
        assert_eq!(
            media_urls.as_deref(),
            Some("[\"Медиафайлы/telegram-cloud-photo-size-2-5298783204590424341-x.jpg\"]")
        );
        assert_eq!(
            media_dimensions.as_deref(),
            Some(
                "{\"Медиафайлы/telegram-cloud-photo-size-2-5298783204590424341-x.jpg\":[388,340]}"
            )
        );
        let manifest: FeedPreviewManifest =
            serde_json::from_str(preview_manifest.as_deref().unwrap()).unwrap();
        assert_eq!(manifest.kind, FeedPreviewKind::Image);
        assert_eq!(
            manifest.tiles[0].source_path,
            "Медиафайлы/telegram-cloud-photo-size-2-5298783204590424341-x.jpg"
        );
        assert_eq!(manifest.tiles[0].width, Some(388));
        assert_eq!(manifest.tiles[0].height, Some(340));
        assert_eq!(media_index_version, Some(MEDIA_INDEX_VERSION));
    }

    #[test]
    fn backfill_media_index_repairs_legacy_metadata_only_remote_video_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        let mut block = make_block_full(
            "design-talk-2026",
            "video",
            Some("The Future of Design Tools"),
            "2026-03-12T19:19:25Z",
            &[],
            "",
        );
        block.frontmatter.url = Some("https://youtube.com/watch?v=example1".to_string());
        upsert_block(&conn, &block, Some(vault.root())).unwrap();
        conn.execute(
            "UPDATE blocks
             SET card_kind = 'media',
                 preview_state = 'ready',
                 preview_schema_version = 1,
                 media_index_version = ?2
             WHERE slug = ?1",
            params!["design-talk-2026", MEDIA_INDEX_VERSION - 1],
        )
        .unwrap();

        assert_eq!(backfill_media_index(&conn, &vault).unwrap(), 1);

        let (card_kind, preview_state, preview_manifest, preview_schema_version, media_index_version): (
            String,
            String,
            String,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT card_kind, preview_state, preview_manifest, preview_schema_version, media_index_version
                 FROM blocks WHERE slug = 'design-talk-2026'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        let manifest: FeedPreviewManifest = serde_json::from_str(&preview_manifest).unwrap();
        assert_eq!(card_kind, "link");
        assert_eq!(preview_state, "stale");
        assert_eq!(manifest.kind, FeedPreviewKind::Text);
        assert!(manifest.primary_preview_path.is_none());
        assert!(manifest.tiles.is_empty());
        assert_eq!(preview_schema_version, PREVIEW_SCHEMA_VERSION);
        assert_eq!(media_index_version, MEDIA_INDEX_VERSION);
    }

    #[test]
    fn backfill_media_index_update_guard_skips_row_changed_after_snapshot() {
        // Isolates the `AND body_hash IS ?` guard that backfill_media_index
        // adds to its UPDATE. It models the race where a concurrent
        // full_scan/watcher reindexes the file (new body_hash + fresh derived
        // columns + version stamp) between backfill's snapshot SELECT and its
        // write: the stale write must become a no-op so the fresh row survives.
        let conn = test_conn();
        let block = make_block_full(
            "racy",
            "article",
            Some("Racy"),
            "2026-01-01T00:00:00Z",
            &[],
            "![](old.jpg)",
        );
        upsert_block(&conn, &block, None).unwrap();

        // The body_hash backfill would have captured in its snapshot.
        let snapshot_hash: Option<String> = conn
            .query_row(
                "SELECT body_hash FROM blocks WHERE slug = 'racy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(snapshot_hash.is_some());

        // A concurrent reindexer rewrites the row to newer content after the
        // snapshot was taken.
        conn.execute(
            "UPDATE blocks
             SET media_urls = 'fresh', body_hash = 'reindexed-hash', media_index_version = ?1
             WHERE slug = 'racy'",
            params![MEDIA_INDEX_VERSION],
        )
        .unwrap();

        // The guarded UPDATE carrying the STALE snapshot hash must not fire.
        let changed = conn
            .execute(
                "UPDATE blocks
                 SET media_urls = 'stale', media_index_version = ?2
                 WHERE slug = 'racy' AND body_hash IS ?1",
                params![snapshot_hash, MEDIA_INDEX_VERSION],
            )
            .unwrap();
        assert_eq!(changed, 0);

        let media_urls: Option<String> = conn
            .query_row(
                "SELECT media_urls FROM blocks WHERE slug = 'racy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(media_urls.as_deref(), Some("fresh"));

        // With the row's current hash the same guard permits the write, so a
        // non-racing backfill still updates normally.
        let changed = conn
            .execute(
                "UPDATE blocks
                 SET media_urls = 'applied'
                 WHERE slug = 'racy' AND body_hash IS 'reindexed-hash'",
                [],
            )
            .unwrap();
        assert_eq!(changed, 1);
    }

    #[test]
    fn backfill_collection_index_rebuilds_memberships_from_mine_collections_only() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        std::fs::write(
            vault.block_path("Obsidian Tags"),
            "---\ntags: \"design typography\"\n---\nBody",
        )
        .unwrap();
        std::fs::write(
            vault.block_path("Mine Collections"),
            "---\ntags:\n  - design\nMine Collections:\n  - \"[[Design]]\"\n  - \"[[Типография]]\"\n---\nBody",
        )
        .unwrap();

        let conn = test_conn();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, title, saved_at, body)
             VALUES ('Obsidian Tags', 'article', 'Obsidian Tags', '2026-01-01T00:00:00Z', 'Body')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, title, saved_at, body)
             VALUES ('Mine Collections', 'article', 'Mine Collections', '2026-01-01T00:00:00Z', 'Body')",
            [],
        )
        .unwrap();
        let obsidian_id: i64 = conn
            .query_row(
                "SELECT id FROM blocks WHERE slug = 'Obsidian Tags'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mine_id: i64 = conn
            .query_row(
                "SELECT id FROM blocks WHERE slug = 'Mine Collections'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        for tag in ["design", "typography"] {
            conn.execute(
                "INSERT INTO block_tags (block_id, tag) VALUES (?1, ?2)",
                params![obsidian_id, tag],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO block_tags (block_id, tag) VALUES (?1, 'design')",
            [mine_id],
        )
        .unwrap();

        let updated = backfill_collection_index(&conn, &vault).unwrap();
        assert_eq!(updated, 2);
        assert!(get_tags_for_block(&conn, obsidian_id).unwrap().is_empty());
        assert_eq!(
            get_tags_for_block(&conn, mine_id).unwrap(),
            vec!["Design", "Типография"]
        );
        assert_eq!(backfill_collection_index(&conn, &vault).unwrap(), 0);
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
    fn backfill_missing_preview_text_restores_legacy_rows() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        let path = vault.block_path("Gaming Platform/Встречи/12.04.2026 Встреча с Владом");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "## Мои задачи\n\n- [ ] Создать **plan.md** проекта").unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, title, saved_at, body)
             VALUES (?1, 'article', ?1, '2026-01-01T00:00:00Z', ?2)",
            params![
                "Gaming Platform/Встречи/12.04.2026 Встреча с Владом",
                "## Мои задачи\n\n- [ ] Создать **plan.md** проекта"
            ],
        )
        .unwrap();

        let updated = backfill_missing_preview_text(&conn, &vault).unwrap();
        assert_eq!(updated, 1);

        let (title, display_title, fallback_label, preview_text, preview_text_cap): (Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>) =
            conn.query_row(
                "SELECT title, display_title, fallback_label, preview_text, preview_text_cap FROM blocks WHERE slug = ?1",
                ["Gaming Platform/Встречи/12.04.2026 Встреча с Владом"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert!(title.is_none());
        assert!(display_title.is_none());
        assert_eq!(
            fallback_label.as_deref(),
            Some("12.04.2026 Встреча с Владом")
        );
        assert_eq!(
            preview_text.as_deref(),
            Some("Мои задачи Создать plan.md проекта")
        );
        assert_eq!(
            preview_text_cap,
            Some(FEED_PREVIEW_TEXT_BUFFER_CHARS as i64)
        );
    }

    #[test]
    fn backfill_missing_preview_text_rebuilds_older_short_cap() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        let body = format!(
            "## Notes\n\n{}",
            (0..180)
                .map(|i| format!("word{i}"))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let old_preview = build_preview_text(&body, 220);
        conn.execute(
            "INSERT INTO blocks (slug, block_type, title, saved_at, body, preview_text, preview_text_cap)
             VALUES ('notes', 'article', 'Notes', '2026-01-01T00:00:00Z', ?1, ?2, 220)",
            params![body, old_preview],
        )
        .unwrap();

        let updated = backfill_missing_preview_text(&conn, &vault).unwrap();
        assert_eq!(updated, 1);

        let (preview_text, preview_text_cap): (String, i64) = conn
            .query_row(
                "SELECT preview_text, preview_text_cap FROM blocks WHERE slug = 'notes'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(preview_text.chars().count() > old_preview.chars().count());
        assert!(preview_text.chars().count() <= FEED_PREVIEW_TEXT_BUFFER_CHARS);
        assert_eq!(preview_text_cap, FEED_PREVIEW_TEXT_BUFFER_CHARS as i64);
    }

    #[test]
    fn backfill_missing_preview_text_skips_empty_legacy_slug() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, saved_at, body)
             VALUES ('', 'article', '2026-01-01T00:00:00Z', '# Empty')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO blocks (slug, block_type, saved_at, body)
             VALUES ('valid', 'article', '2026-01-01T00:00:00Z', '# Valid')",
            [],
        )
        .unwrap();

        let updated = backfill_missing_preview_text(&conn, &vault).unwrap();

        let empty_preview: Option<String> = conn
            .query_row(
                "SELECT preview_text FROM blocks WHERE slug = ''",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let valid_preview: Option<String> = conn
            .query_row(
                "SELECT preview_text FROM blocks WHERE slug = 'valid'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(updated, 1);
        assert!(empty_preview.is_none());
        assert_eq!(valid_preview.as_deref(), Some(""));
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
        // The inline clip has no extracted dimensions, so the restored
        // descriptor streams as heavy rather than buffering an unknown frame
        // size in memory.
        assert_eq!(playback.profile, FeedPlaybackProfile::Heavy);
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

    /// Classify a dedicated video of `size_bytes` with in-limits dimensions, so
    /// only the byte budget decides between the standard and heavy profiles.
    fn profile_for_video_of_size(size_bytes: usize) -> Option<FeedPlaybackProfile> {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("clip.mp4"), vec![0u8; size_bytes]).unwrap();
        feed_autoplay_profile_for_source(Some(dir.path()), "clip.mp4", SourceDimensions::new(1280, 720))
    }

    #[test]
    fn feed_playback_profile_is_standard_at_byte_budget_boundary() {
        assert_eq!(
            profile_for_video_of_size(24 * 1024 * 1024),
            Some(FeedPlaybackProfile::Standard),
        );
    }

    #[test]
    fn video_whose_contents_are_in_icloud_never_autoplays() {
        let dir = tempfile::tempdir().unwrap();
        // An evicted file only exists inside the iCloud container, and the
        // vault has to be there too for the situation to be real.
        let root = dir.path().join("Mobile Documents/com~apple~CloudDocs/Mine");
        std::fs::create_dir_all(&root).unwrap();
        let clip = root.join("clip.mp4");
        std::fs::write(&clip, vec![0u8; 1024]).unwrap();

        // Present and playable while its contents are on disk.
        assert_eq!(
            feed_autoplay_profile_for_source(
                Some(&root),
                "clip.mp4",
                SourceDimensions::new(1280, 720)
            ),
            Some(FeedPlaybackProfile::Standard)
        );

        // A sparse file has an evicted file's signature: full logical size, no
        // allocated blocks. iCloud has no partial materialization, so a
        // <video src> would pull the whole clip down just to scroll past it.
        std::fs::remove_file(&clip).unwrap();
        let file = std::fs::File::create(&clip).unwrap();
        file.set_len(8 * 1024 * 1024).unwrap();
        drop(file);

        assert_eq!(
            feed_autoplay_profile_for_source(
                Some(&root),
                "clip.mp4",
                SourceDimensions::new(1280, 720)
            ),
            None,
            "offloaded contents must fall back to a poster instead of autoplaying"
        );
    }

    #[test]
    fn a_sparse_file_outside_icloud_is_not_treated_as_offloaded() {
        let dir = tempfile::tempdir().unwrap();
        let clip = dir.path().join("big.mp4");
        let file = std::fs::File::create(&clip).unwrap();
        file.set_len(200 * 1024 * 1024).unwrap();
        drop(file);

        // Same on-disk signature as an evicted file, but nothing here is
        // managed by iCloud — treating it as offloaded would silently remove
        // autoplay from ordinary local video.
        assert_eq!(
            feed_autoplay_profile_for_source(
                Some(dir.path()),
                "big.mp4",
                SourceDimensions::new(1920, 1080)
            ),
            Some(FeedPlaybackProfile::Heavy)
        );
    }

    #[test]
    fn feed_playback_profile_is_heavy_one_byte_over_budget() {
        assert_eq!(
            profile_for_video_of_size(24 * 1024 * 1024 + 1),
            Some(FeedPlaybackProfile::Heavy),
        );
    }

    #[test]
    fn feed_playback_profile_is_heavy_for_oversized_but_decodable_video() {
        // 65 MiB used to be hard-cut to None; it is now a playable heavy source.
        assert_eq!(
            profile_for_video_of_size(65 * 1024 * 1024),
            Some(FeedPlaybackProfile::Heavy),
        );
    }

    #[test]
    fn feed_playback_profile_is_none_for_pixel_excessive_video() {
        // Pixel hard caps survive the byte-cap removal: a 6000px source that a
        // decoder cannot handle stays disqualified regardless of file size.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("clip.mp4"), vec![0u8; 1024]).unwrap();
        assert_eq!(
            feed_autoplay_profile_for_source(Some(dir.path()), "clip.mp4", SourceDimensions::new(6000, 6000)),
            None,
        );
    }

    #[test]
    fn backfill_missing_feed_playback_clears_descriptor_for_evicted_source() {
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::domain::vault::VaultLayout::new(dir.path().to_path_buf());
        let conn = test_conn();
        let mut block = make_block_full(
            "evicted-video",
            "video",
            Some("Clip"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("gone.mp4".to_string());
        block.frontmatter.width = Some(1280);
        block.frontmatter.height = Some(720);
        // Derive without a vault root so a descriptor is stored from dimensions
        // alone, without the file existing on disk.
        upsert_block(&conn, &block, None).unwrap();
        sync_test_jpeg_thumb(&conn, "evicted-video");

        let before = list_blocks_light(&conn).unwrap();
        assert!(before[0].feed_playback.is_some());

        // The source never materializes in the vault: stat() fails, so the
        // descriptor is dropped rather than downgraded to a heavy profile.
        assert_eq!(backfill_missing_feed_playback(&conn, &vault).unwrap(), 1);

        let after = list_blocks_light(&conn).unwrap();
        assert_eq!(after[0].feed_playback, None);
    }

    // ── vault_conflicts ─────────────────────────────────────────────────

    #[test]
    fn vault_conflict_exists_tracks_exact_pair() {
        let conn = test_conn();
        record_vault_conflict(&conn, "note", "note-conflicted").unwrap();

        assert!(vault_conflict_exists(&conn, "note", "note-conflicted").unwrap());
        assert!(!vault_conflict_exists(&conn, "note", "other-conflicted").unwrap());

        clear_vault_conflict(&conn, "note", "note-conflicted").unwrap();
        assert!(!vault_conflict_exists(&conn, "note", "note-conflicted").unwrap());
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
        let block = media_test_block(body);
        let json = extract_media_urls(&block, None).unwrap();
        assert_eq!(json, "[\"Title (image 1).jpg\",\"Other (video 1).mp4\"]");
    }

    #[test]
    fn extract_first_image_decodes_local_filename() {
        let body = "prelude\n\n![alt](Title%20%28image%201%29.jpg)\n\nend";
        let block = media_test_block(body);
        assert_eq!(
            extract_first_image(&block, None),
            Some("Title (image 1).jpg".to_string())
        );
    }

    #[test]
    fn extract_media_urls_preserves_remote_encoded_urls() {
        let body = "![](https://cdn.example.com/path%20with%20space.jpg)";
        let block = media_test_block(body);
        let json = extract_media_urls(&block, None).unwrap();
        assert_eq!(
            json,
            "[\"https://cdn.example.com/path%20with%20space.jpg\"]"
        );
    }

    // ── Wikilink syntax parsing (18.H.1) ────────────────────────────────

    #[test]
    fn extract_media_urls_reads_wikilink() {
        let body = "intro\n\n![[Title (image 1).jpg]]\n\nmore text";
        let block = media_test_block(body);
        let json = extract_media_urls(&block, None).unwrap();
        assert_eq!(json, "[\"Title (image 1).jpg\"]");
    }

    #[test]
    fn extract_media_urls_resolves_obsidian_wikilink_attachment_by_basename() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(vault.root().join("Библиотека/images/images")).unwrap();
        std::fs::write(vault.root().join("Библиотека/images/images/01.jpg"), b"img").unwrap();
        let block = make_block_full(
            "Библиотека/Азбука",
            "article",
            None,
            "2026-01-15T12:00:00Z",
            &[],
            "![[01.jpg]]",
        );

        let json = extract_media_urls(&block, Some(vault.root())).unwrap();

        assert_eq!(json, "[\"Библиотека/images/images/01.jpg\"]");
    }

    #[test]
    fn extract_media_urls_reads_wikilink_with_alt() {
        let body = "![[Title (image 1).jpg|a caption]]";
        let block = media_test_block(body);
        let json = extract_media_urls(&block, None).unwrap();
        assert_eq!(json, "[\"Title (image 1).jpg\"]");
    }

    #[test]
    fn extract_media_urls_reads_mixed_wikilink_and_markdown() {
        // Both syntaxes in one body; order preserved.
        let body = "![[Note (image 1).png]]\n\ncontext\n\n\
                    ![](https://cdn.example.com/remote.jpg)\n\n\
                    ![[Other (video 1).mp4]]";
        let block = media_test_block(body);
        let json = extract_media_urls(&block, None).unwrap();
        assert_eq!(
            json,
            "[\"Note (image 1).png\",\"https://cdn.example.com/remote.jpg\",\"Other (video 1).mp4\"]"
        );
    }

    #[test]
    fn extract_first_image_picks_wikilink_when_first() {
        let body = "![[First (image 1).jpg]]\n\n![](later.png)";
        let block = media_test_block(body);
        assert_eq!(
            extract_first_image(&block, None),
            Some("First (image 1).jpg".to_string())
        );
    }

    #[test]
    fn extract_first_image_picks_markdown_when_first() {
        let body = "![alt](early.png)\n\n![[Later (image 1).jpg]]";
        let block = media_test_block(body);
        assert_eq!(
            extract_first_image(&block, None),
            Some("early.png".to_string())
        );
    }

    #[test]
    fn extract_ignores_malformed_wikilink_without_closing() {
        let body = "![[Unclosed wikilink";
        let block = media_test_block(body);
        assert_eq!(extract_media_urls(&block, None), None);
    }

    #[test]
    fn extract_ignores_empty_wikilink() {
        let body = "![[]] and ![[  ]]";
        let block = media_test_block(body);
        assert_eq!(extract_media_urls(&block, None), None);
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
        let ch = Channel::new("design", dt).unwrap();
        let id = upsert_channel(&conn, &ch).unwrap();
        assert!(id > 0);

        let channels = list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].tag, "design");
    }

    #[test]
    fn upsert_channel_updates_existing() {
        let conn = test_conn();
        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let ch1 = Channel::new("design", dt.clone()).unwrap();
        upsert_channel(&conn, &ch1).unwrap();

        let mut ch2 = Channel::new("design", dt).unwrap();
        ch2.position = 5;
        upsert_channel(&conn, &ch2).unwrap();

        let channels = list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].position, 5);
    }

    #[test]
    fn list_channels_preserves_distinct_human_collection_refs() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO channels (tag, title, description, color, icon, position, created_at)
             VALUES (?1, ?2, NULL, NULL, NULL, ?3, ?4)",
            params!["Красивый веб", "Human", 0i64, "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (tag, title, description, color, icon, position, created_at)
             VALUES (?1, ?2, NULL, NULL, NULL, ?3, ?4)",
            params!["красивый-веб", "Kebab", 5i64, "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        let channels = list_channels(&conn).unwrap();
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].tag, "Красивый веб");
        assert_eq!(channels[1].tag, "красивый-веб");
    }

    #[test]
    fn upsert_channel_from_block_preserves_filename_collection_ref() {
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
        assert_eq!(channels[0].tag, "Красивый веб");
        assert_eq!(channels[0].position, 3);

        let human_ref_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM channels WHERE tag = ?1",
                ["Красивый веб"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(human_ref_count, 1);
    }

    #[test]
    fn remove_channel_existing() {
        let conn = test_conn();
        let dt = DateTime::new("2026-01-01T00:00:00Z").unwrap();
        let ch = Channel::new("design", dt).unwrap();
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

        let mut ch_b = Channel::new("beta", dt.clone()).unwrap();
        ch_b.position = 2;
        upsert_channel(&conn, &ch_b).unwrap();

        let mut ch_a = Channel::new("alpha", dt.clone()).unwrap();
        ch_a.position = 1;
        upsert_channel(&conn, &ch_a).unwrap();

        let mut ch_c = Channel::new("gamma", dt).unwrap();
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
        let mut ch_a = Channel::new("alpha", dt.clone()).unwrap();
        ch_a.position = 4;
        upsert_channel(&conn, &ch_a).unwrap();

        let mut ch_b = Channel::new("beta", dt).unwrap();
        ch_b.position = 9;
        upsert_channel(&conn, &ch_b).unwrap();

        assert_eq!(next_channel_position(&conn).unwrap(), 10);
    }
}
