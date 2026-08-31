// Pending clipper uploads.
//
// Large screenshot payloads arrive over the native-host HTTP upload server.
// They must not be written directly into the source vault before the matching
// save_block commit succeeds, otherwise a crash between upload and markdown
// creation leaves untracked media in the user's vault.

use anyhow::{anyhow, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::domain::vault::VaultLayout;
use crate::storage::files;
use crate::storage::media_refs;
use crate::storage::save_operations::sha256_file;

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
    pub vault_binding: Option<String>,
    #[serde(default)]
    pub finalization: Option<UploadFinalization>,
    #[serde(default)]
    pub committed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFinalization {
    pub filename: String,
    pub sha256: String,
    pub published: bool,
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
    let vault_binding = crate::storage::save_operations::binding_id(vault)?;
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
        vault_binding: Some(vault_binding),
        finalization: None,
        committed: false,
    };
    write_manifest(&dir, &manifest)?;
    Ok(manifest)
}

pub fn load_pending_upload(vault: &VaultLayout, upload_id: &str) -> Result<PendingUploadManifest> {
    let dir = pending_upload_dir(vault, upload_id)?;
    let manifest_path = dir.join(MANIFEST_FILE);
    reject_symlink(&dir)?;
    reject_symlink(&manifest_path)?;
    let raw = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("failed to read pending upload {}", manifest_path.display()))?;
    let manifest: PendingUploadManifest = serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse pending upload {}", manifest_path.display()))?;
    if manifest.upload_id != upload_id
        || sanitize_payload_filename(&manifest.payload_filename)? != manifest.payload_filename
    {
        return Err(anyhow!("pending upload manifest identity/path mismatch"));
    }
    if manifest.vault_binding.as_deref().is_some_and(|binding| {
        !crate::storage::save_operations::binding_id(vault).is_ok_and(|current| current == binding)
    }) {
        return Err(anyhow!("pending upload belongs to another folder binding"));
    }
    if let Some(finalization) = &manifest.finalization {
        if sanitize_payload_filename(&finalization.filename)? != finalization.filename {
            return Err(anyhow!("invalid finalized upload path"));
        }
    }
    Ok(manifest)
}

fn reject_symlink(path: &Path) -> Result<()> {
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(anyhow!("refusing upload symlink: {}", path.display()));
    }
    Ok(())
}

fn lock_upload(dir: &Path) -> Result<std::fs::File> {
    reject_symlink(dir)?;
    let path = dir.join(".lock");
    if std::fs::symlink_metadata(&path).is_ok() {
        reject_symlink(&path)?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    file.lock_exclusive()?;
    Ok(file)
}

pub fn finalize_pending_upload(
    vault: &VaultLayout,
    upload_id: &str,
    final_stem: &str,
) -> Result<FinalizedPendingUpload> {
    let dir = pending_upload_dir(vault, upload_id)?;
    let _lock = lock_upload(&dir)?;
    let mut manifest = load_pending_upload(vault, upload_id)?;
    if manifest.vault_binding.is_none() {
        return Err(anyhow!(
            "legacy pending upload binding is unknown; staging retained"
        ));
    }
    if let Some(finalization) = &manifest.finalization {
        let dest = vault.new_media_path(&finalization.filename);
        files::validate_vault_write_target(vault, &dest)?;
        if !sha256_file(&dest).is_ok_and(|hash| hash == finalization.sha256) {
            return Err(anyhow!("pending upload publication outcome is unknown"));
        }
        std::fs::File::open(&dest)?.sync_all()?;
        files::sync_parent_directory(&dest)?;
        let filename = finalization.filename.clone();
        manifest.finalization.as_mut().unwrap().published = true;
        write_manifest(&dir, &manifest)?;
        return Ok(FinalizedPendingUpload { filename });
    }
    let payload_path = dir.join(&manifest.payload_filename);
    reject_symlink(&payload_path)?;
    if !payload_path.is_file() {
        return Err(anyhow!(
            "pending upload payload not found: {}",
            payload_path.display()
        ));
    }

    // Names are deduplicated against the whole vault, but the file is written
    // into the configured media folder: the frontmatter reference is a bare
    // name either way, exactly like an Obsidian wikilink.
    let filename = dedupe_final_filename(vault, &manifest.payload_filename, final_stem)?;
    let dest = vault.new_media_path(&filename);
    files::validate_vault_write_target(vault, &dest)?;
    manifest.finalization = Some(UploadFinalization {
        filename: filename.clone(),
        sha256: sha256_file(&payload_path)?,
        published: false,
    });
    // The exact destination and hash survive a crash or a lost acknowledgement.
    write_manifest(&dir, &manifest)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create media directory: {}", parent.display()))?;
    }
    copy_create_new(&payload_path, &dest)
        .with_context(|| format!("failed to copy pending upload to {}", dest.display()))?;
    manifest.finalization.as_mut().unwrap().published = true;
    write_manifest(&dir, &manifest)?;

    Ok(FinalizedPendingUpload { filename })
}

