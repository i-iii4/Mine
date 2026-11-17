// What the tab bar's menus hold, as data: a tab's menu (SPEC_TABS.md, В50)
// and the logo's (В43), for the menu panel (`MenuSpec`,
// src/components/MenuSpecView.tsx; SPEC_MENU_WINDOW.md, МО16, group Е). The
// bar page is one row tall and would clip a menu drawn inside it (В6): its
// menus open in the menu panel, and where the panel takes none, as the
// system's own (tabMenu.ts, settingsMenu.ts), which hold these rows too.
// Neither menu has an icon: their rows stand with no leading slot.

import { BUTTON_STYLES, type ButtonStyle } from "@/lib/buttonStyle";
import { MENU_MODES, type MenuMode } from "@/lib/menuMode";
import { menuItem, menuSubmenu } from "@/lib/menuSpec";
import { SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settingsSections";
import type { MenuAction, MenuEntry, MenuSpec } from "@/types";

export const MOVE_TAB_TO_NEW_WINDOW_LABEL = "Move Tab to New Window";
export const CLOSE_TAB_LABEL = "Close Tab";
export const CLOSE_OTHER_TABS_LABEL = "Close Other Tabs";
export const CLOSE_TABS_TO_THE_LEFT_LABEL = "Close Tabs to the Left";
export const CLOSE_TABS_TO_THE_RIGHT_LABEL = "Close Tabs to the Right";

const TAB_ITEM_IDS = ["move-to-new-window", "close", "close-others", "close-left", "close-right"] as const;

export type TabMenuItemId = (typeof TAB_ITEM_IDS)[number];

/** The item of a tab's menu `action` chooses, or null. */
export function tabMenuItemId(action: MenuAction): TabMenuItemId | null {
  return action.kind === "run" ? TAB_ITEM_IDS.find((item) => item === action.id) ?? null : null;
}

/**
 * The menu of the tab at `index` of `tabCount`. A single tab has no other
 * tabs to close and already has a window of its own; a side with no tabs
 * has nothing to close: those rows cannot be chosen.
 */
export function tabMenuSpec(index: number, tabCount: number): MenuSpec {
  const severable = tabCount > 1;
  const item = (id: TabMenuItemId, label: string, enabled: boolean): MenuEntry =>
    menuItem(id, label, { plain: true, disabled: !enabled });
  return {
    role: "action",
    entries: [
      item("move-to-new-window", MOVE_TAB_TO_NEW_WINDOW_LABEL, severable),
      { kind: "separator" },
      item("close", CLOSE_TAB_LABEL, true),
      item("close-others", CLOSE_OTHER_TABS_LABEL, severable),
      item("close-left", CLOSE_TABS_TO_THE_LEFT_LABEL, index > 0),
      item("close-right", CLOSE_TABS_TO_THE_RIGHT_LABEL, index < tabCount - 1),
    ],
  };
}

/** The choices of the logo's menu: this window's button style, and where
 *  the app's menus are drawn. */
export const BAR_BUTTON_STYLE_ID = "buttons.style";
export const BAR_MENU_MODE_ID = "menus.mode";

/**
 * The logo's menu in the bar: the sections of the settings window, then the
 * dev button styles of this window and the menus trial, each a submenu with
 * the value on ticked. A choice there closes the menu.
 */
export function barSettingsSpec(style: ButtonStyle, mode: MenuMode): MenuSpec {
  const choice = (id: string, value: string, options: readonly { value: string; label: string }[]): MenuSpec => ({
    role: "action",
    entries: [{ kind: "radio", id, value, options: options.map((option) => ({ value: option.value, label: option.label })), closes: true }],
  });
  return {
    role: "action",
    entries: [
      ...SETTINGS_SECTIONS.map(({ id, label }) => menuItem(id, label, { plain: true })),
      { kind: "separator" },
      menuSubmenu("buttons", "Buttons", choice(BAR_BUTTON_STYLE_ID, style, BUTTON_STYLES), { plain: true }),
      menuSubmenu("menus", "Menus", choice(BAR_MENU_MODE_ID, mode, MENU_MODES), { plain: true }),
    ],
  };
}

/** What a choice made in the logo's menu asks for. */
export type BarSettingsChoice =
  | { kind: "section"; section: SettingsSection }
  | { kind: "button-style"; style: ButtonStyle }
  | { kind: "menu-mode"; mode: MenuMode };

/** What `action` asks for in the logo's menu, or null when it names nothing
 *  the menu holds. */
export function barSettingsChoice(action: MenuAction): BarSettingsChoice | null {
  if (action.kind === "run") {
    const section = SETTINGS_SECTIONS.find(({ id }) => id === action.id);
    return section === undefined ? null : { kind: "section", section: section.id };
  }
  if (action.kind !== "choose") return null;
  if (action.id === BAR_BUTTON_STYLE_ID) {
    const style = BUTTON_STYLES.find(({ value }) => value === action.value);
    return style === undefined ? null : { kind: "button-style", style: style.value };
  }
  if (action.id === BAR_MENU_MODE_ID) {
    const mode = MENU_MODES.find(({ value }) => value === action.value);
    return mode === undefined ? null : { kind: "menu-mode", mode: mode.value };
  }
  return null;
}
