// The logo's menu in the tab bar (SPEC_TABS.md, В43): the sections of the
// settings window and the chrome's height. It is native, like the tab menu:
// the bar page is one row tall and would clip a menu drawn inside it (В6).

import { LogicalPosition } from "@tauri-apps/api/dpi";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settingsSections";
import { CHROME_ROW_VARIANTS, sameChromeRows } from "@/lib/chromeHeight";
import { BUTTON_STYLES, shownButtonStyle, type ButtonStyle } from "@/lib/buttonStyle";
import type { ChromeRows } from "@/types";

/** The bar's settings menu. */
export interface SettingsMenu {
  /** Show the menu with its top left corner at `at`, in the bar's pixels,
   *  with the chrome's `rows` checked. */
  open: (at: { x: number; y: number }, rows: ChromeRows) => Promise<void>;
}

/** What the menu's items do. */
export interface SettingsMenuActions {
  openSection: (section: SettingsSection) => void;
  chooseChromeRows: (rows: ChromeRows) => void;
  /** Dev button styles (src/lib/buttonStyle.ts): this window's style. */
  chooseButtonStyle: (style: ButtonStyle) => void;
}

/** Build the menu once. */
export async function createSettingsMenu(actions: SettingsMenuActions): Promise<SettingsMenu> {
  const sections = await Promise.all(
    SETTINGS_SECTIONS.map(({ id, label }) => MenuItem.new({ text: label, action: () => actions.openSection(id) })),
  );
  const heightSeparator = await PredefinedMenuItem.new({ item: "Separator" });
  const heights = await Promise.all(
    CHROME_ROW_VARIANTS.map(({ rows, label }) =>
      CheckMenuItem.new({
        text: label,
        checked: false,
        action: () => actions.chooseChromeRows(rows),
      })),
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
    items: [...sections, heightSeparator, ...heights, buttonsSeparator, buttons],
  });
  return {
    // The bar page starts at the window's top left corner, so its pixels are
    // the window's.
    open: async (at, rows) => {
      const shown = shownButtonStyle();
      await Promise.all([
        ...heights.map((item, index) => {
          const variant = CHROME_ROW_VARIANTS[index];
          return item.setChecked(variant !== undefined && sameChromeRows(variant.rows, rows));
        }),
        ...styles.map(({ value, item }) => item.setChecked(shown === value)),
      ]);
      await menu.popup(new LogicalPosition(at.x, at.y));
    },
  };
}
