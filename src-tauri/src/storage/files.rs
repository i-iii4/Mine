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
use crate::storage::source_mutation::{SourceFileWrite, StagedSourceMutation};
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
    let tmp = prepare_temp_file(path, |file| file.write_all(bytes))?;
    if let Err(error) = std::fs::rename(&tmp, path).with_context(|| {
        format!(
            "failed to rename temp file {} -> {}",
            tmp.display(),
            path.display()
        )
    }) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    sync_parent_directory(path)?;
    Ok(())
}

/// Atomically publish a new file without replacing an existing destination.
/// The complete fsynced temp inode is linked under the final name in one
/// operation, preserving create-new semantics without exposing partial bytes.
pub fn write_new_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = prepare_temp_file(path, |file| file.write_all(bytes))?;
    if let Err(error) = std::fs::hard_link(&tmp, path).with_context(|| {
        format!(
            "failed to publish new file {} -> {}",
            tmp.display(),
            path.display()
        )
    }) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    let _ = std::fs::remove_file(&tmp);
    sync_parent_directory(path)?;
    Ok(())
}

/// Atomically copy a file to a destination that must not already exist.
pub fn copy_new_atomically(source: &Path, destination: &Path) -> Result<()> {
    let mut source_file = std::fs::File::open(source)
        .with_context(|| format!("failed to open media source: {}", source.display()))?;
    let tmp = prepare_temp_file(destination, |file| {
        std::io::copy(&mut source_file, file).map(|_| ())
    })?;
    if let Err(error) = std::fs::hard_link(&tmp, destination).with_context(|| {
        format!(
            "failed to publish copied file {} -> {}",
            tmp.display(),
            destination.display()
        )
    }) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    let _ = std::fs::remove_file(&tmp);
    sync_parent_directory(destination)?;
    Ok(())
}

fn copy_atomically(source: &Path, destination: &Path) -> Result<()> {
    let mut source_file = std::fs::File::open(source)
        .with_context(|| format!("failed to open media source: {}", source.display()))?;
    let tmp = prepare_temp_file(destination, |file| {
        std::io::copy(&mut source_file, file).map(|_| ())
    })?;
    if let Err(error) = std::fs::rename(&tmp, destination).with_context(|| {
        format!(
            "failed to publish copied file {} -> {}",
            tmp.display(),
            destination.display()
        )
    }) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    sync_parent_directory(destination)?;
    Ok(())
}

pub(crate) fn prepare_temp_file(
    path: &Path,
    writer: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("file has no parent directory: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp = path.with_file_name(format!(
        "{file_name}.tmp.{}.{}.{}",
        std::process::id(),
        nonce,
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .with_context(|| format!("failed to create temp file: {}", tmp.display()))?;
        writer(&mut file)
            .with_context(|| format!("failed to write temp file: {}", tmp.display()))?;
        file.sync_all()
            .with_context(|| format!("failed to fsync temp file: {}", tmp.display()))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(tmp)
}

pub(crate) fn sync_parent_directory(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("file has no parent directory: {}", path.display()))?;
    let directory = std::fs::File::open(parent)
        .with_context(|| format!("failed to open directory for fsync: {}", parent.display()))?;
    directory
        .sync_all()
        .with_context(|| format!("failed to fsync directory: {}", parent.display()))
}

/// Write a new block file without overwriting an existing user file.
pub fn write_new_block_file(vault: &VaultLayout, block: &Block) -> Result<PathBuf> {
    let path = vault.block_path(&block.slug);
    let content = serialize_block(block);
    write_new_atomically(&path, content.as_bytes())
        .with_context(|| format!("failed to create block file: {}", path.display()))?;

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

    copy_atomically(source, &dest)
        .with_context(|| format!("failed to copy media to {}", dest.display()))?;

    Ok(dest)
}

