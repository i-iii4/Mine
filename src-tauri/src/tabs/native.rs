//! What Tauri does not offer for tab pages on macOS (SPEC_TABS.md, В5, В25,
//! В26, В83): the layer order of two pages, a page without its own
//! background, the window's background colour, the title bar's height.

use tauri::{Webview, Window};

use crate::domain::windows::TitleBar;

/// A colour `#rrggbb` as three channels from 0 to 1.
pub fn parse_hex_color(hex: &str) -> Option<(f64, f64, f64)> {
    let digits = hex.strip_prefix('#')?;
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok().map(|v| f64::from(v) / 255.0);
    Some((channel(0)?, channel(2)?, channel(4)?))
}

/// `NSApplicationPresentationFullScreen`.
const PRESENTATION_FULL_SCREEN: usize = 1 << 10;
/// `NSApplicationPresentationAutoHideToolbar`.
const PRESENTATION_AUTO_HIDE_TOOLBAR: usize = 1 << 11;

/// The presentation a window takes in full screen (В83): the proposed one,
/// with the toolbar hidden until the pointer reaches the top of the screen,
/// together with the title bar. Otherwise AppKit keeps a toolbar on screen
/// in full screen, in its own window over the top of the content, and the
/// compact title bar's empty toolbar covers the tab bar's row (measured
/// 05.10.2026). The option is valid only with full screen, so any other
/// presentation passes unchanged.
pub fn full_screen_presentation(proposed: usize) -> usize {
    if proposed & PRESENTATION_FULL_SCREEN == 0 {
        proposed
    } else {
        proposed | PRESENTATION_AUTO_HIDE_TOOLBAR
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::OnceLock;

    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2_app_kit::{NSColor, NSView, NSWindow, NSWindowOrderingMode};
    use objc2_foundation::{NSNumber, NSString};
    use tauri::{Webview, Window};

    use crate::domain::windows::TitleBar;

    /// Put `lower` right under `upper` in their window: the page being shown
    /// draws its first frame under the one still visible (В5). Tauri has no
    /// API for the layer order (tauri #11124).
    pub fn order_below(upper: &Webview, lower: &Webview) {
        let lower = lower.clone();
        let _ = upper.with_webview(move |up| {
            let up_ptr = up.inner() as usize;
            let _ = lower.with_webview(move |low| {
                let low_ptr = low.inner() as usize;
                // SAFETY: both pointers are live WKWebViews: each closure runs
                // on the main thread while its webview exists.
                let up_view: &NSView = unsafe { &*(up_ptr as *const NSView) };
                let low_view: &NSView = unsafe { &*(low_ptr as *const NSView) };
                // SAFETY: reading the superview of a live view on the main thread.
                if let Some(superview) = unsafe { up_view.superview() } {
                    superview.addSubview_positioned_relativeTo(
                        low_view,
                        NSWindowOrderingMode::Below,
                        Some(up_view),
                    );
                }
            });
        });
    }

    /// Let the window's background show through `page` until its own
    /// content paints: a child webview's background colour is not applied
    /// on macOS, and without this a new page flashes white (В26).
    pub fn clear_page_background(page: &Webview) {
        let _ = page.with_webview(|view| {
            let ptr = view.inner() as usize;
            // SAFETY: a live WKWebView on the main thread; `drawsBackground`
            // is the key wry sets for transparent webviews.
            let object: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
            let no = NSNumber::new_bool(false);
            let key = NSString::from_str("drawsBackground");
            unsafe {
                let _: () = objc2::msg_send![object, setValue: &*no, forKey: &*key];
            }
        });
    }

    /// Whether `responder` is a page or a view inside one.
    unsafe fn inside_web_view(responder: &AnyObject) -> bool {
        let is_view: bool = objc2::msg_send![responder, isKindOfClass: objc2::class!(NSView)];
        if !is_view {
            return false;
        }
        let mut view: *const AnyObject = responder;
        while let Some(current) = view.as_ref() {
            let web: bool = objc2::msg_send![current, isKindOfClass: objc2::class!(WKWebView)];
            if web {
                return true;
            }
            let parent: *mut AnyObject = objc2::msg_send![current, superview];
            view = parent;
        }
        false
    }

    /// Give the keyboard to `page` unless a page of its window has it. A new
    /// window hands it to no page, and tao hands it back to the window's own
    /// view whenever the window's style changes (`set_style_mask`, tao
    /// 0.34.8 `util/mod.rs`); a shortcut the page listens for then goes
    /// nowhere until a click (measured 03.10.2026: `TaoView` held it in a
    /// window opened with ⌘N).
    pub fn keyboard_to_page(window: &Window, page: &Webview) {
        let window = window.clone();
        let page = page.clone();
        let _ = window.clone().run_on_main_thread(move || {
            let Ok(ptr) = window.ns_window() else {
                return;
            };
            // SAFETY: the live NSWindow of this window, on the main thread.
            let held = unsafe {
                let ns_window: &AnyObject = &*(ptr as *const AnyObject);
                let responder: *mut AnyObject = objc2::msg_send![ns_window, firstResponder];
                responder.as_ref().is_some_and(|responder| inside_web_view(responder))
            };
            if !held {
                let _ = page.set_focus();
            }
        });
    }

    /// `-[NSWindowDelegate window:willUseFullScreenPresentationOptions:]`.
    type PresentationOptions = unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject, usize) -> usize;

    /// tao's own answer to the presentation question, once Mine's answer
    /// stands in its place; `None` when tao gave none.
    static TAO_PRESENTATION: OnceLock<Option<Imp>> = OnceLock::new();

    /// Mine's answer: tao's, then the toolbar hidden in full screen.
    unsafe extern "C-unwind" fn presentation_options(
        this: &AnyObject,
        cmd: Sel,
        window: *mut AnyObject,
        proposed: usize,
    ) -> usize {
        let options = match TAO_PRESENTATION.get().copied().flatten() {
            // SAFETY: the implementation this one replaced, with the same
            // signature; it runs on the main thread as AppKit calls it there.
            Some(tao) => std::mem::transmute::<Imp, PresentationOptions>(tao)(this, cmd, window, proposed),
            None => proposed,
        };
        super::full_screen_presentation(options)
    }

    /// Let `window`'s toolbar hide in full screen (В83). AppKit asks the
    /// window's delegate for the presentation, and the delegate is tao's
    /// (`TaoWindowDelegate`), which returns the proposal for a window gone
    /// full screen by `toggleFullScreen:`; tao has no setting for it. Mine's
    /// answer takes the place of tao's in the delegate's class, once, and
    /// calls tao's first. The class is every Tauri window's, the settings
    /// window included, which has no toolbar: the option changes nothing
    /// there.
    pub fn hide_toolbar_in_full_screen(window: &Window) {
        let window = window.clone();
        let _ = window.clone().run_on_main_thread(move || {
            let Ok(ptr) = window.ns_window() else {
                return;
            };
            // SAFETY: the live NSWindow of this window, on the main thread;
            // its delegate lives as long as the window. The replacement has
            // the selector's signature, encoded "Q@:@Q", and the OnceLock
            // keeps it from replacing itself.
            unsafe {
                let ns_window: &AnyObject = &*(ptr as *const AnyObject);
                let delegate: *mut AnyObject = objc2::msg_send![ns_window, delegate];
                let Some(delegate) = delegate.as_ref() else {
                    log::warn!("a tab window has no delegate; its toolbar stays in full screen");
                    return;
                };
                let class: *const AnyClass = objc2::msg_send![delegate, class];
                TAO_PRESENTATION.get_or_init(|| {
                    let imp = std::mem::transmute::<PresentationOptions, Imp>(presentation_options);
                    objc2::ffi::class_replaceMethod(
                        class.cast_mut(),
                        objc2::sel!(window:willUseFullScreenPresentationOptions:),
                        imp,
                        c"Q@:@Q".as_ptr(),
                    )
                });
            }
        });
    }

    /// NSWindowToolbarStyleUnifiedCompact.
    const TOOLBAR_STYLE_UNIFIED_COMPACT: isize = 4;

    /// Give `window` the title bar `title_bar` (В83). The compact one is an
    /// empty toolbar that exists only because its style sets the title bar's
    /// height; AppKit places the traffic lights from that height itself, so
    /// nothing in the title bar is moved by hand and nothing fights AppKit's
    /// layout during a live resize.
    pub fn set_title_bar(window: &Window, title_bar: TitleBar) {
        let window = window.clone();
        let _ = window.clone().run_on_main_thread(move || {
            let Ok(ptr) = window.ns_window() else {
                return;
            };
            // SAFETY: the live NSWindow of this window, on the main thread.
            unsafe {
                let ns_window: &AnyObject = &*(ptr as *const AnyObject);
                match title_bar {
                    TitleBar::Standard => {
                        let _: () = objc2::msg_send![ns_window, setToolbar: std::ptr::null::<AnyObject>()];
                    }
                    TitleBar::Compact => {
                        let current: *mut AnyObject = objc2::msg_send![ns_window, toolbar];
                        if current.is_null() {
                            let identifier = NSString::from_str("mine.title-bar");
                            let allocated: Allocated<AnyObject> =
                                objc2::msg_send![objc2::class!(NSToolbar), alloc];
                            let toolbar: Retained<AnyObject> =
                                objc2::msg_send![allocated, initWithIdentifier: &*identifier];
                            let _: () = objc2::msg_send![&*toolbar, setAllowsUserCustomization: false];
                            let _: () = objc2::msg_send![ns_window, setToolbar: &*toolbar];
                        }
                        let _: () =
                            objc2::msg_send![ns_window, setToolbarStyle: TOOLBAR_STYLE_UNIFIED_COMPACT];
                    }
                }
            }
        });
    }

    /// Paint the window's background `rgb`: what shows before a page draws.
    pub fn set_window_background(window: &Window, rgb: (f64, f64, f64)) {
        let window = window.clone();
        let _ = window.clone().run_on_main_thread(move || {
            let Ok(ptr) = window.ns_window() else {
                return;
            };
            // SAFETY: Tauri hands out the live NSWindow of this window, used
            // on the main thread.
            let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            let color = NSColor::colorWithSRGBRed_green_blue_alpha(rgb.0, rgb.1, rgb.2, 1.0);
            ns_window.setBackgroundColor(Some(&color));
        });
    }
}

