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

mod replacement_metadata;

/// Publication completed before its directory durability could be confirmed.
/// Callers must not interpret this error as proof that no final file exists.
#[derive(Debug, thiserror::Error)]
#[error("file was published but durability is unconfirmed at {path}: {source}")]
pub struct PublicationUncertain {
    pub path: PathBuf,
    #[source]
    pub source: anyhow::Error,
}

/// Whether an error occurred after publication rather than before it.
pub fn publication_is_uncertain(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<PublicationUncertain>())
}

fn sync_published_parent(path: &Path) -> Result<()> {
    sync_parent_directory(path).map_err(|source| {
        PublicationUncertain {
            path: path.to_path_buf(),
            source,
        }
        .into()
    })
}

/// Reject known symlink/traversal targets before a source write. The root may
/// itself be a user-selected symlink; descendants must stay in that root.
pub fn validate_vault_write_target(vault: &VaultLayout, path: &Path) -> Result<()> {
    use std::path::Component;
    let relative = path
        .strip_prefix(vault.root())
        .context("target escapes vault root")?;
    let mut current = vault
        .root()
        .canonicalize()
        .context("vault root is unavailable")?;
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            anyhow::bail!("invalid vault-relative write target: {}", path.display());
        };
        current.push(segment);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                anyhow::bail!(
                    "refusing symlink in source write target: {}",
                    current.display()
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Write a block to its .md file in the vault, for test fixtures.
/// Creates parent directories if needed. Returns the path of the written file.
///
/// Test-only: it rebuilds the note from the model and would drop what the
/// model does not know. Application code changes an existing note through
/// `source_patch::apply_block_changes` (SPEC_AUDIT_FIXES.md, Ф1).
#[cfg(test)]
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
    let _write = crate::storage::source_mutation::begin_write()?;
    let tmp = match std::fs::symlink_metadata(path) {
        Ok(_) => prepare_replacement_temp_file(path, path, |file| file.write_all(bytes))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            prepare_temp_file(path, |file| file.write_all(bytes))?
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    };
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
    sync_published_parent(path)?;
    Ok(())
}

/// A publication or a rollback met bytes at the destination that this
/// operation did not put there: the file was edited outside Mine meanwhile.
/// The foreign version stays live; nothing of it is overwritten.
#[derive(Debug, thiserror::Error)]
#[error("{} changed outside Mine during the operation{}", path.display(), preserved_note(preserved))]
pub struct SourceChanged {
    pub path: PathBuf,
    /// Where a second foreign version, displaced by a race with the restore
    /// itself, was kept.
    pub preserved: Option<PathBuf>,
}

fn preserved_note(preserved: &Option<PathBuf>) -> String {
    preserved
        .as_ref()
        .map(|path| format!("; displaced version kept at {}", path.display()))
        .unwrap_or_default()
}

/// Whether an error means an outside edit won over this operation.
pub fn source_changed(error: &anyhow::Error) -> Option<&SourceChanged> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<SourceChanged>())
}

/// Identity of a published file: an atomic replacement changes the inode, an
/// in-place edit changes the size or the modification time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileFingerprint {
    dev: u64,
    ino: u64,
    len: u64,
    modified_ns: u128,
}

pub(crate) fn fingerprint(path: &Path) -> Result<FileFingerprint> {
    use std::os::unix::fs::MetadataExt;
    let metadata =
        std::fs::symlink_metadata(path).with_context(|| format!("stat {}", path.display()))?;
    Ok(FileFingerprint {
        dev: metadata.dev(),
        ino: metadata.ino(),
        len: metadata.len(),
        modified_ns: metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    })
}

/// Where displaced versions found during a race are kept: the space's
/// `.mine` folder when the file lives in a space, otherwise next to the file.
pub(crate) fn conflict_dir_for(path: &Path) -> PathBuf {
    path.ancestors()
        .skip(1)
        .find(|dir| dir.join(".mine").is_dir())
        .map(|root| root.join(".mine").join("source-conflicts"))
        .unwrap_or_else(|| {
            path.parent()
                .unwrap_or_else(|| Path::new("."))
                .join(".mine-source-conflicts")
        })
}

