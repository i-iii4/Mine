import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import { computeMasonryLayout, type MasonryPosition } from "@/lib/masonryLayout";
import {
  findFirstCardAtOrBelowTop,
  findLayoutNeighborSlug,
  type GridArrowKey,
  horizontalStepBackSlug,
  marqueeAutoScrollVelocity,
} from "./interaction";

const VIEWPORT_TOP = 100;
const VIEWPORT_BOTTOM = 700;

describe("marqueeAutoScrollVelocity", () => {
  it("stays at rest away from both edges", () => {
    expect(marqueeAutoScrollVelocity(400, VIEWPORT_TOP, VIEWPORT_BOTTOM)).toBe(0);
    expect(marqueeAutoScrollVelocity(VIEWPORT_TOP + 56, VIEWPORT_TOP, VIEWPORT_BOTTOM)).toBe(0);
    expect(marqueeAutoScrollVelocity(VIEWPORT_BOTTOM - 56, VIEWPORT_TOP, VIEWPORT_BOTTOM)).toBe(0);
  });

  it("pulls up inside the top band and down inside the bottom band", () => {
    expect(marqueeAutoScrollVelocity(VIEWPORT_TOP + 10, VIEWPORT_TOP, VIEWPORT_BOTTOM))
      .toBeLessThan(0);
    expect(marqueeAutoScrollVelocity(VIEWPORT_BOTTOM - 10, VIEWPORT_TOP, VIEWPORT_BOTTOM))
      .toBeGreaterThan(0);
  });

  it("ramps speed with depth into the band", () => {
    const shallow = marqueeAutoScrollVelocity(VIEWPORT_BOTTOM - 50, VIEWPORT_TOP, VIEWPORT_BOTTOM);
    const deep = marqueeAutoScrollVelocity(VIEWPORT_BOTTOM - 5, VIEWPORT_TOP, VIEWPORT_BOTTOM);
    expect(deep).toBeGreaterThan(shallow);
  });

  it("keeps the maximum pull past the scrollport edge instead of losing it", () => {
    const atEdge = marqueeAutoScrollVelocity(VIEWPORT_BOTTOM, VIEWPORT_TOP, VIEWPORT_BOTTOM);
    const beyondEdge = marqueeAutoScrollVelocity(VIEWPORT_BOTTOM + 400, VIEWPORT_TOP, VIEWPORT_BOTTOM);
    expect(beyondEdge).toBe(atEdge);

    const aboveTop = marqueeAutoScrollVelocity(VIEWPORT_TOP - 400, VIEWPORT_TOP, VIEWPORT_BOTTOM);
    expect(aboveTop).toBe(-atEdge);
  });

  it("reports no pull for a collapsed scrollport", () => {
    expect(marqueeAutoScrollVelocity(100, 100, 100)).toBe(0);
  });
});

describe("findFirstCardAtOrBelowTop (SPEC_TABS.md, В28)", () => {
  // Only the slug is read; the rest of a card does not take part.
  const card = (slug: string) => ({ slug }) as LightBlock;
  const at = (index: number, top: number, left: number): MasonryPosition => ({
    index,
    top,
    left,
    width: 200,
    height: 100,
    bottom: top + 100,
    column: left === 0 ? 0 : 1,
  });
  const blocks = [card("a"), card("b"), card("c"), card("d")];
  const positions = [at(0, 0, 0), at(1, 0, 210), at(2, 110, 0), at(3, 160, 210)];

  it("takes the first card whose top is at or below the feed's top, and that distance", () => {
    // Top inset 8: card c starts at 118, card d at 168.
    expect(findFirstCardAtOrBelowTop(positions, blocks, 100, 8)).toEqual({ slug: "c", offsetTop: 18 });
    expect(findFirstCardAtOrBelowTop(positions, blocks, 118, 8)).toEqual({ slug: "c", offsetTop: 0 });
    expect(findFirstCardAtOrBelowTop(positions, blocks, 119, 8)).toEqual({ slug: "d", offsetTop: 49 });
  });

  it("takes the leftmost of cards that start on the same line", () => {
    expect(findFirstCardAtOrBelowTop(positions, blocks, 0, 0)).toEqual({ slug: "a", offsetTop: 0 });
  });

  it("has nothing when no card starts below the top", () => {
    expect(findFirstCardAtOrBelowTop(positions, blocks, 500, 8)).toBeNull();
  });
});

