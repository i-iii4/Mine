// State: shared application state for Tauri commands.
//
// VaultState holds the SQLite connection and vault layout.
// AppState wraps it in a Mutex for thread-safe access from commands.
//
// Contract: SPEC_INTEGRATION.md#commands/state

use notify::RecommendedWatcher;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use thiserror::Error;

use crate::domain::vault::VaultLayout;
use crate::util::SingleInstanceGuard;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Active vault: database connection + filesystem layout.
pub struct VaultState {
    pub conn: Connection,
    pub vault: VaultLayout,
}

#[derive(Default)]
pub struct SyncTracker {
    syncing_vaults: HashSet<String>,
    dirty_during_sync: HashSet<String>,
}

/// Shared state managed by Tauri, accessible from all commands.
pub struct AppState {
    pub vault_state: Mutex<Option<VaultState>>,
    /// File watcher handle. Dropping it stops watching.
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    /// Runtime lock preventing a second desktop instance from launching.
    pub instance_guard: Mutex<Option<SingleInstanceGuard>>,
    /// Paths currently undergoing background sync plus a dirty marker for
    /// notify events that arrived while the sync owned the index.
    pub sync_tracker: Mutex<SyncTracker>,
    /// Short-lived path suppressions for app-initiated filesystem mutations
    /// such as in-app rename. Prevents the watcher from racing the command's
    /// own source-of-truth update path.
    pub suppressed_paths: Mutex<HashMap<PathBuf, Instant>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            vault_state: Mutex::new(None),
            watcher: Mutex::new(None),
            instance_guard: Mutex::new(None),
            sync_tracker: Mutex::new(SyncTracker::default()),
            suppressed_paths: Mutex::new(HashMap::new()),
        }
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

/// Error type for Tauri commands. Serialized as a string for the frontend.
#[derive(Debug, Error)]
pub enum CommandError {
    #[error("no vault selected")]
    NoVault,

    #[error("{0}")]
    Internal(String),
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for CommandError {
    fn from(e: anyhow::Error) -> Self {
        CommandError::Internal(format!("{:#}", e))
    }
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/// Current UTC time as ISO 8601 string (without chrono dependency).
/// Delegates to `crate::util::now_iso8601`.
pub fn now_iso8601() -> String {
    crate::util::now_iso8601()
}

#[cfg(test)]
mod tests {
    use super::AppState;

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
}
