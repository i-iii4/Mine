import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/// The page surface must have exactly one definition: the theme token. A
/// literal colour anywhere in the shell drifts from `--background` and shows up
/// as a page that is a shade lighter or darker than the app painted on it —
/// which is exactly what `#0C0C0C` on <body> used to do against
/// `oklch(0.14)`.
describe("page surface", () => {
  const shells = ["index.html", "settings.html"];

  it("never hard-codes a background colour in the shell HTML", () => {
    for (const shell of shells) {
      const html = readFileSync(shell, "utf8");
      expect(html, `${shell} paints <body> with a literal`).not.toMatch(
        /<body[^>]*style=[^>]*background/i,
      );
      expect(html, `${shell} carries a hex background`).not.toMatch(
        /background:\s*#[0-9a-f]{3,8}/i,
      );
    }
  });

  it("states the anti-flash background with the theme's own values", () => {
    for (const shell of shells) {
      const html = readFileSync(shell, "utf8");
      expect(html).toContain("oklch(0.14 0 0)");
      expect(html).toContain("oklch(1 0 0)");
    }
  });

  it("hands the page surface to the token once the stylesheet loads", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    const pageRule = css.slice(css.indexOf("html,\nbody,\n#root {"));
    expect(pageRule.slice(0, 400)).toContain("background: var(--background)");
  });
});
