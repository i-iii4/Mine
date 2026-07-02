// useThumbnailUpgrade — Phase 2 thumbnail upgrade pipeline.
//
// Owns a single Web Worker instance (`src/workers/thumbWorker.ts`) and
// connects it to two sources of work:
//
//   1. `thumb:upgrade-requested` Tauri events (fired by the watcher when
//      Phase 1 produced a text placeholder for an upgradable block)
//   2. `list_pending_thumb_upgrades` command at app startup (drains the
//      backlog of placeholders left over from previous sessions, from
//      the clipper running while the main app was closed, etc.)
//
// Images decode off-main-thread in the worker (`createImageBitmap`).
// Videos have to decode on the main thread — a `<video>` element is
// unavailable inside a Dedicated Worker — so they run through a
// `DecodeQueue` that bounds parallelism, deduplicates by target, and
// retries a failed decode once per session. Both paths dedup the startup
// backlog against live events so no target is processed twice.
//
// On success, writes decoded JPEG bytes back to Rust via `save_thumb` /
// `save_tile_poster`, which in turn emit `thumb:updated` — the sidebar
// cache-bust hook listens for that event. This keeps the data flow
// one-directional (decode → Rust → event → UI) and means the hook itself
// never needs to touch the sidebar state.
//
// Contract: SPEC_THUMBNAILS.md#contracts

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listPendingThumbUpgrades, saveThumb, saveTilePoster } from "@/lib/commands";
import type { TilePosterUpgrade } from "@/lib/commands";
import { DecodeQueue } from "@/lib/decodeQueue";
import { planThumbUpgrade } from "@/lib/thumbUpgradePlan";
import type { ThumbUpgradeInput } from "@/lib/thumbUpgradePlan";
import type { ThumbWorkerRequest, ThumbWorkerResponse } from "@/workers/thumbWorker";

// Tauri event payload. Matches `ThumbUpgradeRequestedPayload` in
// src-tauri/src/watcher/handler.rs — keep the field names in sync.
interface ThumbUpgradeRequestedEvent {
  slug: string;
  mediaPath: string;
  kind: "image" | "video";
  /** Per-video gallery tile posters; absent for non-gallery blocks. */
  tilePosters?: TilePosterUpgrade[];
}

// ─── Tuning constants ────────────────────────────────────────────────────────

const JPEG_QUALITY = 0.85;
const BRIGHTNESS_THRESHOLD = 40;
// Max side of a decoded thumb, in px. Matches the Rust-side thumbnail size so
// sidebar resolution stays consistent regardless of which decoder produced it.
export const THUMB_UPGRADE_TARGET_PX = 640;
// Budget for the browser to deliver `loadedmetadata` after the <video> src is
// set — this covers time spent queued in the media-decoder pool.
export const VIDEO_METADATA_TIMEOUT_MS = 15_000;
// Budget for capturing a usable frame once metadata has loaded. Kept separate
// from the metadata wait so pool queueing never eats the decode budget.
export const VIDEO_DECODE_TIMEOUT_MS = 10_000;
// Parallel main-thread video decodes. Two keeps the media-decoder pool from
// starving the tail without serializing the whole backlog.
export const VIDEO_DECODE_CONCURRENCY = 2;
// Backoff before the single in-session retry of a failed video decode.
export const VIDEO_DECODE_RETRY_DELAY_MS = 30_000;
// Retries per target per session, beyond the first attempt.
export const VIDEO_DECODE_MAX_RETRIES = 1;

// Seek positions to try — skip black fade-in frames.
// Relative to duration when > 1, absolute seconds otherwise.
const SEEK_CANDIDATES = [0.1, 0.5, 1, 2];

// ─── Video frame extraction (main thread) ───────────────────────────────────
//
// Creates a hidden <video>, seeks past black intro frames, draws the frame
// onto a <canvas>, encodes as JPEG. Runs on the main thread because Dedicated
// Workers have no DOM access for <video>. Parallelism is bounded by the
// DecodeQueue in the hook below.

