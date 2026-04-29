// Watch: spawns a background file watcher using notify.
//
// Opens its own SQLite connection (WAL mode supports concurrent readers).
// When vault files change, re-indexes them and emits a "vault-changed"
// Tauri event so the frontend can refresh.

use anyhow::Result;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::state::AppState;
use crate::domain::vault::VaultLayout;
use crate::storage::db;
use crate::util::append_startup_trace;
use crate::watcher::{events, handler};

const DEBOUNCE_MS: u64 = 300;

#[derive(Debug, Clone, Serialize)]
struct VaultChangedPayload {
    path: String,
}

/// Start watching a vault directory for changes.
///
/// Returns a `RecommendedWatcher` that must be kept alive. Dropping it stops watching.
pub fn start_watching(
    app: &AppHandle,
    vault: &VaultLayout,
    db_path: &Path,
) -> Result<RecommendedWatcher> {
    let started = Instant::now();
    append_startup_trace(
        app,
        "watcher",
        &format!("start path={}", vault.root().display()),
    );
    let vault_clone = vault.clone();
    let app_clone = app.clone();

    // Separate DB connection for the watcher thread (WAL mode allows this)
    let conn = db::open_or_create(db_path)?;
    append_startup_trace(
        app,
        "watcher",
        &format!("db_open elapsed_ms={}", started.elapsed().as_millis()),
    );

    // Debounce: track last emit time to avoid flooding the frontend
    let last_emit: Arc<Mutex<Instant>> =
        Arc::new(Mutex::new(Instant::now() - Duration::from_secs(10)));

    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let event = match res {
                Ok(e) => e,
                Err(e) => {
                    log::error!("watcher error: {e}");
                    return;
                }
            };

            let state = app_clone.state::<AppState>();
            let vault_events: Vec<_> = events::classify_notify_event(&event, &vault_clone)
                .into_iter()
                .filter(|vault_event| !state.is_path_suppressed(vault_event.path()))
                .collect();
            if vault_events.is_empty() {
                return;
            }

            let path = vault_clone.root().to_string_lossy().into_owned();
            if state.mark_dirty_if_syncing(&path) {
                return;
            }

            let mut any_changed = false;
            for ve in &vault_events {
                match handler::handle_event(&conn, &vault_clone, ve, Some(&app_clone)) {
                    Ok(changed) => any_changed |= changed,
                    Err(e) => log::warn!("watcher handle_event: {e:#}"),
                }
            }
            if !any_changed {
                return;
            }

            // Debounce: emit at most once per DEBOUNCE_MS
            let mut last = last_emit.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            if now.duration_since(*last) >= Duration::from_millis(DEBOUNCE_MS) {
                *last = now;
                let _ = app_clone.emit(
                    "vault-changed",
                    VaultChangedPayload {
                        path: vault_clone.root().to_string_lossy().into_owned(),
                    },
                );
            }
        })?;

    watcher.watch(vault.root(), RecursiveMode::Recursive)?;

    log::info!("file watcher started for {}", vault.root().display());
    append_startup_trace(
        app,
        "watcher",
        &format!("ready elapsed_ms={}", started.elapsed().as_millis()),
    );

    Ok(watcher)
}
