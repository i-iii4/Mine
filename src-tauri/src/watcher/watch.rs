// Watch: spawns a background file watcher using notify.
//
// Opens its own SQLite connection (WAL mode supports concurrent readers).
// When vault files change, re-indexes them and emits a "vault-changed"
// Tauri event so the frontend can refresh.

use anyhow::Result;
use crate::commands::effects::VaultChangedPayload;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::commands::state::AppState;
use crate::domain::vault::VaultLayout;
use crate::storage::db;
use crate::util::append_startup_trace;
use crate::watcher::{events, handler};

/// How long the watcher collects the events that follow a batch it handled
/// (SPEC_INTEGRATION.md, «Пачки событий и точное перечитывание»). The window
/// the watcher already had: until 16.11.2026 it held back `vault-changed` to
/// one in 300 ms (`DEBOUNCE_MS`); the same window now parts the batches.
const BATCH_WINDOW: Duration = Duration::from_millis(300);
const RECOVERY_ERROR_THRESHOLD: u32 = 3;
const RECOVERY_ERROR_WINDOW: Duration = Duration::from_secs(30);


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

/// The events a watcher has seen and not handled yet, and when they are due
/// (SPEC_INTEGRATION.md, «Пачки»). The first event after quiet is due at
/// once; events that come while a batch is handled and in [`BATCH_WINDOW`]
/// after it wait for the window to close and are one batch.
#[derive(Debug, Default)]
struct EventBatches {
    waiting: Vec<handler::SeenEvent>,
    /// The end of the window after the last batch handled.
    collects_until: Option<Instant>,
}

impl EventBatches {
    fn push(&mut self, events: impl IntoIterator<Item = handler::SeenEvent>) {
        self.waiting.extend(events);
    }

    /// When the waiting events are due; `None` while none wait.
    fn due_at(&self, now: Instant) -> Option<Instant> {
        if self.waiting.is_empty() {
            return None;
        }
        Some(self.collects_until.filter(|until| *until > now).unwrap_or(now))
    }

    /// Take the waiting events as one batch.
    fn take(&mut self) -> Vec<handler::SeenEvent> {
        std::mem::take(&mut self.waiting)
    }

    /// A batch was handled, at `now`: what comes in the window after it is
    /// the next batch.
    fn handled(&mut self, now: Instant) {
        self.collects_until = Some(now + BATCH_WINDOW);
    }
}

/// The batches of one watcher, shared by the thread that sees its events
/// and the thread that handles them.
#[derive(Default)]
struct BatchQueue {
    state: Mutex<BatchQueueState>,
    changed: Condvar,
}

#[derive(Default)]
struct BatchQueueState {
    batches: EventBatches,
    stopped: bool,
}

impl BatchQueue {
    fn state(&self) -> std::sync::MutexGuard<'_, BatchQueueState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn push(&self, events: Vec<handler::SeenEvent>) {
        self.state().batches.push(events);
        self.changed.notify_all();
    }

    /// Wait for the next batch; `None` once the watcher is stopped.
    fn next_batch(&self) -> Option<Vec<handler::SeenEvent>> {
        let mut state = self.state();
        loop {
            if state.stopped {
                return None;
            }
            let now = Instant::now();
            state = match state.batches.due_at(now) {
                Some(due) if due <= now => return Some(state.batches.take()),
                Some(due) => {
                    self.changed
                        .wait_timeout(state, due - now)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
                None => self
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner),
            };
        }
    }

    fn handled(&self) {
        self.state().batches.handled(Instant::now());
    }
}

/// Owns the thread that handles a watcher's batches: dropping it ends the
/// thread, and the names kept for the space are no longer followed.
struct BatchWorker {
    queue: Arc<BatchQueue>,
    root: std::path::PathBuf,
}

impl Drop for BatchWorker {
    fn drop(&mut self) {
        self.queue.state().stopped = true;
        self.queue.changed.notify_all();
        crate::storage::reconcile::forget_kept_files(&self.root);
    }
}

/// A running watcher of one space and index slot, with the thread that
/// handles its events in batches and the timer that commits its deferred
/// removals. Dropping it stops all three.
pub struct VaultWatcher {
    _events: RecommendedWatcher,
    _batches: BatchWorker,
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
            _batches: BatchWorker {
                queue: Arc::default(),
                root: layout.root().to_path_buf(),
            },
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

