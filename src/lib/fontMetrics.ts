// Font-metrics client API.
//
// Orchestrates a single Web Worker that precomputes word widths for blocks,
// backed by an IndexedDB cache so repeated visits skip computation entirely.
//
// See SPEC_GRID.md for the pipeline rationale.

import type { LightBlock } from "@/types";
import { deriveCardLayoutDescriptor } from "@/lib/cardLayout";
import type {
  FontHash,
  WordWidths,
  CachedWordWidths,
  FontMetricsCacheIdentity,
  WorkerInMessage,
  WorkerOutMessage,
  WorkerBlockInput,
  WorkerBlockResult,
} from "@/types/fontMetrics";
import { FONT_METRICS_PREVIEW_MAX_CHARS } from "@/types/fontMetrics";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Path to the Geist font file served by Vite from /public. */
const FONT_URL = "/fonts/Geist-Variable.woff2";
const FONT_FAMILY = "Geist";

/**
 * Font specs used to measure text widths. MUST match the actual fonts
 * used in Card.tsx for title and preview, otherwise computed line counts
 * will not match rendered line counts.
 *
 * Title: text-sm font-semibold → 12px / 600 weight
 * Preview: text-sm → 12px / 400 weight
 */
const TITLE_FONT_SPEC = "600 12px 'Geist', system-ui, sans-serif";
const PREVIEW_FONT_SPEC = "400 12px 'Geist', system-ui, sans-serif";

/**
 * Static font hash. Bumped manually when the font file, size, or spec
 * changes in a way that affects measureText output. All cached entries
 * with a different hash are treated as stale and re-computed.
 */
const FONT_HASH: FontHash = "descriptor-preview-v2";

const DB_NAME = "mine-font-metrics";
const DB_VERSION = 2;
const STORE_NAME = "wordWidths";
const CACHE_KEY_VERSION = "v2";

// ─── Worker lifecycle ───────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (results: WorkerBlockResult[]) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

