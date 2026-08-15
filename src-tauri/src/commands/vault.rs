// Vault commands: select vault folder, trigger scan.
//
// Persists the selected vault path in the app data directory
// so the vault is automatically restored on next launch.
//
// Contract: SPEC_INTEGRATION.md#commands/vault

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

use rusqlite::Connection;
use serde::Serialize;

use crate::commands::state::{
    current_vault_layout, schedule_preview_reconcile, AppState, CommandError, SweepGuard,
    VaultState,
};
use crate::domain::vault::{VaultLayout, VaultWriteLayout};
use crate::storage::clipper_uploads;
use crate::storage::index;
use crate::storage::search_engine;
use crate::storage::{db, files, reconcile};
use crate::util::{append_startup_trace, reset_startup_trace};
use crate::watcher::handler::{self, ScanResult};
use crate::watcher::watch;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct VaultOpenResult {
    pub indexed: usize,
    pub errors: usize,
    pub sync_in_progress: bool,
    pub derived_store_ready: bool,
    pub bootstrapped_from_legacy: bool,
    pub migration_required: bool,
    pub thumbs_root: String,
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
    // Broadcast the switch to every window: the main window re-mounts on this
    // even when the switch originated elsewhere (e.g. the settings window).
    let _ = app.emit("vault-selected", VaultChangedPayload { path: path.clone() });
    append_startup_trace(
        &app,
        "select_vault",
        &format!("done path={} indexed={}", path, result.indexed),
    );
    Ok(result)
}

/// What a folder holds, before it becomes a space.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct FolderPreview {
    pub markdown_files: usize,
    pub media_files: usize,
    pub other_files: usize,
}

/// Look inside a folder without touching it.
///
/// Choosing a folder turns everything in it into cards, recursively — pick the
/// wrong one and a whole document archive becomes a space. Counting first lets
/// the app say what is about to happen instead of just doing it.
/// See SPEC_ONBOARDING.md О12.
#[tauri::command]
pub fn preview_vault_folder(path: String) -> Result<FolderPreview, CommandError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(CommandError::Internal(format!("not a folder: {path}")));
    }

    let mut preview = FolderPreview {
        markdown_files: 0,
        media_files: 0,
        other_files: 0,
    };
    count_folder(&root, &mut preview, 0);
    Ok(preview)
}

/// Depth is bounded: this runs before the user has committed to anything, and a
/// deep tree must not make the confirmation itself feel slow.
const FOLDER_PREVIEW_MAX_DEPTH: usize = 8;

fn count_folder(dir: &Path, preview: &mut FolderPreview, depth: usize) {
    if depth > FOLDER_PREVIEW_MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if !files::is_ignored_vault_dir(&path) {
                count_folder(&path, preview, depth + 1);
            }
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        match path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_lowercase)
            .as_deref()
        {
            Some("md") => preview.markdown_files += 1,
            Some(ext) if crate::storage::preview_plan::is_image_ext(ext) => {
                preview.media_files += 1
            }
            Some(ext) if crate::storage::preview_plan::is_video_ext(ext) => {
                preview.media_files += 1
            }
            _ => preview.other_files += 1,
        }
    }
}

/// A space that is bound but not reachable right now.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct UnavailableVault {
    pub path: String,
}

/// The saved space that could not be opened, if any.
///
/// Returns `None` when there is no binding at all (a genuinely first run) or
/// when the saved space is reachable. The distinction matters: a missing folder
/// must never look like a fresh install.
#[tauri::command]
pub fn get_unavailable_vault(app: AppHandle) -> Result<Option<UnavailableVault>, CommandError> {
    let Some(saved_path) = load_saved_vault_path(&app) else {
        return Ok(None);
    };
    if PathBuf::from(&saved_path).is_dir() {
        return Ok(None);
    }
    Ok(Some(UnavailableVault { path: saved_path }))
}

/// Discard the binding to a space that is no longer wanted.
///
/// Explicit user action only: this is the single place the saved path is
/// dropped, so a folder that is merely offline is never forgotten silently.
#[tauri::command]
pub fn forget_unavailable_vault(app: AppHandle) -> Result<(), CommandError> {
    if let Some(path) = load_saved_vault_path(&app) {
        let mut cfg = load_config(&app);
        if let Some(known) = cfg.get("known_vaults").and_then(|v| v.as_array()) {
            let remaining: Vec<String> = known
                .iter()
                .filter_map(|value| value.as_str())
                .filter(|existing| *existing != path)
                .map(str::to_string)
                .collect();
            cfg["known_vaults"] = serde_json::json!(remaining);
            write_config(&app, &cfg);
        }
    }
    clear_saved_vault_path(&app);
    Ok(())
}

/// The write layout of the currently open space.
#[tauri::command]
pub fn get_vault_write_layout(
    state: State<'_, AppState>,
) -> Result<VaultWriteLayoutDto, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(VaultWriteLayoutDto::from(vs.vault.write_layout()))
}

/// Choose which folders new cards, media and collections are written into.
///
/// Existing files are never moved: this governs writes from here on. Reading
/// stays recursive, so whatever is already on disk keeps working.
#[tauri::command]
pub fn set_vault_write_layout(
    app: AppHandle,
    state: State<'_, AppState>,
    layout: VaultWriteLayoutDto,
) -> Result<VaultWriteLayoutDto, CommandError> {
    let requested = VaultWriteLayout {
        cards: layout.cards,
        media: layout.media,
        collections: layout.collections,
    }
    .validate()
    .map_err(|e| CommandError::Internal(e.to_string()))?;

    let mut vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_mut().ok_or(CommandError::NoVault)?;
    save_write_layout(&vs.vault, &requested)?;
    vs.vault = vs.vault.clone().with_write_layout(requested.clone());
    let dto = VaultWriteLayoutDto::from(&requested);
    let _ = app.emit("vault-write-layout-changed", dto.clone());
    Ok(dto)
}

