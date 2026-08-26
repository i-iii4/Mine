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

  it("floors every column at the shared keystone", () => {
    expect(css).toContain("--sidebar-col-floor: 88px;");
    expect(css).toMatch(/--sidebar-name-col: clamp\(\s*var\(--sidebar-col-floor\)/);
    const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
    expect(sidebar).toContain("min-w-[var(--sidebar-col-floor)]");
  });

  it("keeps the CSS frozen minimum equal to the JS one, per design", async () => {
    // Two sides of one contract: JS clamps the drag and lifts stored widths
    // to sidebarMinWidth(), CSS freezes the nav at --sidebar-min-width. One
    // side moving alone leaves the nav wider than the panel, and the curtain
    // permanently clips the meta column — which is exactly how the count
    // digits got cut off once.
    const { sidebarMinWidth } = await import("./appLayout");
    expect(css).toContain(`--sidebar-min-width: ${sidebarMinWidth("default")}px;`);
    expect(css).toContain(`--sidebar-min-width: ${sidebarMinWidth("alt")}px;`);
  });
});
