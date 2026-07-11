// State: shared application state for Tauri commands.
//
// VaultState holds the SQLite connection and vault layout.
// AppState wraps it in a Mutex for thread-safe access from commands.
//
// Contract: SPEC_INTEGRATION.md#commands/state

use notify::RecommendedWatcher;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;

use crate::domain::vault::VaultLayout;
use crate::storage::reconcile::ReconcileReport;
use crate::storage::{db, derived_preview, reconcile};
use crate::util::{append_startup_trace, SingleInstanceGuard};

// ─── Types ──────────────────────────────────────────────────────────────────

/// Active vault: database connection + filesystem layout.
pub struct VaultState {
    pub conn: Connection,
    pub vault: VaultLayout,
}

#[derive(Default)]
pub struct SyncTracker {
    syncing_vaults: HashSet<String>,
    dirty_during_sync: HashSet<String>,
}

/// Shared state managed by Tauri, accessible from all commands.
pub struct AppState {
    pub vault_state: Mutex<Option<VaultState>>,
    /// File watcher handle. Dropping it stops watching.
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    /// Runtime lock preventing a second desktop instance from launching.
    pub instance_guard: Mutex<Option<SingleInstanceGuard>>,
    /// Paths currently undergoing background sync plus a dirty marker for
    /// notify events that arrived while the sync owned the index.
    pub sync_tracker: Mutex<SyncTracker>,
    /// Short-lived path suppressions for app-initiated filesystem mutations
    /// such as in-app rename. Prevents the watcher from racing the command's
    /// own source-of-truth update path.
    pub suppressed_paths: Mutex<HashMap<PathBuf, Instant>>,
    /// Serializes classic thumbnail sweeps across startup/focus callers.
    /// A request for the running vault is coalesced; after a vault switch the
    /// newest active vault is retained as one pending pass.
    thumbnail_sweeps: ThumbnailSweepCoordinator,
    /// Coalesces route-facing filesystem reconciliation. The coordinator never
    /// performs filesystem or SQLite work while its internal mutex is held.
    pub freshness: FreshnessCoordinator,
    /// One background derived-preview worker per app. New source changes are
    /// queued while it runs; no filesystem or SQLite work occurs under this
    /// mutex.
    preview_queue: Mutex<PreviewWorkQueue>,
}

#[derive(Default)]
struct PreviewWorkQueue {
    running: bool,
    pending: BTreeMap<String, QueuedPreviewWork>,
}

struct QueuedPreviewWork {
    vault: VaultLayout,
    full_scan: bool,
    pending_slugs: BTreeSet<String>,
}

#[derive(Default)]
struct ThumbnailSweepState {
    running_vault: Option<PathBuf>,
    pending_vault: Option<VaultLayout>,
}

#[derive(Default)]
struct ThumbnailSweepCoordinator {
    state: Arc<Mutex<ThumbnailSweepState>>,
}

#[derive(Default)]
pub struct FreshnessCoordinator {
    state: Mutex<HashMap<String, FreshnessEntry>>,
    changed: Condvar,
}

struct FreshnessEntry {
    running: bool,
    scheduled: bool,
    dirty: bool,
    generation: u64,
    joined_callers: usize,
    fast_path_hits: usize,
    last_completed_at: Option<Instant>,
    last_result: Option<Result<ReconcileReport, String>>,
}

