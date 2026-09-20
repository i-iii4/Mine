import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { ArticleData, PageMetadata } from "../popup/lib/messaging";

const script = readFileSync("extension/content.js", "utf8");
function page(url: string, head = "") {
  const dom = new JSDOM(`<html><head>${head}</head><body><p>Post content</p></body></html>`, { url });
  const fetch = vi.fn();
  runInNewContext(script, {
    window: dom.window, document: dom.window.document, URL,
    chrome: { runtime: { onMessage: { addListener: vi.fn() } } },
    fetch, console, setTimeout, clearTimeout, Node: dom.window.Node,
  });
  const api = (dom.window as unknown as { __mineClipper: {
    extractMetadata(): PageMetadata;
    extractArticleAsync(): Promise<ArticleData>;
  } }).__mineClipper;
  return { dom, api, fetch };
}

describe("actual content-script capture source", () => {
  it("keeps a Bluesky post despite root canonical and OG metadata", async () => {
    const url = "https://bsky.app/profile/did:plc:author/post/123";
    const { api, fetch } = page(url, '<link rel="canonical" href="https://bsky.app"><meta property="og:url" content="https://bsky.app">');
    fetch.mockResolvedValue({ ok: true, json: async () => ({ thread: { post: {
      author: { handle: "author.bsky.social" }, record: { text: "Saved post" },
      embed: { images: [{ fullsize: "https://cdn.bsky.app/picture.webp" }] },
    } } }) });
    expect(api.extractMetadata().url).toBe(url);
    const article = await api.extractArticleAsync();
    expect(article.sourceUrl).toBe(url);
    expect(article.content).toContain("Saved post");
    expect(article.content).toContain("https://cdn.bsky.app/picture.webp");
    expect(fetch.mock.calls[0]?.[0]).toContain(encodeURIComponent("at://did:plc:author/app.bsky.feed.post/123"));
  });

  it("keeps the X post source for a second-photo overlay", () => {
    const { api } = page("https://x.com/artist/status/123/photo/2", '<link rel="canonical" href="https://x.com/home">');
    expect(api.extractMetadata().url).toBe("https://x.com/artist/status/123");
  });

  it.each([
    ['<link rel="canonical" href="/article">', "https://example.com/article"],
    ['<link rel="canonical" href="https://example.com/">', "https://example.com/story?ref=feed"],
    ['<link rel="canonical" href="javascript:alert(1)">', "https://example.com/story?ref=feed"],
    ['<link rel="canonical" href=""><meta property="og:url" content="/story">', "https://example.com/story"],
  ])("resolves generic metadata without replacing a page with a root: %s", (head, expected) => {
    expect(page("https://example.com/story?ref=feed", head).api.extractMetadata().url).toBe(expected);
  });

  it("rejects content completed after navigation instead of relabelling it", async () => {
    const { api, dom, fetch } = page("https://bsky.app/profile/did:plc:author/post/123");
    let finish!: (value: unknown) => void;
    fetch.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = api.extractArticleAsync();
    dom.reconfigure({ url: "https://bsky.app/profile/did:plc:author/post/456" });
    finish({ ok: true, json: async () => ({ thread: { post: { author: {}, record: { text: "old" } } } }) });
    await expect(pending).rejects.toThrow("Capture document changed");
  });
});
