//! The outside window's AppKit side (SPEC_OUTSIDE_WINDOW.md, НО1 to НО4):
//! the flags that make it clear, keyboardless and transparent to the mouse,
//! its level for each use, its frame, and the watch over what takes the app
//! window away from under it.
//!
//! The window is an ordinary Tauri window made `focusable(false)`: tao then
//! answers "no" to `canBecomeKeyWindow` and `canBecomeMainWindow` for it, so
//! no class of its own is needed and none is changed (МО62а). What it needs
//! besides is set through the public setters of NSWindow, as the tab windows'
//! background is (`tabs/native.rs`). Its page is Tauri's own, which Tauri
//! sizes with the window (МО30а does not arise).
//!
//! What is not public API here is the menu panel's (МО64, МО65): the key
//! `drawsBackground` of WKWebView and `_setWindowOcclusionDetectionEnabled:`,
//! the latter sent only to a view that answers it.
//!
//! Everything here but the pure functions runs on the main thread.

use tauri::WebviewWindow;

use crate::menu_panel::geometry::{ScreenPoint, ScreenRect};
use crate::menu_panel::native::Transparency;

/// What the outside window is drawing now, and so where it stands among the
/// windows (НО4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutsideUse {
    /// The hover preview window: above every window, under the menus.
    Preview,
    /// The dragged card: where the system draws a dragged thing.
    Drag,
}

/// `NSFloatingWindowLevel`: above every ordinary window of every app, below
/// the menu panel's `NSPopUpMenuWindowLevel` (101), so a menu lies over a
/// preview it was opened beside (ПН10).
pub const PREVIEW_LEVEL: isize = 3;
/// `kCGDraggingWindowLevel`: the level the system draws a dragged thing at,
/// above the menu bar and the Dock (ПК1).
pub const DRAG_LEVEL: isize = 500;

/// The window level of each use.
pub fn level_of(what: OutsideUse) -> isize {
    match what {
        OutsideUse::Preview => PREVIEW_LEVEL,
        OutsideUse::Drag => DRAG_LEVEL,
    }
}

/// What AppKit says of the outside window after it was dressed: every one of
/// them must hold, or the window is not used (НО9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dressed {
    pub opaque: bool,
    pub ignores_mouse: bool,
    pub can_become_key: bool,
    pub can_become_main: bool,
    pub has_shadow: bool,
}

impl Dressed {
    pub fn holds(&self) -> bool {
        !self.opaque && self.ignores_mouse && !self.can_become_key && !self.can_become_main && !self.has_shadow
    }

    pub fn describe(&self) -> String {
        format!(
            "opaque={} ignores_mouse={} can_become_key={} can_become_main={} has_shadow={}",
            self.opaque, self.ignores_mouse, self.can_become_key, self.can_become_main, self.has_shadow
        )
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::panic::AssertUnwindSafe;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSNumber, NSPoint, NSRect, NSSize, NSString};
    use tauri::WebviewWindow;

    use super::{level_of, Dressed, OutsideUse, ScreenPoint, ScreenRect};

