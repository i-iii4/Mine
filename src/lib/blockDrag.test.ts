import { describe, expect, it, vi } from "vitest";
import type { LightBlock } from "@/types";
import { indexedBlock, lightBlock } from "@/test/blocks";
import {
  isDropOnSourceCollection,
  lightBlockFromIndexed,
  resolveBlockDragBlocks,
  resolveBlockDragSlugs,
  uniqueDragBlocks,
  uniqueDragSlugs,
  type BlockDragData,
} from "./blockDrag";

function block(slug: string): LightBlock {
  return lightBlock({
    id: slug.length,
    slug,
    card_kind: "media",
    block_type: "image",
    title: slug,
    media_file: `${slug}.jpg`,
    width: 100,
    height: 100,
  });
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

  it("knows a card dropped back on the collection whose row it came from", () => {
    const fromAlpha: Partial<BlockDragData> = { type: "block", slug: "alpha", sourceTag: "alpha-tag" };
    expect(isDropOnSourceCollection(fromAlpha, "tag:alpha-tag")).toBe(true);
    expect(isDropOnSourceCollection(fromAlpha, "tag:beta-tag")).toBe(false);
    expect(isDropOnSourceCollection(fromAlpha, "create-channel")).toBe(false);
    // A feed card and a card from Everything name no collection.
    expect(isDropOnSourceCollection({ type: "block", slug: "alpha" }, "tag:alpha-tag")).toBe(false);
    expect(isDropOnSourceCollection(undefined, "tag:alpha-tag")).toBe(false);
  });

  it("gives a card read in full the feed's shape", () => {
    const full = indexedBlock({
      id: 5,
      slug: "alpha",
      card_kind: "media",
      block_type: "image",
      title: "alpha",
      media_file: "alpha.jpg",
      width: 100,
      height: 100,
      tags: ["alpha-tag", "beta-tag"],
    });
    const light = lightBlockFromIndexed(full);
    expect(light.collections).toEqual(["alpha-tag", "beta-tag"]);
    expect(light.search_match).toBeNull();
    expect(light.slug).toBe("alpha");
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
