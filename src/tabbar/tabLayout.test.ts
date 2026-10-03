import { describe, expect, it } from "vitest";
import { EDGE_FADE_WIDTH } from "@/lib/edgeFade";
import { TAB_MAX_WIDTH_PX, TAB_MIN_WIDTH_PX } from "./constants";
import {
  effectiveTabWidth,
  hiddenEdges,
  revealScrollLeft,
  stripFadeMaskStyle,
  tabsOverflow,
  tabWidth,
} from "./tabLayout";

describe("tab width (В48)", () => {
  it("shares the room equally between the minimum and the maximum", () => {
    expect(tabWidth(900, 6)).toBe(150);
    expect(tabWidth(1000, 3)).toBe(TAB_MAX_WIDTH_PX);
    expect(tabWidth(500, 10)).toBe(TAB_MIN_WIDTH_PX);
  });

  it("rounds down, so the tabs never add up to more than the room", () => {
    const width = tabWidth(1000, 7);
    expect(width).toBe(142);
    expect(width * 7).toBeLessThanOrEqual(1000);
  });

  it("gives a bar with no room or no tabs a defined width", () => {
    expect(tabWidth(0, 3)).toBe(TAB_MIN_WIDTH_PX);
    expect(tabWidth(-40, 3)).toBe(TAB_MIN_WIDTH_PX);
    expect(tabWidth(800, 0)).toBe(TAB_MAX_WIDTH_PX);
  });

  it("scrolls only when even the minimum width does not fit", () => {
    expect(tabsOverflow(TAB_MIN_WIDTH_PX * 5, 5)).toBe(false);
    expect(tabsOverflow(TAB_MIN_WIDTH_PX * 5 - 1, 5)).toBe(true);
  });
});

describe("widths held after a close by the pointer (В48)", () => {
  it("keeps the held width while there are no more tabs than at the close", () => {
    const frozen = { width: 150, count: 6 };
    expect(effectiveTabWidth(900, 5, frozen)).toBe(150);
    expect(effectiveTabWidth(900, 6, frozen)).toBe(150);
  });

  it("lets a new tab end the hold", () => {
    expect(effectiveTabWidth(900, 7, { width: 150, count: 6 })).toBe(tabWidth(900, 7));
  });

  it("shares the room again without a hold", () => {
    expect(effectiveTabWidth(900, 5, null)).toBe(180);
  });
});

describe("the visible tab stays in view (В48)", () => {
  const strip = { count: 10, width: 100, viewport: 400 };

  it("leaves the scroll alone when the tab is already whole", () => {
    expect(revealScrollLeft({ ...strip, index: 2, scrollLeft: 100 })).toBe(100);
  });

  it("scrolls back to a tab hidden on the left", () => {
    expect(revealScrollLeft({ ...strip, index: 1, scrollLeft: 250 })).toBe(100);
  });

  it("scrolls on to a tab hidden on the right, as little as needed", () => {
    expect(revealScrollLeft({ ...strip, index: 7, scrollLeft: 0 })).toBe(400);
  });

  it("brings a partly hidden tab in whole", () => {
    expect(revealScrollLeft({ ...strip, index: 4, scrollLeft: 50 })).toBe(100);
  });

  it("stays within the offsets the strip can take", () => {
    expect(revealScrollLeft({ ...strip, index: 9, scrollLeft: 5000 })).toBe(600);
    expect(revealScrollLeft({ ...strip, index: 0, scrollLeft: -20 })).toBe(0);
  });

  it("does not scroll a strip that has no room yet", () => {
    expect(revealScrollLeft({ count: 4, width: 96, viewport: 0, index: 3, scrollLeft: 0 })).toBe(0);
    expect(revealScrollLeft({ count: 3, width: 240, viewport: 720, index: 2, scrollLeft: 0 })).toBe(0);
  });
});

describe("strip edges", () => {
  it("fades no edge when everything fits", () => {
    expect(hiddenEdges(0, 600, 600)).toEqual({ left: false, right: false });
    expect(stripFadeMaskStyle({ left: false, right: false })).toBeUndefined();
  });

  it("fades the edge tabs are hidden past", () => {
    expect(hiddenEdges(0, 400, 960)).toEqual({ left: false, right: true });
    expect(hiddenEdges(560, 400, 960)).toEqual({ left: true, right: false });
    expect(hiddenEdges(200, 400, 960)).toEqual({ left: true, right: true });
  });

  it("ignores sub-pixel offsets", () => {
    expect(hiddenEdges(0.5, 400, 960).left).toBe(false);
    expect(hiddenEdges(559.5, 400, 960).right).toBe(false);
  });

  it("dissolves the right edge with the shared right-edge ramp", () => {
    const style = stripFadeMaskStyle({ left: false, right: true }) as Record<string, string>;
    expect(style.maskImage).toMatch(/^linear-gradient\(to right, rgba\(0, 0, 0, 1\) 0%/);
    expect(style.maskImage).toContain(`calc(100% - ${EDGE_FADE_WIDTH}px)`);
    expect(style.maskImage).toContain("rgba(0, 0, 0, 0) 100%");
    expect(style.WebkitMaskImage).toBe(style.maskImage);
    expect(style.maskComposite).toBeUndefined();
  });

  it("dissolves the left edge with the same ramp turned around", () => {
    const style = stripFadeMaskStyle({ left: true, right: false }) as Record<string, string>;
    expect(style.maskImage).toMatch(/^linear-gradient\(to right, rgba\(0, 0, 0, 0\) 0px/);
    expect(style.maskImage).toContain(`rgba(0, 0, 0, 1) ${EDGE_FADE_WIDTH}px`);
    expect(style.maskImage).not.toContain("to bottom");
  });

  it("intersects both ramps in the middle of a scroll", () => {
    const style = stripFadeMaskStyle({ left: true, right: true }) as Record<string, string>;
    expect(style.maskImage?.match(/linear-gradient\(/g)).toHaveLength(2);
    expect(style.maskComposite).toBe("intersect");
    expect(style.WebkitMaskComposite).toBe("source-in");
  });
});
