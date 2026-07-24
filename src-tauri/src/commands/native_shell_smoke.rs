use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::state::CommandError;

pub const OUTPUT_ENV: &str = "MINE_NATIVE_SMOKE_OUTPUT";
pub const QUERY_FLAG: &str = "mine-native-shell-smoke";

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct NativeShellSmokeReport {
    pub status: String,
    pub vault_path: Option<String>,
    pub location: String,
    pub user_agent: String,
    pub timestamp_ms: u64,
}

pub fn enabled() -> bool {
    std::env::var_os(OUTPUT_ENV).is_some()
}

#[tauri::command]
pub fn report_native_shell_smoke(report: NativeShellSmokeReport) -> Result<(), CommandError> {
    let output = std::env::var_os(OUTPUT_ENV).ok_or_else(|| {
        CommandError::Internal("native-shell smoke reporting is not enabled".to_string())
    })?;
    let output = PathBuf::from(output);
    let parent = output.parent().ok_or_else(|| {
        CommandError::Internal("native-shell smoke output has no parent".to_string())
    })?;
    std::fs::create_dir_all(parent).map_err(|error| {
        CommandError::Internal(format!(
            "failed to create native-shell smoke directory: {error}"
        ))
    })?;
    let bytes = serde_json::to_vec_pretty(&report).map_err(|error| {
        CommandError::Internal(format!(
            "failed to serialize native-shell smoke report: {error}"
        ))
    })?;
    let temporary = output.with_extension("tmp");
    std::fs::write(&temporary, bytes).map_err(|error| {
        CommandError::Internal(format!(
            "failed to write native-shell smoke report: {error}"
        ))
    })?;
    std::fs::rename(&temporary, &output).map_err(|error| {
        CommandError::Internal(format!(
            "failed to publish native-shell smoke report: {error}"
        ))
    })?;
    Ok(())
}
