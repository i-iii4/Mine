//! Download Media for a card's source video: start, cancel, status.
use super::state::{tab_layout, AppState, CommandError};
use crate::source_video_download::{DownloadState, SourceVideoDownloads};

#[tauri::command]
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

#[tauri::command]
pub fn cancel_source_video_download(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    downloads: tauri::State<'_, SourceVideoDownloads>,
    slug: String,
) {
    if let Ok(vault) = tab_layout(&state, &webview) {
        downloads.cancel(&vault, &slug);
    }
}

#[tauri::command]
pub fn source_video_download_status(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    downloads: tauri::State<'_, SourceVideoDownloads>,
    slug: String,
) -> Option<DownloadState> {
    let vault = tab_layout(&state, &webview).ok()?;
    downloads.status(&vault, &slug)
}
