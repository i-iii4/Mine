//! TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): the
//! menu panel, a window of its own the feed card's menu is drawn in, so the
//! menu may reach past the edge of the app's window like a system menu.
//!
//! One clear borderless window, made once at the size of the largest card
//! menu with its submenu, never resized. At rest it stays on the screen, so
//! WebKit keeps its page running, draws nothing and lets every click
//! through. To open a menu it moves to its place, takes the clicks and the
//! keyboard, and becomes the key window without becoming the main one: the
//! window the menu came from stays main, and its title bar and traffic
//! lights keep their active look. Whatever closes the menu gives the clicks
//! back at once. The page draws the menu itself (src/menuPanel); the tab that
//! opened it runs every choice (src/lib/menuPanelSource.ts).

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::commands::space_events::emit_to_labels;
use crate::domain::windows::WindowId;

pub const PANEL_LABEL: &str = "menu-panel";
const PANEL_PAGE: &str = "menu-panel.html";

const OPEN_EVENT: &str = "menu-panel-open";
const SHOWN_EVENT: &str = "menu-panel-shown";
const CLOSED_EVENT: &str = "menu-panel-closed";
const STATUS_EVENT: &str = "menu-panel-status";

/// A focus of the menu's window within this after the menu closed is the
/// window taking the keyboard back from the panel, not a return to the app.
const FOCUS_RETURN_WINDOW: Duration = Duration::from_millis(1000);

/// A rectangle in points. On the page: from the page's top left corner. On
/// the screen: from the top left corner of the main screen, y down.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A point on the screen, from the top left corner of the main screen.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

/// The panel's size in points, the page's one source of it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct MenuPanelSize {
    pub width: f64,
    pub height: f64,
}

/// Whether the panel's page listens: until then a menu opens on its page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct MenuPanelStatus {
    pub ready: bool,
}

/// A tab asks for its card menu in the panel.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MenuPanelOpenRequest {
    /// The anchor in the tab's page: the plate of the button, or the point
    /// of a right click as a rectangle of no size.
    pub anchor: ScreenRect,
    /// What the panel draws, JSON the backend passes on unread
    /// (src/lib/menuPanelProtocol.ts).
    pub payload: String,
    /// When the input that opened the menu came, epoch milliseconds.
    pub event_at: f64,
}

/// The menu's number: every later message names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct MenuPanelTicket {
    pub menu: u32,
}

/// What the panel's page hears to draw a menu.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct MenuPanelOpening {
    pub menu: u32,
    /// The tab that opened it: the panel sends it every choice.
    pub source: String,
    /// The anchor on the screen.
    pub anchor: ScreenRect,
    /// The visible frame of the screen the anchor is on: without the menu
    /// bar and the Dock.
    pub screen: ScreenRect,
    pub payload: String,
    pub event_at: f64,
}

/// The panel showed the menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct MenuPanelShown {
    pub menu: u32,
}

/// Why a menu closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuPanelCloseReason {
    /// An item was chosen.
    Chosen,
    /// Escape, or the chord that opened it.
    Escape,
    /// A press outside it, here, in another window, in another app, or the
    /// app left.
    Outside,
    /// The tab closed it, or another menu took the panel.
    Source,
    /// The panel did not show it in time.
    Unresponsive,
    /// The panel could not draw or show it.
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

/// The menu closed: to the tab and to the panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct MenuPanelClosed {
    pub menu: u32,
    pub reason: MenuPanelCloseReason,
}

/// The panel's page drew its first frame of the menu.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MenuPanelPaint {
    pub menu: u32,
    /// The time of that frame, epoch milliseconds.
    pub frame_at: f64,
    /// `plate` or `point`.
    pub opener: String,
}

/// Why a menu does not open or show in the panel: the tab then opens it on
/// its page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuPanelRefusal {
    #[error("the menu panel is not ready")]
    NotReady,
    #[error("Mine is not the active app")]
    AppInactive,
    #[error("the caller is not a tab page")]
    NotATab,
    #[error("the page's place on the screen is not known")]
    NoGeometry,
    #[error("no such menu is open")]
    NotOpen,
    #[error("called off the main thread")]
    NotMainThread,
    #[error("the panel did not become the key window")]
    ShowFailed,
}

// ── The book of the open menu: no Tauri, no AppKit ────────────────────────

#[derive(Debug, Clone, PartialEq)]
struct OpenMenu {
    id: u32,
    source: String,
    window: String,
    event_at: f64,
    opened_at: f64,
    shown_at: Option<f64>,
}