/// Acquire an upload into operation-owned staging, without touching source.
/// The original binding and manifest remain authoritative until a source
/// receipt permits cleanup; a prior finalization is never silently rebound.
pub fn prepare_pending_upload(
    vault: &VaultLayout,
    staging: &VaultLayout,
    upload_id: &str,
    final_stem: &str,
) -> Result<FinalizedPendingUpload> {
    let dir = pending_upload_dir(vault, upload_id)?;
    let _lock = lock_upload(&dir)?;
    let mut manifest = load_pending_upload(vault, upload_id)?;
    if manifest.vault_binding.is_none() {
        return Err(anyhow!(
            "legacy pending upload binding is unknown; staging retained"
        ));
    }
    if manifest.finalization.is_some() {
        return Err(anyhow!(
            "upload already belongs to a publication; resume its operation"
        ));
    }
    let payload = dir.join(&manifest.payload_filename);
    reject_symlink(&payload)?;
    if !payload.is_file() || std::fs::metadata(&payload)?.len() != manifest.size {
        return Err(anyhow!("pending upload payload is missing or changed"));
    }
    let filename = dedupe_final_filename(vault, &manifest.payload_filename, final_stem)?;
    let target = staging.new_media_path(&filename);
    files::validate_vault_write_target(staging, &target)?;
    manifest.finalization = Some(UploadFinalization {
        filename: filename.clone(),
        sha256: sha256_file(&payload)?,
        published: false,
    });
    write_manifest(&dir, &manifest)?;
    copy_create_new(&payload, &target)?;
    if sha256_file(&target)? != manifest.finalization.as_ref().unwrap().sha256 {
        return Err(anyhow!(
            "pending payload changed during staging; material retained"
        ));
    }
    Ok(FinalizedPendingUpload { filename })
}

/// Staging is retained on an early return or panic. Only a durable source
/// receipt authorizes removing its redundant payload, never ordinary Drop.
pub struct PendingUploadGuard<'a> {
    vault: &'a VaultLayout,
    upload_id: String,
}

impl<'a> PendingUploadGuard<'a> {
    pub fn new(vault: &'a VaultLayout, upload_id: String) -> Self {
        Self { vault, upload_id }
    }
    pub fn mark_committed(&self) -> Result<()> {
        mark_pending_upload_committed(self.vault, &self.upload_id)
    }
}

pub fn mark_pending_upload_committed(vault: &VaultLayout, upload_id: &str) -> Result<()> {
    let dir = pending_upload_dir(vault, upload_id)?;
    let _lock = lock_upload(&dir)?;
    let mut manifest = load_pending_upload(vault, upload_id)?;
    let finalization = manifest
        .finalization
        .as_ref()
        .ok_or_else(|| anyhow!("cannot clean an upload without known publication"))?;
    let dest = vault.new_media_path(&finalization.filename);
    files::validate_vault_write_target(vault, &dest)?;
    if sha256_file(&dest)? != finalization.sha256 {
        return Err(anyhow!("cannot clean an upload with changed source media"));
    }
    std::fs::File::open(&dest)?.sync_all()?;
    files::sync_parent_directory(&dest)?;
    manifest.finalization.as_mut().unwrap().published = true;
    manifest.committed = true;
    write_manifest(&dir, &manifest)?;
    remove_committed_payload(&dir, &manifest)?;
    Ok(())
}

