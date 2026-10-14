// Search command: one page of the search overlay's results.
//
// Contract: SPEC_INTEGRATION.md#commands/search

use tauri::{AppHandle, State};

use crate::commands::state::{
    tab_layout, ensure_vault_fresh, read_owned_search_projection, AppState, CommandError,
};
use crate::storage::search_projection;

const MAX_SEARCH_PAGE_SIZE: usize = 200;

// ─── Commands ───────────────────────────────────────────────────────────────

/// One revision-safe page of search results for the overlay (SPEC_SEARCH.md).
#[tauri::command(rename_all = "snake_case")]
pub async fn search_grid_blocks(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    current_tag: Option<String>,
    query: String,
    limit: Option<usize>,
    cursor: Option<search_projection::SearchPageToken>,
) -> Result<search_projection::SearchSnapshot, CommandError> {
    let vault = tab_layout(&state, &webview)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let page_limit = limit
        .unwrap_or(MAX_SEARCH_PAGE_SIZE)
        .clamp(1, MAX_SEARCH_PAGE_SIZE);
    tauri::async_runtime::spawn_blocking(
        move || -> Result<search_projection::SearchSnapshot, CommandError> {
            read_owned_search_projection(&app, &vault, |conn| {
                Ok(search_projection::read_search_snapshot(
                    conn,
                    current_tag.as_deref(),
                    &query,
                    page_limit,
                    cursor.as_ref(),
                )?)
            })
        },
    )
    .await
    .map_err(|error| {
        CommandError::Internal(format!("search_grid_blocks task join failed: {error}"))
    })?
}