#[derive(Debug, Default)]
struct PanelBook {
    ready: bool,
    next: u32,
    open: Option<OpenMenu>,
    /// The window a closed menu came from, and when it closed.
    focus_return: Option<(String, Instant)>,
    /// The last menu shown, for its paint report after it closed.
    last_shown: Option<OpenMenu>,
}

impl PanelBook {
    /// Open a menu of `source` in `window`; the one it replaces, if any.
    fn begin(&mut self, source: &str, window: &str, event_at: f64, now_ms: f64) -> Result<(u32, Option<OpenMenu>), MenuPanelRefusal> {
        if !self.ready {
            return Err(MenuPanelRefusal::NotReady);
        }
        let replaced = self.open.take();
        self.next = self.next.checked_add(1).unwrap_or(1);
        self.open = Some(OpenMenu {
            id: self.next,
            source: source.to_string(),
            window: window.to_string(),
            event_at,
            opened_at: now_ms,
            shown_at: None,
        });
        Ok((self.next, replaced))
    }

    fn shown(&mut self, id: u32, at: f64) -> Result<OpenMenu, MenuPanelRefusal> {
        match self.open.as_mut() {
            Some(menu) if menu.id == id => {
                menu.shown_at = Some(at);
                self.last_shown = Some(menu.clone());
                Ok(menu.clone())
            }
            _ => Err(MenuPanelRefusal::NotOpen),
        }
    }

    /// Close the menu `id`, or the open one with `None`: the menu that was
    /// open, if it was that one.
    fn finish(&mut self, id: Option<u32>, now: Instant) -> Option<OpenMenu> {
        if id.is_some_and(|id| self.open.as_ref().is_none_or(|menu| menu.id != id)) {
            return None;
        }
        let menu = self.open.take()?;
        self.focus_return = Some((menu.window.clone(), now));
        Some(menu)
    }

    /// Whether `window` coming into focus now is it taking the keyboard back
    /// from the panel. Asked once: a later focus is the person's.
    fn focus_returns(&mut self, window: &str, now: Instant) -> bool {
        match &self.focus_return {
            Some((from, at)) if from == window && now.duration_since(*at) < FOCUS_RETURN_WINDOW => {
                self.focus_return = None;
                true
            }
            _ => false,
        }
    }

    /// The page started anew or went: whatever was open is gone with it.
    fn set_ready(&mut self, ready: bool) -> Option<OpenMenu> {
        self.ready = ready;
        if ready {
            None
        } else {
            self.open.take()
        }
    }
}

// ── Geometry: points between the page, AppKit and the screen ──────────────

/// A rectangle with AppKit's origin, the bottom left corner of the main
/// screen, y up.
#[derive(Debug, Clone, Copy, PartialEq)]
struct AppKitRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// `page`, a rectangle in a page whose view stands at `view` on the screen,
/// on the screen from its top left corner: the main screen is
/// `primary_height` tall.
fn page_rect_on_screen(view: AppKitRect, page: ScreenRect, primary_height: f64) -> ScreenRect {
    ScreenRect {
        x: view.x + page.x,
        y: primary_height - (view.y + view.height) + page.y,
        width: page.width,
        height: page.height,
    }
}

/// An AppKit rectangle from the screen's top left corner.
fn appkit_rect_on_screen(rect: AppKitRect, primary_height: f64) -> ScreenRect {
    ScreenRect {
        x: rect.x,
        y: primary_height - (rect.y + rect.height),
        width: rect.width,
        height: rect.height,
    }
}

/// A point from the screen's top left corner, in AppKit's coordinates.
fn screen_point_in_appkit(point: ScreenPoint, primary_height: f64) -> (f64, f64) {
    (point.x, primary_height - point.y)
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
        ready: panel_state(app).is_some_and(|state| state.book().ready),
    }
}

fn announce_status(app: &AppHandle) {
    if let Err(error) = app.emit(STATUS_EVENT, status(app)) {
        log::warn!("cannot announce the menu panel's state: {error}");
    }
}

/// Make the panel unless it exists, at `size`, on the main screen, clear
/// and passing every click. Whether its page is ready.
pub fn prepare(app: &AppHandle, size: MenuPanelSize) -> MenuPanelStatus {
    if app.get_webview_window(PANEL_LABEL).is_some() {
        return status(app);
    }
    if !(size.width.is_finite() && size.height.is_finite() && size.width > 0.0 && size.height > 0.0) {
        log::warn!("menu panel not made: size {}x{}", size.width, size.height);
        return status(app);
    }
    let built = WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App(PANEL_PAGE.into()))
        .title("")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(true)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .inner_size(size.width, size.height)
        .position(0.0, 0.0)
        // The page keeps running though it is never the visible window's
        // content: the first opening draws in the same frame.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            log::warn!("menu panel not made: {error}");
            return status(app);
        }
    };
    native::configure(&window);
    let handle = app.clone();
    window.on_window_event(move |event| on_panel_event(&handle, event));
    log::info!("menu panel made: {}x{}", size.width, size.height);
    status(app)
}

