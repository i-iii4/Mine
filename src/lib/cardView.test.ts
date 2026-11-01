import { afterEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { CARD_VIEW_STORAGE_KEY, getCardView, offersPeekCollapse, openCardView, reloadCardView, setCardView } from "./cardView";
import { peekAreaHoldsWindow } from "./cardPeek";

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

  // О9, О16 (user's decisions of 30.10.2026).
  describe("the open card's view", () => {
    const peek = { chosen: "peek" as const, areaHolds: true };

    it("stands a card by Peek in its window while the right part holds it, full page while it does not", () => {
      expect(openCardView(peek)).toBe("peek");
      expect(openCardView({ ...peek, areaHolds: false })).toBe("full");
    });

    it("stands a card by Full page full page at any width", () => {
      expect(openCardView({ chosen: "full", areaHolds: true })).toBe("full");
      expect(openCardView({ chosen: "full", areaHolds: false })).toBe("full");
    });

    it("decides by the right part's width the same with the sidebar beside the feed and over it", () => {
      // Beside the feed the right part is the window less the sidebar; over
      // it (a narrow window, У1) it is the whole window.
      const beside = (window: number, sidebar: number) => openCardView({ ...peek, areaHolds: peekAreaHoldsWindow(window - sidebar) });
      const over = (window: number) => openCardView({ ...peek, areaHolds: peekAreaHoldsWindow(window) });
      expect(beside(829, 360)).toBe("full");
      expect(beside(830, 360)).toBe("peek");
      expect(beside(831, 360)).toBe("peek");
      expect(over(469)).toBe("full");
      expect(over(470)).toBe("peek");
      expect(over(471)).toBe("peek");
    });

    it("offers the way to the window full page whenever the right part holds it, whatever «Card view»", () => {
      expect(offersPeekCollapse({ chosen: "full", areaHolds: true })).toBe(true);
      expect(offersPeekCollapse({ chosen: "full", areaHolds: false })).toBe(false);
      // Peek too narrow for the window: full page, and no way to a window
      // there is no room for.
      expect(offersPeekCollapse({ chosen: "peek", areaHolds: false })).toBe(false);
      // In its window there is no full page to offer it from.
      expect(offersPeekCollapse(peek)).toBe(false);
    });
  });
});
