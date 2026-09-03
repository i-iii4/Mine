// Installing the browser clipper without a terminal.
//
// The clipper needs two installed runtime parts: an extension in a stable
// Application Support directory and a native messaging host the browser may
// launch. Both ship in the app bundle and are refreshed without touching a
// user's vault.
//
// See SPEC_ONBOARDING.md О5–О7.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::commands::state::CommandError;
use crate::storage::clipper_connection::{self, ClipperConnectionCheck, DEV_EXTENSION_ID};

/// Native messaging host name, matched by the extension's manifest.
const HOST_NAME: &str = "com.localarena.clipper";

/// First launch installs the bundled runtime; every later launch repairs its
/// exact browser allowlist and refreshes both parts without touching vaults.
pub fn refresh_installed_host(app: &AppHandle) {
    if let Err(error) = install_clipper_host(app.clone(), String::new()) {
        log::warn!("clipper helper registration needs attention: {error}");
    }
}

/// Compare actual bytes, not only app version or a stale installation stamp.
fn file_fingerprint(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(bytes)))
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
    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("extension directory has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let transaction = tempfile::Builder::new()
        .prefix(".clipper-extension-")
        .tempdir_in(parent)?;
    let staged = transaction.path().join("new");
    let previous = transaction.path().join("previous");
    std::fs::create_dir(&staged)?;
    copy_extension_tree(source, &staged)?;
    if !installed_extension_matches(source, &staged) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "staged extension payload differs from the bundle",
        ));
    }
    if destination.exists() {
        std::fs::rename(destination, &previous)?;
    }
    if let Err(error) = std::fs::rename(&staged, destination) {
        if previous.exists() {
            let _ = std::fs::rename(&previous, destination);
        }
        return Err(error);
    }
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
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

fn install_binary(source: &Path, destination: &Path) -> std::io::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("host directory is missing"))?;
    std::fs::create_dir_all(parent)?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    std::io::copy(&mut std::fs::File::open(source)?, staged.as_file_mut())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        staged
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o755))?;
    }
    staged.as_file().sync_all()?;
    staged.persist(destination).map_err(|error| error.error)?;
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn host_binary_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Internal(format!("no app data dir: {e}")))?
        .join("clipper");
    Ok(dir.join("native-host"))
}

fn installed_extension_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(host_binary_path(app)?
        .parent()
        .ok_or_else(|| CommandError::Internal("clipper directory has no parent".into()))?
        .join("extension"))
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

/// Version marker written next to the installed host.
fn version_marker_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(host_binary_path(app)?.with_extension("version"))
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

    let browsers = BROWSERS
        .iter()
        .map(|browser| ClipperBrowserStatus {
            label: browser.label.to_string(),
            detected: browser_detected(browser),
            connected: manifest_path(browser)
                .is_some_and(|path| manifest_is_registered(&path, &host)),
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
    let bundled = bundled_host_path().ok_or_else(|| {
        CommandError::Internal("clipper host is missing from the app bundle".into())
    })?;

    let destination = host_binary_path(&app)?;
    let parent = destination
        .parent()
        .ok_or_else(|| CommandError::Internal("clipper directory has no parent".into()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| CommandError::Internal(format!("failed to create clipper directory: {e}")))?;
    if !installed_binary_matches(&bundled, &destination) {
        install_binary(&bundled, &destination)
            .map_err(|e| CommandError::Internal(format!("failed to install clipper host: {e}")))?;
    }

    // The bundled yt-dlp travels with the host: the browser launches the host
    // from the user's own directory, so anything it needs has to be there too.
    // Failing to copy it is not fatal — everything except restricted video
    // keeps working. See SPEC_ONBOARDING.md О8.
    if let Some(source) = std::env::current_exe()
        .ok()
        .and_then(|exe| bundled_ytdlp_path(&exe))
    {
        let target = parent.join("yt-dlp");
        if !installed_binary_matches(&source, &target) {
            if let Err(error) = install_binary(&source, &target) {
                log::warn!("failed to install bundled yt-dlp: {error}");
            }
        }
    }

    if let Some(source) = bundled_extension_path(&app) {
        let target = installed_extension_path(&app)?;
        if !installed_extension_matches(&source, &target) {
            install_extension_directory(&source, &target).map_err(|error| {
                CommandError::Internal(format!("failed to install bundled extension: {error}"))
            })?;
        }
    }

    let manifest = host_manifest(&destination);
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
        if !manifest_is_registered(&path, &destination) {
            if let Err(e) = crate::storage::files::write_atomically(&path, &manifest_bytes) {
                registration_errors.push(format!("{}: {e:#}", browser.label));
            }
        }
    }
    if !registration_errors.is_empty() {
        return Err(CommandError::Internal(format!(
            "helper installed; browser registration failed: {}",
            registration_errors.join("; ")
        )));
    }

    let version = app.package_info().version.to_string();
    std::fs::write(version_marker_path(&app)?, version).map_err(|error| {
        CommandError::Internal(format!(
            "helper registered but version marker could not be written: {error}"
        ))
    })?;

    get_clipper_setup_status(app)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
