// A feed card's collections, shown as pills (SPEC_CARD_STATES.md, С9).
//
// The feed knows which collection is open and how to open another; a card
// several components deep reads both here instead of through every prop list
// between them.

import { createContext } from "react";

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
