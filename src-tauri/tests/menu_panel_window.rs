//! The menu panel's own window on real AppKit objects (SPEC_MENU_WINDOW.md,
//! МО62, МО62а, МО30а): a window of the panel's class takes the page out of
//! the window it was made in, answers "no" to both questions at rest, takes
//! its flags and a new frame while AppKit and WebKit watch it by KVO, and
//! goes without an exception. The first МО62 changed the class of a living
//! window and crashed the app at its start (15.11.2026): in the first
//! watched setter, and it would have thrown when the window went.
//!
//! The page is laid out in the shell as Tauri lays out every window's page
//! (its `unstable` feature): a child view of a fixed size, which Tauri
//! sizes itself when its window resizes. The page moved into the panel
//! takes each new frame of the panel: its view, and its area as the page
//! reads it (МО30а). The second МО62 left the page the shell's size, and no
//! menu was ever drawn (16.11.2026).
//!
//! What this cannot hold: the page's frames, and with them its `resize`
//! events. WebKit gives a page in a window that is not on the screen no
//! rendering update (`requestAnimationFrame` never runs), and a `resize`
//! event is dispatched in one; no window comes to the screen here. A test
//! that waited for the event passed on one machine and failed three times
//! of three on another (17.11.2026). The page needs no event when its area
//! has the frame's size as the opening reaches it (МО30), and that is what
//! this holds. The first frame of a menu is held by the app's log (МО40а).
//!
//! No standard harness (`harness = false` in Cargo.toml): AppKit makes a
//! window on the process's main thread only, and the harness runs tests on
//! other threads.
//!
//! Nothing comes to the screen and nothing takes the focus: no window is
//! ordered in, and the process may not be activated (activation policy
//! `prohibited`: no Dock icon). With no window server (a build machine with
//! no one logged in) the test is skipped and says why.

#[cfg(target_os = "macos")]
mod appkit {
    use std::cell::RefCell;
    use std::ffi::{c_void, CStr};
    use std::panic::AssertUnwindSafe;
    use std::rc::Rc;
    use std::time::Duration;

    use mine_lib::menu_panel_window::{adopt, forget};
    use objc2::rc::{autoreleasepool, Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    /// `NSApplicationActivationPolicyProhibited`.
    const ACTIVATION_PROHIBITED: isize = 2;
    /// `NSWindowStyleMaskBorderless`.
    const STYLE_BORDERLESS: usize = 0;
    /// `NSBackingStoreBuffered`.
    const BACKING_BUFFERED: usize = 2;
    /// `NSViewMinYMargin`: a view of a fixed size at the top of its parent,
    /// as wry lays out a child page.
    const PINNED_TO_THE_TOP: usize = 1 << 3;
    /// `NSPopUpMenuWindowLevel`.
    const POP_UP_MENU_LEVEL: isize = 101;
    /// The panel at rest and a card's menu with its submenu, in points.
    const REST: (f64, f64) = (264.0, 300.0);
    const MENU: (f64, f64) = (564.0, 332.0);
    /// The whole test takes about a second; one that hangs ends here, at
    /// the time after which cargo itself calls a test slow.
    const DEADLINE: Duration = Duration::from_secs(60);
    /// How long the test waits for WebKit, a step of its run loop at a
    /// time: the page's load, a script's answer, the page's new size.
    const WEBKIT_WAIT: Duration = Duration::from_secs(10);
    const RUN_LOOP_STEP_S: f64 = 0.01;
    /// A page whose script marks that it ran.
    const PAGE: &str = "<!doctype html><script>window.loaded = true;</script>";
    /// What the page says of itself: its area, and whether its script ran.
    const AREA: &str = "[innerWidth, innerHeight, window.loaded === true ? 1 : 0].join(' ')";

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

    /// How a round ends: as the Web mode takes the panel away (the page
    /// leaves, the shell closes, then the panel's window), or as a failed
    /// setup does (the panel's window first).
    #[derive(Clone, Copy)]
    enum Ending {
        ShellFirst,
        PanelFirst,
    }

    fn ensure(holds: bool, what: &str) -> Result<(), String> {
        if holds {
            Ok(())
        } else {
            Err(what.to_string())
        }
    }

    fn rect(size: (f64, f64)) -> NSRect {
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(size.0, size.1))
    }

    /// Run the main run loop until `done` holds or WebKit's wait is over;
    /// whether it holds.
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

    /// The text of what `script` comes to in `page`, or why there is none.
    unsafe fn evaluate(page: &AnyObject, script: &str) -> Result<String, String> {
        let answer: Rc<RefCell<Option<Result<String, String>>>> = Rc::new(RefCell::new(None));
        let into = Rc::clone(&answer);
        let handler = block2::RcBlock::new(move |value: *mut AnyObject, error: *mut AnyObject| {
            let described = |object: &AnyObject| -> String {
                let text: Retained<NSString> = msg_send![object, description];
                text.to_string()
            };
            let came = match (value.as_ref(), error.as_ref()) {
                (Some(value), _) => Ok(described(value)),
                (None, Some(error)) => Err(described(error)),
                (None, None) => Err("no value".to_string()),
            };
            *into.borrow_mut() = Some(came);
        });
        let source = NSString::from_str(script);
        let _: () = msg_send![page, evaluateJavaScript: &*source, completionHandler: &*handler];
        if !run_until(|| answer.borrow().is_some()) {
            return Err(format!("no answer to `{script}`"));
        }
        let came = answer.borrow_mut().take();
        came.unwrap_or_else(|| Err("no answer".to_string()))
    }

