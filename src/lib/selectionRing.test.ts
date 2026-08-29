import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/// The selection ring is one measurement used twice: its own thickness, and
/// how far the selected card grows outward to make room for it. Drawing it as
/// a thick square frame floating off the card's edge read as a different
/// object sitting on top of the card; the ring now sits on the edge and turns
/// the card's own corners.
describe("selection ring", () => {
  const css = readFileSync("src/styles/global.css", "utf8");
  const rule = css.slice(
    css.indexOf("[data-feed-grid-selection-frame]"),
    css.indexOf("[data-feed-grid-marquee-selection]"),
  );

  it("takes its thickness and the card's growth from one token", () => {
    expect(css).toMatch(/--feed-selection-ring:\s*1px/);
    expect(rule).toContain("inset: calc(-1 * var(--feed-selection-ring))");
    expect(rule).toContain(
      "box-shadow: inset 0 0 0 var(--feed-selection-ring) var(--feed-selection-frame)",
    );
  });

  it("rounds with the card instead of cutting a square across it", () => {
    expect(rule).toContain(
      "border-radius: calc(var(--radius-card) + var(--feed-selection-ring))",
    );
    expect(rule).not.toMatch(/border-radius:\s*0/);
  });
});
