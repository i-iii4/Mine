// The sidebar rows' look: compact below the threshold of their list's width
// (`sidebarCompactRowsBelowPx`, the List or, postponed, the narrow table),
// the table above it (user's decision of 01.11.2026; DESIGN_SYSTEM.md,
// «Переход между List и таблицей»). The look is an attribute of the list's
// scrollport and of the lifted copy of a row, which the stylesheet keys its
// compact rules on (global.css, «Compact rows», «List sidebar»), not a
// container query: the scrollport keeps the table while its rows move to
// the List without restyling the list, and its rows' styles do not follow
// its width in every frame of a drag. The scrollport's look is set by
// sidebarListMorph.ts, which decides when it changes; the copy's follows
// its own width at once.

import { sidebarCompactRowsBelowPx, sidebarRowsWidthPx } from "./appLayout";
import { springMotion, type SpringMotion } from "./motion";
import { lastInputIsKey } from "./motionInput";
import { windowEdgeInHand } from "./windowLiveResize";

/** The attribute the look stands in. */
export const SIDEBAR_LOOK_ATTRIBUTE = "data-sidebar-look";

/** Compact rows, or the table's. */
export type SidebarLook = "compact" | "table";

/** The look of rows in a list `width` wide (its content box, px). */
export function sidebarLookAt(width: number): SidebarLook {
  return width < sidebarCompactRowsBelowPx() ? "compact" : "table";
}

/** On the scrollport while the sidebar's width moves beside the feed (a
 *  collapse, an opening, leaving the row and coming back): its width when
 *  open, px (Sidebar.tsx). The list keeps that width's look for the whole
 *  motion (user's decision of 01.11.2026; sidebarListMorph.ts). */
export const SIDEBAR_WIDTH_MOTION_ATTRIBUTE = "data-sidebar-width-motion";

/** On the page's body from the press on the sidebar's edge to its release
 *  (SidebarResizeHandle.tsx, useSidebarResize.ts); global.css holds the
 *  resize cursor and the selection by it. */
export const SIDEBAR_RESIZING_CLASS = "sidebar-resizing";

/** Whether the person holds the sidebar's edge now: a width that changes is
 *  the drag's. */
export function sidebarEdgeInHand(): boolean {
  return typeof document !== "undefined" && document.body.classList.contains(SIDEBAR_RESIZING_CLASS);
}

/** How the rows move across the compact threshold for the width that
 *  changed now (SPEC_MOTION_LEVELS.md, С3, С4; user's decisions of
 *  15.11.2026). Under the sidebar's edge in hand, or the window's
 *  (windowLiveResize.ts), the move answers the drag and runs on its spring
 *  on every level (Р1). Any other change of the width is a command's: at
 *  once after a key, the separator's arrows and a native menu item among
 *  them (Р4); else by the level, the spring in Full, Minimal's move, at once
 *  at Off (Р2, Р3). */
export function sidebarMorphMotion(): SpringMotion {
  if (sidebarEdgeInHand() || windowEdgeInHand()) return springMotion({ answers: true });
  return springMotion({ byKey: lastInputIsKey() });
}

/** The look of a list in a panel `panelWidth` wide, its scrollport keeping
 *  `gutter` of its box for itself (a scrollbar, its padding). */
export function sidebarLookOfPanel(panelWidth: number, gutter: number): SidebarLook {
  return sidebarLookAt(sidebarRowsWidthPx(panelWidth) - gutter);
}

/** The look `element` stands in, if it has one. */
export function sidebarLookOf(element: Element): SidebarLook | null {
  const look = element.getAttribute(SIDEBAR_LOOK_ATTRIBUTE);
  return look === "compact" || look === "table" ? look : null;
}

/** Puts `element` in `look`, touching nothing when it is in it already. */
export function setSidebarLook(element: Element, look: SidebarLook): void {
  if (element.getAttribute(SIDEBAR_LOOK_ATTRIBUTE) !== look) element.setAttribute(SIDEBAR_LOOK_ATTRIBUTE, look);
}

/** The width of `element`'s content as it is laid out now, px: its box less
 *  its borders, padding and scrollbar, as a resize observer reports it. */
export function sidebarContentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const sides = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"] as const;
  const around = sides.reduce((sum, side) => sum + (parseFloat(style[side]) || 0), 0);
  const scrollbar = element.offsetWidth - element.clientWidth - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0);
  return element.getBoundingClientRect().width - around - Math.max(0, scrollbar);
}

/** Keeps `element`'s look by its own width, at once: the lifted copy of a
 *  row, which is compact where its row is. It takes its look when it is
 *  laid out first, before it is painted. Returns the teardown. */
export function observeSidebarLook(element: HTMLElement): () => void {
  const width = sidebarContentWidth(element);
  if (width > 0) setSidebarLook(element, sidebarLookAt(width));
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    const next = entry?.contentBoxSize?.[0]?.inlineSize ?? entry?.contentRect.width ?? 0;
    if (next > 0) setSidebarLook(element, sidebarLookAt(next));
  });
  observer.observe(element);
  return () => observer.disconnect();
}
