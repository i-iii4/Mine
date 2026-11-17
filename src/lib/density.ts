// The feed's spacing, Display's Spacing: the gap between the feed's cards and
// the feed's insets, nothing else (user's decision of 15.11.2026). The shell
// outside the feed keeps its own interval, 16px (`--shell-rhythm`,
// global.css), and the chrome its 8px inset (`--chrome-edge-pad`).
//
// Published as a CSS variable on the root; the feed reads the number through
// a hook, because masonry geometry is computed in JS.

import { useSyncExternalStore } from "react";

/// The steps of the Display panel, in its order (user's decision of
/// 15.11.2026: 8 and 2 after 32, 24 and 16).
export type DensityStep = 32 | 24 | 16 | 8 | 2;

export const DENSITY_STEPS: readonly DensityStep[] = [32, 24, 16, 8, 2];

export const DENSITY_STORAGE_KEY = "mine.spacing";

/// Written with every choice from 15.11.2026 on. A stored 2 without it is
/// the 2px step retired on 24.09.2026, which has read as 16 since: it keeps
/// reading so, and the first choice written (every window writes the read
/// value at its start) carries the mark, so a 2 chosen now is 2.
export const DENSITY_STEPS_MARK_KEY = "mine.spacing.steps";
const DENSITY_STEPS_MARK = "32-24-16-8-2";

const DEFAULT_STEP: DensityStep = 32;

const SPACING_VAR = "--edge-rhythm";

function isStep(value: number): value is DensityStep {
  return (DENSITY_STEPS as readonly number[]).includes(value);
}

export function getStoredDensity(): DensityStep {
  if (typeof window === "undefined") return DEFAULT_STEP;
  const raw = Number(window.localStorage.getItem(DENSITY_STORAGE_KEY));
  if (raw === 2 && window.localStorage.getItem(DENSITY_STEPS_MARK_KEY) !== DENSITY_STEPS_MARK) return 16;
  return isStep(raw) ? raw : DEFAULT_STEP;
}

export function applyDensity(step: DensityStep) {
  localStorage.setItem(DENSITY_STORAGE_KEY, String(step));
  localStorage.setItem(DENSITY_STEPS_MARK_KEY, DENSITY_STEPS_MARK);
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
