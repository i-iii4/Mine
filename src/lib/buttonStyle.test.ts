import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyButtonStyle,
  BUTTON_STYLES,
  buttonStyleNoticeTitle,
  buttonStyleOfWindow,
  DEFAULT_BUTTON_STYLE,
  nextButtonStyle,
  parseWindowButtonStyles,
  serializeWindowButtonStyles,
  shownButtonStyle,
  windowButtonStyleMessages,
  windowIdFromLabel,
  withWindowButtonStyle,
} from "./buttonStyle";

/// The dev button styles: each window's own style, how a bar spreads it to
/// its tab pages, and the rules src/styles/buttons.css draws them with.
describe("button style per window", () => {
  it("keeps one style per window id and starts a window at macOS", () => {
    const styles = withWindowButtonStyle({}, "w1", "retro");
    expect(buttonStyleOfWindow(styles, "w1")).toBe("retro");
    expect(buttonStyleOfWindow(styles, "w2")).toBe("macos");
    expect(buttonStyleOfWindow(styles, null)).toBe(DEFAULT_BUTTON_STYLE);
  });

  it("changes one window and leaves the others", () => {
    const before = { w1: "retro", w2: "retro" } as const;
    const after = withWindowButtonStyle(before, "w1", "linear");
    expect(after).toEqual({ w1: "linear", w2: "retro" });
    expect(before.w1).toBe("retro");
  });

  it("reads what it stored and drops anything else", () => {
    const stored = serializeWindowButtonStyles({ w1: "retro", w2: "linear" });
    expect(JSON.parse(stored)).toEqual({ w1: { buttons: "retro" }, w2: { buttons: "linear" } });
    expect(parseWindowButtonStyles(stored)).toEqual({ w1: "retro", w2: "linear" });
    expect(parseWindowButtonStyles(JSON.stringify({ w1: { buttons: "retro", other: 1 }, w2: "linear", w3: { buttons: "neon" } })))
      .toEqual({ w1: "retro" });
    expect(parseWindowButtonStyles("not json")).toEqual({});
    expect(parseWindowButtonStyles(JSON.stringify(["retro"]))).toEqual({});
    expect(parseWindowButtonStyles(null)).toEqual({});
  });

  it("finds the window in a window's and its bar's label, not in a tab's", () => {
    expect(windowIdFromLabel("window-abc")).toBe("abc");
    expect(windowIdFromLabel("tabbar-abc")).toBe("abc");
    expect(windowIdFromLabel("tab-abc")).toBeNull();
    expect(windowIdFromLabel("settings")).toBeNull();
  });

  it("sends the window's style to every tab and the notice to the visible one only", () => {
    expect(windowButtonStyleMessages("w1", "retro", ["a", "b"], "b", true)).toEqual([
      { label: "tab-a", payload: { window: "w1", style: "retro", notice: false } },
      { label: "tab-b", payload: { window: "w1", style: "retro", notice: true } },
    ]);
    expect(windowButtonStyleMessages("w1", "macos", ["a", "b"], "b", false).map(({ payload }) => payload.notice))
      .toEqual([false, false]);
  });

  it("steps the styles round macOS, Retro, Linear in menu order", () => {
    expect(BUTTON_STYLES.map(({ label }) => label)).toEqual(["macOS", "Retro", "Linear"]);
    expect(nextButtonStyle("macos")).toBe("retro");
    expect(nextButtonStyle("retro")).toBe("linear");
    expect(nextButtonStyle("linear")).toBe("macos");
  });

  it("marks the page: Retro and Linear by attribute, macOS by its absence", () => {
    const root = document.createElement("html");
    expect(shownButtonStyle(root)).toBe("macos");
    applyButtonStyle("retro", root);
    expect(root.getAttribute("data-buttons")).toBe("retro");
    expect(shownButtonStyle(root)).toBe("retro");
    applyButtonStyle("linear", root);
    expect(shownButtonStyle(root)).toBe("linear");
    applyButtonStyle("macos", root);
    expect(root.hasAttribute("data-buttons")).toBe(false);
  });

  it("names what a switch turned on", () => {
    expect(buttonStyleNoticeTitle("retro")).toBe("Buttons: Retro");
    expect(buttonStyleNoticeTitle("macos")).toBe("Buttons: macOS");
    expect(buttonStyleNoticeTitle("linear")).toBe("Buttons: Linear");
  });
});

