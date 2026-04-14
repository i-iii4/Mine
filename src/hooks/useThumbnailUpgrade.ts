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
// On success, writes decoded JPEG bytes back to Rust via `save_thumb`,
// which in turn emits `thumb:updated` — the sidebar cache-bust hook
// listens for that event. This keeps the data flow one-directional
// (worker → Rust → event → UI) and means the hook itself never needs
// to touch the sidebar state.
//
// Contract: SPEC_THUMBNAILS.md#contracts

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listPendingThumbUpgrades, saveThumb } from "@/lib/commands";
import type { ThumbWorkerRequest, ThumbWorkerResponse } from "@/workers/thumbWorker";

// Tauri event payload. Matches `ThumbUpgradeRequestedPayload` in
// src-tauri/src/watcher/handler.rs — keep the field names in sync.
interface ThumbUpgradeRequestedEvent {
  slug: string;
  mediaPath: string;
  kind: "image" | "video";
}

// ─── Video frame extraction (main thread) ───────────────────────────────────
//
// Creates a hidden <video>, seeks to 0.1s (skip black intro frames),
// draws the frame onto a <canvas>, encodes as JPEG. Runs on the main
// thread because Dedicated Workers have no DOM access for <video>.
// Concurrency is naturally limited by the browser's media decoder pool.

const JPEG_QUALITY = 0.85;
const VIDEO_TIMEOUT_MS = 10_000;
const BRIGHTNESS_THRESHOLD = 40;
// Seek positions to try — skip black fade-in frames.
// Relative to duration when > 1, absolute seconds otherwise.
const SEEK_CANDIDATES = [0.1, 0.5, 1, 2];

function extractVideoFrame(url: string, maxSize: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    let done = false;
    let candidateIdx = 0;
    let lastBlob: ArrayBuffer | null = null;

    const timer = setTimeout(() => finish(new Error("video decode timeout")), VIDEO_TIMEOUT_MS);

    function finish(err: Error): void;
    function finish(err: null, buf: ArrayBuffer): void;
    function finish(err: Error | null, buf?: ArrayBuffer) {
      if (done) return;
      done = true;
      clearTimeout(timer);
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

    video.onloadedmetadata = () => seekNext();

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

    // Lazy-spawn the worker on first mount. Vite's `?worker` import
    // wires up the bundler's worker transform; the result is a class
    // that constructs a real `Worker` when `new`ed.
    let cancelled = false;
    let worker: Worker | null = null;
    (async () => {
      const { default: ThumbWorker } = await import("@/workers/thumbWorker?worker");
      if (cancelled) return;
      worker = new ThumbWorker();
      workerRef.current = worker;

      worker.onmessage = async (event: MessageEvent<ThumbWorkerResponse>) => {
        const msg = event.data;
        pendingRef.current.delete(msg.id);
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

      try {
        const pending = await listPendingThumbUpgrades();
        for (const req of pending) {
          enqueue(req.slug, req.mediaPath, req.kind);
        }
      } catch (err) {
        console.warn("[thumb upgrade] startup enumeration failed:", err);
      }
    })();

    // Subscribe to live upgrade requests from the watcher.
    const unlistenPromise = listen<ThumbUpgradeRequestedEvent>(
      "thumb:upgrade-requested",
      (event) => {
        const { slug, mediaPath, kind } = event.payload;
        enqueue(slug, mediaPath, kind);
      },
    );

    function enqueue(slug: string, mediaPath: string, kind: "image" | "video") {
      const assetUrl = convertFileSrc(mediaPath);

      // Video: decode on main thread via <video> + <canvas>.
      // Dedicated Workers have no DOM, so <video> is unavailable there.
      if (kind === "video") {
        decodeVideoOnMainThread(slug, assetUrl);
        return;
      }

      // Image: send to worker (createImageBitmap, off-main-thread).
      const w = workerRef.current;
      if (!w) return;
      const id = `${nextIdRef.current++}`;
      pendingRef.current.set(id, { slug });
      const req: ThumbWorkerRequest = {
        id,
        slug,
        assetUrl,
        kind,
        targetSize: 480,
      };
      w.postMessage(req);
    }

    async function decodeVideoOnMainThread(slug: string, url: string) {
      try {
        const bytes = await extractVideoFrame(url, 480);
        await saveThumb(slug, new Uint8Array(bytes));
        onUpgraded?.();
      } catch (err) {
        console.warn(`[thumb upgrade] video ${slug} failed:`, err);
      }
    }

    return () => {
      cancelled = true;
      unlistenPromise.then((fn) => fn());
      // Cancel in-flight work, then terminate. The worker tears down
      // its fetch AbortControllers on "cancel"; terminate() is the
      // hard stop that guarantees no response lands after unmount.
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