    /// `CanJoinAllSpaces | Transient | IgnoresCycle | FullScreenAuxiliary`,
    /// as the menu panel's (МО55).
    const COLLECTION_BEHAVIOR: usize = (1 << 0) | (1 << 3) | (1 << 6) | (1 << 8);
    /// `NSWindowAnimationBehaviorNone`.
    const ANIMATION_NONE: isize = 2;

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSApplicationDidHideNotification: &'static NSString;
        static NSApplicationDidChangeScreenParametersNotification: &'static NSString;
        static NSWindowDidMiniaturizeNotification: &'static NSString;
        static NSWorkspaceActiveSpaceDidChangeNotification: &'static NSString;
    }

    /// Run `run`, a part of AppKit's work on the window: what Objective-C
    /// throws in it comes back as an error and goes no further.
    fn guarded<R>(what: &str, run: impl FnOnce() -> Result<R, String>) -> Result<R, String> {
        // `AssertUnwindSafe`: after a throw the caller lets the window go
        // and reads nothing the closure left half done.
        match objc2::exception::catch(AssertUnwindSafe(run)) {
            Ok(done) => done,
            Err(Some(thrown)) => Err(format!("{what}: AppKit threw {thrown}")),
            Err(None) => Err(format!("{what}: AppKit threw an exception with no object")),
        }
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

    pub fn ns_window_of(window: &WebviewWindow) -> Option<&'static AnyObject> {
        let ptr = window.ns_window().ok()?;
        // SAFETY: the live NSWindow of a Tauri window, used on the main
        // thread while the window exists.
        unsafe { (ptr as *const AnyObject).as_ref() }
    }

    pub fn web_view_of(window: &WebviewWindow) -> Option<&'static AnyObject> {
        let found = Arc::new(AtomicUsize::new(0));
        let inside = Arc::clone(&found);
        let _ = window.with_webview(move |view| inside.store(view.inner() as usize, Ordering::Relaxed));
        // SAFETY: a live WKWebView, read on the main thread while its page
        // exists; Tauri runs the closure at once on the main thread.
        unsafe { (found.load(Ordering::Relaxed) as *const AnyObject).as_ref() }
    }

    pub fn dress(window: &AnyObject, view: &AnyObject) -> Result<Dressed, String> {
        guarded("dressing the outside window", || {
            // SAFETY: a live NSWindow and its WKWebView on the main thread;
            // every message is a public setter of NSWindow but the two of
            // WKWebView named in the module's comment.
            unsafe {
                let _: () = msg_send![window, setAlphaValue: 0.0_f64];
                let clear: *mut AnyObject = msg_send![objc2::class!(NSColor), clearColor];
                let _: () = msg_send![window, setOpaque: false];
                let _: () = msg_send![window, setBackgroundColor: clear];
                // The page draws the shadow, which moves with what it draws.
                let _: () = msg_send![window, setHasShadow: false];
                let _: () = msg_send![window, setIgnoresMouseEvents: true];
                let _: () = msg_send![window, setLevel: level_of(OutsideUse::Preview)];
                let _: () = msg_send![window, setCollectionBehavior: COLLECTION_BEHAVIOR];
                let _: () = msg_send![window, setExcludedFromWindowsMenu: true];
                let _: () = msg_send![window, setHidesOnDeactivate: false];
                let _: () = msg_send![window, setAnimationBehavior: ANIMATION_NONE];
                let no = NSNumber::new_bool(false);
                let key = NSString::from_str("drawsBackground");
                let _: () = msg_send![view, setValue: &*no, forKey: &*key];
                let occlusion: bool = msg_send![view, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)];
                if occlusion {
                    let _: () = msg_send![view, _setWindowOcclusionDetectionEnabled: false];
                } else {
                    log::warn!(
                        "outside window: WKWebView does not answer _setWindowOcclusionDetectionEnabled:, occlusion detection is left on; a page WebKit counts as hidden draws nothing, and the preview then stays in the app window"
                    );
                }
                Ok(dressed(window))
            }
        })
    }

    pub fn dressed(window: &AnyObject) -> Dressed {
        // SAFETY: a live NSWindow read on the main thread.
        unsafe {
            Dressed {
                opaque: msg_send![window, isOpaque],
                ignores_mouse: msg_send![window, ignoresMouseEvents],
                can_become_key: msg_send![window, canBecomeKeyWindow],
                can_become_main: msg_send![window, canBecomeMainWindow],
                has_shadow: msg_send![window, hasShadow],
            }
        }
    }

    pub fn order_in(window: &AnyObject) -> Result<(), String> {
        guarded("putting the outside window on the screen", || {
            // SAFETY: a live NSWindow on the main thread. Ordered in, not
            // made key: it cannot be.
            unsafe {
                let _: () = msg_send![window, orderFrontRegardless];
            }
            Ok(())
        })
    }

    pub fn reveal(window: &AnyObject) {
        // SAFETY: a live NSWindow on the main thread.
        unsafe {
            let _: () = msg_send![window, setAlphaValue: 1.0_f64];
        }
    }

    pub fn place(window: &AnyObject, frame: ScreenRect, what: OutsideUse) -> Result<(), String> {
        let primary = primary_height().ok_or("no screen")?;
        guarded("placing the outside window", || {
            let to = NSRect::new(
                NSPoint::new(frame.x, primary - (frame.y + frame.height)),
                NSSize::new(frame.width, frame.height),
            );
            // SAFETY: a live NSWindow on the main thread.
            unsafe {
                let _: () = msg_send![window, setLevel: level_of(what)];
                let _: () = msg_send![window, setFrame: to, display: false];
            }
            Ok(())
        })
    }

    pub fn move_to(window: &AnyObject, origin: ScreenPoint, height: f64) {
        let Some(primary) = primary_height() else { return };
        // SAFETY: a live NSWindow on the main thread; only its origin moves.
        unsafe {
            let _: () = msg_send![window, setFrameOrigin: NSPoint::new(origin.x, primary - (origin.y + height))];
        }
    }

    pub fn cursor() -> Option<ScreenPoint> {
        let primary = primary_height()?;
        // SAFETY: a class message of AppKit on the main thread.
        let at: NSPoint = unsafe { msg_send![objc2::class!(NSEvent), mouseLocation] };
        Some(ScreenPoint { x: at.x, y: primary - at.y })
    }

    pub fn tallest_screen() -> Option<f64> {
        // SAFETY: class messages of AppKit on the main thread.
        unsafe {
            let screens: *mut AnyObject = msg_send![objc2::class!(NSScreen), screens];
            let screens = screens.as_ref()?;
            let count: usize = msg_send![screens, count];
            (0..count)
                .filter_map(|index| {
                    let screen: *mut AnyObject = msg_send![screens, objectAtIndex: index];
                    let frame: NSRect = msg_send![screen.as_ref()?, frame];
                    Some(frame.size.height)
                })
                .reduce(f64::max)
        }
    }

    pub fn window_at(point: ScreenPoint, below: isize) -> isize {
        let Some(primary) = primary_height() else { return 0 };
        // SAFETY: a class message of NSWindow on the main thread; it reads
        // the window server's order, every app's windows among it.
        unsafe {
            msg_send![
                objc2::class!(NSWindow),
                windowNumberAtPoint: NSPoint::new(point.x, primary - point.y),
                belowWindowWithWindowNumber: below
            ]
        }
    }

    pub fn number_and_frame(window: &AnyObject) -> Option<(isize, ScreenRect)> {
        let primary = primary_height()?;
        // SAFETY: a live NSWindow read on the main thread.
        unsafe {
            let number: isize = msg_send![window, windowNumber];
            let frame: NSRect = msg_send![window, frame];
            Some((
                number,
                ScreenRect {
                    x: frame.origin.x,
                    y: primary - (frame.origin.y + frame.size.height),
                    width: frame.size.width,
                    height: frame.size.height,
                },
            ))
        }
    }

    pub fn tauri_ns_window(window: &tauri::Window) -> Option<&'static AnyObject> {
        let ptr = window.ns_window().ok()?;
        // SAFETY: the live NSWindow of a Tauri window, used on the main
        // thread while the window exists.
        unsafe { (ptr as *const AnyObject).as_ref() }
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

    pub fn watch(on_lost: impl Fn() + 'static) {
        let run: Rc<dyn Fn()> = Rc::new(on_lost);
        // SAFETY: the default centres, read on the main thread.
        unsafe {
            let app_center: *mut AnyObject = msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
            let workspace: *mut AnyObject = msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
            let space_center: *mut AnyObject = workspace.as_ref().map_or(std::ptr::null_mut(), |w| msg_send![w, notificationCenter]);
            if let Some(center) = app_center.as_ref() {
                observe(center, NSApplicationDidHideNotification, Rc::clone(&run));
                observe(center, NSApplicationDidChangeScreenParametersNotification, Rc::clone(&run));
                observe(center, NSWindowDidMiniaturizeNotification, Rc::clone(&run));
            }
            if let Some(center) = space_center.as_ref() {
                observe(center, NSWorkspaceActiveSpaceDidChangeNotification, run);
            }
        }
    }
}

