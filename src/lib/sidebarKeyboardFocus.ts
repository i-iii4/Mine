// The keyboard's focus on the sidebar's rows (SPEC_KEYBOARD.md, «Sidebar»): the
// walk and what the keys do to a row. A row is reached through the page: the keys
// act on the very row a click or a right click would, so there is one way to open
// it and one menu.

import { sidebarRowDomId } from "./sidebarSearch";

/** The row the focus stands on, and its place when it was set. */
export interface SidebarFocusedRow {
  rowKey: string;
  index: number;
}

/**
 * The row a focus stands on in the list as it is now. A row gone from the list
 * (deleted, or left out by the filter) hands the focus to the row that came to its
 * place, or to the last row: its neighbour. Null only for an empty list.
 */
export function focusedRowKey(rows: readonly string[], focus: SidebarFocusedRow): string | null {
  if (rows.includes(focus.rowKey)) return focus.rowKey;
  return rows[Math.min(focus.index, rows.length - 1)] ?? null;
}

/** The row a step of the walk lands on. Null at the end of the list: the walk
 *  stops there and does not wrap. */
export function walkedRow(
  rows: readonly string[],
  rowKey: string,
  direction: 1 | -1,
): SidebarFocusedRow | null {
  const index = rows.indexOf(rowKey) + direction;
  const next = rows[index];
  return next === undefined ? null : { rowKey: next, index };
}

/**
 * Scrolls the list just enough to show a row, under the list's top and bottom
 * insets. Nothing moves if the row is already in view.
 */
export function scrollSidebarRowIntoView(
  nav: HTMLElement,
  row: HTMLElement,
  behavior: ScrollBehavior,
): void {
  const navRect = nav.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const style = getComputedStyle(nav);
  const topInset = parseFloat(style.paddingTop) || 0;
  const bottomInset = parseFloat(style.paddingBottom) || 0;
  const topLimit = navRect.top + topInset;
  const bottomLimit = navRect.bottom - bottomInset;

  let nextTop = nav.scrollTop;
  if (rowRect.top < topLimit) {
    nextTop -= topLimit - rowRect.top;
  } else if (rowRect.bottom > bottomLimit) {
    nextTop += rowRect.bottom - bottomLimit;
  } else {
    return;
  }

  if (typeof nav.scrollTo === "function") {
    nav.scrollTo({ top: Math.max(0, nextTop), behavior });
  } else {
    nav.scrollTop = Math.max(0, nextTop);
  }
}

function rowElement(rowKey: string): HTMLElement | null {
  return document.getElementById(sidebarRowDomId(rowKey));
}

/** Shows the row the focus landed on, at once (М1, М2). */
export function showFocusedSidebarRow(rowKey: string): void {
  const row = rowElement(rowKey);
  const nav = row?.closest<HTMLElement>("[data-sidebar-scroll]");
  if (row && nav) scrollSidebarRowIntoView(nav, row, "instant");
}

function rowList(rowKey: string): HTMLElement | null {
  return rowElement(rowKey)?.closest<HTMLElement>("[data-sidebar-scroll]") ?? null;
}

/** Where the list holding a row stands. Null while the row is not on the page. */
export function sidebarListScrollTop(rowKey: string): number | null {
  return rowList(rowKey)?.scrollTop ?? null;
}

/** Puts the list holding a row back where it stood, at once. */
export function restoreSidebarListScroll(rowKey: string, top: number): void {
  const nav = rowList(rowKey);
  if (nav) nav.scrollTop = top;
}

/** A moved row's node goes back into the list, and the engine starts its CSS animations
 *  over, so its mark would turn again. They end before the frame is drawn (М11). */
export function settleMovedRowMarks(rowKey: string): void {
  const nav = rowList(rowKey);
  if (!nav || typeof nav.getAnimations !== "function") return;
  for (const animation of nav.getAnimations({ subtree: true })) {
    if ("animationName" in animation && String(animation.animationName).startsWith("sidebar-link-icon")) {
      animation.finish();
    }
  }
}

/** Gives the keyboard back to the open card, with no caret: its scrolling root, the
 *  element it focuses as it opens (М9). */
export function focusOpenCardRoot(): void {
  document.querySelector<HTMLElement>("[data-detail-root] [data-detail-scroll]")?.focus({ preventScroll: true });
}

/** Opens a row by the same path as a click on it (М3). */
export function openFocusedSidebarRow(rowKey: string): void {
  rowElement(rowKey)?.querySelector<HTMLElement>("[data-sidebar-row-body]")?.click();
}

/** Presses the row's `Connect` or `Disconnect`, the button the pointer presses (М3).
 *  A row with no such button, as Everything's, does nothing. */
export function toggleFocusedSidebarRowConnection(rowKey: string): void {
  rowElement(rowKey)?.querySelector<HTMLElement>("[data-sidebar-link-action]")?.click();
}

/**
 * What `Enter` does on a row, as the bottom bar names it (М6): the row opens in the
 * feed; over an open card its connection toggles, by the row's state. Null on a row
 * with no such action.
 */
export function sidebarEnterLabel(
  rowKey: string,
  overCard: boolean,
  linkedTags: readonly string[],
): "Open" | "Connect" | "Disconnect" | null {
  if (!overCard) return "Open";
  if (!rowKey.startsWith("tag:")) return null;
  return linkedTags.includes(rowKey.slice(4)) ? "Disconnect" : "Connect";
}

/**
 * Opens a row's menu, the one a right click opens, out of the row (М7): under
 * it, from where its name starts. Everything's row has no menu, and nothing opens.
 */
export function openFocusedSidebarRowMenu(rowKey: string): void {
  const row = rowElement(rowKey);
  if (!row) return;
  const name = row.querySelector("[data-sidebar-name-text]") ?? row;
  row.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: name.getBoundingClientRect().left,
    clientY: row.getBoundingClientRect().bottom,
    button: 2,
  }));
}
