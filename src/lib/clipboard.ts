import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { logFailure } from "./appLog";

/** The log line of a Copy Path that failed. */
export const COPY_PATH_FAILED_TITLE = "Could not copy the path";
/** The log line of a Copy Link that failed. */
export const COPY_LINK_FAILED_TITLE = "Could not copy the link";

/// Copies text to the system clipboard through the native host.
///
/// Not `navigator.clipboard`: WKWebView rejects a write once the document
/// loses focus, and a menu item that copies does exactly that — Radix closes
/// the menu and moves focus as it fires `onSelect`. The rejection surfaced
/// nowhere, so "Copy Path" simply did nothing. The Rust side has no such
/// notion of focus. A write that fails goes to Mine's log under
/// `failureTitle`, `Could not copy the path` or `… the link`: it is rare and
/// leaves the person nothing to do (SPEC_DEEP_AUDIT.md, «Решения
/// пользователя 14.10.2026»).
export function copyTextToClipboard(text: string, failureTitle: string): void {
  void writeText(text).catch((error: unknown) => logFailure(failureTitle, error));
}
