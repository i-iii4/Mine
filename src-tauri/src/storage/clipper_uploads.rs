// Pending clipper uploads.
//
// Large screenshot payloads arrive over the native-host HTTP upload server.
// They must not be written directly into the source vault before the matching
// save_block commit succeeds, otherwise a crash between upload and markdown
// creation leaves untracked media in the user's vault.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::domain::vault::VaultLayout;
use crate::storage::files;
use crate::storage::media_refs;

const PENDING_UPLOADS_DIR: &str = "pending_uploads";
const MANIFEST_FILE: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUploadManifest {
    pub upload_id: String,
    pub original_filename: String,
    pub payload_filename: String,
    pub content_type: Option<String>,
    pub size: u64,
    pub created_at: String,
    #[serde(default)]
    pub committed_slug: Option<String>,
    #[serde(default)]
    pub committed_file: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FinalizedPendingUpload {
    pub filename: String,
}

pub fn pending_uploads_dir(vault: &VaultLayout) -> PathBuf {
    vault.derived_root().join(PENDING_UPLOADS_DIR)
}

pub fn pending_upload_dir(vault: &VaultLayout, upload_id: &str) -> Result<PathBuf> {
    validate_upload_id(upload_id)?;
    Ok(pending_uploads_dir(vault).join(upload_id))
}

pub fn write_pending_upload(
    vault: &VaultLayout,
    requested_filename: &str,
    content_type: Option<String>,
    body: &[u8],
) -> Result<PendingUploadManifest> {
    let base_dir = pending_uploads_dir(vault);
    std::fs::create_dir_all(&base_dir)
        .with_context(|| format!("failed to create pending upload dir {}", base_dir.display()))?;

    let payload_filename = sanitize_payload_filename(requested_filename)?;
    let upload_id = allocate_upload_id(&base_dir)?;
    let dir = base_dir.join(&upload_id);
    std::fs::create_dir(&dir)
        .with_context(|| format!("failed to create pending upload {}", dir.display()))?;

    let payload_path = dir.join(&payload_filename);
    write_create_new(&payload_path, body)
        .with_context(|| format!("failed to write pending payload {}", payload_path.display()))?;

    let manifest = PendingUploadManifest {
        upload_id,
        original_filename: requested_filename.to_string(),
        payload_filename,
        content_type,
        size: body.len() as u64,
        created_at: crate::util::now_iso8601(),
        committed_slug: None,
        committed_file: None,
    };
    write_manifest(&dir, &manifest)?;
    Ok(manifest)
}

pub fn load_pending_upload(vault: &VaultLayout, upload_id: &str) -> Result<PendingUploadManifest> {
    let dir = pending_upload_dir(vault, upload_id)?;
    let manifest_path = dir.join(MANIFEST_FILE);
    let raw = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("failed to read pending upload {}", manifest_path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse pending upload {}", manifest_path.display()))
}

pub fn list_uncommitted_pending_uploads(vault: &VaultLayout) -> Result<Vec<PendingUploadManifest>> {
    let base_dir = pending_uploads_dir(vault);
    if !base_dir.exists() {
        return Ok(Vec::new());
    }
    let mut rows = Vec::new();
    for entry in std::fs::read_dir(&base_dir)
        .with_context(|| format!("failed to read pending uploads {}", base_dir.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(upload_id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(manifest) = load_pending_upload(vault, &upload_id) else {
            continue;
        };
        if manifest.committed_slug.is_none() {
            rows.push(manifest);
        }
    }
    rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(rows)
}

pub fn finalize_pending_upload(
    vault: &VaultLayout,
    upload_id: &str,
    final_stem: &str,
) -> Result<FinalizedPendingUpload> {
    let manifest = load_pending_upload(vault, upload_id)?;
    if let (Some(slug), Some(file)) = (&manifest.committed_slug, &manifest.committed_file) {
        if slug == final_stem && vault.root().join(file).exists() {
            return Ok(FinalizedPendingUpload {
                filename: file.clone(),
            });
        }
    }

    let dir = pending_upload_dir(vault, upload_id)?;
    let payload_path = dir.join(&manifest.payload_filename);
    if !payload_path.is_file() {
        return Err(anyhow!(
            "pending upload payload not found: {}",
            payload_path.display()
        ));
    }

    let filename = dedupe_final_filename(vault.root(), &manifest.payload_filename, final_stem)?;
    let dest = vault.root().join(&filename);
    copy_create_new(&payload_path, &dest)
        .with_context(|| format!("failed to copy pending upload to {}", dest.display()))?;

    Ok(FinalizedPendingUpload { filename })
}

/// Finish a pending upload whose card now exists in the vault.
///
/// The staging directory holds a full copy of the media, so keeping it after a
/// successful commit doubles every clipped file on disk forever. Marking the
/// manifest and leaving the directory behind is what produced 113 stale
/// directories (109 MB of duplicates) on the development machine before this
/// was fixed; recovery never offered them for deletion either, because it only
/// lists uploads that were *not* committed. See SPEC_VAULT_LIFECYCLE.md П19.
///
/// The extension never retries a save with the same upload id — a failed save
/// re-uploads and gets a fresh id — so removing the payload cannot strand a
/// legitimate retry.
pub fn complete_pending_upload(vault: &VaultLayout, upload_id: &str) -> Result<()> {
    let dir = pending_upload_dir(vault, upload_id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).with_context(|| {
            format!("failed to remove committed pending upload {}", dir.display())
        })?;
    }
    Ok(())
}

/// Record the commit without removing the staging directory.
///
/// Retained for the sweep below, which needs to distinguish a committed upload
/// from an interrupted one while cleaning up directories written by older
/// versions.
pub fn mark_pending_upload_committed(
    vault: &VaultLayout,
    upload_id: &str,
    slug: &str,
    filename: &str,
) -> Result<()> {
    let mut manifest = load_pending_upload(vault, upload_id)?;
    manifest.committed_slug = Some(slug.to_string());
    manifest.committed_file = Some(filename.to_string());
    let dir = pending_upload_dir(vault, upload_id)?;
    write_manifest(&dir, &manifest)
}

/// Remove staging directories left behind by earlier versions.
///
/// A directory is removed when its manifest records a commit and that card's
/// media actually exists in the vault. Anything else — an interrupted upload,
/// or a commit whose file has since been deleted — is left for recovery.
/// Returns how many directories were removed.
pub fn sweep_committed_pending_uploads(vault: &VaultLayout) -> Result<usize> {
    let root = pending_uploads_dir(vault);
    if !root.is_dir() {
        return Ok(0);
    }
    let mut removed = 0usize;
    for entry in std::fs::read_dir(&root)
        .with_context(|| format!("failed to read pending uploads: {}", root.display()))?
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(upload_id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(manifest) = load_pending_upload(vault, &upload_id) else {
            continue;
        };
        let Some(committed_file) = manifest.committed_file.as_deref() else {
            continue;
        };
        // The card's media may sit in `Media/` rather than at the vault root:
        // the manifest stores a bare filename, exactly like an Obsidian
        // wikilink. Checking the root path alone left 111 of 113 stale
        // directories in place on a foldered vault — the same name-versus-path
        // trap the asset protocol hit on 11.08.2026.
        if !media_exists_in_vault(vault, committed_file) {
            continue;
        }
        if complete_pending_upload(vault, &upload_id).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

pub fn discard_pending_upload(vault: &VaultLayout, upload_id: &str) -> Result<()> {
    let dir = pending_upload_dir(vault, upload_id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .with_context(|| format!("failed to remove pending upload {}", dir.display()))?;
    }
    Ok(())
}

pub fn upload_id_from_legacy_filename(value: &str) -> Option<&str> {
    value.strip_prefix("pending:")
}

fn validate_upload_id(upload_id: &str) -> Result<()> {
    if upload_id.len() != 32 || !upload_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(anyhow!("invalid pending upload id"));
    }
    Ok(())
}

fn allocate_upload_id(base_dir: &Path) -> Result<String> {
    for _ in 0..16 {
        let upload_id = random_hex_16();
        if !base_dir.join(&upload_id).exists() {
            return Ok(upload_id);
        }
    }
    Err(anyhow!("failed to allocate pending upload id"))
}

fn random_hex_16() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes[..16].copy_from_slice(&nanos.to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sanitize_payload_filename(requested: &str) -> Result<String> {
    let normalized = requested.replace('\\', "/");
    let file_name = Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| anyhow!("invalid upload filename"))?;

    if file_name == "." || file_name == ".." || file_name.contains('/') || file_name.contains('\\')
    {
        return Err(anyhow!("invalid upload filename"));
    }
    if file_name.contains('\0') {
        return Err(anyhow!("invalid upload filename"));
    }
    Ok(file_name.to_string())
}

fn dedupe_final_filename(vault_root: &Path, uploaded: &str, final_stem: &str) -> Result<String> {
    let sanitized = sanitize_payload_filename(uploaded)?;
    let ext = Path::new(&sanitized)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let build_name = |stem: &str| -> String {
        if ext.is_empty() {
            stem.to_string()
        } else {
            format!("{stem}.{ext}")
        }
    };

    let mut candidate = build_name(final_stem);
    let mut counter: u32 = 2;
    while vault_root.join(&candidate).exists() {
        candidate = build_name(&format!("{final_stem} ({counter})"));
        counter = counter
            .checked_add(1)
            .ok_or_else(|| anyhow!("ran out of collision suffixes"))?;
    }
    Ok(candidate)
}

/// Whether a committed media file is present anywhere in the vault.
///
/// Tries the direct path first — the common case for flat vaults — then falls
/// back to a basename lookup, which is how every other reader resolves media.
fn media_exists_in_vault(vault: &VaultLayout, file_name: &str) -> bool {
    if vault.root().join(file_name).exists() {
        return true;
    }
    media_refs::resolve_basename_under(vault.root(), file_name).is_some()
}

fn write_manifest(dir: &Path, manifest: &PendingUploadManifest) -> Result<()> {
    let manifest_path = dir.join(MANIFEST_FILE);
    let raw = serde_json::to_vec_pretty(manifest)?;
    files::write_atomically(&manifest_path, &raw).with_context(|| {
        format!(
            "failed to write pending manifest {}",
            manifest_path.display()
        )
    })
}

fn write_create_new(path: &Path, bytes: &[u8]) -> Result<()> {
    files::write_new_atomically(path, bytes)
}

fn copy_create_new(src: &Path, dest: &Path) -> Result<()> {
    files::copy_new_atomically(src, dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn vault_for(dir: &TempDir) -> VaultLayout {
        VaultLayout::with_derived_root(dir.path().join("vault"), dir.path().join("derived"))
    }

    #[test]
    fn pending_upload_does_not_write_source_vault_until_finalize() {
        let dir = tempfile::tempdir().unwrap();
        let vault = vault_for(&dir);
        std::fs::create_dir_all(vault.root()).unwrap();

        let manifest = write_pending_upload(
            &vault,
            "screenshot.jpg",
            Some("image/jpeg".to_string()),
            b"jpeg",
        )
        .unwrap();

        assert!(pending_upload_dir(&vault, &manifest.upload_id)
            .unwrap()
            .join("screenshot.jpg")
            .exists());
        assert!(!vault.root().join("screenshot.jpg").exists());

        let finalized = finalize_pending_upload(&vault, &manifest.upload_id, "Door").unwrap();
        assert_eq!(finalized.filename, "Door.jpg");
        assert_eq!(
            std::fs::read(vault.root().join("Door.jpg")).unwrap(),
            b"jpeg"
        );
    }

    #[test]
    fn completing_an_upload_removes_its_staged_copy() {
        let dir = tempfile::tempdir().unwrap();
        let vault = vault_for(&dir);
        std::fs::create_dir_all(vault.root()).unwrap();

        let manifest = write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        finalize_pending_upload(&vault, &manifest.upload_id, "Card").unwrap();
        let staged = pending_upload_dir(&vault, &manifest.upload_id).unwrap();
        assert!(staged.exists());

        complete_pending_upload(&vault, &manifest.upload_id).unwrap();

        // The vault copy survives; the duplicate in staging does not.
        assert!(vault.root().join("Card.jpg").exists());
        assert!(!staged.exists());
    }

    #[test]
    fn sweep_removes_committed_leftovers_and_keeps_unfinished_ones() {
        let dir = tempfile::tempdir().unwrap();
        let vault = vault_for(&dir);
        std::fs::create_dir_all(vault.root()).unwrap();

        // Committed by an older version: marked, card present, directory kept.
        let committed = write_pending_upload(&vault, "done.jpg", None, b"done").unwrap();
        finalize_pending_upload(&vault, &committed.upload_id, "Done").unwrap();
        mark_pending_upload_committed(&vault, &committed.upload_id, "Done", "Done.jpg").unwrap();

        // Interrupted: no card was ever written.
        let unfinished = write_pending_upload(&vault, "half.jpg", None, b"half").unwrap();

        // Committed, but the media has since been deleted from the vault.
        let vanished = write_pending_upload(&vault, "gone.jpg", None, b"gone").unwrap();
        finalize_pending_upload(&vault, &vanished.upload_id, "Gone").unwrap();
        mark_pending_upload_committed(&vault, &vanished.upload_id, "Gone", "Gone.jpg").unwrap();
        std::fs::remove_file(vault.root().join("Gone.jpg")).unwrap();

        let removed = sweep_committed_pending_uploads(&vault).unwrap();

        assert_eq!(removed, 1);
        assert!(!pending_upload_dir(&vault, &committed.upload_id)
            .unwrap()
            .exists());
        // Recoverable work is never swept.
        assert!(pending_upload_dir(&vault, &unfinished.upload_id)
            .unwrap()
            .exists());
        assert!(pending_upload_dir(&vault, &vanished.upload_id)
            .unwrap()
            .exists());
    }

    #[test]
    fn sweep_finds_media_that_lives_in_a_subfolder() {
        let dir = tempfile::tempdir().unwrap();
        let vault = vault_for(&dir);
        std::fs::create_dir_all(vault.root().join("Media")).unwrap();

        let manifest = write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        finalize_pending_upload(&vault, &manifest.upload_id, "Card").unwrap();
        mark_pending_upload_committed(&vault, &manifest.upload_id, "Card", "Card.jpg").unwrap();
        // A migrated vault keeps media in `Media/`, while the manifest records
        // the bare filename.
        std::fs::rename(
            vault.root().join("Card.jpg"),
            vault.root().join("Media/Card.jpg"),
        )
        .unwrap();

        assert_eq!(sweep_committed_pending_uploads(&vault).unwrap(), 1);
        assert!(!pending_upload_dir(&vault, &manifest.upload_id)
            .unwrap()
            .exists());
    }

    #[test]
    fn sweep_is_idempotent_and_survives_a_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let vault = vault_for(&dir);
        std::fs::create_dir_all(vault.root()).unwrap();

        assert_eq!(sweep_committed_pending_uploads(&vault).unwrap(), 0);

        let manifest = write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        finalize_pending_upload(&vault, &manifest.upload_id, "Card").unwrap();
        mark_pending_upload_committed(&vault, &manifest.upload_id, "Card", "Card.jpg").unwrap();

        assert_eq!(sweep_committed_pending_uploads(&vault).unwrap(), 1);
        assert_eq!(sweep_committed_pending_uploads(&vault).unwrap(), 0);
        // Completing an already-removed upload is not an error.
        complete_pending_upload(&vault, &manifest.upload_id).unwrap();
    }

    #[test]
    fn pending_upload_finalization_dedupes_source_vault_collisions() {
        let dir = tempfile::tempdir().unwrap();
        let vault = vault_for(&dir);
        std::fs::create_dir_all(vault.root()).unwrap();
        std::fs::write(vault.root().join("Door.jpg"), b"existing").unwrap();

        let manifest = write_pending_upload(&vault, "screenshot.jpg", None, b"new").unwrap();
        let finalized = finalize_pending_upload(&vault, &manifest.upload_id, "Door").unwrap();

        assert_eq!(finalized.filename, "Door (2).jpg");
        assert_eq!(
            std::fs::read(vault.root().join("Door (2).jpg")).unwrap(),
            b"new"
        );
    }

    #[test]
    fn committed_pending_uploads_are_hidden_from_recovery_list() {
        let dir = tempfile::tempdir().unwrap();
        let vault = vault_for(&dir);
        std::fs::create_dir_all(vault.root()).unwrap();

        let manifest = write_pending_upload(&vault, "screenshot.jpg", None, b"jpeg").unwrap();
        assert_eq!(list_uncommitted_pending_uploads(&vault).unwrap().len(), 1);

        mark_pending_upload_committed(&vault, &manifest.upload_id, "Door", "Door.jpg").unwrap();
        assert!(list_uncommitted_pending_uploads(&vault).unwrap().is_empty());
    }
}
