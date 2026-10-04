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
import { computeWordWidths } from "@/lib/wordWidths";
import { CONTENT_CARD_TITLE_FONT_WEIGHT } from "@/lib/cardTypography";
import { getStoredInterfaceFont } from "@/lib/fontChoice";

/** FNV-1a: a short, stable fingerprint of a string for cache identities. */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * The interface font also renders the cards, so measurement follows the
 * stored choice. Resolved once at module load: switching fonts reloads the
 * main window (see App.tsx), which re-derives these constants.
 *
 * Title: text-sm, regular → 12px / CONTENT_CARD_TITLE_FONT_WEIGHT (400); the
 *   title differs from the preview by color alone.
 * Preview: text-sm → 12px / 400 weight
 */
const INTERFACE_FONT = getStoredInterfaceFont();
const FONT_URL = INTERFACE_FONT === "departure"
  ? "/fonts/DepartureMono-Regular.woff2"
  : "/fonts/Geist-Variable.woff2";
const FONT_FAMILY = INTERFACE_FONT === "departure" ? "Departure Mono" : "Geist";
const TITLE_FONT_SPEC = `${CONTENT_CARD_TITLE_FONT_WEIGHT} 12px '${FONT_FAMILY}', system-ui, sans-serif`;
const PREVIEW_FONT_SPEC = `400 12px '${FONT_FAMILY}', system-ui, sans-serif`;

/**
 * Version of what the font specs do not show: the font file itself and the
 * measured text model. Bumped manually when either changes.
 */
const FONT_HASH_VERSION = "descriptor-preview-v3";

/**
 * Font hash: the identity of everything that shapes measureText output.
 * Both measured font specs (weight, size, family) are part of it, so a change
 * in how titles or previews are measured can never reuse widths measured the
 * old way: a title measured semibold never sizes a title painted regular. All
 * cached entries with a different hash are treated as stale and re-computed.
 */
export function deriveFontMetricsHash(
  titleFontSpec: string,
  previewFontSpec: string,
): FontHash {
  return `${FONT_HASH_VERSION}-${hashString(`${titleFontSpec}\u0000${previewFontSpec}`)}`;
}

const FONT_HASH: FontHash = deriveFontMetricsHash(TITLE_FONT_SPEC, PREVIEW_FONT_SPEC);

const DB_NAME = "mine-font-metrics";
// v3: drops the store of widths measured with the semibold title font. The
// new font hash already keeps them from being read; the upgrade also frees
// the space they hold.
const DB_VERSION = 3;
const STORE_NAME = "wordWidths";
// v3: CJK text is measured per character with no spaces between them.
// v4: a word breaks after an inner hyphen as well (lineUnits.ts).
const CACHE_KEY_VERSION = "v4";

// ─── Worker lifecycle ───────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (results: WorkerBlockResult[]) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

/** How long the worker may take to start (font included) and to answer one
 *  batch. A worker that never answers must not keep the feed on skeletons
 *  (SPEC_AUDIT_FIXES.md, А8.1): past these, the page measures itself. */
export const WORKER_INIT_TIMEOUT_MS = 5_000;
export const WORKER_COMPUTE_TIMEOUT_MS = 20_000;
/** A worker that failed once is not waited for again in this window. */
let workerFailed = false;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

/// Identity of the current start attempt. A start abandoned by its time limit
/// must not install the worker it creates after the limit has passed.
let startAttempt = 0;

async function startWorker(attempt: number): Promise<void> {
  if (typeof Worker === "undefined") {
    throw new Error("Web Workers not supported in this environment");
  }
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("OffscreenCanvas not supported in this environment");
  }

  const fontBuffer = await fetchFontBuffer();
  if (attempt !== startAttempt) {
    throw new Error("Font-metrics worker start was abandoned");
  }
  const started = createWorker();
  worker = started;
  started.addEventListener("message", handleWorkerMessage);
  started.addEventListener("error", (e) => {
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
        started.removeEventListener("message", onMessage);
        resolve();
      } else if (event.data.type === "error" && event.data.requestId === initRequestId) {
        started.removeEventListener("message", onMessage);
        reject(new Error(event.data.message));
      }
    };
    started.addEventListener("message", onMessage);
    // A worker script that fails to load reports only this event.
    started.addEventListener("error", (event) => reject(new Error(`Worker failed to start: ${event.message}`)));
  });

  const initMessage: WorkerInMessage = {
    type: "init",
    requestId: initRequestId,
    fontBuffer,
    fontFamily: FONT_FAMILY,
  };
  started.postMessage(initMessage, [fontBuffer]);

  await initPromise;
}

