import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import { lightBlock } from "@/test/blocks";
import { indexFeed, listGrowth, type FeedIndex } from "./feedIndex";

const card = (id: number, overrides: Partial<LightBlock> = {}): LightBlock =>
  lightBlock({ id, slug: `card-${id}`, ...overrides });

/** The index holds exactly the cards of the list. */
function expectIndexOf(index: FeedIndex, blocks: LightBlock[]): void {
  expect(index.blocks).toBe(blocks);
  expect([...index.ids].sort((a, b) => a - b)).toEqual(blocks.map((block) => block.id).sort((a, b) => a - b));
  expect(index.bySlug.size).toBe(blocks.length);
  for (const block of blocks) expect(index.bySlug.get(block.slug)).toBe(block);
}

// SPEC_GRID.md, «Кэш при карточке и продолжение раскладки».
describe("listGrowth", () => {
  const held = [card(1), card(2), card(3)];

  it("names the rows replaced in place and where the added rows start", () => {
    expect(listGrowth(held, [...held])).toEqual({ replaced: [], from: 3 });
    expect(listGrowth(held, [...held, card(4)])).toEqual({ replaced: [], from: 3 });
    expect(listGrowth(held, [held[0]!, card(2, { title: "Edited" }), held[2]!, card(4)])).toEqual({ replaced: [1], from: 3 });
    expect(listGrowth([], held)).toEqual({ replaced: [], from: 0 });
  });

  it("is null when a card left, changed places or gave its place to another card", () => {
    expect(listGrowth(held, held.slice(0, 2))).toBeNull();
    expect(listGrowth(held, [held[1]!, held[0]!, held[2]!])).toBeNull();
    expect(listGrowth(held, [held[0]!, card(9), held[2]!])).toBeNull();
  });
});

describe("indexFeed", () => {
  const held = [card(1), card(2), card(3)];
  const first = indexFeed(held);

  it("indexes a first list", () => {
    expectIndexOf(first, held);
    expectIndexOf(indexFeed(held, null), held);
  });

  it("keeps the set and the map for a list of the same rows", () => {
    const again = [...held];
    const index = indexFeed(again, first);
    expectIndexOf(index, again);
    expect(index.ids).toBe(first.ids);
    expect(index.bySlug).toBe(first.bySlug);
  });

  it("adds a page to copies and leaves the index before as it was", () => {
    const grown = [...held, card(4), card(5)];
    const index = indexFeed(grown, first);
    expectIndexOf(index, grown);
    expect(index.ids).not.toBe(first.ids);
    expectIndexOf(first, held);
  });

  it("keeps the ids and maps the new row when a row is replaced in place", () => {
    const edited = card(2, { title: "Edited" });
    const next = [held[0]!, edited, held[2]!];
    const index = indexFeed(next, first);
    expectIndexOf(index, next);
    expect(index.ids).toBe(first.ids);
    expect(first.bySlug.get("card-2")).toBe(held[1]);
  });

  it("forgets the slug a renamed card had", () => {
    const renamed = card(2, { slug: "card-2-renamed" });
    const next = [held[0]!, renamed, held[2]!];
    const index = indexFeed(next, first);
    expectIndexOf(index, next);
    expect(index.bySlug.has("card-2")).toBe(false);
  });

  it("gives two cards that exchange their slugs each its own", () => {
    const next = [card(1, { slug: "card-2" }), card(2, { slug: "card-1" }), held[2]!];
    expectIndexOf(indexFeed(next, first), next);
  });

  it("indexes anew when cards left or changed places", () => {
    for (const next of [held.slice(1), [held[2]!, held[0]!, held[1]!], [card(7), card(8)]]) {
      expectIndexOf(indexFeed(next, first), next);
    }
  });
});
