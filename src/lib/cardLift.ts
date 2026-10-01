// Which feed card the pointer has arrived on, for its lift
// (SPEC_CARD_STATES.md, С8.6).
//
// The hover-intent engine answers this as the pointer moves; a card subscribes
// with a selector that returns one boolean, so only the card that gains or
// loses the lift renders again, not the whole feed.

import { useSyncExternalStore } from "react";

export interface CardLiftStore {
  /** The raised card's block id as the engine keys it, or `null`. */
  set(raisedId: string | null): void;
  isRaised(blockId: number): boolean;
  subscribe(listener: () => void): () => void;
}

export function createCardLiftStore(): CardLiftStore {
  let raisedId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    set(next) {
      if (next === raisedId) return;
      raisedId = next;
      for (const listener of listeners) listener();
    },
    isRaised: (blockId) => raisedId === String(blockId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Whether the pointer has arrived on this card (С8.6). */
export function useCardRaised(store: CardLiftStore, blockId: number): boolean {
  return useSyncExternalStore(store.subscribe, () => store.isRaised(blockId));
}
