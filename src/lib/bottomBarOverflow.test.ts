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
  entry("find-elements", 150),
  entry("settings", 100),
];
// Sum: 1000.

describe("computeHiddenBarEntries", () => {
  it("hides nothing while everything fits", () => {
    expect(computeHiddenBarEntries(1000, ALL).size).toBe(0);
  });

  it("drops the reference entries first: nothing can be pressed there", () => {
    expect([...computeHiddenBarEntries(900, ALL)]).toEqual(["navigate"]);
    expect([...computeHiddenBarEntries(750, ALL)]).toEqual(["navigate", "switch-collection"]);
  });

  it("then drops the commands the user has already learned", () => {
    const hidden = computeHiddenBarEntries(400, ALL);
    expect(hidden.has("settings")).toBe(true);
    expect(hidden.has("toggle-sidebar")).toBe(true);
    // Situational commands are still standing at this width.
    expect(hidden.has("open-focused")).toBe(false);
    expect(hidden.has("element-menu")).toBe(false);
  });

  it("keeps the situational commands longest", () => {
    // The bar is the only place Focus and Command are ever shown; the learned
    // ones also live in the native menu.
    const order: string[] = [];
    for (let width = 1000; width >= 0; width -= 10) {
      for (const id of computeHiddenBarEntries(width, ALL)) {
        if (!order.includes(id)) order.push(id);
      }
    }
    expect(order.indexOf("open-focused")).toBeGreaterThan(order.indexOf("settings"));
    expect(order.indexOf("element-menu")).toBeGreaterThan(order.indexOf("find-elements"));
    expect(order.at(-1)).toBe("open-focused");
  });

  it("never drops more than needed", () => {
    expect(computeHiddenBarEntries(890, ALL)).toEqual(new Set(["navigate"]));
  });

  it("drops everything hideable when nothing fits", () => {
    expect(computeHiddenBarEntries(0, ALL).size).toBe(ALL.length);
  });

  it("hides by decided worth even when a bigger entry would fit better", () => {
    // Navigate is narrower than Switch collection, yet leaves first: the order
    // is a decision about worth, not a packing optimisation.
    const hidden = computeHiddenBarEntries(910, ALL);
    expect(hidden.has("navigate")).toBe(true);
    expect(hidden.has("switch-collection")).toBe(false);
  });
});
