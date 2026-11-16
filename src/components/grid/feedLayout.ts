import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";
import type { FeedShow } from "@/lib/feedDisplay";
import { FEED_COLUMN_MIN_WIDTH_PX, computeCardHeight } from "@/lib/cardHeight";
import { blockHasExactDeterministicHeight } from "@/lib/gridLayoutReadiness";
import {
  computeMasonryLayout,
  getMasonryColumnWidth,
  type MasonryContinuation,
  type MasonryLayout,
  type MasonryPosition,
} from "@/lib/masonryLayout";

// The feed's layout from its cards, and the columns it remembers
// (SPEC_GRID_LAYOUT_READINESS.md, «Колонка карточки»; SPEC_GRID.md, «Кэш при
// карточке и продолжение раскладки»).

/** The last layout shown, and the view it belongs to. */
export interface ColumnMemory {
  /** The route these cards are from. Null while a new route's list is on its
   *  way and the feed still holds the previous route's cards: their columns
   *  are no memory of the new route (SPEC_GRID.md, «Форма ленты»). */
  routeKey: string | null;
  parentWidth: number;
  layoutGap: number;
  show: FeedShow;
  /** The cards in the order they were laid out, and where each stood. */
  blocks: readonly LightBlock[];
  layout: MasonryLayout;
  /** Every height was exact. Columns of a layout made on the worst-case
   *  text heights that stand in while fonts load are not kept: the first
   *  exact layout balances the columns anew. */
  exact: boolean;
}

/** The columns a remembered layout gives the cards of a list. */
export interface RememberedColumns {
  /** Where the card at `index` of the list stood; undefined for a card the
   *  layout did not hold. */
  positionOf: (index: number) => MasonryPosition | undefined;
  /** The column the card at `index` of the list stood in; undefined for a
   *  card the layout did not hold. */
  columnOf: (index: number) => number | undefined;
  memory: ColumnMemory;
  /** How many leading cards of the list are the cards at the same places of
   *  the remembered list. */
  aligned: number;
}

/** Where each card of a memory stood, by slug; made when first asked for. */
const placesBySlug = new WeakMap<ColumnMemory, Map<string, number>>();

function placesOf(memory: ColumnMemory): Map<string, number> {
  let places = placesBySlug.get(memory);
  if (places === undefined) {
    places = new Map();
    const count = Math.min(memory.blocks.length, memory.layout.positions.length);
    for (let index = 0; index < count; index += 1) {
      places.set(memory.blocks[index]!.slug, index);
    }
    placesBySlug.set(memory, places);
  }
  return places;
}

/**
 * Where the card `slug` stood in the remembered layout; undefined when the
 * layout did not hold it. `index` is where the card stands in the list now:
 * a card that kept its place is found there without the search by slug.
 */
export function rememberedPosition(
  memory: ColumnMemory,
  slug: string,
  index: number,
): MasonryPosition | undefined {
  const positions = memory.layout.positions;
  if (memory.blocks[index]?.slug === slug) return positions[index];
  const place = placesOf(memory).get(slug);
  return place === undefined ? undefined : positions[place];
}

/**
 * Where each card stood on the last layout, when the view is the same one:
 * the same route, width and presentation, and the cards that remain in the
 * order they had (SPEC_GRID_LAYOUT_READINESS.md, К1, К2). Null when the view
 * changed: the feed is then laid out anew.
 */
export function rememberedColumns(
  memory: ColumnMemory | null,
  blocks: readonly LightBlock[],
  routeKey: string,
  parentWidth: number,
  show: FeedShow,
): RememberedColumns | null {
  if (
    memory === null
    || !memory.exact
    || memory.routeKey !== routeKey
    || Math.abs(memory.parentWidth - parentWidth) > 0.5
    || memory.show !== show
  ) {
    return null;
  }
  const held = memory.blocks;
  const positions = memory.layout.positions;
  const shared = Math.min(held.length, blocks.length);
  let aligned = 0;
  while (
    aligned < shared
    && (held[aligned] === blocks[aligned] || held[aligned]!.slug === blocks[aligned]!.slug)
  ) {
    aligned += 1;
  }
  if (aligned === held.length) {
    // Every remembered card stands where it stood: the list grew at its end
    // or changed cards in place.
    const positionOf = (index: number) => (index < aligned ? positions[index] : undefined);
    return { positionOf, columnOf: (index) => positionOf(index)?.column, memory, aligned };
  }

  const places = placesOf(memory);
  const present = new Set(blocks.map((block) => block.slug));
  const kept = held.filter((block) => present.has(block.slug));
  let next = 0;
  for (const block of blocks) {
    if (!places.has(block.slug)) continue;
    if (kept[next]?.slug !== block.slug) return null;
    next += 1;
  }
  const positionOf = (index: number) => {
    const slug = blocks[index]?.slug;
    const place = slug === undefined ? undefined : places.get(slug);
    return place === undefined ? undefined : positions[place];
  };
  return { positionOf, columnOf: (index) => positionOf(index)?.column, memory, aligned };
}

