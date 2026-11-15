import { describe, expect, it } from "vitest";
import { CONFIRM_CARD_TABS_FROM, TAB_BAR_HEIGHT_PX } from "@/tabbar/constants";
import { asksBeforeOpening, cardTabsOrder, tabBarPointX } from "./cardTabDrop";

/// SPEC_TABS.md, В86: cards dragged from a tab's page onto its window's bar.
describe("the pointer over the tab bar", () => {
  it("is over the bar in the row above the page, across the window's width", () => {
    expect(tabBarPointX(120, -1, 1200)).toBe(120);
    expect(tabBarPointX(0, -TAB_BAR_HEIGHT_PX, 1200)).toBe(0);
    expect(tabBarPointX(1200, -20, 1200)).toBe(1200);
  });

  it("is off the bar in the page, above the window and beside it", () => {
    expect(tabBarPointX(120, 0, 1200)).toBeNull();
    expect(tabBarPointX(120, 300, 1200)).toBeNull();
    expect(tabBarPointX(120, -TAB_BAR_HEIGHT_PX - 1, 1200)).toBeNull();
    expect(tabBarPointX(-1, -20, 1200)).toBeNull();
    expect(tabBarPointX(1201, -20, 1200)).toBeNull();
  });
});

describe("the tabs of dropped cards", () => {
  it("start with the grabbed card, shown, and follow with the rest in the feed's order", () => {
    const feed = ["a", "b", "c", "d", "e"];
    // А, Б, В selected in the feed's order, В grabbed: В, А, Б.
    expect(cardTabsOrder(["c", "a", "b"], feed, "c")).toEqual(["c", "a", "b"]);
    // The feed puts the grabbed card first in the drag, then the selection.
    expect(cardTabsOrder(["d", "e", "b"], feed, "d")).toEqual(["d", "b", "e"]);
    expect(cardTabsOrder(["c"], feed, "c")).toEqual(["c"]);
  });

  it("keep cards the feed does not hold after the ones it does, in their order", () => {
    expect(cardTabsOrder(["x", "b", "y"], ["a", "b"], "y")).toEqual(["y", "b", "x"]);
  });

  it("open one tab for the grabbed card when the drag names no cards, and one per card", () => {
    expect(cardTabsOrder([], ["a"], "z")).toEqual(["z"]);
    expect(cardTabsOrder(["a", "a", "b"], ["a", "b"], "b")).toEqual(["b", "a"]);
  });

  it("ask first from 15 tabs on, the count Firefox asks at", () => {
    expect(CONFIRM_CARD_TABS_FROM).toBe(15);
    expect(asksBeforeOpening(1)).toBe(false);
    expect(asksBeforeOpening(14)).toBe(false);
    expect(asksBeforeOpening(15)).toBe(true);
    expect(asksBeforeOpening(40)).toBe(true);
  });
});
