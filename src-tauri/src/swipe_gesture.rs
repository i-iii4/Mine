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
//! A gesture the system cancels (another gesture took over, the window lost the
//! pointer) is not a gesture the user finished: it resets the run and decides
//! nothing.
//!
//! The monitor is passive: every event is returned to the application unchanged,
//! so ordinary scrolling is untouched.

/// Travel that makes a swipe rather than a nudge, in points. Generous,
/// because the gesture's own boundaries are known — this only separates a
/// swipe from a fidget, not a swipe from a scroll.
#[cfg(any(target_os = "macos", test))]
const SWIPE_TRAVEL: f64 = 40.0;
/// How much the horizontal travel must beat the vertical one. Low on
/// purpose: a swipe along a diagonal is still a swipe, and the phase tells
/// us it was one gesture rather than scrolling noise.
#[cfg(any(target_os = "macos", test))]
const DIRECTION_RATIO: f64 = 1.2;

/// The part of a scroll event's phase that recognition reads. Momentum events
/// never reach the recogniser: they are the tail of a gesture already decided.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq)]
enum GesturePhase {
    /// Fingers landed on the trackpad.
    Began,
    /// Fingers moved; carries the event's scrolling delta.
    Changed { dx: f64, dy: f64 },
    /// Fingers lifted: the user finished the gesture.
    Ended,
    /// The system abandoned the gesture; the user did not finish it.
    Cancelled,
    /// Any other phase (stationary, may-begin): no effect on the run.
    Other,
}

/// Direction of a recognised swipe, named as the frontend event payload.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SwipeDirection {
    Left,
    Right,
}

#[cfg(any(target_os = "macos", test))]
impl SwipeDirection {
    /// Payload of the `sidebar-swipe` event.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn as_payload(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

/// Accumulates one gesture between "landed" and "lifted" and decides once.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Default)]
struct SwipeRecognizer {
    x: f64,
    y: f64,
    live: bool,
}

#[cfg(any(target_os = "macos", test))]
impl SwipeRecognizer {
    /// Feed one non-momentum phase. Returns a direction only when the user
    /// lifted their fingers after enough horizontal travel; a cancelled
    /// gesture resets the run and returns nothing.
    fn feed(&mut self, phase: GesturePhase) -> Option<SwipeDirection> {
        match phase {
            GesturePhase::Began => {
                self.x = 0.0;
                self.y = 0.0;
                self.live = true;
                None
            }
            GesturePhase::Changed { dx, dy } => {
                if self.live {
                    self.x += dx;
                    self.y += dy;
                }
                None
            }
            GesturePhase::Ended => {
                if !self.live {
                    return None;
                }
                let decision = self.decide();
                self.reset();
                decision
            }
            // The system took the gesture away: whatever travel it had, the
            // user did not finish a swipe (`SPEC_AUDIT_FIXES.md`, Ф12, Г5.3).
            GesturePhase::Cancelled => {
                self.reset();
                None
            }
            GesturePhase::Other => None,
        }
    }

    fn decide(&self) -> Option<SwipeDirection> {
        if self.x.abs() >= SWIPE_TRAVEL && self.x.abs() >= self.y.abs() * DIRECTION_RATIO {
            // Natural scrolling: fingers moving right report a positive
            // delta. Right opens the panel, left closes it.
            Some(if self.x > 0.0 {
                SwipeDirection::Right
            } else {
                SwipeDirection::Left
            })
        } else {
            None
        }
    }

    fn reset(&mut self) {
        self.x = 0.0;
        self.y = 0.0;
        self.live = false;
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;
    use std::ptr::NonNull;
    use std::rc::Rc;

    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase};
    use tauri::AppHandle;

    use super::{GesturePhase, SwipeRecognizer};

