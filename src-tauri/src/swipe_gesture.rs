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
//! A gesture that begins with the pointer over a tab window's tab bar belongs
//! to the bar: it scrolls the tabs and never touches the sidebar, whatever the
//! pointer crosses before the fingers lift (`SPEC_NARROW_WINDOW.md`, У9).
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
    /// Fingers landed on the trackpad; whether the pointer was over the
    /// tab bar of its window then.
    Began { over_tab_bar: bool },
    /// Fingers moved; carries the event's scrolling delta.
    Changed { dx: f64, dy: f64 },
    /// Fingers lifted: the user finished the gesture.
    Ended,
    /// The system abandoned the gesture; the user did not finish it.
    Cancelled,
    /// Any other phase (stationary, may-begin): no effect on the run.
    Other,
}

/// Direction of a recognised swipe: right opens the sidebar, left closes it
/// (SPEC_TABS.md, В56).
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SwipeDirection {
    Left,
    Right,
}


/// Whether a point `y_from_top` points below the window's top edge lies on
/// a tab bar `bar_height` tall: the bar takes the rows from 0 up to its
/// height, its last row included.
#[cfg(any(target_os = "macos", test))]
fn begins_over_tab_bar(y_from_top: f64, bar_height: f64) -> bool {
    (0.0..bar_height).contains(&y_from_top)
}

/// Accumulates one gesture between "landed" and "lifted" and decides once.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Default)]
struct SwipeRecognizer {
    x: f64,
    y: f64,
    live: bool,
    /// The gesture began over the tab bar: it decides nothing (У9).
    over_tab_bar: bool,
}

