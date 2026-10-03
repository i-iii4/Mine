// The logo's menu in the tab bar (SPEC_TABS.md, В43): the sections of the
// settings window and the interface version. It is native, like the tab menu:
// the bar page is one row tall and would clip a menu drawn inside it (В6).

import { LogicalPosition } from "@tauri-apps/api/dpi";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settingsSections";
import { UI_VERSIONS, type UiVersion } from "@/lib/uiVersion";

/** The bar's settings menu. */
export interface SettingsMenu {
  /** Show the menu with its top left corner at `at`, in the bar's pixels,
   *  with `version` checked. */
  open: (at: { x: number; y: number }, version: UiVersion) => Promise<void>;
}

/** What the menu's items do. */
export interface SettingsMenuActions {
  openSection: (section: SettingsSection) => void;
  chooseVersion: (version: UiVersion) => void;
}

export function uiVersionLabel(version: UiVersion): string {
  return `Version ${version}`;
}

/** Build the menu once. */
export async function createSettingsMenu(actions: SettingsMenuActions): Promise<SettingsMenu> {
  const sections = await Promise.all(
    SETTINGS_SECTIONS.map(({ id, label }) => MenuItem.new({ text: label, action: () => actions.openSection(id) })),
  );
  const separator = await PredefinedMenuItem.new({ item: "Separator" });
  const versions = await Promise.all(
    UI_VERSIONS.map((version) =>
      CheckMenuItem.new({
        text: uiVersionLabel(version),
        checked: false,
        action: () => actions.chooseVersion(version),
      })),
  );
  const menu = await Menu.new({ items: [...sections, separator, ...versions] });
  return {
    // The bar page starts at the window's top left corner, so its pixels are
    // the window's.
    open: async (at, current) => {
      await Promise.all(versions.map((item, index) => item.setChecked(UI_VERSIONS[index] === current)));
      await menu.popup(new LogicalPosition(at.x, at.y));
    },
  };
}
