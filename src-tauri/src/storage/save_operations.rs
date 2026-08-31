//! Durable native capture receipts, separate from disposable index/preview data.
//! The caller supplies the state root; this module never resolves user folders.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain::vault::VaultLayout;
use crate::storage::files;
use mine_core::save::{next_save_action, PublicationEvidence, SaveAction, SaveEvidence, SavePhase};

const RECORD_VERSION: u32 = 1;

/// Fingerprint of content, never an application-owned card identity.
pub fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Hash a source artifact without copying large media into the journal.
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("open artifact {}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Canonical folder binding; equal display names do not imply equal bindings.
pub fn binding_id(vault: &VaultLayout) -> Result<String> {
    let root = vault
        .root()
        .canonicalize()
        .context("cannot resolve vault binding")?;
    let path = root.to_str().context("vault path is not valid Unicode")?;
    Ok(sha256_bytes(path.as_bytes()))
}

/// An artifact whose bytes must still match before a receipt is recovered.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceArtifact {
    pub relative_path: String,
    pub sha256: String,
}

impl SourceArtifact {
    pub fn inspect(vault: &VaultLayout, path: &Path) -> Result<Self> {
        files::validate_vault_write_target(vault, path)?;
        Ok(Self {
            relative_path: path
                .strip_prefix(vault.root())?
                .to_str()
                .context("artifact path is not Unicode")?
                .to_string(),
            sha256: sha256_file(path)?,
        })
    }

    pub fn matches(&self, vault: &VaultLayout) -> bool {
        self.evidence(vault) == mine_core::save::PublicationEvidence::Matches
    }

    fn evidence(&self, vault: &VaultLayout) -> mine_core::save::PublicationEvidence {
        use mine_core::save::PublicationEvidence;
        let path = vault.root().join(&self.relative_path);
        if files::validate_vault_write_target(vault, &path).is_err() {
            return PublicationEvidence::Unreadable;
        }
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                PublicationEvidence::Missing
            }
            Err(_) => PublicationEvidence::Unreadable,
            Ok(_) => match sha256_file(&path) {
                Ok(hash) if hash == self.sha256 => PublicationEvidence::Matches,
                Ok(_) => PublicationEvidence::Conflict,
                Err(_) => PublicationEvidence::Unreadable,
            },
        }
    }
}

