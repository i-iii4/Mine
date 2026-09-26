//! Dormant production updater: real Tauri checks and signed download staging.
//! Activation remains unavailable until restart recovery is implemented and tested.
//! No network request or source-space access occurs without a configured channel.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const JOURNAL_VERSION: u32 = 1;
const NETWORK_TIMEOUT_SECONDS: u64 = 30;

/// Persisted download lifecycle, separate from installation and activation.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStage {
    Disabled,
    Idle,
    Checking,
    Available,
    Downloading,
    Verified,
    Installing,
    Restarting,
    Activated,
    RolledBack,
    RecoveryRequired,
    Failed,
}

/// Content-free updater status for local diagnostics and a future settings UI.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UpdateStatus {
    pub stage: UpdateStage,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub archive_sha256: Option<String>,
    pub error: Option<UpdateError>,
    pub activation_available: bool,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            stage: UpdateStage::Disabled,
            version: None,
            notes: None,
            downloaded_bytes: 0,
            total_bytes: None,
            archive_sha256: None,
            error: None,
            activation_available: false,
        }
    }
}
impl UpdateStatus {
    fn checked_offer(&mut self, version: Option<String>, notes: Option<String>) {
        self.stage = if version.is_some() {
            UpdateStage::Available
        } else {
            UpdateStage::Idle
        };
        self.version = version;
        self.notes = notes;
        self.downloaded_bytes = 0;
        self.total_bytes = None;
        self.archive_sha256 = None;
        self.error = None;
        self.activation_available = false;
    }
    fn start_download(&mut self) {
        self.stage = UpdateStage::Downloading;
        self.downloaded_bytes = 0;
        self.total_bytes = None;
        self.archive_sha256 = None;
        self.error = None;
        self.activation_available = false;
    }
    fn reopen_allowed(&self) -> bool {
        matches!(self.stage, UpdateStage::Idle | UpdateStage::Verified)
    }
}

/// Failures are distinct; a signed staged archive is never reported as installed.
#[derive(Debug, Clone, Serialize, Deserialize, Type, thiserror::Error)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum UpdateError {
    #[error("update channel is not configured")]
    Disabled,
    #[error("invalid update channel: {0}")]
    Configuration(String),
    #[error("another updater operation is running")]
    Busy,
    #[error("no checked update is available")]
    NoUpdate,
    #[error("update request failed: {0}")]
    Transport(String),
    #[error("update signature did not verify: {0}")]
    Signature(String),
    #[error("update state could not be stored: {0}")]
    Storage(String),
    #[error("unknown or corrupt updater journal has been preserved: {0}")]
    Journal(String),
    #[error("staged update differs from its verified bytes")]
    ArchiveChanged,
    #[error("safe activation refused: {0}")]
    Activation(String),
}

#[derive(Clone)]
struct Channel {
    public_key: String,
}

fn channel_config(value: Option<&serde_json::Value>) -> Result<Option<Channel>, UpdateError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let public_key = value
        .get("pubkey")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| UpdateError::Configuration("missing updater public key".into()))?;
    let public_document = decode_document(public_key).map_err(UpdateError::Configuration)?;
    minisign_verify::PublicKey::decode(&public_document)
        .map_err(|error| UpdateError::Configuration(error.to_string()))?;
    let endpoints = value
        .get("endpoints")
        .and_then(serde_json::Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| UpdateError::Configuration("missing HTTPS endpoints".into()))?;
    for endpoint in endpoints {
        let url = endpoint
            .as_str()
            .and_then(|text| url::Url::parse(text).ok())
            .ok_or_else(|| UpdateError::Configuration("invalid endpoint URL".into()))?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        {
            return Err(UpdateError::Configuration(
                "only public HTTPS endpoints are allowed".into(),
            ));
        }
    }
    if value
        .get("dangerousInsecureTransportProtocol")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
        || value
            .get("allowDowngrades")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    {
        return Err(UpdateError::Configuration(
            "insecure transport and implicit downgrade are forbidden".into(),
        ));
    }
    Ok(Some(Channel {
        public_key: public_key.to_string(),
    }))
}