    let recovery = Arc::new(Mutex::new(WatcherRecoveryTracker::default()));
    let removals = start_removal_timer(app, vault)?;
    let queue = Arc::new(BatchQueue::default());
    let batches = BatchWorker {
        queue: Arc::clone(&queue),
        root: vault.root().to_path_buf(),
    };
    {
        let queue = Arc::clone(&queue);
        let app = app.clone();
        let vault = vault.clone();
        let recovery = Arc::clone(&recovery);
        std::thread::Builder::new()
            .name("watcher-batches".to_string())
            .spawn(move || {
                while let Some(batch) = queue.next_batch() {
                    handle_batch(&app, &vault, &conn, &recovery, &batch);
                    queue.handled();
                }
            })?;
    }

    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let event = match res {
                Ok(e) => e,
                Err(e) => {
                    log::error!("watcher error: {e}");
                    // What the watcher was told no longer says which files
                    // are there.
                    crate::storage::reconcile::forget_kept_files(vault_clone.root());
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
            if event.need_rescan() {
                // The system dropped events: only a pass over the space
                // tells what happened (SPEC_INTEGRATION.md, «Индекс имён
                // файлов»).
                log::warn!("the watcher of {} lost events", vault_clone.root().display());
                crate::storage::reconcile::forget_kept_files(vault_clone.root());
                crate::commands::freshness::request_pass(&app_clone, vault_clone.clone());
            }

            let state = app_clone.state::<AppState>();
            // The names kept for the space follow every event, the ones not
            // handled further included (Mine's own writes).
            let vault_events: Vec<_> = events::classify_notify_event(&event, &vault_clone)
                .into_iter()
                .map(|vault_event| handler::see_event(&vault_clone, vault_event))
                .filter(|seen| !state.is_path_suppressed(seen.event.path()))
                .filter(|seen| !is_own_note_write(&vault_clone, &seen.event))
                .collect();
            if vault_events.is_empty() {
                return;
            }
            // The sessions editing these notes hear of the change now, past
            // the batch and whatever the index is busy with (SPEC_EDITING.md,
            // Л4.1).
            crate::commands::edit_sessions::announce_outside_changes(
                &app_clone,
                &vault_clone,
                vault_events
                    .iter()
                    .filter(|seen| is_note_event(&seen.event))
                    .map(|seen| seen.event.path()),
            );
            queue.push(vault_events);
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
        _batches: batches,
        _removals: removals,
        layout: vault.clone(),
    })
}

/// Handle one batch of the watcher's events and tell the feed after it
/// (SPEC_INTEGRATION.md, «Пачки»).
fn handle_batch(
    app: &AppHandle,
    vault: &VaultLayout,
    conn: &rusqlite::Connection,
    recovery: &Arc<Mutex<WatcherRecoveryTracker>>,
    batch: &[handler::SeenEvent],
) {
    let state = app.state::<AppState>();
    let path = vault.root().to_string_lossy().into_owned();
    // A pass over the whole space is running: it runs again and sees
    // everything this batch is about.
    if state.freshness.mark_dirty_if_running(&path) || state.mark_dirty_if_syncing(&path) {
        return;
    }

    let outcome = handler::handle_batch(conn, vault, batch, Some(app));
    // A deletion waits for its rename window: queuing it wakes the removal
    // timer, which commits it when the window passes.
    for error in &outcome.errors {
        log::warn!("watcher handle_batch: {error:#}");
        record_watcher_error(app, vault, recovery, "handler", format!("{error:#}"));
    }
    if outcome.errors.is_empty() {
        recovery
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .record_success();
    }
    // The notes of this batch are checked for iCloud conflicts by one
    // helper run (SPEC_ICLOUD_CONFLICTS.md, ВК4).
    crate::commands::conflicts::schedule_paths_check(
        app,
        vault,
        batch.iter().map(|seen| seen.event.path()),
    );
    if outcome.full_pass {
        crate::commands::freshness::request_pass(app, vault.clone());
    }
    if outcome.changed {
        crate::commands::space_events::emit_to_space_root(
            app,
            vault.root(),
            "vault-changed",
            VaultChangedPayload::from_outside(path),
        );
    }
}