describe("buttons.css", () => {
  const css = readFileSync("src/styles/buttons.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
  const isDark = (selector: string) => selector.includes('[data-theme="dark"]') || selector.includes('not([data-theme="light"])');
  // K7 and K4 (SPEC_COLOR_RULES.md, section 2).
  const QUIET = 0.03;
  const K4 = 0.7;

  it("anchors every rule on the root, and only the styles on data-buttons", () => {
    const selectors = [...css.matchAll(/([^{}]+)\{/g)]
      .map((match) => match[1].trim())
      .filter((selector) => selector && !selector.startsWith("@media"));
    expect(selectors.length).toBeGreaterThan(10);
    // Commas inside :is() and :not() do not start a new selector.
    const topLevelParts = (selector: string) => {
      const parts = [""];
      let depth = 0;
      for (const char of selector) {
        if (char === "(") depth += 1;
        if (char === ")") depth -= 1;
        if (char === "," && depth === 0) parts.push("");
        else parts[parts.length - 1] += char;
      }
      return parts;
    };
    for (const selector of selectors) {
      for (const part of topLevelParts(selector)) expect(part.trim().startsWith("html:root")).toBe(true);
    }
    expect(css).not.toContain("data-palette");
  });

  it("paints the face of every style from the surface under it", () => {
    const face = rules.find(({ body }) => body.includes("background-image: var(--button-face-layer);"));
    for (const carrier of [".bg-depth-fill", ".bg-component-fill-inner"]) {
      expect(face?.selector).toContain(carrier);
    }
    // A pill's chosen segment is its own carrier now (the list's button,
    // 07.10.2026): no trigger paints the face on `data-state`.
    expect(css).not.toContain('bg-component-fill-inner[data-state="active"]');
    expect(face?.selector).not.toContain("data-buttons");
    expect(face?.body).toContain("background-color: oklch(from var(--surface) clamp(0, calc(l + var(--button-face-step)), 1) 0 0);");
    // Hover and an open menu: the state layer over the face.
    const hover = rules.find(({ selector, body }) => selector.includes(":hover") && body.includes("var(--button-face-layer);") && !selector.includes("data-buttons"));
    expect(hover?.body).toContain("background-image: linear-gradient(var(--active), var(--active)), var(--button-face-layer);");
  });

  it("draws the retro edges only under data-buttons, with the approved steps", () => {
    const retro = rules.filter(({ selector, body }) => selector.includes('"retro"') && body.includes("--button-depth:"));
    expect(retro.length).toBe(3);
    for (const { selector, body } of retro) {
      expect(selector).toContain('[data-buttons="retro"]');
      expect(selector).toContain(":not(:disabled, :disabled > *)");
      expect(body).not.toMatch(/inset 0 0 0 0\.5px[^,]*,\s*0 /);
      expect(body.match(/inset/g)).toHaveLength(3);
    }
    const lightSteps = ["calc(l - 0.06)", "calc(l + 0.045)", "calc(l - 0.03)"];
    const darkSteps = ["calc(l - 0.0858)", "calc(l + 0.0643)", "calc(l - 0.0429)"];
    const light = retro.filter(({ selector }) => !isDark(selector));
    const dark = retro.filter(({ selector }) => isDark(selector));
    expect(light).toHaveLength(1);
    expect(dark).toHaveLength(2);
    for (const { body } of light) for (const step of lightSteps) expect(body).toContain(step);
    for (const { body } of dark) for (const step of darkSteps) expect(body).toContain(step);
  });

  it("draws the Linear buttons only under data-buttons, with the approved outline and shadow", () => {
    const linear = rules.filter(({ selector }) => selector.includes('"linear"'));
    expect(linear.length).toBe(5);
    // The steps on the root: the light block, then the dark ones.
    const steps = linear.filter(({ body }) => body.includes("--linear-ring-top:") || body.includes("--linear-face-white:"));
    const light = steps.find(({ selector }) => !isDark(selector));
    expect(light?.body).toMatch(/--linear-face-white: 60%;[\s\S]*--linear-face-step: 0;[\s\S]*--linear-ring-top: -0\.06;[\s\S]*--linear-ring-bottom: -0\.09;/);
    expect(light?.body).toContain("--button-depth: 0 1px 2px -1px rgb(0 0 0 / 0.1)");
    const dark = steps.filter(({ selector }) => isDark(selector));
    expect(dark).toHaveLength(2);
    for (const { body } of dark) {
      expect(body).toMatch(/--linear-face-white: 0%;[\s\S]*--linear-face-step: 0\.09;[\s\S]*--linear-ring-top: 0\.1758;[\s\S]*--linear-ring-bottom: 0\.1329;/);
      expect(body).toContain("--button-depth: 0 0.5px 1.5px rgb(0 0 0 / 0.5)");
    }
    const outline = linear.find(({ body }) => body.includes("border-width: 0.5px 0"));
    expect(outline?.body).toContain("box-sizing: border-box");
    expect(outline?.body).toContain("border-color: transparent");
    expect(outline?.body).toContain("var(--linear-ring) left / 0.5px 100% no-repeat border-box");
    expect(outline?.body).toContain("var(--linear-ring) right / 0.5px 100% no-repeat border-box");
    expect(outline?.body).toContain("padding-box,\n    var(--linear-ring) border-box");
    for (const { selector } of linear.filter(({ body }) => body.includes("--linear-face:") || body.includes("border-width"))) {
      expect(selector).toContain(":not(:disabled, :disabled > *)");
    }
    // The hover layer covers the whole button, the outline included, so the
    // outline rises with the face (05.10.2026).
    const hover = linear.find(({ body }) => body.includes("background:\n    linear-gradient(var(--active), var(--active)) border-box,"));
    expect(hover?.selector).toContain(":hover");
    expect(hover?.selector).toContain(".button-depth.state-active");
  });

  it("draws the macOS outline 1½ quiet line steps brighter than the face, rising with it, inside the box", () => {
    // The steps on the root: 1½ quiet line steps, darker in light, lighter in
    // dark (half a step up for legibility, user's decision of 07.10.2026).
    const tokens = rules.filter(({ body }) => body.includes("--macos-outline-step:"));
    expect(tokens).toHaveLength(3);
    const step = (body: string) => Number(/--macos-outline-step: (-?[\d.]+);/.exec(body)?.[1]);
    const light = tokens.find(({ selector }) => !isDark(selector));
    expect(step(light?.body ?? "")).toBeCloseTo(-1.5 * QUIET, 4);
    const dark = tokens.filter(({ selector }) => isDark(selector));
    expect(dark).toHaveLength(2);
    for (const { body } of dark) expect(step(body)).toBeCloseTo(1.5 * QUIET / K4, 4);

    const macos = rules.filter(({ selector }) => selector.includes(":not([data-buttons])") && !selector.includes(":active"));
    expect(macos).toHaveLength(2);
    const [rest, hover] = macos;
    // On every carrier the face rule paints, worked out there from its surface.
    for (const carrier of [".button-depth", ".bg-component-fill-inner"]) {
      expect(rest?.selector).toContain(carrier);
    }
    expect(rest?.selector).toContain(":not(:disabled, :disabled > *)");
    expect(rest?.body).toContain("oklch(from var(--surface) clamp(0, calc(l + var(--button-face-step)), 1) 0 0)");
    expect(rest?.body).toContain("var(--foreground) var(--button-face-share)");
    expect(rest?.body).toContain("--macos-outline-from: var(--macos-face);");
    // The outline alone, inside the box, so the box keeps its size.
    expect(rest?.body).toMatch(/box-shadow: inset 0 0 0 0\.5px oklch\(from var\(--macos-outline-from\) clamp\(0, calc\(l \+ var\(--macos-outline-step\)\), 1\) 0 0\);/);
    expect(rest?.body).not.toContain("var(--button-depth)");
    // Hover, an open menu and a selected key: from the face under the state
    // layer, wherever the face takes that layer.
    expect(hover?.body.trim()).toBe("--macos-outline-from: color-mix(in srgb, var(--macos-face), var(--foreground) var(--active-alpha));");
    const faceHover = rules.find(({ selector, body }) => selector.includes(":hover") && body.includes("var(--button-face-layer);") && !selector.includes("data-buttons"));
    const entries = (selector: string) => /:is\(([\s\S]*)\)\s*$/.exec(selector)?.[1].split(/,\s*\n/).map((entry) => entry.trim()) ?? [];
    expect(entries(faceHover?.selector ?? "").length).toBe(5);
    for (const entry of entries(faceHover?.selector ?? "")) expect(entries(hover?.selector ?? "")).toContain(entry);
    expect(entries(hover?.selector ?? "")).toEqual(expect.arrayContaining([".button-depth.state-active", ".bg-component-fill-inner.state-active"]));
  });

  it("flashes a pressed macOS button half a state layer instead of moving it", () => {
    // Retro and Linear keep the 1px press of global.css.
    const press = rules.filter(({ selector }) => selector.includes(":active"));
    expect(press).toHaveLength(1);
    const [rule] = press;
    expect(rule.selector).toContain(":not([data-buttons])");
    for (const carrier of [".button-depth:active:not(:disabled)", "button:active:not(:disabled) > .button-depth", "[data-action-button]:active > .button-depth"]) {
      expect(rule.selector).toContain(carrier);
    }
    expect(rule.body).toContain("transform: none;");
    expect(rule.body).toContain("linear-gradient(var(--press), var(--press)), linear-gradient(var(--active), var(--active)), var(--button-face-layer)");
    expect(rule.body).toContain("var(--foreground) calc(var(--active-alpha) / 2)");
  });
});
