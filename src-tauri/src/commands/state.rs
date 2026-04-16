// State: shared application state for Tauri commands.
//
// VaultState holds the SQLite connection and vault layout.
// AppState wraps it in a Mutex for thread-safe access from commands.
//
// Contract: SPEC_INTEGRATION.md#commands/state

use notify::RecommendedWatcher;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Mutex;
use thiserror::Error;

use crate::domain::vault::VaultLayout;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Active vault: database connection + filesystem layout.
pub struct VaultState {
    pub conn: Connection,
    pub vault: VaultLayout,
}

/// Shared state managed by Tauri, accessible from all commands.
pub struct AppState {
    pub vault_state: Mutex<Option<VaultState>>,
    /// File watcher handle. Dropping it stops watching.
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    /// Paths currently undergoing background sync.
    pub syncing_vaults: Mutex<HashSet<String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            vault_state: Mutex::new(None),
            watcher: Mutex::new(None),
            syncing_vaults: Mutex::new(HashSet::new()),
        }
    }
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
