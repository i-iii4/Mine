// Files: filesystem operations for blocks and media.
//
// Writes .md files, reads them back, scans vault directories,
// copies media files, and deletes block-related files.
//
// Contract: SPEC_STORAGE.md#storage/files

use anyhow::{Context, Result};
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::domain::block::{
    derive_card_kind, derive_title_fields, serialize_block, strip_first_markdown_h1, Block,
    CardKind,
};
use crate::domain::vault::VaultLayout;
use crate::storage::{article_audio, index, media_refs, thumbnails};

// ─── Public API ─────────────────────────────────────────────────────────────

/// Write a block to its .md file in the vault.
/// Creates parent directories if needed. Returns the path of the written file.
pub fn write_block_file(vault: &VaultLayout, block: &Block) -> Result<PathBuf> {
    let path = vault.block_path(&block.slug);
    let content = serialize_block(block);

    write_atomically(&path, content.as_bytes())
        .with_context(|| format!("failed to write block file: {}", path.display()))?;

    Ok(path)
}

/// Atomically write bytes to `path`: write a temp file in the same directory,
/// fsync it, then rename over the destination. A crash leaves either the old
/// file or the complete new one, never a truncated `.md`. The vault is the
/// durable, iCloud-synced source of truth, so partial `.md` writes must never
/// be observable (mirrors `thumbnails::write_thumb_atomically` for derived
/// files).
pub fn write_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("block");
    let tmp = path.with_file_name(format!(
        "{file_name}.tmp.{}.{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));

    let write_result = (|| -> Result<()> {
        let mut file = std::fs::File::create(&tmp)
            .with_context(|| format!("failed to create temp file: {}", tmp.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("failed to write temp file: {}", tmp.display()))?;
        file.sync_all()
            .with_context(|| format!("failed to fsync temp file: {}", tmp.display()))?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    std::fs::rename(&tmp, path).with_context(|| {
        format!(
            "failed to rename temp file {} -> {}",
            tmp.display(),
            path.display()
        )
    })?;
    Ok(())
}

/// Write a new block file without overwriting an existing user file.
pub fn write_new_block_file(vault: &VaultLayout, block: &Block) -> Result<PathBuf> {
    let path = vault.block_path(&block.slug);
    let content = serialize_block(block);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .with_context(|| format!("failed to create block file: {}", path.display()))?;
    file.write_all(content.as_bytes())
        .with_context(|| format!("failed to write block file: {}", path.display()))?;

    Ok(path)
}

/// Read a .md file and return (path-based slug, raw_content).
pub fn read_block_file(vault: &VaultLayout, path: &Path) -> Result<(String, String)> {
    let slug = vault
        .slug_for_path(path)
        .map_err(|e| anyhow::anyhow!(e.to_string()))
        .with_context(|| format!("invalid vault-relative file path: {}", path.display()))?;
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read file: {}", path.display()))?;

    Ok((slug, content))
}

/// Scan the vault for all .md files recursively.
/// Ignores hidden/service directories (`.mine`, `.obsidian`, `.git`,
/// `.mine-migration-backup`) and non-.md files.
/// Returns paths sorted alphabetically.
pub fn scan_md_files(vault: &VaultLayout) -> Result<Vec<PathBuf>> {
    let root = vault.root();
    let mut paths = Vec::new();
    scan_md_files_inner(root, &mut paths)
        .with_context(|| format!("failed to read vault directory: {}", root.display()))?;

    paths.sort();
    Ok(paths)
}

fn scan_md_files_inner(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if is_ignored_vault_dir(&path) {
                continue;
            }
            scan_md_files_inner(&path, paths)?;
            continue;
        }
        if file_type.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            paths.push(path);
        }
    }
    Ok(())
}

pub fn is_ignored_vault_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with('.') || matches!(name, "node_modules" | "target" | "__pycache__")
        })
}

