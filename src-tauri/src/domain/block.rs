// Block: the core data type of Mine.
//
// A block represents a single piece of content saved by the user.
// On disk, it is a `.md` file with YAML frontmatter + an optional media file.
//
// This module contains pure business logic: types, parsing, validation.
// No dependencies on Tauri, SQLite, or filesystem.
//
// Contract: SPEC_BLOCK.md

use serde::Serialize;
use serde_yaml::Value;
use thiserror::Error;

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
    let file = get_opt_string(&value, "file");
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

    // Tags (optional, defaults to empty vec)
    let tags = parse_tags(&value)?;

    Ok(Frontmatter {
        block_type,
        title,
        description,
        url,
        file,
        thumbnail,
        tags,
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

/// Serialize a Frontmatter struct back to a YAML string.
pub fn serialize_frontmatter(frontmatter: &Frontmatter) -> String {
    let mut lines = Vec::new();

    // Field order per spec: type, title, description, url, file, thumbnail,
    // tags, saved_at, source, width, height, author.
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
        lines.push(format!("file: {}", yaml_quote(v)));
    }
    if let Some(ref v) = frontmatter.thumbnail {
        lines.push(format!("thumbnail: {}", yaml_quote(v)));
    }
    if !frontmatter.tags.is_empty() {
        lines.push("tags:".to_string());
        for tag in &frontmatter.tags {
            lines.push(format!("  - {}", yaml_quote(tag)));
        }
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

/// Generate a URL-safe slug from a title or URL.
///
/// Title takes precedence over URL. Cyrillic is transliterated.
/// Result contains only `[a-z0-9-]`, max 80 chars, truncated at word boundary.
pub fn suggest_slug(title: Option<&str>, url: Option<&str>) -> String {
    let raw = if let Some(title) = title {
        transliterate(title)
    } else if let Some(url) = url {
        url.strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))
            .unwrap_or(url)
            .to_string()
    } else {
        return "untitled".to_string()
    };

    normalize_slug(&raw)
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

fn parse_tags(parent: &Value) -> Result<Vec<String>, BlockError> {
    let Some(tags_val) = parent.get("tags") else {
        return Ok(vec![]);
    };

    let seq = tags_val.as_sequence().ok_or(BlockError::InvalidTagValue)?;

    let mut tags = Vec::with_capacity(seq.len());
    for item in seq {
        let s = item.as_str().ok_or(BlockError::InvalidTagValue)?;
        tags.push(s.to_string());
    }

    Ok(tags)
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
fn transliterate(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        match c {
            'а' | 'А' => result.push('a'),
            'б' | 'Б' => result.push('b'),
            'в' | 'В' => result.push('v'),
            'г' | 'Г' => result.push('g'),
            'д' | 'Д' => result.push('d'),
            'е' | 'Е' => result.push('e'),
            'ё' | 'Ё' => result.push_str("yo"),
            'ж' | 'Ж' => result.push_str("zh"),
            'з' | 'З' => result.push('z'),
            'и' | 'И' => result.push('i'),
            'й' | 'Й' => result.push('y'),
            'к' | 'К' => result.push('k'),
            'л' | 'Л' => result.push('l'),
            'м' | 'М' => result.push('m'),
            'н' | 'Н' => result.push('n'),
            'о' | 'О' => result.push('o'),
            'п' | 'П' => result.push('p'),
            'р' | 'Р' => result.push('r'),
            'с' | 'С' => result.push('s'),
            'т' | 'Т' => result.push('t'),
            'у' | 'У' => result.push('u'),
            'ф' | 'Ф' => result.push('f'),
            'х' | 'Х' => result.push_str("kh"),
            'ц' | 'Ц' => result.push_str("ts"),
            'ч' | 'Ч' => result.push_str("ch"),
            'ш' | 'Ш' => result.push_str("sh"),
            'щ' | 'Щ' => result.push_str("sch"),
            'ъ' | 'Ъ' => {}
            'ы' | 'Ы' => result.push('y'),
            'ь' | 'Ь' => {}
            'э' | 'Э' => result.push('e'),
            'ю' | 'Ю' => result.push_str("yu"),
            'я' | 'Я' => result.push_str("ya"),
            other => result.push(other),
        }
    }
    result
}

/// Normalize a raw string into a valid slug: lowercase, [a-z0-9-] only,
/// collapsed dashes, trimmed, max 80 chars at word boundary.
fn normalize_slug(raw: &str) -> String {
    let lower = raw.to_lowercase();

    // Replace all non-[a-z0-9] with dashes
    let mut slug = String::with_capacity(lower.len());
    let mut prev_dash = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }

    // Trim leading/trailing dashes
    let trimmed = slug.trim_matches('-');

    // Truncate to 80 chars at word (dash) boundary
    if trimmed.len() <= 80 {
        return trimmed.to_string();
    }

    let truncated = &trimmed[..80];
    if let Some(last_dash) = truncated.rfind('-') {
        trimmed[..last_dash].to_string()
    } else {
        truncated.to_string()
    }
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
        indoc::indoc! {"
            type: article
            title: Test Article
            description: A test description
            url: https://example.com
            file: test.pdf
            thumbnail: test-thumb.png
            tags:
              - design
              - rust
            saved_at: 2026-02-26T14:30:00Z
            source: manual
            width: 1920
            height: 1080
            author: Test Author
        "}
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
        assert_eq!(fm.tags, vec!["design", "rust"]);
        assert_eq!(fm.saved_at.as_str(), "2026-02-26T14:30:00Z");
        assert_eq!(fm.source.as_deref(), Some("manual"));
        assert_eq!(fm.width, Some(1920));
        assert_eq!(fm.height, Some(1080));
        assert_eq!(fm.author.as_deref(), Some("Test Author"));
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
    fn parse_frontmatter_tags_scalar_not_array() {
        // E9: tags as a single string (not an array) is an error.
        let yaml = "type: image\nsaved_at: 2026-02-26T14:30:00Z\ntags: single-string";
        let err = parse_frontmatter(yaml).unwrap_err();
        assert!(matches!(err, BlockError::InvalidTagValue));
    }

    #[test]
    fn parse_frontmatter_unknown_fields_ignored() {
        // E10: unknown fields are silently ignored (forward compatibility).
        let yaml = "type: image\nsaved_at: 2026-02-26T14:30:00Z\ncustom_field: whatever\nanother: 42";
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
            saved_at: DateTime::new("2026-02-26T14:30:00Z").unwrap(),
            source: None,
            width: None,
            height: None,
            author: None,
        };
        let yaml = serialize_frontmatter(&fm);
        // Must contain type and saved_at.
        assert!(yaml.contains("type: image"));
        assert!(yaml.contains("saved_at: 2026-02-26T14:30:00Z"));
        // None fields must not appear.
        assert!(!yaml.contains("title:"));
        assert!(!yaml.contains("description:"));
        // Empty tags must not appear.
        assert!(!yaml.contains("tags:"));
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
            saved_at: DateTime::new("2026-02-26T14:30:00Z").unwrap(),
            source: Some("manual".to_string()),
            width: None,
            height: None,
            author: Some("Author".to_string()),
        };
        let yaml = serialize_frontmatter(&fm);
        assert!(yaml.contains("type: article"));
        assert!(yaml.contains("title: My Title"));
        assert!(yaml.contains("tags:"));
        assert!(yaml.contains("- tag1"));
        assert!(yaml.contains("- tag2"));
        assert!(yaml.contains("author: Author"));
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
            saved_at: DateTime::new("2026-02-26").unwrap(),
            source: Some("S".to_string()),
            width: Some(100),
            height: Some(200),
            author: Some("A".to_string()),
        };
        let yaml = serialize_frontmatter(&fm);
        // Per spec: type, title, description, url, file, thumbnail, tags,
        // saved_at, source, width, height, author.
        let pos_type = yaml.find("type:").unwrap();
        let pos_title = yaml.find("title:").unwrap();
        let pos_desc = yaml.find("description:").unwrap();
        let pos_url = yaml.find("url:").unwrap();
        let pos_file = yaml.find("file:").unwrap();
        let pos_thumb = yaml.find("thumbnail:").unwrap();
        let pos_tags = yaml.find("tags:").unwrap();
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
        assert!(pos_tags < pos_saved);
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
                saved_at: DateTime::new("2026-02-26T14:30:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
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
                saved_at: DateTime::new("2026-02-26T14:30:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
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

    // ── suggest_slug ────────────────────────────────────────────────────

    #[test]
    fn slug_from_title_ascii() {
        let slug = suggest_slug(Some("Hello World"), None);
        assert_eq!(slug, "hello-world");
    }

    #[test]
    fn slug_from_title_cyrillic() {
        // E12: unicode in title, slug is transliterated.
        let slug = suggest_slug(Some("Как устроен CRDT"), None);
        assert_eq!(slug, "kak-ustroen-crdt");
    }

    #[test]
    fn slug_from_url() {
        let slug = suggest_slug(None, Some("https://stripe.com/blog/api"));
        assert_eq!(slug, "stripe-com-blog-api");
    }

    #[test]
    fn slug_no_input() {
        let slug = suggest_slug(None, None);
        assert_eq!(slug, "untitled");
    }

    #[test]
    fn slug_title_takes_precedence() {
        let slug = suggest_slug(Some("My Title"), Some("https://example.com"));
        assert_eq!(slug, "my-title");
    }

    #[test]
    fn slug_max_length() {
        // E13: very long title (>200 chars) produces slug truncated to 80 chars.
        let long_title = "a ".repeat(120); // 240 chars
        let slug = suggest_slug(Some(&long_title), None);
        assert!(slug.len() <= 80);
    }

    #[test]
    fn slug_special_chars_replaced() {
        let slug = suggest_slug(Some("Hello, World! @#$% Test"), None);
        // Only [a-z0-9-] allowed.
        assert!(slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        // Multiple dashes collapsed.
        assert!(!slug.contains("--"));
    }

    #[test]
    fn slug_no_leading_trailing_dashes() {
        let slug = suggest_slug(Some("  --Hello--  "), None);
        assert!(!slug.starts_with('-'));
        assert!(!slug.ends_with('-'));
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
