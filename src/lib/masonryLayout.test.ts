import { describe, expect, it } from "vitest";
import {
  computeMasonryLayout,
  getMasonryColumnCount,
  getVisibleMasonryItems,
  createVisibilityIndex,
  getVisibleItemsFromIndex,
} from "./masonryLayout";

const MIN_COL = 220;
const GAP = 32;

describe("masonryLayout", () => {
  it("computes the number of columns from the container width", () => {
    expect(getMasonryColumnCount(1200, 220, 32)).toBe(4);
    expect(getMasonryColumnCount(300, 220, 32)).toBe(1);
  });

  it("places cards into the shortest column", () => {
    const layout = computeMasonryLayout([100, 120, 80, 90], 900, MIN_COL, GAP);

    expect(layout.columnCount).toBe(3);
    expect(layout.positions.map((position) => [position.column, position.top])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 112],
    ]);
    expect(layout.totalHeight).toBe(202);
  });

  it("derives max width from the next min-width threshold while preserving the configured gap", () => {
    const layout = computeMasonryLayout([100, 100, 100], 1000, MIN_COL, GAP);

    expect(layout.columnCount).toBe(4);
    expect(layout.columnWidth).toBe(226);
    expect(layout.positions[1]?.left).toBe(layout.columnWidth + GAP);

    const singleColumn = computeMasonryLayout([100], 471, MIN_COL, GAP);
    expect(singleColumn.columnCount).toBe(1);
    expect(singleColumn.columnWidth).toBe(471);

    const nextThreshold = computeMasonryLayout([100, 100], 472, MIN_COL, GAP);
    expect(nextThreshold.columnCount).toBe(2);
    expect(nextThreshold.columnWidth).toBe(MIN_COL);
  });

  it("returns only items inside the viewport plus overscan", () => {
    const layout = computeMasonryLayout([100, 100, 100, 100, 100], 600, MIN_COL, GAP);
    const visible = getVisibleMasonryItems(layout.positions, 90, 120, 20, 20);

    expect(visible.map((item) => item.index)).toEqual([0, 1, 2, 3]);
  });
});

// ─── Visibility index ───────────────────────────────────────────────────────

function makeHeights(count: number, seed = 1): number[] {
  // Deterministic pseudo-random heights, 100-500px range
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < count; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    out.push(100 + (s / 233280) * 400);
  }
  return out;
}

describe("createVisibilityIndex", () => {
  it("handles empty layout", () => {
    const layout = computeMasonryLayout([], 1000, MIN_COL, GAP);
    const index = createVisibilityIndex(layout);
    expect(index.buckets.length).toBeGreaterThanOrEqual(1);
    expect(index.totalHeight).toBe(0);
  });

  it("places each position in all overlapping buckets", () => {
    const heights = [100, 200, 300];
    const layout = computeMasonryLayout(heights, 1000, MIN_COL, GAP);
    const index = createVisibilityIndex(layout, 100);

    let totalEntries = 0;
    for (const bucket of index.buckets) totalEntries += bucket.length;
    expect(totalEntries).toBeGreaterThanOrEqual(layout.positions.length);
  });
});

describe("getVisibleItemsFromIndex — matches brute force filter", () => {
  function compareSets(
    brute: ReturnType<typeof getVisibleMasonryItems>,
    indexed: ReturnType<typeof getVisibleItemsFromIndex>,
  ): void {
    expect(indexed.length).toBe(brute.length);
    const bruteIds = new Set(brute.map((p) => p.index));
    const indexedIds = new Set(indexed.map((p) => p.index));
    expect(indexedIds).toEqual(bruteIds);
  }

  it("matches brute force for small layout", () => {
    const layout = computeMasonryLayout(makeHeights(50), 1000, MIN_COL, GAP);
    const index = createVisibilityIndex(layout, 300);
    const brute = getVisibleMasonryItems(layout.positions, 500, 800, 100, 200);
    const indexed = getVisibleItemsFromIndex(index, 500, 800, 100, 200);
    compareSets(brute, indexed);
  });

  it("matches brute force for 1000-item layout at top", () => {
    const layout = computeMasonryLayout(makeHeights(1000), 1200, MIN_COL, GAP);
    const index = createVisibilityIndex(layout);
    const brute = getVisibleMasonryItems(layout.positions, 0, 900, 0, 600);
    const indexed = getVisibleItemsFromIndex(index, 0, 900, 0, 600);
    compareSets(brute, indexed);
  });

  it("matches brute force for 1000-item layout in the middle", () => {
    const layout = computeMasonryLayout(makeHeights(1000, 42), 1200, MIN_COL, GAP);
    const index = createVisibilityIndex(layout);
    const mid = layout.totalHeight / 2;
    const brute = getVisibleMasonryItems(layout.positions, mid, 900, 300, 300);
    const indexed = getVisibleItemsFromIndex(index, mid, 900, 300, 300);
    compareSets(brute, indexed);
  });

  it("matches brute force at the very bottom of the layout", () => {
    const layout = computeMasonryLayout(makeHeights(500), 1200, MIN_COL, GAP);
    const index = createVisibilityIndex(layout);
    const bottom = Math.max(0, layout.totalHeight - 800);
    const brute = getVisibleMasonryItems(layout.positions, bottom, 800, 200, 200);
    const indexed = getVisibleItemsFromIndex(index, bottom, 800, 200, 200);
    compareSets(brute, indexed);
  });

  it("returns items sorted by top", () => {
    const layout = computeMasonryLayout(makeHeights(200), 1200, MIN_COL, GAP);
    const index = createVisibilityIndex(layout);
    const visible = getVisibleItemsFromIndex(index, 500, 1000, 200, 400);
    for (let i = 1; i < visible.length; i += 1) {
      expect(visible[i]!.top).toBeGreaterThanOrEqual(visible[i - 1]!.top);
    }
  });

  it("returns empty when scroll window is entirely after layout", () => {
    const layout = computeMasonryLayout([100, 100, 100], 1000, MIN_COL, GAP);
    const index = createVisibilityIndex(layout);
    const visible = getVisibleItemsFromIndex(index, layout.totalHeight + 1000, 500, 0, 0);
    expect(visible.length).toBe(0);
  });
});
