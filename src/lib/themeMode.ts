// Theme mode shared between the main window and the settings window.
// Both windows apply the theme themselves on startup and on change; the
// settings window broadcasts changes via the "settings-changed" Tauri event.

import { setTheme as setTauriTheme } from "@tauri-apps/api/app";

// Theme is the color axis only. The design variant (layout metrics) is an
// orthogonal axis — src/lib/designMode.ts — so any theme combines with any
// design (e.g. light + alt).
export type ThemeMode = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

export function getStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  // High Contrast was merged into Dark; migrate any previously saved value so
  // users who had it selected land on the (now identical) Dark theme.
  if (stored === "high-contrast") return "dark";
  // "alt" briefly shipped as a fourth theme — it is a design variant now;
  // designMode migrates the stored flag, colors fall back to system.
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

export function applyTheme(mode: ThemeMode) {
  localStorage.setItem(THEME_STORAGE_KEY, mode);
  const root = document.documentElement;

  if (mode === "system") {
    root.removeAttribute("data-theme");
    root.style.colorScheme = "";
    void setTauriTheme(null).catch(() => {});
  } else {
    root.setAttribute("data-theme", mode);
    root.style.colorScheme = mode;
    void setTauriTheme(mode).catch(() => {});
  }
}
