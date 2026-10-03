// Shared application ownership for Tauri commands.
//
// Stateful workers live in dedicated coordinator modules. AppState composes
// them with the open spaces, the tabs bound to them, sync and suppression
// ownership (SPEC_TABS.md, В7 по В14).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;
use tauri::Manager;
use thiserror::Error;

pub use super::freshness::ensure_vault_fresh;
use super::freshness::FreshnessCoordinator;
pub use super::preview_reconcile::schedule_preview_reconcile;
use super::preview_reconcile::PreviewReconcileCoordinator;
pub use super::spaces::{OpenSpace, SpaceHost, SpaceLease, TabRegistry};
pub use super::thumbnail_sweeps::SweepGuard;
use super::thumbnail_sweeps::ThumbnailSweepCoordinator;
use crate::domain::vault::VaultLayout;
use crate::util::SingleInstanceGuard;
use crate::watcher::watch::VaultWatcher;

pub struct VaultState {
    pub conn: Connection,
    pub vault: VaultLayout,
}

#[derive(Default)]
pub struct SyncTracker {
    syncing_vaults: HashSet<String>,
    dirty_during_sync: HashSet<String>,
}

pub struct AppState {
    /// Every space open in the process (SPEC_TABS.md, В7).
    pub spaces: SpaceHost,
    /// Which space each tab shows (SPEC_TABS.md, В10).
    pub tabs: TabRegistry,
    pub instance_guard: Mutex<Option<SingleInstanceGuard>>,
    pub sync_tracker: Mutex<SyncTracker>,
    pub suppressed_paths: Mutex<HashMap<PathBuf, Instant>>,
    thumbnail_sweeps: ThumbnailSweepCoordinator,
    pub freshness: FreshnessCoordinator,
    pub(crate) preview_reconcile: PreviewReconcileCoordinator,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            spaces: SpaceHost::default(),
            tabs: TabRegistry::default(),
            instance_guard: Mutex::new(None),
            sync_tracker: Mutex::new(SyncTracker::default()),
            suppressed_paths: Mutex::new(HashMap::new()),
            thumbnail_sweeps: ThumbnailSweepCoordinator::default(),
            freshness: FreshnessCoordinator::default(),
            preview_reconcile: PreviewReconcileCoordinator::default(),
        }
    }

    pub fn try_start_sweep(&self, vault: &VaultLayout) -> Option<SweepGuard> {
        self.thumbnail_sweeps.try_start(vault)
    }

    pub fn take_pending_sweep(&self) -> Option<VaultLayout> {
        self.thumbnail_sweeps.take_pending()
    }

    /// Whether an open space serves `root`. Background work for a folder no
    /// open space serves any more stops (SPEC_TABS.md, В14).
    pub fn is_open_root(&self, root: &Path) -> bool {
        self.spaces.is_open_root(root)
    }

    /// The open space shown by the tab whose page is `label`.
    pub fn space_for(&self, label: &str) -> Option<Arc<OpenSpace>> {
        self.tabs.space_of(label)
    }

    pub fn set_instance_guard(&self, guard: SingleInstanceGuard) -> Result<(), CommandError> {
        let mut slot = self
            .instance_guard
            .lock()
            .map_err(|_| CommandError::Internal("instance_guard mutex poisoned".into()))?;
        *slot = Some(guard);
        Ok(())
    }

    pub fn try_start_sync(&self, path: &str) -> Result<bool, CommandError> {
        let mut tracker = self
            .sync_tracker
            .lock()
            .map_err(|_| CommandError::Internal("sync_tracker mutex poisoned".into()))?;
        if !tracker.syncing_vaults.insert(path.to_string()) {
            return Ok(false);
        }
        tracker.dirty_during_sync.remove(path);
        Ok(true)
    }

    pub fn begin_sync_pass(&self, path: &str) -> Result<(), CommandError> {
        let mut tracker = self
            .sync_tracker
            .lock()
            .map_err(|_| CommandError::Internal("sync_tracker mutex poisoned".into()))?;
        tracker.dirty_during_sync.remove(path);
        Ok(())
    }

    pub fn complete_sync_pass(&self, path: &str) -> Result<bool, CommandError> {
        let mut tracker = self
            .sync_tracker
            .lock()
            .map_err(|_| CommandError::Internal("sync_tracker mutex poisoned".into()))?;
        if tracker.dirty_during_sync.remove(path) {
            return Ok(true);
        }
        tracker.syncing_vaults.remove(path);
        Ok(false)
    }

    pub fn abort_sync(&self, path: &str) -> Result<(), CommandError> {
        let mut tracker = self
            .sync_tracker
            .lock()
            .map_err(|_| CommandError::Internal("sync_tracker mutex poisoned".into()))?;
        tracker.syncing_vaults.remove(path);
        tracker.dirty_during_sync.remove(path);
        Ok(())
    }

    pub fn mark_dirty_if_syncing(&self, path: &str) -> bool {
        let Ok(mut tracker) = self.sync_tracker.lock() else {
            return false;
        };
        if !tracker.syncing_vaults.contains(path) {
            return false;
        }
        tracker.dirty_during_sync.insert(path.to_string());
        true
    }

    pub fn suppress_paths<I>(&self, paths: I, ttl: Duration) -> Result<(), CommandError>
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let mut suppressed = self
            .suppressed_paths
            .lock()
            .map_err(|_| CommandError::Internal("suppressed_paths mutex poisoned".into()))?;
        let now = Instant::now();
        suppressed.retain(|_, deadline| *deadline > now);
        let deadline = now + ttl;
        for path in paths {
            suppressed.insert(path, deadline);
        }
        Ok(())
    }

    pub fn is_path_suppressed(&self, path: &Path) -> bool {
        let Ok(mut suppressed) = self.suppressed_paths.lock() else {
            return false;
        };
        let now = Instant::now();
        suppressed.retain(|_, deadline| *deadline > now);
        suppressed.contains_key(path)
    }
}

