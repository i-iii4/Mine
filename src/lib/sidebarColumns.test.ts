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

  it("floors every column at the same value", () => {
    expect(css).toContain("--sidebar-col-floor: 88px;");
    expect(css).toMatch(/--sidebar-name-col: clamp\(\s*var\(--sidebar-col-floor\)/);
    const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
    expect(sidebar).toContain("min-w-[var(--sidebar-col-floor)]");
  });

  it("keeps the frozen minimum equal to three floors plus the reserved chrome", () => {
    // 332 = reserved 156 (meta 88 + pads 64 + divider 4) + name 88 + previews 88.
    expect(css).toContain("--sidebar-min-width: 332px;");
  });
});
