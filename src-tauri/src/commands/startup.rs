//! Startup milestones and the post-paint maintenance boundary.
//!
//! The frontend owns the definition of the first committed route. Tauri owns
//! maintenance execution. Keeping the command explicit prevents helper repair
//! from drifting back into synchronous `.setup` work. A launch whose page
//! paints nothing still gets its maintenance, at a deadline
//! ([`arm_launch_deadline`]).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::commands::clipper_setup::{self, ActiveRuntime, RuntimeUpkeep};
use crate::commands::state::CommandError;
use crate::storage::source_mutation::SourceWriteLease;
use crate::util::append_startup_trace;

/// Without a frame of its page, the launch maintenance starts this long after
/// setup. WebKit runs no animation frame for a window nobody can see (behind
/// other windows, minimised, on another Space, under a locked screen), and
/// until 13.10.2026 such a launch never installed its helper and never
/// started the upkeep: a Mine opened behind other windows kept the previous
/// build's helper for hours (SPEC_ONBOARDING.md, О5). Fifteen times the cold
/// first-cards budget (SPEC_STARTUP_PERFORMANCE.md, p95 1 s): a page that
/// paints has painted long before.
pub(crate) const NO_FRAME_DEADLINE: Duration = Duration::from_secs(15);

/// What started the launch maintenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LaunchTrigger {
    /// The page painted its first screen (`start_startup_maintenance`).
    FirstFrame,
    /// No page painted within [`NO_FRAME_DEADLINE`].
    NoFrame,
}

impl LaunchTrigger {
    fn trace_label(self) -> &'static str {
        match self {
            Self::FirstFrame => "first_frame",
            Self::NoFrame => "no_frame",
        }
    }

    fn describe(self) -> String {
        match self {
            Self::FirstFrame => "after the first frame".into(),
            Self::NoFrame => format!("no frame within {} s", NO_FRAME_DEADLINE.as_secs()),
        }
    }
}

/// The one launch maintenance of a process: the first to claim it starts it.
pub(crate) struct LaunchClaim(AtomicBool);

impl LaunchClaim {
    pub(crate) const fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    /// True for the one caller that starts the maintenance.
    pub(crate) fn claim(&self) -> bool {
        !self.0.swap(true, Ordering::AcqRel)
    }

    /// The start failed: the next caller tries again.
    fn release(&self) {
        self.0.store(false, Ordering::Release);
    }
}

static LAUNCH: LaunchClaim = LaunchClaim::new();

/// After `deadline`, start the launch maintenance with `start` unless a frame
/// claimed it first. Returns the waiting thread.
pub(crate) fn arm_no_frame_deadline(
    claim: &'static LaunchClaim,
    deadline: Duration,
    start: impl FnOnce(LaunchTrigger) + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("mine-maintenance-deadline".into())
        .spawn(move || {
            std::thread::sleep(deadline);
            if claim.claim() {
                start(LaunchTrigger::NoFrame);
            }
        })
}

/// Arm the launch maintenance of a launch whose page paints nothing; called
/// once, from setup. A page that paints starts it first
/// ([`start_startup_maintenance`]), and the deadline then does nothing.
pub fn arm_launch_deadline(app: &AppHandle) {
    let handle = app.clone();
    let armed = arm_no_frame_deadline(&LAUNCH, NO_FRAME_DEADLINE, move |trigger| {
        let started = crate::storage::source_mutation::begin_write()
            .map_err(|error| CommandError::Internal(error.to_string()))
            .and_then(|write| begin_launch_maintenance(&handle, trigger, write));
        if let Err(error) = started {
            log::warn!(
                "clipper maintenance at launch ({}) did not start: {error}",
                trigger.describe()
            );
        }
    });
    if let Err(error) = armed {
        log::warn!("clipper maintenance has no launch deadline: {error}");
    }
}

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

/// Why an upkeep pass runs, for its line in Mine's log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpkeepReason {
    /// The regular check, every [`UPKEEP_INTERVAL`].
    Schedule,
    /// The retry [`UPKEEP_RETRY_AFTER_FAILURE`] after a failed pass.
    Retry,
    /// A Mine window gained focus.
    Window,
}

impl UpkeepReason {
    fn of(nudged: bool, last_failed: bool) -> Self {
        match (nudged, last_failed) {
            (true, _) => Self::Window,
            (false, true) => Self::Retry,
            (false, false) => Self::Schedule,
        }
    }

    fn describe(self) -> &'static str {
        match self {
            Self::Schedule => "every 5 min",
            Self::Retry => "1 min after a failure",
            Self::Window => "a window came to the front",
        }
    }
}

