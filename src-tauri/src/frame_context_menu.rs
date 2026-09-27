//! Right click inside an embedded frame opens Mine's menu, not WebKit's.
//!
//! The only frame the interface embeds is the source video player, which
//! lives on another origin: its `contextmenu` event never reaches the
//! interface, so the page cannot replace the menu the way it does for local
//! media. WebKit instead builds its own menu with a lone "Open Frame in New
//! Window" item, which would open the internal wrapper page.
//!
//! AppKit asks the view before a context menu opens (`willOpenMenu:withEvent:`).
//! Wry's WKWebView subclass does not implement it, so the method is added to
//! that class here. A menu that WebKit built for a frame is emptied (an empty
//! menu is not shown) and the click position, in CSS pixels, is sent to the
//! interface as `source-video-context-menu`; every other menu is left alone.
//! This relies on wry's view class rather than on a supported Tauri API, and
//! is rechecked on every Tauri update. See SPEC_MEDIA_ASSET_ACTIONS.md
//! «Меню видео источника».

/// Event carrying the click point to the interface.
pub const EVENT: &str = "source-video-context-menu";
/// WebKit's identifier for the item it adds to a frame's context menu.
#[cfg(any(target_os = "macos", test))]
const FRAME_MENU_ITEM: &str = "WKMenuItemIdentifierOpenFrameInNewWindow";

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct MenuPoint {
    pub x: f64,
    pub y: f64,
}

/// Whether WebKit built this menu for a click inside an embedded frame.
#[cfg(any(target_os = "macos", test))]
fn is_frame_menu<'a>(mut identifiers: impl Iterator<Item = Option<&'a str>>) -> bool {
    identifiers.any(|identifier| identifier == Some(FRAME_MENU_ITEM))
}

/// View coordinates in points to CSS pixels from the top left of the page.
#[cfg(any(target_os = "macos", test))]
fn css_point(x: f64, y: f64, view_height: f64, flipped: bool, page_zoom: f64) -> MenuPoint {
    let top = if flipped { y } else { view_height - y };
    let zoom = if page_zoom > 0.0 { page_zoom } else { 1.0 };
    MenuPoint { x: x / zoom, y: top / zoom }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicPtr, Ordering};
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSPoint, NSRect, NSString};
    use tauri::{AppHandle, Emitter, Manager, Wry};

    use super::{css_point, is_frame_menu, EVENT};

    static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();
    static MAIN_VIEW: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    /// Attach the handler to the main window's web view. Must run once.
    pub fn install(app: &AppHandle<Wry>) {
        let _ = APP.set(app.clone());
        let Some(window) = app.get_webview_window("main") else {
            log::warn!("frame context menu: main window is missing");
            return;
        };
        let result = window.with_webview(|webview| {
            let view = webview.inner();
            MAIN_VIEW.store(view, Ordering::SeqCst);
            // SAFETY: `inner()` is the live WKWebView of the main window, and
            // this closure runs on the main thread where AppKit objects live.
            unsafe { add_menu_hook(view.cast::<AnyObject>()) };
        });
        if let Err(error) = result {
            log::warn!("frame context menu: {error}");
        }
    }

    unsafe fn add_menu_hook(view: *mut AnyObject) {
        let Some(view) = view.as_ref() else { return };
        let class: *const AnyClass = view.class();
        // SAFETY: the signature matches `-(void)willOpenMenu:(NSMenu*)withEvent:(NSEvent*)`,
        // encoded as "v@:@@".
        let imp: Imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, &AnyObject),
            Imp,
        >(will_open_menu);
        let added = objc2::ffi::class_addMethod(
            class.cast_mut(),
            sel!(willOpenMenu:withEvent:),
            imp,
            c"v@:@@".as_ptr(),
        );
        if !added.as_bool() {
            log::warn!("frame context menu: web view class already handles willOpenMenu");
        }
    }

    unsafe extern "C-unwind" fn will_open_menu(this: &AnyObject, _cmd: Sel, menu: &AnyObject, event: &AnyObject) {
        let is_main = std::ptr::eq(
            (this as *const AnyObject).cast::<c_void>(),
            MAIN_VIEW.load(Ordering::SeqCst).cast_const(),
        );
        if is_main && frame_menu(menu) {
            let _: () = msg_send![menu, removeAllItems];
            let location: NSPoint = msg_send![event, locationInWindow];
            let point: NSPoint = msg_send![this, convertPoint: location, fromView: std::ptr::null::<AnyObject>()];
            let bounds: NSRect = msg_send![this, bounds];
            let flipped: Bool = msg_send![this, isFlipped];
            let zoom: f64 = msg_send![this, pageZoom];
            let payload = css_point(point.x, point.y, bounds.size.height, flipped.as_bool(), zoom);
            if let Some(app) = APP.get() {
                if let Err(error) = app.emit_to("main", EVENT, payload) {
                    log::warn!("frame context menu: {error}");
                }
            }
        }
        // WKWebView's own implementation still runs, as it did before the hook.
        if let Some(superclass) = this.class().superclass() {
            let _: () = msg_send![super(this, superclass), willOpenMenu: menu, withEvent: event];
        }
    }

    unsafe fn frame_menu(menu: &AnyObject) -> bool {
        let count: isize = msg_send![menu, numberOfItems];
        let identifiers: Vec<Option<String>> = (0..count)
            .map(|index| {
                let item: *mut AnyObject = msg_send![menu, itemAtIndex: index];
                let item = item.as_ref()?;
                let identifier: Option<Retained<NSString>> = msg_send![item, identifier];
                identifier.map(|identifier| identifier.to_string())
            })
            .collect();
        is_frame_menu(identifiers.iter().map(Option::as_deref))
    }
}

#[cfg(target_os = "macos")]
pub use imp::install;

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle<tauri::Wry>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_menu_webkit_built_for_a_frame_is_taken_over() {
        assert!(is_frame_menu([Some(FRAME_MENU_ITEM), None].into_iter()));
        assert!(is_frame_menu([Some("WKMenuItemIdentifierCopyLink"), Some(FRAME_MENU_ITEM)].into_iter()));
        assert!(!is_frame_menu([Some("WKMenuItemIdentifierReload"), None].into_iter()));
        assert!(!is_frame_menu(std::iter::empty()));
    }

    #[test]
    fn click_point_is_measured_from_the_top_left_in_css_pixels() {
        assert_eq!(css_point(120.0, 80.0, 600.0, true, 1.0), MenuPoint { x: 120.0, y: 80.0 });
        assert_eq!(css_point(120.0, 520.0, 600.0, false, 1.0), MenuPoint { x: 120.0, y: 80.0 });
        assert_eq!(css_point(240.0, 160.0, 600.0, true, 2.0), MenuPoint { x: 120.0, y: 80.0 });
        assert_eq!(css_point(120.0, 80.0, 600.0, true, 0.0), MenuPoint { x: 120.0, y: 80.0 });
    }
}