fn decode_document(encoded: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| error.to_string())?;
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

/// Recheck the real Tauri signature when committing or reopening staged bytes.
fn verify_signature(public_key: &str, signature: &str, bytes: &[u8]) -> Result<(), UpdateError> {
    let key = minisign_verify::PublicKey::decode(
        &decode_document(public_key).map_err(UpdateError::Signature)?,
    )
    .map_err(|error| UpdateError::Signature(error.to_string()))?;
    let signature = minisign_verify::Signature::decode(
        &decode_document(signature).map_err(UpdateError::Signature)?,
    )
    .map_err(|error| UpdateError::Signature(error.to_string()))?;
    key.verify(bytes, &signature, false)
        .map_err(|error| UpdateError::Signature(error.to_string()))
}

/// The installed signer does not sign an announced version in its trusted comment.
/// Bind that metadata to the actual Info.plist contained in the signed archive.
fn verify_archive_version(bytes: &[u8], announced: &str) -> Result<(), UpdateError> {
    use std::io::Read;
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let mut versions = Vec::new();
    for entry in archive
        .entries()
        .map_err(|error| UpdateError::Signature(error.to_string()))?
    {
        let mut entry = entry.map_err(|error| UpdateError::Signature(error.to_string()))?;
        let path = entry
            .path()
            .map_err(|error| UpdateError::Signature(error.to_string()))?;
        if path.components().any(|part| {
            !matches!(
                part,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        }) {
            return Err(UpdateError::Signature("unsafe archive path".into()));
        }
        let parts: Vec<_> = path
            .components()
            .filter_map(|part| match part {
                std::path::Component::Normal(part) => Some(part),
                _ => None,
            })
            .collect();
        if parts.len() == 3
            && parts[0].to_string_lossy().ends_with(".app")
            && parts[1] == "Contents"
            && parts[2] == "Info.plist"
        {
            if !entry.header().entry_type().is_file() || entry.size() > 1024 * 1024 {
                return Err(UpdateError::Signature("invalid bundle metadata".into()));
            }
            let mut metadata = Vec::new();
            entry
                .read_to_end(&mut metadata)
                .map_err(|error| UpdateError::Signature(error.to_string()))?;
            let value = plist::Value::from_reader(std::io::Cursor::new(metadata))
                .map_err(|error| UpdateError::Signature(error.to_string()))?;
            let version = value
                .as_dictionary()
                .and_then(|value| value.get("CFBundleShortVersionString"))
                .and_then(plist::Value::as_string)
                .ok_or_else(|| UpdateError::Signature("bundle version is missing".into()))?;
            versions.push(version.to_string());
        }
    }
    if versions.len() != 1 || versions[0] != announced {
        return Err(UpdateError::Signature(
            "announced version differs from signed bundle version".into(),
        ));
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DownloadJournal {
    schema_version: u32,
    version: String,
    signature: String,
    archive_sha256: String,
    bytes: u64,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn archive_path(root: &Path, hash: &str) -> PathBuf {
    root.join(format!("{hash}.app.tar.gz"))
}

fn stage_download(
    root: &Path,
    key: &str,
    version: &str,
    signature: &str,
    bytes: &[u8],
) -> Result<DownloadJournal, UpdateError> {
    semver::Version::parse(version).map_err(|error| UpdateError::Journal(error.to_string()))?;
    verify_signature(key, signature, bytes)?;
    verify_archive_version(bytes, version)?;
    // Preserve an unknown journal before touching any previously staged result.
    read_journal(root)?;
    std::fs::create_dir_all(root).map_err(|error| UpdateError::Storage(error.to_string()))?;
    let journal = DownloadJournal {
        schema_version: JOURNAL_VERSION,
        version: version.into(),
        signature: signature.into(),
        archive_sha256: digest(bytes),
        bytes: bytes.len() as u64,
    };
    crate::storage::files::write_atomically(&archive_path(root, &journal.archive_sha256), bytes)
        .map_err(|error| UpdateError::Storage(error.to_string()))?;
    let journal_bytes = serde_json::to_vec_pretty(&journal)
        .map_err(|error| UpdateError::Storage(error.to_string()))?;
    crate::storage::files::write_atomically(&root.join("download-journal.json"), &journal_bytes)
        .map_err(|error| UpdateError::Storage(error.to_string()))?;
    Ok(journal)
}

fn read_journal(root: &Path) -> Result<Option<DownloadJournal>, UpdateError> {
    let bytes = match std::fs::read(root.join("download-journal.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(UpdateError::Journal(error.to_string())),
    };
    let journal: DownloadJournal =
        serde_json::from_slice(&bytes).map_err(|error| UpdateError::Journal(error.to_string()))?;
    if journal.schema_version != JOURNAL_VERSION
        || journal.archive_sha256.len() != 64
        || !journal
            .archive_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || semver::Version::parse(&journal.version).is_err()
    {
        return Err(UpdateError::Journal(
            "unsupported format or invalid artifact identity".into(),
        ));
    }
    Ok(Some(journal))
}

fn verified_journal(root: &Path, key: &str) -> Result<Option<DownloadJournal>, UpdateError> {
    let Some(journal) = read_journal(root)? else {
        return Ok(None);
    };
    let bytes = std::fs::read(archive_path(root, &journal.archive_sha256))
        .map_err(|error| UpdateError::Journal(error.to_string()))?;
    if digest(&bytes) != journal.archive_sha256 || bytes.len() as u64 != journal.bytes {
        return Err(UpdateError::ArchiveChanged);
    }
    verify_signature(key, &journal.signature, &bytes)?;
    verify_archive_version(&bytes, &journal.version)?;
    Ok(Some(journal))
}

/// Managed only by the backend, never by arbitrary frontend update URLs or keys.
#[derive(Default)]
pub struct UpdateService {
    channel: Mutex<Option<Channel>>,
    status: Mutex<UpdateStatus>,
    offer: Mutex<Option<Update>>,
    busy: AtomicBool,
    last_progress_event: Mutex<Option<std::time::Instant>>,
}

struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl UpdateService {
    fn emit(&self, app: &AppHandle) {
        if let Ok(status) = self.status() {
            let _ = app.emit("update-status", status);
        }
    }
    fn begin(&self) -> Result<Operation<'_>, UpdateError> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| UpdateError::Busy)?;
        Ok(Operation(&self.busy))
    }
    fn channel(&self) -> Result<Channel, UpdateError> {
        self.channel
            .lock()
            .map_err(|_| UpdateError::Busy)?
            .clone()
            .ok_or(UpdateError::Disabled)
    }
    fn status(&self) -> Result<UpdateStatus, UpdateError> {
        self.status
            .lock()
            .map(|value| value.clone())
            .map_err(|_| UpdateError::Busy)
    }
    fn set_stage(&self, stage: UpdateStage) -> Result<(), UpdateError> {
        self.status.lock().map_err(|_| UpdateError::Busy)?.stage = stage;
        Ok(())
    }
    fn fail(&self, error: &UpdateError) {
        if let Ok(mut status) = self.status.lock() {
            status.stage = UpdateStage::Failed;
            status.error = Some(error.clone());
        }
    }
}

/// Configure without checking the network; absent/invalid release credentials never block startup.
pub fn initialize(app: &AppHandle) {
    let service = app.state::<UpdateService>();
    match channel_config(app.config().plugins.0.get("updater")) {
        Ok(Some(channel)) => match app.plugin(tauri_plugin_updater::Builder::new().build()) {
            Ok(()) => {
                let resume_key = channel.public_key.clone();
                let resume_app = app.clone();
                if let Ok(mut state) = service.channel.lock() {
                    *state = Some(channel);
                }
                let _ = service.set_stage(UpdateStage::Idle);
                tauri::async_runtime::spawn_blocking(move || {
                    let result = (|| -> Result<(), UpdateError> {
                        let root = update_root(&resume_app)?;
                        if let Some(journal) = verified_journal(&root, &resume_key)? {
                            let bytes = std::fs::read(archive_path(&root, &journal.archive_sha256))
                                .map_err(|error| UpdateError::Storage(error.to_string()))?;
                            crate::update_activation::resume_startup(
                                &root,
                                &journal.archive_sha256,
                                &bytes,
                            )
                            .map_err(UpdateError::Activation)?;
                        }
                        Ok(())
                    })();
                    if let Err(error) = result {
                        resume_app.state::<UpdateService>().fail(&error);
                    }
                });
            }
            Err(error) => service.fail(&UpdateError::Configuration(error.to_string())),
        },
        Ok(None) => {}
        Err(error) => service.fail(&error),
    }
}

fn update_root(app: &AppHandle) -> Result<PathBuf, UpdateError> {
    app.path()
        .app_data_dir()
        .map(|root| root.join("updates/v1"))
        .map_err(|error| UpdateError::Storage(error.to_string()))
}

/// Read back a signed staged result after process restart before reporting it verified.
pub async fn status(app: &AppHandle) -> Result<UpdateStatus, UpdateError> {
    let service = app.state::<UpdateService>();
    let channel = match service.channel() {
        Ok(channel) => channel,
        Err(UpdateError::Disabled) => return service.status(),
        Err(error) => return Err(error),
    };
    // Polling must expose progress, not acquire ownership from a live download.
    let snapshot = service.status()?;
    if service.busy.load(Ordering::Acquire) || !snapshot.reopen_allowed() {
        return Ok(snapshot);
    }
    let _operation = match service.begin() {
        Ok(operation) => operation,
        Err(UpdateError::Busy) => return service.status(),
        Err(error) => return Err(error),
    };
    let root = update_root(app)?;
    let (journal, activation) = tauri::async_runtime::spawn_blocking(move || {
        let journal = verified_journal(&root, &channel.public_key)?;
        let activation = crate::update_activation::latest_phase(
            &root,
            journal
                .as_ref()
                .map(|journal| journal.archive_sha256.as_str()),
        )
        .map_err(UpdateError::Journal)?;
        Ok::<_, UpdateError>((journal, activation))
    })
    .await
    .map_err(|error| UpdateError::Storage(error.to_string()))??;
    if let Some(journal) = journal {
        let mut status = service.status.lock().map_err(|_| UpdateError::Busy)?;
        status.stage = UpdateStage::Verified;
        status.version = Some(journal.version);
        status.downloaded_bytes = journal.bytes;
        status.archive_sha256 = Some(journal.archive_sha256);
        status.error = None;
        status.activation_available = cfg!(target_os = "macos");
    }
    if let Some((phase, error)) = activation {
        use crate::update_activation::ActivationPhase;
        let mut status = service.status.lock().map_err(|_| UpdateError::Busy)?;
        status.stage = match phase {
            ActivationPhase::Verified => UpdateStage::Activated,
            ActivationPhase::RolledBack => UpdateStage::RolledBack,
            ActivationPhase::RecoveryRequired => UpdateStage::RecoveryRequired,
            ActivationPhase::Installed | ActivationPhase::Launched => UpdateStage::Restarting,
            ActivationPhase::LaunchIntent => UpdateStage::RecoveryRequired,
            ActivationPhase::Prepared => status.stage.clone(),
        };
        if !matches!(phase, ActivationPhase::Prepared) {
            status.activation_available = false;
        }
        status.error = error.map(UpdateError::Activation);
    }
    service.status()
}

/// Perform an actual Tauri updater check; this is independent of local space access.
pub async fn check(app: &AppHandle) -> Result<UpdateStatus, UpdateError> {
    let service = app.state::<UpdateService>();
    service.channel()?;
    let _operation = service.begin()?;
    service.set_stage(UpdateStage::Checking)?;
    service.emit(app);
    let result = async {
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(NETWORK_TIMEOUT_SECONDS))
            .build()
            .map_err(|error| UpdateError::Configuration(error.to_string()))?;
        let offer = updater
            .check()
            .await
            .map_err(|error| UpdateError::Transport(error.to_string()))?;
        if let Some(update) = &offer {
            if update.download_url.scheme() != "https" {
                return Err(UpdateError::Configuration(
                    "download URL must use HTTPS".into(),
                ));
            }
        }
        let mut status = service.status.lock().map_err(|_| UpdateError::Busy)?;
        status.checked_offer(
            offer.as_ref().map(|update| update.version.clone()),
            offer.as_ref().and_then(|update| update.body.clone()),
        );
        *service.offer.lock().map_err(|_| UpdateError::Busy)? = offer;
        Ok(status.clone())
    }
    .await;
    if let Err(error) = &result {
        service.fail(error);
    }
    service.emit(app);
    result
}

/// Download through Tauri, reverify the signature, then durably publish staged bytes.
pub async fn download(app: &AppHandle) -> Result<UpdateStatus, UpdateError> {
    let service = app.state::<UpdateService>();
    let channel = service.channel()?;
    let _operation = service.begin()?;
    let update = service
        .offer
        .lock()
        .map_err(|_| UpdateError::Busy)?
        .clone()
        .ok_or(UpdateError::NoUpdate)?;
    {
        let mut status = service.status.lock().map_err(|_| UpdateError::Busy)?;
        status.start_download();
    }
    service.emit(app);
    let result = async {
        let bytes = update
            .download(
                |chunk, total| {
                    if let Ok(mut status) = service.status.lock() {
                        status.downloaded_bytes += chunk as u64;
                        status.total_bytes = total;
                    }
                    let mut last = service
                        .last_progress_event
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if last.is_none_or(|instant| instant.elapsed() >= Duration::from_millis(100)) {
                        *last = Some(std::time::Instant::now());
                        service.emit(app);
                    }
                },
                || {},
            )
            .await
            .map_err(|error| match error {
                tauri_plugin_updater::Error::Minisign(_)
                | tauri_plugin_updater::Error::Base64(_)
                | tauri_plugin_updater::Error::SignatureUtf8(_)
                | tauri_plugin_updater::Error::SignedVersionMismatch { .. }
                | tauri_plugin_updater::Error::MissingSignedVersion => {
                    UpdateError::Signature(error.to_string())
                }
                _ => UpdateError::Transport(error.to_string()),
            })?;
        let root = update_root(app)?;
        let journal = tauri::async_runtime::spawn_blocking(move || {
            stage_download(
                &root,
                &channel.public_key,
                &update.version,
                &update.signature,
                &bytes,
            )
        })
        .await
        .map_err(|error| UpdateError::Storage(error.to_string()))??;
        let mut status = service.status.lock().map_err(|_| UpdateError::Busy)?;
        status.stage = UpdateStage::Verified;
        status.error = None;
        status.downloaded_bytes = journal.bytes;
        status.version = Some(journal.version);
        status.archive_sha256 = Some(journal.archive_sha256);
        status.activation_available = cfg!(target_os = "macos");
        Ok(status.clone())
    }
    .await;
    if let Err(error) = &result {
        service.fail(error);
    }
    service.emit(app);
    result
}

/// Explicit user action only. Heavy verification and Tauri installation run off the UI thread.
pub async fn install(app: &AppHandle) -> Result<UpdateStatus, UpdateError> {
    let service = app.state::<UpdateService>();
    let channel = service.channel()?;
    let _operation = service.begin()?;
    let root = update_root(app)?;
    let journal_root = root.clone();
    let journal = tauri::async_runtime::spawn_blocking(move || {
        verified_journal(&journal_root, &channel.public_key)
    })
    .await
    .map_err(|error| UpdateError::Storage(error.to_string()))??
    .ok_or(UpdateError::NoUpdate)?;
    let cached = { service.offer.lock().map_err(|_| UpdateError::Busy)?.clone() };
    let update = if let Some(update) = cached {
        update
    } else {
        app.updater_builder()
            .timeout(Duration::from_secs(NETWORK_TIMEOUT_SECONDS))
            .build()
            .map_err(|error| UpdateError::Configuration(error.to_string()))?
            .check()
            .await
            .map_err(|error| UpdateError::Transport(error.to_string()))?
            .ok_or(UpdateError::NoUpdate)?
    };
    if update.version != journal.version || update.signature != journal.signature {
        return Err(UpdateError::ArchiveChanged);
    }
    service.set_stage(UpdateStage::Installing)?;
    service.emit(app);
    let app_for_worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let shutdown = crate::storage::source_mutation::begin_shutdown()
            .map_err(|error| UpdateError::Activation(error.to_string()))?;
        let executable =
            std::env::current_exe().map_err(|error| UpdateError::Activation(error.to_string()))?;
        let target = executable
            .ancestors()
            .find(|path| path.extension().is_some_and(|extension| extension == "app"))
            .ok_or_else(|| {
                UpdateError::Activation("current process is not an installed app bundle".into())
            })?;
        let bytes = std::fs::read(archive_path(&root, &journal.archive_sha256))
            .map_err(|error| UpdateError::Storage(error.to_string()))?;
        if digest(&bytes) != journal.archive_sha256 {
            return Err(UpdateError::ArchiveChanged);
        }
        let activation = crate::update_activation::prepare(
            &root,
            &bytes,
            &journal.archive_sha256,
            target,
            &journal.version,
        )
        .map_err(UpdateError::Activation)?;
        crate::update_activation::publish_pointer(&root, &activation)
            .map_err(UpdateError::Activation)?;
        if let Err(error) = crate::update_activation::launch_watchdog(&activation, false) {
            let _ = crate::update_activation::cancel(&activation, &error);
            return Err(UpdateError::Activation(error));
        }
        if let Err(error) = crate::update_activation::activate(&activation) {
            let _ = crate::update_activation::cancel(&activation, &error);
            return Err(UpdateError::Activation(error));
        }
        app_for_worker
            .state::<UpdateService>()
            .set_stage(UpdateStage::Restarting)?;
        // Keep new writers blocked until the process actually exits, not merely until this IPC returns.
        std::mem::forget(shutdown);
        app_for_worker.exit(0);
        Ok(())
    })
    .await
    .map_err(|error| UpdateError::Activation(error.to_string()))?;
    if let Err(error) = &result {
        service.fail(error);
    }
    service.emit(app);
    result?;
    service.status()
}

/// Side effect free identity probe or installed watchdog mode, before GUI startup.
pub fn handle_helper_mode() -> bool {
    let mut args = std::env::args_os().skip(1);
    match args.next().as_deref() {
        Some(mode) if mode == "--mine-build-info" => {
            println!(
                "{}",
                serde_json::to_string(&crate::update_activation::build_identity())
                    .expect("serializable build identity")
            );
            true
        }
        Some(mode) if mode == "--mine-update-watchdog" || mode == "--mine-update-restore" => {
            let restoring = mode == "--mine-update-restore";
            let result =
                (|| -> Result<(), UpdateError> {
                    let path = PathBuf::from(args.next().ok_or_else(|| {
                        UpdateError::Activation("missing watchdog journal".into())
                    })?);
                    if args.next().is_some() {
                        return Err(UpdateError::Activation(
                            "unexpected helper arguments".into(),
                        ));
                    }
                    let context = crate::application_context();
                    let channel = channel_config(context.config().plugins.0.get("updater"))?
                        .ok_or(UpdateError::Disabled)?;
                    let root = path.parent().and_then(Path::parent).ok_or_else(|| {
                        UpdateError::Journal("invalid updater journal path".into())
                    })?;
                    // Do not trust a public key supplied by mutable activation metadata.
                    let download = verified_journal(root, &channel.public_key)?
                        .ok_or(UpdateError::NoUpdate)?;
                    let bytes = std::fs::read(archive_path(root, &download.archive_sha256))
                        .map_err(|error| UpdateError::Storage(error.to_string()))?;
                    crate::update_activation::verify_archive_binding(
                        &path,
                        &download.archive_sha256,
                        &bytes,
                        restoring,
                    )
                    .map_err(UpdateError::Activation)?;
                    if restoring {
                        crate::update_activation::restore_watchdog(&path)
                    } else {
                        crate::update_activation::watchdog(&path)
                    }
                    .map_err(UpdateError::Activation)
                })();
            if let Err(error) = result {
                eprintln!("{error}");
            }
            true
        }
        _ => false,
    }
}

pub async fn restore(app: &AppHandle) -> Result<UpdateStatus, UpdateError> {
    let service = app.state::<UpdateService>();
    let channel = service.channel()?;
    let _operation = service.begin()?;
    let root = update_root(app)?;
    let app_for_worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let journal = verified_journal(&root, &channel.public_key)?.ok_or(UpdateError::NoUpdate)?;
        let path = crate::update_activation::latest_path(&root).map_err(UpdateError::Activation)?;
        let shutdown = crate::storage::source_mutation::begin_shutdown()
            .map_err(|error| UpdateError::Activation(error.to_string()))?;
        crate::update_activation::request_restore(&path, std::process::id())
            .map_err(UpdateError::Activation)?;
        let bytes = std::fs::read(archive_path(&root, &journal.archive_sha256))
            .map_err(|error| UpdateError::Storage(error.to_string()))?;
        if bytes.len() as u64 != journal.bytes {
            return Err(UpdateError::ArchiveChanged);
        }
        crate::update_activation::launch_watchdog(&path, true).map_err(UpdateError::Activation)?;
        app_for_worker
            .state::<UpdateService>()
            .set_stage(UpdateStage::Restarting)?;
        std::mem::forget(shutdown);
        app_for_worker.exit(0);
        Ok::<_, UpdateError>(())
    })
    .await
    .map_err(|error| UpdateError::Activation(error.to_string()))?;
    if let Err(error) = &result {
        service.fail(error);
    }
    service.emit(app);
    result?;
    service.status()
}

