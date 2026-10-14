// The Save journal confirms a record by what it holds, not by the order of an
// object's fields; the order of an array's items still counts (SPEC_CLIPPER.md,
// «Журнал операции Save и базовый протокол»).
import { describe, expect, it } from "vitest";
import "./storedValue.js";

const { same } = globalThis.MineStoredValue;

describe("MineStoredValue.same", () => {
  it("takes objects with the same fields in another order, at any depth, as the same", () => {
    expect(same({ b: 1, a: { d: [1, 2], c: "x" } }, { a: { c: "x", d: [1, 2] }, b: 1 })).toBe(true);
    // Code unit order: an upper-case and a lower-case name sort apart.
    expect(same({ a: 1, B: 2, é: 3 }, { é: 3, B: 2, a: 1 })).toBe(true);
  });

  it("tells apart arrays in another order, other values and missing fields", () => {
    expect(same([1, 2], [2, 1])).toBe(false);
    expect(same({ items: [{ a: 1 }, { b: 2 }] }, { items: [{ b: 2 }, { a: 1 }] })).toBe(false);
    expect(same({ a: 1 }, { a: "1" })).toBe(false);
    expect(same({ a: 1, b: undefined }, { a: 1, b: null })).toBe(false);
    expect(same({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("is frozen, so a page cannot replace the comparison", () => {
    expect(Object.isFrozen(globalThis.MineStoredValue)).toBe(true);
  });
});
