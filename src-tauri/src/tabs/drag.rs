//! Tearing a tab off its window and joining it to another (SPEC_TABS.md, В61
//! по В68).
//!
//! The tab bar notices the pull and hands over; from then on the backend
//! follows the pointer with a local monitor of mouse events, the way Chrome
//! moves a window during a tab drag: page events outside a window are not
//! guaranteed, and an HTML drag runs a system session in which no window can
//! follow the pointer (В64).

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, Position};

use super::{create_window, emit_bar_state, lock, new_id, shell, window_of, TabShell};
use crate::domain::windows::{tab_bar_height, SavedWindows, TabId, WindowFrame, WindowId};

/// `tabbar-drop-hover`: the dragged tab is over this bar at `x` (logical
/// points from the bar's left edge), or left it (`None`).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct DropHover {
    pub tab_id: TabId,
    pub x: Option<f64>,
}

/// What a running drag needs to finish or undo.
struct Drag {
    tab: TabId,
    /// The window that moves with the pointer.
    moving: WindowId,
    /// Where the tab came from, to put it back on Escape.
    origin: Origin,
    /// Pointer offset inside the moving window, physical pixels.
    grab: (f64, f64),
    /// The bar under the pointer and the slot it reported (В63).
    over: Option<(WindowId, Option<usize>)>,
    /// The windows before the drag: written if the app quits meanwhile (В68).
    before: SavedWindows,
}

enum Origin {
    /// Torn off from `window` at `index`; the moving window is new.
    TornOff { window: WindowId, index: usize },
    /// The window of a single tab moves; it stood at `position`.
    Moved { position: PhysicalPosition<i32> },
}

static DRAG: Mutex<Option<Drag>> = Mutex::new(None);

fn drag() -> std::sync::MutexGuard<'static, Option<Drag>> {
    DRAG.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The windows to write if the app quits during a drag: as before it (В68).
pub fn windows_before_drag() -> Option<SavedWindows> {
    drag().as_ref().map(|running| running.before.clone())
}

/// The bar `bar` reports the slot under the dragged tab (В63).
pub fn report_drop_slot(window: &WindowId, index: Option<usize>) {
    if let Some(running) = drag().as_mut() {
        if let Some((over, slot)) = running.over.as_mut() {
            if over == window {
                *slot = index;
            }
        }
    }
}

/// The pointer pulled `tab` off its bar at `grab` (logical points within
/// the bar page). Tears it off into a new window under the pointer, or moves
/// the window of a single tab, then follows the pointer until release.
pub fn begin(app: &AppHandle, tab: &TabId, grab: (f64, f64)) {
    if drag().is_some() {
        return;
    }
    let shell = shell(app);
    let before = shell.snapshot();
    let Some(source) = before.window_of(tab).cloned() else {
        return;
    };
    // A full-screen window does not tear: the tab moves to an ordinary
    // window instead (В65).
    if source.fullscreen {
        super::move_tab_to_new_window(app, tab);
        return;
    }
    let Some(native) = app.get_window(&source.id.label()) else {
        return;
    };
    let scale = native.scale_factor().unwrap_or(1.0);
    let grab_physical = (grab.0 * scale, grab.1 * scale);
    let Ok(cursor) = app.cursor_position() else {
        return;
    };

    let (moving, origin) = if source.tabs.len() < 2 {
        // The only tab moves its window (В62).
        let Ok(position) = native.outer_position() else {
            return;
        };
        (source.id.clone(), Origin::Moved { position })
    } else {
        let index = source.tabs.iter().position(|candidate| &candidate.id == tab).unwrap_or(0);
        let frame = WindowFrame {
            x: (cursor.x - grab_physical.0) / scale,
            y: (cursor.y - grab_physical.1) / scale,
            ..source.frame
        };
        let window = WindowId(new_id());
        let Some(now_visible) = shell.change(|model| model.detach(tab, window.clone(), frame)) else {
            return;
        };
        lock(&shell.live).shown.retain(|_, shown| shown != tab);
        let Some(saved) = shell.snapshot().window(&window).cloned() else {
            return;
        };
        if let Err(error) = create_window(app, &saved) {
            log::warn!("failed to tear the tab off: {error:#}");
            return;
        }
        match now_visible {
            Some(next) => super::activate(app, &next),
            None => emit_bar_state(app, &source.id),
        }
        (
            window,
            Origin::TornOff {
                window: source.id.clone(),
                index,
            },
        )
    };
    *drag() = Some(Drag {
        tab: tab.clone(),
        moving,
        origin,
        grab: grab_physical,
        over: None,
        before,
    });
    follow_pointer(app);
}

