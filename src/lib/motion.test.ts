import { afterEach, describe, expect, it, vi } from "vitest";
import { motionDuration, prefersReducedMotion, scrollBehavior } from "./motion";

function reduceMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

describe("one motion setting (Ф12)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("follows the system's Reduce motion", () => {
    reduceMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(motionDuration(400)).toBe(0);
    expect(scrollBehavior()).toBe("auto");
  });

  it("moves when motion is not reduced", () => {
    reduceMotion(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(motionDuration(400)).toBe(400);
    expect(scrollBehavior()).toBe("smooth");
  });
});
