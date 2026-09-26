// Installing the browser clipper without a terminal.
//
// The clipper needs two installed runtime parts: an extension in a stable
// Application Support directory and a native messaging host the browser may
// launch. Both ship in the app bundle and are refreshed without touching a
// user's vault.
//
// See SPEC_ONBOARDING.md О5–О7.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::commands::state::CommandError;
use crate::storage::clipper_connection::{self, ClipperConnectionCheck, DEV_EXTENSION_ID};

/// Native messaging host name, matched by the extension's manifest.
const HOST_NAME: &str = "com.mine.clipper.v1";
use crate::runtime_installation::{
    install_binary, install_lock as runtime_install_lock, probe_runtime_host,
    MANAGED_RUNTIME_DIRECTORY,
};
use crate::runtime_installation::{
    InstallDecision as RuntimeInstallDecision, PolicyError as RuntimePolicyError,
};
const RUNTIME_MANIFEST_SCHEMA_VERSION: u32 = 1;
const INTEGRITY_CHECK_INTERVAL_SECONDS: u64 = 7 * 24 * 60 * 60;
const RUNTIME_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeComponentManifest {
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeBuildManifest {
    schema_version: u32,
    build_profile: String,
    app_version: String,
    #[serde(default)]
    native_host_build_id: Option<String>,
    native_host: RuntimeComponentManifest,
    extension: RuntimeComponentManifest,
    ytdlp: Option<RuntimeComponentManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeInstallMarker {
    manifest: RuntimeBuildManifest,
    verified_at_unix_seconds: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeInstallStage {
    Prepared,
    HostActivated,
    ExtensionActivated,
    LegacyExtensionRetained,
    LegacyExtensionActivated,
    Registered,
    FilesVerified,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeInstallJournal {
    schema_version: u32,
    package_id: String,
    candidate: RuntimeBuildManifest,
    previous: Option<RuntimeInstallMarker>,
    /// Only a recognized, explicitly adopted stable legacy payload is replaced.
    #[serde(default)]
    legacy_extension_previous: Option<RuntimeComponentManifest>,
    stage: RuntimeInstallStage,
}

fn legacy_extension_path(parent: &Path) -> std::io::Result<PathBuf> {
    if parent.file_name() != Some(std::ffi::OsStr::new(MANAGED_RUNTIME_DIRECTORY)) {
        return Err(std::io::Error::other(
            "legacy activation requires the managed runtime owner",
        ));
    }
    let clipper = parent
        .parent()
        .ok_or_else(|| std::io::Error::other("runtime owner has no parent"))?;
    for path in [parent, clipper] {
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(std::io::Error::other(
                "legacy activation refuses a redirected runtime owner",
            ));
        }
    }
    Ok(clipper.join("extension"))
}

fn recognized_extension(root: &Path, host_name: &str) -> bool {
    use base64::Engine;
    let Some(manifest) = std::fs::read(root.join("manifest.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return false;
    };
    if manifest["manifest_version"] != 3
        || manifest["name"] != "Mine"
        || manifest["background"]["service_worker"] != "background.js"
    {
        return false;
    }
    let Some(key) = manifest["key"]
        .as_str()
        .and_then(|key| base64::engine::general_purpose::STANDARD.decode(key).ok())
    else {
        return false;
    };
    let digest = Sha256::digest(key);
    let id: String = digest[..16]
        .iter()
        .flat_map(|byte| {
            [
                char::from(b'a' + (byte >> 4)),
                char::from(b'a' + (byte & 15)),
            ]
        })
        .collect();
    id == DEV_EXTENSION_ID
        && std::fs::read_to_string(root.join("background.js")).is_ok_and(|worker| {
            worker
                .lines()
                .any(|line| line.trim() == format!("const HOST_NAME = \"{host_name}\";"))
        })
}

fn plan_legacy_extension(
    parent: &Path,
    candidate: &RuntimeBuildManifest,
) -> std::io::Result<Option<RuntimeComponentManifest>> {
    // Other callers/tests may use isolated owners, but cannot adopt arbitrary paths.
    if parent.file_name() != Some(std::ffi::OsStr::new(MANAGED_RUNTIME_DIRECTORY)) {
        return Ok(None);
    }
    let destination = legacy_extension_path(parent)?;
    match std::fs::symlink_metadata(&destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.is_dir() => {
            return Err(std::io::Error::other(
                "foreign legacy extension path preserved",
            ))
        }
        Ok(_) => {}
    }
    let actual = extension_manifest(&destination)
        .ok_or_else(|| std::io::Error::other("unverifiable legacy extension preserved"))?;
    let previously_adopted = read_runtime_journal(parent)?.is_some_and(|journal| {
        journal.legacy_extension_previous.is_some() && journal.candidate.extension == actual
    });
    if !recognized_extension(&destination, "com.localarena.clipper")
        && !(previously_adopted && recognized_extension(&destination, HOST_NAME))
    {
        return Err(std::io::Error::other(
            "unrecognized legacy extension payload preserved",
        ));
    }
    let bytes = serde_json::to_vec(candidate).map_err(std::io::Error::other)?;
    let source = parent
        .join("packages")
        .join(format!("{:x}", Sha256::digest(bytes)))
        .join("extension");
    if !recognized_extension(&source, HOST_NAME) {
        return Err(std::io::Error::other(
            "candidate extension cannot preserve the fixed browser identity",
        ));
    }
    Ok(Some(actual))
}

fn activate_legacy_extension(
    parent: &Path,
    journal: &mut RuntimeInstallJournal,
    checkpoint: &mut impl FnMut(RuntimeInstallStage) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let Some(previous) = journal.legacy_extension_previous.clone() else {
        return Ok(());
    };
    let destination = legacy_extension_path(parent)?;
    let source = parent
        .join("packages")
        .join(&journal.package_id)
        .join("extension");
    if !recognized_extension(&source, HOST_NAME) {
        return Err(std::io::Error::other(
            "legacy activation candidate identity mismatch",
        ));
    }
    let actual = extension_manifest(&destination)
        .ok_or_else(|| std::io::Error::other("legacy activation target disappeared or changed"))?;
    let retained = destination
        .parent()
        .unwrap()
        .join("retained")
        .join(format!("extension-{}", previous.sha256));
    if actual == previous {
        retain_extension(&destination)?;
    } else if actual != journal.candidate.extension {
        return Err(std::io::Error::other(
            "legacy activation target changed; foreign contents preserved",
        ));
    }
    if extension_manifest(&retained).as_ref() != Some(&previous) {
        return Err(std::io::Error::other(
            "legacy activation backup is missing or damaged; target preserved",
        ));
    }
    checkpoint(RuntimeInstallStage::LegacyExtensionRetained)?;
    if actual != journal.candidate.extension {
        install_extension_directory_checked(&source, &destination, Some(&previous))?;
    }
    if extension_manifest(&destination).as_ref() != Some(&journal.candidate.extension) {
        return Err(std::io::Error::other(
            "legacy stable payload readback failed",
        ));
    }
    // Injection here covers a crash after the exchange but before journal advance.
    checkpoint(RuntimeInstallStage::LegacyExtensionActivated)?;
    journal.stage = RuntimeInstallStage::LegacyExtensionActivated;
    write_runtime_json(&parent.join("install-journal.json"), journal)
}

fn restore_legacy_extension(parent: &Path, journal: &RuntimeInstallJournal) -> std::io::Result<()> {
    let Some(previous) = &journal.legacy_extension_previous else {
        return Ok(());
    };
    let destination = legacy_extension_path(parent)?;
    let actual = extension_manifest(&destination)
        .ok_or_else(|| std::io::Error::other("legacy rollback target changed"))?;
    if actual == *previous {
        return Ok(());
    }
    if actual != journal.candidate.extension {
        return Err(std::io::Error::other(
            "legacy rollback refuses changed contents",
        ));
    }
    let retained = destination
        .parent()
        .unwrap()
        .join("retained")
        .join(format!("extension-{}", previous.sha256));
    if extension_manifest(&retained).as_ref() != Some(previous) {
        return Err(std::io::Error::other(
            "legacy rollback backup failed verification",
        ));
    }
    install_extension_directory_checked(&retained, &destination, Some(&journal.candidate.extension))
}

fn write_runtime_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    crate::storage::files::write_atomically(path, &bytes).map_err(std::io::Error::other)
}

fn read_runtime_journal(parent: &Path) -> std::io::Result<Option<RuntimeInstallJournal>> {
    let bytes = match std::fs::read(parent.join("install-journal.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let journal: RuntimeInstallJournal = serde_json::from_slice(&bytes).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("unknown or damaged install journal preserved: {error}"),
        )
    })?;
    if journal.schema_version != RUNTIME_MANIFEST_SCHEMA_VERSION
        || journal.candidate.schema_version != RUNTIME_MANIFEST_SCHEMA_VERSION
        || journal.package_id.len() != 64
        || !journal
            .package_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unknown install journal format preserved",
        ));
    }
    let expected_id = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&journal.candidate).map_err(std::io::Error::other)?)
    );
    if journal.package_id != expected_id {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "install journal package identity differs from its manifest and was preserved",
        ));
    }
    Ok(Some(journal))
}

fn runtime_package_matches(parent: &Path, manifest: &RuntimeBuildManifest) -> bool {
    file_manifest(&parent.join("native-host")).as_ref() == Some(&manifest.native_host)
        && executable_with_size(&parent.join("native-host"), manifest.native_host.bytes)
        && extension_manifest(&parent.join("extension")).as_ref() == Some(&manifest.extension)
        && manifest.ytdlp.as_ref().is_none_or(|expected| {
            file_manifest(&parent.join("yt-dlp")).as_ref() == Some(expected)
                && executable_with_size(&parent.join("yt-dlp"), expected.bytes)
        })
}

fn flush_extension_tree(root: &Path) -> std::io::Result<()> {
    let mut directories = std::collections::BTreeSet::new();
    for relative in extension_files(root)? {
        let path = root.join(relative);
        std::fs::File::open(&path)?.sync_all()?;
        let mut parent = path.parent();
        while let Some(directory) = parent {
            if !directory.starts_with(root) {
                break;
            }
            directories.insert(directory.to_path_buf());
            parent = directory.parent();
        }
    }
    for directory in directories.into_iter().rev() {
        std::fs::File::open(directory)?.sync_all()?;
    }
    Ok(())
}