    /// Reduce the phase bit set `AppKit` reports to the one phase recognition
    /// reads.
    /// Cancelled is checked before Ended: a cancelled gesture must never be
    /// mistaken for a finished one.
    fn gesture_phase(phase: NSEventPhase, dx: f64, dy: f64) -> GesturePhase {
        if phase.contains(NSEventPhase::Began) {
            GesturePhase::Began
        } else if phase.contains(NSEventPhase::Changed) {
            GesturePhase::Changed { dx, dy }
        } else if phase.contains(NSEventPhase::Cancelled) {
            GesturePhase::Cancelled
        } else if phase.contains(NSEventPhase::Ended) {
            GesturePhase::Ended
        } else {
            GesturePhase::Other
        }
    }

    /// Install the monitor. Must run on the main thread, where AppKit lives.
    pub fn install(app: AppHandle) {
        let recognizer = Rc::new(RefCell::new(SwipeRecognizer::default()));

        let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let event_ref = unsafe { event.as_ref() };

            // Momentum is the tail of a gesture already decided. Counting it
            // would let one flick fire several times.
            if event_ref.momentumPhase() != NSEventPhase::empty() {
                return event.as_ptr();
            }

            let phase = gesture_phase(
                event_ref.phase(),
                event_ref.scrollingDeltaX(),
                event_ref.scrollingDeltaY(),
            );
            let decision = recognizer.borrow_mut().feed(phase);
            if let Some(direction) = decision {
                crate::commands::space_events::emit_to_active_tab(
                    &app,
                    "sidebar-swipe",
                    direction.as_payload(),
                );
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

#[cfg(test)]
mod tests {
    use super::{GesturePhase, SwipeDirection, SwipeRecognizer};

    fn run(phases: &[GesturePhase]) -> Vec<SwipeDirection> {
        let mut recognizer = SwipeRecognizer::default();
        phases
            .iter()
            .filter_map(|phase| recognizer.feed(*phase))
            .collect()
    }

    #[test]
    fn finished_horizontal_gesture_emits_its_direction() {
        let emitted = run(&[
            GesturePhase::Began,
            GesturePhase::Changed { dx: 30.0, dy: 2.0 },
            GesturePhase::Other,
            GesturePhase::Changed { dx: 20.0, dy: 3.0 },
            GesturePhase::Ended,
        ]);
        assert_eq!(emitted, vec![SwipeDirection::Right]);

        let emitted = run(&[
            GesturePhase::Began,
            GesturePhase::Changed { dx: -45.0, dy: 0.0 },
            GesturePhase::Ended,
        ]);
        assert_eq!(emitted, vec![SwipeDirection::Left]);
    }

    #[test]
    fn cancelled_gesture_emits_nothing_even_past_the_threshold() {
        // x = 50 ≥ 40 and |x| ≥ 1.2·|y|: a swipe had the user finished it.
        let emitted = run(&[
            GesturePhase::Began,
            GesturePhase::Changed { dx: 50.0, dy: 1.0 },
            GesturePhase::Cancelled,
        ]);
        assert!(emitted.is_empty(), "cancelled swipe emitted {emitted:?}");
    }

    #[test]
    fn cancelled_gesture_does_not_leak_travel_into_a_stray_end() {
        // A late Ended after the cancel must not decide on the cancelled run.
        let emitted = run(&[
            GesturePhase::Began,
            GesturePhase::Changed { dx: 80.0, dy: 0.0 },
            GesturePhase::Cancelled,
            GesturePhase::Changed { dx: 10.0, dy: 0.0 },
            GesturePhase::Ended,
        ]);
        assert!(emitted.is_empty(), "stale run emitted {emitted:?}");
    }

    #[test]
    fn short_or_vertical_gesture_emits_nothing() {
        assert!(run(&[
            GesturePhase::Began,
            GesturePhase::Changed { dx: 39.0, dy: 0.0 },
            GesturePhase::Ended,
        ])
        .is_empty());
        assert!(run(&[
            GesturePhase::Began,
            GesturePhase::Changed { dx: 60.0, dy: 55.0 },
            GesturePhase::Ended,
        ])
        .is_empty());
    }
}
