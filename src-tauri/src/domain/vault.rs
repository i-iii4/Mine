// Vault: path computation for the vault filesystem layout.
//
// Pure path logic: no filesystem access. Computes paths to blocks,
// media files, arena directory, index DB, and thumbnails.
// Also resolves slug conflicts given a set of existing slugs.
//
// Contract: SPEC_DOMAIN.md#domain/vault

use std::collections::HashSet;
use std::path::{Path, PathBuf};

// ─── Types ──────────────────────────────────────────────────────────────────

/// Computes paths within a vault based on its root directory.
/// Does NOT access the filesystem.
#[derive(Debug, Clone)]
pub struct VaultLayout {
    root: PathBuf,
}

impl VaultLayout {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The vault root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Path to a block's .md file: `root/slug.md`.
    pub fn block_path(&self, slug: &str) -> PathBuf {
        self.root.join(format!("{}.md", slug))
    }

    /// Path to a block's media file: `root/slug.ext`.
    pub fn media_path(&self, slug: &str, ext: &str) -> PathBuf {
        let ext = ext.strip_prefix('.').unwrap_or(ext);
        self.root.join(format!("{}.{}", slug, ext))
    }

    /// Path to the `.arena/` directory.
    pub fn arena_dir(&self) -> PathBuf {
        self.root.join(".arena")
    }

    /// Path to the SQLite index: `.arena/index.db`.
    pub fn index_db_path(&self) -> PathBuf {
        self.root.join(".arena").join("index.db")
    }

    /// Path to the thumbnails directory: `.arena/cache/thumbs/`.
    pub fn thumbs_dir(&self) -> PathBuf {
        self.root.join(".arena").join("cache").join("thumbs")
    }

    /// Path to a specific thumbnail: `.arena/cache/thumbs/slug.webp`.
    pub fn thumb_path(&self, slug: &str) -> PathBuf {
        self.thumbs_dir().join(format!("{}.webp", slug))
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Find the next available slug given a set of existing slugs.
///
/// If `slug` is available, returns it unchanged.
/// If taken, tries `slug-2`, `slug-3`, etc. up to `slug-1000`.
pub fn resolve_slug_conflict(slug: &str, existing: &HashSet<String>) -> String {
    if !existing.contains(slug) {
        return slug.to_string();
    }

    for n in 2..=1000 {
        let candidate = format!("{}-{}", slug, n);
        if !existing.contains(&candidate) {
            return candidate;
        }
    }

    // Should never happen in practice
    panic!(
        "could not resolve slug conflict for '{}' after 1000 attempts",
        slug
    );
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
        assert_eq!(layout().block_path("sunset-tokyo"), PathBuf::from("/vault/sunset-tokyo.md"));
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
    fn thumb_path() {
        // V4
        assert_eq!(
            layout().thumb_path("sunset-tokyo"),
            PathBuf::from("/vault/.arena/cache/thumbs/sunset-tokyo.webp")
        );
    }

    #[test]
    fn root() {
        assert_eq!(layout().root(), Path::new("/vault"));
    }

    // ── resolve_slug_conflict ───────────────────────────────────────────

    #[test]
    fn conflict_no_conflict() {
        // V5
        let existing = HashSet::new();
        assert_eq!(resolve_slug_conflict("slug", &existing), "slug");
    }

    #[test]
    fn conflict_one_existing() {
        // V6
        let existing: HashSet<String> = ["slug"].iter().map(|s| s.to_string()).collect();
        assert_eq!(resolve_slug_conflict("slug", &existing), "slug-2");
    }

    #[test]
    fn conflict_two_existing() {
        // V7
        let existing: HashSet<String> = ["slug", "slug-2"].iter().map(|s| s.to_string()).collect();
        assert_eq!(resolve_slug_conflict("slug", &existing), "slug-3");
    }

    #[test]
    fn conflict_gap_in_sequence() {
        // V8: slug-2 is free even though slug-3 exists
        let existing: HashSet<String> = ["slug", "slug-3"].iter().map(|s| s.to_string()).collect();
        assert_eq!(resolve_slug_conflict("slug", &existing), "slug-2");
    }

    #[test]
    fn conflict_many_existing() {
        let mut existing = HashSet::new();
        existing.insert("doc".to_string());
        for i in 2..=10 {
            existing.insert(format!("doc-{}", i));
        }
        assert_eq!(resolve_slug_conflict("doc", &existing), "doc-11");
    }
}
