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
const RECOVERY_ERROR_THRESHOLD: u32 = 3;
const RECOVERY_ERROR_WINDOW: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
struct VaultChangedPayload {
    path: String,
}

#[derive(Debug, Clone, Serialize)]
struct WatcherErrorPayload {
    path: String,
    kind: &'static str,
    consecutive_count: u32,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct WatcherRecoveryPayload {
    path: String,
    fresh: bool,
    error_count: usize,
    watcher_restarted: bool,
}

#[derive(Debug, Default)]
struct WatcherRecoveryTracker {
    window_started: Option<Instant>,
    consecutive_errors: u32,
    recovery_running: bool,
}

impl WatcherRecoveryTracker {
    fn record_error(&mut self, now: Instant) -> (u32, bool) {
        if self.window_started.map_or(true, |started| {
            now.duration_since(started) > RECOVERY_ERROR_WINDOW
        }) {
            self.window_started = Some(now);
            self.consecutive_errors = 0;
        }
        self.consecutive_errors = self.consecutive_errors.saturating_add(1);
        let should_recover =
            self.consecutive_errors >= RECOVERY_ERROR_THRESHOLD && !self.recovery_running;
        if should_recover {
            self.recovery_running = true;
        }
        (self.consecutive_errors, should_recover)
    }

    fn record_success(&mut self) {
        self.window_started = None;
        self.consecutive_errors = 0;
    }

    fn finish_recovery(&mut self, fresh: bool) {
        self.recovery_running = false;
        if fresh {
            self.record_success();
        }
    }
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
    let recovery = Arc::new(Mutex::new(WatcherRecoveryTracker::default()));

    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let event = match res {
                Ok(e) => e,
                Err(e) => {
                    log::error!("watcher error: {e}");
                    record_watcher_error(
                        &app_clone,
                        &vault_clone,
                        &recovery,
                        "notify",
                        e.to_string(),
                    );
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
            if state.freshness.mark_dirty_if_running(&path) {
                return;
            }
            if state.mark_dirty_if_syncing(&path) {
                return;
            }

            let mut any_changed = false;
            let mut any_error = false;
            for ve in &vault_events {
                match handler::handle_event(&conn, &vault_clone, ve, Some(&app_clone)) {
                    Ok(changed) => any_changed |= changed,
                    Err(e) => {
                        any_error = true;
                        log::warn!("watcher handle_event: {e:#}");
                        record_watcher_error(
                            &app_clone,
                            &vault_clone,
                            &recovery,
                            "handler",
                            format!("{e:#}"),
                        );
                    }
                }
            }
            if !any_error {
                recovery
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .record_success();
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

fn record_watcher_error(
    app: &AppHandle,
    vault: &VaultLayout,
    tracker: &Arc<Mutex<WatcherRecoveryTracker>>,
    kind: &'static str,
    message: String,
) {
    let (consecutive_count, should_recover) = tracker
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .record_error(Instant::now());
    let path = vault.root().to_string_lossy().into_owned();
    app.state::<AppState>().freshness.mark_dirty(&path);
    let _ = app.emit(
        "watcher-error",
        WatcherErrorPayload {
            path: path.clone(),
            kind,
            consecutive_count,
            message,
        },
    );
    if !should_recover {
        return;
    }

    let app_for_recovery = app.clone();
    let vault_for_recovery = vault.clone();
    let tracker_for_recovery = Arc::clone(tracker);
    let spawn_result = std::thread::Builder::new()
        .name("watcher-recovery".to_string())
        .spawn(move || {
            let outcome = app_for_recovery
                .state::<AppState>()
                .freshness
                .reconcile(&vault_for_recovery);
            let (fresh, error_count) = match &outcome.result {
                Ok(report) => (report.is_fresh(), report.errors.len()),
                Err(_) => (false, 1),
            };
            let watcher_restarted = match start_watching(
                &app_for_recovery,
                &vault_for_recovery,
                &vault_for_recovery.index_db_path(),
            ) {
                Ok(replacement) => {
                    let state = app_for_recovery.state::<AppState>();
                    let replaced = match state.watcher.lock() {
                        Ok(mut slot) => {
                            *slot = Some(replacement);
                            true
                        }
                        Err(_) => {
                            log::error!("watcher mutex poisoned during recovery");
                            false
                        }
                    };
                    replaced
                }
                Err(error) => {
                    log::error!("failed to restart watcher after recovery: {error:#}");
                    false
                }
            };
            tracker_for_recovery
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .finish_recovery(fresh && watcher_restarted);
            let path = vault_for_recovery.root().to_string_lossy().into_owned();
            let _ = app_for_recovery.emit(
                "watcher-recovery-finished",
                WatcherRecoveryPayload {
                    path: path.clone(),
                    fresh,
                    error_count,
                    watcher_restarted,
                },
            );
            if fresh {
                let _ = app_for_recovery.emit("vault-changed", VaultChangedPayload { path });
            }
        });
    if let Err(error) = spawn_result {
        log::error!("failed to spawn watcher recovery: {error}");
        tracker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .finish_recovery(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_starts_once_after_three_consecutive_errors() {
        let start = Instant::now();
        let mut tracker = WatcherRecoveryTracker::default();

        assert_eq!(tracker.record_error(start), (1, false));
        assert_eq!(
            tracker.record_error(start + Duration::from_secs(1)),
            (2, false)
        );
        assert_eq!(
            tracker.record_error(start + Duration::from_secs(2)),
            (3, true)
        );
        assert_eq!(
            tracker.record_error(start + Duration::from_secs(3)),
            (4, false)
        );
    }

    #[test]
    fn success_and_expired_window_reset_the_error_streak() {
        let start = Instant::now();
        let mut tracker = WatcherRecoveryTracker::default();
        tracker.record_error(start);
        tracker.record_error(start + Duration::from_secs(1));
        tracker.record_success();
        assert_eq!(
            tracker.record_error(start + Duration::from_secs(2)),
            (1, false)
        );
        assert_eq!(
            tracker.record_error(start + Duration::from_secs(40)),
            (1, false)
        );
    }

    #[test]
    fn successful_recovery_allows_a_new_streak() {
        let start = Instant::now();
        let mut tracker = WatcherRecoveryTracker::default();
        tracker.record_error(start);
        tracker.record_error(start);
        assert_eq!(tracker.record_error(start), (3, true));
        tracker.finish_recovery(true);

        assert_eq!(
            tracker.record_error(start + Duration::from_secs(1)),
            (1, false)
        );
    }
}