/// A unique hidden sibling name for moving a file aside.
pub(crate) fn aside_path(path: &Path, purpose: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static ASIDE_SEQ: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("source");
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(
        ".{name}.mine-{purpose}.{}.{}.{}",
        std::process::id(),
        nonce,
        ASIDE_SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Whether `a` and `b` name one directory entry: the same file under the same
/// name, spelled the same or, where the disk ignores letter case (the macOS
/// default), in another case. Two names of one file (hard links) are two
/// entries, and a path that names nothing is no entry. A rename to another
/// spelling of its own name is not taken by another file (06.10.2026,
/// SPEC_IDENTITY_ROBUSTNESS.md, «In-app rename»).
pub(crate) fn names_same_entry(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Ok(first), Ok(second)) = (std::fs::symlink_metadata(a), std::fs::symlink_metadata(b))
    else {
        return false;
    };
    if (first.dev(), first.ino()) != (second.dev(), second.ino()) {
        return false;
    }
    // One file may have several names. The disk resolves a path to the
    // spelling its entry is written in, so one entry gives one path.
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod exchange {
    use anyhow::Result;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    unsafe extern "C" {
        fn renamex_np(
            from: *const std::ffi::c_char,
            to: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    const RENAME_SWAP: u32 = 0x0000_0002;
    const RENAME_EXCL: u32 = 0x0000_0004;

    fn renamex(from: &Path, to: &Path, flags: u32) -> std::io::Result<()> {
        let from = CString::new(from.as_os_str().as_bytes())?;
        let to = CString::new(to.as_os_str().as_bytes())?;
        let status = unsafe { renamex_np(from.as_ptr(), to.as_ptr(), flags) };
        if status != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// Exchange two paths in one step.
    pub(super) fn swap(a: &Path, b: &Path) -> Result<()> {
        Ok(renamex(a, b, RENAME_SWAP)?)
    }

    /// Move `from` to `to` in one step, refusing when `to` exists.
    pub(super) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
        renamex(from, to, RENAME_EXCL)
    }
}

/// Move a file in one step without replacing anything at the destination.
/// Whatever version is at `from` at that moment moves, edits included.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> Result<()> {
    exchange::rename_exclusive(from, to)
        .map_err(anyhow::Error::from)
        .with_context(|| format!("move {} -> {}", from.display(), to.display()))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> Result<()> {
    anyhow::bail!(
        "exclusive move is unavailable on this platform: {} -> {}",
        from.display(),
        to.display()
    )
}

/// Move a file without replacing anything at the destination, across volumes
/// too: a download in the derived store may land in a space on another disk.
/// Across volumes the file is copied to a new name and the source removed.
pub(crate) fn move_exclusive(from: &Path, to: &Path) -> Result<()> {
    match rename_exclusive(from, to) {
        Ok(()) => Ok(()),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .and_then(std::io::Error::raw_os_error)
                == Some(libc::EXDEV) =>
        {
            copy_new_atomically(from, to)?;
            std::fs::remove_file(from).with_context(|| format!("remove {}", from.display()))?;
            sync_parent_directory(from)
        }
        Err(error) => Err(error),
    }
}

/// Remove `path` only while it is still the file this operation published.
/// The file is moved aside in one step first, so a version written meanwhile
/// is never deleted: a mismatch moves it back.
pub(crate) fn remove_if_unchanged(path: &Path, published: &FileFingerprint) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    }
    let aside = aside_path(path, "rollback");
    std::fs::rename(path, &aside).with_context(|| format!("move aside {}", path.display()))?;
    if fingerprint(&aside)? == *published {
        std::fs::remove_file(&aside).with_context(|| format!("remove {}", aside.display()))?;
        sync_parent_directory(path)?;
        return Ok(());
    }
    match rename_exclusive(&aside, path) {
        Ok(()) => {
            sync_parent_directory(path)?;
            Err(SourceChanged {
                path: path.to_path_buf(),
                preserved: None,
            }
            .into())
        }
        Err(_) => Err(SourceChanged {
            path: path.to_path_buf(),
            preserved: Some(aside),
        }
        .into()),
    }
}

/// Publish a link repair while retaining any concurrent editor version.
/// The atomic exchange gives us the exact inode displaced at publication,
/// including an editor write that ignored Mine's advisory lock.
pub(crate) fn write_atomically_if_unchanged(
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
    conflict_dir: &Path,
) -> Result<()> {
    let _write = crate::storage::source_mutation::begin_write()?;
    let tmp = prepare_replacement_temp_file(path, path, |file| file.write_all(replacement))?;
    exchange_if_unchanged(&tmp, path, expected, replacement, conflict_dir)
}

/// Swap the staged `tmp` (holding `replacement`) into `path` when `path`
/// still holds `expected`. A foreign version found at the moment of the swap
/// is made live again and the error is `SourceChanged`.
pub(crate) fn exchange_if_unchanged(
    tmp: &Path,
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
    conflict_dir: &Path,
) -> Result<()> {
    exchange_if_unchanged_with_hooks(
        tmp,
        path,
        expected,
        replacement,
        conflict_dir,
        || {},
        || {},
    )
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn exchange_if_unchanged_with_hooks(
    tmp: &Path,
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
    conflict_dir: &Path,
    before_exchange: impl FnOnce(),
    before_rollback: impl FnOnce(),
) -> Result<()> {
    let current = match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            let _ = std::fs::remove_file(tmp);
            return Err(error).with_context(|| format!("read {}", path.display()));
        }
    };
    if current.as_deref() != Some(expected) {
        let _ = std::fs::remove_file(tmp);
        return Err(SourceChanged {
            path: path.to_path_buf(),
            preserved: None,
        }
        .into());
    }
    before_exchange();
    let outcome = (|| -> Result<()> {
        exchange::swap(tmp, path)?;
        if std::fs::read(tmp)? == expected {
            std::fs::remove_file(tmp)?;
            sync_published_parent(path)?;
            return Ok(());
        }

        // A concurrent replacement is now at tmp. Exchange again so the
        // editor's version is visible, then retain whichever bytes this
        // exchange displaced if another write raced the rollback.
        let live_was_ours = std::fs::read(path)? == replacement;
        if live_was_ours {
            before_rollback();
            exchange::swap(tmp, path)?;
            if std::fs::read(tmp)? == replacement {
                std::fs::remove_file(tmp)?;
                sync_published_parent(path)?;
                return Err(SourceChanged {
                    path: path.to_path_buf(),
                    preserved: None,
                }
                .into());
            }
        }
        std::fs::create_dir_all(conflict_dir)?;
        let conflict = conflict_dir.join(tmp.file_name().context("exchange temp has no name")?);
        std::fs::rename(tmp, &conflict)?;
        sync_parent_directory(&conflict)?;
        Err(SourceChanged {
            path: path.to_path_buf(),
            preserved: Some(conflict),
        }
        .into())
    })();
    if let Err(error) = outcome {
        if tmp.exists() {
            // An exchange may have failed before publication. Keep the staged
            // inode for diagnosis rather than discarding possible editor bytes.
            anyhow::bail!(
                "source exchange failed; staged or displaced version preserved at {}: {error:#}",
                tmp.display()
            );
        }
        return Err(error);
    }
    Ok(())
}

/// Other platforms must provide an atomic exchange before a checked write is
/// safe.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn exchange_if_unchanged_with_hooks(
    tmp: &Path,
    path: &Path,
    _expected: &[u8],
    _replacement: &[u8],
    _conflict_dir: &Path,
    _before_exchange: impl FnOnce(),
    _before_rollback: impl FnOnce(),
) -> Result<()> {
    let _ = std::fs::remove_file(tmp);
    anyhow::bail!(
        "atomic source exchange is unavailable on this platform: {}",
        path.display()
    )
}

