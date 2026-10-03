use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::state::{AppState, CommandError};
use crate::domain::vault::VaultLayout;
use crate::storage::derived_preview::{PreviewPassProgress, PreviewReconcileReport};
use crate::storage::{db, derived_preview};

/// Cards between two `derived-preview-progress` events of one full pass.
const PREVIEW_PROGRESS_EVERY_CARDS: usize = 10;
/// Longest a moving count of a full pass goes unreported.
const PREVIEW_PROGRESS_EVERY: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct PreviewReconcileCoordinator {
    queue: Mutex<PreviewWorkQueue>,
}

#[derive(Default)]
struct PreviewWorkQueue {
    running: bool,
    pending: BTreeMap<String, QueuedPreviewWork>,
}

impl PreviewWorkQueue {
    /// Keep queued work only for the `open` spaces (SPEC_TABS.md, В14).
    /// Returns the spaces whose queued full pass was dropped: each is owed
    /// `derived-preview-finished`, since nothing will run for it any more.
    fn keep_only(&mut self, open: &BTreeSet<String>) -> Vec<String> {
        let mut dropped_full_passes = Vec::new();
        self.pending.retain(|path, work| {
            let keep = open.contains(path);
            if !keep && work.full_scan {
                dropped_full_passes.push(path.clone());
            }
            keep
        });
        dropped_full_passes
    }

    /// Whether another full pass for `path` waits its turn.
    fn full_pass_queued(&self, path: &str) -> bool {
        self.pending.get(path).is_some_and(|work| work.full_scan)
    }

    /// Take the next queued work: the `first` space when it waits, else the
    /// first space in order.
    fn take_next(&mut self, first: Option<&str>) -> Option<(String, QueuedPreviewWork)> {
        let path = first
            .filter(|path| self.pending.contains_key(*path))
            .map(str::to_string)
            .or_else(|| self.pending.keys().next().cloned())?;
        self.pending.remove(&path).map(|work| (path, work))
    }
}

/// The folders of every open space, as queue keys.
fn open_paths(state: &AppState) -> BTreeSet<String> {
    state
        .spaces
        .open_roots()
        .into_iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect()
}

/// The folder served first: the space of the most recently used tab.
fn first_path(state: &AppState) -> Option<String> {
    state
        .tabs
        .last_active_space()
        .and_then(|space| space.root())
        .map(|root| root.to_string_lossy().into_owned())
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
    path: String,
    slug: String,
    is_text: bool,
}

#[derive(Debug, Clone, Serialize)]
struct DerivedPreviewVaultChangedPayload {
    path: String,
    preview_only: bool,
}

/// `derived-preview-queued`: a full preview pass waits or runs for `path`.
#[derive(Debug, Clone, Serialize)]
struct DerivedPreviewQueuedPayload {
    path: String,
}

/// `derived-preview-progress`: how far the running full pass for `path` has
/// come (SPEC_ONBOARDING.md, О13).
#[derive(Debug, Clone, Serialize)]
struct DerivedPreviewProgressPayload {
    path: String,
    processed: usize,
    total: usize,
}

/// `derived-preview-finished`: no full preview pass waits or runs for `path`
/// any more, whether the last one finished, failed or was cancelled.
#[derive(Debug, Clone, Serialize)]
struct DerivedPreviewFinishedPayload {
    path: String,
}

/// Which counts of one full pass reach the window: the start, the first card,
/// then every `PREVIEW_PROGRESS_EVERY_CARDS` cards or `PREVIEW_PROGRESS_EVERY`,
/// whichever comes first, and the last card. A pass with no cards has nothing
/// to count and reports nothing.
#[derive(Debug, Default)]
struct PreviewProgressThrottle {
    last_reported: Option<(usize, Instant)>,
}

