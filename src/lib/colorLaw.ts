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

/**
 * How opaque the cards and links outside a hovered collection's part are
 * drawn in the graph (K13 of SPEC_COLOR_RULES.md, user's decision of
 * 16.10.2026). Pictures keep their own contrast, so the secondary share 0.6
 * left them nearly unchanged; the tertiary tier dims them for real: macOS
 * `tertiaryLabelColor` 0.26, the graph libraries' faded share 0.25
 * (Cytoscape.js, AntV G6). One share in both themes. Collections are never
 * dimmed.
 */
export const GRAPH_CONTEXT_OPACITY = 0.25;

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

/** The linear sRGB channels of `oklch(L C h)`, unclipped: outside the gamut
 *  a channel leaves 0..1. */
function linearFromOklch(lightness: number, chroma: number, hue: number): [number, number, number] {
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** `oklch(L C h)` in sRGB, gamma-encoded and clipped to the gamut, as the
 *  browser paints it. */
export function rgbFromOklch(lightness: number, chroma: number, hue: number): Rgb {
  const [r, g, b] = linearFromOklch(lightness, chroma, hue);
  return { r: encodeSrgb(r), g: encodeSrgb(g), b: encodeSrgb(b) };
}

const GAMUT_EPSILON = 1e-6;

/** The most chroma, up to `cap`, that `oklch(L _ h)` keeps inside sRGB: a
 *  semantic colour's chroma cut to the gamut (SPEC_COLOR_RULES.md, 3.8). */
export function gamutChroma(lightness: number, hue: number, cap: number): number {
  const inside = (chroma: number) =>
    linearFromOklch(lightness, chroma, hue).every((channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON);
  if (inside(cap)) return cap;
  let low = 0;
  let high = cap;
  for (let step = 0; step < BISECTION_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (inside(middle)) low = middle;
    else high = middle;
  }
  return low;
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
  return alphaOverForDelta(greyFromOklch(foreground), surface, delta);
}

/** As `alphaForDelta`, for any colour `top` over the grey `surface`: the
 *  share of a semantic colour in a flat fill (`color-mix(in srgb, …)`). */
export function alphaOverForDelta(top: Rgb, surface: number, delta: number): number {
  const under = greyFromOklch(surface);
  const reach = (alpha: number) => Math.abs(oklabLightness(over(top, alpha, under)) - surface);
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
