//! The menu panel's AppKit side (SPEC_MENU_WINDOW.md, sections 7 to 9): the
//! clear window, its place, the keyboard, the watch over the presses outside
//! an open menu, and the check that the window really is clear before anyone
//! sees it.
//!
//! The panel's window is made here, of its own class from its making, and
//! the page Tauri made is moved into it; the Tauri window stays a hidden
//! shell (МО62). The class of a living window is never changed (МО62а):
//! AppKit and WebKit watch every window by KVO from its `init`, and a window
//! whose class changes under them crashes in the next watched setter or
//! throws when the watch is taken off.
//!
//! What is not public API here, and what each is for (МО62 to МО65):
//! `_setWindowOcclusionDetectionEnabled:` of WKWebView, so WebKit does not
//! count the clear panel's page as hidden, and the key `drawsBackground` of
//! WKWebView, so the page draws no background. Neither has a public
//! replacement. Without the first the page may stop drawing, and a menu then
//! opens on its page once the paint deadline passes; without the second the
//! check of clearness fails and the panel is never shown. The panel's own
//! window class is made with the Objective-C runtime's public functions.
//!
//! Everything here but the pure functions runs on the main thread.

use tauri::{Webview, WebviewWindow, Window};

use super::geometry::{MenuPanelSize, ScreenPoint, ScreenRect};
use super::{Placement, WindowLook};

/// A rectangle with AppKit's origin, the bottom left corner of the main
/// screen, y up.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AppKitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `page`, a rectangle in a page whose view stands at `view` on the screen,
/// from the screen's top left corner: the main screen is `primary_height`
/// tall.
pub fn page_rect_on_screen(view: AppKitRect, page: ScreenRect, primary_height: f64) -> ScreenRect {
    ScreenRect {
        x: view.x + page.x,
        y: primary_height - (view.y + view.height) + page.y,
        width: page.width,
        height: page.height,
    }
}

/// An AppKit rectangle from the screen's top left corner.
pub fn appkit_rect_on_screen(rect: AppKitRect, primary_height: f64) -> ScreenRect {
    ScreenRect {
        x: rect.x,
        y: primary_height - (rect.y + rect.height),
        width: rect.width,
        height: rect.height,
    }
}

/// A frame from the screen's top left corner, in AppKit's coordinates: its
/// origin is its lower left corner, y up.
pub fn frame_in_appkit(origin: ScreenPoint, size: MenuPanelSize, primary_height: f64) -> AppKitRect {
    AppKitRect {
        x: origin.x,
        y: primary_height - (origin.y + size.height),
        width: size.width,
        height: size.height,
    }
}

/// A button of the mouse, as the watch over presses tells them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Other,
}

/// What the mouse did, of all an open menu cares about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseStep {
    Down(MouseButton),
    Up(MouseButton),
    Dragged(MouseButton),
    Wheel,
}

/// The mouse's step of an `NSEventType`, or none for the rest.
pub fn mouse_step(event_type: usize) -> Option<MouseStep> {
    match event_type {
        1 => Some(MouseStep::Down(MouseButton::Left)),
        2 => Some(MouseStep::Up(MouseButton::Left)),
        3 => Some(MouseStep::Down(MouseButton::Right)),
        4 => Some(MouseStep::Up(MouseButton::Right)),
        6 => Some(MouseStep::Dragged(MouseButton::Left)),
        7 => Some(MouseStep::Dragged(MouseButton::Right)),
        22 => Some(MouseStep::Wheel),
        25 => Some(MouseStep::Down(MouseButton::Other)),
        26 => Some(MouseStep::Up(MouseButton::Other)),
        27 => Some(MouseStep::Dragged(MouseButton::Other)),
        _ => None,
    }
}

/// The `NSEventMask` of every type `mouse_step` knows.
pub const WATCHED_EVENTS: u64 =
    (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 6) | (1 << 7) | (1 << 22) | (1 << 25) | (1 << 26) | (1 << 27);

/// What becomes of an event of the mouse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PressVerdict {
    /// It goes on to its window.
    Pass,
    /// It reaches no window.
    Swallow,
    /// It closes the open menu and reaches no window.
    Dismiss,
}

/// The watch over the mouse while a menu is up (МО43). A press outside the
/// panel only closes the menu: it reaches no window, and neither do the
/// drags and the release of that button, however long after the menu
/// closed. The wheel outside the panel scrolls nothing while the menu is
/// up. Everything else passes, the pointer's moves among it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PressGuard {
    held: [bool; 3],
}

impl PressGuard {
    pub fn judge(&mut self, step: MouseStep, menu_up: bool, on_panel: bool) -> PressVerdict {
        match step {
            MouseStep::Down(button) if menu_up && !on_panel => {
                self.held[button as usize] = true;
                PressVerdict::Dismiss
            }
            MouseStep::Up(button) if self.held[button as usize] => {
                self.held[button as usize] = false;
                PressVerdict::Swallow
            }
            MouseStep::Dragged(button) if self.held[button as usize] => PressVerdict::Swallow,
            MouseStep::Wheel if menu_up && !on_panel => PressVerdict::Swallow,
            _ => PressVerdict::Pass,
        }
    }
}

/// What AppKit says of the panel right after it was shown (МО59).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ShowReport {
    pub visible: bool,
    pub on_active_space: bool,
    pub key: bool,
    /// `NSWindowOcclusionStateVisible`. AppKit brings it up to date some
    /// time after a window moves, so it is written to the log and refuses
    /// nothing.
    pub unoccluded: bool,
    /// The panel's frame changed its size for this menu (МО29, МО73).
    pub frame_changed: bool,
    /// The panel's frame set for this menu.
    pub frame: MenuPanelSize,
    /// The size of the page's view in the panel's window after the frame
    /// was set; none when the window holds no page.
    pub page: Option<MenuPanelSize>,
}

impl ShowReport {
    /// The menu is seen, holds the keyboard, and its page can draw it: the
    /// page draws once its area is the frame's (МО30, МО30а).
    pub fn on_top(self) -> bool {
        self.visible && self.on_active_space && self.key && self.page_fits()
    }

    /// The page's view took the panel's frame.
    pub fn page_fits(self) -> bool {
        self.page
            .is_some_and(|page| (page.width - self.frame.width).abs() < 0.5 && (page.height - self.frame.height).abs() < 0.5)
    }

    pub fn describe(self) -> String {
        let page = self.page.map_or_else(|| "none".to_string(), |page| format!("{}x{}", page.width, page.height));
        format!(
            "visible={} on_active_space={} key={} unoccluded={} frame_changed={} frame={}x{} page_view={page}",
            self.visible, self.on_active_space, self.key, self.unoccluded, self.frame_changed, self.frame.width, self.frame.height,
        )
    }
}

