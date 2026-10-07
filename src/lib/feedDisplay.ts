// How the feed shows cards: order and presentation (SPEC_FEED_DISPLAY.md).
//
// Shared by the whole feed and every collection, kept between launches in the
// main window. Spacing is the app-wide rhythm and lives in density.ts; the
// Display panel sets order, presentation and spacing.

import { createContext, useSyncExternalStore } from "react";
import type { FeedOrder } from "@/types";

/// `cards`: every card shows all its content; `media`: a card with media shows
/// only its media, a card without stays as in `cards`. Both act on every card
/// alike (SPEC_CARD_UNIFIED.md, Е11).
export type FeedShow = "cards" | "media";

export interface FeedDisplay {
  sort: FeedOrder;
  show: FeedShow;
}

export const FEED_SORT_STORAGE_KEY = "mine.feed.sort";
export const FEED_SHOW_STORAGE_KEY = "mine.feed.show";

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Unwritable storage (private mode, quota): the choice lasts this session.
  }
}

/// An unknown or damaged stored value reads as the default (Д18), and so does
/// the retired `mixed` (SPEC_CARD_UNIFIED.md, Е11).
export function readStoredFeedDisplay(): FeedDisplay {
  const sort = readKey(FEED_SORT_STORAGE_KEY) === "oldest" ? "oldest" : "newest";
  const show: FeedShow = readKey(FEED_SHOW_STORAGE_KEY) === "media" ? "media" : "cards";
  return { sort, show };
}

let current: FeedDisplay = readStoredFeedDisplay();
const listeners = new Set<() => void>();

function publish(next: FeedDisplay) {
  current = next;
  for (const listener of listeners) listener();
}

export function getFeedDisplay(): FeedDisplay {
  return current;
}

export function setFeedSort(sort: FeedOrder) {
  if (current.sort === sort) return;
  writeKey(FEED_SORT_STORAGE_KEY, sort);
  publish({ ...current, sort });
}

export function setFeedShow(show: FeedShow) {
  if (current.show === show) return;
  writeKey(FEED_SHOW_STORAGE_KEY, show);
  publish({ ...current, show });
}

/// Re-read storage; for tests that change it underneath the module.
export function reloadFeedDisplay() {
  publish(readStoredFeedDisplay());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFeedDisplay(): FeedDisplay {
  return useSyncExternalStore(subscribe, getFeedDisplay, getFeedDisplay);
}

/// The feed's presentation for the cards inside it. A card drawn outside the
/// feed (a hover or search preview, a dragged card) provides the feed's
/// current presentation itself (`StaticCard` in Card.tsx), so it is the same
/// card as in the feed (SPEC_CARD_STATES.md, С10).
export const FeedShowContext = createContext<FeedShow>("cards");
