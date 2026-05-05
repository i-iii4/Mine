import { describe, it, expect } from "vitest";
import {
  CARD_HOVER_ACTION_MIN_HEIGHT,
  computeCardHeight,
  computeFeedPlaybackSurfaceEnvelope,
  DEFAULT_CARD_HEIGHT,
} from "./cardHeight";
import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";

function cardKindForBlockType(blockType: LightBlock["block_type"]): LightBlock["card_kind"] {
  return blockType === "article"
    ? "article"
    : blockType === "channel"
      ? "channel"
      : "media";
}

function makeBlock(overrides: Partial<LightBlock> & { block_type: LightBlock["block_type"] }): LightBlock {
  const cardKind = overrides.card_kind ?? cardKindForBlockType(overrides.block_type);
  return {
    id: 1,
    slug: "test",
    card_kind: cardKind,
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
    media_dimensions: null,
    preview_manifest: null,
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
    const block = makeBlock({ block_type: "image", width: null, height: null, thumbnail: "thumb.jpg" });
    const h = computeCardHeight(block, 280, null);
    expect(h).toBe(DEFAULT_CARD_HEIGHT);
  });

  it("uses card_kind media with image metadata even when legacy type says article", () => {
    const block = makeBlock({
      card_kind: "media",
      block_type: "article",
      media_file: "photo.jpg",
      width: 1600,
      height: 900,
    });
    expect(computeCardHeight(block, 280, null)).toBe(
      Math.round(278 * (900 / 1600)) + CARD_BORDER,
    );
  });
});

describe("computeCardHeight — video / link / file", () => {
  it("video uses 16:9 aspect", () => {
    const block = makeBlock({ block_type: "video", media_file: "clip.mp4" });
    // inner width 320 - 2 = 318; height = round(318 * 9/16) + border
    expect(computeCardHeight(block, 320, null)).toBe(
      Math.round(318 * 9 / 16) + CARD_BORDER,
    );
  });

  it("link adds footer height to thumbnail", () => {
    const block = makeBlock({ block_type: "link", url: "https://example.com" });
    const expected = Math.round(318 * 9 / 16) + 76 + CARD_BORDER;
    expect(computeCardHeight(block, 320, null)).toBe(expected);
  });

  it("file always returns fixed height + border", () => {
    const block = makeBlock({ block_type: "file" });
    expect(computeCardHeight(block, 280, null)).toBe(CARD_HOVER_ACTION_MIN_HEIGHT);
    expect(computeCardHeight(block, 500, null)).toBe(CARD_HOVER_ACTION_MIN_HEIGHT);
  });
});

describe("computeFeedPlaybackSurfaceEnvelope", () => {
  it("returns the dedicated video surface inside the bordered card frame", () => {
    const block = makeBlock({ block_type: "video", media_file: "clip.mp4" });
    expect(computeFeedPlaybackSurfaceEnvelope(block, 320)).toEqual({
      topOffsetPx: 1,
      heightPx: Math.round(318 * 9 / 16),
    });
  });

  it("returns the media-first surface for single-video article cards", () => {
    const block = makeBlock({
      block_type: "article",
      title: "Glass browser",
      body: "hello\n![](clip.mp4)",
      media_urls: "[\"clip.mp4\"]",
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "test.jpg",
        width: 1144,
        height: 720,
        tiles: [
          {
            source_path: "clip.mp4",
            preview_path: "clip.jpg",
            width: 1144,
            height: 720,
            is_video: true,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
      feed_playback: JSON.stringify({
        kind: "single_video",
        source_path: "clip.mp4",
        poster_preview_path: "test.jpg",
        width: 1144,
        height: 720,
        container: "mp4",
      }),
    });

    expect(computeFeedPlaybackSurfaceEnvelope(block, 280)).toEqual({
      topOffsetPx: 17,
      heightPx: Math.round(246 / (1144 / 720)),
    });
  });

  it("returns null for multi-media galleries", () => {
    const block = makeBlock({
      block_type: "article",
      url: "https://x.com/a/status/1",
      body: "hello\n![](clip.mp4)\n![](still.jpg)",
      media_urls: "[\"clip.mp4\",\"still.jpg\"]",
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "test.jpg",
        width: 1,
        height: 1,
        tiles: [
          {
            source_path: "clip.mp4",
            preview_path: "clip.jpg",
            width: 1144,
            height: 720,
            is_video: true,
            is_video_poster: false,
          },
          {
            source_path: "still.jpg",
            preview_path: "still.jpg",
            width: 1144,
            height: 720,
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
      feed_playback: null,
    });

    expect(computeFeedPlaybackSurfaceEnvelope(block, 280)).toBeNull();
  });

  it("does not use legacy video type when card_kind is article", () => {
    const block = makeBlock({
      card_kind: "article",
      block_type: "video",
      body: "Plain article",
      media_file: "clip.mp4",
    });

    expect(computeFeedPlaybackSurfaceEnvelope(block, 320)).toBeNull();
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

  it("fallback height reserves at least as much space as measured height", () => {
    const block = makeBlock({ block_type: "article", title: "Long title", body: "Long body" });
    const fallback = computeCardHeight(block, 280, null);
    const measured = computeCardHeight(block, 280, wordWidths);
    expect(fallback).toBeGreaterThanOrEqual(measured);
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

describe("computeCardHeight — social", () => {
  const wordWidths: WordWidths = {
    title: [],
    preview: [30, 28, 35, 20, 40, 18, 30],
    titleSpace: 4,
    previewSpace: 4,
  };

  it("single-media social card uses exact media aspect ratio", () => {
    const block = makeBlock({
      block_type: "article",
      url: "https://x.com/a/status/1",
      body: "hello\n![](photo.jpg)",
      media_dimensions: "{\"photo.jpg\":[1200,800]}",
      media_urls: "[\"photo.jpg\"]",
    });
    const h = computeCardHeight(block, 280, wordWidths);
    expect(h).toBeGreaterThan(150);
  });

  it("grid social card with 4 items is taller than with 2 items", () => {
    const two = makeBlock({
      block_type: "article",
      url: "https://instagram.com/p/1",
      body: "hello\n![](a.jpg)\n![](b.jpg)",
      media_urls: "[\"a.jpg\",\"b.jpg\"]",
    });
    const four = makeBlock({
      block_type: "article",
      url: "https://instagram.com/p/1",
      body: "hello\n![](a.jpg)\n![](b.jpg)\n![](c.jpg)\n![](d.jpg)",
      media_urls: "[\"a.jpg\",\"b.jpg\",\"c.jpg\",\"d.jpg\"]",
    });
    expect(computeCardHeight(four, 280, wordWidths)).toBeGreaterThan(computeCardHeight(two, 280, wordWidths));
  });

  it("keeps the text-stack gap under social media even when byline is the first text block", () => {
    const block = makeBlock({
      block_type: "article",
      url: "https://instagram.com/p/1",
      author: "@artist",
      body: "![](a.jpg)\n![](b.jpg)",
      media_urls: "[\"a.jpg\",\"b.jpg\"]",
    });
    const h = computeCardHeight(block, 280, wordWidths);
    // border 2 + top padding 16 + one media row 122 + text-stack gap 12 + author 16 + bottom padding 16
    expect(h).toBe(184);
  });

  it("enforces the interactive minimum for empty social cards", () => {
    const block = makeBlock({
      block_type: "article",
      url: "https://x.com/a/status/1",
      body: "",
    });

    expect(computeCardHeight(block, 280, wordWidths)).toBe(CARD_HOVER_ACTION_MIN_HEIGHT);
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
