import { describe, expect, it } from "vitest";
import { resolveCaptureResult } from "./captureResult";
import type { ArticleData, PageMetadata } from "./messaging";

const metadata: PageMetadata = {
  url: "https://bsky.app", title: "Post", description: "", image: null,
  author: null, ogType: null, favicon: null, selection: "", detectedType: "article", isArticle: true,
};
const article: ArticleData = {
  sourceUrl: "https://bsky.app/profile/author/post/123", title: "Post",
  content: "Post text", byline: "author", excerpt: "",
};
describe("capture result shared by preview and Save", () => {
  it("uses the extracted post address with its content", () => {
    const capture = resolveCaptureResult("content", metadata, article);
    expect(capture.sourceUrl).toBe(article.sourceUrl);
    expect(capture.body.text).toBe(article.content);
  });
  it("keeps a selected image separate from an unrelated background article", () => {
    const meta = { ...metadata, url: "https://x.com/artist/status/456",
      imageToSave: "https://pbs.twimg.com/media/second.jpg", imageWidth: 1000 };
    const capture = resolveCaptureResult("image", meta, article);
    expect(capture.sourceUrl).toBe(meta.url);
    expect(capture.kind === "image" && capture.imageUrl).toBe(meta.imageToSave);
  });
  it("does not replace a selection source with the article source", () => {
    const capture = resolveCaptureResult("content", { ...metadata, selection: "Chosen text" }, article);
    expect(capture.sourceUrl).toBe(metadata.url);
    expect(capture.body.text).toBe("Chosen text");
  });
  it.each(["link", "screenshot"] as const)("preserves the %s target", (kind) => {
    expect(resolveCaptureResult(kind, metadata, article).sourceUrl).toBe(metadata.url);
  });
  it("supports previously persisted article drafts without a source field", () => {
    expect(resolveCaptureResult("content", metadata, { ...article, sourceUrl: undefined }).sourceUrl).toBe(metadata.url);
  });
});
