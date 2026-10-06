// A feed card's collections, shown as pills (SPEC_CARD_STATES.md, С9).
//
// The feed knows which collection is open and how to open another; a card
// several components deep reads both here instead of through every prop list
// between them.

import { createContext, useSyncExternalStore } from "react";
import type { TagCount } from "@/types";

export interface CardCollectionsNavigation {
  /** The collection the feed shows, whose pill is marked; null in Everything. */
  currentTag: string | null;
  /** Open a collection, as its sidebar row does. */
  open: (tag: string) => void;
}

export const CardCollectionsContext = createContext<CardCollectionsNavigation | null>(null);

/** Height of the pill row: one line of `xs` reference pills. */
export const CARD_COLLECTION_PILLS_HEIGHT_PX = 24;
/**
 * Collection pills on feed cards (С9). Off for now by the user's decision of
 * 02.10.2026: the cards still carry their collections, and turning this on
 * brings the pills and the height they take back together.
 */
export const CARD_COLLECTION_PILLS_ENABLED = false;

/** The collections a card shows as pills: none while the pills are off. */
export function shownCollections(block: { collections: readonly string[] }): readonly string[] {
  return CARD_COLLECTION_PILLS_ENABLED ? block.collections : [];
}

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
