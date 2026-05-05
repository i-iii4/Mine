export type DetailTopMenuMode = "classic" | "island";

const DETAIL_TOP_MENU_MODE_KEY = "detailTopMenuMode";
export const DETAIL_TOP_MENU_MODES: DetailTopMenuMode[] = ["classic", "island"];

export function getStoredDetailTopMenuMode(): DetailTopMenuMode {
  const value = localStorage.getItem(DETAIL_TOP_MENU_MODE_KEY);
  return DETAIL_TOP_MENU_MODES.includes(value as DetailTopMenuMode)
    ? (value as DetailTopMenuMode)
    : "island";
}

export function storeDetailTopMenuMode(mode: DetailTopMenuMode) {
  localStorage.setItem(DETAIL_TOP_MENU_MODE_KEY, mode);
}