fn on_panel_event(app: &AppHandle, event: &WindowEvent) {
    match event {
        // The panel lost the keyboard: a press outside it, here, in another
        // window or another app, or the app left (DESIGN_SYSTEM.md, «Меню
        // карточки в отдельном окне: проба»).
        WindowEvent::Focused(false) => close(app, None, MenuPanelCloseReason::Outside),
        // ⌘W with the panel in front closes the menu, never the panel.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            close(app, None, MenuPanelCloseReason::Escape);
        }
        WindowEvent::Destroyed => {
            if let Some(state) = panel_state(app) {
                let gone = state.book().set_ready(false);
                if let Some(menu) = gone {
                    emit_to_labels(app, [menu.source], CLOSED_EVENT, MenuPanelClosed { menu: menu.id, reason: MenuPanelCloseReason::Failed });
                }
            }
            announce_status(app);
        }
        _ => {}
    }
}

/// The panel's page listens. A page that started again (a reload) has drawn
/// nothing: the panel passes clicks.
pub fn page_ready(app: &AppHandle, caller: &Webview) {
    if caller.label() != PANEL_LABEL {
        return;
    }
    let Some(state) = panel_state(app) else { return };
    let gone = {
        let mut book = state.book();
        let gone = book.open.take();
        book.set_ready(true);
        gone
    };
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        native::pass_clicks(&window);
    }
    if let Some(menu) = gone {
        emit_to_labels(app, [menu.source], CLOSED_EVENT, MenuPanelClosed { menu: menu.id, reason: MenuPanelCloseReason::Failed });
    }
    announce_status(app);
}

/// Open a card menu of the tab `caller` in the panel.
pub fn open(app: &AppHandle, caller: &Webview, request: MenuPanelOpenRequest) -> Result<MenuPanelTicket, MenuPanelRefusal> {
    if !native::on_main_thread() {
        return Err(MenuPanelRefusal::NotMainThread);
    }
    let source = caller.label().to_string();
    let window = caller.window().label().to_string();
    if !source.starts_with("tab-") || WindowId::from_label(&window).is_none() {
        return Err(MenuPanelRefusal::NotATab);
    }
    let state = panel_state(app).ok_or(MenuPanelRefusal::NotReady)?;
    let panel = app.get_webview_window(PANEL_LABEL).ok_or(MenuPanelRefusal::NotReady)?;
    // A right click in a window of an app in the background: the panel
    // could not take the keyboard without bringing Mine forward.
    if !native::app_is_active() {
        return Err(MenuPanelRefusal::AppInactive);
    }
    let (anchor, screen) = native::anchor_on_screen(caller, request.anchor).ok_or(MenuPanelRefusal::NoGeometry)?;
    let opened_at = now_ms();
    let (menu, replaced) = state.book().begin(&source, &window, request.event_at, opened_at)?;
    if let Some(replaced) = replaced {
        native::pass_clicks(&panel);
        emit_to_labels(
            app,
            [replaced.source, PANEL_LABEL.to_string()],
            CLOSED_EVENT,
            MenuPanelClosed { menu: replaced.id, reason: MenuPanelCloseReason::Source },
        );
    }
    emit_to_labels(
        app,
        [PANEL_LABEL],
        OPEN_EVENT,
        MenuPanelOpening { menu, source, anchor, screen, payload: request.payload, event_at: request.event_at },
    );
    Ok(MenuPanelTicket { menu })
}

/// The panel's page laid the menu `menu` out: the panel moves to `origin`,
/// takes the clicks and becomes the key window, not the main one.
pub fn show(app: &AppHandle, caller: &Webview, menu: u32, origin: ScreenPoint) -> Result<(), MenuPanelRefusal> {
    if caller.label() != PANEL_LABEL {
        return Err(MenuPanelRefusal::NotOpen);
    }
    if !native::on_main_thread() {
        return Err(MenuPanelRefusal::NotMainThread);
    }
    let state = panel_state(app).ok_or(MenuPanelRefusal::NotReady)?;
    let panel = app.get_webview_window(PANEL_LABEL).ok_or(MenuPanelRefusal::NotReady)?;
    let shown = state.book().shown(menu, now_ms())?;
    if !native::show(&panel, origin) {
        log::warn!("menu panel: menu {menu} not shown, the panel did not become the key window");
        close(app, Some(menu), MenuPanelCloseReason::Failed);
        return Err(MenuPanelRefusal::ShowFailed);
    }
    emit_to_labels(app, [shown.source], SHOWN_EVENT, MenuPanelShown { menu });
    Ok(())
}

