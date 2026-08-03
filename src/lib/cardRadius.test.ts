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

  it("offers square and one rounded step", () => {
    expect(CARD_RADIUS_OPTIONS).toEqual([0, 3]);
  });

  it("drives the card frame only, leaving feed-card media square", () => {
    applyCardRadius(3);
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--radius-card")).toBe("3px");
    // Feed thumbnails stay edge to edge whatever the card corner is.
    expect(root.style.getPropertyValue("--radius-media")).toBe("");
  });

  it("persists the choice", () => {
    applyCardRadius(3);
    expect(localStorage.getItem(CARD_RADIUS_STORAGE_KEY)).toBe("3");
    expect(getStoredCardRadius()).toBe(3);
  });

  it("hands the default back to the stylesheet instead of pinning 0px", () => {
    applyCardRadius(3);
    applyCardRadius(0);
    // Cleared, not set to "0px": the token default stays a single source.
    expect(document.documentElement.style.getPropertyValue("--radius-card")).toBe("");
  });

  it("falls back to the default on an unknown stored value", () => {
    localStorage.setItem(CARD_RADIUS_STORAGE_KEY, "7");
    expect(getStoredCardRadius()).toBe(0);
    localStorage.setItem(CARD_RADIUS_STORAGE_KEY, "nonsense");
    expect(getStoredCardRadius()).toBe(0);
  });
});
