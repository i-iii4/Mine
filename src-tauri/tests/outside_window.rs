//! The outside window's flags on a window tao made, with a page in it
//! (SPEC_OUTSIDE_WINDOW.md, НО2 to НО4). The outside window is an ordinary
//! Tauri window, and Tauri's windows are tao's: AppKit watches each of them by
//! KVO from its `init`, and WebKit adds its own watch when a page enters the
//! window. The menu panel once crashed in the first watched setter, `setOpaque:`,
//! after the class of such a window was changed (SPEC_MENU_WINDOW.md, МО62а).
//! Here no class changes: the window is dressed with the public setters only,
//! takes the frames and levels of both its uses, and goes with its page,
//! twice, without an exception or a crash. A crash ends the process: the test
//! fails.
//!
//! What this cannot hold: the page's frames, and whether the window passes the
//! pointer to the window under it. No window comes to the screen here.
//!
//! No standard harness (`harness = false` in Cargo.toml): AppKit makes a
//! window on the process's main thread only. Nothing comes to the screen and
//! nothing takes the focus: no window is ordered in, and the process may not
//! be activated (activation policy `prohibited`: no Dock icon). With no window
//! server (a build machine with no one logged in) the test is skipped and says
//! why.

#[cfg(target_os = "macos")]
mod appkit {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::panic::AssertUnwindSafe;
    use std::rc::Rc;
    use std::time::Duration;

    use mine_lib::outside_window_parts::{dress, dressed, place, OutsideUse, ScreenRect, DRAG_LEVEL, PREVIEW_LEVEL};
    use objc2::rc::{autoreleasepool, Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    use tao::dpi::LogicalSize;
    use tao::event_loop::{EventLoop, EventLoopBuilder};
    use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS, WindowExtMacOS};
    use tao::window::WindowBuilder;

    /// `NSApplicationActivationPolicyProhibited`.
    const ACTIVATION_PROHIBITED: isize = 2;
    /// `NSViewWidthSizable | NSViewHeightSizable`, as wry lays a page out.
    const FILLS_ITS_PARENT: usize = (1 << 1) | (1 << 4);
    /// A preview's column and a dragged card's frame, in points.
    const COLUMN: ScreenRect = ScreenRect { x: 736.0, y: 3.0, width: 284.0, height: 1124.0 };
    const CARD: ScreenRect = ScreenRect { x: 420.0, y: 300.0, width: 284.0, height: 380.0 };
    /// The whole test takes about a second; one that hangs ends here.
    const DEADLINE: Duration = Duration::from_secs(60);
    /// How long the test waits for WebKit, a step of its run loop at a time.
    const WEBKIT_WAIT: Duration = Duration::from_secs(10);
    const RUN_LOOP_STEP_S: f64 = 0.01;
    const PAGE: &str = "<!doctype html><script>window.loaded = 1;</script>";

