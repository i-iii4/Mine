// Whether this tab is the one its window shows, as the backend says
// (SPEC_TABS.md, В41).
//
// The page's own `visibilitychange` is not the signal: moving a tab into
// another window hides its page for a millisecond (probe Э0), and media
// paused on that would stop on every move. The backend sends
// `tab-visibility-changed` when it hides or shows the tab, and that alone
// counts here.

import { useSyncExternalStore } from "react";

/** The backend hid or showed this tab (В41). */
export const TAB_VISIBILITY_CHANGED_EVENT = "tab-visibility-changed";

/** What the local page around a YouTube player relays to it as a pause
 *  (PAUSE_MESSAGE in src-tauri/src/youtube_embed.rs). */
const YOUTUBE_WRAPPER_PAUSE_MESSAGE = "mine:pause";

let visible = true;
const listeners = new Set<() => void>();

/** Whether the tab is shown now. A page that is not a tab is always shown. */
export function isTabVisible(): boolean {
  return visible;
}

/** Record what the backend said about this tab and tell the subscribers. */
export function setTabVisible(next: boolean): void {
  if (visible === next) return;
  visible = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether the tab is shown now, re-rendering when that changes. The feed
 * gates its autoplay on it, so a hidden tab decodes no video and a shown one
 * plays again by the feed's own rules (SPEC_FEED_VIDEO.md).
 */
export function useTabVisible(): boolean {
  return useSyncExternalStore(subscribe, isTabVisible, isTabVisible);
}

/**
 * Pause every sound and picture this page plays: the feed's videos, the
 * video of an open card, and YouTube players. Nothing starts again on its own
 * when the tab is shown (В41).
 *
 * The YouTube player lives two frames down: a local page that gives it the
 * referrer it needs, then the player itself (youtube_embed.rs). The player
 * obeys commands only from that local page's origin, so the pause goes to the
 * local page, which relays it.
 */
export function pauseTabMedia(root: ParentNode = document): void {
  for (const media of root.querySelectorAll<HTMLMediaElement>("video, audio")) {
    media.pause();
  }
  for (const frame of root.querySelectorAll<HTMLIFrameElement>("[data-youtube-source-player] iframe")) {
    const wrapperOrigin = URL.canParse(frame.src) ? new URL(frame.src).origin : null;
    if (wrapperOrigin === null) continue;
    frame.contentWindow?.postMessage(YOUTUBE_WRAPPER_PAUSE_MESSAGE, wrapperOrigin);
  }
}
