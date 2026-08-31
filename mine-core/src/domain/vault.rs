//! Relative vault layout and filename rules, without filesystem observations.

use std::collections::HashSet;
use std::path::{Component, Path};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

/// Invalid relative paths, layout settings or exhausted collision candidates.
#[derive(Debug, Error)]
pub enum VaultError {
    #[error("could not resolve slug conflict for '{slug}' after 1000 attempts")]
    SlugConflictExhausted { slug: String },

    #[error("invalid slug: {reason}")]
    InvalidSlug { reason: String },

    #[error("invalid write layout: {reason}")]
    InvalidWriteLayout { reason: String },
}

fn join_slug(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

// ─── Types ──────────────────────────────────────────────────────────────────

/// Folders new files are written into, relative to the vault root.
///
/// Reading never depends on this: the scanner walks the whole vault and a
/// card's identity is its path, wherever it sits. This governs writes only —
/// where the clipper, the app and new collection documents put new files.
///
/// An empty string means the vault root, which is both the historical layout
/// and a legitimate configuration: a user may point all three at the root and
/// keep everything flat. See SPEC_VAULT_LIFECYCLE.md П1–П4.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct VaultWriteLayout {
    pub cards: String,
    pub media: String,
    pub collections: String,
}

/// Directory facts gathered by an executor, never by the pure layout rules.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VaultLayoutFacts {
    /// The standard cards directory exists as a directory.
    pub cards_dir: bool,
    /// The standard media directory exists as a directory.
    pub media_dir: bool,
    /// The standard collections directory exists as a directory.
    pub collections_dir: bool,
}

/// Standard relative destination for new cards.
pub const DEFAULT_CARDS_DIR: &str = "Cards";
/// Standard relative destination for captured media.
pub const DEFAULT_MEDIA_DIR: &str = "Media";
/// Standard relative destination for collection documents.
pub const DEFAULT_COLLECTIONS_DIR: &str = "Collections";

impl VaultWriteLayout {
    /// The standard layout for a new vault: three folders by role.
    pub fn standard() -> Self {
        Self {
            cards: DEFAULT_CARDS_DIR.to_string(),
            media: DEFAULT_MEDIA_DIR.to_string(),
            collections: DEFAULT_COLLECTIONS_DIR.to_string(),
        }
    }

    /// Everything at the vault root — how every vault behaved before this
    /// contract, and the fallback for a flat vault that was never migrated.
    pub fn flat() -> Self {
        Self {
            cards: String::new(),
            media: String::new(),
            collections: String::new(),
        }
    }

    /// Pick the layout an existing vault already follows.
    ///
    /// A vault that has the standard folders keeps using them; anything else
    /// stays flat, so opening someone's plain Obsidian vault never starts
    /// scattering files into folders it does not have.
    pub fn detect(facts: VaultLayoutFacts) -> Self {
        if facts.cards_dir && facts.media_dir && facts.collections_dir {
            Self::standard()
        } else {
            Self::flat()
        }
    }

    /// Vault-relative stem occupied by a new card.
    pub fn new_card_slug(&self, name: &str) -> String {
        join_slug(&self.cards, name)
    }

    /// Vault-relative stem occupied by media named after a card.
    pub fn new_media_stem(&self, name: &str) -> String {
        let base = name.rsplit('/').next().unwrap_or(name);
        join_slug(&self.media, base)
    }

    /// Vault-relative stem occupied by a new collection document.
    pub fn new_collection_slug(&self, name: &str) -> String {
        join_slug(&self.collections, name)
    }

    fn normalize_segment(value: &str) -> String {
        let trimmed = value.trim();
        // A bare slash means the vault root. Anything else keeps its leading
        // slash so `validate` can reject it as absolute instead of silently
        // turning `/etc` into a relative folder inside the vault.
        if trimmed.chars().all(|c| c == '/') {
            return String::new();
        }
        trimmed.trim_end_matches('/').to_string()
    }

    /// Reject anything that could escape the vault or hide from the scanner.
    pub fn validate(&self) -> Result<Self, VaultError> {
        let mut normalized = Self {
            cards: Self::normalize_segment(&self.cards),
            media: Self::normalize_segment(&self.media),
            collections: Self::normalize_segment(&self.collections),
        };
        for value in [
            &mut normalized.cards,
            &mut normalized.media,
            &mut normalized.collections,
        ] {
            if value.is_empty() {
                continue;
            }
            let path = Path::new(value.as_str());
            if path.is_absolute()
                || path
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
            {
                return Err(VaultError::InvalidWriteLayout {
                    reason: format!("write folder must stay inside the vault: {value}"),
                });
            }
            if value.starts_with('.') {
                return Err(VaultError::InvalidWriteLayout {
                    reason: format!("write folder must not be hidden: {value}"),
                });
            }
        }
        Ok(normalized)
    }
}

