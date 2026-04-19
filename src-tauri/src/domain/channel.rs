// Channel: a promoted tag displayed in the sidebar.
//
// A channel is a tag elevated to a permanent navigation item.
// Opening a channel = showing all blocks with that tag.
//
// Contract: SPEC_DOMAIN.md#domain/channel

use super::block::DateTime;
use super::tag::normalize_tag;
use thiserror::Error;

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ChannelError {
    #[error("channel tag is empty")]
    EmptyTag,

    #[error("channel title is empty")]
    EmptyTitle,

    #[error("invalid color: \"{value}\" (expected #RGB or #RRGGBB)")]
    InvalidColor { value: String },
}

// ─── Types ──────────────────────────────────────────────────────────────────

/// A promoted tag with display metadata for the sidebar.
#[derive(Debug, Clone, PartialEq)]
pub struct Channel {
    /// The tag this channel filters by (normalized).
    pub tag: String,
    /// Display name in the sidebar.
    pub title: String,
    pub description: Option<String>,
    /// Hex color: #RGB or #RRGGBB.
    pub color: Option<String>,
    /// Icon identifier.
    pub icon: Option<String>,
    /// Position in sidebar (0 = top).
    pub position: u32,
    /// When the channel was created.
    pub created_at: DateTime,
}

impl Channel {
    /// Create a new channel from a tag.
    ///
    /// If `title` is None, generates one from the tag:
    /// `"web-design"` becomes `"Web design"`.
    pub fn new(tag: &str, title: Option<&str>, created_at: DateTime) -> Result<Self, ChannelError> {
        let normalized_tag = normalize_tag(tag);
        if normalized_tag.is_empty() {
            return Err(ChannelError::EmptyTag);
        }

        let title = match title {
            Some(t) => {
                let trimmed = t.trim();
                if trimmed.is_empty() {
                    return Err(ChannelError::EmptyTitle);
                }
                trimmed.to_string()
            }
            None => title_from_tag(&normalized_tag),
        };

        Ok(Self {
            tag: normalized_tag,
            title,
            description: None,
            color: None,
            icon: None,
            position: 0,
            created_at,
        })
    }

    /// Update the channel title.
    pub fn update_title(&mut self, title: &str) -> Result<(), ChannelError> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err(ChannelError::EmptyTitle);
        }
        self.title = trimmed.to_string();
        Ok(())
    }

    /// Set the channel's sidebar position.
    pub fn update_position(&mut self, position: u32) {
        self.position = position;
    }

    /// Set the channel color, validating hex format.
    pub fn set_color(&mut self, color: &str) -> Result<(), ChannelError> {
        if !validate_color(color) {
            return Err(ChannelError::InvalidColor {
                value: color.to_string(),
            });
        }
        self.color = Some(color.to_string());
        Ok(())
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Validate a hex color string: #RGB or #RRGGBB.
pub fn validate_color(color: &str) -> bool {
    let bytes = color.as_bytes();
    if bytes.first() != Some(&b'#') {
        return false;
    }
    let hex = &bytes[1..];
    (hex.len() == 3 || hex.len() == 6) && hex.iter().all(|b| b.is_ascii_hexdigit())
}

// ─── Private helpers ────────────────────────────────────────────────────────

/// Generate a human-readable title from a kebab-case tag.
/// `"web-design"` -> `"Web design"`.
fn title_from_tag(tag: &str) -> String {
    let with_spaces = tag.replace('-', " ");
    let mut chars = with_spaces.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let upper: String = first.to_uppercase().collect();
            upper + chars.as_str()
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn dt() -> DateTime {
        DateTime::new("2026-02-26T14:30:00Z").unwrap()
    }

    // ── Channel::new ────────────────────────────────────────────────────

    #[test]
    fn new_with_explicit_title() {
        let ch = Channel::new("design", Some("My Design Channel"), dt()).unwrap();
        assert_eq!(ch.tag, "design");
        assert_eq!(ch.title, "My Design Channel");
        assert_eq!(ch.position, 0);
    }

    #[test]
    fn new_title_generated_from_tag() {
        // C2
        let ch = Channel::new("web-design", None, dt()).unwrap();
        assert_eq!(ch.title, "Web design");
    }

    #[test]
    fn new_normalizes_tag() {
        let ch = Channel::new("  Web Design  ", None, dt()).unwrap();
        assert_eq!(ch.tag, "web-design");
    }

    #[test]
    fn new_empty_tag() {
        // C1
        let err = Channel::new("", None, dt()).unwrap_err();
        assert_eq!(err, ChannelError::EmptyTag);
    }

    #[test]
    fn new_empty_title() {
        let err = Channel::new("design", Some("  "), dt()).unwrap_err();
        assert_eq!(err, ChannelError::EmptyTitle);
    }

    // ── update_title ────────────────────────────────────────────────────

    #[test]
    fn update_title_ok() {
        let mut ch = Channel::new("design", None, dt()).unwrap();
        ch.update_title("New Title").unwrap();
        assert_eq!(ch.title, "New Title");
    }

    #[test]
    fn update_title_empty() {
        let mut ch = Channel::new("design", None, dt()).unwrap();
        assert_eq!(ch.update_title(""), Err(ChannelError::EmptyTitle));
    }

    // ── validate_color ──────────────────────────────────────────────────

    #[test]
    fn color_valid_6() {
        // C3
        assert!(validate_color("#FF5733"));
    }

    #[test]
    fn color_valid_3() {
        // C4
        assert!(validate_color("#FFF"));
    }

    #[test]
    fn color_lowercase() {
        assert!(validate_color("#ff5733"));
    }

    #[test]
    fn color_name_invalid() {
        // C5
        assert!(!validate_color("red"));
    }

    #[test]
    fn color_invalid_hex() {
        // C6
        assert!(!validate_color("#GGGGGG"));
    }

    #[test]
    fn color_no_hash() {
        assert!(!validate_color("FF5733"));
    }

    #[test]
    fn color_wrong_length() {
        assert!(!validate_color("#FF57"));
    }

    // ── set_color ───────────────────────────────────────────────────────

    #[test]
    fn set_color_ok() {
        let mut ch = Channel::new("design", None, dt()).unwrap();
        ch.set_color("#FF5733").unwrap();
        assert_eq!(ch.color.as_deref(), Some("#FF5733"));
    }

    #[test]
    fn set_color_invalid() {
        let mut ch = Channel::new("design", None, dt()).unwrap();
        let err = ch.set_color("red").unwrap_err();
        assert!(matches!(err, ChannelError::InvalidColor { .. }));
    }

    // ── title_from_tag ──────────────────────────────────────────────────

    #[test]
    fn title_from_simple() {
        assert_eq!(title_from_tag("design"), "Design");
    }

    #[test]
    fn title_from_kebab() {
        assert_eq!(title_from_tag("web-design"), "Web design");
    }

    #[test]
    fn title_from_cyrillic() {
        assert_eq!(title_from_tag("верстка"), "Верстка");
    }

    // ── update_position ─────────────────────────────────────────────────

    #[test]
    fn update_position() {
        let mut ch = Channel::new("design", None, dt()).unwrap();
        ch.update_position(5);
        assert_eq!(ch.position, 5);
    }
}
