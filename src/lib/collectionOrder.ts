import type { TagCount } from "@/types";

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
