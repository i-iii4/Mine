import { describe, expect, it } from "vitest";
import {
  EDGE_FADE_WIDTH,
  TOP_FADE_CANVAS,
  TOP_FADE_LIST,
  TOP_FADE_SCROLLED_THRESHOLD_PX,
  createRightFadeMaskStyle,
  createTopFadeMaskStyle,
  topFadeAlpha,
  topFadeStopCount,
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

    expect(withoutTail).toContain("calc(100% - 24px)");
    expect(withTail).toContain("calc(100% - 36px)");
    expect(withTail).toContain("rgba(0, 0, 0, 0) calc(100% - 12px)");
  });
});

describe("topFadeAlpha", () => {
  it("starts at the floor and reaches full opacity", () => {
    expect(topFadeAlpha(0, 0.65)).toBe(0.65);
    expect(topFadeAlpha(1, 0.65)).toBe(1);
  });

  it("flattens at both ends so neither end produces a Mach band", () => {
    // Step wider than the 3-decimal rounding of the alpha values, otherwise the
    // difference quotient collapses to zero everywhere.
    const h = 0.01;
    const slope = (t: number, floor: number) =>
      (topFadeAlpha(t + h, floor) - topFadeAlpha(t, floor)) / h;

    // Near-flat where the ramp meets the edge and where it meets opaque
    // content; steepest in the middle, which is where the transition lives.
    expect(Math.abs(slope(0, 0.65))).toBeLessThan(0.05);
    expect(Math.abs(slope(1 - h, 0.65))).toBeLessThan(0.05);
    expect(slope(0.5, 0.65)).toBeGreaterThan(slope(0.1, 0.65));
  });

  it("rises monotonically", () => {
    let previous = -1;
    for (let i = 0; i <= 40; i += 1) {
      const value = topFadeAlpha(i / 40, 0.65);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("never returns less than the floor", () => {
    for (let i = 0; i <= 40; i += 1) {
      expect(topFadeAlpha(i / 40, 0.7)).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("stays a hint rather than a dissolve: content keeps most of its opacity", () => {
    // Every pixel the ramp touches is content degraded, so the curve lives in a
    // narrow band near full opacity instead of sweeping the whole alpha range.
    expect(topFadeAlpha(0, 0.65)).toBe(0.65);
    expect(topFadeAlpha(0.5, 0.65)).toBeGreaterThan(0.8);
    expect(topFadeAlpha(0.75, 0.65)).toBeGreaterThan(0.94);
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

describe("createTopFadeMaskStyle", () => {
  it("keeps a faint remainder at the edge and is fully opaque below the ramp", () => {
    const gradient = String(createTopFadeMaskStyle(TOP_FADE_CANVAS).maskImage);
    const stops = parseStops(gradient);

    expect(gradient.startsWith("linear-gradient(to bottom,")).toBe(true);
    expect(stops[0]).toEqual({ alpha: TOP_FADE_CANVAS.minAlpha, position: "0px" });
    expect(stops.at(-2)).toEqual({ alpha: 1, position: `${TOP_FADE_CANVAS.width}px` });
    expect(stops.at(-1)).toEqual({ alpha: 1, position: "100%" });
  });

  it("never emits a fully transparent stop", () => {
    for (const profile of [TOP_FADE_CANVAS, TOP_FADE_LIST]) {
      const stops = parseStops(String(createTopFadeMaskStyle(profile).maskImage));
      for (const stop of stops) {
        expect(stop.alpha).toBeGreaterThanOrEqual(profile.minAlpha);
      }
    }
  });

  it("advances position and alpha monotonically", () => {
    const stops = parseStops(String(createTopFadeMaskStyle(TOP_FADE_CANVAS).maskImage));
    const ramp = stops.slice(0, -1); // drop the trailing 100% anchor

    for (let i = 1; i < ramp.length; i += 1) {
      expect(Number.parseFloat(ramp[i]!.position)).toBeGreaterThan(
        Number.parseFloat(ramp[i - 1]!.position),
      );
      expect(ramp[i]!.alpha).toBeGreaterThanOrEqual(ramp[i - 1]!.alpha);
    }
  });

  it("emits one stop per ramp step plus the closing anchor", () => {
    const stops = parseStops(String(createTopFadeMaskStyle(TOP_FADE_CANVAS).maskImage));
    expect(stops.length).toBe(topFadeStopCount(TOP_FADE_CANVAS.width) + 2);
  });

  it("sets the same value on both the standard and WebKit mask property", () => {
    const style = createTopFadeMaskStyle(TOP_FADE_LIST);
    expect(style.maskImage).toBe(style.WebkitMaskImage);
  });
});

describe("top fade profiles", () => {
  it("gives large-format content a longer ramp than dense lists", () => {
    // A canvas-width ramp would swallow a whole 32px sidebar row.
    expect(TOP_FADE_CANVAS.width).toBeGreaterThan(TOP_FADE_LIST.width);
    expect(TOP_FADE_LIST.width).toBeLessThan(32);
  });

  it("keeps every ramp short enough not to eat usable content", () => {
    // The ramp degrades real content, so it stays well inside one sidebar row.
    for (const profile of [TOP_FADE_CANVAS, TOP_FADE_LIST]) {
      expect(profile.width).toBeLessThanOrEqual(20);
    }
  });

  it("never takes more than about a third of the content's opacity", () => {
    for (const profile of [TOP_FADE_CANVAS, TOP_FADE_LIST]) {
      expect(profile.minAlpha).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("goes lighter on list text than on photographs", () => {
    expect(TOP_FADE_LIST.minAlpha).toBeGreaterThan(TOP_FADE_CANVAS.minAlpha);
  });
});

describe("topFadeMaskStyleFor", () => {
  it("returns no style while the surface is at rest", () => {
    expect(topFadeMaskStyleFor(true, 0, "canvas")).toBeUndefined();
  });

  it("returns no style while the preference is off, however far it is scrolled", () => {
    expect(topFadeMaskStyleFor(false, 5000, "canvas")).toBeUndefined();
  });

  it("ignores sub-pixel scroll offsets", () => {
    expect(
      topFadeMaskStyleFor(true, TOP_FADE_SCROLLED_THRESHOLD_PX - 0.5, "list"),
    ).toBeUndefined();
  });

  it("returns a stable style object per variant once scrolled", () => {
    const canvas = topFadeMaskStyleFor(true, 400, "canvas");
    const list = topFadeMaskStyleFor(true, 400, "list");

    expect(canvas).toBeDefined();
    expect(list).toBeDefined();
    expect(canvas).not.toBe(list);
    // Same object across calls: surfaces can compare by identity.
    expect(topFadeMaskStyleFor(true, 900, "canvas")).toBe(canvas);
  });
});
