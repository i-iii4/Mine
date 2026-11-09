// The version of the pictures Mine makes from each card: its thumbnail, the
// levels of it and the feed's tiles (SPEC_THUMBNAILS.md, «Адрес картинки»).
//
// WebKit loads an image address once per page and gives every later image
// with that address the bytes it loaded first, whatever the response says
// (no-store and no-cache included). The pictures of a card are rewritten in
// place under the same file names, so a picture address has to change
// whenever its bytes may have: every builder of such an address in
// `assets.ts` adds the version of its card. The version moves on every
// `thumb:updated` of the card, which the backend sends after it wrote the
// card's pictures, whether or not any surface of the page shows the card
// then, and on every return of the page to a space it showed before: the
// events of a space reach only the pages that show it.

import { useSyncExternalStore } from "react";
import { listenPage } from "@/lib/pageEvents";

/** `thumb:updated` payload; only the slug matters here. */
interface ThumbUpdatedPayload {
  slug: string;
}

/** How many times the pictures of each card changed in this page. */
const changes = new Map<string, number>();
/** How many times the page went back to a space after showing another. */
let spaceReturns = 0;
/** The thumbnail folder of the space the page shows. */
let shownThumbsRoot: string | null = null;
/** How many times any version moved in this page. */
let revision = 0;
const listeners = new Set<() => void>();
let started: Promise<void> | null = null;

function announce(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/**
 * Hear `thumb:updated` for the whole life of the page. Called once when the
 * page starts, before it draws a picture; later calls do nothing.
 */
export function startCardPictureVersions(): Promise<void> {
  started ??= listenPage<ThumbUpdatedPayload>("thumb:updated", (event) => {
    noteCardPicturesChanged(event.payload.slug);
  }).then(
    () => undefined,
    // Outside a Tauri page (a dev browser route) no event comes; the
    // addresses stay as they are.
    () => undefined,
  );
  return started;
}

/** The pictures of the card `slug` were written again. */
export function noteCardPicturesChanged(slug: string): void {
  changes.set(slug, (changes.get(slug) ?? 0) + 1);
  announce();
}

/**
 * The page shows the space whose thumbnails lie in `thumbsRoot`. Showing
 * another space than before moves every version: what changed in a space
 * while the page showed another never reached the page.
 */
export function noteSpaceShown(thumbsRoot: string): void {
  if (shownThumbsRoot !== null && shownThumbsRoot !== thumbsRoot) {
    spaceReturns += 1;
    announce();
  }
  shownThumbsRoot = thumbsRoot;
}

/**
 * The version of the pictures of the card `slug` in this page: empty until
 * they change or the page shows another space, so an address stays as it
 * was until then.
 */
export function cardPicturesVersion(slug: string): string {
  const count = changes.get(slug) ?? 0;
  return spaceReturns === 0 && count === 0 ? "" : `${spaceReturns}.${count}`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The version of the pictures of the card `slug`, rendering its caller again
 * when it moves: a surface that keeps a card on screen across events (the
 * card's window) draws its new pictures at once.
 */
export function useCardPicturesVersion(slug: string): string {
  const read = () => cardPicturesVersion(slug);
  // A card drawn to markup (its measured height, a drag preview) reads the
  // same version.
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * A number that moves with every version of every card, rendering its
 * caller again: a surface that keeps pictures of many cards by address (the
 * graph) makes their addresses again.
 */
export function useCardPictureVersionsRevision(): number {
  const read = () => revision;
  return useSyncExternalStore(subscribe, read, read);
}

/** Forget every version: a page starting over. Tests start each case so. */
export function forgetCardPictureVersions(): void {
  changes.clear();
  spaceReturns = 0;
  shownThumbsRoot = null;
  announce();
}
