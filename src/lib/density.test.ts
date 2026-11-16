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

  it("offers 32, 24, 16, 8 and 2, in this order (user's decision of 15.11.2026)", () => {
    expect(DENSITY_STEPS).toEqual([32, 24, 16, 8, 2]);
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

  it("keeps reading a 2px preference stored before 15.11.2026 as 16px, as it has since 24.09.2026", () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, "2");
    expect(getStoredDensity()).toBe(16);
    // The window's start writes what it read: the 16 the person sees stays.
    applyDensity(getStoredDensity());
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("16");
    expect(getStoredDensity()).toBe(16);
  });

  it.each([8, 2] as const)("persists and publishes %ipx, chosen now", (step) => {
    applyDensity(step);
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe(String(step));
    expect(getStoredDensity()).toBe(step);
    expect(document.documentElement.style.getPropertyValue("--edge-rhythm")).toBe(`${step}px`);
  });
});
