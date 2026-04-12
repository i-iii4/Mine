// Grid scroll state hook.
//
// Connects React to a high-frequency scroll source (native scroll events)
// without triggering a re-render on every pixel of movement.
//
// Strategy:
//   1. The scroll element's current scrollTop lives in a ref. Scroll events
//      update this ref synchronously.
//   2. A requestAnimationFrame loop coalesces updates — at most one per
//      frame — and computes the current set of visible items via a pure
//      getVisibleItems callback.
//   3. The visible set is exposed to React via useSyncExternalStore. React
//      re-renders ONLY when the snapshot (a stable object reference that
//      represents the current visible items) changes. Between changes,
//      React is completely idle during scroll.
//
// The snapshot comparison is reference-identity: the hook caches the last
// visible array and reuses it as long as the new computation yields an
// identical set of MasonryPosition references in the same order. This means
// scrolling within the current overscan window triggers zero React renders.
//
// See SPEC_GRID.md §002 for the rationale.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { MasonryPosition } from "@/lib/masonryLayout";

export interface UseGridScrollOptions {
  /** Compute the currently-visible items given the current scrollTop. */
  getVisibleItems: (scrollTop: number) => MasonryPosition[];
}

type Listener = () => void;

interface ScrollStore {
  snapshot: MasonryPosition[];
}

/**
 * Attach to a scrollable element and return the currently-visible items.
 *
 * The returned array is a stable reference between scroll events — it only
 * changes when the visible set changes. Consumers can safely use it as a
 * dependency for useMemo / JSX.map without worrying about re-render storms.
 */
export function useGridScroll(
  scrollElementRef: React.RefObject<HTMLElement | null>,
  { getVisibleItems }: UseGridScrollOptions,
): MasonryPosition[] {
  // Mutable store outside React's render tree. Listeners notify subscribers
  // (currently just React's useSyncExternalStore) when the snapshot changes.
  const storeRef = useRef<ScrollStore>({ snapshot: [] });
  const listenersRef = useRef<Set<Listener>>(new Set());
  const scrollTopRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const getVisibleItemsRef = useRef(getVisibleItems);

  // Keep the callback reference fresh without recreating subscriptions
  // (which would tear down and rebuild the scroll listener).
  useEffect(() => {
    getVisibleItemsRef.current = getVisibleItems;
  }, [getVisibleItems]);

  const snapshotEqual = useCallback(
    (a: MasonryPosition[], b: MasonryPosition[]): boolean => {
      if (a === b) return true;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    },
    [],
  );

  const computeAndMaybeNotify = useCallback((): void => {
    const next = getVisibleItemsRef.current(scrollTopRef.current);
    const current = storeRef.current.snapshot;
    if (!snapshotEqual(current, next)) {
      storeRef.current = { snapshot: next };
      for (const listener of listenersRef.current) {
        listener();
      }
    }
  }, [snapshotEqual]);

  const scheduleUpdate = useCallback((): void => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      computeAndMaybeNotify();
    });
  }, [computeAndMaybeNotify]);

  const subscribe = useCallback(
    (onStoreChange: Listener): (() => void) => {
      listenersRef.current.add(onStoreChange);
      return () => {
        listenersRef.current.delete(onStoreChange);
      };
    },
    [],
  );

  const getSnapshot = useCallback(
    (): MasonryPosition[] => storeRef.current.snapshot,
    [],
  );

  // Attach native scroll listener. Passive listener — we only read scrollTop.
  useEffect(() => {
    const el = scrollElementRef.current;
    if (!el) return;

    const handleScroll = (): void => {
      scrollTopRef.current = el.scrollTop;
      scheduleUpdate();
    };

    // Initialize the snapshot based on the current scroll position.
    scrollTopRef.current = el.scrollTop;
    computeAndMaybeNotify();

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [scrollElementRef, scheduleUpdate, computeAndMaybeNotify]);

  // Recompute whenever the caller-provided getVisibleItems changes identity,
  // even if scroll hasn't moved. This catches layout changes (resize, channel
  // switch) where the visibility function itself was replaced.
  useEffect(() => {
    computeAndMaybeNotify();
  }, [getVisibleItems, computeAndMaybeNotify]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
