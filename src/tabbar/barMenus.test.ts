import { describe, expect, it } from "vitest";
import { menuActionCloses, menuSpecSize } from "@/lib/menuSpec";
import { SETTINGS_SECTIONS } from "@/lib/settingsSections";
import type { MenuSpec } from "@/types";
import {
  BAR_BUTTON_STYLE_ID,
  BAR_MENU_MODE_ID,
  CLOSE_OTHER_TABS_LABEL,
  CLOSE_TAB_LABEL,
  CLOSE_TABS_TO_THE_LEFT_LABEL,
  CLOSE_TABS_TO_THE_RIGHT_LABEL,
  MOVE_TAB_TO_NEW_WINDOW_LABEL,
  barSettingsChoice,
  barSettingsSpec,
  tabMenuItemId,
  tabMenuSpec,
} from "./barMenus";

/** The rows of a menu that can be chosen now, by their ids. */
function enabled(spec: MenuSpec): string[] {
  return spec.entries.flatMap((entry) => (entry.kind === "item" && !entry.disabled ? [entry.id] : []));
}

describe("a tab's menu for the menu panel (SPEC_TABS.md, В50)", () => {
  it("lists Move Tab to New Window, a separator, Close Tab, Close Other Tabs and the tabs to each side, with no icons", () => {
    const spec = tabMenuSpec(1, 3);
    expect(spec.role).toBe("action");
    expect(spec.entries.map((entry) => (entry.kind === "item" ? entry.label : entry.kind))).toEqual([
      MOVE_TAB_TO_NEW_WINDOW_LABEL,
      "separator",
      CLOSE_TAB_LABEL,
      CLOSE_OTHER_TABS_LABEL,
      CLOSE_TABS_TO_THE_LEFT_LABEL,
      CLOSE_TABS_TO_THE_RIGHT_LABEL,
    ]);
    expect(spec.entries.every((entry) => entry.kind !== "item" || (entry.plain && entry.icon === null))).toBe(true);
    expect(menuSpecSize(spec).size).toEqual({ width: 240, height: 10 + 5 * 32 + 9 });
  });

  it("offers neither a new window nor closing others to the only tab", () => {
    expect(enabled(tabMenuSpec(0, 1))).toEqual(["close"]);
  });

  it("offers closing only the sides that have tabs", () => {
    expect(enabled(tabMenuSpec(0, 3))).toEqual(["move-to-new-window", "close", "close-others", "close-right"]);
    expect(enabled(tabMenuSpec(1, 3))).toEqual(["move-to-new-window", "close", "close-others", "close-left", "close-right"]);
    expect(enabled(tabMenuSpec(2, 3))).toEqual(["move-to-new-window", "close", "close-others", "close-left"]);
  });

  it("keeps its rows whatever they may do: the menu's size does not change while it is open", () => {
    expect(menuSpecSize(tabMenuSpec(0, 1))).toEqual(menuSpecSize(tabMenuSpec(1, 3)));
  });

  it("tells its items by their ids", () => {
    expect(tabMenuItemId({ kind: "run", id: "close-left" })).toBe("close-left");
    expect(tabMenuItemId({ kind: "run", id: "appearance" })).toBeNull();
    expect(tabMenuItemId({ kind: "choose", id: "close", value: "close" })).toBeNull();
  });
});

describe("the logo's menu for the menu panel (SPEC_TABS.md, В43)", () => {
  const spec = barSettingsSpec("retro", "window");

  it("lists the settings' sections, then Buttons and Menus as submenus, no row with an icon's slot", () => {
    expect(spec.entries.map((entry) => ("label" in entry ? entry.label : entry.kind))).toEqual([
      ...SETTINGS_SECTIONS.map(({ label }) => label),
      "separator",
      "Buttons",
      "Menus",
    ]);
    expect(spec.entries.every((entry) => entry.kind === "separator" || ((entry.kind === "item" || entry.kind === "submenu") && entry.plain))).toBe(true);
    // The rows, the separator, and each submenu off its row.
    const rows = SETTINGS_SECTIONS.length + 2;
    expect(menuSpecSize(spec).size).toEqual({ width: 240, height: 10 + rows * 32 + 9 });
    const top = 5 + SETTINGS_SECTIONS.length * 32 + 9;
    expect(menuSpecSize(spec).submenus).toEqual([
      { row_top: top, width: 240, height: 10 + 3 * 32 },
      { row_top: top + 32, width: 240, height: 10 + 2 * 32 },
    ]);
  });

  it("ticks this window's button style and the menus' mode, and closes on a choice of either", () => {
    const [buttons, menus] = spec.entries.flatMap((entry) => (entry.kind === "submenu" ? [entry.content.entries[0]] : []));
    expect(buttons).toMatchObject({ kind: "radio", id: BAR_BUTTON_STYLE_ID, value: "retro", closes: true });
    expect(buttons?.kind === "radio" && buttons.options.map((option) => option.label)).toEqual(["macOS", "Retro", "Linear"]);
    expect(menus).toMatchObject({ kind: "radio", id: BAR_MENU_MODE_ID, value: "window", closes: true });
    expect(menus?.kind === "radio" && menus.options.map((option) => option.value)).toEqual(["web", "window"]);
    expect(menuActionCloses(spec, { kind: "choose", id: BAR_MENU_MODE_ID, value: "web" })).toBe(true);
    expect(menuActionCloses(spec, { kind: "run", id: "appearance" })).toBe(true);
  });

  it("reads a choice as a section, a button style or a menu mode, and nothing else", () => {
    expect(barSettingsChoice({ kind: "run", id: "spaces" })).toEqual({ kind: "section", section: "spaces" });
    expect(barSettingsChoice({ kind: "choose", id: BAR_BUTTON_STYLE_ID, value: "linear" })).toEqual({ kind: "button-style", style: "linear" });
    expect(barSettingsChoice({ kind: "choose", id: BAR_MENU_MODE_ID, value: "web" })).toEqual({ kind: "menu-mode", mode: "web" });
    expect(barSettingsChoice({ kind: "run", id: "buttons" })).toBeNull();
    expect(barSettingsChoice({ kind: "choose", id: BAR_MENU_MODE_ID, value: "native" })).toBeNull();
    expect(barSettingsChoice({ kind: "choose", id: BAR_BUTTON_STYLE_ID, value: "glass" })).toBeNull();
    expect(barSettingsChoice({ kind: "check", id: BAR_MENU_MODE_ID, checked: true })).toBeNull();
  });
});
