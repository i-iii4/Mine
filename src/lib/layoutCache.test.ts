import { describe, it, expect } from "vitest";
import { LayoutCache, layoutCacheKey } from "./layoutCache";
import { computeMasonryLayout } from "./masonryLayout";
import type { LightBlock } from "@/types";

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

describe("layoutCacheKey", () => {
  it("differs for different block lists", () => {
    const a = layoutCacheKey([mkBlock(1), mkBlock(2)], 1000);
    const b = layoutCacheKey([mkBlock(3), mkBlock(4)], 1000);
    expect(a).not.toBe(b);
  });

  it("differs for different parentWidth buckets", () => {
    const a = layoutCacheKey([mkBlock(1)], 1000);
    const b = layoutCacheKey([mkBlock(1)], 1200);
    expect(a).not.toBe(b);
  });

  it("differs when only middle blocks change", () => {
    const a = layoutCacheKey([mkBlock(1), mkBlock(2), mkBlock(3), mkBlock(4)], 1000);
    const b = layoutCacheKey([mkBlock(1), mkBlock(9), mkBlock(8), mkBlock(4)], 1000);
    expect(a).not.toBe(b);
  });

  it("matches for parentWidth within same 10px bucket", () => {
    const a = layoutCacheKey([mkBlock(1)], 1000);
    const b = layoutCacheKey([mkBlock(1)], 1004);
    expect(a).toBe(b);
  });

  it("handles empty blocks array", () => {
    expect(() => layoutCacheKey([], 1000)).not.toThrow();
  });
});

describe("LayoutCache", () => {
  it("returns null on miss", () => {
    const cache = new LayoutCache();
    expect(cache.get([mkBlock(1)], 1000)).toBeNull();
  });

  it("returns stored layout on hit", () => {
    const cache = new LayoutCache();
    const blocks = [mkBlock(1), mkBlock(2)];
    cache.set(blocks, 1000, sampleLayout);
    expect(cache.get(blocks, 1000)).toBe(sampleLayout);
  });

  it("different keys do not collide", () => {
    const cache = new LayoutCache();
    const a = [mkBlock(1)];
    const b = [mkBlock(2)];
    const layoutA = computeMasonryLayout([100], 1000, 240, 32);
    const layoutB = computeMasonryLayout([200], 1000, 240, 32);
    cache.set(a, 1000, layoutA);
    cache.set(b, 1000, layoutB);
    expect(cache.get(a, 1000)).toBe(layoutA);
    expect(cache.get(b, 1000)).toBe(layoutB);
  });

  it("evicts least-recently-used entry when full", () => {
    const cache = new LayoutCache(3);
    const b1 = [mkBlock(1)];
    const b2 = [mkBlock(2)];
    const b3 = [mkBlock(3)];
    const b4 = [mkBlock(4)];
    cache.set(b1, 1000, sampleLayout);
    cache.set(b2, 1000, sampleLayout);
    cache.set(b3, 1000, sampleLayout);
    // At max, next set evicts b1 (oldest)
    cache.set(b4, 1000, sampleLayout);
    expect(cache.size).toBe(3);
    expect(cache.get(b1, 1000)).toBeNull();
    expect(cache.get(b2, 1000)).not.toBeNull();
    expect(cache.get(b4, 1000)).not.toBeNull();
  });

  it("get refreshes LRU position", () => {
    const cache = new LayoutCache(3);
    const b1 = [mkBlock(1)];
    const b2 = [mkBlock(2)];
    const b3 = [mkBlock(3)];
    const b4 = [mkBlock(4)];
    cache.set(b1, 1000, sampleLayout);
    cache.set(b2, 1000, sampleLayout);
    cache.set(b3, 1000, sampleLayout);
    // Access b1 — now b2 is oldest
    cache.get(b1, 1000);
    cache.set(b4, 1000, sampleLayout);
    // b2 evicted, b1 survived
    expect(cache.get(b2, 1000)).toBeNull();
    expect(cache.get(b1, 1000)).not.toBeNull();
  });

  it("set on existing key refreshes LRU position without growing", () => {
    const cache = new LayoutCache(2);
    const b1 = [mkBlock(1)];
    const b2 = [mkBlock(2)];
    cache.set(b1, 1000, sampleLayout);
    cache.set(b2, 1000, sampleLayout);
    expect(cache.size).toBe(2);
    // Re-set existing key — should not evict, just refresh
    cache.set(b1, 1000, sampleLayout);
    expect(cache.size).toBe(2);
  });

  it("clear removes all entries", () => {
    const cache = new LayoutCache();
    cache.set([mkBlock(1)], 1000, sampleLayout);
    cache.set([mkBlock(2)], 1000, sampleLayout);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get([mkBlock(1)], 1000)).toBeNull();
  });

  it("throws on non-positive maxSize", () => {
    expect(() => new LayoutCache(0)).toThrow();
    expect(() => new LayoutCache(-1)).toThrow();
  });
});
