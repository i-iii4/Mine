//! Quitting Mine finishes what has begun (SPEC_DEEP_AUDIT.md, Н3).
//!
//! ⌘Q, the Quit item and closing the last window reach the app as
//! `RunEvent::ExitRequested`. Until 13.10.2026 the process ended right there:
//! a group delete or a collection rename that was moving files stayed half
//! done, and a Download Media lost its video, left its working folder and an
//! orphaned joiner (Е2.1, Е2.2). Now the first request is held: the windows
//! are saved as they stand (SPEC_TABS.md, В33), every download stops with its
//! process group and keeps a finished video for the next launch, no new write
//! starts, and the writes that began are waited for; the windows are hidden
//! at once, so nothing of this is shown, only logged. Then the app exits for
//! real; the second request passes.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Longest wait for the download jobs to stop and clean up.
const DOWNLOADS_DEADLINE: Duration = Duration::from_secs(10);
/// Longest wait for the writes that began: a group delete of a few hundred
/// cards moves each file to the Trash and fits well within it.
const WRITES_DEADLINE: Duration = Duration::from_secs(30);

/// How far quitting has come.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExitPhase {
    /// Not quitting.
    Running,
    /// Waiting for downloads and writes; further requests are held too.
    Finishing,
    /// Everything that began has ended: the next request exits.
    Done,
}

/// What an exit request does in `phase`, and the phase after it.
fn on_request(phase: ExitPhase) -> (ExitPhase, ExitAnswer) {
    match phase {
        ExitPhase::Running => (ExitPhase::Finishing, ExitAnswer::HoldAndFinish),
        ExitPhase::Finishing => (ExitPhase::Finishing, ExitAnswer::Hold),
        ExitPhase::Done => (ExitPhase::Done, ExitAnswer::Exit),
    }
}

/// The answer to one exit request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExitAnswer {
    /// Hold the exit and start finishing what began.
    HoldAndFinish,
    /// Hold the exit: finishing is under way.
    Hold,
    /// Let the process end.
    Exit,
}

static PHASE: Mutex<ExitPhase> = Mutex::new(ExitPhase::Running);

fn phase() -> std::sync::MutexGuard<'static, ExitPhase> {
    PHASE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// An exit was requested: whether the process may end now. When it may not,
/// the caller holds the exit (`ExitRequestApi::prevent_exit`); the app exits
/// by itself once what began has ended.
pub fn exit_requested(app: &AppHandle) -> bool {
    let answer = {
        let mut current = phase();
        let (next, answer) = on_request(*current);
        *current = next;
        answer
    };
    match answer {
        ExitAnswer::Exit => true,
        ExitAnswer::Hold => false,
        ExitAnswer::HoldAndFinish => {
            // The windows as they stand, or as they were before a tab drag
            // still running (В33, В68).
            if let Some(shell) = app.try_state::<crate::tabs::TabShell>() {
                shell.quit();
            }
            // The person asked to quit: the windows go now, saved as they
            // stood, and what finishing meets is said only in the log
            // (SPEC_DEEP_AUDIT.md, «Решения пользователя 14.10.2026»). A
            // window left on screen took presses that quitting refused.
            for window in app.windows().values() {
                if let Err(error) = window.hide() {
                    log::warn!("cannot hide {} while quitting: {error}", window.label());
                }
            }
            let handle = app.clone();
            let finishing = std::thread::Builder::new()
                .name("exit".into())
                .spawn(move || finish(&handle));
            if let Err(error) = finishing {
                // Without the thread nothing would ever exit: exit now.
                log::warn!("cannot finish before exiting: {error}");
                *phase() = ExitPhase::Done;
                return true;
            }
            false
        }
    }
}

fn finish(app: &AppHandle) {
    finish_in_order(
        || {
            // The pages write their unsaved edits while writes may still
            // start, and the previews of the edited notes follow
            // (SPEC_EDITING.md, Л3.9).
            crate::commands::edit_sessions::flush(app, &crate::commands::edit_sessions::FlushScope::All);
            crate::commands::note_edit::make_waiting_previews(app);
        },
        || {
            let downloads = app.state::<crate::source_video_download::SourceVideoDownloads>();
            let unfinished = downloads.shutdown(DOWNLOADS_DEADLINE);
            if unfinished > 0 {
                log::warn!("{unfinished} download job(s) did not end before Mine quit");
            }
        },
        || match crate::storage::source_mutation::close_for_exit(WRITES_DEADLINE) {
            crate::storage::source_mutation::ExitDrain::Drained => {}
            crate::storage::source_mutation::ExitDrain::TimedOut { running } => {
                log::warn!("{running} write(s) still running when Mine quit");
            }
        },
    );
    *phase() = ExitPhase::Done;
    app.exit(0);
}

/// What quitting finishes, in its order: the edits of the pages first, while
/// writes may still start; then the downloads; then the writes that began,
/// after which no write starts.
fn finish_in_order(flush_edits: impl FnOnce(), stop_downloads: impl FnOnce(), close_writes: impl FnOnce()) {
    flush_edits();
    stop_downloads();
    close_writes();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Е2.1: the first request is held while what began finishes; requests
    /// meanwhile are held too; once done, the request exits.
    #[test]
    fn the_first_exit_request_is_held_until_everything_ends() {
        let (phase, answer) = on_request(ExitPhase::Running);
        assert_eq!(answer, ExitAnswer::HoldAndFinish);
        let (phase, answer) = on_request(phase);
        assert_eq!(answer, ExitAnswer::Hold, "a second ⌘Q started a second finish");
        assert_eq!(phase, ExitPhase::Finishing);
        assert_eq!(on_request(ExitPhase::Done), (ExitPhase::Done, ExitAnswer::Exit));
    }

    /// SPEC_EDITING.md, Л3.9: the pages write their unsaved edits before
    /// the gate of writes closes, after which their saves would be refused.
    #[test]
    fn the_edits_are_flushed_before_writes_stop() {
        let steps = std::cell::RefCell::new(Vec::new());
        finish_in_order(
            || steps.borrow_mut().push("flush edits"),
            || steps.borrow_mut().push("stop downloads"),
            || steps.borrow_mut().push("close writes"),
        );
        assert_eq!(steps.into_inner(), ["flush edits", "stop downloads", "close writes"]);
    }
}