/// Close the menu `menu`, or whichever is open with `None`: the panel
/// passes clicks again, the window the menu came from takes the keyboard
/// back when the panel held it, and the tab and the panel hear why.
pub fn close(app: &AppHandle, menu: Option<u32>, reason: MenuPanelCloseReason) {
    let Some(state) = panel_state(app) else { return };
    let Some(closed) = state.book().finish(menu, Instant::now()) else { return };
    let panel = app.get_webview_window(PANEL_LABEL);
    let panel_was_key = panel.as_ref().is_some_and(native::is_key);
    if let Some(panel) = &panel {
        native::pass_clicks(panel);
    }
    if panel_was_key {
        match app.get_window(&closed.window) {
            Some(window) => native::make_key(&window),
            // The window is gone: the panel must not keep the keyboard
            // unseen.
            None => {
                if let Some(panel) = &panel {
                    native::give_up_key(panel);
                }
            }
        }
    }
    log::info!("card menu panel: menu {} closed ({})", closed.id, reason.as_str());
    emit_to_labels(
        app,
        [closed.source, PANEL_LABEL.to_string()],
        CLOSED_EVENT,
        MenuPanelClosed { menu: closed.id, reason },
    );
}

/// The measurement of one opening (DESIGN_SYSTEM.md, «Меню карточки в
/// отдельном окне: проба»): the time from the input to the panel's first
/// frame of the menu, and whether the window under it kept its active look,
/// as AppKit holds it.
pub fn painted(app: &AppHandle, paint: &MenuPanelPaint) {
    let Some(state) = panel_state(app) else { return };
    let shown = {
        let book = state.book();
        book.last_shown.clone().filter(|menu| menu.id == paint.menu)
    };
    let Some(shown) = shown else { return };
    let look = app
        .get_window(&shown.window)
        .zip(app.get_webview_window(PANEL_LABEL))
        .map(|(window, panel)| native::look(&window, &panel));
    let still_open = state.book().open.as_ref().is_some_and(|menu| menu.id == paint.menu);
    let to_frame = paint.frame_at - shown.event_at;
    let to_open = shown.opened_at - shown.event_at;
    let to_show = shown.shown_at.map_or(f64::NAN, |at| at - shown.event_at);
    match look {
        Some(look) => log::info!(
            "card menu panel opened: menu={} opener={} event_to_frame_ms={to_frame:.1} event_to_open_ms={to_open:.1} event_to_show_ms={to_show:.1} main_window_active_look={} main={} key={} panel_key={} app_active={} active_appearance={} open={still_open}",
            paint.menu,
            paint.opener,
            look.active_look(),
            look.main,
            look.key,
            look.panel_key,
            look.app_active,
            look.active_appearance.map_or("unknown", |active| if active { "true" } else { "false" }),
        ),
        None => log::info!(
            "card menu panel opened: menu={} opener={} event_to_frame_ms={to_frame:.1} event_to_open_ms={to_open:.1} event_to_show_ms={to_show:.1} main_window_active_look=unknown open={still_open}",
            paint.menu,
            paint.opener,
        ),
    }
}

/// Whether the tab window `window` coming into focus is it taking the
/// keyboard back from the panel, a menu of its having just closed: then it
/// is no return to the app, and the reactions to one (В42, the last window)
/// do not run.
pub fn focus_returns_from_panel(app: &AppHandle, window: &WindowId) -> bool {
    panel_state(app).is_some_and(|state| state.book().focus_returns(&window.label(), Instant::now()))
}

/// What AppKit says of the window a menu came from while the menu is up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowLook {
    main: bool,
    key: bool,
    panel_key: bool,
    app_active: bool,
    /// AppKit's own answer, where it gives one (`_hasActiveAppearance`).
    active_appearance: Option<bool>,
}

impl WindowLook {
    /// The title bar and the traffic lights look active: the window is main
    /// in the active app, or AppKit says so itself.
    fn active_look(self) -> bool {
        self.active_appearance.unwrap_or(self.app_active && (self.main || self.key))
    }
}

