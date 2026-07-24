// Block: the core data type of Mine.
//
// A block represents a single piece of content saved by the user.
// On disk, it is a `.md` file with YAML frontmatter + an optional media file.
//
// This module contains pure business logic: types, parsing, validation.
// No dependencies on Tauri, SQLite, or filesystem.
//
// Contract: SPEC_BLOCK.md

use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_yaml::Value;
use thiserror::Error;

use crate::domain::collection::{
    collection_ref_from_canonical_value, collection_wikilink_value, MINE_COLLECTIONS_FIELD,
};

const FRONTMATTER_SCAN_LIMIT_LINES: usize = 20;
const MINE_RELATED_NOTES_FIELD: &str = "Mine Related Notes";
const MINE_SOURCE_MEDIA_FIELD: &str = "Mine Source Media";
const MAX_FILENAME_STEM_CHARS: usize = 100;
const MAX_FILENAME_STEM_NFD_BYTES: usize = 220;

/// Indexed feed preview buffer, not the final visual clamp.
///
/// The frontend currently shows up to 8 article-preview lines without media.
/// At the widest one-column card (~512 CSS px, ~478 px inner text width), a
/// conservative 5 px average glyph width yields ~765 chars. Keep the indexed
/// buffer near that derived upper bound so the frontend, not SQLite payload
/// truncation, decides the final visible cutoff.
pub const FEED_PREVIEW_TEXT_BUFFER_CHARS: usize = 768;

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum BlockError {
    /// Frontmatter is empty (only whitespace or nothing between --- markers).
    #[error("empty frontmatter: no content between --- markers")]
    EmptyFrontmatter,

    /// Invalid YAML syntax.
    #[error("invalid YAML: {source}")]
    YamlParse {
        #[from]
        source: serde_yaml::Error,
    },

    /// A required field is missing from frontmatter.
    #[error("missing required field: {field}")]
    MissingRequiredField { field: &'static str },

    /// The `type` field has an unrecognized value.
    #[error("invalid block type: \"{value}\"")]
    InvalidBlockType { value: String },

    /// The `saved_at` field is not a valid ISO 8601 date/time.
    #[error("invalid date/time: \"{value}\"")]
    InvalidDateTime { value: String },

    /// A tag value is not a string (e.g. tags is a scalar instead of a list).
    #[error("invalid tag value: expected array of strings")]
    InvalidTagValue,

    /// No `---` markers found in the file content.
    #[error("no frontmatter markers (---) found")]
    NoFrontmatter,

    /// Only an opening `---` marker found, no closing one.
    #[error("unclosed frontmatter: missing closing ---")]
    UnclosedFrontmatter,

    /// The slug (file name without extension) is empty.
    #[error("empty slug")]
    EmptySlug,
}

// ─── Types ──────────────────────────────────────────────────────────────────

/// The type of content a block represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum BlockType {
    Image,
    Article,
    Link,
    Video,
    File,
    Channel,
}

impl BlockType {
    /// Parse a string into a BlockType.
    /// Accepts: "image", "article", "link", "video", "file".
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Result<Self, BlockError> {
        match s {
            "image" => Ok(Self::Image),
            "article" => Ok(Self::Article),
            "link" => Ok(Self::Link),
            "video" => Ok(Self::Video),
            "file" => Ok(Self::File),
            "channel" => Ok(Self::Channel),
            other => Err(BlockError::InvalidBlockType {
                value: other.to_string(),
            }),
        }
    }

    /// Return the canonical string representation.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Article => "article",
            Self::Link => "link",
            Self::Video => "video",
            Self::File => "file",
            Self::Channel => "channel",
        }
    }
}

/// Runtime card category derived from the Markdown document shape.
///
/// `type` remains legacy source metadata in frontmatter. Feed/detail rendering
/// should use this derived category instead. Body shape remains primary, while
/// ownership metadata distinguishes bodyless media from metadata-only links.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CardKind {
    Article,
    Media,
    Link,
    Channel,
}

impl CardKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Article => "article",
            Self::Media => "media",
            Self::Link => "link",
            Self::Channel => "channel",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "article" => Some(Self::Article),
            "media" => Some(Self::Media),
            "link" => Some(Self::Link),
            "channel" => Some(Self::Channel),
            _ => None,
        }
    }
}

/// An ISO 8601 date/time string, validated on construction.
///
/// Accepted formats:
/// - `2026-02-26T14:30:00Z`
/// - `2026-02-26T14:30:00+03:00`
/// - `2026-02-26` (date only)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateTime(String);

impl DateTime {
    /// Create a new DateTime, validating the format.
    pub fn new(value: &str) -> Result<Self, BlockError> {
        if validate_iso8601(value) {
            Ok(Self(value.to_string()))
        } else {
            Err(BlockError::InvalidDateTime {
                value: value.to_string(),
            })
        }
    }

    /// Return the inner string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Parsed YAML frontmatter from a `.md` block file.
#[derive(Debug, Clone, PartialEq)]
pub struct Frontmatter {
    pub block_type: BlockType,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub file: Option<String>,
    pub thumbnail: Option<String>,
    pub tags: Vec<String>,
    pub related_notes: Vec<String>,
    pub source_media: Option<String>,
    pub saved_at: DateTime,
    pub source: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub author: Option<String>,
    // Channel-specific fields
    pub position: Option<u32>,
    pub color: Option<String>,
    pub icon: Option<String>,
}

/// A complete block: frontmatter + body + file identity.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    /// The `.md` file name without extension (e.g. "sunset-tokyo").
    pub slug: String,
    /// Parsed frontmatter.
    pub frontmatter: Frontmatter,
    /// Body text after the frontmatter. May be empty.
    pub body: String,
}

/// Compatibility metadata returned by the permissive Markdown parser.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMarkdownBlock {
    pub block: Block,
    pub origin: String,
    pub index_warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedTitleFields {
    pub content_heading: Option<String>,
    pub legacy_title: Option<String>,
    pub display_title: Option<String>,
    pub fallback_label: String,
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Parse a YAML string into a Frontmatter struct.
pub fn parse_frontmatter(yaml: &str) -> Result<Frontmatter, BlockError> {
    if yaml.trim().is_empty() {
        return Err(BlockError::EmptyFrontmatter);
    }

    let value: Value = serde_yaml::from_str(yaml)?;

    // type (required)
    let type_val = value
        .get("type")
        .ok_or(BlockError::MissingRequiredField { field: "type" })?;
    let type_str =
        yaml_value_to_string(type_val).ok_or(BlockError::MissingRequiredField { field: "type" })?;
    let block_type = BlockType::from_str(&type_str)?;

    // saved_at (required)
    let saved_val = value
        .get("saved_at")
        .ok_or(BlockError::MissingRequiredField { field: "saved_at" })?;
    let saved_str = yaml_value_to_string(saved_val)
        .ok_or(BlockError::MissingRequiredField { field: "saved_at" })?;
    let saved_at = DateTime::new(&saved_str)?;

    // Optional string fields
    let title = get_opt_string(&value, "title");
    let description = get_opt_string(&value, "description");
    let url = get_opt_string(&value, "url");
    let file = get_opt_string(&value, "file").and_then(|raw| normalize_attachment_reference(&raw));
    let thumbnail = get_opt_string(&value, "thumbnail");
    let source = get_opt_string(&value, "source");
    let author = get_opt_string(&value, "author");

    // Optional numeric fields
    let width = get_opt_u64(&value, "width").map(|n| n as u32);
    let height = get_opt_u64(&value, "height").map(|n| n as u32);

    // Channel-specific fields
    let position = get_opt_u64(&value, "position").map(|n| n as u32);
    let color = get_opt_string(&value, "color");
    let icon = get_opt_string(&value, "icon");

    // Mine collections (optional, canonical `Mine Collections` wikilinks only)
    let tags = parse_collections(&value)?;
    let related_notes = parse_related_notes(&value);
    let source_media = get_opt_string(&value, MINE_SOURCE_MEDIA_FIELD);

    Ok(Frontmatter {
        block_type,
        title,
        description,
        url,
        file,
        thumbnail,
        tags,
        related_notes,
        source_media,
        saved_at,
        source,
        width,
        height,
        author,
        position,
        color,
        icon,
    })
}

/// Parse full `.md` file content into a Block.
pub fn parse_block(slug: &str, content: &str) -> Result<Block, BlockError> {
    if slug.is_empty() {
        return Err(BlockError::EmptySlug);
    }

    let mut lines = content.split('\n');

    // First line must be exactly "---"
    match lines.next() {
        Some("---") => {}
        _ => return Err(BlockError::NoFrontmatter),
    }

    // Collect YAML lines until we find the closing "---"
    let mut yaml_lines = Vec::new();
    let mut found_closing = false;
    for line in &mut lines {
        if line == "---" {
            found_closing = true;
            break;
        }
        yaml_lines.push(line);
    }

    if !found_closing {
        return Err(BlockError::UnclosedFrontmatter);
    }

    let yaml = yaml_lines.join("\n");
    let frontmatter = parse_frontmatter(&yaml)?;

    // Body is everything after the closing "---" line
    let body_lines: Vec<&str> = lines.collect();
    let body = body_lines.join("\n");

    Ok(Block {
        slug: slug.to_string(),
        frontmatter,
        body,
    })
}

/// Parse Markdown for indexing, accepting ordinary Obsidian files without
/// Mine frontmatter. This is intentionally fail-open for read paths; keep
/// `parse_block` strict for Mine-owned serialization roundtrips.
pub fn parse_markdown_document(
    slug: &str,
    content: &str,
    fallback_saved_at: DateTime,
) -> Result<ParsedMarkdownBlock, BlockError> {
    if slug.is_empty() {
        return Err(BlockError::EmptySlug);
    }

    let Some((yaml, body, has_fence)) = split_frontmatter_candidate(content) else {
        return Ok(ParsedMarkdownBlock {
            block: implicit_article_block(slug, content.to_string(), fallback_saved_at),
            origin: "foreign_markdown".to_string(),
            index_warning: None,
        });
    };

    if !has_fence {
        return Ok(ParsedMarkdownBlock {
            block: implicit_article_block(slug, content.to_string(), fallback_saved_at),
            origin: "foreign_markdown".to_string(),
            index_warning: None,
        });
    }

    match parse_frontmatter_compat(slug, yaml, fallback_saved_at.clone()) {
        Ok((frontmatter, warning)) => Ok(ParsedMarkdownBlock {
            block: Block {
                slug: slug.to_string(),
                frontmatter,
                body: body.to_string(),
            },
            origin: "partial_frontmatter".to_string(),
            index_warning: warning,
        }),
        Err(_) => Ok(ParsedMarkdownBlock {
            block: implicit_article_block(slug, content.to_string(), fallback_saved_at),
            origin: "malformed_frontmatter".to_string(),
            index_warning: Some("malformed_frontmatter".to_string()),
        }),
    }
}

pub fn derive_card_kind(block: &Block) -> CardKind {
    if block.frontmatter.block_type == BlockType::Channel {
        CardKind::Channel
    } else if !block.body.trim().is_empty() {
        CardKind::Article
    } else if block.frontmatter.file.is_some() {
        CardKind::Media
    } else if block.frontmatter.url.is_some() {
        CardKind::Link
    } else if matches!(
        block.frontmatter.block_type,
        BlockType::Image | BlockType::Video | BlockType::File
    ) {
        CardKind::Media
    } else if block.frontmatter.block_type == BlockType::Link {
        CardKind::Link
    } else {
        CardKind::Article
    }
}

/// Derive the human display fallback from a path-based slug.
///
/// Recursive vault support made `slug` a vault-relative path
/// (`Folder/Subfolder/File`), but display fallback should stay filename-first:
/// no folder prefixes unless the user explicitly put them in `title`.
pub fn fallback_title_from_slug(slug: &str) -> String {
    slug.rsplit('/').next().unwrap_or(slug).to_string()
}

pub fn derive_title_fields(
    slug: &str,
    legacy_title: Option<&str>,
    body: &str,
) -> DerivedTitleFields {
    let content_heading = extract_first_markdown_h1(body);
    let legacy_title = normalize_optional_title(legacy_title);
    let fallback_label = fallback_title_from_slug(slug);
    let display_title = content_heading.clone().or_else(|| legacy_title.clone());
    DerivedTitleFields {
        content_heading,
        legacy_title,
        display_title,
        fallback_label,
    }
}

pub fn extract_first_markdown_h1(body: &str) -> Option<String> {
    let mut in_fence = false;

    for raw_line in body.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }

        let heading = trimmed.strip_prefix("# ")?;
        let heading = trim_trailing_heading_hashes(heading);
        let heading = normalize_optional_title(Some(heading))?;
        return Some(heading);
    }

    None
}