impl Default for FreshnessEntry {
    fn default() -> Self {
        Self {
            running: false,
            scheduled: false,
            dirty: true,
            generation: 0,
            joined_callers: 0,
            fast_path_hits: 0,
            last_completed_at: None,
            last_result: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreshnessRouteAction {
    /// No completed generation exists yet, so the first route waits for one
    /// usable committed snapshot.
    AwaitFirstGeneration,
    /// A last-good snapshot exists and one background generation was claimed.
    SpawnBackground,
    /// A clean/degraded committed generation can be read immediately.
    ReadCommitted,
}

#[derive(Debug, Clone)]
pub struct FreshnessOutcome {
    pub vault_path: String,
    pub generation: u64,
    pub joined_callers: usize,
    pub fast_path_hits: usize,
    pub ran_reconcile: bool,
    pub result: Result<ReconcileReport, String>,
}

#[derive(Debug, Clone, Serialize)]
struct VaultFreshnessChangedPayload {
    vault_path: String,
    generation: u64,
    state: &'static str,
    joined_callers: usize,
    inventory_markdown: usize,
    content_reads: usize,
    database_writes: usize,
    error_count: usize,
    elapsed_ms: u64,
    fast_path_hits: usize,
}

const FRESHNESS_SAFETY_AUDIT_INTERVAL: Duration = Duration::from_secs(30);

pub struct SweepGuard {
    state: Arc<Mutex<ThumbnailSweepState>>,
    vault_root: PathBuf,
}

impl Drop for SweepGuard {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.running_vault.as_deref() == Some(self.vault_root.as_path()) {
            state.running_vault = None;
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            vault_state: Mutex::new(None),
            watcher: Mutex::new(None),
            instance_guard: Mutex::new(None),
            sync_tracker: Mutex::new(SyncTracker::default()),
            suppressed_paths: Mutex::new(HashMap::new()),
            thumbnail_sweeps: ThumbnailSweepCoordinator::default(),
            freshness: FreshnessCoordinator::default(),
            preview_queue: Mutex::new(PreviewWorkQueue::default()),
        }
    }

    /// Begin one classic thumbnail sweep. Same-vault requests coalesce; a
    /// different active vault becomes the single pending pass.
    pub fn try_start_sweep(&self, vault: &VaultLayout) -> Option<SweepGuard> {
        let mut state = self
            .thumbnail_sweeps
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(running) = state.running_vault.as_deref() {
            if running != vault.root() {
                state.pending_vault = Some(vault.clone());
            }
            return None;
        }
        state.pending_vault = None;
        state.running_vault = Some(vault.root().to_path_buf());
        Some(SweepGuard {
            state: Arc::clone(&self.thumbnail_sweeps.state),
            vault_root: vault.root().to_path_buf(),
        })
    }

    pub fn take_pending_sweep(&self) -> Option<VaultLayout> {
        let mut state = self
            .thumbnail_sweeps
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.running_vault.is_some() {
            return None;
        }
        state.pending_vault.take()
    }

    /// True only while `root` is the vault currently owned by the app shell.
    /// Background workers use this as a cancellation boundary so a vault
    /// switch cannot leave old preview/thumbnail work consuming CPU or
    /// publishing slug-only events into the new screen.
    pub fn is_current_vault(&self, root: &Path) -> bool {
        self.vault_state
            .lock()
            .map(|slot| {
                slot.as_ref()
                    .is_some_and(|state| state.vault.root() == root)
            })
            .unwrap_or(false)
    }

    fn current_vault_path(&self) -> Option<String> {
        self.vault_state.lock().ok().and_then(|slot| {
            slot.as_ref()
                .map(|state| state.vault.root().to_string_lossy().into_owned())
        })
    }

    pub fn set_instance_guard(&self, guard: SingleInstanceGuard) -> Result<(), CommandError> {
        let mut slot = self
            .instance_guard
            .lock()
            .map_err(|_| CommandError::Internal("instance_guard mutex poisoned".into()))?;
        *slot = Some(guard);
        Ok(())
    }

    pub fn try_start_sync(&self, path: &str) -> Result<bool, CommandError> {
        let mut tracker = self
            .sync_tracker
            .lock()
            .map_err(|_| CommandError::Internal("sync_tracker mutex poisoned".into()))?;
        if !tracker.syncing_vaults.insert(path.to_string()) {
            return Ok(false);
        }
        tracker.dirty_during_sync.remove(path);
        Ok(true)
    }

    pub fn begin_sync_pass(&self, path: &str) -> Result<(), CommandError> {
        let mut tracker = self
            .sync_tracker
            .lock()
            .map_err(|_| CommandError::Internal("sync_tracker mutex poisoned".into()))?;
        tracker.dirty_during_sync.remove(path);
        Ok(())
    }

    pub fn complete_sync_pass(&self, path: &str) -> Result<bool, CommandError> {
        let mut tracker = self
            .sync_tracker
            .lock()
            .map_err(|_| CommandError::Internal("sync_tracker mutex poisoned".into()))?;
        if tracker.dirty_during_sync.remove(path) {
            return Ok(true);
        }
        tracker.syncing_vaults.remove(path);
        Ok(false)
    }

    pub fn abort_sync(&self, path: &str) -> Result<(), CommandError> {
        let mut tracker = self
            .sync_tracker
            .lock()
            .map_err(|_| CommandError::Internal("sync_tracker mutex poisoned".into()))?;
        tracker.syncing_vaults.remove(path);
        tracker.dirty_during_sync.remove(path);
        Ok(())
    }

    pub fn mark_dirty_if_syncing(&self, path: &str) -> bool {
        let Ok(mut tracker) = self.sync_tracker.lock() else {
            return false;
        };
        if !tracker.syncing_vaults.contains(path) {
            return false;
        }
        tracker.dirty_during_sync.insert(path.to_string());
        true
    }

    pub fn suppress_paths<I>(&self, paths: I, ttl: Duration) -> Result<(), CommandError>
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let mut suppressed = self
            .suppressed_paths
            .lock()
            .map_err(|_| CommandError::Internal("suppressed_paths mutex poisoned".into()))?;
        let now = Instant::now();
        suppressed.retain(|_, deadline| *deadline > now);
        let deadline = now + ttl;
        for path in paths {
            suppressed.insert(path, deadline);
        }
        Ok(())
    }

    pub fn is_path_suppressed(&self, path: &Path) -> bool {
        let Ok(mut suppressed) = self.suppressed_paths.lock() else {
            return false;
        };
        let now = Instant::now();
        suppressed.retain(|_, deadline| *deadline > now);
        suppressed.contains_key(path)
    }
}

#[derive(Debug, Clone, Serialize)]
struct DerivedPreviewChangedPayload {
    path: String,
    checked: usize,
    ready: usize,
    regenerated: usize,
    failed: usize,
}

#[derive(Debug, Clone, Serialize)]
struct DerivedPreviewThumbPayload {
    slug: String,
    is_text: bool,
}

#[derive(Debug, Clone, Serialize)]
struct DerivedPreviewVaultChangedPayload {
    path: String,
}

/// Queue a bounded background preview reconciliation pass. A full pass
/// supersedes queued slugs; incremental requests arriving during a run are
/// drained by the same worker before it exits.
pub fn schedule_preview_reconcile<I>(
    app: &AppHandle,
    vault: VaultLayout,
    slugs: I,
    full_scan: bool,
) -> Result<(), CommandError>
where
    I: IntoIterator<Item = String>,
{
    let state = app.state::<AppState>();
    if !state.is_current_vault(vault.root()) {
        return Ok(());
    }
    let vault_path = vault.root().to_string_lossy().into_owned();
    let should_spawn = {
        let mut queue = state
            .preview_queue
            .lock()
            .map_err(|_| CommandError::Internal("preview queue mutex poisoned".into()))?;
        // Mine has one active vault. Pending work for a previous vault is
        // obsolete after a switch and must never sit ahead of the visible
        // vault in the single-worker queue.
        queue.pending.retain(|path, _| path == &vault_path);
        let work = queue
            .pending
            .entry(vault_path)
            .or_insert_with(|| QueuedPreviewWork {
                vault,
                full_scan: false,
                pending_slugs: BTreeSet::new(),
            });
        if full_scan {
            work.full_scan = true;
            work.pending_slugs.clear();
        } else if !work.full_scan {
            work.pending_slugs.extend(slugs);
        }
        if queue.running {
            false
        } else {
            queue.running = true;
            true
        }
    };
    if !should_spawn {
        return Ok(());
    }

    let app_for_worker = app.clone();
    let spawn = std::thread::Builder::new()
        .name("derived-preview-reconcile".to_string())
        .spawn(move || preview_worker_loop(app_for_worker));
    if let Err(error) = spawn {
        let mut queue = state
            .preview_queue
            .lock()
            .map_err(|_| CommandError::Internal("preview queue mutex poisoned".into()))?;
        queue.running = false;
        return Err(CommandError::Internal(format!(
            "failed to spawn derived preview worker: {error}"
        )));
    }
    Ok(())
}

fn preview_worker_loop(app: AppHandle) {
    loop {
        let work = {
            let state = app.state::<AppState>();
            let Some(active_path) = state.current_vault_path() else {
                let mut queue = state
                    .preview_queue
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                queue.pending.clear();
                queue.running = false;
                return;
            };
            let mut queue = state
                .preview_queue
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            queue.pending.retain(|path, _| path == &active_path);
            let Some(queued) = queue.pending.remove(&active_path) else {
                queue.running = false;
                return;
            };
            (active_path, queued)
        };

        log::info!("derived preview reconciliation started for {}", work.0);
        let active_root = work.1.vault.root().to_path_buf();
        let result = db::open_or_create(&work.1.vault.index_db_path()).and_then(|conn| {
            let mut should_continue = || app.state::<AppState>().is_current_vault(&active_root);
            if work.1.full_scan {
                let mut publish_batch = |report: &derived_preview::PreviewReconcileReport| {
                    if !report.cancelled && app.state::<AppState>().is_current_vault(&active_root) {
                        publish_preview_report(&app, &work.0, report);
                    }
                };
                derived_preview::reconcile_all_previews_with_progress(
                    &conn,
                    &work.1.vault,
                    &mut should_continue,
                    &mut publish_batch,
                )
            } else {
                derived_preview::reconcile_preview_slugs_while(
                    &conn,
                    &work.1.vault,
                    work.1.pending_slugs.iter().map(String::as_str),
                    &mut should_continue,
                )
            }
        });
        match result {
            Ok(report) => {
                if report.cancelled
                    || !app
                        .state::<AppState>()
                        .is_current_vault(work.1.vault.root())
                {
                    log::info!(
                        "derived preview reconciliation cancelled for {} after {} blocks",
                        work.0,
                        report.checked
                    );
                    continue;
                }
                if !work.1.full_scan {
                    publish_preview_report(&app, &work.0, &report);
                }
                log::info!(
                    "derived preview reconciliation finished for {}: checked={} ready={} regenerated={} failed={}",
                    work.0,
                    report.checked,
                    report.ready,
                    report.regenerated,
                    report.failed.len()
                );
            }
            Err(error) => {
                log::warn!(
                    "derived preview reconciliation failed for {}: {error:#}",
                    work.0
                );
            }
        }
    }
}

fn publish_preview_report(
    app: &AppHandle,
    path: &str,
    report: &derived_preview::PreviewReconcileReport,
) {
    for slug in &report.changed_slugs {
        let _ = app.emit(
            "thumb:updated",
            DerivedPreviewThumbPayload {
                slug: slug.clone(),
                is_text: false,
            },
        );
    }
    let _ = app.emit(
        "derived-preview-changed",
        DerivedPreviewChangedPayload {
            path: path.to_string(),
            checked: report.checked,
            ready: report.ready,
            regenerated: report.regenerated,
            failed: report.failed.len(),
        },
    );
    if !report.failed.is_empty() {
        let _ = app.emit("derived-preview-pending", ());
    }
    if !report.changed_slugs.is_empty() {
        let _ = app.emit(
            "vault-changed",
            DerivedPreviewVaultChangedPayload {
                path: path.to_string(),
            },
        );
    }
}

impl FreshnessCoordinator {
    /// Decide whether a route can read the committed snapshot immediately or
    /// needs to await/schedule reconciliation. Safety-audit expiry never blocks
    /// a snapshot that has already completed at least one generation.
    pub fn route_action(&self, vault_path: &str) -> FreshnessRouteAction {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let entry = state.entry(vault_path.to_string()).or_default();

        if entry.last_result.is_none() {
            return FreshnessRouteAction::AwaitFirstGeneration;
        }
        if entry.running || entry.scheduled {
            entry.fast_path_hits = entry.fast_path_hits.saturating_add(1);
            return FreshnessRouteAction::ReadCommitted;
        }

        let safety_audit_due = entry.last_completed_at.map_or(true, |completed| {
            completed.elapsed() >= FRESHNESS_SAFETY_AUDIT_INTERVAL
        });
        if entry.dirty || safety_audit_due {
            entry.scheduled = true;
            return FreshnessRouteAction::SpawnBackground;
        }

        entry.fast_path_hits = entry.fast_path_hits.saturating_add(1);
        FreshnessRouteAction::ReadCommitted
    }

