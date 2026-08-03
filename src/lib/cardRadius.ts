// Card and media corner rounding, driven from one place.
//
// `--radius-card` and `--radius-media` already exist as design tokens and are
// the only inputs to card and card-media rounding, so this setting overrides
// them on the root element rather than touching components.

export type CardRadius = 0 | 2 | 4 | 8 | 16;

export const CARD_RADIUS_STORAGE_KEY = "mine.cardRadius";

/// Available steps. `0` is the design-system default — square cards.
export const CARD_RADIUS_OPTIONS: readonly CardRadius[] = [0, 2, 4, 8, 16];

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
    // Leave the tokens to the stylesheet so the default stays a single source.
    root.style.removeProperty("--radius-card");
    root.style.removeProperty("--radius-media");
    return;
  }
  root.style.setProperty("--radius-card", `${radius}px`);
  root.style.setProperty("--radius-media", `${radius}px`);
}