// ─── iCloud conflict detection ──────────────────────────────────────────────

/// Check whether a filename stem looks like an iCloud sync conflict.
///
/// iCloud Drive appends one of several conflict markers to the base
/// filename when it cannot merge concurrent edits:
///
/// - `<name> (conflicted copy).md`
/// - `<name> (conflicted copy 2).md`
/// - `<name> (user-name's MacBook Pro conflicted copy).md`
/// - `<name> (conflict).md`
///
/// If the stem matches one of those patterns, returns the inferred
/// `base_slug` (the original name before the conflict suffix). Returns
/// `None` for ordinary filenames.
///
/// Contract: Phase 18.G watcher uses this to divert conflict files into
/// the `vault_conflicts` surface instead of indexing them as new blocks.
pub fn detect_icloud_conflict(stem: &str) -> Option<String> {
    // Patterns are parenthetical and case-insensitive. We match from the end
    // so the base includes any user-authored parens earlier in the title.
    // Minimum signal: a parenthetical group ending with "conflict" or
    // "conflicted copy" (optionally followed by a number).
    let trimmed = stem.trim_end();
    let close = trimmed.rfind(')')?;
    // The closing paren must be at (or very near) the end of the stem.
    if close + 1 < trimmed.len() {
        return None;
    }
    // Find the matching opening paren (last ' (' before close).
    let before_close = &trimmed[..close];
    let open = before_close.rfind(" (")?;
    let inside = trimmed[open + 2..close].to_lowercase();

    let is_conflict = inside == "conflict"
        || inside == "conflicted copy"
        || inside.starts_with("conflicted copy ")
        || inside.ends_with(" conflicted copy")
        || inside.contains("conflicted copy");

    if !is_conflict {
        return None;
    }

    let base = trimmed[..open].trim_end();
    if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    }
}

// ─── Unicode normalization ──────────────────────────────────────────────────

/// Normalize a filename stem to NFC form.
///
/// HFS+ stores filenames in NFD (decomposed) form; APFS stores in NFC
/// (composed). iCloud Drive and Finder may surface the same filename in
/// different canonical forms across devices, which makes byte-for-byte
/// slug matching fragile for non-ASCII names.
///
/// This function is idempotent: ASCII strings pass through unchanged,
/// pre-NFC input is returned unchanged, NFD input is composed into NFC.
///
/// Apply at every filesystem boundary where a path enters the runtime:
/// - `read_block_file` when deriving a slug from `file_stem()`
/// - watcher events when handling notify paths
/// - native messaging host when persisting an uploaded file
/// - IPC command boundaries that accept a slug from external state
///
/// Contract: identity of two `.md` files with filenames that differ only
/// in Unicode normalization form is a single block, not two.
pub fn normalize_filename_stem(stem: &str) -> String {
    stem.nfc().collect()
}

// ─── Slug validation ────────────────────────────────────────────────────────

/// Validate that a slug is safe for use as a vault-relative path.
///
/// Slugs may contain `/` to identify files inside subdirectories, but every
/// segment must be ordinary user content: no empty segments, no `.` / `..`,
/// no absolute paths, no backslashes, and no NUL bytes.
pub fn validate_slug(slug: &str) -> Result<(), VaultError> {
    if slug.is_empty() {
        return Err(VaultError::InvalidSlug {
            reason: "slug is empty".to_string(),
        });
    }
    if slug.contains('\0') {
        return Err(VaultError::InvalidSlug {
            reason: "slug contains NUL byte".to_string(),
        });
    }
    if slug.contains('\\') {
        return Err(VaultError::InvalidSlug {
            reason: "slug contains backslash path separator".to_string(),
        });
    }
    if slug.starts_with('/') || slug.ends_with('/') || slug.contains("//") {
        return Err(VaultError::InvalidSlug {
            reason: "slug contains invalid path separator placement".to_string(),
        });
    }
    for segment in slug.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(VaultError::InvalidSlug {
                reason: "slug contains path traversal".to_string(),
            });
        }
    }
    Ok(())
}

