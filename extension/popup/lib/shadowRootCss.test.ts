import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteRootForShadow } from "./shadowRootCss";

const globalCss = readFileSync(join(__dirname, "..", "..", "..", "src", "styles", "global.css"), "utf8");
const buttonsCss = readFileSync(join(__dirname, "..", "..", "..", "src", "styles", "buttons.css"), "utf8");

/// The selector of the rule whose body declares `declaration`.
function selectorDeclaring(css: string, declaration: string): string {
  const at = css.indexOf(declaration);
  expect(at).toBeGreaterThan(0);
  const open = css.lastIndexOf("{", at);
  const start = Math.max(css.lastIndexOf("}", open), css.lastIndexOf("*/", open) + 1);
  return css.slice(start + 1, open).trim();
}

describe("clipper overlay custom properties inside Shadow DOM", () => {
  it.each([
    [":root { --a: 1; }", ":root,:host { --a: 1; }"],
    [":root{--a:1}", ":root,:host{--a:1}"],
    [":root, [data-theme] { --a: 1; }", ":root,:host, [data-theme] { --a: 1; }"],
    [":root,[data-theme]{--a:1}", ":root,:host,[data-theme]{--a:1}"],
    [":root,\n.bg-background,\n.bg-card {\n  --a: 1;\n}", ":root,:host,\n.bg-background,\n.bg-card {\n  --a: 1;\n}"],
    ["@media (prefers-color-scheme: dark) { :root { --a: 1; } }", "@media (prefers-color-scheme: dark) { :root,:host { --a: 1; } }"],
  ])("makes the bare :root of %j select the host", (input, output) => {
    expect(rewriteRootForShadow(input)).toBe(output);
  });

  it.each([
    ":root, :host { --a: 1; }",
    ":root,:host{--a:1}",
    ':root[data-theme="dark"] { --a: 1; }',
    ':root:not([data-theme="light"]) .feed-article-card { --a: 1; }',
    ':root[data-design="alt"],\n:root[data-design="alt2"] { --a: 1; }',
    ':root[data-font-interface="departure"] body,\n:root[data-font-interface="departure"] .font-sans { --a: 1; }',
  ])("leaves %j as it is", (css) => {
    expect(rewriteRootForShadow(css)).toBe(css);
  });

  it.each(["--active: color-mix(", "--muted-foreground: color-mix(", "--tertiary-foreground: color-mix("])(
    "gives the host the colour ladder step %s",
    (declaration) => {
      expect(selectorDeclaring(globalCss, declaration)).toMatch(/^:root,\s*\[data-theme\]$/);
      expect(selectorDeclaring(rewriteRootForShadow(globalCss), declaration)).toMatch(/^:root,:host,\s*\[data-theme\]$/);
    },
  );

  it.each([
    ["html:root {\n  --a: 1;\n}", ":host {\n  --a: 1;\n}"],
    ["html:root .bg-depth-fill { --a: 1; }", ":host .bg-depth-fill { --a: 1; }"],
    ["html:root:not([data-buttons]) :is(.button-depth) { --a: 1; }", ":host(:not([data-buttons])) :is(.button-depth) { --a: 1; }"],
    ['html:root[data-buttons="linear"] { --a: 1; }', ':host([data-buttons="linear"]) { --a: 1; }'],
    [
      'html:root[data-buttons="retro"]:not([data-theme="light"]) .x{--a:1}',
      ':host([data-buttons="retro"]:not([data-theme="light"])) .x{--a:1}',
    ],
    ["html:root[data-buttons=retro][data-theme=dark] .x{--a:1}", ":host([data-buttons=retro][data-theme=dark]) .x{--a:1}"],
  ])("anchors the button rule %j on the host", (input, output) => {
    expect(rewriteRootForShadow(input)).toBe(output);
  });

  it("anchors every button rule on the host, macOS by the host's own attribute", () => {
    const rewritten = rewriteRootForShadow(buttonsCss);
    expect(buttonsCss).toContain("html:root");
    expect(rewritten).not.toContain("html:root");
    expect(rewritten).toContain(":host(:not([data-buttons])) :is(");
    expect(rewritten).toContain(":host .bg-depth-fill,");
  });

  it("gives the host the fills derived from its surface", () => {
    expect(selectorDeclaring(rewriteRootForShadow(globalCss), "@apply surface-fills;")).toMatch(/^:root,:host,\s*\.bg-background,/);
  });
});
