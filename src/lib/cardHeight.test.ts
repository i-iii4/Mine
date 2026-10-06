import { describe, it, expect } from "vitest";
import {
  CARD_HOVER_ACTION_MIN_HEIGHT,
  computeCardHeight,
  computeFeedPlaybackSurfaceEnvelope,
  DEFAULT_CARD_HEIGHT,
} from "./cardHeight";
import { PROVISIONAL_MEDIA_ASPECT } from "./cardAspect";
import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";

function cardKindForBlockType(blockType: LightBlock["block_type"]): LightBlock["card_kind"] {
  return blockType === "article"
    ? "article"
    : blockType === "link"
      ? "link"
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

/// A link whose page picture came from a source of one shape, with a preview
/// artifact of another shape, or not measured yet.
function pageLink(options: {
  source: [number, number];
  artifact: [number, number] | null;
}): LightBlock {
  const [sourceWidth, sourceHeight] = options.source;
  const artifactWidth = options.artifact?.[0] ?? null;
  const artifactHeight = options.artifact?.[1] ?? null;
  return makeBlock({
    block_type: "link",
    title: "A page",
    url: "https://example.com/page",
    preview_manifest: JSON.stringify({
      kind: "image", primary_preview_path: "page.jpg",
      width: sourceWidth, height: sourceHeight,
      preview_width: artifactWidth, preview_height: artifactHeight,
      tiles: [{ source_path: "https://example.com/og.jpg", preview_path: "page.preview-1.jpg",
        width: sourceWidth, height: sourceHeight,
        preview_width: artifactWidth, preview_height: artifactHeight,
        is_video: false, is_video_poster: false }],
      overflow_count: 0,
    }),
  });
}

function artifactManifest(previewWidth: number, previewHeight: number): string {
  return JSON.stringify({
    kind: "image",
    primary_preview_path: "test.jpg",
    width: null,
    height: null,
    preview_width: previewWidth,
    preview_height: previewHeight,
    tiles: [
      {
        source_path: "photo.jpg",
        preview_path: "test.jpg",
        width: null,
        height: null,
        preview_width: previewWidth,
        preview_height: previewHeight,
        is_video: false,
        is_video_poster: false,
      },
    ],
    overflow_count: 0,
  });
}

function derivedPreviewManifest(
  sources: string[],
  dimensions: Record<string, [number, number]> = {},
): string {
  const first = sources[0] ?? null;
  const firstDimensions = first ? dimensions[first] : undefined;
  return JSON.stringify({
    kind: sources.length > 1 ? "composite" : "image",
    primary_preview_path: first ? "test.preview-0.jpg" : null,
    width: firstDimensions?.[0] ?? null,
    height: firstDimensions?.[1] ?? null,
    tiles: sources.map((source, index) => ({
      source_path: source,
      preview_path: `test.preview-${index}.jpg`,
      width: dimensions[source]?.[0] ?? null,
      height: dimensions[source]?.[1] ?? null,
      is_video: false,
      is_video_poster: false,
    })),
    overflow_count: 0,
  });
}

// Card outer wrapper has `border` class = 1px top + 1px bottom = 2px added
// to the outer height. All block types include this in their returned height.
const CARD_BORDER = 2;

// The line in the frame's colour between a framed card's media and the text
// under it (SPEC_FEED_DISPLAY.md, Д20): 1px of the card's height.
const MEDIA_RULE = 1;

describe("computeCardHeight — image", () => {
  it("reserves height from the artifact ratio", () => {
    const block = makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      // Stale source metadata that disagrees with the artifact.
      width: 1000,
      height: 1000,
      preview_manifest: artifactManifest(640, 360),
    });
    const h = computeCardHeight(block, 280, null);
    // inner width = 278; artifact ratio 640/360 is inside the clamp range
    expect(h).toBe(Math.round(278 * (360 / 640)) + CARD_BORDER);
  });

  it("keeps a tall portrait whole up to the clamp", () => {
    const block = makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      preview_manifest: artifactManifest(506, 640),
    });
    // 506/640 is inside the range: full height, no crop.
    expect(computeCardHeight(block, 280, null)).toBe(
      Math.round(278 * (640 / 506)) + CARD_BORDER,
    );
  });

  it("clamps a panorama to twice its width instead of collapsing it", () => {
    const block = makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      preview_manifest: artifactManifest(2000, 100),
    });
    // Raw ratio 20 would leave a 14px strip; the clamp holds it at 2:1.
    expect(computeCardHeight(block, 280, null)).toBe(Math.round(278 / 2) + CARD_BORDER);
  });

  it("clamps a scroll-shaped screenshot to twice its height", () => {
    const block = makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      preview_manifest: artifactManifest(100, 2000),
    });
    // Raw ratio 0.05 would hand one card several screens.
    expect(computeCardHeight(block, 280, null)).toBe(Math.round(278 / 0.5) + CARD_BORDER);
  });

  it("still honours the interactive floor on very narrow columns", () => {
    const block = makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      preview_manifest: artifactManifest(2000, 100),
    });
    // Clamped height would be 74px here, below the hover-control floor.
    expect(computeCardHeight(block, 150, null)).toBe(CARD_HOVER_ACTION_MIN_HEIGHT);
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
      preview_manifest: artifactManifest(640, 360),
    });
    expect(computeCardHeight(block, 280, null)).toBe(
      Math.round(278 * (360 / 640)) + CARD_BORDER,
    );
  });
});

