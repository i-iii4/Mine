import type { TagCount } from "@/types";

/// The positions a drag writes for `order`, the collections top to bottom:
/// numbered on from the smallest position there is, so the collections the
/// drag did not move keep the positions they have and their pages are not
/// written (`reorder_channels` skips a page whose position stays). A new
/// collection takes the place before the first, below zero once the first is
/// at zero (SPEC_DEEP_AUDIT.md, Е6.2); numbering from zero would rewrite every
/// page after such a creation.
export function reorderedPositions(
  order: readonly string[],
  positions: ReadonlyMap<string, number>,
): { tag: string; position: number }[] {
  const known = order.flatMap((tag) => {
    const position = positions.get(tag);
    return position === undefined ? [] : [position];
  });
  const start = known.length > 0 ? Math.min(...known) : 0;
  return order.map((tag, index) => ({ tag, position: start + index }));
}

/// Applies the collection order a drop just produced on top of the order the
/// vault currently reports.
///
/// The optimistic order exists only between the drop and the reload that
/// confirms it, so it may be missing tags that appeared in the meantime; those
/// keep their relative position at the end rather than being dropped or moved
/// to an arbitrary slot.
export function applyPendingTagOrder(
  tags: readonly TagCount[],
  pendingOrder: readonly string[] | null,
): TagCount[] {
  if (!pendingOrder || pendingOrder.length === 0) return [...tags];

  const rank = new Map(pendingOrder.map((tag, index) => [tag, index]));
  return [...tags].sort((a, b) => {
    const aRank = rank.get(a.tag);
    const bRank = rank.get(b.tag);
    if (aRank === undefined) return bRank === undefined ? 0 : 1;
    if (bRank === undefined) return -1;
    return aRank - bRank;
  });
}
