// The logo's menu in the tab bar (SPEC_TABS.md, В43): the sections of the
// settings window and the dev button styles. It is native, like the tab menu:
// the bar page is one row tall and would clip a menu drawn inside it (В6).

import { LogicalPosition } from "@tauri-apps/api/dpi";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settingsSections";
import { BUTTON_STYLES, shownButtonStyle, type ButtonStyle } from "@/lib/buttonStyle";

/** The bar's settings menu. */
export interface SettingsMenu {
  /** Show the menu with its top left corner at `at`, in the bar's pixels. */
  open: (at: { x: number; y: number }) => Promise<void>;
}

/** What the menu's items do. */
export interface SettingsMenuActions {
  openSection: (section: SettingsSection) => void;
  /** Dev button styles (src/lib/buttonStyle.ts): this window's style. */
  chooseButtonStyle: (style: ButtonStyle) => void;
}

/** Build the menu once. */
export async function createSettingsMenu(actions: SettingsMenuActions): Promise<SettingsMenu> {
  const sections = await Promise.all(
    SETTINGS_SECTIONS.map(({ id, label }) => MenuItem.new({ text: label, action: () => actions.openSection(id) })),
  );
  // Dev button styles: Buttons (macOS, Retro, Linear), for this window.
  const styles = await Promise.all(
    BUTTON_STYLES.map(({ value, label }) =>
      CheckMenuItem.new({
        text: label,
        checked: false,
        action: () => actions.chooseButtonStyle(value),
      }).then((item) => ({ value, item }))),
  );
  const buttons = await Submenu.new({ text: "Buttons", items: styles.map(({ item }) => item) });
  const buttonsSeparator = await PredefinedMenuItem.new({ item: "Separator" });
  const menu = await Menu.new({
    items: [...sections, buttonsSeparator, buttons],
  });
  return {
    // The bar page starts at the window's top left corner, so its pixels are
    // the window's.
    open: async (at) => {
      const shown = shownButtonStyle();
      await Promise.all(styles.map(({ value, item }) => item.setChecked(shown === value)));
      await menu.popup(new LogicalPosition(at.x, at.y));
    },
  };
}