pub fn strip_first_markdown_h1(body: &str) -> String {
    let mut out = Vec::new();
    let mut in_fence = false;
    let mut stripped = false;

    for raw_line in body.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            out.push(raw_line);
            continue;
        }

        if !in_fence && !stripped && trimmed.starts_with("# ") {
            stripped = true;
            continue;
        }

        out.push(raw_line);
    }

    let joined = out.join("\n");
    joined.trim_start_matches('\n').trim_start().to_string()
}

pub fn ensure_body_starts_with_h1(body: &str, heading: &str) -> String {
    let Some(normalized_heading) = normalize_optional_title(Some(heading)) else {
        return body.to_string();
    };

    if extract_first_markdown_h1(body).as_deref() == Some(normalized_heading.as_str()) {
        return body.to_string();
    }

    let trimmed_body = body.trim_start_matches('\n').trim_start();
    if trimmed_body.is_empty() {
        format!("# {normalized_heading}")
    } else {
        format!("# {normalized_heading}\n\n{trimmed_body}")
    }
}

/// Build a short, clean feed preview from full Markdown body text.
///
/// This is an indexed read-model value for list/grid views: strip markdown-ish
/// syntax once at indexing time, normalize whitespace, then truncate on a word
/// boundary with an ellipsis. Full article bodies remain in `blocks.body`.
pub fn build_preview_text(body: &str, max_chars: usize) -> String {
    truncate_preview_text(&markdown_to_plain_text(body), max_chars)
}

fn normalize_optional_title(title: Option<&str>) -> Option<String> {
    title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn trim_trailing_heading_hashes(heading: &str) -> &str {
    let trimmed = heading.trim_end();
    let without_hashes = trimmed.trim_end_matches('#').trim_end();
    if without_hashes.is_empty() {
        trimmed
    } else {
        without_hashes
    }
}

/// Flatten a markdown body into a single line of plain display text: drops
/// heading/list/quote prefixes, Obsidian wikilink embeds and text links,
/// markdown links/images, and inline emphasis/code markers, then collapses
/// whitespace. Single source of truth shared by preview-text indexing
/// (`build_preview_text`) and search-excerpt generation
/// (`search_engine::normalize_excerpt_text`) so both surfaces render identical
/// clean text — no `#` headings, no raw `![[name]]` wikilinks.
pub fn markdown_to_plain_text(body: &str) -> String {
    let mut parts = Vec::new();

    for raw_line in body.lines() {
        let line = strip_markdown_line_prefixes(raw_line.trim());
        let line = strip_inline_preview_markup(&line);
        let line = normalize_inline_whitespace(&line);
        if !line.is_empty() {
            parts.push(line);
        }
    }

    parts.join(" ")
}

fn strip_markdown_line_prefixes(line: &str) -> String {
    let mut s = line.trim();

    while let Some(rest) = s.strip_prefix('>') {
        s = rest.trim_start();
    }

    let hash_count = s.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hash_count) {
        let rest = &s[hash_count..];
        if rest.chars().next().is_some_and(char::is_whitespace) {
            s = rest.trim_start();
        }
    }

    if let Some(rest) = s
        .strip_prefix("- ")
        .or_else(|| s.strip_prefix("* "))
        .or_else(|| s.strip_prefix("+ "))
    {
        s = rest.trim_start();
        if let Some(after_task) = s
            .strip_prefix("[ ]")
            .or_else(|| s.strip_prefix("[x]"))
            .or_else(|| s.strip_prefix("[X]"))
        {
            s = after_task.trim_start();
        }
    } else {
        let mut digit_end = 0;
        for (idx, ch) in s.char_indices() {
            if ch.is_ascii_digit() {
                digit_end = idx + ch.len_utf8();
                continue;
            }
            break;
        }
        if digit_end > 0 {
            let rest = &s[digit_end..];
            if let Some(after_marker) = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')')) {
                if after_marker.chars().next().is_some_and(char::is_whitespace) {
                    s = after_marker.trim_start();
                }
            }
        }
    }

    if s.chars().all(|ch| ch == '-' || ch == '*' || ch == '_') && s.chars().count() >= 3 {
        return String::new();
    }

    s.to_string()
}

fn strip_inline_preview_markup(input: &str) -> String {
    let without_obsidian = replace_obsidian_links_for_preview(input);
    let without_images = remove_markdown_images_for_preview(&without_obsidian);
    let without_links = replace_markdown_links_for_preview(&without_images);
    without_links
        .chars()
        .filter(|ch| !matches!(ch, '*' | '`'))
        .collect()
}

fn replace_obsidian_links_for_preview(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;

    loop {
        let Some(start) = rest.find("[[") else {
            out.push_str(rest);
            break;
        };
        let is_embed = start > 0 && rest[..start].ends_with('!');
        if is_embed {
            out.push_str(&rest[..start - 1]);
        } else {
            out.push_str(&rest[..start]);
        }

        let after_start = &rest[start + 2..];
        let Some(end) = after_start.find("]]") else {
            out.push_str(&rest[start..]);
            break;
        };

        if !is_embed {
            let content = &after_start[..end];
            let display = content
                .rsplit_once('|')
                .map(|(_, display)| display)
                .unwrap_or(content);
            out.push_str(display);
        }
        rest = &after_start[end + 2..];
    }

    out
}

fn remove_markdown_images_for_preview(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;

    loop {
        let Some(start) = rest.find("![") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let after_start = &rest[start + 2..];
        let Some(label_end) = after_start.find("](") else {
            out.push_str(&rest[start..]);
            break;
        };
        let after_url_start = &after_start[label_end + 2..];
        let Some(url_end) = after_url_start.find(')') else {
            out.push_str(&rest[start..]);
            break;
        };
        rest = &after_url_start[url_end + 1..];
    }

    out
}

fn replace_markdown_links_for_preview(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;

    loop {
        let Some(start) = rest.find('[') else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let after_start = &rest[start + 1..];
        let Some(label_end) = after_start.find("](") else {
            out.push_str(&rest[start..]);
            break;
        };
        let label = &after_start[..label_end];
        let after_url_start = &after_start[label_end + 2..];
        let Some(url_end) = after_url_start.find(')') else {
            out.push_str(&rest[start..]);
            break;
        };
        out.push_str(label);
        rest = &after_url_start[url_end + 1..];
    }

    out
}

fn normalize_inline_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_preview_text(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }

    let char_count = text.chars().count();
    if char_count <= max_chars {
        return text.to_string();
    }

    let mut end_byte = text.len();
    for (count, (idx, _)) in text.char_indices().enumerate() {
        if count == max_chars {
            end_byte = idx;
            break;
        }
    }

    let candidate = text[..end_byte].trim_end();
    let word_cut = candidate
        .char_indices()
        .filter(|(_, ch)| ch.is_whitespace())
        .map(|(idx, _)| idx)
        .last();

    let cut = word_cut
        .filter(|idx| candidate[..*idx].chars().count() >= max_chars / 2)
        .unwrap_or(candidate.len());
    let mut truncated = candidate[..cut].trim_end().to_string();
    truncated.push('…');
    truncated
}

/// Normalize a primary attachment frontmatter value into a filesystem target.
///
/// Accepts both the legacy Mine form (`file: image.png`) and the canonical
/// Obsidian form (`file: "[[image.png]]"` or `file: "![[image.png]]"`).
/// Aliases after `|` are ignored because `file` is an attachment reference,
/// not display text.
pub fn normalize_attachment_reference(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let bracketed = trimmed
        .strip_prefix("![[")
        .and_then(|value| value.strip_suffix("]]"))
        .or_else(|| {
            trimmed
                .strip_prefix("[[")
                .and_then(|value| value.strip_suffix("]]"))
        });

    let target = bracketed.unwrap_or(trimmed);
    let target = target.split('|').next().unwrap_or(target).trim();

    if target.is_empty() {
        None
    } else if bracketed.is_some() {
        Some(target.to_string())
    } else {
        Some(normalize_local_markdown_url(target))
    }
}

