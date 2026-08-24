import { describe, expect, it } from "vitest";
import { BAR_HIDE_PRIORITIES } from "./bottomBarOverflow";

/// The order is a decision about worth; the bar itself decides how much has to
/// go. These tests pin the decision, not the arithmetic.
describe("bottom-bar hide order", () => {
  const before = (a: string, b: string) => {
    const pa = BAR_HIDE_PRIORITIES[a];
    const pb = BAR_HIDE_PRIORITIES[b];
    expect(pa, `${a} has no priority`).toBeTypeOf("number");
    expect(pb, `${b} has no priority`).toBeTypeOf("number");
    expect(pa!, `${a} should leave before ${b}`).toBeLessThan(pb!);
  };

  it("drops what cannot be pressed before anything that can", () => {
    for (const pressable of [
      "close-element", "settings", "toggle-sidebar", "new-collection",
      "find-elements", "commands-overlay", "element-menu", "open-focused",
    ]) {
      before("navigate", pressable);
      before("switch-collection", pressable);
    }
  });

  it("drops Escape with the learned commands, not last", () => {
    // Escape is the most universally known key in any interface: its entry is
    // a courtesy, not a lifeline.
    before("close-element", "element-menu");
    before("clear-selection", "open-focused");
  });

  it("keeps the situational commands longest", () => {
    // The bar is the only place Focus and Command are ever shown; every
    // learned command also lives in the native menu.
    for (const learned of ["settings", "toggle-sidebar", "new-collection", "find-elements"]) {
      before(learned, "element-menu");
      before(learned, "open-focused");
    }
  });

  it("gives every hideable entry a distinct place in the order", () => {
    const values = Object.values(BAR_HIDE_PRIORITIES);
    expect(new Set(values).size).toBe(values.length);
  });
});
