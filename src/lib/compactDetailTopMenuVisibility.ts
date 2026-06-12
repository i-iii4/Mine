export const COMPACT_DETAIL_TOP_MENU_STORAGE_KEY = "mine.compactDetailTopMenu";

export function getStoredCompactDetailTopMenu(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(COMPACT_DETAIL_TOP_MENU_STORAGE_KEY) === "true";
}
