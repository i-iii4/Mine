// Search command: parse query and search index.
//
// Contract: SPEC_INTEGRATION.md#commands/search

use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, ensure_vault_fresh, AppState, CommandError};
use crate::domain::search::parse_search_query;
use crate::storage::db;
use crate::storage::index::{self, IndexedBlock};

// ─── Commands ───────────────────────────────────────────────────────────────

/// Search blocks by free text and/or filters (type:image, tag:design).
#[tauri::command]
pub async fn search(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<IndexedBlock>, CommandError> {
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let db_path = vault.index_db_path();
    let parsed = parse_search_query(&query);
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<IndexedBlock>, CommandError> {
        let conn = db::open_read_only(&db_path)?;
        Ok(index::search_blocks(&conn, &parsed)?)
    })
    .await
    .map_err(|error| CommandError::Internal(format!("search task join failed: {error}")))?
}
