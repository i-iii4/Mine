// The interface and article fonts are fixed to Geist and Geist Sans.
// The previous storage keys are normalized at startup for existing installs.

export type InterfaceFont = "geist" | "departure";
export type ContentFont = "geist-sans" | "geist-mono";

export const INTERFACE_FONT_STORAGE_KEY = "mine.fontInterface";
export const CONTENT_FONT_STORAGE_KEY = "mine.fontContent";

export const INTERFACE_FONTS: readonly InterfaceFont[] = ["geist", "departure"];
export const CONTENT_FONTS: readonly ContentFont[] = ["geist-sans", "geist-mono"];

export function getStoredInterfaceFont(): InterfaceFont {
  return "geist";
}

export function getStoredContentFont(): ContentFont {
  return "geist-sans";
}

export function applyInterfaceFont(_font: InterfaceFont) {
  localStorage.setItem(INTERFACE_FONT_STORAGE_KEY, "geist");
  document.documentElement.setAttribute("data-font-interface", "geist");
}

export function applyContentFont(_font: ContentFont) {
  localStorage.setItem(CONTENT_FONT_STORAGE_KEY, "geist-sans");
  document.documentElement.setAttribute("data-font-content", "geist-sans");
}
