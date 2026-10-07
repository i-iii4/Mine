import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  alphaForDelta,
  compositeLightness,
  contrastRatio,
  darkSignalDelta,
  FORM_RATIO,
  greyFromOklch,
  oklabLightness,
  over,
} from "@/lib/colorLaw";

// The colour rules (SPEC_COLOR_RULES.md): every theme token of global.css
// is derived here from the constants of section 2 by the laws of section 3,
// so a number typed past the law fails.

const css = readFileSync(path.join(process.cwd(), "src/styles/global.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Tokens = Record<string, string>;

/** The custom properties of the first rule after `opening`; theme rules
 *  hold no nested blocks, so the rule ends at the first closing brace. */
function ruleTokens(opening: RegExp): Tokens {
  const match = opening.exec(css);
  if (!match) throw new Error(`rule not found: ${opening}`);
  const start = match.index + match[0].length;
  const body = css.slice(start, css.indexOf("}", start));
  const tokens: Tokens = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[name] = value.trim();
  return tokens;
}

const LIGHT = ruleTokens(/(?:^|\n):root \{(?=[^}]*--muted-alpha)/);
const LIGHT_THEME = ruleTokens(/:root\[data-theme="light"\] \{/);
const DARK_SCHEME = ruleTokens(/@media \(prefers-color-scheme: dark\) \{\s*:root \{/);
const DARK = ruleTokens(/:root\[data-theme="dark"\] \{/);

const percent = (value: string | undefined) => Number(/([\d.]+)%/.exec(value ?? "")?.[1]);
const lightness = (value: string | undefined) => Number(/oklch\(([\d.]+)/.exec(value ?? "")?.[1]);

// The constants (SPEC_COLOR_RULES.md, section 2).
const FG = { light: 0.145, dark: 0.985 };
const CANVAS = { light: 1, dark: 0.14 };
const K3 = 0.03;
const K4 = FORM_RATIO.line;
const K4_AREA = FORM_RATIO.area;
const QUIET = 0.03;
const K8 = 0.26;
// Zones (3.2): levels in whole steps brighter than the page; the light step
// is the dark one for an area, K3 × K4a.
const ZONE_STEP = { light: -K3 * K4_AREA, dark: K3 };
const ZONE_LEVELS = { sidebar: 1 / 3, card: 1, chrome: 1, accent: 2, secondary: 2, muted: 2 } as const;
const zone = (theme: "light" | "dark", level: number) => CANVAS[theme] + level * ZONE_STEP[theme];
// Floating layers (3.3): light at the page's brightness, dark one step
// brighter than the brightest zone they open over.
const FLOATING_LEVEL = 3;

const alphaForContrast = (fg: number, bg: number, target: number) => {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    const ratio = contrastRatio(over(greyFromOklch(fg), middle, greyFromOklch(bg)), greyFromOklch(bg));
    if (ratio < target) low = middle;
    else high = middle;
  }
  return high;
};
const greyForContrast = (bg: number, target: number) => {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (contrastRatio(greyFromOklch(middle), greyFromOklch(bg)) < target) high = middle;
    else low = middle;
  }
  return low;
};
/** A text step carried from light to dark: line form. */
const darkAlpha = (lightAlpha: number) =>
  alphaForDelta(FG.dark, CANVAS.dark, darkSignalDelta(Math.abs(compositeLightness(FG.light, lightAlpha, CANVAS.light) - CANVAS.light), "line"));
const mutedLight = alphaForContrast(FG.light, CANVAS.light, 4.5);

describe("colour arithmetic", () => {
  it("reads an achromatic oklch back as its own lightness", () => {
    for (const value of [0.14, 0.243, 0.568, 0.985]) {
      expect(oklabLightness(greyFromOklch(value))).toBeCloseTo(value, 6);
    }
  });

  it("finds the alpha whose composite reaches the asked difference", () => {
    const alpha = alphaForDelta(0.985, 0.14, 0.05);
    expect(compositeLightness(0.985, alpha, 0.14) - 0.14).toBeCloseTo(0.05, 9);
    expect(alphaForDelta(0.985, 0.14, 0.9)).toBe(1);
  });

  it("carries a difference to the dark theme by the signal's form", () => {
    expect(darkSignalDelta(0.03, "line")).toBeCloseTo(0.03 / 0.7, 9);
    expect(darkSignalDelta(0.03, "area")).toBeCloseTo(0.03 / 0.51, 9);
  });
});

describe("theme blocks", () => {
  it("keeps the default light block equal to the explicit light theme", () => {
    for (const [name, value] of Object.entries(LIGHT_THEME)) expect(LIGHT[name], name).toBe(value);
  });

  it("keeps the system dark block equal to the explicit dark theme", () => {
    for (const [name, value] of Object.entries(DARK)) expect(DARK_SCHEME[name], name).toBe(value);
  });
});

describe("tokens follow the colour rules", () => {
  it("sets the zones on their levels and the floating layers above them", () => {
    for (const [name, level] of Object.entries(ZONE_LEVELS)) {
      expect(lightness(LIGHT[`--${name}`])).toBeCloseTo(zone("light", level), 4);
      expect(lightness(DARK[`--${name}`])).toBeCloseTo(zone("dark", level), 4);
    }
    expect(lightness(LIGHT["--background"])).toBe(CANVAS.light);
    expect(lightness(DARK["--background"])).toBe(CANVAS.dark);
    expect(lightness(LIGHT["--popover"])).toBe(CANVAS.light);
    expect(lightness(DARK["--popover"])).toBeCloseTo(zone("dark", FLOATING_LEVEL), 4);
    expect(FLOATING_LEVEL).toBe(Math.max(...Object.values(ZONE_LEVELS)) + 1);
  });

  it("draws text, primary and its ink on the two ends of the ladder", () => {
    for (const name of ["--foreground", "--card-foreground", "--popover-foreground", "--sidebar-foreground", "--secondary-foreground", "--accent-foreground", "--sidebar-accent-foreground", "--primary", "--sidebar-primary", "--feed-selection-frame"]) {
      expect(lightness(LIGHT[name]), name).toBe(FG.light);
      expect(lightness(DARK[name]), name).toBe(FG.dark);
    }
    for (const name of ["--primary-foreground", "--sidebar-primary-foreground"]) {
      expect(lightness(LIGHT[name]), name).toBe(CANVAS.light);
      expect(lightness(DARK[name]), name).toBe(CANVAS.dark);
    }
  });

  it("builds the light face as a hover plate and lifts the dark one three zone steps", () => {
    expect(Number(LIGHT["--button-face-step"])).toBe(0);
    expect(LIGHT["--button-face-layer"]).toBe("linear-gradient(var(--active), var(--active))");
    expect(LIGHT["--button-face-share"]).toBe("var(--active-alpha)");
    expect(Number(DARK["--button-face-step"])).toBeCloseTo(3 * ZONE_STEP.dark, 4);
    expect(DARK["--button-face-layer"]).toBe("none");
    expect(DARK["--button-face-share"]).toBe("0%");
  });

  it("draws the lines one line step brighter than the brightest zone they border", () => {
    const brightest = Math.max(...Object.values(ZONE_LEVELS));
    for (const name of ["--border", "--sidebar-border", "--input"]) {
      expect(lightness(LIGHT[name])).toBeCloseTo(zone("light", brightest) - QUIET, 4);
      expect(lightness(DARK[name])).toBeCloseTo(zone("dark", brightest) + QUIET / K4, 3);
    }
  });

  it("derives the text ladder: K5 on the light canvas, K8, then line form", () => {
    expect(percent(LIGHT["--muted-alpha"])).toBeCloseTo(mutedLight * 100, 1);
    expect(percent(LIGHT["--tertiary-alpha"])).toBeCloseTo(K8 * 100, 1);
    expect(percent(DARK["--muted-alpha"])).toBeCloseTo(darkAlpha(mutedLight) * 100, 1);
    expect(percent(DARK["--tertiary-alpha"])).toBeCloseTo(darkAlpha(K8) * 100, 1);
  });

  it("derives the quiet signals from one quiet step by their form", () => {
    expect(percent(LIGHT["--active-alpha"])).toBeCloseTo(alphaForDelta(FG.light, CANVAS.light, QUIET) * 100, 1);
    expect(percent(DARK["--active-alpha"])).toBeCloseTo(alphaForDelta(FG.dark, CANVAS.dark, darkSignalDelta(QUIET, "area")) * 100, 1);
    expect(Number(LIGHT["--inert-frame-elevation"])).toBeCloseTo(-QUIET, 4);
    expect(Number(DARK["--inert-frame-elevation"])).toBeCloseTo(darkSignalDelta(QUIET, "line"), 3);
    // The sidebar's line under the pointer: half a step, the user's least shift.
    expect(Number(LIGHT["--line-hover-elevation"])).toBeCloseTo(-QUIET / 2, 4);
    expect(Number(DARK["--line-hover-elevation"])).toBeCloseTo(darkSignalDelta(QUIET / 2, "line"), 3);
    expect(Number(LIGHT["--elevation-rest"])).toBeCloseTo(-2 * QUIET, 4);
    expect(Number(LIGHT["--elevation-hover"])).toBeCloseTo(-3 * QUIET, 4);
    expect(Number(DARK["--elevation-rest"])).toBeCloseTo(darkSignalDelta(2 * QUIET, "area"), 3);
    expect(Number(DARK["--elevation-hover"])).toBeCloseTo(darkSignalDelta(3 * QUIET, "area"), 3);
  });

  it("gives strong indicators text steps and the WCAG floor", () => {
    for (const name of ["--ring", "--sidebar-ring"]) {
      expect(lightness(LIGHT[name])).toBeCloseTo(compositeLightness(FG.light, mutedLight, CANVAS.light), 2);
      expect(lightness(DARK[name])).toBeCloseTo(compositeLightness(FG.dark, darkAlpha(mutedLight), CANVAS.dark), 2);
    }
    const focusLight = greyForContrast(CANVAS.light, 3);
    expect(lightness(LIGHT["--border-accent"])).toBeCloseTo(focusLight, 2);
    expect(lightness(DARK["--border-accent"])).toBeCloseTo(CANVAS.dark + darkSignalDelta(CANVAS.light - focusLight, "line"), 2);
    expect(percent(LIGHT["--graphic-card-focus-overlay"])).toBeCloseTo(alphaForDelta(FG.light, CANVAS.light, 3 * QUIET) * 100, 1);
    expect(percent(DARK["--graphic-card-focus-overlay"])).toBeCloseTo(alphaForDelta(FG.dark, CANVAS.dark, darkSignalDelta(3 * QUIET, "area")) * 100, 1);
  });

  it("dims to the tertiary step", () => {
    expect(percent(LIGHT["--glass-bg"])).toBeCloseTo((1 - K8) * 100, 1);
    expect(percent(DARK["--glass-bg"])).toBeCloseTo((1 - darkAlpha(K8)) * 100, 1);
  });
});
