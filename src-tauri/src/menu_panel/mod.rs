//! TRIAL (SPEC_MENU_WINDOW.md; DESIGN_SYSTEM.md, «Меню карточки в отдельном
//! окне: проба»): the menu panel, a window of its own a menu is drawn in,
//! so the menu may reach past the edge of the app's window like a system
//! menu.
//!
//! One clear borderless window, made once. The app makes it itself, of its
//! own class, and moves into it the page of a hidden Tauri window, the
//! panel's shell (`PANEL_LABEL`): the shell makes the page and carries what
//! the page and the backend say to each other (МО62). The panel is unseen
//! until a check of its own pixels finds it clear
//! (`native::check_transparency`); a panel that fails the check is never
//! shown, and the menu opens on its page. At rest the panel stays on the
//! screen, so WebKit keeps its page running, draws nothing and lets every
//! click through.
//!
//! An opening is one step: a page asks with the anchor, the menu as data
//! (`spec`) and the size it counts from that, the backend lays the menu out
//! on the screen (`geometry`), sets the panel's frame for this menu and
//! moves it there (МО29), gives it the clicks and the keyboard and sends its
//! page what to draw. The panel becomes the key window without becoming the
//! main one: the window the menu came from keeps its active look.
//!
//! The order of what is said about a menu is told by numbers, never by time
//! (SPEC_MENU_WINDOW.md, section 5). The page that opens a menu numbers it
//! (МО34), every message names the page and the number (МО35), and every
//! message passes through here, the one place that sets their order (МО36):
//! what the panel's page asks is carried out in the order of its own count,
//! and what goes to either page carries a count of its own. A closing is the
//! last message of its row (МО38). One time is left, `PAINT_DEADLINE`: a page
//! that draws nothing can only be told by the clock (МО40).

pub mod geometry;
pub(crate) mod native;
pub mod spec;

/// The panel's own window with no Tauri around it, for the test that makes
/// it of real AppKit objects on the main thread
/// (`tests/menu_panel_window.rs`; SPEC_MENU_WINDOW.md, МО62а).
#[cfg(target_os = "macos")]
pub mod window {
    pub use super::native::{adopt, forget_panel as forget};
}

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::commands::space_events::emit_to_labels;
use crate::domain::windows::WindowId;
use geometry::{MenuOpener, MenuPanelLayout, MenuPanelSize, ScreenRect, SubmenuSize, REST_HEIGHT_PX, REST_WIDTH_PX};
use spec::{MenuAction, MenuAnswer, MenuSpec};

pub const PANEL_LABEL: &str = "menu-panel";
const PANEL_PAGE: &str = "menu-panel.html";

/// What the backend says to the page a menu came from.
const TO_SOURCE_EVENT: &str = "menu-panel-to-source";
/// What the backend says to the panel's page.
const TO_PAGE_EVENT: &str = "menu-panel-to-page";
const STATUS_EVENT: &str = "menu-panel-status";

/// A panel whose page draws nothing within this after it was shown gives
/// the clicks back, and the tab opens its menu on the page (МО40). The one
/// time of the panel: a page that hangs sends no word to tell it by. Its
/// value is Doherty's threshold: an answer within 400 ms keeps a person's
/// attention, so the menu is there by one way or the other in that time.
const PAINT_DEADLINE: Duration = Duration::from_millis(400);

/// Whether the panel's page listens and its window was found clear: until
/// then a menu opens on its page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct MenuPanelStatus {
    pub ready: bool,
}

/// A page asks for its menu in the panel.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MenuPanelOpenRequest {
    /// The page's load: a page loaded anew counts its menus from one again.
    pub page: String,
    /// The menu's number, the page's own count of its openings (МО34).
    pub menu: u32,
    /// The anchor in the page: the plate of the button, or the point of a
    /// right click as a rectangle of no size.
    pub anchor: ScreenRect,
    pub opener: MenuOpener,
    /// The menu as data: what the panel's page draws (МО16).
    pub spec: MenuSpec,
    /// A key opened the menu: it lands at once and lights its first row
    /// (SPEC_MOTION_LEVELS.md, УД4).
    pub by_key: bool,
    /// The dev button style of the window the menu came from
    /// (src/lib/buttonStyle.ts).
    pub buttons: Option<String>,
    /// The main menu's size as the page counts it from the description
    /// (src/lib/menuSpec.ts): the backend places the panel by it before the
    /// panel's page has drawn anything (МО28).
    pub size: MenuPanelSize,
    /// Each submenu's size and the row it opens off.
    pub submenus: Vec<SubmenuSize>,
    /// When the input that opened the menu came, epoch milliseconds; none
    /// when no input's event was at hand, and the measure starts at `sent_at`.
    pub event_at: Option<f64>,
    /// When the tab sent this request.
    pub sent_at: f64,
}

/// Why a menu closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuPanelCloseReason {
    /// An item was chosen.
    Chosen,
    /// Escape, or the chord that opened it.
    Escape,
    /// A press outside it, here, in another window, in another app, the
    /// app's menu bar, another desktop, or the app left.
    Outside,
    /// The tab closed it, another menu took the panel, or the panel went.
    Source,
    /// The panel's page drew nothing in time: the tab opens it on the page.
    Unresponsive,
    /// The panel could not draw it: the tab opens it on the page.
    Failed,
}

impl MenuPanelCloseReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Chosen => "chosen",
            Self::Escape => "escape",
            Self::Outside => "outside",
            Self::Source => "source",
            Self::Unresponsive => "unresponsive",
            Self::Failed => "failed",
        }
    }
}

/// What the page a menu came from hears of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuPanelToSource {
    /// A choice made in the panel; the page answers one that needs an
    /// answer by `request` (МО25).
    Action { request: u32, action: MenuAction },
    /// The menu closed: the last message of the menu (МО38). `key_returned`
    /// says the backend gave the keyboard back to the page's window, so the
    /// window's next focus is no return to the app (МО47, МО48).
    Closed { reason: MenuPanelCloseReason, key_returned: bool },
}

/// One message to the page a menu came from: `seq` counts them from one for
/// each menu, and the page takes them in that order (МО36).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct MenuPanelSourceMessage {
    pub menu: u32,
    pub seq: u32,
    pub body: MenuPanelToSource,
}

/// What the panel's page hears of a menu.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuPanelToPage {
    /// Draw the menu: the panel already stands at its place, in the frame
    /// the layout names.
    Open {
        layout: MenuPanelLayout,
        /// The menu's size the page gave, for the panel's own measure.
        size: MenuPanelSize,
        spec: MenuSpec,
        by_key: bool,
        buttons: Option<String>,
    },
    /// What changed in the menu while it is open: the whole of it again.
    Update { spec: MenuSpec },
    /// The page's answer to the panel's request `request`.
    Answer { request: u32, answer: MenuAnswer },
    /// The menu closed: the last message of the menu.
    Closed { reason: MenuPanelCloseReason },
}