/// Native persistence of a capture, not a second save algorithm.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum OperationPhase {
    /// Legacy v1 records may already have source effects: never resume them.
    Preparing,
    /// New acquisition writes only inside the journal-owned staging directory.
    StagingV2,
    PlannedV2 {
        step: SavePhase,
        plan: StagedSavePlan,
    },
    Publishing {
        markdown: SourceArtifact,
        media: Vec<SourceArtifact>,
        response: serde_json::Value,
    },
    Committed {
        response: serde_json::Value,
    },
    Rejected {
        response: serde_json::Value,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TargetPublication {
    Pending,
    Publishing,
    Published,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedArtifact {
    #[serde(flatten)]
    pub source: SourceArtifact,
    pub size: u64,
    pub staged_resource: String,
    pub publication_state: TargetPublication,
}

impl PlannedArtifact {
    pub fn inspect(staging: &VaultLayout, path: &Path) -> Result<Self> {
        let source = SourceArtifact::inspect(staging, path)?;
        Ok(Self {
            staged_resource: source.relative_path.clone(),
            source,
            size: std::fs::metadata(path)?.len(),
            publication_state: TargetPublication::Pending,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StagedSavePlan {
    /// Persisted before layout initialization or source artifacts. Early
    /// development records without a snapshot cannot safely auto-resume.
    #[serde(default)]
    pub write_layout: Option<crate::domain::vault::VaultWriteLayout>,
    pub markdown: PlannedArtifact,
    pub media: Vec<PlannedArtifact>,
    pub response: serde_json::Value,
}

impl StagedSavePlan {
    fn evidence(&self, vault: &VaultLayout) -> SaveEvidence {
        let observations: Vec<_> = self
            .media
            .iter()
            .map(|target| target.source.evidence(vault))
            .collect();
        let media = if observations.is_empty() {
            PublicationEvidence::NotRequired
        } else if observations.contains(&PublicationEvidence::Conflict) {
            PublicationEvidence::Conflict
        } else if observations.contains(&PublicationEvidence::Unreadable) {
            PublicationEvidence::Unreadable
        } else if observations.contains(&PublicationEvidence::Missing) {
            PublicationEvidence::Missing
        } else {
            PublicationEvidence::Matches
        };
        SaveEvidence {
            markdown: self.markdown.source.evidence(vault),
            media,
        }
    }

    fn action(&self, step: SavePhase, vault: &VaultLayout) -> SaveAction {
        let evidence = self.evidence(vault);
        // A mixed set of missing/existing targets cannot be summarized as all
        // missing before the first effect. Ask the shared rule for each one.
        if step == SavePhase::Prepared {
            for target in &self.media {
                let action = next_save_action(
                    step,
                    &SaveEvidence {
                        markdown: evidence.markdown,
                        media: target.source.evidence(vault),
                    },
                );
                if !matches!(
                    action,
                    SaveAction::PublishMedia | SaveAction::PublishMarkdown
                ) {
                    return action;
                }
            }
        }
        next_save_action(step, &evidence)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveOperationRecord {
    pub version: u32,
    pub operation_id: String,
    pub binding_id: String,
    pub fingerprint: String,
    pub reserved_name: Option<String>,
    #[serde(default)]
    pub pending_upload_id: Option<String>,
    pub phase: OperationPhase,
}

/// Owns operation files outside the caller's disposable index/cache tree.
#[derive(Debug, Clone)]
pub struct SaveOperationStore {
    root: PathBuf,
}

impl SaveOperationStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Serialize native operations for a binding across independent processes.
    /// The file remains at one stable path; unlinking a lock would split owners.
    pub fn lock(&self, binding: &str) -> Result<LockedSaveOperations> {
        validate_id(binding)?;
        let directory = self.root.join(binding);
        let mut created = Vec::new();
        let mut ancestor = directory.as_path();
        loop {
            match std::fs::symlink_metadata(ancestor) {
                Ok(_) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    created.push(ancestor.to_path_buf());
                    ancestor = ancestor
                        .parent()
                        .context("journal has no existing parent")?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        std::fs::create_dir_all(&directory).context("create operation journal")?;
        if std::fs::symlink_metadata(&directory)?
            .file_type()
            .is_symlink()
        {
            anyhow::bail!("operation journal must not be a symlink");
        }
        // Anchor every new directory entry before accepting durable records.
        for path in created {
            files::sync_parent_directory(&path)?;
        }
        let lock_path = directory.join(".lock");
        if std::fs::symlink_metadata(&lock_path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            anyhow::bail!("operation lock must not be a symlink");
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)?;
        FileExt::lock_exclusive(&lock).context("lock capture journal")?;
        Ok(LockedSaveOperations {
            directory,
            binding: binding.to_string(),
            _lock: lock,
        })
    }
}

/// The open locked file releases the process lock when this value drops.
pub struct LockedSaveOperations {
    directory: PathBuf,
    binding: String,
    _lock: File,
}

impl LockedSaveOperations {
    fn path(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        Ok(self.directory.join(format!("{id}.json")))
    }

    pub fn load(&self, id: &str) -> Result<Option<SaveOperationRecord>> {
        let path = self.path(id)?;
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            anyhow::bail!("operation record must not be a symlink");
        }
        let record: SaveOperationRecord = serde_json::from_slice(&std::fs::read(&path)?)?;
        if record.version != RECORD_VERSION
            || record.operation_id != id
            || record.binding_id != self.binding
        {
            anyhow::bail!("operation record identity/version mismatch");
        }
        Ok(Some(record))
    }

    pub fn begin(
        &self,
        id: &str,
        fingerprint: String,
        request: &serde_json::Value,
    ) -> Result<SaveOperationRecord> {
        if self.load(id)?.is_some() {
            anyhow::bail!("operation already exists");
        }
        if std::fs::symlink_metadata(self.staging_root(id)?).is_ok()
            || std::fs::symlink_metadata(self.directory.join(format!("{id}.request.json"))).is_ok()
        {
            anyhow::bail!("operation material exists without its receipt; outcome is unknown");
        }
        let record = SaveOperationRecord {
            version: RECORD_VERSION,
            operation_id: id.to_string(),
            binding_id: self.binding.clone(),
            fingerprint,
            reserved_name: None,
            pending_upload_id: None,
            phase: OperationPhase::StagingV2,
        };
        let request_path = self.directory.join(format!("{id}.request.json"));
        files::write_atomically(&request_path, &serde_json::to_vec(request)?)?;
        self.store(&record)?;
        Ok(record)
    }

    pub fn store(&self, record: &SaveOperationRecord) -> Result<()> {
        if record.binding_id != self.binding {
            anyhow::bail!("operation binding mismatch");
        }
        let path = self.path(&record.operation_id)?;
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            anyhow::bail!("operation record must not be a symlink");
        }
        files::write_atomically(&path, &serde_json::to_vec(record)?)
    }

    pub fn staging_root(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        Ok(self.directory.join(format!("{id}.staging")))
    }

    pub fn create_staging(&self, id: &str) -> Result<PathBuf> {
        let root = self.staging_root(id)?;
        // Never reuse a directory left without its ledger: its ownership and
        // the previous result are unknown, even if the operation ID matches.
        std::fs::create_dir(&root).context("create operation-owned staging")?;
        files::sync_parent_directory(&root)?;
        Ok(root)
    }

    fn staged_path(&self, id: &str, target: &PlannedArtifact) -> Result<PathBuf> {
        let root = self.staging_root(id)?;
        if std::fs::symlink_metadata(&root)?.file_type().is_symlink() {
            anyhow::bail!("staging root is a symlink");
        }
        let staging = VaultLayout::new(root);
        let path = staging.root().join(&target.staged_resource);
        files::validate_vault_write_target(&staging, &path)?;
        if std::fs::metadata(&path)?.len() != target.size
            || sha256_file(&path)? != target.source.sha256
        {
            anyhow::bail!("staged artifact changed: {}", target.staged_resource);
        }
        Ok(path)
    }

    pub fn prepare_plan(
        &self,
        record: &mut SaveOperationRecord,
        plan: StagedSavePlan,
    ) -> Result<()> {
        if !matches!(record.phase, OperationPhase::StagingV2) {
            anyhow::bail!("operation already has publication history");
        }
        plan.write_layout
            .as_ref()
            .context("prepared plan lacks layout snapshot")?
            .validate()
            .map_err(|error| anyhow::anyhow!(error))?;
        let mut targets = std::collections::HashSet::new();
        let staging_root = self.staging_root(&record.operation_id)?;
        for target in std::iter::once(&plan.markdown).chain(plan.media.iter()) {
            let staged = self.staged_path(&record.operation_id, target)?;
            sync_artifact_tree(&staging_root, &staged)?;
            if !targets.insert(&target.source.relative_path) {
                anyhow::bail!("duplicate target in save plan");
            }
        }
        record.phase = OperationPhase::PlannedV2 {
            step: SavePhase::Prepared,
            plan,
        };
        self.store(record)
    }

    pub fn can_resume(&self, record: &SaveOperationRecord, vault: &VaultLayout) -> bool {
        let OperationPhase::PlannedV2 { step, plan } = &record.phase else {
            return false;
        };
        matches!(
            plan.action(*step, vault),
            SaveAction::PublishMedia | SaveAction::PublishMarkdown
        ) && plan.write_layout.is_some()
            && std::iter::once(&plan.markdown)
                .chain(plan.media.iter())
                .all(|target| self.staged_path(&record.operation_id, target).is_ok())
    }

    pub fn publish_plan(
        &self,
        record: &mut SaveOperationRecord,
        vault: &VaultLayout,
    ) -> Result<serde_json::Value> {
        self.publish_plan_with(record, vault, files::copy_new_atomically)
    }

    /// Concrete native effects only; shared core decides every next action.
    /// A publisher injection makes each persisted intent boundary testable.
    pub fn publish_plan_with(
        &self,
        record: &mut SaveOperationRecord,
        vault: &VaultLayout,
        mut publish: impl FnMut(&Path, &Path) -> Result<()>,
    ) -> Result<serde_json::Value> {
        loop {
            let OperationPhase::PlannedV2 { step, plan } = &record.phase else {
                return self
                    .recovered_response(record, vault)?
                    .ok_or_else(|| anyhow::anyhow!("operation outcome is unknown"));
            };
            let action = plan.action(*step, vault);
            match action {
                SaveAction::PublishMedia => {
                    files::ensure_vault_write_layout(
                        vault,
                        plan.write_layout
                            .as_ref()
                            .context("prepared plan lacks layout snapshot")?,
                    )?;
                    let count = plan.media.len();
                    for index in 0..count {
                        let OperationPhase::PlannedV2 { step, plan } = &mut record.phase else {
                            unreachable!()
                        };
                        *step = SavePhase::MediaPublishing;
                        plan.media[index].publication_state = TargetPublication::Publishing;
                        let target = plan.media[index].clone();
                        let staged = self.staged_path(&record.operation_id, &target)?;
                        let destination = vault.root().join(&target.source.relative_path);
                        files::validate_vault_write_target(vault, &destination)?;
                        self.store(record)?;
                        publish(&staged, &destination)?;
                        let OperationPhase::PlannedV2 { plan, .. } = &mut record.phase else {
                            unreachable!()
                        };
                        plan.media[index].publication_state = TargetPublication::Published;
                        self.store(record)?;
                    }
                    let OperationPhase::PlannedV2 { step, .. } = &mut record.phase else {
                        unreachable!()
                    };
                    *step = SavePhase::MediaPublished;
                    self.store(record)?;
                }
                SaveAction::PublishMarkdown => {
                    files::ensure_vault_write_layout(
                        vault,
                        plan.write_layout
                            .as_ref()
                            .context("prepared plan lacks layout snapshot")?,
                    )?;
                    // Recovery may observe publication whose original fsync
                    // acknowledgement was lost. Confirm media durability first.
                    for target in &plan.media {
                        let path = vault.root().join(&target.source.relative_path);
                        sync_artifact_tree(vault.root(), &path)?;
                    }
                    let target = plan.markdown.clone();
                    let staged = self.staged_path(&record.operation_id, &target)?;
                    let destination = vault.root().join(&target.source.relative_path);
                    files::validate_vault_write_target(vault, &destination)?;
                    let OperationPhase::PlannedV2 { step, plan } = &mut record.phase else {
                        unreachable!()
                    };
                    *step = SavePhase::MarkdownPublishing;
                    plan.markdown.publication_state = TargetPublication::Publishing;
                    self.store(record)?;
                    if let Err(error) = publish(&staged, &destination) {
                        // The atomic publisher distinguishes a completed link
                        // from a failed create-new. Only known Markdown
                        // publication plus exact source evidence can commit
                        // with a durability warning. Keep durable staging.
                        if files::publication_is_uncertain(&error) {
                            let OperationPhase::PlannedV2 { step, plan } = &record.phase else {
                                unreachable!()
                            };
                            if plan.action(*step, vault) == SaveAction::PersistReceipt {
                                let response = plan.response.clone();
                                return self
                                    .commit_with_durability_warning(record, response, &error);
                            }
                        }
                        return Err(error);
                    }
                    let OperationPhase::PlannedV2 { step, plan } = &mut record.phase else {
                        unreachable!()
                    };
                    *step = SavePhase::SourceCommitted;
                    plan.markdown.publication_state = TargetPublication::Published;
                    self.store(record)?;
                }
                SaveAction::PersistReceipt | SaveAction::ReturnCommitted => {
                    return self
                        .recovered_response(record, vault)?
                        .ok_or_else(|| anyhow::anyhow!("publication could not be confirmed"));
                }
                SaveAction::NameConflict => {
                    if *step == SavePhase::Prepared {
                        return self.reject_prepared_conflict(record);
                    }
                    anyhow::bail!("source name conflict; no target may be replaced")
                }
                SaveAction::UnknownOutcome => {
                    anyhow::bail!("publication outcome is unknown; plan and material retained")
                }
            }
        }
    }

    /// Recover only exact committed bytes. Missing/changed artifacts are unknown,
    /// never proof that the first save did not happen.
    pub fn recovered_response(
        &self,
        record: &mut SaveOperationRecord,
        vault: &VaultLayout,
    ) -> Result<Option<serde_json::Value>> {
        use mine_core::save::{
            next_save_action, PublicationEvidence, SaveAction, SaveEvidence, SavePhase,
        };
        match &record.phase {
            OperationPhase::Committed { response } => {
                let action = next_save_action(
                    SavePhase::Committed,
                    &SaveEvidence {
                        markdown: PublicationEvidence::Missing,
                        media: PublicationEvidence::Missing,
                    },
                );
                Ok((action == SaveAction::ReturnCommitted).then(|| response.clone()))
            }
            OperationPhase::Rejected { response } => Ok(Some(response.clone())),
            OperationPhase::StagingV2 => {
                let response = serde_json::json!({
                    "ok": false, "operation_id": record.operation_id,
                    "outcome": "not_committed", "terminal_rejected": true,
                    "code": "preparation_interrupted",
                    "error": "Preparation stopped before source publication; request and staged material retained",
                });
                self.reject_preparation(record, response.clone())?;
                Ok(Some(response))
            }
            OperationPhase::PlannedV2 { step, plan } => {
                let action = plan.action(*step, vault);
                if *step == SavePhase::Prepared && action == SaveAction::NameConflict {
                    return self.reject_prepared_conflict(record).map(Some);
                }
                if action != SaveAction::PersistReceipt {
                    return Ok(None);
                }
                for artifact in std::iter::once(&plan.markdown).chain(plan.media.iter()) {
                    let path = vault.root().join(&artifact.source.relative_path);
                    if let Err(error) = sync_artifact_tree(vault.root(), &path) {
                        // Re-observe after the failed confirmation: disappearing
                        // or changed files cannot become a committed warning.
                        if plan.action(*step, vault) != SaveAction::PersistReceipt {
                            return Ok(None);
                        }
                        let response = plan.response.clone();
                        return self
                            .commit_with_durability_warning(record, response, &error)
                            .map(Some);
                    }
                }
                let response = plan.response.clone();
                self.commit(record, response.clone())?;
                Ok(Some(response))
            }
            OperationPhase::Preparing => {
                // Preparation may already have begun resource effects; unlike
                // a pure Prepared request it is not automatically replayable.
                let action = next_save_action(
                    SavePhase::MediaPublishing,
                    &SaveEvidence {
                        markdown: PublicationEvidence::Missing,
                        media: PublicationEvidence::Missing,
                    },
                );
                debug_assert_eq!(action, SaveAction::UnknownOutcome);
                Ok(None)
            }
            OperationPhase::Publishing {
                markdown,
                media,
                response,
            } => {
                let evidence = SaveEvidence {
                    markdown: markdown.evidence(vault),
                    media: if media.is_empty() {
                        PublicationEvidence::NotRequired
                    } else {
                        media
                            .iter()
                            .map(|artifact| artifact.evidence(vault))
                            .find(|evidence| *evidence != PublicationEvidence::Matches)
                            .unwrap_or(PublicationEvidence::Matches)
                    },
                };
                if next_save_action(SavePhase::MarkdownPublishing, &evidence)
                    != SaveAction::PersistReceipt
                {
                    return Ok(None);
                }
                // A prior caller may have lost fsync's acknowledgement after
                // publication. Re-confirm durability before recording success.
                for artifact in std::iter::once(markdown).chain(media.iter()) {
                    let path = vault.root().join(&artifact.relative_path);
                    sync_artifact_tree(vault.root(), &path)?;
                }
                let response = response.clone();
                self.commit(record, response.clone())?;
                Ok(Some(response))
            }
        }
    }

    pub fn commit(
        &self,
        record: &mut SaveOperationRecord,
        response: serde_json::Value,
    ) -> Result<()> {
        let cleanup = match &record.phase {
            OperationPhase::PlannedV2 { plan, .. } => Some(plan.clone()),
            _ => None,
        };
        record.phase = OperationPhase::Committed { response };
        self.store(record)?;
        if let Some(plan) = cleanup {
            self.clean_staged_payload(record, &plan);
        }
        self.clean_request_payload(record);
        Ok(())
    }

    fn commit_with_durability_warning(
        &self,
        record: &mut SaveOperationRecord,
        mut response: serde_json::Value,
        error: &anyhow::Error,
    ) -> Result<serde_json::Value> {
        let warning = format!("Source published; durability confirmation failed: {error:#}. Recovery material retained.");
        response["durability_warning"] = serde_json::json!(warning);
        response["warning"] = serde_json::json!(match response["warning"].as_str() {
            Some(existing) => format!("{existing}; {warning}"),
            None => warning,
        });
        record.phase = OperationPhase::Committed {
            response: response.clone(),
        };
        self.store(record)?;
        // Neither request nor staged resources are disposable in this case.
        Ok(response)
    }

    fn clean_staged_payload(&self, record: &SaveOperationRecord, plan: &StagedSavePlan) {
        let Ok(root) = self.staging_root(&record.operation_id) else {
            return;
        };
        let mut directories = std::collections::HashSet::new();
        for target in std::iter::once(&plan.markdown).chain(plan.media.iter()) {
            // Only receipt-covered, byte-identical resources belong to this
            // operation. Preserve changed, symlinked and unrecognized material.
            let Ok(path) = self.staged_path(&record.operation_id, target) else {
                continue;
            };
            if let Err(error) = std::fs::remove_file(&path) {
                log::warn!("committed staging cleanup deferred: {error}");
                continue;
            }
            let _ = files::sync_parent_directory(&path);
            let mut directory = path.parent();
            while let Some(path) = directory {
                if !path.starts_with(&root) {
                    break;
                }
                directories.insert(path.to_path_buf());
                directory = path.parent();
            }
        }
        let mut directories: Vec<_> = directories.into_iter().collect();
        directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for directory in directories {
            // remove_dir cannot remove foreign entries, unlike recursive cleanup.
            if std::fs::remove_dir(&directory).is_ok() {
                let _ = files::sync_parent_directory(&directory);
            }
        }
    }

    pub fn reject(
        &self,
        record: &mut SaveOperationRecord,
        response: serde_json::Value,
    ) -> Result<()> {
        record.phase = OperationPhase::Rejected { response };
        self.store(record)?;
        self.clean_request_payload(record);
        Ok(())
    }

    /// Unlike a preflight validation rejection, interrupted acquisition keeps
    /// the immutable request as well as any staged bytes: no Markdown plan
    /// exists yet and it may be the only copy of the captured body/URL.
    pub fn reject_preparation(
        &self,
        record: &mut SaveOperationRecord,
        response: serde_json::Value,
    ) -> Result<()> {
        if !matches!(record.phase, OperationPhase::StagingV2) {
            anyhow::bail!("cannot reject an operation with publication history");
        }
        record.phase = OperationPhase::Rejected { response };
        self.store(record)
    }

    fn reject_prepared_conflict(
        &self,
        record: &mut SaveOperationRecord,
    ) -> Result<serde_json::Value> {
        if !matches!(
            record.phase,
            OperationPhase::PlannedV2 {
                step: SavePhase::Prepared,
                ..
            }
        ) {
            anyhow::bail!("cannot reject a conflict after publication intent");
        }
        let response = serde_json::json!({
            "ok": false, "operation_id": record.operation_id,
            "outcome": "not_committed", "terminal_rejected": true,
            "code": "name_conflict",
            "error": "Target name is occupied; no source was published. Request and staged material retained",
        });
        record.phase = OperationPhase::Rejected {
            response: response.clone(),
        };
        self.store(record)?;
        Ok(response)
    }

    fn clean_request_payload(&self, record: &SaveOperationRecord) {
        // A durable compact receipt is retained. Only its now-redundant request
        // payload is removed; unknown/preparing records have no TTL cleanup.
        let request = self
            .directory
            .join(format!("{}.request.json", record.operation_id));
        match std::fs::remove_file(&request) {
            Ok(()) => {
                if let Err(error) = files::sync_parent_directory(&request) {
                    log::warn!("committed operation payload cleanup sync failed: {error}");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!("committed operation payload cleanup failed: {error}"),
        }
    }
}

/// Flush the file and every containing directory, including newly-created
/// nested layout entries. Immediate-parent fsync alone cannot anchor a tree.
fn sync_artifact_tree(root: &Path, path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    let mut directory = path.parent();
    while let Some(path) = directory {
        if !path.starts_with(root) {
            break;
        }
        File::open(path)?.sync_all()?;
        if path == root {
            break;
        }
        directory = path.parent();
    }
    Ok(())
}

pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        anyhow::bail!("invalid operation identifier");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> (tempfile::TempDir, VaultLayout, SaveOperationStore) {
        let tmp = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(tmp.path().join("vault"), tmp.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();
        std::fs::create_dir_all(vault.derived_root()).unwrap();
        let store = SaveOperationStore::new(tmp.path().join("operations").join("v1"));
        (tmp, vault, store)
    }

    fn staged_plan(
        locked: &LockedSaveOperations,
        id: &str,
        media_count: usize,
    ) -> SaveOperationRecord {
        let mut record = locked
            .begin(id, "fingerprint".into(), &json!({"body":"payload"}))
            .unwrap();
        let staging = VaultLayout::new(locked.create_staging(id).unwrap());
        let markdown = staging.root().join("Cards/Card.md");
        files::write_new_atomically(
            &markdown,
            b"---\nsaved_at: 2026-08-31T12:00:00Z\n---\nbody\n",
        )
        .unwrap();
        let media = (0..media_count)
            .map(|index| {
                let path = staging.root().join(format!("Media/Card-{index}.png"));
                files::write_new_atomically(&path, format!("media bytes {index}").as_bytes())
                    .unwrap();
                PlannedArtifact::inspect(&staging, &path).unwrap()
            })
            .collect();
        locked.prepare_plan(&mut record, StagedSavePlan {
            write_layout: Some(crate::domain::vault::VaultWriteLayout::standard()),
            markdown: PlannedArtifact::inspect(&staging, &markdown).unwrap(), media,
            response: json!({"ok":true,"outcome":"committed","operation_id":id,"slug":"Cards/Card"}),
        }).unwrap();
        record
    }

    #[test]
    fn sc2_complete_staged_plan_is_durable_before_every_source_effect() {
        let (_tmp, vault, store) = setup();
        let locked = store.lock(&binding_id(&vault).unwrap()).unwrap();
        let mut record = staged_plan(&locked, "complete-plan", 3);
        assert_eq!(std::fs::read_dir(vault.root()).unwrap().count(), 0);
        let mut effects = 0;
        locked
            .publish_plan_with(&mut record, &vault, |staged, target| {
                let disk = locked.load("complete-plan")?.unwrap();
                let OperationPhase::PlannedV2 { step, plan } = &disk.phase else {
                    panic!("missing plan")
                };
                assert_eq!(plan.media.len(), 3);
                for artifact in std::iter::once(&plan.markdown).chain(plan.media.iter()) {
                    assert!(locked.staged_path(&disk.operation_id, artifact).is_ok());
                    assert!(artifact.size > 0);
                }
                let expected = if effects < 3 {
                    &plan.media[effects]
                } else {
                    &plan.markdown
                };
                assert_eq!(expected.publication_state, TargetPublication::Publishing);
                assert_eq!(
                    *step,
                    if effects < 3 {
                        SavePhase::MediaPublishing
                    } else {
                        SavePhase::MarkdownPublishing
                    }
                );
                assert_eq!(target, vault.root().join(&expected.source.relative_path));
                assert!(!target.exists());
                if effects == 0 {
                    assert_eq!(std::fs::read_dir(vault.root())?.count(), 1);
                    assert!(vault.write_layout_path().is_file());
                }
                effects += 1;
                files::copy_new_atomically(staged, target)
            })
            .unwrap();
        assert_eq!(effects, 4);
        assert!(!locked.staging_root("complete-plan").unwrap().exists());
        assert!(!locked.directory.join("complete-plan.request.json").exists());
        assert!(matches!(
            locked.load("complete-plan").unwrap().unwrap().phase,
            OperationPhase::Committed { .. }
        ));
    }

    #[test]
    fn sc2_each_media_intent_without_publication_is_unknown_and_retains_material() {
        for fail_at in 0..3 {
            let (_tmp, vault, store) = setup();
            let locked = store.lock(&binding_id(&vault).unwrap()).unwrap();
            let mut record = staged_plan(&locked, "media-intent", 3);
            let mut index = 0;
            assert!(locked
                .publish_plan_with(&mut record, &vault, |staged, target| {
                    if index == fail_at {
                        anyhow::bail!("injected after media intent");
                    }
                    index += 1;
                    files::copy_new_atomically(staged, target)
                })
                .is_err());
            let mut disk = locked.load("media-intent").unwrap().unwrap();
            assert!(!locked.can_resume(&disk, &vault));
            assert!(locked
                .recovered_response(&mut disk, &vault)
                .unwrap()
                .is_none());
            let OperationPhase::PlannedV2 { step, plan } = &disk.phase else {
                panic!("missing plan")
            };
            assert_eq!(*step, SavePhase::MediaPublishing);
            assert_eq!(
                plan.media[fail_at].publication_state,
                TargetPublication::Publishing
            );
            for target in std::iter::once(&plan.markdown).chain(plan.media.iter()) {
                assert!(locked.staged_path("media-intent", target).is_ok());
            }
            for index in 0..3 {
                assert_eq!(
                    vault
                        .root()
                        .join(format!("Media/Card-{index}.png"))
                        .exists(),
                    index < fail_at
                );
            }
            assert!(!vault.root().join("Cards/Card.md").exists());
        }
    }

    #[test]
    fn sc2_each_media_publication_lost_ack_only_resumes_when_all_media_match() {
        for fail_at in 0..3 {
            let (_tmp, vault, store) = setup();
            let binding = binding_id(&vault).unwrap();
            {
                let locked = store.lock(&binding).unwrap();
                let mut record = staged_plan(&locked, "lost-media-ack", 3);
                let mut index = 0;
                assert!(locked
                    .publish_plan_with(&mut record, &vault, |staged, target| {
                        files::copy_new_atomically(staged, target)?;
                        if index == fail_at {
                            anyhow::bail!("injected after media publication");
                        }
                        index += 1;
                        Ok(())
                    })
                    .is_err());
            }
            // State reconstruction with a fresh lock/record, not an OS kill test.
            let locked = store.lock(&binding).unwrap();
            let mut disk = locked.load("lost-media-ack").unwrap().unwrap();
            assert_eq!(locked.can_resume(&disk, &vault), fail_at == 2);
            if fail_at == 2 {
                assert_eq!(
                    locked.publish_plan(&mut disk, &vault).unwrap()["outcome"],
                    "committed"
                );
            } else {
                assert!(locked
                    .recovered_response(&mut disk, &vault)
                    .unwrap()
                    .is_none());
                assert!(locked.staging_root("lost-media-ack").unwrap().exists());
                assert!(!vault.root().join("Cards/Card.md").exists());
            }
        }
    }

    #[test]
    fn sc2_markdown_intent_boundary_distinguishes_safe_resume_from_unknown() {
        let (_tmp, vault, store) = setup();
        let locked = store.lock(&binding_id(&vault).unwrap()).unwrap();
        let mut record = staged_plan(&locked, "before-markdown", 1);
        let OperationPhase::PlannedV2 { step, plan } = &mut record.phase else {
            unreachable!()
        };
        let staged = locked
            .staged_path("before-markdown", &plan.media[0])
            .unwrap();
        files::copy_new_atomically(
            &staged,
            &vault.root().join(&plan.media[0].source.relative_path),
        )
        .unwrap();
        plan.media[0].publication_state = TargetPublication::Published;
        *step = SavePhase::MediaPublished;
        locked.store(&record).unwrap();
        let mut disk = locked.load("before-markdown").unwrap().unwrap();
        assert!(locked.can_resume(&disk, &vault));
        assert!(locked
            .publish_plan_with(&mut disk, &vault, |_, _| anyhow::bail!(
                "after Markdown intent"
            ))
            .is_err());
        let mut disk = locked.load("before-markdown").unwrap().unwrap();
        assert!(!locked.can_resume(&disk, &vault));
        assert!(locked
            .recovered_response(&mut disk, &vault)
            .unwrap()
            .is_none());
        assert!(locked.staging_root("before-markdown").unwrap().exists());
        assert!(!vault.root().join("Cards/Card.md").exists());
    }

    #[test]
    fn sc2_prepared_plan_restart_uses_only_durable_material_and_exact_markdown() {
        let (_tmp, vault, store) = setup();
        let binding = binding_id(&vault).unwrap();
        let expected;
        {
            let locked = store.lock(&binding).unwrap();
            let record = staged_plan(&locked, "restart", 1);
            let OperationPhase::PlannedV2 { plan, .. } = &record.phase else {
                unreachable!()
            };
            expected =
                std::fs::read(locked.staged_path("restart", &plan.markdown).unwrap()).unwrap();
        }
        let locked = store.lock(&binding).unwrap();
        let mut disk = locked.load("restart").unwrap().unwrap();
        assert!(locked.can_resume(&disk, &vault));
        let response = locked.publish_plan(&mut disk, &vault).unwrap();
        assert_eq!(
            std::fs::read(vault.root().join("Cards/Card.md")).unwrap(),
            expected
        );
        // Lost response after receipt: replay cannot re-publish deleted/edited source.
        std::fs::remove_file(vault.root().join("Cards/Card.md")).unwrap();
        assert_eq!(locked.publish_plan(&mut disk, &vault).unwrap(), response);
        assert!(!vault.root().join("Cards/Card.md").exists());
    }

    #[test]
    fn sc2_layout_snapshot_is_anchored_on_resume_before_any_source_artifact() {
        let (_tmp, vault, store) = setup();
        let binding = binding_id(&vault).unwrap();
        {
            let locked = store.lock(&binding).unwrap();
            staged_plan(&locked, "layout-resume", 1);
            assert!(!vault.write_layout_path().exists());
            std::fs::create_dir(vault.root().join("Cards")).unwrap();
        }
        // This caller's fresh default is flat. Resume must use the journal's
        // standard snapshot, not re-infer a different target configuration.
        assert_eq!(
            vault.write_layout(),
            &crate::domain::vault::VaultWriteLayout::flat()
        );
        assert_eq!(
            files::load_vault_write_layout(&vault).unwrap(),
            crate::domain::vault::VaultWriteLayout::flat()
        );
        let locked = store.lock(&binding).unwrap();
        let mut record = locked.load("layout-resume").unwrap().unwrap();
        assert!(locked.can_resume(&record, &vault));
        assert!(locked
            .publish_plan_with(&mut record, &vault, |_, _| {
                assert_eq!(
                    files::load_vault_write_layout(&vault)?,
                    crate::domain::vault::VaultWriteLayout::standard()
                );
                let saved = locked.load("layout-resume")?.unwrap();
                assert!(matches!(
                    saved.phase,
                    OperationPhase::PlannedV2 {
                        step: SavePhase::MediaPublishing,
                        ..
                    }
                ));
                assert!(!vault.root().join("Media/Card-0.png").exists());
                assert!(!vault.root().join("Cards/Card.md").exists());
                anyhow::bail!("injected first-artifact fault after layout initialization")
            })
            .is_err());
        assert_eq!(
            files::load_vault_write_layout(&vault).unwrap(),
            crate::domain::vault::VaultWriteLayout::standard()
        );
        assert!(locked.staging_root("layout-resume").unwrap().exists());
        assert!(!locked.can_resume(&record, &vault));
    }

    #[test]
    fn sc2_plan_conflict_and_cleanup_never_replace_or_remove_foreign_material() {
        let (_tmp, vault, store) = setup();
        let locked = store.lock(&binding_id(&vault).unwrap()).unwrap();
        let mut record = staged_plan(&locked, "conflict", 2);
        files::write_new_atomically(&vault.root().join("Media/Card-1.png"), b"foreign").unwrap();
        let response = locked.publish_plan(&mut record, &vault).unwrap();
        assert_eq!(response["outcome"], "not_committed");
        assert_eq!(response["terminal_rejected"], true);
        assert_eq!(response["code"], "name_conflict");
        let mut reloaded = locked.load("conflict").unwrap().unwrap();
        assert_eq!(
            locked.recovered_response(&mut reloaded, &vault).unwrap(),
            Some(response)
        );
        assert!(locked.staging_root("conflict").unwrap().exists());
        assert!(locked.directory.join("conflict.request.json").exists());
        assert!(!vault.root().join("Media/Card-0.png").exists());
        assert_eq!(
            std::fs::read(vault.root().join("Media/Card-1.png")).unwrap(),
            b"foreign"
        );

        let mut record = staged_plan(&locked, "cleanup", 0);
        let staging = locked.staging_root("cleanup").unwrap();
        std::fs::write(staging.join("foreign.txt"), b"keep me").unwrap();
        locked
            .publish_plan_with(&mut record, &vault, |source, target| {
                files::copy_new_atomically(source, target)?;
                std::fs::write(source, b"changed staged bytes")?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            std::fs::read(staging.join("foreign.txt")).unwrap(),
            b"keep me"
        );
        assert_eq!(
            std::fs::read(staging.join("Cards/Card.md")).unwrap(),
            b"changed staged bytes"
        );
    }

    #[test]
    fn sc2_conflict_after_media_intent_cannot_release_operation_as_rejected() {
        let (_tmp, vault, store) = setup();
        let locked = store.lock(&binding_id(&vault).unwrap()).unwrap();
        let mut record = staged_plan(&locked, "partial-conflict", 1);
        let OperationPhase::PlannedV2 { step, plan } = &mut record.phase else {
            unreachable!()
        };
        *step = SavePhase::MediaPublishing;
        let source = locked
            .staged_path("partial-conflict", &plan.media[0])
            .unwrap();
        files::copy_new_atomically(
            &source,
            &vault.root().join(&plan.media[0].source.relative_path),
        )
        .unwrap();
        locked.store(&record).unwrap();
        files::write_new_atomically(&vault.root().join("Cards/Card.md"), b"foreign Markdown")
            .unwrap();
        assert!(locked.publish_plan(&mut record, &vault).is_err());
        assert!(locked
            .recovered_response(&mut record, &vault)
            .unwrap()
            .is_none());
        assert!(matches!(
            locked.load("partial-conflict").unwrap().unwrap().phase,
            OperationPhase::PlannedV2 {
                step: SavePhase::MediaPublishing,
                ..
            }
        ));
        assert!(locked.staging_root("partial-conflict").unwrap().exists());
    }

    #[test]
    fn sc2_legacy_preparing_and_orphan_material_are_never_reclassified_safe() {
        let (_tmp, vault, store) = setup();
        let locked = store.lock(&binding_id(&vault).unwrap()).unwrap();
        let mut record = locked.begin("legacy", "fp".into(), &json!({})).unwrap();
        record.phase = OperationPhase::Preparing;
        locked.store(&record).unwrap();
        assert!(!locked.can_resume(&record, &vault));
        assert!(locked
            .recovered_response(&mut record, &vault)
            .unwrap()
            .is_none());
        std::fs::create_dir(locked.staging_root("orphan").unwrap()).unwrap();
        assert!(locked.begin("orphan", "fp".into(), &json!({})).is_err());
        assert!(locked.load("orphan").unwrap().is_none());
    }

    #[test]
    fn sc2_uncertain_error_without_matching_markdown_cannot_create_receipt() {
        for publish_then_change in [false, true] {
            let (_tmp, vault, store) = setup();
            let locked = store.lock(&binding_id(&vault).unwrap()).unwrap();
            let mut record = staged_plan(&locked, "not-confirmed", 0);
            assert!(locked
                .publish_plan_with(&mut record, &vault, |source, target| {
                    if publish_then_change {
                        files::copy_new_atomically(source, target)?;
                        std::fs::write(target, b"user changed file")?;
                    }
                    Err(files::PublicationUncertain {
                        path: target.to_path_buf(),
                        source: anyhow::anyhow!("injected unconfirmed publication"),
                    }
                    .into())
                })
                .is_err());
            assert!(matches!(
                locked.load("not-confirmed").unwrap().unwrap().phase,
                OperationPhase::PlannedV2 {
                    step: SavePhase::MarkdownPublishing,
                    ..
                }
            ));
            assert!(locked.staging_root("not-confirmed").unwrap().exists());
        }
    }

    #[test]
    fn sc2_known_publication_without_writable_receipt_remains_unknown() {
        let (_tmp, vault, store) = setup();
        let locked = store.lock(&binding_id(&vault).unwrap()).unwrap();
        let mut record = staged_plan(&locked, "receipt-failure", 0);
        assert!(locked
            .publish_plan_with(&mut record, &vault, |source, target| {
                files::copy_new_atomically(source, target)?;
                // Make receipt replacement fail deterministically, not via chmod
                // (which differs for privileged test processes).
                std::fs::remove_file(locked.path("receipt-failure")?)?;
                std::fs::create_dir(locked.path("receipt-failure")?)?;
                Err(files::PublicationUncertain {
                    path: target.to_path_buf(),
                    source: anyhow::anyhow!("injected fsync failure"),
                }
                .into())
            })
            .is_err());
        assert!(locked.staging_root("receipt-failure").unwrap().exists());
        assert!(locked
            .directory
            .join("receipt-failure.request.json")
            .exists());
        assert!(vault.root().join("Cards/Card.md").is_file());
    }

    #[test]
    fn sc2_receipt_survives_index_loss_and_user_source_changes() {
        let (_tmp, vault, store) = setup();
        let binding = binding_id(&vault).unwrap();
        let locked = store.lock(&binding).unwrap();
        let mut record = locked
            .begin("receipt", "fingerprint".into(), &json!({"body":"payload"}))
            .unwrap();
        let markdown = vault.root().join("Card.md");
        let media = vault.root().join("Card.jpg");
        files::write_new_atomically(&markdown, b"source Markdown").unwrap();
        files::write_new_atomically(&media, b"source media").unwrap();
        let response = json!({"ok":true,"outcome":"committed","slug":"Card"});
        record.phase = OperationPhase::Publishing {
            markdown: SourceArtifact::inspect(&vault, &markdown).unwrap(),
            media: vec![SourceArtifact::inspect(&vault, &media).unwrap()],
            response: response.clone(),
        };
        locked.store(&record).unwrap();
        assert_eq!(
            locked.recovered_response(&mut record, &vault).unwrap(),
            Some(response.clone())
        );
        assert!(!locked.directory.join("receipt.request.json").exists());
        assert!(locked.directory.join("receipt.json").exists());
        std::fs::remove_dir_all(vault.derived_root()).unwrap();
        std::fs::write(&markdown, b"user edit after confirmed save").unwrap();
        std::fs::remove_file(&media).unwrap();
        let mut reloaded = locked.load("receipt").unwrap().unwrap();
        assert_eq!(
            locked.recovered_response(&mut reloaded, &vault).unwrap(),
            Some(response)
        );
        assert_eq!(
            std::fs::read(&markdown).unwrap(),
            b"user edit after confirmed save"
        );
    }

    #[test]
    fn sc2_unconfirmed_publication_keeps_payload_and_foreign_bytes() {
        let (_tmp, vault, store) = setup();
        let binding = binding_id(&vault).unwrap();
        let locked = store.lock(&binding).unwrap();
        let mut record = locked
            .begin("unknown", "fingerprint".into(), &json!({"body":"payload"}))
            .unwrap();
        let markdown = vault.root().join("Card.md");
        record.phase = OperationPhase::Publishing {
            markdown: SourceArtifact {
                relative_path: "Card.md".into(),
                sha256: sha256_bytes(b"expected"),
            },
            media: vec![],
            response: json!({"ok":true}),
        };
        locked.store(&record).unwrap();
        assert!(locked
            .recovered_response(&mut record, &vault)
            .unwrap()
            .is_none());
        std::fs::write(&markdown, b"foreign bytes").unwrap();
        assert!(locked
            .recovered_response(&mut record, &vault)
            .unwrap()
            .is_none());
        assert_eq!(std::fs::read(&markdown).unwrap(), b"foreign bytes");
        assert!(locked.directory.join("unknown.request.json").exists());
        assert!(matches!(
            locked.load("unknown").unwrap().unwrap().phase,
            OperationPhase::Publishing { .. }
        ));
        assert!(locked.load("absent").unwrap().is_none());
    }

    #[test]
    fn sc2_invalid_record_identity_and_traversal_are_rejected() {
        let (_tmp, vault, store) = setup();
        let binding = binding_id(&vault).unwrap();
        let locked = store.lock(&binding).unwrap();
        assert!(locked.begin("../escape", "fp".into(), &json!({})).is_err());
        let mut record = locked.begin("record", "fp".into(), &json!({})).unwrap();
        record.binding_id = "different".into();
        assert!(locked.store(&record).is_err());
        std::fs::write(locked.directory.join("broken.json"), b"truncated").unwrap();
        assert!(locked.load("broken").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn sc2_symlinked_record_is_not_followed_or_replaced() {
        let (tmp, vault, store) = setup();
        let binding = binding_id(&vault).unwrap();
        let locked = store.lock(&binding).unwrap();
        let sentinel = tmp.path().join("sentinel");
        std::fs::write(&sentinel, b"untouched").unwrap();
        std::os::unix::fs::symlink(&sentinel, locked.directory.join("record.json")).unwrap();
        assert!(locked.load("record").is_err());
        assert!(locked.begin("record", "fp".into(), &json!({})).is_err());
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"untouched");
    }

    #[test]
    fn sc2_lock_child_process() {
        let Ok(root) = std::env::var("MINE_SC2_TEST_LOCK_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("binding/.lock"))
            .unwrap();
        assert_eq!(
            file.try_lock_exclusive().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        std::fs::write(root.join("observed_blocked"), b"blocked").unwrap();
        let store = SaveOperationStore::new(root.clone());
        let _locked = store.lock("binding").unwrap();
        std::fs::write(root.join("acquired"), b"acquired").unwrap();
    }

    #[test]
    fn sc2_independent_processes_serialize_on_stable_lock_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("journal");
        let store = SaveOperationStore::new(root.clone());
        let locked = store.lock("binding").unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "storage::save_operations::tests::sc2_lock_child_process",
                "--nocapture",
            ])
            .env("MINE_SC2_TEST_LOCK_ROOT", &root)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.join("observed_blocked").exists() && std::time::Instant::now() < deadline {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("lock child exited early: {status}");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(root.join("observed_blocked").exists());
        assert!(!root.join("acquired").exists());
        drop(locked);
        assert!(child.wait().unwrap().success());
        assert!(root.join("acquired").exists());
    }
}
