// Vault commands: select vault folder, trigger scan.
//
// Persists the selected vault path in the app data directory
// so the vault is automatically restored on next launch.
//
// Contract: SPEC_INTEGRATION.md#commands/vault

use std::io::Read;
use crate::commands::effects::VaultChangedPayload;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Manager, State};

use rusqlite::Connection;
use serde::Serialize;

use crate::space_registry::{
    identity_claim, read_identity_file, record_owner_path, CloudRead, IdentityClaim, Located,
    LostReason,
};
use crate::commands::space_events;
use crate::commands::state::{
    chosen_space, schedule_preview_reconcile, tab_layout, AppState, CommandError, OpenSpace,
    SpaceLease, SweepGuard, VaultState,
};
use crate::domain::vault::{VaultLayout, VaultWriteLayout};
use crate::storage::clipper_uploads;
use crate::storage::index;
use crate::storage::search_engine;
use crate::storage::{db, files, reconcile, thumbnails};
use crate::util::append_startup_trace;
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
struct VaultSyncStartedPayload {
    path: String,
}

#[derive(Debug, Clone, Serialize)]
struct VaultSyncProgressPayload {
    path: String,
    processed: usize,
    total: usize,
}

/// `vault-sync-progress` for one space, as the first-index screen reads it
/// (SPEC_ONBOARDING.md, О13): the first file, every 25th and the last, enough
/// for a live count and cheap on a small space. Both the background sync and
/// the first generation a feed read waits on report through it.
pub(crate) fn sync_progress_emitter(
    app: &AppHandle,
    path: String,
) -> impl Fn(usize, usize) + Sync + Send + 'static {
    let app = app.clone();
    move |processed: usize, total: usize| {
        if processed % 25 != 0 && processed != total && processed != 1 {
            return;
        }
        crate::commands::space_events::emit_to_space_path(
            &app,
            &path,
            "vault-sync-progress",
            VaultSyncProgressPayload {
                path: path.clone(),
                processed,
                total,
            },
        );
    }
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
///
/// Off the main thread: a synchronous command runs there, and a slow disk or
/// iCloud would stall every window with it.
#[tauri::command]
pub async fn list_known_vaults(app: AppHandle) -> Result<Vec<String>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || load_known_vaults(&app))
        .await
        .map_err(|error| CommandError::Internal(format!("space list worker failed: {error}")))
}

/// One space in the list, with whether it can be opened right now.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct SpaceEntry {
    /// The space's identity, when the registry knows it.
    pub vault_id: Option<String>,
    pub path: String,
    /// The folder name, as the switcher shows it.
    pub name: String,
    /// The folder is there and is this space.
    pub available: bool,
    /// The space the app is bound to.
    pub current: bool,
}

/// Every known space, available or not, in the person's order
/// (SPEC_VAULT_LIFECYCLE.md, П25, П26). Unavailable spaces stay listed and
/// marked instead of disappearing.
#[tauri::command]
pub async fn list_spaces(app: AppHandle) -> Result<Vec<SpaceEntry>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || space_entries(&app))
        .await
        .map_err(|error| CommandError::Internal(format!("space list worker failed: {error}")))
}

fn space_entries(app: &AppHandle) -> Vec<SpaceEntry> {
    let serde_json::Value::Object(cfg) = load_config(app) else {
        return Vec::new();
    };
    let current = crate::space_registry::current_path(&cfg);
    crate::space_registry::statuses_in(&cfg, derived_stores_dir(app).as_deref())
        .into_iter()
        .map(|status| {
            let path = status.record.path;
            SpaceEntry {
                vault_id: status.record.vault_id.clone(),
                name: Path::new(&path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone()),
                available: status.available,
                current: current
                    .as_deref()
                    .is_some_and(|current| crate::space_registry::same_path(current, &path)),
                path,
            }
        })
        .collect()
}

/// Open the space the person chose at `path` in the calling tab: open or
/// create its index, lay out its folders on a first choice, bind the tab to
/// it (SPEC_TABS.md, В10). Persists the path so the next launch restores it.
#[tauri::command]
pub async fn select_vault(
    app: AppHandle,
    webview: tauri::Webview,
    path: String,
) -> Result<VaultOpenResult, CommandError> {
    // With the frontend's space_switch_requested these bound where a slow
    // switch spends its time: the IPC hop, the selection lock or the open.
    append_startup_trace(&app, "select_vault", "received");
    let label = webview.label().to_string();
    let request = app.state::<AppState>().tabs.begin_selection(&label);
    tauri::async_runtime::spawn_blocking(move || {
        open_space_in_tab(&app, &label, request, &path, SpaceOpening::Chosen, true)
    })
        .await
        .map_err(|error| CommandError::Internal(format!("vault selection worker failed: {error}")))?
}

/// Who asks for a space to open. Only the person's own choice of a folder
/// may make it a space: lay out its folders and give it an identity
/// (`SPEC_AUDIT_FIXES.md`, Ф8). The app reopening a space it knows finds the
/// identity already there, or does not open the folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpaceOpening {
    /// The person picked this folder.
    Chosen,
    /// The app reopens a known space: at launch, after a move, for
    /// background work on the open space.
    Restored,
}

/// Open the space at `path` for the selection `request` of the tab `label`
/// and bind the tab to it (SPEC_TABS.md, В10). Other tabs are untouched: a
/// newer choice in this tab supersedes this one, a choice in another tab
/// never does. `announce` records the path as the space to restore and
/// tells the tab and the settings window; a restore at launch does neither.
fn open_space_in_tab(
    app: &AppHandle,
    label: &str,
    request: u64,
    path: &str,
    opening: SpaceOpening,
    announce: bool,
) -> Result<VaultOpenResult, CommandError> {
    let state = app.state::<AppState>();
    require_latest_selection(&state, label, request)?;
    let path = canonical_space_path(path)?;
    let (lease, result) = initialize_vault(app, &state, &path, opening)?;
    let vault_id = lease.space().vault_id().to_string();
    let left = state
        .space_for(label)
        .map(|space| space.vault_id().to_string())
        .filter(|previous| previous != &vault_id);
    state
        .tabs
        .bind(label, request, lease)
        .map_err(|_| superseded_selection())?;
    crate::tabs::space_shown(app, label, &vault_id);
    // The space the tab left may have lost its lead (SPEC_TABS.md, В19).
    if let Some(left) = left {
        crate::tabs::refresh_leads(app, &left);
    }
    if announce {
        save_vault_path(app, &path);
        space_events::emit_to_labels(
            app,
            [label, space_events::SETTINGS_LABEL],
            "vault-selected",
            VaultChangedPayload::from_outside(path),
        );
    }
    Ok(result)
}

fn superseded_selection() -> CommandError {
    CommandError::Internal("vault selection superseded by a newer request".into())
}

fn require_latest_selection(state: &AppState, label: &str, request: u64) -> Result<(), CommandError> {
    if state.tabs.is_latest(label, request) {
        Ok(())
    } else {
        Err(superseded_selection())
    }
}

/// Resolve aliases and trailing separators before a folder enters the space
/// registry. The root directory, not its spelling, identifies a space.
pub(crate) fn canonical_space_path(path: &str) -> Result<String, CommandError> {
    std::fs::canonicalize(path)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| CommandError::Internal(format!("cannot access space {path}: {error}")))
}


/// A space that is bound but not reachable right now. Also the payload of
/// `space-unavailable`, which names the lost space so a window can ignore a
/// report about a space it no longer shows (`SPEC_AUDIT_FIXES.md`, В2.1).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct UnavailableVault {
    /// The path the space was opened with, spelled as `vault-selected` and
    /// `get_vault_path` report it.
    pub path: String,
    /// Why the space cannot be opened: the folder is gone from this path, or
    /// it is right there and macOS refuses to let the app read it. The two
    /// need different words and different actions — "locate the folder" is
    /// useless advice when the folder is visible and locked.
    /// See SPEC_ONBOARDING.md О11.
    pub reason: UnavailableVaultReason,
    /// The lost space's identity, when the app knows it.
    pub vault_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableVaultReason {
    /// Renamed, moved, on a disconnected drive, or not yet synced.
    Missing,
    /// The folder exists; reading it is what fails.
    AccessDenied,
}

/// The saved space that could not be opened, if any.
///
/// Returns `None` when there is no binding at all (a genuinely first run) or
/// when the saved space is reachable. The distinction matters: a missing folder
/// must never look like a fresh install.
#[tauri::command]
pub fn get_unavailable_vault(
    app: AppHandle,
    webview: tauri::Webview,
) -> Result<Option<UnavailableVault>, CommandError> {
    let Some(saved_path) = saved_space_path(&app, &webview) else {
        return Ok(None);
    };
    match locate_saved_space(&app, &saved_path) {
        Located::Here { .. } | Located::Moved { .. } => Ok(None),
        // A folder at the path that is another space, or no space at all,
        // means the saved space is not there: the same words as a missing
        // folder, and the same action, locate it.
        Located::Lost { reason, .. } => Ok(Some(UnavailableVault {
            vault_id: saved_space_identity(&app, &saved_path),
            path: saved_path,
            reason: match reason {
                LostReason::AccessDenied => UnavailableVaultReason::AccessDenied,
                LostReason::Missing | LostReason::Replaced => UnavailableVaultReason::Missing,
            },
        })),
    }
}

/// The identity of the space the app knows at `path` (its record, else its
/// derived store).
fn saved_space_identity(app: &AppHandle, path: &str) -> Option<String> {
    let serde_json::Value::Object(cfg) = load_config(app) else {
        return None;
    };
    crate::space_registry::saved_identity(&cfg, derived_stores_dir(app).as_deref(), path)
}

