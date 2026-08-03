import { beforeEach, describe, expect, it } from "vitest";
import {
  CARD_GAP_STORAGE_KEY,
  DENSITY_STEPS,
  EDGE_DENSITY_STORAGE_KEY,
  applyCardGap,
  applyEdgeDensity,
  getStoredCardGap,
  getStoredEdgeDensity,
} from "./density";

describe("density", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("offers the same three steps to both axes", () => {
    expect(DENSITY_STEPS).toEqual([32, 24, 16]);
  });

  it("defaults both axes to the widest step", () => {
    expect(getStoredEdgeDensity()).toBe(32);
    expect(getStoredCardGap()).toBe(32);
  });

  it("keeps the axes independent", () => {
    // Wanting cards tighter is not the same as wanting the whole interface
    // tighter; the previous single value forced both at once.
    applyCardGap(16);

    const root = document.documentElement;
    expect(root.style.getPropertyValue("--card-gap")).toBe("16px");
    expect(root.style.getPropertyValue("--edge-rhythm")).toBe("");
    expect(getStoredEdgeDensity()).toBe(32);
  });

  it("publishes the edge rhythm for stylesheets to read", () => {
    applyEdgeDensity(24);
    expect(document.documentElement.style.getPropertyValue("--edge-rhythm")).toBe("24px");
    expect(localStorage.getItem(EDGE_DENSITY_STORAGE_KEY)).toBe("24");
  });

  it("persists the card gap", () => {
    applyCardGap(24);
    expect(localStorage.getItem(CARD_GAP_STORAGE_KEY)).toBe("24");
    expect(getStoredCardGap()).toBe(24);
  });

  it("falls back to the default on an unknown stored value", () => {
    localStorage.setItem(EDGE_DENSITY_STORAGE_KEY, "20");
    localStorage.setItem(CARD_GAP_STORAGE_KEY, "nonsense");
    expect(getStoredEdgeDensity()).toBe(32);
    expect(getStoredCardGap()).toBe(32);
  });
});
