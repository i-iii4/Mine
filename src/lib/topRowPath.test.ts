import { describe, expect, it } from "vitest";
import { topRowCard, topRowShowsPlace } from "./topRowPath";

describe("topRowShowsPlace (SPEC_NARROW_WINDOW.md, У15; 23.10.2026)", () => {
  it.each([
    // A narrow window with a card open: the card's name takes the row.
    { narrow: true, sidebarBeside: false, cardOpen: true, shown: false },
    // A narrow window with no card: the place stays.
    { narrow: true, sidebarBeside: false, cardOpen: false, shown: true },
    // The sidebar open beside the feed shows the place: a card's name
    // stands alone; with no card the place stays.
    { narrow: false, sidebarBeside: true, cardOpen: true, shown: false },
    { narrow: false, sidebarBeside: true, cardOpen: false, shown: true },
    // The sidebar collapsed: the place stays, with a card or without.
    { narrow: false, sidebarBeside: false, cardOpen: true, shown: true },
    { narrow: false, sidebarBeside: false, cardOpen: false, shown: true },
  ])("narrow $narrow, sidebar beside $sidebarBeside, card open $cardOpen: the place shown $shown", ({ shown, ...state }) => {
    expect(topRowShowsPlace(state)).toBe(shown);
  });
});

describe("topRowCard (SPEC_CARD_PEEK.md, О5)", () => {
  it("leaves the row as with no card while the card stands in its window", () => {
    expect(topRowCard("card", "peek")).toBeNull();
    // With the row's card gone, the place stays in every window.
    expect(topRowShowsPlace({ narrow: false, sidebarBeside: true, cardOpen: topRowCard("card", "peek") !== null })).toBe(true);
  });

  it("shows the card full page, and nothing with no card", () => {
    expect(topRowCard("card", "full")).toBe("card");
    expect(topRowCard(null, "full")).toBeNull();
  });
});
