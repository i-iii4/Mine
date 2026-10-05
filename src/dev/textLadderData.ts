// The signal ladder of the dark theme as the stylesheet draws it, measured on
// `/__text-ladder` (dev server only): the signal tokens the page lists and
// the pure wording of what it measures.

import { contrastRatio, oklabLightness, type Rgb } from "@/lib/colorLaw";

/** The dark signal tokens the page lists with their values. */
export const SIGNAL_TOKENS: readonly string[] = [
  "--active-alpha",
  "--muted-alpha",
  "--tertiary-alpha",
  "--inert-frame-elevation",
  "--border",
  "--sidebar-border",
  "--ring",
  "--sidebar-ring",
];

/** One line of the token list: tokens with the same value share it. */
export interface TokenLine {
  names: string[];
  value: string;
}

/** The signal tokens grouped by value, read from the stylesheet; a token the
 *  stylesheet does not set reads as an empty value. */
export function tokenLines(tokens: Readonly<Record<string, string>>): TokenLine[] {
  const lines: TokenLine[] = [];
  for (const name of SIGNAL_TOKENS) {
    const value = tokens[name] ?? "";
    const same = lines.find((line) => line.value === value);
    if (same) same.names.push(name);
    else lines.push({ names: [name], value });
  }
  return lines;
}

/** Colours measured on the page, by probe id. */
export type Readings = Readonly<Record<string, Rgb>>;

/** One thing a piece shows: `probe` against what lies under it, `against`.
 *  Text adds its WCAG contrast. */
export interface Fact {
  label: string;
  probe: string;
  against: string;
  text?: boolean;
}

/** The 8-bit grey level of a measured grey. */
export function level(color: Rgb): number {
  return Math.round(color.g * 255);
}

/** OKLab lightness difference of two colours. */
export function lightnessGap(a: Rgb, b: Rgb): number {
  return Math.abs(oklabLightness(a) - oklabLightness(b));
}

/** A fact in plain words with the measured numbers; null while one of its
 *  probes has not been measured. */
export function describeFact(fact: Fact, readings: Readings): string | null {
  const probe = readings[fact.probe];
  const under = readings[fact.against];
  if (!probe || !under) return null;
  const parts = [`${fact.label}: ${level(probe)} на ${level(under)}`, `ΔL ${lightnessGap(probe, under).toFixed(3)}`];
  if (fact.text) parts.push(`контраст ${contrastRatio(probe, under).toFixed(2)}`);
  return parts.join(", ");
}
