// Watch: spawns a background file watcher using notify.
//
// Opens its own SQLite connection (WAL mode supports concurrent readers).
// When vault files change, re-indexes them and emits a "vault-changed"
// Tauri event so the frontend can refresh.

use anyhow::Result;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
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

/// A running watcher of one space and index slot, with the timer that
/// commits its deferred removals. Dropping it stops both.
pub struct VaultWatcher {
    _events: RecommendedWatcher,
    _removals: RemovalTimer,
    layout: VaultLayout,
}

impl VaultWatcher {
    /// The space and the index slot this watcher writes to.
    pub fn layout(&self) -> &VaultLayout {
        &self.layout
    }

    /// A watcher of nothing, standing for `layout` in tests of whose
    /// watcher ends up in the slot.
    #[cfg(test)]
    pub(crate) fn detached(layout: &VaultLayout) -> Self {
        Self {
            _events: notify::recommended_watcher(|_: notify::Result<notify::Event>| {})
                .expect("an idle watcher needs no path"),
            _removals: RemovalTimer(handler::RemovalTimerStop::default()),
            layout: layout.clone(),
        }
    }
}

/// Owns a removal timer thread: dropping it ends the thread.
struct RemovalTimer(handler::RemovalTimerStop);

impl Drop for RemovalTimer {
    fn drop(&mut self) {
        self.0.stop();
    }
}

/// Start watching a vault directory for changes, writing into the index
/// slot `vault` names.
///
/// Returns a [`VaultWatcher`] that must be kept alive. Dropping it stops watching.
pub fn start_watching(app: &AppHandle, vault: &VaultLayout) -> Result<VaultWatcher> {
    let db_path = vault.index_db_path();
    let started = Instant::now();
    append_startup_trace(
        app,
        "watcher",
        &format!("start path={}", vault.root().display()),
    );
    let vault_clone = vault.clone();
    let app_clone = app.clone();

    // Separate DB connection for the watcher thread (WAL mode allows this)
    let conn = db::open_or_create(&db_path)?;
    append_startup_trace(
        app,
        "watcher",
        &format!("db_open elapsed_ms={}", started.elapsed().as_millis()),
    );

    // Debounce: track last emit time to avoid flooding the frontend
    let last_emit: Arc<Mutex<Instant>> =
        Arc::new(Mutex::new(Instant::now() - Duration::from_secs(10)));
    let recovery = Arc::new(Mutex::new(WatcherRecoveryTracker::default()));
    let removals = start_removal_timer(app, vault)?;

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
            // A deletion waits for its rename window: queuing it wakes the
            // removal timer, which commits it when the window passes.
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

    Ok(VaultWatcher {
        _events: watcher,
        _removals: removals,
        layout: vault.clone(),
    })
}

/// Put a recovered watcher in place, only while its space and index slot are
/// still the open ones: recovery of space A must not replace the watcher of
/// space B opened meanwhile (`SPEC_AUDIT_FIXES.md`, Ф7), and a watcher of a
/// retired slot must not replace the watcher of the slot that took its place
/// (Б2.4). The open space and the watcher slot are locked in the order a
/// space switch locks them.
fn install_recovered_watcher(state: &AppState, replacement: VaultWatcher) -> bool {
    let Ok(open) = state.vault_state.lock() else {
        log::error!("vault state mutex poisoned during watcher recovery");
        return false;
    };
    if !recovered_space_is_open(open.as_ref().map(|vs| &vs.vault), replacement.layout()) {
        log::info!(
            "watcher recovery for {} dropped: another space or index slot is open",
            replacement.layout().index_db_path().display()
        );
        return false;
    }
    let previous = match state.watcher.lock() {
        Ok(mut slot) => slot.replace(replacement),
        Err(_) => {
            log::error!("watcher mutex poisoned during recovery");
            return false;
        }
    };
    // Like a space switch, the replaced watcher stops outside the locks.
    drop(open);
    drop(previous);
    true
}

/// Whether the open session is the space and index slot a watcher writes to.
/// The root alone is not enough: recovery from a corrupt index moves the
/// same space to a new slot.
fn recovered_space_is_open(open: Option<&VaultLayout>, recovered: &VaultLayout) -> bool {
    open.is_some_and(|open| {
        open.root() == recovered.root() && open.index_db_path() == recovered.index_db_path()
    })
}

/// Put a new watcher in place after a recovery pass over `watched`. When the
/// pass moved a corrupt index to a new slot, the session adopts that slot and
/// the watcher follows it: a watcher raised on the old slot would keep
/// writing into the corrupt database, unseen, and fail again (Б2.4).
/// Returns whether a watcher of the open slot is in place.
fn restart_watcher_after_recovery(
    state: &AppState,
    watched: &VaultLayout,
    recovered: Option<VaultLayout>,
    start: impl Fn(&VaultLayout) -> Result<VaultWatcher>,
) -> bool {
    let Some(recovered) = recovered else {
        return match start(watched) {
            Ok(replacement) => install_recovered_watcher(state, replacement),
            Err(error) => {
                log::error!("failed to restart watcher after recovery: {error:#}");
                false
            }
        };
    };
    if let Err(error) =
        crate::commands::state::adopt_recovered_session(state, watched, recovered.clone(), &start)
    {
        log::info!(
            "watcher recovery for {} dropped: {error}",
            watched.root().display()
        );
        return false;
    }
    state.watcher.lock().is_ok_and(|slot| {
        slot.as_ref()
            .is_some_and(|watcher| recovered_space_is_open(Some(watcher.layout()), &recovered))
    })
}

