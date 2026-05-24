export const BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY = "mine.bottomActionBarHidden";

export function getStoredBottomActionBarHidden(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY) === "true";
}
