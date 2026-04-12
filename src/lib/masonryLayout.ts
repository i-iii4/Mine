export interface MasonryPosition {
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  column: number;
}

export interface MasonryLayout {
  columnCount: number;
  columnWidth: number;
  totalHeight: number;
  positions: MasonryPosition[];
}

function clampPositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function getMasonryColumnCount(
  containerWidth: number,
  minColumnWidth: number,
  gap: number,
): number {
  const width = clampPositive(containerWidth);
  const minWidth = Math.max(1, minColumnWidth);
  const safeGap = clampPositive(gap);
  return Math.max(1, Math.floor((width + safeGap) / (minWidth + safeGap)));
}

export function computeMasonryLayout(
  itemHeights: number[],
  containerWidth: number,
  minColumnWidth: number,
  gap: number,
): MasonryLayout {
  const columnCount = getMasonryColumnCount(containerWidth, minColumnWidth, gap);
  const safeGap = clampPositive(gap);
  const innerWidth = Math.max(0, clampPositive(containerWidth) - safeGap * (columnCount - 1));
  const columnWidth = Math.max(1, innerWidth / columnCount);

  const columnHeights = new Array<number>(columnCount).fill(0);
  const positions: MasonryPosition[] = [];

  itemHeights.forEach((rawHeight, index) => {
    const height = Math.max(1, rawHeight);
    let targetColumn = 0;

    for (let i = 1; i < columnCount; i += 1) {
      if (columnHeights[i]! < columnHeights[targetColumn]!) {
        targetColumn = i;
      }
    }

    const top = columnHeights[targetColumn]!;
    const left = targetColumn * (columnWidth + safeGap);
    const bottom = top + height;

    positions.push({
      index,
      top,
      left,
      width: columnWidth,
      height,
      bottom,
      column: targetColumn,
    });

    columnHeights[targetColumn] = bottom + safeGap;
  });

  const totalHeight = Math.max(0, ...columnHeights.map((height) => (height > 0 ? height - safeGap : 0)));

  return {
    columnCount,
    columnWidth,
    totalHeight,
    positions,
  };
}

export function getVisibleMasonryItems(
  positions: MasonryPosition[],
  scrollTop: number,
  viewportHeight: number,
  overscanBefore: number,
  overscanAfter: number,
): MasonryPosition[] {
  const start = Math.max(0, scrollTop - overscanBefore);
  const end = Math.max(start, scrollTop + viewportHeight + overscanAfter);

  return positions.filter((position) => position.bottom >= start && position.top <= end);
}

// ─── Bucket-based visibility index ──────────────────────────────────────────
//
// For large collections (1000+ blocks) the O(N) filter above becomes a per-
// scroll-frame cost worth optimizing. The bucket index divides the vertical
// span of the layout into fixed-height slots; each slot holds the list of
// positions that overlap it. Visibility lookup scans only the slots that
// intersect the scroll window — O(k + B) where k is the visible count and
// B is the slot count in range. For 10000 items with 600-pixel buckets and
// a ~3000-pixel viewport the cost is ~5 slot scans regardless of N.
//
// The index is rebuilt from a MasonryLayout whenever the layout changes
// (resize, channel switch). Construction is O(N) — the same asymptotic cost
// as the layout itself, so it does not worsen any existing budget.

const DEFAULT_BUCKET_HEIGHT = 600;

export interface VisibilityIndex {
  /** Height in pixels of each bucket slot. */
  bucketHeight: number;
  /** Buckets array. bucket[i] holds positions overlapping [i*h, (i+1)*h). */
  buckets: MasonryPosition[][];
  /** Total layout height (cached from layout.totalHeight). */
  totalHeight: number;
}

/**
 * Build a bucket-based visibility index for fast scroll window queries.
 *
 * @param layout        A computed MasonryLayout.
 * @param bucketHeight  Pixel height of each bucket slot. Defaults to 600.
 *                      Smaller buckets = fewer items per slot (faster lookup)
 *                      but more slots scanned per viewport. 600 is a good
 *                      balance for 240-wide cards at typical screen heights.
 */
export function createVisibilityIndex(
  layout: MasonryLayout,
  bucketHeight: number = DEFAULT_BUCKET_HEIGHT,
): VisibilityIndex {
  const safeBucket = Math.max(1, bucketHeight);
  const bucketCount = layout.totalHeight > 0
    ? Math.ceil(layout.totalHeight / safeBucket) + 1
    : 1;

  const buckets: MasonryPosition[][] = new Array(bucketCount);
  for (let i = 0; i < bucketCount; i += 1) {
    buckets[i] = [];
  }

  for (const position of layout.positions) {
    const startBucket = Math.max(0, Math.floor(position.top / safeBucket));
    const endBucket = Math.min(bucketCount - 1, Math.floor(position.bottom / safeBucket));
    for (let i = startBucket; i <= endBucket; i += 1) {
      buckets[i]!.push(position);
    }
  }

  return {
    bucketHeight: safeBucket,
    buckets,
    totalHeight: layout.totalHeight,
  };
}

/**
 * Query visible items overlapping the given scroll window, using a
 * pre-built visibility index. Deduplicates positions that span multiple
 * buckets. Result is sorted by `top` for stable iteration order.
 */
export function getVisibleItemsFromIndex(
  index: VisibilityIndex,
  scrollTop: number,
  viewportHeight: number,
  overscanBefore: number,
  overscanAfter: number,
): MasonryPosition[] {
  if (index.buckets.length === 0) return [];

  const start = Math.max(0, scrollTop - overscanBefore);
  const end = Math.max(start, scrollTop + viewportHeight + overscanAfter);

  const startBucket = Math.max(0, Math.floor(start / index.bucketHeight));
  const endBucket = Math.min(
    index.buckets.length - 1,
    Math.floor(end / index.bucketHeight),
  );

  if (startBucket > endBucket) return [];

  // Collect via Set to dedupe positions appearing in multiple buckets.
  const seen = new Set<MasonryPosition>();
  const result: MasonryPosition[] = [];

  for (let i = startBucket; i <= endBucket; i += 1) {
    const bucket = index.buckets[i];
    if (!bucket) continue;
    for (const position of bucket) {
      if (seen.has(position)) continue;
      // Re-check exact overlap: a position may be in a bucket whose range
      // overlaps the query but the position itself falls just outside.
      if (position.bottom >= start && position.top <= end) {
        seen.add(position);
        result.push(position);
      }
    }
  }

  // Sort by top for stable iteration order (buckets collect positions in
  // packing order, which may not be top-sorted).
  result.sort((a, b) => a.top - b.top);
  return result;
}