/// One message to the panel's page: the menu by the page it came from and
/// its number there, `seq` from one for each menu.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct MenuPanelPageMessage {
    pub source: String,
    pub menu: u32,
    pub seq: u32,
    pub body: MenuPanelToPage,
}

/// What the panel's page asks of the menu it draws: a choice for the tab to
/// carry out, its own closing, or both at once, the choice first (МО24).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MenuPanelPageRequest {
    pub source: String,
    pub menu: u32,
    /// The page's count of its requests for this menu, from one: they are
    /// carried out in this order (МО36).
    pub request: u32,
    /// A choice made in the menu.
    pub action: Option<MenuAction>,
    /// The menu closes after the choice, or with none: an item was chosen,
    /// Escape, a press on the panel's clear part.
    pub close: Option<MenuPanelCloseReason>,
}

/// The panel's page drew the menu: when each of its steps came, epoch
/// milliseconds, and the menu as it measured it.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MenuPanelPaint {
    pub source: String,
    pub menu: u32,
    /// The page heard the opening.
    pub received_at: f64,
    /// The page's area had the frame's size: at once, or after the change
    /// of size it waited for (МО30).
    pub sized_at: f64,
    /// React drew the menu into the page.
    pub drawn_at: f64,
    /// The first frame with the menu (`requestAnimationFrame`).
    pub frame_at: f64,
    /// The menu as the page laid it out.
    pub measured: MenuPanelSize,
}

/// How far the panel's page got with the menu it was told to draw: the
/// steps before its first frame (SPEC_MENU_WINDOW.md, МО40а). The first
/// frame itself is the paint report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuPanelStep {
    /// The page heard the opening.
    Received,
    /// The page's area changed while it waited for the frame's size, to
    /// another size.
    Resized,
    /// The page's area took the frame's size it waited for (МО30).
    Sized,
    /// React drew the menu into the page, and the page asked for its first
    /// frame.
    FrameRequested,
}

impl MenuPanelStep {
    fn as_str(self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Resized => "resized",
            Self::Sized => "sized",
            Self::FrameRequested => "frame_requested",
        }
    }
}

/// A step of the panel's page with a menu, and the page as it was then.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MenuPanelProgress {
    pub source: String,
    pub menu: u32,
    pub step: MenuPanelStep,
    /// The page's area then (`innerWidth`, `innerHeight`).
    pub area: MenuPanelSize,
    /// The page counted itself seen then (`document.visibilityState`):
    /// WebKit gives a page it counts hidden no frames.
    pub visible: bool,
}

/// The last step the panel's page told of a menu.
#[derive(Debug, Clone, Copy, PartialEq)]
struct PageProgress {
    step: MenuPanelStep,
    area: MenuPanelSize,
    visible: bool,
}

/// Where the panel's page stopped with a menu that drew nothing in time,
/// for the log (МО40а): the last step it told, against the frame the
/// backend set.
fn stall_text(progress: Option<PageProgress>, frame: MenuPanelSize) -> String {
    let frame_text = format!("frame={}x{}", frame.width, frame.height);
    let Some(progress) = progress else {
        return format!("the page told no step: it never heard the opening, {frame_text}");
    };
    let area_is_frame = (progress.area.width - frame.width).abs() < 1.0 && (progress.area.height - frame.height).abs() < 1.0;
    let why = match progress.step {
        MenuPanelStep::Received | MenuPanelStep::Resized if !area_is_frame => {
            "the page waits for its area to take the frame's size"
        }
        MenuPanelStep::Received | MenuPanelStep::Resized | MenuPanelStep::Sized => {
            "the page's area is the frame's and the page drew nothing"
        }
        MenuPanelStep::FrameRequested => "the page drew the menu and no frame came",
    };
    format!(
        "{why}: last step={} area={}x{} {frame_text} page_visible={}",
        progress.step.as_str(),
        progress.area.width,
        progress.area.height,
        progress.visible,
    )
}

/// What a tab's closing of its menu came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, specta::Type)]
pub struct MenuPanelCloseOutcome {
    /// The menu was open and closed now; false when it had closed already or
    /// never opened.
    pub closed: bool,
    /// The backend gave the keyboard back to the tab's window (МО47).
    pub key_returned: bool,
}

/// Why a menu does not open in the panel: the tab then opens it on its page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuPanelRefusal {
    #[error("the menu panel is not ready or was not found clear")]
    NotReady,
    #[error("Mine is not the active app")]
    AppInactive,
    #[error("the caller is the menu panel's own page")]
    NotASource,
    #[error("the page's place on the screen is not known")]
    NoGeometry,
    #[error("the description is no menu, or its size is no size")]
    BadMenu,
    #[error("called off the main thread")]
    NotMainThread,
    #[error("the panel is not seen on the active desktop or did not become the key window")]
    ShowFailed,
    #[error("the page has opened or closed a later menu")]
    Superseded,
}

// ── The book of the open menu: no Tauri, no AppKit ────────────────────────

/// The messages of one row taken in the order of their numbers, from one
/// (МО36): a number already taken is dropped, a number ahead waits for the
/// ones before it. No time ends the wait: the missing message does, or the
/// menu's closing, which drops the row.
#[derive(Debug, Clone, PartialEq)]
struct Inbox<T> {
    next: u32,
    held: BTreeMap<u32, T>,
}

impl<T> Inbox<T> {
    fn new() -> Self {
        Self { next: 1, held: BTreeMap::new() }
    }

    /// Take the message `number`: every message now due, in order.
    fn take(&mut self, number: u32, item: T) -> Vec<T> {
        if number < self.next {
            return Vec::new();
        }
        self.held.entry(number).or_insert(item);
        let mut due = Vec::new();
        while let Some(item) = self.held.remove(&self.next) {
            due.push(item);
            self.next += 1;
        }
        due
    }
}

/// One request of the panel's page, once its turn has come.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PageStep {
    request: u32,
    action: Option<MenuAction>,
    close: Option<MenuPanelCloseReason>,
}

/// How a menu was shown, for the log.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct Shown {
    placement: Placement,
    /// The panel's frame for this menu (МО29).
    frame: MenuPanelSize,
    frame_changed: bool,
}

/// Where a menu was put: for the log of the three cases (МО59).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Placement {
    /// The screen's place among `NSScreen.screens`; the main one is 0.
    pub screen: usize,
    /// The window the menu came from is in full screen.
    pub fullscreen: bool,
    /// It is in full screen and narrower than its screen: Split View.
    pub split: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct OpenMenu {
    source: String,
    menu: u32,
    window: String,
    event_at: Option<f64>,
    sent_at: f64,
    opened_at: f64,
    shown_at: f64,
    expected: MenuPanelSize,
    placement: Placement,
    /// The panel's frame changed its size for this menu, and how long the
    /// backend's layout, the frame and the keyboard took in all is
    /// `shown_at - opened_at`.
    frame_changed: bool,
    /// The panel's frame for this menu.
    frame: MenuPanelSize,
    /// The last step the panel's page told of this menu (МО40а).
    progress: Option<PageProgress>,
    painted: bool,
    /// The last number sent to the page the menu came from, and to the
    /// panel's page.
    to_source: u32,
    to_page: u32,
    /// The panel's page's requests, in the order of its count.
    from_page: Inbox<PageStep>,
    /// The number of the last change of the tab's that went to the panel.
    update: u32,
}

