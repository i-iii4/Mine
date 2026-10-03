import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import type { MasonryPosition } from "@/lib/masonryLayout";
import { findFirstCardAtOrBelowTop, marqueeAutoScrollVelocity } from "./interaction";

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