/// The one line of Mine's log for the launch pass: what it installed, that
/// this build's runtime was in place, or why it failed (SPEC_ONBOARDING.md,
/// О5). Until 13.10.2026 a pass that succeeded left no line at all.
pub(crate) fn launch_outcome_line(
    trigger: LaunchTrigger,
    outcome: &Result<ActiveRuntime, CommandError>,
) -> (log::Level, String) {
    match outcome {
        Ok(active) => (
            log::Level::Info,
            format!(
                "clipper maintenance at launch ({}): {}",
                trigger.describe(),
                active.describe()
            ),
        ),
        Err(error) => (
            log::Level::Warn,
            format!(
                "clipper maintenance at launch ({}) failed: {error}",
                trigger.describe()
            ),
        ),
    }
}

/// The one line of Mine's log for an upkeep pass.
fn upkeep_outcome_line(
    reason: UpkeepReason,
    outcome: &Result<RuntimeUpkeep, CommandError>,
) -> (log::Level, String) {
    let reason = reason.describe();
    match outcome {
        Ok(RuntimeUpkeep::Current) => (
            log::Level::Info,
            format!("clipper upkeep ({reason}): this build's helper and extension copies are in place"),
        ),
        Ok(RuntimeUpkeep::Repaired(active)) => (
            log::Level::Info,
            format!("clipper upkeep ({reason}): repaired; {}", active.describe()),
        ),
        Ok(RuntimeUpkeep::NotBundled) => (
            log::Level::Info,
            format!("clipper upkeep ({reason}) stops: this build carries no helper to install"),
        ),
        Err(error) => (log::Level::Warn, format!("clipper upkeep ({reason}) failed: {error}")),
    }
}

pub(crate) fn log_line((level, line): (log::Level, String)) {
    log::log!(level, "{line}");
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
        let reason = UpkeepReason::of(nudged, last_failed);
        last_check = Instant::now();
        let outcome = clipper_setup::keep_runtime_current(app);
        log_line(upkeep_outcome_line(reason, &outcome));
        match outcome {
            Ok(RuntimeUpkeep::Current) => last_failed = false,
            Ok(RuntimeUpkeep::Repaired(_)) => {
                last_failed = false;
                append_startup_trace(app, "clipper_upkeep", "repaired");
            }
            Ok(RuntimeUpkeep::NotBundled) => return,
            Err(error) => {
                last_failed = true;
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
    if !LAUNCH.claim() {
        return Ok(false);
    }
    begin_launch_maintenance(&app, LaunchTrigger::FirstFrame, write)
}

/// Why this process leaves the clipper alone, if it does. The clipper
/// helper, its browser registration and updates belong to the installed app:
/// a side instance under another identifier would swap the helper back and
/// forth with it every few minutes, and the native shell check keeps its
/// hands off the person's helper.
fn foreign_instance(app: &AppHandle) -> Option<String> {
    if crate::commands::native_shell_smoke::enabled() {
        return Some("native shell check".into());
    }
    let identifier = &app.config().identifier;
    (identifier != crate::app_config::APP_DATA_DIR_NAME).then(|| format!("side instance {identifier}"))
}

/// Run the launch pass and then the upkeep on their own thread. The caller
/// claimed the launch maintenance and holds `write` for the launch pass.
fn begin_launch_maintenance(
    app: &AppHandle,
    trigger: LaunchTrigger,
    write: SourceWriteLease,
) -> Result<bool, CommandError> {
    if let Some(reason) = foreign_instance(app) {
        append_startup_trace(app, "startup_maintenance", &format!("skipped {reason}"));
        log::info!("clipper maintenance skipped: {reason}");
        return Ok(false);
    }

    append_startup_trace(
        app,
        "startup_maintenance",
        &format!("scheduled trigger={}", trigger.trace_label()),
    );
    // After the first interactive frame, like the rest of maintenance (Ф13).
    crate::updater::start_automatic_checks(app);
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
            log_line(launch_outcome_line(trigger, &maintained));
            let failed = maintained.is_err();
            match maintained {
                Ok(active) => append_startup_trace(
                    &worker_app,
                    "startup_maintenance",
                    &format!(
                        "done mode={} elapsed_ms={}",
                        active.mode().as_trace_label(),
                        started.elapsed().as_millis()
                    ),
                ),
                Err(error) => append_startup_trace(
                    &worker_app,
                    "startup_maintenance",
                    &format!(
                        "error elapsed_ms={} err={error}",
                        started.elapsed().as_millis()
                    ),
                ),
            }
            run_clipper_upkeep(&worker_app, failed);
        })
        .map_err(|error| {
            LAUNCH.release();
            CommandError::Internal(format!("failed to start maintenance worker: {error}"))
        })?;

    Ok(true)
}

#[cfg(test)]
mod launch_tests {
    use super::*;
    use crate::commands::clipper_setup::RuntimeChange;