/// Where the moving window stands for the pointer at `cursor`.
fn moving_position(cursor: PhysicalPosition<f64>, grab: (f64, f64)) -> PhysicalPosition<i32> {
    #[allow(clippy::cast_possible_truncation)]
    PhysicalPosition::new((cursor.x - grab.0).round() as i32, (cursor.y - grab.1).round() as i32)
}

/// The tab window other than `moving` whose bar is under `cursor`, with the
/// pointer's x in logical points from that bar's left edge.
fn bar_under(app: &AppHandle, moving: &WindowId, cursor: PhysicalPosition<f64>) -> Option<(WindowId, f64)> {
    let snapshot = app.state::<TabShell>().snapshot();
    snapshot
        .windows
        .iter()
        .filter(|window| &window.id != moving)
        .find_map(|window| {
            let native = app.get_window(&window.id.label())?;
            let scale = native.scale_factor().ok()?;
            let position = native.outer_position().ok()?;
            let size = native.inner_size().ok()?;
            let left = f64::from(position.x);
            let top = f64::from(position.y);
            let inside = cursor.x >= left
                && cursor.x <= left + f64::from(size.width)
                && cursor.y >= top
                && cursor.y <= top + f64::from(tab_bar_height(window.chrome_rows.tab_bar)) * scale;
            inside.then(|| (window.id.clone(), (cursor.x - left) / scale))
        })
}

fn on_drag_moved(app: &AppHandle) {
    let Ok(cursor) = app.cursor_position() else {
        return;
    };
    let (moving, grab, tab, previously_over) = {
        let guard = drag();
        let Some(running) = guard.as_ref() else {
            return;
        };
        (
            running.moving.clone(),
            running.grab,
            running.tab.clone(),
            running.over.as_ref().map(|(window, _)| window.clone()),
        )
    };
    if let Some(window) = app.get_window(&moving.label()) {
        let _ = window.set_position(Position::Physical(moving_position(cursor, grab)));
    }
    let now_over = bar_under(app, &moving, cursor);
    if previously_over.as_ref() != now_over.as_ref().map(|(window, _)| window) {
        if let Some(left) = &previously_over {
            hint(app, left, &tab, None);
        }
        if let Some(running) = drag().as_mut() {
            running.over = now_over.as_ref().map(|(window, _)| (window.clone(), None));
        }
    }
    if let Some((window, x)) = now_over {
        hint(app, &window, &tab, Some(x));
    }
}

fn hint(app: &AppHandle, window: &WindowId, tab: &TabId, x: Option<f64>) {
    crate::commands::space_events::emit_to_labels(
        app,
        [window.bar_label()],
        "tabbar-drop-hover",
        DropHover {
            tab_id: tab.clone(),
            x,
        },
    );
}

/// The button went up: join the bar under the pointer, or stay (В63).
fn on_drag_released(app: &AppHandle) {
    let Some(running) = drag().take() else {
        return;
    };
    stop_following(app);
    let shell = shell(app);
    if let Some((target, slot)) = running.over.clone() {
        hint(app, &target, &running.tab, None);
        let index = slot.unwrap_or_else(|| {
            shell
                .snapshot()
                .window(&target)
                .map_or(0, |window| window.tabs.len())
        });
        join(app, &running.tab, &running.moving, &target, index);
        return;
    }
    // The window stays where it was let go; its frame is saved by its move.
    emit_bar_state(app, &running.moving);
}

