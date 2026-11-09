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
//! A gesture that begins over an element that scrolls sideways belongs to that
//! element in the same way (У17). Only the page knows its elements, so when the
//! fingers land the page under the pointer is asked once. The question goes out
//! before any of the gesture's movement and its answer lands on the main thread,
//! where the gesture's events land too, so exactly two orders exist. The answer
//! comes first in an ordinary swipe, and lifting the fingers decides at once, as
//! it always did. The fingers lift first when the page is busy: the direction
//! then waits for the answer, with no timer, because WebKit always calls back.
//! The answer names its gesture, so a late one cannot touch the next gesture.
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
/// What the page answers the question with (`src/lib/horizontalScroller.ts`).
#[cfg(any(target_os = "macos", test))]
const SCROLLER_QUESTION: &str = "__MINE_HORIZONTAL_SCROLLER_AT__";

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

/// The script that asks a page whether an element that scrolls sideways stands
/// at this point, in CSS pixels. A page without the function, the tab bar's
/// among them, answers no (У17).
#[cfg(any(target_os = "macos", test))]
fn scroller_question(x: f64, y: f64) -> String {
    format!("window.{SCROLLER_QUESTION}?.({x}, {y}) === true")
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
    /// The number of the last gesture that began; the page's answer names it.
    gesture: u64,
    /// What the page answered about the point where the fingers landed.
    over_scroller: Option<bool>,
    /// The direction of a gesture that finished before the page answered.
    unanswered: Option<SwipeDirection>,
}