/// Create the standard folders in the current space and adopt them for writes.
#[tauri::command]
pub fn organize_vault_layout(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<VaultWriteLayoutDto, CommandError> {
    let standard = VaultWriteLayout::standard();
    {
        let vault_state = state
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
        for folder in [&standard.cards, &standard.media, &standard.collections] {
            std::fs::create_dir_all(vs.vault.root().join(folder)).map_err(|e| {
                CommandError::Internal(format!("failed to create {folder}: {e}"))
            })?;
        }
    }
    set_vault_write_layout(app, state, VaultWriteLayoutDto::from(&standard))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct VaultWriteLayoutDto {
    pub cards: String,
    pub media: String,
    pub collections: String,
}

impl From<&VaultWriteLayout> for VaultWriteLayoutDto {
    fn from(value: &VaultWriteLayout) -> Self {
        Self {
            cards: value.cards.clone(),
            media: value.media.clone(),
            collections: value.collections.clone(),
        }
    }
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
            &format!(
                "done path={} indexed={} elapsed_ms={}",
                path,
                open.indexed,
                started.elapsed().as_millis()
            ),
        ),
        Err(err) => append_startup_trace(
            &app,
            "open_vault",
            &format!(
                "error path={} elapsed_ms={} err={}",
                path,
                started.elapsed().as_millis(),
                err
            ),
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
        let vault_state = state
            .vault_state
            .lock()
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
            append_startup_trace(
                &app,
                "get_vault_path",
                &format!("from_config path={saved_path}"),
            );
            return Ok(Some(saved_path));
        }
        // The folder is not there *right now* — renamed, moved, on an
        // unplugged drive, not yet synced. Forgetting it here is what made a
        // temporarily missing space indistinguishable from lost data: the app
        // came up as if it had never been opened. The binding is kept and the
        // frontend shows an explicit unavailable state instead; only the user
        // may discard it. See SPEC_VAULT_LIFECYCLE.md П12–П13.
        log::info!("saved vault is currently unavailable: {}", saved_path);
        append_startup_trace(
            &app,
            "get_vault_path",
            &format!("unavailable path={saved_path}"),
        );
        return Ok(None);
    }

    append_startup_trace(&app, "get_vault_path", "none");
    Ok(None)
}

/// Start a background sync for the currently opened vault.
/// Returns true if a new sync was started, false if one is already running.
#[tauri::command]
pub fn start_vault_sync(app: AppHandle, state: State<'_, AppState>) -> Result<bool, CommandError> {
    let path = {
        let vault_state = state
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
        vs.vault.root().to_string_lossy().into_owned()
    };

    start_background_sync(app, path)
}

/// Rebuild the index from scratch: drop all indexed data, re-scan vault files.
/// Use when the index is corrupted or out of sync with the filesystem.
#[tauri::command]
pub async fn rebuild_index(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, CommandError> {
    let vault = current_vault_layout(&state)?;
    let app_for_task = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<ScanResult, CommandError> {
            let conn = db::open_or_create(&vault.index_db_path())?;

            // Force every source through the canonical reconciler without deleting
            // the last-good projection first. A fatal or per-file failure therefore
            // preserves readable Grid/Search/Detail state and remains retryable.
            let report = rebuild_index_projection(&conn, &vault)?;
            search_engine::warm_search_index(&conn, None)?;
            let app_state = app_for_task.state::<AppState>();
            start_thumbnail_sweep(&app_for_task, &app_state, vault.clone())?;
            schedule_preview_reconcile(&app_for_task, vault, std::iter::empty::<String>(), true)?;
            Ok(ScanResult {
                indexed: report.upserted.len(),
                errors: report.errors.len(),
            })
        })
        .await
        .map_err(|error| {
            CommandError::Internal(format!("rebuild_index task join failed: {error}"))
        })??;

    log::info!(
        "index rebuilt: {} indexed, {} errors",
        result.indexed,
        result.errors
    );

    Ok(result)
}

fn rebuild_index_projection(
    conn: &Connection,
    vault: &VaultLayout,
) -> Result<reconcile::ReconcileReport, CommandError> {
    conn.execute("DELETE FROM source_index_state", [])
        .map_err(|error| {
            CommandError::Internal(format!("failed to invalidate source stamps: {error}"))
        })?;
    reconcile::reconcile_vault(conn, vault)
        .map_err(|error| CommandError::Internal(format!("failed to rebuild index: {error:#}")))
}

/// Re-verify the thumb cache against current media dependencies and
/// regenerate any stale thumbs in the background.
///
/// Called by the frontend on window focus / visibility changes so that
/// external edits to source images — including iCloud Drive syncs from
/// another device, where `notify` delivers no reliable Modify event —
/// are eventually reflected in sidebar and grid cards. The sweep is
/// cheap: it stats thumb + dependency files, reparses `.md` only to
/// construct a `Block` for `is_thumb_fresh`, and only regenerates the
/// thumbs that are actually stale. Each regeneration fires
/// `thumb:updated`, which the frontend cache-busts through rAF.
///
/// Concurrent invocations are suppressed at the command boundary via
/// `AppState::try_start_sweep`: if a sweep is already running this
/// returns `0` without starting another worker. The guard is released
/// either by the done-callback when the worker finishes or by the
/// dropped closure if spawning the worker thread failed.
#[tauri::command]
pub fn sweep_vault_thumbnails(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let vault = current_vault_layout(&state)?;
    let count = start_thumbnail_sweep(&app, &state, vault.clone())?;
    schedule_preview_reconcile(&app, vault, std::iter::empty::<String>(), true)?;
    log::info!("thumb_sweep: queued {count} blocks for freshness check");
    Ok(count)
}

/// Start the one application-wide classic thumbnail sweep for the active
/// vault. Startup sync and focus refresh share this boundary, so they cannot
/// decode the same corpus concurrently. A vault switch makes the request
/// obsolete before it can acquire the worker.
fn start_thumbnail_sweep(
    app: &AppHandle,
    state: &AppState,
    vault: VaultLayout,
) -> Result<usize, CommandError> {
    if !state.is_current_vault(vault.root()) {
        return Ok(0);
    }
    let Some(guard) = state.try_start_sweep(&vault) else {
        log::debug!("thumbnail sweep already in progress, coalescing request");
        return Ok(0);
    };

    // Open a fresh SQLite connection for the sweep so we can release the
    // AppState mutex immediately — list_blocks on the sweep's own handle
    // keeps other IPC commands responsive while the pass runs.
    let vault_root_str = vault.root().to_string_lossy().into_owned();
    let db_path = vault.index_db_path();

    let conn = db::open_or_create(&db_path)
        .map_err(|e| CommandError::Internal(format!("open sweep db: {e:#}")))?;

    // Wrap the done callback so the guard rides with the closure: when
    // the worker finishes, the closure is invoked and `guard` drops; if
    // the worker never runs (spawn failure, zero jobs), the closure is
    // dropped without firing and the guard still releases through Drop.
    let original_done = thumbs_done_cb(app.clone(), vault_root_str);
    let completion = SweepCompletion {
        app: app.clone(),
        guard: Some(guard),
    };
    let done = Box::new(move || {
        original_done();
        drop(completion);
    }) as Box<dyn FnOnce() + Send>;

    let count = handler::thumb_sweep(&conn, &vault, Some(app.clone()), Some(done))?;
    Ok(count)
}

