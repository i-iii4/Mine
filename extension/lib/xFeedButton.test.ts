import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MineLogo } from "@/components/MineLogo";
import "./xThread.js";
import "./xFeedButton.js";
import {
  ALEXIS, ARTIGNATEV, card, GASPR, listResponse, MICASSO, QUOTE_POST_ID, QUOTED_ID, QUOTED_VIDEO, REPOSTED_ID,
  REST_COLOUR, syndication, VIDEO_POST_ID,
} from "./xFeed.fixtures";

// SPEC_CLIPPER.md, «Кнопка Mine в ленте X» (10.10.2026).

interface FeedButtonApi {
  OWNED_ATTRIBUTE: string;
  isXHost(hostname: string): boolean;
  ensureButton(article: Element, activate: (article: Element, control: Element) => void): Element | null;
  scan(doc: Document, activate: (article: Element, control: Element) => void): void;
  watch(doc: Document, activate: (article: Element, control: Element) => void): () => void;
}
const feedButton = (globalThis as unknown as { MineXFeedButton: FeedButtonApi }).MineXFeedButton;
const OWNED = `[${feedButton.OWNED_ATTRIBUTE}]`;
const HOVER_COLOUR = "rgb(29, 155, 240)";

function feed(markup: string) {
  document.body.innerHTML = `<main>${markup}</main>`;
  return [...document.querySelectorAll('article[data-testid="tweet"]')];
}
const row = (article: Element) => article.querySelector('[role="group"]')!;
const shareBox = (article: Element) => row(article).lastElementChild!.matches(OWNED)
  ? row(article).lastElementChild!.previousElementSibling!
  : row(article).lastElementChild!;
const mine = (article: Element) => article.querySelector(`${OWNED} button`) as HTMLButtonElement;
const tint = (button: Element) => button.querySelector('[dir="ltr"]') as HTMLElement;
const halo = (button: Element) => button.querySelector("svg")!.previousElementSibling!;
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = "";
});

