// Vault commands: select vault folder, trigger scan.
//
// Persists the selected vault path in the app data directory
// so the vault is automatically restored on next launch.
//
// Contract: SPEC_INTEGRATION.md#commands/vault

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

use rusqlite::Connection;

use crate::commands::state::{AppState, CommandError, VaultState};
use crate::domain::vault::VaultLayout;
use crate::storage::db;
use crate::watcher::handler::{self, ScanResult};
use crate::watcher::watch;

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all known vault paths (directories that still exist on disk).
#[tauri::command]
pub fn list_known_vaults(app: AppHandle) -> Vec<String> {
    load_known_vaults(&app)
}

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
        let vault_state = state.vault_state.lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
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

/// Rebuild the index from scratch: drop all indexed data, re-scan vault files.
/// Use when the index is corrupted or out of sync with the filesystem.
#[tauri::command]
pub fn rebuild_index(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, CommandError> {
    let vault_state = state.vault_state.lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    // Clear all indexed data
    vs.conn
        .execute_batch(
            "DELETE FROM block_tags;
             DELETE FROM wikilinks;
             DELETE FROM blocks;
             DELETE FROM channels;",
        )
        .map_err(|e| CommandError::Internal(format!("failed to clear index: {e}")))?;

    // Re-scan vault files
    let result = handler::full_scan(&vs.conn, &vs.vault, Some(thumbs_done_cb(app.clone())), Some(app.clone()))?;

    log::info!(
        "index rebuilt: {} indexed, {} errors",
        result.indexed,
        result.errors
    );

    Ok(result)
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

    // One-time thumb cache migration: when the format version marker is
    // absent or outdated, wipe all cached thumbnails so full_scan
    // regenerates them from scratch with the current pipeline. Covers
    // legacy JPEG text placeholders, wrong-format thumbs from old code,
    // and any other stale cache state. The marker is written after the
    // wipe so subsequent starts skip this step.
    migrate_thumb_cache(&vault);

    // Full scan (thumbnails generated in background thread)
    let result = handler::full_scan(&conn, &vault, Some(thumbs_done_cb(app.clone())), Some(app.clone()))?;

    // Migrate channels from SQLite to .md files (one-time)
    migrate_channels_to_files(&conn, &vault);

    // Start file watcher
    let db_path = vault.index_db_path();
    match watch::start_watching(app, &vault, &db_path) {
        Ok(w) => {
            let mut watcher = state.watcher.lock()
                .map_err(|_| CommandError::Internal("watcher mutex poisoned".into()))?;
            *watcher = Some(w);
        }
        Err(e) => {
            log::warn!("failed to start file watcher: {e:#}");
        }
    }

    // Update app state
    let mut vault_state = state.vault_state.lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    *vault_state = Some(VaultState { conn, vault });

    Ok(result)
}

/// Current thumb cache format version. Bump this when the thumbnail
/// pipeline changes in a way that makes old cached files incompatible
/// (e.g. text placeholders switched from JPEG to PNG, or new font).
const THUMB_FORMAT_VERSION: &str = "3";

/// If the thumb cache was written by an older format version, delete
/// all cached thumbnails and let full_scan regenerate them fresh.
fn migrate_thumb_cache(vault: &VaultLayout) {
    let marker = vault.thumbs_dir().join(".format-version");
    let current = std::fs::read_to_string(&marker).unwrap_or_default();
    if current.trim() == THUMB_FORMAT_VERSION {
        return;
    }

    log::info!(
        "thumb cache migration: version {:?} → {}, clearing all thumbnails",
        current.trim(),
        THUMB_FORMAT_VERSION,
    );

    // Delete all .jpg files in thumbs dir. Keep the directory itself
    // and any non-.jpg files (like the marker we're about to write).
    if let Ok(entries) = std::fs::read_dir(vault.thumbs_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jpg") {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    // Write the new version marker. If this fails, next startup will
    // re-run the migration — safe, just slightly wasteful.
    let _ = std::fs::write(&marker, THUMB_FORMAT_VERSION);
}

/// Create a callback that emits "vault-changed" when background thumbnails finish.
fn thumbs_done_cb(app: AppHandle) -> Box<dyn FnOnce() + Send> {
    Box::new(move || {
        log::info!("background thumbnails done, notifying frontend");
        let _ = app.emit("vault-changed", ());
    })
}

// ─── Channel migration ──────────────────────────────────────────────────────

/// One-time migration: create .md files for channels that only exist in SQLite.
/// After this, channels are read from .md files (type: channel) during full_scan.
fn migrate_channels_to_files(conn: &Connection, vault: &VaultLayout) {
    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::storage::{files, index};

    let channels = match index::list_channels(conn) {
        Ok(ch) => ch,
        Err(_) => return,
    };

    for ch in channels {
        let md_path = vault.block_path(&ch.tag);
        if md_path.exists() {
            continue; // Already migrated
        }

        let block = Block {
            slug: ch.tag.clone(),
            frontmatter: Frontmatter {
                block_type: BlockType::Channel,
                title: Some(ch.title),
                description: ch.description,
                url: None,
                file: None,
                thumbnail: None,
                tags: Vec::new(),
                saved_at: ch.created_at,
                source: None,
                width: None,
                height: None,
                author: None,
                position: Some(ch.position),
                color: ch.color,
                icon: ch.icon,
            },
            body: String::new(),
        };

        if let Err(e) = files::write_block_file(vault, &block) {
            log::warn!("failed to migrate channel '{}' to file: {e:#}", ch.tag);
        }
    }
}

// ─── Config persistence ─────────────────────────────────────────────────────

/// Path to the app config file: <app_data_dir>/config.json
fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("config.json"))
}

