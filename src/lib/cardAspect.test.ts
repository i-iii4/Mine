import { describe, expect, it } from "vitest";
import {
  MAX_CARD_ASPECT,
  MIN_CARD_ASPECT,
  cardAspectCrops,
  clampCardAspect,
} from "./cardAspect";

describe("clampCardAspect", () => {
  it("leaves ordinary photographic shapes untouched", () => {
    // The two shapes that prompted this contract: a portrait clip and a
    // landscape screenshot, both of which used to arrive cropped.
    expect(clampCardAspect(1265 / 1600)).toBeCloseTo(1265 / 1600);
    expect(clampCardAspect(3000 / 2146)).toBeCloseTo(3000 / 2146);
    expect(clampCardAspect(1)).toBe(1);
  });

  it("holds the range boundaries exactly", () => {
    expect(clampCardAspect(MIN_CARD_ASPECT)).toBe(MIN_CARD_ASPECT);
    expect(clampCardAspect(MAX_CARD_ASPECT)).toBe(MAX_CARD_ASPECT);
  });

  it("clamps panoramas and scrolls to the range", () => {
    expect(clampCardAspect(20)).toBe(MAX_CARD_ASPECT);
    expect(clampCardAspect(0.05)).toBe(MIN_CARD_ASPECT);
  });

  it("treats a nonsensical ratio as square rather than propagating it", () => {
    expect(clampCardAspect(0)).toBe(1);
    expect(clampCardAspect(-3)).toBe(1);
    expect(clampCardAspect(Number.NaN)).toBe(1);
    expect(clampCardAspect(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("cardAspectCrops", () => {
  it("reports no crop inside the range", () => {
    expect(cardAspectCrops(1265 / 1600)).toBe(false);
    expect(cardAspectCrops(3000 / 2146)).toBe(false);
    expect(cardAspectCrops(MIN_CARD_ASPECT)).toBe(false);
    expect(cardAspectCrops(MAX_CARD_ASPECT)).toBe(false);
  });

  it("reports a crop only outside the range", () => {
    expect(cardAspectCrops(MAX_CARD_ASPECT + 0.01)).toBe(true);
    expect(cardAspectCrops(MIN_CARD_ASPECT - 0.01)).toBe(true);
  });
});
