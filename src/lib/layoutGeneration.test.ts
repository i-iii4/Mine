import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import {
  buildBlockLayoutSignature,
  buildLayoutGenerationKey,
} from "./layoutGeneration";
import { getMasonryColumnCount, getMasonryColumnWidth } from "./masonryLayout";

function makeBlock(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id,
    slug: `block-${id}`,
    block_type: "article",
    title: `Block ${id}`,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: `Body text for block ${id}`,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    tags: ["test"],
    ...overrides,
  };
}

function generationKey(blocks: LightBlock[], parentWidth = 1200): string {
  return buildLayoutGenerationKey({
    blocks,
    routeKey: "__all__",
    columnWidth: getMasonryColumnWidth(parentWidth, 220, 32),
    columnCount: getMasonryColumnCount(parentWidth, 220, 32),
  });
}

describe("buildBlockLayoutSignature", () => {
  it("changes when preview manifest kind changes", () => {
    const base = makeBlock(1, {
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "block-1.jpg",
        width: 480,
        height: 480,
        tiles: [],
        overflow_count: 0,
      }),
    });
    const changed = makeBlock(1, {
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "block-1.jpg",
        width: 480,
        height: 480,
        tiles: [
          { source_path: "a.jpg", preview_path: "a.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
          { source_path: "b.jpg", preview_path: "b.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
        ],
        overflow_count: 0,
      }),
    });

    expect(buildBlockLayoutSignature(base)).not.toBe(buildBlockLayoutSignature(changed));
  });

  it("changes when title or body changes", () => {
    const base = makeBlock(1);
    expect(buildBlockLayoutSignature(base)).not.toBe(
      buildBlockLayoutSignature(makeBlock(1, { title: "Changed" })),
    );
    expect(buildBlockLayoutSignature(base)).not.toBe(
      buildBlockLayoutSignature(makeBlock(1, { body: "Updated body" })),
    );
  });
});

describe("buildLayoutGenerationKey", () => {
  it("changes when preview manifest tile count changes at same block id", () => {
    const oneTile = makeBlock(1, {
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "block-1.jpg",
        width: 480,
        height: 480,
        tiles: [
          { source_path: "a.jpg", preview_path: "a.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
        ],
        overflow_count: 0,
      }),
    });
    const twoTiles = makeBlock(1, {
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "block-1.jpg",
        width: 480,
        height: 480,
        tiles: [
          { source_path: "a.jpg", preview_path: "a.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
          { source_path: "b.jpg", preview_path: "b.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
        ],
        overflow_count: 0,
      }),
    });

    expect(generationKey([oneTile])).not.toBe(generationKey([twoTiles]));
  });

  it("changes when author changes at same block id", () => {
    expect(generationKey([makeBlock(1, { author: "A" })])).not.toBe(
      generationKey([makeBlock(1, { author: "B" })]),
    );
  });
});
