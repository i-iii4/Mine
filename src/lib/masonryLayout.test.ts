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

  // SPEC_GRID.md, «Форма ленты», user decision 06.11.2026.
  describe("the shape of a feed, whatever the memory says", () => {
    const FOUR_COLUMNS = 1000;

    function expectShape(columns: number[]) {
      if (columns.length === 0) return;
      expect(columns[0]).toBe(0);
      const used = [...new Set(columns)].sort((first, second) => first - second);
      expect(used).toEqual(used.map((_, index) => index));
    }

    it("puts a lone card into the first column, not the one it stood in", () => {
      const layout = computeMasonryLayout([100], FOUR_COLUMNS, MIN_COL, GAP, () => 3);
      expect(layout.positions.map((position) => position.column)).toEqual([0]);
      expect(layout.positions[0]!.left).toBe(0);
    });

    it("leaves no column empty with a card to its right", () => {
      // The cards of columns 1 and 2 left; those of 0 and 3 stay.
      const remembered = [0, 3, 0, 3];
      const layout = computeMasonryLayout([100, 100, 100, 100], FOUR_COLUMNS, MIN_COL, GAP, (index) => remembered[index]);
      expectShape(layout.positions.map((position) => position.column));
    });

    it("lays the feed out anew when the first card does not stand in the first column", () => {
      // The first card left: the new first one stood in column 1, and a later
      // card holds column 0.
      const remembered = [1, 2, 0];
      const heights = [100, 120, 80];
      const layout = computeMasonryLayout(heights, 900, MIN_COL, GAP, (index) => remembered[index]);
      const fresh = computeMasonryLayout(heights, 900, MIN_COL, GAP);
      expect(layout).toEqual(fresh);
    });

    it("keeps every column when the cards that left do not break the shape", () => {
      // Column 1 still has a card after one of its two left.
      const remembered = [0, 1, 2, 0, 2];
      const layout = computeMasonryLayout([100, 90, 80, 70, 60], 900, MIN_COL, GAP, (index) => remembered[index]);
      expect(layout.positions.map((position) => position.column)).toEqual(remembered);
    });

    it("holds through any run of departures and height changes", () => {
      let state = 12345;
      const next = () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
      for (const width of [326, 700, 1000, 1400, 2200]) {
        for (let run = 0; run < 40; run += 1) {
          let cards = Array.from({ length: 1 + Math.floor(next() * 30) }, (_, id) => ({
            id,
            height: 40 + Math.floor(next() * 500),
          }));
          const column = new Map<number, number>();
          while (cards.length > 0) {
            const layout = computeMasonryLayout(
              cards.map((card) => card.height),
              width,
              MIN_COL,
              GAP,
              (index) => column.get(cards[index]!.id),
            );
            expectShape(layout.positions.map((position) => position.column));
            layout.positions.forEach((position) => column.set(cards[position.index]!.id, position.column));
            // A card changes its height, and some cards leave the list.
            const changed = cards[Math.floor(next() * cards.length)]!;
            changed.height = 40 + Math.floor(next() * 500);
            cards = cards.filter(() => next() > 0.3);
          }
        }
      }
    });
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

  // Spacing 8 and 2 (user's decision of 15.11.2026): the gap and the edges
  // stay the token, cards never touch, and a column comes in only where its
  // minimum width and one more gap fit.
  describe.each([8, 2])("at Spacing %i", (gap) => {
    it.each([390, 470, 850, 1200, 1800])("lays a feed of %i px out with gaps of exactly the token", (feed) => {
      const width = feed - 2 * gap;
      const heights = Array.from({ length: 24 }, (_, index) => 80 + ((index * 53) % 170));
      const layout = computeMasonryLayout(heights, width, MIN_COL, gap);
      expect(layout.columnCount).toBe(Math.max(2, Math.floor((width + gap) / (MIN_COL + gap))));
      const byColumn = new Map<number, typeof layout.positions>();
      for (const position of layout.positions) {
        expect(position.left).toBeGreaterThanOrEqual(0);
        expect(position.left + position.width).toBeLessThanOrEqual(width);
        byColumn.set(position.column, [...(byColumn.get(position.column) ?? []), position]);
      }
      const columns = [...byColumn.keys()].sort((a, b) => a - b);
      // The last column ends at the edge: the space at both edges is the inset alone.
      const last = byColumn.get(columns.at(-1)!)![0]!;
      expect(last.left + last.width).toBe(width);
      for (const [index, column] of columns.entries()) {
        const cards = byColumn.get(column)!;
        for (let i = 1; i < cards.length; i += 1) expect(cards[i]!.top - cards[i - 1]!.bottom).toBe(gap);
        if (index > 0) {
          const before = byColumn.get(columns[index - 1]!)![0]!;
          expect(cards[0]!.left - (before.left + before.width)).toBe(gap);
        }
      }
    });
  });
});