fn remove_committed_payload(dir: &Path, manifest: &PendingUploadManifest) -> Result<bool> {
    if !manifest.committed {
        return Ok(false);
    }
    let finalization = manifest
        .finalization
        .as_ref()
        .filter(|entry| entry.published)
        .ok_or_else(|| anyhow!("committed upload lacks publication evidence"))?;
    let payload = dir.join(&manifest.payload_filename);
    match std::fs::symlink_metadata(&payload) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(anyhow!("refusing staged payload symlink"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
        _ => {}
    }
    if sha256_file(&payload)? != finalization.sha256 {
        return Err(anyhow!(
            "staged payload changed after publication; retaining unknown bytes"
        ));
    }
    std::fs::remove_file(&payload)?;
    files::sync_parent_directory(&payload)?;
    Ok(true)
}

/// Retry redundant-payload cleanup after this delay; age alone proves nothing.
pub const STALE_UPLOAD_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Remove only payloads already covered by a durable committed marker. Unknown
/// or legacy staging is retained regardless of age; compact receipts remain.
pub fn sweep_stale_pending_uploads(
    vault: &VaultLayout,
    max_age: std::time::Duration,
) -> Result<usize> {
    let root = pending_uploads_dir(vault);
    if !root.is_dir() {
        return Ok(0);
    }
    let now = std::time::SystemTime::now();
    let mut removed = 0usize;
    for entry in std::fs::read_dir(&root)
        .with_context(|| format!("failed to read pending uploads: {}", root.display()))?
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(age) = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .map(|modified| now.duration_since(modified).unwrap_or_default())
        else {
            continue;
        };
        if age < max_age {
            continue;
        }
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(_lock) = lock_upload(&entry.path()) else {
            continue;
        };
        let Ok(manifest) = load_pending_upload(vault, &id) else {
            continue;
        };
        if remove_committed_payload(&entry.path(), &manifest).unwrap_or(false) {
            removed += 1;
        }
    }
    Ok(removed)
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

    if file_name.starts_with('.')
        || file_name == MANIFEST_FILE
        || file_name.contains('/')
        || file_name.contains('\\')
    {
        return Err(anyhow!("invalid upload filename"));
    }
    if file_name.contains('\0') {
        return Err(anyhow!("invalid upload filename"));
    }
    Ok(file_name.to_string())
}