fn prepare_runtime_package(
    parent: &Path,
    manifest: &RuntimeBuildManifest,
    host_source: &Path,
    extension_source: &Path,
    video_source: Option<&Path>,
) -> std::io::Result<String> {
    let bytes = serde_json::to_vec(manifest).map_err(std::io::Error::other)?;
    let package_id = format!("{:x}", Sha256::digest(bytes));
    let packages = parent.join("packages");
    std::fs::create_dir_all(&packages)?;
    let destination = packages.join(&package_id);
    if destination.exists() {
        if runtime_package_matches(&destination, manifest) {
            return Ok(package_id);
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "an immutable runtime package has changed and was preserved",
        ));
    }
    let staged = tempfile::Builder::new()
        .prefix(".preparing-")
        .tempdir_in(&packages)?;
    install_binary(host_source, &staged.path().join("native-host"))?;
    std::fs::create_dir(staged.path().join("extension"))?;
    copy_extension_tree(extension_source, &staged.path().join("extension"))?;
    flush_extension_tree(&staged.path().join("extension"))?;
    if manifest.ytdlp.is_some() {
        let source = video_source.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "the runtime manifest requires a missing yt-dlp component",
            )
        })?;
        install_binary(source, &staged.path().join("yt-dlp"))?;
    }
    write_runtime_json(&staged.path().join("manifest.json"), manifest)?;
    if !runtime_package_matches(staged.path(), manifest) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "runtime package bytes do not match the bundled manifest",
        ));
    }
    std::fs::File::open(staged.path())?.sync_all()?;
    std::fs::rename(staged.path(), &destination)?;
    std::fs::File::open(&packages)?.sync_all()?;
    Ok(package_id)
}

fn apply_runtime_journal(
    parent: &Path,
    journal: &mut RuntimeInstallJournal,
    mut register: impl FnMut(&Path) -> std::io::Result<()>,
    mut checkpoint: impl FnMut(RuntimeInstallStage) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let package = parent.join("packages").join(&journal.package_id);
    if !runtime_package_matches(&package, &journal.candidate) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "pending runtime package failed verification; working resources and journal preserved",
        ));
    }
    // Replaying every step is deliberate: a process can stop after an atomic
    // resource replacement and before publishing the next journal stage.
    checkpoint(RuntimeInstallStage::Prepared)?;
    let host = parent.join("native-host");
    if !installed_binary_matches(&package.join("native-host"), &host) {
        install_binary(&package.join("native-host"), &host)?;
    }
    if journal.candidate.ytdlp.is_some()
        && !installed_binary_matches(&package.join("yt-dlp"), &parent.join("yt-dlp"))
    {
        install_binary(&package.join("yt-dlp"), &parent.join("yt-dlp"))?;
    }
    journal.stage = RuntimeInstallStage::HostActivated;
    write_runtime_json(&parent.join("install-journal.json"), journal)?;
    checkpoint(journal.stage)?;
    if !installed_extension_matches(&package.join("extension"), &parent.join("extension")) {
        install_extension_directory(&package.join("extension"), &parent.join("extension"))?;
    }
    journal.stage = RuntimeInstallStage::ExtensionActivated;
    write_runtime_json(&parent.join("install-journal.json"), journal)?;
    checkpoint(journal.stage)?;
    activate_legacy_extension(parent, journal, &mut checkpoint)?;
    register(&package.join("native-host"))?;
    journal.stage = RuntimeInstallStage::Registered;
    write_runtime_json(&parent.join("install-journal.json"), journal)?;
    checkpoint(journal.stage)?;
    if journal.legacy_extension_previous.is_some()
        && extension_manifest(&legacy_extension_path(parent)?).as_ref()
            != Some(&journal.candidate.extension)
    {
        return Err(std::io::Error::other(
            "legacy extension changed before installation verification",
        ));
    }
    if !runtime_package_matches(parent, &journal.candidate) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "runtime activation bytes could not be verified; journal retained",
        ));
    }
    // This attests files only. A live extension/host handshake proves activation.
    write_runtime_json(
        &parent.join("runtime-install.json"),
        &RuntimeInstallMarker {
            manifest: journal.candidate.clone(),
            verified_at_unix_seconds: unix_seconds_now(),
        },
    )?;
    journal.stage = RuntimeInstallStage::FilesVerified;
    write_runtime_json(&parent.join("install-journal.json"), journal)?;
    checkpoint(journal.stage)?;
    Ok(())
}

#[cfg(test)]
fn install_runtime_from_sources(
    parent: &Path,
    candidate: RuntimeBuildManifest,
    host: &Path,
    extension: &Path,
    video: Option<&Path>,
    register: impl FnMut(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    install_runtime_from_sources_with_probe(
        parent,
        candidate,
        host,
        extension,
        video,
        register,
        |_, _| Ok(()),
    )
}

fn install_runtime_from_sources_with_probe(
    parent: &Path,
    candidate: RuntimeBuildManifest,
    host: &Path,
    extension: &Path,
    video: Option<&Path>,
    mut register: impl FnMut(&Path) -> std::io::Result<()>,
    mut probe: impl FnMut(&Path, &RuntimeBuildManifest) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let _writer = crate::storage::source_mutation::begin_write().map_err(std::io::Error::other)?;
    let _lock = runtime_install_lock(parent)?;
    if let Some(mut journal) = read_runtime_journal(parent)? {
        if journal.stage != RuntimeInstallStage::FilesVerified {
            let package = parent.join("packages").join(&journal.package_id);
            if !runtime_package_matches(&package, &journal.candidate)
                || probe(&package.join("native-host"), &journal.candidate).is_err()
            {
                if let Some(previous) = &journal.previous {
                    let previous_id = format!(
                        "{:x}",
                        Sha256::digest(
                            serde_json::to_vec(&previous.manifest)
                                .map_err(std::io::Error::other)?
                        )
                    );
                    let previous_package = parent.join("packages").join(&previous_id);
                    if runtime_package_matches(&previous_package, &previous.manifest)
                        && probe(&previous_package.join("native-host"), &previous.manifest).is_ok()
                    {
                        write_runtime_json(
                            &parent.join(format!("failed-install-{}.json", journal.package_id)),
                            &journal,
                        )?;
                        restore_legacy_extension(parent, &journal)?;
                        // Register the last verified immutable executor first;
                        // source documents and operation journals never roll back.
                        register(&previous_package.join("native-host"))?;
                        let mut rollback = RuntimeInstallJournal {
                            schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
                            package_id: previous_id,
                            candidate: previous.manifest.clone(),
                            previous: None,
                            legacy_extension_previous: journal
                                .legacy_extension_previous
                                .clone()
                                .filter(|extension| *extension == previous.manifest.extension),
                            stage: RuntimeInstallStage::Prepared,
                        };
                        write_runtime_json(&parent.join("install-journal.json"), &rollback)?;
                        apply_runtime_journal(parent, &mut rollback, &mut register, |_| Ok(()))?;
                        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "pending runtime package failed verification; the previous verified runtime was restored and the failed journal was preserved"));
                    }
                }
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "pending runtime package failed verification; resources and unknown operation outcomes were preserved"));
            }
            apply_runtime_journal(parent, &mut journal, &mut register, |_| Ok(()))?;
        }
    }
    let marker = match std::fs::read(parent.join("runtime-install.json")) {
        Ok(bytes) => Some(
            serde_json::from_slice::<RuntimeInstallMarker>(&bytes).map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unknown runtime marker preserved: {error}"),
                )
            })?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let decision = runtime_install_decision(marker.as_ref(), &candidate)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    if decision == RuntimeInstallDecision::ReuseNewer {
        let installed = marker
            .as_ref()
            .ok_or_else(|| std::io::Error::other("runtime marker disappeared"))?;
        if !runtime_package_matches(parent, &installed.manifest) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "the newer runtime failed verification and was preserved without downgrade",
            ));
        }
        let bytes = serde_json::to_vec(&installed.manifest).map_err(std::io::Error::other)?;
        let package = parent
            .join("packages")
            .join(format!("{:x}", Sha256::digest(bytes)));
        if !runtime_package_matches(&package, &installed.manifest) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "the newer immutable runtime package is unavailable and was not downgraded",
            ));
        }
        probe(&package.join("native-host"), &installed.manifest)?;
        let legacy_extension_previous = plan_legacy_extension(parent, &installed.manifest)?;
        if legacy_extension_previous.is_some() {
            let mut journal = RuntimeInstallJournal {
                schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
                package_id: package.file_name().unwrap().to_string_lossy().into_owned(),
                candidate: installed.manifest.clone(),
                previous: marker.clone(),
                legacy_extension_previous,
                stage: RuntimeInstallStage::Prepared,
            };
            write_runtime_json(&parent.join("install-journal.json"), &journal)?;
            return apply_runtime_journal(parent, &mut journal, register, |_| Ok(()));
        }
        return register(&package.join("native-host"));
    }
    let package_id = prepare_runtime_package(parent, &candidate, host, extension, video)?;
    probe(
        &parent
            .join("packages")
            .join(&package_id)
            .join("native-host"),
        &candidate,
    )?;
    let legacy_extension_previous = plan_legacy_extension(parent, &candidate)?;
    let mut journal = RuntimeInstallJournal {
        schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
        package_id,
        candidate,
        previous: marker,
        legacy_extension_previous,
        stage: RuntimeInstallStage::Prepared,
    };
    write_runtime_json(&parent.join("install-journal.json"), &journal)?;
    apply_runtime_journal(parent, &mut journal, register, |_| Ok(()))
}

fn verify_candidate_launch(host: &Path, manifest: &RuntimeBuildManifest) -> std::io::Result<()> {
    let expected = manifest.native_host_build_id.as_deref().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "candidate package has no declared helper build identity",
        )
    })?;
    probe_runtime_host(
        host,
        &manifest.app_version,
        Some(expected),
        RUNTIME_PROBE_TIMEOUT,
    )
    .map(|_| ())
}

/// Explicit developer inputs share the shipped application's installation policy.
pub struct DevelopmentRuntimeInputs {
    /// The compiled helper, supplied by the developer build command.
    pub native_host: PathBuf,
    /// The complete built browser payload, never a source checkout fragment.
    pub extension: PathBuf,
    /// Optional video helper; when supplied, its bytes are part of the package.
    pub ytdlp: Option<PathBuf>,
    /// App support root; source vaults are never accepted as installer targets.
    pub app_data_dir: PathBuf,
    /// Semantic app version; development replacement is explicit in this API.
    pub app_version: String,
}

/// File installation evidence; live browser activation is a separate handshake.
#[derive(Debug, Serialize)]
pub struct DevelopmentRuntimeReport {
    /// Managed helper path used in the new generation's registration.
    pub host_path: PathBuf,
    /// Stable managed developer payload path.
    pub extension_path: PathBuf,
    /// Actual installed semantic version after the no-downgrade decision.
    pub app_version: String,
    /// Installation does not itself attest a running browser component.
    pub activation_verified: bool,
}

/// Developer installation errors preserve working packages and pending journals.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeInstallationError {
    /// A source component could not be fingerprinted before preparation.
    #[error("runtime component cannot be read: {0}")]
    MissingComponent(PathBuf),
    /// An installation or registration step could not be completed safely.
    #[error("runtime installation did not complete: {0}")]
    Installation(#[from] std::io::Error),
}

