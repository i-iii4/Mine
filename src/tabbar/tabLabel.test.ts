import { describe, expect, it } from "vitest";
import { CHOOSE_SPACE_LABEL, tabLabel } from "./tabLabel";

describe("tab label (В47)", () => {
  it("names the space on Everything", () => {
    expect(tabLabel({ space_name: "Mine", collection: null })).toEqual({
      primary: "Mine",
      secondary: null,
      title: "Mine",
    });
  });

  it("names the collection, then its space, inside a collection", () => {
    expect(tabLabel({ space_name: "Mine", collection: "Beautiful web" })).toEqual({
      primary: "Beautiful web",
      secondary: "Mine",
      title: "Beautiful web · Mine",
    });
  });

  it("asks for a space when the tab has none", () => {
    expect(tabLabel({ space_name: null, collection: null })).toEqual({
      primary: CHOOSE_SPACE_LABEL,
      secondary: null,
      title: CHOOSE_SPACE_LABEL,
    });
    expect(CHOOSE_SPACE_LABEL).toBe("Choose Space");
  });

  it("ignores a collection without a space", () => {
    expect(tabLabel({ space_name: null, collection: "Stale" }).primary).toBe(CHOOSE_SPACE_LABEL);
  });
});