    fn claim() -> &'static LaunchClaim {
        Box::leak(Box::new(LaunchClaim::new()))
    }

    /// О5: a page that painted claimed the launch maintenance; the deadline
    /// starts no second one.
    #[test]
    fn the_deadline_starts_nothing_after_a_frame() {
        let claim = claim();
        assert!(claim.claim(), "the frame claims the launch maintenance");
        let (sender, received) = std::sync::mpsc::channel();
        arm_no_frame_deadline(claim, Duration::from_millis(10), move |trigger| {
            sender.send(trigger).unwrap();
        })
        .unwrap()
        .join()
        .unwrap();
        assert!(received.try_recv().is_err(), "a second launch maintenance started");
        assert!(!claim.claim());
    }

    /// О5: without a frame the deadline starts it, once.
    #[test]
    fn without_a_frame_the_deadline_starts_it_once() {
        let claim = claim();
        let (sender, received) = std::sync::mpsc::channel();
        arm_no_frame_deadline(claim, Duration::from_millis(10), move |trigger| {
            sender.send(trigger).unwrap();
        })
        .unwrap()
        .join()
        .unwrap();
        assert_eq!(received.try_recv(), Ok(LaunchTrigger::NoFrame));
        assert!(!claim.claim(), "a frame after the deadline started it again");
    }

    fn installed() -> ActiveRuntime {
        ActiveRuntime {
            package: "new".into(),
            change: RuntimeChange::Installed {
                replaced: Some("old".into()),
            },
        }
    }

    /// О5: every outcome of the launch pass is one line of Mine's log; a
    /// failure is a warning with its reason.
    #[test]
    fn every_launch_outcome_is_one_line_and_a_failure_says_why() {
        let lines = [
            launch_outcome_line(LaunchTrigger::NoFrame, &Ok(installed())),
            launch_outcome_line(
                LaunchTrigger::FirstFrame,
                &Ok(ActiveRuntime {
                    package: "new".into(),
                    change: RuntimeChange::InPlace,
                }),
            ),
            launch_outcome_line(
                LaunchTrigger::FirstFrame,
                &Ok(ActiveRuntime {
                    package: "newer".into(),
                    change: RuntimeChange::KeptNewer,
                }),
            ),
            launch_outcome_line(
                LaunchTrigger::FirstFrame,
                &Err(CommandError::Internal("the lock is held".into())),
            ),
        ];
        assert_eq!(
            lines[0],
            (
                log::Level::Info,
                "clipper maintenance at launch (no frame within 15 s): installed this build's helper package new with its extension copies, replacing old".into()
            )
        );
        assert_eq!(
            lines[1],
            (
                log::Level::Info,
                "clipper maintenance at launch (after the first frame): this build's helper package new is installed and starts; browsers registered".into()
            )
        );
        assert_eq!(lines[2].0, log::Level::Info);
        assert!(lines[2].1.contains("kept the newer installed helper package newer"));
        assert_eq!(
            lines[3],
            (
                log::Level::Warn,
                "clipper maintenance at launch (after the first frame) failed: the lock is held".into()
            )
        );
        for (_, line) in &lines {
            assert!(!line.contains('\n'), "{line} is more than one line");
        }
    }

    /// О5: every upkeep pass is one line too, the reason it ran included.
    #[test]
    fn every_upkeep_outcome_is_one_line() {
        let current = upkeep_outcome_line(UpkeepReason::Schedule, &Ok(RuntimeUpkeep::Current));
        assert_eq!(current.0, log::Level::Info);
        assert!(current.1.starts_with("clipper upkeep (every 5 min): "));
        let repaired = upkeep_outcome_line(
            UpkeepReason::Window,
            &Ok(RuntimeUpkeep::Repaired(installed())),
        );
        assert_eq!(repaired.0, log::Level::Info);
        assert!(repaired.1.contains("a window came to the front"));
        assert!(repaired.1.contains("installed this build's helper package new"));
        let failed = upkeep_outcome_line(
            UpkeepReason::Retry,
            &Err(CommandError::Internal("disk full".into())),
        );
        assert_eq!(
            failed,
            (
                log::Level::Warn,
                "clipper upkeep (1 min after a failure) failed: disk full".into()
            )
        );
        let stops = upkeep_outcome_line(UpkeepReason::Schedule, &Ok(RuntimeUpkeep::NotBundled));
        assert!(stops.1.contains("stops"));
        assert_eq!(UpkeepReason::of(true, true), UpkeepReason::Window);
        assert_eq!(UpkeepReason::of(false, true), UpkeepReason::Retry);
        assert_eq!(UpkeepReason::of(false, false), UpkeepReason::Schedule);
    }

    /// The line reaches Mine's log as one record at its level.
    #[test]
    fn an_outcome_line_is_one_log_record() {
        let capture = crate::test_log::capture();
        log_line(launch_outcome_line(
            LaunchTrigger::FirstFrame,
            &Err(CommandError::Internal("refused".into())),
        ));
        assert_eq!(
            capture.lines(),
            vec![(
                log::Level::Warn,
                "clipper maintenance at launch (after the first frame) failed: refused".to_string()
            )]
        );
    }
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
