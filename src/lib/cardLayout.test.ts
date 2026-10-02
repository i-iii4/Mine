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

  it("keeps a thumbnail-bearing link semantically link in its fixed thumbnail slot", () => {
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
    // The framed link paints its page picture in a fixed 16:9 slot
    // (SPEC_GRID.md); the source's 1200x630 is never card geometry.
    expect(descriptor.primaryAspectRatio).toBe(16 / 9);
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
          preview_width: 600,
          preview_height: 400,
          tiles: [{ source_path: "photo.jpg", preview_path: "test.preview-1.jpg", width: 1200, height: 800, preview_width: 600, preview_height: 400, is_video: false, is_video_poster: false }],
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
          preview_width: 640,
          preview_height: 360,
          tiles: [
            { source_path: "clip.mp4", preview_path: "tweet.jpg", width: 1920, height: 1080, preview_width: 640, preview_height: 360, is_video: true, is_video_poster: true },
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
          preview_width: 640,
          preview_height: 360,
          tiles: [
            { source_path: "clip.mp4", preview_path: "article-video.jpg", width: 1280, height: 720, preview_width: 640, preview_height: 360, is_video: true, is_video_poster: true },
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

// Card shape follows the artifact the card paints, never the source file.
// A preview is downscaled and may be clamped, so the two shapes differ — and
// laying out from the source crops what is actually drawn.
// See SPEC_CARD_MEDIA_GEOMETRY.md.
describe("card shape comes from the artifact, not the source", () => {
  /// Source and artifact disagree on purpose: 1000×500 is landscape 2.0,
  /// 320×640 is portrait 0.5. Anything reading the source lands on 2.0.
  function disagreeingManifest() {
    return JSON.stringify({
      kind: "image",
      primary_preview_path: "preview.jpg",
      width: 1000,
      height: 500,
      preview_width: 320,
      preview_height: 640,
      tiles: [
        {
          source_path: "photo.jpg",
          preview_path: "preview.jpg",
          width: 1000,
          height: 500,
          preview_width: 320,
          preview_height: 640,
          is_video: false,
          is_video_poster: false,
        },
      ],
      overflow_count: 0,
    });
  }

  /// Same manifest with the artifact never measured — the state every preview
  /// written before the geometry fields existed was in.
  function unmeasuredManifest() {
    return JSON.stringify({
      kind: "image",
      primary_preview_path: "preview.jpg",
      width: 1000,
      height: 500,
      tiles: [
        {
          source_path: "photo.jpg",
          preview_path: "preview.jpg",
          width: 1000,
          height: 500,
          is_video: false,
          is_video_poster: false,
        },
      ],
      overflow_count: 0,
    });
  }

  it("shapes an article card with one image from the artifact", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        card_kind: "article",
        block_type: "article",
        title: "Piece",
        url: "https://example.com/piece",
        preview_manifest: disagreeingManifest(),
      }),
    );

    expect(descriptor.variant).toBe("article-media");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(0.5);
    expect(descriptor.mediaItems[0]?.aspectRatio).toBeCloseTo(0.5);
  });

  it("shapes a social card with one image from the artifact", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        card_kind: "article",
        block_type: "article",
        title: null,
        url: "https://x.com/someone/status/123",
        body: "A post",
        preview_manifest: disagreeingManifest(),
      }),
    );

    expect(descriptor.variant).toBe("social-single-media");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(0.5);
  });

  it("leaves a social card's shape unknown rather than calling it square", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        card_kind: "article",
        block_type: "article",
        title: null,
        url: "https://x.com/someone/status/123",
        body: "A post",
        preview_manifest: unmeasuredManifest(),
      }),
    );

    expect(descriptor.variant).toBe("social-single-media");
    // Not 1: a square is a plausible-looking proportion, which is exactly what
    // makes substituting it a lie rather than a placeholder.
    expect(descriptor.primaryAspectRatio).toBeNull();
    expect(descriptor.mediaItems[0]?.aspectRatio).toBeNull();
  });

  it("leaves an article card's shape unknown rather than guessing from the source", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        card_kind: "article",
        block_type: "article",
        title: "Piece",
        url: "https://example.com/piece",
        preview_manifest: unmeasuredManifest(),
      }),
    );

    expect(descriptor.variant).toBe("article-media");
    expect(descriptor.primaryAspectRatio).toBeNull();
  });
});