impl PreviewProgressThrottle {
    fn admit(&mut self, progress: PreviewPassProgress, now: Instant) -> bool {
        if progress.total == 0 {
            return false;
        }
        let due = progress.processed <= 1
            || progress.processed >= progress.total
            || self.last_reported.is_none_or(|(processed, at)| {
                progress.processed.saturating_sub(processed) >= PREVIEW_PROGRESS_EVERY_CARDS
                    || now.saturating_duration_since(at) >= PREVIEW_PROGRESS_EVERY
            });
        if due {
            self.last_reported = Some((progress.processed, now));
        }
        due
    }
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
    let write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    let state = app.state::<AppState>();
    if !state.is_open_root(vault.root()) {
        return Ok(());
    }
    let vault_path = vault.root().to_string_lossy().into_owned();
    let should_spawn = {
        let mut queue = state
            .preview_reconcile
            .queue
            .lock()
            .map_err(|_| CommandError::Internal("preview queue mutex poisoned".into()))?;
        for dropped in queue.keep_only(&open_paths(&state)) {
            announce_previews_finished(app, dropped);
        }
        let work = queue
            .pending
            .entry(vault_path.clone())
            .or_insert_with(|| QueuedPreviewWork {
                vault,
                full_scan: false,
                pending_slugs: BTreeSet::new(),
            });
        if full_scan {
            work.full_scan = true;
            work.pending_slugs.clear();
            // Sent under the queue lock from the scheduling thread, so it
            // reaches the window before whatever this thread sends next (the
            // sync pass's `vault-sync-finished`) and in order with the
            // worker's `derived-preview-finished`: the opening notice sees no
            // gap between indexing and previews (SPEC_ONBOARDING.md, О13).
            crate::commands::space_events::emit_to_space_path(
                app,
                &vault_path,
                "derived-preview-queued",
                DerivedPreviewQueuedPayload {
                    path: vault_path.clone(),
                },
            );
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
        .spawn(move || {
            let _write = write;
            preview_worker_loop(app_for_worker)
        });
    if let Err(error) = spawn {
        let mut queue = state
            .preview_reconcile
            .queue
            .lock()
            .map_err(|_| CommandError::Internal("preview queue mutex poisoned".into()))?;
        queue.running = false;
        // The work stays queued for the next worker, but nothing runs it now.
        if queue.full_pass_queued(&vault_path) {
            announce_previews_finished(app, vault_path);
        }
        return Err(CommandError::Internal(format!(
            "failed to spawn derived preview worker: {error}"
        )));
    }
    Ok(())
}

fn preview_worker_loop(app: AppHandle) {
    let Ok(_write) = crate::storage::source_mutation::begin_write() else {
        return;
    };
    loop {
        let work = {
            let state = app.state::<AppState>();
            let open = open_paths(&state);
            let first = first_path(&state);
            let mut queue = state
                .preview_reconcile
                .queue
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            for dropped in queue.keep_only(&open) {
                announce_previews_finished(&app, dropped);
            }
            let Some(next) = queue.take_next(first.as_deref()) else {
                queue.running = false;
                return;
            };
            next
        };

        log::info!("derived preview reconciliation started for {}", work.0);
        let active_root = work.1.vault.root().to_path_buf();
        let result = db::open_or_create(&work.1.vault.index_db_path()).and_then(|conn| {
            let is_current = || app.state::<AppState>().is_open_root(&active_root);
            let mut publish_batch = |report: &PreviewReconcileReport| {
                if !report.cancelled && is_current() {
                    publish_preview_report(&app, &work.0, report);
                }
            };
            let mut publish_progress = |progress: PreviewPassProgress| {
                if is_current() {
                    crate::commands::space_events::emit_to_space_path(
                        &app,
                        &work.0,
                        "derived-preview-progress",
                        DerivedPreviewProgressPayload {
                            path: work.0.clone(),
                            processed: progress.processed,
                            total: progress.total,
                        },
                    );
                }
            };
            run_queued_work(
                &conn,
                &work.1,
                &mut || is_current(),
                &mut publish_batch,
                &mut publish_progress,
                &mut Instant::now,
            )
        });
        if work.1.full_scan {
            finish_full_pass(&app, &work.0);
        }
        match result {
            Ok(report) => {
                if report.cancelled
                    || !app
                        .state::<AppState>()
                        .is_open_root(work.1.vault.root())
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

/// Run one queued item against `conn`.
///
/// A full pass publishes its batches through `on_batch` and its count through
/// `on_progress`, thinned by [`PreviewProgressThrottle`] on the clock `now`.
/// A pass over named cards (one saved file, one regenerated thumbnail) reports
/// neither: its caller publishes the whole report, and it has no total worth
/// a notice.
fn run_queued_work(
    conn: &Connection,
    work: &QueuedPreviewWork,
    should_continue: &mut dyn FnMut() -> bool,
    on_batch: &mut dyn FnMut(&PreviewReconcileReport),
    on_progress: &mut dyn FnMut(PreviewPassProgress),
    now: &mut dyn FnMut() -> Instant,
) -> anyhow::Result<PreviewReconcileReport> {
    if !work.full_scan {
        return derived_preview::reconcile_preview_slugs_while(
            conn,
            &work.vault,
            work.pending_slugs.iter().map(String::as_str),
            should_continue,
        );
    }
    let mut throttle = PreviewProgressThrottle::default();
    derived_preview::reconcile_all_previews_with_progress(
        conn,
        &work.vault,
        should_continue,
        on_batch,
        &mut |progress| {
            if throttle.admit(progress, now()) {
                on_progress(progress);
            }
        },
    )
}

/// A full pass for `path` has ended. Previews stay pending while another full
/// pass for the same space waits its turn: the next one picks up the count
/// without the notice dropping out between them. Checked and sent under the
/// queue lock, so a pass queued meanwhile is either seen here or announced
/// after this event.
fn finish_full_pass(app: &AppHandle, path: &str) {
    let state = app.state::<AppState>();
    let queue = state
        .preview_reconcile
        .queue
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !queue.full_pass_queued(path) {
        announce_previews_finished(app, path.to_string());
    }
}

fn announce_previews_finished(app: &AppHandle, path: String) {
    crate::commands::space_events::emit_to_space_path(
        app,
        &path.clone(),
        "derived-preview-finished",
        DerivedPreviewFinishedPayload { path },
    );
}

fn publish_preview_report(app: &AppHandle, path: &str, report: &PreviewReconcileReport) {
    for slug in &report.changed_slugs {
        crate::commands::space_events::emit_to_space_path(
            app,
            path,
            "thumb:updated",
            DerivedPreviewThumbPayload {
                path: path.to_string(),
                slug: slug.clone(),
                is_text: false,
            },
        );
    }
    crate::commands::space_events::emit_to_space_path(
        app,
        path,
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
        crate::commands::space_events::emit_to_lead(app, std::path::Path::new(path), "derived-preview-pending", ());
    }
    if !report.changed_slugs.is_empty() {
        crate::commands::space_events::emit_to_space_path(
            app,
            path,
            "vault-changed",
            DerivedPreviewVaultChangedPayload {
                path: path.to_string(),
                preview_only: true,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::reconcile;

    fn progress(processed: usize, total: usize) -> PreviewPassProgress {
        PreviewPassProgress { processed, total }
    }

    /// The counts a throttle lets through for a pass of `total` cards, each
    /// card settling `step` after the previous one.
    fn admitted(total: usize, step: Duration) -> Vec<usize> {
        let start = Instant::now();
        let mut throttle = PreviewProgressThrottle::default();
        (0..=total)
            .filter(|&processed| {
                let at = start + step * u32::try_from(processed).expect("small test pass");
                throttle.admit(progress(processed, total), at)
            })
            .collect()
    }

    fn space_with_notes(count: usize) -> (tempfile::TempDir, VaultLayout, Connection) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        std::fs::create_dir(&root).unwrap();
        for index in 0..count {
            std::fs::write(
                root.join(format!("Note {index:02}.md")),
                format!("# Note {index}\n\nPlain text."),
            )
            .unwrap();
        }
        let vault = VaultLayout::with_derived_root(root, temp.path().join("derived"));
        std::fs::create_dir_all(vault.thumbs_dir()).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        reconcile::reconcile_vault(&conn, &vault).unwrap();
        (temp, vault, conn)
    }

    fn queued(vault: &VaultLayout, full_scan: bool, slugs: &[&str]) -> QueuedPreviewWork {
        QueuedPreviewWork {
            vault: vault.clone(),
            full_scan,
            pending_slugs: slugs.iter().map(ToString::to_string).collect(),
        }
    }

    #[test]
    fn a_fast_pass_reports_its_start_first_card_every_tenth_card_and_last() {
        assert_eq!(admitted(25, Duration::ZERO), vec![0, 1, 11, 21, 25]);
    }

    #[test]
    fn a_slow_pass_reports_at_least_every_quarter_second() {
        // 100 ms a card: the 250 ms limit comes before the tenth card.
        assert_eq!(
            admitted(12, Duration::from_millis(100)),
            vec![0, 1, 4, 7, 10, 12]
        );
        // Each card slower than the limit is reported on its own.
        assert_eq!(admitted(3, Duration::from_millis(300)), vec![0, 1, 2, 3]);
    }

    #[test]
    fn a_pass_with_no_cards_reports_nothing() {
        assert!(admitted(0, Duration::ZERO).is_empty());
    }

    /// SPEC_ONBOARDING.md, О13: a full pass counts out loud, against every
    /// card it checks.
    #[test]
    fn a_full_pass_reports_first_throttled_and_last_counts_with_its_total() {
        let (_temp, vault, conn) = space_with_notes(25);
        let fixed = Instant::now();
        let mut counts = Vec::new();
        let mut batches = 0;

        let report = run_queued_work(
            &conn,
            &queued(&vault, true, &[]),
            &mut || true,
            &mut |_| batches += 1,
            &mut |progress| counts.push(progress),
            &mut || fixed,
        )
        .unwrap();

        assert_eq!(report.checked, 25);
        assert!(batches > 0);
        assert_eq!(
            counts,
            vec![
                progress(0, 25),
                progress(1, 25),
                progress(11, 25),
                progress(21, 25),
                progress(25, 25),
            ]
        );
    }

    /// A pass over the cards of one saved file stays silent: it must never
    /// raise the opening notice.
    #[test]
    fn a_pass_over_named_cards_reports_no_count() {
        let (_temp, vault, conn) = space_with_notes(3);
        let mut counts = Vec::new();
        let mut batches = 0;

        let report = run_queued_work(
            &conn,
            &queued(&vault, false, &["Note 00", "Note 01"]),
            &mut || true,
            &mut |_| batches += 1,
            &mut |progress| counts.push(progress),
            &mut Instant::now,
        )
        .unwrap();

        assert_eq!(report.checked, 2);
        assert!(counts.is_empty());
        assert_eq!(batches, 0);
    }

    #[test]
    fn dropping_another_space_reports_only_its_full_pass() {
        let temp = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(temp.path().join("source"), temp.path().join("derived"));
        let mut queue = PreviewWorkQueue::default();
        queue
            .pending
            .insert("/old".into(), queued(&vault, true, &[]));
        queue
            .pending
            .insert("/other".into(), queued(&vault, false, &["Card"]));
        queue
            .pending
            .insert("/active".into(), queued(&vault, true, &[]));

        let open: BTreeSet<String> = ["/active".to_string(), "/other".to_string()].into();
        assert_eq!(queue.keep_only(&open), vec!["/old".to_string()]);
        assert!(queue.full_pass_queued("/active"));
        assert!(!queue.full_pass_queued("/old"));
        assert_eq!(queue.keep_only(&BTreeSet::new()), vec!["/active".to_string()]);
        assert!(queue.pending.is_empty());
    }

    #[test]
    fn every_open_space_is_served_the_most_recent_first() {
        let temp = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(temp.path().join("source"), temp.path().join("derived"));
        let mut queue = PreviewWorkQueue::default();
        queue.pending.insert("/a".into(), queued(&vault, true, &[]));
        queue.pending.insert("/b".into(), queued(&vault, true, &[]));

        assert_eq!(queue.take_next(Some("/b")).map(|(path, _)| path).as_deref(), Some("/b"));
        assert_eq!(queue.take_next(Some("/b")).map(|(path, _)| path).as_deref(), Some("/a"));
        assert!(queue.take_next(None).is_none());
    }
}
