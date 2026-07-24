use std::collections::{BTreeSet, HashMap};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::preview_reconcile::schedule_preview_reconcile;
use super::state::{AppState, CommandError};
use crate::domain::vault::VaultLayout;
use crate::storage::reconcile::ReconcileReport;
use crate::storage::{db, reconcile};
use crate::util::append_startup_trace;

const FRESHNESS_SAFETY_AUDIT_INTERVAL: Duration = Duration::from_secs(30);

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
    AwaitFirstGeneration,
    SpawnBackground,
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

#[derive(Debug, Clone, Serialize)]
struct VaultChangedPayload {
    path: String,
}

impl FreshnessCoordinator {
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

    pub fn mark_dirty(&self, vault_path: &str) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.entry(vault_path.to_string()).or_default().dirty = true;
    }
}

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
                    VaultChangedPayload {
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

#[cfg(test)]
mod tests {
    use super::{FreshnessCoordinator, FreshnessRouteAction};
    use crate::domain::vault::VaultLayout;
    use crate::storage::reconcile::{ReconcileFileError, ReconcileFileErrorKind, ReconcileReport};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};

    fn clean_report(inventory_markdown: usize) -> ReconcileReport {
        ReconcileReport {
            inventory_markdown,
            unchanged: inventory_markdown,
            upserted: Vec::new(),
            removed: Vec::new(),
            dependency_changed: Vec::new(),
            errors: Vec::new(),
            content_reads: 0,
            database_writes: 0,
            elapsed_ms: 1,
        }
    }

    #[test]
    fn coalesces_concurrent_callers() {
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
                    Ok(clean_report(1))
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
    }

    #[test]
    fn reuses_clean_generation_for_sequential_reads() {
        let coordinator = FreshnessCoordinator::default();
        let vault_path = "/tmp/sequential-vault".to_string();
        let task_runs = AtomicUsize::new(0);

        let first = coordinator.run(vault_path.clone(), || {
            task_runs.fetch_add(1, Ordering::SeqCst);
            Ok(clean_report(10_000))
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
    fn degraded_generation_is_readable_and_cached() {
        let coordinator = FreshnessCoordinator::default();
        let vault_path = "/tmp/degraded-vault".to_string();
        let task_runs = AtomicUsize::new(0);
        let first = coordinator.run(vault_path.clone(), || {
            task_runs.fetch_add(1, Ordering::SeqCst);
            let mut report = clean_report(2);
            report.unchanged = 1;
            report.errors.push(ReconcileFileError {
                path: "broken.md".to_string(),
                kind: ReconcileFileErrorKind::Parse,
                message: "broken fixture".to_string(),
            });
            Ok(report)
        });
        assert!(!first.result.as_ref().unwrap().is_fresh());

        let cached = coordinator.run(vault_path.clone(), || {
            task_runs.fetch_add(1, Ordering::SeqCst);
            unreachable!("degraded last-good generation must be cached")
        });
        assert!(!cached.ran_reconcile);
        assert_eq!(cached.result.unwrap().errors.len(), 1);
        assert_eq!(task_runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dirty_committed_generation_claims_one_background_pass() {
        let coordinator = FreshnessCoordinator::default();
        let vault_path = "/tmp/background-vault".to_string();
        coordinator.run(vault_path.clone(), || Ok(clean_report(1)));
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
        coordinator.run(actual_path.clone(), || Ok(clean_report(1)));
        coordinator.mark_dirty(&actual_path);
        assert_eq!(
            coordinator.route_action(&actual_path),
            FreshnessRouteAction::SpawnBackground
        );
        assert!(coordinator.reconcile_scheduled(&vault).ran_reconcile);
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
                Ok(clean_report(run + 1))
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
        assert_eq!(outcome.result.unwrap().inventory_markdown, 2);
        assert!(!coordinator.mark_dirty_if_running(&vault_path));
    }
}