function extractVideoFrame(url: string, maxSize: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    let done = false;
    let candidateIdx = 0;
    let lastBlob: ArrayBuffer | null = null;

    // Two honest budgets: waiting for metadata (element created →
    // loadedmetadata) and decoding a usable frame (loadedmetadata → captured
    // frame). A single timer started at element creation would charge time
    // spent merely queued in the browser's media-decoder pool against the
    // decode budget, timing out slow-to-start videos before they ever decode.
    let metadataTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => finish(new Error("video metadata timeout")),
      VIDEO_METADATA_TIMEOUT_MS,
    );
    let decodeTimer: ReturnType<typeof setTimeout> | null = null;

    function clearTimers() {
      if (metadataTimer !== null) {
        clearTimeout(metadataTimer);
        metadataTimer = null;
      }
      if (decodeTimer !== null) {
        clearTimeout(decodeTimer);
        decodeTimer = null;
      }
    }

    function finish(err: Error): void;
    function finish(err: null, buf: ArrayBuffer): void;
    function finish(err: Error | null, buf?: ArrayBuffer) {
      if (done) return;
      done = true;
      clearTimers();
      video.removeAttribute("src");
      video.load();
      if (err) reject(err); else resolve(buf!);
    }

    function seekNext() {
      if (candidateIdx >= SEEK_CANDIDATES.length) {
        // All candidates tried — use last captured frame (even if dark)
        if (lastBlob) { finish(null, lastBlob); return; }
        // Fallback: try 25% of duration
        video.currentTime = video.duration * 0.25;
        return;
      }
      const t = SEEK_CANDIDATES[candidateIdx]!;
      video.currentTime = Math.min(t, video.duration * 0.9);
      candidateIdx++;
    }

    video.onloadedmetadata = () => {
      // Metadata arrived — start the decode budget and stop the metadata one.
      if (metadataTimer !== null) {
        clearTimeout(metadataTimer);
        metadataTimer = null;
      }
      decodeTimer = setTimeout(
        () => finish(new Error("video decode timeout")),
        VIDEO_DECODE_TIMEOUT_MS,
      );
      seekNext();
    };

    video.onseeked = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw === 0 || vh === 0) { finish(new Error("video has zero dimensions")); return; }

      const scale = Math.min(1, maxSize / Math.max(vw, vh));
      const w = Math.max(1, Math.round(vw * scale));
      const h = Math.max(1, Math.round(vh * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) { finish(new Error("canvas 2d unavailable")); return; }

      ctx.drawImage(video, 0, 0, w, h);

      // Check average brightness — skip near-black frames
      const sample = ctx.getImageData(0, 0, w, h).data;
      let sum = 0;
      const step = 40; // sample every 10th pixel (4 channels × 10)
      let count = 0;
      for (let i = 0; i < sample.length; i += step) {
        sum += sample[i]! + sample[i + 1]! + sample[i + 2]!;
        count += 3;
      }
      const avgBrightness = count > 0 ? sum / count : 0;

      canvas.toBlob(
        (blob) => {
          if (!blob) { finish(new Error("toBlob returned null")); return; }
          blob.arrayBuffer().then(
            (buf) => {
              lastBlob = buf;
              if (avgBrightness >= BRIGHTNESS_THRESHOLD) {
                finish(null, buf);
              } else {
                seekNext();
              }
            },
            (e) => finish(e instanceof Error ? e : new Error(String(e))),
          );
        },
        "image/jpeg",
        JPEG_QUALITY,
      );
    };

    video.onerror = () => finish(new Error(`video load failed: ${url.split("/").pop()}`));
    video.src = url;
  });
}

/**
 * Mount once at the top of the app (inside `App.tsx`) after the vault is
 * open. Keeps a worker alive for the lifetime of the component.
 *
 * `enabled` gates startup enumeration and event subscription — pass
 * `false` while the vault is still being resolved to avoid spurious
 * calls to `list_pending_thumb_upgrades` against a stale state.
 */
