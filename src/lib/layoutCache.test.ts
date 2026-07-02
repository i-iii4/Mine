import { describe, it, expect } from "vitest";
import { LayoutCache } from "./layoutCache";
import {
  computeMasonryLayout,
  getMasonryColumnCount,
  getMasonryColumnWidth,
} from "./masonryLayout";
import type { LightBlock } from "@/types";
import { buildLayoutGenerationKey } from "./layoutGeneration";

function mkBlock(id: number): LightBlock {
  return {
    id,
    slug: `slug-${id}`,
    block_type: "image",
    title: null,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: 1000,
    height: 1000,
    author: null,
    body: "",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    tags: [],
  };
}

const sampleLayout = computeMasonryLayout([100, 200, 300], 1000, 240, 32);

function generationKey(blocks: LightBlock[], parentWidth: number): string {
  return buildLayoutGenerationKey({
    blocks,
    routeKey: "__all__",
    columnWidth: getMasonryColumnWidth(parentWidth, 220, 32),
    columnCount: getMasonryColumnCount(parentWidth, 220, 32),
  });
}

describe("buildLayoutGenerationKey", () => {
  it("differs for different block lists", () => {
    const a = generationKey([mkBlock(1), mkBlock(2)], 1000);
    const b = generationKey([mkBlock(3), mkBlock(4)], 1000);
    expect(a).not.toBe(b);
  });

  it("differs for different parentWidth buckets", () => {
    const a = generationKey([mkBlock(1)], 1000);
    const b = generationKey([mkBlock(1)], 1200);
    expect(a).not.toBe(b);
  });

  it("differs when only middle blocks change", () => {
    const a = generationKey([mkBlock(1), mkBlock(2), mkBlock(3), mkBlock(4)], 1000);
    const b = generationKey([mkBlock(1), mkBlock(9), mkBlock(8), mkBlock(4)], 1000);
    expect(a).not.toBe(b);
  });

  it("handles empty blocks array", () => {
    expect(() => generationKey([], 1000)).not.toThrow();
  });
});

describe("LayoutCache", () => {
  it("returns null on miss", () => {
    const cache = new LayoutCache();
    expect(cache.get(generationKey([mkBlock(1)], 1000))).toBeNull();
  });

  it("returns stored layout on hit", () => {
    const cache = new LayoutCache();
    const key = generationKey([mkBlock(1), mkBlock(2)], 1000);
    cache.set(key, sampleLayout);
    expect(cache.get(key)).toBe(sampleLayout);
  });

  it("different keys do not collide", () => {
    const cache = new LayoutCache();
    const a = generationKey([mkBlock(1)], 1000);
    const b = generationKey([mkBlock(2)], 1000);
    const layoutA = computeMasonryLayout([100], 1000, 240, 32);
    const layoutB = computeMasonryLayout([200], 1000, 240, 32);
    cache.set(a, layoutA);
    cache.set(b, layoutB);
    expect(cache.get(a)).toBe(layoutA);
    expect(cache.get(b)).toBe(layoutB);
  });

  it("evicts least-recently-used entry when full", () => {
    const cache = new LayoutCache(3);
    const b1 = generationKey([mkBlock(1)], 1000);
    const b2 = generationKey([mkBlock(2)], 1000);
    const b3 = generationKey([mkBlock(3)], 1000);
    const b4 = generationKey([mkBlock(4)], 1000);
    cache.set(b1, sampleLayout);
    cache.set(b2, sampleLayout);
    cache.set(b3, sampleLayout);
    // At max, next set evicts b1 (oldest)
    cache.set(b4, sampleLayout);
    expect(cache.size).toBe(3);
    expect(cache.get(b1)).toBeNull();
    expect(cache.get(b2)).not.toBeNull();
    expect(cache.get(b4)).not.toBeNull();
  });

  it("get refreshes LRU position", () => {
    const cache = new LayoutCache(3);
    const b1 = generationKey([mkBlock(1)], 1000);
    const b2 = generationKey([mkBlock(2)], 1000);
    const b3 = generationKey([mkBlock(3)], 1000);
    const b4 = generationKey([mkBlock(4)], 1000);
    cache.set(b1, sampleLayout);
    cache.set(b2, sampleLayout);
    cache.set(b3, sampleLayout);
    // Access b1 — now b2 is oldest
    cache.get(b1);
    cache.set(b4, sampleLayout);
    // b2 evicted, b1 survived
    expect(cache.get(b2)).toBeNull();
    expect(cache.get(b1)).not.toBeNull();
  });

  it("set on existing key refreshes LRU position without growing", () => {
    const cache = new LayoutCache(2);
    const b1 = generationKey([mkBlock(1)], 1000);
    const b2 = generationKey([mkBlock(2)], 1000);
    cache.set(b1, sampleLayout);
    cache.set(b2, sampleLayout);
    expect(cache.size).toBe(2);
    // Re-set existing key — should not evict, just refresh
    cache.set(b1, sampleLayout);
    expect(cache.size).toBe(2);
  });

  it("clear removes all entries", () => {
    const cache = new LayoutCache();
    cache.set(generationKey([mkBlock(1)], 1000), sampleLayout);
    cache.set(generationKey([mkBlock(2)], 1000), sampleLayout);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get(generationKey([mkBlock(1)], 1000))).toBeNull();
  });

  it("throws on non-positive maxSize", () => {
    expect(() => new LayoutCache(0)).toThrow();
    expect(() => new LayoutCache(-1)).toThrow();
  });
});
