export type DetailTopMenuMode = "classic" | "island";
export type ChannelDisplayMode = "row" | "card";

const DETAIL_TOP_MENU_MODE_KEY = "detailTopMenuMode";
const CHANNEL_DISPLAY_MODE_KEY = "channelDisplayMode";
export const DETAIL_TOP_MENU_MODES: DetailTopMenuMode[] = ["classic", "island"];
export const CHANNEL_DISPLAY_MODES: ChannelDisplayMode[] = ["row", "card"];

export function getStoredDetailTopMenuMode(): DetailTopMenuMode {
  const value = localStorage.getItem(DETAIL_TOP_MENU_MODE_KEY);
  return DETAIL_TOP_MENU_MODES.includes(value as DetailTopMenuMode)
    ? (value as DetailTopMenuMode)
    : "island";
}

export function storeDetailTopMenuMode(mode: DetailTopMenuMode) {
  localStorage.setItem(DETAIL_TOP_MENU_MODE_KEY, mode);
}

export function getStoredChannelDisplayMode(): ChannelDisplayMode {
  const value = localStorage.getItem(CHANNEL_DISPLAY_MODE_KEY);
  return CHANNEL_DISPLAY_MODES.includes(value as ChannelDisplayMode)
    ? (value as ChannelDisplayMode)
    : "row";
}

export function storeChannelDisplayMode(mode: ChannelDisplayMode) {
  localStorage.setItem(CHANNEL_DISPLAY_MODE_KEY, mode);
}