impl OpenMenu {
    fn is(&self, source: &str, menu: u32) -> bool {
        self.source == source && self.menu == menu
    }
}

/// A page that opens menus: its load, and the highest number it has named.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SourcePage {
    page: String,
    seen: u32,
}

/// Where the panel's check of its own clearness stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Clearness {
    #[default]
    Unknown,
    Clear,
    NotClear,
}

#[derive(Debug, Default)]
struct PanelBook {
    page_ready: bool,
    clearness: Clearness,
    open: Option<OpenMenu>,
    sources: HashMap<String, SourcePage>,
    /// The window the panel gave the keyboard back to: its next focus is no
    /// return to the app (МО47).
    handed_back: Option<String>,
    /// The window a menu came from that closed while the app was away: it
    /// takes the keyboard when the app comes back and nothing else has it.
    key_owed: Option<String>,
    /// The last menu shown, for its paint report after it closed.
    last_shown: Option<OpenMenu>,
}

impl PanelBook {
    /// A menu may open: the page listens and the panel was found clear.
    fn ready(&self) -> bool {
        self.page_ready && self.clearness == Clearness::Clear
    }

    /// The page `source` is of the load `page`: a page loaded anew counts
    /// its menus from one again. Whether it is a new load.
    fn source_loaded(&mut self, source: &str, page: &str) -> bool {
        match self.sources.get_mut(source) {
            Some(known) if known.page == page => false,
            Some(known) => {
                *known = SourcePage { page: page.to_string(), seen: 0 };
                true
            }
            None => {
                self.sources.insert(source.to_string(), SourcePage { page: page.to_string(), seen: 0 });
                true
            }
        }
    }

    /// The page names the menu `menu` in an opening: refused when it has
    /// named this or a later one before, in an opening or a closing (МО37).
    fn admit(&mut self, source: &str, page: &str, menu: u32) -> Result<(), MenuPanelRefusal> {
        self.source_loaded(source, page);
        let known = self.sources.get_mut(source).ok_or(MenuPanelRefusal::NotReady)?;
        if menu <= known.seen {
            return Err(MenuPanelRefusal::Superseded);
        }
        known.seen = menu;
        Ok(())
    }

    /// The page names the menu `menu` in a closing: an opening of it that
    /// comes later is refused (МО37).
    fn closing_named(&mut self, source: &str, page: &str, menu: u32) {
        self.source_loaded(source, page);
        if let Some(known) = self.sources.get_mut(source) {
            known.seen = known.seen.max(menu);
        }
    }

    /// The menu `request` names is shown now in `window`; the one it
    /// replaces, if any. A new opening forgets a keyboard given back.
    fn begin(&mut self, source: &str, window: &str, request: &MenuPanelOpenRequest, shown: Shown, opened_at: f64, shown_at: f64) -> Option<OpenMenu> {
        let replaced = self.open.take();
        self.handed_back = None;
        self.key_owed = None;
        let menu = OpenMenu {
            source: source.to_string(),
            menu: request.menu,
            window: window.to_string(),
            event_at: request.event_at,
            sent_at: request.sent_at,
            opened_at,
            shown_at,
            expected: request.size,
            placement: shown.placement,
            frame_changed: shown.frame_changed,
            frame: shown.frame,
            progress: None,
            painted: false,
            to_source: 0,
            to_page: 0,
            from_page: Inbox::new(),
            update: 0,
        };
        self.last_shown = Some(menu.clone());
        self.open = Some(menu);
        replaced
    }

    fn open_menu(&mut self, source: &str, menu: u32) -> Option<&mut OpenMenu> {
        self.open.as_mut().filter(|open| open.is(source, menu))
    }

    /// The next number of a message to the page the open menu came from.
    fn next_to_source(&mut self, source: &str, menu: u32) -> Option<u32> {
        let open = self.open_menu(source, menu)?;
        open.to_source += 1;
        Some(open.to_source)
    }

    /// The next number of a message to the panel's page.
    fn next_to_page(&mut self, source: &str, menu: u32) -> Option<u32> {
        let open = self.open_menu(source, menu)?;
        open.to_page += 1;
        Some(open.to_page)
    }

    /// A request of the panel's page for the open menu: the requests whose
    /// turn has come, in order. None for a menu that is not open.
    fn page_request(&mut self, request: &MenuPanelPageRequest) -> Vec<PageStep> {
        let Some(open) = self.open_menu(&request.source, request.menu) else { return Vec::new() };
        let step = PageStep { request: request.request, action: request.action.clone(), close: request.close };
        open.from_page.take(request.request, step)
    }

    /// The tab's change number `number` of its open menu goes to the panel:
    /// only a later one than the last, the whole menu each time (МО26).
    fn takes_update(&mut self, source: &str, menu: u32, number: u32) -> bool {
        let Some(open) = self.open_menu(source, menu) else { return false };
        if number <= open.update {
            return false;
        }
        open.update = number;
        true
    }

    /// The page drew the menu: its timings, if it is the last shown.
    fn painted(&mut self, source: &str, menu: u32) -> Option<OpenMenu> {
        if let Some(open) = self.open_menu(source, menu) {
            open.painted = true;
        }
        self.last_shown.as_ref().filter(|shown| shown.is(source, menu)).cloned()
    }

    /// The page told a step of the open menu `source`, `menu`; a step of
    /// a menu that is not open is dropped.
    fn progressed(&mut self, progress: &MenuPanelProgress) {
        if let Some(open) = self.open_menu(&progress.source, progress.menu) {
            open.progress = Some(PageProgress { step: progress.step, area: progress.area, visible: progress.visible });
        }
    }

    /// Whether the menu is open and its page has drawn nothing yet: then
    /// where its page stopped (МО40а).
    fn unpainted(&self, source: &str, menu: u32) -> Option<String> {
        self.open
            .as_ref()
            .filter(|open| open.is(source, menu) && !open.painted)
            .map(|open| stall_text(open.progress, open.frame))
    }

    /// Take the menu `which` out, or the open one with `None`.
    fn finish(&mut self, which: Option<(&str, u32)>) -> Option<OpenMenu> {
        if which.is_some_and(|(source, menu)| self.open.as_ref().is_none_or(|open| !open.is(source, menu))) {
            return None;
        }
        self.open.take()
    }

    /// The panel gave the keyboard back to `window` (МО47).
    fn hand_back(&mut self, window: &str) {
        self.handed_back = Some(window.to_string());
    }

    /// Whether `window` coming into focus now is it taking the keyboard back
    /// from the panel. Asked once: a later focus is the person's.
    fn focus_returns(&mut self, window: &str) -> bool {
        if self.handed_back.as_deref() == Some(window) {
            self.handed_back = None;
            return true;
        }
        false
    }

