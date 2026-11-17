// The backend's partial read of the feed, for tests of the page: what
// `read_feed_changes` answers for a feed held in memory, by the rules of
// SPEC_STORAGE.md, «Частичное чтение ленты». The backend's own read is
// tested in Rust (`block_queries::feed_patch_tests`).

import type { FeedPatch, FeedPatchRow, LightBlock } from "@/types";

/** The cards `named` (`blocks.id`) as the feed `feed`, in its order, holds
 *  them now. `end` is the last card of the page's list that is not named,
 *  `null` when the list holds the whole feed. */
export function feedPatchOf(
  feed: readonly LightBlock[],
  named: readonly number[],
  end: number | null,
  answer: { path: string; generation: number },
): FeedPatch {
  const isNamed = new Set(named);
  const patch: FeedPatch = {
    path: answer.path,
    generation: answer.generation,
    rows: [],
    total_blocks: feed.length,
    has_more: false,
    range_lost: false,
  };
  let rangeEnd = feed.length;
  if (end !== null) {
    const endIndex = feed.findIndex((block) => block.id === end);
    if (endIndex < 0) return { ...patch, range_lost: true };
    const next = feed.findIndex((block, index) => index > endIndex && !isNamed.has(block.id));
    rangeEnd = next < 0 ? feed.length : next;
    patch.has_more = next >= 0;
  }
  let after: number | null = null;
  const rows: FeedPatchRow[] = [];
  for (const block of feed.slice(0, rangeEnd)) {
    if (isNamed.has(block.id)) rows.push({ block, after });
    else after = block.id;
  }
  return { ...patch, rows };
}
