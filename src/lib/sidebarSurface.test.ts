import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/// The sidebar fill is a half-quantum surface between the page background and
/// the top chrome: light 1.0 → 0.995 → 0.99, dark 0.14 → 0.155 → 0.17. The
/// token gathers the panel visually; the contract below keeps all four theme
/// definitions on that midpoint and the panel actually painted with it —
/// `bg-sidebar` also re-bases `--surface`, so relative elevation inside the
/// panel lifts from the sidebar surface rather than the page.
describe("sidebar surface", () => {
  const css = readFileSync("src/styles/global.css", "utf8");

  it("defines the sidebar token as the midpoint in every theme block", () => {
    const values = [...css.matchAll(/--sidebar:\s*oklch\(([^)]*)\)/g)].map(
      (match) => match[1],
    );
    expect(values).toHaveLength(4);
    const light = values.filter((value) => value === "0.995 0 0");
    const dark = values.filter((value) => value === "0.155 0 0");
    expect(light, "light themes sit between background 1.0 and chrome 0.99").toHaveLength(2);
    expect(dark, "dark themes sit between background 0.14 and chrome 0.17").toHaveLength(2);
  });

  it("keeps the sidebar zone registered in the elevation map", () => {
    expect(css).toContain(".bg-sidebar { --surface: var(--sidebar); }");
  });

  it("paints the sidebar panel with the token", () => {
    const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
    expect(sidebar).toMatch(/<aside[\s\S]{0,600}bg-sidebar/);
  });
});