/// Lives inside the worker completion closure. The closure may be invoked or
/// simply dropped; either path releases the running sweep and immediately
/// drains the one pending active-vault request.
struct SweepCompletion {
    app: AppHandle,
    guard: Option<SweepGuard>,
}

impl Drop for SweepCompletion {
    fn drop(&mut self) {
        self.guard.take();
        let state = self.app.state::<AppState>();
        let Some(vault) = state.take_pending_sweep() else {
            return;
        };
        if !state.is_current_vault(vault.root()) {
            return;
        }
        if let Err(error) = start_thumbnail_sweep(&self.app, &state, vault) {
            log::warn!("failed to start pending thumbnail sweep: {error}");
        }
    }
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
    let mut vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    if let Some(ref vs) = *vault_state {
        if vs.vault.root() == Path::new(path) {
            let indexed = count_indexed_blocks(&vs.conn)?;
            append_startup_trace(
                app,
                "initialize_vault",
                &format!(
                    "reuse_existing path={} indexed={} elapsed_ms={}",
                    path,
                    indexed,
                    total.elapsed().as_millis()
                ),
            );
            return Ok(VaultOpenResult {
                indexed,
                errors: 0,
                sync_in_progress: false,
                derived_store_ready: true,
                bootstrapped_from_legacy: false,
                migration_required: false,
                thumbs_root: vs.vault.thumbs_dir().to_string_lossy().into_owned(),
            });
        }
    }

    let vault = resolve_runtime_vault_layout(app, Path::new(path))?;
    append_startup_trace(
        app,
        "initialize_vault",
        &format!(
            "mkdir thumbs={} audio={}",
            vault.thumbs_dir().display(),
            vault.audio_dir().display()
        ),
    );
    let local_index_existed = vault.index_db_path().exists();
    let bootstrapped_thumbs_from_legacy = bootstrap_local_thumbs_from_legacy(&vault)?;

