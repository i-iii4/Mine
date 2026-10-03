//! What Tauri does not offer for tab pages on macOS (SPEC_TABS.md, В5, В25,
//! В26): the layer order of two pages, a page without its own background,
//! the window's background colour.

use tauri::{Webview, Window};

/// A colour `#rrggbb` as three channels from 0 to 1.
pub fn parse_hex_color(hex: &str) -> Option<(f64, f64, f64)> {
    let digits = hex.strip_prefix('#')?;
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok().map(|v| f64::from(v) / 255.0);
    Some((channel(0)?, channel(2)?, channel(4)?))
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSColor, NSView, NSWindow, NSWindowOrderingMode};
    use objc2_foundation::{NSArray, NSNumber, NSPoint, NSRect, NSString};
    use tauri::{Webview, Window};

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

    /// Where a window's traffic lights stand (В83): the row they sit in the
    /// middle of, and the system's step between two buttons, read once
    /// before anything moves them.
    struct TrafficLights {
        row: u32,
        spacing: f64,
    }

    /// Each window's traffic lights, by its NSWindow.
    static TRAFFIC_LIGHTS: Mutex<Vec<(usize, TrafficLights)>> = Mutex::new(Vec::new());

    fn traffic_lights(ns_window: usize) -> Option<(f64, f64)> {
        let lights = TRAFFIC_LIGHTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        lights
            .iter()
            .find(|(window, _)| *window == ns_window)
            .map(|(_, lights)| (f64::from(lights.row), lights.spacing))
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

    /// Each window's frame observers, by window label, retained.
    static OBSERVERS: Mutex<Vec<(String, usize)>> = Mutex::new(Vec::new());

    /// NSWindowStyleMaskFullScreen.
    const FULL_SCREEN_STYLE: usize = 1 << 14;

    /// Windows whose traffic lights are waiting to be put back.
    static PENDING: Mutex<Vec<usize>> = Mutex::new(Vec::new());

    /// The view holding the traffic lights: the close button's superview's
    /// superview, the title bar container.
    unsafe fn title_bar_container(ns_window: &AnyObject) -> Option<&AnyObject> {
        // NSWindowCloseButton.
        let close: *mut AnyObject = objc2::msg_send![ns_window, standardWindowButton: 0usize];
        let title_bar: *mut AnyObject = objc2::msg_send![close.as_ref()?, superview];
        let container: *mut AnyObject = objc2::msg_send![title_bar.as_ref()?, superview];
        container.as_ref()
    }

    /// The close, minimise and zoom buttons, in their order.
    unsafe fn window_buttons(ns_window: &AnyObject) -> [Option<&AnyObject>; 3] {
        [0usize, 1, 2].map(|kind| {
            let button: *mut AnyObject = objc2::msg_send![ns_window, standardWindowButton: kind];
            button.as_ref()
        })
    }

    /// The system's step between two buttons, where it laid them out.
    unsafe fn system_spacing(ns_window: &AnyObject) -> Option<f64> {
        let [Some(close), Some(minimise), _] = window_buttons(ns_window) else {
            return None;
        };
        let close: NSRect = objc2::msg_send![close, frame];
        let minimise: NSRect = objc2::msg_send![minimise, frame];
        Some(minimise.origin.x - close.origin.x)
    }

    /// Put the traffic lights of the window `key` in the middle of its row,
    /// as far from its left edge as from its top, the system's step apart.
    /// Only the buttons move: each is set to its point measured from the
    /// window's top, whatever height AppKit gives their view, and the point
    /// follows from the row and the step alone, so a second pass changes
    /// nothing. Full screen is the system's: its title bar drops in its own
    /// window, and the lights there stay where AppKit puts them.
    unsafe fn place(key: usize) {
        let Some((row, spacing)) = traffic_lights(key) else {
            return;
        };
        // SAFETY: a window in the registry is alive: `release` takes it out
        // on the main thread before the window goes, and this runs there.
        let ns_window: &AnyObject = &*(key as *const AnyObject);
        let style: usize = objc2::msg_send![ns_window, styleMask];
        if style & FULL_SCREEN_STYLE != 0 {
            return;
        }
        let window: NSRect = objc2::msg_send![ns_window, frame];
        for (index, button) in window_buttons(ns_window).into_iter().enumerate() {
            let Some(button) = button else {
                continue;
            };
            let parent: *mut AnyObject = objc2::msg_send![button, superview];
            let Some(parent) = parent.as_ref() else {
                continue;
            };
            let frame: NSRect = objc2::msg_send![button, frame];
            let bounds: NSRect = objc2::msg_send![parent, bounds];
            let in_window: NSRect =
                objc2::msg_send![parent, convertRect: bounds, toView: std::ptr::null::<AnyObject>()];
            let flipped: bool = objc2::msg_send![parent, isFlipped];
            // The gap above the button inside its view, for a gap of `inset`
            // above it in the window.
            let inset = ((row - frame.size.height) / 2.0).max(0.0);
            let view_top = window.size.height - (in_window.origin.y + in_window.size.height);
            let gap = inset - view_top;
            #[allow(clippy::cast_precision_loss)]
            let x = inset + index as f64 * spacing;
            let y = if flipped { gap } else { bounds.size.height - gap - frame.size.height };
            if (frame.origin.x - x).abs() >= 0.5 || (frame.origin.y - y).abs() >= 0.5 {
                let _: () = objc2::msg_send![button, setFrameOrigin: NSPoint::new(x, y)];
            }
        }
    }

    /// Put the traffic lights back once the AppKit pass that moved them
    /// returns. AppKit sets the buttons one by one (`-[NSThemeFrame
    /// _updateButtonPositions]`) and ignores a move of the button it is
    /// setting (`setFrameOrigin:ignoreRentry:`); a move made inside the frame
    /// notification is lost for that button and undone for the ones not set
    /// yet (stack and frames measured 03.10.2026). The main run loop runs
    /// the block right after, in every mode, live resize included; several
    /// notifications of one pass make one placement.
    unsafe fn place_after_appkit(key: usize) {
        {
            let mut pending = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if pending.contains(&key) {
                return;
            }
            pending.push(key);
        }
        let block = block2::RcBlock::new(move || {
            PENDING
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .retain(|pending| *pending != key);
            place(key);
        });
        let run_loop: *mut AnyObject = objc2::msg_send![objc2::class!(NSRunLoop), mainRunLoop];
        let Some(run_loop) = run_loop.as_ref() else {
            return;
        };
        let modes = NSArray::from_retained_slice(&[NSString::from_str("kCFRunLoopCommonModes")]);
        let _: () = objc2::msg_send![run_loop, performInModes: &*modes, block: &*block];
    }

    /// Keep `window`'s traffic lights in the middle of the tab bar's row.
    /// AppKit lays the title bar out again on resize, focus, full screen and
    /// more; each time it moves the container or a button, their frame
    /// notifications put them back once it is done.
    pub fn keep_traffic_lights(window: &Window, row_height: u32) {
        let label = window.label().to_string();
        let window = window.clone();
        let _ = window.clone().run_on_main_thread(move || {
            let Ok(ptr) = window.ns_window() else {
                return;
            };
            let key = ptr as usize;
            // SAFETY: the live NSWindow of this window, on the main thread.
            // The observers are removed when the window goes (`release`), and
            // the views they watch belong to the window, so the block never
            // runs for a window that is gone.
            unsafe {
                let ns_window: &AnyObject = &*(ptr as *const AnyObject);
                let Some(spacing) = system_spacing(ns_window) else {
                    return;
                };
                {
                    let mut lights = TRAFFIC_LIGHTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    lights.retain(|(window, _)| *window != key);
                    lights.push((key, TrafficLights { row: row_height, spacing }));
                }
                place(key);
                let Some(container) = title_bar_container(ns_window) else {
                    return;
                };
                let center: *mut AnyObject =
                    objc2::msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
                let Some(center) = center.as_ref() else {
                    return;
                };
                let name = NSString::from_str("NSViewFrameDidChangeNotification");
                let block = block2::RcBlock::new(move |_note: NonNull<AnyObject>| {
                    place_after_appkit(key);
                });
                // The container and each button: AppKit moves any of them.
                let watched = std::iter::once(container).chain(window_buttons(ns_window).into_iter().flatten());
                for object in watched {
                    let _: () = objc2::msg_send![object, setPostsFrameChangedNotifications: true];
                    let token: *mut AnyObject = objc2::msg_send![
                        center,
                        addObserverForName: &*name,
                        object: object,
                        queue: std::ptr::null::<AnyObject>(),
                        usingBlock: &*block
                    ];
                    if let Some(token) = Retained::retain(token) {
                        let mut observers = OBSERVERS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                        observers.push((label.clone(), Retained::into_raw(token) as usize));
                    }
                }
            }
        });
    }

    /// Move `window`'s traffic lights for a bar row `row_height` tall.
    pub fn set_traffic_light_row(window: &Window, row_height: u32) {
        let window = window.clone();
        let _ = window.clone().run_on_main_thread(move || {
            if let Ok(ptr) = window.ns_window() {
                {
                    let mut lights = TRAFFIC_LIGHTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    match lights.iter_mut().find(|(window, _)| *window == ptr as usize) {
                        Some((_, lights)) => lights.row = row_height,
                        None => return,
                    }
                }
                // SAFETY: on the main thread, for a window in the registry.
                unsafe { place(ptr as usize) };
            }
        });
    }

    /// Stop keeping the traffic lights of the window `label`, before it goes.
    pub fn release_traffic_lights(window: &Window) {
        let label = window.label().to_string();
        let window = window.clone();
        let ns_window = window.ns_window().ok().map(|ptr| ptr as usize);
        let _ = window.run_on_main_thread(move || {
            if let Some(ns_window) = ns_window {
                TRAFFIC_LIGHTS
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .retain(|(window, _)| *window != ns_window);
            }
            let mut observers = OBSERVERS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            observers.retain(|(owner, token)| {
                if owner != &label {
                    return true;
                }
                // SAFETY: the token was retained in `keep_traffic_lights` and
                // is released exactly once, here, on the main thread.
                unsafe {
                    let token = Retained::from_raw(*token as *mut AnyObject);
                    let center: *mut AnyObject =
                        objc2::msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
                    if let (Some(center), Some(token)) = (center.as_ref(), token) {
                        let _: () = objc2::msg_send![center, removeObserver: &*token];
                    }
                }
                false
            });
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

    pub fn order_below(_upper: &Webview, _lower: &Webview) {}
    pub fn clear_page_background(_page: &Webview) {}
    pub fn keyboard_to_page(_window: &Window, _page: &Webview) {}
    pub fn set_window_background(_window: &Window, _rgb: (f64, f64, f64)) {}
    pub fn keep_traffic_lights(_window: &Window, _row_height: u32) {}
    pub fn set_traffic_light_row(_window: &Window, _row_height: u32) {}
    pub fn release_traffic_lights(_window: &Window) {}
}

/// See the platform implementation.
pub fn order_below(upper: &Webview, lower: &Webview) {
    imp::order_below(upper, lower);
}

/// See the platform implementation.
pub fn clear_page_background(page: &Webview) {
    imp::clear_page_background(page);
}

/// Keep `window`'s traffic lights in the middle of a top row `row_height` tall.
pub fn keep_traffic_lights(window: &Window, row_height: u32) {
    imp::keep_traffic_lights(window, row_height);
}

/// Move `window`'s traffic lights for a bar row `row_height` tall.
pub fn set_traffic_light_row(window: &Window, row_height: u32) {
    imp::set_traffic_light_row(window, row_height);
}

/// Stop keeping `window`'s traffic lights, before it goes.
pub fn release_traffic_lights(window: &Window) {
    imp::release_traffic_lights(window);
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
    use super::parse_hex_color;

    #[test]
    fn colours_parse_from_hex() {
        assert_eq!(parse_hex_color("#ff0000"), Some((1.0, 0.0, 0.0)));
        assert_eq!(parse_hex_color("#000000"), Some((0.0, 0.0, 0.0)));
        assert_eq!(parse_hex_color("ff0000"), None);
        assert_eq!(parse_hex_color("#ff00"), None);
        assert_eq!(parse_hex_color("#gg0000"), None);
    }
}
