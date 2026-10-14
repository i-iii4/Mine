// A command of the tab bar that failed goes to Mine's log only: it is rare
// and leaves the person nothing to do (SPEC_DEEP_AUDIT.md, «Решения
// пользователя 14.10.2026»). From 13.10.2026 to then the visible tab of the
// window showed it as a notice (Е6.10); the bar itself is one row 31 px high
// with no room for one.

import { logFailure } from "./appLog";

/** What the person did, in the words of the log line. */
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

/** Write that `action` of the tab bar failed, with why, to the log. */
export function logTabBarFailure(action: TabBarAction, error: unknown): void {
  logFailure(tabBarFailureTitle(action), error);
}
