//! Tearing a tab off its window and joining it to another (SPEC_TABS.md, В61
//! по В68).
//!
//! The tab bar notices the pull and hands over; from then on the backend
//! follows the pointer with a local monitor of mouse events, the way Chrome
//! moves a window during a tab drag: page events outside a window are not
//! guaranteed, and an HTML drag runs a system session in which no window can
//! follow the pointer (В64).
//!
//! Cards dragged in a tab's page come here too (В86; SPEC_OUTSIDE_WINDOW.md,
//! part Б). The page owns the drag; while its button is down the same kind
//! of monitor follows the pointer here, over every window. It moves the
//! dragged card drawn in the outside window, and finds the topmost window of
//! Mine under the pointer (ПК4). A bar under it hears of the cards with the
//! same `tabbar-drop-hover`, and the slot comes back with the same
//! `report_drop_slot`, whichever window the bar is in. The page of another
//! window of the same space hears the point, and the drop, for its rows of
//! collections. Let go anywhere else, the cards stay as they were.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, Position};

use super::{create_window, emit_bar_state, lock, new_id, shell, window_of, TabShell};
use crate::commands::space_events::emit_to_labels;
use crate::domain::windows::{
    NewTab, SavedWindows, TabId, TabSpace, TabView, WindowFrame, WindowId, TAB_BAR_HEIGHT_PX,
};
use crate::menu_panel::geometry::ScreenPoint;
use crate::outside_window::{self, CardStack};

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
    /// Cards dragged in a tab page of Mine (В86), shown by the title
    /// of the card the drag holds. `dropped`: the button went up at `x`; the
    /// bar answers with the slot there (`report_drop_slot`).
    Cards { title: String, dropped: bool },
}

/// What a tab page drags, said as the drag begins (`begin_card_drag`).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CardDragBegin {
    /// The title of the card the drag holds (В47).
    pub title: String,
    /// A tab each, the grabbed card's first, the rest after it in the feed's
    /// order (В86, п. 5).
    pub views: Vec<TabView>,
    /// The dragged cards, for a row of collections of another window.
    pub slugs: Vec<String>,
    /// The card was taken from a thumbnail of the sidebar: the feed of an
    /// open collection takes it, in this window and another
    /// (SPEC_FRONTEND.md, «Бросок миниатюры в открытую коллекцию»).
    pub thumbnail: bool,
    /// So many tabs that the bar's window asks `Open N tabs?` first (В86, п. 6).
    pub confirm: bool,
    /// The card as the outside window draws it; none keeps it in the page.
    pub stack: Option<CardStack>,
}

/// What came of the dragged cards after the drag began
/// (`update_card_drag`): the grabbed card's title once it was read, and its
/// card as the outside window draws it once the page has it.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CardDragUpdate {
    pub title: String,
    pub stack: Option<CardStack>,
}

/// `card-drag-over`: dragged cards are over this page of another window at
/// `point` (its points from the page's top left), or no longer (`None`).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CardDragOver {
    pub point: Option<ScreenPoint>,
    /// Taken from a thumbnail of the sidebar (`CardDragBegin::thumbnail`).
    pub thumbnail: bool,
}

/// `card-drag-drop`: dragged cards were let go over this page at `point`.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CardDragDrop {
    pub point: ScreenPoint,
    pub slugs: Vec<String>,
    pub thumbnail: bool,
}

/// `card-tabs-confirm`: a bar takes `count` cards dragged in this page once
/// `Open N tabs?` is answered here (`answer_card_tabs`): the window the drag
/// began in keeps the keyboard (В86, decision of 16.11.2026).
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
pub struct CardTabsConfirm {
    pub count: u32,
}

pub const CARD_DRAG_OVER_EVENT: &str = "card-drag-over";
pub const CARD_DRAG_DROP_EVENT: &str = "card-drag-drop";
pub const CARD_TABS_CONFIRM_EVENT: &str = "card-tabs-confirm";

/// Cards let go over a bar, waiting for that bar's slot.
struct PendingCards {
    window: WindowId,
    space: TabSpace,
    views: Vec<TabView>,
}

static PENDING_CARDS: Mutex<Option<PendingCards>> = Mutex::new(None);