describe("dedicated video card shape (30.09.2026)", () => {
  function videoCard(previewWidth: number, previewHeight: number) {
    return deriveCardLayoutDescriptor(makeBlock({
      block_type: "video",
      media_file: "clip.mp4",
      width: 1920,
      height: 1080,
      preview_manifest: JSON.stringify({
        kind: "video_poster", primary_preview_path: "clip.jpg", width: null, height: null,
        preview_width: previewWidth, preview_height: previewHeight,
        tiles: [{ source_path: "clip.mp4", preview_path: "clip.jpg", width: null, height: null,
          preview_width: previewWidth, preview_height: previewHeight, is_video: true, is_video_poster: true }],
        overflow_count: 0,
      }),
    }));
  }

  it("takes the poster's shape, not the source size and not a fixed 16:9", () => {
    // The block claims 1920×1080; the poster that is painted is square.
    expect(videoCard(640, 640)).toMatchObject({ variant: "video", primaryAspectRatio: 1 });
    expect(videoCard(512, 640).primaryAspectRatio).toBeCloseTo(0.8);
  });

  it("stays inside the card limits of 1:2 and 2:1", () => {
    expect(videoCard(214, 640).primaryAspectRatio).toBe(0.5);
    expect(videoCard(640, 200).primaryAspectRatio).toBe(2);
  });
});

