import { describe, expect, it } from "vitest";
import { EDGE_FADE_WIDTH, createRightFadeMaskStyle } from "./edgeFade";

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

  it("takes a CSS length for the tail so a variable width can drive it", () => {
    // The sidebar's action column is as wide as the row's own inset plus the
    // button, and that inset is set per design variant. Baking pixels here
    // cleared the wrong strip in every variant whose inset is not zero.
    const style = createRightFadeMaskStyle(24, "calc(var(--sidebar-row-pad-x) + 92px)");
    const gradient = String(style.maskImage);

    expect(gradient).toContain("calc(100% - calc(var(--sidebar-row-pad-x) + 92px))");
    expect(gradient).toContain("calc(100% - calc(calc(var(--sidebar-row-pad-x) + 92px) + 24px))");
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