/// Install an explicitly requested developer build without launching the app UI.
/// Uses the same lock, immutable package, durable journal and registration as Mine.
pub fn install_development_runtime(
    inputs: DevelopmentRuntimeInputs,
) -> Result<DevelopmentRuntimeReport, RuntimeInstallationError> {
    let identity = probe_runtime_host(
        &inputs.native_host,
        &inputs.app_version,
        None,
        RUNTIME_PROBE_TIMEOUT,
    )?;
    let candidate = RuntimeBuildManifest {
        schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
        build_profile: "debug".into(),
        app_version: inputs.app_version,
        native_host_build_id: Some(identity.build_id),
        native_host: file_manifest(&inputs.native_host).ok_or_else(|| {
            RuntimeInstallationError::MissingComponent(inputs.native_host.clone())
        })?,
        extension: extension_manifest(&inputs.extension)
            .ok_or_else(|| RuntimeInstallationError::MissingComponent(inputs.extension.clone()))?,
        ytdlp: inputs
            .ytdlp
            .as_ref()
            .map(|path| {
                file_manifest(path)
                    .ok_or_else(|| RuntimeInstallationError::MissingComponent(path.clone()))
            })
            .transpose()?,
    };
    let parent = inputs
        .app_data_dir
        .join("clipper")
        .join(MANAGED_RUNTIME_DIRECTORY);
    install_runtime_from_sources_with_probe(
        &parent,
        candidate,
        &inputs.native_host,
        &inputs.extension,
        inputs.ytdlp.as_deref(),
        |host| {
            register_browser_manifests(host)
                .map_err(|error| std::io::Error::other(error.to_string()))
        },
        verify_candidate_launch,
    )?;
    let marker: RuntimeInstallMarker =
        serde_json::from_slice(&std::fs::read(parent.join("runtime-install.json"))?)
            .map_err(std::io::Error::other)?;
    Ok(DevelopmentRuntimeReport {
        host_path: parent
            .join("packages")
            .join(format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&marker.manifest).map_err(std::io::Error::other)?
                )
            ))
            .join("native-host"),
        extension_path: parent.join("extension"),
        app_version: marker.manifest.app_version,
        activation_verified: false,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeMaintenanceMode {
    FastRegistration,
    VerifiedInstallation,
}

impl RuntimeMaintenanceMode {
    pub fn as_trace_label(self) -> &'static str {
        match self {
            Self::FastRegistration => "fast_registration",
            Self::VerifiedInstallation => "verified_installation",
        }
    }
}

fn unix_seconds_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

/// Compare actual bytes, not only app version or a stale installation stamp.
fn file_fingerprint(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Some(format!("{:x}", hash.finalize()))
}

fn file_manifest(path: &Path) -> Option<RuntimeComponentManifest> {
    Some(RuntimeComponentManifest {
        sha256: file_fingerprint(path)?,
        bytes: std::fs::metadata(path).ok()?.len(),
    })
}

fn installed_binary_matches(source: &Path, destination: &Path) -> bool {
    let Some(expected) = file_fingerprint(source) else {
        return false;
    };
    if file_fingerprint(destination).as_deref() != Some(expected.as_str()) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(destination)
            .is_ok_and(|metadata| metadata.permissions().mode() & 0o100 != 0);
    }
    #[cfg(not(unix))]
    true
}

fn extension_files(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    if !std::fs::symlink_metadata(root)?.is_dir() {
        return Err(std::io::Error::other(
            "extension root must be a real directory",
        ));
    }
    fn collect(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
        let mut entries = std::fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "extension payload contains a symlink: {}",
                        entry.path().display()
                    ),
                ));
            }
            if file_type.is_dir() {
                collect(root, &entry.path(), files)?;
            } else if file_type.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(std::io::Error::other)?
                    .to_path_buf();
                files.push(relative);
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    collect(root, root, &mut files)?;
    Ok(files)
}

fn extension_fingerprint(root: &Path) -> Option<String> {
    let files = extension_files(root).ok()?;
    if files.is_empty() || !files.iter().any(|path| path == Path::new("manifest.json")) {
        return None;
    }
    let mut hash = Sha256::new();
    for relative in files {
        let bytes = std::fs::read(root.join(&relative)).ok()?;
        hash.update(relative.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    Some(format!("{:x}", hash.finalize()))
}

fn extension_manifest(root: &Path) -> Option<RuntimeComponentManifest> {
    let files = extension_files(root).ok()?;
    let bytes = files.iter().try_fold(0u64, |total, relative| {
        std::fs::metadata(root.join(relative))
            .ok()
            .and_then(|metadata| total.checked_add(metadata.len()))
    })?;
    Some(RuntimeComponentManifest {
        sha256: extension_fingerprint(root)?,
        bytes,
    })
}

fn installed_extension_matches(source: &Path, destination: &Path) -> bool {
    extension_fingerprint(source).is_some_and(|expected| {
        extension_fingerprint(destination).as_deref() == Some(expected.as_str())
    })
}

fn copy_extension_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    for relative in extension_files(source)? {
        let target = destination.join(&relative);
        let parent = target
            .parent()
            .ok_or_else(|| std::io::Error::other("extension file has no parent"))?;
        std::fs::create_dir_all(parent)?;
        std::fs::copy(source.join(relative), target)?;
    }
    Ok(())
}

fn install_extension_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    install_extension_directory_checked(source, destination, None)
}

fn install_extension_directory_checked(
    source: &Path,
    destination: &Path,
    expected_previous: Option<&RuntimeComponentManifest>,
) -> std::io::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("extension directory has no parent"))?;
    std::fs::create_dir_all(parent)?;
    if destination.exists() {
        retain_extension(destination)?;
    }
    let transaction = tempfile::Builder::new()
        .prefix(".clipper-extension-")
        .tempdir_in(parent)?;
    let staged = transaction.path().join("new");
    std::fs::create_dir(&staged)?;
    copy_extension_tree(source, &staged)?;
    flush_extension_tree(&staged)?;
    if !installed_extension_matches(source, &staged) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "staged extension payload differs from the bundle",
        ));
    }
    if expected_previous
        .is_some_and(|expected| extension_manifest(destination).as_ref() != Some(expected))
    {
        return Err(std::io::Error::other(
            "legacy extension changed before atomic activation",
        ));
    }
    if destination.exists() {
        atomic_swap_extension(&staged, destination)?;
        if expected_previous
            .is_some_and(|expected| extension_manifest(&staged).as_ref() != Some(expected))
        {
            // An old installer does not participate in our lock. Restore an
            // unexpected exchanged tree if possible, otherwise retain both.
            if installed_extension_matches(source, destination) {
                if let Err(error) = atomic_swap_extension(&staged, destination) {
                    let _ = transaction.keep();
                    return Err(error);
                }
                std::fs::File::open(parent)?.sync_all()?;
            } else {
                let _ = transaction.keep();
            }
            return Err(std::io::Error::other(
                "concurrent legacy replacement preserved; activation refused",
            ));
        }
    } else {
        std::fs::rename(&staged, destination)?;
    }
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn atomic_swap_extension(staged: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    const RENAME_SWAP: u32 = 0x0000_0002;
    unsafe extern "C" {
        fn renamex_np(
            from: *const std::ffi::c_char,
            to: *const std::ffi::c_char,
            flags: u32,
        ) -> std::ffi::c_int;
    }
    let from =
        std::ffi::CString::new(staged.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
    let to = std::ffi::CString::new(destination.as_os_str().as_bytes())
        .map_err(std::io::Error::other)?;
    // Both C strings are NUL terminated and live across the call. Darwin's
    // RENAME_SWAP exchanges existing directories atomically, retaining the old
    // tree at the staged path; the separately verified retained copy survives.
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), RENAME_SWAP) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn atomic_swap_extension(_staged: &Path, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic managed extension activation is supported on macOS",
    ))
}

fn retain_extension(destination: &Path) -> std::io::Result<()> {
    let fingerprint = extension_fingerprint(destination).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "installed extension cannot be verified for retention",
        )
    })?;
    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("extension directory has no parent"))?;
    let retained = parent
        .join("retained")
        .join(format!("extension-{fingerprint}"));
    if retained.exists() {
        if installed_extension_matches(destination, &retained) {
            return Ok(());
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "retained extension has changed",
        ));
    }
    let retention_root = retained
        .parent()
        .ok_or_else(|| std::io::Error::other("retention directory has no parent"))?;
    std::fs::create_dir_all(retention_root)?;
    let staged = tempfile::Builder::new()
        .prefix(".retaining-")
        .tempdir_in(retention_root)?;
    copy_extension_tree(destination, staged.path())?;
    flush_extension_tree(staged.path())?;
    if !installed_extension_matches(destination, staged.path()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "retained extension verification failed",
        ));
    }
    std::fs::rename(staged.path(), &retained)?;
    std::fs::File::open(
        retained
            .parent()
            .ok_or_else(|| std::io::Error::other("retention directory has no parent"))?,
    )?
    .sync_all()?;
    Ok(())
}

fn runtime_install_decision(
    installed: Option<&RuntimeInstallMarker>,
    candidate: &RuntimeBuildManifest,
) -> Result<RuntimeInstallDecision, RuntimePolicyError> {
    crate::runtime_installation::install_decision(
        installed.map(|value| {
            (
                value.manifest.schema_version,
                value.manifest.app_version.as_str(),
            )
        }),
        &candidate.app_version,
        installed.is_some_and(|value| {
            // Profile describes how installation was requested, not different
            // payload bytes. Keep every version, schema and component field.
            let mut identity = value.manifest.clone();
            identity.build_profile.clone_from(&candidate.build_profile);
            identity == *candidate
        }),
        candidate.build_profile == "debug",
    )
}

fn bundled_host_path() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("native-host")))
        .filter(|path| path.is_file())
}

fn bundled_ytdlp_path(executable: &Path) -> Option<PathBuf> {
    let resources = executable.parent()?.parent()?.join("Resources");
    // Tauri preserves the configured binaries/ resource subdirectory. Older
    // bundles used a flat Resources layout, which remains a valid fallback.
    [resources.join("binaries/yt-dlp"), resources.join("yt-dlp")]
        .into_iter()
        .find(|path| path.is_file())
}

fn bundled_extension_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|resources| resources.join("clipper-extension"))
        .filter(|path| path.join("manifest.json").is_file())
}

fn host_manifest(destination: &Path) -> serde_json::Value {
    serde_json::json!({
        "name": HOST_NAME,
        "description": "Mine web clipper native messaging host",
        "path": destination.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{DEV_EXTENSION_ID}/")],
    })
}

fn manifest_is_registered(path: &Path, destination: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|value| value == host_manifest(destination))
}

fn host_binary_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Internal(format!("no app data dir: {e}")))?
        .join("clipper");
    Ok(dir.join(MANAGED_RUNTIME_DIRECTORY).join("native-host"))
}

fn registered_host_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let host = host_binary_path(app)?;
    let Some(marker) = read_runtime_install_marker(app)? else {
        return Ok(host);
    };
    let parent = host
        .parent()
        .ok_or_else(|| CommandError::Internal("clipper directory has no parent".into()))?;
    let bytes = serde_json::to_vec(&marker.manifest)
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    Ok(parent
        .join("packages")
        .join(format!("{:x}", Sha256::digest(bytes)))
        .join("native-host"))
}

fn installed_extension_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(host_binary_path(app)?
        .parent()
        .ok_or_else(|| CommandError::Internal("clipper directory has no parent".into()))?
        .join("extension"))
}

fn runtime_build_manifest_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|resources| resources.join("clipper-runtime-manifest.json"))
        .filter(|path| path.is_file())
}

fn runtime_install_marker_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(host_binary_path(app)?
        .parent()
        .ok_or_else(|| CommandError::Internal("clipper directory has no parent".into()))?
        .join("runtime-install.json"))
}