/**
 * Where the card at `index` of `blocks` stood in the layout `memory` holds;
 * undefined when the layout did not hold it. `columns` are the columns
 * remembered for `blocks`: taken from this very memory, they already know
 * where each card of the list stood.
 */
export function rememberedPositionAt(
  memory: ColumnMemory,
  columns: RememberedColumns | null,
  blocks: readonly LightBlock[],
  index: number,
): MasonryPosition | undefined {
  if (columns !== null && columns.memory === memory) return columns.positionOf(index);
  const slug = blocks[index]?.slug;
  return slug === undefined ? undefined : rememberedPosition(memory, slug, index);
}

/**
 * Whether every card the memory holds stands in the column it stood in: a
 * card that changed its column means the feed was laid out anew in spite of
 * the memory (SPEC_GRID.md, «Форма ленты»).
 */
export function columnsKept(
  memory: ColumnMemory,
  columns: RememberedColumns | null,
  blocks: readonly LightBlock[],
  layout: MasonryLayout,
): boolean {
  return layout.positions.every((position, index) => {
    const was = rememberedPositionAt(memory, columns, blocks, index)?.column;
    return was === undefined || was === position.column;
  });
}

/**
 * Whether every card has an exact deterministic height
 * (`generationHasExactDeterministicHeights`), asked from the end of the list:
 * the cards without one are the newest, a page that has just arrived, so a
 * feed with one is told at once, without reading the cards before them.
 */
export function everyHeightIsExact(
  blocks: readonly LightBlock[],
  wordWidths: ReadonlyMap<number, unknown>,
  show: FeedShow,
): boolean {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (!blockHasExactDeterministicHeight(blocks[index]!, wordWidths, show)) return false;
  }
  return true;
}

/**
 * The feed's layout: every card's height, then its place. With remembered
 * columns of the same width and gap, the cards that stand at the head of the
 * remembered list with the heights they had are taken from that layout, and
 * the layout goes on from the first card that differs: the memory names for
 * each of them the column it stands in there, so it would come out where it
 * stands. `last` is the layout on screen: a card that comes out where it
 * stands in it keeps its position object.
 */
export function layFeedOut({
  blocks,
  parentWidth,
  layoutGap,
  show,
  wordWidths,
  columns,
  last,
}: {
  blocks: readonly LightBlock[];
  parentWidth: number;
  layoutGap: number;
  show: FeedShow;
  wordWidths: ReadonlyMap<number, WordWidths>;
  columns: RememberedColumns | null;
  last: MasonryLayout | null;
}): MasonryLayout {
  const columnWidth = getMasonryColumnWidth(parentWidth, FEED_COLUMN_MIN_WIDTH_PX, layoutGap);
  const heights = new Array<number>(blocks.length);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    heights[index] = computeCardHeight(block, columnWidth, wordWidths.get(block.id) ?? null, show);
  }

  let continued: MasonryContinuation | undefined = last === null ? undefined : { layout: last, keep: 0 };
  if (
    columns !== null
    && columns.memory.parentWidth === parentWidth
    && columns.memory.layoutGap === layoutGap
  ) {
    const remembered = columns.memory.layout;
    const limit = Math.min(columns.aligned, remembered.positions.length);
    let keep = 0;
    while (
      keep < limit
      && remembered.positions[keep]!.height === Math.max(1, heights[keep]!)
      && remembered.positions[keep]!.column === columns.columnOf(keep)
    ) {
      keep += 1;
    }
    continued = { layout: remembered, keep, reuse: last ?? remembered };
  }

  return computeMasonryLayout(
    heights,
    parentWidth,
    FEED_COLUMN_MIN_WIDTH_PX,
    layoutGap,
    columns?.columnOf,
    continued,
  );
}