/// An anchor of a page on the screen: where it is, the bound of its screen
/// (МО1), and what the screen and the window are, for the log.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placed {
    pub anchor: ScreenRect,
    pub bound: ScreenRect,
    pub placement: Placement,
}

/// The points of a snapshot the check reads: a grid of 9 × 9 across the
/// whole picture, edges included. The page at rest draws nothing, so every
/// one of them must be clear.
pub fn sample_points(width: isize, height: isize) -> Vec<(isize, isize)> {
    if width <= 0 || height <= 0 {
        return Vec::new();
    }
    let steps = 8;
    let mut points = Vec::with_capacity(81);
    for row in 0..=steps {
        for column in 0..=steps {
            points.push(((width - 1) * column / steps, (height - 1) * row / steps));
        }
    }
    points
}

/// What the check found: the window's and the page's flags and the
/// snapshot's pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct Transparency {
    pub window_opaque: bool,
    pub window_background_alpha: f64,
    pub window_shadow: bool,
    pub page_draws_background: bool,
    /// The snapshot's size in pixels and whether it carries alpha.
    pub snapshot: Option<(isize, isize, bool)>,
    /// The highest alpha among the sampled pixels.
    pub highest_alpha: f64,
    pub sampled: usize,
}

impl Transparency {
    /// Nothing was checked: no window or no page to look at. Not clear.
    pub fn unknown() -> Self {
        Transparency {
            window_opaque: true,
            window_background_alpha: 1.0,
            window_shadow: true,
            page_draws_background: true,
            snapshot: None,
            highest_alpha: 1.0,
            sampled: 0,
        }
    }

    /// The window is clear: every flag says so and every sampled pixel of
    /// the page at rest is clear.
    pub fn clear(&self) -> bool {
        !self.window_opaque
            && self.window_background_alpha == 0.0
            && !self.window_shadow
            && !self.page_draws_background
            && self.snapshot.is_some_and(|(_, _, alpha)| alpha)
            && self.sampled > 0
            && self.highest_alpha < 0.01
    }

    pub fn describe(&self) -> String {
        let snapshot = self.snapshot.map_or_else(
            || "none".to_string(),
            |(width, height, alpha)| format!("{width}x{height} alpha_channel={alpha}"),
        );
        format!(
            "window_opaque={} window_background_alpha={:.2} window_shadow={} page_draws_background={} snapshot={snapshot} sampled={} highest_alpha={:.3}",
            self.window_opaque, self.window_background_alpha, self.window_shadow, self.page_draws_background, self.sampled, self.highest_alpha,
        )
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::{Cell, RefCell};
    use std::ffi::CStr;
    use std::panic::AssertUnwindSafe;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_foundation::{NSEdgeInsets, NSNumber, NSPoint, NSRect, NSString};
    use tauri::{Webview, WebviewWindow, Window};

    use super::super::geometry::{self, SafeInsets};
    use super::super::Placement;
    use objc2_foundation::NSSize;

    use super::{
        mouse_step, sample_points, AppKitRect, MenuPanelSize, Placed, PressGuard, PressVerdict, ScreenPoint, ScreenRect,
        ShowReport, Transparency, WindowLook, WATCHED_EVENTS,
    };

    /// `NSPopUpMenuWindowLevel`: above every window, as a system menu.
    const POP_UP_MENU_LEVEL: isize = 101;
    /// `CanJoinAllSpaces | Transient | IgnoresCycle | FullScreenAuxiliary`.
    const COLLECTION_BEHAVIOR: usize = (1 << 0) | (1 << 3) | (1 << 6) | (1 << 8);
    /// `NSWindowAnimationBehaviorNone`.
    const ANIMATION_NONE: isize = 2;
    /// `NSWindowStyleMaskFullScreen`.
    const STYLE_FULL_SCREEN: usize = 1 << 14;
    /// `NSWindowOcclusionStateVisible`.
    const OCCLUSION_VISIBLE: usize = 1 << 1;
    /// `NSWindowStyleMaskBorderless`.
    const STYLE_BORDERLESS: usize = 0;
    /// `NSBackingStoreBuffered`.
    const BACKING_BUFFERED: usize = 2;
    /// `NSViewWidthSizable | NSViewHeightSizable`: a view that keeps the
    /// size of its parent.
    const FILLS_ITS_PARENT: usize = (1 << 1) | (1 << 4);
    /// The class of the panel's own window, an `NSWindow`.
    const PANEL_CLASS: &CStr = c"MineMenuPanelWindow";

    /// The panel's own NSWindow, retained by this place from `adopt` to
    /// `forget_panel`, or 0 when there is none.
    static PANEL: AtomicUsize = AtomicUsize::new(0);
    /// A menu is up in the panel: the panel may hold the keyboard, and a
    /// press outside it closes the menu.
    static MENU_UP: AtomicBool = AtomicBool::new(false);
    /// The watch over the mouse and the app is set, once for the app's run.
    static WATCHING: AtomicBool = AtomicBool::new(false);

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSApplicationDidResignActiveNotification: &'static NSString;
        static NSApplicationDidBecomeActiveNotification: &'static NSString;
        static NSApplicationDidChangeScreenParametersNotification: &'static NSString;
        static NSMenuDidBeginTrackingNotification: &'static NSString;
        static NSWindowDidResignKeyNotification: &'static NSString;
        static NSWorkspaceActiveSpaceDidChangeNotification: &'static NSString;
    }

    /// The panel's `canBecomeMainWindow`: never. The window a menu came from
    /// stays the main one and keeps its active look (МО46).
    extern "C-unwind" fn never_main(_this: &AnyObject, _cmd: Sel) -> Bool {
        Bool::NO
    }

    /// The panel's `canBecomeKeyWindow`: only while a menu is up. At rest
    /// AppKit cannot hand it the keyboard, when the app comes back or ever.
    extern "C-unwind" fn key_while_a_menu_is_up(_this: &AnyObject, _cmd: Sel) -> Bool {
        Bool::new(MENU_UP.load(Ordering::Relaxed))
    }