/// The open space of the tab whose page called the command (SPEC_TABS.md,
/// В11). A page that shows no space, or is not a tab, has none.
pub fn tab_space(state: &AppState, webview: &tauri::Webview) -> Result<Arc<OpenSpace>, CommandError> {
    state.space_for(webview.label()).ok_or(CommandError::NoVault)
}

/// The layout of the calling tab's space.
pub fn tab_layout(state: &AppState, webview: &tauri::Webview) -> Result<VaultLayout, CommandError> {
    tab_space(state, webview)?.layout()
}

/// The space a window other than a tab acts on: the one given by
/// `vault_id`, else the space of the most recently used tab (SPEC_TABS.md,
/// В71).
pub fn chosen_space(state: &AppState, vault_id: Option<&str>) -> Result<Arc<OpenSpace>, CommandError> {
    match vault_id {
        Some(vault_id) => state.spaces.get(vault_id),
        None => state.tabs.last_active_space(),
    }
    .ok_or(CommandError::NoVault)
}

/// Read a projection with one corruption recovery, adopting its new slot only
/// while the same session still owns the requested space and old index.
pub(crate) fn read_owned_projection<T>(
    app: &tauri::AppHandle,
    vault: &VaultLayout,
    query: impl Fn(&Connection) -> anyhow::Result<T>,
) -> Result<T, CommandError> {
    let owned = current_read_owner(app, vault)?;
    let (recovered, value) = crate::storage::db::read_vault_projection(&owned, query)?;
    adopt_recovered_projection(app, &owned, recovered, value)
}

/// Search retains its idempotent derived-index maintenance within read ownership.
pub(crate) fn read_owned_search_projection<T>(
    app: &tauri::AppHandle,
    vault: &VaultLayout,
    query: impl Fn(&Connection) -> anyhow::Result<T>,
) -> Result<T, CommandError> {
    let owned = current_read_owner(app, vault)?;
    let (recovered, value) = crate::storage::db::read_search_projection(&owned, query)?;
    adopt_recovered_projection(app, &owned, recovered, value)
}

fn same_projection_owner(current: &VaultLayout, requested: &VaultLayout) -> bool {
    current.root() == requested.root() && current.index_db_path() == requested.index_db_path()
}

fn current_read_owner(
    app: &tauri::AppHandle,
    requested: &VaultLayout,
) -> Result<VaultLayout, CommandError> {
    app.state::<AppState>()
        .spaces
        .by_root(requested.root())
        .ok_or(CommandError::NoVault)?
        .layout()
}