#[cfg(all(test, target_os = "macos"))]
mod link_repair_tests {
    use super::*;

    fn write_with_hooks(
        path: &Path,
        expected: &[u8],
        replacement: &[u8],
        conflict_dir: &Path,
        before_exchange: impl FnOnce(),
        before_rollback: impl FnOnce(),
    ) -> Result<()> {
        let tmp = prepare_replacement_temp_file(path, path, |file| file.write_all(replacement))?;
        exchange_if_unchanged_with_hooks(
            &tmp,
            path,
            expected,
            replacement,
            conflict_dir,
            before_exchange,
            before_rollback,
        )
    }

    #[test]
    fn atomic_editor_publication_during_repair_restores_editor_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("Card.md");
        let editor_staged = dir.path().join("editor.md");
        let conflict_dir = dir.path().join(".mine/link-repair-conflicts");
        std::fs::write(&source, b"old [[photo.jpg]]").unwrap();
        std::fs::write(&editor_staged, b"editor [[new.jpg]]").unwrap();

        let result = write_with_hooks(
            &source,
            b"old [[photo.jpg]]",
            b"Mine [[renamed.jpg]]",
            &conflict_dir,
            || std::fs::rename(&editor_staged, &source).unwrap(),
            || {},
        );

        let error = result.unwrap_err();
        assert!(source_changed(&error).is_some());
        assert_eq!(std::fs::read(&source).unwrap(), b"editor [[new.jpg]]");
        assert!(!conflict_dir.exists());
    }

    #[test]
    fn second_editor_publication_during_rollback_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("Card.md");
        let first_staged = dir.path().join("first.md");
        let second_staged = dir.path().join("second.md");
        let conflict_dir = dir.path().join(".mine/link-repair-conflicts");
        std::fs::write(&source, b"old").unwrap();
        std::fs::write(&first_staged, b"editor first").unwrap();
        std::fs::write(&second_staged, b"editor second").unwrap();

        let result = write_with_hooks(
            &source,
            b"old",
            b"Mine revised",
            &conflict_dir,
            || std::fs::rename(&first_staged, &source).unwrap(),
            || std::fs::rename(&second_staged, &source).unwrap(),
        );

        assert!(result.is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"editor first");
        let saved = std::fs::read_dir(&conflict_dir)
            .unwrap()
            .collect::<Vec<_>>();
        assert_eq!(saved.len(), 1);
        assert_eq!(
            std::fs::read(saved[0].as_ref().unwrap().path()).unwrap(),
            b"editor second"
        );
    }

    #[test]
    fn edit_before_the_exchange_is_refused_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("Card.md");
        std::fs::write(&source, b"edited outside").unwrap();

        let error = write_atomically_if_unchanged(
            &source,
            b"read by Mine",
            b"Mine revised",
            &dir.path().join("conflicts"),
        )
        .unwrap_err();

        assert!(source_changed(&error).is_some());
        assert_eq!(std::fs::read(&source).unwrap(), b"edited outside");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn remove_if_unchanged_keeps_a_file_edited_after_publication() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Card.md");
        std::fs::write(&path, b"published").unwrap();
        let published = fingerprint(&path).unwrap();
        std::fs::write(dir.path().join("editor.md"), b"edited").unwrap();
        std::fs::rename(dir.path().join("editor.md"), &path).unwrap();

        let error = remove_if_unchanged(&path, &published).unwrap_err();

        assert!(source_changed(&error).is_some());
        assert_eq!(std::fs::read(&path).unwrap(), b"edited");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn remove_if_unchanged_removes_the_published_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Card.md");
        std::fs::write(&path, b"published").unwrap();
        let published = fingerprint(&path).unwrap();

        remove_if_unchanged(&path, &published).unwrap();

        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

