// Vault statistics command.
//
// Thin IPC layer: opens a short-lived read-only DB connection and delegates
// counting to storage/vault_stats.

use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, AppState, CommandError};
use crate::storage::{db, vault_stats};
use crate::util::append_startup_trace;

#[tauri::command(rename_all = "snake_case")]
pub async fn get_vault_stats(
    app: AppHandle,
    state: State<'_, AppState>,
    current_collection: Option<String>,
) -> Result<vault_stats::VaultStats, CommandError> {
    append_startup_trace(&app, "get_vault_stats", "start");
    let vault = current_vault_layout(&state)?;
    let db_path = vault.index_db_path();
    let stats = tauri::async_runtime::spawn_blocking(
        move || -> Result<vault_stats::VaultStats, CommandError> {
            let conn = db::open_read_only(&db_path)?;
            Ok(vault_stats::get_vault_stats(
                &conn,
                &vault,
                current_collection.as_deref(),
            )?)
        },
    )
    .await
    .map_err(|e| CommandError::Internal(format!("get_vault_stats task join failed: {e}")))??;
    append_startup_trace(
        &app,
        "get_vault_stats",
        &format!(
            "done md={} media={} cards={}",
            stats.markdown_file_count, stats.media_file_count, stats.current_collection_card_count
        ),
    );
    Ok(stats)
}