/// Where the derived stores of every space live (П27).
fn derived_stores_dir(app: &AppHandle) -> Option<PathBuf> {
    app_config(app).map(|config| crate::space_registry::vaults_dir(config.app_data_dir()))
}

/// Where the space saved in settings stands now (`SPEC_AUDIT_FIXES.md`, Ф8).
/// The folder at the saved path counts only when it carries the identity the
/// registry recorded for it, or, for a record without one, the identity its
/// derived store last saw there; otherwise the space is looked for by
/// identity (П30). A folder with no identity or another one is not this space.
fn locate_saved_space(app: &AppHandle, saved_path: &str) -> Located {
    let cfg = match load_config(app) {
        serde_json::Value::Object(cfg) => cfg,
        _ => serde_json::Map::new(),
    };
    crate::space_registry::locate_saved(&cfg, derived_stores_dir(app).as_deref(), saved_path)
}

/// Why a bound folder cannot be opened, or `None` when it can.
///
/// Reading the directory is the test that matters — it is the operation the
/// app is about to perform. A folder that exists but refuses the read is an
/// access problem, not a missing one, and the two need different words.
pub(crate) fn unavailable_reason(path: &Path) -> Option<UnavailableVaultReason> {
    match std::fs::read_dir(path) {
        Ok(_) => None,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            Some(UnavailableVaultReason::AccessDenied)
        }
        Err(_) if path.is_dir() => Some(UnavailableVaultReason::AccessDenied),
        Err(_) => Some(UnavailableVaultReason::Missing),
    }
}

/// The first saved card deserves one sentence about what it is (О19).
///
/// The product sells locality, and the moment to show it is the moment the
/// person just got their first result: the card they saved is a file in the
/// folder they chose. Shown once per space; the flag is a sidecar in the
/// derived store, so it survives an index rebuild and dies with the space.
#[tauri::command]
pub fn first_card_marker_pending(
    webview: tauri::Webview,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let root = current_derived_root(&webview, &state)?;
    Ok(!root.join("first-card.json").is_file())
}

/// The marker was shown (or dismissed); it never comes back in this space.
#[tauri::command]
pub fn complete_first_card_marker(
    webview: tauri::Webview,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let root = current_derived_root(&webview, &state)?;
    std::fs::create_dir_all(&root)
        .map_err(|e| CommandError::Internal(format!("failed to create derived root: {e}")))?;
    crate::storage::files::write_atomically(&root.join("first-card.json"), b"{\"shown\":true}")
        .map_err(|e| CommandError::Internal(format!("failed to record the marker: {e:#}")))
}

/// Whether this space still owes its first-screen onboarding (О14, О15).
///
/// The onboarding introduces a new space and leaves with its first card for
/// good: a space that had cards and lost them all has an empty feed, not a new
/// space. The count comes from this space's own index, so a space switch in
/// flight cannot lend it another space's cards.
#[tauri::command]
pub async fn space_onboarding_pending(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let vault = tab_layout(&state, &webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cards = crate::commands::state::read_owned_projection(&app, &vault, |conn| {
            index::count_grid_blocks(conn)
        })?;
        onboarding_owed(vault.derived_root(), cards)
            .map_err(|e| CommandError::Internal(format!("failed to record the onboarding: {e:#}")))
    })
    .await
    .map_err(|e| CommandError::Internal(format!("onboarding check task failed: {e}")))?
}

const SPACE_ONBOARDING_SIDECAR: &str = "space-onboarding.json";

/// The onboarding is owed while the space has never had a card. The first
/// time it has one, a sidecar in the derived store records it: from then on
/// no count brings the onboarding back.
fn onboarding_owed(derived_root: &Path, cards: usize) -> anyhow::Result<bool> {
    let sidecar = derived_root.join(SPACE_ONBOARDING_SIDECAR);
    if sidecar.is_file() {
        return Ok(false);
    }
    if cards == 0 {
        return Ok(true);
    }
    std::fs::create_dir_all(derived_root)?;
    files::write_atomically(&sidecar, b"{\"had_cards\":true}")?;
    Ok(false)
}

fn current_derived_root(
    webview: &tauri::Webview,
    state: &State<'_, AppState>,
) -> Result<PathBuf, CommandError> {
    Ok(tab_layout(state, webview)?.derived_root().to_path_buf())
}

/// Discard the binding to a space that is no longer wanted.
///
/// Explicit user action only: this is the single place the saved path is
/// dropped, so a folder that is merely offline is never forgotten silently.
#[tauri::command]
pub fn forget_unavailable_vault(app: AppHandle, webview: tauri::Webview) -> Result<(), CommandError> {
    let Some(path) = saved_space_path(&app, &webview) else {
        return Ok(());
    };
    let vault_id = saved_space_identity(&app, &path);
    // Exactly this record and the current binding go; every other space and
    // setting stays (П13, П28). The tabs of the space choose another
    // (SPEC_TABS.md, В70).
    update_config(&app, |cfg| crate::space_registry::forget(cfg, &path))?;
    if let Some(vault_id) = vault_id {
        crate::tabs::space_forgotten(&app, &vault_id);
    }
    Ok(())
}

/// The space the page `webview` is bound to restore: its tab's saved space,
/// or the config's current space for a page that is not a tab.
fn saved_space_path(app: &AppHandle, webview: &tauri::Webview) -> Option<String> {
    match crate::tabs::tab_space_path(app, webview.label()) {
        Some(tab_space) => tab_space,
        None => load_saved_vault_path(app),
    }
}

/// Make `path` the space the config names as current (SPEC_TABS.md, В74).
pub(crate) fn record_current_space(app: &AppHandle, path: &str) {
    save_vault_path(app, path);
}

/// The write layout of the space `vault_id`, else of the most recently used
/// tab's space (SPEC_TABS.md, В71).
#[tauri::command]
pub fn get_vault_write_layout(
    state: State<'_, AppState>,
    vault_id: Option<String>,
) -> Result<VaultWriteLayoutDto, CommandError> {
    let space = chosen_space(&state, vault_id.as_deref())?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(VaultWriteLayoutDto::from(&load_write_layout(&vs.vault)?))
}

/// Choose which folders new cards, media and collections are written into.
///
/// Existing files are never moved: this governs writes from here on. Reading
/// stays recursive, so whatever is already on disk keeps working.
#[tauri::command(async)]
pub fn set_vault_write_layout(
    app: AppHandle,
    state: State<'_, AppState>,
    layout: VaultWriteLayoutDto,
    vault_id: Option<String>,
) -> Result<VaultWriteLayoutDto, CommandError> {
    let requested = VaultWriteLayout {
        cards: layout.cards,
        media: layout.media,
        collections: layout.collections,
    }
    .validate()
    .map_err(|e| CommandError::Internal(e.to_string()))?;

    let space = chosen_space(&state, vault_id.as_deref())?;
    let mut vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_mut().ok_or(CommandError::NoVault)?;
    save_write_layout(&vs.vault, &requested)?;
    vs.vault = vs.vault.clone().with_write_layout(requested.clone());
    drop(vault_state);
    let dto = VaultWriteLayoutDto::from(&requested);
    space_events::emit_to_space_and_settings(
        &app,
        space.vault_id(),
        "vault-write-layout-changed",
        dto.clone(),
    );
    Ok(dto)
}