    /// The page started anew: it has drawn nothing and is checked again.
    /// Whatever was open is gone with the page it was drawn in.
    fn page_started(&mut self) -> Option<OpenMenu> {
        self.page_ready = true;
        self.clearness = Clearness::Unknown;
        self.open.take()
    }

    /// The panel went: no page, nothing open.
    fn gone(&mut self) -> Option<OpenMenu> {
        self.page_ready = false;
        self.clearness = Clearness::Unknown;
        self.open.take()
    }
}

/// The time an opening spent in each of its steps, milliseconds.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Steps {
    /// From the input to the tab's request: the tab's own work. None when
    /// the tab had no input's event at hand.
    tab: Option<f64>,
    /// From the request to the backend.
    to_backend: f64,
    /// The backend's layout, the panel's move and the keyboard.
    backend: f64,
    /// From the backend's word to the panel's page.
    to_panel: f64,
    /// The page waiting for its area to take the frame's size (МО30).
    frame_wait: f64,
    /// React drawing the menu in the panel's page.
    render: f64,
    /// From the drawn page to its first frame.
    to_frame: f64,
    /// From the input to the first frame; from the request without an input.
    total: f64,
}

fn steps(menu: &OpenMenu, paint: &MenuPanelPaint) -> Steps {
    Steps {
        tab: menu.event_at.map(|event_at| menu.sent_at - event_at),
        to_backend: menu.opened_at - menu.sent_at,
        backend: menu.shown_at - menu.opened_at,
        to_panel: paint.received_at - menu.shown_at,
        frame_wait: paint.sized_at - paint.received_at,
        render: paint.drawn_at - paint.sized_at,
        to_frame: paint.frame_at - paint.drawn_at,
        total: paint.frame_at - menu.event_at.unwrap_or(menu.sent_at),
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

// ── The window ────────────────────────────────────────────────────────────

/// The app's menu panel state.
#[derive(Default)]
pub struct MenuPanel {
    book: Mutex<PanelBook>,
}

impl MenuPanel {
    fn book(&self) -> MutexGuard<'_, PanelBook> {
        self.book.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn panel_state(app: &AppHandle) -> Option<tauri::State<'_, MenuPanel>> {
    app.try_state::<MenuPanel>()
}

fn status(app: &AppHandle) -> MenuPanelStatus {
    MenuPanelStatus {
        ready: panel_state(app).is_some_and(|state| state.book().ready()),
    }
}

fn announce_status(app: &AppHandle) {
    if let Err(error) = app.emit(STATUS_EVENT, status(app)) {
        log::warn!("cannot announce the menu panel's state: {error}");
    }
}

fn tell_source(app: &AppHandle, source: &str, menu: u32, seq: u32, body: MenuPanelToSource) {
    emit_to_labels(app, [source], TO_SOURCE_EVENT, MenuPanelSourceMessage { menu, seq, body });
}

fn tell_page(app: &AppHandle, source: &str, menu: u32, seq: u32, body: MenuPanelToPage) {
    emit_to_labels(
        app,
        [PANEL_LABEL],
        TO_PAGE_EVENT,
        MenuPanelPageMessage { source: source.to_string(), menu, seq, body },
    );
}

/// Both pages hear that `closed`, taken out of the book, is closed: the
/// last message of each row.
fn tell_closed(app: &AppHandle, closed: &OpenMenu, reason: MenuPanelCloseReason, key_returned: bool) {
    tell_source(
        app,
        &closed.source,
        closed.menu,
        closed.to_source + 1,
        MenuPanelToSource::Closed { reason, key_returned },
    );
    tell_page(app, &closed.source, closed.menu, closed.to_page + 1, MenuPanelToPage::Closed { reason });
}

/// Make the panel unless it exists: unseen, clear, passing every click.
/// `page` is the load of the page that asks: a page loaded anew has no menu
/// open, so one its former load left closes. Whether the panel is ready.
pub fn prepare(app: &AppHandle, caller: &Webview, page: &str) -> MenuPanelStatus {
    let source = caller.label().to_string();
    if let Some(state) = panel_state(app) {
        let orphan = {
            let mut book = state.book();
            let anew = book.source_loaded(&source, page);
            book.open.as_ref().filter(|open| anew && open.source == source).map(|open| open.menu)
        };
        if let Some(menu) = orphan {
            close(app, Some((&source, menu)), MenuPanelCloseReason::Source);
        }
    }
    if app.get_webview_window(PANEL_LABEL).is_some() {
        return status(app);
    }
    let built = WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App(PANEL_PAGE.into()))
        .title("")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .focused(false)
        // The shell: it makes the page and never comes to the screen, nor
        // takes the keyboard or the main window's place. The panel's own
        // window stands where the shell does and takes its page (МО62).
        .visible(false)
        .focusable(false)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .inner_size(REST_WIDTH_PX, REST_HEIGHT_PX)
        .position(0.0, 0.0)
        // The page keeps running though it is never the visible window's
        // content.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            log::warn!("menu panel not made: {error}");
            return status(app);
        }
    };
    // A panel that could not be set up is no panel: one that may become the
    // main window, or with no watch over the presses outside it, would not
    // keep the rules of a menu (МО43, МО46). The menus stay on the page.
    let watch = app.clone();
    let wake = app.clone();
    let lost = app.clone();
    let set_up = native::configure(&window).and_then(|()| {
        native::watch(
            move || {
                close(&watch, None, MenuPanelCloseReason::Outside);
            },
            move || app_came_back(&wake),
            move || panel_lost_key(&lost),
        )
    });
    if let Err(why) = set_up {
        log::warn!("menu panel not set up, menus open on the page: {why}");
        native::forget_panel();
        if let Err(error) = window.destroy() {
            log::warn!("menu panel not taken away: {error}");
        }
        return status(app);
    }
    let handle = app.clone();
    window.on_window_event(move |event| on_panel_event(&handle, event));
    log::info!("menu panel made, unseen until it is found clear");
    status(app)
}

/// The Web mode: the panel goes at once; Window makes it again.
pub fn dispose(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else { return };
    close(app, None, MenuPanelCloseReason::Source);
    native::rest();
    if let Err(error) = window.destroy() {
        log::warn!("menu panel not taken away: {error}");
        return;
    }
    log::info!("menu panel taken away: the menus are on the page");
}

/// The panel's window lost the keyboard by a way the watch does not see
/// (МО44). The word of it waits in a queue: by the time it is heard a later
/// menu may hold the keyboard, and then it is not that menu's.
fn panel_lost_key(app: &AppHandle) {
    if !native::is_key() {
        close(app, None, MenuPanelCloseReason::Outside);
    }
}

/// What Tauri says of the panel's shell.
fn on_panel_event(app: &AppHandle, event: &WindowEvent) {
    match event {
        // Whatever asks the shell to close closes the menu, never the
        // panel.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            close(app, None, MenuPanelCloseReason::Escape);
        }
        WindowEvent::Destroyed => {
            native::forget_panel();
            if let Some(state) = panel_state(app) {
                let gone = state.book().gone();
                if let Some(menu) = gone {
                    tell_closed(app, &menu, MenuPanelCloseReason::Source, false);
                }
            }
            announce_status(app);
        }
        _ => {}
    }
}

