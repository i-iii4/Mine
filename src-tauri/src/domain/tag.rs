// Tag: category label for blocks.
//
// Tags are Unicode-aware lowercase kebab-case strings.
// Unlike slugs (ASCII-only), tags support any Unicode script.
// Normalization: trim, lowercase, spaces/underscores to hyphens, collapse.
//
// Contract: SPEC_DOMAIN.md#domain/tag

use thiserror::Error;

const MAX_TAG_LENGTH: usize = 60;

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TagError {
    #[error("tag is empty")]
    Empty,

    #[error("tag too long: {len} chars (max {MAX_TAG_LENGTH})")]
    TooLong { len: usize },
}

// ─── Types ──────────────────────────────────────────────────────────────────

/// A validated, normalized tag string.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Tag(String);

impl Tag {
    /// Create a new tag from raw input: normalize and validate.
    pub fn new(raw: &str) -> Result<Self, TagError> {
        let normalized = normalize_tag(raw);
        if normalized.is_empty() {
            return Err(TagError::Empty);
        }
        if normalized.len() > MAX_TAG_LENGTH {
            return Err(TagError::TooLong {
                len: normalized.len(),
            });
        }
        Ok(Self(normalized))
    }

    /// Return the normalized tag string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Normalize a raw string into a tag: lowercase, kebab-case, trimmed.
/// Does NOT validate length or emptiness.
pub fn normalize_tag(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();

    let mut result = String::with_capacity(lower.len());
    let mut prev_dash = false;

    for c in lower.chars() {
        if c.is_alphanumeric() || c == '/' {
            result.push(c);
            prev_dash = false;
        } else if (c == '-' || c == ' ' || c == '_') && !prev_dash && !result.is_empty() {
            result.push('-');
            prev_dash = true;
        }
        // Other characters are silently dropped
    }

    // Trim trailing dash
    if result.ends_with('-') {
        result.pop();
    }

    result
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── normalize_tag ───────────────────────────────────────────────────

    #[test]
    fn normalize_ascii_with_spaces() {
        // T4
        assert_eq!(normalize_tag("Web Design"), "web-design");
    }

    #[test]
    fn normalize_cyrillic() {
        // T5: unicode preserved, not transliterated
        assert_eq!(normalize_tag("ВЕРСТКА"), "верстка");
    }

    #[test]
    fn normalize_already_valid() {
        // T7
        assert_eq!(normalize_tag("already-valid"), "already-valid");
    }

    #[test]
    fn normalize_trim_whitespace() {
        assert_eq!(normalize_tag("  hello  "), "hello");
    }

    #[test]
    fn normalize_underscores() {
        assert_eq!(normalize_tag("distributed_systems"), "distributed-systems");
    }

    #[test]
    fn normalize_obsidian_nested_tag_preserves_slash() {
        assert_eq!(normalize_tag("Design/Typography"), "design/typography");
    }

    #[test]
    fn normalize_multiple_spaces() {
        // T8
        assert_eq!(normalize_tag("  multiple   spaces  "), "multiple-spaces");
    }

    #[test]
    fn normalize_dashes_only() {
        assert_eq!(normalize_tag("---"), "");
    }

    #[test]
    fn normalize_dashes_around() {
        assert_eq!(normalize_tag("---foo---"), "foo");
    }

    #[test]
    fn normalize_mixed_unicode() {
        assert_eq!(normalize_tag("UI дизайн 2026"), "ui-дизайн-2026");
    }

    #[test]
    fn normalize_empty() {
        assert_eq!(normalize_tag(""), "");
    }

    // ── Tag::new ────────────────────────────────────────────────────────

    #[test]
    fn tag_new_valid() {
        let tag = Tag::new("Web Design").unwrap();
        assert_eq!(tag.as_str(), "web-design");
    }

    #[test]
    fn tag_new_empty() {
        // T1
        assert_eq!(Tag::new(""), Err(TagError::Empty));
    }

    #[test]
    fn tag_new_whitespace() {
        // T2
        assert_eq!(Tag::new("   "), Err(TagError::Empty));
    }

    #[test]
    fn tag_new_dashes_only() {
        // T3
        assert_eq!(Tag::new("---"), Err(TagError::Empty));
    }

    #[test]
    fn tag_new_too_long() {
        // T6: 100 chars after normalization
        let long = "a".repeat(100);
        let err = Tag::new(&long).unwrap_err();
        assert!(matches!(err, TagError::TooLong { len: 100 }));
    }

    #[test]
    fn tag_new_cyrillic() {
        let tag = Tag::new("Верстка").unwrap();
        assert_eq!(tag.as_str(), "верстка");
    }

    #[test]
    fn tag_equality() {
        let a = Tag::new("Web Design").unwrap();
        let b = Tag::new("web-design").unwrap();
        assert_eq!(a, b);
    }
}
