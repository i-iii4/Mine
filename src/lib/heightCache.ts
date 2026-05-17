// In-memory + IndexedDB cache for card heights.
//
// The DOM measurement pass in Grid.tsx renders cards hidden, reads their
// exact pixel heights via getBoundingClientRect, and stores the result
// here keyed by (layoutGenerationKey, blockId). Heights are only reusable
// when the route, width, and layout-relevant block content are unchanged.
//
// IndexedDB persistence survives app restart. On font version change the
// caller should call `clearAll()` to invalidate stale entries.

import type { LayoutGenerationKey } from "@/lib/layoutGeneration";

/** Pixel granularity for columnWidth bucketing. */
export const BUCKET_PX = 40;

/**
 * Cache content version. Bump whenever Card.tsx visual templates change in
 * a way that affects rendered heights — old measurements become invalid and
 * entries with a different version suffix are silently ignored. Bumping here
 * forces a fresh DOM measurement pass on every block at next load.
 *
 * v1: initial DOM measurement implementation
 * v2: fixed ImageCard/SocialCard aspect-ratio wrappers, added img-load wait
 * v3: ArticleCard first_image and SocialCard media use exact aspect ratios
 *     from media_dimensions metadata with object-contain (no crop)
 * v4: Math.ceil on measured heights (fix 1px bottom clip), fractional
 *     columnWidth passed to measurement (matches visible grid render)
 * v5: width/height now read from media file on disk (Markdown File First),
 *     not from frontmatter. Cards that were 1:1 fallback now have real
 *     aspect ratios — old cached heights are invalid.
 * v6: descriptor-driven layout variants for article/social cards and
 *     route-scoped grid snapshot. Old cached heights can mismatch the
 *     new geometry contract and cause overlap.
 * v7: generation-aware height cache. Keys now include route + width +
 *     layout-relevant content fingerprint, so same block id no longer
 *     reuses stale heights across generations.
 * v8: CardFrame now enforces a 90px interactive minimum so hover actions
 *     cannot overlap on empty cards.
 * v9: Masonry column widths are snapped to whole CSS pixels to keep
 *     transformed card layers and hover controls stable.
 */
const CACHE_VERSION = 9;

const DB_NAME = "arena-card-heights";
const DB_VERSION = 1;
const STORE_NAME = "heights";

export function bucketize(columnWidth: number): number {
  return Math.max(0, Math.round(columnWidth / BUCKET_PX));
}

function cacheKey(generationKey: LayoutGenerationKey, blockId: number): string {
  return `${generationKey}|block=${blockId}:v${CACHE_VERSION}`;
}

// ─── In-memory layer ────────────────────────────────────────────────────────

/**
 * Hot in-memory cache backed by IndexedDB on write.
 * Reads are synchronous (no async IndexedDB roundtrip on hot paths).
 */
const memoryCache = new Map<string, number>();

export function getCachedHeight(
  generationKey: LayoutGenerationKey,
  blockId: number,
): number | undefined {
  return memoryCache.get(cacheKey(generationKey, blockId));
}

export function setCachedHeight(
  generationKey: LayoutGenerationKey,
  blockId: number,
  height: number,
): void {
  memoryCache.set(cacheKey(generationKey, blockId), height);
}

// ─── IndexedDB persistence ──────────────────────────────────────────────────

interface HeightRecord {
  key: string;
  generationKey: string;
  blockId: number;
  height: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error("IndexedDB open failed"));
    };
  });
  return dbPromise;
}

/**
 * Warm the in-memory cache from IndexedDB. Call once at Grid mount.
 * Loads ALL stored records — typical vault has <100k entries which is fine
 * for IndexedDB bulk getAll.
 */
export async function warmFromIndexedDb(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const records = (req.result ?? []) as HeightRecord[];
      const versionSuffix = `:v${CACHE_VERSION}`;
      for (const record of records) {
        // Skip entries from older cache versions — they were measured against
        // a Card.tsx template that has since changed, so the heights are
        // stale. They linger in IndexedDB (harmless, cleaned lazily) but do
        // not populate the hot in-memory cache.
        if (!record.key.endsWith(versionSuffix)) continue;
        memoryCache.set(record.key, record.height);
      }
      resolve();
    };
    req.onerror = () => resolve();
  });
}

/**
 * Persist a batch of measured heights to IndexedDB. Fire-and-forget — does
 * not block the caller. On write failure, entries remain only in memory
 * for the current session.
 */
export function persistHeights(
  entries: ReadonlyArray<{ generationKey: LayoutGenerationKey; blockId: number; height: number }>,
): void {
  if (entries.length === 0) return;
  void (async () => {
    let db: IDBDatabase;
    try {
      db = await openDb();
    } catch {
      return;
    }
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const e of entries) {
      const record: HeightRecord = {
        key: cacheKey(e.generationKey, e.blockId),
        generationKey: e.generationKey,
        blockId: e.blockId,
        height: e.height,
      };
      store.put(record);
    }
  })();
}

/** Clear all cached entries (memory + IndexedDB). */
export async function clearAll(): Promise<void> {
  memoryCache.clear();
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}
