// The light theme's tokens that follow its canvas, derived by the colour
// rules (SPEC_COLOR_RULES.md, sections 2 and 3) from the canvas's lightness.
// The canvas of 1 gives the light block of global.css (colorLaw.test.ts
// holds the two equal); TRIAL (PLAN 47.7) applies the canvas 0.975 through
// lightCanvas.ts. The dark theme is carried from the canvas of 1 and does not
// follow.

import {
  FORM_RATIO,
  alphaForDelta,
  alphaOverForDelta,
  compositeLightness,
  contrastRatio,
  gamutChroma,
  greyFromOklch,
  over,
  rgbFromOklch,
} from "./colorLaw";

/** The light foreground (K2). */
export const LIGHT_FOREGROUND = 0.145;
/** One zone step of the light theme: K3 by the area form. */
const ZONE_STEP = -0.03 * FORM_RATIO.area;
/** The quiet step `s` (K7). */
const QUIET = 0.03;
/** The text contrast floor (K5) and the indicator floor (K6). */
const K5 = 4.5;
const K6 = 3;
/** The tertiary share (K8): the dim of the drop zone's glass is 1 minus it. */
const K8 = 0.26;
/** systemRed's hue and chroma (K12), the destructive colour of the theme. */
const RED = { lightness: 0.596, chroma: 0.232, hue: 28.7 };
/** Floating layers and the chrome stand on level 1. */
const FLOATING_LEVEL = 1;

const zone = (canvas: number, level: number) => canvas + level * ZONE_STEP;

function bisect(test: (value: number) => boolean, low: number, high: number): number {
  let lo = low;
  let hi = high;
  for (let step = 0; step < 60; step += 1) {
    const middle = (lo + hi) / 2;
    if (test(middle)) lo = middle;
    else hi = middle;
  }
  return lo;
}

/** The share of `fg` over `bg` whose composite reaches `target` contrast. */
function alphaForContrast(fg: number, bg: number, target: number): number {
  const lowest = bisect(
    (alpha) => contrastRatio(over(greyFromOklch(fg), alpha, greyFromOklch(bg)), greyFromOklch(bg)) < target,
    0,
    1,
  );
  return lowest;
}

/** The grey on `bg` that reaches `target` contrast, the brightest such. */
function greyForContrast(bg: number, target: number): number {
  return bisect((grey) => contrastRatio(greyFromOklch(grey), greyFromOklch(bg)) >= target, 0, 1);
}

const grey = (lightness: number) => `oklch(${round(lightness, 4)} 0 0)`;
const share = (alpha: number) => `${round(alpha * 100, 2)}%`;
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Every light token that follows the canvas, for a canvas of `canvas`. */
export function deriveLightLadder(canvas: number): Record<string, string> {
  const muted = alphaForContrast(LIGHT_FOREGROUND, canvas, K5);
  const ink = rgbFromOklch(RED.lightness, RED.chroma, RED.hue);
  const destructiveRest = alphaOverForDelta(ink, canvas, 2 * QUIET);
  const destructiveHover = alphaOverForDelta(ink, canvas, 3 * QUIET);
  // The destructive text reaches K5 on the hover fill over level 1.
  const hoverFill = over(ink, destructiveHover, greyFromOklch(zone(canvas, FLOATING_LEVEL)));
  const red = (lightness: number) => rgbFromOklch(lightness, gamutChroma(lightness, RED.hue, RED.chroma), RED.hue);
  const destructiveText = bisect((lightness) => contrastRatio(red(lightness), hoverFill) >= K5, 0, zone(canvas, FLOATING_LEVEL));
  const line = grey(zone(canvas, 2) - QUIET);
  const ring = grey(compositeLightness(LIGHT_FOREGROUND, muted, canvas));
  return {
    "--background": grey(canvas),
    "--sidebar": grey(zone(canvas, 1 / 3)),
    "--card": grey(zone(canvas, 1)),
    "--chrome": grey(zone(canvas, 1)),
    "--popover": grey(zone(canvas, FLOATING_LEVEL)),
    "--accent": grey(zone(canvas, 2)),
    "--secondary": grey(zone(canvas, 2)),
    "--muted": grey(zone(canvas, 2)),
    "--primary-foreground": grey(canvas),
    "--sidebar-primary-foreground": grey(canvas),
    "--muted-alpha": share(muted),
    "--active-alpha": share(alphaForDelta(LIGHT_FOREGROUND, canvas, QUIET)),
    "--border": line,
    "--sidebar-border": line,
    "--input": line,
    "--ring": ring,
    "--sidebar-ring": ring,
    "--border-accent": grey(greyForContrast(canvas, K6)),
    "--graphic-card-focus-overlay": `color-mix(in srgb, oklch(${LIGHT_FOREGROUND} 0 0) ${share(alphaForDelta(LIGHT_FOREGROUND, canvas, 3 * QUIET))}, transparent)`,
    "--destructive-fill-alpha": share(destructiveRest),
    "--destructive-fill-hover-alpha": share(destructiveHover),
    // Down, never up: the text must keep K5 once written with four digits.
    "--destructive-foreground": `oklch(${Math.floor(destructiveText * 1e4) / 1e4} ${round(gamutChroma(destructiveText, RED.hue, RED.chroma), 3)} ${RED.hue})`,
    "--glass-bg": `oklch(${round(canvas, 4)} 0 0 / ${share(1 - K8)})`,
  };
}
