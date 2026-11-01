import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_SECTIONS } from "@/lib/settingsSections";
import { BUTTON_STYLES } from "@/lib/buttonStyle";
import { createSettingsMenu } from "./settingsMenu";

interface FakeItem {
  kind: "item" | "check" | "separator" | "submenu";
  text?: string;
  action?: () => void;
  items?: unknown[];
  setChecked?: ReturnType<typeof vi.fn>;
}

const created = vi.hoisted(() => ({
  menuItems: [] as FakeItem[],
  popup: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
}));

vi.mock("@tauri-apps/api/menu", () => ({
  MenuItem: {
    new: vi.fn(async (options: { text: string; action?: () => void }) => ({ kind: "item", ...options })),
  },
  CheckMenuItem: {
    new: vi.fn(async (options: { text: string; action?: () => void }) => ({
      kind: "check",
      ...options,
      setChecked: vi.fn(async () => undefined),
    })),
  },
  PredefinedMenuItem: {
    new: vi.fn(async () => ({ kind: "separator" })),
  },
  Submenu: {
    new: vi.fn(async (options: { text: string; items: unknown[] }) => ({ kind: "submenu", ...options })),
  },
  Menu: {
    new: vi.fn(async (options: { items: FakeItem[] }) => {
      created.menuItems = options.items;
      return { popup: created.popup };
    }),
  },
}));

// SPEC_TABS.md, В43, В83 (user's decision of 30.10.2026: one chrome height).
describe("the logo's settings menu", () => {
  beforeEach(() => {
    created.menuItems = [];
    created.popup.mockClear();
  });

  it("offers the settings' sections and the button styles, no chrome height", async () => {
    const actions = { openSection: vi.fn(), chooseButtonStyle: vi.fn() };
    const menu = await createSettingsMenu(actions);
    const texts = created.menuItems.map((item) => (item.kind === "separator" ? "separator" : item.text));
    expect(texts).toEqual([...SETTINGS_SECTIONS.map(({ label }) => label), "separator", "Buttons"]);
    expect(texts.some((text) => text?.startsWith("Chrome Height"))).toBe(false);

    created.menuItems[0]?.action?.();
    expect(actions.openSection).toHaveBeenCalledWith(SETTINGS_SECTIONS[0].id);
    const buttons = created.menuItems.at(-1);
    expect(buttons?.items).toHaveLength(BUTTON_STYLES.length);

    await menu.open({ x: 10, y: 40 });
    expect(created.popup).toHaveBeenCalledTimes(1);
  });
});