#[cfg(any(target_os = "macos", test))]
impl SwipeRecognizer {
    /// Feed one non-momentum phase. Returns a direction only when the user
    /// lifted their fingers after enough horizontal travel; a cancelled
    /// gesture, or one that began over the tab bar, returns nothing.
    fn feed(&mut self, phase: GesturePhase) -> Option<SwipeDirection> {
        match phase {
            GesturePhase::Began { over_tab_bar } => {
                self.x = 0.0;
                self.y = 0.0;
                self.live = true;
                self.over_tab_bar = over_tab_bar;
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
                // Decided where the fingers landed, kept to the end (У9).
                let decision = if self.over_tab_bar { None } else { self.decide() };
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
        self.over_tab_bar = false;
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;
    use std::ptr::NonNull;
    use std::rc::Rc;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase};
    use tauri::AppHandle;

    use super::{begins_over_tab_bar, GesturePhase, SwipeRecognizer};

    /// Reduce the phase bit set `AppKit` reports to the one phase recognition
    /// reads. Where the pointer is matters only when the fingers land, so it
    /// is asked for then and only then.
    /// Cancelled is checked before Ended: a cancelled gesture must never be
    /// mistaken for a finished one.
    fn gesture_phase(phase: NSEventPhase, dx: f64, dy: f64, over_tab_bar: impl FnOnce() -> bool) -> GesturePhase {
        if phase.contains(NSEventPhase::Began) {
            GesturePhase::Began {
                over_tab_bar: over_tab_bar(),
            }
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

    /// Whether `event` points at the tab bar of a tab window. Another window
    /// (the settings) has no bar: its gestures go on as before.
    fn over_tab_bar(app: &AppHandle, event: &NSEvent, mtm: MainThreadMarker) -> bool {
        let Some(window) = event.window(mtm) else {
            return false;
        };
        let Some(bar_height) = crate::tabs::bar_height_of_native_window(app, Retained::as_ptr(&window).cast())
        else {
            return false;
        };
        let Some(content) = window.contentView() else {
            return false;
        };
        // AppKit counts y from the bottom unless the view is flipped; the bar
        // stands at the content's top (`TitleBarStyle::Overlay`).
        let point = content.convertPoint_fromView(event.locationInWindow(), None);
        let y_from_top = if content.isFlipped() {
            point.y
        } else {
            content.bounds().size.height - point.y
        };
        begins_over_tab_bar(y_from_top, bar_height)
    }

    /// Install the monitor. Must run on the main thread, where AppKit lives.
    pub fn install(app: AppHandle) {
        let Some(mtm) = MainThreadMarker::new() else {
            log::error!("swipe monitor not installed: not on the main thread");
            return;
        };
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
                || over_tab_bar(&app, event_ref, mtm),
            );
            let decision = recognizer.borrow_mut().feed(phase);
            if let Some(direction) = decision {
                crate::tabs::swipe_sidebar(&app, direction == super::SwipeDirection::Right);
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
    use super::{begins_over_tab_bar, GesturePhase, SwipeDirection, SwipeRecognizer};

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
            GesturePhase::Began { over_tab_bar: false },
            GesturePhase::Changed { dx: 30.0, dy: 2.0 },
            GesturePhase::Other,
            GesturePhase::Changed { dx: 20.0, dy: 3.0 },
            GesturePhase::Ended,
        ]);
        assert_eq!(emitted, vec![SwipeDirection::Right]);

        let emitted = run(&[
            GesturePhase::Began { over_tab_bar: false },
            GesturePhase::Changed { dx: -45.0, dy: 0.0 },
            GesturePhase::Ended,
        ]);
        assert_eq!(emitted, vec![SwipeDirection::Left]);
    }

    #[test]
    fn cancelled_gesture_emits_nothing_even_past_the_threshold() {
        // x = 50 ≥ 40 and |x| ≥ 1.2·|y|: a swipe had the user finished it.
        let emitted = run(&[
            GesturePhase::Began { over_tab_bar: false },
            GesturePhase::Changed { dx: 50.0, dy: 1.0 },
            GesturePhase::Cancelled,
        ]);
        assert!(emitted.is_empty(), "cancelled swipe emitted {emitted:?}");
    }

    #[test]
    fn cancelled_gesture_does_not_leak_travel_into_a_stray_end() {
        // A late Ended after the cancel must not decide on the cancelled run.
        let emitted = run(&[
            GesturePhase::Began { over_tab_bar: false },
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
            GesturePhase::Began { over_tab_bar: false },
            GesturePhase::Changed { dx: 39.0, dy: 0.0 },
            GesturePhase::Ended,
        ])
        .is_empty());
        assert!(run(&[
            GesturePhase::Began { over_tab_bar: false },
            GesturePhase::Changed { dx: 60.0, dy: 55.0 },
            GesturePhase::Ended,
        ])
        .is_empty());
    }

    #[test]
    fn gesture_begun_over_the_tab_bar_never_touches_the_sidebar() {
        // Past the threshold either way and finished below the bar: the
        // decision taken where the fingers landed stands (У9).
        for dx in [80.0, -80.0] {
            let emitted = run(&[
                GesturePhase::Began { over_tab_bar: true },
                GesturePhase::Changed { dx, dy: 0.0 },
                GesturePhase::Ended,
            ]);
            assert!(emitted.is_empty(), "swipe over the bar emitted {emitted:?}");
        }
    }

    #[test]
    fn gesture_begun_below_the_bar_decides_as_usual_wherever_it_moves() {
        // Whether the pointer later crosses the bar is never asked: only
        // Began carries it.
        let emitted = run(&[
            GesturePhase::Began { over_tab_bar: false },
            GesturePhase::Changed { dx: 30.0, dy: 0.0 },
            GesturePhase::Changed { dx: 30.0, dy: 0.0 },
            GesturePhase::Ended,
        ]);
        assert_eq!(emitted, vec![SwipeDirection::Right]);
    }

    #[test]
    fn the_bar_does_not_leak_into_the_next_gesture() {
        let emitted = run(&[
            GesturePhase::Began { over_tab_bar: true },
            GesturePhase::Changed { dx: 80.0, dy: 0.0 },
            GesturePhase::Ended,
            GesturePhase::Began { over_tab_bar: false },
            GesturePhase::Changed { dx: -80.0, dy: 0.0 },
            GesturePhase::Ended,
        ]);
        assert_eq!(emitted, vec![SwipeDirection::Left]);
    }

    #[test]
    fn tab_bar_takes_its_rows_from_the_top_edge_to_its_height() {
        // The standard bar (30 + its line) and the tall one (39 + its line).
        for bar_height in [31.0, 40.0] {
            assert!(begins_over_tab_bar(0.0, bar_height));
            assert!(begins_over_tab_bar(bar_height - 1.0, bar_height));
            assert!(!begins_over_tab_bar(bar_height, bar_height));
        }
        assert!(!begins_over_tab_bar(-1.0, 31.0));
    }
}