pub fn canonical_attachment_wikilink(raw: &str) -> String {
    let target = normalize_attachment_reference(raw).unwrap_or_else(|| raw.trim().to_string());
    if target.contains("]]") {
        target
    } else {
        format!("[[{target}]]")
    }
}

/// Serialize a Frontmatter struct back to a YAML string.
pub fn serialize_frontmatter(frontmatter: &Frontmatter) -> String {
    let mut lines = Vec::new();

    // Field order per spec: type, title, description, url, file, thumbnail,
    // Mine Collections, Mine Related Notes, Mine Source Media, saved_at,
    // source, width, height, author.
    lines.push(format!("type: {}", frontmatter.block_type.as_str()));

    if let Some(ref v) = frontmatter.title {
        lines.push(format!("title: {}", yaml_quote(v)));
    }
    if let Some(ref v) = frontmatter.description {
        lines.push(format!("description: {}", yaml_quote(v)));
    }
    if let Some(ref v) = frontmatter.url {
        lines.push(format!("url: {}", yaml_quote(v)));
    }
    if let Some(ref v) = frontmatter.file {
        lines.push(format!(
            "file: {}",
            yaml_quote(&canonical_attachment_wikilink(v))
        ));
    }
    if let Some(ref v) = frontmatter.thumbnail {
        lines.push(format!("thumbnail: {}", yaml_quote(v)));
    }
    if !frontmatter.tags.is_empty() {
        lines.push(format!("{MINE_COLLECTIONS_FIELD}:"));
        for tag in &frontmatter.tags {
            lines.push(format!(
                "  - {}",
                yaml_quote(&collection_wikilink_value(tag))
            ));
        }
    }
    if !frontmatter.related_notes.is_empty() {
        lines.push(format!("{MINE_RELATED_NOTES_FIELD}:"));
        for note in &frontmatter.related_notes {
            lines.push(format!("  - {}", yaml_quote(&format!("[[{note}]]"))));
        }
    }
    if let Some(ref v) = frontmatter.source_media {
        lines.push(format!("{MINE_SOURCE_MEDIA_FIELD}: {}", yaml_quote(v)));
    }
    lines.push(format!("saved_at: {}", frontmatter.saved_at.as_str()));
    if let Some(ref v) = frontmatter.source {
        lines.push(format!("source: {}", yaml_quote(v)));
    }
    if let Some(v) = frontmatter.width {
        lines.push(format!("width: {}", v));
    }
    if let Some(v) = frontmatter.height {
        lines.push(format!("height: {}", v));
    }
    if let Some(ref v) = frontmatter.author {
        lines.push(format!("author: {}", yaml_quote(v)));
    }
    // Channel-specific fields
    if let Some(v) = frontmatter.position {
        lines.push(format!("position: {}", v));
    }
    if let Some(ref v) = frontmatter.color {
        lines.push(format!("color: {}", yaml_quote(v)));
    }
    if let Some(ref v) = frontmatter.icon {
        lines.push(format!("icon: {}", yaml_quote(v)));
    }

    lines.join("\n")
}

/// Collapse 3+ consecutive newlines into a single blank line.
fn normalize_blank_lines(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut newline_count = 0u32;
    for ch in s.chars() {
        if ch == '\n' {
            newline_count += 1;
            if newline_count <= 2 {
                result.push(ch);
            }
        } else {
            newline_count = 0;
            result.push(ch);
        }
    }
    result
}

/// Serialize a Block into full `.md` file content.
pub fn serialize_block(block: &Block) -> String {
    let yaml = serialize_frontmatter(&block.frontmatter);
    if block.body.is_empty() {
        format!("---\n{}\n---\n", yaml)
    } else {
        let body = normalize_blank_lines(&block.body);
        format!("---\n{}\n---\n{}", yaml, body)
    }
}

/// Extract `[[wikilinks]]` from body text.
///
/// Handles embeds (`![[...]]`), trims whitespace, deduplicates,
/// and correctly resolves nested brackets by matching each `]]`
/// with the most recent `[[`.
pub fn extract_wikilinks(body: &str) -> Vec<String> {
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let bytes = body.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i + 1 < len {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            let start = i + 2;
            let mut j = start;
            let mut real_start = start;

            while j + 1 < len {
                if bytes[j] == b'[' && bytes[j + 1] == b'[' {
                    // Nested [[ resets the match start
                    real_start = j + 2;
                    j += 2;
                } else if bytes[j] == b']' && bytes[j + 1] == b']' {
                    let content = &body[real_start..j];
                    let trimmed = content.trim();
                    if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                        results.push(trimmed.to_string());
                    }
                    i = j + 2;
                    break;
                } else {
                    j += 1;
                }
            }

            if j + 1 >= len {
                break;
            }
        } else {
            i += 1;
        }
    }

    results
}

/// Decode a local markdown URL back to its filesystem name.
///
/// Remote URLs may contain legitimate percent-encoding that must survive
/// unchanged; only local vault-relative references are decoded.
pub fn normalize_local_markdown_url(url: &str) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    percent_decode_str(url).decode_utf8_lossy().into_owned()
}

/// The concrete syntax used for an inline media reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InlineMediaSyntax {
    /// Obsidian embed syntax: `![[name]]` / `![[name|alt]]`.
    ObsidianEmbed,
    /// Standard Markdown image syntax: `![alt](path)`.
    MarkdownImage,
}

/// Inline media reference extracted from a markdown body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineMediaReference {
    pub source: String,
    pub syntax: InlineMediaSyntax,
}

/// Extract every inline media reference from a markdown body in document order,
/// preserving whether it came from an Obsidian embed or a Markdown image.
pub fn iter_inline_media_references(body: &str) -> Vec<InlineMediaReference> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < body.len() {
        let Some(rel) = body[i..].find("![") else {
            break;
        };
        let excl = i + rel;
        let after_excl = excl + 2;
        if after_excl >= body.len() {
            break;
        }

        if body[after_excl..].starts_with('[') {
            let name_start = after_excl + 1;
            let Some(close_offset) = body[name_start..].find("]]") else {
                i = name_start;
                continue;
            };
            let inner = &body[name_start..name_start + close_offset];
            let name = inner.split('|').next().unwrap_or(inner).trim();
            if !name.is_empty() {
                out.push(InlineMediaReference {
                    source: name.to_string(),
                    syntax: InlineMediaSyntax::ObsidianEmbed,
                });
            }
            i = name_start + close_offset + 2;
        } else {
            let Some(bracket_offset) = body[after_excl..].find("](") else {
                i = after_excl;
                continue;
            };
            let url_start = after_excl + bracket_offset + 2;
            let Some(paren_end) = body[url_start..].find(')') else {
                i = url_start;
                continue;
            };
            let url = &body[url_start..url_start + paren_end];
            if !url.is_empty() {
                out.push(InlineMediaReference {
                    source: normalize_local_markdown_url(url),
                    syntax: InlineMediaSyntax::MarkdownImage,
                });
            }
            i = url_start + paren_end + 1;
        }
    }
    out
}

/// Extract every inline media source from a markdown body in document order.
///
/// Supports both canonical local embeds (`![[name]]`, `![[name|alt]]`) and
/// legacy markdown image syntax (`![alt](url)`). Local markdown URLs are
/// percent-decoded back to their on-disk filenames; remote URLs are left
/// unchanged.
pub fn iter_inline_media_sources(body: &str) -> Vec<String> {
    iter_inline_media_references(body)
        .into_iter()
        .map(|reference| reference.source)
        .collect()
}

/// Compute a stable content hash of a block body.
///
/// Used by Phase 18.G watcher rename detection to match a `Remove` event
/// on the old filename with a `Create` event on the new filename: if both
/// yield the same body hash inside the debounce window, the watcher treats
/// them as a rename and preserves the DB identity (thumb cache, audio
/// position, wikilinks) instead of deleting the old row and creating a
/// new one.
///
/// The hash is computed over the raw body string (after frontmatter is
/// stripped upstream). It is stable across NFC-normalized filenames and
/// any purely cosmetic changes to the filename itself.
///
/// Returns a 16-char hex prefix of SHA-256. Collisions are astronomically
/// unlikely for text bodies; this width keeps DB rows small.
pub fn compute_body_hash(body: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(body.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

/// Generate a human-readable filesystem-safe slug from a title or URL.
///
/// Title takes precedence over URL. Unicode, spaces, parentheses and most
/// punctuation are preserved as-is. Only characters that break filesystem
/// semantics (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, NUL, control
/// characters) are stripped or replaced with a space. Whitespace runs are
/// collapsed. Leading/trailing spaces and dots are trimmed.
///
/// The result is NFC-normalized so HFS+ and APFS filesystems agree on
/// identity. Maximum length 100 characters (char count, not bytes).
/// Fallback to `Untitled` when neither input yields usable content.
pub fn suggest_slug(title: Option<&str>, url: Option<&str>) -> String {
    let raw = if let Some(title) = title.filter(|t| !t.trim().is_empty()) {
        title.to_string()
    } else if let Some(url) = url {
        url.strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))
            .unwrap_or(url)
            .to_string()
    } else {
        return "Untitled".to_string();
    };

    sanitize_for_filename(&raw)
}

// ─── Private helpers ────────────────────────────────────────────────────────