/// Dress the Tauri window `window`, made `focusable(false)`, as the outside
/// window: clear, without a shadow, transparent to the mouse, on every space,
/// at the preview's level, unseen until `reveal_window`; what AppKit says of
/// it then.
///
/// # Errors
///
/// No NSWindow or page, or AppKit threw while it was dressed.
pub fn dress_window(window: &WebviewWindow) -> Result<Dressed, String> {
    #[cfg(target_os = "macos")]
    {
        let ns_window = imp::ns_window_of(window).ok_or("no NSWindow")?;
        let view = imp::web_view_of(window).ok_or("no WKWebView")?;
        imp::dress(ns_window, view)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("the outside window is a macOS window".to_string())
    }
}

/// Put the window on the screen, unseen while its alpha is 0.
///
/// # Errors
///
/// No NSWindow, or AppKit threw.
pub fn order_in_window(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::order_in(imp::ns_window_of(window).ok_or("no NSWindow")?)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("the outside window is a macOS window".to_string())
    }
}

/// The window found clear may be seen.
pub fn reveal_window(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    if let Some(ns_window) = imp::ns_window_of(window) {
        imp::reveal(ns_window);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// Set the window's level for `what` and its frame to `frame`, in points
/// from the main screen's top left.
///
/// # Errors
///
/// No NSWindow or screen, or AppKit threw.
pub fn place_window(window: &WebviewWindow, frame: ScreenRect, what: OutsideUse) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::place(imp::ns_window_of(window).ok_or("no NSWindow")?, frame, what)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, frame, what);
        Err("the outside window is a macOS window".to_string())
    }
}

