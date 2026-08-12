import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import { deriveCardLayoutDescriptor, deriveContentCardSlots } from "./cardLayout";

function cardKindForBlockType(blockType: LightBlock["block_type"]): LightBlock["card_kind"] {
  return blockType === "article"
    ? "article"
    : blockType === "link"
      ? "link"
    : blockType === "channel"
      ? "channel"
      : "media";
}

function makeBlock(
  overrides: Partial<LightBlock> & { block_type: LightBlock["block_type"] },
): LightBlock {
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


/// Manifest as the generator leaves it: the artifact's own geometry recorded
/// alongside the source's. Card layout must read only the former.
function readyImageManifest(options: {
  previewWidth: number | null;
  previewHeight: number | null;
  sourceWidth?: number;
  sourceHeight?: number;
}): string {
  return JSON.stringify({
    kind: "image",
    primary_preview_path: "test.jpg",
    width: options.sourceWidth ?? null,
    height: options.sourceHeight ?? null,
    preview_width: options.previewWidth,
    preview_height: options.previewHeight,
    tiles: [
      {
        source_path: "photo.jpg",
        preview_path: "test.jpg",
        width: options.sourceWidth ?? null,
        height: options.sourceHeight ?? null,
        preview_width: options.previewWidth,
        preview_height: options.previewHeight,
        is_video: false,
        is_video_poster: false,
      },
    ],
    overflow_count: 0,
  });
}

describe("deriveCardLayoutDescriptor", () => {
  it("renders metadata-only links as text cards without a faux media surface", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "link",
        card_kind: "link",
        title: "AI 2027",
        url: "https://ai-2027.com/race",
      }),
    );
    expect(descriptor.variant).toBe("link");
    expect(descriptor.primaryAspectRatio).toBeNull();
    expect(descriptor.titleText).toBe("AI 2027");
  });

  it("keeps a thumbnail-bearing link semantically link while using its image preview", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "link",
        card_kind: "link",
        title: "Previewed link",
        url: "https://example.com/story",
        preview_manifest: JSON.stringify({
          kind: "image",
          primary_preview_path: "story.jpg",
          width: 1200,
          height: 630,
          tiles: [],
          overflow_count: 0,
        }),
      }),
    );
    expect(descriptor.variant).toBe("link");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(1200 / 630);
  });

  it("takes the image ratio from the artifact it paints", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "image",
        media_file: "photo.jpg",
        // Source is 1600x900; the artifact carries the same shape at 640px.
        preview_manifest: readyImageManifest({
          previewWidth: 640,
          previewHeight: 360,
          sourceWidth: 1600,
          sourceHeight: 900,
        }),
      }),
    );
    expect(descriptor.variant).toBe("image");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(640 / 360);
  });

  it("ignores source dimensions that disagree with the artifact", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "image",
        media_file: "photo.jpg",
        width: 4036,
        height: 2578,
        media_dimensions: "{\"photo.jpg\":[2880,980]}",
        preview_manifest: readyImageManifest({ previewWidth: 600, previewHeight: 400 }),
      }),
    );
    expect(descriptor.variant).toBe("image");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(600 / 400);
  });

  it("shows ordinary portrait and landscape shapes whole", () => {
    const portrait = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "image",
        media_file: "photo.jpg",
        preview_manifest: readyImageManifest({ previewWidth: 506, previewHeight: 640 }),
      }),
    );
    expect(portrait.primaryAspectRatio).toBeCloseTo(506 / 640);

    const landscape = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "image",
        media_file: "photo.jpg",
        preview_manifest: readyImageManifest({ previewWidth: 640, previewHeight: 458 }),
      }),
    );
    expect(landscape.primaryAspectRatio).toBeCloseTo(640 / 458);
  });

  it("clamps only genuinely extreme shapes", () => {
    const panorama = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "image",
        media_file: "photo.jpg",
        preview_manifest: readyImageManifest({ previewWidth: 640, previewHeight: 128 }),
      }),
    );
    expect(panorama.primaryAspectRatio).toBeCloseTo(2);

    const scroll = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "image",
        media_file: "photo.jpg",
        preview_manifest: readyImageManifest({ previewWidth: 128, previewHeight: 640 }),
      }),
    );
    expect(scroll.primaryAspectRatio).toBeCloseTo(0.5);
  });

  it("reports unknown artifact geometry as unknown, not as a square", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "image",
        media_file: "photo.jpg",
        width: 1000,
        height: 1000,
        preview_manifest: readyImageManifest({ previewWidth: null, previewHeight: null }),
      }),
    );
    expect(descriptor.variant).toBe("image");
    expect(descriptor.primaryAspectRatio).toBeNull();
  });

  it("keeps legacy first-image metadata text-only until a ready manifest arrives", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "hello",
        first_image: "cover.jpg",
        media_dimensions: "{\"cover.jpg\":[800,600]}",
      }),
    );
    expect(descriptor.variant).toBe("article-text");
    expect(descriptor.mediaItems).toEqual([]);
  });

  it("uses indexed preview_text instead of raw body for article previews", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        title: "Meeting",
        body: "## Raw heading\n\n- [ ] Raw markdown task that should not render",
        preview_text: "Raw heading Raw markdown task…",
      }),
    );
    expect(descriptor.previewText).toBe("Raw heading Raw markdown task…");
  });

  it("does not derive a composite from source metadata without a ready manifest", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "hello\n![](a.jpg)\n![](b.jpg)\n![](c.jpg)",
        first_image: "a.jpg",
        media_urls: "[\"a.jpg\",\"b.jpg\",\"c.jpg\"]",
        media_dimensions: "{\"a.jpg\":[800,600],\"b.jpg\":[600,800],\"c.jpg\":[900,900]}",
      }),
    );
    expect(descriptor.variant).toBe("article-text");
    expect(descriptor.visibleMediaCount).toBe(0);
  });

  it("does not derive a two-item gallery from source metadata", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "hello\n![](a.jpg)\n![](b.jpg)",
        first_image: "a.jpg",
        media_urls: "[\"a.jpg\",\"b.jpg\"]",
        media_dimensions: "{\"a.jpg\":[800,600],\"b.jpg\":[600,800]}",
      }),
    );
    expect(descriptor.variant).toBe("article-text");
    expect(descriptor.visibleMediaCount).toBe(0);
  });

  it("never exposes legacy media_urls as Grid media items", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "hello\n![](a.webp)\n![](b.webp)",
        first_image: "a.webp",
        media_urls: "[\"a.webp\",\"b.webp\"]",
        media_dimensions: "{\"a.webp\":[1960,1307],\"b.webp\":[1960,1307]}",
      }),
    );
    expect(descriptor.variant).toBe("article-text");
    expect(descriptor.mediaItems).toEqual([]);
    expect(descriptor.visibleMediaCount).toBe(0);
    expect(descriptor.totalMediaCount).toBe(0);
  });

  it("prefers preview_manifest for article composite previews", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "plain text only",
        preview_manifest: JSON.stringify({
          kind: "composite",
          primary_preview_path: "test.jpg",
          width: 1,
          height: 1,
          tiles: [
            { source_path: "a.jpg", preview_path: "a.jpg", width: 800, height: 600, is_video: false, is_video_poster: false },
            { source_path: "b.jpg", preview_path: "b.jpg", width: 600, height: 800, is_video: false, is_video_poster: false },
            { source_path: "c.jpg", preview_path: "c.jpg", width: 900, height: 900, is_video: false, is_video_poster: false },
          ],
          overflow_count: 0,
        }),
      }),
    );
    expect(descriptor.variant).toBe("article-media");
    expect(descriptor.visibleMediaCount).toBe(3);
    expect(descriptor.primaryAspectRatio).toBe(1);
  });

  it("uses a 2:1 wrapper for two-item article composites from preview_manifest", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "plain text only",
        preview_manifest: JSON.stringify({
          kind: "composite",
          primary_preview_path: "test.jpg",
          width: 1,
          height: 1,
          tiles: [
            { source_path: "a.jpg", preview_path: "a.jpg", width: 800, height: 600, is_video: false, is_video_poster: false },
            { source_path: "b.jpg", preview_path: "b.jpg", width: 600, height: 800, is_video: false, is_video_poster: false },
          ],
          overflow_count: 0,
        }),
      }),
    );
    expect(descriptor.variant).toBe("article-media");
    expect(descriptor.visibleMediaCount).toBe(2);
    expect(descriptor.primaryAspectRatio).toBe(2);
  });

  it("classifies social posts with one media item", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        url: "https://x.com/a/status/1",
        body: "hello\n![](photo.jpg)",
        media_urls: "[\"photo.jpg\"]",
        media_dimensions: "{\"photo.jpg\":[1200,800]}",
        preview_manifest: JSON.stringify({
          kind: "image",
          primary_preview_path: "test.jpg",
          width: 1200,
          height: 800,
          tiles: [{ source_path: "photo.jpg", preview_path: "test.preview-1.jpg", width: 1200, height: 800, is_video: false, is_video_poster: false }],
          overflow_count: 0,
        }),
      }),
    );
    expect(descriptor.variant).toBe("social-single-media");
    expect(descriptor.mediaItems).toHaveLength(1);
    expect(descriptor.primaryAspectRatio).toBeCloseTo(1200 / 800);
  });

  it("classifies social posts with several media items as grid", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        url: "https://instagram.com/p/1",
        body: "hello\n![](a.jpg)\n![](b.jpg)\n![](c.jpg)",
        media_urls: "[\"a.jpg\",\"b.jpg\",\"c.jpg\"]",
        preview_manifest: JSON.stringify({
          kind: "composite",
          primary_preview_path: "test.jpg",
          width: 1,
          height: 1,
          tiles: [
            { source_path: "a.jpg", preview_path: "test.preview-1.jpg", width: 1, height: 1, is_video: false, is_video_poster: false },
            { source_path: "b.jpg", preview_path: "test.preview-2.jpg", width: 1, height: 1, is_video: false, is_video_poster: false },
            { source_path: "c.jpg", preview_path: "test.preview-3.jpg", width: 1, height: 1, is_video: false, is_video_poster: false },
          ],
          overflow_count: 0,
        }),
      }),
    );
    expect(descriptor.variant).toBe("social-media-grid");
    expect(descriptor.visibleMediaCount).toBe(3);
  });

  it("uses a 2:1 wrapper for social galleries with exactly two items", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        url: "https://instagram.com/p/1",
        body: "hello\n![](a.jpg)\n![](b.jpg)",
        media_urls: "[\"a.jpg\",\"b.jpg\"]",
        preview_manifest: JSON.stringify({
          kind: "composite",
          primary_preview_path: "test.jpg",
          width: 1,
          height: 1,
          tiles: [
            { source_path: "a.jpg", preview_path: "test.preview-1.jpg", width: 1, height: 1, is_video: false, is_video_poster: false },
            { source_path: "b.jpg", preview_path: "test.preview-2.jpg", width: 1, height: 1, is_video: false, is_video_poster: false },
          ],
          overflow_count: 0,
        }),
      }),
    );
    expect(descriptor.variant).toBe("social-media-grid");
    expect(descriptor.visibleMediaCount).toBe(2);
    expect(descriptor.primaryAspectRatio).toBe(2);
  });

  it("treats social cards without preview text as content cards with no top slot", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        url: "https://x.com/a/status/1",
        author: "@artist",
        body: "![](a.jpg)\n![](b.jpg)",
        media_urls: "[\"a.jpg\",\"b.jpg\"]",
        preview_manifest: JSON.stringify({
          kind: "composite",
          primary_preview_path: "test.jpg",
          width: 1,
          height: 1,
          tiles: [
            { source_path: "a.jpg", preview_path: "test.preview-1.jpg", width: 1, height: 1, is_video: false, is_video_poster: false },
            { source_path: "b.jpg", preview_path: "test.preview-2.jpg", width: 1, height: 1, is_video: false, is_video_poster: false },
          ],
          overflow_count: 0,
        }),
      }),
    );
    const slots = deriveContentCardSlots(descriptor);
    expect(descriptor.variant).toBe("social-media-grid");
    expect(slots).toEqual({
      hasTopContent: false,
      hasMedia: true,
      hasBottomMeta: true,
    });
  });

  it("prefers preview_manifest for social video previews", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        url: "https://x.com/a/status/1",
        body: "tweet text only",
        preview_manifest: JSON.stringify({
          kind: "video_poster",
          primary_preview_path: "tweet.jpg",
          width: 1920,
          height: 1080,
          tiles: [
            { source_path: "clip.mp4", preview_path: "tweet.jpg", width: 1920, height: 1080, is_video: true, is_video_poster: true },
          ],
          overflow_count: 0,
        }),
      }),
    );
    expect(descriptor.variant).toBe("social-single-media");
    expect(descriptor.mediaItems).toHaveLength(1);
    expect(descriptor.mediaItems[0]?.isVideo).toBe(true);
    expect(descriptor.primaryAspectRatio).toBeCloseTo(1920 / 1080);
  });

  it("prefers preview_manifest for article video previews", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "article text only",
        preview_manifest: JSON.stringify({
          kind: "video_poster",
          primary_preview_path: "article-video.jpg",
          width: 1280,
          height: 720,
          tiles: [
            { source_path: "clip.mp4", preview_path: "article-video.jpg", width: 1280, height: 720, is_video: true, is_video_poster: true },
          ],
          overflow_count: 0,
        }),
      }),
    );
    expect(descriptor.variant).toBe("article-media");
    expect(descriptor.mediaItems).toHaveLength(1);
    expect(descriptor.mediaItems[0]?.isVideo).toBe(true);
    expect(descriptor.primaryAspectRatio).toBeCloseTo(1280 / 720);
  });

  it("keeps poster-only video manifests non-playable", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "video",
        preview_manifest: JSON.stringify({
          kind: "video_poster",
          primary_preview_path: "poster.jpg",
          width: 1280,
          height: 720,
          tiles: [
            { source_path: "poster.jpg", preview_path: "poster.jpg", width: 1280, height: 720, is_video: false, is_video_poster: true },
          ],
          overflow_count: 0,
        }),
      }),
    );
    expect(descriptor.variant).toBe("video");
    expect(descriptor.mediaItems[0]?.isVideo).toBe(false);
    expect(descriptor.mediaItems[0]?.isVideoPoster).toBe(true);
  });

  it("uses card_kind article even when legacy block_type says image", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        card_kind: "article",
        block_type: "image",
        body: "![[photo.jpg]]",
        media_file: "photo.jpg",
      }),
    );
    expect(descriptor.variant).toBe("article-text");
    expect(descriptor.previewText).toBe("");
  });

  it("uses media metadata instead of legacy block_type for media cards", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        card_kind: "media",
        block_type: "article",
        media_file: "photo.jpg",
        width: 1200,
        height: 800,
        preview_manifest: readyImageManifest({ previewWidth: 600, previewHeight: 400 }),
      }),
    );
    expect(descriptor.variant).toBe("image");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(600 / 400);
  });

  it("keeps url-only media with image preview on the link shell", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        card_kind: "media",
        block_type: "image",
        url: "https://example.com/story",
        preview_manifest: JSON.stringify({
          kind: "image",
          primary_preview_path: "story.jpg",
          width: 1200,
          height: 630,
          tiles: [],
          overflow_count: 0,
        }),
      }),
    );
    expect(descriptor.variant).toBe("link");
  });

  it("uses channel card_kind instead of legacy media block_type", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        card_kind: "channel",
        block_type: "video",
        title: "References",
        body: "Collection page",
      }),
    );
    expect(descriptor.variant).toBe("article-text");
    expect(descriptor.titleText).toBe("References");
  });
});