/// Quote a YAML string value if it contains characters that need escaping.
/// Uses double quotes with internal double quotes escaped as \".
fn yaml_quote(s: &str) -> String {
    // Characters/patterns that require quoting in YAML plain scalars:
    // `: ` (colon-space) — mapping separator
    // `#` — comment start
    // `[`, `]`, `{`, `}` — flow collections
    // `,` — flow separator
    // `"`, `'` — quotes at start
    // Leading/trailing whitespace
    let needs_quoting = s.contains(": ")
        || s.contains(" #")
        || s.contains('[')
        || s.contains(']')
        || s.contains('{')
        || s.contains('}')
        || s.contains(',')
        || s.contains('"')
        || s.contains('\'')
        || s.starts_with(' ')
        || s.ends_with(' ')
        || s.starts_with('#')
        || s.starts_with('&')
        || s.starts_with('*')
        || s.starts_with('!')
        || s.starts_with('|')
        || s.starts_with('>')
        || s.starts_with('%')
        || s.starts_with('@')
        || s.starts_with('`')
        || s.is_empty();

    if needs_quoting {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

/// Convert a serde_yaml Value to a String, handling tagged values.
fn yaml_value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Tagged(t) => yaml_value_to_string(&t.value),
        _ => None,
    }
}

fn get_opt_string(parent: &Value, key: &str) -> Option<String> {
    parent.get(key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Tagged(t) => yaml_value_to_string(&t.value),
        _ => None,
    })
}

fn get_opt_u64(parent: &Value, key: &str) -> Option<u64> {
    parent.get(key).and_then(|v| v.as_u64())
}

fn parse_collections(parent: &Value) -> Result<Vec<String>, BlockError> {
    let Some(tags_val) = parent.get(MINE_COLLECTIONS_FIELD) else {
        return Ok(vec![]);
    };

    let seq = tags_val.as_sequence().ok_or(BlockError::InvalidTagValue)?;

    let mut tags = Vec::with_capacity(seq.len());
    for item in seq {
        let Some(s) = item.as_str() else {
            return Err(BlockError::InvalidTagValue);
        };
        if let Some(collection_ref) = collection_ref_from_canonical_value(s) {
            if !tags.contains(&collection_ref) {
                tags.push(collection_ref);
            }
        }
    }

    Ok(tags)
}

fn parse_related_notes(parent: &Value) -> Vec<String> {
    let Some(value) = parent.get(MINE_RELATED_NOTES_FIELD) else {
        return Vec::new();
    };
    let Some(seq) = value.as_sequence() else {
        return Vec::new();
    };

    let mut notes = Vec::with_capacity(seq.len());
    for item in seq {
        let Some(raw) = item.as_str() else {
            continue;
        };
        let normalized = normalize_related_note(raw);
        if !normalized.is_empty() && !notes.contains(&normalized) {
            notes.push(normalized);
        }
    }
    notes
}

fn normalize_related_note(raw: &str) -> String {
    let trimmed = raw.trim();
    let inner = trimmed
        .strip_prefix("[[")
        .and_then(|value| value.strip_suffix("]]"))
        .unwrap_or(trimmed);
    inner.split('|').next().unwrap_or("").trim().to_string()
}

fn split_frontmatter_candidate(content: &str) -> Option<(&str, &str, bool)> {
    let mut iter = content.split_inclusive('\n');
    let first = iter.next()?;
    let first_trimmed = first.trim_end_matches(['\r', '\n']);
    if first_trimmed != "---" {
        return None;
    }

    let mut yaml_start = first.len();
    let mut cursor = first.len();
    for (idx, line) in iter.enumerate() {
        if idx >= FRONTMATTER_SCAN_LIMIT_LINES {
            break;
        }
        let line_body = line.trim_end_matches(['\r', '\n']);
        if line_body == "---" {
            let yaml = &content[yaml_start..cursor];
            let body_start = cursor + line.len();
            let body = content.get(body_start..).unwrap_or("");
            return Some((yaml, body, true));
        }
        cursor += line.len();
    }

    // Leading `---` without a bounded closing fence is treated as body
    // (Markdown horizontal rule), not an indexing error.
    yaml_start = 0;
    Some((&content[yaml_start..], "", false))
}

fn implicit_article_block(slug: &str, body: String, saved_at: DateTime) -> Block {
    Block {
        slug: slug.to_string(),
        frontmatter: Frontmatter {
            block_type: BlockType::Article,
            title: None,
            description: None,
            url: None,
            file: None,
            thumbnail: None,
            tags: Vec::new(),
            related_notes: Vec::new(),
            source_media: None,
            saved_at,
            source: None,
            width: None,
            height: None,
            author: None,
            position: None,
            color: None,
            icon: None,
        },
        body,
    }
}

fn parse_frontmatter_compat(
    _slug: &str,
    yaml: &str,
    fallback_saved_at: DateTime,
) -> Result<(Frontmatter, Option<String>), BlockError> {
    let value: Value = if yaml.trim().is_empty() {
        Value::Mapping(Default::default())
    } else {
        serde_yaml::from_str(yaml)?
    };

    let mut warning = None;

    let block_type = value
        .get("type")
        .and_then(yaml_value_to_string)
        .and_then(|raw| match BlockType::from_str(&raw) {
            Ok(bt) => Some(bt),
            Err(_) => {
                warning.get_or_insert_with(|| "unknown_type".to_string());
                None
            }
        })
        .unwrap_or(BlockType::Article);

    let saved_at = value
        .get("saved_at")
        .and_then(yaml_value_to_string)
        .and_then(|raw| match DateTime::new(&raw) {
            Ok(dt) => Some(dt),
            Err(_) => {
                warning.get_or_insert_with(|| "invalid_saved_at".to_string());
                None
            }
        })
        .unwrap_or(fallback_saved_at);

    let (tags, tag_warning) = parse_collections_compat(&value);
    if tag_warning {
        warning.get_or_insert_with(|| "unsupported_tag_shape".to_string());
    }

    Ok((
        Frontmatter {
            block_type,
            title: get_opt_string(&value, "title"),
            description: get_opt_string(&value, "description"),
            url: get_opt_string(&value, "url"),
            file: get_opt_string(&value, "file")
                .and_then(|raw| normalize_attachment_reference(&raw)),
            thumbnail: get_opt_string(&value, "thumbnail"),
            tags,
            related_notes: parse_related_notes(&value),
            source_media: get_opt_string(&value, MINE_SOURCE_MEDIA_FIELD),
            saved_at,
            source: get_opt_string(&value, "source"),
            width: get_opt_u64(&value, "width").map(|n| n as u32),
            height: get_opt_u64(&value, "height").map(|n| n as u32),
            author: get_opt_string(&value, "author"),
            position: get_opt_u64(&value, "position").map(|n| n as u32),
            color: get_opt_string(&value, "color"),
            icon: get_opt_string(&value, "icon"),
        },
        warning,
    ))
}

fn parse_collections_compat(parent: &Value) -> (Vec<String>, bool) {
    let Some(tags_val) = parent.get(MINE_COLLECTIONS_FIELD) else {
        return (Vec::new(), false);
    };

    parse_collection_value_compat(tags_val)
}

fn parse_collection_value_compat(tags_val: &Value) -> (Vec<String>, bool) {
    let mut warning = false;
    let raw_values: Vec<String> = match tags_val {
        Value::Sequence(seq) => seq
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Value::String(s) => vec![s.clone()],
        _ => {
            warning = true;
            Vec::new()
        }
    };

    let mut tags = Vec::new();
    for raw in raw_values {
        match collection_ref_from_canonical_value(&raw) {
            Some(collection_ref) if !tags.contains(&collection_ref) => tags.push(collection_ref),
            Some(_) => {}
            None => warning = true,
        }
    }

    (tags, warning)
}

/// Validate an ISO 8601 date or datetime string.
///
/// Accepted: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SSZ`, `YYYY-MM-DDTHH:MM:SS+HH:MM`.
fn validate_iso8601(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 10 {
        return false;
    }

    // Date part: YYYY-MM-DD
    if !b[0..4].iter().all(u8::is_ascii_digit)
        || b[4] != b'-'
        || !b[5..7].iter().all(u8::is_ascii_digit)
        || b[7] != b'-'
        || !b[8..10].iter().all(u8::is_ascii_digit)
    {
        return false;
    }

    let month: u32 = s[5..7].parse().unwrap_or(0);
    let day: u32 = s[8..10].parse().unwrap_or(0);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }

    // Date only
    if b.len() == 10 {
        return true;
    }

    // Must have T separator and full time: YYYY-MM-DDTHH:MM:SS (19 chars min)
    if b.len() < 19 || b[10] != b'T' {
        return false;
    }

    if !b[11..13].iter().all(u8::is_ascii_digit)
        || b[13] != b':'
        || !b[14..16].iter().all(u8::is_ascii_digit)
        || b[16] != b':'
        || !b[17..19].iter().all(u8::is_ascii_digit)
    {
        return false;
    }

    let hour: u32 = s[11..13].parse().unwrap_or(99);
    let min: u32 = s[14..16].parse().unwrap_or(99);
    let sec: u32 = s[17..19].parse().unwrap_or(99);
    if hour > 23 || min > 59 || sec > 59 {
        return false;
    }

    // UTC suffix
    if b.len() == 20 && b[19] == b'Z' {
        return true;
    }

    // Timezone offset: +HH:MM or -HH:MM
    if b.len() == 25 && (b[19] == b'+' || b[19] == b'-') {
        return b[20..22].iter().all(u8::is_ascii_digit)
            && b[22] == b':'
            && b[23..25].iter().all(u8::is_ascii_digit)
            && s[20..22].parse::<u32>().unwrap_or(99) <= 23
            && s[23..25].parse::<u32>().unwrap_or(99) <= 59;
    }

    false
}

/// Transliterate Cyrillic characters to Latin equivalents.
/// Convert an arbitrary title/url string into a filesystem-safe filename stem
/// while preserving human readability.
///
/// Behavior:
/// - NFC-normalize so filesystem variants (HFS+/APFS) agree on identity
/// - Replace filesystem-hostile characters with a space
/// - Strip control characters entirely
/// - Collapse whitespace runs
/// - Trim leading/trailing spaces and dots
/// - Cap at 100 chars and 220 NFD bytes; trim again post-truncate
/// - Fall back to "Untitled" on empty result
fn sanitize_for_filename(raw: &str) -> String {
    use unicode_normalization::UnicodeNormalization;

    let normalized: String = raw.nfc().collect();

    let mut result = String::with_capacity(normalized.len());
    let mut prev_space = false;

    for c in normalized.chars() {
        match c {
            // Filesystem-reserved on macOS (/, :) and Windows (* ? " < > |)
            // plus backslash and NUL. Replace with space to preserve word gaps.
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => {
                if !prev_space {
                    result.push(' ');
                    prev_space = true;
                }
            }
            // Whitespace first — covers \t, \n, \r which are also `is_control()`.
            c if c.is_whitespace() => {
                if !prev_space {
                    result.push(' ');
                    prev_space = true;
                }
            }
            c if c.is_control() => continue,
            c => {
                result.push(c);
                prev_space = false;
            }
        }
    }

    // Trim spaces and trailing dots (Windows rejects trailing dots/spaces).
    let trimmed = result.trim_matches(|c: char| c == ' ' || c == '.');

    let truncated = truncate_filename_stem(trimmed);

    if truncated.is_empty() {
        "Untitled".to_string()
    } else {
        truncated
    }
}

