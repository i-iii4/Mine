// The open card, its own part of the bundle, loaded when a card first opens,
// or before that when the card's window is the chosen view
// (SPEC_CARD_PEEK.md, О12): a lazy component waits a render for a module it
// has not met, even a loaded one, and React holds a revealed Suspense
// boundary back for a moment, so the first window of a session would grow
// round an empty card and find its picture late. Once the module is loaded
// the card renders at once.

import { lazy, type ComponentProps } from "react";

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

/** Loads the open card's module and its editor's ahead of the first card. */
export function preloadDetail(): Promise<unknown> {
  return loadDetail().then((module) => module.preloadNoteEditor());
}

/** The open card: at once when its module is loaded, through a Suspense
 *  boundary above it otherwise. */
export function DetailView(props: ComponentProps<DetailModule["Detail"]>) {
  const Loaded = loadedDetail;
  return Loaded ? <Loaded {...props} /> : <LazyDetail {...props} />;
}