#[cfg(any(target_os = "macos", test))]
impl SwipeRecognizer {
    /// Feed one non-momentum phase. Returns a direction only when the user
    /// lifted their fingers after enough horizontal travel and the page has
    /// said no element under the fingers scrolls sideways; a cancelled gesture,
    /// or one that began over the tab bar or such an element, returns nothing.
    /// Before the page answers, the direction waits for [`Self::page_answered`].
    fn feed(&mut self, phase: GesturePhase) -> Option<SwipeDirection> {
        match phase {
            GesturePhase::Began { over_tab_bar } => {
                self.x = 0.0;
                self.y = 0.0;
                self.live = true;
                self.over_tab_bar = over_tab_bar;
                self.gesture = self.gesture.wrapping_add(1);
                self.over_scroller = None;
                self.unanswered = None;
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
                // Decided where the fingers landed, kept to the end (У9, У17).
                let decision = if self.over_tab_bar { None } else { self.decide() };
                let over_scroller = self.over_scroller;
                self.reset();
                match over_scroller {
                    Some(false) => decision,
                    Some(true) => None,
                    None => {
                        self.unanswered = decision;
                        None
                    }
                }
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

    /// The page answered about gesture number `gesture`. Returns the direction
    /// of that gesture if it finished before this answer and no element under
    /// the fingers scrolls sideways. An answer about an earlier gesture changes
    /// nothing: the fingers have landed again since (У17).
    fn page_answered(&mut self, gesture: u64, over_scroller: bool) -> Option<SwipeDirection> {
        if gesture != self.gesture {
            return None;
        }
        self.over_scroller = Some(over_scroller);
        let direction = self.unanswered.take();
        if over_scroller {
            None
        } else {
            direction
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
        self.over_scroller = None;
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;
    use std::ptr::NonNull;
    use std::rc::Rc;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObjectProtocol};
    use objc2::{class, msg_send, MainThreadMarker};
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase, NSView};
    use objc2_foundation::NSString;
    use tauri::AppHandle;

    use super::{begins_over_tab_bar, scroller_question, GesturePhase, SwipeDirection, SwipeRecognizer};
    use crate::frame_context_menu::css_point;

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

    /// The page the scroll of `event` goes to: the web view `AppKit` finds under
    /// the pointer, whichever tab or window it belongs to. `None` over the
    /// window's own controls.
    fn page_under_pointer(event: &NSEvent, mtm: MainThreadMarker) -> Option<Retained<NSView>> {
        let content = event.window(mtm)?.contentView()?;
        // `hitTest:` takes its point in the coordinates of the view's superview.
        // SAFETY: reading the superview of a live view on the main thread.
        let frame = unsafe { content.superview() }?;
        let mut view = content.hitTest(frame.convertPoint_fromView(event.locationInWindow(), None))?;
        while !view.isKindOfClass(class!(WKWebView)) {
            // SAFETY: as above.
            view = unsafe { view.superview() }?;
        }
        Some(view)
    }

    fn apply(app: &AppHandle, decision: Option<SwipeDirection>) {
        if let Some(direction) = decision {
            crate::tabs::swipe_sidebar(app, direction == SwipeDirection::Right);
        }
    }

    /// Ask the page under the pointer whether an element that scrolls sideways
    /// stands where the fingers landed (У17). The answer lands on the main
    /// thread. No page, a script error and a dead page all answer no, so a swipe
    /// over anything else always gets its decision.
    fn ask_page(app: &AppHandle, event: &NSEvent, mtm: MainThreadMarker, recognizer: &Rc<RefCell<SwipeRecognizer>>) {
        let gesture = recognizer.borrow().gesture;
        let Some(page) = page_under_pointer(event, mtm) else {
            recognizer.borrow_mut().page_answered(gesture, false);
            return;
        };
        let point = page.convertPoint_fromView(event.locationInWindow(), None);
        // SAFETY: `page` is a WKWebView, which answers `pageZoom`.
        let zoom: f64 = unsafe { msg_send![&*page, pageZoom] };
        let point = css_point(point.x, point.y, page.bounds().size.height, page.isFlipped(), zoom);
        let script = NSString::from_str(&scroller_question(point.x, point.y));
        let app = app.clone();
        let recognizer = Rc::clone(recognizer);
        let answered = RcBlock::new(move |result: *mut AnyObject, _error: *mut AnyObject| {
            // SAFETY: WebKit hands a live object or nil. The script's value is
            // always a boolean, an `NSNumber` here; an error leaves nil.
            let over_scroller = unsafe { result.as_ref() }.is_some_and(|result| unsafe { msg_send![result, boolValue] });
            let decision = recognizer.borrow_mut().page_answered(gesture, over_scroller);
            apply(&app, decision);
        });
        // SAFETY: a live WKWebView on the main thread; WebKit copies the block
        // and calls it once on the main thread, so it needs no `Send`.
        let () = unsafe { msg_send![&*page, evaluateJavaScript: &*script, completionHandler: &*answered] };
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
            apply(&app, decision);
            if matches!(phase, GesturePhase::Began { over_tab_bar: false }) {
                ask_page(&app, event_ref, mtm, &recognizer);
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
    use super::{begins_over_tab_bar, scroller_question, GesturePhase, SwipeDirection, SwipeRecognizer};

    /// The phases of a gesture over a page that answered no before the fingers
    /// moved, the ordinary order.
    fn run(phases: &[GesturePhase]) -> Vec<SwipeDirection> {
        let mut recognizer = SwipeRecognizer::default();
        phases
            .iter()
            .filter_map(|phase| {
                let decision = recognizer.feed(*phase);
                if matches!(phase, GesturePhase::Began { .. }) {
                    recognizer.page_answered(recognizer.gesture, false);
                }
                decision
            })
            .collect()
    }

    const SWIPE_RIGHT: [GesturePhase; 3] = [
        GesturePhase::Began { over_tab_bar: false },
        GesturePhase::Changed { dx: 80.0, dy: 0.0 },
        GesturePhase::Ended,
    ];

    /// Feed the whole of `phases` with no answer from the page.
    fn fed(recognizer: &mut SwipeRecognizer, phases: &[GesturePhase]) -> Vec<SwipeDirection> {
        phases.iter().filter_map(|phase| recognizer.feed(*phase)).collect()
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
    fn gesture_over_a_scroller_never_touches_the_sidebar_in_either_direction() {
        // The page answered before the fingers lifted: the ordinary order.
        for dx in [80.0, -80.0] {
            let mut recognizer = SwipeRecognizer::default();
            recognizer.feed(GesturePhase::Began { over_tab_bar: false });
            assert_eq!(recognizer.page_answered(recognizer.gesture, true), None);
            let emitted = fed(
                &mut recognizer,
                &[GesturePhase::Changed { dx, dy: 0.0 }, GesturePhase::Ended],
            );
            assert!(emitted.is_empty(), "swipe over a scroller emitted {emitted:?}");
        }
    }

    #[test]
    fn answer_before_the_fingers_lift_decides_at_the_lift() {
        let mut recognizer = SwipeRecognizer::default();
        recognizer.feed(GesturePhase::Began { over_tab_bar: false });
        assert_eq!(recognizer.page_answered(recognizer.gesture, false), None);
        recognizer.feed(GesturePhase::Changed { dx: 80.0, dy: 0.0 });
        assert_eq!(recognizer.feed(GesturePhase::Ended), Some(SwipeDirection::Right));
    }

    #[test]
    fn late_no_lets_a_finished_swipe_through_once() {
        // The fingers lifted first: the swipe waits, then goes on the answer.
        let mut recognizer = SwipeRecognizer::default();
        assert!(fed(&mut recognizer, &SWIPE_RIGHT).is_empty());
        let gesture = recognizer.gesture;
        assert_eq!(recognizer.page_answered(gesture, false), Some(SwipeDirection::Right));
        assert_eq!(recognizer.page_answered(gesture, false), None);
    }

    #[test]
    fn late_yes_takes_a_finished_swipe_away() {
        let mut recognizer = SwipeRecognizer::default();
        assert!(fed(&mut recognizer, &SWIPE_RIGHT).is_empty());
        let gesture = recognizer.gesture;
        assert_eq!(recognizer.page_answered(gesture, true), None);
        assert_eq!(recognizer.page_answered(gesture, false), None);
    }

    #[test]
    fn late_answer_to_a_nudge_or_a_cancelled_gesture_decides_nothing() {
        let mut recognizer = SwipeRecognizer::default();
        let nudge = [
            GesturePhase::Began { over_tab_bar: false },
            GesturePhase::Changed { dx: 39.0, dy: 0.0 },
            GesturePhase::Ended,
        ];
        assert!(fed(&mut recognizer, &nudge).is_empty());
        assert_eq!(recognizer.page_answered(recognizer.gesture, false), None);

        let cancelled = [
            GesturePhase::Began { over_tab_bar: false },
            GesturePhase::Changed { dx: 80.0, dy: 0.0 },
            GesturePhase::Cancelled,
        ];
        assert!(fed(&mut recognizer, &cancelled).is_empty());
        assert_eq!(recognizer.page_answered(recognizer.gesture, false), None);
    }

    #[test]
    fn answer_about_an_earlier_gesture_changes_nothing() {
        let mut recognizer = SwipeRecognizer::default();
        assert!(fed(&mut recognizer, &SWIPE_RIGHT).is_empty());
        let earlier = recognizer.gesture;

        // The fingers land again before the earlier answer: its swipe is gone,
        // and neither of its possible answers speaks for the new gesture.
        recognizer.feed(GesturePhase::Began { over_tab_bar: false });
        assert_eq!(recognizer.page_answered(earlier, false), None);
        assert_eq!(recognizer.page_answered(earlier, true), None);
        recognizer.feed(GesturePhase::Changed { dx: -80.0, dy: 0.0 });
        assert_eq!(recognizer.feed(GesturePhase::Ended), None);
        assert_eq!(
            recognizer.page_answered(recognizer.gesture, false),
            Some(SwipeDirection::Left),
        );
    }

    #[test]
    fn the_scroller_does_not_leak_into_the_next_gesture() {
        let mut recognizer = SwipeRecognizer::default();
        recognizer.feed(GesturePhase::Began { over_tab_bar: false });
        recognizer.page_answered(recognizer.gesture, true);
        recognizer.feed(GesturePhase::Changed { dx: 80.0, dy: 0.0 });
        assert_eq!(recognizer.feed(GesturePhase::Ended), None);

        recognizer.feed(GesturePhase::Began { over_tab_bar: false });
        recognizer.page_answered(recognizer.gesture, false);
        recognizer.feed(GesturePhase::Changed { dx: -80.0, dy: 0.0 });
        assert_eq!(recognizer.feed(GesturePhase::Ended), Some(SwipeDirection::Left));
    }

    #[test]
    fn the_bar_keeps_its_gesture_whatever_a_stray_answer_says() {
        let mut recognizer = SwipeRecognizer::default();
        recognizer.feed(GesturePhase::Began { over_tab_bar: true });
        recognizer.feed(GesturePhase::Changed { dx: 80.0, dy: 0.0 });
        assert_eq!(recognizer.feed(GesturePhase::Ended), None);
        assert_eq!(recognizer.page_answered(recognizer.gesture, false), None);
    }

    #[test]
    fn the_question_names_the_point_and_tolerates_a_page_without_the_function() {
        assert_eq!(
            scroller_question(120.5, 80.0),
            "window.__MINE_HORIZONTAL_SCROLLER_AT__?.(120.5, 80) === true",
        );
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