    // Create the synced vault metadata dir and the local derived caches.
    std::fs::create_dir_all(vault.thumbs_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create dirs: {e}")))?;
    std::fs::create_dir_all(vault.audio_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create dirs: {e}")))?;
    std::fs::create_dir_all(vault.mine_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create Mine metadata dir: {e}")))?;

    let bootstrapped_from_legacy = if !local_index_existed {
        bootstrap_local_index_from_legacy(&vault)?
    } else {
        false
    };

    if bootstrapped_from_legacy {
        append_startup_trace(
            app,
            "initialize_vault",
            &format!(
                "bootstrapped_local_index legacy={} derived={} elapsed_ms={}",
                vault.legacy_index_db_path().display(),
                vault.index_db_path().display(),
                total.elapsed().as_millis()
            ),
        );
    }
    if bootstrapped_thumbs_from_legacy {
        append_startup_trace(
            app,
            "initialize_vault",
            &format!(
                "bootstrapped_local_thumbs legacy={} derived={} elapsed_ms={}",
                vault.legacy_thumbs_dir().display(),
                vault.thumbs_dir().display(),
                total.elapsed().as_millis()
            ),
        );
    }
    cleanup_legacy_vault_artifacts(&vault)?;
    let derived_store_ready = local_index_existed || bootstrapped_from_legacy;
    let migration_required = !derived_store_ready;

    // Expand asset protocol scope for the vault root plus derived caches.
    // Recursive scope is required because Obsidian-compatible vaults may keep
    // notes and media in subfolders.
    app.asset_protocol_scope()
        .allow_directory(vault.root(), true)
        .map_err(|e| CommandError::Internal(format!("failed to allow vault root: {e}")))?;
    append_startup_trace(
        app,
        "initialize_vault",
        &format!(
            "asset_scope root elapsed_ms={}",
            total.elapsed().as_millis()
        ),
    );
    app.asset_protocol_scope()
        .allow_directory(vault.thumbs_dir(), true)
        .map_err(|e| CommandError::Internal(format!("failed to allow thumbs dir: {e}")))?;
    append_startup_trace(
        app,
        "initialize_vault",
        &format!(
            "asset_scope thumbs elapsed_ms={}",
            total.elapsed().as_millis()
        ),
    );
    app.asset_protocol_scope()
        .allow_directory(vault.audio_dir(), true)
        .map_err(|e| CommandError::Internal(format!("failed to allow audio dir: {e}")))?;
    append_startup_trace(
        app,
        "initialize_vault",
        &format!(
            "asset_scope audio elapsed_ms={}",
            total.elapsed().as_millis()
        ),
    );

    // Open or create database
    let db_started = Instant::now();
    let conn = db::open_or_create(&vault.index_db_path())?;
    let indexed = count_indexed_blocks(&conn)?;
    append_startup_trace(
        app,
        "initialize_vault",
        &format!(
            "db_open indexed={} elapsed_ms={}",
            indexed,
            db_started.elapsed().as_millis()
        ),
    );

    // Start file watcher
    let db_path = vault.index_db_path();
    let watcher_started = Instant::now();
    match watch::start_watching(app, &vault, &db_path) {
        Ok(w) => {
            let mut watcher = state
                .watcher
                .lock()
                .map_err(|_| CommandError::Internal("watcher mutex poisoned".into()))?;
            *watcher = Some(w);
            append_startup_trace(
                app,
                "initialize_vault",
                &format!(
                    "watcher_started elapsed_ms={}",
                    watcher_started.elapsed().as_millis()
                ),
            );
        }
        Err(e) => {
            log::warn!("failed to start file watcher: {e:#}");
            append_startup_trace(
                app,
                "initialize_vault",
                &format!(
                    "watcher_failed elapsed_ms={} err={:#}",
                    watcher_started.elapsed().as_millis(),
                    e
                ),
            );
        }
    }

    let thumbs_root = vault.thumbs_dir().to_string_lossy().into_owned();
    *vault_state = Some(VaultState { conn, vault });
    // Switching away can miss watcher events for this vault. Every selection
    // therefore invalidates the in-memory clean generation; the existing local
    // snapshot remains readable while one background pass catches up.
    state.freshness.mark_dirty(path);
    append_startup_trace(
        app,
        "initialize_vault",
        &format!(
            "done path={} indexed={} total_elapsed_ms={}",
            path,
            indexed,
            total.elapsed().as_millis()
        ),
    );

    start_index_metadata_backfill(app.clone(), path.to_string());

    Ok(VaultOpenResult {
        indexed,
        errors: 0,
        sync_in_progress: false,
        derived_store_ready,
        bootstrapped_from_legacy,
        migration_required,
        thumbs_root,
    })
}

/// Current thumb cache format version. Bump this when the thumbnail
/// pipeline changes in a way that makes old cached files incompatible
/// (e.g. text placeholders switched from JPEG to PNG, or new font).
const THUMB_FORMAT_VERSION: &str = "7";

/// If the thumb cache was written by an older format version, delete
/// all cached thumbnails and let a background sync regenerate them fresh.
/// Returns true when a migration actually ran.
fn migrate_thumb_cache(vault: &VaultLayout) -> bool {
    let marker = vault.thumbs_dir().join(".format-version");
    let current = std::fs::read_to_string(&marker).unwrap_or_default();
    if current.trim() == THUMB_FORMAT_VERSION {
        return false;
    }

    log::info!(
        "thumb cache migration: version {:?} → {}, clearing all thumbnails",
        current.trim(),
        THUMB_FORMAT_VERSION,
    );

    // Preview paths may become nested as the cache schema evolves. Walk
    // directories without following symlinks so no stale JPEG can survive a
    // format migration while non-preview sidecars remain untouched.
    clear_cached_jpegs(&vault.thumbs_dir());

    // Write the new version marker. If this fails, next startup will
    // re-run the migration — safe, just slightly wasteful.
    let _ = files::write_atomically(&marker, THUMB_FORMAT_VERSION.as_bytes());
    true
}

fn clear_cached_jpegs(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            clear_cached_jpegs(&path);
        } else if file_type.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("jpg")
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Legacy derived stores may predate the current preview/feed metadata
/// columns. Backfill `preview_manifest`, `thumb_format` / `thumb_mtime`, and
/// `feed_playback` in the background so feed contracts recover without
/// blocking startup.
fn start_index_metadata_backfill(app: AppHandle, path: String) {
    let app_for_thread = app.clone();
    let path_for_thread = path.clone();
    let _ = std::thread::Builder::new()
        .name(format!("index-meta-backfill-{}", path))
        .spawn(move || {
            let vault =
                match resolve_runtime_vault_layout(&app_for_thread, Path::new(&path_for_thread)) {
                    Ok(vault) => vault,
                    Err(err) => {
                        log::warn!(
                            "index metadata backfill layout failed for {}: {}",
                            path_for_thread,
                            err
                        );
                        append_startup_trace(
                            &app_for_thread,
                            "index_metadata_backfill",
                            &format!("layout_failed path={} err={}", path_for_thread, err),
                        );
                        return;
                    }
                };
            let conn = match db::open_or_create(&vault.index_db_path()) {
                Ok(conn) => conn,
                Err(err) => {
                    log::warn!(
                        "index metadata backfill db open failed for {}: {:#}",
                        path_for_thread,
                        err
                    );
                    append_startup_trace(
                        &app_for_thread,
                        "index_metadata_backfill",
                        &format!("db_open_failed path={} err={:#}", path_for_thread, err),
                    );
                    return;
                }
            };

            let freshness = app_for_thread
                .state::<AppState>()
                .freshness
                .reconcile(&vault);
            if let Err(error) = freshness.result {
                log::warn!(
                    "index metadata backfill freshness failed for {}: {}",
                    path_for_thread,
                    error
                );
            }

            let media_updated = match index::backfill_media_index(&conn, &vault) {
                Ok(updated) => updated,
                Err(err) => {
                    log::warn!("media index backfill failed for {}: {:#}", path_for_thread, err);
                    append_startup_trace(
                        &app_for_thread,
                        "index_metadata_backfill",
                        &format!("media_failed path={} err={:#}", path_for_thread, err),
                    );
                    return;
                }
            };
            let collections_updated = match index::backfill_collection_index(&conn, &vault) {
                Ok(updated) => updated,
                Err(err) => {
                    log::warn!(
                        "collection index backfill failed for {}: {:#}",
                        path_for_thread,
                        err
                    );
                    append_startup_trace(
                        &app_for_thread,
                        "index_metadata_backfill",
                        &format!("collections_failed path={} err={:#}", path_for_thread, err),
                    );
                    return;
                }
            };
            // One-time cleanup of staging directories left by earlier versions,
            // which kept a full copy of every clipped file forever. Failure is
            // never fatal: this only reclaims disk space.
            match clipper_uploads::sweep_committed_pending_uploads(&vault) {
                Ok(0) => {}
                Ok(removed) => {
                    log::info!(
                        "removed {} committed clipper staging directories for {}",
                        removed,
                        path_for_thread
                    );
                    append_startup_trace(
                        &app_for_thread,
                        "clipper_upload_sweep",
                        &format!("removed={} path={}", removed, path_for_thread),
                    );
                }
                Err(err) => log::warn!(
                    "clipper staging sweep failed for {}: {:#}",
                    path_for_thread,
                    err
                ),
            }
            let preview_updated = match index::backfill_missing_preview_manifest(&conn) {
                Ok(updated) => updated,
                Err(err) => {
                    log::warn!(
                        "preview manifest backfill failed for {}: {:#}",
                        path_for_thread,
                        err
                    );
                    append_startup_trace(
                        &app_for_thread,
                        "index_metadata_backfill",
                        &format!("preview_failed path={} err={:#}", path_for_thread, err),
                    );
                    return;
                }
            };
            let thumb_updated = match index::backfill_missing_thumb_metadata(&conn, &vault) {
                Ok(updated) => updated,
                Err(err) => {
                    log::warn!(
                        "thumb metadata backfill failed for {}: {:#}",
                        path_for_thread,
                        err
                    );
                    append_startup_trace(
                        &app_for_thread,
                        "index_metadata_backfill",
                        &format!("thumb_failed path={} err={:#}", path_for_thread, err),
                    );
                    return;
                }
            };
            let playback_updated = match index::backfill_missing_feed_playback(&conn, &vault) {
                Ok(updated) => updated,
                Err(err) => {
                    log::warn!(
                        "feed playback backfill failed for {}: {:#}",
                        path_for_thread,
                        err
                    );
                    append_startup_trace(
                        &app_for_thread,
                        "index_metadata_backfill",
                        &format!("playback_failed path={} err={:#}", path_for_thread, err),
                    );
                    return;
                }
            };
            let preview_text_updated = match index::backfill_missing_preview_text(&conn, &vault) {
                Ok(updated) => updated,
                Err(err) => {
                    log::warn!(
                        "preview text backfill failed for {}: {:#}",
                        path_for_thread,
                        err
                    );
                    append_startup_trace(
                        &app_for_thread,
                        "index_metadata_backfill",
                        &format!("preview_text_failed path={} err={:#}", path_for_thread, err),
                    );
                    return;
                }
            };
            let search_updated = match search_engine::warm_search_index_with_default_provider(&conn)
            {
                Ok(updated) => updated,
                Err(err) => {
                    log::warn!(
                        "search index backfill failed for {}: {:#}",
                        path_for_thread,
                        err
                    );
                    append_startup_trace(
                        &app_for_thread,
                        "index_metadata_backfill",
                        &format!("search_failed path={} err={:#}", path_for_thread, err),
                    );
                    0
                }
            };

            let total_updated = media_updated
                + collections_updated
                + preview_updated
                + thumb_updated
                + playback_updated
                + preview_text_updated
                + search_updated;
            if let Err(error) = schedule_preview_reconcile(
                &app_for_thread,
                vault,
                std::iter::empty::<String>(),
                true,
            ) {
                log::warn!(
                    "failed to schedule startup preview reconciliation for {}: {}",
                    path_for_thread,
                    error
                );
            }
            if total_updated == 0 {
                append_startup_trace(
                    &app_for_thread,
                    "index_metadata_backfill",
                    &format!("noop path={}", path_for_thread),
                );
                return;
            }

            log::info!(
                "index metadata backfill: media={} collections={} preview={} thumb={} playback={} preview_text={} search={} for {}",
                media_updated,
                collections_updated,
                preview_updated,
                thumb_updated,
                playback_updated,
                preview_text_updated,
                search_updated,
                path_for_thread,
            );
            append_startup_trace(
                &app_for_thread,
                "index_metadata_backfill",
                &format!(
                    "updated path={} media={} collections={} preview={} thumb={} playback={} preview_text={} search={}",
                    path_for_thread,
                    media_updated,
                    collections_updated,
                    preview_updated,
                    thumb_updated,
                    playback_updated,
                    preview_text_updated,
                    search_updated
                ),
            );
            let _ = app_for_thread.emit(
                "vault-changed",
                VaultChangedPayload {
                    path: path_for_thread.clone(),
                },
            );
        });
}

/// Create a callback that emits "vault-changed" when background thumbnails finish.
fn thumbs_done_cb(app: AppHandle, path: String) -> Box<dyn FnOnce() + Send> {
    Box::new(move || {
        if !app.state::<AppState>().is_current_vault(Path::new(&path)) {
            return;
        }
        log::info!("background thumbnails done, notifying frontend");
        let _ = app.emit("vault-changed", VaultChangedPayload { path });
    })
}

fn start_background_sync(app: AppHandle, path: String) -> Result<bool, CommandError> {
    append_startup_trace(&app, "start_vault_sync", &format!("request path={path}"));
    let app_state = app.state::<AppState>();
    app_state.freshness.mark_dirty(&path);
    if !app_state.try_start_sync(&path)? {
        append_startup_trace(
            &app,
            "start_vault_sync",
            &format!("already_running path={path}"),
        );
        return Ok(false);
    }

    let sync_path = path.clone();
    let app_for_thread = app.clone();
    let path_for_thread = path.clone();
    match std::thread::Builder::new()
        .name(format!("vault-sync-{}", sync_path))
        .spawn(move || {
            let total = Instant::now();
            let vault =
                match resolve_runtime_vault_layout(&app_for_thread, Path::new(&path_for_thread)) {
                    Ok(vault) => vault,
                    Err(err) => {
                        log::error!(
                            "failed to resolve runtime vault layout for {}: {}",
                            path_for_thread,
                            err
                        );
                        let _ = app_for_thread.emit(
                            "vault-sync-finished",
                            VaultSyncFinishedPayload {
                                path: path_for_thread.clone(),
                                indexed: 0,
                                errors: 0,
                                error: Some(err.to_string()),
                            },
                        );
                        let _ = app_for_thread
                            .state::<AppState>()
                            .abort_sync(&path_for_thread);
                        return;
                    }
                };
            let _ = app_for_thread.emit(
                "vault-sync-started",
                VaultSyncStartedPayload {
                    path: path_for_thread.clone(),
                },
            );
            append_startup_trace(
                &app_for_thread,
                "vault_sync_thread",
                &format!("start path={}", path_for_thread),
            );

            let conn = match db::open_or_create(&vault.index_db_path()) {
                Ok(conn) => conn,
                Err(err) => {
                    log::error!("failed to open db for sync {}: {:#}", path_for_thread, err);
                    append_startup_trace(
                        &app_for_thread,
                        "vault_sync_thread",
                        &format!("db_open_failed path={} err={:#}", path_for_thread, err),
                    );
                    let _ = app_for_thread.emit(
                        "vault-sync-finished",
                        VaultSyncFinishedPayload {
                            path: path_for_thread.clone(),
                            indexed: 0,
                            errors: 0,
                            error: Some(format!("{:#}", err)),
                        },
                    );
                    let _ = app_for_thread
                        .state::<AppState>()
                        .abort_sync(&path_for_thread);
                    return;
                }
            };
            let sync_state = app_for_thread.state::<AppState>();
            if migrate_thumb_cache(&vault) {
                append_startup_trace(
                    &app_for_thread,
                    "vault_sync_thread",
                    &format!(
                        "thumb_cache_migrated path={} elapsed_ms={}",
                        path_for_thread,
                        total.elapsed().as_millis()
                    ),
                );
            }
            let final_result = loop {
                if let Err(err) = sync_state.begin_sync_pass(&path_for_thread) {
                    break Err(err);
                }
                let result = match sync_state.freshness.reconcile(&vault).result {
                    Ok(report) => Ok(ScanResult {
                        indexed: report.upserted.len(),
                        errors: report.errors.len(),
                    }),
                    Err(error) => Err(anyhow::anyhow!(error)),
                };
                match result {
                    Ok(scan) => match sync_state.complete_sync_pass(&path_for_thread) {
                        Ok(true) => {
                            append_startup_trace(
                                &app_for_thread,
                                "vault_sync_thread",
                                &format!(
                                    "dirty_during_sync path={} rerun elapsed_ms={}",
                                    path_for_thread,
                                    total.elapsed().as_millis()
                                ),
                            );
                            continue;
                        }
                        Ok(false) => break Ok(scan),
                        Err(err) => break Err(err),
                    },
                    Err(err) => break Err(CommandError::Internal(format!("{:#}", err))),
                }
            };

            match final_result {
                Ok(scan) => {
                    migrate_channels_to_files(&conn, &vault);
                    // After the DB side is consistent, run a thumb_sweep so
                    // that thumbs are refreshed for blocks whose media was
                    // edited externally (e.g. iCloud sync from another
                    // device) without touching the `.md` mtime — which
                    // incremental_scan correctly skips but that would
                    // otherwise leave the sidebar showing a stale version.
                    match start_thumbnail_sweep(&app_for_thread, &sync_state, vault.clone()) {
                        Ok(count) => append_startup_trace(
                            &app_for_thread,
                            "vault_sync_thread",
                            &format!(
                                "thumb_sweep path={} queued={} elapsed_ms={}",
                                path_for_thread,
                                count,
                                total.elapsed().as_millis()
                            ),
                        ),
                        Err(err) => {
                            log::warn!("thumb_sweep failed for {}: {:#}", path_for_thread, err)
                        }
                    }
                    if let Err(error) = schedule_preview_reconcile(
                        &app_for_thread,
                        vault.clone(),
                        std::iter::empty::<String>(),
                        true,
                    ) {
                        log::warn!(
                            "failed to schedule sync preview reconciliation for {}: {}",
                            path_for_thread,
                            error
                        );
                    }
                    append_startup_trace(
                        &app_for_thread,
                        "vault_sync_thread",
                        &format!(
                            "done path={} indexed={} errors={} elapsed_ms={}",
                            path_for_thread,
                            scan.indexed,
                            scan.errors,
                            total.elapsed().as_millis()
                        ),
                    );
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
                    log::error!(
                        "background vault sync failed for {}: {}",
                        path_for_thread,
                        err
                    );
                    append_startup_trace(
                        &app_for_thread,
                        "vault_sync_thread",
                        &format!(
                            "failed path={} elapsed_ms={} err={}",
                            path_for_thread,
                            total.elapsed().as_millis(),
                            err
                        ),
                    );
                    let _ = sync_state.abort_sync(&path_for_thread);
                    let _ = app_for_thread.emit(
                        "vault-sync-finished",
                        VaultSyncFinishedPayload {
                            path: path_for_thread.clone(),
                            indexed: 0,
                            errors: 0,
                            error: Some(err.to_string()),
                        },
                    );
                }
            }
        }) {
        Ok(_handle) => Ok(true),
        Err(err) => {
            let _ = app.state::<AppState>().abort_sync(&path);
            Err(CommandError::Internal(format!(
                "failed to spawn vault sync thread: {err}"
            )))
        }
    }
}

fn count_indexed_blocks(conn: &Connection) -> Result<usize, CommandError> {
    let count: i64 = conn
        .query_row("SELECT count(*) FROM blocks", [], |row| row.get(0))
        .map_err(|e| CommandError::Internal(format!("failed to count indexed blocks: {e}")))?;
    Ok(count as usize)
}

fn resolve_runtime_vault_layout(app: &AppHandle, root: &Path) -> Result<VaultLayout, CommandError> {
    let base = VaultLayout::new(root.to_path_buf());
    std::fs::create_dir_all(base.mine_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create Mine metadata dir: {e}")))?;
    let vault_id = ensure_vault_id(&base)?;
    let derived_root = derived_store_root(app, &vault_id)?;
    let write_layout = load_write_layout(&base);
    Ok(VaultLayout::with_derived_root(root.to_path_buf(), derived_root)
        .with_write_layout(write_layout))
}

/// Read the vault's saved write layout, falling back to what the folder
/// already looks like. A vault that was never configured keeps behaving
/// exactly as before: standard folders if it has them, flat otherwise.
fn load_write_layout(vault: &VaultLayout) -> VaultWriteLayout {
    let Ok(raw) = std::fs::read_to_string(vault.write_layout_path()) else {
        return VaultWriteLayout::detect(vault.root());
    };
    let Ok(stored) = serde_json::from_str::<StoredWriteLayout>(&raw) else {
        log::warn!("ignoring unreadable write layout in {}", vault.root().display());
        return VaultWriteLayout::detect(vault.root());
    };
    VaultWriteLayout {
        cards: stored.cards,
        media: stored.media,
        collections: stored.collections,
    }
    .validate()
    .unwrap_or_else(|error| {
        log::warn!("ignoring invalid write layout: {error}");
        VaultWriteLayout::detect(vault.root())
    })
}

fn save_write_layout(vault: &VaultLayout, layout: &VaultWriteLayout) -> Result<(), CommandError> {
    let stored = StoredWriteLayout {
        cards: layout.cards.clone(),
        media: layout.media.clone(),
        collections: layout.collections.clone(),
    };
    let raw = serde_json::to_vec_pretty(&stored)
        .map_err(|e| CommandError::Internal(format!("failed to serialize write layout: {e}")))?;
    std::fs::create_dir_all(vault.mine_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create Mine metadata dir: {e}")))?;
    files::write_atomically(&vault.write_layout_path(), &raw)
        .map_err(|e| CommandError::Internal(format!("failed to save write layout: {e:#}")))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredWriteLayout {
    cards: String,
    media: String,
    collections: String,
}

fn ensure_vault_id(vault: &VaultLayout) -> Result<String, CommandError> {
    let path = vault.vault_id_path();
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    if let Ok(existing) = std::fs::read_to_string(vault.legacy_vault_id_path()) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            files::write_atomically(&path, format!("{trimmed}\n").as_bytes()).map_err(|e| {
                CommandError::Internal(format!("failed to migrate vault-id to .mine: {e:#}"))
            })?;
            return Ok(trimmed.to_string());
        }
    }

    let new_id = generate_vault_id()?;
    files::write_atomically(&path, format!("{new_id}\n").as_bytes())
        .map_err(|e| CommandError::Internal(format!("failed to write vault-id: {e:#}")))?;
    Ok(new_id)
}

fn generate_vault_id() -> Result<String, CommandError> {
    let mut bytes = [0u8; 16];
    match std::fs::File::open("/dev/urandom") {
        Ok(mut file) => file
            .read_exact(&mut bytes)
            .map_err(|e| CommandError::Internal(format!("failed to read /dev/urandom: {e}")))?,
        Err(_) => {
            let fallback = format!(
                "{:016x}{:08x}{:08x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| CommandError::Internal(format!("system time before epoch: {e}")))?
                    .as_nanos(),
                std::process::id(),
                0x5A17_u32,
            );
            return Ok(fallback);
        }
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15],
    ))
}

pub(crate) fn derived_store_root(app: &AppHandle, vault_id: &str) -> Result<PathBuf, CommandError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Internal(format!("failed to resolve app data dir: {e}")))?;
    Ok(app_data.join("vaults").join(vault_id))
}

