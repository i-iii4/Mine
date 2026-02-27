// Vault commands: select vault folder, trigger scan.
//
// Persists the selected vault path in the app data directory
// so the vault is automatically restored on next launch.
//
// Contract: SPEC_INTEGRATION.md#commands/vault

use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::commands::state::{AppState, CommandError, VaultState};
use crate::domain::vault::VaultLayout;
use crate::storage::db;
use crate::watcher::handler::{self, ScanResult};
use crate::watcher::watch;

// ─── Commands ───────────────────────────────────────────────────────────────

/// Select a vault directory: open/create DB, create directories, full scan.
/// Persists the path so next launch auto-restores.
#[tauri::command]
pub fn select_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ScanResult, CommandError> {
    let result = initialize_vault(&app, &state, &path)?;
    save_vault_path(&app, &path);
    Ok(result)
}

/// Get the current vault path, or None if no vault is selected.
///
/// If the in-memory state is empty (fresh launch), tries to restore
/// from the persisted config. If the saved directory still exists,
/// performs a full initialization (DB open + scan) transparently.
#[tauri::command]
pub fn get_vault_path(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    // Check in-memory state first
    {
        let vault_state = state.vault_state.lock().unwrap();
        if let Some(ref vs) = *vault_state {
            return Ok(Some(vs.vault.root().to_string_lossy().to_string()));
        }
    }

    // Try to restore from saved config
    if let Some(saved_path) = load_saved_vault_path(&app) {
        if PathBuf::from(&saved_path).is_dir() {
            match initialize_vault(&app, &state, &saved_path) {
                Ok(_) => return Ok(Some(saved_path)),
                Err(e) => {
                    log::warn!("failed to restore vault {}: {}", saved_path, e);
                    // Clear invalid saved path
                    clear_saved_vault_path(&app);
                }
            }
        } else {
            log::info!("saved vault no longer exists: {}", saved_path);
            clear_saved_vault_path(&app);
        }
    }

    Ok(None)
}

// ─── Shared initialization ──────────────────────────────────────────────────

/// Initialize a vault: expand asset scope, create dirs, open DB, full scan.
fn initialize_vault(
    app: &AppHandle,
    state: &AppState,
    path: &str,
) -> Result<ScanResult, CommandError> {
    let vault = VaultLayout::new(PathBuf::from(path));

    // Expand asset protocol scope so the WebView can load images from vault
    app.asset_protocol_scope()
        .allow_directory(vault.root(), true)
        .map_err(|e| CommandError::Internal(format!("failed to expand asset scope: {e}")))?;

    // Create .arena directories
    std::fs::create_dir_all(vault.thumbs_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create dirs: {e}")))?;

    // Open or create database
    let conn = db::open_or_create(&vault.index_db_path())?;

    // Full scan
    let result = handler::full_scan(&conn, &vault)?;

    // Start file watcher
    let db_path = vault.index_db_path();
    match watch::start_watching(app, &vault, &db_path) {
        Ok(w) => {
            let mut watcher = state.watcher.lock().unwrap();
            *watcher = Some(w);
        }
        Err(e) => {
            log::warn!("failed to start file watcher: {e:#}");
        }
    }

    // Update app state
    let mut vault_state = state.vault_state.lock().unwrap();
    *vault_state = Some(VaultState { conn, vault });

    Ok(result)
}

// ─── Config persistence ─────────────────────────────────────────────────────

/// Path to the app config file: <app_data_dir>/config.json
fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("config.json"))
}

/// Save the vault path to the config file.
fn save_vault_path(app: &AppHandle, path: &str) {
    let Some(config) = config_path(app) else { return };

    if let Some(parent) = config.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let json = serde_json::json!({ "vault_path": path });
    if let Err(e) = std::fs::write(&config, json.to_string()) {
        log::warn!("failed to save config: {e}");
    }
}

/// Load the saved vault path from the config file.
fn load_saved_vault_path(app: &AppHandle) -> Option<String> {
    let config = config_path(app)?;
    let data = std::fs::read_to_string(&config).ok()?;
    let json: serde_json::Value = serde_json::from_str(&data).ok()?;
    json.get("vault_path")?.as_str().map(|s| s.to_string())
}

/// Remove the saved vault path (directory no longer valid).
fn clear_saved_vault_path(app: &AppHandle) {
    if let Some(config) = config_path(app) {
        let _ = std::fs::remove_file(&config);
    }
}
