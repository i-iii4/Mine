// Backend events, heard by this page only (SPEC_TABS.md, В21, В22).
//
// Every tab is its own page, and the backend addresses events to pages by
// label: a space's news goes to that space's tabs, a tab's role to that tab.
// A global `listen` would also hear what was meant for another tab, so pages
// subscribe through their own webview. Events the backend sends to every
// page still arrive here.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";

/**
 * Subscribe this page to `event`. Outside a Tauri page (a dev browser route)
 * the subscription fails as a rejected promise, as a global `listen` did.
 */
export async function listenPage<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return getCurrentWebview().listen<T>(event, handler);
}