fn bootstrap_local_index_from_legacy(vault: &VaultLayout) -> Result<bool, CommandError> {
    let target = vault.index_db_path();
    let source = vault.legacy_index_db_path();
    if target.exists() || !source.exists() {
        return Ok(false);
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            CommandError::Internal(format!("failed to create local derived dir: {e}"))
        })?;
    }

    std::fs::copy(&source, &target)
        .map_err(|e| CommandError::Internal(format!("failed to copy legacy index db: {e}")))?;

    for suffix in ["-wal", "-shm"] {
        let source_sidecar = PathBuf::from(format!("{}{}", source.display(), suffix));
        let target_sidecar = PathBuf::from(format!("{}{}", target.display(), suffix));
        if source_sidecar.exists() {
            std::fs::copy(&source_sidecar, &target_sidecar).map_err(|e| {
                CommandError::Internal(format!(
                    "failed to copy legacy sqlite sidecar {}: {e}",
                    source_sidecar.display()
                ))
            })?;
        }
    }

    Ok(true)
}

fn bootstrap_local_thumbs_from_legacy(vault: &VaultLayout) -> Result<bool, CommandError> {
    let source = vault.legacy_thumbs_dir();
    let target = vault.thumbs_dir();
    if !source.exists() {
        return Ok(false);
    }

    if target.exists() {
        let mut entries = target.read_dir().map_err(|e| {
            CommandError::Internal(format!(
                "failed to inspect local thumb cache {}: {e}",
                target.display()
            ))
        })?;
        if entries.next().is_some() {
            return Ok(false);
        }
    } else {
        std::fs::create_dir_all(&target).map_err(|e| {
            CommandError::Internal(format!(
                "failed to create local thumb cache {}: {e}",
                target.display()
            ))
        })?;
    }

    let mut copied_any = false;
    for entry in std::fs::read_dir(&source).map_err(|e| {
        CommandError::Internal(format!(
            "failed to read legacy thumb cache {}: {e}",
            source.display()
        ))
    })? {
        let entry = entry.map_err(|e| {
            CommandError::Internal(format!(
                "failed to enumerate legacy thumb cache {}: {e}",
                source.display()
            ))
        })?;
        let source_path = entry.path();
        if !source_path.is_file() {
            continue;
        }
        let target_path = target.join(entry.file_name());
        std::fs::copy(&source_path, &target_path).map_err(|e| {
            CommandError::Internal(format!(
                "failed to copy legacy thumb {} -> {}: {e}",
                source_path.display(),
                target_path.display()
            ))
        })?;
        copied_any = true;
    }

    Ok(copied_any)
}

