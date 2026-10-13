import { describe, expect, it } from "vitest";
import { applyPendingTagOrder, reorderedPositions } from "./collectionOrder";
import type { TagCount } from "@/types";

function tags(...names: string[]): TagCount[] {
  return names.map((tag, index) => ({ tag, count: index }));
}

function names(list: readonly TagCount[]): string[] {
  return list.map((tc) => tc.tag);
}

describe("applyPendingTagOrder", () => {
  it("returns the vault order untouched when nothing is pending", () => {
    expect(names(applyPendingTagOrder(tags("a", "b", "c"), null))).toEqual(["a", "b", "c"]);
  });

  it("shows the dropped order before the vault confirms it", () => {
    // The drop moved "c" to the front; the vault still reports the old order.
    expect(names(applyPendingTagOrder(tags("a", "b", "c"), ["c", "a", "b"])))
      .toEqual(["c", "a", "b"]);
  });

  it("keeps tags the gesture never saw at the end, in their own order", () => {
    // A collection created elsewhere while the write was in flight must not be
    // dropped from the list or jump to an arbitrary slot.
    expect(names(applyPendingTagOrder(tags("a", "b", "fresh"), ["b", "a"])))
      .toEqual(["b", "a", "fresh"]);
  });

  it("does not mutate the list it was given", () => {
    const source = tags("a", "b");
    applyPendingTagOrder(source, ["b", "a"]);
    expect(names(source)).toEqual(["a", "b"]);
  });
});

/// SPEC_DEEP_AUDIT.md, Е6.2: a new collection takes the place before the first
/// (a position below the others, below zero after 0); a drag keeps the
/// smallest position as the start, so it rewrites only the pages it moved.
describe("reorderedPositions", () => {
  it("starts the order at the smallest position and moves only what moved", () => {
    const positions = new Map([["new", -2], ["newer", -3], ["a", 0], ["b", 1], ["c", 2]]);
    // `c` dragged above `a`.
    expect(reorderedPositions(["newer", "new", "c", "a", "b"], positions)).toEqual([
      { tag: "newer", position: -3 },
      { tag: "new", position: -2 },
      { tag: "c", position: -1 },
      { tag: "a", position: 0 },
      { tag: "b", position: 1 },
    ]);
  });

  it("numbers from zero a space whose positions start there", () => {
    const positions = new Map([["a", 0], ["b", 1]]);
    expect(reorderedPositions(["b", "a"], positions)).toEqual([
      { tag: "b", position: 0 },
      { tag: "a", position: 1 },
    ]);
  });
});
