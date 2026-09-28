//! What WebKit's own context menu may show inside Mine.
//!
//! Two rules, applied where AppKit asks the view before a context menu opens
//! (`willOpenMenu:withEvent:`):
//!
//! 1. Browser navigation never appears. Mine is an application, not a browser:
//!    Back, Forward, Stop and Reload are removed from every native menu in
//!    every window. A menu left with nothing but separators is not shown.
//!    Text commands (Copy, Look Up, Translate and the rest) stay.
//! 2. A right click inside an embedded frame opens Mine's menu. The only frame
//!    the interface embeds is the source video player, which lives on another
//!    origin: its `contextmenu` event never reaches the interface. WebKit
//!    marks the menu it builds for a frame with "Open Frame in New Window";
//!    in the main window that menu is emptied and the click position, in CSS
//!    pixels, is sent to the interface as `source-video-context-menu`.
//!
//! Wry's WKWebView subclass does not implement `willOpenMenu:withEvent:`, so
//! the method is added to that class. This relies on wry's view class rather
//! than on a supported Tauri API, and is rechecked on every Tauri update. See
//! SPEC_MEDIA_ASSET_ACTIONS.md «Меню видео источника».

/// Event carrying the click point to the interface.
pub const EVENT: &str = "source-video-context-menu";
/// WebKit's identifier for the item it adds to a frame's context menu.
#[cfg(any(target_os = "macos", test))]
const FRAME_MENU_ITEM: &str = "WKMenuItemIdentifierOpenFrameInNewWindow";
/// WebCore context menu tags of browser navigation: Back, Forward, Stop,
/// Reload. Stop carries no WebKit identifier, so the tag is the reliable key.
#[cfg(any(target_os = "macos", test))]
const NAVIGATION_TAGS: [isize; 4] = [9, 10, 11, 12];

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct MenuPoint {
    pub x: f64,
    pub y: f64,
}

/// One native menu item, as far as these rules need to know it.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq)]
struct NativeItem {
    identifier: Option<String>,
    tag: isize,
    separator: bool,
}

/// What to do with a native menu before it opens.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq)]
enum MenuPlan {
    /// A frame's menu: show nothing and let the interface open Mine's menu.
    ReplaceWithMineMenu,
    /// Remove these items (indices in descending order); an empty menu is not shown.
    Remove(Vec<usize>),
}

#[cfg(any(target_os = "macos", test))]
fn plan_menu(items: &[NativeItem], frame_menu_allowed: bool) -> MenuPlan {
    if frame_menu_allowed
        && items
            .iter()
            .any(|item| item.identifier.as_deref() == Some(FRAME_MENU_ITEM))
    {
        return MenuPlan::ReplaceWithMineMenu;
    }
    let kept: Vec<usize> = (0..items.len())
        .filter(|&index| !NAVIGATION_TAGS.contains(&items[index].tag) || items[index].separator)
        .collect();
    // Separators survive only between two kept commands.
    let mut visible: Vec<usize> = Vec::new();
    for index in kept {
        let separator = items[index].separator;
        if separator && visible.last().is_none_or(|&last| items[last].separator) {
            continue;
        }
        visible.push(index);
    }
    while visible.last().is_some_and(|&last| items[last].separator) {
        visible.pop();
    }
    let mut remove: Vec<usize> = (0..items.len()).filter(|index| !visible.contains(index)).collect();
    remove.reverse();
    MenuPlan::Remove(remove)
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

    use super::{css_point, plan_menu, MenuPlan, NativeItem, EVENT};

    static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();
    static MAIN_VIEW: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    /// Attach the handler to the web view class. Must run once, on setup.
    pub fn install(app: &AppHandle<Wry>) {
        let _ = APP.set(app.clone());
        let Some(window) = app.get_webview_window("main") else {
            log::warn!("native context menu: main window is missing");
            return;
        };
        let result = window.with_webview(|webview| {
            let view = webview.inner();
            MAIN_VIEW.store(view, Ordering::SeqCst);
            // SAFETY: `inner()` is the live WKWebView of the main window, and
            // this closure runs on the main thread where AppKit objects live.
            // Every window's web view shares this class, so the rules reach
            // the settings window too.
            unsafe { add_menu_hook(view.cast::<AnyObject>()) };
        });
        if let Err(error) = result {
            log::warn!("native context menu: {error}");
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
            log::warn!("native context menu: web view class already handles willOpenMenu");
        }
    }

    unsafe extern "C-unwind" fn will_open_menu(this: &AnyObject, _cmd: Sel, menu: &AnyObject, event: &AnyObject) {
        let is_main = std::ptr::eq(
            (this as *const AnyObject).cast::<c_void>(),
            MAIN_VIEW.load(Ordering::SeqCst).cast_const(),
        );
        match plan_menu(&native_items(menu), is_main) {
            MenuPlan::ReplaceWithMineMenu => {
                let _: () = msg_send![menu, removeAllItems];
                let location: NSPoint = msg_send![event, locationInWindow];
                let point: NSPoint = msg_send![this, convertPoint: location, fromView: std::ptr::null::<AnyObject>()];
                let bounds: NSRect = msg_send![this, bounds];
                let flipped: Bool = msg_send![this, isFlipped];
                let zoom: f64 = msg_send![this, pageZoom];
                let payload = css_point(point.x, point.y, bounds.size.height, flipped.as_bool(), zoom);
                if let Some(app) = APP.get() {
                    if let Err(error) = app.emit_to("main", EVENT, payload) {
                        log::warn!("native context menu: {error}");
                    }
                }
            }
            MenuPlan::Remove(indices) => {
                for index in indices {
                    let index = isize::try_from(index).unwrap_or(isize::MAX);
                    let _: () = msg_send![menu, removeItemAtIndex: index];
                }
            }
        }
        // WKWebView's own implementation still runs, as it did before the hook.
        if let Some(superclass) = this.class().superclass() {
            let _: () = msg_send![super(this, superclass), willOpenMenu: menu, withEvent: event];
        }
    }

    unsafe fn native_items(menu: &AnyObject) -> Vec<NativeItem> {
        let count: isize = msg_send![menu, numberOfItems];
        (0..count)
            .filter_map(|index| {
                let item: *mut AnyObject = msg_send![menu, itemAtIndex: index];
                let item = item.as_ref()?;
                let identifier: Option<Retained<NSString>> = msg_send![item, identifier];
                let tag: isize = msg_send![item, tag];
                let separator: Bool = msg_send![item, isSeparatorItem];
                Some(NativeItem {
                    identifier: identifier.map(|identifier| identifier.to_string()),
                    tag,
                    separator: separator.as_bool(),
                })
            })
            .collect()
    }
}