/** A video card's poster manifest: source size and the poster's own size. */
function videoPosterManifest(width: number, height: number, previewWidth: number, previewHeight: number): string {
  return JSON.stringify({
    kind: "video_poster",
    primary_preview_path: "clip.jpg",
    width,
    height,
    preview_width: previewWidth,
    preview_height: previewHeight,
    tiles: [{
      source_path: "clip.mp4",
      preview_path: "clip.preview-1.jpg",
      width,
      height,
      preview_width: previewWidth,
      preview_height: previewHeight,
      is_video: true,
      is_video_poster: true,
    }],
    overflow_count: 0,
  });
}

describe("computeCardHeight — video / link / file", () => {
  it("video without a poster yet keeps the provisional 16:9 envelope", () => {
    const block = makeBlock({ block_type: "video", media_file: "clip.mp4" });
    // inner width 320 - 2 = 318; height = round(318 * 9/16) + border
    expect(computeCardHeight(block, 320, null)).toBe(
      Math.round(318 * 9 / 16) + CARD_BORDER,
    );
  });

  it("a video card takes its poster's shape, not a fixed 16:9 slot (30.09.2026)", () => {
    // The square video restored from Orphans: 1080×1080, poster 640×640.
    const square = makeBlock({
      block_type: "video",
      media_file: "clip.mp4",
      preview_manifest: videoPosterManifest(1080, 1080, 640, 640),
    });
    expect(computeCardHeight(square, 320, null)).toBe(318 + CARD_BORDER);
    expect(computeFeedPlaybackSurfaceEnvelope(square, 320)).toEqual({ topOffsetPx: 1, heightPx: 318 });

    // A vertical 4:5 video stands taller than wide.
    const vertical = makeBlock({
      block_type: "video",
      media_file: "clip.mp4",
      preview_manifest: videoPosterManifest(2160, 2700, 512, 640),
    });
    expect(computeCardHeight(vertical, 320, null)).toBe(Math.round(318 / 0.8) + CARD_BORDER);

    // A 9:16 phone video fits inside the card limits whole.
    const phone = makeBlock({
      block_type: "video",
      media_file: "clip.mp4",
      preview_manifest: videoPosterManifest(1080, 1920, 360, 640),
    });
    expect(computeCardHeight(phone, 320, null)).toBe(Math.round(318 / (360 / 640)) + CARD_BORDER);

    // Narrower than 1:2 stops at the card limit.
    const strip = makeBlock({
      block_type: "video",
      media_file: "clip.mp4",
      preview_manifest: videoPosterManifest(360, 1080, 214, 640),
    });
    expect(computeCardHeight(strip, 320, null)).toBe(318 * 2 + CARD_BORDER);
  });

  it("link adds footer height to thumbnail", () => {
    const block = makeBlock({
      block_type: "link",
      url: "https://example.com",
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "link.jpg",
        width: 1600,
        height: 900,
        tiles: [],
        overflow_count: 0,
      }),
    });
    // The line under the picture (Д20), then 12 + title 16 + 2 + domain 16 + 12:
    // the footer LinkCard paints.
    const expected = Math.round(318 * 9 / 16) + MEDIA_RULE + 58 + CARD_BORDER;
    expect(computeCardHeight(block, 320, null)).toBe(expected);
  });

  it("metadata-only link uses text-card geometry", () => {
    const link = makeBlock({
      block_type: "link",
      card_kind: "link",
      title: "AI 2027",
      url: "https://ai-2027.com/race",
    });
    const article = makeBlock({
      block_type: "article",
      card_kind: "article",
      title: "AI 2027",
    });
    expect(computeCardHeight(link, 320, null)).toBe(computeCardHeight(article, 320, null));
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
        preview_width: 572,
        preview_height: 360,
        tiles: [
          {
            source_path: "clip.mp4",
            preview_path: "clip.jpg",
            width: 1144,
            height: 720,
            preview_width: 572,
            preview_height: 360,
            is_video: true,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
      collections: [],
      feed_playback: JSON.stringify({
        kind: "single_video",
        source_path: "clip.mp4",
        poster_preview_path: "test.jpg",
        width: 1144,
        height: 720,
        container: "mp4",
      }),
    });

    // Right under the border, across the frame's inner width (Д20).
    expect(computeFeedPlaybackSurfaceEnvelope(block, 280)).toEqual({
      topOffsetPx: 1,
      heightPx: Math.round(278 / (1144 / 720)),
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
      collections: [],
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

  it("article with a ready derived preview is taller than without", () => {
    const withImage = makeBlock({
      block_type: "article",
      title: "T",
      body: "b",
      first_image: "some.jpg",
      preview_manifest: derivedPreviewManifest(["some.jpg"], {
        "some.jpg": [1200, 800],
      }),
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
      preview_manifest: derivedPreviewManifest(["photo.jpg"], {
        "photo.jpg": [1200, 800],
      }),
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
      preview_manifest: derivedPreviewManifest(["a.jpg", "b.jpg"]),
    });
    const four = makeBlock({
      block_type: "article",
      url: "https://instagram.com/p/1",
      body: "hello\n![](a.jpg)\n![](b.jpg)\n![](c.jpg)\n![](d.jpg)",
      media_urls: "[\"a.jpg\",\"b.jpg\",\"c.jpg\",\"d.jpg\"]",
      preview_manifest: derivedPreviewManifest(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]),
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
      preview_manifest: derivedPreviewManifest(["a.jpg", "b.jpg"]),
    });
    const h = computeCardHeight(block, 280, wordWidths);
    // border 2 + the two-tile gallery at 2:1 across the inner width (278 / 2
    // = 139, the height its surface paints) + the 1px line under it (Д20) +
    // 14px to the author's letters (box 12) + author 16 + 14px under them
    // (box 12)
    expect(h).toBe(182);
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

describe("card presentation heights (SPEC_FEED_DISPLAY.md, Д15)", () => {
  const titleWidths: WordWidths = {
    title: [60],
    preview: [],
    titleSpace: 4,
    previewSpace: 4,
    titleNoSpaceBefore: [false],
    previewNoSpaceBefore: [],
  };
  const picture = () => makeBlock({
    block_type: "image",
    media_file: "photo.jpg",
    fallback_label: "Sunset",
    preview_manifest: artifactManifest(640, 480),
  });

  it("Cards lays a picture out exactly as the post card it looks like", () => {
    const post = makeBlock({
      block_type: "article",
      title: "Sunset",
      body: "![](photo.jpg)",
      media_urls: "[\"photo.jpg\"]",
      preview_manifest: artifactManifest(640, 480),
    });
    const titled = { ...picture(), content_heading: "Sunset" };
    const asCard = computeCardHeight(titled, 320, titleWidths, "cards");
    expect(asCard).toBe(computeCardHeight(post, 320, titleWidths, "mixed"));
    // Its own title makes it taller than the bare picture.
    expect(asCard).toBeGreaterThan(computeCardHeight(picture(), 320, null, "mixed"));
    // A file name is no title: without a heading the card is its media alone.
    expect(computeCardHeight(picture(), 320, titleWidths, "cards"))
      .toBe(computeCardHeight(picture(), 320, null, "mixed"));
  });

  it("Cards lays out a picture's text and author like the post card it looks like (В5.3)", () => {
    const widths: WordWidths = {
      title: [60],
      preview: [70, 30, 40],
      titleSpace: 4,
      previewSpace: 4,
      titleNoSpaceBefore: [false],
      previewNoSpaceBefore: [false, false, false],
    };
    const described = makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      fallback_label: "Sunset",
      content_heading: "Sunset",
      author: "@someone",
      preview_text: "Evening over the bay",
      preview_manifest: artifactManifest(640, 480),
    });
    const post = makeBlock({
      block_type: "article",
      title: "Sunset",
      body: "Evening over the bay\n\n![](photo.jpg)",
      media_urls: "[\"photo.jpg\"]",
      author: "@someone",
      preview_text: "Evening over the bay",
      preview_manifest: artifactManifest(640, 480),
    });
    expect(computeCardHeight(described, 320, widths, "cards"))
      .toBe(computeCardHeight(post, 320, widths, "mixed"));
  });

  it("Media holds a link's tall page picture at twice the width (В5.2)", () => {
    const tallPage = pageLink({ source: [100, 1000], artifact: [100, 1000] });
    const innerWidth = 320 - CARD_BORDER;
    expect(computeCardHeight(tallPage, 320, null, "media")).toBe(innerWidth * 2 + CARD_BORDER);
  });

  it("Media lays a link's page picture out at its artifact's shape, not its source's (В5.7)", () => {
    const link = pageLink({ source: [1200, 630], artifact: [600, 900] });
    const innerWidth = 320 - CARD_BORDER;
    expect(computeCardHeight(link, 320, null, "media"))
      .toBe(Math.round(innerWidth / (600 / 900)) + CARD_BORDER);
  });

  it("Media reserves the provisional envelope for an unmeasured page picture (В5.7)", () => {
    const link = pageLink({ source: [1200, 630], artifact: null });
    const innerWidth = 320 - CARD_BORDER;
    expect(computeCardHeight(link, 320, null, "media"))
      .toBe(Math.round(innerWidth / PROVISIONAL_MEDIA_ASPECT) + CARD_BORDER);
  });

  it("Mixed and Cards keep the link's 16:9 thumbnail slot whatever its picture's shape (В5.7)", () => {
    // The line under the picture (Д20), then 12 + title 16 + 2 + domain 16 + 12:
    // the footer LinkCard paints.
    const expected = Math.round(318 * 9 / 16) + MEDIA_RULE + 58 + CARD_BORDER;
    for (const artifact of [[600, 900], null] as const) {
      const link = pageLink({ source: [1200, 630], artifact: artifact ? [artifact[0], artifact[1]] : null });
      expect(computeCardHeight(link, 320, null, "mixed")).toBe(expected);
      expect(computeCardHeight(link, 320, null, "cards")).toBe(expected);
    }
  });

  it("Media gives a post exactly the height of its picture alone", () => {
    const post = makeBlock({
      block_type: "article",
      title: "A post with words",
      body: "Some words\n\n![](photo.jpg)",
      media_urls: "[\"photo.jpg\"]",
      author: "@someone",
      preview_manifest: artifactManifest(640, 480),
    });
    expect(computeCardHeight(post, 320, null, "media")).toBe(
      computeCardHeight(picture(), 320, null, "mixed"),
    );
  });

  it("Media plays a post's single video over the whole card", () => {
    const post = makeBlock({
      block_type: "article",
      title: "Clip",
      body: "words\n\n![](clip.mp4)",
      media_urls: "[\"clip.mp4\"]",
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "test.jpg",
        width: 1080,
        height: 1080,
        preview_width: 640,
        preview_height: 640,
        tiles: [{
          source_path: "clip.mp4", preview_path: "test.preview-1.jpg",
          width: 1080, height: 1080, preview_width: 640, preview_height: 640,
          is_video: true, is_video_poster: true,
        }],
        overflow_count: 0,
      }),
    });
    expect(computeFeedPlaybackSurfaceEnvelope(post, 320, "media")).toEqual({ topOffsetPx: 1, heightPx: 318 });
    expect(computeCardHeight(post, 320, null, "media")).toBe(318 + CARD_BORDER);
  });
});

describe("post card geometry (SPEC_FEED_DISPLAY.md, Д20, Д25)", () => {
  const COLUMN = 320;
  const INNER = COLUMN - CARD_BORDER;
  /// Every vertical gap reads as 14px from letter to letter (Д25): the box gap
  /// is 14 less the half-leading of the lines that meet. A 12px title or author
  /// on a 16px line has 2px of it, a 20px text line 4px.
  const TOP_TITLE = 12;
  const TOP_TEXT = 10;
  const BOTTOM_TEXT = 10;
  const TITLE_TO_TEXT = 8;
  const singleVideoManifest = JSON.stringify({
    kind: "video_poster",
    primary_preview_path: "test.jpg",
    width: 1280,
    height: 720,
    preview_width: 640,
    preview_height: 360,
    tiles: [{
      source_path: "clip.mp4", preview_path: "test.preview-1.jpg",
      width: 1280, height: 720, preview_width: 640, preview_height: 360,
      is_video: true, is_video_poster: true,
    }],
    overflow_count: 0,
  });
  const playback = JSON.stringify({
    kind: "single_video",
    source_path: "clip.mp4",
    poster_preview_path: "test.jpg",
    width: 1280,
    height: 720,
    container: "mp4",
  });

  it("plays a post's single video over its media, right under the border (Д24)", () => {
    for (const post of [
      makeBlock({
        block_type: "article",
        title: "Clip",
        body: "words\n\n![](clip.mp4)",
        media_urls: "[\"clip.mp4\"]",
        preview_manifest: singleVideoManifest,
        collections: [],
        feed_playback: playback,
      }),
      makeBlock({
        block_type: "article",
        url: "https://x.com/someone/status/1",
        body: "![](clip.mp4)",
        media_urls: "[\"clip.mp4\"]",
        preview_manifest: singleVideoManifest,
        collections: [],
        feed_playback: playback,
      }),
    ]) {
      expect(computeFeedPlaybackSurfaceEnvelope(post, COLUMN, "mixed")).toEqual({
        topOffsetPx: 1,
        heightPx: Math.round(INNER / (640 / 360)),
      });
    }
  });

  it("gives a post's media the frame's full width and its text an 8px side padding (Д20)", () => {
    const widths: WordWidths = {
      title: [60],
      preview: [70, 30, 40],
      titleSpace: 4,
      previewSpace: 4,
      titleNoSpaceBefore: [false],
      previewNoSpaceBefore: [false, false, false],
    };
    const post = makeBlock({
      block_type: "article",
      title: "Sunset",
      body: "Evening over the bay\n\n![](photo.jpg)",
      media_urls: "[\"photo.jpg\"]",
      preview_text: "Evening over the bay",
      preview_manifest: artifactManifest(640, 480),
    });
    expect(computeCardHeight(post, COLUMN, widths, "mixed")).toBe(
      CARD_BORDER + Math.round(INNER / (640 / 480)) + MEDIA_RULE + TOP_TITLE + 16 + TITLE_TO_TEXT + 20 + BOTTOM_TEXT,
    );
  });

  it("wraps a post's text at its 302px column (Д20)", () => {
    // 150 + 4 + 140 = 294px: one line in the 318 − 16 = 302px column.
    const widths: WordWidths = {
      title: [150, 140],
      preview: [150, 140],
      titleSpace: 4,
      previewSpace: 4,
      titleNoSpaceBefore: [false, false],
      previewNoSpaceBefore: [false, false],
    };
    const article = makeBlock({
      block_type: "article",
      title: "Sunset",
      body: "Evening over the bay\n\n![](photo.jpg)",
      media_urls: "[\"photo.jpg\"]",
      preview_text: "Evening over the bay",
      preview_manifest: artifactManifest(640, 480),
    });
    expect(computeCardHeight(article, COLUMN, widths, "mixed")).toBe(
      CARD_BORDER + Math.round(INNER / (640 / 480)) + MEDIA_RULE + TOP_TITLE + 16 + TITLE_TO_TEXT + 20 + BOTTOM_TEXT,
    );

    const xPost = makeBlock({
      block_type: "article",
      url: "https://x.com/someone/status/1",
      body: "Evening over the bay\n\n![](photo.jpg)",
      media_urls: "[\"photo.jpg\"]",
      preview_text: "Evening over the bay",
      preview_manifest: artifactManifest(640, 480),
    });
    expect(computeCardHeight(xPost, COLUMN, widths, "mixed")).toBe(
      CARD_BORDER + Math.round(INNER / (640 / 480)) + MEDIA_RULE + TOP_TEXT + 20 + BOTTOM_TEXT,
    );
  });

  it("keeps a text post's letters 14px from the frame's top and bottom (Д25)", () => {
    // Three 300px words wrap to three lines: tall enough to clear the card's
    // 90px interactive minimum.
    const widths: WordWidths = {
      title: [60],
      preview: [300, 300, 300],
      titleSpace: 4,
      previewSpace: 4,
      titleNoSpaceBefore: [false],
      previewNoSpaceBefore: [false, false, false],
    };
    const text = makeBlock({
      block_type: "article",
      title: "Only words",
      body: "Evening over the bay",
      preview_text: "Evening over the bay",
    });
    expect(computeCardHeight(text, COLUMN, widths, "mixed")).toBe(
      CARD_BORDER + TOP_TITLE + 16 + TITLE_TO_TEXT + 20 * 3 + BOTTOM_TEXT,
    );
  });
});