    /// Join or start one reconciliation generation. A completed clean or
    /// degraded generation is reused until an explicit dirty marker or safety
    /// audit claims another pass.
    pub fn reconcile(&self, vault: &VaultLayout) -> FreshnessOutcome {
        let vault_path = vault.root().to_string_lossy().into_owned();
        self.run(vault_path, || {
            db::open_or_create(&vault.index_db_path())
                .map_err(|error| format!("failed to open freshness database: {error:#}"))
                .and_then(|conn| {
                    reconcile::reconcile_vault(&conn, vault)
                        .map_err(|error| format!("filesystem reconciliation failed: {error:#}"))
                })
        })
    }

    /// Execute a generation previously claimed by `route_action`.
    pub fn reconcile_scheduled(&self, vault: &VaultLayout) -> FreshnessOutcome {
        let vault_path = vault.root().to_string_lossy().into_owned();
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            let entry = state.entry(vault_path).or_default();
            entry.scheduled = false;
            entry.dirty = true;
        }
        self.reconcile(vault)
    }

    fn run(
        &self,
        vault_path: String,
        task: impl Fn() -> Result<ReconcileReport, String>,
    ) -> FreshnessOutcome {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let entry = state.entry(vault_path.clone()).or_default();

        if entry.running {
            let generation = entry.generation;
            entry.joined_callers = entry.joined_callers.saturating_add(1);
            while state
                .get(&vault_path)
                .is_some_and(|current| current.running && current.generation == generation)
            {
                state = self
                    .changed
                    .wait(state)
                    .unwrap_or_else(|error| error.into_inner());
            }
            let completed = state
                .get(&vault_path)
                .expect("freshness entry remains present after reconciliation");
            return FreshnessOutcome {
                vault_path,
                generation: completed.generation,
                joined_callers: completed.joined_callers,
                fast_path_hits: completed.fast_path_hits,
                ran_reconcile: false,
                result: completed.last_result.clone().unwrap_or_else(|| {
                    Err("freshness generation completed without a result".to_string())
                }),
            };
        }

        entry.scheduled = false;
        if !entry.dirty {
            if let Some(result) = entry.last_result.clone() {
                entry.fast_path_hits = entry.fast_path_hits.saturating_add(1);
                return FreshnessOutcome {
                    vault_path,
                    generation: entry.generation,
                    joined_callers: 0,
                    fast_path_hits: entry.fast_path_hits,
                    ran_reconcile: false,
                    result,
                };
            }
        }

        entry.running = true;
        entry.dirty = false;
        entry.joined_callers = 0;
        drop(state);

        let (result, mut state) = loop {
            let result = task();
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            let entry = state
                .get_mut(&vault_path)
                .expect("freshness entry remains present while leader is running");
            if entry.dirty {
                entry.dirty = false;
                drop(state);
                continue;
            }
            break (result, state);
        };

        let entry = state
            .get_mut(&vault_path)
            .expect("freshness entry remains present while leader is running");
        entry.running = false;
        entry.scheduled = false;
        entry.generation = entry.generation.saturating_add(1);
        entry.last_completed_at = Some(Instant::now());
        entry.last_result = Some(result.clone());
        let outcome = FreshnessOutcome {
            vault_path,
            generation: entry.generation,
            joined_callers: entry.joined_callers,
            fast_path_hits: entry.fast_path_hits,
            ran_reconcile: true,
            result,
        };
        self.changed.notify_all();
        outcome
    }