describe("the Mine button in a post's action row", () => {
  it("is the last control of the row on an ordinary post, a repost, a post with a quote and an X Pro post", () => {
    const articles = feed([
      card(GASPR, VIDEO_POST_ID),
      card(MICASSO, REPOSTED_ID, { social: "Lister" }),
      card(ARTIGNATEV, QUOTE_POST_ID, { quote: { user: ALEXIS, id: QUOTED_ID, text: "Quote text" } }),
      card(GASPR, "2103621844733714548", { base: "https://x.com" }),
    ].join(""));
    feedButton.scan(document, vi.fn());
    for (const article of articles) {
      expect(article.querySelectorAll(OWNED)).toHaveLength(1);
      expect(row(article).lastElementChild!.matches(OWNED)).toBe(true);
      expect(mine(article).getAttribute("aria-label")).toBe("Save to Mine");
    }
  });

  it("copies the look of X's last control and draws the Mine mark in its icon", () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    feedButton.scan(document, vi.fn());
    const share = shareBox(article);
    const box = row(article).lastElementChild!;
    expect(box.className).toBe(share.className);
    expect(mine(article).className).toBe(share.querySelector("button")!.className);
    expect(tint(mine(article)).getAttribute("style")).toBe(`color: ${REST_COLOUR};`);
    expect(halo(mine(article)).className).toBe(halo(share).className);
    const icon = mine(article).querySelector("svg")!;
    expect(icon.getAttribute("class")).toBe(share.querySelector("svg")!.getAttribute("class"));
    const logo = render(createElement(MineLogo)).container.querySelector("svg")!;
    expect(icon.getAttribute("viewBox")).toBe(logo.getAttribute("viewBox"));
    expect(icon.querySelector("path")!.getAttribute("d")).toBe(logo.querySelector("path")!.getAttribute("d"));
    // Nothing of X's identity, label or count travels with the copy.
    expect(box.querySelectorAll("[data-testid], [id], [aria-expanded], [aria-haspopup]")).toHaveLength(0);
    expect(box.textContent).toBe("");
  });

  it("stays one per post through repeated passes and comes back after X redraws the row", async () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    stop = feedButton.watch(document, vi.fn());
    feedButton.scan(document, vi.fn());
    feedButton.scan(document, vi.fn());
    expect(article.querySelectorAll(OWNED)).toHaveLength(1);
    row(article).querySelector(OWNED)!.remove();
    await vi.waitFor(() => expect(article.querySelectorAll(OWNED)).toHaveLength(1));
    // X appends a control of its own: the Mine button moves back after it.
    const late = shareBox(article).cloneNode(true) as Element;
    row(article).append(late);
    feedButton.scan(document, vi.fn());
    expect(row(article).lastElementChild!.matches(OWNED)).toBe(true);
    expect(row(article).lastElementChild!.previousElementSibling).toBe(late);
    expect(article.querySelectorAll(OWNED)).toHaveLength(1);
  });

  it("after the first pass looks only at the posts X added or whose action row it redrew", async () => {
    const articles = feed(["1001", "1002", "1003"].map((id) => card(GASPR, id)).join(""));
    stop = feedButton.watch(document, vi.fn());
    const [changed, other, redrawn] = articles;
    const otherButton = row(other).querySelector(OWNED);
    // The other post's controls take another look without a change to its
    // row's children: a pass over the page would make its copy again.
    tint(shareBox(other).querySelector("button")!).style.color = "rgb(139, 152, 165)";
    const pageQuery = vi.spyOn(document, "querySelectorAll");

    row(changed).querySelector(OWNED)!.remove();
    await vi.waitFor(() => expect(row(changed).querySelectorAll(OWNED)).toHaveLength(1));
    // X redraws a whole row: the new row gets its button.
    const fresh = row(redrawn).cloneNode(true) as Element;
    fresh.querySelector(OWNED)!.remove();
    row(redrawn).replaceWith(fresh);
    await vi.waitFor(() => expect(fresh.querySelectorAll(OWNED)).toHaveLength(1));
    // A post X adds gets its button.
    document.querySelector("main")!.insertAdjacentHTML("beforeend", card(GASPR, "1004"));
    const added = document.querySelector("main")!.lastElementChild!.querySelector("article")!;
    pageQuery.mockClear();
    await vi.waitFor(() => expect(added.querySelectorAll(OWNED)).toHaveLength(1));

    expect(pageQuery).not.toHaveBeenCalled();
    expect(row(other).querySelector(OWNED)).toBe(otherButton);
    expect(tint(mine(other)).style.color).toBe(REST_COLOUR);
  });

  it("is made anew when X draws its controls in another look", () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    feedButton.scan(document, vi.fn());
    const first = row(article).querySelector(OWNED);
    tint(shareBox(article).querySelector("button")!).style.color = "rgb(139, 152, 165)";
    feedButton.scan(document, vi.fn());
    expect(row(article).querySelector(OWNED)).not.toBe(first);
    expect(tint(mine(article)).style.color).toBe("rgb(139, 152, 165)");
  });

  it("gives no button to a quote, which has no row of its own", () => {
    const [article] = feed(card(ARTIGNATEV, QUOTE_POST_ID, { quote: { user: ALEXIS, id: QUOTED_ID, text: "Quote text" } }));
    feedButton.scan(document, vi.fn());
    expect(document.querySelectorAll(OWNED)).toHaveLength(1);
    expect(article.querySelector('[role="link"] [data-mine-x-post]')).toBeNull();
  });

  it("keeps the press from X and hands the post to the clipper", () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    const opened = vi.fn();
    article.addEventListener("click", opened);
    article.addEventListener("pointerdown", opened);
    const activate = vi.fn();
    feedButton.scan(document, activate);
    mine(article).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    mine(article).click();
    expect(opened).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(article, mine(article));
  });

  it("changes only the cursor on hover until X has drawn a hover of its own", () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    stop = feedButton.watch(document, vi.fn());
    const before = mine(article).outerHTML;
    mine(article).dispatchEvent(new MouseEvent("pointerenter"));
    expect(mine(article).outerHTML).toBe(before);
  });

  it("repeats on hover what X draws on hover of its accent controls, and takes it back off", async () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    // X's hover script, as it changes a control under the pointer.
    const reply = article.querySelector('[data-testid="reply"]') as HTMLElement;
    reply.addEventListener("pointerover", () => {
      tint(reply).style.color = HOVER_COLOUR;
      halo(reply).classList.replace("r-1niwhzg", "r-1peqgm7");
    });
    const like = article.querySelector('[data-testid="like"]') as HTMLElement;
    like.addEventListener("pointerover", () => { tint(like).style.color = "rgb(249, 24, 128)"; });
    stop = feedButton.watch(document, vi.fn());

    like.querySelector("svg")!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await frames();
    reply.querySelector("svg")!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await frames();

    const button = mine(article);
    button.dispatchEvent(new MouseEvent("pointerenter"));
    expect(tint(button).style.color).toBe(HOVER_COLOUR);
    expect(halo(button).classList.contains("r-1peqgm7")).toBe(true);
    expect(halo(button).classList.contains("r-1niwhzg")).toBe(false);
    button.dispatchEvent(new MouseEvent("pointerleave"));
    expect(tint(button).getAttribute("style")).toBe(`color: ${REST_COLOUR};`);
    expect(halo(button).className).toBe(halo(shareBox(article)).className);
  });

  it("belongs to X only", () => {
    expect(["x.com", "twitter.com", "pro.x.com", "X.COM"].every(feedButton.isXHost)).toBe(true);
    expect(["example.com", "x.com.example.com", "notx.com"].some(feedButton.isXHost)).toBe(false);
  });
});

