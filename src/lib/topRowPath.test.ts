import { describe, expect, it } from "vitest";
import { topRowShowsPlace } from "./topRowPath";

describe("topRowShowsPlace (SPEC_NARROW_WINDOW.md, У15)", () => {
  it.each([
    // A narrow window with a card open: the card's name takes the row.
    { narrow: true, cardOpen: true, shown: false },
    // A narrow window with no card: the place stays.
    { narrow: true, cardOpen: false, shown: true },
    // A wide window: the place stays, with a card or without.
    { narrow: false, cardOpen: true, shown: true },
    { narrow: false, cardOpen: false, shown: true },
  ])("narrow $narrow, card open $cardOpen: the place shown $shown", ({ narrow, cardOpen, shown }) => {
    expect(topRowShowsPlace(narrow, cardOpen)).toBe(shown);
  });
});