/// Escape: the tab goes back where it came from (В63).
fn on_drag_cancelled(app: &AppHandle) {
    let Some(running) = drag().take() else {
        return;
    };
    stop_following(app);
    if let Some((target, _)) = &running.over {
        hint(app, target, &running.tab, None);
    }
    match running.origin {
        Origin::TornOff { window, index } => join(app, &running.tab, &running.moving, &window, index),
        Origin::Moved { position } => {
            if let Some(native) = app.get_window(&running.moving.label()) {
                let _ = native.set_position(Position::Physical(position));
            }
        }
    }
}

/// Move `tab` from the window `from` into `target` at `index`; `from` closes
/// when it empties.
fn join(app: &AppHandle, tab: &TabId, from: &WindowId, target: &WindowId, index: usize) {
    let shell = shell(app);
    let Some(closed) = shell.change(|model| model.attach(tab, target, index)) else {
        return;
    };
    lock(&shell.live).shown.retain(|_, shown| shown != tab);
    super::activate(app, tab);
    if closed.window_closed {
        if let Some(native) = app.get_window(&from.label()) {
            let _ = native.destroy();
        }
    } else if let Some(next) = closed.now_visible {
        super::activate(app, &next);
    } else {
        emit_bar_state(app, from);
    }
    if let Some(window) = window_of(app, tab) {
        if let Some(native) = app.get_window(&window.label()) {
            let _ = native.set_focus();
        }
    }
}

#[cfg(target_os = "macos")]
mod monitor {
    use std::cell::RefCell;
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};
    use tauri::AppHandle;

    /// The virtual key code of Escape.
    const ESCAPE_KEY_CODE: u16 = 53;

    thread_local! {
        static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    pub fn start(app: &AppHandle) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let events = handle.clone();
            let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                // SAFETY: AppKit hands the monitor a live event.
                let event_ref = unsafe { event.as_ref() };
                let kind = event_ref.r#type();
                if kind == NSEventType::LeftMouseDragged {
                    super::on_drag_moved(&events);
                } else if kind == NSEventType::LeftMouseUp {
                    super::on_drag_released(&events);
                } else if kind == NSEventType::KeyDown && event_ref.keyCode() == ESCAPE_KEY_CODE {
                    super::on_drag_cancelled(&events);
                    // The Escape belongs to the drag, not to a page.
                    return std::ptr::null_mut();
                }
                event.as_ptr()
            });
            // SAFETY: the documented AppKit call on the main thread; the
            // returned monitor is removed when the drag ends.
            let monitor = unsafe {
                NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                    NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp | NSEventMask::KeyDown,
                    &handler,
                )
            };
            MONITOR.with(|slot| *slot.borrow_mut() = monitor);
        });
    }

    pub fn stop() {
        MONITOR.with(|slot| {
            if let Some(monitor) = slot.borrow_mut().take() {
                // SAFETY: the monitor this module installed, removed on the
                // main thread where the monitor's events arrive.
                unsafe { NSEvent::removeMonitor(&monitor) };
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod monitor {
    use tauri::AppHandle;

    pub fn start(_app: &AppHandle) {}
    pub fn stop() {}
}

fn follow_pointer(app: &AppHandle) {
    monitor::start(app);
}

/// Remove the monitor after the event that ended the drag is handled: a
/// monitor is not removed from inside its own handler.
fn stop_following(app: &AppHandle) {
    let _ = app.run_on_main_thread(monitor::stop);
}

#[cfg(test)]
mod tests {
    use super::moving_position;
    use tauri::PhysicalPosition;

    #[test]
    fn the_window_keeps_the_grab_under_the_pointer() {
        let at = moving_position(PhysicalPosition::new(500.4, 300.6), (40.0, 20.0));
        assert_eq!(at, PhysicalPosition::new(460, 281));
    }
}
