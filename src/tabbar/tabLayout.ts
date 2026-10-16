// How wide the tabs are and what the strip shows (SPEC_TABS.md, В48). Pure:
// the bar measures, these decide.

import { hiddenEdges, stripFadeMaskStyle } from "@/lib/edgeFade";
import { TAB_MAX_WIDTH_PX, TAB_MIN_WIDTH_PX } from "./constants";

// The strip's edges dissolve by the rule every horizontally scrolled row
// shares (src/lib/edgeFade.ts); the bottom bar of a narrow window uses it too.
export { hiddenEdges, stripFadeMaskStyle };

/** Tab widths held after a close by the pointer, until it leaves the bar. */
export interface FrozenTabWidth {
  width: number;
  /** Tabs at the moment of the close; more tabs than this release the hold. */
  count: number;
}

/** The width every tab gets: the strip's room shared equally, from
 *  `TAB_MIN_WIDTH_PX` to `TAB_MAX_WIDTH_PX`. Whole pixels, so the tabs never
 *  add up to more than the room they share. */
export function tabWidth(available: number, count: number): number {
  if (count <= 0) return TAB_MAX_WIDTH_PX;
  const share = Math.floor(Math.max(0, available) / count);
  return Math.min(TAB_MAX_WIDTH_PX, Math.max(TAB_MIN_WIDTH_PX, share));
}

/** Whether the tabs do not fit even at their minimum width, so the strip scrolls. */
export function tabsOverflow(available: number, count: number): boolean {
  return count * TAB_MIN_WIDTH_PX > Math.max(0, available);
}

/** The width in force: the held width after a close by the pointer, else the
 *  shared one. A hold never makes the row wider than it was, because it only
 *  covers as many tabs as there were when it began (В48). */
export function effectiveTabWidth(
  available: number,
  count: number,
  frozen: FrozenTabWidth | null,
): number {
  if (frozen !== null && count <= frozen.count) return frozen.width;
  return tabWidth(available, count);
}

/** The scroll offset that keeps tab `index` of `count` whole in the strip's
 *  viewport, moving as little as possible. The answer stays within the
 *  offsets the strip can take; a strip with no room yet stays at its start. */
export function revealScrollLeft({
  index,
  count,
  width,
  viewport,
  scrollLeft,
}: {
  index: number;
  count: number;
  width: number;
  viewport: number;
  scrollLeft: number;
}): number {
  if (viewport <= 0) return 0;
  const limit = Math.max(0, count * width - viewport);
  const clamp = (offset: number) => Math.min(Math.max(0, offset), limit);
  const current = clamp(scrollLeft);
  const left = index * width;
  const right = left + width;
  if (left < current) return clamp(left);
  if (right > current + viewport) return clamp(right - viewport);
  return current;
}

/** Where a wheel turn over the bar outside the strip (a button, +, empty
 *  space) moves the strip: the bar is one scroll surface for the tabs
 *  (SPEC_NARROW_WINDOW.md, У9, У11). `null` when the turn is not mostly
 *  horizontal or the tabs fit, so nothing moves. The answer stays within the
 *  offsets the strip can take. */
export function wheelScrollLeft({
  deltaX,
  deltaY,
  scrollLeft,
  viewport,
  content,
}: {
  deltaX: number;
  deltaY: number;
  scrollLeft: number;
  viewport: number;
  content: number;
}): number | null {
  if (Math.abs(deltaX) <= Math.abs(deltaY)) return null;
  const limit = Math.max(0, content - Math.max(0, viewport));
  if (limit === 0) return null;
  return Math.min(Math.max(0, scrollLeft + deltaX), limit);
}

