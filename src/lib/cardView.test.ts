import { afterEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { CARD_VIEW_STORAGE_KEY, cardViewForOpening, getCardView, reloadCardView, setCardView } from "./cardView";

/// TRIAL (SPEC_CARD_PEEK.md, О1): the open card's view.
describe("cardView", () => {
  afterEach(() => {
    localStorage.removeItem(CARD_VIEW_STORAGE_KEY);
    act(() => reloadCardView());
  });

  it("is Full page until Peek is chosen, and keeps the choice", () => {
    expect(getCardView()).toBe("full");
    setCardView("peek");
    expect(localStorage.getItem(CARD_VIEW_STORAGE_KEY)).toBe("peek");
    expect(getCardView()).toBe("peek");
  });

  it("re-reads a choice another tab stored and drops an unknown one", () => {
    localStorage.setItem(CARD_VIEW_STORAGE_KEY, "peek");
    reloadCardView();
    expect(getCardView()).toBe("peek");
    localStorage.setItem(CARD_VIEW_STORAGE_KEY, "sideways");
    reloadCardView();
    expect(getCardView()).toBe("full");
  });

  it("opens every card full page in a narrow window", () => {
    expect(cardViewForOpening("peek", false)).toBe("peek");
    expect(cardViewForOpening("peek", true)).toBe("full");
    expect(cardViewForOpening("full", false)).toBe("full");
  });
});