fn truncate_filename_stem(stem: &str) -> String {
    use unicode_normalization::UnicodeNormalization;

    let mut truncated = String::new();
    let mut used_nfd_bytes = 0usize;

    for c in stem.chars().take(MAX_FILENAME_STEM_CHARS) {
        let mut char_nfd_bytes = 0usize;
        let mut buf = [0u8; 4];
        for decomposed in c.encode_utf8(&mut buf).nfd() {
            char_nfd_bytes += decomposed.len_utf8();
        }

        if used_nfd_bytes + char_nfd_bytes > MAX_FILENAME_STEM_NFD_BYTES {
            break;
        }

        truncated.push(c);
        used_nfd_bytes += char_nfd_bytes;
    }

    truncated
        .trim_end_matches(|c: char| c == ' ' || c == '.')
        .to_string()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Helpers ─────────────────────────────────────────────────────────

    /// Minimal valid YAML frontmatter.
    fn minimal_yaml() -> String {
        "type: image\nsaved_at: 2026-02-26T14:30:00Z".to_string()
    }

    /// Full YAML frontmatter with all optional fields.
    fn full_yaml() -> String {
        indoc::indoc! {r#"
            type: article
            title: Test Article
            description: A test description
            url: https://example.com
            file: test.pdf
            thumbnail: test-thumb.png
            Mine Collections:
              - "[[Design]]"
              - "[[Rust]]"
            saved_at: 2026-02-26T14:30:00Z
            source: manual
            width: 1920
            height: 1080
            author: Test Author
        "#}
        .to_string()
    }

    /// Wrap YAML into a full .md file with frontmatter markers.
    fn wrap_md(yaml: &str, body: &str) -> String {
        if body.is_empty() {
            format!("---\n{}\n---\n", yaml)
        } else {
            format!("---\n{}\n---\n{}", yaml, body)
        }
    }

    fn fallback_dt() -> DateTime {
        DateTime::new("2026-04-24T00:00:00Z").unwrap()
    }

    // ── BlockType ───────────────────────────────────────────────────────

    #[test]
    fn block_type_parse_image() {
        assert_eq!(BlockType::from_str("image").unwrap(), BlockType::Image);
    }

    #[test]
    fn block_type_parse_article() {
        assert_eq!(BlockType::from_str("article").unwrap(), BlockType::Article);
    }

    #[test]
    fn block_type_parse_link() {
        assert_eq!(BlockType::from_str("link").unwrap(), BlockType::Link);
    }

    #[test]
    fn block_type_parse_video() {
        assert_eq!(BlockType::from_str("video").unwrap(), BlockType::Video);
    }

    #[test]
    fn block_type_parse_file() {
        assert_eq!(BlockType::from_str("file").unwrap(), BlockType::File);
    }

    #[test]
    fn block_type_parse_unknown() {
        let err = BlockType::from_str("unknown").unwrap_err();
        assert!(matches!(err, BlockError::InvalidBlockType { ref value } if value == "unknown"));
    }

    #[test]
    fn block_type_as_str_roundtrip() {
        let types = [
            BlockType::Image,
            BlockType::Article,
            BlockType::Link,
            BlockType::Video,
            BlockType::File,
        ];
        for bt in types {
            let s = bt.as_str();
            assert_eq!(BlockType::from_str(s).unwrap(), bt);
        }
    }

    // ── DateTime ────────────────────────────────────────────────────────

    #[test]
    fn datetime_full_utc() {
        let dt = DateTime::new("2026-02-26T14:30:00Z").unwrap();
        assert_eq!(dt.as_str(), "2026-02-26T14:30:00Z");
    }

    #[test]
    fn datetime_with_timezone() {
        let dt = DateTime::new("2026-02-26T14:30:00+03:00").unwrap();
        assert_eq!(dt.as_str(), "2026-02-26T14:30:00+03:00");
    }

    #[test]
    fn datetime_date_only() {
        // E20: saved_at date only is valid.
        let dt = DateTime::new("2026-02-26").unwrap();
        assert_eq!(dt.as_str(), "2026-02-26");
    }

    #[test]
    fn datetime_invalid() {
        let err = DateTime::new("not a date").unwrap_err();
        assert!(matches!(err, BlockError::InvalidDateTime { ref value } if value == "not a date"));
    }

    #[test]
    fn datetime_empty() {
        let err = DateTime::new("").unwrap_err();
        assert!(matches!(err, BlockError::InvalidDateTime { .. }));
    }

    // ── parse_frontmatter ───────────────────────────────────────────────

    #[test]
    fn parse_frontmatter_minimal() {
        let fm = parse_frontmatter(&minimal_yaml()).unwrap();
        assert_eq!(fm.block_type, BlockType::Image);
        assert_eq!(fm.saved_at.as_str(), "2026-02-26T14:30:00Z");
        assert!(fm.title.is_none());
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn parse_frontmatter_full() {
        let fm = parse_frontmatter(&full_yaml()).unwrap();
        assert_eq!(fm.block_type, BlockType::Article);
        assert_eq!(fm.title.as_deref(), Some("Test Article"));
        assert_eq!(fm.description.as_deref(), Some("A test description"));
        assert_eq!(fm.url.as_deref(), Some("https://example.com"));
        assert_eq!(fm.file.as_deref(), Some("test.pdf"));
        assert_eq!(fm.thumbnail.as_deref(), Some("test-thumb.png"));
        assert_eq!(fm.tags, vec!["Design", "Rust"]);
        assert_eq!(fm.saved_at.as_str(), "2026-02-26T14:30:00Z");
        assert_eq!(fm.source.as_deref(), Some("manual"));
        assert_eq!(fm.width, Some(1920));
        assert_eq!(fm.height, Some(1080));
        assert_eq!(fm.author.as_deref(), Some("Test Author"));
    }

    #[test]
    fn parse_frontmatter_normalizes_file_wikilink() {
        let yaml = indoc::indoc! {r#"
            type: image
            file: "[[Assets/photo 1.png|Photo]]"
            saved_at: 2026-02-26T14:30:00Z
        "#};
        let fm = parse_frontmatter(yaml).unwrap();
        assert_eq!(fm.file.as_deref(), Some("Assets/photo 1.png"));
    }

    #[test]
    fn parse_frontmatter_accepts_bang_file_wikilink() {
        let yaml = indoc::indoc! {r#"
            type: image
            file: "![[photo.png]]"
            saved_at: 2026-02-26T14:30:00Z
        "#};
        let fm = parse_frontmatter(yaml).unwrap();
        assert_eq!(fm.file.as_deref(), Some("photo.png"));
    }

    #[test]
    fn derive_card_kind_uses_body_presence_not_legacy_type() {
        let media = Block {
            slug: "media".to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: None,
                description: None,
                url: None,
                file: Some("photo.png".to_string()),
                thumbnail: None,
                tags: vec![],
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-02-26T14:30:00Z").unwrap(),
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
        assert_eq!(derive_card_kind(&media), CardKind::Media);

        let article = Block {
            slug: "article".to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Image,
                ..media.frontmatter.clone()
            },
            body: "![[photo.png]]".to_string(),
        };
        assert_eq!(derive_card_kind(&article), CardKind::Article);

        let link = Block {
            slug: "ai-2027".to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Link,
                url: Some("https://ai-2027.com/race".to_string()),
                file: None,
                ..media.frontmatter.clone()
            },
            body: String::new(),
        };
        assert_eq!(derive_card_kind(&link), CardKind::Link);

        let metadata_only_video = Block {
            slug: "metadata-video".to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Video,
                url: Some("https://example.com/watch".to_string()),
                file: None,
                ..media.frontmatter.clone()
            },
            body: String::new(),
        };
        assert_eq!(derive_card_kind(&metadata_only_video), CardKind::Link);

        let empty_note = Block {
            slug: "empty-note".to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                url: None,
                file: None,
                ..media.frontmatter
            },
            body: String::new(),
        };
        assert_eq!(derive_card_kind(&empty_note), CardKind::Article);
    }

    #[test]
    fn parse_markdown_document_no_frontmatter_defaults_article() {
        let parsed =
            parse_markdown_document("Plain Note", "# Heading\n\nBody", fallback_dt()).unwrap();
        assert_eq!(parsed.origin, "foreign_markdown");
        assert!(parsed.index_warning.is_none());
        assert_eq!(parsed.block.frontmatter.block_type, BlockType::Article);
        assert!(parsed.block.frontmatter.title.is_none());
        assert_eq!(parsed.block.body, "# Heading\n\nBody");
    }

    #[test]
    fn parse_markdown_document_nested_slug_title_uses_filename_leaf() {
        let parsed = parse_markdown_document(
            "Gaming Platform/Встречи/12.04.2026 Встреча с Владом",
            "## Мои задачи\n\nBody",
            fallback_dt(),
        )
        .unwrap();
        assert!(parsed.block.frontmatter.title.is_none());
    }

    #[test]
    fn derive_title_fields_prefers_body_h1_then_legacy_title_then_filename() {
        let with_h1 = derive_title_fields("Folder/Note", Some("Legacy"), "# Heading\n\nBody");
        assert_eq!(with_h1.content_heading.as_deref(), Some("Heading"));
        assert_eq!(with_h1.display_title.as_deref(), Some("Heading"));
        assert_eq!(with_h1.fallback_label, "Note");

        let legacy_only = derive_title_fields("Folder/Note", Some("Legacy"), "Body");
        assert!(legacy_only.content_heading.is_none());
        assert_eq!(legacy_only.display_title.as_deref(), Some("Legacy"));
        assert_eq!(legacy_only.fallback_label, "Note");

        let fallback_only = derive_title_fields("Folder/Note", None, "Body");
        assert!(fallback_only.content_heading.is_none());
        assert!(fallback_only.display_title.is_none());
        assert_eq!(fallback_only.fallback_label, "Note");
    }

    #[test]
    fn strip_first_markdown_h1_removes_only_the_leading_h1_line() {
        let body = "# Heading\n\nParagraph\n\n## Subheading";
        assert_eq!(strip_first_markdown_h1(body), "Paragraph\n\n## Subheading");
    }

    #[test]
    fn build_preview_text_strips_markdown_and_truncates_on_word_boundary() {
        let body = "## Мои задачи\n\n- [ ] Создать **plan.md** проекта — формализовать все договорённости и роудмап в одном документе\n- [ ] Dogfood всех сценариев: пройти полный путь игрока, разработчика, фандера и спекулянта на платформе\n![[image.jpg]]";
        let preview = build_preview_text(body, 120);
        assert_eq!(
            preview,
            "Мои задачи Создать plan.md проекта — формализовать все договорённости и роудмап в одном документе Dogfood всех…"
        );
        assert!(!preview.contains("[ ]"));
        assert!(!preview.contains("![["));
        assert!(!preview.ends_with("платфор…"));
    }

    #[test]
    fn markdown_to_plain_text_strips_article_heading_and_wikilink_embed() {
        // Mirrors a clipped article: H1 title, an inline-media wikilink whose
        // name carries dots and parens, then caption and body. Search excerpts
        // build on this output, so the raw `#` and `![[...]]` must be gone.
        let body = "# Как искусственный интеллект повлияет на рынок труда\n\n![[Как искусственный интеллект повлияет на рынок труда (image 1).webp]]\n\nSmith Collection / Gado / Getty Images\n\nАмериканский The Wall Street Journal провёл опрос.";
        let plain = markdown_to_plain_text(body);
        assert!(!plain.contains("![["));
        assert!(!plain.contains(".webp"));
        assert!(!plain.contains('#'));
        assert!(plain
            .starts_with("Как искусственный интеллект повлияет на рынок труда Smith Collection"));
        assert!(plain.contains("Американский The Wall Street Journal провёл опрос."));
    }

    #[test]
    fn parse_markdown_document_hr_at_top_without_closing_fence_is_foreign() {
        let parsed =
            parse_markdown_document("hr", "---\n\n# Header\n\nBody", fallback_dt()).unwrap();
        assert_eq!(parsed.origin, "foreign_markdown");
        assert_eq!(parsed.block.body, "---\n\n# Header\n\nBody");
    }

    #[test]
    fn parse_markdown_document_unknown_type_downgrades_to_article_with_warning() {
        let input = "---\ntype: meeting\nMine Collections: [\"[[Design/Typography]]\"]\n---\nBody";
        let parsed = parse_markdown_document("meeting-note", input, fallback_dt()).unwrap();
        assert_eq!(parsed.index_warning.as_deref(), Some("unknown_type"));
        assert_eq!(parsed.block.frontmatter.block_type, BlockType::Article);
        assert_eq!(parsed.block.frontmatter.tags, vec!["Design/Typography"]);
    }

    #[test]
    fn parse_markdown_document_invalid_saved_at_uses_fallback_with_warning() {
        let input = "---\ntype: article\nsaved_at: not-a-date\n---\nBody";
        let parsed = parse_markdown_document("bad-date", input, fallback_dt()).unwrap();
        assert_eq!(parsed.index_warning.as_deref(), Some("invalid_saved_at"));
        assert_eq!(
            parsed.block.frontmatter.saved_at.as_str(),
            "2026-04-24T00:00:00Z"
        );
    }

    #[test]
    fn parse_markdown_document_malformed_yaml_indexes_whole_file_with_warning() {
        let input = "---\ntype: article\n\tsaved_at: broken\n---\nBody";
        let parsed = parse_markdown_document("bad-yaml", input, fallback_dt()).unwrap();
        assert_eq!(parsed.origin, "malformed_frontmatter");
        assert_eq!(
            parsed.index_warning.as_deref(),
            Some("malformed_frontmatter")
        );
        assert_eq!(parsed.block.body, input);
    }

    #[test]
    fn parse_markdown_document_obsidian_tags_are_user_metadata() {
        let input = "---\ntags: \"#design typography\"\n---\nBody";
        let parsed = parse_markdown_document("tags", input, fallback_dt()).unwrap();
        assert!(parsed.block.frontmatter.tags.is_empty());
    }

    #[test]
    fn parse_markdown_document_mine_collections_are_canonical_wikilinks() {
        let input =
            "---\ntags: \"#design typography\"\nMine Collections:\n  - \"[[Аркада]]\"\n---\nBody";
        let parsed = parse_markdown_document("tags", input, fallback_dt()).unwrap();
        assert_eq!(parsed.block.frontmatter.tags, vec!["Аркада"]);
    }

    #[test]
    fn parse_markdown_document_inline_body_tag_does_not_mutate_tags() {
        let parsed = parse_markdown_document("inline", "Body #typography", fallback_dt()).unwrap();
        assert!(parsed.block.frontmatter.tags.is_empty());
        assert_eq!(parsed.block.body, "Body #typography");
    }

    #[test]
    fn parse_frontmatter_empty_string() {
        // E3: empty frontmatter.
        let err = parse_frontmatter("").unwrap_err();
        assert!(matches!(err, BlockError::EmptyFrontmatter));
    }

    #[test]
    fn parse_frontmatter_whitespace_only() {
        let err = parse_frontmatter("   \n  \n  ").unwrap_err();
        assert!(matches!(err, BlockError::EmptyFrontmatter));
    }

    #[test]
    fn parse_frontmatter_missing_type() {
        // E4
        let yaml = "saved_at: 2026-02-26T14:30:00Z";
        let err = parse_frontmatter(yaml).unwrap_err();
        assert!(matches!(
            err,
            BlockError::MissingRequiredField { field: "type" }
        ));
    }

    #[test]
    fn parse_frontmatter_invalid_type() {
        // E5
        let yaml = "type: unknown\nsaved_at: 2026-02-26T14:30:00Z";
        let err = parse_frontmatter(yaml).unwrap_err();
        assert!(matches!(err, BlockError::InvalidBlockType { ref value } if value == "unknown"));
    }

    #[test]
    fn parse_frontmatter_missing_saved_at() {
        // E6
        let yaml = "type: image";
        let err = parse_frontmatter(yaml).unwrap_err();
        assert!(matches!(
            err,
            BlockError::MissingRequiredField { field: "saved_at" }
        ));
    }

    #[test]
    fn parse_frontmatter_invalid_saved_at() {
        // E7
        let yaml = "type: image\nsaved_at: not a date";
        let err = parse_frontmatter(yaml).unwrap_err();
        assert!(matches!(err, BlockError::InvalidDateTime { .. }));
    }

    #[test]
    fn parse_frontmatter_no_tags() {
        // E8: missing tags is OK, defaults to empty vec.
        let yaml = "type: image\nsaved_at: 2026-02-26T14:30:00Z";
        let fm = parse_frontmatter(yaml).unwrap();
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn parse_frontmatter_obsidian_tags_ignored_for_collections() {
        let yaml = "type: image\nsaved_at: 2026-02-26T14:30:00Z\ntags: single-string";
        let fm = parse_frontmatter(yaml).unwrap();
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn parse_frontmatter_mine_collections_rejects_non_string_items() {
        let yaml = "type: link\nsaved_at: 2026-02-26T14:30:00Z\nMine Collections:\n  - \"[[Design]]\"\n  - 1";
        let err = parse_frontmatter(yaml).unwrap_err();
        assert!(matches!(err, BlockError::InvalidTagValue));
    }

    #[test]
    fn parse_frontmatter_mine_collections_ignores_raw_non_wikilinks() {
        let yaml = "type: link\nsaved_at: 2026-02-26T14:30:00Z\ntags:\n  - obsidian\nMine Collections:\n  - raw\n  - \"[[Mine]]\"";
        let fm = parse_frontmatter(yaml).unwrap();
        assert_eq!(fm.tags, vec!["Mine"]);
    }

    #[test]
    fn parse_frontmatter_related_notes_normalizes_wikilinks() {
        let yaml = "type: image\nsaved_at: 2026-02-26T14:30:00Z\nMine Related Notes:\n  - \"[[Source Note]]\"\n  - \"[[Aliased Note|display]]\"\n  - Raw Note\n  - 42\nMine Source Media: Source Note (image 1).jpg";
        let fm = parse_frontmatter(yaml).unwrap();
        assert_eq!(
            fm.related_notes,
            vec!["Source Note", "Aliased Note", "Raw Note"]
        );
        assert_eq!(
            fm.source_media.as_deref(),
            Some("Source Note (image 1).jpg")
        );
    }

    #[test]
    fn serialize_frontmatter_related_notes_as_wikilinks() {
        let yaml = "type: image\nsaved_at: 2026-02-26T14:30:00Z\nMine Related Notes:\n  - Source Note\nMine Source Media: source.jpg";
        let fm = parse_frontmatter(yaml).unwrap();
        let serialized = serialize_frontmatter(&fm);
        assert!(serialized.contains("Mine Related Notes:\n  - \"[[Source Note]]\""));
        assert!(serialized.contains("Mine Source Media: source.jpg"));
    }

    #[test]
    fn parse_frontmatter_unknown_fields_ignored() {
        // E10: unknown fields are silently ignored (forward compatibility).
        let yaml =
            "type: image\nsaved_at: 2026-02-26T14:30:00Z\ncustom_field: whatever\nanother: 42";
        let fm = parse_frontmatter(yaml).unwrap();
        assert_eq!(fm.block_type, BlockType::Image);
    }

    #[test]
    fn parse_frontmatter_invalid_yaml() {
        // E19: tabs used for indentation (YAML forbids tab indentation).
        let yaml = "type: image\n\tsaved_at: 2026-02-26T14:30:00Z";
        let err = parse_frontmatter(yaml).unwrap_err();
        assert!(matches!(err, BlockError::YamlParse { .. }));
    }

    #[test]
    fn parse_frontmatter_saved_at_date_only() {
        // E20
        let yaml = "type: image\nsaved_at: 2026-02-26";
        let fm = parse_frontmatter(yaml).unwrap();
        assert_eq!(fm.saved_at.as_str(), "2026-02-26");
    }

    // ── parse_block ─────────────────────────────────────────────────────

    #[test]
    fn parse_block_minimal() {
        let content = wrap_md(&minimal_yaml(), "");
        let block = parse_block("test-slug", &content).unwrap();
        assert_eq!(block.slug, "test-slug");
        assert_eq!(block.frontmatter.block_type, BlockType::Image);
        assert!(block.body.is_empty());
    }

    #[test]
    fn parse_block_with_body() {
        let content = wrap_md(&minimal_yaml(), "Hello, world!\n\nSecond paragraph.");
        let block = parse_block("my-block", &content).unwrap();
        assert_eq!(block.body, "Hello, world!\n\nSecond paragraph.");
    }

    #[test]
    fn parse_block_no_frontmatter() {
        // E1
        let err = parse_block("slug", "no dashes here").unwrap_err();
        assert!(matches!(err, BlockError::NoFrontmatter));
    }

    #[test]
    fn parse_block_unclosed_frontmatter() {
        // E2
        let err = parse_block("slug", "---\ntype: image\nno closing marker").unwrap_err();
        assert!(matches!(err, BlockError::UnclosedFrontmatter));
    }

    #[test]
    fn parse_block_empty_frontmatter() {
        // E3
        let err = parse_block("slug", "---\n---\n").unwrap_err();
        assert!(matches!(err, BlockError::EmptyFrontmatter));
    }

    #[test]
    fn parse_block_empty_slug() {
        // E18
        let content = wrap_md(&minimal_yaml(), "");
        let err = parse_block("", &content).unwrap_err();
        assert!(matches!(err, BlockError::EmptySlug));
    }

    #[test]
    fn parse_block_body_with_triple_dashes() {
        // E11: --- inside body is just text, not a frontmatter marker.
        let body = "Some text\n---\nMore text after dashes";
        let content = wrap_md(&minimal_yaml(), body);
        let block = parse_block("slug", &content).unwrap();
        assert_eq!(block.body, body);
    }

    #[test]
    fn parse_block_only_frontmatter_no_body() {
        // E17: file with only frontmatter is valid, body is empty.
        let content = format!("---\n{}\n---\n", minimal_yaml());
        let block = parse_block("slug", &content).unwrap();
        assert!(block.body.is_empty());
    }

    #[test]
    fn parse_block_unicode_body() {
        // E12: unicode in body.
        let body = "Привет, мир! 日本語テスト 🌸";
        let content = wrap_md(&minimal_yaml(), body);
        let block = parse_block("slug", &content).unwrap();
        assert_eq!(block.body, body);
    }

    // ── serialize_frontmatter ───────────────────────────────────────────

    #[test]
    fn serialize_frontmatter_minimal() {
        let fm = Frontmatter {
            block_type: BlockType::Image,
            title: None,
            description: None,
            url: None,
            file: None,
            thumbnail: None,
            tags: vec![],
            related_notes: Vec::new(),
            source_media: None,
            saved_at: DateTime::new("2026-02-26T14:30:00Z").unwrap(),
            source: None,
            width: None,
            height: None,
            author: None,
            position: None,
            color: None,
            icon: None,
        };
        let yaml = serialize_frontmatter(&fm);
        // Must contain type and saved_at.
        assert!(yaml.contains("type: image"));
        assert!(yaml.contains("saved_at: 2026-02-26T14:30:00Z"));
        // None fields must not appear.
        assert!(!yaml.contains("title:"));
        assert!(!yaml.contains("description:"));
        // Empty collections must not appear.
        assert!(!yaml.contains("tags:"));
        assert!(!yaml.contains("Mine Collections:"));
    }

    #[test]
    fn serialize_frontmatter_with_optional_fields() {
        let fm = Frontmatter {
            block_type: BlockType::Article,
            title: Some("My Title".to_string()),
            description: Some("Desc".to_string()),
            url: Some("https://example.com".to_string()),
            file: None,
            thumbnail: None,
            tags: vec!["tag1".to_string(), "tag2".to_string()],
            related_notes: Vec::new(),
            source_media: None,
            saved_at: DateTime::new("2026-02-26T14:30:00Z").unwrap(),
            source: Some("manual".to_string()),
            width: None,
            height: None,
            author: Some("Author".to_string()),
            position: None,
            color: None,
            icon: None,
        };
        let yaml = serialize_frontmatter(&fm);
        assert!(yaml.contains("type: article"));
        assert!(yaml.contains("title: My Title"));
        assert!(yaml.contains("Mine Collections:"));
        assert!(!yaml.contains("tags:"));
        assert!(yaml.contains("- \"[[tag1]]\""));
        assert!(yaml.contains("- \"[[tag2]]\""));
        assert!(yaml.contains("author: Author"));
    }

    #[test]
    fn serialize_frontmatter_writes_file_as_wikilink() {
        let fm = Frontmatter {
            block_type: BlockType::Image,
            title: None,
            description: None,
            url: None,
            file: Some("photo.png".to_string()),
            thumbnail: None,
            tags: vec![],
            related_notes: Vec::new(),
            source_media: None,
            saved_at: DateTime::new("2026-02-26T14:30:00Z").unwrap(),
            source: None,
            width: None,
            height: None,
            author: None,
            position: None,
            color: None,
            icon: None,
        };
        let yaml = serialize_frontmatter(&fm);
        assert!(yaml.contains("file: \"[[photo.png]]\""));
    }

    #[test]
    fn serialize_frontmatter_field_order() {
        let fm = Frontmatter {
            block_type: BlockType::Image,
            title: Some("T".to_string()),
            description: Some("D".to_string()),
            url: Some("U".to_string()),
            file: Some("F".to_string()),
            thumbnail: Some("TH".to_string()),
            tags: vec!["tag".to_string()],
            related_notes: vec!["Related".to_string()],
            source_media: Some("Source (image 1).jpg".to_string()),
            saved_at: DateTime::new("2026-02-26").unwrap(),
            source: Some("S".to_string()),
            width: Some(100),
            height: Some(200),
            author: Some("A".to_string()),
            position: None,
            color: None,
            icon: None,
        };
        let yaml = serialize_frontmatter(&fm);
        // Per spec: type, title, description, url, file, thumbnail,
        // Mine Collections, Mine Related Notes, Mine Source Media, saved_at,
        // source, width, height, author.
        let pos_type = yaml.find("type:").unwrap();
        let pos_title = yaml.find("title:").unwrap();
        let pos_desc = yaml.find("description:").unwrap();
        let pos_url = yaml.find("url:").unwrap();
        let pos_file = yaml.find("file:").unwrap();
        let pos_thumb = yaml.find("thumbnail:").unwrap();
        let pos_tags = yaml.find("Mine Collections:").unwrap();
        let pos_related = yaml.find("Mine Related Notes:").unwrap();
        let pos_source_media = yaml.find("Mine Source Media:").unwrap();
        let pos_saved = yaml.find("saved_at:").unwrap();
        let pos_source = yaml.find("source:").unwrap();
        let pos_width = yaml.find("width:").unwrap();
        let pos_height = yaml.find("height:").unwrap();
        let pos_author = yaml.find("author:").unwrap();

        assert!(pos_type < pos_title);
        assert!(pos_title < pos_desc);
        assert!(pos_desc < pos_url);
        assert!(pos_url < pos_file);
        assert!(pos_file < pos_thumb);
        assert!(pos_thumb < pos_tags);
        assert!(pos_tags < pos_related);
        assert!(pos_related < pos_source_media);
        assert!(pos_source_media < pos_saved);
        assert!(pos_saved < pos_source);
        assert!(pos_source < pos_width);
        assert!(pos_width < pos_height);
        assert!(pos_height < pos_author);
    }

    // ── serialize_block ─────────────────────────────────────────────────

    #[test]
    fn serialize_block_empty_body() {
        let block = Block {
            slug: "test".to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Image,
                title: None,
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: vec![],
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-02-26T14:30:00Z").unwrap(),
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
        let output = serialize_block(&block);
        assert!(output.starts_with("---\n"));
        assert!(output.contains("\n---\n"));
    }

    #[test]
    fn serialize_block_with_body() {
        let block = Block {
            slug: "test".to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: Some("Hello".to_string()),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: vec![],
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-02-26T14:30:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: "Article body here.".to_string(),
        };
        let output = serialize_block(&block);
        assert!(output.ends_with("Article body here."));
    }

    // ── Roundtrip (E16) ─────────────────────────────────────────────────

    #[test]
    fn roundtrip_minimal() {
        let content = wrap_md(&minimal_yaml(), "");
        let block = parse_block("slug", &content).unwrap();
        let serialized = serialize_block(&block);
        let reparsed = parse_block("slug", &serialized).unwrap();
        assert_eq!(block, reparsed);
    }

    #[test]
    fn roundtrip_full() {
        let content = wrap_md(&full_yaml(), "Body with **markdown** and [[wikilinks]].");
        let block = parse_block("my-article", &content).unwrap();
        let serialized = serialize_block(&block);
        let reparsed = parse_block("my-article", &serialized).unwrap();
        assert_eq!(block, reparsed);
    }

    #[test]
    fn roundtrip_with_dashes_in_body() {
        // E11: body containing --- should survive roundtrip.
        let body = "Text before\n---\nText after dashes\n---\nMore";
        let content = wrap_md(&minimal_yaml(), body);
        let block = parse_block("slug", &content).unwrap();
        let serialized = serialize_block(&block);
        let reparsed = parse_block("slug", &serialized).unwrap();
        assert_eq!(block.body, reparsed.body);
    }

    // ── extract_wikilinks ───────────────────────────────────────────────

    #[test]
    fn wikilinks_basic() {
        let result = extract_wikilinks("text [[foo]] more [[bar]]");
        assert_eq!(result, vec!["foo", "bar"]);
    }

    #[test]
    fn wikilinks_embed() {
        // ![[image.png]] is also a wikilink (embed syntax).
        let result = extract_wikilinks("![[image.png]]");
        assert_eq!(result, vec!["image.png"]);
    }

    #[test]
    fn wikilinks_empty_ignored() {
        // E14: empty wikilinks are ignored.
        let result = extract_wikilinks("[[]] [[ ]]");
        assert!(result.is_empty());
    }

    #[test]
    fn wikilinks_trimmed() {
        let result = extract_wikilinks("[[ spaces ]]");
        assert_eq!(result, vec!["spaces"]);
    }

    #[test]
    fn wikilinks_no_links() {
        let result = extract_wikilinks("no links here");
        assert!(result.is_empty());
    }

    #[test]
    fn wikilinks_dedup() {
        // E15: duplicates removed.
        let result = extract_wikilinks("[[a]] text [[a]]");
        assert_eq!(result, vec!["a"]);
    }

    #[test]
    fn wikilinks_nested_takes_inner() {
        // Per spec: nested [[foo [[bar]]]] — each [[ resets the match start,
        // so the first ]] matches the most recent [[ → result is ["bar"].
        let result = extract_wikilinks("[[foo [[bar]]]]");
        assert!(result.contains(&"bar".to_string()));
        assert!(!result.contains(&"foo [[bar".to_string()));
    }

    #[test]
    fn wikilinks_multiple_on_same_line() {
        let result = extract_wikilinks("see [[alpha]] and [[beta]] and [[gamma]]");
        assert_eq!(result.len(), 3);
        assert!(result.contains(&"alpha".to_string()));
        assert!(result.contains(&"beta".to_string()));
        assert!(result.contains(&"gamma".to_string()));
    }

    #[test]
    fn wikilinks_multiline() {
        let result = extract_wikilinks("line one [[foo]]\nline two [[bar]]");
        assert_eq!(result, vec!["foo", "bar"]);
    }

    // ── inline media parsing ───────────────────────────────────────────

    #[test]
    fn normalize_local_markdown_url_decodes_local_filename() {
        assert_eq!(
            normalize_local_markdown_url("Title%20%28image%201%29.jpg"),
            "Title (image 1).jpg"
        );
    }

    #[test]
    fn normalize_local_markdown_url_preserves_remote_url() {
        let url = "https://cdn.example.com/path%20with%20space.jpg";
        assert_eq!(normalize_local_markdown_url(url), url);
    }

    #[test]
    fn inline_media_reads_wikilink() {
        let body = "intro\n\n![[Title (image 1).jpg]]\n\nmore";
        assert_eq!(iter_inline_media_sources(body), vec!["Title (image 1).jpg"]);
    }

    #[test]
    fn inline_media_reads_wikilink_with_alt() {
        let body = "![[Title (image 1).jpg|a caption]]";
        assert_eq!(iter_inline_media_sources(body), vec!["Title (image 1).jpg"]);
    }

    #[test]
    fn inline_media_reads_mixed_wikilink_and_markdown() {
        let body = "![[Note (image 1).png]]\n\ncontext\n\n\
                    ![](https://cdn.example.com/remote.jpg)\n\n\
                    ![](Title%20%28video%201%29.mp4)";
        assert_eq!(
            iter_inline_media_sources(body),
            vec![
                "Note (image 1).png",
                "https://cdn.example.com/remote.jpg",
                "Title (video 1).mp4",
            ]
        );
    }

    #[test]
    fn inline_media_ignores_malformed_wikilink_without_closing() {
        let body = "![[Unclosed wikilink";
        assert!(iter_inline_media_sources(body).is_empty());
    }

    // ── suggest_slug ────────────────────────────────────────────────────

    #[test]
    fn slug_from_title_ascii_preserves_case_and_spaces() {
        let slug = suggest_slug(Some("Hello World"), None);
        assert_eq!(slug, "Hello World");
    }

    #[test]
    fn slug_from_title_cyrillic_preserved() {
        let slug = suggest_slug(Some("Как устроен CRDT"), None);
        assert_eq!(slug, "Как устроен CRDT");
    }

    #[test]
    fn slug_from_title_mixed_unicode() {
        let slug = suggest_slug(Some("日本語 テスト"), None);
        assert_eq!(slug, "日本語 テスト");
    }

    #[test]
    fn slug_from_url_preserves_domain_and_path() {
        let slug = suggest_slug(None, Some("https://stripe.com/blog/api"));
        // URL path separators collapse to single space.
        assert_eq!(slug, "stripe.com blog api");
    }

    #[test]
    fn slug_no_input_defaults_to_untitled() {
        let slug = suggest_slug(None, None);
        assert_eq!(slug, "Untitled");
    }

    #[test]
    fn slug_empty_title_falls_back_to_url() {
        let slug = suggest_slug(Some("   "), Some("https://example.com"));
        assert_eq!(slug, "example.com");
    }

    #[test]
    fn slug_title_takes_precedence() {
        let slug = suggest_slug(Some("My Title"), Some("https://example.com"));
        assert_eq!(slug, "My Title");
    }

    #[test]
    fn slug_truncated_to_100_chars() {
        let long_title = "a".repeat(200);
        let slug = suggest_slug(Some(&long_title), None);
        assert_eq!(slug.chars().count(), 100);
    }

    #[test]
    fn slug_truncated_to_filesystem_byte_budget_for_cjk() {
        use unicode_normalization::UnicodeNormalization;

        let long_title: String = "日".repeat(200);
        let slug = suggest_slug(Some(&long_title), None);

        assert!(slug.chars().count() < 100);
        assert!(slug.nfd().map(|c| c.len_utf8()).sum::<usize>() <= MAX_FILENAME_STEM_NFD_BYTES);
        assert!(slug.ends_with('日'));
    }

    #[test]
    fn slug_truncation_preserves_unicode_boundaries() {
        use unicode_normalization::UnicodeNormalization;

        let long_title = "到着時刻に変更しました。その他、駅名の誤植とJRの管轄が違うとのことで２箇所修正しました。"
            .repeat(20);
        let slug = suggest_slug(Some(&long_title), None);

        assert!(slug.nfd().map(|c| c.len_utf8()).sum::<usize>() <= MAX_FILENAME_STEM_NFD_BYTES);
        assert!(!slug.ends_with('\u{fffd}'));
    }

    #[test]
    fn slug_filesystem_unsafe_chars_become_spaces() {
        let slug = suggest_slug(Some("file/with:bad*chars?"), None);
        assert!(!slug.contains('/'));
        assert!(!slug.contains(':'));
        assert!(!slug.contains('*'));
        assert!(!slug.contains('?'));
        // Runs of replacements collapse into a single space.
        assert!(!slug.contains("  "));
    }

    #[test]
    fn slug_keeps_parentheses_brackets_punctuation() {
        let slug = suggest_slug(Some("Note (draft, v1)"), None);
        assert_eq!(slug, "Note (draft, v1)");
    }

    #[test]
    fn slug_trims_leading_trailing_spaces_and_dots() {
        let slug = suggest_slug(Some(". . .Hello World. . ."), None);
        assert_eq!(slug, "Hello World");
    }

    #[test]
    fn slug_collapses_whitespace_runs() {
        let slug = suggest_slug(Some("Hello     world\t\tthere"), None);
        assert_eq!(slug, "Hello world there");
    }

    #[test]
    fn slug_strips_control_characters() {
        let slug = suggest_slug(Some("Hello\x01World\x07"), None);
        assert_eq!(slug, "HelloWorld");
    }

    #[test]
    fn slug_nfc_normalizes_decomposed_cyrillic() {
        // NFD: "и" + combining breve
        let nfd_title = "\u{0438}\u{0306}ог";
        let slug = suggest_slug(Some(nfd_title), None);
        // Expected NFC: "йог"
        assert_eq!(slug, "\u{0439}ог");
    }

    // ── compute_body_hash (18.G) ────────────────────────────────────────

    #[test]
    fn body_hash_is_16_char_lowercase_hex() {
        let hash = compute_body_hash("some body");
        assert_eq!(hash.len(), 16);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(hash.chars().all(|c| !c.is_ascii_uppercase()));
    }

    #[test]
    fn body_hash_deterministic() {
        let a = compute_body_hash("Hello, world!");
        let b = compute_body_hash("Hello, world!");
        assert_eq!(a, b);
    }

    #[test]
    fn body_hash_differs_for_different_inputs() {
        let a = compute_body_hash("Hello");
        let b = compute_body_hash("Hello.");
        assert_ne!(a, b);
    }

    #[test]
    fn body_hash_empty_body_is_stable() {
        // Empty body is legitimate (e.g. link blocks) and must produce a
        // well-defined hash, not a special sentinel.
        let hash = compute_body_hash("");
        assert_eq!(hash.len(), 16);
        assert_eq!(hash, compute_body_hash(""));
    }

    #[test]
    fn body_hash_unicode_content_stable() {
        let a = compute_body_hash("Закат в Токио — прекрасный вид");
        let b = compute_body_hash("Закат в Токио — прекрасный вид");
        assert_eq!(a, b);
    }

    // ── Edge cases summary ──────────────────────────────────────────────
    // E1:  parse_block_no_frontmatter
    // E2:  parse_block_unclosed_frontmatter
    // E3:  parse_block_empty_frontmatter, parse_frontmatter_empty_string
    // E4:  parse_frontmatter_missing_type
    // E5:  parse_frontmatter_invalid_type
    // E6:  parse_frontmatter_missing_saved_at
    // E7:  parse_frontmatter_invalid_saved_at
    // E8:  parse_frontmatter_no_tags
    // E9:  parse_frontmatter_tags_scalar_not_array
    // E10: parse_frontmatter_unknown_fields_ignored
    // E11: parse_block_body_with_triple_dashes, roundtrip_with_dashes_in_body
    // E12: parse_block_unicode_body, slug_from_title_cyrillic
    // E13: slug_max_length
    // E14: wikilinks_empty_ignored
    // E15: wikilinks_dedup
    // E16: roundtrip_minimal, roundtrip_full
    // E17: parse_block_only_frontmatter_no_body
    // E18: parse_block_empty_slug
    // E19: parse_frontmatter_invalid_yaml
    // E20: parse_frontmatter_saved_at_date_only, datetime_date_only
}
