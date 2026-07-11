import { describe, expect, it } from "vitest";
import {
  findPreviewTileForSource,
  normalizeDetailPreviewManifest,
  normalizeFeedPreviewManifest,
} from "./feedPreview";

describe("feedPreview", () => {
  it("rejects a tile when the backend did not provide a derived path", () => {
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

    expect(manifest?.tiles).toEqual([]);
  });

  it("does not substitute the primary preview for a missing tile", () => {
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

    expect(manifest?.tiles).toEqual([]);
  });

  it("preserves source-only legacy tiles for the full-fidelity Detail path", () => {
    const manifest = normalizeDetailPreviewManifest(
      JSON.stringify({
        kind: "image",
        primary_preview_path: "note.jpg",
        tiles: [{
          source_path: "Library/images/01.jpg",
          preview_path: null,
          width: 800,
          height: 600,
          is_video: false,
          is_video_poster: false,
        }],
        overflow_count: 0,
      }),
    );

    expect(manifest?.tiles[0]).toMatchObject({
      sourcePath: "Library/images/01.jpg",
      previewPath: null,
    });
  });

  it("treats an explicit derived tile path as backend-authoritative", () => {
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
    expect(tile?.previewPath).toBe("Title (image 1).jpg");
  });

  it("matches a bare Obsidian embed name to one resolved backend tile", () => {
    const manifest = normalizeFeedPreviewManifest(
      JSON.stringify({
        kind: "image",
        primary_preview_path: "Азбука.jpg",
        width: 1,
        height: 1,
        tiles: [
          {
            source_path: "Библиотека/images/images/01.jpg",
            preview_path: "Азбука.preview-1.jpg",
            width: 800,
            height: 600,
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
    );

    const tile = findPreviewTileForSource(manifest, "01.jpg");
    expect(tile?.sourcePath).toBe("Библиотека/images/images/01.jpg");
  });

  it("does not basename-match ambiguous Obsidian embed names", () => {
    const manifest = normalizeFeedPreviewManifest(
      JSON.stringify({
        kind: "composite",
        primary_preview_path: "note.jpg",
        width: 1,
        height: 1,
        tiles: [
          {
            source_path: "A/photo.jpg",
            preview_path: "note.preview-1.jpg",
            is_video: false,
            is_video_poster: false,
          },
          {
            source_path: "B/photo.jpg",
            preview_path: "note.preview-2.jpg",
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
    );

    expect(findPreviewTileForSource(manifest, "photo.jpg")).toBeNull();
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