fn runtime_build_manifest(app: &AppHandle) -> Result<RuntimeBuildManifest, CommandError> {
    if let Some(path) = runtime_build_manifest_path(app) {
        let bundled = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RuntimeBuildManifest>(&bytes).ok());
        if let Some(manifest) = bundled {
            let expected_profile = if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            };
            let current = manifest.schema_version == RUNTIME_MANIFEST_SCHEMA_VERSION
                && manifest.build_profile == expected_profile
                && manifest.app_version == app.package_info().version.to_string()
                && manifest.native_host_build_id.is_some();
            if current {
                return Ok(manifest);
            }
        }
        if !cfg!(debug_assertions) {
            return Err(CommandError::Internal(
                "clipper runtime manifest is invalid or differs from the app".into(),
            ));
        }
        log::info!("using development clipper manifest fallback");
    }
    if !cfg!(debug_assertions) {
        return Err(CommandError::Internal(
            "release clipper runtime manifest is missing; developer fallback is not permitted"
                .into(),
        ));
    }

    // `tauri dev` has no bundle hook. It may hash after first paint, but never
    // on the startup critical path. Production bundles always ship the file.
    let native_host_path = bundled_host_path().ok_or_else(|| {
        CommandError::Internal("clipper host is missing from the app bundle".into())
    })?;
    let extension_path = bundled_extension_path(app).ok_or_else(|| {
        CommandError::Internal("clipper extension is missing from the app bundle".into())
    })?;
    let executable = std::env::current_exe()
        .map_err(|error| CommandError::Internal(format!("no current executable: {error}")))?;
    let identity = probe_runtime_host(
        &native_host_path,
        &app.package_info().version.to_string(),
        None,
        RUNTIME_PROBE_TIMEOUT,
    )
    .map_err(|error| CommandError::Internal(format!("development helper probe failed: {error}")))?;
    Ok(RuntimeBuildManifest {
        schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
        build_profile: "debug".into(),
        app_version: app.package_info().version.to_string(),
        native_host_build_id: Some(identity.build_id),
        native_host: file_manifest(&native_host_path).ok_or_else(|| {
            CommandError::Internal("failed to fingerprint bundled clipper host".into())
        })?,
        extension: extension_manifest(&extension_path).ok_or_else(|| {
            CommandError::Internal("failed to fingerprint bundled clipper extension".into())
        })?,
        ytdlp: bundled_ytdlp_path(&executable).and_then(|path| file_manifest(&path)),
    })
}

fn read_runtime_install_marker(
    app: &AppHandle,
) -> Result<Option<RuntimeInstallMarker>, CommandError> {
    let path = runtime_install_marker_path(app)?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| {
            CommandError::Internal(format!(
                "runtime marker is unreadable or unknown and has been preserved: {error}"
            ))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CommandError::Internal(format!(
            "runtime marker could not be read: {error}"
        ))),
    }
}

fn executable_with_size(path: &Path, expected_bytes: u64) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() != expected_bytes {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o100 != 0
    }
    #[cfg(not(unix))]
    true
}

fn runtime_components_present(app: &AppHandle, manifest: &RuntimeBuildManifest) -> bool {
    let Ok(host) = host_binary_path(app) else {
        return false;
    };
    if !executable_with_size(&host, manifest.native_host.bytes) {
        return false;
    }
    let Ok(extension) = installed_extension_path(app) else {
        return false;
    };
    let extension_bytes = extension_files(&extension).ok().and_then(|files| {
        files.iter().try_fold(0u64, |total, relative| {
            std::fs::metadata(extension.join(relative))
                .ok()
                .and_then(|metadata| total.checked_add(metadata.len()))
        })
    });
    if !extension.join("manifest.json").is_file()
        || extension_bytes != Some(manifest.extension.bytes)
    {
        return false;
    }
    manifest.ytdlp.as_ref().is_none_or(|component| {
        host.parent()
            .is_some_and(|parent| executable_with_size(&parent.join("yt-dlp"), component.bytes))
    })
}

fn marker_allows_fast_registration(
    marker: Option<&RuntimeInstallMarker>,
    manifest: &RuntimeBuildManifest,
    now: u64,
) -> bool {
    marker.is_some_and(|marker| {
        marker.manifest == *manifest
            && now.saturating_sub(marker.verified_at_unix_seconds)
                <= INTEGRITY_CHECK_INTERVAL_SECONDS
    })
}

/// A Chromium-family browser that supports native messaging.
struct BrowserTarget {
    /// Shown to the user.
    label: &'static str,
    /// Path of the browser's native messaging directory, relative to Library.
    manifest_dir: &'static str,
}

const BROWSERS: &[BrowserTarget] = &[
    BrowserTarget {
        label: "Chrome",
        manifest_dir: "Application Support/Google/Chrome/NativeMessagingHosts",
    },
    BrowserTarget {
        label: "Dia",
        manifest_dir: "Application Support/Dia/User Data/NativeMessagingHosts",
    },
    BrowserTarget {
        label: "Arc",
        manifest_dir: "Application Support/Arc/User Data/NativeMessagingHosts",
    },
    BrowserTarget {
        label: "Edge",
        manifest_dir: "Application Support/Microsoft Edge/NativeMessagingHosts",
    },
    BrowserTarget {
        label: "Brave",
        manifest_dir: "Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClipperBrowserStatus {
    pub label: String,
    /// The browser's own directory exists, so the browser is installed.
    pub detected: bool,
    /// The exact bundled helper manifest is registered; not a live handshake.
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClipperSetupStatus {
    /// The host binary is installed where browsers can launch it.
    pub host_installed: bool,
    /// The installed host matches the bundled binary, not just its version marker.
    pub host_current: bool,
    /// The browser extension lives outside the app and outside a source checkout.
    pub extension_installed: bool,
    /// The installed extension directory exactly matches the bundled payload.
    pub extension_current: bool,
    /// Stable folder that a development browser loads once with Load unpacked.
    pub extension_path: String,
    pub app_version: String,
    pub browsers: Vec<ClipperBrowserStatus>,
    /// Last extension-confirmed handshake, not proof of a current connection.
    pub last_connection_check: Option<ClipperConnectionCheck>,
    /// A damaged diagnostic record does not make registration or capture fail.
    pub connection_check_error: Option<String>,
}

fn library_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library"))
}

fn manifest_path(browser: &BrowserTarget) -> Option<PathBuf> {
    Some(
        library_dir()?
            .join(browser.manifest_dir)
            .join(format!("{HOST_NAME}.json")),
    )
}

/// Whether a browser is installed, judged by its data directory's parent.
fn browser_detected(browser: &BrowserTarget) -> bool {
    let Some(library) = library_dir() else {
        return false;
    };
    let dir = library.join(browser.manifest_dir);
    // The NativeMessagingHosts directory may not exist yet even when the
    // browser does, so check the level above it.
    dir.parent().is_some_and(Path::exists)
}

fn register_browser_manifests(destination: &Path) -> Result<(), CommandError> {
    let manifest = host_manifest(destination);
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| CommandError::Internal(format!("failed to build manifest: {e}")))?;

    let mut registration_errors = Vec::new();
    for browser in BROWSERS {
        if !browser_detected(browser) {
            continue;
        }
        let Some(path) = manifest_path(browser) else {
            continue;
        };
        if let Some(dir) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                registration_errors.push(format!("{}: {e}", browser.label));
                continue;
            }
        }
        if !manifest_is_registered(&path, destination) {
            if let Err(e) = crate::storage::files::write_atomically(&path, &manifest_bytes) {
                registration_errors.push(format!("{}: {e:#}", browser.label));
            }
        }
    }
    if registration_errors.is_empty() {
        Ok(())
    } else {
        Err(CommandError::Internal(format!(
            "helper installed; browser registration failed: {}",
            registration_errors.join("; ")
        )))
    }
}

/// Maintain the installed clipper after first paint. A current installation
/// reads its marker and metadata, then probes the registered immutable helper.
/// Full byte verification runs on changes, missing parts and the weekly pass.
pub fn maintain_installed_runtime(app: &AppHandle) -> Result<RuntimeMaintenanceMode, CommandError> {
    let manifest = runtime_build_manifest(app)?;
    let marker = read_runtime_install_marker(app)?;
    let host = host_binary_path(app)?;
    let parent = host
        .parent()
        .ok_or_else(|| CommandError::Internal("clipper directory has no parent".into()))?;
    let pending = read_runtime_journal(parent)
        .map_err(|error| CommandError::Internal(error.to_string()))?
        .is_some_and(|journal| journal.stage != RuntimeInstallStage::FilesVerified);
    if marker_allows_fast_registration(marker.as_ref(), &manifest, unix_seconds_now())
        && runtime_components_present(app, &manifest)
        && !pending
        && !parent
            .parent()
            .is_some_and(|clipper| std::fs::symlink_metadata(clipper.join("extension")).is_ok())
    {
        let _writer = crate::storage::source_mutation::begin_write()
            .map_err(|error| CommandError::Internal(error.to_string()))?;
        let host = host_binary_path(app)?;
        let _lock = runtime_install_lock(
            host.parent()
                .ok_or_else(|| CommandError::Internal("clipper directory has no parent".into()))?,
        )
        .map_err(|error| {
            CommandError::Internal(format!(
                "another runtime installation is active or its lock is unavailable: {error}"
            ))
        })?;
        let registered = registered_host_path(app)?;
        verify_candidate_launch(&registered, &manifest).map_err(|error| {
            CommandError::Internal(format!("installed helper launch probe failed: {error}"))
        })?;
        register_browser_manifests(&registered)?;
        return Ok(RuntimeMaintenanceMode::FastRegistration);
    }

    install_clipper_host(app.clone(), String::new())?;
    Ok(RuntimeMaintenanceMode::VerifiedInstallation)
}

/// What is installed right now.
#[tauri::command]
pub fn get_clipper_setup_status(app: AppHandle) -> Result<ClipperSetupStatus, CommandError> {
    let app_version = app.package_info().version.to_string();
    let host = host_binary_path(&app)?;
    let host_installed = host.is_file();
    let host_current =
        bundled_host_path().is_some_and(|bundled| installed_binary_matches(&bundled, &host));
    let extension = installed_extension_path(&app)?;
    let extension_installed = extension.join("manifest.json").is_file();
    let extension_current = bundled_extension_path(&app)
        .is_some_and(|bundled| installed_extension_matches(&bundled, &extension));
    let registered_host = registered_host_path(&app)?;

    let browsers = BROWSERS
        .iter()
        .map(|browser| ClipperBrowserStatus {
            label: browser.label.to_string(),
            detected: browser_detected(browser),
            connected: manifest_path(browser)
                .is_some_and(|path| manifest_is_registered(&path, &registered_host)),
        })
        .collect();

    let (last_connection_check, connection_check_error) = match app.path().app_data_dir() {
        Ok(root) => match clipper_connection::read_last_connection_check(&root) {
            Ok(record) => (record, None),
            Err(error) => (
                None,
                Some(format!("Last connection check could not be read: {error}")),
            ),
        },
        Err(error) => (
            None,
            Some(format!(
                "Connection-check directory is unavailable: {error}"
            )),
        ),
    };

    Ok(ClipperSetupStatus {
        host_installed,
        host_current,
        extension_installed,
        extension_current,
        extension_path: extension.to_string_lossy().into_owned(),
        app_version,
        browsers,
        last_connection_check,
        connection_check_error,
    })
}

