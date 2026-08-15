// Installing the browser clipper without a terminal.
//
// The clipper needs a native messaging host: a small binary the browser is
// allowed to launch, declared by a manifest in that browser's own directory.
// Until now this was a bash script that compiled the binary with cargo and
// asked for an extension id by hand — a path only a developer could walk. The
// binary already ships inside the app bundle, so installing is copying it into
// place and writing one manifest per browser found.
//
// See SPEC_ONBOARDING.md О5–О7.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::state::CommandError;

/// Native messaging host name, matched by the extension's manifest.
const HOST_NAME: &str = "com.localarena.clipper";

/// Where the installed host binary lives, alongside the app's other data.
fn host_binary_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Internal(format!("no app data dir: {e}")))?
        .join("clipper");
    Ok(dir.join("native-host"))
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
    /// A manifest for this host is present in it.
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClipperSetupStatus {
    /// The host binary is installed where browsers can launch it.
    pub host_installed: bool,
    /// The installed host matches the running app's version.
    pub host_current: bool,
    pub app_version: String,
    pub browsers: Vec<ClipperBrowserStatus>,
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
    let installed_version = version_marker_path(&app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|raw| raw.trim().to_string());

    let browsers = BROWSERS
        .iter()
        .map(|browser| ClipperBrowserStatus {
            label: browser.label.to_string(),
            detected: browser_detected(browser),
            connected: manifest_path(browser).is_some_and(|path| path.is_file()),
        })
        .collect();

    Ok(ClipperSetupStatus {
        host_installed,
        host_current: host_installed && installed_version.as_deref() == Some(app_version.as_str()),
        app_version,
        browsers,
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
    if extension_id.is_empty() || !extension_id.chars().all(|c| c.is_ascii_lowercase()) {
        return Err(CommandError::Internal(
            "extension id must be the lowercase id shown on the extension's page".into(),
        ));
    }

    // Tauri bundles every binary target of this crate next to the app
    // executable, so the host is already inside the .app and installing it is
    // a copy. Declaring it as a bundle resource instead would make the build
    // script depend on its own output.
    let bundled = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("native-host")))
        .filter(|path| path.is_file())
        .ok_or_else(|| {
            CommandError::Internal("clipper host is missing from the app bundle".into())
        })?;

    let destination = host_binary_path(&app)?;
    let parent = destination
        .parent()
        .ok_or_else(|| CommandError::Internal("clipper directory has no parent".into()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| CommandError::Internal(format!("failed to create clipper directory: {e}")))?;
    std::fs::copy(&bundled, &destination)
        .map_err(|e| CommandError::Internal(format!("failed to install clipper host: {e}")))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&destination)
            .map_err(|e| CommandError::Internal(format!("failed to read host metadata: {e}")))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&destination, perms)
            .map_err(|e| CommandError::Internal(format!("failed to mark host executable: {e}")))?;
    }

    // The bundled yt-dlp travels with the host: the browser launches the host
    // from the user's own directory, so anything it needs has to be there too.
    // Failing to copy it is not fatal — everything except restricted video
    // keeps working. See SPEC_ONBOARDING.md О8.
    if let Some(source) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("../Resources/yt-dlp")))
        .filter(|path| path.is_file())
    {
        let target = parent.join("yt-dlp");
        match std::fs::copy(&source, &target) {
            Ok(_) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(meta) = std::fs::metadata(&target) {
                        let mut perms = meta.permissions();
                        perms.set_mode(0o755);
                        let _ = std::fs::set_permissions(&target, perms);
                    }
                }
            }
            Err(error) => log::warn!("failed to install bundled yt-dlp: {error}"),
        }
    }

    let manifest = serde_json::json!({
        "name": HOST_NAME,
        "description": "Mine web clipper native messaging host",
        "path": destination.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{extension_id}/")],
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| CommandError::Internal(format!("failed to build manifest: {e}")))?;

    for browser in BROWSERS {
        if !browser_detected(browser) {
            continue;
        }
        let Some(path) = manifest_path(browser) else {
            continue;
        };
        if let Some(dir) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                log::warn!("failed to prepare {} manifest dir: {e}", browser.label);
                continue;
            }
        }
        if let Err(e) = crate::storage::files::write_atomically(&path, &manifest_bytes) {
            log::warn!("failed to register clipper with {}: {e:#}", browser.label);
        }
    }

    let version = app.package_info().version.to_string();
    let _ = std::fs::write(version_marker_path(&app)?, version);

    get_clipper_setup_status(app)
}
