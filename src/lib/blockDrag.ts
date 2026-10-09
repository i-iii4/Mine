import type { IndexedBlock, LightBlock } from "@/types";

export interface BlockDragData {
  type: "block";
  slug: string;
  /** The card itself. A source that shows only a thumbnail (a sidebar row's
   *  strip) leaves it out; the drag then takes the card from the feed or reads
   *  it by its slug (SPEC_FRONTEND.md, «Перетаскивание миниатюры»). */
  block?: LightBlock;
  dragSlugs?: string[];
  dragBlocks?: LightBlock[];
  clearSelectionOnDragStart?: () => void;
  /** The collection whose sidebar row the card was taken from. */
  sourceTag?: string;
}

/**
 * Whether a card is dropped back on the collection whose row it was taken
 * from. It is already there, so the drop changes nothing.
 */
export function isDropOnSourceCollection(
  data: Partial<BlockDragData> | undefined,
  overId: string,
): boolean {
  return data?.type === "block"
    && data.sourceTag !== undefined
    && overId === `tag:${data.sourceTag}`;
}

/**
 * A card read in full, in the shape the feed draws: the full block names its
 * collections `tags` and carries no search match.
 */
export function lightBlockFromIndexed(block: IndexedBlock): LightBlock {
  return { ...block, search_match: null, collections: block.tags };
}

export function uniqueDragSlugs(slugs: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const slug of slugs) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    result.push(slug);
  }
  return result;
}

export function uniqueDragBlocks(blocks: readonly LightBlock[]): LightBlock[] {
  const seen = new Set<string>();
  const result: LightBlock[] = [];
  for (const block of blocks) {
    if (seen.has(block.slug)) continue;
    seen.add(block.slug);
    result.push(block);
  }
  return result;
}

export function resolveBlockDragSlugs(
  activeId: string,
  data: Partial<BlockDragData> | undefined,
): string[] {
  if (data?.type === "block") {
    const dragSlugs = uniqueDragSlugs(data.dragSlugs ?? []);
    if (dragSlugs.length > 0) return dragSlugs;
    if (data.slug) return [data.slug];
  }
  return [activeId];
}

export function resolveBlockDragBlocks(
  activeId: string,
  data: Partial<BlockDragData> | undefined,
  fallbackBlocks: readonly LightBlock[],
): LightBlock[] {
  const dragBlocks = uniqueDragBlocks(data?.type === "block" ? data.dragBlocks ?? [] : []);
  if (dragBlocks.length > 0) return dragBlocks;

  const dragSlugs = resolveBlockDragSlugs(activeId, data);
  const blocksBySlug = new Map(fallbackBlocks.map((block) => [block.slug, block]));
  return dragSlugs
    .map((slug) => blocksBySlug.get(slug))
    .filter((block): block is LightBlock => Boolean(block));
}
