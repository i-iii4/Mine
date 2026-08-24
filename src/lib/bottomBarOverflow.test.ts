import { describe, expect, it } from "vitest";
import { BAR_HIDE_PRIORITIES, computeHiddenBarEntries } from "./bottomBarOverflow";

const entry = (id: string, width: number) => ({
  id,
  priority: BAR_HIDE_PRIORITIES[id]!,
  width,
});

const ALL = [
  entry("toggle-sidebar", 150),
  entry("new-collection", 150),
  entry("switch-collection", 170),
  entry("navigate", 110),
  entry("open-focused", 70),
  entry("element-menu", 100),
];
// Sum: 750.

describe("computeHiddenBarEntries", () => {
  it("hides nothing while everything fits", () => {
    expect(computeHiddenBarEntries(750, ALL).size).toBe(0);
  });

  it("drops entries in the decided order, one at a time", () => {
    // 700 lacks 50px: Navigate (priority 1) alone covers it.
    expect([...computeHiddenBarEntries(700, ALL)]).toEqual(["navigate"]);
    // 500 after Navigate (640 left) still lacks room: Switch collection goes too.
    expect([...computeHiddenBarEntries(500, ALL)]).toEqual(["navigate", "switch-collection"]);
  });

  it("never drops more than needed", () => {
    const hidden = computeHiddenBarEntries(640, ALL);
    expect(hidden).toEqual(new Set(["navigate"]));
  });

  it("drops everything hideable when nothing fits", () => {
    expect(computeHiddenBarEntries(0, ALL).size).toBe(ALL.length);
  });

  it("hides by decided priority even when a bigger entry would fit better", () => {
    // Navigate is narrower than Switch collection, yet leaves first: the order
    // is a decision about worth, not a packing optimisation.
    const hidden = computeHiddenBarEntries(660, ALL);
    expect(hidden.has("navigate")).toBe(true);
    expect(hidden.has("switch-collection")).toBe(false);
  });
});