    /// Mark the running generation dirty so its leader performs another
    /// delta-pass before publishing. Returns true when the watcher should skip
    /// its parallel per-event write because the generation now owns recovery.
    pub fn mark_dirty_if_running(&self, vault_path: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(entry) = state.get_mut(vault_path) else {
            return false;
        };
        if !entry.running {
            return false;
        }
        entry.dirty = true;
        true
    }

    /// Persist a dirty marker while no generation is running. The next route
    /// serves last-good data and schedules one background pass.
    pub fn mark_dirty(&self, vault_path: &str) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.entry(vault_path.to_string()).or_default().dirty = true;
    }
}

pub fn current_vault_layout(state: &AppState) -> Result<VaultLayout, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(vs.vault.clone())
}

/// Ensure route reads have at least one committed generation, then use
/// stale-while-revalidate for later dirty/safety-audit generations. A readable
/// last-good SQLite snapshot is never rejected because one source file failed.
pub async fn ensure_vault_fresh(app: &AppHandle, vault: VaultLayout) -> Result<(), CommandError> {
    let vault_path = vault.root().to_string_lossy().into_owned();
    match app.state::<AppState>().freshness.route_action(&vault_path) {
        FreshnessRouteAction::ReadCommitted => Ok(()),
        FreshnessRouteAction::SpawnBackground => {
            let app_for_task = app.clone();
            let preview_vault = vault.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let outcome = app_for_task
                    .state::<AppState>()
                    .freshness
                    .reconcile_scheduled(&vault);
                publish_freshness_outcome(&app_for_task, preview_vault, outcome);
            });
            Ok(())
        }
        FreshnessRouteAction::AwaitFirstGeneration => {
            let app_for_task = app.clone();
            let preview_vault = vault.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                app_for_task.state::<AppState>().freshness.reconcile(&vault)
            })
            .await
            {
                Ok(outcome) => publish_freshness_outcome(app, preview_vault, outcome),
                Err(error) => {
                    let message = format!("freshness reconciliation task join failed: {error}");
                    log::warn!("{message}");
                    append_startup_trace(
                        app,
                        "vault_freshness",
                        &format!("state=failed {message}"),
                    );
                }
            }
            Ok(())
        }
    }
}