fn cleanup_legacy_vault_artifacts(vault: &VaultLayout) -> Result<(), CommandError> {
    remove_file_if_exists(&vault.legacy_vault_id_path(), "legacy vault-id")?;
    remove_file_if_exists(&vault.legacy_index_db_path(), "legacy index db")?;
    for suffix in ["-wal", "-shm"] {
        remove_file_if_exists(
            &PathBuf::from(format!(
                "{}{}",
                vault.legacy_index_db_path().display(),
                suffix
            )),
            "legacy sqlite sidecar",
        )?;
    }
    remove_file_if_exists(
        &vault.legacy_arena_dir().join(".DS_Store"),
        "legacy metadata .DS_Store",
    )?;
    remove_dir_all_if_exists(&vault.legacy_arena_dir().join("cache"), "legacy cache")?;
    remove_empty_dir_if_exists(&vault.legacy_arena_dir(), "legacy metadata dir")?;
    Ok(())
}

fn remove_file_if_exists(path: &Path, label: &str) -> Result<(), CommandError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandError::Internal(format!(
            "failed to remove {label} {}: {error}",
            path.display()
        ))),
    }
}

fn remove_dir_all_if_exists(path: &Path, label: &str) -> Result<(), CommandError> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandError::Internal(format!(
            "failed to remove {label} {}: {error}",
            path.display()
        ))),
    }
}

