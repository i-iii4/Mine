import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  alphaForDelta,
  alphaOverForDelta,
  compositeLightness,
  contrastRatio,
  darkSignalDelta,
  GRAPH_CONTEXT_OPACITY,
  FORM_RATIO,
  gamutChroma,
  greyFromOklch,
  oklabLightness,
  over,
  rgbFromOklch,
  type Rgb,
} from "@/lib/colorLaw";
import { deriveLightLadder } from "@/lib/lightLadder";

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
  // Both groups are required by the pattern, so every match carries them.
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[name!] = value!.trim();
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
// Floating layers (3.3): on the chrome's level 1 in both themes, the page
// row under the tab bar (user's decision of 07.10.2026), held by their line
// and shadow.
const FLOATING_LEVEL = 1;

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
  it("sets the zones on their levels and the floating layers on the chrome's", () => {
    for (const [name, level] of Object.entries(ZONE_LEVELS)) {
      expect(lightness(LIGHT[`--${name}`])).toBeCloseTo(zone("light", level), 4);
      expect(lightness(DARK[`--${name}`])).toBeCloseTo(zone("dark", level), 4);
    }
    expect(lightness(LIGHT["--background"])).toBe(CANVAS.light);
    expect(lightness(DARK["--background"])).toBe(CANVAS.dark);
    expect(lightness(LIGHT["--popover"])).toBeCloseTo(zone("light", FLOATING_LEVEL), 4);
    expect(lightness(DARK["--popover"])).toBeCloseTo(zone("dark", FLOATING_LEVEL), 4);
    expect(LIGHT["--popover"]).toBe(LIGHT["--chrome"]);
    expect(DARK["--popover"]).toBe(DARK["--chrome"]);
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
    // The pill's chosen segment, from the surface under it (user's decision
    // of 07.10.2026): 1¼ s in light, 1¾ s in dark, so a quarter and three
    // quarters of an s brighter than its track, the hover plate's state
    // layer. A fill, so the area form.
    expect(Number(LIGHT["--pill-chosen-elevation"])).toBeCloseTo(-1.25 * QUIET, 4);
    expect(Number(DARK["--pill-chosen-elevation"])).toBeCloseTo(darkSignalDelta(1.75 * QUIET, "area"), 3);
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

  it("derives the destructive button: a flat fill of 2 s and 3 s, its text K5 on the hover fill (3.8)", () => {
    // K12: the hue and chroma of systemRed; the chroma is cut to sRGB.
    const RED = { hue: 28.7, chroma: 0.232 };
    const parts = (value: string | undefined): [number, number, number] => {
      const match = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(value ?? "");
      return [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
    };
    const ink = (tokens: Tokens) => {
      const [l, c, h] = parts(tokens["--destructive"]);
      return rgbFromOklch(l, c, h);
    };
    const share = {
      light: {
        rest: alphaOverForDelta(ink(LIGHT), CANVAS.light, 2 * QUIET),
        hover: alphaOverForDelta(ink(LIGHT), CANVAS.light, 3 * QUIET),
      },
      dark: {
        rest: alphaOverForDelta(ink(DARK), CANVAS.dark, darkSignalDelta(2 * QUIET, "area")),
        hover: alphaOverForDelta(ink(DARK), CANVAS.dark, darkSignalDelta(3 * QUIET, "area")),
      },
    };
    expect(percent(LIGHT["--destructive-fill-alpha"])).toBeCloseTo(share.light.rest * 100, 1);
    expect(percent(LIGHT["--destructive-fill-hover-alpha"])).toBeCloseTo(share.light.hover * 100, 1);
    expect(percent(DARK["--destructive-fill-alpha"])).toBeCloseTo(share.dark.rest * 100, 1);
    expect(percent(DARK["--destructive-fill-hover-alpha"])).toBeCloseTo(share.dark.hover * 100, 1);

    // The text is measured on the hover fill over level 1, where windows
    // (floating layers) and the chrome stand: the darker fill of the two
    // the button stands on in light, the brighter in dark.
    const hoverFill = (theme: "light" | "dark", tokens: Tokens): Rgb =>
      over(ink(tokens), share[theme].hover, greyFromOklch(zone(theme, FLOATING_LEVEL)));
    const red = (lightness: number) => rgbFromOklch(lightness, gamutChroma(lightness, RED.hue, RED.chroma), RED.hue);
    const lightFill = hoverFill("light", LIGHT);
    let low = 0;
    let high = oklabLightness(lightFill);
    for (let step = 0; step < 60; step += 1) {
      const middle = (low + high) / 2;
      if (contrastRatio(red(middle), lightFill) >= 4.5) low = middle;
      else high = middle;
    }
    const lightText = low;
    const [lightL, lightC, lightH] = parts(LIGHT["--destructive-foreground"]);
    expect(lightL).toBeCloseTo(lightText, 3);
    expect(lightC).toBeCloseTo(gamutChroma(lightText, RED.hue, RED.chroma), 3);
    expect(lightH).toBe(RED.hue);
    // Dark by the line form: as far from its fill as the light text is.
    const darkText = oklabLightness(hoverFill("dark", DARK))
      + darkSignalDelta(oklabLightness(lightFill) - lightText, "line");
    const [darkL, darkC, darkH] = parts(DARK["--destructive-foreground"]);
    expect(darkL).toBeCloseTo(darkText, 3);
    expect(darkC).toBeCloseTo(gamutChroma(darkText, RED.hue, RED.chroma), 3);
    expect(darkH).toBe(RED.hue);
    // Both reach K5 on the hover fill as written.
    expect(contrastRatio(rgbFromOklch(lightL, lightC, lightH), lightFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rgbFromOklch(darkL, darkC, darkH), hoverFill("dark", DARK))).toBeGreaterThanOrEqual(4.5);
  });

  // K12 (section 2): the system colours of macOS as sRGB, light appearance;
  // red and orange as K12 has held them since 05.10.2026, the others from
  // AppKit's NSColor on macOS 27.2 (18.10.2026).
  const SYSTEM_COLORS = {
    red: [255, 59, 48],
    orange: [255, 149, 0],
    yellow: [255, 204, 0],
    green: [52, 199, 89],
    cyan: [0, 192, 232],
    blue: [0, 136, 255],
    purple: [203, 48, 224],
  } as const satisfies Record<string, readonly [number, number, number]>;
  type SystemColor = keyof typeof SYSTEM_COLORS;
  /** Hue (one decimal) and chroma (three) of a system colour, as K12 writes them. */
  const hueAndChroma = (name: SystemColor) => {
    const linear = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const [red, green, blue] = SYSTEM_COLORS[name];
    const [r, g, b] = [linear(red), linear(green), linear(blue)] as const;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const hue = (Math.atan2(bb, a) * 180) / Math.PI;
    return { hue: Math.round((hue < 0 ? hue + 360 : hue) * 10) / 10, chroma: Math.round(Math.hypot(a, bb) * 1000) / 1000 };
  };
  const oklchParts = (value: string | undefined): [number, number, number] => {
    const match = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(value ?? "");
    return [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
  };
  const bisect = (holds: (value: number) => boolean, low: number, high: number) => {
    let lo = low;
    let hi = high;
    for (let step = 0; step < 60; step += 1) {
      const middle = (lo + hi) / 2;
      if (holds(middle)) lo = middle;
      else hi = middle;
    }
    return lo;
  };

  it("derives the semantic text colours: macOS's hue and chroma, K5 on the light canvas, the dark by the line form (3.8)", () => {
    const TEXT: ReadonlyArray<readonly [string, SystemColor]> = [
      ["--destructive", "red"],
      ["--detach", "orange"],
      ["--callout-blue", "blue"],
      ["--callout-cyan", "cyan"],
      ["--callout-green", "green"],
      ["--callout-purple", "purple"],
    ];
    const canvas = { light: greyFromOklch(CANVAS.light), dark: greyFromOklch(CANVAS.dark) };
    for (const [token, name] of TEXT) {
      const { hue, chroma } = hueAndChroma(name);
      const ink = (l: number) => rgbFromOklch(l, gamutChroma(l, hue, chroma), hue);
      // The brightest lightness that keeps K5 on the white canvas.
      const light = bisect((l) => contrastRatio(ink(l), canvas.light) >= 4.5, 0, 1);
      const dark = CANVAS.dark + darkSignalDelta(CANVAS.light - light, "line");
      for (const [theme, tokens, expected] of [["light", LIGHT, light], ["dark", DARK, dark]] as const) {
        const [l, c, h] = oklchParts(tokens[token]);
        expect(l, `${token} ${theme}`).toBeCloseTo(expected, 3);
        expect(c, `${token} ${theme}`).toBeCloseTo(gamutChroma(l, hue, chroma), 2);
        expect(h, `${token} ${theme}`).toBe(hue);
        expect(contrastRatio(rgbFromOklch(l, c, h), canvas[theme]), `${token} ${theme}`).toBeGreaterThan(4.49);
      }
    }
  });

  it("derives the series of a diagram: an area under the foreground text, K5 against K2 of its theme (3.8)", () => {
    const foreground = { light: greyFromOklch(FG.light), dark: greyFromOklch(FG.dark) };
    for (const name of Object.keys(SYSTEM_COLORS) as SystemColor[]) {
      const token = `--series-${name}`;
      const { hue, chroma } = hueAndChroma(name);
      const fill = (l: number) => rgbFromOklch(l, gamutChroma(l, hue, chroma), hue);
      // Light: the darkest fill dark text still reads on; dark: the brightest
      // fill light text still reads on.
      const light = 1 - bisect((x) => contrastRatio(fill(1 - x), foreground.light) >= 4.5, 0, 1);
      const dark = bisect((l) => contrastRatio(fill(l), foreground.dark) >= 4.5, 0, 1);
      for (const [theme, tokens, expected] of [["light", LIGHT, light], ["dark", DARK, dark]] as const) {
        const [l, c, h] = oklchParts(tokens[token]);
        expect(l, `${token} ${theme}`).toBeCloseTo(expected, 3);
        expect(c, `${token} ${theme}`).toBeCloseTo(gamutChroma(l, hue, chroma), 2);
        expect(h, `${token} ${theme}`).toBe(hue);
        const drawn = rgbFromOklch(l, c, h);
        expect(contrastRatio(drawn, foreground[theme]), `${token} ${theme}`).toBeGreaterThanOrEqual(4.5);
        // A slice or a bar stands out from the canvas as an indicator (K6).
        expect(contrastRatio(drawn, greyFromOklch(CANVAS[theme])), `${token} ${theme}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("colours highlighted code exactly as highlight.js 11.11.2's GitHub themes do (SPEC_READING_MODE.md, Ч6.4)", () => {
    const highlightJs = path.join(process.cwd(), "node_modules/highlight.js");
    expect(JSON.parse(readFileSync(path.join(highlightJs, "package.json"), "utf8")).version).toBe("11.11.2");
    /** Each selector of a stylesheet with the declarations of its rule. */
    const rules = (text: string) => {
      const found = new Map<string, Record<string, string>>();
      for (const [, selectors, body] of text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const declarations = Object.fromEntries(
          [...body!.matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)].map(([, name, value]) => [name!, value!]),
        );
        for (const selector of selectors!.split(",")) {
          const key = selector.trim().replace(/^\.mine-article \[data-code-block\] /, "");
          found.set(key, { ...found.get(key), ...declarations });
        }
      }
      return found;
    };
    // The article's rules, `:is()` lists opened, `var(--x)` read from a theme.
    const article = new Map<string, Record<string, string>>();
    const articleCss = readFileSync("src/styles/article.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const highlightRule = /\.mine-article \[data-code-block\] (?::is\(([^)]*)\)|(\.hljs-[\w-]+))\s*\{([^}]*)\}/g;
    for (const [, list, single, body] of articleCss.matchAll(highlightRule)) {
      const declarations = Object.fromEntries([...body!.matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*;/g)].map(([, name, value]) => [name!, value!]));
      for (const selector of (list ?? single!).split(",")) article.set(selector.trim(), declarations);
    }
    expect(article.size).toBeGreaterThan(30);
    for (const [file, tokens] of [["github.css", LIGHT], ["github-dark.css", DARK]] as const) {
      const github = rules(readFileSync(path.join(highlightJs, "styles", file), "utf8"));
      const base = github.get(".hljs")?.color;
      for (const [selector, declarations] of github) {
        if (!selector.startsWith(".hljs-")) continue;
        const ours = article.get(selector);
        if (!declarations.color) {
          // What the theme leaves alone keeps the block's own text.
          expect(ours, `${file} ${selector}`).toBeUndefined();
          continue;
        }
        const resolve = (value: string | undefined) => {
          const variable = /^var\((--[\w-]+)\)$/.exec(value ?? "")?.[1];
          return variable === "--tw-prose-pre-code" ? base : variable ? tokens[variable] : value;
        };
        expect(resolve(ours?.color), `${file} ${selector}`).toBe(declarations.color);
        if (declarations["background-color"]) {
          expect(resolve(ours?.["background-color"]), `${file} ${selector} fill`).toBe(declarations["background-color"]);
        }
      }
    }
  });

  it("dims to the tertiary step", () => {
    expect(percent(LIGHT["--glass-bg"])).toBeCloseTo((1 - K8) * 100, 1);
    expect(percent(DARK["--glass-bg"])).toBeCloseTo((1 - darkAlpha(K8)) * 100, 1);
  });

  it("derives the light tokens that follow the canvas: the block of today from 1, the Soft trial from 0.975 (PLAN 47.7)", () => {
    const numberOf = (value: string | undefined) => Number(/(?:oklch\(|\s)([\d.]+)(?=\s0 0|%)/.exec(value ?? "")?.[1]);
    const white = deriveLightLadder(CANVAS.light);
    // The derivation is the law: at the canvas of 1 it gives the light block.
    for (const [name, value] of Object.entries(white)) {
      if (value.includes("%")) expect(percent(value), name).toBeCloseTo(percent(LIGHT[name]), 1);
      else expect(lightness(value), name).toBeCloseTo(lightness(LIGHT[name]), 2);
    }
    // At 0.975 every step keeps today's relations to its canvas.
    const SOFT = 0.975;
    const soft = deriveLightLadder(SOFT);
    expect(lightness(soft["--background"])).toBe(SOFT);
    for (const [name, level] of Object.entries(ZONE_LEVELS)) {
      expect(lightness(soft[`--${name}`]), name).toBeCloseTo(SOFT + level * ZONE_STEP.light, 4);
    }
    expect(lightness(soft["--popover"])).toBeCloseTo(SOFT + FLOATING_LEVEL * ZONE_STEP.light, 4);
    expect(lightness(soft["--border"])).toBeCloseTo(SOFT + 2 * ZONE_STEP.light - QUIET, 4);
    const softMuted = alphaForContrast(FG.light, SOFT, 4.5);
    expect(percent(soft["--muted-alpha"])).toBeCloseTo(softMuted * 100, 1);
    expect(percent(soft["--active-alpha"])).toBeCloseTo(alphaForDelta(FG.light, SOFT, QUIET) * 100, 1);
    expect(lightness(soft["--ring"])).toBeCloseTo(compositeLightness(FG.light, softMuted, SOFT), 3);
    expect(lightness(soft["--border-accent"])).toBeCloseTo(greyForContrast(SOFT, 3), 3);
    expect(lightness(soft["--primary-foreground"])).toBe(SOFT);
    expect(percent(soft["--glass-bg"])).toBe(74);
    expect(numberOf(soft["--glass-bg"])).toBe(SOFT);
    // The destructive text still reaches K5 on its hover fill over level 1.
    const [l, c, h] = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(soft["--destructive-foreground"] ?? "")?.slice(1).map(Number) ?? [];
    const ink = rgbFromOklch(0.596, 0.232, 28.7);
    const hover = alphaOverForDelta(ink, SOFT, 3 * QUIET);
    expect(percent(soft["--destructive-fill-hover-alpha"])).toBeCloseTo(hover * 100, 1);
    const fill = over(ink, hover, greyFromOklch(SOFT + FLOATING_LEVEL * ZONE_STEP.light));
    expect(contrastRatio(rgbFromOklch(l!, c!, h!), fill)).toBeGreaterThanOrEqual(4.5);
  });

  it("fades the graph's context to the tertiary tier, collections excepted (K13, 3.9.4, 16.10.2026)", () => {
    // macOS tertiaryLabelColor 0.26 (K8); Cytoscape.js and AntV G6 fade to 0.25.
    expect(GRAPH_CONTEXT_OPACITY).toBe(0.25);
    expect(GRAPH_CONTEXT_OPACITY).toBeCloseTo(K8, 1);
    // One owner: the graph takes its share from the law and reads no scrim.
    const graph = readFileSync("src/components/GraphView.tsx", "utf8");
    expect(graph).toContain("GRAPH_CONTEXT_OPACITY");
    expect(graph).toMatch(/node\.kind === "collection"\s*\?\s*1/);
    for (const file of ["src/components/graph/canvas.ts", "src/components/graph/hoverDim.ts", "src/components/GraphView.tsx"]) {
      expect(readFileSync(file, "utf8"), file).not.toContain("--scrim-color");
    }
  });

  it("dims under the scrim by the canvas of each theme at 32 % (3.9.1, 16.10.2026)", () => {
    // One value from the palette: the canvas, whatever the theme, at the
    // share of Material 3's scrim; no theme writes a scrim colour of its own.
    const css = readFileSync("src/styles/global.css", "utf8");
    const written = css.match(/--scrim-color:[^;]*;/g) ?? [];
    expect(written).toEqual(["--scrim-color: color-mix(in oklch, var(--background) 32%, transparent);"]);
    for (const theme of [LIGHT, LIGHT_THEME, DARK_SCHEME, DARK]) {
      expect(theme["--scrim-color"]).toBeUndefined();
    }
  });

  it("takes every colour of the article from a token (SPEC_READING_MODE.md, Ч0.4)", () => {
    const article = readFileSync("src/styles/article.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const declared = Object.fromEntries(
      [...article.matchAll(/(--tw-prose-[a-z-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]?.trim()]),
    );
    const variables = ["body", "headings", "lead", "links", "bold", "counters", "bullets", "hr", "quotes", "quote-borders", "captions", "kbd", "kbd-shadows", "code", "pre-code", "pre-bg", "th-borders", "td-borders"];
    expect(variables).toHaveLength(18);
    for (const name of variables) {
      for (const variable of [`--tw-prose-${name}`, `--tw-prose-invert-${name}`]) {
        expect(declared[variable], variable).toMatch(/^(var\(--[a-z-]+\)|transparent)$/);
      }
    }
    expect(Object.keys(declared)).toHaveLength(36);
    // Nothing else of the article's stylesheet names a colour by number.
    expect(article).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(|hsla?\(/i);
  });
});
