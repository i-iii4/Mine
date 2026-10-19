//! What Tauri does not offer for tab pages on macOS (SPEC_TABS.md, В5, В25,
//! В26, В83): the layer order of two pages, a page without its own
//! background, the window's background colour, the title bar's height; and
//! the system's action of a stock Edit menu item (SPEC_EDITING.md, Л12).

use tauri::{AppHandle, Webview, Window};

use crate::domain::edit_menu::EditMenuCommand;
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

/// `NSTrackingMouseMoved`.
const TRACKING_MOUSE_MOVED: usize = 0x02;
/// `NSTrackingActiveWhenFirstResponder`.
const TRACKING_ACTIVE_WHEN_FIRST_RESPONDER: usize = 0x10;
/// `NSTrackingActiveInKeyWindow`.
const TRACKING_ACTIVE_IN_KEY_WINDOW: usize = 0x20;
/// `NSTrackingActiveInActiveApp`.
const TRACKING_ACTIVE_IN_ACTIVE_APP: usize = 0x40;
/// `NSTrackingActiveAlways`.
const TRACKING_ACTIVE_ALWAYS: usize = 0x80;
/// The four options of which exactly one says when an area is active.
const TRACKING_ACTIVE_ANY: usize = TRACKING_ACTIVE_WHEN_FIRST_RESPONDER
    | TRACKING_ACTIVE_IN_KEY_WINDOW
    | TRACKING_ACTIVE_IN_ACTIVE_APP
    | TRACKING_ACTIVE_ALWAYS;

/// The options a page's pointer tracking area takes instead of `options`
/// (SPEC_TABS.md, В85), or `None` to keep them. WebKit tracks the pointer
/// over a page with an area active only in the key window
/// (`trackingAreaOptions()` in WebViewImpl.mm) unless the system shows
/// scroll bars always, when it makes the same area active always itself
/// (`PageClientImpl::recommendedScrollbarStyleDidChange`). Without the
/// pointer's moves a window that is not key shows no hover. The same
/// options with "always" give the pages of every window the hover that
/// setting gives them. An area WebKit already made "always" keeps its
/// options and is still replaced, for the owner of the substitute, which
/// lets every exit reach the page. Any other area passes unchanged.
pub fn background_tracking_options(options: usize) -> Option<usize> {
    let followed = options & (TRACKING_ACTIVE_IN_KEY_WINDOW | TRACKING_ACTIVE_ALWAYS) != 0;
    if options & TRACKING_MOUSE_MOVED == 0 || !followed {
        return None;
    }
    Some((options & !TRACKING_ACTIVE_ANY) | TRACKING_ACTIVE_ALWAYS)
}

#[cfg(target_os = "macos")]
mod tracking {
    use std::sync::OnceLock;

