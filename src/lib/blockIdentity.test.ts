import { describe, it, expect } from "vitest";
import type { LightBlock } from "@/types";
import { lightBlockContentEqual, reconcileBlocks } from "./blockIdentity";
import { lightBlock } from "@/test/blocks";

function makeBlock(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return lightBlock({
    id,
    slug: `block-${id}`,
    card_kind: "article",
    block_type: "article",
    title: `Block ${id}`,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: `Body ${id}`,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    collections: [],
    feed_playback: null,
    ...overrides,
  });
}

describe("reconcileBlocks", () => {
  it("returns the previous array unchanged when content is identical", () => {
    const prev = [makeBlock(1), makeBlock(2), makeBlock(3)];
    // Fresh objects with identical content — what a no-op refresh produces.
    const next = [makeBlock(1), makeBlock(2), makeBlock(3)];

    const result = reconcileBlocks(prev, next);

    expect(result).toBe(prev);
    result.forEach((block, index) => {
      expect(block).toBe(prev[index]);
    });
  });

  it("preserves identity of unchanged blocks and replaces only the changed one", () => {
    const prev = [makeBlock(1), makeBlock(2), makeBlock(3)];
    const next = [
      makeBlock(1),
      makeBlock(2, { thumbnail: "block-2.jpg" }),
      makeBlock(3),
    ];

    const result = reconcileBlocks(prev, next);

    expect(result).not.toBe(prev);
    expect(result[0]).toBe(prev[0]);
    expect(result[1]).toBe(next[1]);
    expect(result[1]).not.toBe(prev[1]);
    expect(result[2]).toBe(prev[2]);
  });

  it("keeps the loaded prefix identity when a page is appended", () => {
    const prev = [makeBlock(1), makeBlock(2)];
    const next = [makeBlock(1), makeBlock(2), makeBlock(3), makeBlock(4)];

    const result = reconcileBlocks(prev, next);

    expect(result).toHaveLength(4);
    expect(result[0]).toBe(prev[0]);
    expect(result[1]).toBe(prev[1]);
    expect(result[2]).toBe(next[2]);
    expect(result[3]).toBe(next[3]);
  });

  it("produces a new array when blocks are removed", () => {
    const prev = [makeBlock(1), makeBlock(2), makeBlock(3)];
    const next = [makeBlock(1), makeBlock(3)];

    const result = reconcileBlocks(prev, next);

    expect(result).not.toBe(prev);
    expect(result.map((block) => block.id)).toEqual([1, 3]);
    expect(result[0]).toBe(prev[0]);
    expect(result[1]).toBe(prev[2]);
  });

  it("produces a new array when order changes even if content is unchanged", () => {
    const prev = [makeBlock(1), makeBlock(2), makeBlock(3)];
    const next = [makeBlock(2), makeBlock(1), makeBlock(3)];

    const result = reconcileBlocks(prev, next);

    expect(result).not.toBe(prev);
    expect(result[0]).toBe(prev[1]);
    expect(result[1]).toBe(prev[0]);
    expect(result[2]).toBe(prev[2]);
  });

  it("returns next when there is no previous state", () => {
    const next = [makeBlock(1)];
    expect(reconcileBlocks([], next)).toBe(next);
  });

  it("treats a body edit at the same id as a content change", () => {
    const prev = [makeBlock(7, { body: "before" })];
    const next = [makeBlock(7, { body: "after" })];

    const result = reconcileBlocks(prev, next);

    expect(result[0]).toBe(next[0]);
    expect(result[0]).not.toBe(prev[0]);
  });

  it("keeps a block whose menu is open after it leaves the snapshot", () => {
    // Unchecking the collection you are browsing drops the card from the query
    // at once. Without the hold, the list would close over the card the menu is
    // attached to, and the menu would leave with it mid-gesture.
    const prev = [makeBlock(1), makeBlock(2), makeBlock(3)];
    const next = [makeBlock(1), makeBlock(3)];

    const result = reconcileBlocks(prev, next, new Set(["block-2"]));

    expect(result.map((block) => block.slug)).toEqual(["block-1", "block-2", "block-3"]);
  });

  it("lets the block go once nothing holds it", () => {
    const prev = [makeBlock(1), makeBlock(2)];
    const next = [makeBlock(1)];

    expect(reconcileBlocks(prev, next, new Set()).map((b) => b.slug)).toEqual(["block-1"]);
    expect(reconcileBlocks(prev, next).map((b) => b.slug)).toEqual(["block-1"]);
  });

  it("holds nothing for a block that is still in the snapshot", () => {
    const prev = [makeBlock(1), makeBlock(2)];
    const next = [makeBlock(1), makeBlock(2)];

    const result = reconcileBlocks(prev, next, new Set(["block-2"]));

    expect(result).toBe(prev);
  });

  it("restores several held blocks at their own positions", () => {
    const prev = [makeBlock(1), makeBlock(2), makeBlock(3), makeBlock(4)];
    const next = [makeBlock(3)];

    const result = reconcileBlocks(prev, next, new Set(["block-1", "block-4"]));

    expect(result.map((block) => block.slug)).toEqual(["block-1", "block-3", "block-4"]);
  });
});

describe("lightBlockContentEqual", () => {
  it("is true for structurally identical blocks", () => {
    expect(lightBlockContentEqual(makeBlock(1), makeBlock(1))).toBe(true);
  });

  it("detects a preview_manifest change", () => {
    expect(
      lightBlockContentEqual(
        makeBlock(1),
        makeBlock(1, { preview_manifest: "{\"kind\":\"image\"}" }),
      ),
    ).toBe(false);
  });

  it("detects a feed_playback change", () => {
    expect(
      lightBlockContentEqual(
        makeBlock(1),
        makeBlock(1, { feed_playback: "{\"kind\":\"single_video\"}" }),
      ),
    ).toBe(false);
  });
});

