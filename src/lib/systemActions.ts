// Actions that hand something to the system: a link to the browser, a file
// to Finder. A menu item that does this closes on the press, so its failure
// is the tab's notice (SPEC_DEEP_AUDIT.md, Н11, Е6.16); before 13.10.2026 a
// refused link or a file Finder could not show did nothing and said nothing.

import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  OPEN_LINK_FAILED_TITLE,
  REVEAL_FAILED_TITLE,
  dismissActionFailure,
  reportActionError,
} from "./actionFailures";

/** Open `url` in the browser; a failure is the tab's notice. */
export function openLinkInBrowser(url: string): void {
  void openUrl(url).then(
    () => dismissActionFailure("open-link"),
    (error: unknown) => reportActionError("open-link", OPEN_LINK_FAILED_TITLE, error),
  );
}

/** Show `path` in Finder; a failure is the tab's notice. */
export function revealInFinder(path: string): void {
  void revealItemInDir(path).then(
    () => dismissActionFailure("reveal"),
    (error: unknown) => reportActionError("reveal", REVEAL_FAILED_TITLE, error),
  );
}