describe("findLayoutNeighborSlug (SPEC_KEYBOARD.md, «Feed»)", () => {
  const MIN_COLUMN = 220;
  const GAP = 32;
  const FOUR_COLUMNS = 1000;
  const TWO_COLUMNS = 500;

  // Only the id and the slug are read; the rest of a card does not take part.
  function feedOf(heights: number[], width: number = FOUR_COLUMNS, notLive: number[] = []) {
    const blocks = heights.map((_, index) => ({ id: index, slug: `c${index}` }) as LightBlock);
    const { positions } = computeMasonryLayout(heights, width, MIN_COLUMN, GAP);
    const live = new Set(blocks.map((block) => block.id).filter((id) => !notLive.includes(id)));
    const press = (slug: string, key: GridArrowKey) => findLayoutNeighborSlug(positions, blocks, slug, key, live);
    return { blocks, positions, live, press };
  }

  // c0 and c2 stand level, c1 between them is a long card whose centre is far
  // below: distance between centres sent both past c1, and nothing reached it.
  it("goes to the adjacent column, not past it to a card at the same height", () => {
    const { press } = feedOf([300, 1000, 300, 300]);
    expect(press("c2", "ArrowLeft")).toBe("c1");
    expect(press("c0", "ArrowRight")).toBe("c1");
  });

  it("takes the card with the largest vertical overlap in that column", () => {
    // Column 0 is c0 and c2, column 1 is the tall c1.
    const { press, positions } = feedOf([100, 500, 300], TWO_COLUMNS);
    expect(positions.map((position) => position.left)).toEqual([0, positions[1]!.left, 0]);
    expect(press("c1", "ArrowLeft")).toBe("c2");
  });

  it("takes the upper card when the overlaps are equal", () => {
    // The tall c0 stands beside three cards of one height, all within its span.
    const { press } = feedOf([1000, 300, 300, 300], TWO_COLUMNS);
    expect(press("c0", "ArrowRight")).toBe("c1");
  });

  it("takes the nearest card by vertical gap when nothing overlaps", () => {
    // c2 is alone at the bottom of column 0, c1 ended above it.
    const { press } = feedOf([100, 100, 100], TWO_COLUMNS);
    expect(press("c2", "ArrowRight")).toBe("c1");
  });

  it("takes the upper card when two cards are equally near and neither overlaps", () => {
    const at = (index: number, left: number, top: number, bottom: number): MasonryPosition => ({
      index,
      top,
      left,
      width: 200,
      height: bottom - top,
      bottom,
      column: left === 0 ? 0 : 1,
    });
    const blocks = [0, 1, 2].map((id) => ({ id, slug: `c${id}` }) as LightBlock);
    const positions = [at(0, 0, 150, 200), at(1, 232, 0, 100), at(2, 232, 250, 350)];
    expect(findLayoutNeighborSlug(positions, blocks, "c0", "ArrowRight", new Set([0, 1, 2]))).toBe("c1");
  });

  it("passes a column with no live card and stops at the next one that has one", () => {
    const { press } = feedOf([300, 1000, 300, 300], FOUR_COLUMNS, [1]);
    expect(press("c2", "ArrowLeft")).toBe("c0");
    expect(press("c0", "ArrowRight")).toBe("c2");
  });

  it("has nothing to the left of the leftmost column that holds a live card", () => {
    const { press } = feedOf([300, 1000, 300, 300], FOUR_COLUMNS, [0]);
    expect(press("c1", "ArrowLeft")).toBeNull();
    expect(feedOf([300, 1000, 300, 300]).press("c0", "ArrowLeft")).toBeNull();
    expect(feedOf([300, 1000, 300, 300]).press("c3", "ArrowRight")).toBeNull();
  });

  it("keeps ArrowUp and ArrowDown in the column, and they do nothing at its ends", () => {
    // Column 0: c0, c3. Column 1: the tall c1. Column 2: c2. Column 3: nothing yet.
    const { press, positions } = feedOf([100, 900, 100, 100, 100], 750);
    const columns = positions.map((position) => position.left);
    expect(columns[3]).toBe(columns[0]);
    expect(columns[4]).toBe(columns[2]);

    expect(press("c0", "ArrowDown")).toBe("c3");
    expect(press("c3", "ArrowUp")).toBe("c0");
    expect(press("c3", "ArrowDown")).toBeNull();
    expect(press("c0", "ArrowUp")).toBeNull();
    // The tall card has cards level with it next door, and stays where it is.
    expect(press("c1", "ArrowDown")).toBeNull();
    expect(press("c1", "ArrowUp")).toBeNull();
  });

  it("passes a card that is not live on the way up and down", () => {
    const { press } = feedOf([100, 100, 100, 100, 100, 100], 750, [3]);
    expect(press("c0", "ArrowDown")).toBeNull();
    expect(press("c1", "ArrowDown")).toBe("c4");
  });

  it("works the same in a single column", () => {
    const at = (index: number, top: number): MasonryPosition => ({
      index,
      top,
      left: 0,
      width: 400,
      height: 100,
      bottom: top + 100,
      column: 0,
    });
    const blocks = [0, 1, 2].map((id) => ({ id, slug: `c${id}` }) as LightBlock);
    const positions = [at(0, 0), at(1, 132), at(2, 264)];
    const live = new Set([0, 1, 2]);
    const press = (slug: string, key: GridArrowKey) => findLayoutNeighborSlug(positions, blocks, slug, key, live);
    expect(press("c1", "ArrowDown")).toBe("c2");
    expect(press("c1", "ArrowUp")).toBe("c0");
    expect(press("c1", "ArrowLeft")).toBeNull();
    expect(press("c1", "ArrowRight")).toBeNull();
  });

  // Varied heights and column counts, with some cards not live yet. Every
  // press must obey the rule, and from every live card every other live card
  // must be reachable by presses alone.
  describe("on real layouts", () => {
    const KEYS: GridArrowKey[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    const WIDTHS = [326, 500, 750, 1000, 1400, 2200];
    const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

    /** A small repeatable generator, so a failure names its own case. */
    function numbers(seed: number) {
      let state = seed;
      return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
    }

    function randomFeed(seed: number, width: number) {
      const next = numbers(seed * 7919 + width);
      const count = 3 + Math.floor(next() * 45);
      const heights = Array.from({ length: count }, () => 40 + Math.floor(next() * next() * 900));
      const notLive = heights.map((_, index) => index).filter(() => next() < 0.1);
      return feedOf(heights, width, notLive);
    }

    it("sends every press where the rule says", () => {
      for (const seed of SEEDS) {
        for (const width of WIDTHS) {
          const { blocks, positions, live, press } = randomFeed(seed, width);
          const liveCards = positions.filter((position) => live.has(position.index));
          const liveLefts = [...new Set(liveCards.map((position) => position.left))].sort((a, b) => a - b);
          const positionOf = (slug: string) => positions[blocks.findIndex((block) => block.slug === slug)]!;

          for (const card of liveCards) {
            const slug = blocks[card.index]!.slug;
            const column = liveCards
              .filter((position) => position.left === card.left)
              .sort((a, b) => a.top - b.top);
            const row = column.indexOf(card);
            expect(press(slug, "ArrowUp")).toBe(row > 0 ? blocks[column[row - 1]!.index]!.slug : null);
            expect(press(slug, "ArrowDown"))
              .toBe(row < column.length - 1 ? blocks[column[row + 1]!.index]!.slug : null);

            const place = liveLefts.indexOf(card.left);
            const left = press(slug, "ArrowLeft");
            const right = press(slug, "ArrowRight");
            expect(left === null).toBe(place === 0);
            expect(right === null).toBe(place === liveLefts.length - 1);
            if (left !== null) expect(positionOf(left).left).toBe(liveLefts[place - 1]);
            if (right !== null) expect(positionOf(right).left).toBe(liveLefts[place + 1]);
          }
        }
      }
    });

    it("reaches every live card from every other", () => {
      let columnsSeen = new Set<number>();
      for (const seed of SEEDS) {
        for (const width of WIDTHS) {
          const { blocks, positions, live, press } = randomFeed(seed, width);
          columnsSeen = columnsSeen.add(new Set(positions.map((position) => position.left)).size);
          const liveSlugs = positions
            .filter((position) => live.has(position.index))
            .map((position) => blocks[position.index]!.slug);

          for (const start of liveSlugs) {
            const reached = new Set([start]);
            const queue = [start];
            while (queue.length > 0) {
              const slug = queue.pop()!;
              for (const key of KEYS) {
                const next = press(slug, key);
                if (next !== null && !reached.has(next)) {
                  reached.add(next);
                  queue.push(next);
                }
              }
            }
            expect([...reached].sort()).toEqual([...liveSlugs].sort());
          }
        }
      }
      // The sample really does run through different column counts.
      expect(columnsSeen.size).toBeGreaterThanOrEqual(4);
    });
  });
});

describe("horizontalStepBackSlug (SPEC_KEYBOARD.md, «Feed»)", () => {
  const blocks = [0, 1].map((id) => ({ id, slug: `c${id}` }) as LightBlock);
  const { positions } = computeMasonryLayout([100, 100], 500, 220, 32);
  const live = new Set([0, 1]);
  const step = { from: "c1", to: "c0", direction: "ArrowLeft" as const, positions };

  it("returns where the last step came from on the opposite key", () => {
    expect(horizontalStepBackSlug(step, positions, blocks, "c0", "ArrowRight", live)).toBe("c1");
  });

  it("has nothing without a step, for another key, or away from where the step ended", () => {
    expect(horizontalStepBackSlug(null, positions, blocks, "c0", "ArrowRight", live)).toBeNull();
    expect(horizontalStepBackSlug(step, positions, blocks, "c0", "ArrowLeft", live)).toBeNull();
    expect(horizontalStepBackSlug(step, positions, blocks, "c0", "ArrowUp", live)).toBeNull();
    expect(horizontalStepBackSlug(step, positions, blocks, "c1", "ArrowRight", live)).toBeNull();
  });

  it("has nothing on another layout, even one with the same numbers", () => {
    const again = computeMasonryLayout([100, 100], 500, 220, 32).positions;
    expect(horizontalStepBackSlug(step, again, blocks, "c0", "ArrowRight", live)).toBeNull();
  });

  it("has nothing when the card it came from is no longer live", () => {
    expect(horizontalStepBackSlug(step, positions, blocks, "c0", "ArrowRight", new Set([0]))).toBeNull();
  });
});
