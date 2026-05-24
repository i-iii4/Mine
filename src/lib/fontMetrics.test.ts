import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import { FONT_METRICS_PREVIEW_MAX_CHARS } from "@/types/fontMetrics";
import {
  createFontMetricsCacheIdentity,
  getFontHash,
} from "./fontMetrics";

function makeBlock(overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id: 1,
    slug: "test-block",
    card_kind: "article",
    block_type: "article",
    title: "Original title",
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "Original body text",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    ...overrides,
  };
}

describe("createFontMetricsCacheIdentity", () => {
  it("is stable for the same measured text and font version", () => {
    const a = createFontMetricsCacheIdentity(makeBlock());
    const b = createFontMetricsCacheIdentity(makeBlock());

    expect(a).toEqual(b);
    expect(a.fontHash).toBe(getFontHash());
  });

  it("changes when the same block id receives different layout text", () => {
    const before = createFontMetricsCacheIdentity(makeBlock({ id: 42, title: "Alpha" }));
    const after = createFontMetricsCacheIdentity(makeBlock({ id: 42, title: "Beta" }));

    expect(after.blockId).toBe(before.blockId);
    expect(after.cacheKey).not.toBe(before.cacheKey);
    expect(after.textHash).not.toBe(before.textHash);
  });

  it("uses prepared preview text when present", () => {
    const fromBody = createFontMetricsCacheIdentity(makeBlock({
      body: "Long markdown body",
      preview_text: "Indexer preview",
    }));
    const samePreviewDifferentBody = createFontMetricsCacheIdentity(makeBlock({
      body: "Changed markdown body",
      preview_text: "Indexer preview",
    }));

    expect(samePreviewDifferentBody.cacheKey).toBe(fromBody.cacheKey);
    expect(fromBody.preview).toBe("Indexer preview");
  });

  it("hashes only the preview prefix measured by the worker", () => {
    const prefix = "a".repeat(FONT_METRICS_PREVIEW_MAX_CHARS);
    const first = createFontMetricsCacheIdentity(makeBlock({
      preview_text: `${prefix} first suffix`,
    }));
    const second = createFontMetricsCacheIdentity(makeBlock({
      preview_text: `${prefix} second suffix`,
    }));

    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.preview).toHaveLength(FONT_METRICS_PREVIEW_MAX_CHARS);
  });

  it("does not invalidate metrics for fields that do not affect measured text", () => {
    const first = createFontMetricsCacheIdentity(makeBlock({
      width: 100,
      height: 200,
    }));
    const second = createFontMetricsCacheIdentity(makeBlock({
      width: 300,
      height: 400,
    }));

    expect(second.cacheKey).toBe(first.cacheKey);
  });
});
