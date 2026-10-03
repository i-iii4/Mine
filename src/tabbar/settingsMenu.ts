// The logo's menu in the tab bar (SPEC_TABS.md, В43): the sections of the
// settings window. It is native, like the tab menu: the bar page is one row
// tall and would clip a menu drawn inside it (В6).

import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settingsSections";

/** The bar's settings menu. */
export interface SettingsMenu {
  /** Show the menu with its top left corner at `at`, in the bar's pixels. */
  open: (at: { x: number; y: number }) => Promise<void>;
}

/** Build the menu once; an item opens the settings window at its section. */
export async function createSettingsMenu(
  openSection: (section: SettingsSection) => void,
): Promise<SettingsMenu> {
  const items = await Promise.all(
    SETTINGS_SECTIONS.map(({ id, label }) => MenuItem.new({ text: label, action: () => openSection(id) })),
  );
  const menu = await Menu.new({ items });
  return {
    // The bar page starts at the window's top left corner, so its pixels are
    // the window's.
    open: (at) => menu.popup(new LogicalPosition(at.x, at.y)),
  };
}
