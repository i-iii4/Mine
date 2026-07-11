import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import { feedMediaCandidatesForBlock } from "./feedMediaCandidates";

function block(overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id: 1,
    slug: "alpha",
    card_kind: "media",
    block_type: "image",
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
    feed_playback: null,
    search_match: null,
    ...overrides,
  };
}

describe("feedMediaCandidatesForBlock", () => {
  it("returns only manifest-backed poster, primary and tile candidates", () => {
    const candidates = feedMediaCandidatesForBlock({
      thumbsRootPath: "/thumbs",
      block: block({
        width: 640,
        height: 360,
        preview_manifest: JSON.stringify({
          kind: "composite",
          primary_preview_path: "primary.jpg",
          width: 1200,
          height: 800,
          tiles: [
            {
              source_path: "source-a.jpg",
              preview_path: "tile-a.jpg",
              width: 400,
              height: 300,
              is_video: false,
              is_video_poster: false,
            },
            {
              source_path: "source-b.jpg",
              preview_path: "tile-b.jpg",
              width: 500,
              height: 300,
              is_video: false,
              is_video_poster: false,
            },
          ],
          overflow_count: 0,
        }),
        feed_playback: JSON.stringify({
          kind: "single_video",
          source_path: "clip.mp4",
          poster_preview_path: "poster.jpg",
          width: 1920,
          height: 1080,
          container: "mp4",
          profile: "standard",
        }),
      }),
    });

    expect(candidates.map((candidate) => candidate.role)).toEqual([
      "poster-preview",
      "primary-preview",
      "tile-preview",
      "tile-preview",
    ]);
    expect(candidates.map((candidate) => candidate.url)).toEqual([
      "asset://localhost//thumbs/poster.jpg",
      "asset://localhost//thumbs/primary.jpg",
      "asset://localhost//thumbs/tile-a.jpg",
      "asset://localhost//thumbs/tile-b.jpg",
    ]);
  });

  it("keeps the preloader preview-only and excludes source media fallbacks", () => {
    const candidates = feedMediaCandidatesForBlock({
      thumbsRootPath: "/thumbs",
      block: block({
        media_file: "original-heavy.png",
        thumbnail: "https://remote.example/thumbnail.jpg",
        preview_manifest: JSON.stringify({
          kind: "image",
          primary_preview_path: null,
          width: null,
          height: null,
          tiles: [
            {
              source_path: "raw-inline.jpg",
              preview_path: null,
              width: 800,
              height: 600,
              is_video: false,
              is_video_poster: false,
            },
          ],
          overflow_count: 0,
        }),
      }),
    });

    expect(candidates).toHaveLength(0);
    expect(candidates.some((candidate) => candidate.url.includes("original-heavy"))).toBe(false);
    expect(candidates.some((candidate) => candidate.url.includes("raw-inline"))).toBe(false);
    expect(candidates.some((candidate) => candidate.url.includes("remote.example"))).toBe(false);
  });

  it("deduplicates repeated preview URLs", () => {
    const candidates = feedMediaCandidatesForBlock({
      thumbsRootPath: "/thumbs",
      block: block({
        preview_manifest: JSON.stringify({
          kind: "video_poster",
          primary_preview_path: "poster.jpg",
          width: 1280,
          height: 720,
          tiles: [
            {
              source_path: "clip.mp4",
              preview_path: "poster.jpg",
              width: 1280,
              height: 720,
              is_video: true,
              is_video_poster: true,
            },
          ],
          overflow_count: 0,
        }),
        feed_playback: JSON.stringify({
          kind: "single_video",
          source_path: "clip.mp4",
          poster_preview_path: "poster.jpg",
          width: 1280,
          height: 720,
          container: "mp4",
          profile: "standard",
        }),
      }),
    });

    expect(candidates.map((candidate) => candidate.url)).toEqual([
      "asset://localhost//thumbs/poster.jpg",
    ]);
  });
});

describe("feedMediaCandidatesForBlock memoization", () => {
  it("returns the same array instance for repeated calls on the same block", () => {
    const target = block({
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "primary.jpg",
        width: 100,
        height: 100,
        tiles: [],
        overflow_count: 0,
      }),
    });

    const first = feedMediaCandidatesForBlock({ block: target, thumbsRootPath: "/thumbs" });
    const second = feedMediaCandidatesForBlock({ block: target, thumbsRootPath: "/thumbs" });

    expect(second).toBe(first);
  });

  it("recomputes when preview_manifest changes on a reused block object", () => {
    const target = block({ preview_manifest: null });

    const first = feedMediaCandidatesForBlock({ block: target, thumbsRootPath: "/thumbs" });
    expect(first).toEqual([]);

    target.preview_manifest = JSON.stringify({
      kind: "image",
      primary_preview_path: "primary.jpg",
      width: 100,
      height: 100,
      tiles: [],
      overflow_count: 0,
    });
    const second = feedMediaCandidatesForBlock({ block: target, thumbsRootPath: "/thumbs" });

    expect(second).not.toBe(first);
    expect(second.map((candidate) => candidate.role)).toEqual(["primary-preview"]);
  });

  it("recomputes when thumbsRootPath changes for the same block", () => {
    const target = block({
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "alpha.jpg",
        width: 100,
        height: 100,
        tiles: [],
        overflow_count: 0,
      }),
    });

    const first = feedMediaCandidatesForBlock({ block: target, thumbsRootPath: "/thumbs" });
    const second = feedMediaCandidatesForBlock({ block: target, thumbsRootPath: "/other" });

    expect(second).not.toBe(first);
    expect(first[0]?.url).toBe("asset://localhost//thumbs/alpha.jpg");
    expect(second[0]?.url).toBe("asset://localhost//other/alpha.jpg");
  });

  it("does not recompute when only the source slug changes", () => {
    const target = block({
      slug: "alpha",
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "stable-preview.jpg",
        width: 100,
        height: 100,
        tiles: [],
        overflow_count: 0,
      }),
    });

    const first = feedMediaCandidatesForBlock({ block: target, thumbsRootPath: "/thumbs" });
    target.slug = "beta";
    const second = feedMediaCandidatesForBlock({ block: target, thumbsRootPath: "/thumbs" });

    expect(second).toBe(first);
    expect(second[0]?.url).toBe("asset://localhost//thumbs/stable-preview.jpg");
  });
});
