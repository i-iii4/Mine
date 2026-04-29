import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import { deriveCardLayoutDescriptor, deriveContentCardSlots } from "./cardLayout";

function makeBlock(
  overrides: Partial<LightBlock> & { block_type: LightBlock["block_type"] },
): LightBlock {
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
    media_dimensions: null,
    preview_manifest: null,
    ...overrides,
  };
}

describe("deriveCardLayoutDescriptor", () => {
  it("classifies image blocks with exact ratio", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({ block_type: "image", width: 1600, height: 900 }),
    );
    expect(descriptor.variant).toBe("image");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(1600 / 900);
  });

  it("prefers media_dimensions over stale image frontmatter dimensions", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "image",
        media_file: "wide-screenshot.jpg",
        width: 4036,
        height: 2578,
        media_dimensions: "{\"wide-screenshot.jpg\":[2880,980]}",
      }),
    );
    expect(descriptor.variant).toBe("image");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(2880 / 980);
  });

  it("classifies article with first image as article-media", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "hello",
        first_image: "cover.jpg",
        media_dimensions: "{\"cover.jpg\":[800,600]}",
      }),
    );
    expect(descriptor.variant).toBe("article-media");
    expect(descriptor.primaryAspectRatio).toBeCloseTo(800 / 600);
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

  it("reserves square geometry for article composite previews with 3+ items", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "hello\n![](a.jpg)\n![](b.jpg)\n![](c.jpg)",
        first_image: "a.jpg",
        media_urls: "[\"a.jpg\",\"b.jpg\",\"c.jpg\"]",
        media_dimensions: "{\"a.jpg\":[800,600],\"b.jpg\":[600,800],\"c.jpg\":[900,900]}",
      }),
    );
    expect(descriptor.variant).toBe("article-media");
    expect(descriptor.visibleMediaCount).toBe(3);
    expect(descriptor.primaryAspectRatio).toBe(1);
  });

  it("uses a 2:1 wrapper for article galleries with exactly two items", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "hello\n![](a.jpg)\n![](b.jpg)",
        first_image: "a.jpg",
        media_urls: "[\"a.jpg\",\"b.jpg\"]",
        media_dimensions: "{\"a.jpg\":[800,600],\"b.jpg\":[600,800]}",
      }),
    );
    expect(descriptor.variant).toBe("article-media");
    expect(descriptor.visibleMediaCount).toBe(2);
    expect(descriptor.primaryAspectRatio).toBe(2);
  });

  it("builds legacy article gallery items from media_urls when preview_manifest is missing", () => {
    const descriptor = deriveCardLayoutDescriptor(
      makeBlock({
        block_type: "article",
        body: "hello\n![](a.webp)\n![](b.webp)",
        first_image: "a.webp",
        media_urls: "[\"a.webp\",\"b.webp\"]",
        media_dimensions: "{\"a.webp\":[1960,1307],\"b.webp\":[1960,1307]}",
      }),
    );
    expect(descriptor.variant).toBe("article-media");
    expect(descriptor.mediaItems).toHaveLength(2);
    expect(descriptor.mediaItems[0]?.sourcePath).toBe("a.webp");
    expect(descriptor.mediaItems[1]?.sourcePath).toBe("b.webp");
    expect(descriptor.visibleMediaCount).toBe(2);
    expect(descriptor.totalMediaCount).toBe(2);
    expect(descriptor.primaryAspectRatio).toBe(2);
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
});