// The content script of an X page with the Mine buttons running, and the
// background it asks: the post the page's feeds delivered, then the clipper.
const libs = ["youtubeSource", "xThread", "twitterThreadSelection", "twitterTweetContent", "tweetTextCompletion", "xFeedButton"]
  .map((name) => readFileSync(`extension/lib/${name}.js`, "utf8")).join("\n");
const contentScript = readFileSync("extension/content.js", "utf8");
const shareWithWindow = ["MineXThread", "MineTwitterThreadSelection", "MineTwitterTweetContent", "MineTweetTextCompletion", "MineXFeedButton"]
  .map((name) => `window.${name} = globalThis.${name};`).join("\n");

type Message = Record<string, unknown> & { action?: string; preloaded?: { metadata: Record<string, unknown>; article: Record<string, unknown> } };
const knownPosts = new Map((globalThis as unknown as { MineXThread: { feed(data: unknown): Array<{ id: string }> } })
  .MineXThread.feed(listResponse()).map((post) => [post.id, post]));

function xPage(url: string, markup: string, options: { cached?: boolean; syndication?: unknown } = {}) {
  const dom = new JSDOM(`<html><head></head><body><main>${markup}</main></body></html>`, { url, pretendToBeVisual: true });
  const messages: Message[] = [];
  const sendMessage = vi.fn((message: Message, callback?: (response: unknown) => void) => {
    messages.push(message);
    if (message.action === "readXPost") callback?.({ post: options.cached === false ? null : knownPosts.get(String(message.tweetId)) ?? null });
    else if (message.action === "showOverlayInThisTab") callback?.({ ok: true, mode: "overlay" });
    else callback?.(undefined);
  });
  const fetch = vi.fn(async () => options.syndication
    ? { ok: true, json: async () => options.syndication }
    : { ok: false, json: async () => ({}) });
  runInNewContext(`${libs}\n${shareWithWindow}\n${contentScript}`, {
    window: dom.window, document: dom.window.document, URL, Node: dom.window.Node,
    chrome: { runtime: { onMessage: { addListener: vi.fn() }, sendMessage, lastError: undefined, getURL: (path: string) => path } },
    fetch, console, setTimeout, clearTimeout,
  });
  const articles = [...dom.window.document.querySelectorAll('article[data-testid="tweet"]')];
  async function press(article: Element) {
    (article.querySelector(`${OWNED} button`) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(messages.some((message) => message.action === "showOverlayInThisTab")).toBe(true));
    return messages.find((message) => message.action === "showOverlayInThisTab")!;
  }
  return { dom, articles, messages, fetch, press };
}

