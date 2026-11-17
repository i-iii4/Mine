// The partial path of the feed's update (SPEC_FRONTEND.md, «Обновление
// ленты»): the page read only the cards it knows changed, and puts the answer
// into its list. The backend owns order and membership; the page places each
// answered row after the card the answer names and computes neither.

import type { FeedPatchRow, LightBlock } from "@/types";

/** Where the page's list ends, for a partial read of the cards `named`:
 *  `null` when the list holds the whole feed, otherwise the last card of the
 *  list that is not named. `undefined` when the feed has more and every card
 *  of the list is named: the range cannot be told, and the page reads the
 *  feed in full. */
export function feedPatchEnd(
  list: readonly LightBlock[],
  named: ReadonlySet<number>,
  hasMore: boolean,
): number | null | undefined {
  if (!hasMore) return null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const card = list[index]!;
    if (!named.has(card.id)) return card.id;
  }
  return undefined;
}

/** The list after a partial read: the cards `named` leave it, and each
 *  answered row stands after the card its `after` names (before every kept
 *  card when it names none). Rows come in feed order, so rows that share a
 *  card keep their order.
 *
 *  `null` when a row names a card the list does not hold: the list was not
 *  the feed's beginning the answer was read for, and the page reads the feed
 *  in full. */
export function applyFeedPatch(
  list: readonly LightBlock[],
  named: ReadonlySet<number>,
  rows: readonly FeedPatchRow[],
): LightBlock[] | null {
  const rowsAfter = new Map<number | null, LightBlock[]>();
  for (const row of rows) {
    const standing = rowsAfter.get(row.after);
    if (standing) standing.push(row.block);
    else rowsAfter.set(row.after, [row.block]);
  }
  const first = rowsAfter.get(null) ?? [];
  const next: LightBlock[] = [...first];
  let placed = first.length;
  for (const card of list) {
    if (named.has(card.id)) continue;
    next.push(card);
    const standing = rowsAfter.get(card.id);
    if (standing === undefined) continue;
    for (const block of standing) next.push(block);
    placed += standing.length;
  }
  return placed === rows.length ? next : null;
}
