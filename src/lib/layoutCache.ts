// LRU cache for pre-computed masonry layouts.
//
// Channel switching is one of the four product requirements (instant).
// When the user navigates back to a recently-visited channel, we want the
// layout to be ready without recomputation. This cache keeps the last N
// layouts keyed by (blocks identity, parentWidth bucket) and evicts the
// least-recently-used entry when full.
//
// Keys use a lightweight identity hash rather than deep content comparison.
// A blocks array is identified by its length plus first/last block ids —
// cheap to compute and sufficient to distinguish different channels in
// practice (since blocks arrays come from separate Tauri command calls
// and never share structural identity across channels).
//
// parentWidth is bucketed to 10-pixel granularity so sub-pixel resize
// variations don't create distinct cache entries.
//
// See SPEC_GRID.md §004 for the rationale.

import type { LightBlock } from "@/types";
import type { MasonryLayout } from "./masonryLayout";

/** Default maximum number of layouts kept in cache. */
const DEFAULT_MAX_SIZE = 10;

/** Granularity of parentWidth bucketing, in pixels. */
const WIDTH_BUCKET_PX = 10;

/**
 * Build a cache key for (blocks, parentWidth). Pure function.
 * Returns a short string derived from array length and edge block ids.
 */
export function layoutCacheKey(blocks: LightBlock[], parentWidth: number): string {
  const n = blocks.length;
  const first = n > 0 ? blocks[0]!.id : -1;
  const last = n > 0 ? blocks[n - 1]!.id : -1;
  const widthBucket = Math.round(parentWidth / WIDTH_BUCKET_PX);
  return `${n}:${first}:${last}:${widthBucket}`;
}

/**
 * LRU cache with explicit size limit and first-class get/set/clear API.
 * Implemented over a Map, which preserves insertion order in ES2015+.
 * Every get() re-inserts the key to refresh its LRU position.
 */
export class LayoutCache {
  private readonly store = new Map<string, MasonryLayout>();

  constructor(private readonly maxSize: number = DEFAULT_MAX_SIZE) {
    if (maxSize <= 0) {
      throw new Error("LayoutCache maxSize must be positive");
    }
  }

  /** Current number of entries. */
  get size(): number {
    return this.store.size;
  }

  /**
   * Lookup a cached layout. On hit, refreshes the key's LRU position so
   * it survives the next eviction. Returns null on miss.
   */
  get(blocks: LightBlock[], parentWidth: number): MasonryLayout | null {
    const key = layoutCacheKey(blocks, parentWidth);
    const hit = this.store.get(key);
    if (hit === undefined) return null;
    // Refresh LRU: delete + re-insert moves the entry to the end.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit;
  }

  /**
   * Store a layout. Evicts the least-recently-used entry if full.
   */
  set(blocks: LightBlock[], parentWidth: number, layout: MasonryLayout): void {
    const key = layoutCacheKey(blocks, parentWidth);
    // If key exists, delete to re-insert at the end (refresh LRU order).
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      // Evict the oldest (first inserted / least recently used) entry.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, layout);
  }

  /** Drop all entries. Call after font version bump or global invalidation. */
  clear(): void {
    this.store.clear();
  }
}