/// The panel's page listens and has drawn its rest: the panel is checked
/// for clearness, and shown to no one unless it passes.
pub fn page_ready(app: &AppHandle, caller: &Webview) {
    if caller.label() != PANEL_LABEL {
        return;
    }
    let Some(state) = panel_state(app) else { return };
    let gone = state.book().page_started();
    let Some(window) = app.get_webview_window(PANEL_LABEL) else { return };
    // The page started anew with a menu up: the menu went with it (МО39).
    match gone {
        Some(menu) => {
            settle(app, &menu, MenuPanelCloseReason::Failed);
        }
        None => native::rest(),
    }
    announce_status(app);
    let handle = app.clone();
    native::check_transparency(&window, move |found| {
        let Some(state) = panel_state(&handle) else { return };
        let clear = found.clear();
        state.book().clearness = if clear { Clearness::Clear } else { Clearness::NotClear };
        if clear {
            native::reveal();
            log::info!("menu panel found clear: {}", found.describe());
        } else {
            log::warn!("menu panel not clear, never shown, menus open on the page: {}", found.describe());
        }
        announce_status(&handle);
    });
}

/// Open a menu of the page `caller` in the panel: laid out, moved to its
/// place and given the keyboard at once; the panel's page draws it when it
/// hears. Any page of the app may ask but the panel's own (МО22).
pub fn open(app: &AppHandle, caller: &Webview, request: MenuPanelOpenRequest) -> Result<(), MenuPanelRefusal> {
    let opened_at = now_ms();
    if !native::on_main_thread() {
        return Err(MenuPanelRefusal::NotMainThread);
    }
    let source = caller.label().to_string();
    let window = caller.window().label().to_string();
    if source == PANEL_LABEL {
        return Err(MenuPanelRefusal::NotASource);
    }
    let state = panel_state(app).ok_or(MenuPanelRefusal::NotReady)?;
    // The number first: an opening the page has since closed or overtaken
    // is refused whatever else stands (МО37).
    state.book().admit(&source, &request.page, request.menu)?;
    if app.get_webview_window(PANEL_LABEL).is_none() || !state.book().ready() {
        return Err(MenuPanelRefusal::NotReady);
    }
    // The panel's page draws only what is a menu (МО17).
    if let Err(why) = request.spec.validate() {
        log::warn!("menu panel: menu {} of {source} is no menu: {why}", request.menu);
        return Err(MenuPanelRefusal::BadMenu);
    }
    if !geometry::sizes_are_sizes(request.size, &request.submenus) {
        log::warn!("menu panel: menu {} of {source} has no size", request.menu);
        return Err(MenuPanelRefusal::BadMenu);
    }
    // A right click in a window of an app in the background: the panel
    // could not take the keyboard without bringing Mine forward (МО61).
    if !native::app_is_active() {
        return Err(MenuPanelRefusal::AppInactive);
    }
    let placed = native::anchor_on_screen(caller, request.anchor).ok_or(MenuPanelRefusal::NoGeometry)?;
    let layout = geometry::layout(request.opener, placed.anchor, request.size, &request.submenus, placed.bound);
    let shown = native::show(layout.origin, layout.frame);
    if !shown.on_top() {
        log::warn!(
            "menu panel: menu {} of {source} not shown ({}), screen={} fullscreen={} split={}",
            request.menu,
            shown.describe(),
            placed.placement.screen,
            placed.placement.fullscreen,
            placed.placement.split,
        );
        // The panel was moved for nothing: a menu still up in it goes, and
        // the keyboard goes back to the window that asked.
        if close(app, None, MenuPanelCloseReason::Source) == MenuPanelCloseOutcome::default() {
            native::rest();
            if shown.key {
                if let Some(asking) = app.get_window(&window) {
                    if native::make_key(&asking) {
                        state.book().hand_back(&window);
                    }
                }
            }
        }
        return Err(MenuPanelRefusal::ShowFailed);
    }
    let shown_at = now_ms();
    let how = Shown { placement: placed.placement, frame: layout.frame, frame_changed: shown.frame_changed };
    let replaced = state.book().begin(&source, &window, &request, how, opened_at, shown_at);
    if let Some(replaced) = replaced {
        // The panel stays up for the new menu: the old one only hears.
        log::info!("card menu panel: menu {} of {} closed (source), replaced", replaced.menu, replaced.source);
        tell_closed(app, &replaced, MenuPanelCloseReason::Source, false);
    }
    log::info!(
        "card menu panel: menu {} of {source} shown ({}), screen={} fullscreen={} split={}",
        request.menu,
        shown.describe(),
        placed.placement.screen,
        placed.placement.fullscreen,
        placed.placement.split,
    );
    if let Some(seq) = state.book().next_to_page(&source, request.menu) {
        tell_page(
            app,
            &source,
            request.menu,
            seq,
            MenuPanelToPage::Open {
                layout,
                size: request.size,
                spec: request.spec,
                by_key: request.by_key,
                buttons: request.buttons,
            },
        );
    }
    watch_paint(app, source, request.menu);
    Ok(())
}

/// A shown panel whose page draws nothing in time gives the clicks back.
fn watch_paint(app: &AppHandle, source: String, menu: u32) {
    let handle = app.clone();
    let started = std::thread::Builder::new().name("menu-panel-paint".into()).spawn(move || {
        std::thread::sleep(PAINT_DEADLINE);
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let stalled = panel_state(&inner).and_then(|state| state.book().unpainted(&source, menu));
            if let Some(stalled) = stalled {
                log::warn!(
                    "card menu panel: menu {menu} of {source} drew nothing within {} ms, opened on the page; {stalled}",
                    PAINT_DEADLINE.as_millis()
                );
                close(&inner, Some((&source, menu)), MenuPanelCloseReason::Unresponsive);
            }
        });
    });
    if let Err(error) = started {
        log::warn!("menu panel: no watch over the menu's first frame: {error}");
    }
}

/// A step of the panel's page with the menu it draws, kept for the log of
/// a menu that draws nothing in time (МО40а).
pub fn progress(app: &AppHandle, caller: &Webview, progress: &MenuPanelProgress) {
    if caller.label() != PANEL_LABEL {
        return;
    }
    if let Some(state) = panel_state(app) {
        state.book().progressed(progress);
    }
}

/// The page's change number `number` of its open menu: the whole menu again,
/// passed on to the panel when it is later than the last (МО26).
pub fn update(app: &AppHandle, caller: &Webview, menu: u32, number: u32, spec: MenuSpec) {
    let Some(state) = panel_state(app) else { return };
    let source = caller.label();
    if let Err(why) = spec.validate() {
        log::warn!("menu panel: a change of menu {menu} of {source} is no menu, dropped: {why}");
        return;
    }
    let seq = {
        let mut book = state.book();
        if !book.takes_update(source, menu, number) {
            return;
        }
        book.next_to_page(source, menu)
    };
    if let Some(seq) = seq {
        tell_page(app, source, menu, seq, MenuPanelToPage::Update { spec });
    }
}