pub(crate) fn adopt_recovered_projection<T>(
    app: &tauri::AppHandle,
    vault: &VaultLayout,
    recovered: VaultLayout,
    value: T,
) -> Result<T, CommandError> {
    adopt_recovered_session(&app.state::<AppState>(), vault, recovered, |layout| {
        crate::watcher::watch::start_watching(app, layout)
    })?;
    Ok(value)
}

/// Move the session of `vault` to the index slot `recovered`, with a watcher
/// of that slot from `start_watcher`, while the same space and old slot are
/// still open. A session already on `recovered` is left as it is; any other
/// session means the space changed, and nothing is replaced.
pub(crate) fn adopt_recovered_session(
    state: &AppState,
    vault: &VaultLayout,
    recovered: VaultLayout,
    start_watcher: impl FnOnce(&VaultLayout) -> anyhow::Result<VaultWatcher>,
) -> Result<(), CommandError> {
    let space = state
        .spaces
        .by_root(vault.root())
        .ok_or(CommandError::NoVault)?;
    if recovered.index_db_path() == vault.index_db_path() {
        let current = space.layout()?;
        return if same_projection_owner(&current, vault) {
            Ok(())
        } else {
            Err(CommandError::NoVault)
        };
    }
    let conn = crate::storage::db::open_or_create(&recovered.index_db_path())?;
    let watcher = match start_watcher(&recovered) {
        Ok(watcher) => Some(watcher),
        Err(error) => {
            log::warn!("recovered index is readable but watcher could not start: {error:#}");
            None
        }
    };
    let publication = space
        .publication
        .lock()
        .map_err(|_| CommandError::Internal("vault publication mutex poisoned".into()))?;
    let mut active = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let matches = active.as_ref().is_some_and(|session| {
        session.vault.root() == vault.root()
            && session.vault.index_db_path() == vault.index_db_path()
    });
    let already_adopted = active.as_ref().is_some_and(|session| {
        session.vault.root() == vault.root()
            && session.vault.index_db_path() == recovered.index_db_path()
    });
    if already_adopted {
        drop(active);
        drop(publication);
        drop(watcher);
        return Ok(());
    }
    if !matches {
        drop(active);
        drop(publication);
        drop(watcher);
        return Err(CommandError::NoVault);
    }
    let mut watcher_slot = space
        .watcher
        .lock()
        .map_err(|_| CommandError::Internal("watcher mutex poisoned".into()))?;
    let old_vault = active.replace(VaultState {
        conn,
        vault: recovered,
    });
    let old_watcher = std::mem::replace(&mut *watcher_slot, watcher);
    drop(watcher_slot);
    drop(active);
    drop(publication);
    drop(old_watcher);
    drop(old_vault);
    state.freshness.mark_dirty(&vault.root().to_string_lossy());
    Ok(())
}

#[derive(Debug, Error, Serialize, specta::Type)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum CommandError {
    #[error("no vault selected")]
    NoVault,
    /// The request was built for a space that is no longer the open one.
    #[error("the open space changed; refresh and try again")]
    SpaceChanged,
    /// A file changed on disk after the operation read it. Nothing was
    /// overwritten or deleted; the other version stays (`SPEC_AUDIT_FIXES.md`,
    /// Ф2). `path` is the file that changed.
    #[error("{path} changed outside Mine; nothing was overwritten")]
    SourceChanged { path: String },
    /// The properties of the note at `path` cannot take the change in place:
    /// they are not valid YAML properties, or writing into their layout would
    /// break them or take the user's comments out. Nothing was written
    /// (`SPEC_AUDIT_FIXES.md`, Ф1).
    #[error("the properties of {path} cannot be changed in place; nothing was written")]
    FrontmatterNotWritable { path: String },
    /// The identity file of the space at `path` is there but cannot be read,
    /// even after waiting for iCloud. The space was not opened and nothing
    /// was written: a new identity over the old one would split the space in
    /// two (`SPEC_AUDIT_FIXES.md`, Д2.1).
    #[error("the identity of the space at {path} cannot be read; nothing was changed")]
    SpaceIdentityUnreadable { path: String },
    #[error("{0}")]
    Internal(String),
}

impl From<anyhow::Error> for CommandError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(format!("{error:#}"))
    }
}

