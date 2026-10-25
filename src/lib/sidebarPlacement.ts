// Where the sidebar stands for a window's width (SPEC_NARROW_WINDOW.md, У1,
// У2). The placement is computed from the window's width, the narrowest
// sidebar and feed and the width the person last dragged the sidebar to
// (`S_target`); it is never stored.
//
// | Window width              | Placement            | Sidebar        | Feed          |
// |---------------------------|----------------------|----------------|---------------|
// | W ≥ S_target + F_min      | beside               | S_target       | W − S_target  |
// | S_beside + F_min ≤ W < …  | beside, squeezed     | W − F_min      | F_min         |
// | W < S_beside + F_min      | over the feed        | over the feed  | W             |
//
// `S_beside` is 280, so the window goes narrow at 670 (user's decisions of
// 22.10.2026, 23.10.2026 and 25.10.2026; it was `S_min + F_min`, 740, then
// the tab bar's lead plus 390, 559 or 563.5, then 240 and 630).
//
// Narrowing, the feed gives way first, then the sidebar, then the sidebar
// leaves the row; widening runs the other way, and the sidebar grows back to
// exactly `S_target`: a window's width never changes it, only a drag does.

import {
  APP_MAIN_MIN_WIDTH_PX,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_OVERLAY_STRIP_PX,
  sidebarBesideMinWidthPx,
  sidebarOverlayBelowPx,
} from "./appLayout";

/** The sidebar beside the feed, or over it. */
export type SidebarPlacement =
  | {
    kind: "beside";
    /** The sidebar's width on screen. */
    sidebarWidth: number;
    /** The feed's width: the rest of the window. */
    feedWidth: number;
    /** The window holds less than `S_target` beside the narrowest feed. */
    squeezed: boolean;
  }
  | {
    kind: "overlay";
    /** The feed takes the whole window; the sidebar lies over it when open. */
    feedWidth: number;
  };

/** A width the person may give the sidebar: from `S_beside`
 *  (`sidebarBesideMinWidthPx`, below `S_min` since PLAN 50.36, 22.10.2026)
 *  up, with no cap of its own: beside the feed only the window, which keeps
 *  the narrowest feed, holds it (user's decision of 23.10.2026; it was
 *  `S_max`, 600). `S_min` still decides where the sidebar stands (У1). */
export function clampSidebarTarget(width: number): number {
  return Math.max(sidebarBesideMinWidthPx(), width);
}

/** Whether a window `windowWidth` wide is too narrow for the narrowest
 *  sidebar beside the narrowest feed, the compact one (`S_beside + F_min`,
 *  since 22.10.2026): the sidebar lies over the feed then (У1). It does
 *  not depend on the target. */
export function sidebarOverlaid(windowWidth: number): boolean {
  return windowWidth < sidebarOverlayBelowPx();
}

/** Where the sidebar stands in a window `windowWidth` wide, for a sidebar
 *  last dragged to `target` (У1). */
export function sidebarPlacement({
  windowWidth,
  target,
}: {
  windowWidth: number;
  target: number;
}): SidebarPlacement {
  const wanted = clampSidebarTarget(target);
  if (sidebarOverlaid(windowWidth)) {
    return { kind: "overlay", feedWidth: windowWidth };
  }
  const sidebarWidth = Math.min(wanted, windowWidth - APP_MAIN_MIN_WIDTH_PX);
  return {
    kind: "beside",
    sidebarWidth,
    feedWidth: windowWidth - sidebarWidth,
    squeezed: sidebarWidth < wanted,
  };
}

/** The bounds a drag of the sidebar's edge keeps it in (У2): from `S_beside`
 *  (PLAN 50.36; it was `S_min`) to what the window leaves beside the
 *  narrowest feed (23.10.2026: no `S_max` beside the feed). A window too
 *  narrow for the sidebar beside the feed gives no room above the minimum. */
export function sidebarDragBounds(windowWidth: number): { min: number; max: number } {
  const max = windowWidth - APP_MAIN_MIN_WIDTH_PX;
  const min = sidebarBesideMinWidthPx();
  return { min, max: Math.max(min, max) };
}

/** The sidebar's width as a CSS value: `target`, squeezed by the window
 *  until the feed keeps its narrowest. CSS follows the window with it, so a
 *  window's resize squeezes the sidebar without a render. */
export function sidebarWidthCss(target: number): string {
  return `min(${clampSidebarTarget(target)}px, 100vw - ${APP_MAIN_MIN_WIDTH_PX}px)`;
}

/** The width of the sidebar over the feed in a window `windowWidth` wide:
 *  the window less the strip at its right, never past `S_max` (У4). No drag
 *  sets it. */
export function sidebarOverlayWidth(windowWidth: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH_PX, windowWidth - SIDEBAR_OVERLAY_STRIP_PX);
}

/** The same width as a CSS value, so a window's resize follows it without a
 *  render. */
export function sidebarOverlayWidthCss(): string {
  return `min(${SIDEBAR_MAX_WIDTH_PX}px, 100vw - ${SIDEBAR_OVERLAY_STRIP_PX}px)`;
}
