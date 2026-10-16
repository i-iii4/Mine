// Where the sidebar stands for a window's width (SPEC_NARROW_WINDOW.md, У1,
// У2). The placement is computed from the window's width, the narrowest
// sidebar and feed and the width the person last dragged the sidebar to
// (`S_target`); it is never stored.
//
// | Window width              | Placement            | Sidebar        | Feed          |
// |---------------------------|----------------------|----------------|---------------|
// | W ≥ S_target + F_min      | beside               | S_target       | W − S_target  |
// | S_min + F_min ≤ W < …     | beside, squeezed     | W − F_min      | F_min         |
// | W < S_min + F_min         | over the feed        | over the feed  | W             |
//
// Narrowing, the feed gives way first, then the sidebar, then the sidebar
// leaves the row; widening runs the other way, and the sidebar grows back to
// exactly `S_target`: a window's width never changes it, only a drag does.

import {
  APP_MAIN_MIN_WIDTH_PX,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  SIDEBAR_OVERLAY_STRIP_PX,
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

/** A width the person may give the sidebar: between `S_min` and `S_max`. */
export function clampSidebarTarget(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, width));
}

/** Whether a window `windowWidth` wide is too narrow for the narrowest
 *  sidebar beside the narrowest feed: the sidebar lies over the feed then
 *  (У1). It does not depend on the target. */
export function sidebarOverlaid(windowWidth: number): boolean {
  return windowWidth < SIDEBAR_MIN_WIDTH_PX + APP_MAIN_MIN_WIDTH_PX;
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

/** The bounds a drag of the sidebar's edge keeps it in (У2): from `S_min` to
 *  what the window leaves beside the narrowest feed, never past `S_max`. A
 *  window too narrow for the sidebar beside the feed gives no room to drag. */
export function sidebarDragBounds(windowWidth: number): { min: number; max: number } {
  const max = Math.min(SIDEBAR_MAX_WIDTH_PX, windowWidth - APP_MAIN_MIN_WIDTH_PX);
  return { min: SIDEBAR_MIN_WIDTH_PX, max: Math.max(SIDEBAR_MIN_WIDTH_PX, max) };
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
