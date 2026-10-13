import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { ArticleData, PageMetadata } from "../popup/lib/messaging";

const script = readFileSync("extension/content.js", "utf8");
const youtubeScript = readFileSync("extension/lib/youtubeSource.js", "utf8");
// The manifest puts lib/xThread.js before content.js in the page's world.
const xThreadScript = readFileSync("extension/lib/xThread.js", "utf8");
function page(url: string, head = "", Defuddle?: unknown) {
  const dom = new JSDOM(`<html><head>${head}</head><body><p>Post content</p></body></html>`, { url });
  const fetch = vi.fn();
  const addListener = vi.fn();
  runInNewContext(`${xThreadScript}\n${youtubeScript}\n${script}`, {
    window: dom.window, document: dom.window.document, URL,
    chrome: { runtime: { onMessage: { addListener } } },
    Defuddle,
    fetch, console, setTimeout, clearTimeout, Node: dom.window.Node,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  });
  const api = (dom.window as unknown as { __mineClipper: {
    extractMetadata(): PageMetadata;
    extractArticleAsync(): Promise<ArticleData>;
    extractArticle(): ArticleData;
  } }).__mineClipper;
  return { dom, api, fetch, addListener };
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

  // SPEC_DEEP_AUDIT.md, Е3.13: a screenshot shows the page, not the Mine
  // buttons the content script put on X posts and Instagram posts.
  it("hides the Mine buttons of X and Instagram for a screenshot and shows them again after it", async () => {
    const { dom, addListener } = page("https://x.com/home");
    const document = dom.window.document;
    document.body.insertAdjacentHTML("beforeend",
      '<div data-mine-x-post="post"><button type="button">Mine</button></div><button type="button" data-la-clip="">Mine</button>');
    const receive = addListener.mock.calls[0]![0] as (message: unknown, sender: unknown, reply: (answer: unknown) => void) => unknown;
    const shown = () => [...document.querySelectorAll("[data-mine-x-post], [data-la-clip]")]
      .map((button) => dom.window.getComputedStyle(button).visibility);

    await new Promise((resolve) => receive({ action: "prepareViewportCapture" }, {}, resolve));
    expect(shown()).toEqual(["hidden", "hidden"]);
    receive({ action: "finishViewportCapture" }, {}, () => undefined);
    expect(shown()).toEqual(["visible", "visible"]);
  });

  // SPEC_DEEP_AUDIT.md, Е3.15: X by its host, not by a substring "x.com/".
  it("does not take a page of a host that ends in x.com for a post of X", () => {
    const meta = page("https://www.dropbox.com/team/status/123", "<title>Status</title>").api.extractMetadata();
    expect(meta.author).toBeNull();
    expect(meta.detectedType).not.toBe("article");
  });

  it("reads a post page of X Pro as the post of X it is", () => {
    const meta = page("https://pro.x.com/artist/status/123").api.extractMetadata();
    expect(meta.author).toBe("@artist");
    expect(meta.url).toBe("https://x.com/artist/status/123");
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

  it.each([
    "https://www.youtube.com/watch?v=BBBBBBBBBBB&list=old",
    "https://m.youtube.com/shorts/BBBBBBBBBBB",
    "https://youtu.be/BBBBBBBBBBB?t=20",
  ])("binds the source and poster to the current YouTube video: %s", (url) => {
    const { api } = page(url, '<title>Current video</title><link rel="canonical" href="https://www.youtube.com/watch?v=AAAAAAAAAAA"><meta property="og:url" content="https://www.youtube.com/watch?v=AAAAAAAAAAA"><meta property="og:image" content="https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg"><meta property="og:title" content="Previous video">');
    const meta = api.extractMetadata();
    expect(meta.url).toBe("https://www.youtube.com/watch?v=BBBBBBBBBBB");
    expect(meta.documentUrl).toBe(url);
    expect(meta.title).toBe("Current video");
    expect(meta.image).toBe("https://i.ytimg.com/vi/BBBBBBBBBBB/maxresdefault.jpg");
    expect(meta.detectedType).toBe("video");
    const article = api.extractArticle();
    expect(article.title).toBe("Current video");
    expect(article.sourceUrl).toBe(meta.url);
    expect(article.captureGeneration).toBe(meta.captureGeneration);
    expect(article.embeddedVideos).toEqual([{ src: "https://www.youtube.com/embed/BBBBBBBBBBB", poster: meta.image, title: "Current video" }]);
  });

  it("derives a YouTube poster even without page image metadata", () => {
    expect(page("https://www.youtube.com/watch?v=BBBBBBBBBBB").api.extractMetadata().image)
      .toBe("https://i.ytimg.com/vi/BBBBBBBBBBB/maxresdefault.jpg");
  });

  it.each([
    "https://youtube.com.evil.example/watch?v=BBBBBBBBBBB",
    "https://example.com/?next=https://youtube.com/watch?v=BBBBBBBBBBB",
    "https://www.youtube.com/watch?v=bad",
  ])("does not identify an unsupported address as a YouTube video: %s", (url) => {
    const meta = page(url).api.extractMetadata();
    expect(meta.detectedType).toBe("link");
    expect(meta.image).toBeNull();
  });

  it("rejects a completed extraction after navigation away and back", async () => {
    const url = "https://bsky.app/profile/did:plc:author/post/123";
    const { api, dom, fetch } = page(url);
    let finish!: (value: unknown) => void;
    fetch.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const first = api.extractMetadata();
    const pending = api.extractArticleAsync();
    dom.window.history.pushState({}, "", "/profile/did:plc:author/post/456");
    dom.window.dispatchEvent(new dom.window.Event("popstate"));
    dom.window.history.pushState({}, "", url);
    dom.window.dispatchEvent(new dom.window.Event("popstate"));
    expect(api.extractMetadata().captureGeneration).not.toBe(first.captureGeneration);
    finish({ ok: true, json: async () => ({ thread: { post: { author: {}, record: { text: "old" } } } }) });
    await expect(pending).rejects.toThrow("Capture document changed");
  });

  it("keeps new YouTube transcript, title, source and poster in one generation", async () => {
    class CurrentDefuddle {
      async parseAsync() { return { title: "Current video", variables: { transcript: "Current transcript" } }; }
    }
    const { api } = page("https://www.youtube.com/watch?v=BBBBBBBBBBB", '<title>Current video</title><link rel="canonical" href="https://www.youtube.com/watch?v=AAAAAAAAAAA"><meta property="og:image" content="https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg">', CurrentDefuddle);
    const meta = api.extractMetadata();
    const article = await api.extractArticleAsync();
    expect(article).toMatchObject({ title: "Current video", content: "Current transcript", sourceUrl: meta.url, documentUrl: meta.documentUrl, captureGeneration: meta.captureGeneration });
    expect(article.embeddedVideos?.[0]?.poster).toBe(meta.image);
  });

  it("rejects a YouTube transcript from before an A to B to A navigation", async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const parsing = new Promise<void>((resolve) => { started = resolve; });
    class DelayedDefuddle {
      parseAsync() {
        started();
        return new Promise((resolve) => { finish = resolve; });
      }
    }
    const url = "https://www.youtube.com/watch?v=AAAAAAAAAAA";
    const { api, dom } = page(url, "<title>Original</title>", DelayedDefuddle);
    const first = api.extractMetadata();
    const pending = api.extractArticleAsync();
    await parsing;
    dom.window.dispatchEvent(new dom.window.Event("yt-navigate-start"));
    dom.window.history.pushState({}, "", "/watch?v=BBBBBBBBBBB");
    dom.window.dispatchEvent(new dom.window.Event("yt-navigate-start"));
    dom.window.history.pushState({}, "", url);
    expect(api.extractMetadata().captureGeneration).not.toBe(first.captureGeneration);
    finish({ title: "Original", variables: { transcript: "Old transcript" } });
    await expect(pending).rejects.toThrow("Capture document changed");
  });

  it("labels message errors with the original capture rather than the new document", async () => {
    const original = "https://bsky.app/profile/did:plc:author/post/123";
    const { api, dom, fetch, addListener } = page(original, "<title>Original</title>");
    let finish!: (value: unknown) => void;
    fetch.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const meta = api.extractMetadata();
    const reply = vi.fn();
    const listener = addListener.mock.calls[0]![0];
    listener({ action: "extractArticleAsync" }, {}, reply);
    dom.window.history.pushState({}, "", "/profile/did:plc:author/post/456");
    dom.window.dispatchEvent(new dom.window.Event("popstate"));
    dom.window.document.title = "New document";
    finish({ ok: true, json: async () => ({ thread: { post: { author: {}, record: { text: "old" } } } }) });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    expect(reply.mock.calls[0]![0]).toMatchObject({ title: "Original", content: "", documentUrl: original, captureGeneration: meta.captureGeneration });
    expect(reply.mock.calls[0]![0].threadWarning).toContain("Capture document changed");
  });
});