/// The tab's answer to the panel's request `request` of its open menu.
pub fn answer(app: &AppHandle, caller: &Webview, menu: u32, request: u32, answer: MenuAnswer) {
    let Some(state) = panel_state(app) else { return };
    let source = caller.label();
    let seq = state.book().next_to_page(source, menu);
    if let Some(seq) = seq {
        tell_page(app, source, menu, seq, MenuPanelToPage::Answer { request, answer });
    }
}

/// What the panel's page asks of the menu it draws: carried out in the
/// order of the page's count (МО36), a choice before the closing it brings
/// (МО24). A closing ends the row: what the page counted after it is dropped.
pub fn page_request(app: &AppHandle, caller: &Webview, request: &MenuPanelPageRequest) {
    if caller.label() != PANEL_LABEL {
        return;
    }
    let Some(state) = panel_state(app) else { return };
    let due = state.book().page_request(request);
    for step in due {
        if let Some(action) = step.action {
            let seq = state.book().next_to_source(&request.source, request.menu);
            if let Some(seq) = seq {
                tell_source(
                    app,
                    &request.source,
                    request.menu,
                    seq,
                    MenuPanelToSource::Action { request: step.request, action },
                );
            }
        }
        if let Some(reason) = step.close {
            close(app, Some((&request.source, request.menu)), reason);
            return;
        }
    }
}

/// The tab `caller` closes its menu `menu`; a closing that comes before its
/// opening cancels it (МО37).
pub fn close_from_source(app: &AppHandle, caller: &Webview, page: &str, menu: u32, reason: MenuPanelCloseReason) -> MenuPanelCloseOutcome {
    let Some(state) = panel_state(app) else { return MenuPanelCloseOutcome::default() };
    let source = caller.label();
    state.book().closing_named(source, page, menu);
    close(app, Some((source, menu)), reason)
}

/// Close the menu `which`, a page and its number, or whichever is open with
/// `None`: the panel passes clicks again, the window the menu came from
/// takes the keyboard back when the panel held it, and both pages hear why.
pub fn close(app: &AppHandle, which: Option<(&str, u32)>, reason: MenuPanelCloseReason) -> MenuPanelCloseOutcome {
    let Some(state) = panel_state(app) else { return MenuPanelCloseOutcome::default() };
    let Some(closed) = state.book().finish(which) else { return MenuPanelCloseOutcome::default() };
    settle(app, &closed, reason)
}

/// `closed` is out of the book: the panel rests, the keyboard goes back,
/// both pages hear.
fn settle(app: &AppHandle, closed: &OpenMenu, reason: MenuPanelCloseReason) -> MenuPanelCloseOutcome {
    let panel_was_key = native::is_key();
    // At rest the panel passes clicks and cannot take the keyboard: when
    // the app comes back, the window the menu came from has it (МО46).
    native::rest();
    let app_active = native::app_is_active();
    let mut key_returned = false;
    if panel_was_key && app_active {
        match app.get_window(&closed.window) {
            Some(window) => key_returned = native::make_key(&window),
            // The window is gone: the panel must not keep the keyboard.
            None => native::give_up_key(),
        }
    }
    if let Some(state) = panel_state(app) {
        let mut book = state.book();
        if key_returned {
            // The window's focus that follows is no return to the app (МО47).
            book.hand_back(&closed.window);
        } else if !app_active {
            // The app is away: nothing is given back now, and the focus the
            // window gets when the app comes back is a return.
            book.key_owed = Some(closed.window.clone());
        }
    }
    log::info!(
        "card menu panel: menu {} of {} closed ({}), key_returned={key_returned}",
        closed.menu,
        closed.source,
        reason.as_str()
    );
    tell_closed(app, closed, reason, key_returned);
    MenuPanelCloseOutcome { closed: true, key_returned }
}

/// The app came back. A menu that closed while it was away left the
/// keyboard with no window: the window the menu came from takes it, unless
/// the app gave it to another window already.
fn app_came_back(app: &AppHandle) {
    let Some(state) = panel_state(app) else { return };
    let owed = {
        let mut book = state.book();
        if book.open.is_some() {
            return;
        }
        book.key_owed.take()
    };
    let Some(owed) = owed else { return };
    if !native::keyboard_is_unheld() {
        return;
    }
    if let Some(window) = app.get_window(&owed) {
        native::make_key(&window);
    }
}

/// A command of the app's menu bar came while a menu is up: it only closes
/// the menu and is not carried out, as a system menu takes the keys that
/// come while it is open (МО52). Whether a menu was up.
pub fn closes_for_command(app: &AppHandle) -> bool {
    close(app, None, MenuPanelCloseReason::Escape).closed
}

/// One line of the measurement per opening (SPEC_MENU_WINDOW.md, МО72):
/// each step's time, and whether the window under the menu kept its active
/// look, as AppKit's public answers give it.
pub fn painted(app: &AppHandle, paint: &MenuPanelPaint) {
    let Some(state) = panel_state(app) else { return };
    let Some(menu) = state.book().painted(&paint.source, paint.menu) else { return };
    let look = app.get_window(&menu.window).map(|window| native::look(&window));
    let still_open = state.book().open.as_ref().is_some_and(|open| open.is(&paint.source, paint.menu));
    let time = steps(&menu, paint);
    // The page counts the largest size the menu gets while open (МО28): a
    // menu drawn larger than counted would be cut by the frame.
    let size_matches = (paint.measured.width - menu.expected.width).abs() < 0.5
        && paint.measured.height < menu.expected.height + 0.5;
    let look_text = look.map_or_else(
        || "main_window_active_look=unknown".to_string(),
        |look| {
            format!(
                "main_window_active_look={} main={} key={} panel_key={} app_active={}",
                look.active_look(),
                look.main,
                look.key,
                look.panel_key,
                look.app_active,
            )
        },
    );
    // Without an input's event the measure starts at the tab's request.
    let (from, tab_text) = match time.tab {
        Some(tab) => ("event", format!("{tab:.1}")),
        None => ("request", "unknown".to_string()),
    };
    log::info!(
        "card menu panel opened: menu={} source={} {from}_to_frame_ms={:.1} tab_ms={tab_text} to_backend_ms={:.1} backend_ms={:.1} to_panel_ms={:.1} frame_wait_ms={:.1} render_ms={:.1} to_frame_ms={:.1} frame_changed={} size={}x{} measured={}x{} size_matches={size_matches} screen={} fullscreen={} split={} {look_text} open={still_open}",
        paint.menu,
        paint.source,
        time.total,
        time.to_backend,
        time.backend,
        time.to_panel,
        time.frame_wait,
        time.render,
        time.to_frame,
        menu.frame_changed,
        menu.expected.width,
        menu.expected.height,
        paint.measured.width,
        paint.measured.height,
        menu.placement.screen,
        menu.placement.fullscreen,
        menu.placement.split,
    );
}

