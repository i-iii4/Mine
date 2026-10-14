import { describe, expect, it } from "vitest";
import { CHOOSE_SPACE_LABEL, tabLabel, tabTitle } from "./tabLabel";

describe("tab title (Е2.9)", () => {
  // Decision of 14.10.2026: a tab whose page could not be made says nothing
  // of it; its tooltip is its label, and selecting it tries again.
  it("is the label, whatever happened to the tab's page", () => {
    expect(tabTitle({ space_name: "Mine", place: null, card: null })).toBe("Mine");
    expect(tabTitle({ space_name: "Mine", place: "Beautiful web", card: null })).toBe("Beautiful web");
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
