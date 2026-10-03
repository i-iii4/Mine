import { useEffect } from "react";
import { applyChromeRowHeight, CHROME_ROWS_EVENT } from "@/lib/chromeHeight";
import type { ChromeRows } from "@/types";
import { useAppearanceSync } from "./appearance";
import { TabBar, TabBarPending } from "./TabBar";
import { listenHere, useTabBarState } from "./useTabBarState";

/** The tab bar page: the window's state from the backend, drawn as one row. */
export function TabBarApp() {
  useAppearanceSync();
  const { bar, dropHover } = useTabBarState();
  // The bar's row height comes with the window's state; each window keeps
  // its own (SPEC_TABS.md, В83).
  const tabBarRow = bar?.chrome_rows.tab_bar;
  useEffect(() => {
    if (tabBarRow !== undefined) applyChromeRowHeight(tabBarRow);
  }, [tabBarRow]);
  useEffect(() => listenHere<ChromeRows>(CHROME_ROWS_EVENT, (rows) => applyChromeRowHeight(rows.tab_bar)), []);
  return bar === null ? <TabBarPending /> : <TabBar bar={bar} dropHover={dropHover} />;
}