/// Whether the tab window `window` coming into focus is it taking the
/// keyboard back from the panel, a menu of its having just closed: then it
/// is no return to the app, and the reactions to one (В42, the last window)
/// do not run. Told by the mark the closing left, not by the clock (МО47).
pub fn focus_returns_from_panel(app: &AppHandle, window: &WindowId) -> bool {
    panel_state(app).is_some_and(|state| state.book().focus_returns(&window.label()))
}

/// What AppKit says of the window a menu came from while the menu is up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowLook {
    main: bool,
    key: bool,
    panel_key: bool,
    app_active: bool,
}

impl WindowLook {
    /// The title bar and the traffic lights look active: the window is the
    /// main one of the active app.
    fn active_look(self) -> bool {
        self.app_active && self.main
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use geometry::ScreenRect;

    fn request(menu: u32) -> MenuPanelOpenRequest {
        MenuPanelOpenRequest {
            page: "load-1".to_string(),
            menu,
            anchor: ScreenRect { x: 0.0, y: 0.0, width: 24.0, height: 24.0 },
            opener: MenuOpener::Plate,
            spec: MenuSpec { role: spec::MenuWidthRole::Action, entries: Vec::new() },
            by_key: false,
            buttons: None,
            size: MenuPanelSize { width: 240.0, height: 325.0 },
            submenus: Vec::new(),
            event_at: Some(1.0),
            sent_at: 2.0,
        }
    }

    fn run(id: &str) -> MenuAction {
        MenuAction::Run { id: id.to_string() }
    }

    fn ready_book() -> PanelBook {
        let mut book = PanelBook::default();
        book.page_started();
        book.clearness = Clearness::Clear;
        book
    }

    fn begin(book: &mut PanelBook, source: &str, window: &str, menu: u32) -> Option<OpenMenu> {
        book.begin(source, window, &request(menu), Shown::default(), 3.0, 4.0)
    }

    fn page_request(menu: u32, number: u32, action: Option<&str>, close: Option<MenuPanelCloseReason>) -> MenuPanelPageRequest {
        MenuPanelPageRequest {
            source: "tab-a".to_string(),
            menu,
            request: number,
            action: action.map(run),
            close,
        }
    }

    #[test]
    fn a_menu_opens_only_in_a_panel_found_clear() {
        let mut book = PanelBook::default();
        assert!(!book.ready());
        book.page_started();
        // The page listens, the check has not answered: not yet.
        assert!(!book.ready());
        book.clearness = Clearness::NotClear;
        assert!(!book.ready());
        book.clearness = Clearness::Clear;
        assert!(book.ready());
    }

    #[test]
    fn a_page_that_starts_again_is_checked_again_and_takes_its_menu_with_it() {
        let mut book = ready_book();
        begin(&mut book, "tab-a", "window-a", 1);
        assert_eq!(book.page_started().map(|menu| menu.menu), Some(1));
        assert!(!book.ready());
        assert!(book.gone().is_none());
        assert!(!book.ready());
    }

    #[test]
    fn the_messages_of_a_row_are_taken_in_the_order_of_their_numbers() {
        let mut inbox = Inbox::new();
        // The second came first: it waits for the first.
        assert_eq!(inbox.take(2, "b"), Vec::<&str>::new());
        assert_eq!(inbox.take(1, "a"), vec!["a", "b"]);
        // One already taken is dropped, and so is its second copy ahead.
        assert_eq!(inbox.take(1, "again"), Vec::<&str>::new());
        assert_eq!(inbox.take(4, "d"), Vec::<&str>::new());
        assert_eq!(inbox.take(4, "other"), Vec::<&str>::new());
        assert_eq!(inbox.take(3, "c"), vec!["c", "d"]);
    }

    #[test]
    fn a_page_numbers_its_menus_and_an_older_number_is_refused() {
        let mut book = ready_book();
        assert_eq!(book.admit("tab-a", "load-1", 1), Ok(()));
        assert_eq!(book.admit("tab-a", "load-1", 3), Ok(()));
        // The second came after the third: overtaken.
        assert_eq!(book.admit("tab-a", "load-1", 2), Err(MenuPanelRefusal::Superseded));
        assert_eq!(book.admit("tab-a", "load-1", 3), Err(MenuPanelRefusal::Superseded));
        // Another page counts on its own.
        assert_eq!(book.admit("tab-b", "load-1", 1), Ok(()));
    }

    #[test]
    fn a_closing_that_comes_before_its_opening_cancels_it() {
        let mut book = ready_book();
        book.closing_named("tab-a", "load-1", 4);
        assert_eq!(book.admit("tab-a", "load-1", 4), Err(MenuPanelRefusal::Superseded));
        assert_eq!(book.admit("tab-a", "load-1", 5), Ok(()));
        // A closing of an older menu takes nothing back.
        book.closing_named("tab-a", "load-1", 2);
        assert_eq!(book.admit("tab-a", "load-1", 5), Err(MenuPanelRefusal::Superseded));
        assert_eq!(book.admit("tab-a", "load-1", 6), Ok(()));
    }

    #[test]
    fn a_page_loaded_anew_counts_from_one_again() {
        let mut book = ready_book();
        assert!(book.source_loaded("tab-a", "load-1"));
        assert!(!book.source_loaded("tab-a", "load-1"));
        assert_eq!(book.admit("tab-a", "load-1", 7), Ok(()));
        assert!(book.source_loaded("tab-a", "load-2"));
        assert_eq!(book.admit("tab-a", "load-2", 1), Ok(()));
    }

    #[test]
    fn a_new_menu_replaces_the_open_one() {
        let mut book = ready_book();
        assert!(begin(&mut book, "tab-a", "window-a", 1).is_none());
        let replaced = begin(&mut book, "tab-b", "window-b", 1);
        assert_eq!(replaced.map(|menu| (menu.menu, menu.source)), Some((1, "tab-a".to_string())));
        // The same number of another page is another menu.
        assert!(book.finish(Some(("tab-a", 1))).is_none());
        assert!(book.open.is_some());
        assert!(book.finish(Some(("tab-b", 1))).is_some());
    }

    #[test]
    fn the_messages_to_each_page_are_counted_from_one_for_each_menu() {
        let mut book = ready_book();
        begin(&mut book, "tab-a", "window-a", 1);
        assert_eq!(book.next_to_page("tab-a", 1), Some(1));
        assert_eq!(book.next_to_page("tab-a", 1), Some(2));
        assert_eq!(book.next_to_source("tab-a", 1), Some(1));
        // A menu that is not the open one has no row.
        assert_eq!(book.next_to_source("tab-a", 2), None);
        assert_eq!(book.next_to_page("tab-b", 1), None);
        begin(&mut book, "tab-a", "window-a", 2);
        assert_eq!(book.next_to_page("tab-a", 2), Some(1));
    }

    #[test]
    fn the_pages_requests_are_carried_out_in_the_order_of_its_count() {
        let mut book = ready_book();
        begin(&mut book, "tab-a", "window-a", 1);
        // The closing came before the choice the person made first.
        assert!(book.page_request(&page_request(1, 2, None, Some(MenuPanelCloseReason::Escape))).is_empty());
        let due = book.page_request(&page_request(1, 1, Some("toggle"), None));
        assert_eq!(
            due,
            vec![
                PageStep { request: 1, action: Some(run("toggle")), close: None },
                PageStep { request: 2, action: None, close: Some(MenuPanelCloseReason::Escape) },
            ],
        );
        // A request for a menu that is not open is dropped.
        assert!(book.page_request(&page_request(9, 1, Some("run"), None)).is_empty());
    }

    #[test]
    fn only_a_later_change_of_the_tabs_goes_to_the_panel() {
        let mut book = ready_book();
        begin(&mut book, "tab-a", "window-a", 1);
        assert!(book.takes_update("tab-a", 1, 2));
        // The first came after the second: stale, the whole menu was newer.
        assert!(!book.takes_update("tab-a", 1, 1));
        assert!(!book.takes_update("tab-a", 1, 2));
        assert!(book.takes_update("tab-a", 1, 3));
        assert!(!book.takes_update("tab-a", 2, 4));
    }

    #[test]
    fn a_menu_its_page_has_not_drawn_is_watched_until_it_draws() {
        let mut book = ready_book();
        begin(&mut book, "tab-a", "window-a", 1);
        assert!(book.unpainted("tab-a", 1).is_some());
        assert!(book.painted("tab-a", 1).is_some());
        assert!(book.unpainted("tab-a", 1).is_none());
        assert!(book.unpainted("tab-a", 2).is_none());
        // A late report for a menu that closed still finds its timings.
        book.finish(None);
        assert!(book.painted("tab-a", 1).is_some());
        assert!(book.painted("tab-b", 1).is_none());
    }

    fn step(menu: u32, step: MenuPanelStep, area: (f64, f64), visible: bool) -> MenuPanelProgress {
        MenuPanelProgress {
            source: "tab-a".into(),
            menu,
            step,
            area: MenuPanelSize { width: area.0, height: area.1 },
            visible,
        }
    }

    /// МО40а: a menu that draws nothing in time says where its page stopped.
    #[test]
    fn a_menu_that_draws_nothing_says_where_its_page_stopped() {
        let frame = MenuPanelSize { width: 564.0, height: 332.0 };
        let mut book = ready_book();
        let shown = Shown { frame, ..Shown::default() };
        book.begin("tab-a", "window-a", &request(1), shown, 3.0, 4.0);
        let stalled = book.unpainted("tab-a", 1).expect("the menu is unpainted");
        assert!(stalled.starts_with("the page told no step: it never heard the opening"), "{stalled}");
        book.progressed(&step(1, MenuPanelStep::Received, (264.0, 56.0), true));
        let stalled = book.unpainted("tab-a", 1).expect("the menu is unpainted");
        assert_eq!(
            stalled,
            "the page waits for its area to take the frame's size: last step=received area=264x56 frame=564x332 page_visible=true"
        );
        book.progressed(&step(1, MenuPanelStep::Sized, (564.0, 332.0), true));
        assert!(book.unpainted("tab-a", 1).is_some_and(|text| text.starts_with("the page's area is the frame's and the page drew nothing")));
        book.progressed(&step(1, MenuPanelStep::FrameRequested, (564.0, 332.0), false));
        assert_eq!(
            book.unpainted("tab-a", 1).as_deref(),
            Some("the page drew the menu and no frame came: last step=frame_requested area=564x332 frame=564x332 page_visible=false")
        );
        // A step of another menu, or of a closed one, is dropped.
        book.progressed(&step(2, MenuPanelStep::Received, (1.0, 1.0), true));
        assert!(book.unpainted("tab-a", 1).is_some_and(|text| text.contains("frame_requested")));
    }

    #[test]
    fn the_keyboard_given_back_marks_the_windows_next_focus_once() {
        let mut book = ready_book();
        begin(&mut book, "tab-a", "window-a", 1);
        book.finish(None);
        // Nothing was given back: the focus is the person's.
        assert!(!book.focus_returns("window-a"));
        book.hand_back("window-a");
        assert!(!book.focus_returns("window-b"));
        assert!(book.focus_returns("window-a"));
        assert!(!book.focus_returns("window-a"));
    }

    #[test]
    fn the_mark_holds_however_late_the_focus_comes_and_a_new_menu_takes_it_off() {
        let mut book = ready_book();
        begin(&mut book, "tab-a", "window-a", 1);
        book.finish(None);
        book.hand_back("window-a");
        // No clock: the mark waits for the focus it names.
        assert!(book.focus_returns("window-a"));
        book.hand_back("window-a");
        begin(&mut book, "tab-a", "window-a", 2);
        assert!(!book.focus_returns("window-a"));
    }

    #[test]
    fn the_report_splits_the_opening_into_its_steps() {
        let mut book = ready_book();
        let mut asked = request(1);
        asked.event_at = Some(100.0);
        asked.sent_at = 101.0;
        book.begin("tab-a", "window-a", &asked, Shown::default(), 103.0, 104.5);
        let menu = book.painted("tab-a", 1).unwrap();
        let paint = MenuPanelPaint {
            source: "tab-a".to_string(),
            menu: 1,
            received_at: 106.0,
            sized_at: 107.0,
            drawn_at: 110.0,
            frame_at: 112.0,
            measured: MenuPanelSize { width: 240.0, height: 325.0 },
        };
        assert_eq!(
            steps(&menu, &paint),
            Steps { tab: Some(1.0), to_backend: 2.0, backend: 1.5, to_panel: 1.5, frame_wait: 1.0, render: 3.0, to_frame: 2.0, total: 12.0 },
        );
        // The parts add up to the whole.
        let parts = steps(&menu, &paint);
        assert_eq!(
            parts.tab.unwrap() + parts.to_backend + parts.backend + parts.to_panel + parts.frame_wait + parts.render + parts.to_frame,
            parts.total,
        );
    }

    #[test]
    fn without_an_inputs_event_the_measure_starts_at_the_request() {
        let mut book = ready_book();
        let mut asked = request(1);
        asked.event_at = None;
        asked.sent_at = 101.0;
        book.begin("tab-a", "window-a", &asked, Shown::default(), 103.0, 104.5);
        let menu = book.painted("tab-a", 1).unwrap();
        let paint = MenuPanelPaint {
            source: "tab-a".to_string(),
            menu: 1,
            received_at: 106.0,
            sized_at: 106.0,
            drawn_at: 110.0,
            frame_at: 112.0,
            measured: MenuPanelSize { width: 240.0, height: 325.0 },
        };
        let time = steps(&menu, &paint);
        assert_eq!((time.tab, time.total), (None, 11.0));
    }

    #[test]
    fn the_look_is_the_main_window_of_the_active_app() {
        let look = WindowLook { main: true, key: false, panel_key: true, app_active: true };
        assert!(look.active_look());
        assert!(!WindowLook { main: false, ..look }.active_look());
        assert!(!WindowLook { app_active: false, ..look }.active_look());
    }
}
