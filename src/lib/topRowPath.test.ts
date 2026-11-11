import { describe, expect, it } from "vitest";
import { topRowCard, topRowShowsPlace, type TopRowCardView, type TopRowSidebar } from "./topRowPath";

describe("topRowShowsPlace (DESIGN_SYSTEM.md, «Одно название в ряду»; 11.11.2026)", () => {
  it.each<{ sidebar: TopRowSidebar; card: TopRowCardView; shown: boolean }>([
    // No card: the place's name, the sidebar beside the feed or hidden.
    { sidebar: "beside", card: "none", shown: true },
    { sidebar: "hidden", card: "none", shown: true },
    // Full page: the card's name takes the place's room wherever the sidebar
    // stands (SPEC_NARROW_WINDOW.md, У15).
    { sidebar: "beside", card: "full", shown: false },
    { sidebar: "hidden", card: "full", shown: false },
    // The card's window: the row under its scrim is as with no card beside
    // the open sidebar, and names nothing with the sidebar hidden
    // (SPEC_CARD_PEEK.md, О5).
    { sidebar: "beside", card: "window", shown: true },
    { sidebar: "hidden", card: "window", shown: false },
  ])("sidebar $sidebar, card $card: the place shown $shown", ({ shown, ...state }) => {
    expect(topRowShowsPlace(state)).toBe(shown);
  });
});

describe("topRowCard (SPEC_CARD_PEEK.md, О5)", () => {
  it("leaves the card's name out of the row while the card stands in its window", () => {
    expect(topRowCard("card", "peek")).toBeNull();
  });

  it("shows the card full page, and nothing with no card", () => {
    expect(topRowCard("card", "full")).toBe("card");
    expect(topRowCard(null, "full")).toBeNull();
  });
});
