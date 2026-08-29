import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/// The sidebar fill sits a third of the way from the page background toward
/// the top chrome: light 1.0 → 0.997 → 0.99, dark 0.14 → 0.15 → 0.17. The
/// half-step midpoint read as chrome (0.155 vs 0.17 was indistinguishable), so
/// the token keeps two thirds of the gap to the chrome. The contract below
/// keeps all four theme definitions on that value and the panel painted with it —
/// `bg-sidebar` also re-bases `--surface`, so relative elevation inside the
/// panel lifts from the sidebar surface rather than the page.
describe("sidebar surface", () => {
  const css = readFileSync("src/styles/global.css", "utf8");

  it("defines the sidebar token as the midpoint in every theme block", () => {
    const values = [...css.matchAll(/--sidebar:\s*oklch\(([^)]*)\)/g)].map(
      (match) => match[1],
    );
    expect(values).toHaveLength(4);
    const light = values.filter((value) => value === "0.997 0 0");
    const dark = values.filter((value) => value === "0.15 0 0");
    expect(light, "light themes sit a third step below background 1.0").toHaveLength(2);
    expect(dark, "dark themes sit a third step above background 0.14").toHaveLength(2);
  });

  it("keeps the sidebar zone registered in the elevation map", () => {
    expect(css).toContain(".bg-sidebar { --surface: var(--sidebar); }");
  });

  it("paints the sidebar panel with the token", () => {
    const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
    expect(sidebar).toMatch(/<aside[\s\S]{0,600}bg-sidebar/);
  });
});
