import { describe, expect, it } from "vitest";
import { topRowShowsPlace } from "./topRowPath";

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
