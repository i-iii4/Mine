import { describe, expect, it } from "vitest";
import {
  findPreviewTileForSource,
  normalizeFeedPreviewManifest,
} from "./feedPreview";

describe("feedPreview", () => {
  it("leaves preview path null when the backend did not provide one", () => {
    // Contract: if preview_path is absent the source file IS the preview.
    // The consumer falls back to asset://vault/<source> rather than
    // attempting a synthetic thumbs/<stem>.jpg URL that often 404s for
    // inline media like `<slug> (image N).jpg`.
    const manifest = normalizeFeedPreviewManifest(
      JSON.stringify({
        kind: "composite",
        primary_preview_path: "article.jpg",
        width: 1,
        height: 1,
        tiles: [
          {
            src: "article-img0.webp",
            width: 800,
            height: 600,
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
    );

    expect(manifest?.tiles[0]?.sourcePath).toBe("article-img0.webp");
    expect(manifest?.tiles[0]?.previewPath).toBeNull();
  });

  it("falls back to primary_preview_path for video poster tiles without their own preview", () => {
    const manifest = normalizeFeedPreviewManifest(
      JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "clip-poster.jpg",
        width: 1,
        height: 1,
        tiles: [
          {
            source_path: "clip.mp4",
            width: 800,
            height: 600,
            is_video: true,
            is_video_poster: true,
          },
        ],
        overflow_count: 0,
      }),
    );

    expect(manifest?.tiles[0]?.previewPath).toBe("clip-poster.jpg");
  });

  it("normalizes legacy synthetic tile preview paths to source fallback", () => {
    const manifest = normalizeFeedPreviewManifest(
      JSON.stringify({
        kind: "image",
        primary_preview_path: "Title.jpg",
        width: 1,
        height: 1,
        tiles: [
          {
            source_path: "Title (image 1).jpg",
            preview_path: "Title (image 1).jpg",
            width: 800,
            height: 600,
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
    );

    const tile = findPreviewTileForSource(manifest, "Title%20%28image%201%29.jpg");
    expect(tile?.sourcePath).toBe("Title (image 1).jpg");
    expect(tile?.previewPath).toBeNull();
  });

  it("keeps explicit cache preview paths when they are not synthetic", () => {
    const manifest = normalizeFeedPreviewManifest(
      JSON.stringify({
        kind: "image",
        primary_preview_path: "Title.jpg",
        width: 1,
        height: 1,
        tiles: [
          {
            source_path: "Title (image 1).webp",
            preview_path: "Title (image 1)-preview.jpg",
            width: 800,
            height: 600,
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
    );

    expect(manifest?.tiles[0]?.previewPath).toBe("Title (image 1)-preview.jpg");
  });
});
