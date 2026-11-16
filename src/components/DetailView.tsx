// The open card, its own part of the bundle, loaded ahead of the first card
// (SPEC_READING_MODE.md, Ч0.6): once the feed has painted its first cards the
// page loads this part and the editor's, whatever view the card opens in, so
// the first card of a session opens without waiting for either. A lazy
// component waits a render for a module it has not met, even a loaded one,
// and React holds a revealed Suspense boundary back for a moment, so the
// first window of a session would grow round an empty card and find its
// picture late (SPEC_CARD_PEEK.md, О12). Once the module is loaded the card
// renders at once.

import { lazy, useEffect, type ComponentProps } from "react";
import { scheduleAfterNextPaint, whenCardsRendered } from "@/lib/startup";

type DetailModule = typeof import("./Detail");

let loadedDetail: DetailModule["Detail"] | null = null;
let detailModule: Promise<DetailModule> | null = null;

function loadDetail(): Promise<DetailModule> {
  detailModule ??= import("./Detail").then((module) => {
    loadedDetail = module.Detail;
    return module;
  });
  return detailModule;
}

const LazyDetail = lazy(async () => ({ default: (await loadDetail()).Detail }));

let markPreloaded: () => void = () => {};
const preloaded = new Promise<void>((resolve) => {
  markPreloaded = resolve;
});

/** Loads the open card's module and its editor's ahead of the first card. */
export function preloadDetail(): Promise<unknown> {
  return loadDetail()
    .then((module) => module.preloadNoteEditor())
    .then(markPreloaded);
}

/** Resolves once both parts have been loaded ahead of a card; asks for
 *  neither itself. */
export function whenDetailPreloaded(): Promise<void> {
  return preloaded;
}

/** The latest the parts start loading after the page asks for them, ms: the
 *  budget of the first cards of a cold launch, its 95th percentile
 *  (SPEC_STARTUP_PERFORMANCE.md, «Performance budgets»). A page that has
 *  painted no cards by then (the graph, a screen of an error) shows what it
 *  shows, and loads them. */
export const DETAIL_PRELOAD_LATEST_MS = 1000;

/** The log line of a preload that failed; the first card then loads the
 *  parts itself. */
export const DETAIL_PRELOAD_FAILED_TITLE = "Could not load the open card ahead of the first card:";

/**
 * Loads the open card's parts after the page's first cards (Ч0.6): once the
 * feed has painted them, or `DETAIL_PRELOAD_LATEST_MS` after the call if it
 * paints none, and a frame later, so the load does not start inside the
 * frame that shows the cards. WebKit has no idle callback to ask for; the
 * first cards are the end of what the page must do first
 * (SPEC_STARTUP_PERFORMANCE.md). Returns what calls the load off.
 */
export function preloadDetailAfterFirstCards(): () => void {
  let cancelPaint: (() => void) | null = null;
  let latest: number | null = null;
  let started = false;
  const stopWaiting = () => {
    started = true;
    if (latest !== null) window.clearTimeout(latest);
  };
  const start = () => {
    if (started) return;
    stopWaiting();
    cancelPaint = scheduleAfterNextPaint(() => {
      preloadDetail().catch((error: unknown) => console.error(DETAIL_PRELOAD_FAILED_TITLE, error));
    });
  };
  latest = window.setTimeout(start, DETAIL_PRELOAD_LATEST_MS);
  void whenCardsRendered().then(start);
  return () => {
    stopWaiting();
    cancelPaint?.();
  };
}

/** The page's preload of the open card (`preloadDetailAfterFirstCards`),
 *  for the life of the page. */
export function useDetailPreload(): void {
  useEffect(() => preloadDetailAfterFirstCards(), []);
}

/** The open card: at once when its module is loaded, through a Suspense
 *  boundary above it otherwise. */
export function DetailView(props: ComponentProps<DetailModule["Detail"]>) {
  const Loaded = loadedDetail;
  return Loaded ? <Loaded {...props} /> : <LazyDetail {...props} />;
}