/// Atomically publish a new file without replacing an existing destination.
/// The complete fsynced temp inode is linked under the final name in one
/// operation, preserving create-new semantics without exposing partial bytes.
pub fn write_new_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    let _write = crate::storage::source_mutation::begin_write()?;
    write_new_atomically_with_sync(path, bytes, sync_parent_directory)
}

fn write_new_atomically_with_sync(
    path: &Path,
    bytes: &[u8],
    confirm: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
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
    confirm(path).map_err(|source| PublicationUncertain {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(())
}

/// Atomically copy a file to a destination that must not already exist.
pub fn copy_new_atomically(source: &Path, destination: &Path) -> Result<()> {
    let _write = crate::storage::source_mutation::begin_write()?;
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
    sync_published_parent(destination)?;
    Ok(())
}

fn copy_atomically(source: &Path, destination: &Path) -> Result<()> {
    let _write = crate::storage::source_mutation::begin_write()?;
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
    sync_published_parent(destination)?;
    Ok(())
}

/// Stage replacement bytes with source metadata, before any visible mutation.
pub(crate) fn prepare_replacement_temp_file(
    path: &Path,
    source: &Path,
    writer: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<PathBuf> {
    prepare_temp_file(path, |file| {
        writer(file)?;
        replacement_metadata::preserve(source, file)
    })
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

pub fn sync_parent_directory(path: &Path) -> Result<()> {
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
    validate_vault_write_target(vault, &path)?;
    let content = serialize_block(block);
    write_new_atomically(&path, content.as_bytes())
        .with_context(|| format!("failed to create block file: {}", path.display()))?;

    Ok(path)
}

/// Filename inventory from source files, independent of SQLite and without
/// following symlinked directories. Naming policy remains in mine-core.
pub fn scan_vault_file_stems(vault: &VaultLayout) -> Result<std::collections::HashSet<String>> {
    fn walk(
        vault: &VaultLayout,
        dir: &Path,
        out: &mut std::collections::HashSet<String>,
    ) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_dir() && !is_ignored_vault_dir(&path) {
                walk(vault, &path, out)?;
            } else if kind.is_file() {
                if let Ok(stem) = vault.slug_for_path(&path) {
                    out.insert(stem);
                }
            }
        }
        Ok(())
    }
    let mut stems = std::collections::HashSet::new();
    walk(vault, vault.root(), &mut stems)?;
    Ok(stems)
}

/// Vault-relative source paths for shortest unambiguous Obsidian references.
pub fn scan_vault_file_paths(vault: &VaultLayout) -> Result<Vec<String>> {
    fn walk(vault: &VaultLayout, dir: &Path, out: &mut Vec<String>) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_dir() && !is_ignored_vault_dir(&path) {
                walk(vault, &path, out)?;
            } else if kind.is_file() {
                if let Ok(relative) = path.strip_prefix(vault.root()) {
                    if !relative
                        .components()
                        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
                    {
                        out.push(relative.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
        }
        Ok(())
    }
    let mut paths = Vec::new();
    walk(vault, vault.root(), &mut paths)?;
    paths.sort();
    Ok(paths)
}

pub fn shortest_vault_link(vault: &VaultLayout, target: &str, omit_md_ext: bool) -> Result<String> {
    mine_core::links::LinkIndex::new(scan_vault_file_paths(vault)?)
        .shortest_link(target, omit_md_ext)
        .ok_or_else(|| anyhow::anyhow!("vault link target is missing: {target}"))
}

/// Read explicit write destinations. Missing configuration and missing fields
/// mean the space root, regardless of directory names on disk.
pub fn load_vault_write_layout(
    vault: &VaultLayout,
) -> Result<crate::domain::vault::VaultWriteLayout> {
    let marker = vault.write_layout_path();
    validate_vault_write_target(vault, &marker)?;
    let stored: crate::domain::vault::VaultWriteLayout = match std::fs::read(&marker) {
        Ok(raw) => serde_json::from_slice(&raw).context("invalid saved write layout")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            crate::domain::vault::VaultWriteLayout::flat()
        }
        Err(error) => return Err(error.into()),
    };
    stored.validate().map_err(|error| anyhow::anyhow!(error))
}

/// Snapshot the latest saved destinations immediately before creating files.
/// Native host and the desktop app may both change the shared layout marker.
pub fn layout_for_new_files(vault: &VaultLayout) -> Result<VaultLayout> {
    Ok(vault
        .clone()
        .with_write_layout(load_vault_write_layout(vault)?))
}

/// Anchor the layout agreed by a durable capture plan. This is idempotent
/// initialization, never permission to replace a user's saved configuration.
pub fn ensure_vault_write_layout(
    vault: &VaultLayout,
    requested: &crate::domain::vault::VaultWriteLayout,
) -> Result<()> {
    let _write = crate::storage::source_mutation::begin_write()?;
    let expected = requested
        .validate()
        .map_err(|error| anyhow::anyhow!(error))?;
    let marker = vault.write_layout_path();
    validate_vault_write_target(vault, &marker)?;
    match std::fs::read(&marker) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Concurrent initialization may win, but the marker is never
            // overwritten. Read back and validate the winner in either case.
            if let Err(error) = write_new_atomically(&marker, &serde_json::to_vec(&expected)?) {
                if !marker.is_file() {
                    return Err(error);
                }
            }
        }
        Err(error) => return Err(error.into()),
    }
    validate_vault_write_target(vault, &marker)?;
    let stored: crate::domain::vault::VaultWriteLayout =
        serde_json::from_slice(&std::fs::read(&marker)?).context("invalid saved write layout")?;
    let stored = stored.validate().map_err(|error| anyhow::anyhow!(error))?;
    if stored != expected {
        anyhow::bail!("saved write layout differs from prepared capture");
    }
    // A new .mine entry must itself be anchored in the vault directory.
    std::fs::File::open(&marker)?.sync_all()?;
    sync_parent_directory(&marker)?;
    sync_parent_directory(&vault.mine_dir())?;
    Ok(())
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
///
/// References resolve through `resolver`, so a pass that indexes many notes
/// shares one snapshot of the vault's file list across all of them.
pub fn normalize_block_media_refs_for_index(
    resolver: &mut media_refs::MediaResolver<'_>,
    block: &mut Block,
) {
    let vault = resolver.vault();
    if let Some(file) = block.frontmatter.file.clone() {
        if let Some(resolved) = resolver.resolve_frontmatter_media(&block.slug, &file) {
            if let Some(root_relative) = vault.root_relative_reference(&resolved) {
                block.frontmatter.file = Some(root_relative);
            }
        }
    }
    if let Some(thumbnail) = block.frontmatter.thumbnail.clone() {
        if let Some(resolved) = resolver.resolve_frontmatter_media(&block.slug, &thumbnail) {
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
/// Moves to OS trash. Failure must never become permanent deletion.
pub fn delete_user_file(path: &Path) -> Result<()> {
    let _write = crate::storage::source_mutation::begin_write()?;
    if !path.exists() {
        return Ok(());
    }

    delete_user_files(&[path.to_path_buf()])
}

/// One OS trash request for a batch. The OS may partially succeed; callers
/// must refresh their view after errors. Never remove remaining files here.
pub fn delete_user_files(paths: &[PathBuf]) -> Result<()> {
    let _write = crate::storage::source_mutation::begin_write()?;
    if paths.is_empty() {
        return Ok(());
    }
    // Unit tests delete temp notes by the hundred: they go to a test trash,
    // never into the person's own Trash.
    #[cfg(test)]
    {
        test_trash::move_all(paths)
    }
    #[cfg(all(not(test), not(target_os = "ios")))]
    {
        trash::delete_all(paths).context("failed to move files to the system Trash")
    }
    #[cfg(all(not(test), target_os = "ios"))]
    {
        anyhow::bail!("system Trash is unavailable; files were not deleted")
    }
}

/// The Trash of unit tests: a folder in the system temp directory. A file
/// moved here leaves its path exactly as a trashed one does, and its bytes
/// stay readable, so rollback and "changed while trashing" checks behave as
/// with the system Trash.
#[cfg(test)]
mod test_trash {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use anyhow::{Context, Result};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn slot() -> Result<PathBuf> {
        let slot = std::env::temp_dir()
            .join("mine-test-trash")
            .join(format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&slot).with_context(|| format!("create {}", slot.display()))?;
        Ok(slot)
    }

    fn move_one(path: &Path) -> Result<()> {
        let name = path
            .file_name()
            .with_context(|| format!("no file name: {}", path.display()))?;
        let target = slot()?.join(name);
        if std::fs::rename(path, &target).is_ok() {
            return Ok(());
        }
        // Another volume: copy, then remove the original, as the Trash does.
        if path.is_dir() {
            anyhow::bail!("test trash cannot move a folder across volumes: {}", path.display());
        }
        std::fs::copy(path, &target).with_context(|| format!("copy {}", path.display()))?;
        std::fs::remove_file(path).with_context(|| format!("remove {}", path.display()))
    }

    pub(super) fn move_all(paths: &[PathBuf]) -> Result<()> {
        // Like the system Trash, a batch naming a missing file moves nothing.
        for path in paths {
            std::fs::symlink_metadata(path)
                .with_context(|| format!("failed to move {} to the test trash", path.display()))?;
        }
        for path in paths {
            move_one(path).with_context(|| format!("failed to move {} to the test trash", path.display()))?;
        }
        Ok(())
    }
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
        // A slug in other letter case may name the same preview.
        anyhow::ensure!(
            !new_thumb.exists() || names_same_entry(&old_thumb, &new_thumb),
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

    #[test]
    fn unit_tests_trash_into_the_test_trash_not_the_persons_trash() {
        let temp = tempfile::tempdir().unwrap();
        let note = temp.path().join("Note.md");
        std::fs::write(&note, b"note bytes").unwrap();

        delete_user_file(&note).unwrap();

        assert!(!note.exists());
        let test_trash = std::env::temp_dir().join("mine-test-trash");
        let kept = std::fs::read_dir(&test_trash)
            .unwrap()
            .flatten()
            .map(|slot| slot.path().join("Note.md"))
            .find(|candidate| std::fs::read(candidate).is_ok_and(|bytes| bytes == b"note bytes"));
        assert!(kept.is_some(), "the note must land in {}", test_trash.display());
    }

    /// 06.10.2026: one entry is one file under one name, in any spelling the
    /// disk finds it by; a second name of the file is another entry.
    #[test]
    fn same_entry_is_one_name_of_one_file() {
        let temp = tempfile::tempdir().unwrap();
        let note = temp.path().join("note.md");
        std::fs::write(&note, b"note").unwrap();
        std::fs::write(temp.path().join("other.md"), b"note").unwrap();
        std::fs::hard_link(&note, temp.path().join("linked.md")).unwrap();

        assert!(names_same_entry(&note, &note));
        // Where the disk ignores case the other spelling finds the note.
        let respelled = temp.path().join("NOTE.md");
        assert_eq!(names_same_entry(&note, &respelled), respelled.exists());
        assert!(!names_same_entry(&note, &temp.path().join("other.md")));
        assert!(!names_same_entry(&note, &temp.path().join("linked.md")));
        assert!(!names_same_entry(&note, &temp.path().join("missing.md")));
    }

    #[test]
    fn sc2_layout_initialization_never_overwrites_corrupt_or_changed_marker() {
        let temp = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(temp.path().to_path_buf());
        let standard = crate::domain::vault::VaultWriteLayout::standard();
        ensure_vault_write_layout(&vault, &standard).unwrap();
        let original = std::fs::read(vault.write_layout_path()).unwrap();
        ensure_vault_write_layout(&vault, &standard).unwrap();
        assert_eq!(std::fs::read(vault.write_layout_path()).unwrap(), original);
        assert!(
            ensure_vault_write_layout(&vault, &crate::domain::vault::VaultWriteLayout::flat())
                .is_err()
        );
        assert_eq!(std::fs::read(vault.write_layout_path()).unwrap(), original);
        std::fs::write(vault.write_layout_path(), b"broken layout").unwrap();
        assert!(ensure_vault_write_layout(&vault, &standard).is_err());
        assert_eq!(
            std::fs::read(vault.write_layout_path()).unwrap(),
            b"broken layout"
        );
    }

    #[cfg(unix)]
    #[test]
    fn sc2_layout_initialization_rejects_symlink_without_touching_target() {
        let temp = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(temp.path().join("vault"));
        std::fs::create_dir_all(vault.mine_dir()).unwrap();
        let external = temp.path().join("external.json");
        std::fs::write(&external, b"untouched").unwrap();
        std::os::unix::fs::symlink(&external, vault.write_layout_path()).unwrap();
        assert!(ensure_vault_write_layout(
            &vault,
            &crate::domain::vault::VaultWriteLayout::standard()
        )
        .is_err());
        assert_eq!(std::fs::read(external).unwrap(), b"untouched");
    }

    #[test]
    fn sc2_saved_custom_layout_is_respected_and_invalid_marker_is_not_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(tmp.path().to_path_buf());
        assert_eq!(
            load_vault_write_layout(&vault).unwrap(),
            crate::domain::vault::VaultWriteLayout::flat()
        );
        std::fs::create_dir_all(vault.root().join("Cards")).unwrap();
        std::fs::create_dir_all(vault.root().join("Media")).unwrap();
        std::fs::create_dir_all(vault.root().join("Collections")).unwrap();
        assert_eq!(
            load_vault_write_layout(&vault).unwrap(),
            crate::domain::vault::VaultWriteLayout::flat()
        );
        std::fs::create_dir(vault.mine_dir()).unwrap();
        std::fs::write(
            vault.write_layout_path(),
            br#"{"cards":"Mine/Notes","media":"Mine/Files","collections":"Mine/Sets"}"#,
        )
        .unwrap();
        let selected = load_vault_write_layout(&vault).unwrap();
        assert_eq!(selected.cards, "Mine/Notes");
        assert_eq!(selected.media, "Mine/Files");
        std::fs::write(vault.write_layout_path(), br#"{"cards":"Notes"}"#).unwrap();
        let partial = load_vault_write_layout(&vault).unwrap();
        assert_eq!(partial.cards, "Notes");
        assert_eq!(partial.media, "");
        assert_eq!(partial.collections, "");
        std::fs::write(
            vault.write_layout_path(),
            br#"{"cards":"../outside","media":"Files","collections":"Sets"}"#,
        )
        .unwrap();
        assert!(load_vault_write_layout(&vault).is_err());
        std::fs::write(vault.write_layout_path(), b"truncated").unwrap();
        assert!(load_vault_write_layout(&vault).is_err());
    }

    #[test]
    fn sc2_failed_directory_sync_reports_publication_uncertain_and_retains_complete_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("Card.md");
        let error = write_new_atomically_with_sync(&path, b"complete Markdown", |_| {
            anyhow::bail!("injected directory sync failure")
        })
        .unwrap_err();
        assert!(publication_is_uncertain(&error));
        assert_eq!(std::fs::read(&path).unwrap(), b"complete Markdown");
        let collision = write_new_atomically(&path, b"must not replace").unwrap_err();
        assert!(!publication_is_uncertain(&collision));
        assert_eq!(std::fs::read(&path).unwrap(), b"complete Markdown");
    }

    #[cfg(unix)]
    #[test]
    fn sc2_write_target_and_inventory_reject_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("vault");
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("Foreign.md"), b"foreign").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("Cards")).unwrap();
        let vault = VaultLayout::new(root.clone());
        assert!(validate_vault_write_target(&vault, &root.join("Cards/New.md")).is_err());
        assert!(validate_vault_write_target(&vault, &root.join("../outside/New.md")).is_err());
        assert!(scan_vault_file_stems(&vault).unwrap().is_empty());
        assert_eq!(
            std::fs::read(outside.join("Foreign.md")).unwrap(),
            b"foreign"
        );
    }
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
        assert_eq!(
            std::fs::read(&destination).expect("reread winner"),
            winner.0
        );
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
    fn trash_batch_failure_never_permanently_deletes_existing_files() {
        let root = tempfile::tempdir().expect("tempdir");
        let keep = root.path().join("keep.jpg");
        std::fs::write(&keep, b"keep").expect("write");
        let missing = root.path().join("missing.jpg");
        assert!(delete_user_files(&[keep.clone(), missing]).is_err());
        assert_eq!(std::fs::read(keep).expect("file preserved"), b"keep");
    }

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