/// Where the dragged cards are over (ПК4).
#[derive(Debug, Clone, PartialEq)]
enum CardTarget {
    /// The bar of a window, at `x` from its left edge.
    Bar { window: WindowId, x: f64 },
    /// The page of a window's visible tab, at `point` on it.
    Page { window: WindowId, tab: TabId, space: TabSpace, point: ScreenPoint },
}

impl CardTarget {
    fn same_place(&self, other: &CardTarget) -> bool {
        match (self, other) {
            (CardTarget::Bar { window: a, .. }, CardTarget::Bar { window: b, .. }) => a == b,
            (CardTarget::Page { tab: a, .. }, CardTarget::Page { tab: b, .. }) => a == b,
            _ => false,
        }
    }
}

/// Cards dragged in a tab page, followed here while its button is down.
struct CardDrag {
    source: String,
    window: WindowId,
    space: TabSpace,
    title: String,
    views: Vec<TabView>,
    slugs: Vec<String>,
    thumbnail: bool,
    confirm: bool,
    over: Option<CardTarget>,
}

static CARD_DRAG: Mutex<Option<CardDrag>> = Mutex::new(None);

/// Cards let go over a bar whose window asks `Open N tabs?` first.
struct Confirming {
    x: f64,
    title: String,
    cards: PendingCards,
}

static CONFIRMING: Mutex<Option<Confirming>> = Mutex::new(None);

fn card_drag() -> std::sync::MutexGuard<'static, Option<CardDrag>> {
    CARD_DRAG.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn confirming() -> std::sync::MutexGuard<'static, Option<Confirming>> {
    CONFIRMING.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

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

/// The tab page `label` began to drag cards, its drag `seq`: followed from
/// now on, its card drawn outside when it can be (ПК1, ПК8).
pub fn begin_card_drag(app: &AppHandle, label: &str, seq: u32, begin: CardDragBegin) {
    if !take_card_report(label, seq) || drag().is_some() {
        return;
    }
    let Some((window, space)) = tab_window_and_space(app, label) else {
        return;
    };
    // Cards let go over a bar that never answered stay where they are.
    *pending_cards() = None;
    if let (Some(stack), Some(cursor)) = (begin.stack, outside_window::native::cursor()) {
        outside_window::begin_drag(app, label, seq, stack, cursor);
    }
    *card_drag() = Some(CardDrag {
        source: label.to_string(),
        window,
        space,
        title: begin.title,
        views: begin.views,
        slugs: begin.slugs,
        thumbnail: begin.thumbnail,
        confirm: begin.confirm,
        over: None,
    });
    follow_pointer(app);
    on_card_moved(app);
}

/// The dragged card's title and look came once it was read (`seq` as for
/// the rest): a card not drawn outside yet is drawn there now (ПК2).
pub fn update_card_drag(app: &AppHandle, label: &str, seq: u32, update: CardDragUpdate) {
    if !take_card_report(label, seq) {
        return;
    }
    let title = update.title;
    let over = {
        let mut guard = card_drag();
        let Some(running) = guard.as_mut().filter(|running| running.source == label) else { return };
        running.title.clone_from(&title);
        running.over.clone()
    };
    if let (Some(stack), Some(cursor)) = (update.stack, outside_window::native::cursor()) {
        if !outside_window::drags_for(label) {
            outside_window::begin_drag(app, label, seq, stack, cursor);
        }
    }
    if let Some(CardTarget::Bar { window, x }) = over {
        emit_drop_hover(app, &window, Some(x), DropItem::Cards { title, dropped: false });
    }
}

/// The tab page `label` ended its drag: let go, or cancelled with Escape.
/// What it was over hears it no longer, and the card drawn outside goes.
pub fn end_card_drag(app: &AppHandle, label: &str, seq: u32) {
    if !take_card_report(label, seq) {
        return;
    }
    let ended = card_drag().take_if(|running| running.source == label);
    if let Some(ended) = ended {
        stop_following(app);
        if let Some(over) = &ended.over {
            leave(app, over, &ended.title);
        }
    }
    outside_window::end_drag(app);
}

