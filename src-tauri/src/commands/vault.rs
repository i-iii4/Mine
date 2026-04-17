// Vault commands: select vault folder, trigger scan.
//
// Persists the selected vault path in the app data directory
// so the vault is automatically restored on next launch.
//
// Contract: SPEC_INTEGRATION.md#commands/vault

use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

use rusqlite::Connection;
use serde::Serialize;

use crate::commands::state::{AppState, CommandError, VaultState};
use crate::domain::vault::VaultLayout;
use crate::storage::db;
use crate::storage::index;
use crate::util::{append_startup_trace, reset_startup_trace};
use crate::watcher::handler::{self, ScanResult};
use crate::watcher::watch;

#[derive(Debug, Clone, Serialize)]
pub struct VaultOpenResult {
    pub indexed: usize,
    pub errors: usize,
    pub sync_in_progress: bool,
}

#[derive(Debug, Clone, Serialize)]
struct VaultChangedPayload {
    path: String,
}

#[derive(Debug, Clone, Serialize)]
struct VaultSyncStartedPayload {
    path: String,
}

#[derive(Debug, Clone, Serialize)]
struct VaultSyncFinishedPayload {
    path: String,
    indexed: usize,
    errors: usize,
    error: Option<String>,
}

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
) -> Result<VaultOpenResult, CommandError> {
    append_startup_trace(&app, "select_vault", &format!("start path={path}"));
    let result = initialize_vault(&app, &state, &path)?;
    save_vault_path(&app, &path);
    append_startup_trace(
        &app,
        "select_vault",
        &format!("done path={} indexed={}", path, result.indexed),
    );
    Ok(result)
}

/// Open a vault snapshot without mutating persisted config.
#[tauri::command]
pub fn open_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<VaultOpenResult, CommandError> {
    append_startup_trace(&app, "open_vault", &format!("start path={path}"));
    let started = Instant::now();
    let result = initialize_vault(&app, &state, &path);
    match &result {
        Ok(open) => append_startup_trace(
            &app,
            "open_vault",
            &format!("done path={} indexed={} elapsed_ms={}", path, open.indexed, started.elapsed().as_millis()),
        ),
        Err(err) => append_startup_trace(
            &app,
            "open_vault",
            &format!("error path={} elapsed_ms={} err={}", path, started.elapsed().as_millis(), err),
        ),
    }
    result
}

/// Get the current vault path, or None if no vault is selected.
///
/// If the in-memory state is empty (fresh launch), returns the persisted
/// path if it still exists. Actual vault initialization is performed by
/// a follow-up `open_vault` / `select_vault` call after the first paint,
/// so app startup never blocks on restore-path side effects.
#[tauri::command]
pub fn get_vault_path(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    reset_startup_trace(&app);
    append_startup_trace(&app, "get_vault_path", "start");
    // Check in-memory state first
    {
        let vault_state = state.vault_state.lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        if let Some(ref vs) = *vault_state {
            let path = vs.vault.root().to_string_lossy().to_string();
            append_startup_trace(&app, "get_vault_path", &format!("from_memory path={path}"));
            return Ok(Some(path));
        }
    }

    // Try to restore from saved config
    if let Some(saved_path) = load_saved_vault_path(&app) {
        if PathBuf::from(&saved_path).is_dir() {
            append_startup_trace(&app, "get_vault_path", &format!("from_config path={saved_path}"));
            return Ok(Some(saved_path));
        } else {
            log::info!("saved vault no longer exists: {}", saved_path);
            append_startup_trace(&app, "get_vault_path", &format!("stale_config path={saved_path}"));
            clear_saved_vault_path(&app);
        }
    }

    append_startup_trace(&app, "get_vault_path", "none");
    Ok(None)
}

/// Start a background sync for the currently opened vault.
/// Returns true if a new sync was started, false if one is already running.
#[tauri::command]
pub fn start_vault_sync(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let path = {
        let vault_state = state.vault_state.lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
        vs.vault.root().to_string_lossy().into_owned()
    };

    start_background_sync(app, path)
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
    let result = handler::full_scan(
        &vs.conn,
        &vs.vault,
        Some(thumbs_done_cb(
            app.clone(),
            vs.vault.root().to_string_lossy().into_owned(),
        )),
        Some(app.clone()),
    )?;

    log::info!(
        "index rebuilt: {} indexed, {} errors",
        result.indexed,
        result.errors
    );

    Ok(result)
}

// ─── Shared initialization ──────────────────────────────────────────────────

