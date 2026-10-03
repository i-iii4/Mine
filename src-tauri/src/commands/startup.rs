//! Startup milestones and the post-paint maintenance boundary.
//!
//! The frontend owns the definition of the first committed route. Tauri owns
//! maintenance execution. Keeping the command explicit prevents helper repair
//! from drifting back into synchronous `.setup` work.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::commands::clipper_setup;
use crate::commands::state::CommandError;
use crate::util::append_startup_trace;

static MAINTENANCE_STARTED: AtomicBool = AtomicBool::new(false);

/// How often Mine compares the clipper helper with its bundle while it runs.
const UPKEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// After a failed repair the next attempt comes sooner.
const UPKEEP_RETRY_AFTER_FAILURE: Duration = Duration::from_secs(60);
/// Returning to the window checks at once, but not more often than this.
const UPKEEP_NUDGE_MIN_GAP: Duration = Duration::from_secs(30);

struct UpkeepWake {
    nudged: Mutex<bool>,
    wake: Condvar,
}

static UPKEEP_WAKE: UpkeepWake = UpkeepWake {
    nudged: Mutex::new(false),
    wake: Condvar::new(),
};

/// Ask the clipper upkeep to check now (the main window gained focus).
pub fn nudge_clipper_upkeep() {
    if let Ok(mut nudged) = UPKEEP_WAKE.nudged.lock() {
        *nudged = true;
        UPKEEP_WAKE.wake.notify_one();
    }
}

/// Sleep until the timeout or a nudge; true when a nudge woke it.
fn wait_for_upkeep(timeout: Duration) -> bool {
    let Ok(guard) = UPKEEP_WAKE.nudged.lock() else {
        std::thread::sleep(timeout);
        return false;
    };
    let Ok((mut nudged, _)) = UPKEEP_WAKE
        .wake
        .wait_timeout_while(guard, timeout, |nudged| !*nudged)
    else {
        return false;
    };
    std::mem::take(&mut *nudged)
}

/// When the next scheduled check comes.
fn upkeep_delay(last_failed: bool) -> Duration {
    if last_failed {
        UPKEEP_RETRY_AFTER_FAILURE
    } else {
        UPKEEP_INTERVAL
    }
}

/// A nudge right after a check waits for the schedule instead.
fn nudge_is_due(since_last_check: Duration) -> bool {
    since_last_check >= UPKEEP_NUDGE_MIN_GAP
}

/// The clipper helper stays this build's while Mine runs: every few minutes
/// and on return to the window (SPEC_ONBOARDING.md, О5).
fn run_clipper_upkeep(app: &AppHandle, mut last_failed: bool) {
    let mut last_check = Instant::now();
    loop {
        let nudged = wait_for_upkeep(upkeep_delay(last_failed));
        if nudged && !nudge_is_due(last_check.elapsed()) {
            continue;
        }
        last_check = Instant::now();
        match clipper_setup::keep_runtime_current(app) {
            Ok(clipper_setup::RuntimeUpkeep::Current) => last_failed = false,
            Ok(clipper_setup::RuntimeUpkeep::Repaired) => {
                last_failed = false;
                append_startup_trace(app, "clipper_upkeep", "repaired");
            }
            Ok(clipper_setup::RuntimeUpkeep::NotBundled) => return,
            Err(error) => {
                last_failed = true;
                log::warn!("clipper helper upkeep failed: {error}");
                append_startup_trace(app, "clipper_upkeep", &format!("error err={error}"));
            }
        }
    }
}

fn valid_milestone(event: &str) -> bool {
    matches!(
        event,
        "frontend_entry"
            | "window_shell_painted"
            | "first_route_committed"
            | "first_cards_painted"
            | "space_switch_requested"
            | "tag_reorder_dropped"
            | "tag_reorder_written"
            | "tag_reorder_reloaded"
            | "tag_reorder_painted"
            | "interactive"
            | "update_ready"
    )
}

/// Record a content-free frontend milestone in the per-launch trace.
#[tauri::command]
pub fn record_startup_milestone(app: AppHandle, event: String) -> Result<(), CommandError> {
    if !valid_milestone(&event) {
        return Err(CommandError::Internal(format!(
            "unknown startup milestone: {event}"
        )));
    }
    append_startup_trace(&app, "startup", &format!("milestone={event}"));
    if event == "update_ready" {
        crate::update_activation::record_interactive().map_err(CommandError::Internal)?;
    }
    Ok(())
}

