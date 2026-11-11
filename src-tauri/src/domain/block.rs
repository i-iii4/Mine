//! Compatibility path for the shared portable block model and rules.
pub use mine_core::domain::block::*;

/// `source` of the card a merge writes: the operation's provenance, not the
/// user's source address (SPEC_CARD_MERGE.md, «New Frontmatter»). Its preview
/// is planned from every part of its body (`storage::index`, «Preview Tiles»).
pub const CARD_MERGE_SOURCE: &str = "card-merge";
