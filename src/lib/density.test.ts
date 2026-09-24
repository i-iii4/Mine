import { beforeEach, describe, expect, it } from "vitest";
import {
  DENSITY_STEPS,
  DENSITY_STORAGE_KEY,
  applyDensity,
  getStoredDensity,
} from "./density";

describe("density", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("offers only the three retained spacing steps", () => {
    expect(DENSITY_STEPS).toEqual([32, 24, 16]);
  });

  it("defaults to the widest step", () => {
    expect(getStoredDensity()).toBe(32);
  });

  it("publishes one variable for every spacing to read", () => {
    // Feed edges and the gap between cards follow this; chrome is pinned to
    // its own 16px pad and stays put.
    applyDensity(24);
    expect(document.documentElement.style.getPropertyValue("--edge-rhythm")).toBe("24px");
  });

  it("persists the choice", () => {
    applyDensity(16);
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("16");
    expect(getStoredDensity()).toBe(16);
  });

  it("falls back to the default on an unknown stored value", () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, "20");
    expect(getStoredDensity()).toBe(32);
    localStorage.setItem(DENSITY_STORAGE_KEY, "nonsense");
    expect(getStoredDensity()).toBe(32);
  });

  it("maps a retired 2px preference to 16px", () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, "2");
    expect(getStoredDensity()).toBe(16);
  });
});