#[cfg(test)]
mod tests {
    use super::*;
    const PUBLIC_KEY: &str = "untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";
    fn encoded(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    /// Exercise the installed Tauri signer, with an ephemeral key never published.
    fn signed_archive(root: &Path) -> (String, String, Vec<u8>) {
        let path = root.join("fixture.app.tar.gz");
        let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tar = tar::Builder::new(gzip);
        let metadata = b"<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleShortVersionString</key><string>1.0.0</string></dict></plist>";
        let mut header = tar::Header::new_gnu();
        header.set_size(metadata.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, "Mine.app/Contents/Info.plist", &metadata[..])
            .unwrap();
        let bytes = tar.into_inner().unwrap().finish().unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let signer = Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules/.bin/tauri");
        let secret = root.join("ephemeral.key");
        let generated = std::process::Command::new(&signer)
            .args([
                "signer",
                "generate",
                "--ci",
                "--password",
                "",
                "--write-keys",
            ])
            .arg(&secret)
            .output()
            .expect("installed Tauri signer is required for archive acceptance tests");
        assert!(
            generated.status.success(),
            "ephemeral signer key generation failed"
        );
        let signed = std::process::Command::new(signer)
            .args(["signer", "sign", "--password", "", "--private-key-path"])
            .arg(&secret)
            .arg(&path)
            .output()
            .unwrap();
        assert!(signed.status.success(), "fixture signing failed");
        let public = std::fs::read_to_string(root.join("ephemeral.key.pub")).unwrap();
        let signature = std::fs::read_to_string(root.join("fixture.app.tar.gz.sig")).unwrap();
        (public, signature, bytes)
    }

    #[test]
    fn absent_configuration_is_disabled_and_invalid_credentials_are_rejected() {
        assert!(channel_config(None).unwrap().is_none());
        for value in [
            serde_json::json!({}),
            serde_json::json!({"pubkey":"placeholder", "endpoints":["https://updates.invalid"]}),
            serde_json::json!({"pubkey":encoded(PUBLIC_KEY), "endpoints":["http://updates.invalid"]}),
            serde_json::json!({"pubkey":encoded(PUBLIC_KEY), "endpoints":["https://updates.invalid"], "allowDowngrades":true}),
        ] {
            assert!(channel_config(Some(&value)).is_err());
        }
        assert!(channel_config(Some(&serde_json::json!({"pubkey":encoded(PUBLIC_KEY),"endpoints":["https://updates.invalid"]}))).unwrap().is_some());
    }

    #[test]
    fn actual_signature_verification_rejects_changed_and_partial_downloads() {
        verify_signature(&encoded(PUBLIC_KEY), &encoded(SIGNATURE), b"test").unwrap();
        for bytes in [b"changed".as_slice(), b"tes".as_slice()] {
            assert!(matches!(
                verify_signature(&encoded(PUBLIC_KEY), &encoded(SIGNATURE), bytes),
                Err(UpdateError::Signature(_))
            ));
        }
    }

    #[test]
    fn signed_staging_survives_reopen_and_detects_modified_archive() {
        let temporary = tempfile::tempdir().unwrap();
        let (key, signature, bytes) = signed_archive(temporary.path());
        let journal = stage_download(temporary.path(), &key, "1.0.0", &signature, &bytes).unwrap();
        assert_eq!(
            verified_journal(temporary.path(), &key)
                .unwrap()
                .unwrap()
                .archive_sha256,
            journal.archive_sha256
        );
        std::fs::write(
            archive_path(temporary.path(), &journal.archive_sha256),
            b"different",
        )
        .unwrap();
        assert!(matches!(
            verified_journal(temporary.path(), &key),
            Err(UpdateError::ArchiveChanged)
        ));
    }

    #[test]
    fn signed_bundle_version_rejects_changed_announcements_and_journals() {
        let temporary = tempfile::tempdir().unwrap();
        let (key, signature, bytes) = signed_archive(temporary.path());
        assert!(stage_download(temporary.path(), &key, "9.0.0", &signature, &bytes).is_err());
        assert!(!temporary.path().join("download-journal.json").exists());
        let mut journal =
            stage_download(temporary.path(), &key, "1.0.0", &signature, &bytes).unwrap();
        journal.version = "9.0.0".into();
        std::fs::write(
            temporary.path().join("download-journal.json"),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            verified_journal(temporary.path(), &key),
            Err(UpdateError::Signature(_))
        ));
    }

