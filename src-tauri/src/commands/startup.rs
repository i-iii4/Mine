//! Startup milestones and the post-paint maintenance boundary.
//!
//! The frontend owns the definition of the first committed route. Tauri owns
//! maintenance execution. Keeping the command explicit prevents helper repair
//! from drifting back into synchronous `.setup` work.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use tauri::AppHandle;

use crate::commands::clipper_setup;
use crate::commands::state::CommandError;
use crate::util::append_startup_trace;

static MAINTENANCE_STARTED: AtomicBool = AtomicBool::new(false);

fn valid_milestone(event: &str) -> bool {
    matches!(
        event,
        "frontend_entry"
            | "window_shell_painted"
            | "first_route_committed"
            | "first_cards_painted"
            | "interactive"
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
    Ok(())
}

/// Start process-wide maintenance once, after the frontend has painted a usable
/// surface. The worker never joins the IPC command or the UI thread.
#[tauri::command]
pub fn start_startup_maintenance(app: AppHandle) -> Result<bool, CommandError> {
    if MAINTENANCE_STARTED.swap(true, Ordering::AcqRel) {
        return Ok(false);
    }

    append_startup_trace(&app, "startup_maintenance", "scheduled");
    let worker_app = app.clone();
    std::thread::Builder::new()
        .name("mine-startup-maintenance".into())
        .spawn(move || {
            let started = Instant::now();
            append_startup_trace(&worker_app, "startup_maintenance", "start");
            match clipper_setup::maintain_installed_runtime(&worker_app) {
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
        })
        .map_err(|error| {
            MAINTENANCE_STARTED.store(false, Ordering::Release);
            CommandError::Internal(format!("failed to start maintenance worker: {error}"))
        })?;

    Ok(true)
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
        assert!(!valid_milestone("vault=/private/user-content"));
    }
}
