// Search command: parse query and search index.
//
// Contract: SPEC_INTEGRATION.md#commands/search

use tauri::State;

use crate::commands::state::{AppState, CommandError};
use crate::domain::search::parse_search_query;
use crate::storage::index::{self, IndexedBlock};

// ─── Commands ───────────────────────────────────────────────────────────────

/// Search blocks by free text and/or filters (type:image, tag:design).
#[tauri::command]
pub fn search(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<IndexedBlock>, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let parsed = parse_search_query(&query);
    Ok(index::search_blocks(&vs.conn, &parsed)?)
}
