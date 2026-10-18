import { readFileSync } from "node:fs";

// The editor's own styles (SPEC_EDITING.md, Л15): every colour is a token,
// every rule is scoped to the editor's root, and no line gets a vertical
// margin, which CodeMirror cannot measure.

const CSS = readFileSync("src/styles/editor.css", "utf8");
/** The rules of the file, comments out. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((rule) => rule.trim()).filter(Boolean);

/** The selectors of a list, split at the commas outside `:is(…)`. */
function selectorList(text: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      selectors.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) selectors.push(current.trim());
  return selectors;
}

describe("editor.css (SPEC_EDITING.md, Л15)", () => {
  it("names no colour by number, only by token", () => {
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|oklab\(/i);
    for (const rule of RULES) {
      for (const declaration of rule.split("{")[1]?.split(";") ?? []) {
        if (/^\s*(color|background-color|border-color)\s*:/.test(declaration)) {
          expect(declaration).toMatch(/var\(--[a-z-]+\)/);
        }
      }
    }
  });

  it("styles only inside the editor's root", () => {
    for (const rule of RULES) {
      const selectors = selectorList(rule.split("{")[0] ?? "");
      expect(selectors.filter((selector) => !selector.startsWith(".mine-note-editor"))).toEqual([]);
    }
  });

  it("gives lines no vertical margin", () => {
    for (const rule of RULES) {
      const [selectors = "", body = ""] = rule.split("{");
      if (!selectors.includes(".cm-line")) continue;
      expect(body).not.toMatch(/margin(-top|-bottom|-block)?\s*:/);
    }
  });
});
