// Search command: parse query and search index.
//
// Contract: SPEC_INTEGRATION.md#commands/search

use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, ensure_vault_fresh, AppState, CommandError};
use crate::domain::search::parse_search_query;
use crate::storage::index::{self, IndexedBlock};
use crate::storage::{db, search_projection};

const MAX_SEARCH_PAGE_SIZE: usize = 200;

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

#[tauri::command(rename_all = "snake_case")]
pub async fn search_grid_blocks(
    app: AppHandle,
    state: State<'_, AppState>,
    current_tag: Option<String>,
    query: String,
    limit: Option<usize>,
    cursor: Option<search_projection::SearchPageToken>,
) -> Result<search_projection::SearchSnapshot, CommandError> {
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let db_path = vault.index_db_path();
    let page_limit = limit
        .unwrap_or(MAX_SEARCH_PAGE_SIZE)
        .clamp(1, MAX_SEARCH_PAGE_SIZE);
    tauri::async_runtime::spawn_blocking(
        move || -> Result<search_projection::SearchSnapshot, CommandError> {
            let conn = db::open_or_create(&db_path)?;
            Ok(search_projection::read_search_snapshot(
                &conn,
                current_tag.as_deref(),
                &query,
                page_limit,
                cursor.as_ref(),
            )?)
        },
    )
    .await
    .map_err(|error| {
        CommandError::Internal(format!("search_grid_blocks task join failed: {error}"))
    })?
}
