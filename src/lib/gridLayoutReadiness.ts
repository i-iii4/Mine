import type { LightBlock } from "@/types";
import type { MasonryPosition } from "@/lib/masonryLayout";

const POSITION_DISTANCE_EPSILON_PX = 0.5;

/**
 * Developer-only snapshot for proving whether Grid is blocked by layout
 * measurement backlog, media decode backlog, or something else.
 */
export interface GridLayoutReadinessDiagnostics {
  layoutGenerationKey: string;
  committedEndIndex: number;
  targetCommittedEndIndex: number;
  maxVisibleIndex: number;
  mountedGridItems: number;
  visibleUnmeasuredCount: number;
  viewportUnmeasuredCount: number;
  measurementBatchSize: number;
  measuredBlockCount: number;
  totalBlockCount: number;
}

/**
 * Inputs for viewport-first measurement scheduling.
 *
 * `measuredBlockIds` is intentionally non-contiguous: exact measured islands
 * in the current viewport may render live even while earlier prefix gaps are
 * still catching up in the background.
 */
export interface ViewportFirstMeasurementBatchInput {
  blocks: readonly LightBlock[];
  positions: readonly MasonryPosition[];
  visibleItems: readonly MasonryPosition[];
  measuredBlockIds: ReadonlySet<number>;
  scrollTop: number;
  viewportHeight: number;
  targetEndIndex: number;
  batchSize: number;
}

function overlapsViewport(
  position: MasonryPosition,
  viewportTop: number,
  viewportBottom: number,
): boolean {
  return position.bottom >= viewportTop && position.top <= viewportBottom;
}

function distanceToViewport(
  position: MasonryPosition,
  viewportTop: number,
  viewportBottom: number,
): number {
  if (position.bottom < viewportTop) return viewportTop - position.bottom;
  if (position.top > viewportBottom) return position.top - viewportBottom;
  return 0;
}

export function computeCommittedEndIndex(
  blocks: readonly LightBlock[],
  measuredBlockIds: ReadonlySet<number>,
  warmedUp: boolean,
): number {
  if (!warmedUp) return -1;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block || !measuredBlockIds.has(block.id)) {
      return index - 1;
    }
  }
  return blocks.length - 1;
}

/**
 * Build the next hidden-measurement batch with viewport-first priority.
 *
 * Order is:
 * 1. mounted items intersecting the real viewport;
 * 2. mounted overscan items nearest to the viewport;
 * 3. missing prefix items up to `targetEndIndex`;
 * 4. remaining layout positions only if the bounded batch still has room.
 */
export function collectViewportFirstMeasurementBatch({
  blocks,
  positions,
  visibleItems,
  measuredBlockIds,
  scrollTop,
  viewportHeight,
  targetEndIndex,
  batchSize,
}: ViewportFirstMeasurementBatchInput): LightBlock[] {
  if (targetEndIndex < 0 || batchSize <= 0) return [];

  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + Math.max(0, viewportHeight);
  const queued = new Set<number>();
  const batch: LightBlock[] = [];

  const addIndex = (index: number): void => {
    if (batch.length >= batchSize || queued.has(index)) return;
    const block = blocks[index];
    if (!block || measuredBlockIds.has(block.id)) return;
    queued.add(index);
    batch.push(block);
  };

  for (const item of visibleItems) {
    if (!overlapsViewport(item, viewportTop, viewportBottom)) continue;
    addIndex(item.index);
  }

  const nearItems = visibleItems
    .filter((item) => !overlapsViewport(item, viewportTop, viewportBottom))
    .slice()
    .sort((first, second) => {
      const distanceDelta =
        distanceToViewport(first, viewportTop, viewportBottom) -
        distanceToViewport(second, viewportTop, viewportBottom);
      if (Math.abs(distanceDelta) > POSITION_DISTANCE_EPSILON_PX) return distanceDelta;
      return first.index - second.index;
    });

  for (const item of nearItems) {
    addIndex(item.index);
  }

  const target = Math.min(targetEndIndex, blocks.length - 1);
  for (let index = 0; index <= target; index += 1) {
    addIndex(index);
    if (batch.length >= batchSize) break;
  }

  if (batch.length >= batchSize) return batch;

  for (const position of positions) {
    if (position.index <= target) continue;
    addIndex(position.index);
    if (batch.length >= batchSize) break;
  }

  return batch;
}

/**
 * Create the layout-readiness part of `window.__MINE_FEED_SCROLL_DEBUG__`.
 *
 * The prefix counters are diagnostic only; live rendering is governed by
 * `measuredBlockIds` so current-viewport islands can become real cards before
 * the entire prefix has caught up.
 */
export function createGridLayoutReadinessDiagnostics({
  layoutGenerationKey,
  blocks,
  visibleItems,
  measuredBlockIds,
  committedEndIndex,
  targetCommittedEndIndex,
  maxVisibleIndex,
  scrollTop,
  viewportHeight,
  measurementBatchSize,
}: {
  layoutGenerationKey: string;
  blocks: readonly LightBlock[];
  visibleItems: readonly MasonryPosition[];
  measuredBlockIds: ReadonlySet<number>;
  committedEndIndex: number;
  targetCommittedEndIndex: number;
  maxVisibleIndex: number;
  scrollTop: number;
  viewportHeight: number;
  measurementBatchSize: number;
}): GridLayoutReadinessDiagnostics {
  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + Math.max(0, viewportHeight);
  let visibleUnmeasuredCount = 0;
  let viewportUnmeasuredCount = 0;

  for (const item of visibleItems) {
    const block = blocks[item.index];
    if (!block || measuredBlockIds.has(block.id)) continue;
    visibleUnmeasuredCount += 1;
    if (overlapsViewport(item, viewportTop, viewportBottom)) {
      viewportUnmeasuredCount += 1;
    }
  }

  return {
    layoutGenerationKey,
    committedEndIndex,
    targetCommittedEndIndex,
    maxVisibleIndex,
    mountedGridItems: visibleItems.length,
    visibleUnmeasuredCount,
    viewportUnmeasuredCount,
    measurementBatchSize,
    measuredBlockCount: measuredBlockIds.size,
    totalBlockCount: blocks.length,
  };
}
