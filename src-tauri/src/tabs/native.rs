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
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSColor, NSView, NSWindow, NSWindowOrderingMode};
    use objc2_foundation::{NSNumber, NSString};
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
    pub fn set_window_background(_window: &Window, _rgb: (f64, f64, f64)) {}
}

/// See the platform implementation.
pub fn order_below(upper: &Webview, lower: &Webview) {
    imp::order_below(upper, lower);
}

/// See the platform implementation.
pub fn clear_page_background(page: &Webview) {
    imp::clear_page_background(page);
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
