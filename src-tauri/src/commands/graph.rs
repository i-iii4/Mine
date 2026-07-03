// Graph commands: read-only snapshot for Canvas graph surfaces.
//
// Contract: SPEC_GRAPH_VIEW.md

use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, AppState, CommandError};
use crate::storage::{db, graph};
use crate::util::append_startup_trace;

#[tauri::command(rename_all = "snake_case")]
pub async fn list_graph_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
    current_collection: Option<String>,
) -> Result<graph::GraphSnapshot, CommandError> {
    append_startup_trace(
        &app,
        "list_graph_snapshot",
        &format!(
            "start collection={}",
            current_collection
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("__all__")
        ),
    );
    let db_path = current_vault_layout(&state)?.index_db_path();
    let scope = current_collection
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let snapshot = tauri::async_runtime::spawn_blocking(
        move || -> Result<graph::GraphSnapshot, CommandError> {
            let conn = db::open_read_only(&db_path)?;
            Ok(graph::graph_snapshot(&conn, scope.as_deref())?)
        },
    )
    .await
    .map_err(|e| CommandError::Internal(format!("list_graph_snapshot task join failed: {e}")))??;

    append_startup_trace(
        &app,
        "list_graph_snapshot",
        &format!(
            "done nodes={} links={}",
            snapshot.nodes.len(),
            snapshot.links.len()
        ),
    );
    Ok(snapshot)
}
