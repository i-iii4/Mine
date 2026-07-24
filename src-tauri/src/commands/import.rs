// Import commands: fetch Are.na channels and import blocks.
//
// The import runs synchronously on a Tauri command thread.
// Progress is reported via Tauri events so the frontend can
// show a progress bar.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::state::{AppState, CommandError};
use crate::import::arena_api;
use crate::import::importer;
use crate::storage::db;

// ─── Response types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ArenaChannelInfo {
    pub id: i64,
    pub title: String,
    pub slug: String,
    pub length: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
struct VaultChangedPayload {
    path: String,
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Fetch public channels for an Are.na user.
#[tauri::command]
pub fn list_arena_channels(username: String) -> Result<Vec<ArenaChannelInfo>, CommandError> {
    let channels = arena_api::fetch_user_channels(&username)?;

    Ok(channels
        .into_iter()
        .map(|c| ArenaChannelInfo {
            id: c.id,
            title: c.title,
            slug: c.slug,
            length: c.length,
            status: c.status,
        })
        .collect())
}

/// Import blocks from selected Are.na channels.
///
/// Each channel is imported with its title as the local tag.
/// Progress events are emitted as "import-progress".
#[tauri::command]
pub fn import_arena_channels(
    app: AppHandle,
    state: State<'_, AppState>,
    channels: Vec<ImportChannelRequest>,
) -> Result<Vec<importer::ImportChannelResult>, CommandError> {
    // Clone the layout + db path under a short lock, then release vault_state
    // before the import's network and file IO. Holding the mutex across a
    // multi-channel import froze every other command for minutes; the import
    // runs on its own SQLite connection instead (mirrors start_background_sync).
    let (vault, db_path) = {
        let vault_state = state
            .vault_state
            .lock()
            .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
        let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
        (vs.vault.clone(), vs.vault.index_db_path())
    };

    let conn = db::open_or_create(&db_path)?;

    let mut results = Vec::new();
    for req in &channels {
        let result = importer::import_channel(&conn, &vault, &req.slug, &req.tag, |progress| {
            let _ = app.emit("import-progress", &progress);
        });

        match result {
            Ok(r) => results.push(r),
            Err(e) => {
                results.push(importer::ImportChannelResult {
                    channel_slug: req.slug.clone(),
                    channel_title: req.tag.clone(),
                    imported: 0,
                    skipped: 0,
                    errors: vec![format!("{:#}", e)],
                });
            }
        }
    }

    // Emit vault-changed so the frontend refreshes
    let _ = app.emit(
        "vault-changed",
        VaultChangedPayload {
            path: vault.root().to_string_lossy().into_owned(),
        },
    );

    Ok(results)
}

#[derive(Debug, serde::Deserialize, specta::Type)]
pub struct ImportChannelRequest {
    pub slug: String,
    pub tag: String,
}