async function fetchFontBuffer(): Promise<ArrayBuffer> {
  const response = await fetch(FONT_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch font at ${FONT_URL}: ${response.status}`);
  }
  return response.arrayBuffer();
}

function createWorker(): Worker {
  return new Worker(
    new URL("../workers/fontMetrics.worker.ts", import.meta.url),
    { type: "module" },
  );
}

function handleWorkerMessage(event: MessageEvent<WorkerOutMessage>): void {
  const msg = event.data;
  switch (msg.type) {
    case "ready":
      // Init acknowledgement — resolved separately by ensureWorkerReady
      break;
    case "progress":
      // Ignored for now; a future UI could subscribe to progress events
      break;
    case "result": {
      const request = pending.get(msg.requestId);
      if (request) {
        pending.delete(msg.requestId);
        request.resolve(msg.results);
      }
      break;
    }
    case "error": {
      const request = pending.get(msg.requestId);
      if (request) {
        pending.delete(msg.requestId);
        request.reject(new Error(msg.message));
      }
      break;
    }
  }
}

async function ensureWorkerReady(): Promise<void> {
  if (workerReady) return workerReady;

  workerReady = (async () => {
    if (typeof Worker === "undefined") {
      throw new Error("Web Workers not supported in this environment");
    }
    if (typeof OffscreenCanvas === "undefined") {
      throw new Error("OffscreenCanvas not supported in this environment");
    }

    const fontBuffer = await fetchFontBuffer();
    worker = createWorker();
    worker.addEventListener("message", handleWorkerMessage);
    worker.addEventListener("error", (e) => {
      // Reject all pending requests on worker crash
      const err = new Error(`Worker crashed: ${e.message}`);
      for (const req of pending.values()) {
        req.reject(err);
      }
      pending.clear();
    });

    const initRequestId = nextRequestId++;
    const initPromise = new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerOutMessage>) => {
        if (event.data.type === "ready" && event.data.requestId === initRequestId) {
          worker?.removeEventListener("message", onMessage);
          resolve();
        } else if (event.data.type === "error" && event.data.requestId === initRequestId) {
          worker?.removeEventListener("message", onMessage);
          reject(new Error(event.data.message));
        }
      };
      worker!.addEventListener("message", onMessage);
    });

    const initMessage: WorkerInMessage = {
      type: "init",
      requestId: initRequestId,
      fontBuffer,
      fontFamily: FONT_FAMILY,
    };
    worker.postMessage(initMessage, [fontBuffer]);

    await initPromise;
  })();

  try {
    await workerReady;
  } catch (err) {
    workerReady = null;
    worker = null;
    throw err;
  }
  return workerReady;
}

function computeInWorker(blocks: WorkerBlockInput[]): Promise<WorkerBlockResult[]> {
  if (!worker) {
    return Promise.reject(new Error("Worker not initialized"));
  }
  const requestId = nextRequestId++;
  const promise = new Promise<WorkerBlockResult[]>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
  });
  const message: WorkerInMessage = {
    type: "compute",
    requestId,
    blocks,
    fontHash: FONT_HASH,
    titleFontSpec: TITLE_FONT_SPEC,
    previewFontSpec: PREVIEW_FONT_SPEC,
  };
  worker.postMessage(message);
  return promise;
}

// ─── Font readiness ─────────────────────────────────────────────────────────

let fontReadyPromise: Promise<void> | null = null;

async function ensureFontLoaded(): Promise<void> {
  if (fontReadyPromise) return fontReadyPromise;
  fontReadyPromise = (async () => {
    if (typeof document !== "undefined" && document.fonts?.ready) {
      await document.fonts.ready;
    }
  })();
  return fontReadyPromise;
}

// ─── IndexedDB cache ────────────────────────────────────────────────────────

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Build the cache identity for one block's font metrics.
 *
 * The old cache contract keyed entries only by block id and font hash. That is
 * not enough: card text can change without changing id, and then stale word
 * widths corrupt deterministic height calculation. The identity therefore
 * hashes exactly the text slice the worker measures.
 */
export function createFontMetricsCacheIdentity(
  block: LightBlock,
): FontMetricsCacheIdentity {
  const descriptor = deriveCardLayoutDescriptor(block);
  const title = descriptor.titleText;
  const preview = descriptor.previewText.length > FONT_METRICS_PREVIEW_MAX_CHARS
    ? descriptor.previewText.slice(0, FONT_METRICS_PREVIEW_MAX_CHARS)
    : descriptor.previewText;
  const textHash = hashString(`${title}\u0000${preview}`);
  return {
    blockId: block.id,
    fontHash: FONT_HASH,
    textHash,
    cacheKey: `${CACHE_KEY_VERSION}:${FONT_HASH}:${block.id}:${textHash}`,
    title,
    preview,
  };
}

function isWordWidths(value: unknown): value is WordWidths {
  if (typeof value !== "object" || value === null) return false;
  // IndexedDB stores structured clones; validate each field before reuse.
  const candidate = value as Partial<WordWidths>;
  return (
    Array.isArray(candidate.title) &&
    Array.isArray(candidate.preview) &&
    typeof candidate.titleSpace === "number" &&
    typeof candidate.previewSpace === "number"
  );
}

function isCachedWordWidths(value: unknown): value is CachedWordWidths {
  if (typeof value !== "object" || value === null) return false;
  // IndexedDB returns an untyped clone; validate the shape before trusting it.
  const candidate = value as Partial<CachedWordWidths>;
  return (
    typeof candidate.cacheKey === "string" &&
    typeof candidate.blockId === "number" &&
    typeof candidate.fontHash === "string" &&
    typeof candidate.textHash === "string" &&
    isWordWidths(candidate.widths)
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function readFromCache(
  identities: FontMetricsCacheIdentity[],
): Promise<Map<number, WordWidths>> {
  if (identities.length === 0) return new Map();

  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return new Map();
  }

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const result = new Map<number, WordWidths>();
    let pendingCount = identities.length;

    if (pendingCount === 0) {
      db.close();
      resolve(result);
      return;
    }

    for (const identity of identities) {
      const req = store.get(identity.cacheKey);
      req.onsuccess = () => {
        const record: unknown = req.result;
        if (
          isCachedWordWidths(record) &&
          record.blockId === identity.blockId &&
          record.fontHash === identity.fontHash &&
          record.textHash === identity.textHash
        ) {
          result.set(identity.blockId, record.widths);
        }
        pendingCount -= 1;
        if (pendingCount === 0) {
          db.close();
          resolve(result);
        }
      };
      req.onerror = () => {
        pendingCount -= 1;
        if (pendingCount === 0) {
          db.close();
          resolve(result);
        }
      };
    }
  });
}

async function writeToCache(
  entries: WorkerBlockResult[],
  identitiesByBlockId: ReadonlyMap<number, FontMetricsCacheIdentity>,
): Promise<void> {
  if (entries.length === 0) return;

  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const entry of entries) {
      const identity = identitiesByBlockId.get(entry.id);
      if (!identity) continue;
      const record: CachedWordWidths = {
        cacheKey: identity.cacheKey,
        blockId: entry.id,
        fontHash: identity.fontHash,
        textHash: identity.textHash,
        widths: entry.widths,
      };
      store.put(record);
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get word widths for a set of blocks.
 *
 * Strategy:
 * 1. Ensure the font is loaded (main-thread font face).
 * 2. Read cached widths from IndexedDB for all blocks.
 * 3. Compute missing widths in the Web Worker.
 * 4. Persist new results to IndexedDB.
 * 5. Return the merged map.
 *
 * On any worker/IndexedDB failure, returns whatever was successfully retrieved —
 * missing entries are represented by absence in the map. Callers must handle
 * null lookups via a conservative fallback in `computeCardHeight`.
 */
export async function fetchWordWidths(
  blocks: LightBlock[],
): Promise<Map<number, WordWidths>> {
  if (blocks.length === 0) return new Map();

  await ensureFontLoaded();

  const identities = blocks.map(createFontMetricsCacheIdentity);
  const identitiesByBlockId = new Map<number, FontMetricsCacheIdentity>();
  for (const identity of identities) {
    identitiesByBlockId.set(identity.blockId, identity);
  }
  const cached = await readFromCache(identities);

  const missing = blocks.filter((b) => !cached.has(b.id));
  if (missing.length === 0) return cached;

  try {
    await ensureWorkerReady();
  } catch (err) {
    // Worker/OffscreenCanvas absence is an expected capability fallback in
    // JSDOM and older WebViews. Unexpected initialization failures still stay
    // visible because they can indicate a broken font asset or worker bundle.
    if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
      console.warn("[fontMetrics] worker init failed, returning partial cache", err);
    }
    return cached;
  }

  const workerInputs: WorkerBlockInput[] = missing.map((b) => {
    const identity = identitiesByBlockId.get(b.id);
    return {
      id: b.id,
      title: identity?.title ?? "",
      body: identity?.preview ?? "",
    };
  });

  let computed: WorkerBlockResult[];
  try {
    computed = await computeInWorker(workerInputs);
  } catch (err) {
    console.warn("[fontMetrics] worker compute failed, returning partial cache", err);
    return cached;
  }

  // Fire-and-forget cache write — don't block on it
  void writeToCache(computed, identitiesByBlockId);

  const result = new Map<number, WordWidths>(cached);
  for (const entry of computed) {
    result.set(entry.id, entry.widths);
  }
  return result;
}

/** Current font hash. Exposed for debugging and cache inspection. */
export function getFontHash(): FontHash {
  return FONT_HASH;
}

/**
 * Invalidate the entire font-metrics cache. Call after a font version bump
 * or when debugging stale entries. Does not cancel in-flight worker requests.
 */
export async function invalidateFontCache(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

/** Terminate the worker (for cleanup on unmount in tests or HMR). */
export function disposeWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerReady = null;
  pending.clear();
}
