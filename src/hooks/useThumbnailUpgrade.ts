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

/**
 * Mount once at the top of the app (inside `App.tsx`) after the vault is
 * open. Keeps a worker alive for the lifetime of the component.
 *
 * `enabled` gates startup enumeration and event subscription — pass
 * `false` while the vault is still being resolved to avoid spurious
 * calls to `list_pending_thumb_upgrades` against a stale state.
 */
export function useThumbnailUpgrade(enabled: boolean): void {
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
          // Non-fatal: keep the placeholder, log for diagnostic. Retried
          // automatically on the next startup via list_pending_thumb_upgrades.
          console.warn(`[thumb upgrade] ${msg.slug} failed: ${msg.error}`);
          return;
        }
        try {
          await saveThumb(msg.slug, new Uint8Array(msg.bytes));
        } catch (err) {
          console.warn(`[thumb upgrade] save_thumb ${msg.slug} failed:`, err);
        }
      };

      worker.onerror = (e) => {
        console.error("[thumb upgrade] worker error:", e.message);
      };

      // Drain startup backlog. Fire-and-forget: if it fails (vault not
      // open yet, race with another init path) the watcher events will
      // continue producing new upgrade requests and backlog retries
      // happen on next app start.
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
      const w = workerRef.current;
      if (!w) return;
      const id = `${nextIdRef.current++}`;
      pendingRef.current.set(id, { slug });
      const assetUrl = convertFileSrc(mediaPath);
      const req: ThumbWorkerRequest = {
        id,
        slug,
        assetUrl,
        kind,
        targetSize: 480,
      };
      w.postMessage(req);
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
