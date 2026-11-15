//! The person holding the edge of a tab window (SPEC_MOTION_LEVELS.md, Р1,
//! С3; user's decision of 15.11.2026). A window the person resizes by its
//! edge squeezes or widens the sidebar of its pages, and the sidebar's move
//! across its compact threshold then answers a drag in hand: it runs on the
//! spring at every motion level. A page only sees its new size, the same as
//! after the green button, the system's tiling or full screen, which are
//! commands and move by the level. `AppKit` tells them apart: it calls a
//! resize the person drives live, posting
//! `NSWindowWillStartLiveResizeNotification` on the press on the edge,
//! before the window's size changes, and
//! `NSWindowDidEndLiveResizeNotification` on the release, after its last
//! change; the other resizes are not live. The backend passes both to the
//! pages of the window's tabs as `window-live-resize` (SPEC_TABS.md, В21):
//! `true` at the start, `false` at the end.

use tauri::{AppHandle, Window};

use crate::commands::space_events;
use crate::domain::windows::{SavedWindows, WindowId};

/// The event the pages of a window's tabs hear: `true` once the person
/// starts resizing the window by its edge, `false` once they release it.
pub const WINDOW_LIVE_RESIZE_EVENT: &str = "window-live-resize";

/// The labels of the pages of the tabs of window `id`, left to right; none
/// for a window the model does not hold.
pub(crate) fn tab_page_labels(windows: &SavedWindows, id: &WindowId) -> Vec<String> {
    windows
        .window(id)
        .map(|window| window.tabs.iter().map(|tab| tab.id.label()).collect())
        .unwrap_or_default()
}

/// Tells the pages of window `id`'s tabs whether its edge is in hand.
fn send(app: &AppHandle, id: &WindowId, live: bool) {
    let labels = tab_page_labels(&super::shell(app).snapshot(), id);
    space_events::emit_to_labels(app, labels, WINDOW_LIVE_RESIZE_EVENT, live);
}

/// Follows the live resizes of tab window `window`, `id` in the model, until
/// it is destroyed.
pub fn observe(app: &AppHandle, window: &Window, id: &WindowId) {
    imp::observe(app, window, id);
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSNotificationName, NSObjectProtocol};
    use tauri::{AppHandle, Window, WindowEvent};

    use super::send;
    use crate::domain::windows::WindowId;

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSWindowWillStartLiveResizeNotification: &'static NSNotificationName;
        static NSWindowDidEndLiveResizeNotification: &'static NSNotificationName;
    }

    /// The notification center's tokens of a window's two observers.
    struct Tokens(Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>);

    // SAFETY: the tokens are made on the main thread and taken back on it,
    // where Tauri runs a window's events; no other thread touches them.
    unsafe impl Send for Tokens {}

    pub fn observe(app: &AppHandle, window: &Window, id: &WindowId) {
        let app = app.clone();
        let id = id.clone();
        let window = window.clone();
        let _ = window.clone().run_on_main_thread(move || {
            let Ok(ptr) = window.ns_window() else {
                return;
            };
            // SAFETY: the live NSWindow of this window, on the main thread.
            let ns_window: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
            let center = NSNotificationCenter::defaultCenter();
            // SAFETY: AppKit's own names, read on the main thread.
            let names = unsafe { [(NSWindowWillStartLiveResizeNotification, true), (NSWindowDidEndLiveResizeNotification, false)] };
            let tokens: Vec<_> = names
                .into_iter()
                .map(|(name, live)| {
                    let app = app.clone();
                    let id = id.clone();
                    // Without a queue the block runs where AppKit posts, on
                    // the main thread, before the start's first size change:
                    // the pages are told ahead of their first new size.
                    let block = RcBlock::new(move |_: NonNull<NSNotification>| send(&app, &id, live));
                    // SAFETY: the notifications of this window only, no queue.
                    unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), Some(ns_window), None, &block) }
                })
                .collect();
            let tokens = Arc::new(Mutex::new(Some(Tokens(tokens))));
            window.on_window_event(move |event| {
                if !matches!(event, WindowEvent::Destroyed) {
                    return;
                }
                let taken = tokens.lock().ok().and_then(|mut tokens| tokens.take());
                if let Some(Tokens(tokens)) = taken {
                    let center = NSNotificationCenter::defaultCenter();
                    for token in tokens {
                        // SAFETY: a token this center handed out, on the
                        // main thread.
                        unsafe { center.removeObserver(AsRef::<AnyObject>::as_ref(&*token)) };
                    }
                }
            });
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::{AppHandle, Window};

    use crate::domain::windows::WindowId;

    pub fn observe(_app: &AppHandle, _window: &Window, _id: &WindowId) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::windows::{SavedTab, SavedWindow, SidebarLayout, TabId, TabSpace, TabView, WindowFrame, SAVED_WINDOWS_VERSION};

    fn window(id: &str, tabs: &[&str]) -> SavedWindow {
        let tabs: Vec<SavedTab> = tabs
            .iter()
            .map(|tab| SavedTab {
                id: TabId((*tab).into()),
                space: TabSpace::Space { vault_id: "space".into() },
                view: TabView::default(),
                sidebar: None,
            })
            .collect();
        SavedWindow {
            id: WindowId(id.into()),
            frame: WindowFrame { x: 0.0, y: 0.0, width: 1200.0, height: 831.0 },
            fullscreen: false,
            active_tab: tabs[0].id.clone(),
            tabs,
            sidebar: SidebarLayout::default(),
        }
    }

    fn windows() -> SavedWindows {
        SavedWindows {
            version: SAVED_WINDOWS_VERSION,
            windows: vec![window("w1", &["a", "b", "c"]), window("w2", &["d"])],
            window_surface: None,
        }
    }

    #[test]
    fn a_live_resize_goes_to_every_tab_page_of_its_window_and_no_other() {
        let labels = tab_page_labels(&windows(), &WindowId("w1".into()));
        let expected: Vec<String> = ["a", "b", "c"].iter().map(|tab| TabId((*tab).into()).label()).collect();
        assert_eq!(labels, expected);
        assert!(!labels.contains(&TabId("d".into()).label()));
        // Neither the window's bar nor the window itself is a tab's page.
        assert!(!labels.contains(&WindowId("w1".into()).bar_label()));
        assert!(!labels.contains(&WindowId("w1".into()).label()));
    }

    #[test]
    fn a_window_the_model_does_not_hold_has_no_pages_to_tell() {
        assert!(tab_page_labels(&windows(), &WindowId("gone".into())).is_empty());
    }
}
