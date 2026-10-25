import { describe, expect, it } from "vitest";
import { sidebarBesideMinWidthPx } from "./appLayout";
import {
  clampSidebarTarget,
  sidebarDragBounds,
  sidebarOverlaid,
  sidebarOverlayWidth,
  sidebarOverlayWidthCss,
  sidebarPlacement,
  sidebarWidthCss,
} from "./sidebarPlacement";

// S_beside 280 (user's decision of 25.10.2026; 240 since 23.10.2026), S_min 350
// (the narrowest window less the strip), F_min 390 (the window's narrowest),
// both 16.10.2026; no S_max beside the feed since 23.10.2026, 600 over it
// (SPEC_NARROW_WINDOW.md, «Величины»).
describe("sidebarPlacement: the three placements by window width (SPEC_NARROW_WINDOW.md, У1)", () => {
  it.each([
    // Wide: the sidebar at its target, the feed takes the rest.
    { windowWidth: 1200, target: 360, expected: { kind: "beside", sidebarWidth: 360, feedWidth: 840, squeezed: false } },
    // The feed reaches its narrowest exactly at S_target + F_min.
    { windowWidth: 750, target: 360, expected: { kind: "beside", sidebarWidth: 360, feedWidth: 390, squeezed: false } },
    // One pixel narrower: the sidebar gives way, the feed holds F_min.
    { windowWidth: 749, target: 360, expected: { kind: "beside", sidebarWidth: 359, feedWidth: 390, squeezed: true } },
    { windowWidth: 745, target: 360, expected: { kind: "beside", sidebarWidth: 355, feedWidth: 390, squeezed: true } },
    // Past S_min it keeps squeezing beside the feed (user's decision of
    // 22.10.2026): 350 at 740, as it was, and on through the compact items.
    { windowWidth: 740, target: 360, expected: { kind: "beside", sidebarWidth: 350, feedWidth: 390, squeezed: true } },
    { windowWidth: 739, target: 360, expected: { kind: "beside", sidebarWidth: 349, feedWidth: 390, squeezed: true } },
    // The sidebar reaches S_beside exactly at S_beside + F_min = 670.
    { windowWidth: 670, target: 360, expected: { kind: "beside", sidebarWidth: 280, feedWidth: 390, squeezed: true } },
    // One pixel narrower: the sidebar leaves the row.
    { windowWidth: 669, target: 360, expected: { kind: "overlay", feedWidth: 669 } },
    { windowWidth: 390, target: 360, expected: { kind: "overlay", feedWidth: 390 } },
    // A sidebar dragged to its minimum is never squeezed.
    { windowWidth: 670, target: 280, expected: { kind: "beside", sidebarWidth: 280, feedWidth: 390, squeezed: false } },
    { windowWidth: 740, target: 280, expected: { kind: "beside", sidebarWidth: 280, feedWidth: 460, squeezed: false } },
    { windowWidth: 669, target: 280, expected: { kind: "overlay", feedWidth: 669 } },
    // A 600 wide sidebar squeezes from 990 down.
    { windowWidth: 990, target: 600, expected: { kind: "beside", sidebarWidth: 600, feedWidth: 390, squeezed: false } },
    { windowWidth: 989, target: 600, expected: { kind: "beside", sidebarWidth: 599, feedWidth: 390, squeezed: true } },
    // Beside the feed the sidebar has no cap of its own (23.10.2026).
    { windowWidth: 1600, target: 1000, expected: { kind: "beside", sidebarWidth: 1000, feedWidth: 600, squeezed: false } },
  ])("W $windowWidth, S_target $target", ({ windowWidth, target, expected }) => {
    expect(sidebarPlacement({ windowWidth, target })).toEqual(expected);
  });

  it("returns to exactly the target as the window widens", () => {
    const target = 480;
    const widths = [1000, 800, 760, 740, 760, 800, 870, 1000];
    const shown = widths.map((windowWidth) => {
      const placement = sidebarPlacement({ windowWidth, target });
      return placement.kind === "beside" ? placement.sidebarWidth : null;
    });
    expect(shown).toEqual([480, 410, 370, 350, 370, 410, 480, 480]);
  });

  it("holds a target below S_beside to it, and keeps any wider one", () => {
    expect(clampSidebarTarget(100)).toBe(sidebarBesideMinWidthPx());
    expect(clampSidebarTarget(5000)).toBe(5000);
    // Only the narrowest feed holds it.
    expect(sidebarPlacement({ windowWidth: 2000, target: 5000 })).toEqual({
      kind: "beside",
      sidebarWidth: 1610,
      feedWidth: 390,
      squeezed: true,
    });
  });
});

// From S_beside, 280 (25.10.2026; PLAN 50.36 made it the lower bound in
// place of S_min), up to what the window leaves beside the narrowest feed.
describe("sidebarDragBounds: what a drag of the edge may reach (У2)", () => {
  it("starts at S_beside", () => {
    expect(sidebarBesideMinWidthPx()).toBe(280);
  });

  it.each([
    { windowWidth: 2560, expected: { min: 280, max: 2170 } },
    { windowWidth: 1200, expected: { min: 280, max: 810 } },
    { windowWidth: 990, expected: { min: 280, max: 600 } },
    { windowWidth: 800, expected: { min: 280, max: 410 } },
    { windowWidth: 740, expected: { min: 280, max: 350 } },
    { windowWidth: 670, expected: { min: 280, max: 280 } },
    { windowWidth: 500, expected: { min: 280, max: 280 } },
  ])("W $windowWidth", ({ windowWidth, expected }) => {
    expect(sidebarDragBounds(windowWidth)).toEqual(expected);
  });
});

describe("sidebarWidthCss: the squeeze as one CSS value (47.2b)", () => {
  it("takes the target and the feed's minimum, the target held to S_beside", () => {
    expect(sidebarWidthCss(360)).toBe("min(360px, 100vw - 390px)");
    expect(sidebarWidthCss(5000)).toBe("min(5000px, 100vw - 390px)");
    expect(sidebarWidthCss(100)).toBe("min(280px, 100vw - 390px)");
  });
});

describe("the sidebar over the feed (У1, У4)", () => {
  it("comes over the feed exactly below S_beside + F_min, whatever the target (22.10.2026, 25.10.2026)", () => {
    expect(sidebarOverlaid(670)).toBe(false);
    expect(sidebarOverlaid(669)).toBe(true);
    expect(sidebarOverlaid(739)).toBe(false);
    expect(sidebarOverlaid(390)).toBe(true);
    for (const target of [280, 350, 360, 600, 1000]) {
      expect(sidebarPlacement({ windowWidth: 669, target }).kind).toBe("overlay");
    }
  });

  it("is the window less the 40 px strip, never past S_max", () => {
    expect(sidebarOverlayWidth(561)).toBe(521);
    expect(sidebarOverlayWidth(617)).toBe(577);
    expect(sidebarOverlayWidth(400)).toBe(360);
    // The narrowest window, a phone wide (16.10.2026).
    expect(sidebarOverlayWidth(390)).toBe(350);
    expect(sidebarOverlayWidth(2000)).toBe(600);
    expect(sidebarOverlayWidthCss()).toBe("min(600px, 100vw - 40px)");
  });
});