#[cfg(target_os = "macos")]
mod pressure {
    use std::ffi::c_void;

    /// `DISPATCH_MEMORYPRESSURE_WARN | DISPATCH_MEMORYPRESSURE_CRITICAL`.
    const WARN_AND_CRITICAL: usize = 0x02 | 0x04;
    /// `QOS_CLASS_UTILITY`: the handler does little and can wait a moment.
    const UTILITY_QUEUE: isize = 0x11;

    extern "C" {
        static _dispatch_source_type_memorypressure: c_void;
        fn dispatch_get_global_queue(identifier: isize, flags: usize) -> *mut c_void;
        fn dispatch_source_create(
            kind: *const c_void,
            handle: usize,
            mask: usize,
            queue: *mut c_void,
        ) -> *mut c_void;
        fn dispatch_source_set_event_handler(source: *mut c_void, handler: &block2::DynBlock<dyn Fn()>);
        fn dispatch_resume(object: *mut c_void);
    }

    /// Call `handler` whenever the system reports memory pressure at the
    /// warning level or above (В39). The source lives for the process.
    pub fn on_memory_pressure(handler: impl Fn() + Send + 'static) {
        let block = block2::RcBlock::new(handler);
        // SAFETY: the documented libdispatch calls; the source is never
        // released, so the handler it copied stays valid for the process.
        unsafe {
            let queue = dispatch_get_global_queue(UTILITY_QUEUE, 0);
            let source = dispatch_source_create(
                std::ptr::addr_of!(_dispatch_source_type_memorypressure),
                0,
                WARN_AND_CRITICAL,
                queue,
            );
            if source.is_null() {
                log::warn!("memory pressure source is unavailable");
                return;
            }
            dispatch_source_set_event_handler(source, &block);
            dispatch_resume(source);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod pressure {
    pub fn on_memory_pressure(_handler: impl Fn() + Send + 'static) {}
}

/// See the platform implementation.
pub fn on_memory_pressure(handler: impl Fn() + Send + 'static) {
    pressure::on_memory_pressure(handler);
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::{Webview, Window};

    use crate::domain::windows::TitleBar;

    pub fn order_below(_upper: &Webview, _lower: &Webview) {}
    pub fn clear_page_background(_page: &Webview) {}
    pub fn keyboard_to_page(_window: &Window, _page: &Webview) {}
    pub fn set_window_background(_window: &Window, _rgb: (f64, f64, f64)) {}
    pub fn set_title_bar(_window: &Window, _title_bar: TitleBar) {}
    pub fn hide_toolbar_in_full_screen(_window: &Window) {}
}

/// See the platform implementation.
pub fn order_below(upper: &Webview, lower: &Webview) {
    imp::order_below(upper, lower);
}

/// See the platform implementation.
pub fn clear_page_background(page: &Webview) {
    imp::clear_page_background(page);
}

/// Give `window` the title bar `title_bar`, which places its traffic lights.
pub fn set_title_bar(window: &Window, title_bar: TitleBar) {
    imp::set_title_bar(window, title_bar);
}

/// Let `window`'s toolbar hide in full screen with the title bar, so the
/// tab bar keeps the top of the screen (`full_screen_presentation`).
pub fn hide_toolbar_in_full_screen(window: &Window) {
    imp::hide_toolbar_in_full_screen(window);
}

/// Give the keyboard to `page` unless a page of `window` has it.
pub fn keyboard_to_page(window: &Window, page: &Webview) {
    imp::keyboard_to_page(window, page);
}

/// Paint `window`'s background with `hex` (`#rrggbb`); an unreadable colour
/// leaves the system background.
pub fn set_window_background(window: &Window, hex: &str) {
    if let Some(rgb) = parse_hex_color(hex) {
        imp::set_window_background(window, rgb);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        full_screen_presentation, parse_hex_color, PRESENTATION_AUTO_HIDE_TOOLBAR, PRESENTATION_FULL_SCREEN,
    };

    /// `NSApplicationPresentationAutoHideDock`.
    const AUTO_HIDE_DOCK: usize = 1 << 0;
    /// `NSApplicationPresentationAutoHideMenuBar`.
    const AUTO_HIDE_MENU_BAR: usize = 1 << 2;
    /// `NSApplicationPresentationHideMenuBar`.
    const HIDE_MENU_BAR: usize = 1 << 3;

    #[test]
    fn full_screen_hides_the_toolbar_with_the_menu_bar() {
        let proposed = PRESENTATION_FULL_SCREEN | AUTO_HIDE_MENU_BAR | AUTO_HIDE_DOCK;
        assert_eq!(full_screen_presentation(proposed), proposed | PRESENTATION_AUTO_HIDE_TOOLBAR);
        // A menu bar that never shows keeps the proposal's other choices.
        let hidden = PRESENTATION_FULL_SCREEN | HIDE_MENU_BAR;
        assert_eq!(full_screen_presentation(hidden), hidden | PRESENTATION_AUTO_HIDE_TOOLBAR);
    }

    #[test]
    fn a_presentation_without_full_screen_passes_unchanged() {
        assert_eq!(full_screen_presentation(0), 0);
        let menu = AUTO_HIDE_MENU_BAR | AUTO_HIDE_DOCK;
        assert_eq!(full_screen_presentation(menu), menu);
    }

    #[test]
    fn asking_twice_changes_nothing() {
        let once = full_screen_presentation(PRESENTATION_FULL_SCREEN | AUTO_HIDE_MENU_BAR);
        assert_eq!(full_screen_presentation(once), once);
    }

    #[test]
    fn colours_parse_from_hex() {
        assert_eq!(parse_hex_color("#ff0000"), Some((1.0, 0.0, 0.0)));
        assert_eq!(parse_hex_color("#000000"), Some((0.0, 0.0, 0.0)));
        assert_eq!(parse_hex_color("ff0000"), None);
        assert_eq!(parse_hex_color("#ff00"), None);
        assert_eq!(parse_hex_color("#gg0000"), None);
    }
}
