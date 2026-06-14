import { describe, it, expect } from "vitest";
import { microPreviewFromIndexedBlock } from "./MicroPreviewThumbnail";

const THUMBS = "/tmp/thumbs";

describe("microPreviewFromIndexedBlock", () => {
  it("keeps hasThumb true when thumb_format is momentarily null after a fresh clip", () => {
    // thumb_format is null in the window between indexing and async thumb
    // generation, but the thumb file (or its placeholder) exists. The preview
    // must still attempt the image instead of hiding an already-present
    // thumbnail; the consumer's onError covers the rare missing-file case.
    const preview = microPreviewFromIndexedBlock(
      { slug: "fresh-clip", thumb_format: null, thumb_mtime: 0, preview_manifest: null },
      THUMBS,
    );
    expect(preview.hasThumb).toBe(true);
    expect(preview.url).toContain("fresh-clip");
  });

  it("detects a text thumb from preview_manifest, not the volatile thumb_format", () => {
    // preview_manifest is stable across the indexing→thumb-generation window,
    // so it — not the briefly-null thumb_format — drives the dark:invert flag.
    const preview = microPreviewFromIndexedBlock(
      {
        slug: "text-article",
        thumb_format: null,
        thumb_mtime: 0,
        preview_manifest: JSON.stringify({ kind: "text", width: 1, height: 1, tiles: [] }),
      },
      THUMBS,
    );
    expect(preview.text).toBe(true);
  });

  it("falls back to thumb_format for legacy blocks without a manifest", () => {
    const media = microPreviewFromIndexedBlock(
      { slug: "legacy-media", thumb_format: "jpeg", thumb_mtime: 5, preview_manifest: null },
      THUMBS,
    );
    expect(media.text).toBe(false);

    const text = microPreviewFromIndexedBlock(
      { slug: "legacy-text", thumb_format: "png", thumb_mtime: 5, preview_manifest: null },
      THUMBS,
    );
    expect(text.text).toBe(true);
  });
});
