import { describe, expect, it } from "vitest";
import { marqueeAutoScrollVelocity, slugsWithinSelectionSpan } from "./interaction";

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

// A three-column masonry, columns of unequal height — the layout where a range
// taken over list order and a range taken over geometry disagree.
//
//   col 0        col 1        col 2
//   a (0,0)      b (200,0)    c (400,0)
//   d (0,220)    e (200,180)  f (400,260)
//   g (0,460)
const POSITIONS = [
  { index: 0, left: 0, top: 0, width: 180, height: 200, bottom: 200, column: 0 },
  { index: 1, left: 200, top: 0, width: 180, height: 160, bottom: 160, column: 1 },
  { index: 2, left: 400, top: 0, width: 180, height: 240, bottom: 240, column: 2 },
  { index: 3, left: 0, top: 220, width: 180, height: 220, bottom: 440, column: 0 },
  { index: 4, left: 200, top: 180, width: 180, height: 200, bottom: 380, column: 1 },
  { index: 5, left: 400, top: 260, width: 180, height: 180, bottom: 440, column: 2 },
  { index: 6, left: 0, top: 460, width: 180, height: 200, bottom: 660, column: 0 },
];
const BLOCKS = ["a", "b", "c", "d", "e", "f", "g"].map((slug, index) => ({
  id: index + 1,
  slug,
} as never as { id: number; slug: string }));
const LIVE = new Set(BLOCKS.map((block) => block.id));

const span = (anchor: string, cursor: string, live: ReadonlySet<number> = LIVE) =>
  slugsWithinSelectionSpan(
    POSITIONS,
    BLOCKS as never,
    anchor,
    cursor,
    live,
  ).sort();

describe("slugsWithinSelectionSpan", () => {
  it("holds a single card when the cursor sits on the anchor", () => {
    expect(span("a", "a")).toEqual(["a"]);
  });

  it("takes the anchor with it, so one step selects two", () => {
    expect(span("a", "d")).toEqual(["a", "d"]);
  });

  it("collects the cards a sideways step passes over", () => {
    // a → c spans all three columns at the top, so b comes along.
    expect(span("a", "c")).toEqual(["a", "b", "c"]);
  });

  it("leaves out a card whose centre is outside the span", () => {
    // g sits below the a–f rectangle and must not be swept in.
    expect(span("a", "f")).not.toContain("g");
  });

  it("does not follow list order across columns", () => {
    // b and c precede d in list order but lie outside the first column's span.
    expect(span("a", "d")).not.toContain("b");
    expect(span("a", "d")).not.toContain("c");
  });

  it("skips cards that are not ready to be shown", () => {
    const withoutB = new Set(LIVE);
    withoutB.delete(2);
    expect(span("a", "c", withoutB)).toEqual(["a", "c"]);
  });

  it("reads the same in both directions", () => {
    expect(span("f", "a")).toEqual(span("a", "f"));
  });

  it("returns nothing when either end is missing", () => {
    expect(span("a", "absent")).toEqual([]);
  });
});
