import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { dismissActionFailure, reportActionError } from "./actionFailures";

/// Copies text to the system clipboard through the native host.
///
/// Not `navigator.clipboard`: WKWebView rejects a write once the document
/// loses focus, and a menu item that copies does exactly that — Radix closes
/// the menu and moves focus as it fires `onSelect`. The rejection surfaced
/// nowhere, so "Copy Path" simply did nothing. The Rust side has no such
/// notion of focus. A write that fails is the tab's notice under
/// `failureTitle`, `Could not copy the path` or `… the link`
/// (SPEC_DEEP_AUDIT.md, Н11, Е6.16).
export function copyTextToClipboard(text: string, failureTitle: string): void {
  void writeText(text).then(
    () => dismissActionFailure("copy"),
    (error: unknown) => reportActionError("copy", failureTitle, error),
  );
}
