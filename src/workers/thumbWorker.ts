/// <reference lib="webworker" />

// Thumbnail Web Worker.
//
// Phase 2 of the two-phase thumbnail pipeline (SPEC_THUMBNAILS.md). Runs
// off-main-thread so sidebar scroll and grid re-layout stay at 60+ FPS
// while hundreds of placeholder thumbs get upgraded to real JPEGs in
// the background.
//
// Protocol:
//   main → worker: { id, slug, assetUrl, kind, targetSize }
//                  { type: 'cancel' }
//   worker → main: { id, slug, ok: true,  bytes: ArrayBuffer }
//                  { id, slug, ok: false, error: string }
//
// The decoded JPEG bytes are sent back via a transfer list so no copy
// crosses the thread boundary. Main thread then ships them to Rust via
// the `save_thumb` IPC command.
//
// Concurrency: FIFO queue, four parallel in-flight requests. Main thread
// can drain the queue and abort in-flight fetches with a single
// `{ type: 'cancel' }` message (e.g. when the vault changes).

declare const self: DedicatedWorkerGlobalScope;

// ─── Protocol types ─────────────────────────────────────────────────────────

export interface ThumbWorkerRequest {
  id: string;
  slug: string;
  assetUrl: string;
  kind: "image" | "video";
  targetSize?: number;
}

interface CancelMessage {
  type: "cancel";
}

type IncomingMessage = ThumbWorkerRequest | CancelMessage;

export type ThumbWorkerResponse =
  | { id: string; slug: string; ok: true; bytes: ArrayBuffer }
  | { id: string; slug: string; ok: false; error: string };

// ─── Queue state ────────────────────────────────────────────────────────────

const MAX_CONCURRENCY = 4;
const DEFAULT_TARGET = 640;
const JPEG_QUALITY = 0.85;

interface QueueEntry {
  req: ThumbWorkerRequest;
  abort: AbortController;
}

const waiting: QueueEntry[] = [];
const active = new Set<QueueEntry>();

// ─── Message entry point ────────────────────────────────────────────────────

self.addEventListener("message", (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;
  if ("type" in msg && msg.type === "cancel") {
    cancelAll();
    return;
  }
  // Enqueue and try to start work
  const entry: QueueEntry = {
    req: msg as ThumbWorkerRequest,
    abort: new AbortController(),
  };
  waiting.push(entry);
  pump();
});

function cancelAll() {
  // Abort every in-flight fetch; their error paths will clean up `active`
  // and call pump() again, which will find `waiting` empty.
  for (const entry of active) {
    entry.abort.abort();
  }
  // Drop pending queue — they'll never be posted back to main
  waiting.length = 0;
}

function pump() {
  while (active.size < MAX_CONCURRENCY && waiting.length > 0) {
    const entry = waiting.shift()!;
    active.add(entry);
    runEntry(entry).finally(() => {
      active.delete(entry);
      pump();
    });
  }
}

// ─── Per-request pipeline ───────────────────────────────────────────────────

async function runEntry(entry: QueueEntry): Promise<void> {
  const { req, abort } = entry;
  const targetSize = req.targetSize ?? DEFAULT_TARGET;
  try {
    const blob = await fetchAsset(req.assetUrl, abort.signal);
    const bitmap =
      req.kind === "image"
        ? await decodeImage(blob)
        : await decodeVideoFrame(blob);
    const bytes = await encodeJpeg(bitmap, targetSize);
    bitmap.close();
    postResponse({ id: req.id, slug: req.slug, ok: true, bytes }, [bytes]);
  } catch (err) {
    if (abort.signal.aborted) {
      // Swallow — main thread requested cancel, no response expected
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    postResponse({ id: req.id, slug: req.slug, ok: false, error: message });
  }
}

async function fetchAsset(url: string, signal: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  return await res.blob();
}

/// Decode a raster image blob to an ImageBitmap via the native browser
/// decoder. This is the whole reason the worker exists — WKWebView can
/// read VP8X WebP, HEIC, AVIF, and other formats that the Rust `image`
/// crate chokes on. `createImageBitmap` is available in every WKWebView
/// version Mine supports.
async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return await createImageBitmap(blob);
}

/// Decode the first frame of a video blob. WKWebView does not ship
/// `VideoDecoder` in every version, so we use the always-available
/// `<video>` element path: load the blob, seek to frame 0, then draw
/// onto an OffscreenCanvas and snapshot.
///
/// Note: a `<video>` element is NOT available inside a Dedicated
/// Worker on WKWebView. If the user ever opens a vault with many
/// videos, we'd need a main-thread fallback — tracked in
/// SPEC_THUMBNAILS.md Q1. For now: attempt `VideoDecoder` if available,
/// otherwise fail with a clear error and let the main thread handle it.
async function decodeVideoFrame(_blob: Blob): Promise<ImageBitmap> {
  // Feature-detect the modern VideoDecoder API
  const hasVideoDecoder = typeof (self as unknown as { VideoDecoder?: unknown }).VideoDecoder !== "undefined";
  if (!hasVideoDecoder) {
    throw new Error(
      "video decode requires VideoDecoder API or main-thread fallback",
    );
  }
  // VideoDecoder path is non-trivial: need to demux the container,
  // find the first keyframe, feed it to the decoder, capture the
  // output frame. Out of scope for the initial worker — videos
  // currently fall back to the text placeholder, same as HEIC on
  // unsupported platforms. Leaves room for a future PR.
  throw new Error("video thumbnail decode not yet implemented in worker");
}

/// Resize `bitmap` to fit within `max × max` preserving aspect ratio
/// and encode as JPEG. The max-side convention matches Rust
/// `DEFAULT_MAX_SIZE = 640` so sidebar thumb resolution stays
/// consistent regardless of which decoder path produced it.
async function encodeJpeg(
  bitmap: ImageBitmap,
  maxSize: number,
): Promise<ArrayBuffer> {
  const { width: w0, height: h0 } = bitmap;
  const scale = Math.min(1, maxSize / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("OffscreenCanvas 2d context unavailable");
  }
  // Opaque background for JPEG — prevents black fringes on transparent
  // sources (VP8X WebP with alpha, PNG-as-placeholder).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);

  const blob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: JPEG_QUALITY,
  });
  return await blob.arrayBuffer();
}

// ─── Reply helper ───────────────────────────────────────────────────────────

function postResponse(
  msg: ThumbWorkerResponse,
  transfer: Transferable[] = [],
): void {
  // Typed postMessage accepting a transfer list. `bytes` in the success
  // case is moved (not copied) to the main thread.
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void })
    .postMessage(msg, transfer);
}
