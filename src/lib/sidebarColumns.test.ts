import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/// The sidebar row is three columns: name, previews, meta. The contract under
/// narrowing: name and previews split the free width equally until the name's
/// cap, every column bottoms out at the same floor, and the previews are never
/// the narrowest third. jsdom does not lay out CSS, so the contract is pinned
/// on the stylesheet's own formula.
describe("sidebar column contract", () => {
  const css = readFileSync("src/styles/global.css", "utf8");

  it("shares the free width between name and previews equally", () => {
    expect(css).toContain("calc((var(--sidebar-width) - var(--sidebar-reserved)) / 2)");
  });

  it("floors the previews at a column box plus the row's edge padding", () => {
    // The side zones are read WITH their padding, so the middle floor carries
    // the same padding — otherwise it reads as the narrowest third even when
    // the boxes are equal.
    expect(css).toContain("--sidebar-col-floor: 88px;");
    expect(css).toContain(
      "--sidebar-rail-floor: calc(var(--sidebar-col-floor) + var(--sidebar-row-pad-x));",
    );
    expect(css).toMatch(/--sidebar-name-col: clamp\(\s*var\(--sidebar-col-floor\)/);
    const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
    expect(sidebar).toContain("min-w-[var(--sidebar-rail-floor)]");
  });

  it("keeps each frozen minimum equal to its floors plus the reserved chrome", () => {
    // Primary: 332 = reserved 156 + name 88 + rail 88 (row padding is 0).
    expect(css).toContain("--sidebar-min-width: 332px;");
    // Alt: 300 = reserved 108 + name 88 + rail (88 + 16) — three equal zones
    // of 104 at the minimum.
    expect(css).toContain("--sidebar-min-width: 300px;");
  });
});