/// Initialize a vault: expand asset scope, create dirs, open DB and restore snapshot.
fn initialize_vault(
    app: &AppHandle,
    state: &AppState,
    path: &str,
) -> Result<VaultOpenResult, CommandError> {
    let total = Instant::now();
    append_startup_trace(app, "initialize_vault", &format!("start path={path}"));
    let mut vault_state = state.vault_state.lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    if let Some(ref vs) = *vault_state {
        if vs.vault.root() == Path::new(path) {
            let indexed = count_indexed_blocks(&vs.conn)?;
            append_startup_trace(app, "initialize_vault", &format!("reuse_existing path={} indexed={} elapsed_ms={}", path, indexed, total.elapsed().as_millis()));
            return Ok(VaultOpenResult {
                indexed,
                errors: 0,
                sync_in_progress: false,
            });
        }
    }

    let vault = VaultLayout::new(PathBuf::from(path));
    append_startup_trace(app, "initialize_vault", &format!("mkdir thumbs={}", vault.thumbs_dir().display()));

    // Create .arena directories
    std::fs::create_dir_all(vault.thumbs_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create dirs: {e}")))?;

    // Expand asset protocol scope for the flat vault root plus thumbnail cache.
    // The vault is intentionally flat; recursive scope over the whole vault
    // needlessly walks every file on startup and blocks restore-path UX.
    app.asset_protocol_scope()
        .allow_directory(vault.root(), false)
        .map_err(|e| CommandError::Internal(format!("failed to allow vault root: {e}")))?;
    append_startup_trace(app, "initialize_vault", &format!("asset_scope root elapsed_ms={}", total.elapsed().as_millis()));
    app.asset_protocol_scope()
        .allow_directory(vault.thumbs_dir(), false)
        .map_err(|e| CommandError::Internal(format!("failed to allow thumbs dir: {e}")))?;
    append_startup_trace(app, "initialize_vault", &format!("asset_scope thumbs elapsed_ms={}", total.elapsed().as_millis()));

    // Open or create database
    let db_started = Instant::now();
    let conn = db::open_or_create(&vault.index_db_path())?;
    let indexed = count_indexed_blocks(&conn)?;
    append_startup_trace(app, "initialize_vault", &format!("db_open indexed={} elapsed_ms={}", indexed, db_started.elapsed().as_millis()));

    // One-time thumb cache migration: when the format version marker is
    // absent or outdated, wipe all cached thumbnails so full_scan
    // regenerates them from scratch with the current pipeline. Covers
    // legacy JPEG text placeholders, wrong-format thumbs from old code,
    // and any other stale cache state. The marker is written after the
    // wipe so subsequent starts skip this step.
    migrate_thumb_cache(&vault);
    append_startup_trace(app, "initialize_vault", &format!("thumb_cache_migrated elapsed_ms={}", total.elapsed().as_millis()));

    // Start file watcher
    let db_path = vault.index_db_path();
    let watcher_started = Instant::now();
    match watch::start_watching(app, &vault, &db_path) {
        Ok(w) => {
            let mut watcher = state.watcher.lock()
                .map_err(|_| CommandError::Internal("watcher mutex poisoned".into()))?;
            *watcher = Some(w);
            append_startup_trace(app, "initialize_vault", &format!("watcher_started elapsed_ms={}", watcher_started.elapsed().as_millis()));
        }
        Err(e) => {
            log::warn!("failed to start file watcher: {e:#}");
            append_startup_trace(app, "initialize_vault", &format!("watcher_failed elapsed_ms={} err={:#}", watcher_started.elapsed().as_millis(), e));
        }
    }

    *vault_state = Some(VaultState { conn, vault });
    append_startup_trace(app, "initialize_vault", &format!("done path={} indexed={} total_elapsed_ms={}", path, indexed, total.elapsed().as_millis()));

    start_thumb_metadata_backfill(app.clone(), path.to_string());

    Ok(VaultOpenResult {
        indexed,
        errors: 0,
        sync_in_progress: false,
    })
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

/// Legacy vaults may have thumbnail files on disk but no DB metadata yet.
/// Backfill `thumb_format` / `thumb_mtime` in the background so sidebar
/// previews start working again without blocking startup.
fn start_thumb_metadata_backfill(app: AppHandle, path: String) {
    let app_for_thread = app.clone();
    let path_for_thread = path.clone();
    let _ = std::thread::Builder::new()
        .name(format!("thumb-meta-backfill-{}", path))
        .spawn(move || {
            let vault = VaultLayout::new(PathBuf::from(&path_for_thread));
            let conn = match db::open_or_create(&vault.index_db_path()) {
                Ok(conn) => conn,
                Err(err) => {
                    log::warn!("thumb metadata backfill db open failed for {}: {:#}", path_for_thread, err);
                    append_startup_trace(&app_for_thread, "thumb_metadata_backfill", &format!("db_open_failed path={} err={:#}", path_for_thread, err));
                    return;
                }
            };

            match index::backfill_missing_thumb_metadata(&conn, &vault) {
                Ok(0) => {
                    append_startup_trace(&app_for_thread, "thumb_metadata_backfill", &format!("noop path={}", path_for_thread));
                }
                Ok(updated) => {
                    log::info!("thumb metadata backfill: {} row(s) updated for {}", updated, path_for_thread);
                    append_startup_trace(&app_for_thread, "thumb_metadata_backfill", &format!("updated path={} rows={}", path_for_thread, updated));
                    let _ = app_for_thread.emit("vault-changed", VaultChangedPayload {
                        path: path_for_thread.clone(),
                    });
                }
                Err(err) => {
                    log::warn!("thumb metadata backfill failed for {}: {:#}", path_for_thread, err);
                    append_startup_trace(&app_for_thread, "thumb_metadata_backfill", &format!("failed path={} err={:#}", path_for_thread, err));
                }
            }
        });
}

/// Create a callback that emits "vault-changed" when background thumbnails finish.
fn thumbs_done_cb(app: AppHandle, path: String) -> Box<dyn FnOnce() + Send> {
    Box::new(move || {
        log::info!("background thumbnails done, notifying frontend");
        let _ = app.emit("vault-changed", VaultChangedPayload { path });
    })
}

fn start_background_sync(app: AppHandle, path: String) -> Result<bool, CommandError> {
    append_startup_trace(&app, "start_vault_sync", &format!("request path={path}"));
    {
        let app_state = app.state::<AppState>();
        let mut syncing = app_state.syncing_vaults.lock()
            .map_err(|_| CommandError::Internal("syncing_vaults mutex poisoned".into()))?;
        if !syncing.insert(path.clone()) {
            append_startup_trace(&app, "start_vault_sync", &format!("already_running path={path}"));
            return Ok(false);
        }
    }

    let sync_path = path.clone();
    let app_for_thread = app.clone();
    let path_for_thread = path.clone();
    match std::thread::Builder::new()
        .name(format!("vault-sync-{}", sync_path))
        .spawn(move || {
            let total = Instant::now();
            let vault = VaultLayout::new(PathBuf::from(&path_for_thread));
            let _ = app_for_thread.emit(
                "vault-sync-started",
                VaultSyncStartedPayload {
                    path: path_for_thread.clone(),
                },
            );
            append_startup_trace(&app_for_thread, "vault_sync_thread", &format!("start path={}", path_for_thread));

            let conn = match db::open_or_create(&vault.index_db_path()) {
                Ok(conn) => conn,
                Err(err) => {
                    log::error!("failed to open db for sync {}: {:#}", path_for_thread, err);
                    append_startup_trace(&app_for_thread, "vault_sync_thread", &format!("db_open_failed path={} err={:#}", path_for_thread, err));
                    let _ = app_for_thread.emit(
                        "vault-sync-finished",
                        VaultSyncFinishedPayload {
                            path: path_for_thread.clone(),
                            indexed: 0,
                            errors: 0,
                            error: Some(format!("{:#}", err)),
                        },
                    );
                    if let Ok(mut syncing) = app_for_thread.state::<AppState>().syncing_vaults.lock() {
                        syncing.remove(&path_for_thread);
                    }
                    return;
                }
            };

            let result = handler::full_scan(
                &conn,
                &vault,
                Some(thumbs_done_cb(app_for_thread.clone(), path_for_thread.clone())),
                Some(app_for_thread.clone()),
            );

            match result {
                Ok(scan) => {
                    migrate_channels_to_files(&conn, &vault);
                    append_startup_trace(&app_for_thread, "vault_sync_thread", &format!("done path={} indexed={} errors={} elapsed_ms={}", path_for_thread, scan.indexed, scan.errors, total.elapsed().as_millis()));
                    let _ = app_for_thread.emit(
                        "vault-sync-finished",
                        VaultSyncFinishedPayload {
                            path: path_for_thread.clone(),
                            indexed: scan.indexed,
                            errors: scan.errors,
                            error: None,
                        },
                    );
                }
                Err(err) => {
                    log::error!("background vault sync failed for {}: {:#}", path_for_thread, err);
                    append_startup_trace(&app_for_thread, "vault_sync_thread", &format!("failed path={} elapsed_ms={} err={:#}", path_for_thread, total.elapsed().as_millis(), err));
                    let _ = app_for_thread.emit(
                        "vault-sync-finished",
                        VaultSyncFinishedPayload {
                            path: path_for_thread.clone(),
                            indexed: 0,
                            errors: 0,
                            error: Some(format!("{:#}", err)),
                        },
                    );
                }
            }

            if let Ok(mut syncing) = app_for_thread.state::<AppState>().syncing_vaults.lock() {
                syncing.remove(&path_for_thread);
            }
        })
    {
        Ok(_handle) => Ok(true),
        Err(err) => {
            if let Ok(mut syncing) = app.state::<AppState>().syncing_vaults.lock() {
                syncing.remove(&path);
            }
            Err(CommandError::Internal(format!("failed to spawn vault sync thread: {err}")))
        }
    }
}

fn count_indexed_blocks(conn: &Connection) -> Result<usize, CommandError> {
    let count: i64 = conn
        .query_row("SELECT count(*) FROM blocks", [], |row| row.get(0))
        .map_err(|e| CommandError::Internal(format!("failed to count indexed blocks: {e}")))?;
    Ok(count as usize)
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
