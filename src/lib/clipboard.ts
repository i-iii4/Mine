import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/// Copies text to the system clipboard through the native host.
///
/// Not `navigator.clipboard`: WKWebView rejects a write once the document
/// loses focus, and a menu item that copies does exactly that — Radix closes
/// the menu and moves focus as it fires `onSelect`. The rejection surfaced
/// nowhere, so "Copy Path" simply did nothing. The Rust side has no such
/// notion of focus, and the failure path is logged instead of swallowed.
export function copyTextToClipboard(text: string): void {
  void writeText(text).catch((error) => {
    console.error("Failed to copy to clipboard:", error);
  });
}
