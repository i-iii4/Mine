import { describe, expect, it } from "vitest";
import {
  clampSidebarTarget,
  sidebarDragBounds,
  sidebarOverlaid,
  sidebarOverlayWidth,
  sidebarOverlayWidthCss,
  sidebarPlacement,
  sidebarWidthCss,
} from "./sidebarPlacement";

// S_min 314, F_min 390 (the window's narrowest, 16.10.2026), S_max 600
// (SPEC_NARROW_WINDOW.md, «Величины»).
describe("sidebarPlacement: the three placements by window width (SPEC_NARROW_WINDOW.md, У1)", () => {
  it.each([
    // Wide: the sidebar at its target, the feed takes the rest.
    { windowWidth: 1200, target: 360, expected: { kind: "beside", sidebarWidth: 360, feedWidth: 840, squeezed: false } },
    // The feed reaches its narrowest exactly at S_target + F_min.
    { windowWidth: 750, target: 360, expected: { kind: "beside", sidebarWidth: 360, feedWidth: 390, squeezed: false } },
    // One pixel narrower: the sidebar gives way, the feed holds F_min.
    { windowWidth: 749, target: 360, expected: { kind: "beside", sidebarWidth: 359, feedWidth: 390, squeezed: true } },
    { windowWidth: 720, target: 360, expected: { kind: "beside", sidebarWidth: 330, feedWidth: 390, squeezed: true } },
    // The sidebar reaches S_min exactly at S_min + F_min.
    { windowWidth: 704, target: 360, expected: { kind: "beside", sidebarWidth: 314, feedWidth: 390, squeezed: true } },
    // One pixel narrower: the sidebar leaves the row.
    { windowWidth: 703, target: 360, expected: { kind: "overlay", feedWidth: 703 } },
    { windowWidth: 390, target: 360, expected: { kind: "overlay", feedWidth: 390 } },
    // A sidebar dragged to its minimum is never squeezed.
    { windowWidth: 704, target: 314, expected: { kind: "beside", sidebarWidth: 314, feedWidth: 390, squeezed: false } },
    // The widest sidebar squeezes from 990 down.
    { windowWidth: 990, target: 600, expected: { kind: "beside", sidebarWidth: 600, feedWidth: 390, squeezed: false } },
    { windowWidth: 989, target: 600, expected: { kind: "beside", sidebarWidth: 599, feedWidth: 390, squeezed: true } },
  ])("W $windowWidth, S_target $target", ({ windowWidth, target, expected }) => {
    expect(sidebarPlacement({ windowWidth, target })).toEqual(expected);
  });

  it("returns to exactly the target as the window widens", () => {
    const target = 480;
    const widths = [1000, 800, 720, 704, 720, 800, 870, 1000];
    const shown = widths.map((windowWidth) => {
      const placement = sidebarPlacement({ windowWidth, target });
      return placement.kind === "beside" ? placement.sidebarWidth : null;
    });
    expect(shown).toEqual([480, 410, 330, 314, 330, 410, 480, 480]);
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
    { windowWidth: 990, expected: { min: 314, max: 600 } },
    { windowWidth: 800, expected: { min: 314, max: 410 } },
    { windowWidth: 704, expected: { min: 314, max: 314 } },
    { windowWidth: 500, expected: { min: 314, max: 314 } },
  ])("W $windowWidth", ({ windowWidth, expected }) => {
    expect(sidebarDragBounds(windowWidth)).toEqual(expected);
  });
});

describe("sidebarWidthCss: the squeeze as one CSS value (47.2b)", () => {
  it("takes the target and the feed's minimum, clamped", () => {
    expect(sidebarWidthCss(360)).toBe("min(360px, 100vw - 390px)");
    expect(sidebarWidthCss(5000)).toBe("min(600px, 100vw - 390px)");
  });
});

describe("the sidebar over the feed (У1, У4)", () => {
  it("comes over the feed exactly below S_min + F_min, whatever the target", () => {
    expect(sidebarOverlaid(704)).toBe(false);
    expect(sidebarOverlaid(703)).toBe(true);
    expect(sidebarOverlaid(390)).toBe(true);
    for (const target of [314, 360, 600]) {
      expect(sidebarPlacement({ windowWidth: 703, target }).kind).toBe("overlay");
    }
  });

  it("is the window less the 40 px strip, never past S_max", () => {
    expect(sidebarOverlayWidth(703)).toBe(600);
    expect(sidebarOverlayWidth(617)).toBe(577);
    expect(sidebarOverlayWidth(400)).toBe(360);
    // The narrowest window, a phone wide (16.10.2026).
    expect(sidebarOverlayWidth(390)).toBe(350);
    expect(sidebarOverlayWidth(2000)).toBe(600);
    expect(sidebarOverlayWidthCss()).toBe("min(600px, 100vw - 40px)");
  });
});
