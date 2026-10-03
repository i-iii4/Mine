// How wide the tabs are and what the strip shows (SPEC_TABS.md, В48). Pure:
// the bar measures, these decide.

import type { CSSProperties } from "react";
import {
  EDGE_FADE_WIDTH,
  TOP_FADE_SCROLLED_THRESHOLD_PX,
  createLeftFadeMaskStyle,
  createRightFadeMaskStyle,
} from "@/lib/edgeFade";
import { TAB_MAX_WIDTH_PX, TAB_MIN_WIDTH_PX } from "./constants";

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

/** Which edges of a horizontally scrolled strip hide tabs. The threshold is
 *  the one every scroll fade uses: sub-pixel offsets do not count. */
export function hiddenEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: boolean; right: boolean } {
  return {
    left: scrollLeft >= TOP_FADE_SCROLLED_THRESHOLD_PX,
    right: scrollWidth - clientWidth - scrollLeft >= TOP_FADE_SCROLLED_THRESHOLD_PX,
  };
}

function maskImage(style: CSSProperties): string {
  return String(style.maskImage);
}

/// The shared edge ramp on both ends of the strip (SPEC_SCROLL_EDGE_FADE.md).
const RIGHT_EDGE_MASK = maskImage(createRightFadeMaskStyle(EDGE_FADE_WIDTH, 0));
const LEFT_EDGE_MASK = maskImage(createLeftFadeMaskStyle(EDGE_FADE_WIDTH));

/** The mask that dissolves the strip's edges where tabs are hidden past them;
 *  `undefined` when nothing is hidden. Two layers intersect, so both edges
 *  fade at once when the strip is scrolled into its middle. */
export function stripFadeMaskStyle(edges: { left: boolean; right: boolean }): CSSProperties | undefined {
  const layers = [edges.left ? LEFT_EDGE_MASK : null, edges.right ? RIGHT_EDGE_MASK : null].filter(
    (layer): layer is string => layer !== null,
  );
  if (layers.length === 0) return undefined;
  const image = layers.join(", ");
  if (layers.length === 1) return { maskImage: image, WebkitMaskImage: image };
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskComposite: "intersect",
    WebkitMaskComposite: "source-in",
  };
}