fn publish_freshness_outcome(
    app: &AppHandle,
    preview_vault: VaultLayout,
    outcome: FreshnessOutcome,
) {
    match outcome.result {
        Ok(report) => {
            let changed = !report.upserted.is_empty()
                || !report.dependency_changed.is_empty()
                || !report.removed.is_empty();
            if outcome.ran_reconcile && changed {
                let changed_slugs = report
                    .upserted
                    .iter()
                    .chain(&report.dependency_changed)
                    .cloned()
                    .collect::<BTreeSet<_>>();
                if let Err(error) = schedule_preview_reconcile(
                    app,
                    preview_vault.clone(),
                    changed_slugs,
                    !report.removed.is_empty(),
                ) {
                    log::warn!("failed to schedule derived preview reconciliation: {error}");
                }
            }
            let state = if report.is_fresh() {
                "fresh"
            } else {
                "degraded"
            };
            if outcome.ran_reconcile {
                append_startup_trace(
                    app,
                    "vault_freshness",
                    &format!(
                        "state={} generation={} joined={} fast_path_hits={} inventory={} reads={} writes={} errors={} elapsed_ms={}",
                        state,
                        outcome.generation,
                        outcome.joined_callers,
                        outcome.fast_path_hits,
                        report.inventory_markdown,
                        report.content_reads,
                        report.database_writes,
                        report.errors.len(),
                        report.elapsed_ms,
                    ),
                );
                let _ = app.emit(
                    "vault-freshness-changed",
                    VaultFreshnessChangedPayload {
                        vault_path: outcome.vault_path.clone(),
                        generation: outcome.generation,
                        state,
                        joined_callers: outcome.joined_callers,
                        inventory_markdown: report.inventory_markdown,
                        content_reads: report.content_reads,
                        database_writes: report.database_writes,
                        error_count: report.errors.len(),
                        elapsed_ms: report.elapsed_ms,
                        fast_path_hits: outcome.fast_path_hits,
                    },
                );
            }
            if !report.is_fresh() {
                log::warn!(
                    "vault freshness degraded for {}: {} source error(s); serving last-good snapshot",
                    outcome.vault_path,
                    report.errors.len()
                );
            }
            if outcome.ran_reconcile && changed {
                let _ = app.emit(
                    "vault-changed",
                    DerivedPreviewVaultChangedPayload {
                        path: outcome.vault_path,
                    },
                );
            }
        }
        Err(message) => {
            if outcome.ran_reconcile {
                append_startup_trace(
                    app,
                    "vault_freshness",
                    &format!(
                        "state=failed generation={} joined={} error={}",
                        outcome.generation, outcome.joined_callers, message
                    ),
                );
                let _ = app.emit(
                    "vault-freshness-changed",
                    VaultFreshnessChangedPayload {
                        vault_path: outcome.vault_path.clone(),
                        generation: outcome.generation,
                        state: "failed",
                        joined_callers: outcome.joined_callers,
                        inventory_markdown: 0,
                        content_reads: 0,
                        database_writes: 0,
                        error_count: 1,
                        elapsed_ms: 0,
                        fast_path_hits: outcome.fast_path_hits,
                    },
                );
            }
            log::warn!(
                "vault freshness failed for {}: {}; attempting last-good snapshot",
                outcome.vault_path,
                message
            );
        }
    }
}

