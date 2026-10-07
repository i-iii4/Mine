import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import { deriveCardContent, deriveCardLayoutDescriptor } from "./cardLayout";
import { CARD_COLLECTION_PILLS_ENABLED } from "./cardCollections";

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

const content = (block: LightBlock) => deriveCardContent(block);

describe("deriveCardContent (SPEC_CARD_UNIFIED.md, Е3)", () => {
  it("reads a link without a page picture as its title alone, no media", () => {
    const link = content(makeBlock({
      block_type: "link",
      card_kind: "link",
      title: "AI 2027",
      url: "https://ai-2027.com/race",
    }));
    expect(link.source).toBe("link");
    expect(link.media).toBeNull();
    expect(link.text.title).toBe("AI 2027");
  });

  it("reads a link's page picture as media in its own shape, not a fixed slot (Е6)", () => {
    const link = content(makeBlock({
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
    }));
    expect(link.source).toBe("link");
    expect(link.media?.paint).toEqual({ kind: "preview" });
    // The source's 1200x630 is never card geometry; an unmeasured artifact
    // stays unknown.
    expect(link.media?.aspectRatio).toBeNull();
  });

  it("takes the image ratio from the artifact it paints", () => {
    const picture = content(makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      // Source is 1600x900; the artifact carries the same shape at 640px.
      preview_manifest: readyImageManifest({
        previewWidth: 640,
        previewHeight: 360,
        sourceWidth: 1600,
        sourceHeight: 900,
      }),
    }));
    expect(picture.source).toBe("image");
    expect(picture.media?.paint).toEqual({ kind: "preview" });
    expect(picture.media?.aspectRatio).toBeCloseTo(640 / 360);
  });

  it("ignores source dimensions that disagree with the artifact", () => {
    const picture = content(makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      width: 4036,
      height: 2578,
      media_dimensions: "{\"photo.jpg\":[2880,980]}",
      preview_manifest: readyImageManifest({ previewWidth: 600, previewHeight: 400 }),
    }));
    expect(picture.media?.aspectRatio).toBeCloseTo(600 / 400);
  });

  it("shows ordinary portrait and landscape shapes whole", () => {
    const shape = (previewWidth: number, previewHeight: number) => content(makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      preview_manifest: readyImageManifest({ previewWidth, previewHeight }),
    })).media?.aspectRatio;
    expect(shape(506, 640)).toBeCloseTo(506 / 640);
    expect(shape(640, 458)).toBeCloseTo(640 / 458);
  });

  it("clamps only genuinely extreme shapes", () => {
    const shape = (previewWidth: number, previewHeight: number) => content(makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      preview_manifest: readyImageManifest({ previewWidth, previewHeight }),
    })).media?.aspectRatio;
    expect(shape(640, 128)).toBeCloseTo(2);
    expect(shape(128, 640)).toBeCloseTo(0.5);
  });

  it("reports unknown artifact geometry as unknown, not as a square", () => {
    const picture = content(makeBlock({
      block_type: "image",
      media_file: "photo.jpg",
      width: 1000,
      height: 1000,
      preview_manifest: readyImageManifest({ previewWidth: null, previewHeight: null }),
    }));
    expect(picture.source).toBe("image");
    expect(picture.media?.aspectRatio).toBeNull();
  });

  it("keeps legacy first-image metadata text-only until a ready manifest arrives", () => {
    const post = content(makeBlock({
      block_type: "article",
      body: "hello",
      first_image: "cover.jpg",
      media_dimensions: "{\"cover.jpg\":[800,600]}",
    }));
    expect(post.source).toBe("article");
    expect(post.media).toBeNull();
  });

  it("uses indexed preview_text instead of raw body for article text", () => {
    const post = content(makeBlock({
      block_type: "article",
      title: "Meeting",
      body: "## Raw heading\n\n- [ ] Raw markdown task that should not render",
      preview_text: "Raw heading Raw markdown task…",
    }));
    expect(post.text.text).toBe("Raw heading Raw markdown task…");
  });

  it.each([
    ["three", "hello\n![](a.jpg)\n![](b.jpg)\n![](c.jpg)", "[\"a.jpg\",\"b.jpg\",\"c.jpg\"]"],
    ["two", "hello\n![](a.webp)\n![](b.webp)", "[\"a.webp\",\"b.webp\"]"],
  ])("never derives media from %s legacy media_urls without a ready manifest", (_count, body, mediaUrls) => {
    const post = content(makeBlock({
      block_type: "article",
      body,
      first_image: "a.jpg",
      media_urls: mediaUrls,
      media_dimensions: "{\"a.jpg\":[800,600]}",
    }));
    expect(post.media).toBeNull();
  });

  it.each([
    [3, 1],
    [2, 2],
  ])("lays an article composite of %i tiles out as the gallery at %s:1", (count, ratio) => {
    const post = content(makeBlock({
      block_type: "article",
      body: "plain text only",
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "test.jpg",
        width: 1,
        height: 1,
        tiles: ["a", "b", "c"].slice(0, count).map((name) => (
          { source_path: `${name}.jpg`, preview_path: `${name}.jpg`, width: 800, height: 600, is_video: false, is_video_poster: false }
        )),
        overflow_count: 0,
      }),
    }));
    expect(post.media?.paint).toEqual({ kind: "gallery" });
    expect(post.media?.visibleCount).toBe(count);
    expect(post.media?.aspectRatio).toBe(ratio);
  });

  it("reads an X post with one picture as that picture's tile, with no title", () => {
    const post = content(makeBlock({
      block_type: "article",
      url: "https://x.com/a/status/1",
      title: "A synthetic legacy title",
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
    }));
    expect(post.source).toBe("social");
    expect(post.text.title).toBe("");
    expect(post.media?.items).toHaveLength(1);
    expect(post.media?.paint).toEqual({ kind: "tile", item: post.media?.items[0] });
    expect(post.media?.aspectRatio).toBeCloseTo(1200 / 800);
  });

  it.each([
    [3, 1],
    [2, 2],
  ])("reads an Instagram post with %i pictures as the gallery at %s:1", (count, ratio) => {
    const post = content(makeBlock({
      block_type: "article",
      url: "https://instagram.com/p/1",
      body: "hello\n![](a.jpg)\n![](b.jpg)\n![](c.jpg)",
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "test.jpg",
        width: 1,
        height: 1,
        tiles: ["a", "b", "c"].slice(0, count).map((name, index) => (
          { source_path: `${name}.jpg`, preview_path: `test.preview-${index + 1}.jpg`, width: 1, height: 1, is_video: false, is_video_poster: false }
        )),
        overflow_count: 0,
      }),
    }));
    expect(post.media?.paint).toEqual({ kind: "gallery" });
    expect(post.media?.visibleCount).toBe(count);
    expect(post.media?.aspectRatio).toBe(ratio);
  });

  it("reads an X post without words as its media and its author", () => {
    const post = content(makeBlock({
      block_type: "article",
      url: "https://x.com/a/status/1",
      author: "@artist",
      body: "![](a.jpg)\n![](b.jpg)",
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "test.jpg",
        width: 1,
        height: 1,
        tiles: ["a", "b"].map((name, index) => (
          { source_path: `${name}.jpg`, preview_path: `test.preview-${index + 1}.jpg`, width: 1, height: 1, is_video: false, is_video_poster: false }
        )),
        overflow_count: 0,
      }),
    }));
    expect(post.text).toEqual({ title: "", text: "", author: "@artist" });
    expect(post.media?.paint).toEqual({ kind: "gallery" });
  });

  it.each([
    ["an X post", "https://x.com/a/status/1"],
    ["a post", null],
  ])("reads the one video of %s as a video", (_card, url) => {
    const post = content(makeBlock({
      block_type: "article",
      url,
      body: "text only",
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "clip.jpg",
        width: 1280,
        height: 720,
        preview_width: 640,
        preview_height: 360,
        tiles: [
          { source_path: "clip.mp4", preview_path: "clip.jpg", width: 1280, height: 720, preview_width: 640, preview_height: 360, is_video: true, is_video_poster: true },
        ],
        overflow_count: 0,
      }),
    }));
    expect(post.media?.paint).toEqual({ kind: "video" });
    expect(post.media?.items[0]?.isVideo).toBe(true);
    expect(post.media?.aspectRatio).toBeCloseTo(1280 / 720);
  });

  it("keeps poster-only video manifests non-playable", () => {
    const video = content(makeBlock({
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
    }));
    expect(video.source).toBe("video");
    expect(video.media?.paint).toEqual({ kind: "video" });
    expect(video.media?.items[0]?.isVideo).toBe(false);
    expect(video.media?.items[0]?.isVideoPoster).toBe(true);
  });

  it("uses card_kind article even when legacy block_type says image", () => {
    const post = content(makeBlock({
      card_kind: "article",
      block_type: "image",
      body: "![[photo.jpg]]",
      media_file: "photo.jpg",
    }));
    expect(post.source).toBe("article");
    expect(post.text.text).toBe("");
  });

  it("uses media metadata instead of legacy block_type for media cards", () => {
    const picture = content(makeBlock({
      card_kind: "media",
      block_type: "article",
      media_file: "photo.jpg",
      width: 1200,
      height: 800,
      preview_manifest: readyImageManifest({ previewWidth: 600, previewHeight: 400 }),
    }));
    expect(picture.source).toBe("image");
    expect(picture.media?.aspectRatio).toBeCloseTo(600 / 400);
  });

  it("reads url-only media with a page picture as a link", () => {
    const link = content(makeBlock({
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
    }));
    expect(link.source).toBe("link");
    expect(link.media?.paint).toEqual({ kind: "preview" });
  });

  it("uses channel card_kind instead of legacy media block_type", () => {
    const collection = content(makeBlock({
      card_kind: "channel",
      block_type: "video",
      title: "References",
      body: "Collection page",
    }));
    expect(collection.source).toBe("channel");
    expect(collection.media).toBeNull();
    expect(collection.text.title).toBe("References");
  });

  it("titles a picture, a video or a file only by a heading of its own (SPEC_DISPLAY_TITLE.md)", () => {
    const picture = makeBlock({
      block_type: "image",
      media_file: "Media/Sunset.jpg",
      fallback_label: "Sunset",
      title: "A page the clipper once wrote",
      preview_manifest: readyImageManifest({ previewWidth: 640, previewHeight: 480 }),
    });
    expect(content(picture).text.title).toBe("");
    expect(content({ ...picture, content_heading: "Evening light" }).text.title).toBe("Evening light");
    expect(content(makeBlock({ block_type: "file", media_file: "doc.pdf", fallback_label: "doc" })).text.title).toBe("");
  });

  it("never repeats the title as the text when the index gave none: the body loses its first heading, as in the index", () => {
    const picture = content(makeBlock({
      block_type: "image",
      media_file: "Media/Sunset.jpg",
      content_heading: "Sunset",
      body: "# Sunset",
      preview_text: "",
    }));
    expect(picture.text).toEqual({ title: "Sunset", text: "", author: "" });
    const post = content(makeBlock({
      block_type: "article",
      title: null,
      content_heading: "A piece",
      body: "# A piece\n\nThe words after it.\n\n```\n# not a heading\n```",
    }));
    expect(post.text.title).toBe("A piece");
    expect(post.text.text).toContain("The words after it.");
    expect(post.text.text).not.toMatch(/^A piece/);
  });

  it("keeps a picture's and a video's own text and author (В5.3)", () => {
    const picture = content(makeBlock({
      block_type: "image",
      media_file: "Media/Sunset.jpg",
      author: "@someone",
      preview_text: "Evening over the bay",
      preview_manifest: readyImageManifest({ previewWidth: 640, previewHeight: 480 }),
    }));
    expect(picture.text).toEqual({ title: "", text: "Evening over the bay", author: "@someone" });
  });
});

