// Contract test for resolveContentBody.
//
// The purpose of this test is not to check that the function "works"
// (the body is tiny) but to FREEZE its contract. resolveContentBody is
// the single source of truth for BOTH save() and the popup preview
// rendering. Any silent change in priority or behavior breaks either
// save or preview, and since they both go through this function, the
// failure mode is now "preview shows X, block contains X" — they must
// never diverge.
//
// The four cases below are a byte-for-byte reference of the save()
// behavior that existed in useClipperState.ts prior to the extraction
// (lines 533-542 of the pre-refactor file). If you change the function,
// re-derive this test from the new intended save() behavior — do not
// loosen it.

import { describe, it, expect } from "vitest";
import { resolveContentBody } from "./resolveContentBody";
import type { PageMetadata, ArticleData } from "./messaging";

function meta(overrides: Partial<PageMetadata> = {}): PageMetadata {
  return {
    url: "https://example.com/",
    title: "Example",
    description: "",
    image: null,
    author: null,
    ogType: null,
    favicon: null,
    selection: "",
    detectedType: "article",
    isArticle: true,
    ...overrides,
  };
}

function article(overrides: Partial<ArticleData> = {}): ArticleData {
  return {
    title: "Example",
    content: "",
    byline: null,
    excerpt: "",
    ...overrides,
  };
}

describe("resolveContentBody — save-equivalence contract", () => {
  it("video: returns articleData.content regardless of selection", () => {
    const result = resolveContentBody(
      meta({ detectedType: "video", selection: "user highlighted this" }),
      article({ content: "youtube transcript paragraph 1\n\nparagraph 2" }),
    );
    expect(result).toEqual({
      text: "youtube transcript paragraph 1\n\nparagraph 2",
      source: "video",
      byline: null,
    });
  });

  it("video with empty article: returns empty string, not selection", () => {
    const result = resolveContentBody(
      meta({ detectedType: "video", selection: "irrelevant highlight" }),
      article({ content: "" }),
    );
    expect(result).toEqual({ text: "", source: "video", byline: null });
  });

  it("non-video with selection: returns selection, article is ignored", () => {
    const result = resolveContentBody(
      meta({ detectedType: "article", selection: "the quoted fragment" }),
      article({ content: "full article body text", byline: "Jane Doe" }),
    );
    expect(result).toEqual({
      text: "the quoted fragment",
      source: "selection",
      byline: null,
    });
  });

  it("non-video without selection: returns article, byline propagated", () => {
    const result = resolveContentBody(
      meta({ detectedType: "article", selection: "" }),
      article({ content: "full article body text", byline: "Jane Doe" }),
    );
    expect(result).toEqual({
      text: "full article body text",
      source: "article",
      byline: "Jane Doe",
    });
  });

  it("non-video without selection and without article: returns empty", () => {
    const result = resolveContentBody(
      meta({ detectedType: "article", selection: "" }),
      article({ content: "" }),
    );
    expect(result).toEqual({ text: "", source: "empty", byline: null });
  });

  it("X media-only status: uses embedded media as article body", () => {
    const result = resolveContentBody(
      meta({
        url: "https://x.com/AwkSilenceGames/status/2061150566542156267",
        detectedType: "article",
        selection: "",
        author: "@AwkSilenceGames",
      }),
      article({
        content: "",
        byline: "@AwkSilenceGames",
        embeddedVideos: [
          { src: "https://video.twimg.com/amplify_video/test.mp4?tag=14", poster: null, title: "Preview" },
        ],
      }),
    );
    expect(result).toEqual({
      text: "![](https://video.twimg.com/amplify_video/test.mp4?tag=14)",
      source: "article",
      byline: "@AwkSilenceGames",
    });
  });

  it("non-X media-only article: stays empty instead of saving generic preview media", () => {
    const result = resolveContentBody(
      meta({ url: "https://example.com/video-card", detectedType: "article", selection: "" }),
      article({
        content: "",
        embeddedVideos: [
          { src: "https://cdn.example.com/video.mp4", poster: null, title: "Preview" },
        ],
      }),
    );
    expect(result).toEqual({ text: "", source: "empty", byline: null });
  });

  it("null metadata: returns empty", () => {
    const result = resolveContentBody(null, article({ content: "x" }));
    expect(result).toEqual({ text: "", source: "empty", byline: null });
  });

  it("article without byline: byline stays null", () => {
    const result = resolveContentBody(
      meta({ detectedType: "article", selection: "" }),
      article({ content: "body", byline: null }),
    );
    expect(result).toEqual({
      text: "body",
      source: "article",
      byline: null,
    });
  });
});
