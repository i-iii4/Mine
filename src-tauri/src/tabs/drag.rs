//! Tearing a tab off its window and joining it to another (SPEC_TABS.md, В61
//! по В68).
//!
//! The tab bar notices the pull and hands over; from then on the backend
//! follows the pointer with a local monitor of mouse events, the way Chrome
//! moves a window during a tab drag: page events outside a window are not
//! guaranteed, and an HTML drag runs a system session in which no window can
//! follow the pointer (В64).
//!
//! Cards dragged in a tab's page over its own window's bar come here too
//! (В86): the page sees the pointer over the bar, the bar alone knows where
//! its tabs stand, so the backend carries the pointer to the bar with the
//! same `tabbar-drop-hover` and takes the slot back with the same
//! `report_drop_slot`.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, Position};

use super::{activate, create_window, emit_bar_state, lock, new_id, shell, window_of, TabShell};
use crate::domain::windows::{
    NewTab, SavedWindows, TabId, TabSpace, TabView, WindowFrame, WindowId, TAB_BAR_HEIGHT_PX,
};

/// The event that tells a bar what is held over it (В63, В86).
pub const TABBAR_DROP_HOVER_EVENT: &str = "tabbar-drop-hover";

/// `tabbar-drop-hover`: something dragged is over this bar at `x` (logical
/// points from the bar's left edge), or left it (`None`).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct DropHover {
    pub x: Option<f64>,
    pub item: DropItem,
}

/// What is held over a bar.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DropItem {
    /// A tab of another window (В63).
    Tab { tab_id: TabId },
    /// Cards dragged in this window's visible tab (В86), shown by the title
    /// of the card the drag holds. `dropped`: the button went up at `x`; the
    /// bar answers with the slot there (`report_drop_slot`).
    Cards { title: String, dropped: bool },
}

/// Where cards dragged in a tab's page are over its window's bar
/// (`report_card_drag`, В86): `x` in logical points from the bar's left
/// edge, which is the page's left edge too.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CardDragHover {
    pub x: f64,
    /// The title of the card the drag holds (В47).
    pub title: String,
}

/// Cards let go over the bar (`drop_cards_on_tab_bar`, В86): one tab each,
/// the grabbed card's first, on the placeholder's slot, and shown; the rest
/// after it in the feed's order (decision of 15.11.2026).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CardBarDrop {
    pub x: f64,
    pub title: String,
    pub views: Vec<TabView>,
}

/// Cards let go over a bar, waiting for that bar's slot.
struct PendingCards {
    window: WindowId,
    space: TabSpace,
    views: Vec<TabView>,
}

static PENDING_CARDS: Mutex<Option<PendingCards>> = Mutex::new(None);

/// The number of the latest card report taken from each tab page. A page's
/// calls may reach the backend in any order (В10): a report numbered no
/// higher than one already taken is late and changes nothing, so the pointer
/// leaving the bar is never undone by a move reported before it.
static CARD_REPORTS: Mutex<BTreeMap<String, u32>> = Mutex::new(BTreeMap::new());

/// Whether the report `seq` of the page `label` is newer than every one
/// taken from it; a newer one is taken.
fn take_card_report(label: &str, seq: u32) -> bool {
    let mut reports = CARD_REPORTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    newer_report(&mut reports, label, seq)
}

fn newer_report(reports: &mut BTreeMap<String, u32>, label: &str, seq: u32) -> bool {
    if reports.get(label).is_some_and(|&last| seq <= last) {
        return false;
    }
    reports.insert(label.to_string(), seq);
    true
}

/// The page `label` starts again or closes: its card reports count from the
/// start.
pub fn forget_card_reports(label: &str) {
    CARD_REPORTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(label);
}

fn pending_cards() -> std::sync::MutexGuard<'static, Option<PendingCards>> {
    PENDING_CARDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The window of the tab page `label` and the space its tab shows.
fn tab_window_and_space(app: &AppHandle, label: &str) -> Option<(WindowId, TabSpace)> {
    card_target(&shell(app).snapshot(), label)
}

/// Whose bar hears of cards dragged in the page `label`: the window that
/// holds its tab, and no other (В86, п. 7); with the space the cards' tabs
/// show. `None` for a page that is not a tab.
fn card_target(windows: &SavedWindows, label: &str) -> Option<(WindowId, TabSpace)> {
    let tab = TabId::from_label(label)?;
    let window = windows.window_of(&tab)?.id.clone();
    let space = windows.tab(&tab)?.space.clone();
    Some((window, space))
}

/// The tab page `label` drags cards over its own window's bar at `hover`, or
/// no longer (`None`). Only that window's bar hears of it (В86, п. 7).
pub fn report_card_drag(app: &AppHandle, label: &str, seq: u32, hover: Option<CardDragHover>) {
    if !take_card_report(label, seq) {
        return;
    }
    let Some((window, _)) = tab_window_and_space(app, label) else {
        return;
    };
    // A drop waiting for its slot stays: the page's calls may arrive out of
    // order (В10), and a late report of the pointer must not undo the drop.
    let (x, title) = match hover {
        Some(hover) => (Some(hover.x), hover.title),
        None => (None, String::new()),
    };
    emit_drop_hover(app, &window, x, DropItem::Cards { title, dropped: false });
}

/// The tab page `label` let cards go over its window's bar: they wait for
/// the slot the bar finds at `drop.x` (В86).
pub fn drop_cards(app: &AppHandle, label: &str, seq: u32, drop: CardBarDrop) {
    if !take_card_report(label, seq) {
        return;
    }
    let Some((window, space)) = tab_window_and_space(app, label) else {
        return;
    };
    if drop.views.is_empty() {
        emit_drop_hover(app, &window, None, DropItem::Cards { title: drop.title, dropped: false });
        return;
    }
    *pending_cards() = Some(PendingCards {
        window: window.clone(),
        space,
        views: drop.views,
    });
    emit_drop_hover(app, &window, Some(drop.x), DropItem::Cards { title: drop.title, dropped: true });
}