/// Move the window's top left corner to `origin`, in points from the main
/// screen's top left, its frame `height` tall: the dragged card follows the
/// pointer in the handler of the pointer's move (ПК3).
pub fn move_window(window: &WebviewWindow, origin: ScreenPoint, height: f64) {
    #[cfg(target_os = "macos")]
    if let Some(ns_window) = imp::ns_window_of(window) {
        imp::move_to(ns_window, origin, height);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, origin, height);
}

/// The pointer, in points from the main screen's top left.
pub fn cursor() -> Option<ScreenPoint> {
    #[cfg(target_os = "macos")]
    {
        imp::cursor()
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// The height of the tallest screen, in points.
pub fn tallest_screen() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        imp::tallest_screen()
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// The number of the topmost window of any app at `point` under the window
/// numbered `below` (`windowNumberAtPoint:belowWindowWithWindowNumber:`), or
/// 0 for none.
pub fn window_at(point: ScreenPoint, below: isize) -> isize {
    #[cfg(target_os = "macos")]
    {
        imp::window_at(point, below)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (point, below);
        0
    }
}

/// A Tauri window's number in the window server and its frame in points.
pub fn number_and_frame(window: &tauri::Window) -> Option<(isize, ScreenRect)> {
    #[cfg(target_os = "macos")]
    {
        imp::number_and_frame(imp::tauri_ns_window(window)?)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        None
    }
}

/// The outside window's number in the window server.
pub fn number_of(window: &WebviewWindow) -> Option<isize> {
    #[cfg(target_os = "macos")]
    {
        imp::number_and_frame(imp::ns_window_of(window)?).map(|(number, _)| number)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        None
    }
}

/// Whether the window and its page are clear: the menu panel's check
/// (МО32). `done` runs once, on the main thread.
pub fn check_window_clear(window: &WebviewWindow, done: impl FnOnce(Transparency) + 'static) {
    #[cfg(target_os = "macos")]
    {
        match (imp::ns_window_of(window), imp::web_view_of(window)) {
            (Some(ns_window), Some(view)) => crate::menu_panel::native::check_clearness(ns_window, view, done),
            _ => done(Transparency::unknown()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        done(Transparency::unknown());
    }
}

/// `on_lost` runs when what the window stands over may have gone: the app
/// hidden, a window minimized, the screens changed, another space (ПН9).
pub fn watch(on_lost: impl Fn() + 'static) {
    #[cfg(target_os = "macos")]
    imp::watch(on_lost);
    #[cfg(not(target_os = "macos"))]
    let _ = on_lost;
}

/// The window parts with no Tauri around them, for `tests/outside_window.rs`:
/// a window tao made, with a page in it (SPEC_OUTSIDE_WINDOW.md, НО4; the risk
/// of `setOpaque:` on a window AppKit and WebKit watch by KVO, МО62а).
#[cfg(target_os = "macos")]
pub mod window {
    pub use crate::menu_panel::geometry::ScreenRect;

    pub use super::OutsideUse;
    use super::Dressed;

    /// Dress the NSWindow `window` and its WKWebView `view`.
    ///
    /// # Errors
    ///
    /// AppKit threw while the window was dressed.
    pub fn dress(window: &objc2::runtime::AnyObject, view: &objc2::runtime::AnyObject) -> Result<Dressed, String> {
        super::imp::dress(window, view)
    }

    /// What AppKit says of `window` now.
    pub fn dressed(window: &objc2::runtime::AnyObject) -> Dressed {
        super::imp::dressed(window)
    }

    /// Set `window`'s level for `what` and its frame.
    ///
    /// # Errors
    ///
    /// No screen, or AppKit threw.
    pub fn place(window: &objc2::runtime::AnyObject, frame: ScreenRect, what: OutsideUse) -> Result<(), String> {
        super::imp::place(window, frame, what)
    }

    pub use super::{DRAG_LEVEL, PREVIEW_LEVEL};
}
