import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EDGE_FADE_WIDTH, createRightFadeMaskStyle } from "./edgeFade";

/// Text that outgrows the sidebar's right edge dissolves; it is never cut.
/// The collection filter used to be the exception — a narrow panel sliced its
/// placeholder through the middle of a letter. jsdom drops `mask-image` as an
/// unknown property, so the contract is pinned on the source and the helper
/// rather than on a rendered style attribute.
describe("collection filter edge", () => {
  it("masks the filter surface with the shared right-edge fade", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const surface = app.slice(app.indexOf("data-sidebar-top-search-surface"));
    const openingTag = surface.slice(0, surface.indexOf(">"));

    expect(openingTag).toContain("style={SIDEBAR_SEARCH_MASK_STYLE}");
    expect(app).toContain(
      "const SIDEBAR_SEARCH_MASK_STYLE = createRightFadeMaskStyle(EDGE_FADE_WIDTH, 0);",
    );
  });

  it("uses the one curve every other edge uses", () => {
    const style = createRightFadeMaskStyle(EDGE_FADE_WIDTH, 0) as Record<string, string>;

    expect(style.maskImage).toContain("linear-gradient(to right");
    // Full opacity where the text starts, full transparency at the very edge.
    expect(style.maskImage).toContain("rgba(0, 0, 0, 1) 0%");
    expect(style.maskImage).toContain("rgba(0, 0, 0, 0) 100%");
    // Safari needs the prefixed longhand; WKWebView is the shipping engine.
    expect(style.WebkitMaskImage).toBe(style.maskImage);
  });
});
