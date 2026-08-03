// Card corner rounding, driven from one place.
//
// Scope is deliberate: the setting rounds the card frame and the images shown in
// an expanded card, but never the media inside a feed card. Thumbnails sit edge
// to edge in the grid, where rounded corners read as noise; a single opened
// image is a standalone object and takes the same corner as the card frame.
//
// `--radius-card` is the only input to both, so the setting overrides that token
// on the root element rather than touching components. `--radius-media`, which
// drives feed-card media, is left at its stylesheet value.

export type CardRadius = 0 | 3;

export const CARD_RADIUS_STORAGE_KEY = "mine.cardRadius";

/// Available steps. `0` is the design-system default — square cards.
export const CARD_RADIUS_OPTIONS: readonly CardRadius[] = [0, 3];

const DEFAULT_CARD_RADIUS: CardRadius = 0;

function isCardRadius(value: number): value is CardRadius {
  return (CARD_RADIUS_OPTIONS as readonly number[]).includes(value);
}

export function getStoredCardRadius(): CardRadius {
  if (typeof window === "undefined") return DEFAULT_CARD_RADIUS;
  const raw = Number(window.localStorage.getItem(CARD_RADIUS_STORAGE_KEY));
  return isCardRadius(raw) ? raw : DEFAULT_CARD_RADIUS;
}

export function applyCardRadius(radius: CardRadius) {
  localStorage.setItem(CARD_RADIUS_STORAGE_KEY, String(radius));
  const root = document.documentElement;
  if (radius === DEFAULT_CARD_RADIUS) {
    // Leave the token to the stylesheet so the default stays a single source.
    root.style.removeProperty("--radius-card");
    return;
  }
  root.style.setProperty("--radius-card", `${radius}px`);
}
