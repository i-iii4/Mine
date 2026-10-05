// The colour law of the signal role (SPEC_COLOR_RULES.md, 3.4): lines,
// frames, state layers, flat fills, focus and selection indicators and the
// secondary and tertiary text steps differ from what lies under them equally
// visibly in both themes. The difference is the OKLab lightness ΔL; dark on
// white reads sharper than light on dark (irradiation), so the dark theme
// needs the light ΔL divided by the coefficient of the signal's form: K4 for
// lines, frames, text and icons, K4a for areas (state layers, flat fills,
// the focus wash on an image). The light theme is the reference: its values
// stay and the dark ones are derived. Pure arithmetic, no DOM.

/** Light ΔL over dark ΔL of a signal that reads equally sharp in both
 *  themes, by the signal's form: K4 and K4a of SPEC_COLOR_RULES.md. */
export const FORM_RATIO = { line: 0.7, area: 0.51 } as const;

/** The form of a signal: thin strokes or areas. */
export type SignalForm = keyof typeof FORM_RATIO;

/** An opaque sRGB colour, gamma-encoded channels 0..1. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function encodeSrgb(linear: number): number {
  return clamp01(linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);
}

function decodeSrgb(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** An achromatic `oklch(L 0 0)` in sRGB: with no chroma the OKLab matrices
 *  give L³ in every linear channel. */
export function greyFromOklch(lightness: number): Rgb {
  const channel = encodeSrgb(lightness ** 3);
  return { r: channel, g: channel, b: channel };
}

/** `top` at `alpha` over an opaque `under`, per gamma-encoded sRGB channel:
 *  how the browser composites a colour with alpha and how
 *  `color-mix(in srgb, …)` mixes. */
export function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  const mix = (a: number, b: number) => a * alpha + b * (1 - alpha);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b) };
}

export function relativeLuminance(color: Rgb): number {
  return 0.2126 * decodeSrgb(color.r) + 0.7152 * decodeSrgb(color.g) + 0.0722 * decodeSrgb(color.b);
}

/** WCAG 2 contrast ratio, at least 1. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function oklabLightness(color: Rgb): number {
  const r = decodeSrgb(color.r);
  const g = decodeSrgb(color.g);
  const b = decodeSrgb(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** OKLab lightness of the grey `foreground` at `alpha` over the grey
 *  `surface`, both given as `oklch(L 0 0)` lightness. */
export function compositeLightness(foreground: number, alpha: number, surface: number): number {
  return oklabLightness(over(greyFromOklch(foreground), alpha, greyFromOklch(surface)));
}

/** The dark ΔL that reads as sharp as `lightDelta` does in the light theme,
 *  for a signal of `form`. */
export function darkSignalDelta(lightDelta: number, form: SignalForm): number {
  return lightDelta / FORM_RATIO[form];
}

const BISECTION_STEPS = 60;

/** The alpha of `foreground` over `surface` whose composite differs from
 *  `surface` by `delta` in OKLab lightness; 1 when even the opaque
 *  foreground stays closer. The difference grows with alpha, so bisection
 *  finds the one answer. */
export function alphaForDelta(foreground: number, surface: number, delta: number): number {
  const reach = (alpha: number) => Math.abs(compositeLightness(foreground, alpha, surface) - surface);
  if (reach(1) <= delta) return 1;
  let low = 0;
  let high = 1;
  for (let step = 0; step < BISECTION_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (reach(middle) < delta) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
