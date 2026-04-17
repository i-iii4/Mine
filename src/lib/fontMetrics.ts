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
  WorkerInMessage,
  WorkerOutMessage,
  WorkerBlockInput,
  WorkerBlockResult,
} from "@/types/fontMetrics";

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
const FONT_HASH: FontHash = "descriptor-preview-v1";

const DB_NAME = "arena-font-metrics";
const DB_VERSION = 1;
const STORE_NAME = "wordWidths";

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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "blockId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function readFromCache(
  blockIds: number[],
  fontHash: FontHash,
): Promise<Map<number, WordWidths>> {
  if (blockIds.length === 0) return new Map();

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
    let pendingCount = blockIds.length;

    if (pendingCount === 0) {
      db.close();
      resolve(result);
      return;
    }

    for (const id of blockIds) {
      const req = store.get(id);
      req.onsuccess = () => {
        const record = req.result as CachedWordWidths | undefined;
        if (record && record.fontHash === fontHash) {
          result.set(id, record.widths);
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
  fontHash: FontHash,
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
      const record: CachedWordWidths = {
        blockId: entry.id,
        fontHash,
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

  const blockIds = blocks.map((b) => b.id);
  const cached = await readFromCache(blockIds, FONT_HASH);

  const missing = blocks.filter((b) => !cached.has(b.id));
  if (missing.length === 0) return cached;

  try {
    await ensureWorkerReady();
  } catch (err) {
    console.warn("[fontMetrics] worker init failed, returning partial cache", err);
    return cached;
  }

  const workerInputs: WorkerBlockInput[] = missing.map((b) => {
    const descriptor = deriveCardLayoutDescriptor(b);
    return {
      id: b.id,
      title: descriptor.titleText,
      body: descriptor.previewText,
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
  void writeToCache(computed, FONT_HASH);

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
