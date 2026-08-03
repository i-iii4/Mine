import { beforeEach, describe, expect, it } from "vitest";
import {
  CARD_RADIUS_OPTIONS,
  CARD_RADIUS_STORAGE_KEY,
  applyCardRadius,
  getStoredCardRadius,
} from "./cardRadius";

describe("card radius", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("defaults to square cards", () => {
    expect(getStoredCardRadius()).toBe(0);
  });

  it("offers the full set of steps", () => {
    expect(CARD_RADIUS_OPTIONS).toEqual([0, 2, 4, 8, 16]);
  });

  it("drives both the card and its media from one setting", () => {
    applyCardRadius(8);
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--radius-card")).toBe("8px");
    expect(root.style.getPropertyValue("--radius-media")).toBe("8px");
  });

  it("persists the choice", () => {
    applyCardRadius(16);
    expect(localStorage.getItem(CARD_RADIUS_STORAGE_KEY)).toBe("16");
    expect(getStoredCardRadius()).toBe(16);
  });

  it("hands the default back to the stylesheet instead of pinning 0px", () => {
    applyCardRadius(4);
    applyCardRadius(0);
    const root = document.documentElement;
    // Cleared, not set to "0px": the token default stays a single source.
    expect(root.style.getPropertyValue("--radius-card")).toBe("");
    expect(root.style.getPropertyValue("--radius-media")).toBe("");
  });

  it("falls back to the default on an unknown stored value", () => {
    localStorage.setItem(CARD_RADIUS_STORAGE_KEY, "7");
    expect(getStoredCardRadius()).toBe(0);
    localStorage.setItem(CARD_RADIUS_STORAGE_KEY, "nonsense");
    expect(getStoredCardRadius()).toBe(0);
  });
});