/// Copy a media file into the vault without overwriting an existing user file.
pub fn copy_new_media_file(source: &Path, vault: &VaultLayout, slug: &str) -> Result<PathBuf> {
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let dest = vault.media_path(slug, ext);

    copy_new_atomically(source, &dest)
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

    let canonical_source = source_file
        .map(|source| {
            let canonical = source
                .canonicalize()
                .with_context(|| format!("invalid file path: {}", source.display()))?;
            anyhow::ensure!(canonical.is_file(), "path is not a file");
            Ok::<PathBuf, anyhow::Error>(canonical)
        })
        .transpose()?;
    let mut writes = Vec::with_capacity(2);
    if let Some(source) = canonical_source.as_ref() {
        let ext = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("bin");
        writes.push(SourceFileWrite::create_from_file(
            vault.media_path(&block.slug, ext),
            source.clone(),
        ));
    }
    writes.push(SourceFileWrite::create(
        block_path,
        serialize_block(block).into_bytes(),
    ));
    commit_new_block_source(conn, vault, block, writes)?;

    // Generate thumbnail after the source files exist. Thumbnail generation is
    // best effort and never rolls back the user-owned block/media files.
    if let Some(canonical) = canonical_source.as_ref() {
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
    commit_new_block_source(
        conn,
        vault,
        block,
        vec![SourceFileWrite::create(
            vault.block_path(&block.slug),
            serialize_block(block).into_bytes(),
        )],
    )?;
    let _ = thumbnails::generate_for_block(block, vault);
    let _ = index::sync_thumb_metadata(
        conn,
        &block.slug,
        &vault.thumb_path(&block.slug),
        Some(vault.root()),
    );

    index::get_block(conn, &block.slug)?
        .ok_or_else(|| anyhow::anyhow!("block not found after creation"))
}

fn commit_new_block_source(
    conn: &Connection,
    vault: &VaultLayout,
    block: &Block,
    writes: Vec<SourceFileWrite>,
) -> Result<()> {
    let staged = StagedSourceMutation::stage(writes)?;
    staged.commit_with_index(conn, "create_block", |index_conn| {
        index::upsert_block(index_conn, block, Some(vault.root())).map(|_| ())
    })?;
    Ok(())
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
    use crate::storage::db;

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
        assert!(!std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp.")));
    }

    #[test]
    fn sc0_n1_competing_create_new_writers_preserve_the_winner() {
        use std::sync::{Arc, Barrier};

        // SC0 characterization of the real publication primitive, not a
        // simulated filesystem. A barrier releases both writers together.
        let dir = tempfile::tempdir().expect("create disposable SC0 directory");
        let destination = dir.path().join("note.md");
        let payloads = [b"complete writer A".to_vec(), b"complete writer B".to_vec()];
        let barrier = Arc::new(Barrier::new(payloads.len()));
        let writers: Vec<_> = payloads
            .into_iter()
            .map(|payload| {
                let barrier = Arc::clone(&barrier);
                let destination = destination.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let result = write_new_atomically(&destination, &payload);
                    (payload, result)
                })
            })
            .collect();
        let results: Vec<_> = writers
            .into_iter()
            .map(|writer| writer.join().expect("SC0 writer must not panic"))
            .collect();

        assert_eq!(
            results.iter().filter(|(_, result)| result.is_ok()).count(),
            1
        );
        let winner = results
            .iter()
            .find(|(_, result)| result.is_ok())
            .expect("exactly one writer published");
        let loser = results
            .iter()
            .find_map(|(_, result)| result.as_ref().err())
            .expect("one writer encountered the occupied destination");
        let io_error = loser
            .chain()
            .find_map(|source| source.downcast_ref::<std::io::Error>())
            .expect("publication error retains its underlying IO error");
        assert_eq!(io_error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&destination).expect("read winner"), winner.0);

        let occupied = write_new_atomically(&destination, b"replacement attempt")
            .expect_err("an already occupied path must reject another publication");
        assert!(occupied.chain().any(|source| {
            source
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists)
        }));
        assert_eq!(std::fs::read(&destination).expect("reread winner"), winner.0);
        assert!(!std::fs::read_dir(dir.path())
            .expect("inspect disposable directory")
            .map(|entry| entry.expect("read directory entry"))
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp.")));
        eprintln!(
            "SC0 N1: one complete winner; loser=AlreadyExists; occupied bytes unchanged; no temporary files; winner_bytes={:?}",
            std::str::from_utf8(&winner.0).expect("SC0 payloads are ASCII")
        );
    }

    #[test]
    fn failed_temp_write_leaves_no_final_or_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("note.md");

        let result = prepare_temp_file(&destination, |file| {
            std::io::Write::write_all(file, b"partial")?;
            Err(std::io::Error::other("injected write failure"))
        });

        assert!(result.is_err());
        assert!(!destination.exists());
        assert!(!std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp.")));
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
        assert!(!std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp.")));
    }

    #[test]
    fn persist_new_block_removes_markdown_and_media_when_index_commit_fails() {
        let dir = tempfile::tempdir().unwrap();
        let vault = make_vault(dir.path());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let source = dir.path().join("source.png");
        std::fs::write(&source, b"media bytes").unwrap();
        let mut block = make_test_block("Rejected");
        block.frontmatter.file = Some("Rejected.png".to_string());
        conn.execute_batch(
            "CREATE TRIGGER reject_new_block
             BEFORE INSERT ON blocks
             WHEN new.slug = 'Rejected'
             BEGIN
                 SELECT RAISE(ABORT, 'injected create failure');
             END;",
        )
        .unwrap();

        let result = persist_new_block(&conn, &vault, &block, Some(&source));

        assert!(result.is_err());
        assert!(!vault.block_path("Rejected").exists());
        assert!(!vault.media_path("Rejected", "png").exists());
        assert!(index::get_block(&conn, "Rejected").unwrap().is_none());
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
