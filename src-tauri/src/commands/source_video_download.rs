//! Download Media for a card's source video: start, cancel, status.
//!
//! Each command waits for the space's lock through `tab_layout`, so none runs
//! on the main thread (SPEC_INTEGRATION.md, «Команды записи вне главного
//! потока»).
use super::state::{tab_layout, AppState, CommandError};
use crate::source_video_download::{DownloadState, SourceVideoDownloads};

#[tauri::command(async)]
pub fn start_source_video_download(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    downloads: tauri::State<'_, SourceVideoDownloads>,
    slug: String,
    source_url: String,
) -> Result<(), CommandError> {
    let vault = tab_layout(&state, &webview)?;
    downloads
        .start(&app, vault, slug, &source_url)
        .map_err(CommandError::Internal)
}

/// Cancel the card's download. A tab without a space has nothing to cancel.
#[tauri::command(async)]
pub fn cancel_source_video_download(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    downloads: tauri::State<'_, SourceVideoDownloads>,
    slug: String,
) -> Result<(), CommandError> {
    if let Ok(vault) = tab_layout(&state, &webview) {
        downloads.cancel(&vault, &slug);
    }
    Ok(())
}

/// The last known state of the card's download; none without a space or a
/// download in this session.
#[tauri::command(async)]
pub fn source_video_download_status(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    downloads: tauri::State<'_, SourceVideoDownloads>,
    slug: String,
) -> Result<Option<DownloadState>, CommandError> {
    let Ok(vault) = tab_layout(&state, &webview) else {
        return Ok(None);
    };
    Ok(downloads.status(&vault, &slug))
}