// Card shape follows the artifact the card paints, never the source file.
// A preview is downscaled and may be clamped, so the two shapes differ, and
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

  /// Same manifest with the artifact never measured: the state every preview
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

  const article = (manifest: string) => makeBlock({
    card_kind: "article",
    block_type: "article",
    title: "Piece",
    url: "https://example.com/piece",
    preview_manifest: manifest,
  });
  const social = (manifest: string) => makeBlock({
    card_kind: "article",
    block_type: "article",
    title: null,
    url: "https://x.com/someone/status/123",
    body: "A post",
    preview_manifest: manifest,
  });

  it("shapes an article's one picture and a social post's from the artifact", () => {
    expect(content(article(disagreeingManifest())).media?.aspectRatio).toBeCloseTo(0.5);
    expect(content(article(disagreeingManifest())).media?.items[0]?.aspectRatio).toBeCloseTo(0.5);
    expect(content(social(disagreeingManifest())).media?.aspectRatio).toBeCloseTo(0.5);
  });

  it("leaves an unmeasured shape unknown rather than calling it square or the source's", () => {
    // Not 1: a square is a plausible-looking proportion, which is exactly what
    // makes substituting it a lie rather than a placeholder.
    expect(content(social(unmeasuredManifest())).media?.aspectRatio).toBeNull();
    expect(content(social(unmeasuredManifest())).media?.items[0]?.aspectRatio).toBeNull();
    expect(content(article(unmeasuredManifest())).media?.aspectRatio).toBeNull();
  });
});

