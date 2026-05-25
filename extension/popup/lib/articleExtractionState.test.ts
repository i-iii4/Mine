import { describe, expect, it } from "vitest";
import {
  articleExtractionStateForResult,
  buildLinkBody,
  contentModeNeedsArticleExtraction,
  emptyContentMessage,
} from "./articleExtractionState";
import type { ArticleData, PageMetadata } from "./messaging";

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
    detectedType: "link",
    isArticle: false,
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

describe("article extraction state", () => {
  it("manual Content on a link-detected page still requires extraction", () => {
    expect(contentModeNeedsArticleExtraction(meta({ detectedType: "link" }))).toBe(true);
  });

  it("non-video selected text does not require article extraction", () => {
    expect(contentModeNeedsArticleExtraction(meta({ selection: "quoted paragraph" }))).toBe(false);
  });

  it("video content ignores selection and still requires transcript extraction", () => {
    expect(contentModeNeedsArticleExtraction(meta({
      detectedType: "video",
      selection: "highlighted page text",
    }))).toBe(true);
  });

  it("classifies only non-empty article text as ready", () => {
    expect(articleExtractionStateForResult(article({ content: "full article" }))).toBe("ready");
    expect(articleExtractionStateForResult(article({ content: "   " }))).toBe("empty");
    expect(articleExtractionStateForResult(article({
      content: "",
      embeddedVideos: [{ src: "https://example.com/v.mp4", poster: null, title: "Preview" }],
    }))).toBe("empty");
  });

  it("builds the Link body H1 required by the clipper storage contract", () => {
    expect(buildLinkBody("  Braun Design  ")).toBe("# Braun Design");
    expect(buildLinkBody("   ")).toBe("");
  });

  it("returns mode-specific empty extraction messages", () => {
    expect(emptyContentMessage(meta(), "empty")).toContain("No article text");
    expect(emptyContentMessage(meta({ detectedType: "video" }), "empty")).toContain("No transcript");
    expect(emptyContentMessage(meta(), "failed")).toContain("failed");
  });
});
