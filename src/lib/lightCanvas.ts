// TRIAL (PLAN 47.7, user's request of 16.10.2026): the light theme's canvas,
// set in the Display panel. «White» is the canvas of today (L 1, K1), «Soft»
// a canvas of L 0.975, for a feed whose white glows too much. Once the user
// decides, this module either goes or the chosen canvas becomes K1.
//
// Soft writes, on the root, every light token that follows the canvas,
// derived from it by the colour rules (lightLadder.ts); everything derived in
// CSS from those tokens (fills, the scrim, the elevation map) follows by
// itself. It writes them only while the theme on screen is light, the
// explicit light theme or the system's, and takes them away the moment the
// theme turns dark: the dark theme does not change. Kept between launches in
// its own localStorage key; every tab, the tab bar and the settings window
// apply it and hear `settings-changed`.

import { useSyncExternalStore } from "react";
import { deriveLightLadder } from "./lightLadder";

/** The two canvases on trial. */
export type LightCanvas = "white" | "soft";

export const LIGHT_CANVAS_STORAGE_KEY = "mine.lightCanvas";
/** The canvas lightness of each choice. */
export const LIGHT_CANVAS_LIGHTNESS: Record<LightCanvas, number> = { white: 1, soft: 0.975 };
/** What the Display panel calls each choice. */
export const LIGHT_CANVAS_LABELS: Record<LightCanvas, string> = { white: "White", soft: "Soft" };

const SOFT_TOKENS = deriveLightLadder(LIGHT_CANVAS_LIGHTNESS.soft);

function readStored(): LightCanvas {
  try {
    return window.localStorage.getItem(LIGHT_CANVAS_STORAGE_KEY) === "soft" ? "soft" : "white";
  } catch {
    return "white";
  }
}

function writeStored(canvas: LightCanvas) {
  try {
    window.localStorage.setItem(LIGHT_CANVAS_STORAGE_KEY, canvas);
  } catch {
    // Unwritable storage (private mode, quota): the choice lasts this session.
  }
}

/** Whether the theme on screen is light: the explicit one, or the system's
 *  when none is chosen. */
function lightOnScreen(root: HTMLElement): boolean {
  const theme = root.getAttribute("data-theme");
  if (theme === "light") return true;
  if (theme === "dark") return false;
  return typeof window.matchMedia !== "function" || !window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Put `canvas` on `root`: the soft ladder while the light theme is on
 *  screen, nothing otherwise. */
export function applyLightCanvas(canvas: LightCanvas, root: HTMLElement = document.documentElement) {
  const soft = canvas === "soft" && lightOnScreen(root);
  for (const [name, value] of Object.entries(SOFT_TOKENS)) {
    if (soft) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  root.toggleAttribute("data-light-canvas-soft", soft);
}

let current: LightCanvas = typeof window === "undefined" ? "white" : readStored();
const listeners = new Set<() => void>();

function publish(next: LightCanvas) {
  current = next;
  if (typeof document !== "undefined") applyLightCanvas(next);
  for (const listener of listeners) listener();
}

if (typeof document !== "undefined") {
  applyLightCanvas(current);
  // The theme turns dark or light: by the person's choice (`data-theme`) or
  // by the system's.
  new MutationObserver(() => applyLightCanvas(current)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  if (typeof window.matchMedia === "function") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyLightCanvas(current));
  }
}

/** The canvas now. */
export function getLightCanvas(): LightCanvas {
  return current;
}

/** Choose the canvas and keep it. */
export function setLightCanvas(canvas: LightCanvas) {
  if (canvas === current) return;
  writeStored(canvas);
  publish(canvas);
}

/** Re-read storage: another tab or window chose (`settings-changed`). */
export function reloadLightCanvas() {
  publish(readStored());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The canvas, re-rendering when it changes. */
export function useLightCanvas(): LightCanvas {
  return useSyncExternalStore(subscribe, getLightCanvas, getLightCanvas);
}
