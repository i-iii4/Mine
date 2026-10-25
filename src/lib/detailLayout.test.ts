import { describe, expect, it } from "vitest";

import {
  DETAIL_CONTENT_MAX_WIDTH_PX,
  DETAIL_MEDIA_MAX_HEIGHT_VAR,
  DETAIL_RAIL_LINE_PX,
  DETAIL_RAIL_WIDTH_PX,
  detailLayout,
  detailMediaFrameStyle,
  detailMediaFrameWidth,
  detailMediaMaxHeightStyle,
  detailMediaSize,
  detailRailGridTemplate,
  sameMediaProportion,
} from "./detailLayout";

// SPEC_FRONTEND.md, «Раскладка открытой карточки».
describe("detailLayout", () => {
  const pad = 32;

  it("stands the content beside the panel, centred, while both margins are at least the inset (Р2, Р3)", () => {
    // 1400 = margin + 680 + margin + (line 1 + 32 + 320 + 32): each margin
    // 167.5 (user's decisions of 16.10.2026, the reading column 680 instead
    // of 768, and of 24.10.2026, the line before the panel).
    const layout = detailLayout(1400, pad, DETAIL_CONTENT_MAX_WIDTH_PX);
    expect(layout).toEqual({ mode: "rail", sideMarginPx: 167.5 });
    // Centred between the left edge and the panel: the same space on both sides.
    const contentLeft = layout.sideMarginPx!;
    const contentRight = contentLeft + DETAIL_CONTENT_MAX_WIDTH_PX;
    const panelLeft = 1400 - 2 * pad - DETAIL_RAIL_WIDTH_PX - DETAIL_RAIL_LINE_PX;
    expect(panelLeft - contentRight).toBe(contentLeft);
  });

  it("narrows both margins equally and stacks once they would fall under the inset (Р3)", () => {
    // 4 × 32 + 680 + 1 + 320 = 1129: both margins exactly the inset.
    expect(detailLayout(1129, pad, 680)).toEqual({ mode: "rail", sideMarginPx: pad });
    expect(detailLayout(1128, pad, 680)).toEqual({ mode: "stacked", sideMarginPx: null });
    // The margins follow the drawn content: a picture 544 wide stays beside
    // the panel down to 4 × 32 + 544 + 1 + 320 = 993.
    expect(detailLayout(1095, pad, 544)).toEqual({ mode: "rail", sideMarginPx: 83 });
    expect(detailLayout(993, pad, 544).mode).toBe("rail");
    expect(detailLayout(992, pad, 544).mode).toBe("stacked");
    // The inset follows the edge rhythm.
    expect(detailLayout(4 * 16 + 680 + 321, 16, 680).mode).toBe("rail");
    expect(detailLayout(4 * 16 + 680 + 320, 16, 680).mode).toBe("stacked");
  });

  it("builds the rail columns as two equal flexible tracks round the content (Р2)", () => {
    expect(detailRailGridTemplate(544)).toBe(
      "minmax(var(--card-content-pad),1fr) 544px minmax(var(--card-content-pad),1fr) calc(321px + 2 * var(--card-content-pad))",
    );
  });
});

describe("detail media frame", () => {
  it("knows a size only when both sides are positive finite numbers", () => {
    expect(detailMediaSize(1080, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(detailMediaSize(null, 1920)).toBeNull();
    expect(detailMediaSize(1080, undefined)).toBeNull();
    expect(detailMediaSize(0, 1920)).toBeNull();
    expect(detailMediaSize(Number.NaN, 1920)).toBeNull();
    expect(detailMediaSize(Number.POSITIVE_INFINITY, 1920)).toBeNull();
  });

  it("draws a medium at its own width or at the width the height limit allows (Р6, Р7)", () => {
    // Portrait at the limit: 0.85 × 800 = 680 tall, 680 × 1080 / 1920 wide.
    expect(detailMediaFrameWidth({ width: 1080, height: 1920 }, 800)).toBe(382.5);
    // Landscape: the limit allows 680 × 16 / 9; the column holds it later.
    expect(detailMediaFrameWidth({ width: 1920, height: 1080 }, 800)).toBeCloseTo(1208.89, 2);
    // Small: its own width, never enlarged.
    expect(detailMediaFrameWidth({ width: 240, height: 160 }, 800)).toBe(240);
    // Exactly at the limit: both rules give the same width.
    expect(detailMediaFrameWidth({ width: 400, height: 680 }, 800)).toBe(400);
  });

  it("gives the frame the medium's proportion and the same width rule in CSS, never wider than its column (Р6)", () => {
    expect(detailMediaFrameStyle({ width: 1080, height: 1920 })).toEqual({
      width: `min(1080px, calc(var(${DETAIL_MEDIA_MAX_HEIGHT_VAR}) * 1080 / 1920))`,
      maxWidth: "100%",
      aspectRatio: "1080 / 1920",
    });
  });

  it("carries the one height limit as a CSS variable (Р7)", () => {
    expect(detailMediaMaxHeightStyle()).toEqual({ [DETAIL_MEDIA_MAX_HEIGHT_VAR]: "85vh" });
  });

  it("takes the limit of the card's own frame in its window (SPEC_CARD_PEEK.md, О8)", () => {
    expect(detailMediaMaxHeightStyle(600)).toEqual({ [DETAIL_MEDIA_MAX_HEIGHT_VAR]: "510px" });
  });

  it("tells a turned video from the record's rounding (Р6)", () => {
    expect(sameMediaProportion({ width: 1920, height: 1080 }, { width: 960, height: 540 })).toBe(true);
    // An encoder's odd side: 1080 × 1918 against 1080 × 1920.
    expect(sameMediaProportion({ width: 1080, height: 1920 }, { width: 1080, height: 1918 })).toBe(true);
    expect(sameMediaProportion({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toBe(false);
    expect(sameMediaProportion({ width: 1000, height: 1000 }, { width: 1000, height: 1030 })).toBe(false);
  });
});
