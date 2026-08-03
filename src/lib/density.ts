// Interface spacing — one value behind every gap that separates content.
//
// It drives the distance from window edges and chrome (top and bottom bars, the
// sidebar table, the feed's side and top insets, the expanded card's columns and
// top offset) and the gap between feed cards. One rhythm, applied everywhere:
// spacing that varies per surface reads as inconsistency, not as intent.
//
// Published as a CSS variable on the root so stylesheets and Tailwind arbitrary
// values read it directly; the feed also reads the number through a hook,
// because masonry geometry is computed in JS.

import { useSyncExternalStore } from "react";

export type DensityStep = 32 | 24 | 16;

export const DENSITY_STEPS: readonly DensityStep[] = [32, 24, 16];

export const DENSITY_STORAGE_KEY = "mine.spacing";

const DEFAULT_STEP: DensityStep = 32;

const SPACING_VAR = "--edge-rhythm";

function isStep(value: number): value is DensityStep {
  return (DENSITY_STEPS as readonly number[]).includes(value);
}

export function getStoredDensity(): DensityStep {
  if (typeof window === "undefined") return DEFAULT_STEP;
  const raw = Number(window.localStorage.getItem(DENSITY_STORAGE_KEY));
  return isStep(raw) ? raw : DEFAULT_STEP;
}

export function applyDensity(step: DensityStep) {
  localStorage.setItem(DENSITY_STORAGE_KEY, String(step));
  document.documentElement.style.setProperty(SPACING_VAR, `${step}px`);
}

function readVar(): DensityStep {
  if (typeof document === "undefined") return DEFAULT_STEP;
  const raw = Number.parseInt(
    getComputedStyle(document.documentElement).getPropertyValue(SPACING_VAR),
    10,
  );
  return isStep(raw) ? raw : DEFAULT_STEP;
}

function subscribe(onChange: () => void): () => void {
  // The value lives in the root element's inline style.
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });
  return () => observer.disconnect();
}

/// Spacing in pixels, for layout computed in JS.
export function useDensity(): DensityStep {
  return useSyncExternalStore(subscribe, readVar, () => DEFAULT_STEP);
}
