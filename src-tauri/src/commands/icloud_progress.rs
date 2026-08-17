//! The real download percentage for a file iCloud is bringing back.
//!
//! Disk state can only say "contents absent"; how much of the download has
//! arrived lives in the system's ubiquitous metadata, which the bundled Swift
//! helper reads (`native/icloud_progress_helper.swift`). This module owns
//! resolving a card's media reference to a vault path, refusing anything that
//! points outside the vault, and translating the helper's answer into a typed
//! result the interface can poll. See SPEC_CLOUD_STORAGE.md Х4, Х9.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::state::{AppState, CommandError};
use crate::storage::media_refs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum IcloudDownloadStatus {
    /// Contents are on this Mac; the percent is trivially 100.
    Current,
    /// The system is bringing the contents down right now.
    Downloading,
    /// Evicted and no download in flight.
    NotDownloaded,
    /// The file is not managed by iCloud at all.
    NotManaged,
    /// The metadata gave no answer within the helper's deadline. The caller
    /// keeps its numberless indicator — an honest "unknown" over a stale bar.
    Unknown,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct IcloudDownloadProgress {
    pub status: IcloudDownloadStatus,
    /// 0–100 when the metadata reports one. Never invented.
    pub percent: Option<f64>,
}

const UNKNOWN: IcloudDownloadProgress = IcloudDownloadProgress {
    status: IcloudDownloadStatus::Unknown,
    percent: None,
};

/// Poll the download state of a card's media file.
///
/// `media_ref` is whatever the card carries — a vault-relative path or a bare
/// basename — resolved with the same rules the asset protocol uses, so the
/// probe watches the same file the card paints.
#[tauri::command]
pub fn icloud_download_progress(
    app: AppHandle,
    state: State<'_, AppState>,
    media_ref: String,
) -> Result<IcloudDownloadProgress, CommandError> {
    let vault_root = {
        let vault_state = state
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
        vs.vault.root().to_path_buf()
    };

    let Some(path) = resolve_media_path(&vault_root, &media_ref) else {
        // A missing file has no download to report; the card's own
        // missing-media state covers it.
        return Ok(UNKNOWN);
    };

    let helper = resolve_helper_path(&app)?;
    let output = Command::new(&helper)
        .arg(&path)
        .output()
        .map_err(|error| {
            CommandError::Internal(format!(
                "failed to run the iCloud progress helper at {}: {error}",
                helper.display()
            ))
        })?;
    if !output.status.success() {
        return Ok(UNKNOWN);
    }

    Ok(parse_helper_output(&output.stdout))
}

/// Resolve a media reference to a real file inside the vault, or nothing.
///
/// The reference crosses the IPC boundary, so it is treated as untrusted:
/// no absolute paths, no `..`, and the resolved file must live under the
/// vault root even after the basename fallback.
fn resolve_media_path(vault_root: &std::path::Path, media_ref: &str) -> Option<PathBuf> {
    let trimmed = media_ref.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = std::path::Path::new(trimmed);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return None;
    }

    let direct = vault_root.join(candidate);
    let resolved = if direct.is_file() {
        direct
    } else {
        let file_name = candidate.file_name()?.to_str()?;
        media_refs::resolve_basename_under(vault_root, file_name)?
    };

    let canonical = resolved.canonicalize().ok()?;
    let canonical_root = vault_root.canonicalize().ok()?;
    canonical.starts_with(&canonical_root).then_some(canonical)
}

/// The helper travels as a bundle resource, like yt-dlp; in development it
/// sits in `binaries/` where the build script put it.
fn resolve_helper_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("binaries").join("icloud-progress-helper"));
        candidates.push(resource_dir.join("icloud-progress-helper"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("icloud-progress-helper"),
    );
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            CommandError::Internal(
                "iCloud progress helper binary not found in expected runtime locations".into(),
            )
        })
}

fn parse_helper_output(stdout: &[u8]) -> IcloudDownloadProgress {
    #[derive(serde::Deserialize)]
    struct HelperOutput {
        status: String,
        // Swift's JSONEncoder omits nil fields entirely rather than writing
        // null, so absence must parse as "no percent".
        #[serde(default)]
        percent: Option<f64>,
    }
    let Ok(parsed) = serde_json::from_slice::<HelperOutput>(stdout) else {
        return UNKNOWN;
    };
    let status = match parsed.status.as_str() {
        "current" => IcloudDownloadStatus::Current,
        "downloading" => IcloudDownloadStatus::Downloading,
        "not_downloaded" => IcloudDownloadStatus::NotDownloaded,
        "not_managed" => IcloudDownloadStatus::NotManaged,
        _ => IcloudDownloadStatus::Unknown,
    };
    IcloudDownloadProgress {
        status,
        percent: parsed.percent.map(|p| p.clamp(0.0, 100.0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_output_maps_statuses_and_clamps_percent() {
        let parsed = parse_helper_output(br#"{"status":"downloading","percent":41.7}"#);
        assert_eq!(parsed.status, IcloudDownloadStatus::Downloading);
        assert_eq!(parsed.percent, Some(41.7));

        let clamped = parse_helper_output(br#"{"status":"downloading","percent":250.0}"#);
        assert_eq!(clamped.percent, Some(100.0));

        let unknown = parse_helper_output(b"not json at all");
        assert_eq!(unknown.status, IcloudDownloadStatus::Unknown);
        assert_eq!(unknown.percent, None);

        let alien = parse_helper_output(br#"{"status":"weird","percent":null}"#);
        assert_eq!(alien.status, IcloudDownloadStatus::Unknown);

        // Swift omits nil fields; absence is "no percent", not a parse error.
        let omitted = parse_helper_output(br#"{"status":"not_managed"}"#);
        assert_eq!(omitted.status, IcloudDownloadStatus::NotManaged);
        assert_eq!(omitted.percent, None);
    }

    #[test]
    fn media_ref_cannot_leave_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Media")).unwrap();
        std::fs::write(root.join("Media").join("photo.jpg"), b"x").unwrap();

        // A bare basename resolves through the same fallback the assets use.
        let resolved = resolve_media_path(root, "photo.jpg").expect("basename resolves");
        assert!(resolved.ends_with("Media/photo.jpg"));

        // A relative path resolves directly.
        assert!(resolve_media_path(root, "Media/photo.jpg").is_some());

        // Escapes and absolute paths do not resolve at all.
        assert!(resolve_media_path(root, "../photo.jpg").is_none());
        assert!(resolve_media_path(root, "/etc/passwd").is_none());
        assert!(resolve_media_path(root, "").is_none());
        assert!(resolve_media_path(root, "Media/../../photo.jpg").is_none());
    }
}
