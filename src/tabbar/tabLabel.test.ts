import { describe, expect, it } from "vitest";
import { CHOOSE_SPACE_LABEL, tabLabel, tabTitle } from "./tabLabel";

describe("tab title (Е2.9)", () => {
  it("is the label for a tab that opened", () => {
    expect(tabTitle({ space_name: "Mine", place: null, card: null, error: null })).toBe("Mine");
  });

  it("says why a tab could not open and how to try again", () => {
    expect(
      tabTitle({
        space_name: "Mine",
        place: "Beautiful web",
        card: null,
        error: "the page of this tab could not be made: no memory",
      }),
    ).toBe("Beautiful web\nThe page of this tab could not be made: no memory. Select the tab to try again.");
  });
});

describe("tab label (В47)", () => {
  it("names the space on Everything", () => {
    expect(tabLabel({ space_name: "Mine", place: null, card: null })).toBe("Mine");
  });

  it("names the collection inside one, without its space", () => {
    expect(tabLabel({ space_name: "Mine", place: "Beautiful web", card: null })).toBe("Beautiful web");
  });

  it("names the author inside an author's feed", () => {
    expect(tabLabel({ space_name: "Mine", place: "@kotecinho", card: null })).toBe("@kotecinho");
  });

  it("names the open card, the deepest place, in a collection or on Everything", () => {
    expect(tabLabel({ space_name: "Mine", place: "Beautiful web", card: "Stripe homepage" })).toBe("Stripe homepage");
    expect(tabLabel({ space_name: "Mine", place: null, card: "Stripe homepage" })).toBe("Stripe homepage");
  });

  it("asks for a space when the tab has none", () => {
    expect(tabLabel({ space_name: null, place: null, card: null })).toBe(CHOOSE_SPACE_LABEL);
    expect(CHOOSE_SPACE_LABEL).toBe("Choose Space");
  });

  it("ignores a collection or a card without a space", () => {
    expect(tabLabel({ space_name: null, place: "Stale", card: "Stale card" })).toBe(CHOOSE_SPACE_LABEL);
  });
});