/// Load the full config JSON, or empty object if missing.
fn load_config(app: &AppHandle) -> serde_json::Value {
    let Some(config) = config_path(app) else {
        return serde_json::json!({});
    };
    let Ok(data) = std::fs::read_to_string(&config) else {
        return serde_json::json!({});
    };
    serde_json::from_str(&data).unwrap_or_else(|_| serde_json::json!({}))
}

/// Write the full config JSON to disk.
fn write_config(app: &AppHandle, json: &serde_json::Value) {
    let Some(config) = config_path(app) else { return };
    if let Some(parent) = config.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&config, serde_json::to_string_pretty(json).unwrap_or_default()) {
        log::warn!("failed to save config: {e}");
    }
}

/// Save the vault path to the config file and add to known_vaults.
fn save_vault_path(app: &AppHandle, path: &str) {
    let mut cfg = load_config(app);
    cfg["vault_path"] = serde_json::json!(path);

    // Add to known_vaults if not already there
    let known = cfg["known_vaults"].as_array_mut();
    let path_val = serde_json::json!(path);
    if let Some(arr) = known {
        if !arr.contains(&path_val) {
            arr.push(path_val);
        }
    } else {
        cfg["known_vaults"] = serde_json::json!([path]);
    }

    write_config(app, &cfg);
}

/// Load the saved vault path from the config file.
fn load_saved_vault_path(app: &AppHandle) -> Option<String> {
    let cfg = load_config(app);
    cfg.get("vault_path")?.as_str().map(|s| s.to_string())
}

/// Load known vaults, filtering out directories that no longer exist.
fn load_known_vaults(app: &AppHandle) -> Vec<String> {
    let cfg = load_config(app);
    let Some(arr) = cfg.get("known_vaults").and_then(|v| v.as_array()) else {
        // Fallback: if no known_vaults, use current vault_path
        return cfg.get("vault_path")
            .and_then(|v| v.as_str())
            .filter(|p| PathBuf::from(p).is_dir())
            .map(|s| vec![s.to_string()])
            .unwrap_or_default();
    };
    arr.iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .filter(|p| PathBuf::from(p).is_dir())
        .collect()
}

/// Remove the saved vault path (directory no longer valid).
fn clear_saved_vault_path(app: &AppHandle) {
    if let Some(config) = config_path(app) {
        let _ = std::fs::remove_file(&config);
    }
}
