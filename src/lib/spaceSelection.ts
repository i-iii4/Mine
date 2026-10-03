// The order of this page's space selections (SPEC_TABS.md, В10). The page
// counts its choices the moment it makes them, because the commands that
// carry two choices may start in the backend in either order; the backend
// keeps each tab's newest and refuses an older one. The count lives under a
// generation the backend hands this page load, newer than any before, so a
// late request of the page this one replaced loses to it.

import type { SelectionStamp } from "@/types";

/** Stamps for one page's choices; `fetchGeneration` is asked once. */
export function createSelectionStamps(
  fetchGeneration: () => Promise<number>,
): () => Promise<SelectionStamp> {
  let generation: Promise<number> | null = null;
  let sequence = 0;
  return () => {
    // Counted now, in the order the page chooses; only the generation waits.
    sequence += 1;
    const own = sequence;
    if (generation === null) {
      const asked = fetchGeneration();
      generation = asked;
      // A failed ask fails its choice; the next choice asks again.
      asked.catch(() => {
        if (generation === asked) generation = null;
      });
    }
    return generation.then((value) => ({ generation: value, sequence: own }));
  };
}