describe("video shape (30.09.2026)", () => {
  function videoShape(previewWidth: number, previewHeight: number) {
    return content(makeBlock({
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
    })).media?.aspectRatio;
  }

  it("takes the poster's shape, not the source size and not a fixed 16:9", () => {
    // The block claims 1920×1080; the poster that is painted is square.
    expect(videoShape(640, 640)).toBe(1);
    expect(videoShape(512, 640)).toBeCloseTo(0.8);
  });

  it("stays inside the card limits of 1:2 and 2:1", () => {
    expect(videoShape(214, 640)).toBe(0.5);
    expect(videoShape(640, 200)).toBe(2);
  });
});

describe("one card in both presentations (SPEC_CARD_UNIFIED.md, Е2, Е8, Е11)", () => {
  const picture = (overrides: Partial<LightBlock> = {}) => makeBlock({
    block_type: "image",
    media_file: "Media/Sunset.jpg",
    fallback_label: "Sunset",
    preview_manifest: readyImageManifest({ previewWidth: 640, previewHeight: 480 }),
    ...overrides,
  });
  const postWithPicture = () => makeBlock({
    block_type: "article",
    title: "A post",
    body: "Some words\n\n![](photo.jpg)",
    media_urls: "[\"photo.jpg\"]",
    author: "@someone",
    preview_manifest: readyImageManifest({ previewWidth: 640, previewHeight: 480 }),
  });

  it("defaults to Cards", () => {
    expect(deriveCardLayoutDescriptor(postWithPicture())).toEqual(deriveCardLayoutDescriptor(postWithPicture(), "cards"));
  });

  it("Cards shows every card's content in its text part, a picture's as a post's", () => {
    const post = deriveCardLayoutDescriptor(postWithPicture(), "cards");
    expect(post).toMatchObject({ mode: "content", textShown: "always", textUnderMedia: true });
    const described = deriveCardLayoutDescriptor(picture({ preview_text: "Evening over the bay" }), "cards");
    expect(described).toMatchObject({ mode: "content", textShown: "always", textUnderMedia: true });
    expect(described.text.text).toBe("Evening over the bay");
  });

  it("Media shows a card's media alone and keeps its text for the lift", () => {
    const post = deriveCardLayoutDescriptor(postWithPicture(), "media");
    expect(post.media?.aspectRatio).toBeCloseTo(640 / 480);
    expect(post).toMatchObject({ textShown: "on-lift", textUnderMedia: false });
    expect(post.text.title).toBe("A post");
  });

  it("Media leaves a card without media as Cards shows it", () => {
    const words = makeBlock({ block_type: "article", title: "Only words", body: "Just text" });
    expect(deriveCardLayoutDescriptor(words, "media")).toEqual(deriveCardLayoutDescriptor(words, "cards"));
  });

  it("shows a link's page picture in its own clamped shape in both presentations (Е6, В5.7)", () => {
    for (const show of ["cards", "media"] as const) {
      expect(deriveCardLayoutDescriptor(pageLink({ source: [1200, 630], artifact: [600, 900] }), show).media?.aspectRatio)
        .toBeCloseTo(600 / 900);
      expect(deriveCardLayoutDescriptor(pageLink({ source: [100, 1000], artifact: [100, 1000] }), show).media?.aspectRatio)
        .toBe(0.5);
      expect(deriveCardLayoutDescriptor(pageLink({ source: [1200, 630], artifact: null }), show).media?.aspectRatio)
        .toBeNull();
    }
  });

  it.each([
    ["X", "https://x.com/someone/status/1"],
    ["Instagram", "https://instagram.com/p/1"],
  ])("clamps a single %s post picture into 1:2 to 2:1 in both presentations (Г4.5)", (_network, url) => {
    const tallPost = makeBlock({
      block_type: "article",
      url,
      body: "![](tall.jpg)",
      media_urls: "[\"tall.jpg\"]",
      preview_manifest: readyImageManifest({ previewWidth: 100, previewHeight: 1000 }),
    });
    for (const show of ["cards", "media"] as const) {
      expect(deriveCardLayoutDescriptor(tallPost, show).media?.aspectRatio).toBe(0.5);
    }
  });

  it.each([
    ["a link with no picture, title or description", () => makeBlock({ block_type: "link", url: "https://example.com/bare" })],
    ["a file with no preview", () => makeBlock({ block_type: "file", media_file: "archive.zip", fallback_label: "archive" })],
    ["a note with an empty body", () => makeBlock({ block_type: "article", card_kind: "article", body: "" })],
  ])("is a card without content for %s: nothing stands in for it (Е8)", (_card, make) => {
    for (const show of ["cards", "media"] as const) {
      const descriptor = deriveCardLayoutDescriptor(make(), show);
      expect(descriptor.mode).toBe("empty");
      expect(descriptor.media).toBeNull();
      expect(descriptor.text).toEqual({ title: "", text: "", author: "" });
    }
  });
});

