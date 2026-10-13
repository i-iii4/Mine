// A command of the tab bar that failed, told by the visible tab of its window
// (SPEC_DEEP_AUDIT.md, Н11, Е6.10). The bar is one row 31 px high with no
// room for a notice; the tab under it has the notice corner, and it is the
// tab the person is looking at. Before 13.10.2026 the failure went to the
// console only.

import { emitTo } from "@tauri-apps/api/event";
import type { TabId } from "@/types";

/** The event a tab page hears from the bar of its window. */
export const TAB_BAR_ACTION_FAILED_EVENT = "tab-bar-action-failed";

export interface TabBarActionFailed {
  /** `Could not …`, the action in words (`tabBarFailureTitle`). */
  title: string;
  /** Why, in the words of the error. */
  message: string;
}

/** What the person did, in the words of the notice's title. */
export type TabBarAction =
  | "show the tab"
  | "close the tab"
  | "close the other tabs"
  | "switch tabs"
  | "move the tab"
  | "move the tab to a new window"
  | "open a new tab"
  | "open a new window"
  | "open Settings"
  | "change the height of the top rows"
  | "show or hide the sidebar"
  | "go back"
  | "go forward"
  | "open Find elements"
  | "show the tab menu"
  | "show the settings menu";

export function tabBarFailureTitle(action: TabBarAction): string {
  return `Could not ${action}`;
}

/** The page label of a tab (`TabId::label` in domain/windows.rs). */
export function tabPageLabel(tab: TabId): string {
  return `tab-${tab}`;
}

/// Send `failure` to the page of `tab`, the visible tab of the bar's window.
export function tellVisibleTabOfFailure(tab: TabId, failure: TabBarActionFailed): Promise<void> {
  return emitTo(tabPageLabel(tab), TAB_BAR_ACTION_FAILED_EVENT, failure);
}