    /// The page's area, and 1 once its script ran.
    unsafe fn area(page: &AnyObject) -> Result<(f64, f64, i64), String> {
        let text = evaluate(page, AREA)?;
        let mut parts = text.split(' ');
        let mut next = || parts.next().and_then(|part| part.parse::<f64>().ok());
        match (next(), next(), next()) {
            #[allow(clippy::cast_possible_truncation)]
            (Some(width), Some(height), Some(loaded)) => Ok((width, height, loaded as i64)),
            _ => Err(format!("the page said `{text}`")),
        }
    }

    /// Load the counting page into `page` and wait until its script runs.
    unsafe fn load(page: &AnyObject) -> Result<(), String> {
        let html = NSString::from_str(PAGE);
        let nothing: *mut AnyObject = std::ptr::null_mut();
        let _: *mut AnyObject = msg_send![page, loadHTMLString: &*html, baseURL: nothing];
        let loaded = run_until(|| area(page).is_ok_and(|(_, _, loaded)| loaded == 1));
        ensure(loaded, "the page did not load")
    }

    /// The page says its area is `size`, as its own script reads it.
    unsafe fn page_takes(page: &AnyObject, size: (f64, f64)) -> Result<(), String> {
        let mut seen = (0.0, 0.0);
        let took = run_until(|| {
            if let Ok((width, height, _)) = area(page) {
                seen = (width, height);
            }
            (seen.0 - size.0).abs() < 0.5 && (seen.1 - size.1).abs() < 0.5
        });
        ensure(
            took,
            &format!("the page did not take the frame {}x{}: its area is {}x{}", size.0, size.1, seen.0, seen.1),
        )
    }

    /// A window as tao makes the shell, and in it a page as Tauri lays out
    /// every window's page: tao's view is the content view, and the web
    /// view is a child of it of the window's size, pinned to its top.
    unsafe fn shell_with_page() -> Result<(Retained<AnyObject>, Retained<AnyObject>), String> {
        let made: Allocated<AnyObject> = msg_send![class!(NSWindow), alloc];
        let shell: Option<Retained<AnyObject>> = msg_send![
            made,
            initWithContentRect: rect(REST),
            styleMask: STYLE_BORDERLESS,
            backing: BACKING_BUFFERED,
            defer: false
        ];
        let shell = shell.ok_or("AppKit made no window")?;
        let _: () = msg_send![&*shell, setReleasedWhenClosed: false];
        let made: Allocated<AnyObject> = msg_send![class!(NSView), alloc];
        let parent: Retained<AnyObject> = msg_send![made, initWithFrame: rect(REST)];
        let web_view = AnyClass::get(c"WKWebView").ok_or("WebKit is not loaded")?;
        let configuration: Retained<AnyObject> = msg_send![class!(WKWebViewConfiguration), new];
        // Nothing of the test stays on the disk.
        let store: Retained<AnyObject> = msg_send![class!(WKWebsiteDataStore), nonPersistentDataStore];
        let _: () = msg_send![&*configuration, setWebsiteDataStore: &*store];
        let made: Allocated<AnyObject> = msg_send![web_view, alloc];
        let page: Retained<AnyObject> = msg_send![made, initWithFrame: rect(REST), configuration: &*configuration];
        let _: () = msg_send![&*page, setAutoresizingMask: PINNED_TO_THE_TOP];
        let _: () = msg_send![&*parent, addSubview: &*page];
        let _: () = msg_send![&*shell, setContentView: &*parent];
        let _: bool = msg_send![&*shell, makeFirstResponder: &*page];
        Ok((shell, page))
    }

    /// The window `page` is in.
    unsafe fn window_of(page: &AnyObject) -> Option<&AnyObject> {
        let window: *mut AnyObject = msg_send![page, window];
        window.as_ref()
    }

    /// The panel's window is of its own class from its making: the class it
    /// says it is and the class it really is are the panel's, or KVO's
    /// class made right above the panel's.
    unsafe fn is_of_the_panels_class(window: &AnyObject) -> bool {
        let panels: &CStr = c"MineMenuPanelWindow";
        let said: *const AnyClass = msg_send![window, class];
        let Some(said) = said.as_ref() else { return false };
        let real = window.class();
        said.name() == panels && (real.name() == panels || real.superclass().is_some_and(|above| above.name() == panels))
    }