#[cfg(target_os = "macos")]
mod native {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, OnceLock};

    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_foundation::{NSNumber, NSPoint, NSRect, NSString};
    use tauri::{Webview, WebviewWindow, Window};

    use super::{AppKitRect, ScreenPoint, ScreenRect, WindowLook};

    /// `NSPopUpMenuWindowLevel`: above every window, as a system menu.
    const POP_UP_MENU_LEVEL: isize = 101;
    /// `CanJoinAllSpaces | Transient | IgnoresCycle | FullScreenAuxiliary`:
    /// on every space and over a full screen window, out of Mission Control
    /// and the ⌘` cycle.
    const COLLECTION_BEHAVIOR: usize = (1 << 0) | (1 << 3) | (1 << 6) | (1 << 8);
    /// `NSWindowAnimationBehaviorNone`.
    const ANIMATION_NONE: isize = 2;

    /// The panel's NSWindow, for the main window question.
    static PANEL: AtomicUsize = AtomicUsize::new(0);
    /// tao's answer to `canBecomeMainWindow`, before Mine's stood in front.
    static TAO_CAN_BECOME_MAIN: OnceLock<Option<Imp>> = OnceLock::new();

    type BoolMethod = unsafe extern "C-unwind" fn(&AnyObject, Sel) -> Bool;

    /// Mine's `canBecomeMainWindow`: never the panel, tao's answer for
    /// every other window. The panel becomes the key window and leaves the
    /// window under it main, as a panel of AppKit does.
    unsafe extern "C-unwind" fn can_become_main(this: &AnyObject, cmd: Sel) -> Bool {
        if std::ptr::from_ref(this) as usize == PANEL.load(Ordering::Relaxed) {
            return Bool::NO;
        }
        match TAO_CAN_BECOME_MAIN.get().copied().flatten() {
            // SAFETY: the implementation this one replaced, same signature,
            // called on the main thread where AppKit asks.
            Some(tao) => std::mem::transmute::<Imp, BoolMethod>(tao)(this, cmd),
            None => Bool::YES,
        }
    }

    pub fn on_main_thread() -> bool {
        MainThreadMarker::new().is_some()
    }

    fn ns_window_of(window: &Window) -> Option<&'static AnyObject> {
        let ptr = window.ns_window().ok()?;
        // SAFETY: the live NSWindow of a Tauri window, used on the main
        // thread while the window exists.
        unsafe { (ptr as *const AnyObject).as_ref() }
    }

    fn panel_ns_window(panel: &WebviewWindow) -> Option<&'static AnyObject> {
        let ptr = panel.ns_window().ok()?;
        // SAFETY: as in `ns_window_of`.
        unsafe { (ptr as *const AnyObject).as_ref() }
    }

    /// The WKWebView of `webview`. Tauri runs the closure at once on the
    /// main thread; anywhere else there is none.
    fn web_view_of(webview: &Webview) -> Option<&'static AnyObject> {
        let found = Arc::new(AtomicUsize::new(0));
        let inside = Arc::clone(&found);
        let _ = webview.with_webview(move |view| inside.store(view.inner() as usize, Ordering::Relaxed));
        let ptr = found.load(Ordering::Relaxed);
        // SAFETY: a live WKWebView, read on the main thread while its page
        // exists.
        unsafe { (ptr as *const AnyObject).as_ref() }
    }

    fn web_view_of_panel(panel: &WebviewWindow) -> Option<&'static AnyObject> {
        let found = Arc::new(AtomicUsize::new(0));
        let inside = Arc::clone(&found);
        let _ = panel.with_webview(move |view| inside.store(view.inner() as usize, Ordering::Relaxed));
        let ptr = found.load(Ordering::Relaxed);
        // SAFETY: as in `web_view_of`.
        unsafe { (ptr as *const AnyObject).as_ref() }
    }

    fn rect(value: NSRect) -> AppKitRect {
        AppKitRect { x: value.origin.x, y: value.origin.y, width: value.size.width, height: value.size.height }
    }

    /// The height of the main screen, whose bottom left corner is AppKit's
    /// origin.
    fn primary_height() -> Option<f64> {
        // SAFETY: class messages of AppKit on the main thread.
        unsafe {
            let screens: *mut AnyObject = msg_send![objc2::class!(NSScreen), screens];
            let screens = screens.as_ref()?;
            let first: *mut AnyObject = msg_send![screens, firstObject];
            let first = first.as_ref()?;
            let frame: NSRect = msg_send![first, frame];
            Some(frame.size.height)
        }
    }

    /// The visible frame of the screen holding `point` (AppKit's
    /// coordinates), else of `fallback`'s screen.
    fn visible_frame_at(point: NSPoint, fallback: &AnyObject) -> Option<AppKitRect> {
        // SAFETY: AppKit objects read on the main thread.
        unsafe {
            let screens: *mut AnyObject = msg_send![objc2::class!(NSScreen), screens];
            if let Some(screens) = screens.as_ref() {
                let count: usize = msg_send![screens, count];
                for index in 0..count {
                    let screen: *mut AnyObject = msg_send![screens, objectAtIndex: index];
                    let Some(screen) = screen.as_ref() else { continue };
                    let frame: NSRect = msg_send![screen, frame];
                    let inside = point.x >= frame.origin.x
                        && point.x < frame.origin.x + frame.size.width
                        && point.y >= frame.origin.y
                        && point.y < frame.origin.y + frame.size.height;
                    if inside {
                        let visible: NSRect = msg_send![screen, visibleFrame];
                        return Some(rect(visible));
                    }
                }
            }
            let screen: *mut AnyObject = msg_send![fallback, screen];
            let screen = screen.as_ref()?;
            let visible: NSRect = msg_send![screen, visibleFrame];
            Some(rect(visible))
        }
    }

    /// The anchor `page` of `webview`'s page on the screen, and the visible
    /// frame of the screen it is on, both from the main screen's top left.
    pub fn anchor_on_screen(webview: &Webview, page: ScreenRect) -> Option<(ScreenRect, ScreenRect)> {
        let view = web_view_of(webview)?;
        let primary = primary_height()?;
        // SAFETY: a live view and its window on the main thread.
        unsafe {
            let window: *mut AnyObject = msg_send![view, window];
            let window = window.as_ref()?;
            let bounds: NSRect = msg_send![view, bounds];
            let nothing: *mut AnyObject = std::ptr::null_mut();
            let in_window: NSRect = msg_send![view, convertRect: bounds, toView: nothing];
            let on_screen: NSRect = msg_send![window, convertRectToScreen: in_window];
            let anchor = super::page_rect_on_screen(rect(on_screen), page, primary);
            let center = NSPoint::new(anchor.x + anchor.width / 2.0, primary - (anchor.y + anchor.height / 2.0));
            let visible = visible_frame_at(center, window)?;
            Some((anchor, super::appkit_rect_on_screen(visible, primary)))
        }
    }

    /// Make the panel clear and passing clicks, on every space, never main.
    pub fn configure(panel: &WebviewWindow) {
        let Some(window) = panel_ns_window(panel) else {
            log::warn!("menu panel: no NSWindow");
            return;
        };
        // SAFETY: the panel's live NSWindow and its WKWebView on the main
        // thread. The replacement of `canBecomeMainWindow` has its
        // signature and calls the implementation saved before it went in;
        // the OnceLock keeps it from replacing itself.
        unsafe {
            let clear: *mut AnyObject = msg_send![objc2::class!(NSColor), clearColor];
            let _: () = msg_send![window, setOpaque: false];
            let _: () = msg_send![window, setBackgroundColor: clear];
            // The page draws the menu's own shadow, which moves and shows
            // with the menu; a window shadow would be a second one round
            // the clear panel, behind the menu's motion.
            let _: () = msg_send![window, setHasShadow: false];
            let _: () = msg_send![window, setLevel: POP_UP_MENU_LEVEL];
            let _: () = msg_send![window, setCollectionBehavior: COLLECTION_BEHAVIOR];
            let _: () = msg_send![window, setExcludedFromWindowsMenu: true];
            let _: () = msg_send![window, setHidesOnDeactivate: false];
            let _: () = msg_send![window, setAnimationBehavior: ANIMATION_NONE];
            let _: () = msg_send![window, setIgnoresMouseEvents: true];
            PANEL.store(std::ptr::from_ref(window) as usize, Ordering::Relaxed);
            let class: *const AnyClass = msg_send![window, class];
            if let Some(class) = class.as_ref() {
                TAO_CAN_BECOME_MAIN.get_or_init(|| {
                    let original = class.instance_method(sel!(canBecomeMainWindow)).map(objc2::runtime::Method::implementation);
                    let hook = std::mem::transmute::<BoolMethod, Imp>(can_become_main);
                    let _ = objc2::ffi::class_replaceMethod(
                        std::ptr::from_ref(class).cast_mut(),
                        sel!(canBecomeMainWindow),
                        hook,
                        c"B@:".as_ptr(),
                    );
                    original
                });
            }
        }
        if let Some(view) = web_view_of_panel(panel) {
            // SAFETY: the panel's live WKWebView on the main thread.
            // `drawsBackground` is the key wry sets for clear pages;
            // `_setWindowOcclusionDetectionEnabled:` (WKWebViewPrivate.h)
            // keeps WebKit from counting the clear panel as hidden.
            unsafe {
                let no = NSNumber::new_bool(false);
                let key = NSString::from_str("drawsBackground");
                let _: () = msg_send![view, setValue: &*no, forKey: &*key];
                let occlusion: bool = msg_send![view, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)];
                if occlusion {
                    let _: () = msg_send![view, _setWindowOcclusionDetectionEnabled: false];
                }
            }
        }
    }

    /// The panel lets every click through.
    pub fn pass_clicks(panel: &WebviewWindow) {
        if let Some(window) = panel_ns_window(panel) {
            // SAFETY: the panel's live NSWindow on the main thread.
            unsafe {
                let _: () = msg_send![window, setIgnoresMouseEvents: true];
            }
        }
    }

    /// Move the panel's top left corner to `origin`, take the clicks and the
    /// keyboard. False when it did not become the key window: it passes
    /// clicks again then.
    pub fn show(panel: &WebviewWindow, origin: ScreenPoint) -> bool {
        let Some(window) = panel_ns_window(panel) else { return false };
        let Some(primary) = primary_height() else { return false };
        let (x, y) = super::screen_point_in_appkit(origin, primary);
        // SAFETY: the panel's live NSWindow on the main thread.
        unsafe {
            let _: () = msg_send![window, setFrameTopLeftPoint: NSPoint::new(x, y)];
            let _: () = msg_send![window, setIgnoresMouseEvents: false];
            let _: () = msg_send![window, orderFrontRegardless];
            let _: () = msg_send![window, makeKeyWindow];
            let key: bool = msg_send![window, isKeyWindow];
            if !key {
                let _: () = msg_send![window, setIgnoresMouseEvents: true];
            }
            key
        }
    }

    /// The panel stops being the key window and stays on the screen.
    pub fn give_up_key(panel: &WebviewWindow) {
        if let Some(window) = panel_ns_window(panel) {
            // SAFETY: the panel's live NSWindow on the main thread.
            unsafe {
                let nothing: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![window, orderOut: nothing];
                let _: () = msg_send![window, orderFrontRegardless];
            }
        }
    }

    pub fn is_key(panel: &WebviewWindow) -> bool {
        panel_ns_window(panel).is_some_and(|window| {
            // SAFETY: a live NSWindow on the main thread.
            unsafe { msg_send![window, isKeyWindow] }
        })
    }

    /// Give `window` the keyboard back.
    pub fn make_key(window: &Window) {
        if let Some(ns_window) = ns_window_of(window) {
            // SAFETY: a live NSWindow on the main thread.
            unsafe {
                let _: () = msg_send![ns_window, makeKeyWindow];
            }
        }
    }

    fn shared_application() -> Option<&'static AnyObject> {
        // SAFETY: the shared application, on the main thread.
        unsafe {
            let application: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
            application.as_ref()
        }
    }

    pub fn app_is_active() -> bool {
        shared_application().is_some_and(|application| {
            // SAFETY: as above.
            unsafe { msg_send![application, isActive] }
        })
    }

    pub fn look(window: &Window, panel: &WebviewWindow) -> WindowLook {
        let ns_window = ns_window_of(window);
        // SAFETY: live NSWindows on the main thread; the private
        // `_hasActiveAppearance` is only read, and only where the window
        // answers it.
        unsafe {
            let main = ns_window.is_some_and(|w| msg_send![w, isMainWindow]);
            let key = ns_window.is_some_and(|w| msg_send![w, isKeyWindow]);
            let active_appearance = ns_window.and_then(|w| {
                let answers: bool = msg_send![w, respondsToSelector: sel!(_hasActiveAppearance)];
                answers.then(|| msg_send![w, _hasActiveAppearance])
            });
            WindowLook { main, key, panel_key: is_key(panel), app_active: app_is_active(), active_appearance }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use tauri::{Webview, WebviewWindow, Window};

    use super::{ScreenPoint, ScreenRect, WindowLook};

    pub fn on_main_thread() -> bool {
        false
    }
    pub fn anchor_on_screen(_webview: &Webview, _page: ScreenRect) -> Option<(ScreenRect, ScreenRect)> {
        None
    }
    pub fn configure(_panel: &WebviewWindow) {}
    pub fn pass_clicks(_panel: &WebviewWindow) {}
    pub fn show(_panel: &WebviewWindow, _origin: ScreenPoint) -> bool {
        false
    }
    pub fn is_key(_panel: &WebviewWindow) -> bool {
        false
    }
    pub fn give_up_key(_panel: &WebviewWindow) {}
    pub fn make_key(_window: &Window) {}
    pub fn app_is_active() -> bool {
        false
    }
    pub fn look(_window: &Window, _panel: &WebviewWindow) -> WindowLook {
        WindowLook { main: false, key: false, panel_key: false, app_active: false, active_appearance: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_book() -> PanelBook {
        let mut book = PanelBook::default();
        book.set_ready(true);
        book
    }

    #[test]
    fn a_menu_opens_only_once_the_page_is_ready() {
        let mut book = PanelBook::default();
        assert_eq!(book.begin("tab-a", "window-a", 1.0, 2.0), Err(MenuPanelRefusal::NotReady));
        book.set_ready(true);
        let (id, replaced) = book.begin("tab-a", "window-a", 1.0, 2.0).unwrap();
        assert_eq!(id, 1);
        assert!(replaced.is_none());
    }

    #[test]
    fn a_new_menu_replaces_the_open_one_with_a_new_number() {
        let mut book = ready_book();
        let (first, _) = book.begin("tab-a", "window-a", 1.0, 2.0).unwrap();
        let (second, replaced) = book.begin("tab-b", "window-b", 3.0, 4.0).unwrap();
        assert_ne!(first, second);
        assert_eq!(replaced.map(|menu| (menu.id, menu.source)), Some((first, "tab-a".to_string())));
        // The replaced menu's late word finds nothing.
        assert_eq!(book.shown(first, 5.0), Err(MenuPanelRefusal::NotOpen));
        assert!(book.finish(Some(first), Instant::now()).is_none());
        assert!(book.open.is_some());
    }

    #[test]
    fn closing_marks_the_return_of_the_focus_to_the_menus_window_once() {
        let mut book = ready_book();
        let (id, _) = book.begin("tab-a", "window-a", 1.0, 2.0).unwrap();
        book.shown(id, 3.0).unwrap();
        let now = Instant::now();
        assert_eq!(book.finish(None, now).map(|menu| menu.id), Some(id));
        assert!(!book.focus_returns("window-b", now));
        assert!(book.focus_returns("window-a", now + Duration::from_millis(10)));
        // Asked once: the next focus is the person's.
        assert!(!book.focus_returns("window-a", now + Duration::from_millis(20)));
    }

    #[test]
    fn a_late_focus_is_a_return_to_the_app() {
        let mut book = ready_book();
        book.begin("tab-a", "window-a", 1.0, 2.0).unwrap();
        let now = Instant::now();
        book.finish(None, now);
        assert!(!book.focus_returns("window-a", now + FOCUS_RETURN_WINDOW));
    }

    #[test]
    fn a_page_that_went_takes_its_menu_with_it() {
        let mut book = ready_book();
        let (id, _) = book.begin("tab-a", "window-a", 1.0, 2.0).unwrap();
        assert_eq!(book.set_ready(false).map(|menu| menu.id), Some(id));
        assert!(book.open.is_none());
        assert_eq!(book.begin("tab-a", "window-a", 1.0, 2.0), Err(MenuPanelRefusal::NotReady));
    }

    #[test]
    fn a_shown_menu_keeps_its_times_for_the_report() {
        let mut book = ready_book();
        let (id, _) = book.begin("tab-a", "window-a", 10.0, 12.0).unwrap();
        book.shown(id, 15.0).unwrap();
        book.finish(Some(id), Instant::now());
        let shown = book.last_shown.clone().unwrap();
        assert_eq!((shown.event_at, shown.opened_at, shown.shown_at), (10.0, 12.0, Some(15.0)));
    }

    #[test]
    fn page_rectangles_land_on_the_screen_from_its_top_left() {
        // A 900 pt tall main screen; the page's view 600 pt tall, its bottom
        // left corner at (100, 200) in AppKit's coordinates: its top at 100
        // from the screen's top.
        let view = AppKitRect { x: 100.0, y: 200.0, width: 800.0, height: 600.0 };
        let anchor = page_rect_on_screen(view, ScreenRect { x: 10.0, y: 20.0, width: 24.0, height: 24.0 }, 900.0);
        assert_eq!(anchor, ScreenRect { x: 110.0, y: 120.0, width: 24.0, height: 24.0 });
    }

    #[test]
    fn screen_frames_and_points_turn_between_the_two_origins() {
        // A second screen above the main one: its frame starts at y 900.
        let above = AppKitRect { x: 0.0, y: 900.0, width: 1920.0, height: 1080.0 };
        assert_eq!(appkit_rect_on_screen(above, 900.0), ScreenRect { x: 0.0, y: -1080.0, width: 1920.0, height: 1080.0 });
        assert_eq!(screen_point_in_appkit(ScreenPoint { x: 50.0, y: 100.0 }, 900.0), (50.0, 800.0));
    }

    #[test]
    fn the_look_is_appkits_answer_where_it_gives_one() {
        let look = WindowLook { main: true, key: false, panel_key: true, app_active: true, active_appearance: None };
        assert!(look.active_look());
        assert!(!WindowLook { active_appearance: Some(false), ..look }.active_look());
        assert!(!WindowLook { main: false, ..look }.active_look());
    }
}
