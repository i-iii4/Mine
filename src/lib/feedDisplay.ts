// How the feed shows cards: order, presentation and media placement
// (SPEC_FEED_DISPLAY.md).
//
// Shared by the whole feed and every collection, kept between launches in the
// main window. Spacing is the app-wide rhythm and lives in density.ts; the
// Display panel sets all four.

import { createContext, useSyncExternalStore } from "react";
import type { FeedOrder } from "@/types";

/// `cards`: everything in a card frame, media as a post card; `mixed`: text as
/// cards, media bare (the feed as it has always been); `media`: a card with
/// media shows only its media, a card without stays a card.
export type FeedShow = "cards" | "mixed" | "media";

/// Where a framed card's media sits (Д19 to Д22). `inset`: inside the card's
/// padding with its own rounded outline (the feed as it has always been);
/// `edge`: across the frame's full inner width, touching its top and sides.
/// Independent of `show`: it shapes every framed card with media on top.
export type FeedMedia = "inset" | "edge";

export interface FeedDisplay {
  sort: FeedOrder;
  show: FeedShow;
  media: FeedMedia;
}

export const FEED_SORT_STORAGE_KEY = "mine.feed.sort";
export const FEED_SHOW_STORAGE_KEY = "mine.feed.show";
export const FEED_MEDIA_STORAGE_KEY = "mine.feed.media";

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

/// An unknown or damaged stored value reads as the default (Д18).
export function readStoredFeedDisplay(): FeedDisplay {
  const sort = readKey(FEED_SORT_STORAGE_KEY) === "oldest" ? "oldest" : "newest";
  const storedShow = readKey(FEED_SHOW_STORAGE_KEY);
  const show: FeedShow = storedShow === "cards" || storedShow === "media" ? storedShow : "mixed";
  const media: FeedMedia = readKey(FEED_MEDIA_STORAGE_KEY) === "edge" ? "edge" : "inset";
  return { sort, show, media };
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

export function setFeedMedia(media: FeedMedia) {
  if (current.media === media) return;
  writeKey(FEED_MEDIA_STORAGE_KEY, media);
  publish({ ...current, media });
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

/// The feed's presentation for the cards inside it; every other surface that
/// draws a card (search, drag, graph) keeps `mixed`.
export const FeedShowContext = createContext<FeedShow>("mixed");

/// The feed's media placement for the cards inside it; every other surface
/// that draws a card keeps `inset`, as it keeps `mixed`.
export const FeedMediaContext = createContext<FeedMedia>("inset");
