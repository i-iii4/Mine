export type ChromeSurfaceVariant = "variant1" | "variant2";

export const CHROME_SURFACE_VARIANT_STORAGE_KEY = "mine.chromeSurfaceVariant";

export function isChromeSurfaceVariant(value: string | null): value is ChromeSurfaceVariant {
  return value === "variant1" || value === "variant2";
}

export function getStoredChromeSurfaceVariant(): ChromeSurfaceVariant {
  if (typeof window === "undefined") return "variant1";
  const stored = window.localStorage.getItem(CHROME_SURFACE_VARIANT_STORAGE_KEY);
  return isChromeSurfaceVariant(stored) ? stored : "variant1";
}

export function isChromeSurfaceVariant2(value: ChromeSurfaceVariant): boolean {
  return value === "variant2";
}
