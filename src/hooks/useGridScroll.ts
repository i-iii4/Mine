// Grid scroll state hook.
//
// Returns the currently-visible masonry items for a scroll container, with
// three performance properties:
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
//  3. Fast native scroll jumps must not paint an empty viewport while React
//     waits for the next RAF. If the real viewport no longer intersects any
//     currently mounted item, the hook performs a bounded synchronous commit
//     for the new window. This is the anti-blank path; it is not used during
//     ordinary within-window scrolling.
//
// See SPEC_GRID.md §002 for the design rationale.

import { flushSync } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MasonryPosition } from "@/lib/masonryLayout";

export interface UseGridScrollOptions {
  /** Compute the currently-visible items given the current scrollTop. */
  getVisibleItems: (scrollTop: number) => MasonryPosition[];
  /**
   * Compute the smallest window that can fill the real viewport immediately
   * after a native jump. The regular overscan window is restored on the next
   * animation frame, after the viewport is no longer blank.
   */
  getEmergencyVisibleItems?: (scrollTop: number) => MasonryPosition[];
  /** Reset the scroll visibility snapshot when route/layout scope changes. */
  resetKey?: string;
  /**
   * Measured scrollport height from the caller's layout observer. Browsers
   * usually expose the same value through `clientHeight`, but tests and early
   * mount/resize frames can report `0` there while ResizeObserver already
   * knows the real viewport. The anti-blank path must use the measured height
   * rather than silently disabling itself.
   */
  viewportHeight?: number;
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

function viewportHasRenderedItem(
  items: readonly MasonryPosition[],
  scrollTop: number,
  viewportHeight: number,
): boolean {
  if (viewportHeight <= 0) return true;
  const viewportBottom = scrollTop + viewportHeight;
  return items.some((item) => item.bottom >= scrollTop && item.top <= viewportBottom);
}

function resolveViewportHeight(element: HTMLElement, measuredViewportHeight?: number): number {
  if (element.clientHeight > 0) return element.clientHeight;
  return measuredViewportHeight && measuredViewportHeight > 0 ? measuredViewportHeight : 0;
}

/**
 * Attach to a scrollable element and return the currently-visible items.
 *
 * Synchronous in two directions:
 *  - When `getVisibleItems` changes (layout change), the returned items
 *    are recomputed during the same render. No stale paint.
 *  - When the scroll position changes within the overscan window, no
 *    re-render — the RAF loop detects the no-op and does not bump state.
 *  - When a native scroll jump would leave the viewport with no currently
 *    rendered item, the hook updates synchronously before the blank frame can
 *    paint.
 */
export function useGridScroll(
  scrollElementRef: React.RefObject<HTMLElement | null>,
  {
    getVisibleItems,
    getEmergencyVisibleItems = getVisibleItems,
    resetKey,
    viewportHeight,
  }: UseGridScrollOptions,
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
  const getEmergencyVisibleItemsRef = useRef(getEmergencyVisibleItems);
  const emergencyVisibleItemsRef = useRef<MasonryPosition[] | null>(null);
  const viewportHeightRef = useRef(viewportHeight);

  useEffect(() => {
    getVisibleItemsRef.current = getVisibleItems;
  }, [getVisibleItems]);

  useEffect(() => {
    getEmergencyVisibleItemsRef.current = getEmergencyVisibleItems;
  }, [getEmergencyVisibleItems]);

  useEffect(() => {
    viewportHeightRef.current = viewportHeight;
  }, [viewportHeight]);

  useEffect(() => {
    const el = scrollElementRef.current;
    const scrollTop = el?.scrollTop ?? 0;
    scrollTopRef.current = scrollTop;
    // getVisibleItems changes identity on every layout change AND on every
    // velocity-driven readiness-window change. The synchronous useMemo above
    // has already recomputed visibleItems for this render, so bump scrollTick
    // only when the freshly computed set actually differs from what is mounted.
    // Otherwise a pure velocity ripple (identical visible set) would force a
    // second, wasted Grid render every scroll frame.
    const next = getVisibleItems(scrollTop);
    if (!samePositions(next, lastVisibleRef.current)) {
      lastVisibleRef.current = next;
      setScrollTick((t) => t + 1);
    }
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
    const items = emergencyVisibleItemsRef.current ?? getVisibleItems(scrollTopRef.current);
    emergencyVisibleItemsRef.current = null;
    lastVisibleRef.current = items;
    return items;
  }, [getVisibleItems, scrollTick]);

  // Scroll listener: updates scrollTop ref on every scroll event, then uses
  // one of two paths:
  //
  //   - normal path: RAF diff + state bump only if the visible set changed;
  //   - anti-blank path: synchronous state bump when native scroll jumped to
  //     a viewport that has no currently mounted item.
  useEffect(() => {
    const el = scrollElementRef.current;
    if (!el) return;

    let rafId: number | null = null;

    const handleScroll = (): void => {
      scrollTopRef.current = el.scrollTop;
      const currentViewportHeight = resolveViewportHeight(el, viewportHeightRef.current);
      if (!viewportHasRenderedItem(lastVisibleRef.current, scrollTopRef.current, currentViewportHeight)) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        const next = getEmergencyVisibleItemsRef.current(scrollTopRef.current);
        if (!samePositions(next, lastVisibleRef.current)) {
          emergencyVisibleItemsRef.current = next;
          flushSync(() => {
            setScrollTick((t) => t + 1);
          });
        }
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const expanded = getVisibleItemsRef.current(scrollTopRef.current);
          if (!samePositions(expanded, lastVisibleRef.current)) {
            setScrollTick((t) => t + 1);
          }
        });
        return;
      }

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
