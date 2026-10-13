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
    /// Place in the manual order of the sidebar: the smallest stands on top.
    /// Signed, so a new collection takes the first place with a write of its
    /// own page only ([`new_collection_position`]).
    pub position: i64,
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
    pub fn update_position(&mut self, position: i64) {
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

/// The position of a new collection: first in the manual order, one before
/// the smallest position of the collections there are, `0` in a space
/// without any. `positions` are the positions as the index reads them, a page
/// without `position` at `0`.
///
/// One rule for every way a collection is made: the app, the CLI and the
/// MCP, the clipper's helper and the browser folder
/// (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, «Место новой коллекции»). Only the
/// new page is written: the others keep their positions, so making a
/// collection never rewrites the pages of the rest (SPEC_DEEP_AUDIT.md,
/// Е6.2).
pub fn new_collection_position<I: IntoIterator<Item = i64>>(positions: I) -> i64 {
    positions
        .into_iter()
        .min()
        .map_or(0, |smallest| smallest.saturating_sub(1))
}

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

    // ── new_collection_position ─────────────────────────────────────────

    #[test]
    fn a_new_collection_takes_the_place_before_the_first() {
        assert_eq!(new_collection_position([0, 1, 2]), -1);
        assert_eq!(new_collection_position([3, 7]), 2);
        assert_eq!(new_collection_position([-2, -1, 0, 5]), -3);
    }

    #[test]
    fn the_first_collection_of_a_space_stands_at_zero() {
        assert_eq!(new_collection_position(std::iter::empty()), 0);
    }

    #[test]
    fn the_smallest_position_does_not_wrap() {
        assert_eq!(new_collection_position([i64::MIN]), i64::MIN);
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