    /// The class of the panel's window, an `NSWindow` that answers the two
    /// questions above: made once with the runtime's public functions. The
    /// panel's window is of this class from its making; no window's class
    /// is changed (МО62, МО62а).
    fn panel_class() -> Option<&'static AnyClass> {
        if let Some(known) = AnyClass::get(PANEL_CLASS) {
            return Some(known);
        }
        let mut builder = ClassBuilder::new(PANEL_CLASS, objc2::class!(NSWindow))?;
        // SAFETY: both methods have the signature of the NSWindow methods
        // they override, `- (BOOL)canBecomeMainWindow` and
        // `- (BOOL)canBecomeKeyWindow`.
        unsafe {
            builder.add_method(sel!(canBecomeMainWindow), never_main as extern "C-unwind" fn(_, _) -> _);
            builder.add_method(sel!(canBecomeKeyWindow), key_while_a_menu_is_up as extern "C-unwind" fn(_, _) -> _);
        }
        Some(builder.register())
    }

    /// Run `run`, a part of AppKit's work on the panel's window: what
    /// Objective-C throws in it comes back as an error and goes no further.
    /// The panel is then not set up and the menus stay on the page (МО62).
    fn guarded<R>(what: &str, run: impl FnOnce() -> Result<R, String>) -> Result<R, String> {
        // `AssertUnwindSafe`: after a throw the caller lets the window go
        // and reads nothing the closure left half done.
        match objc2::exception::catch(AssertUnwindSafe(run)) {
            Ok(done) => done,
            Err(Some(thrown)) => Err(format!("{what}: AppKit threw {thrown}")),
            Err(None) => Err(format!("{what}: AppKit threw an exception with no object")),
        }
    }

    /// The page's view in the panel's window: the WKWebView among the
    /// views of its content view, as wry laid it out.
    fn page_in_panel(window: &AnyObject) -> Option<&AnyObject> {
        let web_view = AnyClass::get(c"WKWebView")?;
        // SAFETY: the panel's live window and its views on the main thread.
        unsafe {
            let content: *mut AnyObject = msg_send![window, contentView];
            let content = content.as_ref()?;
            let subviews: *mut AnyObject = msg_send![content, subviews];
            let subviews = subviews.as_ref()?;
            let count: usize = msg_send![subviews, count];
            (0..count).find_map(|index| {
                let view: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
                let view = view.as_ref()?;
                let is_page: bool = msg_send![view, isKindOfClass: web_view];
                is_page.then_some(view)
            })
        }
    }

    /// The panel's own window, or none.
    fn panel_window() -> Option<&'static AnyObject> {
        // SAFETY: the window `adopt` retained and stored; it lives until
        // `forget_panel` takes it back, and both run on the main thread, as
        // every reader of this does.
        unsafe { (PANEL.load(Ordering::Relaxed) as *const AnyObject).as_ref() }
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

    /// The NSWindow of the Tauri window the panel's page was made in.
    fn shell_ns_window(panel: &WebviewWindow) -> Option<&'static AnyObject> {
        let ptr = panel.ns_window().ok()?;
        // SAFETY: as in `ns_window_of`.
        unsafe { (ptr as *const AnyObject).as_ref() }
    }

    /// The WKWebView of a page. Tauri runs the closure at once on the main
    /// thread; anywhere else there is none.
    fn web_view_of(webview: &Webview) -> Option<&'static AnyObject> {
        let found = Arc::new(AtomicUsize::new(0));
        let inside = Arc::clone(&found);
        let _ = webview.with_webview(move |view| inside.store(view.inner() as usize, Ordering::Relaxed));
        // SAFETY: a live WKWebView, read on the main thread while its page
        // exists.
        unsafe { (found.load(Ordering::Relaxed) as *const AnyObject).as_ref() }
    }

    fn web_view_of_panel(panel: &WebviewWindow) -> Option<&'static AnyObject> {
        let found = Arc::new(AtomicUsize::new(0));
        let inside = Arc::clone(&found);
        let _ = panel.with_webview(move |view| inside.store(view.inner() as usize, Ordering::Relaxed));
        // SAFETY: as in `web_view_of`.
        unsafe { (found.load(Ordering::Relaxed) as *const AnyObject).as_ref() }
    }

    fn rect(value: NSRect) -> AppKitRect {
        AppKitRect { x: value.origin.x, y: value.origin.y, width: value.size.width, height: value.size.height }
    }

    fn primary_height() -> Option<f64> {
        // SAFETY: class messages of AppKit on the main thread.
        unsafe {
            let screens: *mut AnyObject = msg_send![objc2::class!(NSScreen), screens];
            let first: *mut AnyObject = msg_send![screens.as_ref()?, firstObject];
            let frame: NSRect = msg_send![first.as_ref()?, frame];
            Some(frame.size.height)
        }
    }

    /// The screen `point` lies on and its place among the screens, else the
    /// screen of `fallback`, a window (МО1).
    fn screen_at(point: NSPoint, fallback: &AnyObject) -> Option<(usize, &'static AnyObject)> {
        // SAFETY: AppKit objects read on the main thread.
        unsafe {
            let screens: *mut AnyObject = msg_send![objc2::class!(NSScreen), screens];
            let screens = screens.as_ref()?;
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
                    return Some((index, screen));
                }
            }
            let screen: *mut AnyObject = msg_send![fallback, screen];
            let screen = screen.as_ref()?;
            let index: usize = msg_send![screens, indexOfObject: screen];
            Some((if index < count { index } else { 0 }, screen))
        }
    }

    /// The bound of a menu on `screen` (МО1): its visible frame, less the
    /// safe area's insets where the screen has them.
    fn bound_of(screen: &AnyObject, primary: f64) -> (ScreenRect, AppKitRect) {
        // SAFETY: a live NSScreen read on the main thread; `safeAreaInsets`
        // is asked only of a screen that answers it (macOS 12 and later).
        unsafe {
            let frame: NSRect = msg_send![screen, frame];
            let visible: NSRect = msg_send![screen, visibleFrame];
            let answers: bool = msg_send![screen, respondsToSelector: sel!(safeAreaInsets)];
            let insets = if answers {
                let insets: NSEdgeInsets = msg_send![screen, safeAreaInsets];
                SafeInsets { top: insets.top, left: insets.left, bottom: insets.bottom, right: insets.right }
            } else {
                SafeInsets::default()
            };
            let bound = geometry::screen_bound(
                super::appkit_rect_on_screen(rect(frame), primary),
                super::appkit_rect_on_screen(rect(visible), primary),
                insets,
            );
            (bound, rect(frame))
        }
    }

    pub fn anchor_on_screen(webview: &Webview, page: ScreenRect) -> Option<Placed> {
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
            let (screen, on) = screen_at(center, window)?;
            let (bound, screen_frame) = bound_of(on, primary);
            let style: usize = msg_send![window, styleMask];
            let frame: NSRect = msg_send![window, frame];
            let fullscreen = style & STYLE_FULL_SCREEN != 0;
            // In full screen and narrower than its screen: beside another
            // window in Split View.
            let split = fullscreen && frame.size.width + 1.0 < screen_frame.width;
            Some(Placed { anchor, bound, placement: Placement { screen, fullscreen, split } })
        }
    }

    /// Make the panel's own window where `shell` stands and move `shell`'s
    /// page, the web view `view`, into it (МО62). The window is clear,
    /// unseen (`alphaValue` 0) and passes clicks, on every space, never
    /// main, key only while a menu is up; it is not put on the screen here.
    /// A panel made before goes first, and a panel that could not be made
    /// whole is not left behind: whatever fails, an exception of AppKit
    /// among it, comes back as the error.
    pub fn adopt(shell: &AnyObject, view: &AnyObject) -> Result<(), String> {
        if !on_main_thread() {
            return Err("a window is made on the main thread only".to_string());
        }
        forget_panel();
        let made = guarded("making the panel's window", || make_and_fill(shell, view));
        if made.is_err() {
            forget_panel();
        }
        made
    }

    /// The panel's window, made and filled; a failure leaves what was made
    /// to `forget_panel`.
    fn make_and_fill(shell: &AnyObject, view: &AnyObject) -> Result<(), String> {
        let class = panel_class().ok_or("the panel's window class could not be made")?;
        // SAFETY: live AppKit objects on the main thread. The window is made
        // by the designated initializer of NSWindow, the class's parent;
        // the class adds no instance variables.
        let content = unsafe {
            let content: Option<Retained<AnyObject>> = msg_send![shell, contentView];
            let content = content.ok_or("the shell has no content view")?;
            let inside: bool = msg_send![view, isDescendantOf: &*content];
            if !inside {
                return Err("the page is not in the shell's content view".to_string());
            }
            let frame: NSRect = msg_send![shell, frame];
            let made: Allocated<AnyObject> = msg_send![class, alloc];
            let window: Option<Retained<AnyObject>> = msg_send![
                made,
                initWithContentRect: frame,
                styleMask: STYLE_BORDERLESS,
                backing: BACKING_BUFFERED,
                defer: false
            ];
            let window = window.ok_or("AppKit made no window")?;
            // This place owns the window: closing it must not release it.
            let _: () = msg_send![&*window, setReleasedWhenClosed: false];
            MENU_UP.store(false, Ordering::Relaxed);
            PANEL.store(Retained::into_raw(window) as usize, Ordering::Relaxed);
            content
        };
        let window = panel_window().ok_or("the panel's window is gone")?;
        dress_and_fill(window, shell, &content, view)
    }

    /// The panel's new window `window` gets its look and its rules, then
    /// `content`, the view of `shell` that holds the page `view`.
    fn dress_and_fill(window: &AnyObject, shell: &AnyObject, content: &AnyObject, view: &AnyObject) -> Result<(), String> {
        // SAFETY: the panel's live window, the shell and the page's views on
        // the main thread.
        unsafe {
            let main: bool = msg_send![window, canBecomeMainWindow];
            let key: bool = msg_send![window, canBecomeKeyWindow];
            if main || key {
                return Err(format!("the panel's window class does not answer: canBecomeMainWindow={main} canBecomeKeyWindow={key} at rest"));
            }
            let _: () = msg_send![window, setAlphaValue: 0.0_f64];
            let clear: *mut AnyObject = msg_send![objc2::class!(NSColor), clearColor];
            let _: () = msg_send![window, setOpaque: false];
            let _: () = msg_send![window, setBackgroundColor: clear];
            // The page draws the menu's own shadow, which moves and shows
            // with the menu; a window shadow would be a second one round the
            // clear panel, behind the menu's motion.
            let _: () = msg_send![window, setHasShadow: false];
            let _: () = msg_send![window, setLevel: POP_UP_MENU_LEVEL];
            let _: () = msg_send![window, setCollectionBehavior: COLLECTION_BEHAVIOR];
            let _: () = msg_send![window, setExcludedFromWindowsMenu: true];
            let _: () = msg_send![window, setHidesOnDeactivate: false];
            let _: () = msg_send![window, setAnimationBehavior: ANIMATION_NONE];
            let _: () = msg_send![window, setIgnoresMouseEvents: true];
            // As tao sets on every window it makes, the shell among them:
            // the page hears the pointer's moves as it did there.
            let _: () = msg_send![window, setAcceptsMouseMovedEvents: true];
            // The page's view moves with the content view it is in: the
            // shell gets an empty view in its place.
            let empty: Retained<AnyObject> = msg_send![objc2::class!(NSView), new];
            let _: () = msg_send![shell, setContentView: &*empty];
            let _: () = msg_send![window, setContentView: content];
            let now_in: *mut AnyObject = msg_send![view, window];
            if !std::ptr::eq(now_in, window) {
                return Err("the page did not move into the panel's window".to_string());
            }
            // The page's view fills the panel and keeps its size from now
            // on (МО30а). Tauri makes every window's page a child view of a
            // fixed size (its `unstable` feature) and sizes it itself when
            // its window resizes; the panel's window is not Tauri's, so no
            // such word comes, and a page left as it was keeps the shell's
            // size whatever frame the panel takes.
            let bounds: NSRect = msg_send![content, bounds];
            let _: () = msg_send![view, setFrame: bounds];
            let _: () = msg_send![view, setAutoresizingMask: FILLS_ITS_PARENT];
            let frame: NSRect = msg_send![view, frame];
            if frame != bounds {
                return Err("the page does not fill the panel's window".to_string());
            }
            // The page takes the keys of its window, as wry set it in the
            // shell.
            let takes_keys: bool = msg_send![window, makeFirstResponder: view];
            if !takes_keys {
                return Err("the page does not take the keys of the panel's window".to_string());
            }
        }
        Ok(())
    }

    /// Make the panel of the Tauri window `panel`, its shell: the panel's
    /// own window with the shell's page in it, on the screen and unseen
    /// until the check below finds it clear.
    pub fn configure(panel: &WebviewWindow) -> Result<(), String> {
        let shell = shell_ns_window(panel).ok_or("no NSWindow")?;
        let view = web_view_of_panel(panel).ok_or("no WKWebView to move and make clear")?;
        adopt(shell, view)?;
        let window = panel_window().ok_or("the panel's window is gone")?;
        // SAFETY: the panel's live window and WKWebView on the main thread.
        // At rest the panel stays on the screen, unseen, so WebKit keeps
        // its page running. `drawsBackground` is the key wry sets for clear
        // pages (МО65); `_setWindowOcclusionDetectionEnabled:`
        // (WKWebViewPrivate.h) keeps WebKit from counting the clear panel
        // as hidden (МО64), and is sent only to a view that answers it.
        let shown = guarded("putting the panel's window at rest", || unsafe {
            let no = NSNumber::new_bool(false);
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![view, setValue: &*no, forKey: &*key];
            let occlusion: bool = msg_send![view, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)];
            if occlusion {
                let _: () = msg_send![view, _setWindowOcclusionDetectionEnabled: false];
            } else {
                log::warn!(
                    "menu panel: WKWebView does not answer _setWindowOcclusionDetectionEnabled:, occlusion detection is left on; a page WebKit counts as hidden draws nothing, and the menus then open on the page"
                );
            }
            let nothing: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![window, orderFront: nothing];
            Ok(())
        });
        if shown.is_err() {
            forget_panel();
        }
        shown
    }

    /// Hear `name` from `center` for the app's run.
    fn observe(center: &AnyObject, name: &NSString, run: Rc<dyn Fn()>) {
        let block = block2::RcBlock::new(move |_note: *mut AnyObject| run());
        let nothing: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: a notification centre on the main thread; the block is
        // copied by the centre and runs on the posting thread, the main one
        // for these notifications.
        let token: Option<Retained<AnyObject>> = unsafe {
            msg_send![center, addObserverForName: name, object: nothing, queue: nothing, usingBlock: &*block]
        };
        // The observer stands for the app's run.
        std::mem::forget(token);
    }

    /// Hear the panel's window lose the keyboard, for the app's run: `run`
    /// goes on the main queue's next step, not inside AppKit's change of
    /// the key window, and by then a later menu may hold the keyboard
    /// (МО44). No Tauri event tells of it: the window is not Tauri's (МО62).
    fn observe_key_lost(center: &AnyObject, run: Rc<dyn Fn()>) {
        let block = block2::RcBlock::new(move |note: *mut AnyObject| {
            // SAFETY: the notification AppKit posts on the main thread and
            // the main operation queue.
            unsafe {
                let Some(note) = note.as_ref() else { return };
                let of: *mut AnyObject = msg_send![note, object];
                if of.is_null() || of as usize != PANEL.load(Ordering::Relaxed) {
                    return;
                }
                let run = Rc::clone(&run);
                let later = block2::RcBlock::new(move || run());
                let queue: *mut AnyObject = msg_send![objc2::class!(NSOperationQueue), mainQueue];
                if let Some(queue) = queue.as_ref() {
                    let _: () = msg_send![queue, addOperationWithBlock: &*later];
                }
            }
        });
        let nothing: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: as in `observe`.
        let token: Option<Retained<AnyObject>> = unsafe {
            msg_send![center, addObserverForName: NSWindowDidResignKeyNotification, object: nothing, queue: nothing, usingBlock: &*block]
        };
        // The observer stands for the app's run.
        std::mem::forget(token);
    }

    /// Watch the mouse, the app and the panel's window, once for the app's
    /// run (МО43, МО44). `on_outside` runs on a press outside the panel
    /// while a menu is up, when the app leaves, when the menu bar starts
    /// tracking, when the desktop or the screens change. `on_active` runs
    /// when the app comes back. `on_key_lost` runs after the panel's window
    /// lost the keyboard.
    pub fn watch(
        on_outside: impl Fn() + 'static,
        on_active: impl Fn() + 'static,
        on_key_lost: impl Fn() + 'static,
    ) -> Result<(), String> {
        if WATCHING.load(Ordering::Relaxed) {
            return Ok(());
        }
        let on_outside: Rc<dyn Fn()> = Rc::new(on_outside);
        let guard = Cell::new(PressGuard::default());
        let dismiss = Rc::clone(&on_outside);
        let handler = block2::RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
            // SAFETY: the NSEvent AppKit is about to dispatch, read on the
            // main thread inside the monitor.
            let (kind, window) = unsafe {
                let Some(seen) = event.as_ref() else { return event };
                let kind: usize = msg_send![seen, type];
                let window: *mut AnyObject = msg_send![seen, window];
                (kind, window)
            };
            let Some(step) = mouse_step(kind) else { return event };
            let on_panel = !window.is_null() && window as usize == PANEL.load(Ordering::Relaxed);
            let mut presses = guard.get();
            let verdict = presses.judge(step, MENU_UP.load(Ordering::Relaxed), on_panel);
            guard.set(presses);
            match verdict {
                PressVerdict::Pass => event,
                PressVerdict::Swallow => std::ptr::null_mut(),
                PressVerdict::Dismiss => {
                    dismiss();
                    std::ptr::null_mut()
                }
            }
        });
        // SAFETY: AppKit's class method on the main thread; the handler
        // returns the event it was given or nil, as the monitor expects.
        let monitor: Option<Retained<AnyObject>> = unsafe {
            msg_send![objc2::class!(NSEvent), addLocalMonitorForEventsMatchingMask: WATCHED_EVENTS, handler: &*handler]
        };
        let Some(monitor) = monitor else {
            return Err("AppKit gave no monitor of the mouse".to_string());
        };
        // The monitor stands for the app's run.
        std::mem::forget(monitor);
        // SAFETY: AppKit's shared objects and its notification names, read
        // on the main thread.
        unsafe {
            let center: *mut AnyObject = msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
            let workspace: *mut AnyObject = msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
            let Some(center) = center.as_ref() else {
                return Err("no notification centre".to_string());
            };
            observe(center, NSApplicationDidResignActiveNotification, Rc::clone(&on_outside));
            observe(center, NSMenuDidBeginTrackingNotification, Rc::clone(&on_outside));
            observe(center, NSApplicationDidChangeScreenParametersNotification, Rc::clone(&on_outside));
            observe(center, NSApplicationDidBecomeActiveNotification, Rc::new(on_active));
            observe_key_lost(center, Rc::new(on_key_lost));
            if let Some(workspace) = workspace.as_ref() {
                let spaces: *mut AnyObject = msg_send![workspace, notificationCenter];
                if let Some(spaces) = spaces.as_ref() {
                    observe(spaces, NSWorkspaceActiveSpaceDidChangeNotification, on_outside);
                }
            }
        }
        WATCHING.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// The panel may be seen: the check found it clear.
    pub fn reveal() {
        if let Some(window) = panel_window() {
            // SAFETY: the panel's live NSWindow on the main thread.
            unsafe {
                let _: () = msg_send![window, setAlphaValue: 1.0_f64];
            }
        }
    }

    /// Whether the panel is clear: its flags, then a snapshot of its page at
    /// rest, every sampled pixel clear. WebKit draws the snapshot itself
    /// (`takeSnapshotWithConfiguration:`): no system permission, no picture
    /// of the screen. `done` runs once, on the main thread.
    pub fn check_transparency(panel: &WebviewWindow, done: impl FnOnce(Transparency) + 'static) {
        check_clearness(panel_window(), web_view_of_panel(panel), done);
    }

    /// Whether `window` and its page `view` are clear, as `check_transparency`
    /// asks of the panel: for any clear window of the app, the outside window
    /// too (SPEC_OUTSIDE_WINDOW.md, НО1). A missing window or page is not.
    pub fn check_clearness(
        window: Option<&AnyObject>,
        view: Option<&AnyObject>,
        done: impl FnOnce(Transparency) + 'static,
    ) {
        // SAFETY: live AppKit and WebKit objects read on the main thread.
        let flags = unsafe {
            let window_opaque = window.is_none_or(|w| msg_send![w, isOpaque]);
            let window_shadow = window.is_none_or(|w| msg_send![w, hasShadow]);
            let window_background_alpha = window.map_or(1.0, |w| {
                let color: *mut AnyObject = msg_send![w, backgroundColor];
                color.as_ref().map_or(1.0, |color| msg_send![color, alphaComponent])
            });
            let page_draws_background = view.is_none_or(|v| {
                let key = NSString::from_str("drawsBackground");
                let value: *mut AnyObject = msg_send![v, valueForKey: &*key];
                value.as_ref().is_none_or(|value| msg_send![value, boolValue])
            });
            Transparency {
                window_opaque,
                window_background_alpha,
                window_shadow,
                page_draws_background,
                snapshot: None,
                highest_alpha: 1.0,
                sampled: 0,
            }
        };
        let Some(view) = view else {
            done(flags);
            return;
        };
        let pending = RefCell::new(Some((done, flags)));
        let handler = block2::RcBlock::new(move |image: *mut AnyObject, _error: *mut AnyObject| {
            let Some((done, mut found)) = pending.borrow_mut().take() else { return };
            // SAFETY: the snapshot WebKit handed over, read on the main
            // thread inside its completion handler.
            unsafe {
                if let Some(image) = image.as_ref() {
                    read_pixels(image, &mut found);
                }
            }
            done(found);
        });
        // SAFETY: the panel's live WKWebView on the main thread; the
        // configuration's defaults take the whole page after its screen
        // updates.
        unsafe {
            let configuration: Retained<AnyObject> = msg_send![objc2::class!(WKSnapshotConfiguration), new];
            let _: () = msg_send![view, takeSnapshotWithConfiguration: &*configuration, completionHandler: &*handler];
        }
    }

    /// Read the snapshot's sampled pixels into `found`.
    unsafe fn read_pixels(image: &AnyObject, found: &mut Transparency) {
        let data: *mut AnyObject = msg_send![image, TIFFRepresentation];
        let Some(data) = data.as_ref() else { return };
        let rep: *mut AnyObject = msg_send![objc2::class!(NSBitmapImageRep), imageRepWithData: data];
        let Some(rep) = rep.as_ref() else { return };
        let width: isize = msg_send![rep, pixelsWide];
        let height: isize = msg_send![rep, pixelsHigh];
        let has_alpha: bool = msg_send![rep, hasAlpha];
        found.snapshot = Some((width, height, has_alpha));
        let mut highest: f64 = 0.0;
        let mut sampled = 0;
        for (x, y) in sample_points(width, height) {
            let color: *mut AnyObject = msg_send![rep, colorAtX: x, y: y];
            let alpha: f64 = color.as_ref().map_or(1.0, |color| msg_send![color, alphaComponent]);
            highest = highest.max(alpha);
            sampled += 1;
        }
        found.highest_alpha = highest;
        found.sampled = sampled;
    }

    /// The panel at rest: it passes every click and cannot take the
    /// keyboard.
    pub fn rest() {
        MENU_UP.store(false, Ordering::Relaxed);
        if let Some(window) = panel_window() {
            // SAFETY: the panel's live NSWindow on the main thread.
            unsafe {
                let _: () = msg_send![window, setIgnoresMouseEvents: true];
            }
        }
    }

    /// The panel is gone: no menu is up, and its window, if one is left,
    /// is closed and let go.
    pub fn forget_panel() {
        MENU_UP.store(false, Ordering::Relaxed);
        if PANEL.load(Ordering::Relaxed) == 0 {
            return;
        }
        if !on_main_thread() {
            log::warn!("menu panel: its window is closed on the main thread only, and stays");
            return;
        }
        let window = PANEL.swap(0, Ordering::Relaxed) as *mut AnyObject;
        // SAFETY: the pointer `adopt` stored of `Retained::into_raw`, taken
        // back once, on the main thread; `close` takes a window off the
        // screen, and one that was never on it is closed all the same.
        let closed = guarded("closing the panel's window", || unsafe {
            if let Some(window) = Retained::from_raw(window) {
                let _: () = msg_send![&*window, close];
            }
            Ok(())
        });
        if let Err(why) = closed {
            log::warn!("menu panel: {why}");
        }
    }

    /// Put the panel at `origin` in the frame `size`, in front, with the
    /// clicks and the keyboard; what AppKit says of it then (МО59). The
    /// frame is set while the panel's page is empty (МО29). A panel that is
    /// not on top goes back to rest.
    pub fn show(origin: ScreenPoint, size: MenuPanelSize) -> ShowReport {
        let Some(window) = panel_window() else { return ShowReport::default() };
        let Some(primary) = primary_height() else { return ShowReport::default() };
        let frame = super::frame_in_appkit(origin, size, primary);
        MENU_UP.store(true, Ordering::Relaxed);
        // SAFETY: the panel's live NSWindow on the main thread.
        let report = unsafe {
            let was: NSRect = msg_send![window, frame];
            let frame_changed = (was.size.width - frame.width).abs() > 0.5 || (was.size.height - frame.height).abs() > 0.5;
            let to = NSRect::new(NSPoint::new(frame.x, frame.y), NSSize::new(frame.width, frame.height));
            let _: () = msg_send![window, setFrame: to, display: false];
            let _: () = msg_send![window, setIgnoresMouseEvents: false];
            let _: () = msg_send![window, orderFrontRegardless];
            let _: () = msg_send![window, makeKeyWindow];
            let occlusion: usize = msg_send![window, occlusionState];
            let page = page_in_panel(window).map(|view| {
                let bounds: NSRect = msg_send![view, bounds];
                MenuPanelSize { width: bounds.size.width, height: bounds.size.height }
            });
            ShowReport {
                visible: msg_send![window, isVisible],
                on_active_space: msg_send![window, isOnActiveSpace],
                key: msg_send![window, isKeyWindow],
                unoccluded: occlusion & OCCLUSION_VISIBLE != 0,
                frame_changed,
                frame: size,
                page,
            }
        };
        if !report.on_top() {
            rest();
        }
        report
    }

    pub fn give_up_key() {
        if let Some(window) = panel_window() {
            // SAFETY: the panel's live NSWindow on the main thread.
            unsafe {
                let nothing: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![window, orderOut: nothing];
                let _: () = msg_send![window, orderFrontRegardless];
            }
        }
    }

    pub fn is_key() -> bool {
        panel_window().is_some_and(|window| {
            // SAFETY: a live NSWindow on the main thread.
            unsafe { msg_send![window, isKeyWindow] }
        })
    }

    /// Give `window` the keyboard; whether it has it now.
    pub fn make_key(window: &Window) -> bool {
        ns_window_of(window).is_some_and(|ns_window| {
            // SAFETY: a live NSWindow on the main thread.
            unsafe {
                let _: () = msg_send![ns_window, makeKeyWindow];
                msg_send![ns_window, isKeyWindow]
            }
        })
    }

    pub fn app_is_active() -> bool {
        // SAFETY: the shared application, on the main thread.
        unsafe {
            let application: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
            application.as_ref().is_some_and(|application| msg_send![application, isActive])
        }
    }

    /// No window of the app holds the keyboard, or the panel does.
    pub fn keyboard_is_unheld() -> bool {
        // SAFETY: the shared application, on the main thread.
        unsafe {
            let application: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
            let Some(application) = application.as_ref() else { return false };
            let key: *mut AnyObject = msg_send![application, keyWindow];
            key.is_null() || key as usize == PANEL.load(Ordering::Relaxed)
        }
    }

    pub fn look(window: &Window) -> WindowLook {
        let ns_window = ns_window_of(window);
        // SAFETY: live NSWindows on the main thread, public properties only
        // (МО63).
        unsafe {
            let main = ns_window.is_some_and(|w| msg_send![w, isMainWindow]);
            let key = ns_window.is_some_and(|w| msg_send![w, isKeyWindow]);
            WindowLook { main, key, panel_key: is_key(), app_active: app_is_active() }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::{Webview, WebviewWindow, Window};

    use super::{MenuPanelSize, Placed, ScreenPoint, ScreenRect, ShowReport, Transparency, WindowLook};

    pub fn on_main_thread() -> bool {
        false
    }
    pub fn anchor_on_screen(_webview: &Webview, _page: ScreenRect) -> Option<Placed> {
        None
    }
    pub fn configure(_panel: &WebviewWindow) -> Result<(), String> {
        Err("the menu panel is a macOS window".to_string())
    }
    pub fn watch(
        _on_outside: impl Fn() + 'static,
        _on_active: impl Fn() + 'static,
        _on_key_lost: impl Fn() + 'static,
    ) -> Result<(), String> {
        Err("the menu panel is a macOS window".to_string())
    }
    pub fn reveal() {}
    pub fn check_transparency(_panel: &WebviewWindow, done: impl FnOnce(Transparency) + 'static) {
        done(Transparency::unknown());
    }
    pub fn rest() {}
    pub fn forget_panel() {}
    pub fn show(_origin: ScreenPoint, _size: MenuPanelSize) -> ShowReport {
        ShowReport::default()
    }
    pub fn give_up_key() {}
    pub fn is_key() -> bool {
        false
    }
    pub fn make_key(_window: &Window) -> bool {
        false
    }
    pub fn app_is_active() -> bool {
        false
    }
    pub fn keyboard_is_unheld() -> bool {
        false
    }
    pub fn look(_window: &Window) -> WindowLook {
        WindowLook { main: false, key: false, panel_key: false, app_active: false }
    }
}

pub fn on_main_thread() -> bool {
    imp::on_main_thread()
}
pub fn anchor_on_screen(webview: &Webview, page: ScreenRect) -> Option<Placed> {
    imp::anchor_on_screen(webview, page)
}
pub fn configure(panel: &WebviewWindow) -> Result<(), String> {
    imp::configure(panel)
}
/// What `configure` does with no Tauri around it: make the panel's own
/// window where the NSWindow `shell` stands and move `shell`'s page, the
/// view `view`, into it (МО62). The window is not put on the screen.
/// `tests/menu_panel_window.rs` runs this on real AppKit objects.
///
/// # Errors
///
/// Why the panel's window could not be made whole; nothing of it is left
/// then.
#[cfg(target_os = "macos")]
pub fn adopt(shell: &objc2::runtime::AnyObject, view: &objc2::runtime::AnyObject) -> Result<(), String> {
    imp::adopt(shell, view)
}
pub fn watch(
    on_outside: impl Fn() + 'static,
    on_active: impl Fn() + 'static,
    on_key_lost: impl Fn() + 'static,
) -> Result<(), String> {
    imp::watch(on_outside, on_active, on_key_lost)
}
pub fn reveal() {
    imp::reveal();
}
pub fn check_transparency(panel: &WebviewWindow, done: impl FnOnce(Transparency) + 'static) {
    imp::check_transparency(panel, done);
}
/// Whether the NSWindow `window` and its WKWebView `view` are clear: the
/// panel's check for another clear window of the app (SPEC_OUTSIDE_WINDOW.md,
/// НО1). `done` runs once, on the main thread.
#[cfg(target_os = "macos")]
pub fn check_clearness(
    window: &objc2::runtime::AnyObject,
    view: &objc2::runtime::AnyObject,
    done: impl FnOnce(Transparency) + 'static,
) {
    imp::check_clearness(Some(window), Some(view), done);
}
pub fn rest() {
    imp::rest();
}
pub fn forget_panel() {
    imp::forget_panel();
}
pub fn show(origin: ScreenPoint, size: MenuPanelSize) -> ShowReport {
    imp::show(origin, size)
}
pub fn give_up_key() {
    imp::give_up_key();
}
pub fn is_key() -> bool {
    imp::is_key()
}
pub fn make_key(window: &Window) -> bool {
    imp::make_key(window)
}
pub fn app_is_active() -> bool {
    imp::app_is_active()
}
pub fn keyboard_is_unheld() -> bool {
    imp::keyboard_is_unheld()
}
pub fn look(window: &Window) -> WindowLook {
    imp::look(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_rectangles_land_on_the_screen_from_its_top_left() {
        let view = AppKitRect { x: 100.0, y: 200.0, width: 800.0, height: 600.0 };
        let anchor = page_rect_on_screen(view, ScreenRect { x: 10.0, y: 20.0, width: 24.0, height: 24.0 }, 900.0);
        assert_eq!(anchor, ScreenRect { x: 110.0, y: 120.0, width: 24.0, height: 24.0 });
    }

    #[test]
    fn screen_frames_and_points_turn_between_the_two_origins() {
        let above = AppKitRect { x: 0.0, y: 900.0, width: 1920.0, height: 1080.0 };
        assert_eq!(appkit_rect_on_screen(above, 900.0), ScreenRect { x: 0.0, y: -1080.0, width: 1920.0, height: 1080.0 });
        // A frame's origin in AppKit is its lower left corner.
        assert_eq!(
            frame_in_appkit(ScreenPoint { x: 50.0, y: 100.0 }, MenuPanelSize { width: 264.0, height: 300.0 }, 900.0),
            AppKitRect { x: 50.0, y: 500.0, width: 264.0, height: 300.0 },
        );
    }

    #[test]
    fn the_check_samples_the_whole_picture_corners_included() {
        let points = sample_points(1128, 858);
        assert_eq!(points.len(), 81);
        for corner in [(0, 0), (1127, 0), (0, 857), (1127, 857)] {
            assert!(points.contains(&corner));
        }
        assert!(sample_points(0, 10).is_empty());
    }

    fn clear() -> Transparency {
        Transparency {
            window_opaque: false,
            window_background_alpha: 0.0,
            window_shadow: false,
            page_draws_background: false,
            snapshot: Some((1128, 858, true)),
            highest_alpha: 0.0,
            sampled: 81,
        }
    }

    #[test]
    fn only_a_window_clear_by_every_flag_and_every_pixel_is_clear() {
        assert!(clear().clear());
        // The trial's first run: the page's root painted the theme's
        // background over the whole panel.
        assert!(!Transparency { highest_alpha: 1.0, ..clear() }.clear());
        assert!(!Transparency { snapshot: None, sampled: 0, ..clear() }.clear());
        assert!(!Transparency { snapshot: Some((10, 10, false)), ..clear() }.clear());
        assert!(!Transparency { window_opaque: true, ..clear() }.clear());
        assert!(!Transparency { window_background_alpha: 1.0, ..clear() }.clear());
        assert!(!Transparency { window_shadow: true, ..clear() }.clear());
        assert!(!Transparency { page_draws_background: true, ..clear() }.clear());
    }

    #[test]
    fn a_press_outside_an_open_menu_only_closes_it_and_reaches_no_window() {
        let mut guard = PressGuard::default();
        let left = MouseButton::Left;
        // The press closes the menu; by its drags and its release the menu
        // is closed already, and they still reach no window.
        assert_eq!(guard.judge(MouseStep::Down(left), true, false), PressVerdict::Dismiss);
        assert_eq!(guard.judge(MouseStep::Dragged(left), false, false), PressVerdict::Swallow);
        assert_eq!(guard.judge(MouseStep::Up(left), false, false), PressVerdict::Swallow);
        // The next press is the person's.
        assert_eq!(guard.judge(MouseStep::Down(left), false, false), PressVerdict::Pass);
        assert_eq!(guard.judge(MouseStep::Up(left), false, false), PressVerdict::Pass);
    }

    #[test]
    fn a_press_in_the_panel_and_a_press_with_no_menu_pass() {
        let mut guard = PressGuard::default();
        for button in [MouseButton::Left, MouseButton::Right, MouseButton::Other] {
            assert_eq!(guard.judge(MouseStep::Down(button), true, true), PressVerdict::Pass);
            assert_eq!(guard.judge(MouseStep::Up(button), true, true), PressVerdict::Pass);
            assert_eq!(guard.judge(MouseStep::Down(button), false, false), PressVerdict::Pass);
        }
        // The release of the press that opened the menu was never held.
        assert_eq!(guard.judge(MouseStep::Up(MouseButton::Right), true, false), PressVerdict::Pass);
    }

    #[test]
    fn each_button_is_held_on_its_own_and_the_wheel_scrolls_nothing_outside() {
        let mut guard = PressGuard::default();
        assert_eq!(guard.judge(MouseStep::Down(MouseButton::Right), true, false), PressVerdict::Dismiss);
        assert_eq!(guard.judge(MouseStep::Up(MouseButton::Left), false, false), PressVerdict::Pass);
        assert_eq!(guard.judge(MouseStep::Up(MouseButton::Right), false, false), PressVerdict::Swallow);
        assert_eq!(guard.judge(MouseStep::Wheel, true, false), PressVerdict::Swallow);
        assert_eq!(guard.judge(MouseStep::Wheel, true, true), PressVerdict::Pass);
        assert_eq!(guard.judge(MouseStep::Wheel, false, false), PressVerdict::Pass);
    }

    #[test]
    fn the_watch_hears_every_type_it_can_judge_and_no_other() {
        let mut mask = 0_u64;
        for event_type in 0..64_usize {
            if mouse_step(event_type).is_some() {
                mask |= 1 << event_type;
            }
        }
        assert_eq!(mask, WATCHED_EVENTS);
        // The pointer's moves pass unheard: `NSEventTypeMouseMoved` is 5.
        assert_eq!(mouse_step(5), None);
        assert_eq!(mouse_step(1), Some(MouseStep::Down(MouseButton::Left)));
        assert_eq!(mouse_step(26), Some(MouseStep::Up(MouseButton::Other)));
    }

    /// МО62а: the class of a window is set at its making only. AppKit and
    /// WebKit watch every window by KVO from its `init`; a window whose
    /// class changed under them crashed the app at its start (15.11.2026).
    #[test]
    fn no_living_window_changes_its_class() {
        let source = include_str!("native.rs");
        // The names are put together here, so this test is not what it
        // looks for.
        for forbidden in [["object_set", "Class"].concat(), ["set_", "class("].concat()] {
            assert!(!source.contains(&forbidden), "native.rs changes the class of a living object: {forbidden}");
        }
    }

    #[test]
    fn a_menu_is_on_top_when_it_is_seen_on_the_active_desktop_with_the_keyboard() {
        let frame = MenuPanelSize { width: 564.0, height: 332.0 };
        let shown = ShowReport {
            visible: true,
            on_active_space: true,
            key: true,
            unoccluded: false,
            frame_changed: true,
            frame,
            page: Some(frame),
        };
        // The occlusion state lags a move: it refuses nothing.
        assert!(shown.on_top());
        assert!(!ShowReport { visible: false, ..shown }.on_top());
        assert!(!ShowReport { on_active_space: false, ..shown }.on_top());
        assert!(!ShowReport { key: false, ..shown }.on_top());
        assert!(!ShowReport::default().on_top());
    }

    /// МО30а: a page that kept another size than the panel's frame would
    /// wait for its size forever and draw nothing (16.11.2026): the menu
    /// opens on the page at once, and the log names both sizes.
    #[test]
    fn a_page_that_did_not_take_the_frame_refuses_the_menu() {
        let frame = MenuPanelSize { width: 564.0, height: 332.0 };
        let shown = ShowReport { visible: true, on_active_space: true, key: true, unoccluded: true, frame_changed: true, frame, page: Some(frame) };
        let stuck = ShowReport { page: Some(MenuPanelSize { width: 264.0, height: 56.0 }), ..shown };
        assert!(!stuck.on_top());
        assert!(stuck.describe().ends_with("frame=564x332 page_view=264x56"), "{}", stuck.describe());
        assert!(!ShowReport { page: None, ..shown }.on_top());
    }
}