fn remove_empty_dir_if_exists(path: &Path, label: &str) -> Result<(), CommandError> {
    match std::fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(CommandError::Internal(format!(
            "failed to remove empty {label} {}: {error}",
            path.display()
        ))),
    }
}

// ─── Channel migration ──────────────────────────────────────────────────────

/// One-time migration: create .md files for channels that only exist in SQLite.
/// After this, channels are read from .md files (type: channel) during full_scan.
fn migrate_channels_to_files(conn: &Connection, vault: &VaultLayout) {
    use crate::domain::block::{Block, BlockType, Frontmatter};
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
                title: None,
                description: ch.description,
                url: None,
                file: None,
                thumbnail: None,
                tags: Vec::new(),
                related_notes: Vec::new(),
                source_media: None,
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

        if let Err(e) = files::write_new_block_file(vault, &block) {
            log::warn!("failed to migrate channel '{}' to file: {e:#}", ch.tag);
        }
    }
}

// ─── Config persistence ─────────────────────────────────────────────────────

/// Path to the app config file: <app_data_dir>/config.json
fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("config.json"))
}

/// Load the full config JSON, or empty object if missing.
pub(crate) fn load_config(app: &AppHandle) -> serde_json::Value {
    let Some(config) = config_path(app) else {
        return serde_json::json!({});
    };
    let Ok(data) = std::fs::read_to_string(&config) else {
        return serde_json::json!({});
    };
    serde_json::from_str(&data).unwrap_or_else(|_| serde_json::json!({}))
}

