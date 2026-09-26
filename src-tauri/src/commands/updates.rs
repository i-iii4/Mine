//! Thin IPC adapters for the configured production updater.
use crate::updater::{self, UpdateError, UpdateStatus};
use tauri::AppHandle;

#[tauri::command]
pub async fn get_update_status(app: AppHandle) -> Result<UpdateStatus, UpdateError> {
    updater::status(&app).await
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateStatus, UpdateError> {
    updater::check(&app).await
}

#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<UpdateStatus, UpdateError> {
    updater::download(&app).await
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<UpdateStatus, UpdateError> {
    updater::install(&app).await
}

#[tauri::command]
pub async fn restore_previous_update(app: AppHandle) -> Result<UpdateStatus, UpdateError> {
    updater::restore(&app).await
}
