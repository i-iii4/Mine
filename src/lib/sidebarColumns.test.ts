import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SIDEBAR_COLUMN_MIN_PX,
  SIDEBAR_ROW_ACTION_BUTTON_PX,
  SIDEBAR_ROW_ACTION_GAP_PX,
  sidebarBesideMinWidthPx,
  SIDEBAR_NAME_MAX_PX,
  sidebarCompactRowsBelowPx,
  sidebarEqualZonesWidth,
  sidebarNameColumnPx,
  sidebarPreviewCellPx,
  sidebarThreeThumbnailsCellPx,
  sidebarNameFloor,
  sidebarReserved,
  sidebarZoneWidth,
} from "./appLayout";
import { TALL_CHROME_ROW_HEIGHT } from "./chromeHeight";

/// The sidebar row reads as three zones: name, previews, meta. A zone is the
/// distance between two guidelines — or between a guideline and the panel edge
/// — which is what the eye compares. Measuring column boxes instead left the
/// middle zone visibly narrower even when the boxes agreed, because the row's
/// padding and the gaps around the previews belong to the neighbouring zones.
/// jsdom lays out no CSS, so the contract is pinned on the numbers themselves.
describe("sidebar zone contract", () => {
  const css = readFileSync("src/styles/global.css", "utf8");
  /** The row's inset before the name and after the count. */
  const rowPad = 16;

  it("fits the longest action state with equal 8px fields", () => {
    const width = sidebarZoneWidth() - 2 * SIDEBAR_ROW_ACTION_GAP_PX;
    expect(width).toBeGreaterThanOrEqual(SIDEBAR_ROW_ACTION_BUTTON_PX);
    expect((sidebarZoneWidth() - width) / 2).toBe(8);
  });

  it("makes the three zones equal at the frozen minimum", () => {
    // Three zones plus the two guidelines between them; the table sits flush
    // to the panel's edges.
    expect(sidebarEqualZonesWidth()).toBe(sidebarZoneWidth() * 3 + 2);
  });

  it("never lets a zone fall below what it holds", () => {
    // The previews' keystone — 2.5 icons — and the action button's field.
    expect(sidebarZoneWidth()).toBeGreaterThanOrEqual(rowPad + SIDEBAR_COLUMN_MIN_PX);
    expect(sidebarNameFloor()).toBeGreaterThanOrEqual(SIDEBAR_COLUMN_MIN_PX);
  });

  it("reserves the meta zone, the guidelines and the row inset", () => {
    expect(sidebarReserved()).toBe(sidebarZoneWidth() + 2 + rowPad);
  });

  it("keeps CSS and JS on the same numbers", () => {
    // Two sides of one contract: JS clamps the drag and lifts stored widths to
    // sidebarEqualZonesWidth(), CSS freezes the nav at --sidebar-equal-zones-width. One side
    // moving alone leaves the nav wider than the panel, and the curtain
    // permanently clips the meta column — which is how the count digits got
    // cut off once.
    expect(css).toContain(`--sidebar-equal-zones-width: ${sidebarEqualZonesWidth()}px;`);
    expect(css).toContain(`--sidebar-zone: ${sidebarZoneWidth()}px;`);
    expect(css).toContain(`--sidebar-row-pad-x: ${rowPad}px;`);
    expect(css).toContain(
      "--sidebar-reserved: calc(var(--sidebar-zone) + 2px + var(--sidebar-row-pad-x));",
    );
    expect(css).toContain(
      "--sidebar-name-floor: calc(var(--sidebar-zone) - var(--sidebar-row-pad-x));",
    );
  });

  it("splits every extra pixel of width evenly between name and previews", () => {
    expect(css).toContain("(var(--sidebar-width) - var(--sidebar-equal-zones-width)) / 2");
  });

  it("goes compact where the previews stop showing 2.8 thumbnails (PLAN 50.36, 22.10.2026)", () => {
    const below = sidebarCompactRowsBelowPx();
    // Two 32px tiles with their 4px gaps and 0.8 of a third, the 1px
    // guideline and 4px gap before them, the 24px dissolve and the 4px edge
    // gap after them.
    expect(sidebarThreeThumbnailsCellPx()).toBeCloseTo(1 + 4 + 2 * 36 + 0.8 * 32 + 24 + 4, 6);
    expect(below).toBe(366.2);
    expect(sidebarPreviewCellPx(below)).toBeCloseTo(sidebarThreeThumbnailsCellPx(), 6);
    expect(sidebarPreviewCellPx(below - 1)).toBeLessThan(sidebarThreeThumbnailsCellPx());
    // Solved on the name's growing stretch, which the threshold lies on.
    expect(sidebarNameColumnPx(below)).toBeLessThan(SIDEBAR_NAME_MAX_PX);
    expect(css).toContain(`@container sidebar-rows (width < ${below}px)`);
  });

  it("drags down to the tab bar's lead, always compact (PLAN 50.36)", () => {
    // The list is the panel less its border, at the widest chrome.
    expect(sidebarBesideMinWidthPx(TALL_CHROME_ROW_HEIGHT) - 1).toBeLessThan(sidebarCompactRowsBelowPx());
  });
});
