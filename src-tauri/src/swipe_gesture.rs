//! Two-finger swipe, recognised where the system actually describes it.
//!
//! In the web layer this gesture arrives as a stream of wheel events that looks
//! exactly like an ordinary scroll: no beginning, no end, and no way to tell a
//! deliberate flick from the sideways drift every vertical scroll carries. Every
//! attempt to recognise it there is guesswork over thresholds, and guesswork is
//! what made it fire late, miss slow movements and ignore diagonals.
//!
//! AppKit describes the same gesture properly. A scroll event carries a phase:
//! fingers landed, fingers moving, fingers lifted — and, separately, the
//! momentum that keeps arriving afterwards. With those, recognition needs no
//! thresholds on timing at all: accumulate between "landed" and "lifted", decide
//! once, ignore momentum entirely.
//!
//! The monitor is passive: every event is returned to the application unchanged,
//! so ordinary scrolling is untouched.

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::Cell;
    use std::ptr::NonNull;
    use std::rc::Rc;

    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase};
    use tauri::{AppHandle, Emitter, Runtime};

    /// Travel that makes a swipe rather than a nudge, in points. Generous,
    /// because the gesture's own boundaries are known — this only separates a
    /// swipe from a fidget, not a swipe from a scroll.
    const SWIPE_TRAVEL: f64 = 40.0;
    /// How much the horizontal travel must beat the vertical one. Low on
    /// purpose: a swipe along a diagonal is still a swipe, and the phase tells
    /// us it was one gesture rather than scrolling noise.
    const DIRECTION_RATIO: f64 = 1.2;

    #[derive(Default)]
    struct Run {
        x: Cell<f64>,
        y: Cell<f64>,
        live: Cell<bool>,
    }

    /// Install the monitor. Must run on the main thread, where AppKit lives.
    pub fn install<R: Runtime>(app: AppHandle<R>) {
        let run = Rc::new(Run::default());

        let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let event_ref = unsafe { event.as_ref() };
            let phase = event_ref.phase();
            let momentum = event_ref.momentumPhase();

            // Momentum is the tail of a gesture already decided. Counting it
            // would let one flick fire several times.
            if momentum != NSEventPhase::empty() {
                return event.as_ptr();
            }

            if phase.contains(NSEventPhase::Began) {
                run.x.set(0.0);
                run.y.set(0.0);
                run.live.set(true);
            } else if phase.contains(NSEventPhase::Changed) && run.live.get() {
                run.x.set(run.x.get() + event_ref.scrollingDeltaX());
                run.y.set(run.y.get() + event_ref.scrollingDeltaY());
            } else if phase.contains(NSEventPhase::Ended)
                || phase.contains(NSEventPhase::Cancelled)
            {
                if run.live.get() {
                    run.live.set(false);
                    let x = run.x.get();
                    let y = run.y.get();
                    if x.abs() >= SWIPE_TRAVEL && x.abs() >= y.abs() * DIRECTION_RATIO {
                        // Natural scrolling: fingers moving right report a
                        // positive delta. Right opens the panel, left closes it.
                        let direction = if x > 0.0 { "right" } else { "left" };
                        let _ = app.emit("sidebar-swipe", direction);
                    }
                }
            }

            event.as_ptr()
        });

        unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::ScrollWheel,
                &handler,
            );
        }

        // The monitor lives for the process; AppKit keeps the block alive.
        std::mem::forget(handler);
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::{AppHandle, Runtime};

    /// Other platforms describe trackpad gestures differently, or not at all.
    pub fn install<R: Runtime>(_app: AppHandle<R>) {}
}

pub use imp::install;
