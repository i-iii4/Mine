// Grid scroll state hook.
//
// Returns the currently-visible masonry items for a scroll container, with
// two performance properties:
//
//  1. Layout changes are reflected SYNCHRONOUSLY during render. When the
//     caller-provided `getVisibleItems` callback changes identity (e.g.
//     because the masonry layout changed — new channel, resize, re-measure)
//     the returned visible items are freshly computed in the same render,
//     not a frame later. This fixes stale-snapshot bugs where the old
//     channel's positions would paint briefly on top of the new channel's
//     block list.
//
//  2. Scroll events don't trigger React re-renders unless the visible set
//     actually changes. scrollTop lives in a ref. A requestAnimationFrame
//     loop checks whether the visible set has changed by element-wise
//     reference comparison, and only bumps a tick state when it has. Within
//     the overscan window, scrolling is completely free of React work.
//
// See SPEC_GRID.md §002 for the design rationale.

import { useEffect, useMemo, useRef, useState } from "react";
import type { MasonryPosition } from "@/lib/masonryLayout";

export interface UseGridScrollOptions {
  /** Compute the currently-visible items given the current scrollTop. */
  getVisibleItems: (scrollTop: number) => MasonryPosition[];
  /** Reset the scroll visibility snapshot when route/layout scope changes. */
  resetKey?: string;
}

/** Element-wise reference equality for two arrays of positions. */
function samePositions(
  a: readonly MasonryPosition[],
  b: readonly MasonryPosition[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Attach to a scrollable element and return the currently-visible items.
 *
 * Synchronous in two directions:
 *  - When `getVisibleItems` changes (layout change), the returned items
 *    are recomputed during the same render. No stale paint.
 *  - When the scroll position changes within the overscan window, no
 *    re-render — the RAF loop detects the no-op and does not bump state.
 */
export function useGridScroll(
  scrollElementRef: React.RefObject<HTMLElement | null>,
  { getVisibleItems, resetKey }: UseGridScrollOptions,
): MasonryPosition[] {
  const scrollTopRef = useRef(0);
  // Opaque tick state: bumped by the scroll handler when the visible set
  // changes. The only purpose is to force useMemo to recompute visibleItems
  // with the latest scrollTopRef.current value.
  const [scrollTick, setScrollTick] = useState(0);
  // Cache of the last computed visible array. Used by the scroll handler
  // to detect no-op updates (scroll stayed within overscan window).
  const lastVisibleRef = useRef<MasonryPosition[]>([]);
  // getVisibleItems identity changes on layout change. Mirror into a ref
  // so the scroll handler always sees the latest version without needing
  // to re-bind the native event listener.
  const getVisibleItemsRef = useRef(getVisibleItems);

  useEffect(() => {
    getVisibleItemsRef.current = getVisibleItems;
  }, [getVisibleItems]);

  useEffect(() => {
    const el = scrollElementRef.current;
    const scrollTop = el?.scrollTop ?? 0;
    scrollTopRef.current = scrollTop;
    lastVisibleRef.current = getVisibleItems(scrollTop);
    setScrollTick((t) => t + 1);
  }, [getVisibleItems, resetKey, scrollElementRef]);

  // Synchronous compute during render. Recomputes when:
  //   - getVisibleItems identity changes (layout / visibility function changed)
  //   - scrollTick increments (scroll handler detected a crossed boundary)
  //
  // scrollTopRef is read inside the memo function. React does not track
  // ref reads, so it's not in the deps list — that's intentional. Scroll-
  // driven changes reach the memo via scrollTick.
  const visibleItems = useMemo(() => {
    // scrollTopRef is intentionally NOT in the deps — refs aren't tracked
    // by useMemo. Scroll-driven updates come in via scrollTick which is
    // bumped by the scroll handler when the visible set changes.
    void scrollTick;
    const items = getVisibleItems(scrollTopRef.current);
    lastVisibleRef.current = items;
    return items;
  }, [getVisibleItems, scrollTick]);

  // Scroll listener: updates scrollTop ref on every scroll event, then
  // schedules a RAF check. The check compares the new visible set with
  // the last one; if they differ by element-wise reference, bumps
  // scrollTick to force a re-render.
  useEffect(() => {
    const el = scrollElementRef.current;
    if (!el) return;

    let rafId: number | null = null;

    const handleScroll = (): void => {
      scrollTopRef.current = el.scrollTop;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const next = getVisibleItemsRef.current(scrollTopRef.current);
        if (!samePositions(next, lastVisibleRef.current)) {
          // Bump tick — useMemo will recompute and update lastVisibleRef.
          setScrollTick((t) => t + 1);
        }
      });
    };

    // Prime: record the current scroll position so the first useMemo run
    // sees the right value. No notification needed — useMemo already ran.
    scrollTopRef.current = el.scrollTop;

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scrollElementRef]);

  return visibleItems;
}