/// Error type for Tauri commands. Serialized as a string for the frontend.
#[derive(Debug, Error)]
pub enum CommandError {
    #[error("no vault selected")]
    NoVault,

    #[error("{0}")]
    Internal(String),
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for CommandError {
    fn from(e: anyhow::Error) -> Self {
        CommandError::Internal(format!("{:#}", e))
    }
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/// Current UTC time as ISO 8601 string (without chrono dependency).
/// Delegates to `crate::util::now_iso8601`.
pub fn now_iso8601() -> String {
    crate::util::now_iso8601()
}

#[cfg(test)]
mod tests {
    use super::{AppState, FreshnessCoordinator, FreshnessRouteAction, VaultState};
    use crate::domain::vault::VaultLayout;
    use crate::storage::db;
    use crate::storage::reconcile::{ReconcileFileError, ReconcileFileErrorKind, ReconcileReport};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};

    #[test]
    fn sync_tracker_repeats_when_marked_dirty() {
        let state = AppState::new();
        assert!(state.try_start_sync("/tmp/vault").unwrap());
        state.begin_sync_pass("/tmp/vault").unwrap();
        assert!(state.mark_dirty_if_syncing("/tmp/vault"));
        assert!(state.complete_sync_pass("/tmp/vault").unwrap());
        state.begin_sync_pass("/tmp/vault").unwrap();
        assert!(!state.complete_sync_pass("/tmp/vault").unwrap());
    }

    #[test]
    fn sync_tracker_ignores_dirty_marks_outside_sync() {
        let state = AppState::new();
        assert!(!state.mark_dirty_if_syncing("/tmp/vault"));
        assert!(state.try_start_sync("/tmp/vault").unwrap());
        assert!(state.mark_dirty_if_syncing("/tmp/vault"));
        state.abort_sync("/tmp/vault").unwrap();
        assert!(!state.mark_dirty_if_syncing("/tmp/vault"));
    }

    #[test]
    fn suppressed_paths_expire_after_deadline() {
        let state = AppState::new();
        let path = std::path::PathBuf::from("/tmp/doc.md");
        state
            .suppress_paths([path.clone()], std::time::Duration::from_millis(5))
            .unwrap();
        assert!(state.is_path_suppressed(&path));
        std::thread::sleep(std::time::Duration::from_millis(10));
        assert!(!state.is_path_suppressed(&path));
    }

    #[test]
    fn background_work_matches_only_the_current_vault() {
        let state = AppState::new();
        let source = tempfile::tempdir().unwrap();
        let derived = source.path().join("derived");
        let vault = VaultLayout::with_derived_root(source.path().to_path_buf(), derived);
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        *state.vault_state.lock().unwrap() = Some(VaultState {
            conn,
            vault: vault.clone(),
        });

        assert!(state.is_current_vault(vault.root()));
        assert!(!state.is_current_vault(&source.path().join("other")));
    }

    #[test]
    fn thumbnail_sweeps_coalesce_same_vault_and_queue_latest_switch() {
        let state = AppState::new();
        let first_source = tempfile::tempdir().unwrap();
        let second_source = tempfile::tempdir().unwrap();
        let first = VaultLayout::with_derived_root(
            first_source.path().to_path_buf(),
            first_source.path().join("derived"),
        );
        let second = VaultLayout::with_derived_root(
            second_source.path().to_path_buf(),
            second_source.path().join("derived"),
        );

        let first_guard = state.try_start_sweep(&first).unwrap();
        assert!(state.try_start_sweep(&first).is_none());
        assert!(state.take_pending_sweep().is_none());
        assert!(state.try_start_sweep(&second).is_none());
        drop(first_guard);

        let pending = state.take_pending_sweep().unwrap();
        assert_eq!(pending.root(), second.root());
        assert!(state.try_start_sweep(&second).is_some());
    }

    #[test]
    fn freshness_coordinator_coalesces_concurrent_callers() {
        let coordinator = Arc::new(FreshnessCoordinator::default());
        let vault_path = "/tmp/coalesced-vault".to_string();
        let task_runs = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let mut callers = Vec::new();
        for _ in 0..8 {
            let coordinator = Arc::clone(&coordinator);
            let path = vault_path.clone();
            let task_runs = Arc::clone(&task_runs);
            let gate = Arc::clone(&gate);
            callers.push(std::thread::spawn(move || {
                coordinator.run(path, || {
                    task_runs.fetch_add(1, Ordering::SeqCst);
                    let (open, changed) = &*gate;
                    let mut open = open.lock().unwrap();
                    while !*open {
                        open = changed.wait(open).unwrap();
                    }
                    Ok(ReconcileReport {
                        inventory_markdown: 1,
                        unchanged: 1,
                        upserted: Vec::new(),
                        removed: Vec::new(),
                        dependency_changed: Vec::new(),
                        errors: Vec::new(),
                        content_reads: 0,
                        database_writes: 0,
                        elapsed_ms: 1,
                    })
                })
            }));
        }

        while coordinator
            .state
            .lock()
            .unwrap()
            .get(&vault_path)
            .is_none_or(|entry| entry.joined_callers != 7)
        {
            std::thread::yield_now();
        }
        {
            let (open, changed) = &*gate;
            *open.lock().unwrap() = true;
            changed.notify_all();
        }
        let outcomes = callers
            .into_iter()
            .map(|caller| caller.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(task_runs.load(Ordering::SeqCst), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| outcome.ran_reconcile)
                .count(),
            1
        );
        assert!(outcomes.iter().all(|outcome| outcome.generation == 1));
        assert!(outcomes
            .iter()
            .all(|outcome| outcome.result.as_ref().unwrap().inventory_markdown == 1));
    }

    #[test]
    fn freshness_coordinator_reuses_clean_generation_for_sequential_reads() {
        let coordinator = FreshnessCoordinator::default();
        let vault_path = "/tmp/sequential-vault".to_string();
        let task_runs = AtomicUsize::new(0);

        let first = coordinator.run(vault_path.clone(), || {
            task_runs.fetch_add(1, Ordering::SeqCst);
            Ok(ReconcileReport {
                inventory_markdown: 10_000,
                unchanged: 10_000,
                upserted: Vec::new(),
                removed: Vec::new(),
                dependency_changed: Vec::new(),
                errors: Vec::new(),
                content_reads: 0,
                database_writes: 0,
                elapsed_ms: 100,
            })
        });
        assert!(first.ran_reconcile);

        for _ in 0..100 {
            let outcome = coordinator.run(vault_path.clone(), || {
                task_runs.fetch_add(1, Ordering::SeqCst);
                unreachable!("clean sequential route must not run inventory")
            });
            assert!(!outcome.ran_reconcile);
            assert_eq!(outcome.generation, 1);
        }

        assert_eq!(task_runs.load(Ordering::SeqCst), 1);
        assert_eq!(
            coordinator.route_action(&vault_path),
            FreshnessRouteAction::ReadCommitted
        );
    }

    #[test]
    fn degraded_generation_is_readable_and_does_not_retry_each_route() {
        let coordinator = FreshnessCoordinator::default();
        let vault_path = "/tmp/degraded-vault".to_string();
        let task_runs = AtomicUsize::new(0);
        let first = coordinator.run(vault_path.clone(), || {
            task_runs.fetch_add(1, Ordering::SeqCst);
            Ok(ReconcileReport {
                inventory_markdown: 2,
                unchanged: 1,
                upserted: Vec::new(),
                removed: Vec::new(),
                dependency_changed: Vec::new(),
                errors: vec![ReconcileFileError {
                    path: "broken.md".to_string(),
                    kind: ReconcileFileErrorKind::Parse,
                    message: "broken fixture".to_string(),
                }],
                content_reads: 1,
                database_writes: 0,
                elapsed_ms: 1,
            })
        });
        assert!(!first.result.as_ref().unwrap().is_fresh());

        let cached = coordinator.run(vault_path.clone(), || {
            task_runs.fetch_add(1, Ordering::SeqCst);
            unreachable!("degraded last-good generation must be cached")
        });
        assert!(!cached.ran_reconcile);
        assert_eq!(cached.result.unwrap().errors.len(), 1);
        assert_eq!(task_runs.load(Ordering::SeqCst), 1);
        assert_eq!(
            coordinator.route_action(&vault_path),
            FreshnessRouteAction::ReadCommitted
        );
    }

    #[test]
    fn dirty_committed_generation_claims_one_background_pass() {
        let coordinator = FreshnessCoordinator::default();
        let vault_path = "/tmp/background-vault".to_string();
        let task_runs = AtomicUsize::new(0);
        let report = || ReconcileReport {
            inventory_markdown: 1,
            unchanged: 1,
            upserted: Vec::new(),
            removed: Vec::new(),
            dependency_changed: Vec::new(),
            errors: Vec::new(),
            content_reads: 0,
            database_writes: 0,
            elapsed_ms: 1,
        };

        coordinator.run(vault_path.clone(), || {
            task_runs.fetch_add(1, Ordering::SeqCst);
            Ok(report())
        });
        coordinator.mark_dirty(&vault_path);
        assert_eq!(
            coordinator.route_action(&vault_path),
            FreshnessRouteAction::SpawnBackground
        );
        assert_eq!(
            coordinator.route_action(&vault_path),
            FreshnessRouteAction::ReadCommitted
        );

        let source = tempfile::tempdir().unwrap();
        let vault = VaultLayout::with_derived_root(
            source.path().to_path_buf(),
            source.path().join("derived"),
        );
        let actual_path = vault.root().to_string_lossy().into_owned();
        coordinator.run(actual_path.clone(), || Ok(report()));
        coordinator.mark_dirty(&actual_path);
        assert_eq!(
            coordinator.route_action(&actual_path),
            FreshnessRouteAction::SpawnBackground
        );
        let outcome = coordinator.reconcile_scheduled(&vault);
        assert!(outcome.ran_reconcile);
        assert_eq!(
            coordinator.route_action(&actual_path),
            FreshnessRouteAction::ReadCommitted
        );
    }

    #[test]
    fn dirty_running_generation_reconciles_again_before_publish() {
        let coordinator = Arc::new(FreshnessCoordinator::default());
        let vault_path = "/tmp/dirty-vault".to_string();
        let task_runs = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_coordinator = Arc::clone(&coordinator);
        let worker_path = vault_path.clone();
        let worker_runs = Arc::clone(&task_runs);
        let worker_gate = Arc::clone(&gate);
        let worker = std::thread::spawn(move || {
            worker_coordinator.run(worker_path, || {
                let run = worker_runs.fetch_add(1, Ordering::SeqCst);
                if run == 0 {
                    let (open, changed) = &*worker_gate;
                    let mut open = open.lock().unwrap();
                    while !*open {
                        open = changed.wait(open).unwrap();
                    }
                }
                Ok(ReconcileReport {
                    inventory_markdown: run + 1,
                    unchanged: 0,
                    upserted: Vec::new(),
                    removed: Vec::new(),
                    dependency_changed: Vec::new(),
                    errors: Vec::new(),
                    content_reads: 0,
                    database_writes: 0,
                    elapsed_ms: 1,
                })
            })
        });

        while task_runs.load(Ordering::SeqCst) != 1 {
            std::thread::yield_now();
        }
        assert!(coordinator.mark_dirty_if_running(&vault_path));
        {
            let (open, changed) = &*gate;
            *open.lock().unwrap() = true;
            changed.notify_all();
        }
        let outcome = worker.join().unwrap();

        assert_eq!(task_runs.load(Ordering::SeqCst), 2);
        assert_eq!(outcome.generation, 1);
        assert_eq!(outcome.result.unwrap().inventory_markdown, 2);
        assert!(!coordinator.mark_dirty_if_running(&vault_path));
    }
}
