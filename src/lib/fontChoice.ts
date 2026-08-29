// Font switching — interface and content families, chosen in Settings.
//
// Interface: the whole UI, cards included ("Geist" default, "Departure Mono"
// as the alternative). Card heights are measured with the interface font, so
// the main window reloads itself when this changes — module-level metric
// constants (spec, cache hash) are derived from the stored value at load.
//
// Content: the article body in Detail only ("Geist Sans" default,
// "Geist Mono" alternative). Purely presentational — no measurements depend
// on it, so it applies live via a data attribute.

export type InterfaceFont = "geist" | "departure";
export type ContentFont = "geist-sans" | "geist-mono";

export const INTERFACE_FONT_STORAGE_KEY = "mine.fontInterface";
export const CONTENT_FONT_STORAGE_KEY = "mine.fontContent";

export const INTERFACE_FONTS: readonly InterfaceFont[] = ["geist", "departure"];
export const CONTENT_FONTS: readonly ContentFont[] = ["geist-sans", "geist-mono"];

export function getStoredInterfaceFont(): InterfaceFont {
  if (typeof window === "undefined") return "geist";
  const raw = window.localStorage.getItem(INTERFACE_FONT_STORAGE_KEY);
  return raw === "departure" ? "departure" : "geist";
}

export function getStoredContentFont(): ContentFont {
  if (typeof window === "undefined") return "geist-sans";
  const raw = window.localStorage.getItem(CONTENT_FONT_STORAGE_KEY);
  return raw === "geist-mono" ? "geist-mono" : "geist-sans";
}

export function applyInterfaceFont(font: InterfaceFont) {
  localStorage.setItem(INTERFACE_FONT_STORAGE_KEY, font);
  document.documentElement.setAttribute("data-font-interface", font);
}

export function applyContentFont(font: ContentFont) {
  localStorage.setItem(CONTENT_FONT_STORAGE_KEY, font);
  document.documentElement.setAttribute("data-font-content", font);
}
