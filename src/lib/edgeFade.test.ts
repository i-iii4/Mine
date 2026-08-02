import { describe, expect, it } from "vitest";
import {
  EDGE_FADE_WIDTH,
  TOP_FADE_CANVAS,
  TOP_FADE_LIST,
  TOP_FADE_SCROLLED_THRESHOLD_PX,
  createRightFadeMaskStyle,
  isTopFadeActive,
  topFadeAlpha,
  topFadeStopCount,
} from "./edgeFade";
import { createTopFadeScrimStyle } from "@/components/TopFadeScrim";

const ALL_PROFILES = [TOP_FADE_CANVAS, TOP_FADE_LIST];

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

    expect(withoutTail).toContain("calc(100% - 24px)");
    expect(withTail).toContain("calc(100% - 36px)");
    expect(withTail).toContain("rgba(0, 0, 0, 0) calc(100% - 12px)");
  });
});

describe("topFadeAlpha", () => {
  it("starts at the floor and reaches full opacity", () => {
    expect(topFadeAlpha(0, 0.08)).toBe(0.08);
    expect(topFadeAlpha(1, 0.08)).toBe(1);
  });

  it("flattens at both ends so neither end produces a Mach band", () => {
    // Step wider than the 3-decimal rounding of the alpha values, otherwise the
    // difference quotient collapses to zero everywhere.
    const h = 0.01;
    const slope = (t: number, floor: number) =>
      (topFadeAlpha(t + h, floor) - topFadeAlpha(t, floor)) / h;

    // Near-flat where the ramp meets the edge and where it meets opaque
    // content; steepest in the middle, which is where the transition lives.
    expect(Math.abs(slope(0, 0.08))).toBeLessThan(0.05);
    expect(Math.abs(slope(1 - h, 0.08))).toBeLessThan(0.05);
    expect(slope(0.5, 0.08)).toBeGreaterThan(slope(0.1, 0.08));
  });

  it("rises monotonically", () => {
    let previous = -1;
    for (let i = 0; i <= 40; i += 1) {
      const value = topFadeAlpha(i / 40, 0.08);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("never returns less than the floor", () => {
    for (let i = 0; i <= 40; i += 1) {
      expect(topFadeAlpha(i / 40, 0.08)).toBeGreaterThanOrEqual(0.08);
    }
  });

  it("sweeps most of the range so the chrome genuinely covers the top", () => {
    expect(topFadeAlpha(0, 0.08)).toBe(0.08);
    expect(topFadeAlpha(0.5, 0.08)).toBeGreaterThan(0.4);
    expect(topFadeAlpha(0.5, 0.08)).toBeLessThan(0.65);
  });
});

describe("topFadeStopCount", () => {
  it("scales stop density with ramp length", () => {
    expect(topFadeStopCount(56)).toBeGreaterThan(topFadeStopCount(28));
  });

  it("keeps a floor of stops on short ramps and a ceiling on long ones", () => {
    expect(topFadeStopCount(4)).toBe(12);
    expect(topFadeStopCount(400)).toBe(24);
  });

  it("keeps every ramp segment under the width where faceting shows", () => {
    for (const width of [12, 28, 56, 96]) {
      const segment = width / topFadeStopCount(width);
      expect(segment).toBeLessThanOrEqual(4);
    }
  });
});

describe("createTopFadeScrimStyle", () => {
  it("starts as the chrome colour and fades to nothing over the band", () => {
    const gradient = String(createTopFadeScrimStyle(TOP_FADE_CANVAS).backgroundImage);

    expect(gradient.startsWith("linear-gradient(to bottom,")).toBe(true);
    // Strongest against the edge — the chrome effectively continues there.
    expect(gradient).toContain("var(--chrome) 92%");
    // Gone by the bottom of the band.
    expect(gradient).toContain(
      `color-mix(in oklab, var(--chrome) 0%, transparent) ${TOP_FADE_CANVAS.height}px`,
    );
  });

  it("mixes toward transparent instead of interpolating to it", () => {
    // Interpolating a colour to `transparent` passes through transparent black
    // and greys the midpoint of the gradient.
    const gradient = String(createTopFadeScrimStyle(TOP_FADE_LIST).backgroundImage);
    expect(gradient).toContain("color-mix(in oklab, var(--chrome)");
    // Every stop is an explicit mix ratio, never a bare colour handed to the
    // browser to interpolate toward `transparent`.
    expect(gradient).toContain("%, transparent)");
    expect(gradient).not.toMatch(/var\(--chrome\)\s*,/);
  });

  it("emits one stop per band step plus the closing anchor", () => {
    const gradient = String(createTopFadeScrimStyle(TOP_FADE_CANVAS).backgroundImage);
    const stops = gradient.split("color-mix").length - 1;
    expect(stops).toBe(topFadeStopCount(TOP_FADE_CANVAS.height) + 1);
  });

  it("weakens monotonically from the edge downward", () => {
    const gradient = String(createTopFadeScrimStyle(TOP_FADE_CANVAS).backgroundImage);
    const percentages = [...gradient.matchAll(/var\(--chrome\) ([\d.]+)%/g)].map((m) =>
      Number(m[1]),
    );
    for (let i = 1; i < percentages.length; i += 1) {
      expect(percentages[i]!).toBeLessThanOrEqual(percentages[i - 1]!);
    }
    expect(percentages.at(-1)).toBe(0);
  });
});

describe("top fade profiles", () => {
  it("keeps the list band inside a single 32px row", () => {
    expect(TOP_FADE_LIST.height).toBeLessThanOrEqual(32);
    expect(TOP_FADE_LIST.height).toBeLessThanOrEqual(TOP_FADE_CANVAS.height);
  });

  it("makes the canvas band tall enough to read as a panel, not a line", () => {
    expect(TOP_FADE_CANVAS.height).toBeGreaterThanOrEqual(40);
  });

  it("starts nearly opaque so content genuinely passes under the chrome", () => {
    for (const profile of ALL_PROFILES) {
      expect(profile.minAlpha).toBeLessThanOrEqual(0.1);
    }
  });
});

describe("isTopFadeActive", () => {
  it("stays off while the surface is at rest", () => {
    expect(isTopFadeActive(true, 0)).toBe(false);
  });

  it("stays off while the preference is off, however far it is scrolled", () => {
    expect(isTopFadeActive(false, 5000)).toBe(false);
  });

  it("ignores sub-pixel scroll offsets", () => {
    expect(isTopFadeActive(true, TOP_FADE_SCROLLED_THRESHOLD_PX - 0.5)).toBe(false);
  });

  it("turns on once content has travelled under the chrome", () => {
    expect(isTopFadeActive(true, TOP_FADE_SCROLLED_THRESHOLD_PX)).toBe(true);
  });
});
