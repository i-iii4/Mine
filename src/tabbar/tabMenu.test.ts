import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import {
  CLOSE_OTHER_TABS_LABEL,
  CLOSE_TAB_LABEL,
  MOVE_TAB_TO_NEW_WINDOW_LABEL,
  createTabMenu,
} from "./tabMenu";

interface FakeItem {
  text: string;
  action?: () => void;
  setEnabled: ReturnType<typeof vi.fn>;
}

const created = vi.hoisted(() => ({
  items: [] as Array<{ kind: "item" | "separator"; text?: string; action?: () => void; setEnabled?: ReturnType<typeof vi.fn> }>,
  menuItems: [] as unknown[],
  popup: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/menu", () => ({
  MenuItem: {
    new: vi.fn(async (options: { text: string; action?: () => void }) => {
      const item = { kind: "item" as const, text: options.text, action: options.action, setEnabled: vi.fn(async () => undefined) };
      created.items.push(item);
      return item;
    }),
  },
  PredefinedMenuItem: {
    new: vi.fn(async () => {
      const item = { kind: "separator" as const };
      created.items.push(item);
      return item;
    }),
  },
  Menu: {
    new: vi.fn(async (options: { items: unknown[] }) => {
      created.menuItems = options.items;
      return { popup: created.popup };
    }),
  },
}));

function item(text: string): FakeItem {
  const found = created.items.find((candidate) => candidate.text === text);
  if (!found?.setEnabled) throw new Error(`no menu item ${text}`);
  return { text, action: found.action, setEnabled: found.setEnabled };
}

describe("tab menu (В50)", () => {
  const actions = { moveToNewWindow: vi.fn(), close: vi.fn(), closeOthers: vi.fn() };

  beforeEach(() => {
    created.items = [];
    created.menuItems = [];
    created.popup.mockClear();
    vi.mocked(Menu.new).mockClear();
    vi.mocked(MenuItem.new).mockClear();
    vi.mocked(PredefinedMenuItem.new).mockClear();
    for (const action of Object.values(actions)) action.mockClear();
  });

  it("lists Move Tab to New Window, a separator, Close Tab and Close Other Tabs", async () => {
    await createTabMenu(actions);

    expect(created.menuItems).toEqual(created.items);
    expect(created.items.map((entry) => entry.kind === "separator" ? "separator" : entry.text)).toEqual([
      MOVE_TAB_TO_NEW_WINDOW_LABEL,
      "separator",
      CLOSE_TAB_LABEL,
      CLOSE_OTHER_TABS_LABEL,
    ]);
    expect([MOVE_TAB_TO_NEW_WINDOW_LABEL, CLOSE_TAB_LABEL, CLOSE_OTHER_TABS_LABEL]).toEqual([
      "Move Tab to New Window",
      "Close Tab",
      "Close Other Tabs",
    ]);
    expect(PredefinedMenuItem.new).toHaveBeenCalledWith({ item: "Separator" });
  });

  it("pops up at the pointer and acts on the tab it was opened for", async () => {
    const menu = await createTabMenu(actions);

    await menu.open("tab-b", 3);
    expect(created.popup).toHaveBeenCalledWith();
    item(CLOSE_TAB_LABEL).action?.();
    item(CLOSE_OTHER_TABS_LABEL).action?.();
    item(MOVE_TAB_TO_NEW_WINDOW_LABEL).action?.();

    expect(actions.close).toHaveBeenCalledWith("tab-b");
    expect(actions.closeOthers).toHaveBeenCalledWith("tab-b");
    expect(actions.moveToNewWindow).toHaveBeenCalledWith("tab-b");

    await menu.open("tab-c", 3);
    item(CLOSE_TAB_LABEL).action?.();
    expect(actions.close).toHaveBeenLastCalledWith("tab-c");
  });

  it("is built once for every later right click", async () => {
    const menu = await createTabMenu(actions);
    await menu.open("tab-a", 2);
    await menu.open("tab-b", 2);

    expect(Menu.new).toHaveBeenCalledTimes(1);
    expect(MenuItem.new).toHaveBeenCalledTimes(3);
  });

  it("offers neither a new window nor closing others to the only tab", async () => {
    const menu = await createTabMenu(actions);

    await menu.open("tab-a", 1);
    expect(item(MOVE_TAB_TO_NEW_WINDOW_LABEL).setEnabled).toHaveBeenLastCalledWith(false);
    expect(item(CLOSE_OTHER_TABS_LABEL).setEnabled).toHaveBeenLastCalledWith(false);

    await menu.open("tab-a", 2);
    expect(item(MOVE_TAB_TO_NEW_WINDOW_LABEL).setEnabled).toHaveBeenLastCalledWith(true);
    expect(item(CLOSE_OTHER_TABS_LABEL).setEnabled).toHaveBeenLastCalledWith(true);
  });

  it("does nothing before it was opened for a tab", async () => {
    await createTabMenu(actions);
    item(CLOSE_TAB_LABEL).action?.();
    expect(actions.close).not.toHaveBeenCalled();
  });
});
