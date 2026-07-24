use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::state::{AppState, CommandError};
use crate::domain::vault::VaultLayout;
use crate::storage::{db, derived_preview};

#[derive(Default)]
pub struct PreviewReconcileCoordinator {
    queue: Mutex<PreviewWorkQueue>,
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

/// Queue one bounded background preview pass. Full work supersedes pending
/// slugs and one worker drains changes that arrive while it is running.
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
            .preview_reconcile
            .queue
            .lock()
            .map_err(|_| CommandError::Internal("preview queue mutex poisoned".into()))?;
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
            .preview_reconcile
            .queue
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
                    .preview_reconcile
                    .queue
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                queue.pending.clear();
                queue.running = false;
                return;
            };
            let mut queue = state
                .preview_reconcile
                .queue
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
