import { describe, expect, it } from "vitest";
import { applyFeedPatch, feedPatchEnd } from "./feedPatch";
import { lightBlock } from "@/test/blocks";
import type { FeedPatchRow, LightBlock } from "@/types";

function card(id: number): LightBlock {
  return lightBlock({ id, slug: `card-${id}` });
}

function row(id: number, after: number | null, title = "new"): FeedPatchRow {
  return { block: lightBlock({ id, slug: `card-${id}`, title }), after };
}

const ids = (list: LightBlock[] | null) => list?.map((block) => block.id) ?? null;

describe("feedPatchEnd", () => {
  it("is no card when the list holds the whole feed", () => {
    expect(feedPatchEnd([card(1), card(2)], new Set([2]), false)).toBeNull();
    expect(feedPatchEnd([], new Set(), false)).toBeNull();
  });

  it("is the last card of the list that is not named", () => {
    expect(feedPatchEnd([card(1), card(2), card(3)], new Set([3]), true)).toBe(2);
    expect(feedPatchEnd([card(1), card(2), card(3)], new Set([9]), true)).toBe(3);
  });

  it("cannot be told when the feed has more and every card is named", () => {
    expect(feedPatchEnd([card(1), card(2)], new Set([1, 2]), true)).toBeUndefined();
    expect(feedPatchEnd([], new Set(), true)).toBeUndefined();
  });
});

describe("applyFeedPatch", () => {
  const list = [card(1), card(2), card(3), card(4)];

  it("replaces a named card where it stands", () => {
    const next = applyFeedPatch(list, new Set([2]), [row(2, 1)]);
    expect(ids(next)).toEqual([1, 2, 3, 4]);
    expect(next?.[1]?.title).toBe("new");
    // The cards that were not named are the same objects.
    expect(next?.[0]).toBe(list[0]);
    expect(next?.[2]).toBe(list[2]);
  });

  it("removes a named card the answer does not hold", () => {
    expect(ids(applyFeedPatch(list, new Set([2, 4]), []))).toEqual([1, 3]);
  });

  it("puts a new card before every kept card", () => {
    expect(ids(applyFeedPatch(list, new Set([9]), [row(9, null)]))).toEqual([9, 1, 2, 3, 4]);
  });

  it("moves a named card to the place the answer names", () => {
    expect(ids(applyFeedPatch(list, new Set([1]), [row(1, 3)]))).toEqual([2, 3, 1, 4]);
  });

  it("keeps the order of rows that stand after one card", () => {
    const next = applyFeedPatch(list, new Set([2, 3, 8]), [row(8, null), row(3, 1), row(2, 1), row(7, 4)]);
    expect(ids(next)).toEqual([8, 1, 3, 2, 4, 7]);
  });

  it("fills an empty list", () => {
    expect(ids(applyFeedPatch([], new Set([5, 6]), [row(5, null), row(6, null)]))).toEqual([5, 6]);
  });

  it("refuses a row that names a card the list does not hold", () => {
    expect(applyFeedPatch(list, new Set([9]), [row(9, 77)])).toBeNull();
    // The card it names is itself named, so it is not a kept card.
    expect(applyFeedPatch(list, new Set([2, 9]), [row(9, 2)])).toBeNull();
  });
});