describe("pressing the Mine button of an X post", () => {
  it("opens the clipper in the page with the post the list's feed delivered", async () => {
    const page = xPage("https://x.com/i/lists/123", card(GASPR, VIDEO_POST_ID));
    const opened = await page.press(page.articles[0]);
    expect(page.messages[0]).toMatchObject({ target: "background", action: "readXPost", tweetId: VIDEO_POST_ID });
    expect(opened).toMatchObject({ target: "background", pageUrl: "https://x.com/i/lists/123" });
    expect(opened.preloaded?.metadata).toMatchObject({
      url: `https://x.com/GasprArt/status/${VIDEO_POST_ID}`, author: "@GasprArt", detectedType: "article", selection: "",
      documentUrl: "https://x.com/i/lists/123",
    });
    expect(opened.preloaded?.article).toMatchObject({
      sourceUrl: `https://x.com/GasprArt/status/${VIDEO_POST_ID}`, byline: "@GasprArt", threadPostCount: 1,
      twitterPosts: [{ id: VIDEO_POST_ID, mediaComplete: true }],
    });
    expect(String(opened.preloaded?.article.content)).toMatch(/^Clip\n\n!\[\]\(https:\/\/video\.twimg\.com\/amplify_video\//);
    // The feed itself is never read for the clip.
    expect(page.fetch).not.toHaveBeenCalled();
  });

  it("saves the reposted post of a repost card", async () => {
    const page = xPage("https://x.com/home", card(MICASSO, REPOSTED_ID, { social: "Lister" }));
    const opened = await page.press(page.articles[0]);
    expect(opened.preloaded?.metadata.url).toBe(`https://x.com/michaelmicasso/status/${REPOSTED_ID}`);
    expect(opened.preloaded?.article.content).toBe("post 2099105293938708797");
  });

  it("saves a post with its quote and the quote's author line, not as a thread", async () => {
    const page = xPage("https://x.com/artignatev",
      card(ARTIGNATEV, QUOTE_POST_ID, { quote: { user: ALEXIS, id: QUOTED_ID, text: "Quote text" } }));
    const opened = await page.press(page.articles[0]);
    expect(opened.preloaded?.article.content).toBe([
      "Main text",
      "![](https://pbs.twimg.com/media/one.jpg)",
      "![](https://pbs.twimg.com/media/two.jpg)",
      `> **Alexis Ohanian** [@alexisohanian](https://x.com/alexisohanian/status/${QUOTED_ID})\n> \n> Quote text\n> \n> ![](${QUOTED_VIDEO})`,
    ].join("\n\n"));
    expect(page.messages.some((message) => message.action === "collectXThread")).toBe(false);
    expect(opened.preloaded?.metadata.image).toBe("https://pbs.twimg.com/media/one.jpg");
  });

  it("reads the post of an X Pro column from its absolute timestamp link", async () => {
    const page = xPage("https://pro.x.com/i/decks/1", card(GASPR, VIDEO_POST_ID, { base: "https://x.com" }));
    expect(page.articles[0].querySelectorAll(OWNED)).toHaveLength(1);
    const opened = await page.press(page.articles[0]);
    expect(page.messages[0]).toMatchObject({ action: "readXPost", tweetId: VIDEO_POST_ID });
    expect(opened.preloaded?.metadata.url).toBe(`https://x.com/GasprArt/status/${VIDEO_POST_ID}`);
  });

  it("falls back to syndication by ID for a post the feeds did not deliver", async () => {
    const id = "2108700000000000001";
    const page = xPage("https://pro.x.com/i/decks/1", card(GASPR, id, { base: "https://x.com", text: "Fallback text" }),
      { cached: false, syndication: syndication(id, GASPR, "Fallback text https://t.co/p") });
    const opened = await page.press(page.articles[0]);
    expect(String(page.fetch.mock.calls[0]?.[0])).toBe(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=0`);
    expect(opened.preloaded?.article.content).toBe("Fallback text\n\n![](https://pbs.twimg.com/media/fallback.jpg?name=large)");
    expect(opened.preloaded?.article.unavailableReason).toBeUndefined();
  });

  it("opens the clipper with the reason when neither the feeds nor syndication give the post", async () => {
    const id = "2108700000000000002";
    const page = xPage("https://x.com/home", card(GASPR, id, { text: "Seen in the feed" }), { cached: false });
    const opened = await page.press(page.articles[0]);
    expect(opened.preloaded?.article).toMatchObject({
      content: "", twitterPosts: [],
      unavailableReason: "Mine couldn't read this post here. Open the post and save it from its page.",
    });
  });

  it("puts no button on a page outside X", () => {
    const page = xPage("https://example.com/feed", card(GASPR, VIDEO_POST_ID));
    expect(page.articles[0].querySelectorAll(OWNED)).toHaveLength(0);
  });
});
