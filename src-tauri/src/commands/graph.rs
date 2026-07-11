// Graph commands: read-only snapshot for Canvas graph surfaces.
//
// Contract: SPEC_GRAPH_VIEW.md

use tauri::{AppHandle, State};

use crate::commands::state::{current_vault_layout, ensure_vault_fresh, AppState, CommandError};
use crate::storage::{db, graph};
use crate::util::append_startup_trace;

#[tauri::command(rename_all = "snake_case")]
pub async fn list_graph_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
    scope: Option<graph::GraphScope>,
    options: Option<graph::GraphOptions>,
) -> Result<graph::GraphSnapshot, CommandError> {
    let scope = scope.unwrap_or_default();
    let options = options.unwrap_or_default();
    append_startup_trace(
        &app,
        "list_graph_snapshot",
        &format!(
            "start scope={:?} collection={}",
            scope.kind,
            scope
                .collection_ref
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("__all__")
        ),
    );
    let vault = current_vault_layout(&state)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let db_path = vault.index_db_path();
    let snapshot = tauri::async_runtime::spawn_blocking(
        move || -> Result<graph::GraphSnapshot, CommandError> {
            let conn = db::open_read_only(&db_path)?;
            Ok(graph::graph_snapshot(&conn, &scope, &options)?)
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