export function useThumbnailUpgrade(enabled: boolean, onUpgraded?: () => void): void {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<string, { slug: string }>>(new Map());
  const nextIdRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let worker: Worker | null = null;

    // Dedup for the image (worker) path, keyed by slug. Cleared when the
    // worker replies. The video/tile dedup lives inside `videoQueue`.
    const imageInFlight = new Set<string>();
    // Image requests that arrived while the worker was still spawning; drained
    // once it is ready so an event in that window is never dropped.
    const preWorkerImages: { slug: string; assetUrl: string }[] = [];

    const videoQueue = new DecodeQueue({
      concurrency: VIDEO_DECODE_CONCURRENCY,
      retryDelayMs: VIDEO_DECODE_RETRY_DELAY_MS,
      maxRetries: VIDEO_DECODE_MAX_RETRIES,
      onGaveUp: (key, error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[thumb upgrade] ${key} gave up after retry: ${message}`);
      },
    });

    function postImageToWorker(slug: string, assetUrl: string) {
      const w = workerRef.current;
      if (!w) return;
      const id = `${nextIdRef.current++}`;
      pendingRef.current.set(id, { slug });
      const req: ThumbWorkerRequest = {
        id,
        slug,
        assetUrl,
        kind: "image",
        targetSize: THUMB_UPGRADE_TARGET_PX,
      };
      w.postMessage(req);
    }

    function enqueueImage(slug: string, assetUrl: string) {
      if (imageInFlight.has(slug)) return;
      imageInFlight.add(slug);
      if (!workerRef.current) {
        preWorkerImages.push({ slug, assetUrl });
        return;
      }
      postImageToWorker(slug, assetUrl);
    }

    function enqueueVideo(key: string, slug: string, assetUrl: string) {
      videoQueue.enqueue(key, async () => {
        const bytes = await extractVideoFrame(assetUrl, THUMB_UPGRADE_TARGET_PX);
        if (cancelled) return;
        await saveThumb(slug, new Uint8Array(bytes));
        onUpgraded?.();
      });
    }

    function enqueueTilePoster(key: string, slug: string, tile: TilePosterUpgrade) {
      videoQueue.enqueue(key, async () => {
        const bytes = await extractVideoFrame(convertFileSrc(tile.mediaPath), THUMB_UPGRADE_TARGET_PX);
        if (cancelled) return;
        await saveTilePoster(tile.posterName, slug, new Uint8Array(bytes));
        onUpgraded?.();
      });
    }

    function dispatch(input: ThumbUpgradeInput) {
      for (const action of planThumbUpgrade(input)) {
        switch (action.kind) {
          case "image":
            enqueueImage(action.slug, convertFileSrc(action.mediaPath));
            break;
          case "video":
            enqueueVideo(action.key, action.slug, convertFileSrc(action.mediaPath));
            break;
          case "tile":
            enqueueTilePoster(action.key, action.slug, action.tile);
            break;
        }
      }
    }

    async function enumeratePending() {
      try {
        const pending = await listPendingThumbUpgrades();
        if (cancelled) return;
        for (const req of pending) {
          dispatch(req);
        }
      } catch (err) {
        console.warn("[thumb upgrade] startup enumeration failed:", err);
      }
    }

    // Lazy-spawn the worker on first mount. Vite's `?worker` import wires up
    // the bundler's worker transform; the result is a class that constructs a
    // real `Worker` when `new`ed.
    (async () => {
      const { default: ThumbWorker } = await import("@/workers/thumbWorker?worker");
      if (cancelled) return;
      worker = new ThumbWorker();
      workerRef.current = worker;

      worker.onmessage = async (event: MessageEvent<ThumbWorkerResponse>) => {
        const msg = event.data;
        const entry = pendingRef.current.get(msg.id);
        pendingRef.current.delete(msg.id);
        if (entry) imageInFlight.delete(entry.slug);
        if (!msg.ok) {
          console.warn(`[thumb upgrade] ${msg.slug} failed: ${msg.error}`);
          return;
        }
        try {
          await saveThumb(msg.slug, new Uint8Array(msg.bytes));
          onUpgraded?.();
        } catch (err) {
          console.warn(`[thumb upgrade] save_thumb ${msg.slug} failed:`, err);
        }
      };

      worker.onerror = (e) => {
        console.error("[thumb upgrade] worker error:", e.message);
      };

      // Drain image requests buffered while the worker was spawning.
      for (const buffered of preWorkerImages) {
        postImageToWorker(buffered.slug, buffered.assetUrl);
      }
      preWorkerImages.length = 0;

      await enumeratePending();
    })();

    // Subscribe to live upgrade requests from the watcher.
    const unlistenPromise = listen<ThumbUpgradeRequestedEvent>(
      "thumb:upgrade-requested",
      (event) => dispatch(event.payload),
    );

    // Close the listen race: an event fired between the startup enumeration
    // and the subscription becoming active would otherwise be lost. Once the
    // subscription is registered, re-enumerate — dedup drops anything already
    // queued or in-flight, so only genuinely-missed work survives.
    unlistenPromise.then(() => {
      if (!cancelled) void enumeratePending();
    });

    return () => {
      cancelled = true;
      unlistenPromise.then((fn) => fn());
      videoQueue.dispose();
      // Cancel in-flight worker work, then terminate. The worker tears down
      // its fetch AbortControllers on "cancel"; terminate() is the hard stop
      // that guarantees no response lands after unmount.
      if (worker) {
        try {
          worker.postMessage({ type: "cancel" });
        } catch {
          /* worker may already be dead */
        }
        worker.terminate();
      }
      workerRef.current = null;
      pendingRef.current.clear();
    };
  }, [enabled]);
}
