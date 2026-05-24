import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import type { MasonryPosition } from "@/lib/masonryLayout";
import {
  collectViewportFirstMeasurementBatch,
  computeCommittedEndIndex,
  createGridLayoutReadinessDiagnostics,
} from "./gridLayoutReadiness";

function block(id: number): LightBlock {
  return {
    id,
    slug: `block-${id}`,
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
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    tags: [],
  };
}

function position(index: number, top: number): MasonryPosition {
  return {
    index,
    top,
    left: 0,
    width: 240,
    height: 200,
    bottom: top + 200,
    column: 0,
  };
}

describe("gridLayoutReadiness", () => {
  it("keeps contiguous committed prefix as diagnostics, not the only live-readiness model", () => {
    const blocks = [block(1), block(2), block(3), block(4)];
    const measured = new Set([1, 4]);

    expect(computeCommittedEndIndex(blocks, measured, true)).toBe(0);
    expect(measured.has(4)).toBe(true);
  });

  it("prioritizes the current viewport before missing prefix blocks", () => {
    const blocks = Array.from({ length: 12 }, (_, index) => block(index + 1));
    const positions = blocks.map((_, index) => position(index, index * 240));
    const visibleItems = positions.filter((item) => item.index >= 7 && item.index <= 10);
    const measured = new Set([1, 2]);

    const batch = collectViewportFirstMeasurementBatch({
      blocks,
      positions,
      visibleItems,
      measuredBlockIds: measured,
      scrollTop: positions[8]!.top,
      viewportHeight: 260,
      targetEndIndex: 11,
      batchSize: 5,
    });

    expect(batch.map((item) => item.id)).toEqual([9, 10, 8, 11, 3]);
  });

  it("reports viewport unmeasured backlog separately from mounted overscan backlog", () => {
    const blocks = Array.from({ length: 6 }, (_, index) => block(index + 1));
    const visibleItems = [
      position(1, 0),
      position(2, 240),
      position(3, 480),
      position(4, 720),
    ];
    const measured = new Set([2, 5]);

    const diagnostics = createGridLayoutReadinessDiagnostics({
      layoutGenerationKey: "route|width=240",
      blocks,
      visibleItems,
      measuredBlockIds: measured,
      committedEndIndex: 1,
      targetCommittedEndIndex: 5,
      maxVisibleIndex: 4,
      scrollTop: 240,
      viewportHeight: 420,
      measurementBatchSize: 3,
    });

    expect(diagnostics.layoutGenerationKey).toBe("route|width=240");
    expect(diagnostics.visibleUnmeasuredCount).toBe(2);
    expect(diagnostics.viewportUnmeasuredCount).toBe(2);
    expect(diagnostics.measuredBlockCount).toBe(2);
    expect(diagnostics.totalBlockCount).toBe(6);
  });
});
