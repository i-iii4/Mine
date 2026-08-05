// Block identity reconciliation for grid snapshots.
//
// A vault refresh (vault-changed, thumb:updated, block:added, …) re-fetches the
// feed and produces a brand-new array of brand-new block objects, even when the
// underlying content did not change. Feeding that straight into React state
// invalidates every downstream memo (generation key, word metrics, masonry
// layout) and forces a full recompute for a no-op refresh.
//
// `reconcileBlocks` diffs the incoming snapshot against the current state by
// block id and content: unchanged blocks keep their previous object identity,
// and when nothing changed at all the previous array is returned unchanged so
// even the array identity is preserved. This turns a no-op refresh into a
// no-op render.

import type { LightBlock, SearchMatch } from "@/types";

function searchMatchEqual(
  a: SearchMatch | null | undefined,
  b: SearchMatch | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.field === right.field &&
    left.kind === right.kind &&
    left.excerpt === right.excerpt &&
    left.score === right.score &&
    left.explanation === right.explanation &&
    left.ranges.length === right.ranges.length &&
    left.ranges.every((range, index) => {
      const other = right.ranges[index];
      return other !== undefined && range.start === other.start && range.end === other.end;
    })
  );
}

/**
 * Structural equality over every field the grid and card renderers read from a
 * `LightBlock`. Two blocks that compare equal are interchangeable for
 * rendering, so the previous object can be reused to preserve identity.
 */
export function lightBlockContentEqual(a: LightBlock, b: LightBlock): boolean {
  return (
    a.id === b.id &&
    a.slug === b.slug &&
    a.card_kind === b.card_kind &&
    a.block_type === b.block_type &&
    a.title === b.title &&
    a.content_heading === b.content_heading &&
    a.display_title === b.display_title &&
    a.fallback_label === b.fallback_label &&
    a.url === b.url &&
    a.media_file === b.media_file &&
    a.thumbnail === b.thumbnail &&
    a.saved_at === b.saved_at &&
    a.width === b.width &&
    a.height === b.height &&
    a.author === b.author &&
    a.body === b.body &&
    a.preview_text === b.preview_text &&
    a.first_image === b.first_image &&
    a.media_urls === b.media_urls &&
    a.media_dimensions === b.media_dimensions &&
    a.preview_manifest === b.preview_manifest &&
    a.feed_playback === b.feed_playback &&
    searchMatchEqual(a.search_match, b.search_match)
  );
}

/**
 * Reconcile a freshly fetched block list against the current one.
 *
 * - A block present in `prev` with the same id and equal content keeps its
 *   previous object identity.
 * - Blocks that are new, edited, reordered, or removed produce a new array.
 * - When the reconciled result is element-for-element identical to `prev`
 *   (same references in the same order), `prev` is returned so the array
 *   identity is preserved and no re-render is triggered.
 */
export function reconcileBlocks(
  prev: LightBlock[],
  next: LightBlock[],
  heldSlugs?: ReadonlySet<string>,
): LightBlock[] {
  if (prev.length === 0) return next;

  const prevById = new Map<number, LightBlock>();
  for (const block of prev) {
    prevById.set(block.id, block);
  }

  let changed = next.length !== prev.length;
  const result = next.map((block, index) => {
    const previous = prevById.get(block.id);
    if (previous && lightBlockContentEqual(previous, block)) {
      if (previous !== prev[index]) changed = true;
      return previous;
    }
    changed = true;
    return block;
  });

  const withHeld = heldSlugs?.size ? restoreHeldBlocks(prev, result, heldSlugs) : result;
  if (withHeld !== result) return withHeld;

  return changed ? result : prev;
}

/// Put back blocks that dropped out of the snapshot while their menu is open.
///
/// Removing a card from the collection you are browsing makes it fail the
/// filter at once, and the list would close over the card the menu belongs to —
/// the menu would follow the card out from under the pointer mid-gesture. The
/// removal has already happened; only the reflow waits. Each held block returns
/// to the index it occupied before, so nothing shifts around it either.
function restoreHeldBlocks(
  prev: LightBlock[],
  next: LightBlock[],
  heldSlugs: ReadonlySet<string>,
): LightBlock[] {
  const presentSlugs = new Set(next.map((block) => block.slug));
  const missing = prev
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => heldSlugs.has(block.slug) && !presentSlugs.has(block.slug));
  if (missing.length === 0) return next;

  const restored = [...next];
  for (const { block, index } of missing) {
    restored.splice(Math.min(index, restored.length), 0, block);
  }
  return restored;
}
