import { describe, it, expect } from "vitest";
import { computeCardHeight, DEFAULT_CARD_HEIGHT } from "./cardHeight";
import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";

function makeBlock(overrides: Partial<LightBlock> & { block_type: LightBlock["block_type"] }): LightBlock {
  return {
    id: 1,
    slug: "test",
    title: null,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "",
    first_image: null,
    media_urls: null,
    tags: [],
    ...overrides,
  };
}

// Card outer wrapper has `border` class = 1px top + 1px bottom = 2px added
// to the outer height. All block types include this in their returned height.
const CARD_BORDER = 2;

describe("computeCardHeight — image", () => {
  it("uses exact aspect ratio when width/height metadata present", () => {
    const block = makeBlock({ block_type: "image", width: 1600, height: 900 });
    const h = computeCardHeight(block, 280, null);
    // inner width = 280 - 2 = 278; image h = round(278 * 9/16) = 156; + border
    expect(h).toBe(Math.round(278 * (900 / 1600)) + CARD_BORDER);
  });

  it("enforces minimum height for ultra-wide images", () => {
    const block = makeBlock({ block_type: "image", width: 2000, height: 100 });
    const h = computeCardHeight(block, 280, null);
    // raw = 278 * 100/2000 = 13.9, clamped to IMAGE_MIN_HEIGHT 120; + border
    expect(h).toBeGreaterThanOrEqual(120);
  });

  it("falls back to DEFAULT_CARD_HEIGHT without metadata", () => {
    const block = makeBlock({ block_type: "image", width: null, height: null });
    const h = computeCardHeight(block, 280, null);
    expect(h).toBe(DEFAULT_CARD_HEIGHT);
  });
});

describe("computeCardHeight — video / link / file", () => {
  it("video uses 16:9 aspect", () => {
    const block = makeBlock({ block_type: "video" });
    // inner width 320 - 2 = 318; height = round(318 * 9/16) + border
    expect(computeCardHeight(block, 320, null)).toBe(
      Math.round(318 * 9 / 16) + CARD_BORDER,
    );
  });

  it("link adds footer height to thumbnail", () => {
    const block = makeBlock({ block_type: "link" });
    const expected = Math.round(318 * 9 / 16) + 76 + CARD_BORDER;
    expect(computeCardHeight(block, 320, null)).toBe(expected);
  });

  it("file always returns fixed height + border", () => {
    const block = makeBlock({ block_type: "file" });
    expect(computeCardHeight(block, 280, null)).toBe(88 + CARD_BORDER);
    expect(computeCardHeight(block, 500, null)).toBe(88 + CARD_BORDER);
  });
});

describe("computeCardHeight — article", () => {
  const wordWidths: WordWidths = {
    title: [40, 30, 50, 25, 35],
    preview: [20, 30, 25, 40, 35, 20, 45, 30, 25, 35, 50, 20, 30],
    titleSpace: 4,
    previewSpace: 4,
  };

  it("returns positive height with word widths", () => {
    const block = makeBlock({ block_type: "article", title: "T", body: "b" });
    const h = computeCardHeight(block, 280, wordWidths);
    expect(h).toBeGreaterThan(0);
  });

  it("returns positive height without word widths (fallback)", () => {
    const block = makeBlock({ block_type: "article", title: "T", body: "b" });
    const h = computeCardHeight(block, 280, null);
    expect(h).toBeGreaterThan(0);
  });

  it("fallback height is never larger than measured height (conservative lower bound)", () => {
    // Conservative fallback guarantees that actual height >= fallback.
    // Otherwise totalHeight would shrink on correction, causing jumps.
    const block = makeBlock({ block_type: "article", title: "Long title", body: "Long body" });
    const fallback = computeCardHeight(block, 280, null);
    const measured = computeCardHeight(block, 280, wordWidths);
    expect(measured).toBeGreaterThanOrEqual(fallback);
  });

  it("article with first_image is taller than without", () => {
    const withImage = makeBlock({
      block_type: "article",
      title: "T",
      body: "b",
      first_image: "some.jpg",
    });
    const without = makeBlock({ block_type: "article", title: "T", body: "b" });
    const a = computeCardHeight(withImage, 280, wordWidths);
    const b = computeCardHeight(without, 280, wordWidths);
    expect(a).toBeGreaterThan(b);
  });

  it("article with author is slightly taller", () => {
    const withAuthor = makeBlock({
      block_type: "article",
      title: "T",
      body: "b",
      author: "Somebody",
    });
    const without = makeBlock({ block_type: "article", title: "T", body: "b" });
    expect(
      computeCardHeight(withAuthor, 280, wordWidths),
    ).toBeGreaterThan(computeCardHeight(without, 280, wordWidths));
  });
});

describe("computeCardHeight — determinism", () => {
  it("same inputs always produce same output", () => {
    const block = makeBlock({ block_type: "image", width: 1000, height: 600 });
    const h1 = computeCardHeight(block, 280, null);
    const h2 = computeCardHeight(block, 280, null);
    const h3 = computeCardHeight(block, 280, null);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });
});
