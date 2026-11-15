// src/lib/windowLiveResize.ts: whether the person holds the edge of this
// page's window now (SPEC_MOTION_LEVELS.md, Р1, С3; user's decision of
// 15.11.2026). A window resized by its edge squeezes or widens the sidebar,
// and its move across the compact threshold then answers a drag in hand.
// The page only sees its new size, which the green button, the system's
// tiling and full screen give too; the backend, which AppKit tells about a
// live resize, says when one starts and ends (`window-live-resize`,
// src-tauri/src/tabs/live_resize.rs; SPEC_TABS.md, В21). AppKit posts the
// start on the press on the edge, before the window's size changes, so the
// page hears it before its first new size.
//
// The mark must never outlive the drag: with it a command's width at Off
// would move on the spring. It goes with the end of the live resize, when
// the page loses its window's focus or is hidden or put away, and with the
// page itself; a page made or loaded again starts without it.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { listenPage } from "./pageEvents";

/** The backend's event: `true` once the person starts resizing this page's
 *  window by its edge, `false` once they release it. */
export const WINDOW_LIVE_RESIZE_EVENT = "window-live-resize";

let held = false;

/** Whether the person holds the edge of this page's window now. */
export function windowEdgeInHand(): boolean {
  return held;
}

const release = () => {
  held = false;
};

const releaseWhenHidden = () => {
  if (document.visibilityState === "hidden") held = false;
};

/** Follows the backend's word on this page's window until the returned
 *  teardown, which drops the mark too. Outside a Tauri page the
 *  subscription fails and the mark stays off. */
export function followWindowLiveResize(target: Window = window): () => void {
  let unlisten: UnlistenFn | null = null;
  let stopped = false;
  void listenPage<boolean>(WINDOW_LIVE_RESIZE_EVENT, (event) => {
    held = event.payload === true;
  }).then(
    (stop) => {
      if (stopped) stop();
      else unlisten = stop;
    },
    () => undefined,
  );
  target.addEventListener("blur", release);
  target.addEventListener("pagehide", release);
  target.document.addEventListener("visibilitychange", releaseWhenHidden);
  return () => {
    stopped = true;
    unlisten?.();
    target.removeEventListener("blur", release);
    target.removeEventListener("pagehide", release);
    target.document.removeEventListener("visibilitychange", releaseWhenHidden);
    held = false;
  };
}
