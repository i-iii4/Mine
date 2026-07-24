// Shared application ownership for Tauri commands.
//
// Stateful workers live in dedicated coordinator modules. AppState only
// composes them with active-vault, watcher, sync and suppression ownership.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::RecommendedWatcher;
use rusqlite::Connection;
use serde::Serialize;
use thiserror::Error;

pub use super::freshness::ensure_vault_fresh;
use super::freshness::FreshnessCoordinator;
pub use super::preview_reconcile::schedule_preview_reconcile;
use super::preview_reconcile::PreviewReconcileCoordinator;
pub use super::thumbnail_sweeps::SweepGuard;
use super::thumbnail_sweeps::ThumbnailSweepCoordinator;
use crate::domain::vault::VaultLayout;
use crate::util::SingleInstanceGuard;

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
    pub vault_state: Mutex<Option<VaultState>>,
    pub watcher: Mutex<Option<RecommendedWatcher>>,
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
            vault_state: Mutex::new(None),
            watcher: Mutex::new(None),
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

    pub fn is_current_vault(&self, root: &Path) -> bool {
        self.vault_state
            .lock()
            .map(|slot| {
                slot.as_ref()
                    .is_some_and(|state| state.vault.root() == root)
            })
            .unwrap_or(false)
    }

    pub(crate) fn current_vault_path(&self) -> Option<String> {
        self.vault_state.lock().ok().and_then(|slot| {
            slot.as_ref()
                .map(|state| state.vault.root().to_string_lossy().into_owned())
        })
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

pub fn current_vault_layout(state: &AppState) -> Result<VaultLayout, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(vs.vault.clone())
}

#[derive(Debug, Error, Serialize, specta::Type)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum CommandError {
    #[error("no vault selected")]
    NoVault,
    #[error("{0}")]
    Internal(String),
}

impl From<anyhow::Error> for CommandError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(format!("{error:#}"))
    }
}

pub fn now_iso8601() -> String {
    crate::util::now_iso8601()
}

#[cfg(test)]
mod tests {
    use super::{AppState, VaultState};
    use crate::domain::vault::VaultLayout;
    use crate::storage::db;

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
    fn background_work_matches_only_the_current_vault() {
        let state = AppState::new();
        let source = tempfile::tempdir().unwrap();
        let derived = source.path().join("derived");
        let vault = VaultLayout::with_derived_root(source.path().to_path_buf(), derived);
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        *state.vault_state.lock().unwrap() = Some(VaultState {
            conn,
            vault: vault.clone(),
        });

        assert!(state.is_current_vault(vault.root()));
        assert!(!state.is_current_vault(&source.path().join("other")));
    }
}
