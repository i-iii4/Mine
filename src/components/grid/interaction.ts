import type { PointerEvent as ReactPointerEvent } from "react";
import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";
import type { MasonryLayout, MasonryPosition } from "@/lib/masonryLayout";
import { blockHasExactDeterministicHeight } from "@/lib/gridLayoutReadiness";

const GRID_BOTTOM_INSET_PX = 32;
const MARQUEE_DRAG_THRESHOLD_PX = 4;
const SCROLL_ANCHOR_REFERENCE_OFFSET_PX = 32;

/// Edge band of the scrollport that pulls the feed while a marquee drag is
/// held there. Deep enough to reach without precision, shallow enough that a
/// drag ending near the edge does not scroll by accident.
const MARQUEE_AUTOSCROLL_ZONE_PX = 56;
/// Speed at the outer boundary of the zone — slow enough to aim at a card.
const MARQUEE_AUTOSCROLL_MIN_SPEED_PX_PER_S = 160;
/// Speed once the pointer reaches the scrollport edge or leaves it entirely.
const MARQUEE_AUTOSCROLL_MAX_SPEED_PX_PER_S = 1800;

export type GridArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
export type FeedInteractionMode = "keyboard" | "pointer";
export type FeedPointerPosition = {
  x: number;
  y: number;
  pointerId: number;
};
export type LayoutPoint = {
  x: number;
  y: number;
};
export type LayoutRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type MarqueeSelection = {
  pointerId: number;
  start: LayoutPoint;
  current: LayoutPoint;
  active: boolean;
};
export type ScrollAnchor = {
  slug: string;
  offsetTop: number;
};
export type ScrollAnchorSnapshot = {
  routeKey: string;
  parentWidth: number;
  blocks: readonly LightBlock[];
  positions: readonly MasonryPosition[];
};
export type PendingScrollAnchor = {
  routeKey: string;
  anchor: ScrollAnchor;
};

export function isGridArrowKey(key: string): key is GridArrowKey {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
}

export function feedPointerPosition(event: ReactPointerEvent): FeedPointerPosition {
  return {
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId,
  };
}

export function isSameFeedPointerPosition(
  first: FeedPointerPosition | null,
  second: FeedPointerPosition,
): boolean {
  return (
    first !== null &&
    first.pointerId === second.pointerId &&
    first.x === second.x &&
    first.y === second.y
  );
}

export function isStationaryFeedPointerMove(event: ReactPointerEvent): boolean {
  return event.movementX === 0 && event.movementY === 0;
}

function positionCenter(position: MasonryPosition): { x: number; y: number } {
  return {
    x: position.left + position.width / 2,
    y: position.top + position.height / 2,
  };
}

export function findPositionForSlug(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  slug: string,
): MasonryPosition | null {
  const blockIndex = blocks.findIndex((block) => block.slug === slug);
  if (blockIndex < 0) return null;
  return positions.find((position) => position.index === blockIndex) ?? null;
}

export function findLayoutNeighborSlug(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  currentSlug: string,
  direction: GridArrowKey,
  liveBlockIds: ReadonlySet<number>,
): string | null {
  const current = findPositionForSlug(positions, blocks, currentSlug);
  if (!current) return null;

  const currentCenter = positionCenter(current);
  const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
  let bestSlug: string | null = null;
  let bestScore = Infinity;

  for (const candidate of positions) {
    if (candidate.index === current.index) continue;
    const block = blocks[candidate.index];
    if (!block || !liveBlockIds.has(block.id)) continue;

    const candidateCenter = positionCenter(candidate);
    const dx = candidateCenter.x - currentCenter.x;
    const dy = candidateCenter.y - currentCenter.y;
    const valid =
      direction === "ArrowRight" ? dx > 10 :
      direction === "ArrowLeft" ? dx < -10 :
      direction === "ArrowDown" ? dy > 10 :
      dy < -10;
    if (!valid) continue;

    const score = horizontal
      ? Math.abs(dx) + Math.abs(dy) * 3
      : Math.abs(dy) + Math.abs(dx) * 3;

    if (score < bestScore) {
      bestScore = score;
      bestSlug = block.slug;
    }
  }

  return bestSlug;
}

/**
 * Every card whose centre falls inside the rectangle spanned by the anchor card
 * and the cursor card, the anchor and cursor included.
 *
 * The range is geometric rather than index-based because arrow navigation is
 * geometric: masonry fills columns by height, so a range taken over list order
 * would select cards from columns the focus never crossed. Membership is decided
 * by the card's centre — a card clipped by a few pixels of the span is not in it.
 */
