import { describe, expect, it } from "vitest";
import type { LightBlock, SearchMatch } from "@/types";
import { deriveSearchResultRow } from "./searchResultRow";

function makeBlock(overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id: 1,
    slug: "test-block",
    card_kind: "article",
    block_type: "article",
    title: "Card title",
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "Body text",
    preview_text: "Normal preview text",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<SearchMatch> = {}): SearchMatch {
  return {
    field: "body",
    kind: "exact",
    excerpt: "…around the first match…",
    ranges: [{ start: 12, end: 17 }],
    score: 100,
    ...overrides,
  };
}

describe("deriveSearchResultRow", () => {
  it("title match highlights the title and keeps the plain preview snippet", () => {
    const block = makeBlock({
      search_match: makeMatch({ field: "title", excerpt: "Card title", ranges: [{ start: 0, end: 4 }] }),
    });
    const row = deriveSearchResultRow(block);
    expect(row.title).toBe("Card title");
    expect(row.titleMatch?.field).toBe("title");
    expect(row.snippet).toBe("Normal preview text");
    expect(row.snippetMatch).toBeNull();
  });

  it("body match renders the backend excerpt with mark ranges", () => {
    const match = makeMatch({ field: "body" });
    const row = deriveSearchResultRow(makeBlock({ search_match: match }));
    expect(row.titleMatch).toBeNull();
    expect(row.snippet).toBe(match.excerpt);
    expect(row.snippetMatch).toBe(match);
  });

  it("description match renders the backend excerpt with mark ranges", () => {
    const match = makeMatch({ field: "description" });
    const row = deriveSearchResultRow(makeBlock({ search_match: match }));
    expect(row.snippet).toBe(match.excerpt);
    expect(row.snippetMatch).toBe(match);
  });

  it("semantic match renders the excerpt without highlight ranges", () => {
    const match = makeMatch({ field: "semantic", kind: "semantic", ranges: [] });
    const row = deriveSearchResultRow(makeBlock({ search_match: match }));
    expect(row.snippet).toBe(match.excerpt);
    expect(row.snippetMatch?.ranges).toEqual([]);
  });

  it("author match keeps the normal preview and never leaks matched metadata", () => {
    const match = makeMatch({ field: "author", excerpt: "@matched-author", ranges: [] });
    const row = deriveSearchResultRow(makeBlock({ search_match: match }));
    expect(row.snippet).toBe("Normal preview text");
    expect(row.snippet).not.toContain("@matched-author");
    expect(row.snippetMatch).toBeNull();
  });

  it("url match keeps the normal preview without highlight", () => {
    const match = makeMatch({ field: "url", excerpt: "https://example.com/x", ranges: [] });
    const row = deriveSearchResultRow(makeBlock({ search_match: match }));
    expect(row.snippet).toBe("Normal preview text");
    expect(row.snippetMatch).toBeNull();
  });

  it("media block without any text yields a single-line row without snippet", () => {
    const block = makeBlock({
      card_kind: "media",
      block_type: "image",
      title: null,
      body: "",
      preview_text: null,
      media_file: "photo.jpg",
      search_match: makeMatch({ field: "title", excerpt: "photo", ranges: [] }),
    });
    const row = deriveSearchResultRow(block);
    expect(row.title.length).toBeGreaterThan(0);
    expect(row.snippet).toBeNull();
  });

  it("falls back to the fallback label when there is no display title", () => {
    const block = makeBlock({ title: null, body: "", preview_text: null, media_file: "archive.zip" });
    const row = deriveSearchResultRow(block);
    expect(row.title.length).toBeGreaterThan(0);
  });

  it("block without search_match renders plain title and preview", () => {
    const row = deriveSearchResultRow(makeBlock());
    expect(row.titleMatch).toBeNull();
    expect(row.snippet).toBe("Normal preview text");
    expect(row.snippetMatch).toBeNull();
  });
});
