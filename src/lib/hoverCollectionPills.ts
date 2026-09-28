// Whether the sidebar marks the collections of the card under the pointer
// with reference `Connected` pills (SPEC_CARD_STATES.md, С4). On by default.
//
// The switch covers the pointer only: the keyboard-focused card, a selection
// (С6) and an expanded card (С5) keep their marks whatever it says.
//
// Storage follows the same contract as the other Appearance toggles — the
// settings window writes localStorage and broadcasts the key, the main window
// re-reads it (see src/lib/settingsChanged.ts).

export const HOVER_COLLECTION_PILLS_STORAGE_KEY = "mine.hoverCollectionPills";

export function getStoredHoverCollectionPills(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(HOVER_COLLECTION_PILLS_STORAGE_KEY) !== "false";
}