/// A free file name for the finalized media.
///
/// Collisions are checked across the whole vault, not just the destination
/// folder: references are bare names resolved by basename, so two files with
/// the same name in different folders would make every link to them ambiguous.
fn dedupe_final_filename(vault: &VaultLayout, uploaded: &str, final_stem: &str) -> Result<String> {
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
    while media_exists_in_vault(vault, &candidate) {
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

    #[test]
    fn sc2_pending_preparation_copies_only_into_journal_staging_and_keeps_binding() {
        let dir = tempfile::tempdir().unwrap();
        let vault =
            vault_for(&dir).with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        let staging = VaultLayout::new(dir.path().join("operations/capture.staging"))
            .with_write_layout(vault.write_layout().clone());
        std::fs::create_dir_all(staging.root()).unwrap();
        let upload = write_pending_upload(&vault, "shot.png", None, b"original bytes").unwrap();
        let prepared =
            prepare_pending_upload(&vault, &staging, &upload.upload_id, "Capture").unwrap();
        assert_eq!(prepared.filename, "Capture.png");
        assert!(!vault.new_media_path(&prepared.filename).exists());
        assert_eq!(
            std::fs::read(staging.new_media_path(&prepared.filename)).unwrap(),
            b"original bytes"
        );
        let manifest = load_pending_upload(&vault, &upload.upload_id).unwrap();
        assert!(!manifest.finalization.unwrap().published);
        assert!(!manifest.committed);
        assert!(prepare_pending_upload(&vault, &staging, &upload.upload_id, "Different").is_err());
        // Once in the prepared plan, source publication no longer needs the
        // HTTP-upload cache: copy from durable journal-owned material.
        std::fs::remove_file(
            pending_upload_dir(&vault, &upload.upload_id)
                .unwrap()
                .join("shot.png"),
        )
        .unwrap();
        files::copy_new_atomically(
            &staging.new_media_path(&prepared.filename),
            &vault.new_media_path(&prepared.filename),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(vault.new_media_path(&prepared.filename)).unwrap(),
            b"original bytes"
        );
    }

    fn vault_for(dir: &TempDir) -> VaultLayout {
        let vault =
            VaultLayout::with_derived_root(dir.path().join("vault"), dir.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();
        vault
    }

    #[test]
    fn pending_upload_is_bound_to_folder_even_when_copied_vaults_share_derived_id() {
        let dir = TempDir::new().unwrap();
        let vault = vault_for(&dir);
        let copied = VaultLayout::with_derived_root(
            dir.path().join("copy"),
            vault.derived_root().to_path_buf(),
        );
        std::fs::create_dir(copied.root()).unwrap();
        let upload = write_pending_upload(&vault, "shot.jpg", None, b"original upload").unwrap();
        assert!(load_pending_upload(&copied, &upload.upload_id).is_err());
        assert!(finalize_pending_upload(&copied, &upload.upload_id, "Card").is_err());
        assert!(std::fs::read_dir(copied.root()).unwrap().next().is_none());
        let staged = pending_upload_dir(&vault, &upload.upload_id).unwrap();
        assert_eq!(
            std::fs::read(staged.join("shot.jpg")).unwrap(),
            b"original upload"
        );
        let mut old = load_pending_upload(&vault, &upload.upload_id).unwrap();
        old.vault_binding = None;
        write_manifest(&staged, &old).unwrap();
        assert!(finalize_pending_upload(&vault, &upload.upload_id, "Card").is_err());
        assert_eq!(
            sweep_stale_pending_uploads(&vault, std::time::Duration::ZERO).unwrap(),
            0
        );
        assert_eq!(
            std::fs::read(staged.join("shot.jpg")).unwrap(),
            b"original upload"
        );
    }

    #[test]
    fn sc0_n2_repeated_finalization_reuses_verified_publication() {
        let dir = TempDir::new().unwrap();
        let vault = vault_for(&dir);
        let upload =
            write_pending_upload(&vault, "shot.jpg", None, b"SC0 pending payload").unwrap();
        let first = finalize_pending_upload(&vault, &upload.upload_id, "Door").unwrap();
        let repeated = finalize_pending_upload(&vault, &upload.upload_id, "Door").unwrap();
        assert_eq!(first.filename, "Door.jpg");
        assert_eq!(repeated.filename, first.filename);
        assert!(!vault.new_media_path("Door (2).jpg").exists());
        let manifest = load_pending_upload(&vault, &upload.upload_id).unwrap();
        assert!(manifest.finalization.as_ref().unwrap().published);
        assert!(pending_upload_dir(&vault, &upload.upload_id)
            .unwrap()
            .join(&manifest.payload_filename)
            .exists());
        eprintln!("SC0 N2 regression: same upload ID reuses Door.jpg; finalized receipt and staging retained");
    }

    #[test]
    fn pending_upload_does_not_write_source_vault_until_finalize() {
        let dir = TempDir::new().unwrap();
        let vault = vault_for(&dir);
        let upload = write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        assert!(!vault.new_media_path("shot.jpg").exists());
        finalize_pending_upload(&vault, &upload.upload_id, "Card").unwrap();
        assert_eq!(
            std::fs::read(vault.new_media_path("Card.jpg")).unwrap(),
            b"bytes"
        );
    }

    #[test]
    fn explicit_commit_removes_payload_but_retains_compact_receipt() {
        let dir = TempDir::new().unwrap();
        let vault = vault_for(&dir);
        let upload = write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        finalize_pending_upload(&vault, &upload.upload_id, "Card").unwrap();
        let staged = pending_upload_dir(&vault, &upload.upload_id).unwrap();
        PendingUploadGuard::new(&vault, upload.upload_id.clone())
            .mark_committed()
            .unwrap();
        assert!(staged.join(MANIFEST_FILE).exists());
        assert!(!staged.join("shot.jpg").exists());
        assert!(
            load_pending_upload(&vault, &upload.upload_id)
                .unwrap()
                .committed
        );
        assert_eq!(
            finalize_pending_upload(&vault, &upload.upload_id, "Card")
                .unwrap()
                .filename,
            "Card.jpg"
        );
    }

    #[test]
    fn failed_save_and_ttl_keep_unknown_staging() {
        let dir = TempDir::new().unwrap();
        let vault = vault_for(&dir);
        let upload = write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        {
            let _guard = PendingUploadGuard::new(&vault, upload.upload_id.clone());
        }
        assert_eq!(
            sweep_stale_pending_uploads(&vault, std::time::Duration::ZERO).unwrap(),
            0
        );
        let staged = pending_upload_dir(&vault, &upload.upload_id).unwrap();
        assert_eq!(std::fs::read(staged.join("shot.jpg")).unwrap(), b"bytes");
        assert!(mark_pending_upload_committed(&vault, &upload.upload_id).is_err());
    }

    #[test]
    fn sweep_cleans_only_proven_redundant_payload_and_keeps_receipts() {
        let dir = TempDir::new().unwrap();
        let vault = vault_for(&dir);
        assert_eq!(
            sweep_stale_pending_uploads(&vault, std::time::Duration::ZERO).unwrap(),
            0
        );
        let upload = write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        finalize_pending_upload(&vault, &upload.upload_id, "Card").unwrap();
        // State reconstruction: commit marker was persisted, process stopped
        // before redundant payload removal. This is not a process kill test.
        let staged = pending_upload_dir(&vault, &upload.upload_id).unwrap();
        let mut manifest = load_pending_upload(&vault, &upload.upload_id).unwrap();
        manifest.committed = true;
        write_manifest(&staged, &manifest).unwrap();
        assert_eq!(
            sweep_stale_pending_uploads(&vault, std::time::Duration::ZERO).unwrap(),
            1
        );
        assert_eq!(
            sweep_stale_pending_uploads(&vault, std::time::Duration::ZERO).unwrap(),
            0
        );
        assert!(staged.join(MANIFEST_FILE).exists());
        assert!(!staged.join("shot.jpg").exists());
    }

    #[test]
    fn sweep_does_not_delete_changed_staging_even_with_commit_marker() {
        let dir = TempDir::new().unwrap();
        let vault = vault_for(&dir);
        let upload = write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        finalize_pending_upload(&vault, &upload.upload_id, "Card").unwrap();
        let staged = pending_upload_dir(&vault, &upload.upload_id).unwrap();
        let mut manifest = load_pending_upload(&vault, &upload.upload_id).unwrap();
        manifest.committed = true;
        write_manifest(&staged, &manifest).unwrap();
        std::fs::write(staged.join("shot.jpg"), b"unrecognized bytes").unwrap();
        assert_eq!(
            sweep_stale_pending_uploads(&vault, std::time::Duration::ZERO).unwrap(),
            0
        );
        assert_eq!(
            std::fs::read(staged.join("shot.jpg")).unwrap(),
            b"unrecognized bytes"
        );
    }

    #[test]
    fn changed_or_missing_published_media_is_unknown_and_never_republished() {
        let dir = TempDir::new().unwrap();
        let vault = vault_for(&dir);
        let upload = write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        finalize_pending_upload(&vault, &upload.upload_id, "Card").unwrap();
        std::fs::write(vault.new_media_path("Card.jpg"), b"user changed").unwrap();
        assert!(finalize_pending_upload(&vault, &upload.upload_id, "Card").is_err());
        assert!(mark_pending_upload_committed(&vault, &upload.upload_id).is_err());
        assert_eq!(
            std::fs::read(vault.new_media_path("Card.jpg")).unwrap(),
            b"user changed"
        );
        std::fs::remove_file(vault.new_media_path("Card.jpg")).unwrap();
        assert!(finalize_pending_upload(&vault, &upload.upload_id, "Card").is_err());
        assert!(!vault.new_media_path("Card (2).jpg").exists());
        assert!(pending_upload_dir(&vault, &upload.upload_id)
            .unwrap()
            .join("shot.jpg")
            .exists());
    }

    #[test]
    fn pending_upload_finalization_dedupes_source_vault_collisions() {
        let dir = TempDir::new().unwrap();
        let vault =
            vault_for(&dir).with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        std::fs::create_dir_all(vault.media_dir()).unwrap();
        std::fs::write(vault.new_media_path("Door.jpg"), b"existing").unwrap();
        let upload = write_pending_upload(&vault, "shot.jpg", None, b"new").unwrap();
        assert_eq!(
            finalize_pending_upload(&vault, &upload.upload_id, "Door")
                .unwrap()
                .filename,
            "Door (2).jpg"
        );
        assert_eq!(
            std::fs::read(vault.new_media_path("Door.jpg")).unwrap(),
            b"existing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_payload_or_media_directory_cannot_escape_vault() {
        let dir = TempDir::new().unwrap();
        let vault =
            vault_for(&dir).with_write_layout(crate::domain::vault::VaultWriteLayout::standard());
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, vault.media_dir()).unwrap();
        let upload = write_pending_upload(&vault, "shot.jpg", None, b"bytes").unwrap();
        assert!(finalize_pending_upload(&vault, &upload.upload_id, "Card").is_err());
        assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
    }
}