/// Normalize local frontmatter/body media refs for indexing.
///
/// Obsidian interprets local refs relative to the note. Mine's frontend and
/// preview manifest consume root-relative paths, so the index stores resolved
/// root-relative values without rewriting the source markdown.
pub fn normalize_block_media_refs_for_index(vault: &VaultLayout, block: &mut Block) {
    if let Some(file) = block.frontmatter.file.clone() {
        if let Some(resolved) = media_refs::resolve_frontmatter_media(vault, &block.slug, &file) {
            if let Some(root_relative) = vault.root_relative_reference(&resolved) {
                block.frontmatter.file = Some(root_relative);
            }
        }
    }
    if let Some(thumbnail) = block.frontmatter.thumbnail.clone() {
        if let Some(resolved) =
            media_refs::resolve_frontmatter_media(vault, &block.slug, &thumbnail)
        {
            if let Some(root_relative) = vault.root_relative_reference(&resolved) {
                block.frontmatter.thumbnail = Some(root_relative);
            }
        }
    }
}

/// Copy a media file into the vault with slug-based naming.
/// Preserves the original extension. Returns the destination path.
pub fn copy_media_file(source: &Path, vault: &VaultLayout, slug: &str) -> Result<PathBuf> {
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("bin");

    let dest = vault.media_path(slug, ext);

    std::fs::copy(source, &dest)
        .with_context(|| format!("failed to copy media to {}", dest.display()))?;

    Ok(dest)
}

/// Copy a media file into the vault without overwriting an existing user file.
pub fn copy_new_media_file(source: &Path, vault: &VaultLayout, slug: &str) -> Result<PathBuf> {
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let dest = vault.media_path(slug, ext);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let mut src = std::fs::File::open(source)
        .with_context(|| format!("failed to open media source: {}", source.display()))?;
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dest)
        .with_context(|| format!("failed to create media file: {}", dest.display()))?;
    std::io::copy(&mut src, &mut out)
        .with_context(|| format!("failed to copy media to {}", dest.display()))?;

    Ok(dest)
}

/// Delete a user-owned file.
///
/// Moves to OS trash when available, then falls back to permanent delete for
/// filesystems where trashing fails (notably some iCloud placeholder states).
pub fn delete_user_file(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }

    let trashed = {
        #[cfg(not(target_os = "ios"))]
        {
            trash::delete(path).is_ok()
        }
        #[cfg(target_os = "ios")]
        {
            false
        }
    };
    if !trashed {
        std::fs::remove_file(path)
            .with_context(|| format!("failed to delete: {}", path.display()))?;
    }

    Ok(())
}

/// Delete a block's .md file and optional media file.
/// Also removes the thumbnail (best-effort). Non-existent files are silently ignored.
pub fn delete_block_files(vault: &VaultLayout, slug: &str, media_ext: Option<&str>) -> Result<()> {
    let md_path = vault.block_path(slug);
    delete_user_file(&md_path)?;

    if let Some(ext) = media_ext {
        let media_path = vault.media_path(slug, ext);
        delete_user_file(&media_path)?;
    }

    // Permanently delete thumbnail (generated cache, not user content)
    let thumb_path = vault.thumb_path(slug);
    if thumb_path.exists() {
        let _ = std::fs::remove_file(&thumb_path);
    }

    Ok(())
}

/// Delete a block's .md file plus an explicit list of resolved media files.
///
/// The caller owns media resolution and sharing checks. This function only
/// performs the final file operation and removes derived thumbnail cache.
pub fn delete_block_files_with_media_paths(
    vault: &VaultLayout,
    slug: &str,
    media_paths: &[PathBuf],
) -> Result<()> {
    let md_path = vault.block_path(slug);
    delete_user_file(&md_path)?;

    for media_path in media_paths {
        delete_user_file(media_path)?;
    }

    let thumb_path = vault.thumb_path(slug);
    if thumb_path.exists() {
        let _ = std::fs::remove_file(&thumb_path);
    }

    Ok(())
}

/// Rename derived-store artifacts that are keyed by block slug.
///
/// Source-of-truth files in the vault are handled separately by rename flows;
/// this helper only migrates local cache/state under the derived store so the
/// new slug keeps thumbnails and article-audio progress.
pub fn rename_derived_artifacts(vault: &VaultLayout, old_slug: &str, new_slug: &str) -> Result<()> {
    if old_slug == new_slug {
        return Ok(());
    }

    let old_thumb = vault.thumb_path(old_slug);
    if old_thumb.exists() {
        let new_thumb = vault.thumb_path(new_slug);
        anyhow::ensure!(
            !new_thumb.exists(),
            "target thumbnail already exists: {}",
            new_thumb.display()
        );
        if let Some(parent) = new_thumb.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create directory: {}", parent.display()))?;
        }
        std::fs::rename(&old_thumb, &new_thumb).with_context(|| {
            format!(
                "failed to rename thumbnail {} -> {}",
                old_thumb.display(),
                new_thumb.display()
            )
        })?;
    }

    article_audio::rename_all_artifacts(vault, old_slug, new_slug)?;
    Ok(())
}