    #[test]
    fn invalid_signature_and_unknown_journal_never_publish_success() {
        let temporary = tempfile::tempdir().unwrap();
        assert!(stage_download(
            temporary.path(),
            &encoded(PUBLIC_KEY),
            "1.0.0",
            &encoded(SIGNATURE),
            b"partial"
        )
        .is_err());
        assert!(!temporary.path().join("download-journal.json").exists());
        let unknown = b"{\"schema_version\":99}";
        std::fs::write(temporary.path().join("download-journal.json"), unknown).unwrap();
        assert!(stage_download(
            temporary.path(),
            &encoded(PUBLIC_KEY),
            "1.0.0",
            &encoded(SIGNATURE),
            b"test"
        )
        .is_err());
        assert_eq!(
            std::fs::read(temporary.path().join("download-journal.json")).unwrap(),
            unknown
        );
        assert!(!UpdateStatus::default().activation_available);
    }

    #[test]
    fn concurrent_updater_operations_are_serialized_and_release_their_owner() {
        let service = UpdateService::default();
        let operation = service.begin().unwrap();
        assert!(matches!(service.begin(), Err(UpdateError::Busy)));
        drop(operation);
        assert!(service.begin().is_ok());
    }
    #[test]
    fn retries_and_new_offers_never_mix_old_artifact_progress_or_override_active_status() {
        let mut status = UpdateStatus {
            stage: UpdateStage::Verified,
            version: Some("1.0.0".into()),
            downloaded_bytes: 900,
            total_bytes: Some(1000),
            archive_sha256: Some("old".into()),
            activation_available: true,
            error: Some(UpdateError::ArchiveChanged),
            ..UpdateStatus::default()
        };
        status.checked_offer(Some("2.0.0".into()), Some("new release".into()));
        assert_eq!(status.stage, UpdateStage::Available);
        assert_eq!(status.downloaded_bytes, 0);
        assert!(status.total_bytes.is_none());
        assert!(status.archive_sha256.is_none());
        assert!(status.error.is_none());
        assert!(!status.activation_available);
        assert!(!status.reopen_allowed());
        status.downloaded_bytes = 40;
        status.total_bytes = Some(100);
        status.start_download();
        assert_eq!(status.downloaded_bytes, 0);
        assert!(status.total_bytes.is_none());
        assert!(!status.reopen_allowed());
    }
}
