// The interface and article fonts are the system fonts (decision 06.10.2026):
// SF Pro for text, SF Mono for monospace on macOS. The previous storage keys
// are normalized at startup for existing installs.

export type InterfaceFont = "system" | "departure";
export type ContentFont = "system-sans" | "system-mono";

export const INTERFACE_FONT_STORAGE_KEY = "mine.fontInterface";
export const CONTENT_FONT_STORAGE_KEY = "mine.fontContent";

export const INTERFACE_FONTS: readonly InterfaceFont[] = ["system", "departure"];
export const CONTENT_FONTS: readonly ContentFont[] = ["system-sans", "system-mono"];

/**
 * Font stacks, the same strings the stylesheet sets (`global.css`, checked
 * by fontChoice.test.ts). Canvas measurement reads them from here, so a card
 * is measured in the face the page paints it with. `system-ui` is SF Pro in
 * WebKit and Chromium on macOS; the rest serve other platforms.
 */
export const SYSTEM_SANS_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** `ui-monospace` is SF Mono in WebKit; Chromium skips it and takes Menlo. */
export const SYSTEM_MONO_STACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
export const DEPARTURE_MONO_STACK = '"Departure Mono", ui-monospace, SFMono-Regular, monospace';

export function getStoredInterfaceFont(): InterfaceFont {
  return "system";
}

export function getStoredContentFont(): ContentFont {
  return "system-sans";
}

export function applyInterfaceFont(_font: InterfaceFont) {
  localStorage.setItem(INTERFACE_FONT_STORAGE_KEY, "system");
  document.documentElement.setAttribute("data-font-interface", "system");
}

export function applyContentFont(_font: ContentFont) {
  localStorage.setItem(CONTENT_FONT_STORAGE_KEY, "system-sans");
  document.documentElement.setAttribute("data-font-content", "system-sans");
}