impl From<crate::storage::source_mutation::SourceMutationError> for CommandError {
    /// A refused source mutation, typed when an outside edit won.
    fn from(error: crate::storage::source_mutation::SourceMutationError) -> Self {
        match error {
            crate::storage::source_mutation::SourceMutationError::Changed { path, .. } => {
                Self::SourceChanged {
                    path: path.display().to_string(),
                }
            }
            error => Self::Internal(error.to_string()),
        }
    }
}

/// `saved_at` for a document created now: local wall-clock time, no zone.
pub fn now_saved_at() -> String {
    crate::util::now_saved_at()
}

#[cfg(test)]
impl AppState {
    /// Open `session` as the space of the tab `label`, the way an opening
    /// publishes it. The space is keyed by its folder.
    pub(crate) fn open_space_for_test(&self, label: &str, session: VaultState) -> Arc<OpenSpace> {
        let vault_id = session.vault.root().to_string_lossy().into_owned();
        let request = self.tabs.begin_selection(label);
        let lease = self.spaces.lease(&vault_id);
        let space = Arc::clone(lease.space());
        space.publish(session, None);
        self.tabs
            .bind(label, request, lease)
            .expect("a fresh selection binds");
        space
    }
}

#[cfg(test)]
mod tests {
    use super::{AppState, VaultState};
    use crate::domain::vault::VaultLayout;
    use crate::storage::db;

    #[test]
    fn reliability_new_selection_detaches_previous_request() {
        let state = AppState::new();
        let old = state.tabs.begin_selection("main");
        assert!(state.tabs.is_latest("main", old));
        let latest = state.tabs.begin_selection("main");
        assert!(!state.tabs.is_latest("main", old));
        assert!(state.tabs.is_latest("main", latest));
    }

    #[test]
    fn sync_tracker_repeats_when_marked_dirty() {
        let state = AppState::new();
        assert!(state.try_start_sync("/tmp/vault").unwrap());
        state.begin_sync_pass("/tmp/vault").unwrap();
        assert!(state.mark_dirty_if_syncing("/tmp/vault"));
        assert!(state.complete_sync_pass("/tmp/vault").unwrap());
        state.begin_sync_pass("/tmp/vault").unwrap();
        assert!(!state.complete_sync_pass("/tmp/vault").unwrap());
    }

    #[test]
    fn sync_tracker_ignores_dirty_marks_outside_sync() {
        let state = AppState::new();
        assert!(!state.mark_dirty_if_syncing("/tmp/vault"));
        assert!(state.try_start_sync("/tmp/vault").unwrap());
        assert!(state.mark_dirty_if_syncing("/tmp/vault"));
        state.abort_sync("/tmp/vault").unwrap();
        assert!(!state.mark_dirty_if_syncing("/tmp/vault"));
    }

    #[test]
    fn suppressed_paths_expire_after_deadline() {
        let state = AppState::new();
        let path = std::path::PathBuf::from("/tmp/doc.md");
        state
            .suppress_paths([path.clone()], std::time::Duration::from_millis(5))
            .unwrap();
        assert!(state.is_path_suppressed(&path));
        std::thread::sleep(std::time::Duration::from_millis(10));
        assert!(!state.is_path_suppressed(&path));
    }

    #[test]
    fn background_work_matches_only_open_spaces() {
        let state = AppState::new();
        let source = tempfile::tempdir().unwrap();
        let derived = source.path().join("derived");
        let vault = VaultLayout::with_derived_root(source.path().to_path_buf(), derived);
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        state.open_space_for_test("main", VaultState {
            conn,
            vault: vault.clone(),
        });

        assert!(state.is_open_root(vault.root()));
        assert!(!state.is_open_root(&source.path().join("other")));
    }
}
#[test]
fn reliability_projection_owner_rejects_switched_space_and_retired_slot() {
    let requested =
        crate::domain::vault::VaultLayout::new(std::path::PathBuf::from("/synthetic/first"));
    let switched =
        crate::domain::vault::VaultLayout::new(std::path::PathBuf::from("/synthetic/second"));
    let recovered = requested
        .clone()
        .with_index_db_path(std::path::PathBuf::from("/synthetic/recovery/index.db"));
    assert!(same_projection_owner(&requested, &requested));
    assert!(!same_projection_owner(&switched, &requested));
    assert!(!same_projection_owner(&recovered, &requested));
}