/// Create the standard folders in the current space and adopt them for writes.
#[tauri::command(async)]
pub fn organize_vault_layout(
    app: AppHandle,
    state: State<'_, AppState>,
    vault_id: Option<String>,
) -> Result<VaultWriteLayoutDto, CommandError> {
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    let standard = VaultWriteLayout::standard();
    let space = chosen_space(&state, vault_id.as_deref())?;
    {
        let vault_state = space
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
        for folder in [&standard.cards, &standard.media, &standard.collections] {
            std::fs::create_dir_all(vs.vault.root().join(folder))
                .map_err(|e| CommandError::Internal(format!("failed to create {folder}: {e}")))?;
        }
    }
    set_vault_write_layout(
        app,
        state,
        VaultWriteLayoutDto::from(&standard),
        Some(space.vault_id().to_string()),
    )
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

/// Open the saved space in the calling tab without changing the config: the
/// restore at launch.
#[tauri::command]
pub async fn open_vault(
    app: AppHandle,
    webview: tauri::Webview,
    path: String,
) -> Result<VaultOpenResult, CommandError> {
    let label = webview.label().to_string();
    let request = app.state::<AppState>().tabs.begin_selection(&label);
    tauri::async_runtime::spawn_blocking(move || {
        // Opening without a choice by the person: the folder must still be
        // the saved space. Only an explicit selection may make a folder a
        // space and give it an identity.
        if !matches!(locate_saved_space(&app, &path), Located::Here { .. }) {
            return Err(CommandError::Internal(format!(
                "the saved space is no longer at {path}"
            )));
        }
        open_space_in_tab(&app, &label, request, &path, SpaceOpening::Restored, false)
    })
    .await
    .map_err(|error| CommandError::Internal(format!("vault opening worker failed: {error}")))?
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
    webview: tauri::Webview,
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    append_startup_trace(&app, "get_vault_path", "start");
    // The space this tab already shows comes first.
    if let Some(root) = state.space_for(webview.label()).and_then(|space| space.root()) {
        let path = root.to_string_lossy().to_string();
        append_startup_trace(&app, "get_vault_path", &format!("from_memory path={path}"));
        append_startup_trace(&app, "startup", "milestone=saved_vault_resolved");
        return Ok(Some(path));
    }

    repair_space_registry(&app);
    // Try to restore the tab's saved space (SPEC_TABS.md, В32): the saved
    // path opens only while it holds the recorded space, never a folder that
    // took its place. A tab choosing a space has none.
    if let Some(saved_path) = saved_space_path(&app, &webview) {
        let found = match locate_saved_space(&app, &saved_path) {
            Located::Here { path } => Some(path),
            Located::Moved { path, .. } => {
                record_moved_space(&app, &saved_path, &path);
                Some(path)
            }
            Located::Lost { .. } => None,
        };
        if let Some(saved_path) = found {
            append_startup_trace(
                &app,
                "get_vault_path",
                &format!("from_config path={saved_path}"),
            );
            append_startup_trace(&app, "startup", "milestone=saved_vault_resolved");
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
#[tauri::command(async)]
pub fn start_vault_sync(webview: tauri::Webview, app: AppHandle, state: State<'_, AppState>) -> Result<bool, CommandError> {
    let path = {
        let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
        // Another tab of this opening already synced it (SPEC_TABS.md, В7).
        if space.opening_synced() {
            append_startup_trace(
                &app,
                "start_vault_sync",
                &format!("already_synced vault_id={}", space.vault_id()),
            );
            return Ok(false);
        }
        let vault_state = space
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
async fn rebuild_index_unannounced(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, CommandError> {
    let vault = tab_layout(&state, &webview)?;
    let app_for_task = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<ScanResult, CommandError> {
            // Force every source through the canonical reconciler without deleting
            // the last-good projection first. A fatal or per-file failure therefore
            // preserves readable Grid/Search/Detail state and remains retryable.
            let app_state = app_for_task.state::<AppState>();
            let owned = app_state
                .spaces
                .by_root(vault.root())
                .ok_or(CommandError::NoVault)?
                .layout()?;
            let attempt = |layout: &VaultLayout| -> anyhow::Result<_> {
                let conn = db::open_or_create(&layout.index_db_path())?;
                let report = rebuild_index_projection(&conn, layout)?;
                search_engine::warm_search_index(&conn, None)?;
                Ok(report)
            };
            let (selected, report) = match attempt(&owned) {
                Ok(report) => (owned.clone(), report),
                Err(error) if db::is_index_corruption(&error) => {
                    let recovered = db::recover_vault_index_after_error(owned.clone(), &error)
                        .map_err(|error| CommandError::Internal(error.to_string()))?;
                    let report = attempt(&recovered)?;
                    (recovered, report)
                }
                Err(error) => return Err(error.into()),
            };
            super::state::adopt_recovered_projection(&app_for_task, &owned, selected.clone(), ())?;
            start_thumbnail_sweep(&app_for_task, &app_state, selected.clone())?;
            schedule_preview_reconcile(
                &app_for_task,
                selected,
                std::iter::empty::<String>(),
                true,
            )?;
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

/// [`rebuild_index_unannounced`], then the other tabs of the space hear of the
/// change (SPEC_TABS.md, В15).
#[tauri::command]
pub async fn rebuild_index(webview: tauri::Webview, app: AppHandle, state: State<'_, AppState>) -> Result<ScanResult, CommandError> {
    let announcing = webview.clone();
    let outcome = rebuild_index_unannounced(webview, app, state).await;
    if outcome.is_ok() {
        super::effects::space_changed_by_tab(&announcing, Vec::new());
    }
    outcome
}

fn rebuild_index_projection(
    conn: &Connection,
    vault: &VaultLayout,
) -> anyhow::Result<reconcile::ReconcileReport> {
    db::set_index_ready(conn, false)?;
    conn.execute("DELETE FROM source_index_state", [])?;
    Ok(reconcile::reconcile_vault(conn, vault)?)
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
#[tauri::command(async)]
pub fn sweep_vault_thumbnails(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let vault = tab_layout(&state, &webview)?;
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
    if !state.is_open_root(vault.root()) {
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
        if !state.is_open_root(vault.root()) {
            return;
        }
        if let Err(error) = start_thumbnail_sweep(&self.app, &state, vault) {
            log::warn!("failed to start pending thumbnail sweep: {error}");
        }
    }
}

// ─── Shared initialization ──────────────────────────────────────────────────

/// Whether the open session `open` is still the space at `path`, so that
/// choosing `path` again may reuse it (`SPEC_AUDIT_FIXES.md`, Ф8, Г2.1).
///
/// The path alone proves nothing: the session outlives its folder, and
/// another space may stand at the path by now. Reusing the session then
/// served the lost space's index for the new one, and two seconds later the
/// folder watch found the wrong identity and declared the space unavailable
/// again, round after round. The session is reused only while its folder
/// passes the very test the folder watch applies
/// ([`crate::storage::root_guard::root_gone`]), so the two never disagree;
/// otherwise the choice takes the full opening path, which reads the
/// folder's own identity.
fn session_serves(open: &VaultLayout, path: &Path) -> bool {
    open.root() == path && !crate::storage::root_guard::root_gone(open)
}

/// The opened space's result when `space` already serves `path`: another tab
/// opened it, or it is chosen again. `None` when it must be opened afresh.
fn reuse_open_space(
    app: &AppHandle,
    state: &AppState,
    space: &OpenSpace,
    path: &str,
    total: Instant,
) -> Result<Option<VaultOpenResult>, CommandError> {
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    if let Some(ref vs) = *vault_state {
        if session_serves(&vs.vault, Path::new(path)) {
            let cached = (|| -> anyhow::Result<_> {
                let indexed: i64 = vs
                    .conn
                    .query_row("SELECT COUNT(*) FROM blocks", [], |row| row.get(0))?;
                let ready = db::index_is_ready(&vs.conn)?;
                Ok((usize::try_from(indexed)?, ready))
            })();
            let reusable = match cached {
                Ok(value) => Some(value),
                Err(error) if db::is_index_corruption(&error) => None,
                Err(error) => return Err(error.into()),
            };
            if let Some((indexed, ready)) = reusable {
                if ready {
                    state.freshness.mark_committed_snapshot_available(path);
                }
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
                append_startup_trace(app, "startup", "milestone=local_snapshot_opened");
                return Ok(Some(VaultOpenResult {
                    indexed,
                    errors: 0,
                    sync_in_progress: false,
                    derived_store_ready: ready,
                    bootstrapped_from_legacy: false,
                    migration_required: false,
                    thumbs_root: vs.vault.thumbs_dir().to_string_lossy().into_owned(),
                }));
            }
        }
    }
    Ok(None)
}

/// Open the space at `path`: expand the asset scope, create its folders,
/// open its index and publish the session into the space's owner
/// (SPEC_TABS.md, В7). A space already open, in this tab or another, is
/// shared rather than opened twice. Returns a lease on the space.
fn initialize_vault(
    app: &AppHandle,
    state: &AppState,
    path: &str,
    opening: SpaceOpening,
) -> Result<(SpaceLease, VaultOpenResult), CommandError> {
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    let total = Instant::now();
    append_startup_trace(app, "initialize_vault", &format!("start path={path}"));
    if let Some(open) = state.spaces.by_root(Path::new(path)) {
        let lease = state.spaces.lease(open.vault_id());
        if let Some(result) = reuse_open_space(app, state, lease.space(), path, total)? {
            return Ok((lease, result));
        }
    }

    let vault = resolve_runtime_vault_layout(app, Path::new(path), opening)?;
    let vault_id = layout_space_id(&vault).ok_or_else(|| {
        CommandError::Internal(format!("the space at {path} has no identity"))
    })?;
    let lease = state.spaces.lease(&vault_id);
    let space = Arc::clone(lease.space());
    let _opening = space
        .opening
        .lock()
        .map_err(|_| CommandError::Internal("space opening mutex poisoned".into()))?;
    // Another tab may have opened it while this one waited.
    if let Some(result) = reuse_open_space(app, state, &space, path, total)? {
        return Ok((lease, result));
    }
    let first_opening = space.root().is_none();
    append_startup_trace(
        app,
        "initialize_vault",
        &format!(
            "mkdir thumbs={} audio={}",
            vault.thumbs_dir().display(),
            vault.audio_dir().display()
        ),
    );
    // Opening the space starts a new cloud-wait session: Х17 reasons in
    // sessions, and a quiet one is itself a signal (Х21). A space leased
    // again within its grace period, or reopened after a move, continues the
    // session it has (SPEC_TABS.md, В9). Best effort.
    if first_opening {
        if let Err(error) = crate::storage::cloud_waits::begin_session(
            vault.derived_root(),
            &crate::util::now_iso8601(),
        ) {
            log::warn!("failed to open a cloud-wait session: {error:#}");
        }
    }
    let bootstrapped_thumbs_from_legacy = bootstrap_local_thumbs_from_legacy(&vault)?;

    // Create the synced vault metadata dir and the local derived caches.
    std::fs::create_dir_all(vault.thumbs_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create dirs: {e}")))?;
    std::fs::create_dir_all(vault.audio_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create dirs: {e}")))?;
    std::fs::create_dir_all(vault.mine_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create Mine metadata dir: {e}")))?;

    // The shared pre-B0 database may still belong to another running component.
    // Rebuild from documents in our own generation instead of copying its WAL.
    let bootstrapped_from_legacy = false;
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
    let (vault, conn, indexed) =
        db::open_vault_index(vault).map_err(|error| CommandError::Internal(error.to_string()))?;
    let root_watch_layout = vault.clone();
    let derived_store_ready = db::index_is_ready(&conn)?;
    let migration_required = !derived_store_ready;
    append_startup_trace(
        app,
        "initialize_vault",
        &format!(
            "db_open indexed={} elapsed_ms={}",
            indexed,
            db_started.elapsed().as_millis()
        ),
    );
    append_startup_trace(app, "startup", "milestone=local_snapshot_opened");

    // Prepare OS and database resources before the short publication boundary.
    let watcher_started = Instant::now();
    let prepared_watcher = match watch::start_watching(app, &vault) {
        Ok(w) => {
            append_startup_trace(
                app,
                "initialize_vault",
                &format!(
                    "watcher_started elapsed_ms={}",
                    watcher_started.elapsed().as_millis()
                ),
            );
            Some(w)
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
            None
        }
    };

    let thumbs_root = vault.thumbs_dir().to_string_lossy().into_owned();
    space.publish(VaultState { conn, vault }, prepared_watcher);
    // Switching away can miss watcher events for this vault. Every selection
    // therefore invalidates the in-memory clean generation; the existing local
    // snapshot remains readable while one background pass catches up.
    if derived_store_ready {
        state.freshness.mark_committed_snapshot_available(path);
    }
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
    // Videos finished while this space was not reachable come in now (Ф9).
    crate::source_video_download::adopt_kept_downloads(app.clone(), root_watch_layout);
    if space.claim_root_watch() {
        watch_space_root(app, Arc::clone(&space));
    }
    drop(_opening);

    Ok((
        lease,
        VaultOpenResult {
            indexed,
            errors: 0,
            sync_in_progress: false,
            derived_store_ready,
            bootstrapped_from_legacy,
            migration_required,
            thumbs_root,
        },
    ))
}

/// How often the open space's folder is checked for still being there.
const SPACE_ROOT_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// Watch the open space's folder itself (SPEC_VAULT_LIFECYCLE.md, П15, П30).
///
/// The file watcher reports what happens inside the folder; a rename of the
/// folder itself only looks like every file vanishing. One cheap check every
/// [`SPACE_ROOT_CHECK_INTERVAL`] asks the root guard whether the folder is
/// still this space. When it is not, the space is looked for beside its old
/// path by identity and reopened there, or the unavailable screen is shown.
///
/// The watch belongs to the open space and lives as long as it does
/// (SPEC_TABS.md, В9): a choice made in a tab never ends it, and following a
/// move or reporting a loss reaches only the tabs showing this space. The
/// tabs that chose another space meanwhile are not bound to it, so nothing
/// is reopened over their choice (`SPEC_AUDIT_FIXES.md`, В2.1).
fn watch_space_root(app: &AppHandle, space: Arc<OpenSpace>) {
    let host = AppSpaceRoot(app.clone());
    let spawned = std::thread::Builder::new()
        .name("space-root-watch".into())
        .spawn(move || loop {
            std::thread::sleep(SPACE_ROOT_CHECK_INTERVAL);
            if check_space_root(&host, &space) != RootWatch::Watching {
                return;
            }
        });
    if let Err(error) = spawned {
        log::warn!("cannot watch the space folder: {error}");
    }
}

/// What watching the open space's folder needs from the app. Tests stand in
/// for the windows and for opening a space.
trait SpaceRootHost {
    /// Where the space last seen at `path` stands now (Ф8, П30).
    fn locate(&self, path: &str) -> Located;
    /// Reopen `space` at `to`, recording its move from `from`, and tell the
    /// tabs showing it.
    fn reopen_moved(&self, space: &OpenSpace, from: &str, to: &str) -> Result<(), CommandError>;
    /// Tell the tabs showing `space` it is not there.
    fn announce_unavailable(&self, space: &OpenSpace, lost: &UnavailableVault);
}

/// The running app as the host of the watch.
struct AppSpaceRoot(AppHandle);

impl SpaceRootHost for AppSpaceRoot {
    fn locate(&self, path: &str) -> Located {
        locate_saved_space(&self.0, path)
    }

    fn reopen_moved(&self, space: &OpenSpace, from: &str, to: &str) -> Result<(), CommandError> {
        let state = self.0.state::<AppState>();
        record_moved_space(&self.0, from, to);
        let to = canonical_space_path(to)?;
        // The same identity leases the same owner, which takes the session
        // at the new folder; the tabs keep their own leases.
        let (lease, _) = initialize_vault(&self.0, &state, &to, SpaceOpening::Restored)?;
        drop(lease);
        if load_saved_vault_path(&self.0)
            .is_some_and(|saved| crate::space_registry::same_path(&saved, from))
        {
            save_vault_path(&self.0, &to);
        }
        space_events::emit_to_space_and_settings(
            &self.0,
            space.vault_id(),
            "space-moved",
            SpaceMovedPayload {
                vault_id: space.vault_id().to_string(),
                path: to,
            },
        );
        Ok(())
    }

    fn announce_unavailable(&self, space: &OpenSpace, lost: &UnavailableVault) {
        space_events::emit_to_space_and_settings(
            &self.0,
            space.vault_id(),
            "space-unavailable",
            lost.clone(),
        );
    }
}

/// `space-moved`: the space `vault_id` now lives at `path` (SPEC_TABS.md,
/// В73).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SpaceMovedPayload {
    pub vault_id: String,
    pub path: String,
}

/// What one look at the open space's folder decided.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RootWatch {
    /// The folder is there and is this space: keep watching.
    Watching,
    /// The space closed: the watch ends without acting.
    Retired,
    /// The space moved and opened at this path.
    Followed(String),
    /// The space is nowhere to be found, and its tabs were told.
    Unavailable,
}

/// One look at the folder of the open space.
fn check_space_root(host: &impl SpaceRootHost, space: &OpenSpace) -> RootWatch {
    if space.is_closed() {
        return RootWatch::Retired;
    }
    let Ok(layout) = space.layout() else {
        return RootWatch::Retired;
    };
    if !crate::storage::root_guard::root_gone(&layout) {
        return RootWatch::Watching;
    }
    handle_space_root_lost(host, space, &layout)
}

/// The open space's folder is gone or is another space now: follow the
/// space to where it moved, or report it unavailable to its tabs.
fn handle_space_root_lost(host: &impl SpaceRootHost, space: &OpenSpace, layout: &VaultLayout) -> RootWatch {
    let root = layout.root();
    let path = root.to_string_lossy().into_owned();
    log::warn!("space folder is no longer there: {path}");
    if let Located::Moved { path: moved, .. } = host.locate(&path) {
        match host.reopen_moved(space, &path, &moved) {
            Ok(()) => return RootWatch::Followed(moved),
            Err(error) => log::warn!("cannot reopen the moved space at {moved}: {error}"),
        }
    }
    if space.is_closed() {
        return RootWatch::Retired;
    }
    let lost = UnavailableVault {
        reason: unavailable_reason(root).unwrap_or(UnavailableVaultReason::Missing),
        vault_id: layout_space_id(layout),
        path,
    };
    host.announce_unavailable(space, &lost);
    RootWatch::Unavailable
}

/// The identity of the space `layout` serves, from the derived store named
/// after it; readable after the folder itself is gone.
fn layout_space_id(layout: &VaultLayout) -> Option<String> {
    layout
        .derived_root()
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| crate::space_registry::is_space_id(name))
        .map(str::to_string)
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
            let Ok(_write)=crate::storage::source_mutation::begin_write() else {return;};
            let vault =
                match resolve_runtime_vault_layout(
                    &app_for_thread,
                    Path::new(&path_for_thread),
                    SpaceOpening::Restored,
                ) {
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
            let (mut vault, mut conn) = match db::open_vault_index(vault.clone()) {
                Ok((selected, conn, _)) => {
                    if let Err(error) = super::state::adopt_recovered_projection(&app_for_thread, &vault, selected.clone(), ()) {
                        log::warn!("backfill index adoption skipped: {error}");
                        return;
                    }
                    (selected, conn)
                }
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
            if let Some(recovered) = freshness.recovered_vault {
                if let Err(error) = super::state::adopt_recovered_projection(&app_for_thread, &vault, recovered.clone(), ()) {
                    log::warn!("backfill recovery adoption skipped: {error}");
                    return;
                }
                conn = match db::open_or_create(&recovered.index_db_path()) {
                    Ok(conn) => conn,
                    Err(error) => { log::warn!("backfill recovered index open failed: {error:#}"); return; }
                };
                vault = recovered;
            }
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
            // A staging directory may only belong to a save happening right
            // now, so anything older is a leftover from a crash between the
            // upload and the card. Age is the whole test: the previous sweep
            // asked whether the card's media still existed in the vault, which
            // made the cache keep copies of files the user had deleted, for
            // ever. Failure is never fatal — this only reclaims disk space.
            // Existing vaults have full thumbnails and no levels; the graph
            // and the sidebar read levels now. One pass writes what is
            // missing, and later launches only walk the directory. The same
            // pass rewrites levels that predate rule П6 and lost the alpha of
            // a text placeholder — those exist, so nothing else would.
            let filled = thumbnails::backfill_thumb_levels(&vault);
            if filled > 0 {
                log::info!("wrote thumbnail levels for {} cards in {}", filled, path_for_thread);
                append_startup_trace(
                    &app_for_thread,
                    "thumb_level_backfill",
                    &format!("written={} path={}", filled, path_for_thread),
                );
            }

            match clipper_uploads::sweep_stale_pending_uploads(
                &vault,
                clipper_uploads::STALE_UPLOAD_AGE,
            ) {
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
            crate::commands::space_events::emit_to_space_path(
                &app_for_thread,
                &path,
                "vault-changed",
                VaultChangedPayload::from_outside(path_for_thread.clone()),
            );
        });
}

/// Create a callback that emits "vault-changed" when background thumbnails finish.
fn thumbs_done_cb(app: AppHandle, path: String) -> Box<dyn FnOnce() + Send> {
    Box::new(move || {
        if !app.state::<AppState>().is_open_root(Path::new(&path)) {
            return;
        }
        log::info!("background thumbnails done, notifying frontend");
        crate::commands::space_events::emit_to_space_path(&app, &path.clone(), "vault-changed", VaultChangedPayload::from_outside(path));
    })
}

fn start_background_sync(app: AppHandle, path: String) -> Result<bool, CommandError> {
    let write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
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
            let _write = write;
            let total = Instant::now();
            let vault =
                match resolve_runtime_vault_layout(
                    &app_for_thread,
                    Path::new(&path_for_thread),
                    SpaceOpening::Restored,
                ) {
                    Ok(vault) => vault,
                    Err(err) => {
                        log::error!(
                            "failed to resolve runtime vault layout for {}: {}",
                            path_for_thread,
                            err
                        );
                        crate::commands::space_events::emit_to_space_path(
                            &app_for_thread,
                            &path_for_thread,
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
            crate::commands::space_events::emit_to_space_path(
                &app_for_thread,
                &path_for_thread,
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

            let mut vault = match db::open_vault_index(vault.clone()) {
                Ok((selected, conn, _)) => {
                    drop(conn);
                    if let Err(error) = super::state::adopt_recovered_projection(
                        &app_for_thread,
                        &vault,
                        selected.clone(),
                        (),
                    ) {
                        log::warn!("sync index adoption skipped: {error}");
                        let _ = app_for_thread
                            .state::<AppState>()
                            .abort_sync(&path_for_thread);
                        return;
                    }
                    selected
                }
                Err(err) => {
                    log::error!("failed to open db for sync {}: {:#}", path_for_thread, err);
                    append_startup_trace(
                        &app_for_thread,
                        "vault_sync_thread",
                        &format!("db_open_failed path={} err={:#}", path_for_thread, err),
                    );
                    crate::commands::space_events::emit_to_space_path(
                        &app_for_thread,
                        &path_for_thread,
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
                // Numbers instead of an endless spinner (О13): every 25th
                // file and the final one — enough for a live bar, cheap
                // enough to be free on small spaces.
                let emit_progress =
                    sync_progress_emitter(&app_for_thread, path_for_thread.clone());
                let outcome = sync_state
                    .freshness
                    .reconcile_with_progress(&vault, &emit_progress);
                if let Some(recovered) = outcome.recovered_vault {
                    if let Err(error) = super::state::adopt_recovered_projection(
                        &app_for_thread,
                        &vault,
                        recovered.clone(),
                        (),
                    ) {
                        break Err(error);
                    }
                    vault = recovered;
                }
                let result = match outcome.result {
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
                    if let Some(space) = sync_state.spaces.by_root(vault.root()) {
                        space.mark_opening_synced();
                    }
                    // Reconciliation reads source documents into the index.
                    // Never recreate documents from cached channel rows here:
                    // doing so duplicates nested collections and resurrects deletions.
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
                    crate::commands::space_events::emit_to_space_path(
                        &app_for_thread,
                        &path_for_thread,
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
                    crate::commands::space_events::emit_to_space_path(
                        &app_for_thread,
                        &path_for_thread,
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

fn resolve_runtime_vault_layout(
    app: &AppHandle,
    root: &Path,
    opening: SpaceOpening,
) -> Result<VaultLayout, CommandError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Internal(format!("failed to resolve app data dir: {e}")))?;
    resolve_space_layout(&crate::space_registry::vaults_dir(&app_data), root, opening)
}

/// The layout of the space at `root`, its derived store under `vaults_dir`
/// and its index slot. A space the person chose may be created here; a
/// space the app restores must already carry its identity.
fn resolve_space_layout(
    vaults_dir: &Path,
    root: &Path,
    opening: SpaceOpening,
) -> Result<VaultLayout, CommandError> {
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    let base = VaultLayout::new(root.to_path_buf());
    let mut vault_id = match opening {
        SpaceOpening::Chosen => {
            initialize_new_space_layout(&base)?;
            std::fs::create_dir_all(base.mine_dir()).map_err(|e| {
                CommandError::Internal(format!("failed to create Mine metadata dir: {e}"))
            })?;
            ensure_vault_id(&base)?
        }
        SpaceOpening::Restored => existing_vault_id(&base)?.ok_or_else(|| {
            CommandError::Internal(format!(
                "{} holds no space identity; only choosing the folder makes it a space",
                root.display()
            ))
        })?,
    };
    let derived_root = vaults_dir.join(&vault_id);

    // A copied folder carries the original's identity (П22): the id travels
    // in `.mine/vault-id`, so two folders now claim one derived store, and
    // both would silently write into one index and one cache. The recorded
    // owner path settles it: the same space alive there — this is a copy and
    // it gets its own identity; no such space there — this is the same space
    // after a move, and it inherits everything. The app may wait for iCloud
    // to tell; an identity it still cannot read decides nothing.
    match identity_claim(root, &derived_root, &vault_id, CloudRead::Wait) {
        IdentityClaim::Undecided { owner, cause } => Err(CommandError::Internal(format!(
            "cannot tell whether {} is the space last opened at {} or a copy of it: {cause}",
            root.display(),
            owner.display()
        ))),
        IdentityClaim::Owned | IdentityClaim::Adopted => {
            record_owner_path(&derived_root, root);
            let write_layout = load_write_layout(&base)?;
            db::resolve_vault_index(
                VaultLayout::with_derived_root(root.to_path_buf(), derived_root)
                    .with_write_layout(write_layout),
            )
            .map_err(|error| CommandError::Internal(error.to_string()))
        }
        IdentityClaim::Copy { owner } => {
            let new_id = generate_vault_id()?;
            files::write_atomically(&base.vault_id_path(), format!("{new_id}\n").as_bytes())
                .map_err(|e| {
                    CommandError::Internal(format!(
                        "failed to write the copy's own vault-id: {e:#}"
                    ))
                })?;
            log::info!(
                "space at {} is a copy of {} — minted its own identity {}",
                root.display(),
                owner.display(),
                new_id
            );
            vault_id = new_id;
            let fresh_derived = vaults_dir.join(&vault_id);
            record_owner_path(&fresh_derived, root);
            let write_layout = load_write_layout(&base)?;
            db::resolve_vault_index(
                VaultLayout::with_derived_root(root.to_path_buf(), fresh_derived)
                    .with_write_layout(write_layout),
            )
            .map_err(|error| CommandError::Internal(error.to_string()))
        }
    }
}

/// The first connection of an empty folder creates a new space. A folder with
/// user content, a vault identity, or a saved layout is an existing space and
/// never gets a layout inferred from its directory names.
pub(crate) fn initialize_new_space_layout(vault: &VaultLayout) -> Result<(), CommandError> {
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    if vault.vault_id_path().exists()
        || vault.legacy_vault_id_path().exists()
        || vault.write_layout_path().exists()
    {
        return Ok(());
    }
    let empty = std::fs::read_dir(vault.root())
        .map_err(|e| CommandError::Internal(format!("failed to inspect space: {e}")))?
        .try_fold(true, |empty, entry| {
            let entry = entry.map_err(|e| CommandError::Internal(e.to_string()))?;
            Ok::<bool, CommandError>(empty && entry.file_name().to_string_lossy().starts_with('.'))
        })?;
    if !empty {
        return Ok(());
    }
    let standard = VaultWriteLayout::standard();
    for folder in [&standard.cards, &standard.media, &standard.collections] {
        std::fs::create_dir_all(vault.root().join(folder))
            .map_err(|e| CommandError::Internal(format!("failed to create {folder}: {e}")))?;
    }
    save_write_layout(vault, &standard)
}

/// Use the same strict layout reader as capture and CLI; invalid settings
/// must not silently redirect writes to a different folder.
fn load_write_layout(vault: &VaultLayout) -> Result<VaultWriteLayout, CommandError> {
    files::load_vault_write_layout(vault)
        .map_err(|error| CommandError::Internal(format!("invalid write layout: {error:#}")))
}

fn save_write_layout(vault: &VaultLayout, layout: &VaultWriteLayout) -> Result<(), CommandError> {
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
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
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    if let Some(existing) = existing_vault_id(vault)? {
        return Ok(existing);
    }
    let new_id = generate_vault_id()?;
    files::write_atomically(&vault.vault_id_path(), format!("{new_id}\n").as_bytes())
        .map_err(|e| CommandError::Internal(format!("failed to write vault-id: {e:#}")))?;
    Ok(new_id)
}

/// The identity the space already carries, moved from the legacy `.arena`
/// marker when only that one is there. Never mints one. An identity file
/// still in iCloud is waited for; one that cannot be read even then refuses
/// the open, and nothing is written over it (`SPEC_AUDIT_FIXES.md`, Д2.1).
fn existing_vault_id(vault: &VaultLayout) -> Result<Option<String>, CommandError> {
    let unreadable = |cause: crate::space_registry::IdentityUnreadable| {
        log::warn!("space at {} not opened: {cause}", vault.root().display());
        CommandError::SpaceIdentityUnreadable {
            path: vault.root().to_string_lossy().into_owned(),
        }
    };
    let path = vault.vault_id_path();
    if let Some(existing) = read_identity_file(&path, CloudRead::Wait).map_err(unreadable)? {
        return Ok(Some(existing));
    }
    let legacy = read_identity_file(&vault.legacy_vault_id_path(), CloudRead::Wait)
        .map_err(unreadable)?;
    let Some(legacy) = legacy else {
        return Ok(None);
    };
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    std::fs::create_dir_all(vault.mine_dir())
        .map_err(|e| CommandError::Internal(format!("failed to create Mine metadata dir: {e}")))?;
    files::write_atomically(&path, format!("{legacy}\n").as_bytes())
        .map_err(|e| CommandError::Internal(format!("failed to migrate vault-id to .mine: {e:#}")))?;
    Ok(Some(legacy))
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

fn bootstrap_local_thumbs_from_legacy(vault: &VaultLayout) -> Result<bool, CommandError> {
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
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

// ─── Config persistence ─────────────────────────────────────────────────────

/// The app settings file, through its one owner (SPEC_VAULT_LIFECYCLE.md, П28).
pub(crate) fn app_config(app: &AppHandle) -> Option<crate::app_config::AppConfig> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| crate::app_config::AppConfig::in_dir(&dir))
}

/// The settings for reading. An unreadable file reads as empty here, which
/// is safe because nothing written goes through this value: every change
/// goes through [`update_config`], which refuses to write over it.
pub(crate) fn load_config(app: &AppHandle) -> serde_json::Value {
    let Some(config) = app_config(app) else {
        return serde_json::json!({});
    };
    match config.read() {
        Ok(map) => serde_json::Value::Object(map),
        Err(error) => {
            log::warn!("{error}");
            serde_json::json!({})
        }
    }
}

/// Change the settings: only the fields `change` touches, under the shared
/// lock, never over a file that cannot be read.
pub(crate) fn update_config<T>(
    app: &AppHandle,
    change: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> T,
) -> Result<T, CommandError> {
    let config = app_config(app)
        .ok_or_else(|| CommandError::Internal("app data directory is unavailable".into()))?;
    config
        .update(change)
        .map_err(|error| CommandError::Internal(error.to_string()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// Record the opened space in the registry, by its identity (П16, П26).
fn save_vault_path(app: &AppHandle, path: &str) {
    let id = crate::space_registry::read_space_id(Path::new(path));
    let now = now_ms();
    let result = update_config(app, |cfg| match &id {
        Some(id) => crate::space_registry::record_open(cfg, id, path, now),
        None => crate::space_registry::record_path_only(cfg, path),
    });
    if let Err(error) = result {
        log::warn!("failed to record the opened space {path}: {error}");
    }
}

/// Load the saved vault path from the config file.
fn load_saved_vault_path(app: &AppHandle) -> Option<String> {
    let serde_json::Value::Object(cfg) = load_config(app) else {
        return None;
    };
    crate::space_registry::current_path(&cfg)
}

/// The spaces that can be opened right now, canonical and without repeats.
pub(crate) fn load_known_vaults(app: &AppHandle) -> Vec<String> {
    let serde_json::Value::Object(cfg) = load_config(app) else {
        return Vec::new();
    };
    let mut unique: Vec<String> = Vec::new();
    for status in crate::space_registry::statuses_in(&cfg, derived_stores_dir(app).as_deref()) {
        if !status.available {
            continue;
        }
        if let Ok(canonical) = canonical_space_path(&status.record.path) {
            if !unique.contains(&canonical) {
                unique.push(canonical);
            }
        }
    }
    unique
}

/// Bring spaces lost from the list back from their derived stores (П27),
/// and follow a space renamed beside its old path (П30). Runs before the
/// saved space is resolved at startup; both are no-ops when nothing is lost.
fn repair_space_registry(app: &AppHandle) {
    let Some(config) = app_config(app) else {
        return;
    };
    let vaults_dir = crate::space_registry::vaults_dir(config.app_data_dir());
    let recover = || {
        config.update(|cfg| crate::space_registry::recover_from_derived_stores(cfg, &vaults_dir))
    };
    // Damaged settings are set aside by the first attempt, which then starts
    // over from clean ones: the list comes back in this launch, not the next
    // (SPEC_AUDIT_FIXES.md, А6.6).
    let outcome = match recover() {
        Err(crate::app_config::AppConfigError::Damaged { kept, .. }) => {
            log::warn!("damaged settings kept at {}; recovering the space list", kept.display());
            recover()
        }
        other => other,
    };
    match outcome {
        Ok(0) => {}
        Ok(added) => log::info!("recovered {added} space(s) from their derived stores"),
        Err(error) => log::warn!("space registry recovery skipped: {error}"),
    }
}

/// The saved space was found under another path: that path becomes the one
/// to open next time too. The record that stood for it at `from` follows it,
/// a record without an identity included, which learns it from the folder
/// the space was found in: finding it there proved it (В2.2).
fn record_moved_space(app: &AppHandle, from: &str, to: &str) {
    let recorded = match load_config(app) {
        serde_json::Value::Object(cfg) => {
            crate::space_registry::record_at(&cfg, from).and_then(|record| record.vault_id)
        }
        _ => None,
    };
    let Some(id) = recorded.or_else(|| crate::space_registry::read_space_id(Path::new(to))) else {
        return;
    };
    let now = now_ms();
    match update_config(app, |cfg| crate::space_registry::record_moved(cfg, &id, from, to, now)) {
        Ok(()) => log::info!("space {id} moved from {from} to {to}"),
        Err(error) => log::warn!("cannot record the move of space {id} to {to}: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_write_reports_failure_instead_of_claiming_success() {
        let root = tempfile::tempdir().unwrap();
        let valid = crate::app_config::AppConfig::in_dir(root.path());
        valid
            .update(|cfg| cfg.insert("shortcut_overrides".into(), serde_json::json!({})))
            .unwrap();
        assert!(valid.path().is_file());

        let blocked_parent = root.path().join("not_a_directory");
        std::fs::write(&blocked_parent, b"file").unwrap();
        let result = crate::app_config::AppConfig::in_dir(&blocked_parent)
            .update(|cfg| cfg.insert("shortcut_overrides".into(), serde_json::json!({})));
        assert!(result.is_err());
    }

    #[test]
    fn first_connection_initializes_only_an_empty_unidentified_space() {
        let root = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(root.path().to_path_buf());
        initialize_new_space_layout(&vault).unwrap();
        for folder in ["Cards", "Media", "Collections"] {
            assert!(root.path().join(folder).is_dir());
        }
        assert_eq!(
            load_write_layout(&vault).unwrap(),
            VaultWriteLayout::standard()
        );

        std::fs::remove_dir_all(root.path().join("Media")).unwrap();
        initialize_new_space_layout(&vault).unwrap();
        assert!(!root.path().join("Media").exists());
    }

    #[test]
    fn connecting_existing_content_does_not_infer_folders() {
        let root = tempfile::tempdir().unwrap();
        for folder in ["Cards", "Media", "Collections"] {
            std::fs::create_dir(root.path().join(folder)).unwrap();
        }
        let vault = VaultLayout::new(root.path().to_path_buf());
        initialize_new_space_layout(&vault).unwrap();
        assert!(!vault.write_layout_path().exists());
        assert_eq!(load_write_layout(&vault).unwrap(), VaultWriteLayout::flat());
    }

    #[cfg(unix)]
    #[test]
    fn aliases_identify_one_space_root() {
        let root = tempfile::tempdir().unwrap();
        let alias_parent = tempfile::tempdir().unwrap();
        let alias = alias_parent.path().join("alias");
        std::os::unix::fs::symlink(root.path(), &alias).unwrap();
        let canonical = canonical_space_path(root.path().to_str().unwrap()).unwrap();
        assert_eq!(
            canonical_space_path(alias.to_str().unwrap()).unwrap(),
            canonical
        );
        assert!(crate::space_registry::same_path(
            alias.to_str().unwrap(),
            root.path().to_str().unwrap()
        ));
        // A path-only record under the alias becomes the space's record.
        let other = tempfile::tempdir().unwrap();
        let mut cfg = serde_json::Map::new();
        cfg.insert(
            "known_vaults".into(),
            serde_json::json!([other.path().to_str().unwrap(), alias.to_str().unwrap()]),
        );
        crate::space_registry::record_open(&mut cfg, "cea575682e5a4018991c0097fbedff66", &canonical, 1);
        assert_eq!(
            cfg["known_vaults"],
            serde_json::json!([other.path().to_str().unwrap(), canonical])
        );
    }

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
        assert!(!db::index_is_ready(&conn).unwrap());
        let indexed = index::get_block(&conn, "Stable").unwrap().unwrap();
        assert_eq!(indexed.body.trim(), "old body");
    }

    #[test]
    fn reliability_explicit_rebuild_marks_incomplete_before_clear_failure() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::write(vault.block_path("Stable"), "stable source").unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        assert!(db::index_is_ready(&conn).unwrap());
        conn.execute_batch(
            "CREATE TRIGGER reject_state_clear BEFORE DELETE ON source_index_state
             BEGIN SELECT RAISE(ABORT, 'injected clear failure'); END;",
        )
        .unwrap();
        let error = rebuild_index_projection(&conn, &vault).unwrap_err();
        assert!(error.downcast_ref::<rusqlite::Error>().is_some());
        assert!(!db::is_index_corruption(&error));
        assert!(!db::index_is_ready(&conn).unwrap());
        assert_eq!(
            std::fs::read_to_string(vault.block_path("Stable")).unwrap(),
            "stable source"
        );
    }

    #[test]
    fn generation_selection_preserves_legacy_sqlite_files() {
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

        let selected = db::resolve_vault_index(vault.clone()).unwrap();
        assert!(selected.index_db_path().exists());
        assert_eq!(
            std::fs::read(vault.legacy_index_db_path()).unwrap(),
            b"legacy-db"
        );
        assert_eq!(
            std::fs::read(format!("{}-wal", vault.legacy_index_db_path().display())).unwrap(),
            b"legacy-wal"
        );
        assert_eq!(
            std::fs::read(format!("{}-shm", vault.legacy_index_db_path().display())).unwrap(),
            b"legacy-shm"
        );
        assert_eq!(
            db::resolve_vault_index(vault).unwrap().index_db_path(),
            selected.index_db_path()
        );
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
    fn selecting_generation_keeps_legacy_identity_cache_and_unknown_history() {
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

        db::resolve_vault_index(vault.clone()).unwrap();

        assert!(vault.legacy_vault_id_path().exists());
        assert!(vault.legacy_index_db_path().exists());
        assert!(vault.legacy_arena_dir().join("cache").exists());
        assert!(vault.legacy_arena_dir().join("conflicts-archive").exists());
    }
}

#[cfg(test)]
mod identity_claim_tests {
    use super::*;
    use crate::space_registry::{self, Located};

    const ID: &str = "cea575682e5a4018991c0097fbedff66";
    const OTHER: &str = "e7fc8f8bf1294aaa89f375ac9cfaf1b4";

    fn carry_identity(folder: &Path, id: &str) {
        std::fs::create_dir_all(folder.join(".mine")).unwrap();
        std::fs::write(folder.join(".mine/vault-id"), format!("{id}\n")).unwrap();
    }

    /// The copy rule as the app reads it: it may wait for iCloud.
    fn resolve_identity_claim(root: &Path, derived_root: &Path, vault_id: &str) -> IdentityClaim {
        identity_claim(root, derived_root, vault_id, CloudRead::Wait)
    }

    fn owner_recorded(derived_root: &Path) -> String {
        let raw = std::fs::read_to_string(space_registry::owner_path_file(derived_root)).unwrap();
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["path"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn derived_stores(vaults: &Path) -> Vec<String> {
        let mut ids: Vec<String> = std::fs::read_dir(vaults)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        ids.sort();
        ids
    }

    #[test]
    fn a_folder_owns_its_identity_and_a_move_adopts_it() {
        let derived = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let original = home.path().join("Mine");
        std::fs::create_dir(&original).unwrap();
        carry_identity(&original, ID);

        // Nothing recorded yet: the first open owns the identity.
        assert!(matches!(
            resolve_identity_claim(&original, derived.path(), ID),
            IdentityClaim::Owned
        ));
        record_owner_path(derived.path(), &original);
        assert!(matches!(
            resolve_identity_claim(&original, derived.path(), ID),
            IdentityClaim::Owned
        ));

        // The folder moved: the old path is gone, the identity follows it.
        let moved = home.path().join("Mine (archive)");
        std::fs::rename(&original, &moved).unwrap();
        assert!(matches!(
            resolve_identity_claim(&moved, derived.path(), ID),
            IdentityClaim::Adopted
        ));
    }

    #[test]
    fn a_live_original_makes_the_second_folder_a_copy() {
        let derived = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let original = home.path().join("Mine");
        let copy = home.path().join("Mine copy");
        carry_identity(&original, ID);
        carry_identity(&copy, ID);
        record_owner_path(derived.path(), &original);

        // The same space is alive at its recorded path: opening the twin is
        // a copy, not a move — it must not share the derived store (П22).
        match resolve_identity_claim(&copy, derived.path(), ID) {
            IdentityClaim::Copy { owner } => assert_eq!(owner, original),
            _ => panic!("a live original must make the twin a copy"),
        }
    }

    /// Д2.1: the folder where the store last served the space is there, but
    /// its identity cannot be read. Whether the second folder is a copy
    /// cannot be told: it is not opened on the original's store, and keeps
    /// its identity.
    #[test]
    fn an_original_whose_identity_cannot_be_read_never_lends_its_store() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let vaults = home.path().join("app/vaults");
        let original = home.path().join("Mine");
        let copy = home.path().join("Mine copy");
        carry_identity(&original, ID);
        carry_identity(&copy, ID);
        let first = resolve_space_layout(&vaults, &original, SpaceOpening::Restored).unwrap();
        let locked = original.join(".mine/vault-id");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let opened = resolve_space_layout(&vaults, &copy, SpaceOpening::Restored);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert!(opened.is_err(), "the copy opened on {:?}", opened.map(|vault| vault.derived_root().to_path_buf()));
        assert_eq!(owner_recorded(first.derived_root()), original.to_string_lossy());
        assert_eq!(space_registry::read_space_id(&copy).as_deref(), Some(ID));
        assert_eq!(derived_stores(&vaults), vec![ID.to_string()]);
    }

    /// Д2.1: choosing or reopening a folder whose identity file cannot be
    /// read refuses with a typed error; the file is never written over and
    /// no derived store is made.
    #[test]
    fn a_space_whose_identity_cannot_be_read_is_refused_and_never_given_another() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let vaults = home.path().join("app/vaults");
        let folder = home.path().join("Mine");
        carry_identity(&folder, ID);
        std::fs::write(folder.join("Card.md"), "A card.\n").unwrap();
        let id_file = folder.join(".mine/vault-id");
        let before = std::fs::read(&id_file).unwrap();
        std::fs::set_permissions(&id_file, std::fs::Permissions::from_mode(0o000)).unwrap();
        let entries = |folder: &Path| {
            let mut names: Vec<String> = std::fs::read_dir(folder)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };
        let listed = entries(&folder);

        let refusals: Vec<_> = [SpaceOpening::Chosen, SpaceOpening::Restored]
            .into_iter()
            .map(|opening| resolve_space_layout(&vaults, &folder, opening).err())
            .collect();
        let mode = std::fs::metadata(&id_file).unwrap().permissions().mode() & 0o777;
        std::fs::set_permissions(&id_file, std::fs::Permissions::from_mode(0o644)).unwrap();

        let path = folder.to_string_lossy().into_owned();
        for refused in refusals {
            assert!(
                matches!(&refused, Some(CommandError::SpaceIdentityUnreadable { path: named }) if *named == path),
                "{refused:?}"
            );
        }
        assert_eq!(mode, 0, "the identity file was replaced");
        assert_eq!(std::fs::read(&id_file).unwrap(), before);
        assert_eq!(entries(&folder), listed);
        assert!(!vaults.exists(), "a derived store was made");
    }

    #[test]
    fn a_folder_at_the_old_path_without_the_identity_is_no_original() {
        // Б2.1: after a rename, an empty folder with the old name, or another
        // space moved in under it, does not make the moved space a copy.
        let derived = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let old = home.path().join("Mine");
        let moved = home.path().join("Mine renamed");
        carry_identity(&moved, ID);
        record_owner_path(derived.path(), &old);

        std::fs::create_dir(&old).unwrap();
        assert!(matches!(
            resolve_identity_claim(&moved, derived.path(), ID),
            IdentityClaim::Adopted
        ));
        carry_identity(&old, OTHER);
        assert!(matches!(
            resolve_identity_claim(&moved, derived.path(), ID),
            IdentityClaim::Adopted
        ));
    }

    #[test]
    fn a_space_moved_while_mine_was_closed_keeps_its_identity_beside_an_empty_folder() {
        // Б2.1: quit Mine, rename A to B, create an empty A, launch.
        let home = tempfile::tempdir().unwrap();
        let vaults = home.path().join("app/vaults");
        let a = home.path().join("A");
        let b = home.path().join("B");
        std::fs::create_dir(&a).unwrap();
        carry_identity(&a, ID);
        std::fs::write(a.join("Card.md"), "A card.\n").unwrap();
        let a_path = a.to_string_lossy().into_owned();
        let b_path = b.to_string_lossy().into_owned();
        let first = resolve_space_layout(&vaults, &a, SpaceOpening::Chosen).unwrap();
        let mut cfg = serde_json::Map::new();
        space_registry::record_open(&mut cfg, ID, &a_path, 1);

        std::fs::rename(&a, &b).unwrap();
        std::fs::create_dir(&a).unwrap();

        // Launch: the saved path no longer holds the space; it is found at B.
        let found = space_registry::locate_saved(&cfg, Some(&vaults), &a_path);
        assert_eq!(found, Located::Moved { from: a_path.clone(), path: b_path.clone() });
        space_registry::record_open(&mut cfg, ID, &b_path, 2);
        // The app opens B: the same identity and the same derived store.
        assert_eq!(
            space_registry::locate_saved(&cfg, Some(&vaults), &b_path),
            Located::Here { path: b_path.clone() }
        );
        let opened = resolve_space_layout(&vaults, &b, SpaceOpening::Restored).unwrap();
        assert_eq!(space_registry::read_space_id(&b).as_deref(), Some(ID));
        assert_eq!(opened.derived_root(), first.derived_root());
        assert_eq!(opened.index_db_path(), first.index_db_path());
        assert_eq!(derived_stores(&vaults), vec![ID.to_string()]);
        assert_eq!(owner_recorded(opened.derived_root()), b_path);
        let records = space_registry::records(&cfg);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].vault_id.as_deref(), Some(ID));
        assert_eq!(records[0].path, b_path);
        // The empty folder at A is left as it was.
        assert_eq!(std::fs::read_dir(&a).unwrap().count(), 0);

        // The next launch opens B again, in place.
        assert_eq!(
            space_registry::locate_saved(&cfg, Some(&vaults), &b_path),
            Located::Here { path: b_path.clone() }
        );
        let again = resolve_space_layout(&vaults, &b, SpaceOpening::Restored).unwrap();
        assert_eq!(again.derived_root(), first.derived_root());
        assert_eq!(derived_stores(&vaults), vec![ID.to_string()]);
    }

    #[test]
    fn an_old_listing_never_turns_an_empty_folder_into_a_space() {
        // Б2.2: settings from before the registry list A; the space X opened
        // there is now B, and A is an empty folder. The launch finds X at B;
        // A gets no identity and no folders.
        let home = tempfile::tempdir().unwrap();
        let vaults = home.path().join("app/vaults");
        let a = home.path().join("A");
        let b = home.path().join("B");
        std::fs::create_dir(&a).unwrap();
        carry_identity(&a, ID);
        let first = resolve_space_layout(&vaults, &a, SpaceOpening::Chosen).unwrap();
        std::fs::rename(&a, &b).unwrap();
        std::fs::create_dir(&a).unwrap();
        let a_path = a.to_string_lossy().into_owned();
        let b_path = b.to_string_lossy().into_owned();
        let mut cfg = serde_json::Map::new();
        cfg.insert("known_vaults".into(), serde_json::json!([a_path.clone()]));
        cfg.insert("vault_path".into(), serde_json::json!(a_path.clone()));

        assert_eq!(
            space_registry::locate_saved(&cfg, Some(&vaults), &a_path),
            Located::Moved { from: a_path.clone(), path: b_path.clone() }
        );
        let opened = resolve_space_layout(&vaults, &b, SpaceOpening::Restored).unwrap();
        assert_eq!(opened.derived_root(), first.derived_root());
        // Even asked directly, reopening A does not make it a space.
        assert!(resolve_space_layout(&vaults, &a, SpaceOpening::Restored).is_err());
        assert_eq!(std::fs::read_dir(&a).unwrap().count(), 0);
        assert_eq!(derived_stores(&vaults), vec![ID.to_string()]);
    }

    /// Г2.1: space A was open at P. A's folder was deleted and space B now
    /// stands at P; the person chooses P. A's session must not be reused: P
    /// opens as B, with B's own derived store, and the folder watch then
    /// finds the space it expects there.
    #[test]
    fn choosing_a_path_another_space_took_opens_that_space_not_the_old_session() {
        let home = tempfile::tempdir().unwrap();
        let vaults = home.path().join("app/vaults");
        let p = home.path().join("P");
        std::fs::create_dir(&p).unwrap();
        carry_identity(&p, ID);
        let session_a = resolve_space_layout(&vaults, &p, SpaceOpening::Chosen).unwrap();
        assert!(session_serves(&session_a, &p), "A, still at P, reuses its session");

        std::fs::remove_dir_all(&p).unwrap();
        std::fs::create_dir(&p).unwrap();
        carry_identity(&p, OTHER);

        assert!(!session_serves(&session_a, &p), "A's session was reused for B");
        let opened = resolve_space_layout(&vaults, &p, SpaceOpening::Chosen).unwrap();
        assert_eq!(opened.derived_root(), vaults.join(OTHER));
        assert_ne!(opened.index_db_path(), session_a.index_db_path());
        assert!(session_serves(&opened, &p));
        assert!(!crate::storage::root_guard::root_gone(&opened));

        // A's folder deleted and nothing at P: no session to reuse either.
        std::fs::remove_dir_all(&p).unwrap();
        assert!(!session_serves(&session_a, &p));
    }

    #[test]
    fn only_a_chosen_folder_becomes_a_new_space() {
        let home = tempfile::tempdir().unwrap();
        let vaults = home.path().join("app/vaults");
        let folder = home.path().join("New");
        std::fs::create_dir(&folder).unwrap();

        assert!(resolve_space_layout(&vaults, &folder, SpaceOpening::Restored).is_err());
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);

        let chosen = resolve_space_layout(&vaults, &folder, SpaceOpening::Chosen).unwrap();
        let id = space_registry::read_space_id(&folder).expect("a chosen folder gets an identity");
        assert_eq!(chosen.derived_root(), vaults.join(&id));
        for name in ["Cards", "Media", "Collections"] {
            assert!(folder.join(name).is_dir());
        }
    }
}

#[cfg(test)]
mod unavailable_reason_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn missing_locked_and_fine_are_three_different_answers() {
        let dir = tempfile::tempdir().unwrap();

        // Readable: not unavailable at all.
        assert_eq!(unavailable_reason(dir.path()), None);

        // Gone: missing.
        assert_eq!(
            unavailable_reason(&dir.path().join("nowhere")),
            Some(UnavailableVaultReason::Missing)
        );

        // Present but unreadable: an access problem, not a missing folder.
        let locked = dir.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let reason = unavailable_reason(&locked);
        // Restore before asserting so a failure does not strand an
        // undeletable temp dir.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(reason, Some(UnavailableVaultReason::AccessDenied));
    }
}

#[cfg(test)]
mod space_onboarding_tests {
    use super::onboarding_owed;

    #[test]
    fn onboarding_leaves_with_the_first_card_and_never_returns() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("derived");

        // A new space: nothing indexed, nothing recorded.
        assert!(onboarding_owed(&root, 0).unwrap());
        assert!(onboarding_owed(&root, 0).unwrap());

        // The first card arrives.
        assert!(!onboarding_owed(&root, 1).unwrap());

        // Every card deleted: an empty feed, not a new space (О15).
        assert!(!onboarding_owed(&root, 0).unwrap());
    }
}

#[cfg(test)]
mod space_root_watch_tests {
    use super::*;
    use crate::commands::state::SpaceHost;
    use crate::space_registry::{Located, LostReason};
    use std::time::Duration;

    const ID: &str = "cea575682e5a4018991c0097fbedff66";

    fn carry_identity(folder: &Path, id: &str) {
        std::fs::create_dir_all(folder.join(".mine")).unwrap();
        std::fs::write(folder.join(".mine/vault-id"), format!("{id}\n")).unwrap();
    }

    /// The app around the watch of an open space's folder: a fixed answer
    /// to where the space went, and the openings and reports it asked for.
    struct RootHost {
        located: Located,
        reopened: std::cell::RefCell<Vec<(String, String, String)>>,
        announced: std::cell::RefCell<Vec<(String, UnavailableVault)>>,
    }

    impl RootHost {
        fn new(located: Located) -> Self {
            Self {
                located,
                reopened: std::cell::RefCell::default(),
                announced: std::cell::RefCell::default(),
            }
        }
    }

    impl SpaceRootHost for RootHost {
        fn locate(&self, _path: &str) -> Located {
            self.located.clone()
        }

        fn reopen_moved(&self, space: &OpenSpace, from: &str, to: &str) -> Result<(), CommandError> {
            self.reopened.borrow_mut().push((
                space.vault_id().to_string(),
                from.to_string(),
                to.to_string(),
            ));
            Ok(())
        }

        fn announce_unavailable(&self, space: &OpenSpace, lost: &UnavailableVault) {
            self.announced
                .borrow_mut()
                .push((space.vault_id().to_string(), lost.clone()));
        }
    }

    /// Space A open under `host`, its folder at `dir/A`.
    fn open_space_a(host: &SpaceHost, dir: &Path) -> (SpaceLease, String, String) {
        let root = dir.join("A");
        let moved = dir.join("A renamed").to_string_lossy().into_owned();
        let layout = VaultLayout::with_derived_root(root.clone(), dir.join("vaults").join(ID));
        let lease = host.lease(ID);
        lease.space().publish(
            VaultState {
                conn: db::open_memory().unwrap(),
                vault: layout,
            },
            None,
        );
        (lease, root.to_string_lossy().into_owned(), moved)
    }

    #[test]
    fn the_watch_follows_a_move_for_the_space_that_moved() {
        // SPEC_TABS.md, В9: the watch belongs to the open space; following a
        // move reopens that space, whichever tabs show it.
        let dir = tempfile::tempdir().unwrap();
        let spaces = SpaceHost::with_grace(Duration::from_millis(20));
        let (lease, a, moved) = open_space_a(&spaces, dir.path());
        let host = RootHost::new(Located::Moved { from: a.clone(), path: moved.clone() });

        assert_eq!(check_space_root(&host, lease.space()), RootWatch::Followed(moved.clone()));
        assert_eq!(*host.reopened.borrow(), vec![(ID.to_string(), a, moved)]);
        assert!(host.announced.borrow().is_empty());
    }

    #[test]
    fn a_lost_space_is_reported_to_its_own_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let spaces = SpaceHost::with_grace(Duration::from_millis(20));
        let (lease, a, _) = open_space_a(&spaces, dir.path());
        let host = RootHost::new(Located::Lost { path: a.clone(), reason: LostReason::Missing });

        assert_eq!(check_space_root(&host, lease.space()), RootWatch::Unavailable);
        assert_eq!(
            *host.announced.borrow(),
            vec![(
                ID.to_string(),
                UnavailableVault {
                    path: a,
                    reason: UnavailableVaultReason::Missing,
                    vault_id: Some(ID.to_string()),
                }
            )]
        );
    }

    #[test]
    fn a_closed_space_ends_its_watch_without_acting() {
        // В2.1 in a world of tabs: a space nobody shows any more is never
        // reopened after a move nor reported lost.
        let dir = tempfile::tempdir().unwrap();
        let spaces = SpaceHost::with_grace(Duration::from_millis(10));
        let (lease, _, moved) = open_space_a(&spaces, dir.path());
        let space = std::sync::Arc::clone(lease.space());
        drop(lease);
        std::thread::sleep(Duration::from_millis(80));
        let host = RootHost::new(Located::Moved { from: String::new(), path: moved });

        assert_eq!(check_space_root(&host, &space), RootWatch::Retired);
        assert!(host.reopened.borrow().is_empty());
        assert!(host.announced.borrow().is_empty());
    }

    #[test]
    fn a_folder_still_there_keeps_being_watched() {
        let dir = tempfile::tempdir().unwrap();
        let spaces = SpaceHost::with_grace(Duration::from_millis(20));
        let (lease, a, _) = open_space_a(&spaces, dir.path());
        carry_identity(Path::new(&a), ID);
        let host = RootHost::new(Located::Here { path: a });
        assert_eq!(check_space_root(&host, lease.space()), RootWatch::Watching);
        assert!(host.announced.borrow().is_empty());
    }
}
