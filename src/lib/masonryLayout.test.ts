import { describe, expect, it } from "vitest";
import {
  computeMasonryLayout,
  getMasonryColumnCount,
  getMasonryColumnWidth,
  getVisibleMasonryItems,
  createVisibilityIndex,
  getVisibleItemsFromIndex,
  MASONRY_MIN_COLUMN_COUNT,
} from "./masonryLayout";

const MIN_COL = 220;
const GAP = 32;

describe("masonryLayout", () => {
  it("computes the number of columns from the container width", () => {
    expect(getMasonryColumnCount(1200, 220, 32)).toBe(4);
    expect(getMasonryColumnCount(723, 220, 32)).toBe(2);
    expect(getMasonryColumnCount(724, 220, 32)).toBe(3);
  });

  // SPEC_GRID.md, «Число колонок» (user decision 16.10.2026): a feed too
  // narrow for two columns of the minimum width keeps two narrower columns.
  it("keeps two columns in a feed too narrow for two of the minimum width", () => {
    expect(MASONRY_MIN_COLUMN_COUNT).toBe(2);
    for (const width of [471, 326, 300, 120]) {
      expect(getMasonryColumnCount(width, MIN_COL, GAP)).toBe(2);
    }

    // The narrowest feed of the app: 390 px less the 32-px insets.
    const layout = computeMasonryLayout([100, 100, 100], 326, MIN_COL, GAP);
    expect(layout.columnCount).toBe(2);
    expect(layout.columnWidth).toBe(147);
    expect(layout.columnWidth).toBeLessThan(MIN_COL);
    const [first, second, third] = layout.positions;
    expect(first).toMatchObject({ column: 0, left: 0, width: 147, top: 0 });
    expect(second).toMatchObject({ column: 1, left: 147 + GAP, width: 147, top: 0 });
    expect(second!.left + second!.width).toBe(326);
    expect(third).toMatchObject({ column: 0, top: 100 + GAP });
  });

  it("never gives a column a width below one pixel, whatever the feed width", () => {
    for (const width of [0, 1, GAP, GAP + 2, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getMasonryColumnCount(width, MIN_COL, GAP)).toBe(2);
      expect(getMasonryColumnWidth(width, MIN_COL, GAP)).toBe(1);

      const layout = computeMasonryLayout([100, 100], width, MIN_COL, GAP);
      expect(layout.columnCount).toBe(2);
      expect(layout.columnWidth).toBe(1);
      for (const position of layout.positions) {
        expect(position.width).toBe(1);
        expect(Number.isFinite(position.left)).toBe(true);
        expect(position.left).toBeGreaterThanOrEqual(0);
      }
      expect(layout.positions.map((position) => position.column)).toEqual([0, 1]);
    }
    // From gap + 2 px on, the two columns and their gap fit inside the feed.
    const fitting = computeMasonryLayout([100, 100], GAP + 2, MIN_COL, GAP);
    expect(fitting.positions[1]!.left + fitting.positions[1]!.width).toBe(GAP + 2);
    expect(getMasonryColumnWidth(GAP + 4, MIN_COL, GAP)).toBe(2);
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

  // SPEC_GRID_LAYOUT_READINESS.md, К1: a card that grows moves only the
  // cards under it in its own column; without the memory the whole feed
  // reshuffles into other columns.
  it("keeps every card in its column when one card's height changes", () => {
    const heights = [100, 120, 80, 90, 110, 70, 60];
    const before = computeMasonryLayout(heights, 900, MIN_COL, GAP);
    const columns = before.positions.map((position) => position.column);

    const grown = [...heights];
    grown[0] = 300;
    const reshuffled = computeMasonryLayout(grown, 900, MIN_COL, GAP);
    expect(reshuffled.positions.map((position) => position.column)).not.toEqual(columns);

    const kept = computeMasonryLayout(grown, 900, MIN_COL, GAP, (index) => columns[index]);
    expect(kept.positions.map((position) => position.column)).toEqual(columns);
    for (const position of kept.positions) {
      const was = before.positions[position.index]!;
      if (position.column === columns[0] && position.index > 0) {
        expect(position.top).toBe(was.top + 200);
      } else if (position.index > 0) {
        expect(position.top).toBe(was.top);
      }
    }
  });

  it("puts a card the memory does not name, or names past the columns, into the shortest column", () => {
    const layout = computeMasonryLayout([100, 120, 80, 90], 900, MIN_COL, GAP, (index) =>
      index === 3 ? 7 : index === 2 ? undefined : index,
    );
    expect(layout.positions.map((position) => position.column)).toEqual([0, 1, 2, 2]);
  });

  it("derives max width from the next min-width threshold while preserving the configured gap", () => {
    const layout = computeMasonryLayout([100, 100, 100], 1000, MIN_COL, GAP);

    expect(layout.columnCount).toBe(4);
    expect(layout.columnWidth).toBe(226);
    expect(layout.positions[1]?.left).toBe(layout.columnWidth + GAP);

    // Two columns grow up to the width at which a third one fits.
    const twoColumns = computeMasonryLayout([100, 100], 723, MIN_COL, GAP);
    expect(twoColumns.columnCount).toBe(2);
    expect(twoColumns.columnWidth).toBe(345);

    const nextThreshold = computeMasonryLayout([100, 100, 100], 724, MIN_COL, GAP);
    expect(nextThreshold.columnCount).toBe(3);
    expect(nextThreshold.columnWidth).toBe(MIN_COL);
  });

  it("snaps column widths and positions to whole CSS pixels", () => {
    const layout = computeMasonryLayout([100, 100, 100], 902, MIN_COL, GAP);

    expect(layout.columnCount).toBe(3);
    expect(layout.columnWidth).toBe(279);
    expect(getMasonryColumnWidth(902, MIN_COL, GAP)).toBe(layout.columnWidth);
    for (const position of layout.positions) {
      expect(Number.isInteger(position.left)).toBe(true);
      expect(Number.isInteger(position.width)).toBe(true);
    }
  });

  it("gives leftover pixels to the columns, so edges and gaps are exactly the token", () => {
    for (const width of [902, 1000, 1279, 1343, 1512]) {
      const layout = computeMasonryLayout(new Array(12).fill(100), width, MIN_COL, GAP);
      const firstRow = layout.positions.slice(0, layout.columnCount).sort((a, b) => a.left - b.left);
      expect(firstRow[0]!.left).toBe(0);
      const last = firstRow[firstRow.length - 1]!;
      expect(last.left + last.width).toBe(width);
      for (let i = 1; i < firstRow.length; i += 1) {
        expect(firstRow[i]!.left - (firstRow[i - 1]!.left + firstRow[i - 1]!.width)).toBe(GAP);
      }
      for (const position of firstRow) {
        expect(position.width - layout.columnWidth).toBeGreaterThanOrEqual(0);
        expect(position.width - layout.columnWidth).toBeLessThanOrEqual(1);
      }
    }
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