// ─── Block creation orchestration ────────────────────────────────────────────

/// Persist a new block: write .md file, copy media, generate thumbnail, index.
/// Returns the fully indexed block. The caller is responsible for constructing
/// the `Block` with a unique slug (see `index::resolve_unique_slug`).
pub fn persist_new_block(
    conn: &Connection,
    vault: &VaultLayout,
    block: &Block,
    source_file: Option<&Path>,
) -> Result<index::IndexedBlock> {
    let block_path = vault.block_path(&block.slug);
    anyhow::ensure!(
        !block_path.exists(),
        "block file already exists: {}",
        block_path.display()
    );

    // Copy media before creating the markdown file so a media-copy failure
    // does not leave an orphaned block document behind.
    let mut copied_media: Option<PathBuf> = None;
    if let Some(source) = source_file {
        let canonical = source
            .canonicalize()
            .with_context(|| format!("invalid file path: {}", source.display()))?;
        anyhow::ensure!(canonical.is_file(), "path is not a file");

        copied_media = Some(copy_new_media_file(&canonical, vault, &block.slug)?);
    }

    if let Err(error) = write_new_block_file(vault, block) {
        if let Some(path) = copied_media {
            let _ = std::fs::remove_file(path);
        }
        return Err(error);
    }

    // Generate thumbnail after the source files exist. Thumbnail generation is
    // best effort and never rolls back the user-owned block/media files.
    if let Some(source) = source_file {
        let canonical = source
            .canonicalize()
            .with_context(|| format!("invalid file path: {}", source.display()))?;
        let ext = canonical.extension().and_then(|e| e.to_str()).unwrap_or("");
        if is_image_ext(ext) {
            let media_dest = vault.media_path(&block.slug, ext);
            let thumb_dest = vault.thumb_path(&block.slug);
            let _ = thumbnails::generate_thumbnail(
                &media_dest,
                &thumb_dest,
                thumbnails::DEFAULT_MAX_SIZE,
            );
        }
    } else if derive_card_kind(block) == CardKind::Article {
        let thumb_dest = vault.thumb_path(&block.slug);
        let title_fields =
            derive_title_fields(&block.slug, block.frontmatter.title.as_deref(), &block.body);
        let preview_body = strip_first_markdown_h1(&block.body);
        let _ = thumbnails::generate_text_thumbnail(
            title_fields.display_title.as_deref(),
            &preview_body,
            &thumb_dest,
        );
    }

    // Index
    index::upsert_block(conn, block, Some(vault.root()))?;
    let _ = index::sync_thumb_metadata(
        conn,
        &block.slug,
        &vault.thumb_path(&block.slug),
        Some(vault.root()),
    );

    // Return the indexed block
    index::get_block(conn, &block.slug)?
        .ok_or_else(|| anyhow::anyhow!("block not found after creation"))
}

/// Persist a new block whose `frontmatter.file` already points to a media file
/// in the vault. This intentionally does not copy or take ownership of the
/// referenced media; only the `.md`, derived thumbnail, and index row are new.
pub fn persist_new_reference_block(
    conn: &Connection,
    vault: &VaultLayout,
    block: &Block,
) -> Result<index::IndexedBlock> {
    write_new_block_file(vault, block)?;
    let _ = thumbnails::generate_for_block(block, vault);
    index::upsert_block(conn, block, Some(vault.root()))?;
    let _ = index::sync_thumb_metadata(
        conn,
        &block.slug,
        &vault.thumb_path(&block.slug),
        Some(vault.root()),
    );

    index::get_block(conn, &block.slug)?
        .ok_or_else(|| anyhow::anyhow!("block not found after creation"))
}