/// `Open N tabs?` was answered in the bar's window: the cards land, or not.
pub fn answer_card_tabs(app: &AppHandle, open: bool) {
    let Some(asked) = confirming().take() else { return };
    if !open {
        return;
    }
    let window = asked.cards.window.clone();
    *pending_cards() = Some(asked.cards);
    emit_drop_hover(app, &window, Some(asked.x), DropItem::Cards { title: asked.title, dropped: true });
}

/// The topmost window of Mine under `cursor` and what of it is there: its
/// bar, or its visible tab's page (ПК4). The outside window, transparent to
/// the mouse, is not one of them.
fn target_at(app: &AppHandle, cursor: ScreenPoint) -> Option<CardTarget> {
    let below = outside_window::window_number(app).unwrap_or(0);
    let number = outside_window::native::window_at(cursor, below);
    if number == 0 {
        return None;
    }
    let snapshot = shell(app).snapshot();
    snapshot.windows.iter().find_map(|window| {
        let native = app.get_window(&window.id.label())?;
        let (found, frame) = outside_window::native::number_and_frame(&native)?;
        if found != number {
            return None;
        }
        let x = cursor.x - frame.x;
        let y = cursor.y - frame.y;
        let bar = f64::from(TAB_BAR_HEIGHT_PX);
        if y < bar {
            return Some(CardTarget::Bar { window: window.id.clone(), x });
        }
        let space = snapshot.tab(&window.active_tab)?.space.clone();
        Some(CardTarget::Page {
            window: window.id.clone(),
            tab: window.active_tab.clone(),
            space,
            point: ScreenPoint { x, y: y - bar },
        })
    })
}

/// What the cards were over hears they left it.
fn leave(app: &AppHandle, over: &CardTarget, title: &str) {
    match over {
        CardTarget::Bar { window, .. } => {
            emit_drop_hover(app, window, None, DropItem::Cards { title: title.to_string(), dropped: false });
        }
        CardTarget::Page { tab, .. } => {
            emit_to_labels(app, [tab.label()], CARD_DRAG_OVER_EVENT, CardDragOver { point: None, thumbnail: false });
        }
    }
}

/// Whether a page of another window hears of the cards: only one of their
/// own space (SPEC_OUTSIDE_WINDOW.md, question 3, decided 16.11.2026).
fn hears_cards(target: &CardTarget, from: &WindowId, space: &TabSpace) -> bool {
    match target {
        CardTarget::Bar { .. } => true,
        CardTarget::Page { window, space: shown, .. } => window != from && shown == space,
    }
}

fn on_card_moved(app: &AppHandle) {
    let Some(cursor) = outside_window::native::cursor() else { return };
    outside_window::move_drag(app, cursor);
    let found = target_at(app, cursor);
    let (left, now, title, thumbnail) = {
        let mut guard = card_drag();
        let Some(running) = guard.as_mut() else { return };
        let now = found.filter(|target| hears_cards(target, &running.window, &running.space));
        let left = running.over.clone().filter(|was| now.as_ref().is_none_or(|now| !now.same_place(was)));
        running.over.clone_from(&now);
        (left, now, running.title.clone(), running.thumbnail)
    };
    if let Some(left) = left {
        leave(app, &left, &title);
    }
    match now {
        Some(CardTarget::Bar { window, x }) => {
            emit_drop_hover(app, &window, Some(x), DropItem::Cards { title, dropped: false });
        }
        Some(CardTarget::Page { tab, point, .. }) => {
            emit_to_labels(app, [tab.label()], CARD_DRAG_OVER_EVENT, CardDragOver { point: Some(point), thumbnail });
        }
        None => {}
    }
}