describe("lightBlockContentEqual and a card's collections (02.10.2026)", () => {
  it("sees a card connected to one more collection as changed", () => {
    const before = makeBlock(1);
    const after = { ...before, collections: [...before.collections, "Органика"] };
    expect(lightBlockContentEqual(before, after)).toBe(false);
    expect(reconcileBlocks([before], [after])[0]).toBe(after);
  });

  it("sees the cloud and unreadable flags as content", () => {
    const before = makeBlock(1);
    expect(lightBlockContentEqual(before, { ...before, content_in_cloud: true })).toBe(false);
    expect(lightBlockContentEqual(before, { ...before, preview_unreadable: true })).toBe(false);
  });
});


// The feed keeps a card's signature, content and height by the card's row
// object (SPEC_GRID.md, «Кэш при карточке и продолжение раскладки»). That is
// right only while a card that did not change stays the same object and a
// card that changed is a new one, whatever of the row changed.
describe("the condition of the cache kept by the card's row (15.11.2026)", () => {
  // Every field of a row, each with a value: a field added to `LightBlock`
  // has to be named here, or this file does not type-check.
  const ROW: Required<LightBlock> = {
    id: 7,
    slug: "row",
    block_type: "article",
    card_kind: "article",
    title: "Title",
    content_heading: "Heading",
    display_title: "Display",
    fallback_label: "Row",
    url: "https://example.test/row",
    media_file: "row.jpg",
    thumbnail: "row.thumb.jpg",
    saved_at: "2026-01-01T00:00:00Z",
    width: 800,
    height: 600,
    author: "Author",
    body: "Body",
    preview_text: "Preview",
    first_image: "first.jpg",
    media_urls: '["row.jpg"]',
    media_dimensions: '{"row.jpg":[800,600]}',
    preview_manifest: '{"kind":"image","preview_width":640,"preview_height":480}',
    feed_playback: '{"profile":"standard"}',
    content_in_cloud: false,
    preview_unreadable: false,
    collections: ["one", "two"],
    search_match: {
      field: "title",
      kind: "exact",
      excerpt: "Title",
      ranges: [{ start: 0, end: 5 }],
      score: 1,
      explanation: "why",
    },
  };
  // The same fields, each with another value.
  const CHANGED: Required<LightBlock> = {
    id: 8,
    slug: "row-renamed",
    block_type: "link",
    card_kind: "link",
    title: "Another title",
    content_heading: "Another heading",
    display_title: "Another display",
    fallback_label: "Another row",
    url: "https://example.test/another",
    media_file: "another.jpg",
    thumbnail: "another.thumb.jpg",
    saved_at: "2026-02-02T00:00:00Z",
    width: 801,
    height: 601,
    author: "Another author",
    body: "Another body",
    preview_text: "Another preview",
    first_image: "another-first.jpg",
    media_urls: '["another.jpg"]',
    media_dimensions: '{"another.jpg":[801,601]}',
    preview_manifest: '{"kind":"image","preview_width":640,"preview_height":360}',
    feed_playback: '{"profile":"heavy"}',
    content_in_cloud: true,
    preview_unreadable: true,
    collections: ["two", "one"],
    search_match: null,
  };
  const row = (): Required<LightBlock> => structuredClone(ROW);
  const fields = Object.keys(ROW) as (keyof LightBlock)[];

  it("names every field of a row", () => {
    expect(fields.sort()).toEqual((Object.keys(CHANGED) as (keyof LightBlock)[]).sort());
    for (const field of fields) expect(CHANGED[field]).not.toEqual(ROW[field]);
  });

  it("keeps the object of a row read again without a change", () => {
    const held = [row(), { ...row(), id: 9, slug: "other" }];
    const again = structuredClone(held);
    const result = reconcileBlocks(held, again);
    expect(result).toBe(held);
    expect(result[0]).toBe(held[0]);
    expect(result[1]).toBe(held[1]);
  });

  it.each(fields)("gives a row whose %s changed a new object", (field) => {
    const held = row();
    const arrived = { ...row(), [field]: CHANGED[field] };
    const result = reconcileBlocks([held], [arrived]);
    expect(lightBlockContentEqual(held, arrived)).toBe(false);
    expect(result[0]).toBe(arrived);
    expect(result[0]).not.toBe(held);
  });

  it.each([
    ["field", "body"],
    ["kind", "prefix"],
    ["excerpt", "Titles"],
    ["ranges", [{ start: 0, end: 4 }]],
    ["ranges", [{ start: 0, end: 5 }, { start: 6, end: 7 }]],
    ["score", 2],
    ["explanation", null],
  ] as const)("gives a row whose search match changed its %s a new object", (part, value) => {
    const held = row();
    const arrived = { ...row(), search_match: { ...row().search_match!, [part]: value } };
    expect(reconcileBlocks([held], [arrived])[0]).toBe(arrived);
  });

  it("gives a row one more collection, one fewer, or another one a new object", () => {
    for (const collections of [["one", "two", "three"], ["one"], ["one", "other"]]) {
      const held = row();
      const arrived = { ...row(), collections };
      expect(reconcileBlocks([held], [arrived])[0]).toBe(arrived);
    }
  });

  it("matches a card that changed places by its id, and keeps the object it had", () => {
    const held = [row(), { ...row(), id: 9, slug: "other" }, { ...row(), id: 10, slug: "third" }];
    const again = structuredClone([held[2]!, held[0]!, { ...held[1]!, title: "Edited" }]);
    const result = reconcileBlocks(held, again);
    expect(result[0]).toBe(held[2]);
    expect(result[1]).toBe(held[0]);
    expect(result[2]).toBe(again[2]);
  });
});
