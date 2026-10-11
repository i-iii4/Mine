import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/styles/global.css"), "utf8");

describe("surface tokens", () => {
  it("keeps the dark card surface visibly lifted from the page background", () => {
    expect(css).toMatch(/--background:\s*oklch\(0\.14 0 0\);/);
    expect(css).toMatch(/--card:\s*oklch\(0\.17 0 0\);/);
    expect(css).not.toMatch(/--card:\s*oklch\(0\.14 0 0\);/);
  });

  it("paints a highlight as a state layer over what lies below and publishes it", () => {
    // The values themselves follow the colour rules (colorLaw.test.ts).
    expect(css.match(/--active-alpha:\s*[\d.]+%;/g)).toHaveLength(4);
    expect(css).toMatch(
      /--active:\s*color-mix\(in srgb, var\(--foreground\) var\(--active-alpha\), transparent\);/,
    );
    expect(css).toMatch(/@utility state-active \{\s*background-image: linear-gradient\(var\(--active\), var\(--active\)\);\s*@apply state-surface;/);
    // The layer keeps the surface it stands on and passes itself on to what
    // it holds, so a layer inside a layer stacks exactly.
    expect(css).toMatch(
      /@utility state-surface \{\s*--under: var\(--surface\);\s*& > \* \{\s*--surface: color-mix\(in srgb, var\(--under\), var\(--foreground\) var\(--active-alpha\)\);\s*@apply surface-fills;/,
    );
    expect(css).not.toMatch(/--active-elevation/);
    expect(css).not.toMatch(/data-surface-zone/);
  });

  it("sets secondary and tertiary text as the foreground with alpha", () => {
    // The alphas themselves follow the colour rules (colorLaw.test.ts).
    expect(css.match(/--muted-alpha:\s*[\d.]+%;/g)).toHaveLength(4);
    expect(css.match(/--tertiary-alpha:\s*[\d.]+%;/g)).toHaveLength(4);
    expect(css).toMatch(/--muted-foreground:\s*color-mix\(in srgb, var\(--foreground\) var\(--muted-alpha\), transparent\);/);
    expect(css).not.toMatch(/--muted-foreground:\s*oklch/);
    expect(css).not.toMatch(/--hover-foreground/);
  });

  it("keeps one opaque line colour per theme, field frames equal to it", () => {
    // Opaque: no alpha in any theme block; the values are pinned by the
    // colour rules (colorLaw.test.ts).
    expect(css.match(/--border:\s*oklch\([\d.]+ 0 0\);/g)).toHaveLength(4);
    for (const line of ["0\\.9394", "0\\.243"]) {
      expect(css.match(new RegExp(`--border:\\s*oklch\\(${line} 0 0\\);`, "g"))).toHaveLength(2);
      expect(css.match(new RegExp(`--input:\\s*oklch\\(${line} 0 0\\);`, "g"))).toHaveLength(2);
    }
  });

  it("presses only a button with depth", () => {
    expect(css).not.toMatch(/button:active:not\(:disabled\):not\(\[aria-haspopup\]\)/);
    expect(css).toMatch(
      /\.button-depth:active:not\(:disabled\),\s*button:active:not\(:disabled\) > \.button-depth,\s*\[data-action-button\]:active > \.button-depth \{\s*transform: translateY\(1px\);/,
    );
  });

  it("flashes a flat chrome plate on press, except a pill with a menu chevron", () => {
    // Icon buttons that open menus (Display) keep the flash; the space and
    // collection switchers show a press only by turning their chevron.
    const rules = css.match(/\[data-chrome-control\]:active[^{]*\{[^}]*\}/g) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatch(
      /^\[data-chrome-control\]:active:not\(:disabled\) > \[data-chrome-plate\]:not\(\.button-depth\):not\(:has\(> \[data-menu-chevron\]\)\) \{\s*background-image: linear-gradient\(var\(--press\), var\(--press\)\), linear-gradient\(var\(--active\), var\(--active\)\);/,
    );
  });

  it("gives a disabled button with depth the frame instead of its face", () => {
    expect(css).toMatch(
      /\.button-depth:disabled,\s*:disabled > \.button-depth \{\s*background-color: transparent;\s*box-shadow: none;\s*outline: 1px solid var\(--inert-frame\);/,
    );
  });
});

// A menu's width is its role's (user's decision of 11.10.2026;
// DESIGN_SYSTEM.md, «Всплывающие элементы», «Ширина»).
describe("menu width roles", () => {
  const ruleBody = (selector: string) => {
    const escaped = selector.replace(/[[\]"]/g, (char) => `\\${char}`);
    return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? null;
  };

  // The width global.css gives a menu of `role` when the window leaves
  // `available` pixels for it.
  function menuWidthPx(role: string, available: number): number {
    const base = ruleBody("[data-floating-menu]") ?? "";
    expect(base).toMatch(
      /width: min\(var\(--floating-menu-width\), var\(--floating-menu-available-width\)\);/,
    );
    const roleWidth = /--floating-menu-width: (\d+)px;/.exec(
      ruleBody(`[data-floating-menu="${role}"]`) ?? "",
    )?.[1];
    expect(roleWidth).toBeDefined();
    return Math.min(Number(roleWidth), available);
  }

  it("gives a menu of actions or a panel 240px and a list under a search field 300px", () => {
    expect(menuWidthPx("action", 10_000)).toBe(240);
    expect(menuWidthPx("search", 10_000)).toBe(300);
  });

  it("has exactly the two roles", () => {
    const roles = [...css.matchAll(/\[data-floating-menu="([^"]+)"\]/g)].map((match) => match[1]);
    expect(roles).toEqual(["action", "search"]);
  });

  it("never sizes a menu by its rows: only the window's room narrows it", () => {
    for (const selector of [
      "[data-floating-menu]",
      '[data-floating-menu="action"]',
      '[data-floating-menu="search"]',
    ]) {
      const body = ruleBody(selector);
      expect(body).not.toBeNull();
      expect(body).not.toMatch(/max-content|fit-content|min-content|min-width|max-width/);
    }
    expect(menuWidthPx("action", 200)).toBe(200);
    expect(menuWidthPx("search", 260)).toBe(260);
    expect(css).not.toMatch(/data-floating-menu-width/);
  });
});

// User's decisions of 07.10.2026 (DESIGN_SYSTEM.md, «Всплывающие элементы»,
// «Плотность»).
describe("menus and the chrome inset", () => {

  it("keeps one chrome inset, the card's 8px round its buttons", () => {
    expect(css.match(/--chrome-edge-pad:\s*[^;]+;/g)).toEqual(["--chrome-edge-pad: 8px;"]);
    expect(css).not.toMatch(/--chrome-icon-edge-pad/);
    expect(css).toMatch(/--top-collection-pad-x: var\(--chrome-edge-pad\);/);
    expect(css).toMatch(/--main-secondary-pad-x: var\(--chrome-edge-pad\);/);
  });

  it("derives the bottom bar's left inset from where the sidebar names start", () => {
    expect(css.match(/--sidebar-label-inset:\s*[^;]+;/g)).toEqual([
      "--sidebar-label-inset: calc(var(--sidebar-nav-pad-x) + var(--sidebar-row-pad-x));",
    ]);
  });
});

// The previews' right edge (SPEC_FRONTEND.md, «Thumbnail strip»; user's
// decision of 07.10.2026): in the light theme the cell's edge simply cuts
// the previews; the dark theme keeps its dissolve.
describe("the previews' right edge", () => {
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };

  it("runs the light theme's previews to the guideline with no gap and no effect", () => {
    expect(block("[data-sidebar-preview-rail]")).toMatch(/--preview-edge-gap: 0px;/);
    // The mask is applied only under the dark theme's selectors.
    expect(css).not.toMatch(/(?:^|\n)\[data-sidebar-thumbnail-strip\] \{[^}]*mask-image/);
    for (const gone of ["--preview-edge-alpha", "--preview-edge-blur", "--preview-edge-wash", "--preview-edge-width", "data-sidebar-preview-edge-"]) {
      expect(css).not.toContain(gone);
    }
  });

  it("keeps the dark theme's dissolve and its 4px of air", () => {
    for (const theme of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
      expect(block(`${theme} [data-sidebar-preview-rail]`)).toMatch(/--preview-edge-gap: 4px;/);
      expect(block(`${theme} [data-sidebar-thumbnail-strip]`)).toMatch(/mask-image: var\(--sidebar-preview-mask\);/);
    }
  });
});