/// A deferred removal is committed when its rename window passes, not when
/// some later file event happens to arrive (`SPEC_AUDIT_FIXES.md`, Ф7). The
/// timer has its own index connection and ends with its watcher.
fn start_removal_timer(app: &AppHandle, vault: &VaultLayout) -> Result<RemovalTimer> {
    let conn = db::open_or_create(&vault.index_db_path())?;
    let stop = handler::RemovalTimerStop::default();
    let timer = RemovalTimer(stop.clone());
    let app = app.clone();
    let vault = vault.clone();
    std::thread::Builder::new()
        .name("watcher-removals".to_string())
        .spawn(move || {
            let path = vault.root().to_string_lossy().into_owned();
            handler::run_removal_timer(&conn, &vault, &stop, Some(&app), |pass| {
                if settle_removal_pass(&app.state::<AppState>(), &path, pass) {
                    let _ = app.emit("vault-changed", VaultChangedPayload { path: path.clone() });
                }
            });
        })?;
    Ok(timer)
}

/// Take in one pass of the removal timer; returns whether the feed must
/// reload. An index that refused a removal, or removals that could not be
/// committed at all, leave it behind the files: the next freshness pass
/// reconciles it (`SPEC_AUDIT_FIXES.md`, В2.3).
fn settle_removal_pass(state: &AppState, path: &str, pass: Result<handler::RemovalPass>) -> bool {
    match pass {
        Ok(pass) => {
            if pass.stale {
                state.freshness.mark_dirty(path);
            }
            pass.removed
        }
        Err(error) => {
            log::warn!("deferred removals: {error:#}");
            state.freshness.mark_dirty(path);
            false
        }
    }
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
            let watcher_restarted = restart_watcher_after_recovery(
                &app_for_recovery.state::<AppState>(),
                &vault_for_recovery,
                outcome.recovered_vault.clone(),
                |layout| start_watching(&app_for_recovery, layout),
            );
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
    fn recovery_installs_its_watcher_only_for_the_open_space() {
        let a = VaultLayout::new(std::path::PathBuf::from("/spaces/A"));
        let b = VaultLayout::new(std::path::PathBuf::from("/spaces/B"));
        assert!(recovered_space_is_open(Some(&a), &a));
        assert!(!recovered_space_is_open(Some(&b), &a));
        assert!(!recovered_space_is_open(None, &a));
    }

    #[test]
    fn a_watcher_of_a_retired_index_slot_is_not_the_open_space() {
        // Б2.4: recovery from a corrupt index keeps the root and moves the
        // index to a new slot.
        let open = VaultLayout::new(std::path::PathBuf::from("/spaces/A"));
        let retired = open
            .clone()
            .with_index_db_path(std::path::PathBuf::from("/derived/A/retired/index.db"));
        assert!(!recovered_space_is_open(Some(&open), &retired));
        assert!(!recovered_space_is_open(Some(&retired), &open));
    }

    #[test]
    fn recovery_from_a_corrupt_index_leaves_the_watcher_on_the_new_slot() {
        // Б2.4: the recovery pass moves the index to a new slot; the watcher
        // restarted after it must write there, not into the corrupt file.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("Card.md"), "A card the index must keep.\n").unwrap();
        let watched = VaultLayout::with_derived_root(root.clone(), temp.path().join("derived"));
        let watched = db::resolve_vault_index(watched).unwrap();
        std::fs::create_dir_all(watched.index_generation_dir()).unwrap();
        std::fs::write(watched.index_db_path(), b"not a SQLite database").unwrap();

        let state = AppState::new();
        *state.vault_state.lock().unwrap() = Some(crate::commands::state::VaultState {
            conn: db::open_memory().unwrap(),
            vault: watched.clone(),
        });
        *state.watcher.lock().unwrap() = Some(VaultWatcher::detached(&watched));

        let outcome = state.freshness.reconcile(&watched);
        let recovered = outcome
            .recovered_vault
            .clone()
            .expect("the corrupt index is recovered");
        assert_ne!(recovered.index_db_path(), watched.index_db_path());

        assert!(restart_watcher_after_recovery(
            &state,
            &watched,
            outcome.recovered_vault,
            |layout| Ok(VaultWatcher::detached(layout)),
        ));
        let installed = state.watcher.lock().unwrap();
        let installed = installed.as_ref().expect("a watcher is in place");
        assert_eq!(installed.layout().index_db_path(), recovered.index_db_path());
        let open = state.vault_state.lock().unwrap();
        assert_eq!(
            open.as_ref().unwrap().vault.index_db_path(),
            recovered.index_db_path()
        );
    }

    #[test]
    fn a_watcher_of_the_retired_slot_does_not_replace_the_new_one() {
        // Б2.4: a restart that still aims at the retired slot (its pass
        // joined the one that moved the index) finds the session on the new
        // slot and leaves that slot's watcher in place.
        let temp = tempfile::tempdir().unwrap();
        let retired =
            VaultLayout::with_derived_root(temp.path().join("source"), temp.path().join("derived"));
        let adopted = retired
            .clone()
            .with_index_db_path(temp.path().join("derived/recovered/index.db"));
        let state = AppState::new();
        *state.vault_state.lock().unwrap() = Some(crate::commands::state::VaultState {
            conn: db::open_memory().unwrap(),
            vault: adopted.clone(),
        });
        *state.watcher.lock().unwrap() = Some(VaultWatcher::detached(&adopted));

        assert!(!restart_watcher_after_recovery(&state, &retired, None, |layout| Ok(
            VaultWatcher::detached(layout)
        )));
        let installed = state.watcher.lock().unwrap();
        assert_eq!(
            installed.as_ref().unwrap().layout().index_db_path(),
            adopted.index_db_path()
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