/// Whether `event` is a note changed by Mine itself: the file holds exactly
/// the bytes Mine wrote there last, a moment ago (SPEC_EDITING.md, Л3.6).
/// Any other change of the note, however soon after Mine's, is news.
fn is_own_note_write(vault: &VaultLayout, event: &events::VaultEvent) -> bool {
    matches!(event, events::VaultEvent::BlockChanged(path) if crate::storage::note_write::is_own_write(vault, path))
}

/// Whether `event` is about a note rather than a media file.
fn is_note_event(event: &events::VaultEvent) -> bool {
    matches!(
        event,
        events::VaultEvent::BlockChanged(_) | events::VaultEvent::BlockDeleted(_)
    )
}

/// Put a recovered watcher in place, only while its space and index slot are
/// still the open ones: recovery of space A must not replace the watcher of
/// space B opened meanwhile (`SPEC_AUDIT_FIXES.md`, Ф7), and a watcher of a
/// retired slot must not replace the watcher of the slot that took its place
/// (Б2.4). The open space and the watcher slot are locked in the order a
/// space switch locks them.
fn install_recovered_watcher(state: &AppState, replacement: VaultWatcher) -> bool {
    // The space that owns the folder; another open space is never touched
    // (SPEC_TABS.md, В7).
    let Some(space) = state.spaces.by_root(replacement.layout().root()) else {
        log::info!(
            "watcher recovery for {} dropped: the space is no longer open",
            replacement.layout().index_db_path().display()
        );
        return false;
    };
    let Ok(open) = space.vault_state.lock() else {
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
    let previous = match space.watcher.lock() {
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
    state.spaces.by_root(recovered.root()).is_some_and(|space| {
        space.watcher.lock().is_ok_and(|slot| {
            slot.as_ref()
                .is_some_and(|watcher| recovered_space_is_open(Some(watcher.layout()), &recovered))
        })
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
                    crate::commands::space_events::emit_to_space_path(
                        &app,
                        &path,
                        "vault-changed",
                        VaultChangedPayload::from_outside(path.clone()),
                    );
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
    crate::commands::space_events::emit_to_space_root(
        app,
        vault.root(),
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
            // A pass that finished with errors in some notes finished: the
            // index is ready without them (SPEC_DEEP_AUDIT.md, Н6). Only a pass
            // that failed leaves the recovery unfinished.
            let (finished, fresh, error_count) = match &outcome.result {
                Ok(report) => (true, report.is_fresh(), report.errors.len()),
                Err(_) => (false, false, 1),
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
                .finish_recovery(finished && watcher_restarted);
            let path = vault_for_recovery.root().to_string_lossy().into_owned();
            crate::commands::space_events::emit_to_space_path(
                &app_for_recovery,
                &path,
                "watcher-recovery-finished",
                WatcherRecoveryPayload {
                    path: path.clone(),
                    fresh,
                    error_count,
                    watcher_restarted,
                },
            );
            if finished {
                crate::commands::conflicts::schedule_conflict_check(
                    &app_for_recovery,
                    &vault_for_recovery,
                    crate::storage::icloud_conflicts::CheckScope::Full,
                );
                crate::commands::space_events::emit_to_space_path(
                    &app_for_recovery,
                    &path.clone(),
                    "vault-changed",
                    VaultChangedPayload::from_outside(path),
                );
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

    fn media_event(name: &str) -> handler::SeenEvent {
        handler::SeenEvent {
            event: events::VaultEvent::MediaChanged(std::path::PathBuf::from(format!(
                "/spaces/A/Media/{name}"
            ))),
            path: crate::storage::reconcile::SeenPath::File,
        }
    }

    /// SPEC_INTEGRATION.md, «Пачки»: the first event after quiet is due at
    /// once, with no window to wait out: a card the clipper saved reaches
    /// the feed as soon as before.
    #[test]
    fn the_first_event_after_quiet_is_handled_at_once() {
        let start = Instant::now();
        let mut batches = EventBatches::default();
        assert_eq!(batches.due_at(start), None, "nothing waits");

        batches.push([media_event("first.jpg")]);
        assert_eq!(batches.due_at(start), Some(start));
        assert_eq!(batches.take().len(), 1);
        batches.handled(start);

        // Quiet again once the window after the batch has passed.
        let later = start + BATCH_WINDOW;
        batches.push([media_event("later.jpg")]);
        assert_eq!(batches.due_at(later), Some(later));
    }

    /// A hundred events in a row are two batches: the first event alone, at
    /// once, and the ninety-nine that come while it is handled and in the
    /// window after it, when the window closes.
    #[test]
    fn a_hundred_events_in_a_row_make_two_batches() {
        let start = Instant::now();
        let mut batches = EventBatches::default();
        let mut handled = Vec::new();

        batches.push([media_event("0.jpg")]);
        assert_eq!(batches.due_at(start), Some(start));
        handled.push(batches.take().len());
        // The first batch took 20 ms; events kept coming meanwhile.
        for event in 1..40 {
            batches.push([media_event(&format!("{event}.jpg"))]);
        }
        let first_done = start + Duration::from_millis(20);
        batches.handled(first_done);
        let closes = first_done + BATCH_WINDOW;
        for event in 40..100 {
            batches.push([media_event(&format!("{event}.jpg"))]);
            let now = first_done + Duration::from_millis(event);
            assert_eq!(batches.due_at(now), Some(closes), "event {event} waits for the window");
        }
        assert_eq!(batches.due_at(closes), Some(closes));
        handled.push(batches.take().len());
        batches.handled(closes);

        assert_eq!(handled, [1, 99]);
        assert_eq!(batches.due_at(closes + Duration::from_secs(1)), None);
    }

    /// The thread that handles batches gets the first event without a wait
    /// and nothing more once the watcher is stopped.
    #[test]
    fn the_queue_hands_out_a_waiting_batch_and_ends_when_stopped() {
        let queue = BatchQueue::default();
        queue.push(vec![media_event("a.jpg"), media_event("b.jpg")]);
        assert_eq!(queue.next_batch().map(|batch| batch.len()), Some(2));
        queue.handled();
        queue.state().stopped = true;
        queue.push(vec![media_event("c.jpg")]);
        assert_eq!(queue.next_batch(), None);
    }

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
        let space = state.open_space_for_test("main", crate::commands::state::VaultState {
            conn: db::open_memory().unwrap(),
            vault: watched.clone(),
        });
        *space.watcher.lock().unwrap() = Some(VaultWatcher::detached(&watched));

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
        let installed = space.watcher.lock().unwrap();
        let installed = installed.as_ref().expect("a watcher is in place");
        assert_eq!(installed.layout().index_db_path(), recovered.index_db_path());
        let open = space.vault_state.lock().unwrap();
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
        let space = state.open_space_for_test("main", crate::commands::state::VaultState {
            conn: db::open_memory().unwrap(),
            vault: adopted.clone(),
        });
        *space.watcher.lock().unwrap() = Some(VaultWatcher::detached(&adopted));

        assert!(!restart_watcher_after_recovery(&state, &retired, None, |layout| Ok(
            VaultWatcher::detached(layout)
        )));
        let installed = space.watcher.lock().unwrap();
        assert_eq!(
            installed.as_ref().unwrap().layout().index_db_path(),
            adopted.index_db_path()
        );
    }

    /// SPEC_EDITING.md, Л3.6: the watcher drops a note event only while the
    /// file holds Mine's own bytes; an outside write right after it, and a
    /// deletion, are news.
    #[test]
    fn only_mines_own_bytes_are_dropped() {
        let temp = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(temp.path().join("source"), temp.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        let path = vault.block_path("Note");
        std::fs::write(&path, "before\n").unwrap();
        let note = crate::storage::note_write::writable_note(&vault, "Note").unwrap();
        let read = crate::storage::note_write::read_note(&vault, &note.path).unwrap();
        let written = read.read_back("mine\n").unwrap();
        crate::storage::note_write::publish_note(&conn, &vault, &note, read, "mine\n".into(), &written, "test")
            .unwrap();

        let changed = events::VaultEvent::BlockChanged(path.clone());
        assert!(is_own_note_write(&vault, &changed));
        assert!(!is_own_note_write(&vault, &events::VaultEvent::BlockDeleted(path.clone())));
        std::fs::write(&path, "from Obsidian\n").unwrap();
        assert!(!is_own_note_write(&vault, &changed));
        assert!(is_note_event(&changed));
        assert!(!is_note_event(&events::VaultEvent::MediaChanged(path)));
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
