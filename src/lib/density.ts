// Two independent density axes.
//
// `edge` is the app-wide edge rhythm: how far content sits from window edges and
// from the chrome — top and bottom bars, the sidebar table, the feed's side and
// top insets, the expanded card's columns and top offset.
//
// `cardGap` is the space between cards in the feed, and nothing else.
//
// They are separate because they answer different questions. The edge rhythm is
// about the frame around the interface; the card gap is about how densely the
// content itself is packed. Wanting cards tighter is not the same as wanting the
// whole interface tighter, and the previous single value forced both at once.
//
// Both are published as CSS variables on the root so stylesheets and Tailwind
// arbitrary values read them directly; the feed also reads the numbers through
// hooks, because masonry geometry is computed in JS.

import { useSyncExternalStore } from "react";

export type DensityStep = 32 | 24 | 16;

export const DENSITY_STEPS: readonly DensityStep[] = [32, 24, 16];

export const EDGE_DENSITY_STORAGE_KEY = "mine.edgeDensity";
export const CARD_GAP_STORAGE_KEY = "mine.cardGap";

const DEFAULT_STEP: DensityStep = 32;

const EDGE_VAR = "--edge-rhythm";
const CARD_GAP_VAR = "--card-gap";

function isStep(value: number): value is DensityStep {
  return (DENSITY_STEPS as readonly number[]).includes(value);
}

function readStored(key: string): DensityStep {
  if (typeof window === "undefined") return DEFAULT_STEP;
  const raw = Number(window.localStorage.getItem(key));
  return isStep(raw) ? raw : DEFAULT_STEP;
}

export function getStoredEdgeDensity(): DensityStep {
  return readStored(EDGE_DENSITY_STORAGE_KEY);
}

export function getStoredCardGap(): DensityStep {
  return readStored(CARD_GAP_STORAGE_KEY);
}

export function applyEdgeDensity(step: DensityStep) {
  localStorage.setItem(EDGE_DENSITY_STORAGE_KEY, String(step));
  document.documentElement.style.setProperty(EDGE_VAR, `${step}px`);
}

export function applyCardGap(step: DensityStep) {
  localStorage.setItem(CARD_GAP_STORAGE_KEY, String(step));
  document.documentElement.style.setProperty(CARD_GAP_VAR, `${step}px`);
}

function readVar(name: string): DensityStep {
  if (typeof document === "undefined") return DEFAULT_STEP;
  const raw = Number.parseInt(
    getComputedStyle(document.documentElement).getPropertyValue(name),
    10,
  );
  return isStep(raw) ? raw : DEFAULT_STEP;
}

function subscribe(onChange: () => void): () => void {
  // Both values live in the root element's inline style.
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });
  return () => observer.disconnect();
}

/// Edge rhythm in pixels, for layout computed in JS.
export function useEdgeDensity(): DensityStep {
  return useSyncExternalStore(
    subscribe,
    () => readVar(EDGE_VAR),
    () => DEFAULT_STEP,
  );
}

/// Gap between feed cards in pixels.
export function useCardGap(): DensityStep {
  return useSyncExternalStore(
    subscribe,
    () => readVar(CARD_GAP_VAR),
    () => DEFAULT_STEP,
  );
}
