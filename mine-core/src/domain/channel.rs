// Channel: the shared model of a promoted collection displayed in the sidebar.
//
// A channel is backed by an Obsidian collection page. Opening a channel =
// showing all blocks whose `Mine Collections` links target that page.
//
// Contract: SPEC_DOMAIN.md#domain/channel

use super::block::DateTime;
use super::collection::normalize_collection_ref;
use thiserror::Error;

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ChannelError {
    #[error("channel collection ref is empty")]
    EmptyTag,

    #[error("invalid color: \"{value}\" (expected #RGB or #RRGGBB)")]
    InvalidColor { value: String },
}

// ─── Types ──────────────────────────────────────────────────────────────────

/// A promoted collection with sidebar metadata.
#[derive(Debug, Clone, PartialEq)]
pub struct Channel {
    /// The collection ref this channel filters by.
    pub tag: String,
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
    /// Create a new channel from an Obsidian collection ref.
    pub fn new(tag: &str, created_at: DateTime) -> Result<Self, ChannelError> {
        let collection_ref = normalize_collection_ref(tag);
        if collection_ref.is_empty() {
            return Err(ChannelError::EmptyTag);
        }

        Ok(Self {
            tag: collection_ref,
            description: None,
            color: None,
            icon: None,
            position: 0,
            created_at,
        })
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

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn dt() -> DateTime {
        DateTime::new("2026-02-26T14:30:00Z").unwrap()
    }

    // ── Channel::new ────────────────────────────────────────────────────

    #[test]
    fn new_with_ref() {
        let ch = Channel::new("design", dt()).unwrap();
        assert_eq!(ch.tag, "design");
        assert_eq!(ch.position, 0);
    }

    #[test]
    fn new_preserves_human_ref() {
        let ch = Channel::new("  Web Design  ", dt()).unwrap();
        assert_eq!(ch.tag, "Web Design");
    }

    #[test]
    fn new_empty_tag() {
        // C1
        let err = Channel::new("", dt()).unwrap_err();
        assert_eq!(err, ChannelError::EmptyTag);
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
        let mut ch = Channel::new("design", dt()).unwrap();
        ch.set_color("#FF5733").unwrap();
        assert_eq!(ch.color.as_deref(), Some("#FF5733"));
    }

    #[test]
    fn set_color_invalid() {
        let mut ch = Channel::new("design", dt()).unwrap();
        let err = ch.set_color("red").unwrap_err();
        assert!(matches!(err, ChannelError::InvalidColor { .. }));
    }

    // ── update_position ─────────────────────────────────────────────────

    #[test]
    fn update_position() {
        let mut ch = Channel::new("design", dt()).unwrap();
        ch.update_position(5);
        assert_eq!(ch.position, 5);
    }
}
