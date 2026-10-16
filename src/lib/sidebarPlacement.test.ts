import { describe, expect, it } from "vitest";
import {
  clampSidebarTarget,
  sidebarDragBounds,
  sidebarPlacement,
  sidebarWidthCss,
} from "./sidebarPlacement";

// S_min 314, F_min 304, S_max 600 (SPEC_NARROW_WINDOW.md, «План реализации»).
describe("sidebarPlacement: the three placements by window width (SPEC_NARROW_WINDOW.md, У1)", () => {
  it.each([
    // Wide: the sidebar at its target, the feed takes the rest.
    { windowWidth: 1200, target: 360, expected: { kind: "beside", sidebarWidth: 360, feedWidth: 840, squeezed: false } },
    // The feed reaches its narrowest exactly at S_target + F_min.
    { windowWidth: 664, target: 360, expected: { kind: "beside", sidebarWidth: 360, feedWidth: 304, squeezed: false } },
    // One pixel narrower: the sidebar gives way, the feed holds F_min.
    { windowWidth: 663, target: 360, expected: { kind: "beside", sidebarWidth: 359, feedWidth: 304, squeezed: true } },
    { windowWidth: 640, target: 360, expected: { kind: "beside", sidebarWidth: 336, feedWidth: 304, squeezed: true } },
    // The sidebar reaches S_min exactly at S_min + F_min.
    { windowWidth: 618, target: 360, expected: { kind: "beside", sidebarWidth: 314, feedWidth: 304, squeezed: true } },
    // One pixel narrower: the sidebar leaves the row.
    { windowWidth: 617, target: 360, expected: { kind: "overlay", feedWidth: 617 } },
    { windowWidth: 354, target: 360, expected: { kind: "overlay", feedWidth: 354 } },
    // A sidebar dragged to its minimum is never squeezed.
    { windowWidth: 618, target: 314, expected: { kind: "beside", sidebarWidth: 314, feedWidth: 304, squeezed: false } },
    // The widest sidebar squeezes from 904 down.
    { windowWidth: 904, target: 600, expected: { kind: "beside", sidebarWidth: 600, feedWidth: 304, squeezed: false } },
    { windowWidth: 903, target: 600, expected: { kind: "beside", sidebarWidth: 599, feedWidth: 304, squeezed: true } },
  ])("W $windowWidth, S_target $target", ({ windowWidth, target, expected }) => {
    expect(sidebarPlacement({ windowWidth, target })).toEqual(expected);
  });

  it("returns to exactly the target as the window widens", () => {
    const target = 480;
    const widths = [1000, 700, 640, 618, 640, 700, 784, 1000];
    const shown = widths.map((windowWidth) => {
      const placement = sidebarPlacement({ windowWidth, target });
      return placement.kind === "beside" ? placement.sidebarWidth : null;
    });
    expect(shown).toEqual([480, 396, 336, 314, 336, 396, 480, 480]);
  });

  it("holds a target outside the bounds to them", () => {
    expect(clampSidebarTarget(100)).toBe(314);
    expect(clampSidebarTarget(5000)).toBe(600);
    expect(sidebarPlacement({ windowWidth: 2000, target: 5000 })).toMatchObject({ sidebarWidth: 600 });
  });
});

describe("sidebarDragBounds: what a drag of the edge may reach (У2)", () => {
  it.each([
    { windowWidth: 1200, expected: { min: 314, max: 600 } },
    { windowWidth: 904, expected: { min: 314, max: 600 } },
    { windowWidth: 800, expected: { min: 314, max: 496 } },
    { windowWidth: 618, expected: { min: 314, max: 314 } },
    { windowWidth: 500, expected: { min: 314, max: 314 } },
  ])("W $windowWidth", ({ windowWidth, expected }) => {
    expect(sidebarDragBounds(windowWidth)).toEqual(expected);
  });
});

describe("sidebarWidthCss: the squeeze as one CSS value (47.2b)", () => {
  it("takes the target and the feed's minimum, clamped", () => {
    expect(sidebarWidthCss(360)).toBe("min(360px, 100vw - 304px)");
    expect(sidebarWidthCss(5000)).toBe("min(600px, 100vw - 304px)");
  });
});