/// Install the host binary and register it with every browser found.
///
/// Idempotent: running it again refreshes the binary and the manifests, which
/// is exactly what an app update needs. A browser that is not installed is
/// skipped rather than reported as a failure.
#[tauri::command]
pub fn install_clipper_host(
    app: AppHandle,
    extension_id: String,
) -> Result<ClipperSetupStatus, CommandError> {
    let extension_id = extension_id.trim().to_string();
    if !extension_id.is_empty() && extension_id != DEV_EXTENSION_ID {
        return Err(CommandError::Internal(
            "only the bundled Mine development extension is supported; the store release is not configured".into(),
        ));
    }

    // Tauri bundles every binary target of this crate next to the app
    // executable, so the host is already inside the .app and installing it is
    // a copy. Declaring it as a bundle resource instead would make the build
    // script depend on its own output.
    let runtime_manifest = runtime_build_manifest(&app)?;
    let bundled = bundled_host_path().ok_or_else(|| {
        CommandError::Internal("clipper host is missing from the app bundle".into())
    })?;

    let destination = host_binary_path(&app)?;
    let parent = destination
        .parent()
        .ok_or_else(|| CommandError::Internal("clipper directory has no parent".into()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| CommandError::Internal(format!("failed to create clipper directory: {e}")))?;
    let extension = bundled_extension_path(&app).ok_or_else(|| {
        CommandError::Internal("clipper extension is missing from the app bundle".into())
    })?;
    let video = std::env::current_exe()
        .ok()
        .and_then(|exe| bundled_ytdlp_path(&exe));
    install_runtime_from_sources_with_probe(
        parent,
        runtime_manifest,
        &bundled,
        &extension,
        video.as_deref(),
        |host| {
            register_browser_manifests(host)
                .map_err(|error| std::io::Error::other(error.to_string()))
        },
        verify_candidate_launch,
    )
    .map_err(|error| {
        CommandError::Internal(format!("runtime installation remains recoverable: {error}"))
    })?;

    get_clipper_setup_status(app)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn helper_probe_is_bounded_and_rejects_wrong_identity_before_installation() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let host = tmp.path().join("probe-helper");
        let identity = crate::runtime_protocol::RuntimeProbe {
            schema_version: 1,
            version: "1.2.3".into(),
            build_id: "a".repeat(64),
            commit: "test".into(),
            save_protocols: vec![1],
        };
        let write = |body: &str| {
            std::fs::write(&host, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&host, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        write(&format!(
            "printf '%s' '{}'",
            serde_json::to_string(&identity).unwrap()
        ));
        assert_eq!(
            probe_runtime_host(
                &host,
                "1.2.3",
                Some(&identity.build_id),
                std::time::Duration::from_secs(1)
            )
            .unwrap()
            .build_id,
            identity.build_id
        );
        assert!(
            probe_runtime_host(&host, "2.0.0", None, std::time::Duration::from_secs(1)).is_err()
        );
        assert!(probe_runtime_host(
            &host,
            "1.2.3",
            Some(&"b".repeat(64)),
            std::time::Duration::from_secs(1)
        )
        .is_err());
        write("exit 7");
        assert!(
            probe_runtime_host(&host, "1.2.3", None, std::time::Duration::from_secs(1)).is_err()
        );
        write("printf '%s' 'malformed'");
        assert!(
            probe_runtime_host(&host, "1.2.3", None, std::time::Duration::from_secs(1)).is_err()
        );
        write("while :; do :; done");
        assert_eq!(
            probe_runtime_host(&host, "1.2.3", None, std::time::Duration::from_millis(30))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
    }

    #[test]
    fn failed_candidate_launch_preserves_installed_marker_and_registration() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("managed-v1");
        let (old, old_manifest) = runtime_fixture(tmp.path(), "old", "1.0.0");
        install_runtime_from_sources(
            &parent,
            old_manifest,
            &old.join("native-host"),
            &old.join("extension"),
            Some(&old.join("yt-dlp")),
            |_| Ok(()),
        )
        .unwrap();
        let marker = std::fs::read(parent.join("runtime-install.json")).unwrap();
        let journal = std::fs::read(parent.join("install-journal.json")).unwrap();
        let binary = std::fs::read(parent.join("native-host")).unwrap();
        let (new, candidate) = runtime_fixture(tmp.path(), "new", "2.0.0");
        let mut registrations = 0;
        assert!(install_runtime_from_sources_with_probe(
            &parent,
            candidate,
            &new.join("native-host"),
            &new.join("extension"),
            Some(&new.join("yt-dlp")),
            |_| {
                registrations += 1;
                Ok(())
            },
            |_, _| Err(std::io::Error::other("launch rejected"))
        )
        .is_err());
        assert_eq!(registrations, 0);
        assert_eq!(
            std::fs::read(parent.join("runtime-install.json")).unwrap(),
            marker
        );
        assert_eq!(
            std::fs::read(parent.join("install-journal.json")).unwrap(),
            journal
        );
        assert_eq!(std::fs::read(parent.join("native-host")).unwrap(), binary);
    }

    #[test]
    fn fingerprint_changes_when_the_bundled_host_is_rebuilt() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("native-host");
        std::fs::write(&path, b"first build").unwrap();
        let first = file_fingerprint(&path).unwrap();

        // Content changes matter even if version and file length are unchanged.
        std::fs::write(&path, b"a considerably longer second build").unwrap();
        let second = file_fingerprint(&path).unwrap();

        assert_ne!(first, second);
    }

    #[test]
    fn fingerprint_is_stable_for_an_untouched_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("native-host");
        std::fs::write(&path, b"build").unwrap();

        assert_eq!(file_fingerprint(&path), file_fingerprint(&path));
    }

    #[test]
    fn fingerprint_is_absent_for_a_missing_file() {
        let tmp = TempDir::new().unwrap();
        assert!(file_fingerprint(&tmp.path().join("nothing")).is_none());
    }

    fn manifest(version: &str) -> RuntimeBuildManifest {
        RuntimeBuildManifest {
            schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
            build_profile: "release".into(),
            app_version: version.into(),
            native_host_build_id: Some("a".repeat(64)),
            native_host: RuntimeComponentManifest {
                sha256: "host".into(),
                bytes: 10,
            },
            extension: RuntimeComponentManifest {
                sha256: "extension".into(),
                bytes: 20,
            },
            ytdlp: Some(RuntimeComponentManifest {
                sha256: "video".into(),
                bytes: 30,
            }),
        }
    }

    fn runtime_fixture(root: &Path, name: &str, version: &str) -> (PathBuf, RuntimeBuildManifest) {
        let source = root.join(name);
        std::fs::create_dir_all(source.join("extension/dist")).unwrap();
        std::fs::write(source.join("native-host"), format!("host {name}")).unwrap();
        std::fs::write(source.join("yt-dlp"), format!("video {name}")).unwrap();
        std::fs::write(
            source.join("extension/manifest.json"),
            format!("manifest {name}"),
        )
        .unwrap();
        std::fs::write(
            source.join("extension/dist/widget.js"),
            format!("widget {name}"),
        )
        .unwrap();
        let manifest = RuntimeBuildManifest {
            schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
            build_profile: "release".into(),
            app_version: version.into(),
            native_host_build_id: Some("a".repeat(64)),
            native_host: file_manifest(&source.join("native-host")).unwrap(),
            extension: extension_manifest(&source.join("extension")).unwrap(),
            ytdlp: file_manifest(&source.join("yt-dlp")),
        };
        (source, manifest)
    }

    fn browser_payload(root: &Path, host: &str, label: &str) -> RuntimeComponentManifest {
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(
            root.join("manifest.json"),
            include_str!("../../../extension/manifest.json"),
        )
        .unwrap();
        std::fs::write(
            root.join("background.js"),
            format!("const HOST_NAME = \"{host}\";\n// {label}\n"),
        )
        .unwrap();
        std::fs::write(root.join("dist/popup.js"), label).unwrap();
        extension_manifest(root).unwrap()
    }

    #[test]
    fn legacy_activation_recovers_at_every_step_retaining_original_payload_and_old_host() {
        for stopped_at in [
            RuntimeInstallStage::Prepared,
            RuntimeInstallStage::HostActivated,
            RuntimeInstallStage::ExtensionActivated,
            RuntimeInstallStage::LegacyExtensionRetained,
            RuntimeInstallStage::LegacyExtensionActivated,
            RuntimeInstallStage::Registered,
            RuntimeInstallStage::FilesVerified,
        ] {
            let tmp = TempDir::new().unwrap();
            let parent = tmp.path().join("app/clipper/managed-v1");
            let legacy = parent.parent().unwrap().join("extension");
            let original =
                browser_payload(&legacy, "com.localarena.clipper", "original loaded payload");
            let old_host = parent.parent().unwrap().join("native-host");
            let old_registration = tmp.path().join("com.localarena.clipper.json");
            let pending_operation = parent.parent().unwrap().join("pending-save.json");
            for path in [&old_host, &old_registration, &pending_operation] {
                std::fs::write(path, b"keep exactly").unwrap();
            }
            let (source, mut candidate) = runtime_fixture(tmp.path(), "bundle", "1.0.0");
            candidate.extension =
                browser_payload(&source.join("extension"), HOST_NAME, "verified replacement");
            let package_id = prepare_runtime_package(
                &parent,
                &candidate,
                &source.join("native-host"),
                &source.join("extension"),
                Some(&source.join("yt-dlp")),
            )
            .unwrap();
            let mut journal = RuntimeInstallJournal {
                schema_version: 1,
                package_id,
                candidate: candidate.clone(),
                previous: None,
                legacy_extension_previous: plan_legacy_extension(&parent, &candidate).unwrap(),
                stage: RuntimeInstallStage::Prepared,
            };
            write_runtime_json(&parent.join("install-journal.json"), &journal).unwrap();
            assert!(apply_runtime_journal(
                &parent,
                &mut journal,
                |_| Ok(()),
                |stage| {
                    if stage == stopped_at {
                        Err(std::io::Error::other("injected crash"))
                    } else {
                        Ok(())
                    }
                }
            )
            .is_err());
            // Both sides of the atomic exchange leave a complete directory.
            let visible = extension_manifest(&legacy).unwrap();
            assert!(visible == original || visible == candidate.extension);
            let mut replay = read_runtime_journal(&parent).unwrap().unwrap();
            apply_runtime_journal(&parent, &mut replay, |_| Ok(()), |_| Ok(())).unwrap();
            assert_eq!(
                extension_manifest(&legacy),
                Some(candidate.extension.clone())
            );
            let retained = parent
                .parent()
                .unwrap()
                .join("retained")
                .join(format!("extension-{}", original.sha256));
            assert_eq!(extension_manifest(&retained), Some(original));
            assert!(recognized_extension(&legacy, HOST_NAME));
            for path in [&old_host, &old_registration, &pending_operation] {
                assert_eq!(std::fs::read(path).unwrap(), b"keep exactly");
            }
            // Shared maintenance can refresh the adopted directory repeatedly.
            assert_eq!(
                plan_legacy_extension(&parent, &candidate).unwrap(),
                Some(candidate.extension)
            );
        }
    }

    #[test]
    fn legacy_activation_refuses_unknown_payload_identity_and_redirected_paths() {
        for damage in [
            "id",
            "worker",
            "foreign",
            "root_symlink",
            "child_symlink",
            "owner_symlink",
        ] {
            let tmp = TempDir::new().unwrap();
            let parent = tmp.path().join("app/clipper/managed-v1");
            let legacy = parent.parent().unwrap().join("extension");
            browser_payload(&legacy, "com.localarena.clipper", "original");
            let (source, mut candidate) = runtime_fixture(tmp.path(), "bundle", "1.0.0");
            candidate.extension =
                browser_payload(&source.join("extension"), HOST_NAME, "replacement");
            prepare_runtime_package(
                &parent,
                &candidate,
                &source.join("native-host"),
                &source.join("extension"),
                Some(&source.join("yt-dlp")),
            )
            .unwrap();
            match damage {
                "id" => {
                    let mut manifest: serde_json::Value = serde_json::from_slice(
                        &std::fs::read(legacy.join("manifest.json")).unwrap(),
                    )
                    .unwrap();
                    manifest["key"] = serde_json::json!("YWJj");
                    write_runtime_json(&legacy.join("manifest.json"), &manifest).unwrap();
                }
                "worker" => {
                    std::fs::write(
                        legacy.join("background.js"),
                        "const HOST_NAME = \"foreign.host\";\n",
                    )
                    .unwrap();
                }
                "foreign" => {
                    browser_payload(&legacy, HOST_NAME, "not previously adopted");
                }
                "root_symlink" => {
                    let elsewhere = tmp.path().join("elsewhere");
                    std::fs::rename(&legacy, &elsewhere).unwrap();
                    std::os::unix::fs::symlink(&elsewhere, &legacy).unwrap();
                }
                "child_symlink" => {
                    std::os::unix::fs::symlink(
                        &source.join("native-host"),
                        legacy.join("unexpected"),
                    )
                    .unwrap();
                }
                "owner_symlink" => {
                    let elsewhere = tmp.path().join("elsewhere");
                    std::fs::rename(&parent, &elsewhere).unwrap();
                    std::os::unix::fs::symlink(&elsewhere, &parent).unwrap();
                }
                _ => unreachable!(),
            }
            let before = std::fs::read(legacy.join("background.js")).unwrap();
            assert!(
                plan_legacy_extension(&parent, &candidate).is_err(),
                "{damage}"
            );
            assert_eq!(std::fs::read(legacy.join("background.js")).unwrap(), before);
            assert!(!parent.parent().unwrap().join("retained").exists());
        }
    }

    #[test]
    fn legacy_replay_preserves_foreign_changes_and_damaged_backup() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("app/clipper/managed-v1");
        let legacy = parent.parent().unwrap().join("extension");
        let original = browser_payload(&legacy, "com.localarena.clipper", "original");
        let (source, mut candidate) = runtime_fixture(tmp.path(), "bundle", "1.0.0");
        candidate.extension = browser_payload(&source.join("extension"), HOST_NAME, "replacement");
        let package_id = prepare_runtime_package(
            &parent,
            &candidate,
            &source.join("native-host"),
            &source.join("extension"),
            Some(&source.join("yt-dlp")),
        )
        .unwrap();
        let mut journal = RuntimeInstallJournal {
            schema_version: 1,
            package_id,
            candidate: candidate.clone(),
            previous: None,
            legacy_extension_previous: Some(original.clone()),
            stage: RuntimeInstallStage::Prepared,
        };
        std::fs::write(legacy.join("dist/popup.js"), "foreign edit").unwrap();
        assert!(activate_legacy_extension(&parent, &mut journal, &mut |_| Ok(())).is_err());
        assert_eq!(
            std::fs::read_to_string(legacy.join("dist/popup.js")).unwrap(),
            "foreign edit"
        );
        browser_payload(&legacy, "com.localarena.clipper", "original");
        activate_legacy_extension(&parent, &mut journal, &mut |_| Ok(())).unwrap();
        let retained = parent
            .parent()
            .unwrap()
            .join("retained")
            .join(format!("extension-{}", original.sha256));
        std::fs::write(retained.join("dist/popup.js"), "damaged backup").unwrap();
        assert!(activate_legacy_extension(&parent, &mut journal, &mut |_| Ok(())).is_err());
        assert_eq!(extension_manifest(&legacy), Some(candidate.extension));
    }

    #[test]
    fn legacy_activation_reuses_newer_runtime_without_downgrading_browser_payload() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("app/clipper/managed-v1");
        let (new, mut newest) = runtime_fixture(tmp.path(), "new", "2.0.0");
        newest.extension = browser_payload(&new.join("extension"), HOST_NAME, "newest");
        install_runtime_from_sources(
            &parent,
            newest.clone(),
            &new.join("native-host"),
            &new.join("extension"),
            Some(&new.join("yt-dlp")),
            |_| Ok(()),
        )
        .unwrap();
        let legacy = parent.parent().unwrap().join("extension");
        let original = browser_payload(&legacy, "com.localarena.clipper", "original");
        let (old, mut older) = runtime_fixture(tmp.path(), "old", "1.0.0");
        older.extension = browser_payload(&old.join("extension"), HOST_NAME, "older");
        install_runtime_from_sources(
            &parent,
            older,
            &old.join("native-host"),
            &old.join("extension"),
            Some(&old.join("yt-dlp")),
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(extension_manifest(&legacy), Some(newest.extension));
        assert_eq!(
            extension_manifest(
                &parent
                    .parent()
                    .unwrap()
                    .join("retained")
                    .join(format!("extension-{}", original.sha256))
            ),
            Some(original)
        );
    }

    #[test]
    fn legacy_activation_rolls_back_from_verified_backup_when_pending_package_is_damaged() {
        for previously_adopted in [false, true] {
            let tmp = TempDir::new().unwrap();
            let parent = tmp.path().join("app/clipper/managed-v1");
            let legacy = parent.parent().unwrap().join("extension");
            if previously_adopted {
                browser_payload(&legacy, "com.localarena.clipper", "original");
            }
            let (old, mut previous_manifest) = runtime_fixture(tmp.path(), "old", "1.0.0");
            previous_manifest.extension =
                browser_payload(&old.join("extension"), HOST_NAME, "previous generation");
            install_runtime_from_sources(
                &parent,
                previous_manifest.clone(),
                &old.join("native-host"),
                &old.join("extension"),
                Some(&old.join("yt-dlp")),
                |_| Ok(()),
            )
            .unwrap();
            if !previously_adopted {
                browser_payload(&legacy, "com.localarena.clipper", "original");
            }
            let original = extension_manifest(&legacy).unwrap();
            let previous: RuntimeInstallMarker = serde_json::from_slice(
                &std::fs::read(parent.join("runtime-install.json")).unwrap(),
            )
            .unwrap();
            let (source, mut candidate) = runtime_fixture(tmp.path(), "candidate", "2.0.0");
            candidate.extension =
                browser_payload(&source.join("extension"), HOST_NAME, "candidate generation");
            let package_id = prepare_runtime_package(
                &parent,
                &candidate,
                &source.join("native-host"),
                &source.join("extension"),
                Some(&source.join("yt-dlp")),
            )
            .unwrap();
            let mut journal = RuntimeInstallJournal {
                schema_version: 1,
                package_id: package_id.clone(),
                candidate: candidate.clone(),
                previous: Some(previous),
                legacy_extension_previous: plan_legacy_extension(&parent, &candidate).unwrap(),
                stage: RuntimeInstallStage::Prepared,
            };
            write_runtime_json(&parent.join("install-journal.json"), &journal).unwrap();
            assert!(apply_runtime_journal(
                &parent,
                &mut journal,
                |_| Ok(()),
                |stage| {
                    if stage == RuntimeInstallStage::LegacyExtensionActivated {
                        Err(std::io::Error::other("crash after exchange"))
                    } else {
                        Ok(())
                    }
                }
            )
            .is_err());
            std::fs::write(
                parent
                    .join("packages")
                    .join(&package_id)
                    .join("native-host"),
                "damaged candidate",
            )
            .unwrap();
            assert!(install_runtime_from_sources(
                &parent,
                candidate,
                &source.join("native-host"),
                &source.join("extension"),
                Some(&source.join("yt-dlp")),
                |_| Ok(())
            )
            .is_err());
            assert_eq!(extension_manifest(&legacy), Some(original.clone()));
            assert!(runtime_package_matches(&parent, &previous_manifest));
            assert_eq!(
                extension_manifest(
                    &parent
                        .parent()
                        .unwrap()
                        .join("retained")
                        .join(format!("extension-{}", original.sha256))
                ),
                Some(original)
            );
            assert!(parent
                .join(format!("failed-install-{package_id}.json"))
                .is_file());
        }
    }

    #[test]
    fn legacy_activation_rejects_candidate_identity_before_registration_or_stable_writes() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("app/clipper/managed-v1");
        let legacy = parent.parent().unwrap().join("extension");
        let original = browser_payload(&legacy, "com.localarena.clipper", "original");
        let (source, candidate) = runtime_fixture(tmp.path(), "foreign", "1.0.0");
        let mut registered = false;
        assert!(install_runtime_from_sources(
            &parent,
            candidate,
            &source.join("native-host"),
            &source.join("extension"),
            Some(&source.join("yt-dlp")),
            |_| {
                registered = true;
                Ok(())
            }
        )
        .is_err());
        assert!(!registered);
        assert!(!parent.join("native-host").exists());
        assert!(!parent.join("install-journal.json").exists());
        assert_eq!(extension_manifest(&legacy), Some(original));
    }

    #[test]
    fn install_recovers_after_every_durable_step_without_touching_source_files() {
        for stopped_at in [
            RuntimeInstallStage::Prepared,
            RuntimeInstallStage::HostActivated,
            RuntimeInstallStage::ExtensionActivated,
            RuntimeInstallStage::Registered,
            RuntimeInstallStage::FilesVerified,
        ] {
            let tmp = TempDir::new().unwrap();
            let parent = tmp.path().join("app/clipper/managed-v1");
            let source_file = tmp.path().join("user-material.md");
            std::fs::write(
                &source_file,
                "# User material\nUnknown fields and media remain intact\n",
            )
            .unwrap();
            let original = file_fingerprint(&source_file);
            let registration = tmp.path().join("browser/com.mine.clipper.v1.json");
            let register = |host: &Path| write_runtime_json(&registration, &host_manifest(host));
            let (old, old_manifest) = runtime_fixture(tmp.path(), "old", "1.0.0");
            install_runtime_from_sources(
                &parent,
                old_manifest.clone(),
                &old.join("native-host"),
                &old.join("extension"),
                Some(&old.join("yt-dlp")),
                register,
            )
            .unwrap();
            let previous: RuntimeInstallMarker = serde_json::from_slice(
                &std::fs::read(parent.join("runtime-install.json")).unwrap(),
            )
            .unwrap();
            let (new, candidate) = runtime_fixture(tmp.path(), "new", "1.1.0");
            let package_id = prepare_runtime_package(
                &parent,
                &candidate,
                &new.join("native-host"),
                &new.join("extension"),
                Some(&new.join("yt-dlp")),
            )
            .unwrap();
            let mut journal = RuntimeInstallJournal {
                schema_version: 1,
                package_id,
                candidate: candidate.clone(),
                previous: Some(previous),
                legacy_extension_previous: None,
                stage: RuntimeInstallStage::Prepared,
            };
            write_runtime_json(&parent.join("install-journal.json"), &journal).unwrap();
            assert!(
                apply_runtime_journal(&parent, &mut journal, register, |stage| {
                    if stage == stopped_at {
                        Err(std::io::Error::other("injected process stop"))
                    } else {
                        Ok(())
                    }
                })
                .is_err()
            );
            let mut recovered = read_runtime_journal(&parent).unwrap().unwrap();
            apply_runtime_journal(&parent, &mut recovered, register, |_| Ok(())).unwrap();
            assert!(runtime_package_matches(&parent, &candidate));
            assert_eq!(recovered.stage, RuntimeInstallStage::FilesVerified);
            assert_eq!(recovered.previous.as_ref().unwrap().manifest, old_manifest);
            assert_eq!(file_fingerprint(&source_file), original);
            assert!(manifest_is_registered(
                &registration,
                &parent
                    .join("packages")
                    .join(&recovered.package_id)
                    .join("native-host")
            ));
            assert!(parent.join("packages").is_dir());
        }
    }

    #[test]
    fn registration_failure_keeps_pending_journal_until_recovery() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("managed");
        let (source, manifest) = runtime_fixture(tmp.path(), "bundle", "1.0.0");
        let error = install_runtime_from_sources(
            &parent,
            manifest.clone(),
            &source.join("native-host"),
            &source.join("extension"),
            Some(&source.join("yt-dlp")),
            |_| Err(std::io::Error::other("browser directory denied")),
        );
        assert!(error.is_err());
        assert_eq!(
            read_runtime_journal(&parent).unwrap().unwrap().stage,
            RuntimeInstallStage::ExtensionActivated
        );
        install_runtime_from_sources(
            &parent,
            manifest.clone(),
            &source.join("native-host"),
            &source.join("extension"),
            Some(&source.join("yt-dlp")),
            |_| Ok(()),
        )
        .unwrap();
        assert!(runtime_package_matches(&parent, &manifest));
        assert_eq!(
            read_runtime_journal(&parent).unwrap().unwrap().stage,
            RuntimeInstallStage::FilesVerified
        );
    }

    #[test]
    fn unknown_install_journal_is_preserved_without_mutation() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("managed");
        std::fs::create_dir_all(&parent).unwrap();
        let path = parent.join("install-journal.json");
        std::fs::write(&path, b"{\"schema_version\": 99, \"future\": true}").unwrap();
        let before = std::fs::read(&path).unwrap();
        let (source, manifest) = runtime_fixture(tmp.path(), "bundle", "1.0.0");
        assert!(install_runtime_from_sources(
            &parent,
            manifest,
            &source.join("native-host"),
            &source.join("extension"),
            Some(&source.join("yt-dlp")),
            |_| Ok(())
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!parent.join("native-host").exists());
    }

    #[test]
    fn legacy_installer_paths_do_not_replace_managed_generation() {
        let tmp = TempDir::new().unwrap();
        let clipper = tmp.path().join("clipper");
        let parent = clipper.join(MANAGED_RUNTIME_DIRECTORY);
        let (source, manifest) = runtime_fixture(tmp.path(), "bundle", "1.0.0");
        install_runtime_from_sources(
            &parent,
            manifest.clone(),
            &source.join("native-host"),
            &source.join("extension"),
            Some(&source.join("yt-dlp")),
            |_| Ok(()),
        )
        .unwrap();
        std::fs::write(clipper.join("native-host"), b"legacy replacement").unwrap();
        std::fs::create_dir_all(clipper.join("extension")).unwrap();
        std::fs::write(
            clipper.join("extension/manifest.json"),
            b"legacy replacement",
        )
        .unwrap();
        let browser = tmp.path().join("browser");
        write_runtime_json(
            &browser.join(format!("{HOST_NAME}.json")),
            &host_manifest(&parent.join("native-host")),
        )
        .unwrap();
        std::fs::write(
            browser.join("com.localarena.clipper.json"),
            b"legacy registration",
        )
        .unwrap();
        assert!(runtime_package_matches(&parent, &manifest));
        assert!(manifest_is_registered(
            &browser.join(format!("{HOST_NAME}.json")),
            &parent.join("native-host")
        ));
    }

    #[test]
    fn explicit_development_install_replaces_same_version_and_preserves_running_package() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("managed");
        let (old, mut old_manifest) = runtime_fixture(tmp.path(), "old-dev", "0.1.0");
        old_manifest.build_profile = "debug".into();
        install_runtime_from_sources(
            &parent,
            old_manifest.clone(),
            &old.join("native-host"),
            &old.join("extension"),
            Some(&old.join("yt-dlp")),
            |_| Ok(()),
        )
        .unwrap();
        let old_package_id = read_runtime_journal(&parent).unwrap().unwrap().package_id;
        let old_package = parent.join("packages").join(old_package_id);
        let (new, mut new_manifest) = runtime_fixture(tmp.path(), "new-dev", "0.1.0");
        new_manifest.build_profile = "debug".into();
        let mut registration = PathBuf::new();
        install_runtime_from_sources(
            &parent,
            new_manifest.clone(),
            &new.join("native-host"),
            &new.join("extension"),
            Some(&new.join("yt-dlp")),
            |host| {
                registration = host.to_path_buf();
                Ok(())
            },
        )
        .unwrap();
        assert!(runtime_package_matches(&parent, &new_manifest));
        assert!(runtime_package_matches(&old_package, &old_manifest));
        assert_ne!(registration, parent.join("native-host"));
        assert_eq!(
            std::fs::read(old_package.join("yt-dlp")).unwrap(),
            b"video old-dev"
        );
    }

    #[test]
    fn explicit_development_install_does_not_downgrade_newer_published_runtime() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("managed");
        let (published, published_manifest) = runtime_fixture(tmp.path(), "published", "1.0.0");
        install_runtime_from_sources(
            &parent,
            published_manifest.clone(),
            &published.join("native-host"),
            &published.join("extension"),
            Some(&published.join("yt-dlp")),
            |_| Ok(()),
        )
        .unwrap();
        let (dev, mut dev_manifest) = runtime_fixture(tmp.path(), "older-dev", "0.1.0");
        dev_manifest.build_profile = "debug".into();
        install_runtime_from_sources(
            &parent,
            dev_manifest,
            &dev.join("native-host"),
            &dev.join("extension"),
            Some(&dev.join("yt-dlp")),
            |_| Ok(()),
        )
        .unwrap();
        assert!(runtime_package_matches(&parent, &published_manifest));
    }

    #[test]
    fn prerelease_order_is_explicit_and_build_metadata_does_not_authorize_replacement() {
        let installed = RuntimeInstallMarker {
            manifest: manifest("1.0.0-beta.2"),
            verified_at_unix_seconds: 0,
        };
        assert_eq!(
            runtime_install_decision(Some(&installed), &manifest("1.0.0-beta.1")),
            Ok(RuntimeInstallDecision::ReuseNewer)
        );
        assert_eq!(
            runtime_install_decision(Some(&installed), &manifest("1.0.0")),
            Ok(RuntimeInstallDecision::Install)
        );
        let installed = RuntimeInstallMarker {
            manifest: manifest("1.0.0+published"),
            verified_at_unix_seconds: 0,
        };
        assert!(
            runtime_install_decision(Some(&installed), &manifest("1.0.0+replacement")).is_err()
        );
    }

    #[test]
    fn damaged_pending_package_restores_the_previous_verified_executor_and_keeps_failed_journal() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("managed");
        let registration = tmp.path().join("browser/host.json");
        let register = |host: &Path| write_runtime_json(&registration, &host_manifest(host));
        let (old, old_manifest) = runtime_fixture(tmp.path(), "old", "1.0.0");
        install_runtime_from_sources(
            &parent,
            old_manifest.clone(),
            &old.join("native-host"),
            &old.join("extension"),
            Some(&old.join("yt-dlp")),
            register,
        )
        .unwrap();
        let previous: RuntimeInstallMarker =
            serde_json::from_slice(&std::fs::read(parent.join("runtime-install.json")).unwrap())
                .unwrap();
        let old_id = read_runtime_journal(&parent).unwrap().unwrap().package_id;
        let (new, candidate) = runtime_fixture(tmp.path(), "new", "1.1.0");
        let package_id = prepare_runtime_package(
            &parent,
            &candidate,
            &new.join("native-host"),
            &new.join("extension"),
            Some(&new.join("yt-dlp")),
        )
        .unwrap();
        let mut journal = RuntimeInstallJournal {
            schema_version: 1,
            package_id: package_id.clone(),
            candidate: candidate.clone(),
            previous: Some(previous),
            legacy_extension_previous: None,
            stage: RuntimeInstallStage::Prepared,
        };
        write_runtime_json(&parent.join("install-journal.json"), &journal).unwrap();
        assert!(
            apply_runtime_journal(&parent, &mut journal, register, |stage| {
                if stage == RuntimeInstallStage::Registered {
                    Err(std::io::Error::other("process stopped"))
                } else {
                    Ok(())
                }
            })
            .is_err()
        );
        std::fs::write(
            parent
                .join("packages")
                .join(&package_id)
                .join("native-host"),
            b"corrupted",
        )
        .unwrap();
        let result = install_runtime_from_sources(
            &parent,
            candidate,
            &new.join("native-host"),
            &new.join("extension"),
            Some(&new.join("yt-dlp")),
            register,
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("previous verified runtime was restored"));
        assert!(runtime_package_matches(&parent, &old_manifest));
        assert!(manifest_is_registered(
            &registration,
            &parent.join("packages").join(old_id).join("native-host")
        ));
        assert!(parent
            .join(format!("failed-install-{package_id}.json"))
            .is_file());
        assert!(parent
            .join("packages")
            .join(package_id)
            .join("native-host")
            .is_file());
    }

    #[test]
    fn current_recent_marker_uses_metadata_only_fast_path() {
        let now = 10_000_000;
        let build = manifest("1.2.3");
        let marker = RuntimeInstallMarker {
            manifest: build.clone(),
            verified_at_unix_seconds: now - 60,
        };
        assert!(marker_allows_fast_registration(Some(&marker), &build, now));
    }

    #[test]
    fn app_update_requires_verified_installation() {
        let now = 10_000_000;
        let marker = RuntimeInstallMarker {
            manifest: manifest("1.2.2"),
            verified_at_unix_seconds: now - 60,
        };
        assert!(!marker_allows_fast_registration(
            Some(&marker),
            &manifest("1.2.3"),
            now
        ));
    }

    #[test]
    fn older_app_reuses_the_newer_runtime_without_downgrade() {
        let installed = RuntimeInstallMarker {
            manifest: manifest("1.3.0"),
            verified_at_unix_seconds: 0,
        };
        assert_eq!(
            runtime_install_decision(Some(&installed), &manifest("1.2.0")),
            Ok(RuntimeInstallDecision::ReuseNewer)
        );
    }

    #[test]
    fn release_version_cannot_be_reused_for_changed_bytes() {
        let installed = RuntimeInstallMarker {
            manifest: manifest("1.2.0"),
            verified_at_unix_seconds: 0,
        };
        let mut changed = manifest("1.2.0");
        changed.native_host.sha256 = "other-build".into();
        assert!(runtime_install_decision(Some(&installed), &changed).is_err());
        changed.build_profile = "debug".into();
        assert_eq!(
            runtime_install_decision(Some(&installed), &changed),
            Ok(RuntimeInstallDecision::Install)
        );
    }

    #[test]
    fn identical_runtime_content_is_accepted_across_development_and_release_profiles() {
        for (installed_profile, candidate_profile) in [("debug", "release"), ("release", "debug")] {
            let mut installed = RuntimeInstallMarker {
                manifest: manifest("1.2.0"),
                verified_at_unix_seconds: 0,
            };
            installed.manifest.build_profile = installed_profile.into();
            let mut candidate = installed.manifest.clone();
            candidate.build_profile = candidate_profile.into();
            assert_eq!(
                runtime_install_decision(Some(&installed), &candidate),
                Ok(RuntimeInstallDecision::Install)
            );
        }
    }

    #[test]
    fn release_rejects_changed_content_even_when_installed_profile_is_development() {
        let mut installed = RuntimeInstallMarker {
            manifest: manifest("1.2.0"),
            verified_at_unix_seconds: 0,
        };
        installed.manifest.build_profile = "debug".into();
        for field in [
            "host_hash",
            "host_bytes",
            "extension_hash",
            "extension_bytes",
            "video_hash",
            "video_bytes",
            "host_build_id",
        ] {
            let mut candidate = installed.manifest.clone();
            candidate.build_profile = "release".into();
            match field {
                "host_hash" => candidate.native_host.sha256 = "different".into(),
                "host_bytes" => candidate.native_host.bytes += 1,
                "extension_hash" => candidate.extension.sha256 = "different".into(),
                "extension_bytes" => candidate.extension.bytes += 1,
                "video_hash" => candidate.ytdlp.as_mut().unwrap().sha256 = "different".into(),
                "video_bytes" => candidate.ytdlp.as_mut().unwrap().bytes += 1,
                "host_build_id" => candidate.native_host_build_id = Some("different".into()),
                _ => unreachable!(),
            }
            assert!(
                matches!(
                    runtime_install_decision(Some(&installed), &candidate),
                    Err(RuntimePolicyError::ReleaseIdentityCollision(_))
                ),
                "{field}"
            );
        }
    }

    #[test]
    fn application_accepts_identical_development_payload_and_retains_its_package() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("managed");
        let (source, mut candidate) = runtime_fixture(tmp.path(), "bundle", "1.0.0");
        candidate.build_profile = "debug".into();
        install_runtime_from_sources(
            &parent,
            candidate.clone(),
            &source.join("native-host"),
            &source.join("extension"),
            Some(&source.join("yt-dlp")),
            |_| Ok(()),
        )
        .unwrap();
        let development_id = read_runtime_journal(&parent).unwrap().unwrap().package_id;
        candidate.build_profile = "release".into();
        install_runtime_from_sources(
            &parent,
            candidate.clone(),
            &source.join("native-host"),
            &source.join("extension"),
            Some(&source.join("yt-dlp")),
            |_| Ok(()),
        )
        .unwrap();
        let marker: RuntimeInstallMarker =
            serde_json::from_slice(&std::fs::read(parent.join("runtime-install.json")).unwrap())
                .unwrap();
        assert_eq!(marker.manifest, candidate);
        assert!(runtime_package_matches(
            &parent.join("packages").join(development_id),
            &marker.manifest
        ));
        assert!(runtime_package_matches(&parent, &marker.manifest));
    }

    #[test]
    fn installers_serialize_and_release_the_lock_on_owner_exit() {
        let tmp = TempDir::new().unwrap();
        let owner = runtime_install_lock(tmp.path()).unwrap();
        assert!(runtime_install_lock(tmp.path()).is_err());
        drop(owner);
        assert!(runtime_install_lock(tmp.path()).is_ok());
    }

    #[test]
    fn unknown_marker_schema_and_unordered_versions_are_not_overwritten() {
        let mut installed = RuntimeInstallMarker {
            manifest: manifest("1.2.0"),
            verified_at_unix_seconds: 0,
        };
        installed.manifest.schema_version = 2;
        assert!(runtime_install_decision(Some(&installed), &manifest("1.3.0")).is_err());
        installed.manifest.schema_version = 1;
        installed.manifest.app_version = "experimental".into();
        assert!(runtime_install_decision(Some(&installed), &manifest("1.3.0")).is_err());
    }

    #[test]
    fn expired_marker_requires_bounded_integrity_pass() {
        let now = 10_000_000;
        let build = manifest("1.2.3");
        let marker = RuntimeInstallMarker {
            manifest: build.clone(),
            verified_at_unix_seconds: now - INTEGRITY_CHECK_INTERVAL_SECONDS - 1,
        };
        assert!(!marker_allows_fast_registration(Some(&marker), &build, now));
    }

    #[test]
    fn ytdlp_resolver_matches_tauri_bundle_resources_and_prefers_current_layout() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(
            config["bundle"]["resources"]["binaries/yt-dlp"],
            serde_json::json!("binaries/yt-dlp")
        );
        assert_eq!(
            config["bundle"]["resources"]["../build/clipper-extension/"],
            serde_json::json!("clipper-extension/")
        );
        let tmp = TempDir::new().unwrap();
        let contents = tmp.path().join("Mine.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        std::fs::create_dir_all(contents.join("Resources/binaries")).unwrap();
        let executable = contents.join("MacOS/mine");
        let resource = contents.join("Resources/binaries/yt-dlp");
        std::fs::write(&executable, b"app").unwrap();
        std::fs::write(&resource, b"current bundled helper").unwrap();
        std::fs::write(contents.join("Resources/yt-dlp"), b"older helper").unwrap();
        assert_eq!(bundled_ytdlp_path(&executable), Some(resource));
    }

    #[test]
    fn ytdlp_resolver_preserves_legacy_flat_bundle_layout() {
        let tmp = TempDir::new().unwrap();
        let contents = tmp.path().join("Mine.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        std::fs::create_dir_all(contents.join("Resources")).unwrap();
        let resource = contents.join("Resources/yt-dlp");
        std::fs::write(&resource, b"legacy bundled helper").unwrap();
        assert_eq!(
            bundled_ytdlp_path(&contents.join("MacOS/mine")),
            Some(resource)
        );
    }

    #[test]
    fn ytdlp_resolver_does_not_treat_a_resource_directory_as_a_binary() {
        let tmp = TempDir::new().unwrap();
        let contents = tmp.path().join("Mine.app/Contents");
        assert!(bundled_ytdlp_path(&contents.join("MacOS/mine")).is_none());
        std::fs::create_dir_all(contents.join("Resources/binaries/yt-dlp")).unwrap();
        assert!(bundled_ytdlp_path(&contents.join("MacOS/mine")).is_none());
    }

    #[test]
    fn extension_key_derives_the_registered_development_id() {
        use base64::Engine;
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../extension/manifest.json")).unwrap();
        let key = base64::engine::general_purpose::STANDARD
            .decode(manifest["key"].as_str().unwrap())
            .unwrap();
        let hash = Sha256::digest(key);
        let id: String = hash[..16]
            .iter()
            .flat_map(|byte| {
                [
                    char::from(b'a' + (byte >> 4)),
                    char::from(b'a' + (byte & 15)),
                ]
            })
            .collect();
        assert_eq!(id, DEV_EXTENSION_ID);
    }

    #[test]
    fn registration_requires_the_exact_bundled_path_and_allowlist() {
        let tmp = TempDir::new().unwrap();
        let host = tmp.path().join("native-host");
        let path = tmp.path().join("manifest.json");
        let mut manifest = host_manifest(&host);
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(manifest_is_registered(&path, &host));
        assert!(!manifest_is_registered(
            &path,
            &tmp.path().join("other-host")
        ));
        manifest["allowed_origins"] = serde_json::json!(["chrome-extension://*/"]);
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(!manifest_is_registered(&path, &host));
    }

    #[test]
    fn binary_install_replaces_complete_bytes_without_mutating_existing_inode() {
        use std::io::Read;
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("bundle");
        let destination = tmp.path().join("native-host");
        std::fs::write(&destination, b"old-running-binary").unwrap();
        let mut running = std::fs::File::open(&destination).unwrap();
        std::fs::write(&source, b"new-complete-binary").unwrap();
        install_binary(&source, &destination).unwrap();
        let mut old = String::new();
        running.read_to_string(&mut old).unwrap();
        assert_eq!(old, "old-running-binary");
        let retained = destination.parent().unwrap().join("retained").join(format!(
            "native-host-{}",
            format!("{:x}", Sha256::digest(b"old-running-binary"))
        ));
        assert_eq!(std::fs::read(retained).unwrap(), b"old-running-binary");
        assert_eq!(std::fs::read(&destination).unwrap(), b"new-complete-binary");
        assert!(installed_binary_matches(&source, &destination));
    }

    #[test]
    fn missing_source_and_destination_do_not_match() {
        let tmp = TempDir::new().unwrap();
        assert!(!installed_binary_matches(
            &tmp.path().join("source"),
            &tmp.path().join("target")
        ));
    }

    #[test]
    fn extension_install_replaces_the_complete_directory_and_removes_stale_files() {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("bundle");
        let destination = tmp.path().join("installed/extension");
        std::fs::create_dir_all(source.join("dist")).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("manifest.json"), b"bundle manifest").unwrap();
        std::fs::write(source.join("dist/popup.js"), b"bundle script").unwrap();
        std::fs::write(destination.join("manifest.json"), b"old manifest").unwrap();
        std::fs::write(destination.join("stale.js"), b"stale").unwrap();

        install_extension_directory(&source, &destination).unwrap();

        assert!(installed_extension_matches(&source, &destination));
        assert!(!destination.join("stale.js").exists());
        let retained: Vec<_> = std::fs::read_dir(destination.parent().unwrap().join("retained"))
            .unwrap()
            .collect();
        assert_eq!(retained.len(), 1);
        assert_eq!(
            std::fs::read(destination.join("dist/popup.js")).unwrap(),
            b"bundle script"
        );
    }

    #[cfg(unix)]
    #[test]
    fn extension_install_rejects_symlinks_from_the_bundle() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("bundle");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("manifest.json"), b"manifest").unwrap();
        symlink(source.join("manifest.json"), source.join("linked.json")).unwrap();

        let error = install_extension_directory(&source, &tmp.path().join("installed/extension"))
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
