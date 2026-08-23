import { describe, expect, it } from "vitest";
import { marqueeAutoScrollVelocity } from "./interaction";

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
