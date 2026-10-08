import { describe, expect, it } from "vitest";
import { resolveCaptureAuthor, resolveCaptureResult, youtubeCaptureSourceUrl } from "./captureResult";
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

// SPEC_CARD_ASSOCIATIONS.md, «Клиппер: канал YouTube».
describe("author written by Save", () => {
  const kinds = ["content", "link", "screenshot", "image", "video"] as const;
  const video: PageMetadata = {
    ...metadata, url: "https://www.youtube.com/watch?v=9KDDhAOyv9k", title: "Video", author: "Page meta author",
    detectedType: "video", isArticle: false, imageToSave: "https://i.ytimg.com/vi/9KDDhAOyv9k/maxresdefault.jpg",
  };
  // Defuddle's byline may belong to the video shown before an in-page navigation.
  const transcript: ArticleData = { title: "Video", content: "Transcript", byline: "Previous video channel", excerpt: "" };

  it.each(kinds)("takes the channel of a YouTube capture saved as %s", (kind) => {
    expect(resolveCaptureAuthor(kind, video, transcript, "@kotecinho")).toBe("@kotecinho");
  });

  it.each(kinds)("leaves a YouTube capture saved as %s without an author while the channel is unknown", (kind) => {
    expect(resolveCaptureAuthor(kind, video, transcript, null)).toBeNull();
  });

  it("keeps the channel over the byline of a selection or article read from a YouTube page", () => {
    const selected = { ...video, detectedType: "selection", selection: "A quote" };
    expect(resolveCaptureAuthor("content", selected, transcript, "@kotecinho")).toBe("@kotecinho");
    const page = { ...video, detectedType: "article" };
    expect(resolveCaptureAuthor("content", page, transcript, "@kotecinho")).toBe("@kotecinho");
  });

  it.each(["https://youtu.be/9KDDhAOyv9k", "https://m.youtube.com/shorts/9KDDhAOyv9k"])(
    "recognises the YouTube address %s",
    (url) => {
      expect(youtubeCaptureSourceUrl({ ...video, url })).toBe("https://www.youtube.com/watch?v=9KDDhAOyv9k");
      expect(resolveCaptureAuthor("link", { ...video, url }, null, "@kotecinho")).toBe("@kotecinho");
    },
  );

  it.each(kinds)("ignores a channel answer for a %s capture of another address", (kind) => {
    const page = { ...metadata, author: "Page author" };
    expect(youtubeCaptureSourceUrl(page)).toBeNull();
    expect(resolveCaptureAuthor(kind, page, null, "@kotecinho")).toBe("Page author");
  });

  it("keeps the article byline for an extracted article", () => {
    expect(resolveCaptureAuthor("content", { ...metadata, author: "Page author" }, article, null)).toBe("author");
  });

  it("keeps the page author when the content is a selection, not the article", () => {
    const selected = { ...metadata, author: "Page author", selection: "Chosen text" };
    expect(resolveCaptureAuthor("content", selected, article, null)).toBe("Page author");
  });

  it("keeps the page author when the article has no byline", () => {
    expect(resolveCaptureAuthor("content", { ...metadata, author: "Page author" }, { ...article, byline: null }, null)).toBe("Page author");
  });

  it.each(["link", "screenshot", "image", "video"] as const)("keeps the page author, not the byline, for %s", (kind) => {
    expect(resolveCaptureAuthor(kind, { ...metadata, author: "Page author" }, article, null)).toBe("Page author");
  });

  it("has no author without one on the page", () => {
    expect(resolveCaptureAuthor("link", { ...metadata, author: "" }, null, null)).toBeNull();
    expect(resolveCaptureAuthor("link", null, null, null)).toBeNull();
  });
});