    #[link(name = "WebKit", kind = "framework")]
    extern "C" {}

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        /// The window server's session of this process; null outside one.
        fn CGSessionCopyCurrentDictionary() -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(object: *const c_void);
        static kCFRunLoopDefaultMode: *const c_void;
        fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source_handled: u8) -> i32;
    }

    pub enum Outcome {
        Passed,
        Skipped(&'static str),
    }

    fn ensure(holds: bool, what: &str) -> Result<(), String> {
        if holds {
            Ok(())
        } else {
            Err(what.to_string())
        }
    }

    /// Run the main run loop until `done` holds or WebKit's wait is over.
    unsafe fn run_until(mut done: impl FnMut() -> bool) -> bool {
        let started = std::time::Instant::now();
        while started.elapsed() < WEBKIT_WAIT {
            if done() {
                return true;
            }
            let _ = CFRunLoopRunInMode(kCFRunLoopDefaultMode, RUN_LOOP_STEP_S, 0);
        }
        done()
    }

    /// Whether the page's script has run.
    unsafe fn loaded(page: &AnyObject) -> bool {
        let answer: Rc<RefCell<Option<bool>>> = Rc::new(RefCell::new(None));
        let into = Rc::clone(&answer);
        let handler = block2::RcBlock::new(move |value: *mut AnyObject, _error: *mut AnyObject| {
            *into.borrow_mut() = Some(!value.is_null());
        });
        let source = NSString::from_str("window.loaded");
        let _: () = msg_send![page, evaluateJavaScript: &*source, completionHandler: &*handler];
        run_until(|| answer.borrow().is_some());
        let came = *answer.borrow();
        came.unwrap_or(false)
    }

    /// The class name of `object` as the runtime holds it.
    unsafe fn class_name(object: &AnyObject) -> String {
        let class: *const AnyClass = objc2::ffi::object_getClass(std::ptr::from_ref(object).cast());
        class.as_ref().map_or_else(String::new, |class| class.name().to_string_lossy().into_owned())
    }

    /// The window's frame from the main screen's top left, and its level.
    unsafe fn frame_and_level(window: &AnyObject) -> (ScreenRect, isize) {
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        let first: *mut AnyObject = msg_send![&*screens, firstObject];
        let primary: NSRect = msg_send![&*first, frame];
        let frame: NSRect = msg_send![window, frame];
        let level: isize = msg_send![window, level];
        (
            ScreenRect {
                x: frame.origin.x,
                y: primary.size.height - (frame.origin.y + frame.size.height),
                width: frame.size.width,
                height: frame.size.height,
            },
            level,
        )
    }

    unsafe fn takes(window: &AnyObject, frame: ScreenRect, what: OutsideUse, level: isize) -> Result<(), String> {
        place(window, frame, what)?;
        let (now, now_level) = frame_and_level(window);
        ensure(now == frame, &format!("the window took {now:?} for {frame:?}"))?;
        ensure(now_level == level, &format!("the window's level is {now_level}, not {level}"))
    }

    /// One window, as Tauri makes the outside window: tao's, unfocusable,
    /// unseen, its page in its content view as wry lays it out; dressed,
    /// placed for both uses, and gone with its page.
    unsafe fn one_round(event_loop: &EventLoop<()>) -> Result<(), String> {
        let tao_window = WindowBuilder::new()
            .with_visible(false)
            .with_focused(false)
            .with_focusable(false)
            .with_decorations(false)
            .with_inner_size(LogicalSize::new(284.0, 284.0))
            .build(event_loop)
            .map_err(|error| format!("tao made no window: {error}"))?;
        let window = (tao_window.ns_window() as *const AnyObject).as_ref().ok_or("no NSWindow")?;

        let configuration: Retained<AnyObject> = msg_send![class!(WKWebViewConfiguration), new];
        let made: Allocated<AnyObject> = msg_send![class!(WKWebView), alloc];
        let bounds = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(284.0, 284.0));
        let page: Option<Retained<AnyObject>> = msg_send![made, initWithFrame: bounds, configuration: &*configuration];
        let page = page.ok_or("WebKit made no page")?;
        let content: *mut AnyObject = msg_send![window, contentView];
        let content = content.as_ref().ok_or("the window has no content view")?;
        let _: () = msg_send![&*page, setAutoresizingMask: FILLS_ITS_PARENT];
        let _: () = msg_send![content, addSubview: &*page];
        let html = NSString::from_str(PAGE);
        let nothing: *mut AnyObject = std::ptr::null_mut();
        let _: *mut AnyObject = msg_send![&*page, loadHTMLString: &*html, baseURL: nothing];
        ensure(run_until(|| loaded(&page)), "the page did not load")?;
        // The class as KVO left it once the page is in: what the watched
        // setters below read. Dressing must not change it.
        let watched_class = class_name(window);

        let after = dress(window, &page)?;
        ensure(after.holds(), &format!("the dressed window says {}", after.describe()))?;
        ensure(
            class_name(window) == watched_class,
            &format!("dressing changed the window's class from {watched_class} to {}", class_name(window)),
        )?;
        takes(window, COLUMN, OutsideUse::Preview, PREVIEW_LEVEL)?;
        takes(window, CARD, OutsideUse::Drag, DRAG_LEVEL)?;
        takes(window, COLUMN, OutsideUse::Preview, PREVIEW_LEVEL)?;
        ensure(dressed(window).holds(), "the window lost its flags as it moved")?;

        let _: () = msg_send![&*page, removeFromSuperview];
        drop(page);
        drop(tao_window);
        Ok(())
    }

    /// Run `part` with its own autorelease pool, so the windows it made go
    /// before it ends: an exception thrown as they go is the part's.
    fn part(name: &str, run: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        match objc2::exception::catch(AssertUnwindSafe(|| autoreleasepool(|_| run()))) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(why)) => Err(format!("{name}: {why}")),
            Err(Some(thrown)) => Err(format!("{name}: AppKit threw {thrown}")),
            Err(None) => Err(format!("{name}: AppKit threw an exception with no object")),
        }
    }

    pub fn run() -> Result<Outcome, String> {
        // SAFETY: a public function of CoreGraphics; what it returns is
        // released once.
        let session = unsafe { CGSessionCopyCurrentDictionary() };
        if session.is_null() {
            return Ok(Outcome::Skipped("no window server session: AppKit can make no window here"));
        }
        // SAFETY: the dictionary the call above returned, owned here.
        unsafe { CFRelease(session) };
        std::thread::spawn(|| {
            std::thread::sleep(DEADLINE);
            eprintln!("outside_window: no end within {} s", DEADLINE.as_secs());
            std::process::exit(2);
        });
        let mut event_loop: EventLoop<()> = EventLoopBuilder::new().build();
        // The loop never runs here: the policy is set on the app below too.
        event_loop.set_activation_policy(ActivationPolicy::Prohibited);
        // SAFETY: the process's main thread (`main` runs on it), the only
        // one AppKit is used from here.
        unsafe {
            let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let application = application.as_ref().ok_or("no shared application")?;
            let _: bool = msg_send![application, setActivationPolicy: ACTIVATION_PROHIBITED];
            let policy: isize = msg_send![application, activationPolicy];
            ensure(
                policy == ACTIVATION_PROHIBITED,
                "the process could not be kept out of the Dock and from activation",
            )?;
            part("the first window", || one_round(&event_loop))?;
            part("a second window after the first went", || one_round(&event_loop))?;
        }
        Ok(Outcome::Passed)
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    match appkit::run() {
        Ok(appkit::Outcome::Passed) => println!("outside_window: ok"),
        Ok(appkit::Outcome::Skipped(why)) => println!("outside_window: skipped, {why}"),
        Err(why) => {
            eprintln!("outside_window: FAILED, {why}");
            std::process::exit(1);
        }
    }
    #[cfg(not(target_os = "macos"))]
    println!("outside_window: skipped, the outside window is a macOS window");
}