// SPEC_GRID.md, «Кэш при карточке и продолжение раскладки»: a layout that
// goes on from another one is the layout made from the first item.
describe("computeMasonryLayout going on from a layout", () => {
  /** The same numbers for the same seed on every run. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }
  const heightsOf = (count: number, next: () => number) =>
    Array.from({ length: count }, () => 60 + Math.floor(next() * 400));

  it("places a page added to the end from the columns' heights", () => {
    const next = random(11);
    const before = heightsOf(500, next);
    const held = computeMasonryLayout(before, 1180, MIN_COL, GAP);
    const columnOf = (index: number) => held.positions[index]?.column;
    const grown = [...before, ...heightsOf(40, next)];

    const continued = computeMasonryLayout(grown, 1180, MIN_COL, GAP, columnOf, { layout: held, keep: before.length });

    expect(continued).toEqual(computeMasonryLayout(grown, 1180, MIN_COL, GAP, columnOf));
    before.forEach((_, index) => expect(continued.positions[index]).toBe(held.positions[index]));
    expect(continued.positions).not.toBe(held.positions);
  });

  it("goes on from the first item whose height changed, and keeps the items that did not move", () => {
    const next = random(12);
    const before = heightsOf(300, next);
    const held = computeMasonryLayout(before, 1180, MIN_COL, GAP);
    const columnOf = (index: number) => held.positions[index]?.column;
    const changedAt = 120;
    const after = before.map((height, index) => (index === changedAt ? height + 37 : height));

    const continued = computeMasonryLayout(after, 1180, MIN_COL, GAP, columnOf, { layout: held, keep: changedAt });

    expect(continued).toEqual(computeMasonryLayout(after, 1180, MIN_COL, GAP, columnOf));
    const column = held.positions[changedAt]!.column;
    continued.positions.forEach((position, index) => {
      const moved = index >= changedAt && position.column === column;
      if (moved) expect(position).not.toBe(held.positions[index]);
      else expect(position).toBe(held.positions[index]);
    });
  });

  it("is the layout made from the first item on random lists, kept counts and remembered columns", () => {
    for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
      const next = random(seed);
      const width = 500 + Math.floor(next() * 1000);
      const gap = [8, 16, 32][Math.floor(next() * 3)]!;
      const before = heightsOf(20 + Math.floor(next() * 200), next);
      const held = computeMasonryLayout(before, width, MIN_COL, gap);
      // Some items leave, some change their height, a few arrive at the end.
      const stays = before.map(() => next() > 0.03);
      const kept: { was: number; height: number }[] = [];
      before.forEach((height, index) => {
        if (stays[index]) kept.push({ was: index, height: next() < 0.05 ? height + 11 : height });
      });
      const heights = [...kept.map((item) => item.height), ...heightsOf(Math.floor(next() * 30), next)];
      const columnOf = (index: number) => (index < kept.length ? held.positions[kept[index]!.was]!.column : undefined);
      // The items vouched for: the same place, the same height.
      let keep = 0;
      while (keep < kept.length && kept[keep]!.was === keep && kept[keep]!.height === before[keep]) keep += 1;

      const expected = computeMasonryLayout(heights, width, MIN_COL, gap, columnOf);
      for (const vouched of [keep, Math.floor(keep / 2), 0]) {
        expect(computeMasonryLayout(heights, width, MIN_COL, gap, columnOf, { layout: held, keep: vouched })).toEqual(expected);
      }
      // Without remembered columns only an untouched head may be vouched for.
      const plain = computeMasonryLayout(heights, width, MIN_COL, gap);
      expect(computeMasonryLayout(heights, width, MIN_COL, gap, undefined, { layout: held, keep })).toEqual(plain);
    }
  });

  it("falls back to a layout made anew when the remembered columns break the feed's shape", () => {
    const before = [100, 100, 100, 100, 100, 100];
    const held = computeMasonryLayout(before, 760, MIN_COL, GAP);
    expect(held.positions.map((position) => position.column)).toEqual([0, 1, 2, 0, 1, 2]);
    // Only the items of the last column remain: by memory they would leave
    // the first two columns empty.
    const kept = [2, 5];
    const columnOf = (index: number) => held.positions[kept[index]!]?.column;
    const heights = kept.map((index) => before[index]!);

    const continued = computeMasonryLayout(heights, 760, MIN_COL, GAP, columnOf, { layout: held, keep: 0 });

    expect(continued).toEqual(computeMasonryLayout(heights, 760, MIN_COL, GAP, columnOf));
    expect(continued.positions.map((position) => position.column)).toEqual([0, 1]);
  });

  it("keeps the array of positions when no item moved, in a layout object of its own", () => {
    const heights = heightsOf(80, random(31));
    const held = computeMasonryLayout(heights, 1180, MIN_COL, GAP);
    const columnOf = (index: number) => held.positions[index]?.column;

    for (const keep of [heights.length, 40, 0]) {
      const again = computeMasonryLayout([...heights], 1180, MIN_COL, GAP, columnOf, { layout: held, keep });
      expect(again).not.toBe(held);
      expect(again.positions).toBe(held.positions);
      expect(again.totalHeight).toBe(held.totalHeight);
    }
    // One item fewer is another array, of the same position objects.
    const shorter = computeMasonryLayout(heights.slice(0, -1), 1180, MIN_COL, GAP, columnOf, { layout: held, keep: heights.length - 1 });
    expect(shorter.positions).not.toBe(held.positions);
    shorter.positions.forEach((position, index) => expect(position).toBe(held.positions[index]));
  });

  it("takes position objects from the layout named to reuse", () => {
    const next = random(41);
    const before = heightsOf(60, next);
    const held = computeMasonryLayout(before, 1180, MIN_COL, GAP);
    const columnOf = (index: number) => held.positions[index]?.column;
    const grown = [...before, ...heightsOf(10, next)];
    const first = computeMasonryLayout(grown, 1180, MIN_COL, GAP, columnOf, { layout: held, keep: before.length });
    // The last item's height changes: the others of the page stand.
    const regrown = [...grown.slice(0, -1), grown[grown.length - 1]! + 5];

    const second = computeMasonryLayout(regrown, 1180, MIN_COL, GAP, columnOf, { layout: held, keep: before.length, reuse: first });

    expect(second).toEqual(computeMasonryLayout(regrown, 1180, MIN_COL, GAP, columnOf));
    second.positions.slice(0, -1).forEach((position, index) => expect(position).toBe(first.positions[index]));
    expect(second.positions[second.positions.length - 1]).not.toBe(first.positions[first.positions.length - 1]);
  });

  it("takes nothing from a layout of other columns", () => {
    const heights = heightsOf(50, random(51));
    const held = computeMasonryLayout(heights, 1180, MIN_COL, GAP);

    const narrower = computeMasonryLayout(heights, 900, MIN_COL, GAP, undefined, { layout: held, keep: heights.length });

    expect(narrower).toEqual(computeMasonryLayout(heights, 900, MIN_COL, GAP));
    narrower.positions.forEach((position, index) => expect(position).not.toBe(held.positions[index]));
  });
});
