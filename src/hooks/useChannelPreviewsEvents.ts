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
// The read is the whole list of every collection, not a page of it
// (SPEC_SIDEBAR_STRIP.md, ЛМ1): a strip draws as many cards as its width
// holds, and a wider strip takes the next ones from the list it has. A read
// answers with every card again, so the hook keeps what did not change: a
// card with the same address is the same object, a list with the same cards
// the same array, and only the rows whose list changed render.
//
// Contract: SPEC_THUMBNAILS.md#phase-3-sidebar-update-event-driven

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { listChannelPreviews } from "@/lib/commands";
import { thumbnailLevelUrl } from "@/lib/assets";
import { releaseStripPicturesExcept } from "@/lib/stripPictures";
import type { PreviewCard, PreviewItem } from "@/types";
import type { ProjectionRevisionOwner } from "./useProjectionRevisionOwner";

interface Options {
  thumbsRootPath: string | null;
  revisionOwner?: ProjectionRevisionOwner;
}

/** A card as the last read made it, with what its address was built from. */
interface KnownCard {
  card: PreviewCard;
  mtime: number;
  version: number;
}

/** The card a read's `item` stands for: the one this read already made for
 *  another row, the one the last read made when nothing its address or look
 *  comes from changed, a new one otherwise. `made` collects this read's. */
function previewCard(
  item: PreviewItem,
  root: string,
  version: number,
  known: Map<string, KnownCard>,
  made: Map<string, KnownCard>,
): PreviewCard {
  const current = made.get(item.slug);
  if (current) return current.card;
  const previous = known.get(item.slug);
  if (
    previous
    && previous.mtime === item.mtime
    && previous.version === version
    && previous.card.text === item.text
  ) {
    made.set(item.slug, previous);
    return previous.card;
  }
  // The strip draws 32 logical pixels: the `micro` level, never the full
  // thumbnail of 640 (SPEC_SIDEBAR_STRIP.md, ЛМ4; SPEC_THUMBNAILS.md, П4).
  // `?v=` wins over `?m=` within a session so events can force a refetch
  // even when the file's mtime appears unchanged.
  const query = version > 0
    ? `?v=${version}`
    : item.mtime > 0 ? `?m=${item.mtime}` : "";
  const card: PreviewCard = {
    slug: item.slug,
    url: `${thumbnailLevelUrl(root, item.slug, "micro")}${query}`,
    text: item.text,
    hasThumb: item.has_thumb,
  };
  made.set(item.slug, { card, mtime: item.mtime, version });
  return card;
}

/** `next` unless it holds exactly the cards of `previous`, in order. */
function sameListOr(previous: PreviewCard[] | undefined, next: PreviewCard[]): PreviewCard[] {
  if (!previous || previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return next;
  }
  return previous;
}

/**
 * Returns `channelPreviews` (a Map keyed by channel tag, plus `__all__`)
 * and a `refresh()` function for forced reload after imports or bulk
 * operations that bypass the normal event flow.
 */
export function useChannelPreviewsEvents({ thumbsRootPath, revisionOwner }: Options): {
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
  // The cards the last read made, by slug: one object per card, shared by
  // every row it stands in and kept across reads while its address holds.
  const knownCardsRef = useRef<Map<string, KnownCard>>(new Map());

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
        releaseStripPicturesExcept(new Set());
        setChannelPreviews(new Map());
      }
      return;
    }
    const raw = await listChannelPreviews();
    if (
      refreshRequestIdRef.current !== requestId
      || thumbsRootPathRef.current !== root
    ) {
      return;
    }
    if (revisionOwner && !revisionOwner.accept("sidebar-previews", raw.generation)) {
      return;
    }
    const known = knownCardsRef.current;
    const made = new Map<string, KnownCard>();
    const versions = versionsRef.current;
    const lists = new Map<string, PreviewCard[]>();
    for (const [key, items] of Object.entries(raw.previews)) {
      if (!items) continue;
      const cards: PreviewCard[] = [];
      for (const item of items) {
        if (!item.has_thumb) continue;
        cards.push(previewCard(item, root, versions.get(item.slug) ?? 0, known, made));
      }
      lists.set(key, cards);
    }
    // Only the cards of this read stay known: a card gone from the space is
    // forgotten with it, and so is its held picture.
    knownCardsRef.current = made;
    releaseStripPicturesExcept(new Set(Array.from(made.values(), (known) => known.card.url)));
    // A low-priority update: the rows whose lists changed render without
    // holding a frame of the drag, the scroll or the pointer.
    startTransition(() => {
      setChannelPreviews((previous) => {
        let changed = previous.size !== lists.size;
        const next = new Map<string, PreviewCard[]>();
        for (const [key, cards] of lists) {
          const kept = sameListOr(previous.get(key), cards);
          if (kept !== previous.get(key)) changed = true;
          next.set(key, kept);
        }
        return changed ? next : previous;
      });
    });
  }, [revisionOwner]);

  // Initial load on mount / vault switch.
  useEffect(() => {
    versionsRef.current.clear();
    knownCardsRef.current.clear();
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
