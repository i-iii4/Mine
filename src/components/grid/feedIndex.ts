import type { LightBlock } from "@/types";

// The feed's cards by id and by slug, made from the index of the list before
// when the list only grew (SPEC_GRID.md, «Кэш при карточке и продолжение
// раскладки»): a page added to the end adds its cards to a copy, and a list
// read again with the same rows keeps the index as it is.

/** How a list grew out of another: rows replaced in place by rows of the same
 *  card, and rows added at the end. */
export interface ListGrowth {
  /** Places whose row is another object of the same card (the same id). */
  replaced: number[];
  /** The place of the first added row; the list's length when none is. */
  from: number;
}

/** How `blocks` grew out of `previous`; null when cards left the list,
 *  changed places, or a place holds another card. */
export function listGrowth(
  previous: readonly LightBlock[],
  blocks: readonly LightBlock[],
): ListGrowth | null {
  if (blocks.length < previous.length) return null;
  const replaced: number[] = [];
  for (let index = 0; index < previous.length; index += 1) {
    const was = previous[index]!;
    const now = blocks[index]!;
    if (was === now) continue;
    if (was.id !== now.id) return null;
    replaced.push(index);
  }
  return { replaced, from: previous.length };
}

export interface FeedIndex {
  /** The list the index is of. */
  blocks: readonly LightBlock[];
  /** The id of every card. */
  ids: ReadonlySet<number>;
  bySlug: ReadonlyMap<string, LightBlock>;
}

/** The index of `blocks`, the same whatever `previous` is. The set of ids and
 *  the map by slug are `previous`'s own objects when they hold the same. */
export function indexFeed(blocks: readonly LightBlock[], previous?: FeedIndex | null): FeedIndex {
  const growth = previous ? listGrowth(previous.blocks, blocks) : null;
  if (!previous || growth === null) {
    const ids = new Set<number>();
    const bySlug = new Map<string, LightBlock>();
    for (const block of blocks) {
      ids.add(block.id);
      bySlug.set(block.slug, block);
    }
    return { blocks, ids, bySlug };
  }

  const added = growth.from < blocks.length;
  if (!added && growth.replaced.length === 0) return { blocks, ids: previous.ids, bySlug: previous.bySlug };
  // A replaced row is the same card: the ids change only with added rows.
  let ids = previous.ids;
  if (added) {
    const grown = new Set(previous.ids);
    for (let index = growth.from; index < blocks.length; index += 1) grown.add(blocks[index]!.id);
    ids = grown;
  }
  const bySlug = new Map(previous.bySlug);
  for (const index of growth.replaced) {
    // A renamed card arrives under another slug.
    const was = previous.blocks[index]!.slug;
    if (was !== blocks[index]!.slug && bySlug.get(was) === previous.blocks[index]) bySlug.delete(was);
  }
  for (const index of growth.replaced) bySlug.set(blocks[index]!.slug, blocks[index]!);
  for (let index = growth.from; index < blocks.length; index += 1) bySlug.set(blocks[index]!.slug, blocks[index]!);
  return { blocks, ids, bySlug };
}
