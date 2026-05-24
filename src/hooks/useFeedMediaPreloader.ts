import { useEffect, useMemo, useRef, useState } from "react";
import type { LightBlock } from "@/types";
import {
  getVisibleItemsFromIndex,
  type MasonryLayout,
  type VisibilityIndex,
} from "@/lib/masonryLayout";
import { feedMediaCandidatesForBlock } from "@/lib/feedMediaCandidates";
import {
  computeFeedScrollReadinessWindows,
  type FeedScrollDirection,
  type FeedScrollReadinessWindows,
} from "@/lib/feedScrollReadiness";
import {
  FeedMediaPreloadQueue,
  type FeedMediaPreloadCandidate,
  type FeedMediaPreloadStats,
} from "@/lib/feedMediaPreloadQueue";
import type { LayoutGenerationKey } from "@/lib/layoutGeneration";

interface FeedMediaPreloaderDebug {
  enabled: boolean;
  stats: FeedMediaPreloadStats;
  mountedGridItems: number;
  renderWindowPx: { forward: number; backward: number };
  priorityWindowPx: { forward: number; backward: number };
  preloadWindowPx: { forward: number; backward: number };
}

declare global {
  interface Window {
    __MINE_FEED_SCROLL_DEBUG__?: FeedMediaPreloaderDebug;
  }
}

const EMPTY_STATS: FeedMediaPreloadStats = {
  queued: 0,
  active: 0,
  decoded: 0,
  failed: 0,
  skippedLru: 0,
  skippedNoPreview: 0,
  generation: "",
};

function sameStats(first: FeedMediaPreloadStats, second: FeedMediaPreloadStats): boolean {
  return (
    first.queued === second.queued &&
    first.active === second.active &&
    first.decoded === second.decoded &&
    first.failed === second.failed &&
    first.skippedLru === second.skippedLru &&
    first.skippedNoPreview === second.skippedNoPreview &&
    first.generation === second.generation
  );
}

function distanceToViewport(
  top: number,
  bottom: number,
  viewportTop: number,
  viewportBottom: number,
): number {
  if (bottom < viewportTop) return viewportTop - bottom;
  if (top > viewportBottom) return top - viewportBottom;
  return 0;
}

function orientedWindowDebug(
  direction: FeedScrollDirection,
  beforePx: number,
  afterPx: number,
): { forward: number; backward: number } {
  return direction === "backward"
    ? { forward: beforePx, backward: afterPx }
    : { forward: afterPx, backward: beforePx };
}

function emptyStatsForGeneration(generation: string): FeedMediaPreloadStats {
  return {
    ...EMPTY_STATS,
    generation,
  };
}

export function useFeedMediaPreloader({
  enabled,
  blocks,
  layout,
  visibilityIndex,
  scrollTop,
  viewportHeight,
  scrollDirection,
  scrollVelocityPxMs,
  generationKey,
  thumbsRootPath,
  mountedGridItems,
  windows,
}: {
  enabled: boolean;
  blocks: readonly LightBlock[];
  layout: MasonryLayout;
  visibilityIndex: VisibilityIndex;
  scrollTop: number;
  viewportHeight: number;
  scrollDirection: FeedScrollDirection;
  scrollVelocityPxMs: number;
  generationKey: LayoutGenerationKey;
  thumbsRootPath: string | null;
  mountedGridItems: number;
  windows?: FeedScrollReadinessWindows;
}): FeedMediaPreloadStats {
  const queueRef = useRef<FeedMediaPreloadQueue | null>(null);
  const [stats, setStats] = useState<FeedMediaPreloadStats>(EMPTY_STATS);
  const resolvedWindows = useMemo(
    () => windows ?? computeFeedScrollReadinessWindows({
      viewportHeight,
      scrollVelocityPxMs,
      scrollDirection,
      visibleItemCount: mountedGridItems,
    }),
    [
      mountedGridItems,
      scrollDirection,
      scrollVelocityPxMs,
      viewportHeight,
      windows,
    ],
  );
  const generation = `${generationKey}|thumbs=${thumbsRootPath ?? ""}`;

  if (!queueRef.current) {
    queueRef.current = new FeedMediaPreloadQueue();
  }

  const preloadInput = useMemo(() => {
    if (
      !enabled ||
      !thumbsRootPath ||
      viewportHeight <= 0 ||
      layout.positions.length === 0
    ) {
      return null;
    }

    const viewportBottom = scrollTop + viewportHeight;
    const items = getVisibleItemsFromIndex(
      visibilityIndex,
      scrollTop,
      viewportHeight,
      resolvedWindows.preloadBeforePx,
      resolvedWindows.preloadAfterPx,
    );
    const candidates: FeedMediaPreloadCandidate[] = [];
    let skippedNoPreview = 0;

    for (const item of items) {
      const block = blocks[item.index];
      if (!block) continue;
      const blockCandidates = feedMediaCandidatesForBlock({ block, thumbsRootPath });
      if (blockCandidates.length === 0) {
        skippedNoPreview += 1;
        continue;
      }
      const distancePx = distanceToViewport(
        item.top,
        item.bottom,
        scrollTop,
        viewportBottom,
      );
      for (const candidate of blockCandidates) {
        candidates.push({
          url: candidate.url,
          role: candidate.role,
          distancePx,
          visualIndex: item.index,
        });
      }
    }

    return {
      generation,
      candidates,
      skippedNoPreview,
    };
  }, [
    blocks,
    enabled,
    generation,
    layout.positions.length,
    resolvedWindows.preloadAfterPx,
    resolvedWindows.preloadBeforePx,
    scrollTop,
    thumbsRootPath,
    viewportHeight,
    visibilityIndex,
  ]);

  useEffect(() => {
    const queue = queueRef.current;
    if (!queue) return;

    const nextStats = preloadInput
      ? queue.update(preloadInput)
      : emptyStatsForGeneration(generation);
    if (!preloadInput) {
      queue.reset(generation);
    }
    setStats((current) => sameStats(current, nextStats) ? current : nextStats);
  }, [generation, preloadInput]);

  useEffect(() => {
    return () => {
      queueRef.current?.dispose();
      queueRef.current = null;
      if (typeof window !== "undefined") {
        delete window.__MINE_FEED_SCROLL_DEBUG__;
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.__MINE_FEED_SCROLL_DEBUG__ = {
      enabled,
      stats,
      mountedGridItems,
      renderWindowPx: orientedWindowDebug(
        scrollDirection,
        resolvedWindows.renderBeforePx,
        resolvedWindows.renderAfterPx,
      ),
      priorityWindowPx: orientedWindowDebug(
        scrollDirection,
        resolvedWindows.priorityBeforePx,
        resolvedWindows.priorityAfterPx,
      ),
      preloadWindowPx: orientedWindowDebug(
        scrollDirection,
        resolvedWindows.preloadBeforePx,
        resolvedWindows.preloadAfterPx,
      ),
    };
  }, [enabled, mountedGridItems, resolvedWindows, scrollDirection, stats]);

  return stats;
}