describe("the media's outline over a text part (SPEC_FEED_DISPLAY.md, Д20)", () => {
  const imageManifest = readyImageManifest({ previewWidth: 640, previewHeight: 480 });
  const galleryManifest = JSON.stringify({
    kind: "composite", primary_preview_path: "test.jpg", width: 1, height: 1,
    preview_width: 640, preview_height: 640,
    tiles: ["a", "b"].map((name, index) => ({
      source_path: `${name}.jpg`, preview_path: `test.preview-${index + 1}.jpg`,
      width: 1, height: 1, preview_width: 640, preview_height: 480,
      is_video: false, is_video_poster: false,
    })),
    overflow_count: 0,
  });
  const videoManifest = JSON.stringify({
    kind: "video_poster", primary_preview_path: "clip.jpg", width: null, height: null,
    preview_width: 640, preview_height: 360,
    tiles: [{ source_path: "Media/Clip.mp4", preview_path: "clip.jpg", width: null, height: null,
      preview_width: 640, preview_height: 360, is_video: true, is_video_poster: true }],
    overflow_count: 0,
  });
  const article = (overrides: Partial<LightBlock> = {}) => makeBlock({
    block_type: "article", title: "A post", body: "Some words\n\n![](photo.jpg)",
    media_urls: "[\"photo.jpg\"]", preview_text: "Some words", author: "Ann",
    preview_manifest: imageManifest, ...overrides,
  });
  const xPost = (manifest: string, overrides: Partial<LightBlock> = {}) => makeBlock({
    block_type: "article", url: "https://x.com/someone/status/1", body: "Hello\n\n![](a.jpg)",
    media_urls: "[\"a.jpg\"]", preview_text: "Hello", author: "@someone",
    preview_manifest: manifest, ...overrides,
  });
  const picture = (overrides: Partial<LightBlock> = {}) => makeBlock({
    block_type: "image", media_file: "Media/Sunset.jpg", fallback_label: "Sunset",
    preview_manifest: imageManifest, ...overrides,
  });
  const video = (overrides: Partial<LightBlock> = {}) => makeBlock({
    block_type: "video", media_file: "Media/Clip.mp4", fallback_label: "Clip",
    preview_manifest: videoManifest, ...overrides,
  });
  const lineUnder = (block: LightBlock, show: "cards" | "media") =>
    deriveCardLayoutDescriptor(block, show).textUnderMedia;

  it.each([
    ["a post with media and text", () => article()],
    ["a post with media and an author only", () => article({ title: null, preview_text: null, body: "![](photo.jpg)" })],
    ["an X post with one picture", () => xPost(imageManifest)],
    ["an X post with a gallery and its author only", () => xPost(galleryManifest, { preview_text: null, body: "![](a.jpg)\n![](b.jpg)" })],
    ["a link with its page picture", () => pageLink({ source: [1200, 630], artifact: [1200, 630] })],
    ["a picture with its own heading", () => picture({ content_heading: "Evening light" })],
    ["a picture with text", () => picture({ preview_text: "Over the bay" })],
    ["a video with an author", () => video({ author: "@filmmaker" })],
  ] as const)("runs under the media of %s in Cards, and not in Media", (_card, make) => {
    expect(lineUnder(make(), "cards")).toBe(true);
    expect(lineUnder(make(), "media")).toBe(false);
  });

  it.each([
    ["a post whose media ends the card", () => article({ title: null, preview_text: null, author: null, body: "![](photo.jpg)" })],
    ["an X post whose gallery ends the card", () => xPost(galleryManifest, { preview_text: null, author: null, body: "![](a.jpg)\n![](b.jpg)" })],
    ["a picture without words", () => picture()],
    ["a video without words", () => video()],
    ["a link whose page picture is all it has", () => ({ ...pageLink({ source: [1200, 630], artifact: [1200, 630] }), title: null })],
  ] as const)("is absent from %s in both presentations", (_card, make) => {
    for (const show of ["cards", "media"] as const) {
      expect(lineUnder(make(), show)).toBe(false);
    }
  });

  it("is absent from cards without media", () => {
    const cards = [
      makeBlock({ block_type: "article", title: "Only words", body: "Just text", preview_text: "Just text", author: "Ann" }),
      makeBlock({ block_type: "article", url: "https://x.com/someone/status/2", body: "Hello", preview_text: "Hello", author: "@someone" }),
      makeBlock({ block_type: "link", title: "Bare page", url: "https://example.com/bare" }),
      makeBlock({ block_type: "file", media_file: "doc.pdf" }),
      makeBlock({ block_type: "channel", title: "A collection", body: "About it" }),
    ];
    for (const card of cards) {
      for (const show of ["cards", "media"] as const) {
        expect(lineUnder(card, show)).toBe(false);
      }
    }
  });

  it("counts the row of collections as text under the media exactly while the pills show (С9)", () => {
    const mediaOnly = article({ title: null, preview_text: null, author: null, body: "![](photo.jpg)" });
    expect(lineUnder({ ...mediaOnly, collections: ["Reading"] }, "cards")).toBe(CARD_COLLECTION_PILLS_ENABLED);
    // A block read without its collections (Detail) has none to show.
    expect(lineUnder(mediaOnly, "cards")).toBe(false);
  });
});
