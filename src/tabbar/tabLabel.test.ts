import { describe, expect, it } from "vitest";
import { CHOOSE_SPACE_LABEL, tabLabel } from "./tabLabel";

describe("tab label (В47)", () => {
  it("names the space on Everything", () => {
    expect(tabLabel({ space_name: "Mine", collection: null, card: null })).toBe("Mine");
  });

  it("names the collection inside one, without its space", () => {
    expect(tabLabel({ space_name: "Mine", collection: "Beautiful web", card: null })).toBe("Beautiful web");
  });

  it("names the open card, the deepest place, in a collection or on Everything", () => {
    expect(tabLabel({ space_name: "Mine", collection: "Beautiful web", card: "Stripe homepage" })).toBe("Stripe homepage");
    expect(tabLabel({ space_name: "Mine", collection: null, card: "Stripe homepage" })).toBe("Stripe homepage");
  });

  it("asks for a space when the tab has none", () => {
    expect(tabLabel({ space_name: null, collection: null, card: null })).toBe(CHOOSE_SPACE_LABEL);
    expect(CHOOSE_SPACE_LABEL).toBe("Choose Space");
  });

  it("ignores a collection or a card without a space", () => {
    expect(tabLabel({ space_name: null, collection: "Stale", card: "Stale card" })).toBe(CHOOSE_SPACE_LABEL);
  });
});
