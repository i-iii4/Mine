import { describe, expect, it } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { normalizeArticleMedia } from "./normalizeArticleMedia";
import { resolveContentBody } from "./resolveContentBody";
import type { ArticleData, PageMetadata } from "./messaging";
import fixture from "./fixtures/objkt-video.json";

const base = "https://example.com/articles/page";
const article = (content: string): ArticleData => ({ title: "Page", content, byline: null, excerpt: "" });
const normalize = (body: string) => normalizeArticleMedia(article(body), base);

describe("extracted HTML video normalization", () => {
  it("normalizes the saved objkt failure without discarding its text", () => {
    const result = normalizeArticleMedia(fixture.article, fixture.pageUrl);
    expect(result.content).not.toContain("<video");
    expect(result.content).toContain(`![](${fixture.mediaUrl})`);
    expect(result.content).toContain('[bach](https://objkt.com/tokens?tags=bach "bach")');
    expect(result.embeddedVideos).toEqual([{ src: fixture.mediaUrl, poster: null, title: "Video preview" }]);
    expect(normalizeArticleMedia(result, fixture.pageUrl)).toEqual(result);
  });

  it.each([
    '<video src="/movie.mp4"></video>',
    '<VIDEO SRC=/movie.mp4></VIDEO>',
    '<video><source src="/movie.mp4" type="video/mp4"></video>',
    '<video><source src="/stream.m3u8" type="application/x-mpegURL"><source src="/movie.mp4" type="video/mp4"></video>',
    '<video src="/movie.mp4"><source src="/other.webm"></video>',
  ])("selects one source from %s", (body) => {
    const result = normalize(body);
    expect(result.content.trim()).toBe("![](https://example.com/movie.mp4)");
    expect(result.embeddedVideos).toHaveLength(1);
  });

  it("retains captions, media order and existing Markdown byte-for-byte", () => {
    const before = "# Heading\n\n![photo](https://example.com/image.jpg)\n\nBefore ";
    const between = "caption one\n\n**Between**\n\n";
    const after = "\n\n[after](https://example.com)";
    const result = normalize(`${before}<video src="/1.mp4">caption one</video>\n\n**Between**\n\n<video src="/2.mp4"></video>${after}`);
    expect(result.content.startsWith(before)).toBe(true);
    expect(result.content).toContain(between);
    expect(result.content.endsWith(after)).toBe(true);
    expect(result.content.indexOf("/1.mp4")).toBeLessThan(result.content.indexOf("**Between**"));
    expect(result.content.indexOf("**Between**")).toBeLessThan(result.content.indexOf("/2.mp4"));
  });

  it("keeps legitimate repeated occurrences but emits only one preview", () => {
    const result = normalize('<video src="/movie.mp4"></video>\n\nAgain\n\n<video src="/movie.mp4"></video>');
    expect(result.content.match(/!\[\]/g)).toHaveLength(2);
    expect(result.embeddedVideos).toHaveLength(1);
  });

  it("reuses a DOM preview rather than adding a second copy", () => {
    const input = { ...article('<video src="/movie.mp4" poster="/cover.jpg"></video>'), embeddedVideos: [
      { src: "https://example.com/movie.mp4", poster: null, title: "Player" },
    ] };
    const result = normalizeArticleMedia(input, base);
    expect(result.embeddedVideos).toEqual([{ src: "https://example.com/movie.mp4", poster: "https://example.com/cover.jpg", title: "Player" }]);
    expect(input.embeddedVideos[0].poster).toBeNull();
  });

  it("decodes HTML entities and escapes Markdown URL delimiters", () => {
    const result = normalize('<video src="../media/a(b).mp4?x=1&amp;y=2" title="Clip" poster="//example.com/p.jpg"></video>');
    expect(result.content.trim()).toBe("![](https://example.com/media/a%28b%29.mp4?x=1&y=2)");
    expect(result.embeddedVideos?.[0]).toMatchObject({ poster: "https://example.com/p.jpg", title: "Clip" });
  });

  it.each([
    '```html\n<video src="/demo.mp4">\n```',
    '~~~html\n<video src="/demo.mp4"></video>\n~~~',
    '`<video src="/demo.mp4"></video>`',
    '    <video src="/demo.mp4"></video>',
    '<pre><video src="/demo.mp4"></video></pre>',
    '<code><video src="/demo.mp4"></video></code>',
    '<!-- <video src="/demo.mp4"></video> -->',
    '&lt;video src="/demo.mp4"&gt;',
  ])("does not rewrite code or inert content: %s", (body) => {
    expect(normalize(body).content).toBe(body);
    expect(normalize(body).embeddedVideos).toBeUndefined();
  });

  it("an unclosed player inside code cannot swallow the real player", () => {
    const body = '```html\n<video>\n```\n\n<video src="/real.mp4"></video>';
    const result = normalize(body);
    expect(result.content).toContain('```html\n<video>\n```');
    expect(result.content).toContain('![](https://example.com/real.mp4)');
  });

  it.each([
    '<video src="blob:123"></video>',
    '<video src="data:video/mp4;base64,abc"></video>',
    '<video src="javascript:alert(1)"></video>',
    '<video src="file:///private/movie.mp4"></video>',
    '<video src="https://user:secret@example.com/movie.mp4"></video>',
    '<video src="/stream.m3u8"></video>',
    '<video><source src="/stream" type="application/dash+xml"></video>',
    '<video src="blob:123"><source src="/fallback.mp4"></video>',
    '<iframe src="https://youtube.com/embed/123"></iframe>',
    '<video src="/truncated.mp4">',
  ])("does not invent a downloadable file for %s", (body) => {
    expect(normalize(body).content).toBe(body);
    expect(normalize(body).embeddedVideos).toBeUndefined();
  });

  it("removes only truly empty players", () => {
    expect(normalize("before<video> </video>after").content).toBe("beforeafter");
    expect(normalize("<video>Fallback text</video>").content).toBe("<video>Fallback text</video>");
  });

  it("makes an embed inside an HTML wrapper visible to Markdown rendering", () => {
    const result = normalize('<div><video src="/movie.mp4"></video></div>');
    const tree = fromMarkdown(result.content);
    expect(tree.children.some((node) => node.type === "paragraph" && node.children.some((child) => child.type === "image"))).toBe(true);
  });

  it.each(["> ", "- "])("keeps embeds inside their Markdown container %s", (prefix) => {
    const result = normalize(`${prefix}<video src="/movie.mp4"></video>`);
    expect(fromMarkdown(result.content).children).toHaveLength(1);
    expect(fromMarkdown(result.content).children[0].type).toBe(prefix === "> " ? "blockquote" : "list");
  });

  it("normalization does not add page-wide preview media to body", () => {
    const input = { ...article("Text only"), embeddedVideos: [{ src: "https://example.com/ad.mp4", poster: null, title: "Ad" }] };
    expect(normalizeArticleMedia(input, base)).toBe(input);
  });

  it("the common body resolver preserves selection precedence", () => {
    const normalized = normalizeArticleMedia(fixture.article, fixture.pageUrl);
    const metadata: PageMetadata = { url: fixture.pageUrl, title: "Page", description: "", image: null, author: null, ogType: null, favicon: null, selection: "Selected text", detectedType: "article", isArticle: true };
    expect(resolveContentBody(metadata, normalized).text).toBe("Selected text");
    expect(resolveContentBody({ ...metadata, selection: "" }, normalized).text).toBe(normalized.content);
  });
});