/// Image extensions the bundled `image` crate can decode for thumbnail
/// generation. Intentionally narrower than `preview_plan::is_image_ext` (which
/// classifies feed media broadly): AVIF/HEIC are excluded here because the
/// decoder cannot read them, so attempting a thumbnail would only fail. Kept
/// separate from `media_dimensions` for the same decoder-capability reason.
fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | "tif"
    )
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{parse_block, BlockType, DateTime, Frontmatter};

    fn make_vault(dir: &Path) -> VaultLayout {
        VaultLayout::new(dir.to_path_buf())
    }

    fn make_test_block(slug: &str) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Image,
                title: Some("Test Image".to_string()),
                description: None,
                url: None,
                file: Some(format!("{}.jpg", slug)),
                thumbnail: None,
                tags: vec!["test".to_string()],
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-01-15T12:00:00Z").unwrap(),
                source: None,
                width: Some(1920),
                height: Some(1080),
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: String::new(),
        }
    }

    // ── write_block_file + read_block_file ───────────────────────────────

    #[test]
    fn write_and_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let block = make_test_block("sunset");

        let path = write_block_file(&vault, &block).unwrap();
        assert!(path.exists());
        assert_eq!(path, vault.block_path("sunset"));

        let (slug, content) = read_block_file(&vault, &path).unwrap();
        assert_eq!(slug, "sunset");

        let parsed = parse_block(&slug, &content).unwrap();
        assert_eq!(parsed.frontmatter.block_type, BlockType::Image);
        assert_eq!(parsed.frontmatter.title.as_deref(), Some("Test Image"));
        assert_eq!(parsed.frontmatter.tags, vec!["test"]);
    }

    #[test]
    fn write_new_block_file_refuses_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let block = make_test_block("sunset");
        std::fs::write(vault.block_path("sunset"), "existing").unwrap();

        let result = write_new_block_file(&vault, &block);

        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(vault.block_path("sunset")).unwrap(),
            "existing"
        );
    }

    // ── scan_md_files ────────────────────────────────────────────────────

    #[test]
    fn scan_finds_md_files() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        // Create some .md files
        std::fs::write(vault.block_path("alpha"), "---\n---").unwrap();
        std::fs::write(vault.block_path("beta"), "---\n---").unwrap();

        // Create a non-.md file (should be ignored)
        std::fs::write(dir.path().join("photo.jpg"), b"fake image").unwrap();

        let paths = scan_md_files(&vault).unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths[0].ends_with("alpha.md"));
        assert!(paths[1].ends_with("beta.md"));
    }

    #[test]
    fn scan_ignores_directories() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        std::fs::write(vault.block_path("note"), "---\n---").unwrap();
        std::fs::create_dir_all(vault.mine_dir()).unwrap();

        let paths = scan_md_files(&vault).unwrap();
        assert_eq!(paths.len(), 1);
    }

    #[test]
    fn scan_empty_vault() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let paths = scan_md_files(&vault).unwrap();
        assert!(paths.is_empty());
    }

    // ── copy_media_file ──────────────────────────────────────────────────

    #[test]
    fn copy_media_preserves_extension() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        let source = dir.path().join("original.png");
        std::fs::write(&source, b"fake png data").unwrap();

        let dest = copy_media_file(&source, &vault, "my-image").unwrap();
        assert_eq!(dest, vault.media_path("my-image", "png"));
        assert!(dest.exists());

        let content = std::fs::read(&dest).unwrap();
        assert_eq!(content, b"fake png data");
    }

    #[test]
    fn copy_new_media_file_refuses_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        let source = dir.path().join("original.png");
        std::fs::write(&source, b"new data").unwrap();
        std::fs::write(vault.media_path("my-image", "png"), b"existing data").unwrap();

        let result = copy_new_media_file(&source, &vault, "my-image");

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(vault.media_path("my-image", "png")).unwrap(),
            b"existing data"
        );
    }

    // ── delete_block_files ───────────────────────────────────────────────

    #[test]
    fn delete_md_only() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        std::fs::write(vault.block_path("note"), "content").unwrap();
        delete_block_files(&vault, "note", None).unwrap();
        assert!(!vault.block_path("note").exists());
    }

    #[test]
    fn delete_md_and_media() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());

        std::fs::write(vault.block_path("photo"), "frontmatter").unwrap();
        std::fs::write(vault.media_path("photo", "jpg"), b"image data").unwrap();

        delete_block_files(&vault, "photo", Some("jpg")).unwrap();
        assert!(!vault.block_path("photo").exists());
        assert!(!vault.media_path("photo", "jpg").exists());
    }

    #[test]
    fn delete_nonexistent_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        // Should not error
        delete_block_files(&vault, "nope", Some("jpg")).unwrap();
    }
}
