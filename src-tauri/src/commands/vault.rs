// Vault commands: select vault folder, trigger scan.
//
// Contract: SPEC_INTEGRATION.md#commands/vault

use std::path::PathBuf;
use tauri::State;

use crate::commands::state::{AppState, CommandError, VaultState};
use crate::domain::vault::VaultLayout;
use crate::storage::db;
use crate::watcher::handler::{self, ScanResult};

// ─── Commands ───────────────────────────────────────────────────────────────

/// Select a vault directory: open/create DB, create directories, full scan.
#[tauri::command]
pub fn select_vault(
    state: State<'_, AppState>,
    path: String,
) -> Result<ScanResult, CommandError> {
    let vault = VaultLayout::new(PathBuf::from(&path));

    // Create .arena directories
    std::fs::create_dir_all(vault.thumbs_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create dirs: {}", e)))?;

    // Open or create database
    let conn = db::open_or_create(&vault.index_db_path())?;

    // Full scan
    let result = handler::full_scan(&conn, &vault)?;

    // Update app state
    let mut vault_state = state.vault_state.lock().unwrap();
    *vault_state = Some(VaultState { conn, vault });

    Ok(result)
}

/// Get the current vault path, or None if no vault is selected.
#[tauri::command]
pub fn get_vault_path(state: State<'_, AppState>) -> Result<Option<String>, CommandError> {
    let vault_state = state.vault_state.lock().unwrap();
    Ok(vault_state
        .as_ref()
        .map(|vs| vs.vault.root().to_string_lossy().to_string()))
}
