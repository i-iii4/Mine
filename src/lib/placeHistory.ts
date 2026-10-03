// The places a tab went through, for the tab bar's back and forward buttons
// (SPEC_TABS.md, В81). A place is where the tab stands: Everything or a
// collection, and the card open there, if any.

/** Where a tab stands: the collection (`null` for Everything) and the open card. */
export interface Place {
  tag: string | null;
  card: string | null;
}

/** The places a tab went through and the one it stands on. */
export interface PlaceHistory {
  entries: readonly Place[];
  /** The entry the tab stands on; -1 before the first place. */
  index: number;
}

/** How many places a tab remembers; the oldest go first. */
export const PLACE_HISTORY_LIMIT = 100;

export const EMPTY_PLACE_HISTORY: PlaceHistory = { entries: [], index: -1 };

export function samePlace(a: Place, b: Place): boolean {
  return a.tag === b.tag && a.card === b.card;
}

/** The tab came to `place` by itself: the places ahead are dropped and
 *  `place` becomes the newest. Standing still records nothing. */
export function recordPlace(history: PlaceHistory, place: Place): PlaceHistory {
  const current = history.entries[history.index];
  if (current !== undefined && samePlace(current, place)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), place];
  const dropped = Math.max(0, entries.length - PLACE_HISTORY_LIMIT);
  return { entries: entries.slice(dropped), index: entries.length - 1 - dropped };
}

/** The place one step back or forward and the history standing on it, or
 *  `null` when there is none that way. */
export function stepPlace(
  history: PlaceHistory,
  forward: boolean,
): { history: PlaceHistory; target: Place } | null {
  const index = history.index + (forward ? 1 : -1);
  const target = history.entries[index];
  if (index < 0 || target === undefined) return null;
  return { history: { entries: history.entries, index }, target };
}

/** A step landed elsewhere than asked (a card or a collection gone): the
 *  entry it stands on becomes the place it reached. */
export function settlePlace(history: PlaceHistory, place: Place): PlaceHistory {
  const current = history.entries[history.index];
  if (current === undefined || samePlace(current, place)) return history;
  const entries = history.entries.map((entry, index) => (index === history.index ? place : entry));
  return { entries, index: history.index };
}

/** Whether there are places to go back and forward to. */
export function historyDirections(history: PlaceHistory): { back: boolean; forward: boolean } {
  return {
    back: history.index > 0,
    forward: history.index >= 0 && history.index < history.entries.length - 1,
  };
}