/**
 * One start, shared by every caller, bounded once. The stored promise is the
 * bounded one: a second measurement that arrives while the first waits (a
 * collection switch, the next page) gives up at the same limit and measures
 * on the page, instead of waiting for a `ready` that a stopped worker never
 * sends (SPEC_AUDIT_FIXES.md, Б5.1).
 */
function ensureWorkerReady(): Promise<void> {
  if (workerReady) return workerReady;

  startAttempt += 1;
  const attempt = startAttempt;
  const bounded = withTimeout(startWorker(attempt), WORKER_INIT_TIMEOUT_MS, "Font-metrics worker start")
    .catch((err: unknown) => {
      if (attempt === startAttempt) {
        // Abandon this start: a font fetch still in flight must not create a
        // worker after the limit, and the next start begins from scratch.
        startAttempt += 1;
        worker?.terminate();
        worker = null;
        workerReady = null;
      }
      throw err;
    });
  workerReady = bounded;
  return bounded;
}

function computeInWorker(blocks: WorkerBlockInput[]): Promise<WorkerBlockResult[]> {
  if (!worker) {
    return Promise.reject(new Error("Worker not initialized"));
  }
  const requestId = nextRequestId++;
  const answer = new Promise<WorkerBlockResult[]>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
  });
  const promise = withTimeout(answer, WORKER_COMPUTE_TIMEOUT_MS, "Font-metrics worker").catch((err: unknown) => {
    pending.delete(requestId);
    throw err;
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
  // Measured as `Cards` shows it: the only presentation where a picture card
  // carries its name, and for every other card the same text as `Mixed`.
  // One measurement serves all three (SPEC_FEED_DISPLAY.md, Д15).
  const descriptor = deriveCardLayoutDescriptor(block, "cards");
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
    typeof candidate.previewSpace === "number" &&
    Array.isArray(candidate.titleNoSpaceBefore) &&
    Array.isArray(candidate.previewNoSpaceBefore)
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

  const workerInputs: WorkerBlockInput[] = missing.map((b) => {
    const identity = identitiesByBlockId.get(b.id);
    return {
      id: b.id,
      title: identity?.title ?? "",
      body: identity?.preview ?? "",
    };
  });

  // Worker/OffscreenCanvas absence is an expected capability fallback in
  // JSDOM and older WebViews: the conservative height fallback applies.
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return cached;
  }

  let computed: WorkerBlockResult[] | null = null;
  if (!workerFailed) {
    try {
      await ensureWorkerReady();
      computed = await computeInWorker(workerInputs);
    } catch (err) {
      // A broken font asset or worker bundle stays visible in the log; the
      // cards are measured anyway, on the page.
      workerFailed = true;
      console.warn("[fontMetrics] worker unavailable, measuring on the page", err);
    }
  }
  computed ??= await measureOnPage(workerInputs);
  if (!computed) return cached;

  // Fire-and-forget cache write — don't block on it
  void writeToCache(computed, identitiesByBlockId);

  const result = new Map<number, WordWidths>(cached);
  for (const entry of computed) {
    result.set(entry.id, entry.widths);
  }
  return result;
}

/** Cards measured on the page between two yields to the event loop. */
const PAGE_MEASURE_CHUNK = 200;

/**
 * Measure on the page's own canvas: the fallback when the worker cannot help.
 * The document font is the card font (`ensureFontLoaded` waited for it).
 */
async function measureOnPage(inputs: WorkerBlockInput[]): Promise<WorkerBlockResult[] | null> {
  if (typeof document === "undefined") return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  const results: WorkerBlockResult[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i]!;
    results.push({
      id: input.id,
      widths: computeWordWidths(context, input, TITLE_FONT_SPEC, PREVIEW_FONT_SPEC),
    });
    if ((i + 1) % PAGE_MEASURE_CHUNK === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return results;
}

/** How many cards from the top of the feed are measured before the rest. */
export const FIRST_MEASURED_BLOCKS = 48;

/**
 * Measure the top of the feed first and publish it before the rest. A card
 * renders as soon as its own widths are known; measuring a whole space before
 * showing any of it kept a newly opened space blank for seconds.
 */
export async function measureTopFirst(
  blocks: LightBlock[],
  fetch: (blocks: LightBlock[]) => Promise<Map<number, WordWidths>>,
  publish: (computed: Map<number, WordWidths>) => void,
  isCancelled: () => boolean,
): Promise<void> {
  publish(await fetch(blocks.slice(0, FIRST_MEASURED_BLOCKS)));
  const rest = blocks.slice(FIRST_MEASURED_BLOCKS);
  if (isCancelled() || rest.length === 0) return;
  publish(await fetch(rest));
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
  // A start still in flight belongs to the disposed worker.
  startAttempt += 1;
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerReady = null;
  pending.clear();
}
