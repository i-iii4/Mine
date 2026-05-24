import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import {
  CARD_HEIGHT_DRIFT_HARD_BUDGET_PX,
  CARD_HEIGHT_DRIFT_SOFT_BUDGET_PX,
  createCardHeightDriftReport,
} from "./cardHeightDrift";

function block(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id,
    slug: `block-${id}`,
    card_kind: "article",
    block_type: "article",
    title: `Block ${id}`,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: `Body ${id}`,
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    ...overrides,
  };
}

describe("createCardHeightDriftReport", () => {
  it("returns an empty report without samples", () => {
    const report = createCardHeightDriftReport({
      layoutGenerationKey: "route|width=240",
      columnWidth: 240,
      observations: [],
      nowMs: 10,
    });

    expect(report.status).toBe("empty");
    expect(report.count).toBe(0);
    expect(report.checkedAtMs).toBe(10);
  });

  it("aggregates exact samples and keeps small drift within budget", () => {
    const report = createCardHeightDriftReport({
      layoutGenerationKey: "route|width=240",
      columnWidth: 240,
      observations: [
        {
          block: block(1),
          measuredHeight: 100,
          deterministicHeight: 101,
          wordMetricsReady: true,
        },
        {
          block: block(2, { card_kind: "media", block_type: "image" }),
          measuredHeight: 120,
          deterministicHeight: 119,
          wordMetricsReady: true,
        },
      ],
      nowMs: 20,
    });

    expect(report.status).toBe("ok");
    expect(report.count).toBe(2);
    expect(report.meanAbsDeltaPx).toBe(1);
    expect(report.p95AbsDeltaPx).toBe(1);
    expect(report.exactSampleCount).toBe(2);
    expect(report.fallbackSampleCount).toBe(0);
    expect(report.byCardKind.article?.count).toBe(1);
    expect(report.byCardKind.media?.count).toBe(1);
    expect(report.softBudgetPx).toBe(CARD_HEIGHT_DRIFT_SOFT_BUDGET_PX);
    expect(report.hardBudgetPx).toBe(CARD_HEIGHT_DRIFT_HARD_BUDGET_PX);
  });

  it("reports over-budget when deterministic height drifts beyond thresholds", () => {
    const report = createCardHeightDriftReport({
      layoutGenerationKey: "route|width=240",
      columnWidth: 240,
      observations: [
        {
          block: block(1),
          measuredHeight: 100,
          deterministicHeight: 101,
          wordMetricsReady: true,
        },
        {
          block: block(2),
          measuredHeight: 100,
          deterministicHeight: 103,
          wordMetricsReady: true,
        },
        {
          block: block(3),
          measuredHeight: 100,
          deterministicHeight: 109,
          wordMetricsReady: true,
        },
      ],
      nowMs: 30,
    });

    expect(report.status).toBe("over-budget");
    expect(report.maxAbsDeltaPx).toBe(9);
    expect(report.p95AbsDeltaPx).toBe(9);
    expect(report.softBudgetExceededCount).toBe(2);
    expect(report.hardBudgetExceededCount).toBe(1);
  });

  it("keeps fallback word metrics out of production-ready status", () => {
    const report = createCardHeightDriftReport({
      layoutGenerationKey: "route|width=240",
      columnWidth: 240,
      observations: [
        {
          block: block(1),
          measuredHeight: 100,
          deterministicHeight: 100,
          wordMetricsReady: false,
        },
      ],
      nowMs: 40,
    });

    expect(report.status).toBe("over-budget");
    expect(report.exactSampleCount).toBe(0);
    expect(report.fallbackSampleCount).toBe(1);
  });
});