    use objc2::rc::{Allocated, Retained, Weak};
    use objc2::runtime::{AnyClass, AnyObject, Imp, NSObject, Sel};
    use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass};
    use objc2_foundation::NSRect;

    /// `-[NSView addTrackingArea:]` and `-[NSView removeTrackingArea:]`.
    type TrackingAreaMethod = unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject);

    /// The implementations Mine's stand in front of, taken from the class
    /// before the hook went in: the class's own or the ones it inherits.
    struct Originals {
        class: usize,
        add: Imp,
        remove: Imp,
    }

    static ORIGINALS: OnceLock<Option<Originals>> = OnceLock::new();

    /// The key of the area a view holds in place of the one it was given.
    static SUBSTITUTE_KEY: u8 = 0;
    /// The key of the owner a substitute area answers to: an area does not
    /// retain its owner, so the substitute keeps it.
    static OWNER_KEY: u8 = 0;

    /// What the owner of a substitute area reaches: WebKit's own owner of
    /// the area (`WKMouseTrackingObserver`) and the page the area is on.
    pub struct OwnerIvars {
        webkit_owner: Weak<AnyObject>,
        page: Weak<AnyObject>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements; the methods only
        // pass the event on, and `Drop` is not implemented.
        #[unsafe(super(NSObject))]
        #[name = "MinePageTrackingOwner"]
        #[ivars = OwnerIvars]
        pub struct PageTrackingOwner;

        impl PageTrackingOwner {
            #[unsafe(method(mouseMoved:))]
            fn mouse_moved(&self, event: *mut AnyObject) {
                if let Some(owner) = self.ivars().webkit_owner.load() {
                    // SAFETY: WebKit's owner answers mouseMoved:.
                    unsafe { msg_send![&*owner, mouseMoved: event] }
                }
            }

            #[unsafe(method(mouseEntered:))]
            fn mouse_entered(&self, event: *mut AnyObject) {
                if let Some(owner) = self.ivars().webkit_owner.load() {
                    // SAFETY: WebKit's owner answers mouseEntered:.
                    unsafe { msg_send![&*owner, mouseEntered: event] }
                }
            }

            /// The pointer left the page: the page hears it, whatever the
            /// last move WebKit's owner saw (SPEC_TABS.md, В85). WebKit's
            /// owner passes an exit on only when its last move or entry
            /// found the page topmost under the pointer
            /// (`_viewIsTopmostAtLastMouseLocation`, WebKit 67fc22ee): a
            /// move it receives at a point where another page of the window
            /// is topmost makes it drop the next exit, and the page keeps
            /// its hover. `_simulateMouseExit:` (WKWebViewPrivate.h, macOS 14)
            /// is the same `WebViewImpl::mouseExited` without that check.
            #[unsafe(method(mouseExited:))]
            fn mouse_exited(&self, event: *mut AnyObject) {
                if let Some(page) = self.ivars().page.load() {
                    // SAFETY: asking a live view about a selector.
                    let direct: bool = unsafe { msg_send![&*page, respondsToSelector: sel!(_simulateMouseExit:)] };
                    if direct {
                        // SAFETY: the page answers it, checked above.
                        unsafe { msg_send![&*page, _simulateMouseExit: event] }
                        return;
                    }
                }
                if let Some(owner) = self.ivars().webkit_owner.load() {
                    // SAFETY: WebKit's owner answers mouseExited:.
                    unsafe { msg_send![&*owner, mouseExited: event] }
                }
            }
        }
    );

    impl PageTrackingOwner {
        fn new(webkit_owner: &AnyObject, page: &AnyObject) -> Retained<Self> {
            let this = Self::alloc().set_ivars(OwnerIvars {
                webkit_owner: Weak::new(webkit_owner),
                page: Weak::new(page),
            });
            // SAFETY: NSObject's designated initialiser.
            unsafe { msg_send![super(this), init] }
        }
    }

    fn originals() -> Option<&'static Originals> {
        ORIGINALS.get().and_then(Option::as_ref)
    }

    /// An area like `area` on `page`, with the options of
    /// [`super::background_tracking_options`] and an owner that passes its
    /// events to `area`'s owner and its exits to `page`, or `None` to keep
    /// `area`.
    unsafe fn substitute_for(page: &AnyObject, area: *mut AnyObject) -> Option<Retained<AnyObject>> {
        let area = area.as_ref()?;
        let options: usize = msg_send![area, options];
        let options = super::background_tracking_options(options)?;
        let rect: NSRect = msg_send![area, rect];
        let webkit_owner: *mut AnyObject = msg_send![area, owner];
        let owner = PageTrackingOwner::new(webkit_owner.as_ref()?, page);
        let user_info: *mut AnyObject = msg_send![area, userInfo];
        let allocated: Allocated<AnyObject> = msg_send![objc2::class!(NSTrackingArea), alloc];
        let substitute: Retained<AnyObject> = msg_send![
            allocated,
            initWithRect: rect,
            options: options,
            owner: &*owner,
            userInfo: user_info
        ];
        // SAFETY: a live area; the association retains the owner for as long
        // as the substitute lives.
        objc2::ffi::objc_setAssociatedObject(
            Retained::as_ptr(&substitute).cast_mut(),
            std::ptr::addr_of!(OWNER_KEY).cast(),
            Retained::as_ptr(&owner).cast::<AnyObject>().cast_mut(),
            objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        Some(substitute)
    }

    /// Mine's `addTrackingArea:`: the area or its substitute, which the
    /// given area keeps for its removal.
    unsafe extern "C-unwind" fn add_tracking_area(this: &AnyObject, cmd: Sel, area: *mut AnyObject) {
        let Some(originals) = originals() else { return };
        // SAFETY: the implementation this one stands in front of, with the
        // same signature, on the thread AppKit calls it on.
        let add = std::mem::transmute::<Imp, TrackingAreaMethod>(originals.add);
        match substitute_for(this, area) {
            Some(substitute) => {
                // SAFETY: `area` is a live tracking area; the association
                // retains the substitute for as long as the area lives.
                objc2::ffi::objc_setAssociatedObject(
                    area,
                    std::ptr::addr_of!(SUBSTITUTE_KEY).cast(),
                    Retained::as_ptr(&substitute).cast_mut(),
                    objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
                );
                add(this, cmd, Retained::as_ptr(&substitute).cast_mut());
            }
            None => add(this, cmd, area),
        }
    }

    /// Mine's `removeTrackingArea:`: the substitute of the area when it has
    /// one, since the view holds that and not the area.
    unsafe extern "C-unwind" fn remove_tracking_area(this: &AnyObject, cmd: Sel, area: *mut AnyObject) {
        let Some(originals) = originals() else { return };
        // SAFETY: as in `add_tracking_area`.
        let remove = std::mem::transmute::<Imp, TrackingAreaMethod>(originals.remove);
        let substitute = if area.is_null() {
            std::ptr::null()
        } else {
            objc2::ffi::objc_getAssociatedObject(area, std::ptr::addr_of!(SUBSTITUTE_KEY).cast())
        };
        if substitute.is_null() {
            remove(this, cmd, area);
        } else {
            remove(this, cmd, substitute.cast_mut());
        }
    }

    /// Put Mine's tracking area methods in front of `class`'s, once per
    /// process. True when `class` has them, now or from before.
    pub fn install(class: &AnyClass) -> bool {
        let target = std::ptr::from_ref(class).cast_mut();
        let mut first = false;
        // The originals are saved before the hooks go in: a hook never runs
        // without the implementation it calls.
        let installed = ORIGINALS.get_or_init(|| {
            first = true;
            Some(Originals {
                class: target as usize,
                add: class.instance_method(sel!(addTrackingArea:))?.implementation(),
                remove: class.instance_method(sel!(removeTrackingArea:))?.implementation(),
            })
        });
        if first && installed.is_some() {
            // SAFETY: the replacements have the selectors' signature,
            // encoded "v@:@", and call the implementations saved above.
            unsafe {
                let add_hook = std::mem::transmute::<TrackingAreaMethod, Imp>(add_tracking_area);
                let remove_hook = std::mem::transmute::<TrackingAreaMethod, Imp>(remove_tracking_area);
                objc2::ffi::class_replaceMethod(target, sel!(addTrackingArea:), add_hook, c"v@:@".as_ptr());
                objc2::ffi::class_replaceMethod(target, sel!(removeTrackingArea:), remove_hook, c"v@:@".as_ptr());
            }
        }
        installed
            .as_ref()
            .is_some_and(|originals| originals.class == target as usize)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::OnceLock;

    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2_app_kit::{NSColor, NSView, NSWindow, NSWindowOrderingMode};
    use objc2_foundation::{NSNumber, NSString};
    use tauri::{AppHandle, Webview, Window};

    use crate::domain::edit_menu::EditMenuCommand;
    use crate::domain::windows::TitleBar;

    /// Send the system's action of `command` to the first responder of the
    /// key window, as the stock item of the Edit menu did: `undo:`, `redo:`
    /// and `selectAll:` with no target (SPEC_EDITING.md, Л12).
    pub fn send_edit_action(app: &AppHandle, command: EditMenuCommand) {
        let action = match command {
            EditMenuCommand::Undo => objc2::sel!(undo:),
            EditMenuCommand::Redo => objc2::sel!(redo:),
            EditMenuCommand::SelectAll => objc2::sel!(selectAll:),
        };
        let sent = app.run_on_main_thread(move || {
            // SAFETY: the shared application, on the main thread. A nil
            // target walks the responder chain from the key window's first
            // responder, as AppKit does for a menu item without a target.
            unsafe {
                let application: *mut AnyObject = objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
                let Some(application) = application.as_ref() else {
                    return;
                };
                let nothing: *mut AnyObject = std::ptr::null_mut();
                let _: bool = objc2::msg_send![application, sendAction: action, to: nothing, from: nothing];
            }
        });
        if let Err(error) = sent {
            log::warn!("cannot send the Edit menu's action: {error}");
        }
    }

    /// Let every page show hover while its window is not key or Mine is
    /// not the active app (В85). The hook goes on `WKWebView` before any
    /// page exists, so it holds for the area WebKit makes with each page,
    /// for the tab bars and the pages of every window, for a page moved
    /// to another window, and for the area WebKit makes again when the
    /// scroll bar setting changes.
    pub fn hover_in_background() {
        let Some(class) = AnyClass::get(c"WKWebView") else {
            log::warn!("WKWebView is not loaded; pages show hover only in the key window");
            return;
        };
        if !super::tracking::install(class) {
            log::warn!("pointer tracking hook is on another class; pages show hover only in the key window");
        }
    }

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
    use tauri::{AppHandle, Webview, Window};

    use crate::domain::edit_menu::EditMenuCommand;
    use crate::domain::windows::TitleBar;

    pub fn send_edit_action(_app: &AppHandle, _command: EditMenuCommand) {}

    pub fn order_below(_upper: &Webview, _lower: &Webview) {}
    pub fn clear_page_background(_page: &Webview) {}
    pub fn keyboard_to_page(_window: &Window, _page: &Webview) {}
    pub fn set_window_background(_window: &Window, _rgb: (f64, f64, f64)) {}
    pub fn set_title_bar(_window: &Window, _title_bar: TitleBar) {}
    pub fn hide_toolbar_in_full_screen(_window: &Window) {}
    pub fn hover_in_background() {}
}

/// Let the pages of every window answer the pointer when their window is
/// not key or Mine is not the active app. Runs once, before any page.
pub fn hover_in_background() {
    imp::hover_in_background();
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

/// Send the system's action of the Edit menu's `command`, as its stock item
/// did: where no note editor holds the focus, the menu keeps what it did
/// (SPEC_EDITING.md, Л12).
pub fn send_system_edit_action(app: &AppHandle, command: EditMenuCommand) {
    imp::send_edit_action(app, command);
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
        background_tracking_options, full_screen_presentation, parse_hex_color, PRESENTATION_AUTO_HIDE_TOOLBAR,
        PRESENTATION_FULL_SCREEN, TRACKING_ACTIVE_ALWAYS, TRACKING_ACTIVE_ANY, TRACKING_ACTIVE_IN_ACTIVE_APP,
        TRACKING_ACTIVE_IN_KEY_WINDOW, TRACKING_MOUSE_MOVED,
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

    /// WebKit's area over a page with overlay scroll bars
    /// (`trackingAreaOptions()` in WebViewImpl.mm).
    const WEBKIT_PAGE_AREA: usize = TRACKING_MOUSE_MOVED
        | MOUSE_ENTERED_AND_EXITED
        | CURSOR_UPDATE
        | IN_VISIBLE_RECT
        | TRACKING_ACTIVE_IN_KEY_WINDOW;
    /// WebKit's area that watches the modifier keys.
    const WEBKIT_FLAGS_AREA: usize = IN_VISIBLE_RECT | TRACKING_ACTIVE_IN_ACTIVE_APP | MOUSE_ENTERED_AND_EXITED;
    /// `NSTrackingMouseEnteredAndExited`.
    const MOUSE_ENTERED_AND_EXITED: usize = 0x01;
    /// `NSTrackingCursorUpdate`.
    const CURSOR_UPDATE: usize = 0x04;
    /// `NSTrackingInVisibleRect`.
    const IN_VISIBLE_RECT: usize = 0x200;

    #[test]
    fn the_page_area_tracks_the_pointer_always() {
        let options = background_tracking_options(WEBKIT_PAGE_AREA).expect("the page area changes");
        assert_eq!(
            options,
            TRACKING_MOUSE_MOVED | MOUSE_ENTERED_AND_EXITED | CURSOR_UPDATE | IN_VISIBLE_RECT | TRACKING_ACTIVE_ALWAYS
        );
        // Exactly one "active" option, as AppKit requires.
        assert_eq!((options & TRACKING_ACTIVE_ANY).count_ones(), 1);
    }

    #[test]
    fn the_page_area_webkit_made_always_keeps_its_options() {
        // The page area as WebKit makes it when scroll bars always show: it
        // is replaced for its owner, with the same options.
        let always = (WEBKIT_PAGE_AREA & !TRACKING_ACTIVE_IN_KEY_WINDOW) | TRACKING_ACTIVE_ALWAYS;
        assert_eq!(background_tracking_options(always), Some(always));
    }

    #[test]
    fn other_areas_pass_unchanged() {
        // The modifier keys area, active in the active app.
        assert_eq!(background_tracking_options(WEBKIT_FLAGS_AREA), None);
        // A key window area that does not follow the pointer's moves.
        let entered = MOUSE_ENTERED_AND_EXITED | TRACKING_ACTIVE_IN_KEY_WINDOW;
        assert_eq!(background_tracking_options(entered), None);
    }

    #[cfg(target_os = "macos")]
    mod hook {
        use std::sync::Mutex;

        use objc2::rc::Retained;
        use objc2::runtime::{AnyObject, NSObject};
        use objc2::{define_class, msg_send, ClassType};
        use objc2_foundation::{NSPoint, NSRect, NSSize};

        use super::{
            TRACKING_ACTIVE_ALWAYS, TRACKING_ACTIVE_IN_KEY_WINDOW, WEBKIT_FLAGS_AREA, WEBKIT_PAGE_AREA,
        };

        /// What the base class received: added or not, the area, its options.
        static RECEIVED: Mutex<Vec<(bool, usize, usize)>> = Mutex::new(Vec::new());
        /// Which event reached whom: WebKit's owner or the page itself.
        static EVENTS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

        fn record(added: bool, area: &AnyObject) {
            // SAFETY: a live NSTrackingArea.
            let options: usize = unsafe { msg_send![area, options] };
            RECEIVED
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((added, std::ptr::from_ref(area) as usize, options));
        }

        fn heard(event: &'static str) {
            EVENTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(event);
        }

        fn take_events() -> Vec<&'static str> {
            std::mem::take(&mut *EVENTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
        }

        define_class!(
            // SAFETY: NSObject has no subclassing requirements; the methods
            // only record their argument.
            #[unsafe(super(NSObject))]
            #[name = "MineHoverTrackingBase"]
            struct TrackingBase;

            impl TrackingBase {
                #[unsafe(method(addTrackingArea:))]
                fn add_tracking_area(&self, area: &AnyObject) {
                    record(true, area);
                }

                #[unsafe(method(removeTrackingArea:))]
                fn remove_tracking_area(&self, area: &AnyObject) {
                    record(false, area);
                }
            }
        );

        define_class!(
            // SAFETY: as above; the view inherits both methods, as WKWebView
            // inherits NSView's.
            #[unsafe(super(TrackingBase, NSObject))]
            #[name = "MineHoverTrackingView"]
            struct TrackingView;
        );

        define_class!(
            // SAFETY: as above; a page that answers WebKit's direct exit.
            #[unsafe(super(TrackingView, TrackingBase, NSObject))]
            #[name = "MineHoverTrackingPage"]
            struct TrackingPage;

            impl TrackingPage {
                #[unsafe(method(_simulateMouseExit:))]
                fn simulate_mouse_exit(&self, _event: &AnyObject) {
                    heard("page exited");
                }
            }
        );

        define_class!(
            // SAFETY: as above; stands for `WKMouseTrackingObserver`.
            #[unsafe(super(NSObject))]
            #[name = "MineHoverTrackingWebKitOwner"]
            struct WebKitOwner;

            impl WebKitOwner {
                #[unsafe(method(mouseMoved:))]
                fn mouse_moved(&self, _event: &AnyObject) {
                    heard("owner moved");
                }

                #[unsafe(method(mouseEntered:))]
                fn mouse_entered(&self, _event: &AnyObject) {
                    heard("owner entered");
                }

                #[unsafe(method(mouseExited:))]
                fn mouse_exited(&self, _event: &AnyObject) {
                    heard("owner exited");
                }
            }
        );

        fn area(options: usize, owner: &AnyObject) -> Retained<AnyObject> {
            let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(10.0, 20.0));
            // SAFETY: the designated initialiser of NSTrackingArea; a null
            // userInfo is allowed.
            unsafe {
                let allocated: objc2::rc::Allocated<AnyObject> =
                    msg_send![objc2::class!(NSTrackingArea), alloc];
                msg_send![
                    allocated,
                    initWithRect: rect,
                    options: options,
                    owner: owner,
                    userInfo: std::ptr::null::<AnyObject>()
                ]
            }
        }

        /// The substitute `view` holds for `area`, from what the base class
        /// received.
        fn substitute_on(view: &AnyObject, area: &AnyObject) -> usize {
            RECEIVED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
            // SAFETY: the hooked method with a live area.
            unsafe {
                let _: () = msg_send![view, addTrackingArea: area];
            }
            let received = RECEIVED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            assert_eq!(received.len(), 1);
            received[0].1
        }

        /// Send the three pointer events to the owner of `substitute`.
        fn pointer_events(substitute: usize) {
            // SAFETY: the substitute is alive (its area retains it), and so
            // is its owner (the substitute retains it).
            unsafe {
                let substitute: &AnyObject = &*(substitute as *const AnyObject);
                let owner: *const AnyObject = msg_send![substitute, owner];
                let owner: &AnyObject = &*owner;
                let event = NSObject::new();
                let _: () = msg_send![owner, mouseEntered: &*event];
                let _: () = msg_send![owner, mouseMoved: &*event];
                let _: () = msg_send![owner, mouseExited: &*event];
            }
        }

        #[test]
        fn the_view_holds_an_always_active_substitute_and_removes_it() {
            assert!(crate::tabs::native::tracking::install(TrackingView::class()));
            // A second install, on the same class or another, changes nothing.
            assert!(crate::tabs::native::tracking::install(TrackingView::class()));
            assert!(!crate::tabs::native::tracking::install(TrackingBase::class()));

            let view: Retained<TrackingView> = unsafe { msg_send![TrackingView::class(), new] };
            let owner: Retained<WebKitOwner> = unsafe { msg_send![WebKitOwner::class(), new] };
            let page = area(WEBKIT_PAGE_AREA, &owner);
            let flags = area(WEBKIT_FLAGS_AREA, &owner);
            let page_ptr = Retained::as_ptr(&page) as usize;
            let flags_ptr = Retained::as_ptr(&flags) as usize;
            RECEIVED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
            // SAFETY: the hooked methods with live areas.
            unsafe {
                let _: () = msg_send![&*view, addTrackingArea: &*page];
                let _: () = msg_send![&*view, addTrackingArea: &*flags];
                let _: () = msg_send![&*view, removeTrackingArea: &*page];
                let _: () = msg_send![&*view, removeTrackingArea: &*flags];
            }

            let received = RECEIVED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            assert_eq!(received.len(), 4);
            let (added, substitute, options) = received[0];
            assert!(added);
            assert_ne!(substitute, page_ptr, "the page area is replaced");
            assert_eq!(
                options,
                (WEBKIT_PAGE_AREA & !TRACKING_ACTIVE_IN_KEY_WINDOW) | TRACKING_ACTIVE_ALWAYS
            );
            // SAFETY: the substitute is alive: the page area retains it.
            let substitute_area: &AnyObject = unsafe { &*(substitute as *const AnyObject) };
            let substitute_owner: *const AnyObject = unsafe { msg_send![substitute_area, owner] };
            assert_ne!(
                substitute_owner as usize,
                Retained::as_ptr(&owner) as usize,
                "the substitute answers to Mine's owner"
            );
            let substitute_rect: NSRect = unsafe { msg_send![substitute_area, rect] };
            assert_eq!(substitute_rect.size, NSSize::new(10.0, 20.0));
            assert_eq!(received[1], (true, flags_ptr, WEBKIT_FLAGS_AREA), "other areas pass unchanged");
            assert_eq!(received[2].1, substitute, "removing the page area removes its substitute");
            assert!(!received[2].0);
            assert_eq!(received[3], (false, flags_ptr, WEBKIT_FLAGS_AREA));
            let flags_owner: *const AnyObject = unsafe { msg_send![&*flags, owner] };
            assert_eq!(flags_owner as usize, Retained::as_ptr(&owner) as usize);

            // A page that answers the direct exit: moves and entries reach
            // WebKit's owner, the exit reaches the page whatever the owner
            // last saw.
            let web_page: Retained<TrackingPage> = unsafe { msg_send![TrackingPage::class(), new] };
            let on_page = area(WEBKIT_PAGE_AREA, &owner);
            take_events();
            pointer_events(substitute_on(&web_page, &on_page));
            assert_eq!(take_events(), ["owner entered", "owner moved", "page exited"]);

            // A view without it: the exit goes to WebKit's owner as before.
            let on_view = area(WEBKIT_PAGE_AREA, &owner);
            pointer_events(substitute_on(&view, &on_view));
            assert_eq!(take_events(), ["owner entered", "owner moved", "owner exited"]);
        }
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
