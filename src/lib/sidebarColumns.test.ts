import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SIDEBAR_COLUMN_MIN_PX,
  sidebarMinWidth,
  sidebarNameFloor,
  sidebarReserved,
  sidebarZoneWidth,
} from "./appLayout";

/// The sidebar row reads as three zones: name, previews, meta. A zone is the
/// distance between two guidelines — or between a guideline and the panel edge
/// — which is what the eye compares. Measuring column boxes instead left the
/// middle zone visibly narrower even when the boxes agreed, because the row's
/// padding and the gaps around the previews belong to the neighbouring zones.
/// jsdom lays out no CSS, so the contract is pinned on the numbers themselves.
describe("sidebar zone contract", () => {
  const css = readFileSync("src/styles/global.css", "utf8");
  const designs = ["default", "alt"] as const;

  it("makes the three zones equal at the frozen minimum", () => {
    for (const design of designs) {
      const zone = sidebarZoneWidth(design);
      const navPad = design === "default" ? 32 : 0;
      // Three zones plus the two guidelines between them, inside the nav's
      // own insets.
      expect(sidebarMinWidth(design), design).toBe(zone * 3 + 2 + navPad * 2);
    }
  });

  it("never lets a zone fall below what it holds", () => {
    for (const design of designs) {
      const rowPad = design === "default" ? 0 : 16;
      // The previews' keystone — 2.5 icons — and the action button's field.
      expect(sidebarZoneWidth(design)).toBeGreaterThanOrEqual(rowPad + SIDEBAR_COLUMN_MIN_PX);
      expect(sidebarNameFloor(design)).toBeGreaterThanOrEqual(SIDEBAR_COLUMN_MIN_PX);
    }
  });

  it("reserves the meta zone, the guidelines and the row inset", () => {
    for (const design of designs) {
      const rowPad = design === "default" ? 0 : 16;
      expect(sidebarReserved(design)).toBe(sidebarZoneWidth(design) + 2 + rowPad);
    }
  });

  it("keeps CSS and JS on the same numbers", () => {
    // Two sides of one contract: JS clamps the drag and lifts stored widths to
    // sidebarMinWidth(), CSS freezes the nav at --sidebar-min-width. One side
    // moving alone leaves the nav wider than the panel, and the curtain
    // permanently clips the meta column — which is how the count digits got
    // cut off once.
    for (const design of designs) {
      expect(css).toContain(`--sidebar-min-width: ${sidebarMinWidth(design)}px;`);
      expect(css).toContain(`--sidebar-zone: ${sidebarZoneWidth(design)}px;`);
    }
    expect(css).toContain(
      "--sidebar-reserved: calc(var(--sidebar-zone) + 2px + var(--sidebar-row-pad-x));",
    );
    expect(css).toContain(
      "--sidebar-name-floor: calc(var(--sidebar-zone) - var(--sidebar-row-pad-x));",
    );
  });

  it("splits every extra pixel of width evenly between name and previews", () => {
    expect(css).toContain("(var(--sidebar-width) - var(--sidebar-min-width)) / 2");
  });
});
