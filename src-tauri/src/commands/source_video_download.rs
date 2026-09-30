//! Download Media for a card's source video: start, cancel, status.
use super::state::CommandError;
use crate::source_video_download::{DownloadState, SourceVideoDownloads};

#[tauri::command]
pub fn start_source_video_download(
    app: tauri::AppHandle,
    downloads: tauri::State<'_, SourceVideoDownloads>,
    slug: String,
    source_url: String,
) -> Result<(), CommandError> {
    downloads.start(&app, slug, &source_url).map_err(CommandError::Internal)
}

#[tauri::command]
pub fn cancel_source_video_download(
    app: tauri::AppHandle,
    downloads: tauri::State<'_, SourceVideoDownloads>,
    slug: String,
) {
    downloads.cancel(&app, &slug);
}

#[tauri::command]
pub fn source_video_download_status(
    app: tauri::AppHandle,
    downloads: tauri::State<'_, SourceVideoDownloads>,
    slug: String,
) -> Option<DownloadState> {
    downloads.status(&app, &slug)
}