export function slugsWithinSelectionSpan(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  anchorSlug: string,
  cursorSlug: string,
  liveBlockIds: ReadonlySet<number>,
): string[] {
  const anchor = findPositionForSlug(positions, blocks, anchorSlug);
  const cursor = findPositionForSlug(positions, blocks, cursorSlug);
  if (!anchor || !cursor) return [];

  const left = Math.min(anchor.left, cursor.left);
  const right = Math.max(anchor.left + anchor.width, cursor.left + cursor.width);
  const top = Math.min(anchor.top, cursor.top);
  const bottom = Math.max(anchor.bottom, cursor.bottom);

  const withinSpan: string[] = [];
  for (const candidate of positions) {
    const block = blocks[candidate.index];
    if (!block || !liveBlockIds.has(block.id)) continue;
    if (candidate.index === anchor.index || candidate.index === cursor.index) {
      withinSpan.push(block.slug);
      continue;
    }
    const centre = positionCenter(candidate);
    if (centre.x < left || centre.x > right) continue;
    if (centre.y < top || centre.y > bottom) continue;
    withinSpan.push(block.slug);
  }

  return withinSpan;
}

export function firstVisibleSlug(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  scrollTop: number,
  viewportHeight: number,
  liveBlockIds: ReadonlySet<number>,
  topInset: number,
): string | null {
  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + viewportHeight;
  let best: MasonryPosition | null = null;

  for (const item of positions) {
    const block = blocks[item.index];
    if (!block || !liveBlockIds.has(block.id)) continue;
    const itemTop = topInset + item.top;
    const itemBottom = topInset + item.bottom;
    if (itemBottom < viewportTop || itemTop > viewportBottom) continue;
    if (
      !best ||
      item.top < best.top - 0.5 ||
      (Math.abs(item.top - best.top) <= 0.5 && item.left < best.left)
    ) {
      best = item;
    }
  }

  return best ? blocks[best.index]?.slug ?? null : null;
}

export function findViewportPreservationAnchor(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  currentSlugs: ReadonlySet<string>,
  scrollTop: number,
  viewportHeight: number,
  topInset: number,
): ScrollAnchor | null {
  if (viewportHeight <= 0) return null;

  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + viewportHeight;
  const referenceY = viewportTop + Math.min(
    SCROLL_ANCHOR_REFERENCE_OFFSET_PX,
    viewportHeight / 2,
  );
  let best: (ScrollAnchor & { score: number; itemTop: number; itemLeft: number }) | null = null;

  for (const position of positions) {
    const block = blocks[position.index];
    if (!block || !currentSlugs.has(block.slug)) continue;

    const itemTop = topInset + position.top;
    const itemBottom = topInset + position.bottom;
    const visible = itemBottom >= viewportTop && itemTop <= viewportBottom;
    const distanceFromReference =
      referenceY < itemTop
        ? itemTop - referenceY
        : referenceY > itemBottom
          ? referenceY - itemBottom
          : 0;
    const score = (visible ? 0 : 1_000_000) + distanceFromReference;

    if (
      !best ||
      score < best.score - 0.5 ||
      (Math.abs(score - best.score) <= 0.5 && itemTop < best.itemTop - 0.5) ||
      (
        Math.abs(score - best.score) <= 0.5 &&
        Math.abs(itemTop - best.itemTop) <= 0.5 &&
        position.left < best.itemLeft
      )
    ) {
      best = {
        slug: block.slug,
        offsetTop: itemTop - viewportTop,
        score,
        itemTop,
        itemLeft: position.left,
      };
    }
  }

  return best ? { slug: best.slug, offsetTop: best.offsetTop } : null;
}

export function clampedScrollTopForAnchor(
  layout: MasonryLayout,
  viewportHeight: number,
  position: MasonryPosition,
  anchor: ScrollAnchor,
  topInset: number,
): number {
  const unclamped = topInset + position.top - anchor.offsetTop;
  const maxScrollTop = Math.max(
    0,
    topInset + layout.totalHeight + GRID_BOTTOM_INSET_PX - viewportHeight,
  );
  return Math.min(Math.max(0, unclamped), maxScrollTop);
}

export function isPositionVisibleInViewport(
  position: MasonryPosition,
  scrollTop: number,
  viewportHeight: number,
  topInset: number,
): boolean {
  if (viewportHeight <= 0) return false;
  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + viewportHeight;
  const itemTop = topInset + position.top;
  const itemBottom = topInset + position.bottom;
  return itemBottom >= viewportTop && itemTop <= viewportBottom;
}

export function scrollPositionIntoView(
  scrollElement: HTMLElement,
  position: MasonryPosition,
  topInset: number,
): void {
  const padding = 32;
  const itemTop = topInset + position.top;
  const itemBottom = topInset + position.bottom;
  const viewportTop = scrollElement.scrollTop;
  const viewportBottom = viewportTop + scrollElement.clientHeight;
  let nextTop: number | null = null;

  if (itemTop < viewportTop + padding) {
    nextTop = Math.max(0, itemTop - padding);
  } else if (itemBottom > viewportBottom - padding) {
    nextTop = Math.max(0, itemBottom - scrollElement.clientHeight + padding);
  }

  if (nextTop !== null) {
    scrollElement.scrollTo({ top: nextTop, behavior: "smooth" });
  }
}

