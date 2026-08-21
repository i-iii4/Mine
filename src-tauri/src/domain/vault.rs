// Vault: path computation for the vault filesystem layout.
//
// Pure path logic: no filesystem access. Computes paths to blocks,
// media files, Mine metadata directory, index DB, and thumbnails.
// Also resolves slug conflicts given a set of existing slugs.
//
// Contract: SPEC_DOMAIN.md#domain/vault

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

// ─── Errors ─────────────────────────────────────────────────────────────────

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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultWriteLayout {
    pub cards: String,
    pub media: String,
    pub collections: String,
}

pub const DEFAULT_CARDS_DIR: &str = "Cards";
pub const DEFAULT_MEDIA_DIR: &str = "Media";
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
    pub fn detect(root: &Path) -> Self {
        let standard = Self::standard();
        let has_all = root.join(&standard.cards).is_dir()
            && root.join(&standard.media).is_dir()
            && root.join(&standard.collections).is_dir();
        if has_all {
            standard
        } else {
            Self::flat()
        }
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
        for value in [&mut normalized.cards, &mut normalized.media, &mut normalized.collections] {
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

/// Computes paths within a vault based on its root directory.
/// Does NOT access the filesystem.
#[derive(Debug, Clone)]
pub struct VaultLayout {
    root: PathBuf,
    derived_root: PathBuf,
    write_layout: VaultWriteLayout,
}

impl VaultLayout {
    pub fn new(root: PathBuf) -> Self {
        let derived_root = root.join(".mine");
        let write_layout = VaultWriteLayout::detect(&root);
        Self {
            root,
            derived_root,
            write_layout,
        }
    }

    pub fn with_derived_root(root: PathBuf, derived_root: PathBuf) -> Self {
        let write_layout = VaultWriteLayout::detect(&root);
        Self {
            root,
            derived_root,
            write_layout,
        }
    }

    /// Replace the write layout, e.g. from the vault's saved configuration.
    pub fn with_write_layout(mut self, write_layout: VaultWriteLayout) -> Self {
        self.write_layout = write_layout;
        self
    }

    pub fn write_layout(&self) -> &VaultWriteLayout {
        &self.write_layout
    }

    fn write_dir(&self, segment: &str) -> PathBuf {
        if segment.is_empty() {
            self.root.clone()
        } else {
            self.root.join(segment)
        }
    }

    /// Directory new cards are written into.
    pub fn cards_dir(&self) -> PathBuf {
        self.write_dir(&self.write_layout.cards)
    }

    /// Directory new media files are written into.
    pub fn media_dir(&self) -> PathBuf {
        self.write_dir(&self.write_layout.media)
    }

    /// Directory new collection documents are written into.
    pub fn collections_dir(&self) -> PathBuf {
        self.write_dir(&self.write_layout.collections)
    }

    /// The vault root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Slug for a newly created card with the given base name.
    ///
    /// A card's identity is its vault-relative path, so the write layout is
    /// applied here rather than at write time: `Cards/Note` under the standard
    /// layout, plain `Note` on a flat vault. Everything downstream — writing,
    /// indexing, resolving — keeps treating the slug as the path it always was.
    pub fn new_card_slug(&self, name: &str) -> String {
        join_slug(&self.write_layout.cards, name)
    }

    /// Vault-relative stem a media file for `name` would occupy.
    ///
    /// Media keeps a bare file name even when the card sits in a folder, so
    /// this is the media folder joined to the name, not to the card's slug.
    pub fn new_media_stem(&self, name: &str) -> String {
        let base = name.rsplit('/').next().unwrap_or(name);
        join_slug(&self.write_layout.media, base)
    }

    /// Slug for a newly created collection document.
    pub fn new_collection_slug(&self, name: &str) -> String {
        join_slug(&self.write_layout.collections, name)
    }

    /// Path for a newly written media file with the given file name.
    pub fn new_media_path(&self, file_name: &str) -> PathBuf {
        self.media_dir().join(file_name)
    }

    /// Path to a block's .md file: `root/<slug>.md`.
    ///
    /// `slug` is a vault-relative path without the `.md` extension. Root
    /// files keep the historical shape (`Note`), nested files use forward
    /// slashes (`Folder/Note`).
    ///
    /// Panics in debug builds if slug fails validation.
    /// Call `validate_slug()` at IPC boundaries before using this.
    pub fn block_path(&self, slug: &str) -> PathBuf {
        debug_assert!(
            validate_slug(slug).is_ok(),
            "invalid slug passed to block_path: {:?}",
            slug
        );
        self.root.join(format!("{}.md", slug))
    }

    /// Path to a block's media file, named after the block and placed in the
    /// configured media folder.
    ///
    /// The file name is the block's base name, never its folder path: media is
    /// referenced from frontmatter as a bare wikilink, so `Cards/Note` owns
    /// `Media/Note.jpg`, not `Media/Cards/Note.jpg`. On a flat vault the media
    /// folder is the root and this is the historical `root/<slug>.<ext>`.
    ///
    /// Panics in debug builds if slug fails validation.
    /// Call `validate_slug()` at IPC boundaries before using this.
    pub fn media_path(&self, slug: &str, ext: &str) -> PathBuf {
        debug_assert!(
            validate_slug(slug).is_ok(),
            "invalid slug passed to media_path: {:?}",
            slug
        );
        let base = slug.rsplit('/').next().unwrap_or(slug);
        let ext = ext.strip_prefix('.').unwrap_or(ext);
        self.media_dir().join(format!("{}.{}", base, ext))
    }

    /// Path to the synced Mine metadata directory.
    pub fn mine_dir(&self) -> PathBuf {
        self.root.join(".mine")
    }

    /// Path to the saved write-layout configuration.
    ///
    /// Lives inside the vault so it travels with the folder: the same space
    /// opened on another machine keeps writing into the same folders.
    pub fn write_layout_path(&self) -> PathBuf {
        self.mine_dir().join("layout.json")
    }

    /// Path to the legacy `.arena/` directory.
    pub fn legacy_arena_dir(&self) -> PathBuf {
        self.root.join(".arena")
    }

    /// Path to the synced vault identity marker: `.mine/vault-id`.
    pub fn vault_id_path(&self) -> PathBuf {
        self.mine_dir().join("vault-id")
    }

    /// Path to the legacy synced vault identity marker: `.arena/vault-id`.
    pub fn legacy_vault_id_path(&self) -> PathBuf {
        self.legacy_arena_dir().join("vault-id")
    }

    /// Root directory for local derived state (per-device cache/index).
    pub fn derived_root(&self) -> &Path {
        &self.derived_root
    }

    /// Path to the legacy SQLite index in the vault: `.arena/index.db`.
    pub fn legacy_index_db_path(&self) -> PathBuf {
        self.legacy_arena_dir().join("index.db")
    }

    /// Path to the SQLite index in the local derived store.
    pub fn index_db_path(&self) -> PathBuf {
        self.derived_root.join("index.db")
    }

    /// Path to the legacy thumbnails directory inside the vault:
    /// `.arena/cache/thumbs`.
    pub fn legacy_thumbs_dir(&self) -> PathBuf {
        self.legacy_arena_dir().join("cache").join("thumbs")
    }

    /// Path to the thumbnails directory in the local derived store.
    pub fn thumbs_dir(&self) -> PathBuf {
        self.derived_root.join("cache").join("thumbs")
    }

    /// Path to the local article-audio cache directory in the derived store.
    pub fn audio_dir(&self) -> PathBuf {
        self.derived_root.join("cache").join("audio")
    }

    /// Path to a specific thumbnail in the local derived store:
    /// `<derived_root>/cache/thumbs/<slug>.jpg`.
    ///
    /// Panics in debug builds if slug fails validation.
    /// Call `validate_slug()` at IPC boundaries before using this.
    pub fn thumb_path(&self, slug: &str) -> PathBuf {
        debug_assert!(
            validate_slug(slug).is_ok(),
            "invalid slug passed to thumb_path: {:?}",
            slug
        );
        self.thumbs_dir().join(format!("{}.jpg", slug))
    }

    /// Path to a per-media tile poster in the local derived store:
    /// `<derived_root>/cache/thumbs/<media-stem>.jpg`.
    ///
    /// Unlike `thumb_path`, the key is a media filename (spaces, parens,
    /// `(video 1)` suffixes), not a block slug, so no slug validation applies.
    /// Used for gallery video tiles where each video needs its own frame,
    /// distinct from the block's representative `<slug>.jpg`.
    pub fn media_thumb_path(&self, media_name: &str) -> PathBuf {
        // Drop the media extension; keep the rest verbatim (spaces, parens).
        let stem = media_name
            .rsplit_once('.')
            .map_or(media_name, |(stem, _)| stem);
        self.thumbs_dir().join(format!("{stem}.jpg"))
    }

    /// Path to an article-audio sidecar JSON in the local derived store:
    /// `<derived_root>/cache/audio/<slug>.json`.
    pub fn article_audio_state_path(&self, slug: &str) -> PathBuf {
        debug_assert!(
            validate_slug(slug).is_ok(),
            "invalid slug passed to article_audio_state_path: {:?}",
            slug
        );
        self.audio_dir().join(format!("{}.json", slug))
    }

    /// Path to an article-audio file in the local derived store:
    /// `<derived_root>/cache/audio/<slug>.<ext>`.
    pub fn article_audio_asset_path(&self, slug: &str, ext: &str) -> PathBuf {
        debug_assert!(
            validate_slug(slug).is_ok(),
            "invalid slug passed to article_audio_asset_path: {:?}",
            slug
        );
        let ext = ext.strip_prefix('.').unwrap_or(ext);
        self.audio_dir().join(format!("{}.{}", slug, ext))
    }

    /// Convert an on-disk `.md` path into Mine's path-based slug.
    pub fn slug_for_path(&self, path: &Path) -> Result<String, VaultError> {
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|_| VaultError::InvalidSlug {
                reason: "path is outside vault root".to_string(),
            })?;
        let without_ext = relative.with_extension("");
        let slug =
            path_to_portable_string(&without_ext).ok_or_else(|| VaultError::InvalidSlug {
                reason: "path is not valid UTF-8".to_string(),
            })?;
        let slug = normalize_path_slug(&slug);
        validate_slug(&slug)?;
        Ok(slug)
    }

    /// Resolve a local media reference against the directory containing a block.
    ///
    /// Frontmatter and Obsidian embeds are interpreted relative to their `.md`
    /// file first, then constrained to stay inside the vault.
    pub fn resolve_local_reference(&self, block_slug: &str, reference: &str) -> Option<PathBuf> {
        if reference.is_empty()
            || reference.starts_with("http://")
            || reference.starts_with("https://")
            || reference.contains('\0')
        {
            return None;
        }
        let reference_path = Path::new(reference);
        if reference_path.is_absolute() {
            return None;
        }
        let block_path = self.block_path(block_slug);
        let base = block_path.parent().unwrap_or(self.root());
        let resolved = normalize_join(base, reference_path)?;
        resolved.starts_with(&self.root).then_some(resolved)
    }

    /// Render a media reference as a vault-root-relative portable path.
    pub fn root_relative_reference(&self, path: &Path) -> Option<String> {
        let relative = path.strip_prefix(&self.root).ok()?;
        path_to_portable_string(relative)
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

pub fn normalize_path_slug(slug: &str) -> String {
    slug.split('/')
        .map(normalize_filename_stem)
        .collect::<Vec<_>>()
        .join("/")
}

fn path_to_portable_string(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

fn normalize_join(base: &Path, relative: &Path) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for component in relative.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
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
    layout: &VaultLayout,
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

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> VaultLayout {
        VaultLayout::new(PathBuf::from("/vault"))
    }

    // ── VaultLayout paths ───────────────────────────────────────────────

    #[test]
    fn block_path() {
        // V1
        assert_eq!(
            layout().block_path("sunset-tokyo"),
            PathBuf::from("/vault/sunset-tokyo.md")
        );
    }

    #[test]
    fn media_path_without_dot() {
        // V2
        assert_eq!(
            layout().media_path("sunset-tokyo", "jpg"),
            PathBuf::from("/vault/sunset-tokyo.jpg")
        );
    }

    #[test]
    fn media_path_with_dot() {
        assert_eq!(
            layout().media_path("sunset-tokyo", ".jpg"),
            PathBuf::from("/vault/sunset-tokyo.jpg")
        );
    }

    #[test]
    fn mine_dir() {
        assert_eq!(layout().mine_dir(), PathBuf::from("/vault/.mine"));
    }

    #[test]
    fn legacy_arena_dir() {
        assert_eq!(layout().legacy_arena_dir(), PathBuf::from("/vault/.arena"));
    }

    #[test]
    fn vault_id_path() {
        assert_eq!(
            layout().vault_id_path(),
            PathBuf::from("/vault/.mine/vault-id")
        );
    }

    #[test]
    fn legacy_vault_id_path() {
        assert_eq!(
            layout().legacy_vault_id_path(),
            PathBuf::from("/vault/.arena/vault-id")
        );
    }

    #[test]
    fn derived_root_defaults_to_mine_dir() {
        assert_eq!(layout().derived_root(), Path::new("/vault/.mine"));
    }

    #[test]
    fn legacy_index_db_path() {
        assert_eq!(
            layout().legacy_index_db_path(),
            PathBuf::from("/vault/.arena/index.db")
        );
    }

    #[test]
    fn index_db_path() {
        assert_eq!(
            layout().index_db_path(),
            PathBuf::from("/vault/.mine/index.db")
        );
    }

    #[test]
    fn thumbs_dir() {
        assert_eq!(
            layout().thumbs_dir(),
            PathBuf::from("/vault/.mine/cache/thumbs")
        );
    }

    #[test]
    fn legacy_thumbs_dir() {
        assert_eq!(
            layout().legacy_thumbs_dir(),
            PathBuf::from("/vault/.arena/cache/thumbs")
        );
    }

    #[test]
    fn media_thumb_path_uses_media_stem() {
        assert_eq!(
            layout().media_thumb_path("clip (video 1).mp4"),
            PathBuf::from("/vault/.mine/cache/thumbs/clip (video 1).jpg")
        );
    }

    #[test]
    fn audio_dir() {
        assert_eq!(
            layout().audio_dir(),
            PathBuf::from("/vault/.mine/cache/audio")
        );
    }

    #[test]
    fn article_audio_state_path() {
        assert_eq!(
            layout().article_audio_state_path("sunset-tokyo"),
            PathBuf::from("/vault/.mine/cache/audio/sunset-tokyo.json")
        );
    }

    #[test]
    fn article_audio_asset_path() {
        assert_eq!(
            layout().article_audio_asset_path("sunset-tokyo", "aiff"),
            PathBuf::from("/vault/.mine/cache/audio/sunset-tokyo.aiff")
        );
    }

    #[test]
    fn thumb_path() {
        assert_eq!(
            layout().thumb_path("sunset-tokyo"),
            PathBuf::from("/vault/.mine/cache/thumbs/sunset-tokyo.jpg")
        );
    }

    #[test]
    fn root() {
        assert_eq!(layout().root(), Path::new("/vault"));
    }

    #[test]
    fn custom_derived_root_overrides_index_location() {
        let layout = VaultLayout::with_derived_root(
            PathBuf::from("/vault"),
            PathBuf::from("/local-derived/vault-123"),
        );
        assert_eq!(layout.root(), Path::new("/vault"));
        assert_eq!(layout.derived_root(), Path::new("/local-derived/vault-123"));
        assert_eq!(
            layout.index_db_path(),
            PathBuf::from("/local-derived/vault-123/index.db")
        );
        assert_eq!(
            layout.legacy_index_db_path(),
            PathBuf::from("/vault/.arena/index.db")
        );
        assert_eq!(
            layout.thumbs_dir(),
            PathBuf::from("/local-derived/vault-123/cache/thumbs")
        );
        assert_eq!(
            layout.legacy_thumbs_dir(),
            PathBuf::from("/vault/.arena/cache/thumbs")
        );
    }

    // ── validate_slug ─────────────────────────────────────────────────

    #[test]
    fn validate_slug_normal() {
        assert!(validate_slug("sunset-tokyo").is_ok());
        assert!(validate_slug("a").is_ok());
        assert!(validate_slug("my-slug-2").is_ok());
    }

    #[test]
    fn validate_slug_empty() {
        assert!(validate_slug("").is_err());
    }

    #[test]
    fn validate_slug_nul_byte() {
        assert!(validate_slug("foo\0bar").is_err());
    }

    #[test]
    fn validate_slug_forward_slash() {
        assert!(validate_slug("foo/bar").is_ok());
        assert!(validate_slug("/foo").is_err());
        assert!(validate_slug("foo/").is_err());
        assert!(validate_slug("foo//bar").is_err());
    }

    #[test]
    fn validate_slug_backslash() {
        assert!(validate_slug("foo\\bar").is_err());
    }

    #[test]
    fn validate_slug_dotdot() {
        assert!(validate_slug("..").is_err());
        assert!(validate_slug("../etc").is_err());
    }

    #[test]
    fn validate_slug_single_dot_ok() {
        // A single dot is also suspicious but currently only ".." is blocked.
        // "." is blocked explicitly.
        assert!(validate_slug(".").is_err());
    }

    // ── write layout ────────────────────────────────────────────────────

    #[test]
    fn detects_the_standard_layout_only_when_all_three_folders_exist() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            VaultWriteLayout::detect(dir.path()),
            VaultWriteLayout::flat()
        );

        std::fs::create_dir_all(dir.path().join("Cards")).unwrap();
        std::fs::create_dir_all(dir.path().join("Media")).unwrap();
        // Two of three is not the standard layout: a vault that merely happens
        // to have a `Cards` folder must not start scattering files.
        assert_eq!(
            VaultWriteLayout::detect(dir.path()),
            VaultWriteLayout::flat()
        );

        std::fs::create_dir_all(dir.path().join("Collections")).unwrap();
        assert_eq!(
            VaultWriteLayout::detect(dir.path()),
            VaultWriteLayout::standard()
        );
    }

    #[test]
    fn new_slugs_carry_the_configured_folder() {
        let dir = tempfile::tempdir().unwrap();
        let layout = VaultLayout::new(dir.path().to_path_buf())
            .with_write_layout(VaultWriteLayout::standard());

        assert_eq!(layout.new_card_slug("Note"), "Cards/Note");
        assert_eq!(layout.new_collection_slug("Каталоги"), "Collections/Каталоги");
        assert_eq!(layout.new_media_path("Note.jpg"), dir.path().join("Media/Note.jpg"));
    }

    #[test]
    fn a_flat_layout_keeps_the_historical_paths() {
        let dir = tempfile::tempdir().unwrap();
        let layout = VaultLayout::new(dir.path().to_path_buf())
            .with_write_layout(VaultWriteLayout::flat());

        assert_eq!(layout.new_card_slug("Note"), "Note");
        assert_eq!(layout.new_media_path("Note.jpg"), dir.path().join("Note.jpg"));
        assert_eq!(layout.media_path("Note", "jpg"), dir.path().join("Note.jpg"));
    }

    #[test]
    fn media_is_named_after_the_card_not_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let layout = VaultLayout::new(dir.path().to_path_buf())
            .with_write_layout(VaultWriteLayout::standard());

        // A card at `Cards/Note` owns `Media/Note.jpg`: the frontmatter
        // reference is a bare wikilink, so nesting must not leak into it.
        assert_eq!(
            layout.media_path("Cards/Note", "jpg"),
            dir.path().join("Media/Note.jpg")
        );
    }

    #[test]
    fn all_three_may_point_at_the_root() {
        let layout = VaultWriteLayout {
            cards: String::new(),
            media: "  ".to_string(),
            collections: "/".to_string(),
        }
        .validate()
        .unwrap();
        assert_eq!(layout, VaultWriteLayout::flat());
    }

    #[test]
    fn write_layout_cannot_escape_the_vault_or_hide() {
        for bad in ["../outside", "/etc", "Cards/../..", ".hidden"] {
            let result = VaultWriteLayout {
                cards: bad.to_string(),
                media: "Media".to_string(),
                collections: "Collections".to_string(),
            }
            .validate();
            assert!(result.is_err(), "expected rejection for {bad}");
        }
    }

    #[test]
    fn nested_write_folders_are_allowed() {
        let layout = VaultWriteLayout {
            cards: "Mine/Cards".to_string(),
            media: "Mine/Media".to_string(),
            collections: "Mine/Collections".to_string(),
        }
        .validate()
        .unwrap();
        assert_eq!(layout.cards, "Mine/Cards");
    }

    // ── resolve_card_name_conflict ──────────────────────────────────────

    fn standard_layout() -> VaultLayout {
        VaultLayout::new(PathBuf::from("/vault")).with_write_layout(VaultWriteLayout::standard())
    }

    #[test]
    fn card_name_conflict_sees_a_card_that_lives_in_the_cards_folder() {
        // The bug this exists for: the vault holds `Cards/Inspora`, the name
        // asked for is `Inspora`, and a bare comparison finds nothing — so the
        // clipper kept the taken name and failed to create the file.
        let existing: HashSet<String> = ["Cards/Inspora".to_string()].into_iter().collect();
        assert_eq!(
            resolve_card_name_conflict(&standard_layout(), "Inspora", &existing).unwrap(),
            "Inspora (2)",
        );
    }

    #[test]
    fn card_name_conflict_sees_the_media_file_named_after_the_card() {
        // Media keeps a bare name in its own folder, so a free card path is not
        // enough: the image would collide instead.
        let existing: HashSet<String> = ["Media/Inspora".to_string()].into_iter().collect();
        assert_eq!(
            resolve_card_name_conflict(&standard_layout(), "Inspora", &existing).unwrap(),
            "Inspora (2)",
        );
    }

    #[test]
    fn card_name_conflict_keeps_counting_until_both_paths_are_free() {
        let existing: HashSet<String> = [
            "Cards/Shot".to_string(),
            "Cards/Shot (2)".to_string(),
            "Media/Shot (3)".to_string(),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            resolve_card_name_conflict(&standard_layout(), "Shot", &existing).unwrap(),
            "Shot (4)",
        );
    }

    #[test]
    fn card_name_conflict_still_works_when_everything_sits_at_the_root() {
        let flat = VaultLayout::new(PathBuf::from("/vault")).with_write_layout(VaultWriteLayout::flat());
        let existing: HashSet<String> = ["Note".to_string()].into_iter().collect();
        assert_eq!(
            resolve_card_name_conflict(&flat, "Note", &existing).unwrap(),
            "Note (2)",
        );
        assert_eq!(
            resolve_card_name_conflict(&flat, "Fresh", &existing).unwrap(),
            "Fresh",
        );
    }

    // ── resolve_slug_conflict ───────────────────────────────────────────

    #[test]
    fn conflict_no_conflict() {
        let existing = HashSet::new();
        assert_eq!(resolve_slug_conflict("slug", &existing).unwrap(), "slug");
    }

    #[test]
    fn conflict_one_existing() {
        let existing: HashSet<String> = ["slug"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            resolve_slug_conflict("slug", &existing).unwrap(),
            "slug (2)"
        );
    }

    #[test]
    fn conflict_two_existing() {
        let existing: HashSet<String> =
            ["slug", "slug (2)"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            resolve_slug_conflict("slug", &existing).unwrap(),
            "slug (3)"
        );
    }

    #[test]
    fn conflict_gap_in_sequence() {
        // slug (2) is free even though slug (3) exists
        let existing: HashSet<String> =
            ["slug", "slug (3)"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            resolve_slug_conflict("slug", &existing).unwrap(),
            "slug (2)"
        );
    }

    #[test]
    fn conflict_many_existing() {
        let mut existing = HashSet::new();
        existing.insert("doc".to_string());
        for i in 2..=10 {
            existing.insert(format!("doc ({})", i));
        }
        assert_eq!(resolve_slug_conflict("doc", &existing).unwrap(), "doc (11)");
    }

    #[test]
    fn conflict_exhausted_returns_error() {
        let mut existing = HashSet::new();
        existing.insert("slug".to_string());
        for i in 2..=1000 {
            existing.insert(format!("slug ({})", i));
        }
        let result = resolve_slug_conflict("slug", &existing);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("slug"));
    }

    #[test]
    fn conflict_preserves_unicode_base() {
        let existing: HashSet<String> = ["Закат в Токио"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            resolve_slug_conflict("Закат в Токио", &existing).unwrap(),
            "Закат в Токио (2)"
        );
    }

    #[test]
    fn conflict_preserves_base_containing_parentheses() {
        // Base already has parens from user content; suffix still appends.
        let existing: HashSet<String> = ["Note (draft)"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            resolve_slug_conflict("Note (draft)", &existing).unwrap(),
            "Note (draft) (2)"
        );
    }

    // ── Unicode normalization ───────────────────────────────────────────

    #[test]
    fn normalize_passes_ascii_through_unchanged() {
        assert_eq!(normalize_filename_stem("sunset-tokyo"), "sunset-tokyo");
    }

    #[test]
    fn normalize_passes_empty_string_through() {
        assert_eq!(normalize_filename_stem(""), "");
    }

    #[test]
    fn normalize_is_idempotent_on_nfc_input() {
        let nfc_input = "закат-в-токио";
        let once = normalize_filename_stem(nfc_input);
        let twice = normalize_filename_stem(&once);
        assert_eq!(once, nfc_input);
        assert_eq!(twice, once);
    }

    #[test]
    fn normalize_composes_nfd_cyrillic_to_nfc() {
        // "йог" decomposed: "и" (U+0438) + combining breve (U+0306) + "о" + "г"
        let nfd = "\u{0438}\u{0306}\u{043E}\u{0433}";
        let nfc = normalize_filename_stem(nfd);
        // Expected composed: "й" (U+0439) + "о" + "г"
        assert_eq!(nfc, "\u{0439}\u{043E}\u{0433}");
    }

    #[test]
    fn normalize_composes_nfd_latin_accents_to_nfc() {
        // "café" decomposed: "cafe" + combining acute accent
        let nfd = "cafe\u{0301}";
        let nfc = normalize_filename_stem(nfd);
        // Expected composed: "caf" + "é" (U+00E9)
        assert_eq!(nfc, "caf\u{00E9}");
    }

    // ── iCloud conflict detection ───────────────────────────────────────

    #[test]
    fn detect_conflict_basic() {
        assert_eq!(
            detect_icloud_conflict("Hello World (conflicted copy)"),
            Some("Hello World".to_string())
        );
    }

    #[test]
    fn detect_conflict_numbered() {
        assert_eq!(
            detect_icloud_conflict("Note (conflicted copy 2)"),
            Some("Note".to_string())
        );
    }

    #[test]
    fn detect_conflict_with_device_name() {
        assert_eq!(
            detect_icloud_conflict("Doc (MacBook Pro conflicted copy)"),
            Some("Doc".to_string())
        );
    }

    #[test]
    fn detect_conflict_short_form() {
        assert_eq!(
            detect_icloud_conflict("Note (conflict)"),
            Some("Note".to_string())
        );
    }

    #[test]
    fn detect_conflict_case_insensitive_marker() {
        assert_eq!(
            detect_icloud_conflict("Thing (Conflicted Copy)"),
            Some("Thing".to_string())
        );
    }

    #[test]
    fn detect_conflict_preserves_unicode_base() {
        assert_eq!(
            detect_icloud_conflict("Закат (conflicted copy)"),
            Some("Закат".to_string())
        );
    }

    #[test]
    fn detect_conflict_preserves_user_parentheses_in_base() {
        // "Note (draft)" is the real base; the trailing paren group is
        // the conflict marker only.
        assert_eq!(
            detect_icloud_conflict("Note (draft) (conflicted copy)"),
            Some("Note (draft)".to_string())
        );
    }

    #[test]
    fn detect_conflict_rejects_ordinary_parenthetical() {
        // Mine's own collision suffix (Phase 18.D) is not a conflict.
        assert_eq!(detect_icloud_conflict("Hello World (2)"), None);
        assert_eq!(detect_icloud_conflict("Note (draft)"), None);
    }

    #[test]
    fn detect_conflict_rejects_plain_filename() {
        assert_eq!(detect_icloud_conflict("sunset-tokyo"), None);
        assert_eq!(detect_icloud_conflict("Hello World"), None);
    }

    #[test]
    fn detect_conflict_rejects_empty_base() {
        assert_eq!(detect_icloud_conflict("(conflicted copy)"), None);
        assert_eq!(detect_icloud_conflict(" (conflict)"), None);
    }
}
