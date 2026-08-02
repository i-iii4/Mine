import { describe, expect, it } from "vitest";
import {
  EDGE_FADE_WIDTH,
  TOP_FADE_MASK_STYLE,
  TOP_FADE_SCROLLED_THRESHOLD_PX,
  createRightFadeMaskStyle,
  createTopFadeMaskStyle,
  topFadeMaskStyleFor,
} from "./edgeFade";

/// Pull `<alpha, position>` pairs out of a generated gradient so the tests
/// assert the ramp shape instead of one frozen string.
function parseStops(gradient: string): { alpha: number; position: string }[] {
  return [...gradient.matchAll(/rgba\(0, 0, 0, ([\d.]+)\)\s+([^,]+?)(?=,|\)$)/g)].map(
    (match) => ({ alpha: Number(match[1]), position: match[2]!.trim() }),
  );
}

describe("createRightFadeMaskStyle", () => {
  it("matches the sidebar contract: opaque at the left, clear at the right edge", () => {
    const style = createRightFadeMaskStyle(EDGE_FADE_WIDTH, 0);
    const gradient = String(style.maskImage);
    const stops = parseStops(gradient);

    expect(gradient.startsWith("linear-gradient(to right,")).toBe(true);
    expect(stops[0]).toEqual({ alpha: 1, position: "0%" });
    expect(stops.at(-1)).toEqual({ alpha: 0, position: "100%" });
  });

  it("sets the same value on both the standard and WebKit mask property", () => {
    const style = createRightFadeMaskStyle(EDGE_FADE_WIDTH, 4);
    expect(style.maskImage).toBe(style.WebkitMaskImage);
  });

  it("offsets the whole ramp by the clear tail", () => {
    const withoutTail = String(createRightFadeMaskStyle(24, 0).maskImage);
    const withTail = String(createRightFadeMaskStyle(24, 12).maskImage);

    // The ramp start sits at fadeWidth + clearTail from the right edge.
    expect(withoutTail).toContain("calc(100% - 24px)");
    expect(withTail).toContain("calc(100% - 36px)");
    // The transparent end sits exactly at the reserved tail.
    expect(withTail).toContain("rgba(0, 0, 0, 0) calc(100% - 12px)");
  });
});

describe("createTopFadeMaskStyle", () => {
  it("is transparent at the top edge and fully opaque below the ramp", () => {
    const gradient = String(createTopFadeMaskStyle(EDGE_FADE_WIDTH).maskImage);
    const stops = parseStops(gradient);

    expect(gradient.startsWith("linear-gradient(to bottom,")).toBe(true);
    expect(stops[0]).toEqual({ alpha: 0, position: "0px" });
    expect(stops.at(-2)).toEqual({ alpha: 1, position: `${EDGE_FADE_WIDTH}px` });
    expect(stops.at(-1)).toEqual({ alpha: 1, position: "100%" });
  });

  it("increases alpha monotonically with distance from the top edge", () => {
    const stops = parseStops(String(createTopFadeMaskStyle(EDGE_FADE_WIDTH).maskImage));
    const rampStops = stops.slice(0, -1); // drop the trailing 100% anchor

    const positions = rampStops.map((stop) => Number.parseFloat(stop.position));
    const alphas = rampStops.map((stop) => stop.alpha);

    for (let i = 1; i < rampStops.length; i += 1) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
      expect(alphas[i]!).toBeGreaterThan(alphas[i - 1]!);
    }
  });

  it("mirrors the right-edge ramp: the same alphas in reverse order", () => {
    // Compare ramp stops only. The anchors differ by design: the right edge
    // reserves a fully transparent tail for the action column, the top edge has
    // nothing to clear and starts transparent exactly at the edge.
    const rampAlphas = (gradient: string) =>
      parseStops(gradient)
        .map((stop) => stop.alpha)
        .filter((alpha) => alpha > 0 && alpha < 1);

    const right = rampAlphas(String(createRightFadeMaskStyle(EDGE_FADE_WIDTH, 0).maskImage));
    const top = rampAlphas(String(createTopFadeMaskStyle(EDGE_FADE_WIDTH).maskImage));

    expect(top).toEqual([...right].reverse());
    expect(right).toEqual([0.82, 0.64, 0.49, 0.36, 0.25, 0.16, 0.09, 0.04, 0.01]);
  });

  it("scales the ramp with the requested width", () => {
    const narrow = parseStops(String(createTopFadeMaskStyle(12).maskImage));
    const wide = parseStops(String(createTopFadeMaskStyle(24).maskImage));

    const narrowRampEnd = narrow.at(-2)!;
    const wideRampEnd = wide.at(-2)!;
    expect(narrowRampEnd.position).toBe("12px");
    expect(wideRampEnd.position).toBe("24px");
  });
});

describe("topFadeMaskStyleFor", () => {
  it("returns no style while the surface is at rest", () => {
    expect(topFadeMaskStyleFor(true, 0)).toBeUndefined();
  });

  it("returns no style while the preference is off, however far it is scrolled", () => {
    expect(topFadeMaskStyleFor(false, 5000)).toBeUndefined();
  });

  it("ignores sub-pixel scroll offsets", () => {
    expect(topFadeMaskStyleFor(true, TOP_FADE_SCROLLED_THRESHOLD_PX - 0.5)).toBeUndefined();
  });

  it("returns the shared mask once the surface is scrolled", () => {
    expect(topFadeMaskStyleFor(true, TOP_FADE_SCROLLED_THRESHOLD_PX)).toBe(TOP_FADE_MASK_STYLE);
    expect(topFadeMaskStyleFor(true, 1200)).toBe(TOP_FADE_MASK_STYLE);
  });
});
