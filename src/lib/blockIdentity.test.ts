import { describe, it, expect } from "vitest";
import type { LightBlock } from "@/types";
import { lightBlockContentEqual, reconcileBlocks } from "./blockIdentity";

function makeBlock(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return {
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
    feed_playback: null,
    ...overrides,
  };
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
