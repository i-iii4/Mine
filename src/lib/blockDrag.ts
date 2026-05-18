import type { LightBlock } from "@/types";

export interface BlockDragData {
  type: "block";
  slug: string;
  block: LightBlock;
  dragSlugs?: string[];
  dragBlocks?: LightBlock[];
  clearSelectionOnDragStart?: () => void;
}

function slugFromActiveId(activeId: string): string {
  return activeId.startsWith("detail:")
    ? activeId.slice("detail:".length)
    : activeId;
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
  return [slugFromActiveId(activeId)];
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
