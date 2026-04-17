import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import { deriveCardLayoutDescriptor } from "./cardLayout";

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
});

