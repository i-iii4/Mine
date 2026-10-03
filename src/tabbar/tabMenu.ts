// The tab's right-click menu (SPEC_TABS.md, В50). It is native: the bar page
// is one row tall and would clip a menu drawn inside it (В6).
//
// One menu serves the whole bar. Its items act on the tab it was last opened
// for, so a right click never creates native menu resources that nothing
// frees afterwards.

import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import type { TabId } from "@/types";

export const MOVE_TAB_TO_NEW_WINDOW_LABEL = "Move Tab to New Window";
export const CLOSE_TAB_LABEL = "Close Tab";
export const CLOSE_OTHER_TABS_LABEL = "Close Other Tabs";

/** What the menu's items do to the tab it was opened for. */
export interface TabMenuActions {
  moveToNewWindow: (tabId: TabId) => void;
  close: (tabId: TabId) => void;
  closeOthers: (tabId: TabId) => void;
}

/** The bar's tab menu. */
export interface TabMenu {
  /** Show the menu at the pointer for `tabId`, one of `tabCount` tabs. */
  open: (tabId: TabId, tabCount: number) => Promise<void>;
}

/** Build the menu once; `actions` receive the tab of the latest `open`. */
export async function createTabMenu(actions: TabMenuActions): Promise<TabMenu> {
  let target: TabId | null = null;
  const act = (run: (tabId: TabId) => void) => () => {
    if (target !== null) run(target);
  };

  const moveToNewWindow = await MenuItem.new({
    text: MOVE_TAB_TO_NEW_WINDOW_LABEL,
    action: act(actions.moveToNewWindow),
  });
  const separator = await PredefinedMenuItem.new({ item: "Separator" });
  const close = await MenuItem.new({ text: CLOSE_TAB_LABEL, action: act(actions.close) });
  const closeOthers = await MenuItem.new({
    text: CLOSE_OTHER_TABS_LABEL,
    action: act(actions.closeOthers),
  });
  const menu = await Menu.new({ items: [moveToNewWindow, separator, close, closeOthers] });

  return {
    open: async (tabId, tabCount) => {
      target = tabId;
      // A single tab has no other tabs to close and already has a window of
      // its own.
      const severable = tabCount > 1;
      await Promise.all([moveToNewWindow.setEnabled(severable), closeOthers.setEnabled(severable)]);
      // No position: the menu opens at the pointer in this page's window.
      await menu.popup();
    },
  };
}
