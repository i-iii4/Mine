import { describe, expect, it } from "vitest";
import { applyPendingTagOrder } from "./collectionOrder";
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
