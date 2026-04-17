// useChannelPreviewsEvents — derived sidebar preview state.
//
// `channelPreviews` is a pure function of server state: frontend asks
// Rust `list_channel_previews` for the full picture, and renders what
// Rust returned. Tauri events (block:added / block:removed /
// thumb:updated) act as cache-invalidation SIGNALS, not mutations —
// each event triggers a coalesced refresh() (one per animation frame).
//
// Previously the hook patched `channelPreviews` from each event with
// its own dedup logic, which produced three independent writers with
// divergent predicates. Newly-saved blocks could be missed (initial
// snapshot didn't include them, thumb:updated only patches existing
// entries, block:added ran before the thumb file existed). The derived-
// state approach collapses the race surface to a single writer.
//
// `versionsRef` is kept — on `thumb:updated` we bump the per-slug
// version before the refresh fires. `listChannelPreviews` also returns
// mtime, so cross-session changes are handled via `?m=<mtime>`. Within
// a session, `?v=<counter>` takes precedence once the counter grows.
//
// Contract: SPEC_THUMBNAILS.md#phase-3-sidebar-update-event-driven

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { listChannelPreviews } from "@/lib/commands";
import { thumbnailUrl } from "@/lib/assets";
import type { PreviewCard } from "@/types";

interface ThumbUpdatedEvent {
  slug: string;
  is_text: boolean;
}

interface VaultChangedEvent {
  path: string;
}

interface Options {
  vaultPath: string | null;
  limit: number;
}

/**
 * Returns `channelPreviews` (a Map keyed by channel tag, plus `__all__`)
 * and a `refresh()` function for forced reload after imports or bulk
 * operations that bypass the normal event flow.
 */
export function useChannelPreviewsEvents({ vaultPath, limit }: Options): {
  channelPreviews: Map<string, PreviewCard[]>;
  refresh: () => Promise<void>;
} {
  const [channelPreviews, setChannelPreviews] = useState<Map<string, PreviewCard[]>>(
    () => new Map(),
  );

  // Per-slug cache-buster counter. Bumped on `thumb:updated`. Takes
  // precedence over mtime once it grows above 0 — needed because the
  // file's mtime can be stale on APFS when save_thumb writes to an
  // already-existing inode.
  const versionsRef = useRef<Map<string, number>>(new Map());

  const vaultPathRef = useRef(vaultPath);
  vaultPathRef.current = vaultPath;

  // Single source of truth for channelPreviews updates. All paths
  // (initial load, vault switch, events) funnel through here.
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
          const version = versionsRef.current.get(item.slug) ?? 0;
          // `?v=` wins over `?m=` within a session so events can force
          // a refetch even when the file's mtime appears unchanged.
          const query = version > 0
            ? `?v=${version}`
            : item.mtime > 0 ? `?m=${item.mtime}` : "";
          return {
            url: `${baseUrl}${query}`,
            text: item.text,
            hasThumb: item.has_thumb,
          };
        }),
      );
    }
    setChannelPreviews(next);
  }, [limit]);

  // Coalesce rapid event bursts into a single refresh per animation
  // frame. A save that fires block:added + thumb:updated within 16ms
  // triggers exactly one listChannelPreviews IPC call.
  const rafRef = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      void refresh();
    });
  }, [refresh]);

  // Initial load on mount / vault switch.
  useEffect(() => {
    void refresh();
  }, [vaultPath, refresh]);

  // Event subscriptions. Each event is a signal to re-read server
  // state. No state mutation here — scheduleRefresh() → refresh() is
  // the only writer of channelPreviews.
  useEffect(() => {
    if (!vaultPath) return;

    const unlistenFns: Array<() => void> = [];

    listen("block:added", () => scheduleRefresh())
      .then((fn) => unlistenFns.push(fn));

    listen("block:removed", () => scheduleRefresh())
      .then((fn) => unlistenFns.push(fn));

    listen<VaultChangedEvent>("vault-changed", (event) => {
      if (event.payload.path === vaultPathRef.current) {
        scheduleRefresh();
      }
    }).then((fn) => unlistenFns.push(fn));

    listen<ThumbUpdatedEvent>("thumb:updated", (event) => {
      const { slug } = event.payload;
      // Bump the cache-buster BEFORE scheduling refresh so the coalesced
      // IPC result builds URLs with the new `?v=N`.
      const version = (versionsRef.current.get(slug) ?? 0) + 1;
      versionsRef.current.set(slug, version);
      scheduleRefresh();
    }).then((fn) => unlistenFns.push(fn));

    return () => {
      for (const fn of unlistenFns) fn();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [vaultPath, scheduleRefresh]);

  return { channelPreviews, refresh };
}