/// Normalize each path component to NFC without changing the folder layout.
pub fn normalize_path_slug(slug: &str) -> String {
    slug.split('/')
        .map(normalize_filename_stem)
        .collect::<Vec<_>>()
        .join("/")
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Find the next available slug given a set of existing slugs.
///
/// If `slug` is available, returns it unchanged.
/// If taken, tries `slug (2)`, `slug (3)`, etc. up to `slug (1000)`.
///
/// The parenthetical suffix matches the human-readable basename style
/// introduced in Phase 18.C: e.g. `Hello World (2).md` instead of
/// `Hello World-2.md`. Obsidian uses the same convention for filename
/// deduplication, so the output stays native to both environments.
/// Pick a free display name for a new card, given everything the vault already
/// holds as vault-relative stems.
///
/// The distinction from `resolve_slug_conflict` is the whole point: a card's
/// name is bare (`Inspora`) while the stem it occupies carries the configured
/// folder (`Cards/Inspora`). Comparing the bare name against a set of stems
/// finds nothing, so every clip of an already-clipped page kept the taken name
/// and then failed to create the file. Both places the name lands are checked —
/// the card's own path and the media file named after it.
pub fn resolve_card_name_conflict(
    layout: &VaultWriteLayout,
    raw_name: &str,
    existing: &HashSet<String>,
) -> Result<String, VaultError> {
    let free = |candidate: &str| {
        !existing.contains(candidate)
            && !existing.contains(&layout.new_card_slug(candidate))
            && !existing.contains(&layout.new_media_stem(candidate))
    };
    if free(raw_name) {
        return Ok(raw_name.to_string());
    }
    for n in 2..=1000 {
        let candidate = format!("{} ({})", raw_name, n);
        if free(&candidate) {
            return Ok(candidate);
        }
    }
    Err(VaultError::SlugConflictExhausted {
        slug: raw_name.to_string(),
    })
}

/// Return a free slug, trying readable suffixes from `(2)` through `(1000)`.
pub fn resolve_slug_conflict(slug: &str, existing: &HashSet<String>) -> Result<String, VaultError> {
    if !existing.contains(slug) {
        return Ok(slug.to_string());
    }

    for n in 2..=1000 {
        let candidate = format!("{} ({})", slug, n);
        if !existing.contains(&candidate) {
            return Ok(candidate);
        }
    }

    Err(VaultError::SlugConflictExhausted {
        slug: slug.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_layout_using_only_supplied_directory_facts() {
        for bits in 0..8 {
            let facts = VaultLayoutFacts {
                cards_dir: bits & 1 != 0,
                media_dir: bits & 2 != 0,
                collections_dir: bits & 4 != 0,
            };
            assert_eq!(
                VaultWriteLayout::detect(facts),
                if bits == 7 {
                    VaultWriteLayout::standard()
                } else {
                    VaultWriteLayout::flat()
                }
            );
        }
    }

    #[test]
    fn relative_layout_preserves_nested_folders_and_unicode() {
        let layout = VaultWriteLayout {
            cards: "Mine/Cards".into(),
            media: "Mine/Media".into(),
            collections: "Mine/Collections".into(),
        }
        .validate()
        .expect("relative layout is valid");
        assert_eq!(layout.new_card_slug("Заметка"), "Mine/Cards/Заметка");
        assert_eq!(
            layout.new_media_stem("Mine/Cards/Заметка"),
            "Mine/Media/Заметка"
        );
        assert_eq!(
            layout.new_collection_slug("Чтение"),
            "Mine/Collections/Чтение"
        );
    }

    #[test]
    fn card_names_check_card_media_and_legacy_root_stems() {
        let existing = ["Cards/Note", "Media/Note (2)", "Note (3)"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        assert_eq!(
            resolve_card_name_conflict(&VaultWriteLayout::standard(), "Note", &existing)
                .expect("fourth name is free"),
            "Note (4)"
        );
    }

    #[test]
    fn slug_conflict_preserves_unicode_and_returns_exhaustion() {
        let existing = ["Закат".to_owned()].into_iter().collect();
        assert_eq!(
            resolve_slug_conflict("Закат", &existing).expect("suffix is free"),
            "Закат (2)"
        );
        let mut exhausted = HashSet::from(["Note".to_owned()]);
        exhausted.extend((2..=1000).map(|n| format!("Note ({n})")));
        assert!(matches!(
            resolve_slug_conflict("Note", &exhausted),
            Err(VaultError::SlugConflictExhausted { .. })
        ));
    }

    #[test]
    fn unsafe_paths_are_rejected_without_resolving_a_filesystem() {
        for value in [
            "",
            "../outside",
            "/outside",
            "Note//child",
            "Note\\child",
            "Note\0",
        ] {
            assert!(validate_slug(value).is_err(), "{value:?}");
        }
        assert!(validate_slug("Notes/Заметка").is_ok());
        for cards in ["../outside", "/outside", ".hidden"] {
            assert!(VaultWriteLayout {
                cards: cards.into(),
                ..VaultWriteLayout::standard()
            }
            .validate()
            .is_err());
        }
    }

    #[test]
    fn unicode_and_cloud_conflicts_are_platform_independent() {
        assert_eq!(normalize_path_slug("Cards/cafe\u{301}"), "Cards/café");
        assert_eq!(
            detect_icloud_conflict("Note (conflicted copy)"),
            Some("Note".into())
        );
        assert_eq!(detect_icloud_conflict("Note (2)"), None);
    }
}
