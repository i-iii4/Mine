// Vault: path computation for the vault filesystem layout.
//
// Pure path logic: no filesystem access. Computes paths to blocks,
// media files, arena directory, index DB, and thumbnails.
// Also resolves slug conflicts given a set of existing slugs.
//
// Contract: SPEC_DOMAIN.md#domain/vault

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use thiserror::Error;

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("could not resolve slug conflict for '{slug}' after 1000 attempts")]
    SlugConflictExhausted { slug: String },

    #[error("invalid slug: {reason}")]
    InvalidSlug { reason: String },
}

// ─── Types ──────────────────────────────────────────────────────────────────

/// Computes paths within a vault based on its root directory.
/// Does NOT access the filesystem.
#[derive(Debug, Clone)]
pub struct VaultLayout {
    root: PathBuf,
    derived_root: PathBuf,
}

impl VaultLayout {
    pub fn new(root: PathBuf) -> Self {
        let derived_root = root.join(".arena");
        Self { root, derived_root }
    }

    pub fn with_derived_root(root: PathBuf, derived_root: PathBuf) -> Self {
        Self { root, derived_root }
    }

    /// The vault root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Path to a block's .md file: `root/slug.md`.
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

    /// Path to a block's media file: `root/slug.ext`.
    ///
    /// Panics in debug builds if slug fails validation.
    /// Call `validate_slug()` at IPC boundaries before using this.
    pub fn media_path(&self, slug: &str, ext: &str) -> PathBuf {
        debug_assert!(
            validate_slug(slug).is_ok(),
            "invalid slug passed to media_path: {:?}",
            slug
        );
        let ext = ext.strip_prefix('.').unwrap_or(ext);
        self.root.join(format!("{}.{}", slug, ext))
    }

    /// Path to the `.arena/` directory.
    pub fn arena_dir(&self) -> PathBuf {
        self.root.join(".arena")
    }

    /// Path to the synced vault identity marker: `.arena/vault-id`.
    pub fn vault_id_path(&self) -> PathBuf {
        self.arena_dir().join("vault-id")
    }

    /// Root directory for local derived state (per-device cache/index).
    pub fn derived_root(&self) -> &Path {
        &self.derived_root
    }

    /// Path to the legacy SQLite index in the vault: `.arena/index.db`.
    pub fn legacy_index_db_path(&self) -> PathBuf {
        self.arena_dir().join("index.db")
    }

    /// Path to the SQLite index in the local derived store.
    pub fn index_db_path(&self) -> PathBuf {
        self.derived_root.join("index.db")
    }

    /// Path to the legacy thumbnails directory inside the vault:
    /// `.arena/cache/thumbs`.
    pub fn legacy_thumbs_dir(&self) -> PathBuf {
        self.arena_dir().join("cache").join("thumbs")
    }

    /// Path to the thumbnails directory in the local derived store.
    pub fn thumbs_dir(&self) -> PathBuf {
        self.derived_root.join("cache").join("thumbs")
    }

    /// Path to a specific thumbnail in the local derived store:
    /// `<derived_root>/cache/thumbs/slug.jpg`.
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
}

// ─── Slug validation ────────────────────────────────────────────────────────

/// Validate that a slug is safe for use in filesystem paths.
/// Rejects path traversal, separators, NUL bytes, and empty strings.
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
    if slug.contains('/') || slug.contains('\\') {
        return Err(VaultError::InvalidSlug {
            reason: "slug contains path separator".to_string(),
        });
    }
    if slug == "." || slug == ".." || slug.starts_with("../") || slug.starts_with("..\\") {
        return Err(VaultError::InvalidSlug {
            reason: "slug contains path traversal".to_string(),
        });
    }
    Ok(())
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Find the next available slug given a set of existing slugs.
///
/// If `slug` is available, returns it unchanged.
/// If taken, tries `slug-2`, `slug-3`, etc. up to `slug-1000`.
pub fn resolve_slug_conflict(slug: &str, existing: &HashSet<String>) -> Result<String, VaultError> {
    if !existing.contains(slug) {
        return Ok(slug.to_string());
    }

    for n in 2..=1000 {
        let candidate = format!("{}-{}", slug, n);
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
    fn arena_dir() {
        // V3
        assert_eq!(layout().arena_dir(), PathBuf::from("/vault/.arena"));
    }

    #[test]
    fn vault_id_path() {
        assert_eq!(
            layout().vault_id_path(),
            PathBuf::from("/vault/.arena/vault-id")
        );
    }

    #[test]
    fn derived_root_defaults_to_arena_dir() {
        assert_eq!(layout().derived_root(), Path::new("/vault/.arena"));
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
            PathBuf::from("/vault/.arena/index.db")
        );
    }

    #[test]
    fn thumbs_dir() {
        assert_eq!(
            layout().thumbs_dir(),
            PathBuf::from("/vault/.arena/cache/thumbs")
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
    fn thumb_path() {
        // V4
        assert_eq!(
            layout().thumb_path("sunset-tokyo"),
            PathBuf::from("/vault/.arena/cache/thumbs/sunset-tokyo.jpg")
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
        assert!(validate_slug("foo/bar").is_err());
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

    // ── resolve_slug_conflict ───────────────────────────────────────────

    #[test]
    fn conflict_no_conflict() {
        // V5
        let existing = HashSet::new();
        assert_eq!(resolve_slug_conflict("slug", &existing).unwrap(), "slug");
    }

    #[test]
    fn conflict_one_existing() {
        // V6
        let existing: HashSet<String> = ["slug"].iter().map(|s| s.to_string()).collect();
        assert_eq!(resolve_slug_conflict("slug", &existing).unwrap(), "slug-2");
    }

    #[test]
    fn conflict_two_existing() {
        // V7
        let existing: HashSet<String> = ["slug", "slug-2"].iter().map(|s| s.to_string()).collect();
        assert_eq!(resolve_slug_conflict("slug", &existing).unwrap(), "slug-3");
    }

    #[test]
    fn conflict_gap_in_sequence() {
        // V8: slug-2 is free even though slug-3 exists
        let existing: HashSet<String> = ["slug", "slug-3"].iter().map(|s| s.to_string()).collect();
        assert_eq!(resolve_slug_conflict("slug", &existing).unwrap(), "slug-2");
    }

    #[test]
    fn conflict_many_existing() {
        let mut existing = HashSet::new();
        existing.insert("doc".to_string());
        for i in 2..=10 {
            existing.insert(format!("doc-{}", i));
        }
        assert_eq!(resolve_slug_conflict("doc", &existing).unwrap(), "doc-11");
    }

    #[test]
    fn conflict_exhausted_returns_error() {
        let mut existing = HashSet::new();
        existing.insert("slug".to_string());
        for i in 2..=1000 {
            existing.insert(format!("slug-{}", i));
        }
        let result = resolve_slug_conflict("slug", &existing);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("slug"));
    }
}
