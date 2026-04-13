// Watch: spawns a background file watcher using notify.
//
// Opens its own SQLite connection (WAL mode supports concurrent readers).
// When vault files change, re-indexes them and emits a "vault-changed"
// Tauri event so the frontend can refresh.

use anyhow::Result;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::domain::vault::VaultLayout;
use crate::storage::db;
use crate::watcher::{events, handler};

const DEBOUNCE_MS: u64 = 300;

/// Start watching a vault directory for changes.
///
/// Returns a `RecommendedWatcher` that must be kept alive. Dropping it stops watching.
pub fn start_watching(
    app: &AppHandle,
    vault: &VaultLayout,
    db_path: &Path,
) -> Result<RecommendedWatcher> {
    let vault_clone = vault.clone();
    let app_clone = app.clone();

    // Separate DB connection for the watcher thread (WAL mode allows this)
    let conn = db::open_or_create(db_path)?;

    // Debounce: track last emit time to avoid flooding the frontend
    let last_emit: Arc<Mutex<Instant>> = Arc::new(Mutex::new(
        Instant::now() - Duration::from_secs(10),
    ));

    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        let event = match res {
            Ok(e) => e,
            Err(e) => {
                log::error!("watcher error: {e}");
                return;
            }
        };

        let vault_events = events::classify_notify_event(&event, &vault_clone);
        if vault_events.is_empty() {
            return;
        }

        for ve in &vault_events {
            if let Err(e) = handler::handle_event(&conn, &vault_clone, ve, Some(&app_clone)) {
                log::warn!("watcher handle_event: {e:#}");
            }
        }

        // Debounce: emit at most once per DEBOUNCE_MS
        let mut last = last_emit.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if now.duration_since(*last) >= Duration::from_millis(DEBOUNCE_MS) {
            *last = now;
            let _ = app_clone.emit("vault-changed", ());
        }
    })?;

    watcher.watch(vault.root(), RecursiveMode::NonRecursive)?;

    log::info!("file watcher started for {}", vault.root().display());

    Ok(watcher)
}
