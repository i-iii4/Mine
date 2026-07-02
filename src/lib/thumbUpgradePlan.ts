// Pure routing for the Phase 2 thumbnail upgrade pipeline.
//
// One upgrade request (from the startup backlog enumeration or a live
// `thumb:upgrade-requested` event) can carry a block-level media asset —
// an image or a video — and/or a set of per-tile video posters for a
// gallery block. An empty `mediaPath` means only tile posters are missing.
//
// Splitting this expansion out of the hook keeps the routing — which media
// goes to the worker vs. the main-thread decode queue, and the dedup keys
// each target is tracked under — testable without a DOM or Tauri mock.
// See SPEC_THUMBNAILS.md#enqueue-logic.

import type { TilePosterUpgrade } from "@/lib/commands";

export interface ThumbUpgradeInput {
  slug: string;
  /** Empty when only tile posters are missing (block thumb already a JPEG). */
  mediaPath: string;
  kind: "image" | "video";
  /** Per-video gallery tile posters; absent for non-gallery blocks. */
  tilePosters?: TilePosterUpgrade[];
}

export type ThumbUpgradeAction =
  | { kind: "image"; key: string; slug: string; mediaPath: string }
  | { kind: "video"; key: string; slug: string; mediaPath: string }
  | { kind: "tile"; key: string; slug: string; tile: TilePosterUpgrade };

/** Dedup key for a block's own thumb (image or video decode to the same
 *  destination — a block has a single kind, so these never collide). */
export function blockThumbKey(slug: string): string {
  return `thumb:${slug}`;
}

/** Dedup key for one gallery video tile's poster. */
export function tilePosterKey(posterName: string): string {
  return `tile:${posterName}`;
}

/** Expand one upgrade request into its concrete decode actions. Callers
 *  dedup by each action's `key` and route by its `kind`. */
export function planThumbUpgrade(input: ThumbUpgradeInput): ThumbUpgradeAction[] {
  const actions: ThumbUpgradeAction[] = [];

  if (input.mediaPath) {
    const key = blockThumbKey(input.slug);
    actions.push(
      input.kind === "video"
        ? { kind: "video", key, slug: input.slug, mediaPath: input.mediaPath }
        : { kind: "image", key, slug: input.slug, mediaPath: input.mediaPath },
    );
  }

  for (const tile of input.tilePosters ?? []) {
    actions.push({
      kind: "tile",
      key: tilePosterKey(tile.posterName),
      slug: input.slug,
      tile,
    });
  }

  return actions;
}
