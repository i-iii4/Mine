// Top-edge scroll fade preference. Off by default: the fade is an optional
// refinement, so a fresh install keeps the existing hard content edge.
//
// Storage follows the same contract as the other Appearance toggles — the
// settings window writes localStorage and broadcasts the key, the main window
// re-reads it (see src/lib/settingsChanged.ts).

export const SCROLL_EDGE_FADE_STORAGE_KEY = "mine.scrollEdgeFade";

export function getStoredScrollEdgeFade(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SCROLL_EDGE_FADE_STORAGE_KEY) === "true";
}