/// Write the full config JSON to disk.
pub(crate) fn write_config(app: &AppHandle, json: &serde_json::Value) {
    let Some(config) = config_path(app) else {
        return;
    };
    if let Some(parent) = config.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = files::write_atomically(
        &config,
        serde_json::to_string_pretty(json)
            .unwrap_or_default()
            .as_bytes(),
    ) {
        log::warn!("failed to save config: {e:#}");
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
        return cfg
            .get("vault_path")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_vault_id_persists_value() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(vault.mine_dir()).unwrap();

        let first = ensure_vault_id(&vault).unwrap();
        let second = ensure_vault_id(&vault).unwrap();

        assert_eq!(first, second);
        assert_eq!(
            std::fs::read_to_string(vault.vault_id_path())
                .unwrap()
                .trim(),
            first
        );
    }

    #[test]
    fn ensure_vault_id_migrates_legacy_arena_marker() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(vault.mine_dir()).unwrap();
        std::fs::create_dir_all(vault.legacy_arena_dir()).unwrap();
        std::fs::write(vault.legacy_vault_id_path(), "legacy-id\n").unwrap();

        let id = ensure_vault_id(&vault).unwrap();

        assert_eq!(id, "legacy-id");
        assert_eq!(
            std::fs::read_to_string(vault.vault_id_path())
                .unwrap()
                .trim(),
            "legacy-id"
        );
    }

    #[test]
    fn rebuild_failure_preserves_last_good_index_projection() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let source_path = vault.block_path("Stable");
        std::fs::write(
            &source_path,
            "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\n---\nold body",
        )
        .unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        std::fs::write(
            &source_path,
            "---\ntype: article\nsaved_at: 2026-07-10T00:00:00Z\n---\nnew body",
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_rebuild_update
             BEFORE UPDATE ON blocks
             WHEN new.slug = 'Stable'
             BEGIN
                 SELECT RAISE(ABORT, 'injected rebuild failure');
             END;",
        )
        .unwrap();

        let report = rebuild_index_projection(&conn, &vault).unwrap();

        assert_eq!(report.errors.len(), 1);
        let indexed = index::get_block(&conn, "Stable").unwrap().unwrap();
        assert_eq!(indexed.body.trim(), "old body");
    }

    #[test]
    fn bootstrap_local_index_from_legacy_copies_sqlite_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let derived = dir.path().join("derived");
        let vault = VaultLayout::with_derived_root(root.clone(), derived);
        std::fs::create_dir_all(vault.legacy_arena_dir()).unwrap();
        std::fs::write(vault.legacy_index_db_path(), b"legacy-db").unwrap();
        std::fs::write(
            format!("{}-wal", vault.legacy_index_db_path().display()),
            b"legacy-wal",
        )
        .unwrap();
        std::fs::write(
            format!("{}-shm", vault.legacy_index_db_path().display()),
            b"legacy-shm",
        )
        .unwrap();

        assert!(bootstrap_local_index_from_legacy(&vault).unwrap());
        assert_eq!(std::fs::read(vault.index_db_path()).unwrap(), b"legacy-db");
        assert_eq!(
            std::fs::read(format!("{}-wal", vault.index_db_path().display())).unwrap(),
            b"legacy-wal"
        );
        assert_eq!(
            std::fs::read(format!("{}-shm", vault.index_db_path().display())).unwrap(),
            b"legacy-shm"
        );
        assert!(!bootstrap_local_index_from_legacy(&vault).unwrap());
    }

    #[test]
    fn bootstrap_local_thumbs_from_legacy_copies_thumb_cache_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let derived = dir.path().join("derived");
        let vault = VaultLayout::with_derived_root(root.clone(), derived);
        std::fs::create_dir_all(vault.legacy_thumbs_dir()).unwrap();
        std::fs::write(vault.legacy_thumbs_dir().join("alpha.jpg"), b"jpg").unwrap();
        std::fs::write(vault.legacy_thumbs_dir().join(".format-version"), b"3").unwrap();

        assert!(bootstrap_local_thumbs_from_legacy(&vault).unwrap());
        assert_eq!(
            std::fs::read(vault.thumbs_dir().join("alpha.jpg")).unwrap(),
            b"jpg"
        );
        assert_eq!(
            std::fs::read(vault.thumbs_dir().join(".format-version")).unwrap(),
            b"3"
        );
        assert!(!bootstrap_local_thumbs_from_legacy(&vault).unwrap());
    }

    #[test]
    fn cleanup_legacy_vault_artifacts_removes_known_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let derived = dir.path().join("derived");
        let vault = VaultLayout::with_derived_root(root.clone(), derived);
        std::fs::create_dir_all(vault.legacy_thumbs_dir()).unwrap();
        std::fs::create_dir_all(vault.legacy_arena_dir().join("conflicts-archive")).unwrap();
        std::fs::write(vault.legacy_vault_id_path(), b"legacy-id").unwrap();
        std::fs::write(vault.legacy_index_db_path(), b"db").unwrap();
        std::fs::write(
            PathBuf::from(format!("{}-wal", vault.legacy_index_db_path().display())),
            b"wal",
        )
        .unwrap();
        std::fs::write(vault.legacy_thumbs_dir().join("alpha.jpg"), b"jpg").unwrap();

        cleanup_legacy_vault_artifacts(&vault).unwrap();

        assert!(!vault.legacy_vault_id_path().exists());
        assert!(!vault.legacy_index_db_path().exists());
        assert!(!vault.legacy_arena_dir().join("cache").exists());
        assert!(vault.legacy_arena_dir().join("conflicts-archive").exists());
    }
}
