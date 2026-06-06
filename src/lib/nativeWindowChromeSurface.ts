import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type NativeWindowChromeSurfaceToken = "--chrome" | "--accent";

const FALLBACK_SURFACE_COLORS: Record<"light" | "dark", Record<NativeWindowChromeSurfaceToken, string>> = {
  light: {
    "--chrome": "#fcfcfc",
    "--accent": "#f8f8f8",
  },
  dark: {
    "--chrome": "#0f0f0f",
    "--accent": "#121212",
  },
};

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function byteToHex(value: number): string {
  return clampByte(value).toString(16).padStart(2, "0");
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${byteToHex(red)}${byteToHex(green)}${byteToHex(blue)}`;
}

function oklabNeutralToHex(lightness: number): string {
  const linear = lightness ** 3;
  const srgb = linear <= 0.0031308
    ? 12.92 * linear
    : 1.055 * linear ** (1 / 2.4) - 0.055;
  const value = srgb * 255;
  return rgbToHex(value, value, value);
}

function parseCssColorToHex(color: string): string | null {
  const trimmed = color.trim();
  if (!trimmed) return null;

  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1]!
      .split(/[,\s/]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const values = parts.map(Number);
    const red = values[0];
    const green = values[1];
    const blue = values[2];
    if (
      red !== undefined &&
      green !== undefined &&
      blue !== undefined &&
      values.every(Number.isFinite)
    ) {
      return rgbToHex(red, green, blue);
    }
  }

  const oklchMatch = trimmed.match(/^oklch\(\s*([0-9.]+)\s+0(?:\.0+)?\s+0(?:\.0+)?(?:\s*\/\s*[0-9.%]+)?\s*\)$/i);
  if (oklchMatch) {
    const lightness = Number(oklchMatch[1]);
    if (Number.isFinite(lightness)) {
      return oklabNeutralToHex(lightness);
    }
  }

  return null;
}

function currentTheme(): "light" | "dark" {
  const explicitTheme = document.documentElement.getAttribute("data-theme");
  if (explicitTheme === "light") return "light";
  // high-contrast is a dark variant.
  if (explicitTheme === "dark" || explicitTheme === "high-contrast") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

export function resolveNativeWindowChromeSurfaceColor(
  surfaceToken: NativeWindowChromeSurfaceToken,
): string {
  const cssValue = getComputedStyle(document.documentElement).getPropertyValue(surfaceToken);
  return parseCssColorToHex(cssValue)
    ?? FALLBACK_SURFACE_COLORS[currentTheme()][surfaceToken];
}

export function useNativeWindowChromeSurface(
  surfaceToken: NativeWindowChromeSurfaceToken,
): void {
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let lastColor: string | null = null;

    const sync = () => {
      const nextColor = resolveNativeWindowChromeSurfaceColor(surfaceToken);
      if (disposed || nextColor === lastColor) return;
      lastColor = nextColor;
      void appWindow.setBackgroundColor(nextColor).catch(() => {});
    };

    sync();

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", sync);

    return () => {
      disposed = true;
      observer.disconnect();
      media?.removeEventListener("change", sync);
    };
  }, [surfaceToken]);
}
