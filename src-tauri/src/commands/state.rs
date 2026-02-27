// State: shared application state for Tauri commands.
//
// VaultState holds the SQLite connection and vault layout.
// AppState wraps it in a Mutex for thread-safe access from commands.
//
// Contract: SPEC_INTEGRATION.md#commands/state

use rusqlite::Connection;
use serde::Serialize;
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
}

impl AppState {
    pub fn new() -> Self {
        Self {
            vault_state: Mutex::new(None),
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
pub fn now_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let secs_per_day = 86400u64;
    let days = now / secs_per_day;
    let rem = now % secs_per_day;
    let hours = rem / 3600;
    let minutes = (rem % 3600) / 60;
    let seconds = rem % 60;
    let (year, month, day) = days_to_ymd(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

/// Convert days since Unix epoch to (year, month, day).
/// Howard Hinnant's civil_from_days algorithm.
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