/// The button went up: the cards land where the pointer is, if anything
/// there takes them (ПК4). The page that dragged them ends its drag after.
fn on_card_released(app: &AppHandle) {
    let Some(running) = card_drag().take() else { return };
    stop_following(app);
    outside_window::end_drag(app);
    match running.over {
        Some(CardTarget::Bar { window, x }) => {
            let cards = PendingCards { window: window.clone(), space: running.space, views: running.views };
            if running.confirm {
                // The room in the bar closes while the question is open; the
                // tabs come at the place of the drop once it is answered. The
                // page the drag began in asks: its window keeps the keyboard
                // (decision of 16.11.2026; the asking page is the lead's
                // reading of it).
                emit_drop_hover(app, &window, None, DropItem::Cards { title: running.title.clone(), dropped: false });
                let count = u32::try_from(cards.views.len()).unwrap_or(u32::MAX);
                *confirming() = Some(Confirming { x, title: running.title, cards });
                emit_to_labels(app, [running.source], CARD_TABS_CONFIRM_EVENT, CardTabsConfirm { count });
            } else {
                *pending_cards() = Some(cards);
                emit_drop_hover(app, &window, Some(x), DropItem::Cards { title: running.title, dropped: true });
            }
        }
        Some(CardTarget::Page { tab, point, .. }) => {
            emit_to_labels(
                app,
                [tab.label()],
                CARD_DRAG_DROP_EVENT,
                CardDragDrop { point, slugs: running.slugs, thumbnail: running.thumbnail },
            );
        }
        None => {}
    }
}

/// The cards waiting for `window`'s slot land at `index`: a tab each from
/// there, the grabbed card's first, where the placeholder stood; records
/// without a page. The window's visible tab stays, and the window stays
/// where it is among the windows: the bar shows the new tabs, nothing
/// switches to them (В86, decision of 16.11.2026).
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
        shell(app).change(|model| model.insert_tabs(window, index, tabs, None));
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
            // A drag whose end never came leaves no second monitor.
            stop();
            let events = handle.clone();
            let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                // SAFETY: AppKit hands the monitor a live event.
                let event_ref = unsafe { event.as_ref() };
                let kind = event_ref.r#type();
                // A tab's drag or a card's: one mouse, one at a time.
                let tab = super::drag().is_some();
                if kind == NSEventType::LeftMouseDragged {
                    if tab {
                        super::on_drag_moved(&events);
                    } else {
                        super::on_card_moved(&events);
                    }
                } else if kind == NSEventType::LeftMouseUp {
                    if tab {
                        super::on_drag_released(&events);
                    } else {
                        super::on_card_released(&events);
                    }
                } else if tab && kind == NSEventType::KeyDown && event_ref.keyCode() == ESCAPE_KEY_CODE {
                    super::on_drag_cancelled(&events);
                    // The Escape belongs to the drag, not to a page. A
                    // card's drag leaves it to its page, which cancels it.
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
    use super::{card_target, hears_cards, moving_position, newer_report, CardTarget};
    use crate::menu_panel::geometry::ScreenPoint;
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

    fn page(window: &str, tab: &str, vault: &str) -> CardTarget {
        CardTarget::Page {
            window: WindowId(window.to_string()),
            tab: TabId(tab.to_string()),
            space: TabSpace::Space { vault_id: vault.to_string() },
            point: ScreenPoint { x: 10.0, y: 20.0 },
        }
    }

    #[test]
    fn hears_cards_on_any_bar_and_on_another_windows_page_of_their_space() {
        let from = WindowId("one".to_string());
        let space = TabSpace::Space { vault_id: "mine".to_string() };
        // Every window's bar takes cards, the window's own too (ПК4).
        assert!(hears_cards(&CardTarget::Bar { window: from.clone(), x: 40.0 }, &from, &space));
        assert!(hears_cards(&CardTarget::Bar { window: WindowId("two".to_string()), x: 40.0 }, &from, &space));
        // Another window's page of the same space hears them.
        assert!(hears_cards(&page("two", "t2", "mine"), &from, &space));
        // Not one of another space (question 3, decided 16.11.2026), nor the
        // window's own page, whose drag finds its own targets.
        assert!(!hears_cards(&page("two", "t2", "other"), &from, &space));
        assert!(!hears_cards(&page("one", "t1", "mine"), &from, &space));
    }

    #[test]
    fn tells_a_move_within_one_bar_or_page_from_a_move_to_another() {
        let bar = |window: &str, x: f64| CardTarget::Bar { window: WindowId(window.to_string()), x };
        assert!(bar("one", 10.0).same_place(&bar("one", 300.0)));
        assert!(!bar("one", 10.0).same_place(&bar("two", 10.0)));
        assert!(page("two", "t2", "mine").same_place(&page("two", "t2", "mine")));
        assert!(!page("two", "t2", "mine").same_place(&bar("two", 10.0)));
    }
}
