// The heights of the top chrome rows (SPEC_TABS.md, В83): the tab bar's row
// and the tab pages' top rows, 30 px or 40 px (a row of the sidebar's
// table). The bottom bar keeps its height. The backend owns the heights,
// because it lays the tab bar and the tab pages out and places the traffic
// lights; every page shows its own row as `data-chrome-height` on its root,
// which sets `--chrome-row-content-height` for the top rows.

import type { ChromeRows } from "@/types";

/** Content heights of a top chrome row (domain/windows.rs). The tall one and
 *  its 1px line step as a sidebar table row, 40px (`--sidebar-row-height`). */
export const STANDARD_CHROME_ROW_HEIGHT = 30;
export const TALL_CHROME_ROW_HEIGHT = 39;

/** The heights the logo's menu offers, in its order; labels name the step. */
export const CHROME_ROW_VARIANTS: readonly { rows: ChromeRows; label: string }[] = [
  { rows: { tab_bar: 30, page: 30 }, label: "Chrome Height 30" },
  { rows: { tab_bar: 39, page: 39 }, label: "Chrome Height 40" },
  { rows: { tab_bar: 30, page: 39 }, label: "Chrome Height 40, Tab Bar 30" },
];

/** The event the backend sends every page when the heights change. */
export const CHROME_ROWS_EVENT = "chrome-rows-changed";

export function sameChromeRows(a: ChromeRows, b: ChromeRows): boolean {
  return a.tab_bar === b.tab_bar && a.page === b.page;
}

/** Show this page's top rows `height` tall. */
export function applyChromeRowHeight(height: number): void {
  const root = document.documentElement;
  // The attribute names the step; the content height follows from the token.
  if (height === TALL_CHROME_ROW_HEIGHT) root.setAttribute("data-chrome-height", "40");
  else root.removeAttribute("data-chrome-height");
}