export function blockCanRenderFromDeterministicHeight(
  block: LightBlock,
  wordWidthsMap: ReadonlyMap<number, WordWidths>,
  wordMetricsSettled: boolean,
): boolean {
  return blockHasExactDeterministicHeight(block, wordWidthsMap) || wordMetricsSettled;
}

export function rectFromPoints(first: LayoutPoint, second: LayoutPoint): LayoutRect {
  const left = Math.min(first.x, second.x);
  const top = Math.min(first.y, second.y);
  return {
    left,
    top,
    width: Math.abs(second.x - first.x),
    height: Math.abs(second.y - first.y),
  };
}

function rectsIntersect(first: LayoutRect, second: LayoutRect): boolean {
  return (
    first.left <= second.left + second.width &&
    first.left + first.width >= second.left &&
    first.top <= second.top + second.height &&
    first.top + first.height >= second.top
  );
}

export function marqueeIsActive(start: LayoutPoint, current: LayoutPoint): boolean {
  return (
    Math.abs(current.x - start.x) >= MARQUEE_DRAG_THRESHOLD_PX ||
    Math.abs(current.y - start.y) >= MARQUEE_DRAG_THRESHOLD_PX
  );
}

export function findMarqueeSelectionSlugs(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  rect: LayoutRect,
  liveBlockIds: ReadonlySet<number>,
): string[] {
  const selected: string[] = [];

  for (const candidate of positions) {
    const block = blocks[candidate.index];
    if (!block || !liveBlockIds.has(block.id)) continue;
    if (rectsIntersect(rect, {
      left: candidate.left,
      top: candidate.top,
      width: candidate.width,
      height: candidate.height,
    })) {
      selected.push(block.slug);
    }
  }

  return selected;
}

export function layoutPointFromClientPoint(
  scrollElement: HTMLElement,
  clientX: number,
  clientY: number,
): LayoutPoint | null {
  const layoutElement = scrollElement.querySelector("[data-grid-layout]");
  if (!(layoutElement instanceof HTMLElement)) return null;
  const rect = layoutElement.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

export function layoutPointFromPointerEvent(
  scrollElement: HTMLElement,
  event: ReactPointerEvent<HTMLElement>,
): LayoutPoint | null {
  return layoutPointFromClientPoint(scrollElement, event.clientX, event.clientY);
}

/// Vertical autoscroll speed for a held marquee drag, in CSS pixels per second.
///
/// Negative pulls the feed up, positive pulls it down, zero means the pointer
/// is away from both edges. Speed ramps from the outer boundary of the edge
/// band to the scrollport edge; past the edge the pointer keeps the maximum
/// instead of losing the pull, so a drag beyond the window still scrolls.
export function marqueeAutoScrollVelocity(
  clientY: number,
  viewportTop: number,
  viewportBottom: number,
): number {
  if (viewportBottom - viewportTop <= 0) return 0;

  const speedAt = (depth: number) =>
    MARQUEE_AUTOSCROLL_MIN_SPEED_PX_PER_S +
    (MARQUEE_AUTOSCROLL_MAX_SPEED_PX_PER_S - MARQUEE_AUTOSCROLL_MIN_SPEED_PX_PER_S) *
      Math.min(1, Math.max(0, depth));

  const topBoundary = viewportTop + MARQUEE_AUTOSCROLL_ZONE_PX;
  if (clientY < topBoundary) {
    return -speedAt((topBoundary - clientY) / MARQUEE_AUTOSCROLL_ZONE_PX);
  }

  const bottomBoundary = viewportBottom - MARQUEE_AUTOSCROLL_ZONE_PX;
  if (clientY > bottomBoundary) {
    return speedAt((clientY - bottomBoundary) / MARQUEE_AUTOSCROLL_ZONE_PX);
  }

  return 0;
}

export function isEmptyGridPointerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !target.closest(
    [
      "[data-block-slug]",
      "button",
      "a",
      "input",
      "textarea",
      "select",
      "[contenteditable='true']",
      "[role='button']",
      "[data-radix-popper-content-wrapper]",
    ].join(","),
  );
}

export function blockSlugFromKeyboardTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest("[data-block-slug]")?.getAttribute("data-block-slug") ?? null;
}

export function isPassiveGridKeyboardTarget(
  target: EventTarget | null,
  scrollElement: HTMLElement | null,
): boolean {
  if (!(target instanceof HTMLElement)) return target === document.body;
  if (target === document.body || target === scrollElement) return true;
  if (!scrollElement?.contains(target)) return false;
  return !target.closest(
    [
      "[data-block-slug]",
      "button",
      "a",
      "input",
      "textarea",
      "select",
      "[contenteditable='true']",
      "[role='button']",
      "[data-radix-popper-content-wrapper]",
    ].join(","),
  );
}

export function isLiveSlug(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  slug: string,
  liveBlockIds: ReadonlySet<number>,
): boolean {
  const position = findPositionForSlug(positions, blocks, slug);
  const block = position ? blocks[position.index] : null;
  return Boolean(block && liveBlockIds.has(block.id));
}