    unsafe fn one_round(ending: Ending) -> Result<(), String> {
        let (shell, page) = shell_with_page()?;
        load(&page)?;
        let (width, height, _) = area(&page)?;
        ensure((width - REST.0).abs() < 0.5 && (height - REST.1).abs() < 0.5, "the page is not the shell's size")?;
        adopt(&shell, &page)?;
        let window = window_of(&page).ok_or("the page is in no window")?;
        ensure(!std::ptr::eq(window, &*shell), "the page stayed in the shell")?;
        ensure(is_of_the_panels_class(window), "the panel's window is not of the panel's class")?;
        let main: bool = msg_send![window, canBecomeMainWindow];
        let key: bool = msg_send![window, canBecomeKeyWindow];
        ensure(!main && !key, "the panel's window may become main or key at rest")?;
        let opaque: bool = msg_send![window, isOpaque];
        let shadow: bool = msg_send![window, hasShadow];
        let passes_clicks: bool = msg_send![window, ignoresMouseEvents];
        let alpha: f64 = msg_send![window, alphaValue];
        let level: isize = msg_send![window, level];
        ensure(!opaque && !shadow && passes_clicks && alpha == 0.0, "the panel's window is not clear, unseen and passing clicks")?;
        ensure(level == POP_UP_MENU_LEVEL, "the panel's window is not on the level of a menu")?;
        let on_screen: bool = msg_send![window, isVisible];
        ensure(!on_screen, "the panel's window came to the screen")?;
        let first: *mut AnyObject = msg_send![window, firstResponder];
        ensure(std::ptr::eq(first, &*page), "the page does not take the keys of the panel's window")?;
        // What opening and closing a menu send the window, while AppKit and
        // WebKit watch it: the crash was in the first of such setters.
        let _: () = msg_send![window, setIgnoresMouseEvents: false];
        let _: () = msg_send![window, setFrame: rect(MENU), display: false];
        let _: () = msg_send![window, setIgnoresMouseEvents: true];
        let _: () = msg_send![window, setOpaque: false];
        let _: () = msg_send![window, setHasShadow: false];
        let _: () = msg_send![window, setAlphaValue: 1.0_f64];
        let _: () = msg_send![window, setAlphaValue: 0.0_f64];
        let frame: NSRect = msg_send![&*page, frame];
        ensure(
            (frame.size.width - MENU.0).abs() < 0.5 && (frame.size.height - MENU.1).abs() < 0.5,
            "the page's view did not follow the frame of the panel's window",
        )?;
        // The page itself takes the frame, as it waits to (МО30); then the
        // next frame, back to the size at rest.
        page_takes(&page, MENU)?;
        let _: () = msg_send![window, setFrame: rect(REST), display: false];
        page_takes(&page, REST)?;
        ensure(is_of_the_panels_class(window), "the panel's window changed its class")?;
        match ending {
            Ending::ShellFirst => {
                let _: () = msg_send![&*page, removeFromSuperview];
                let _: () = msg_send![&*shell, close];
                forget();
            }
            Ending::PanelFirst => {
                forget();
                let _: () = msg_send![&*page, removeFromSuperview];
                let _: () = msg_send![&*shell, close];
            }
        }
        ensure(window_of(&page).is_none(), "the page is still in a window")?;
        Ok(())
    }

    /// A view that is not in the shell is no page of it: nothing is made.
    unsafe fn a_stray_view_is_refused() -> Result<(), String> {
        let (shell, page) = shell_with_page()?;
        let stray: Retained<AnyObject> = msg_send![class!(NSView), new];
        ensure(adopt(&shell, &stray).is_err(), "a view outside the shell was taken for its page")?;
        ensure(window_of(&page).is_some_and(|window| std::ptr::eq(window, &*shell)), "the refused shell lost its page")?;
        let _: () = msg_send![&*page, removeFromSuperview];
        let _: () = msg_send![&*shell, close];
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
            eprintln!("menu_panel_window: no end within {} s", DEADLINE.as_secs());
            std::process::exit(2);
        });
        // SAFETY: the process's main thread (`main` runs on it), the only
        // one AppKit is used from here.
        unsafe {
            let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let application = application.as_ref().ok_or("no shared application")?;
            // For this process, one outside a bundle, AppKit answers "no"
            // here while the policy reads `prohibited`: the policy is read
            // back, not the answer.
            let _: bool = msg_send![application, setActivationPolicy: ACTIVATION_PROHIBITED];
            let policy: isize = msg_send![application, activationPolicy];
            ensure(
                policy == ACTIVATION_PROHIBITED,
                "the process could not be kept out of the Dock and from activation",
            )?;
            part("a panel taken away by its shell", || one_round(Ending::ShellFirst))?;
            part("a panel taken away first, after one was made before", || one_round(Ending::PanelFirst))?;
            part("a view outside the shell", || a_stray_view_is_refused())?;
        }
        Ok(Outcome::Passed)
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    match appkit::run() {
        Ok(appkit::Outcome::Passed) => println!("menu_panel_window: ok"),
        Ok(appkit::Outcome::Skipped(why)) => println!("menu_panel_window: skipped, {why}"),
        Err(why) => {
            eprintln!("menu_panel_window: FAILED, {why}");
            std::process::exit(1);
        }
    }
    #[cfg(not(target_os = "macos"))]
    println!("menu_panel_window: skipped, the menu panel is a macOS window");
}
