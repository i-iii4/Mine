// LRU cache for exact pre-computed masonry layouts.
//
// Only committed exact layouts are stored. The caller is responsible for
// building a generation-aware cache key that already includes route, width,
// and layout-relevant content fingerprint.

import type { LayoutGenerationKey } from "@/lib/layoutGeneration";
import type { MasonryLayout } from "./masonryLayout";

/** Default maximum number of layouts kept in cache. */
const DEFAULT_MAX_SIZE = 10;

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
  get(generationKey: LayoutGenerationKey): MasonryLayout | null {
    const hit = this.store.get(generationKey);
    if (hit === undefined) return null;
    // Refresh LRU: delete + re-insert moves the entry to the end.
    this.store.delete(generationKey);
    this.store.set(generationKey, hit);
    return hit;
  }

  /**
   * Store a layout. Evicts the least-recently-used entry if full.
   */
  set(generationKey: LayoutGenerationKey, layout: MasonryLayout): void {
    // If key exists, delete to re-insert at the end (refresh LRU order).
    if (this.store.has(generationKey)) {
      this.store.delete(generationKey);
    } else if (this.store.size >= this.maxSize) {
      // Evict the oldest (first inserted / least recently used) entry.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(generationKey, layout);
  }

  /** Drop all entries. Call after font version bump or global invalidation. */
  clear(): void {
    this.store.clear();
  }
}