/// The cards waiting for `window`'s slot land at `index`: a tab each from
/// there, the grabbed card's first and shown, where the placeholder stood;
/// the rest records without a page (В86).
/// The bar then hears the drop is over, also when nothing was waiting.
fn land_cards(app: &AppHandle, window: &WindowId, index: usize) {
    let pending = pending_cards().take_if(|pending| &pending.window == window);
    if let Some(pending) = pending {
        let tabs: Vec<NewTab> = pending
            .views
            .into_iter()
            .map(|view| NewTab {
                id: TabId(new_id()),
                space: pending.space.clone(),
                view,
            })
            .collect();
        let shown = tabs[0].id.clone();
        if shell(app).change(|model| model.insert_tabs(window, index, tabs, 0)) {
            activate(app, &shown);
        }
    }
    // The state with the new tabs ends the gap they land in; the end of the
    // drop ends the bar's landing.
    emit_bar_state(app, window);
    emit_drop_hover(app, window, None, DropItem::Cards { title: String::new(), dropped: false });
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

/// The bar of `window` reports the slot under the dragged tab (В63), or the
/// slot where cards were let go (В86).
pub fn report_drop_slot(app: &AppHandle, window: &WindowId, index: Option<usize>) {
    if let Some(running) = drag().as_mut() {
        if let Some((over, slot)) = running.over.as_mut() {
            if over == window {
                *slot = index;
            }
        }
        return;
    }
    if let Some(index) = index {
        land_cards(app, window, index);
    }
}

/// The pointer pulled `tab` off its bar at `grab` (logical points within
/// the bar page). Tears it off into a new window under the pointer, or moves
/// the window of a single tab, then follows the pointer until release.
pub fn begin(app: &AppHandle, tab: &TabId, grab: (f64, f64)) {
    if drag().is_some() {
        return;
    }
    // Cards let go over a bar that never answered stay where they are.
    *pending_cards() = None;
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
        if let Err(error) = create_window(app, &saved, true) {
            // The tab goes back where it was, why in the log (Е2.9):
            // until 13.10.2026 it stayed in a window that did not exist.
            super::put_back(app, tab, &source.id, index, &error);
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
                && cursor.y <= top + f64::from(TAB_BAR_HEIGHT_PX) * scale;
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
    emit_drop_hover(app, window, x, DropItem::Tab { tab_id: tab.clone() });
}

fn emit_drop_hover(app: &AppHandle, window: &WindowId, x: Option<f64>, item: DropItem) {
    crate::commands::space_events::emit_to_labels(app, [window.bar_label()], TABBAR_DROP_HOVER_EVENT, DropHover { x, item });
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
    use super::{card_target, moving_position, newer_report};
    use crate::domain::windows::{
        SavedTab, SavedWindow, SavedWindows, SidebarLayout, TabId, TabSpace, TabView, WindowFrame, WindowId,
        SAVED_WINDOWS_VERSION,
    };
    use std::collections::BTreeMap;
    use tauri::PhysicalPosition;

    fn window(id: &str, tabs: &[(&str, &str)]) -> SavedWindow {
        SavedWindow {
            id: WindowId(id.into()),
            frame: WindowFrame { x: 0.0, y: 0.0, width: 1200.0, height: 840.0 },
            fullscreen: false,
            tabs: tabs
                .iter()
                .map(|(tab, space)| SavedTab {
                    id: TabId((*tab).into()),
                    space: TabSpace::Space { vault_id: (*space).into() },
                    view: TabView::default(),
                    sidebar: None,
                })
                .collect(),
            active_tab: TabId(tabs[0].0.into()),
            sidebar: SidebarLayout::default(),
        }
    }

    /// В86, п. 7: cards dragged in a tab go to the bar of its own window,
    /// in its space; a bar or an unknown page takes none.
    #[test]
    fn cards_go_to_the_bar_of_their_own_window_only() {
        let windows = SavedWindows {
            version: SAVED_WINDOWS_VERSION,
            windows: vec![window("w1", &[("a", "x"), ("b", "y")]), window("w2", &[("c", "x")])],
            window_surface: None,
        };
        assert_eq!(
            card_target(&windows, "tab-b"),
            Some((WindowId("w1".into()), TabSpace::Space { vault_id: "y".into() })),
        );
        assert_eq!(card_target(&windows, "tab-c").map(|(window, _)| window), Some(WindowId("w2".into())));
        assert_eq!(card_target(&windows, "tabbar-w1"), None);
        assert_eq!(card_target(&windows, "tab-gone"), None);
    }

    /// В86: a page's card reports may arrive out of order (В10); a late one
    /// changes nothing, a page that starts again counts from the start.
    #[test]
    fn a_late_card_report_changes_nothing() {
        let mut reports = BTreeMap::new();
        assert!(newer_report(&mut reports, "tab-a", 1));
        assert!(newer_report(&mut reports, "tab-a", 3));
        assert!(!newer_report(&mut reports, "tab-a", 2));
        assert!(!newer_report(&mut reports, "tab-a", 3));
        // Each page counts on its own.
        assert!(newer_report(&mut reports, "tab-b", 1));
        reports.remove("tab-a");
        assert!(newer_report(&mut reports, "tab-a", 1));
    }

    #[test]
    fn the_window_keeps_the_grab_under_the_pointer() {
        let at = moving_position(PhysicalPosition::new(500.4, 300.6), (40.0, 20.0));
        assert_eq!(at, PhysicalPosition::new(460, 281));
    }
}