#[cfg(target_os = "macos")]
pub use imp::install;

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle<tauri::Wry>) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(identifier: &str, tag: isize) -> NativeItem {
        NativeItem { identifier: Some(identifier.to_owned()), tag, separator: false }
    }

    fn separator() -> NativeItem {
        NativeItem { identifier: None, tag: 0, separator: true }
    }

    // Menus as WebKit built them in a WKWebView probe on 27.09.2026.
    fn page_menu() -> Vec<NativeItem> {
        vec![item("WKMenuItemIdentifierReload", 12), separator()]
    }
    fn loading_menu() -> Vec<NativeItem> {
        vec![item("forwardContextMenuAction:", 11), separator()]
    }
    fn frame_menu() -> Vec<NativeItem> {
        vec![item(FRAME_MENU_ITEM, 7), separator()]
    }
    fn selection_menu() -> Vec<NativeItem> {
        vec![
            item("WKMenuItemIdentifierLookUp", 22),
            item("WKMenuItemIdentifierTranslate", 95),
            separator(),
            item("WKMenuItemIdentifierSearchWeb", 21),
            separator(),
            item("WKMenuItemIdentifierCopy", 8),
        ]
    }

    #[test]
    fn reload_and_stop_never_reach_the_screen() {
        assert_eq!(plan_menu(&page_menu(), true), MenuPlan::Remove(vec![1, 0]));
        assert_eq!(plan_menu(&loading_menu(), false), MenuPlan::Remove(vec![1, 0]));
    }

    #[test]
    fn back_and_forward_are_removed_and_text_commands_stay() {
        let mut items = vec![item("WKMenuItemIdentifierGoBack", 9), item("WKMenuItemIdentifierGoForward", 10), separator()];
        items.extend(selection_menu());
        assert_eq!(plan_menu(&items, true), MenuPlan::Remove(vec![2, 1, 0]));
        assert_eq!(plan_menu(&selection_menu(), true), MenuPlan::Remove(vec![]));
    }

    #[test]
    fn only_the_main_window_turns_a_frame_menu_into_mine() {
        assert_eq!(plan_menu(&frame_menu(), true), MenuPlan::ReplaceWithMineMenu);
        assert_eq!(plan_menu(&frame_menu(), false), MenuPlan::Remove(vec![1]));
    }

    #[test]
    fn separators_survive_only_between_commands() {
        let items = vec![
            item("WKMenuItemIdentifierCopy", 8),
            separator(),
            item("WKMenuItemIdentifierReload", 12),
            separator(),
            item("WKMenuItemIdentifierLookUp", 22),
        ];
        assert_eq!(plan_menu(&items, true), MenuPlan::Remove(vec![3, 2]));
    }

    #[test]
    fn click_point_is_measured_from_the_top_left_in_css_pixels() {
        assert_eq!(css_point(120.0, 80.0, 600.0, true, 1.0), MenuPoint { x: 120.0, y: 80.0 });
        assert_eq!(css_point(120.0, 520.0, 600.0, false, 1.0), MenuPoint { x: 120.0, y: 80.0 });
        assert_eq!(css_point(240.0, 160.0, 600.0, true, 2.0), MenuPoint { x: 120.0, y: 80.0 });
        assert_eq!(css_point(120.0, 80.0, 600.0, true, 0.0), MenuPoint { x: 120.0, y: 80.0 });
    }
}
