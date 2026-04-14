// useChannelPreviewsEvents — event-driven sidebar preview cards.
//
// Replaces the polling `listChannelPreviews` loop (vault-changed →
// 500ms debounce → full reload) with a one-time initial load plus
// incremental patching based on Tauri events. Latency from "block
// saved" to "preview visible in sidebar" drops from ~500ms to ~110ms
// (watcher debounce 100ms + IPC + React update).
//
// Events consumed:
//   block:added      — prepend a PreviewCard to every affected channel
//   block:removed    — strip the slug from every affected channel
//   thumb:updated    — cache-bust the PreviewCard.url for that slug
//
// The initial snapshot still comes from `listChannelPreviews(limit)`,
// so legacy behavior (correct ordering, per-channel caps) is preserved
// on cold start and on vault switch.
//
// Contract: SPEC_THUMBNAILS.md#phase-3-sidebar-update-event-driven

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { listChannelPreviews } from "@/lib/commands";
import { thumbnailUrl } from "@/lib/assets";
import type { PreviewCard } from "@/types";

// Payload shapes must match the Serialize structs in
// src-tauri/src/watcher/handler.rs. Field names are snake_case because
// we don't use `#[serde(rename_all = "camelCase")]` on those payloads.
interface BlockAddedEvent {
  slug: string;
  tags: string[];
  is_text: boolean;
}

interface BlockRemovedEvent {
  slug: string;
  tags: string[];
}

interface ThumbUpdatedEvent {
  slug: string;
  is_text: boolean;
}

const ALL_KEY = "__all__";

interface Options {
  vaultPath: string | null;
  limit: number;
}

/**
 * Returns `channelPreviews` (a Map keyed by channel tag, plus `__all__`)
 * and a `refresh()` function for forced reload after imports or bulk
 * operations that bypass the normal add/remove flow.
 */
export function useChannelPreviewsEvents({ vaultPath, limit }: Options): {
  channelPreviews: Map<string, PreviewCard[]>;
  refresh: () => Promise<void>;
} {
  const [channelPreviews, setChannelPreviews] = useState<Map<string, PreviewCard[]>>(
    () => new Map(),
  );

  // Cache-buster version per slug. Incrementing this forces React to
  // re-render `<img>` elements with a fresh `?v=N` query param, which
  // WKWebView treats as a new URL and refetches from the asset protocol.
  const versionsRef = useRef<Map<string, number>>(new Map());

  const vaultPathRef = useRef(vaultPath);
  vaultPathRef.current = vaultPath;

  // Build a PreviewCard from a slug using the current vaultPath and
  // cache-buster state. Called by all the incremental patches.
  const buildCard = useCallback(
    (slug: string, isText: boolean): PreviewCard | null => {
      const vp = vaultPathRef.current;
      if (!vp) return null;
      const version = versionsRef.current.get(slug) ?? 0;
      const baseUrl = thumbnailUrl(vp, slug);
      const url = version > 0 ? `${baseUrl}?v=${version}` : baseUrl;
      return { url, text: isText };
    },
    [],
  );

  // Forced full reload. Used for the initial mount and from callers
  // that change state the event stream can't describe (vault switch,
  // import finished, manual rebuild_index, …).
  //
  // Each URL gets `?m=<mtime>` where mtime is the thumb file's last
  // modification time (unix seconds, from Rust stat()). The browser
  // treats a new mtime as a new URL and refetches from disk. Files
  // that haven't changed keep the same URL and are served from cache.
  const refresh = useCallback(async () => {
    const vp = vaultPathRef.current;
    if (!vp) {
      setChannelPreviews(new Map());
      return;
    }
    const raw = await listChannelPreviews(limit);
    const next = new Map<string, PreviewCard[]>();
    for (const [key, items] of Object.entries(raw)) {
      next.set(
        key,
        items.map((item) => {
          const baseUrl = thumbnailUrl(vp, item.slug);
          const url = item.mtime > 0 ? `${baseUrl}?m=${item.mtime}` : baseUrl;
          return { url, text: item.text };
        }),
      );
    }
    setChannelPreviews(next);
  }, [limit, buildCard]);

  // Initial load whenever the vault changes. Subscription setup happens
  // in the next effect so the two concerns stay separable.
  useEffect(() => {
    refresh();
  }, [vaultPath, refresh]);

  // Event subscriptions. One useEffect for all three so we only wire up
  // one set of listeners per mount.
  useEffect(() => {
    if (!vaultPath) return;

    const unlistenFns: Array<() => void> = [];

    listen<BlockAddedEvent>("block:added", (event) => {
      const { slug, tags, is_text } = event.payload;
      const card = buildCard(slug, is_text);
      if (!card) return;
      const keys = [ALL_KEY, ...tags];
      setChannelPreviews((prev) => {
        const next = new Map(prev);
        for (const key of keys) {
          const existing = next.get(key) ?? [];
          // Dedupe: if the slug already appears, drop the old entry so
          // the new one lands at the front. Covers the "re-save the
          // same block" case.
          const filtered = existing.filter((c) => !c.url.includes(`/${slug}.jpg`));
          next.set(key, [card, ...filtered].slice(0, limit));
        }
        return next;
      });
    }).then((fn) => unlistenFns.push(fn));

    listen<BlockRemovedEvent>("block:removed", (event) => {
      const { slug, tags } = event.payload;
      const keys = [ALL_KEY, ...tags];
      setChannelPreviews((prev) => {
        const next = new Map(prev);
        for (const key of keys) {
          const existing = next.get(key);
          if (!existing) continue;
          const filtered = existing.filter(
            (c) => !c.url.includes(`/${slug}.jpg`),
          );
          if (filtered.length !== existing.length) {
            next.set(key, filtered);
          }
        }
        return next;
      });
      versionsRef.current.delete(slug);
    }).then((fn) => unlistenFns.push(fn));

    listen<ThumbUpdatedEvent>("thumb:updated", (event) => {
      const { slug, is_text } = event.payload;
      // Bump cache-buster and update the text flag. When Phase 2
      // upgrades a PNG placeholder to a decoded JPEG, is_text flips
      // from true to false so dark:invert is removed in the same
      // render pass as the URL update.
      const version = (versionsRef.current.get(slug) ?? 0) + 1;
      versionsRef.current.set(slug, version);
      const vp = vaultPathRef.current;
      if (!vp) return;
      const base = thumbnailUrl(vp, slug);
      const fresh = `${base}?v=${version}`;
      setChannelPreviews((prev) => {
        let changed = false;
        const next = new Map<string, PreviewCard[]>();
        for (const [key, items] of prev) {
          let hit = false;
          const updated = items.map((c) => {
            if (c.url.includes(`/${slug}.jpg`)) {
              hit = true;
              return { url: fresh, text: is_text };
            }
            return c;
          });
          if (hit) {
            changed = true;
            next.set(key, updated);
          } else {
            next.set(key, items);
          }
        }
        return changed ? next : prev;
      });
    }).then((fn) => unlistenFns.push(fn));

    return () => {
      for (const fn of unlistenFns) fn();
    };
  }, [vaultPath, buildCard, limit]);

  return { channelPreviews, refresh };
}
