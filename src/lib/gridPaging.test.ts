import { describe, expect, it } from "vitest";

import { refreshPageLimit } from "./gridPaging";

describe("refreshPageLimit", () => {
  it("never asks for less than one page", () => {
    expect(refreshPageLimit(0, 200)).toBe(200);
    expect(refreshPageLimit(1, 200)).toBe(200);
    expect(refreshPageLimit(200, 200)).toBe(200);
  });

  it("covers everything the user scrolled through", () => {
    // The case that matters: 3 pages are on screen and an edit refreshes the
    // route. Asking for 200 would drop 400 cards and rebuild the feed.
    expect(refreshPageLimit(201, 200)).toBe(400);
    expect(refreshPageLimit(600, 200)).toBe(600);
    expect(refreshPageLimit(601, 200)).toBe(800);
  });

  it("treats a nonsensical count as an empty feed rather than throwing", () => {
    expect(refreshPageLimit(-5, 200)).toBe(200);
  });

  it("rejects a page size that cannot page anything", () => {
    expect(() => refreshPageLimit(10, 0)).toThrow();
  });
});
