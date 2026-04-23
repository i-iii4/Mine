import { describe, expect, it } from "vitest";
import {
  deriveTilePreviewPath,
  findPreviewTileForSource,
  normalizeFeedPreviewManifest,
} from "./feedPreview";

describe("feedPreview", () => {
  it("derives local tile preview paths from source filenames", () => {
    expect(deriveTilePreviewPath("gallery-item.webp")).toBe("gallery-item.jpg");
    expect(deriveTilePreviewPath("nested/path/photo.png?x=1")).toBe("photo.jpg");
    expect(deriveTilePreviewPath("https://example.com/photo.jpg")).toBeNull();
  });

  it("derives preview paths from encoded local filenames", () => {
    expect(deriveTilePreviewPath("Title%20%28image%201%29.webp")).toBe(
      "Title (image 1).jpg",
    );
  });

  it("normalizes legacy src-only manifests into preview-first tiles", () => {
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
    expect(manifest?.tiles[0]?.previewPath).toBe("article-img0.jpg");
  });

  it("matches preview tiles against encoded local markdown paths", () => {
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

    expect(findPreviewTileForSource(manifest, "Title%20%28image%201%29.jpg")?.previewPath).toBe(
      "Title (image 1).jpg",
    );
  });
});
