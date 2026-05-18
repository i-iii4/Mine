import { describe, expect, it, vi } from "vitest";
import type { LightBlock } from "@/types";
import {
  resolveBlockDragBlocks,
  resolveBlockDragSlugs,
  uniqueDragBlocks,
  uniqueDragSlugs,
  type BlockDragData,
} from "./blockDrag";

function block(slug: string): LightBlock {
  return {
    id: slug.length,
    slug,
    card_kind: "media",
    block_type: "image",
    title: slug,
    description: null,
    url: null,
    media_file: `${slug}.jpg`,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    source: null,
    width: 100,
    height: 100,
    author: null,
    body: "",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    tags: [],
  };
}

describe("block drag helpers", () => {
  it("deduplicates drag slugs while preserving order", () => {
    expect(uniqueDragSlugs(["alpha", "beta", "alpha", "", "gamma"])).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("deduplicates drag blocks by slug while preserving order", () => {
    const alpha = block("alpha");
    const beta = block("beta");
    expect(uniqueDragBlocks([alpha, beta, { ...alpha, id: 99 }])).toEqual([alpha, beta]);
  });

  it("resolves group drag slugs from draggable data before the active id", () => {
    const data: Partial<BlockDragData> = {
      type: "block",
      slug: "alpha",
      dragSlugs: ["alpha", "beta", "alpha"],
    };
    expect(resolveBlockDragSlugs("alpha", data)).toEqual(["alpha", "beta"]);
  });

  it("falls back to detail ids for single-card drags", () => {
    expect(resolveBlockDragSlugs("detail:alpha", undefined)).toEqual(["alpha"]);
  });

  it("resolves group drag preview blocks from draggable data", () => {
    const alpha = block("alpha");
    const beta = block("beta");
    const data: Partial<BlockDragData> = {
      type: "block",
      slug: "alpha",
      block: alpha,
      dragBlocks: [alpha, beta, alpha],
    };
    expect(resolveBlockDragBlocks("alpha", data, [])).toEqual([alpha, beta]);
  });

  it("can carry a clear-selection callback for ungrouped drags", () => {
    const clearSelectionOnDragStart = vi.fn();
    const data: Partial<BlockDragData> = {
      type: "block",
      slug: "alpha",
      clearSelectionOnDragStart,
    };
    data.clearSelectionOnDragStart?.();
    expect(clearSelectionOnDragStart).toHaveBeenCalledOnce();
  });
});
