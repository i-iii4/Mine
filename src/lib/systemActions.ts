// Actions that hand something to the system: a link to the browser, a file
// to Finder. A failure is rare and leaves the person nothing to do, so it
// goes to Mine's log only (SPEC_DEEP_AUDIT.md, «Решения пользователя
// 14.10.2026»); from 13.10.2026 to then it was a notice of the tab (Е6.16).

import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { logFailure } from "./appLog";

/** The log line of a link the browser would not open. */
export const OPEN_LINK_FAILED = "Could not open the link";
/** The log line of a file Finder could not show. */
export const REVEAL_FAILED = "Could not reveal in Finder";

/** Open `url` in the browser; a failure goes to the log. */
export function openLinkInBrowser(url: string): void {
  void openUrl(url).catch((error: unknown) => logFailure(`${OPEN_LINK_FAILED} ${url}`, error));
}

/** Show `path` in Finder; a failure goes to the log. */
export function revealInFinder(path: string): void {
  void revealItemInDir(path).catch((error: unknown) => logFailure(`${REVEAL_FAILED} ${path}`, error));
}
