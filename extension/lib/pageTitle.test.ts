import { describe, expect, it } from "vitest";

import "./pageTitle.js";

const { hasNameText, withoutSiteName, choosePageTitle } = globalThis.MinePageTitle;

// The same cases as `a_title_of_separators_alone_names_nothing` in
// mine-core/src/domain/block.rs: the clipper and the save core read a name by
// one rule (SPEC_CLIPPER.md, «Название страницы»).
const PLACEHOLDERS = ["-", " - ", "|", "—", "– | –", "...", "…", "・", "－", "｜", "·", "•", "»", "* * *",
  "\u200B", "\u00A0-\u00A0", ""];
const NAMES = ["Parachute Wide Track Pants - Navy", "앵글런", "2026", "Ⅻ", "🔥", "★", "a", "-a-", "日本語"];

describe("page title", () => {
  it("reads no name in punctuation, dashes and separators alone", () => {
    for (const placeholder of PLACEHOLDERS) expect(hasNameText(placeholder), placeholder).toBe(false);
    for (const name of NAMES) expect(hasNameText(name), name).toBe(true);
    expect(hasNameText(null)).toBe(false);
  });

  it("takes the site's name off the end or the start, keeping separators inside the title", () => {
    expect(withoutSiteName("Parachute Wide Track Pants - Navy - ANGLAN", ["앵글런샵", null, "Anglan"]))
      .toBe("Parachute Wide Track Pants - Navy");
    expect(withoutSiteName("Shop | Linen Shirt", ["Shop"])).toBe("Linen Shirt");
    expect(withoutSiteName("Linen Shirt — Shop.example", ["shop.example"])).toBe("Linen Shirt");
    expect(withoutSiteName("Navy - Pants", ["Anglan"])).toBe("Navy - Pants");
    expect(withoutSiteName("Anglan", ["Anglan"])).toBe("Anglan");
    expect(withoutSiteName(" - Anglan", ["Anglan"])).toBe("- Anglan");
  });

  it("names the page by the document title when the declared title is a placeholder", () => {
    const sites = ["앵글런샵", null, "Anglan"];
    const documentTitle = "Parachute Wide Track Pants - Navy - ANGLAN";
    expect(choosePageTitle(["-", null], documentTitle, sites)).toBe("Parachute Wide Track Pants - Navy");
    expect(choosePageTitle(["-", "Parachute Pants"], documentTitle, sites)).toBe("Parachute Pants");
    expect(choosePageTitle(["Navy Pants", null], documentTitle, sites)).toBe("Navy Pants");
  });

  it("keeps the document title as it was when nothing is declared", () => {
    expect(choosePageTitle([null, null], "Linen Shirt - Anglan", ["Anglan"])).toBe("Linen Shirt - Anglan");
    expect(choosePageTitle(["", null], "Linen Shirt - Anglan", ["Anglan"])).toBe("Linen Shirt - Anglan");
  });

  it("gives no name when no candidate has one", () => {
    expect(choosePageTitle(["-", "|"], "–", ["Anglan"])).toBe("");
    expect(choosePageTitle([null, null], "-", [])).toBe("");
    expect(choosePageTitle([null, null], null, [])).toBe("");
  });
});
