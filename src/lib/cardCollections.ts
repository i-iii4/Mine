// A feed card's collections, shown in its row of collections
// (SPEC_CARD_STATES.md, С8).
//
// The feed knows which collection is open and how to open another; a card
// several components deep reads both here instead of through every prop list
// between them.

import { createContext, useSyncExternalStore } from "react";
import type { TagCount } from "@/types";

export interface CardCollectionsNavigation {
  /** The collection the feed shows; null in Everything. */
  currentTag: string | null;
  /** Open a collection, as its sidebar row does. */
  open: (tag: string) => void;
}

export const CardCollectionsContext = createContext<CardCollectionsNavigation | null>(null);

let collectionOrder: readonly TagCount[] = [];
const collectionOrderListeners = new Set<() => void>();

/**
 * The sidebar's collections in its manual order, published by the sidebar as
 * it draws them. A card shown outside the feed (a hover or search preview)
 * orders its collections by it, as the feed card's row does
 * (SPEC_CARD_STATES.md, С8.9, С10). Until the sidebar publishes, a card keeps
 * its own order.
 */
export function publishCollectionOrder(order: readonly TagCount[]): void {
  if (order === collectionOrder) return;
  collectionOrder = order;
  for (const listener of collectionOrderListeners) listener();
}

function subscribeCollectionOrder(listener: () => void): () => void {
  collectionOrderListeners.add(listener);
  return () => collectionOrderListeners.delete(listener);
}

function readCollectionOrder(): readonly TagCount[] {
  return collectionOrder;
}

export function useCollectionOrder(): readonly TagCount[] {
  return useSyncExternalStore(subscribeCollectionOrder, readCollectionOrder, readCollectionOrder);
}