describe("card presentation in the feed (SPEC_FEED_DISPLAY.md, Д10 to Д14)", () => {
  const picture = () => makeBlock({
    block_type: "image",
    media_file: "Media/Sunset.jpg",
    fallback_label: "Sunset",
    preview_manifest: readyImageManifest({ previewWidth: 640, previewHeight: 480 }),
  });
  const postWithPicture = () => makeBlock({
    block_type: "article",
    title: "A post",
    body: "Some words\n\n![](photo.jpg)",
    media_urls: "[\"photo.jpg\"]",
    author: "@someone",
    preview_manifest: readyImageManifest({ previewWidth: 640, previewHeight: 480 }),
  });
  const socialGallery = () => makeBlock({
    block_type: "article",
    url: "https://instagram.com/p/1",
    body: "hello\n![](a.jpg)\n![](b.jpg)\n![](c.jpg)",
    media_urls: "[\"a.jpg\",\"b.jpg\",\"c.jpg\"]",
    preview_manifest: JSON.stringify({
      kind: "composite", primary_preview_path: "test.jpg", width: 1, height: 1,
      tiles: ["a", "b", "c"].map((name, index) => ({
        source_path: `${name}.jpg`, preview_path: `test.preview-${index + 1}.jpg`,
        width: 1, height: 1, is_video: false, is_video_poster: false,
      })),
      overflow_count: 0,
    }),
  });

  it("Mixed keeps the feed as it was", () => {
    expect(deriveCardLayoutDescriptor(picture(), "mixed")).toEqual(deriveCardLayoutDescriptor(picture()));
    expect(deriveCardLayoutDescriptor(postWithPicture(), "mixed").variant).toBe("article-media");
  });

  it("Cards shows a picture as a post card titled only by its own heading", () => {
    const descriptor = deriveCardLayoutDescriptor(picture(), "cards");
    expect(descriptor.variant).toBe("article-media");
    // A file name is not a title: without a heading of its own the card has
    // none.
    expect(descriptor.titleText).toBe("");
    expect(deriveCardLayoutDescriptor({ ...picture(), content_heading: "Evening light" }, "cards").titleText)
      .toBe("Evening light");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(640 / 480);
    expect(descriptor.mediaItems).toHaveLength(1);
    // A post is framed already and stays as it is.
    expect(deriveCardLayoutDescriptor(postWithPicture(), "cards")).toEqual(deriveCardLayoutDescriptor(postWithPicture()));
  });

  it("Media shows a post's media and nothing else", () => {
    const descriptor = deriveCardLayoutDescriptor(postWithPicture(), "media");
    expect(descriptor.variant).toBe("media-only");
    expect([descriptor.titleText, descriptor.previewText, descriptor.authorText]).toEqual(["", "", ""]);
    expect(descriptor.primaryAspectRatio).toBeCloseTo(640 / 480);
  });

  it("Media keeps several media as the gallery", () => {
    const descriptor = deriveCardLayoutDescriptor(socialGallery(), "media");
    expect(descriptor.variant).toBe("media-only");
    expect(descriptor.totalMediaCount).toBe(3);
  });

  it("Media leaves a card without media a card", () => {
    const text = makeBlock({ block_type: "article", title: "Only words", body: "Just text" });
    expect(deriveCardLayoutDescriptor(text, "media").variant).toBe("article-text");
    const file = makeBlock({ block_type: "file", media_file: "doc.pdf" });
    expect(deriveCardLayoutDescriptor(file, "media").variant).toBe("file");
  });

  it("Cards keeps a picture's text and author (Д12, В5.3)", () => {
    const described = makeBlock({
      block_type: "image",
      media_file: "Media/Sunset.jpg",
      fallback_label: "Sunset",
      author: "@someone",
      preview_text: "Evening over the bay",
      preview_manifest: readyImageManifest({ previewWidth: 640, previewHeight: 480 }),
    });
    const descriptor = deriveCardLayoutDescriptor(described, "cards");
    expect(descriptor.variant).toBe("article-media");
    expect(descriptor.titleText).toBe("");
    expect(descriptor.previewText).toBe("Evening over the bay");
    expect(descriptor.authorText).toBe("@someone");
    // Mixed still shows the picture bare.
    const mixed = deriveCardLayoutDescriptor(described, "mixed");
    expect([mixed.variant, mixed.previewText, mixed.authorText]).toEqual(["image", "", ""]);
  });

  it("Cards keeps a video's text and author (Д12, В5.3)", () => {
    const described = makeBlock({
      block_type: "video",
      media_file: "Media/Clip.mp4",
      fallback_label: "Clip",
      author: "@filmmaker",
      preview_text: "Behind the scenes",
      preview_manifest: JSON.stringify({
        kind: "video_poster", primary_preview_path: "clip.jpg", width: null, height: null,
        preview_width: 640, preview_height: 360,
        tiles: [{ source_path: "Media/Clip.mp4", preview_path: "clip.jpg", width: null, height: null,
          preview_width: 640, preview_height: 360, is_video: true, is_video_poster: true }],
        overflow_count: 0,
      }),
    });
    const descriptor = deriveCardLayoutDescriptor(described, "cards");
    expect(descriptor.variant).toBe("article-media");
    expect([descriptor.titleText, descriptor.previewText, descriptor.authorText])
      .toEqual(["", "Behind the scenes", "@filmmaker"]);
  });

  it("Media clamps a link's page picture into 1:2 to 2:1 (Д13, Д14, В5.2)", () => {
    const tallPage = pageLink({ source: [100, 1000], artifact: [100, 1000] });
    const descriptor = deriveCardLayoutDescriptor(tallPage, "media");
    expect(descriptor.variant).toBe("media-only");
    expect(descriptor.primaryAspectRatio).toBe(0.5);
  });

  it("Media shapes a link's page picture from its artifact, not from its source (В5.7)", () => {
    const link = pageLink({ source: [1200, 630], artifact: [600, 900] });
    const descriptor = deriveCardLayoutDescriptor(link, "media");
    expect(descriptor.variant).toBe("media-only");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(600 / 900);
  });

  it("Media leaves an unmeasured page picture's shape unknown, not the source's (В5.7)", () => {
    const link = pageLink({ source: [1200, 630], artifact: null });
    const descriptor = deriveCardLayoutDescriptor(link, "media");
    expect(descriptor.variant).toBe("media-only");
    expect(descriptor.primaryAspectRatio).toBeNull();
  });

  it.each([
    ["X", "https://x.com/someone/status/1"],
    ["Instagram", "https://instagram.com/p/1"],
  ])("clamps a single %s post picture into 1:2 to 2:1 in every presentation (Г4.5)", (_network, url) => {
    const tallPost = makeBlock({
      block_type: "article",
      url,
      body: "![](tall.jpg)",
      media_urls: "[\"tall.jpg\"]",
      preview_manifest: readyImageManifest({ previewWidth: 100, previewHeight: 1000 }),
    });
    expect(deriveCardLayoutDescriptor(tallPost, "mixed")).toMatchObject({
      variant: "social-single-media", primaryAspectRatio: 0.5,
    });
    expect(deriveCardLayoutDescriptor(tallPost, "cards")).toMatchObject({
      variant: "social-single-media", primaryAspectRatio: 0.5,
    });
    expect(deriveCardLayoutDescriptor(tallPost, "media")).toMatchObject({
      variant: "media-only", primaryAspectRatio: 0.5,
    });
  });

  it("Mixed and Cards keep the link's fixed thumbnail slot whatever its picture's shape (В5.7)", () => {
    const link = pageLink({ source: [1200, 630], artifact: [600, 900] });
    for (const show of ["mixed", "cards"] as const) {
      const descriptor = deriveCardLayoutDescriptor(link, show);
      expect(descriptor.variant).toBe("link");
      expect(descriptor.primaryAspectRatio).toBe(16 / 9);
    }
  });
});

/// A link whose page picture came from a 1200x630 source, say, and whose
/// preview artifact is another shape, or not measured yet.
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
