import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { deriveLightLadder } from "./lightLadder";
import {
  LIGHT_CANVAS_STORAGE_KEY,
  applyLightCanvas,
  getLightCanvas,
  reloadLightCanvas,
  setLightCanvas,
  useLightCanvas,
} from "./lightCanvas";

/// TRIAL (PLAN 47.7): the light theme's canvas, White (L 1) or Soft (L 0.975).
describe("lightCanvas", () => {
  const root = document.documentElement;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    localStorage.removeItem(LIGHT_CANVAS_STORAGE_KEY);
    root.removeAttribute("data-theme");
    reloadLightCanvas();
  });

  it("is White by default and writes nothing on the root", () => {
    expect(getLightCanvas()).toBe("white");
    expect(root.hasAttribute("data-light-canvas-soft")).toBe(false);
    expect(root.style.getPropertyValue("--background")).toBe("");
  });

  it("puts the soft ladder, derived from 0.975, on the root of a light page and takes it away", () => {
    root.setAttribute("data-theme", "light");
    act(() => setLightCanvas("soft"));
    expect(root.hasAttribute("data-light-canvas-soft")).toBe(true);
    for (const [name, value] of Object.entries(deriveLightLadder(0.975))) {
      expect(root.style.getPropertyValue(name), name).toBe(value);
    }
    expect(root.style.getPropertyValue("--background")).toBe("oklch(0.975 0 0)");

    act(() => setLightCanvas("white"));
    expect(root.hasAttribute("data-light-canvas-soft")).toBe(false);
    expect(root.style.getPropertyValue("--background")).toBe("");
  });

  it("leaves the dark theme alone, and follows the theme as it turns", async () => {
    root.setAttribute("data-theme", "dark");
    act(() => setLightCanvas("soft"));
    expect(root.hasAttribute("data-light-canvas-soft")).toBe(false);
    expect(root.style.getPropertyValue("--card")).toBe("");

    root.setAttribute("data-theme", "light");
    await act(settle);
    expect(root.hasAttribute("data-light-canvas-soft")).toBe(true);
    root.setAttribute("data-theme", "dark");
    await act(settle);
    expect(root.style.getPropertyValue("--card")).toBe("");
  });

  it("keeps the choice between launches and follows another tab's", () => {
    act(() => setLightCanvas("soft"));
    expect(localStorage.getItem(LIGHT_CANVAS_STORAGE_KEY)).toBe("soft");
    const { result } = renderHook(() => useLightCanvas());
    localStorage.setItem(LIGHT_CANVAS_STORAGE_KEY, "white");
    act(() => reloadLightCanvas());
    expect(result.current).toBe("white");
    // Anything else stored reads as White.
    localStorage.setItem(LIGHT_CANVAS_STORAGE_KEY, "beige");
    act(() => reloadLightCanvas());
    expect(result.current).toBe("white");
  });

  it("applies to any root", () => {
    const other = document.createElement("div");
    other.setAttribute("data-theme", "light");
    applyLightCanvas("soft", other);
    expect(other.style.getPropertyValue("--sidebar")).toBe(deriveLightLadder(0.975)["--sidebar"]);
  });
});
