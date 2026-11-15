// TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): where
// the card menu of the feed is drawn. `web`, the default, is the menu on the
// page as before; `window` draws it in the menu panel, a window of its own
// that may reach past the window's edge. The logo menu's Menus item sets it
// for the whole app, as the experiment of 06.10.2026 had `Menus: Web /
// System` there. Removing the trial is this module, src/lib/menuPanel*.ts,
// src/menuPanel, menu-panel.html and the backend's menu_panel modules.

import { broadcastSettingsChange } from "./settingsChanged";

export type MenuMode = "web" | "window";

export const MENU_MODES: readonly { value: MenuMode; label: string }[] = [
  { value: "web", label: "Web" },
  { value: "window", label: "Window" },
];

export const MENU_MODE_STORAGE_KEY = "mine.menus";

export function parseMenuMode(raw: string | null): MenuMode {
  return raw === "window" ? "window" : "web";
}

/** The chosen place of the card menu. Read at each opening: a choice made in
 *  another page reaches this one's storage with `settings-changed`. */
export function menuMode(): MenuMode {
  try {
    return parseMenuMode(window.localStorage.getItem(MENU_MODE_STORAGE_KEY));
  } catch {
    return "web";
  }
}

/** Store `mode` and tell every page. */
export function chooseMenuMode(mode: MenuMode): void {
  try {
    if (mode === "web") window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    else window.localStorage.setItem(MENU_MODE_STORAGE_KEY, mode);
  } catch (error) {
    console.error("Failed to store the menu mode:", error);
  }
  broadcastSettingsChange(MENU_MODE_STORAGE_KEY);
}