/// Start process-wide maintenance once, after the frontend has painted a usable
/// surface. The worker never joins the IPC command or the UI thread.
#[tauri::command]
pub fn start_startup_maintenance(app: AppHandle) -> Result<bool, CommandError> {
    // The first route of the last window is on screen: the other saved
    // windows come now (SPEC_TABS.md, В36).
    crate::tabs::restore_rest(&app);
    let write = crate::storage::source_mutation::begin_write()
        .map_err(|error| CommandError::Internal(error.to_string()))?;
    if MAINTENANCE_STARTED.swap(true, Ordering::AcqRel) {
        return Ok(false);
    }
    // The clipper helper, its browser registration and updates belong to the
    // installed app. A side instance under another identifier leaves them
    // alone, or the two would swap the helper back and forth every few minutes.
    if app.config().identifier != crate::app_config::APP_DATA_DIR_NAME {
        append_startup_trace(&app, "startup_maintenance", "skipped side instance");
        return Ok(false);
    }

    append_startup_trace(&app, "startup_maintenance", "scheduled");
    // After the first interactive frame, like the rest of maintenance (Ф13).
    crate::updater::start_automatic_checks(&app);
    let worker_app = app.clone();
    std::thread::Builder::new()
        .name("mine-startup-maintenance".into())
        .spawn(move || {
            let started = Instant::now();
            append_startup_trace(&worker_app, "startup_maintenance", "start");
            let maintained = clipper_setup::maintain_installed_runtime(&worker_app);
            // The write lease covers the launch pass only: the upkeep that
            // follows runs for the whole session.
            drop(write);
            let failed = maintained.is_err();
            match maintained {
                Ok(mode) => append_startup_trace(
                    &worker_app,
                    "startup_maintenance",
                    &format!(
                        "done mode={} elapsed_ms={}",
                        mode.as_trace_label(),
                        started.elapsed().as_millis()
                    ),
                ),
                Err(error) => {
                    log::warn!("clipper helper registration needs attention: {error}");
                    append_startup_trace(
                        &worker_app,
                        "startup_maintenance",
                        &format!(
                            "error elapsed_ms={} err={error}",
                            started.elapsed().as_millis()
                        ),
                    );
                }
            }
            run_clipper_upkeep(&worker_app, failed);
        })
        .map_err(|error| {
            MAINTENANCE_STARTED.store(false, Ordering::Release);
            CommandError::Internal(format!("failed to start maintenance worker: {error}"))
        })?;

    Ok(true)
}

#[cfg(test)]
mod upkeep_tests {
    use super::*;

    #[test]
    fn checks_every_five_minutes_and_sooner_after_a_failure() {
        assert_eq!(upkeep_delay(false), Duration::from_secs(300));
        assert_eq!(upkeep_delay(true), Duration::from_secs(60));
    }

    #[test]
    fn returning_to_the_window_checks_at_most_every_half_minute() {
        assert!(!nudge_is_due(Duration::from_secs(5)));
        assert!(nudge_is_due(Duration::from_secs(30)));
    }

    #[test]
    fn a_nudge_wakes_the_upkeep_before_its_schedule() {
        let waiter = std::thread::spawn(|| {
            let started = Instant::now();
            (wait_for_upkeep(Duration::from_secs(30)), started.elapsed())
        });
        std::thread::sleep(Duration::from_millis(50));
        nudge_clipper_upkeep();
        let (nudged, waited) = waiter.join().unwrap();
        assert!(nudged);
        assert!(waited < Duration::from_secs(5));
        // The nudge is consumed: the next wait runs to its timeout.
        assert!(!wait_for_upkeep(Duration::from_millis(20)));
    }
}

#[cfg(test)]
mod tests {
    use super::valid_milestone;

    #[test]
    fn only_content_free_startup_milestones_are_accepted() {
        assert!(valid_milestone("frontend_entry"));
        assert!(valid_milestone("window_shell_painted"));
        assert!(valid_milestone("first_route_committed"));
        assert!(valid_milestone("first_cards_painted"));
        assert!(valid_milestone("interactive"));
        assert!(valid_milestone("update_ready"));
        assert!(!valid_milestone("vault=/private/user-content"));
    }
}
