import { describe, expect, it } from "vitest";
import { cubicBezier, parseCubicBezier } from "./cubicBezier";
import { MOTION_EASE } from "./motion";

describe("a CSS timing curve in code", () => {
  it("reads the control values of a cubic-bezier string, the motion curve's among them", () => {
    expect(parseCubicBezier(MOTION_EASE)).toEqual([0.22, 1, 0.36, 1]);
    expect(parseCubicBezier("cubic-bezier(0.37, 0, 0.63, 1)")).toEqual([0.37, 0, 0.63, 1]);
    expect(parseCubicBezier("ease")).toBeNull();
    expect(parseCubicBezier("cubic-bezier(1.2, 0, 0.5, 1)")).toBeNull();
    expect(parseCubicBezier("cubic-bezier(0.2, x, 0.5, 1)")).toBeNull();
  });

  it("evaluates as CSS does: ends fixed, linear on the diagonal, `ease` at half its time", () => {
    const linear = cubicBezier([0.25, 0.25, 0.75, 0.75]);
    for (const t of [0, 0.1, 0.5, 0.9, 1]) expect(linear(t)).toBeCloseTo(t, 6);
    // `ease`, cubic-bezier(0.25, 0.1, 0.25, 1), is 0.8024 of the way at half its time.
    expect(cubicBezier([0.25, 0.1, 0.25, 1])(0.5)).toBeCloseTo(0.8024, 3);
    const ease = cubicBezier([0.22, 1, 0.36, 1]);
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
    let previous = 0;
    for (let t = 0; t <= 1; t += 0.01) {
      const value = ease(t);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});
