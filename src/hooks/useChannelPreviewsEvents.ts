// useChannelPreviewsEvents — derived sidebar preview state.
//
// `channelPreviews` is a pure function of server state: frontend asks
// Rust `list_channel_previews` for the full picture, and renders what
// Rust returned. Tauri events are handled one layer up in App.tsx by the
// central invalidation scheduler; this hook only owns snapshot reads plus
// per-slug cache-buster versions for refreshed thumbnails.
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
import { listChannelPreviews } from "@/lib/commands";
import { thumbnailUrl } from "@/lib/assets";
import type { PreviewCard } from "@/types";
import type { ProjectionRevisionOwner } from "./useProjectionRevisionOwner";

interface Options {
  thumbsRootPath: string | null;
  limit: number;
  revisionOwner?: ProjectionRevisionOwner;
}

/**
 * Returns `channelPreviews` (a Map keyed by channel tag, plus `__all__`)
 * and a `refresh()` function for forced reload after imports or bulk
 * operations that bypass the normal event flow.
 */
export function useChannelPreviewsEvents({ thumbsRootPath, limit, revisionOwner }: Options): {
  channelPreviews: Map<string, PreviewCard[]>;
  refresh: () => Promise<void>;
  bumpThumbVersion: (slug: string) => void;
} {
  const [channelPreviews, setChannelPreviews] = useState<Map<string, PreviewCard[]>>(
    () => new Map(),
  );

  // Per-slug cache-buster counter. Bumped on `thumb:updated`. Takes
  // precedence over mtime once it grows above 0 — needed because the
  // file's mtime can be stale on APFS when save_thumb writes to an
  // already-existing inode.
  const versionsRef = useRef<Map<string, number>>(new Map());

  const thumbsRootPathRef = useRef(thumbsRootPath);
  thumbsRootPathRef.current = thumbsRootPath;
  const refreshRequestIdRef = useRef(0);
  const lastRecoveryRefreshAtRef = useRef(0);

  // Single source of truth for channelPreviews updates. App-level invalidation
  // calls `refresh()`, while this hook stays a pure reader/cache-buster.
  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestIdRef.current;
    const root = thumbsRootPathRef.current;
    if (!root) {
      if (refreshRequestIdRef.current === requestId) {
        setChannelPreviews(new Map());
      }
      return;
    }
    const raw = await listChannelPreviews(limit);
    if (
      refreshRequestIdRef.current !== requestId
      || thumbsRootPathRef.current !== root
    ) {
      return;
    }
    if (revisionOwner && !revisionOwner.accept("sidebar-previews", raw.generation)) {
      return;
    }
    const next = new Map<string, PreviewCard[]>();
    for (const [key, items] of Object.entries(raw.previews)) {
      if (!items) continue;
      next.set(
        key,
        items.filter((item) => item.has_thumb).map((item) => {
          const baseUrl = thumbnailUrl(root, item.slug);
          const version = versionsRef.current.get(item.slug) ?? 0;
          // `?v=` wins over `?m=` within a session so events can force
          // a refetch even when the file's mtime appears unchanged.
          const query = version > 0
            ? `?v=${version}`
            : item.mtime > 0 ? `?m=${item.mtime}` : "";
          return {
            slug: item.slug,
            url: `${baseUrl}${query}`,
            text: item.text,
            hasThumb: item.has_thumb,
          };
        }),
      );
    }
    setChannelPreviews(next);
  }, [limit, revisionOwner]);

  // Initial load on mount / vault switch.
  useEffect(() => {
    versionsRef.current.clear();
    void refresh();
  }, [thumbsRootPath, refresh]);

  useEffect(() => {
    const runRecoveryRefresh = () => {
      if (!thumbsRootPathRef.current) return;
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRecoveryRefreshAtRef.current < 1000) return;
      lastRecoveryRefreshAtRef.current = now;
      void refresh();
    };

    window.addEventListener("focus", runRecoveryRefresh);
    window.addEventListener("vault-refreshed", runRecoveryRefresh);
    document.addEventListener("visibilitychange", runRecoveryRefresh);
    return () => {
      window.removeEventListener("focus", runRecoveryRefresh);
      window.removeEventListener("vault-refreshed", runRecoveryRefresh);
      document.removeEventListener("visibilitychange", runRecoveryRefresh);
    };
  }, [refresh]);

  const bumpThumbVersion = useCallback((slug: string) => {
    const version = (versionsRef.current.get(slug) ?? 0) + 1;
    versionsRef.current.set(slug, version);
  }, []);

  return { channelPreviews, refresh, bumpThumbVersion };
}
