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
  ALEXIS, ARTIGNATEV, card, column, GASPR, listResponse, LISTER, MICASSO, QUOTE_POST_ID, QUOTED_ID, QUOTED_VIDEO,
  REPOSTED_ID, REST_COLOUR, syndication, VIDEO_POST_ID,
} from "./xFeed.fixtures";
import { switchStorage } from "./feedButtonSwitch.fixtures";

// SPEC_CLIPPER.md, «Кнопка Mine в ленте X» and «Доработки после живого
// просмотра» (10.10.2026), Р1 to Р4.

type Activate = (article: Element, control: Element) => void;
interface FeedButtonApi {
  OWNED_ATTRIBUTE: string;
  isXHost(hostname: string): boolean;
  postIdentity(article: Element): { tweetId: string; handle: string } | null;
  ensureButton(article: Element, activate: Activate): Element | null;
  scan(doc: Document, activate: Activate): void;
  watch(doc: Document, activate: Activate): () => void;
  removeAll(doc: Document): void;
}
const feedButton = (globalThis as unknown as { MineXFeedButton: FeedButtonApi }).MineXFeedButton;
const OWNED = `[${feedButton.OWNED_ATTRIBUTE}]`;
const HOVER_COLOUR = "rgb(29, 155, 240)";

function feed(markup: string) {
  document.body.innerHTML = `<main>${markup}</main>`;
  return [...document.querySelectorAll('article[data-testid="tweet"]')];
}
const caret = (article: Element) => article.querySelector('[data-testid="caret"]') as HTMLElement;
const caretBox = (article: Element) => caret(article).parentElement!;
const rightRow = (article: Element) => caretBox(article).parentElement!;
const grok = (article: Element) => [...article.querySelectorAll("button")]
  .find((button) => button.className.includes("r-grok")) as HTMLElement | undefined;
const grokBox = (article: Element) => grok(article)!.parentElement!.parentElement!;
const box = (article: Element) => article.querySelector(OWNED) as HTMLElement;
const mine = (article: Element) => article.querySelector(`${OWNED} button`) as HTMLButtonElement;
const tint = (button: Element) => button.querySelector('[dir="ltr"]') as HTMLElement;
const halo = (button: Element) => button.querySelector("svg")!.previousElementSibling!;
const stackHeader = () => document.querySelector('[data-testid="root"]') as HTMLElement;
const stackActions = () => stackHeader().lastElementChild as HTMLElement;
const newColumnButton = () => stackActions().querySelector("button") as HTMLButtonElement;
const stackMine = () => stackHeader().querySelector(`:scope > ${OWNED} button`) as HTMLButtonElement | null;
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = "";
});

describe("the Mine button in a post's header (Р1)", () => {
  it("stands just before Grok in the post's header, and not in the action row", () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    feedButton.scan(document, vi.fn());
    expect(article.querySelectorAll(OWNED)).toHaveLength(1);
    expect(box(article).parentElement).toBe(rightRow(article));
    expect(box(article).nextElementSibling).toBe(grokBox(article));
    expect(article.querySelector(`[role="group"] ${OWNED}`)).toBeNull();
    expect(mine(article).getAttribute("aria-label")).toBe("Save to Mine");
  });

  it("finds Grok by its build whatever the interface language, and without a label", () => {
    const articles = feed([
      card(GASPR, "1001", { grok: "Действия Grok" }),
      card(GASPR, "1002", { grok: null }),
    ].join(""));
    feedButton.scan(document, vi.fn());
    for (const article of articles) expect(box(article).nextElementSibling).toBe(grokBox(article));
  });

  it("stands just before \"…\" when the post has no Grok, as in lists", () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID, { grok: false }));
    feedButton.scan(document, vi.fn());
    expect(box(article).parentElement).toBe(rightRow(article));
    expect(box(article).nextElementSibling).toBe(caretBox(article));
  });

  it("keeps the same place beside Follow on the main post of a post page", () => {
    const [withGrok, withoutGrok] = feed([
      card(ARTIGNATEV, QUOTE_POST_ID, { follow: true }),
      card(ARTIGNATEV, "1003", { follow: true, grok: false }),
    ].join(""));
    feedButton.scan(document, vi.fn());
    const order = (article: Element) => [...rightRow(article).children].map((child) => child.matches(OWNED) ? "mine"
      : child === caretBox(article) ? "caret" : child.textContent?.includes("Follow") ? "follow" : "grok");
    expect(order(withGrok)).toEqual(["follow", "mine", "grok", "caret"]);
    expect(order(withoutGrok)).toEqual(["follow", "mine", "caret"]);
  });

  it("stands before \"…\" in a column of X Pro, and on a repost and a post with a quote", () => {
    const articles = feed([
      card(GASPR, "2103621844733714548", { base: "https://x.com" }),
      card(MICASSO, REPOSTED_ID, { social: "Lister" }),
      card(ARTIGNATEV, QUOTE_POST_ID, { quote: { user: ALEXIS, id: QUOTED_ID, text: "Quote text" } }),
    ].join(""));
    feedButton.scan(document, vi.fn());
    expect(box(articles[0]!).nextElementSibling).toBe(caretBox(articles[0]!));
    for (const article of articles) expect(article.querySelectorAll(OWNED)).toHaveLength(1);
    // The quote has no header of its own and gets no button.
    expect(articles[2]!.querySelector('[role="link"]:not(a) [data-mine-x-post]')).toBeNull();
  });

  it("copies the look of \"…\" and draws the Mine mark in its icon", () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    feedButton.scan(document, vi.fn());
    expect(box(article).className).toBe(caretBox(article).className);
    expect(mine(article).className).toBe(caret(article).className);
    expect(tint(mine(article)).getAttribute("style")).toBe(`color: ${REST_COLOUR};`);
    expect(halo(mine(article)).className).toBe(halo(caret(article)).className);
    const icon = mine(article).querySelector("svg")!;
    expect(icon.getAttribute("class")).toBe(caret(article).querySelector("svg")!.getAttribute("class"));
    const logo = render(createElement(MineLogo)).container.querySelector("svg")!;
    expect(icon.getAttribute("viewBox")).toBe(logo.getAttribute("viewBox"));
    expect(icon.querySelector("path")!.getAttribute("d")).toBe(logo.querySelector("path")!.getAttribute("d"));
    // Nothing of X's identity, label or menu travels with the copy.
    expect(box(article).querySelectorAll("[data-testid], [id], [aria-expanded], [aria-haspopup]")).toHaveLength(0);
    expect(box(article).textContent).toBe("");
  });

  it("stays one per post through repeated passes and comes back after X redraws the header", async () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    stop = feedButton.watch(document, vi.fn());
    feedButton.scan(document, vi.fn());
    feedButton.scan(document, vi.fn());
    expect(article.querySelectorAll(OWNED)).toHaveLength(1);
    box(article).remove();
    await vi.waitFor(() => expect(article.querySelectorAll(OWNED)).toHaveLength(1));
    // X draws its right block anew: the new one gets the button.
    const redrawn = rightRow(article).cloneNode(true) as Element;
    redrawn.querySelector(OWNED)!.remove();
    rightRow(article).replaceWith(redrawn);
    await vi.waitFor(() => expect(redrawn.querySelectorAll(OWNED)).toHaveLength(1));
    expect(box(article).nextElementSibling).toBe(grokBox(article));
  });

  it("after the first pass looks only at the posts X added or whose header it redrew", async () => {
    const articles = feed(["1001", "1002", "1003"].map((id) => card(GASPR, id)).join(""));
    stop = feedButton.watch(document, vi.fn());
    const [changed, other] = articles;
    const otherBox = box(other!);
    // The other post's "…" takes another look without a change to its header:
    // a pass over that post would make its copy again.
    tint(caret(other!)).style.color = "rgb(139, 152, 165)";
    const pageQuery = vi.spyOn(document, "querySelectorAll");

    // X redraws the other post's action row: not the header, not looked at.
    const row = other!.querySelector('[role="group"]')!;
    row.replaceWith(row.cloneNode(true));
    box(changed!).remove();
    await vi.waitFor(() => expect(changed!.querySelectorAll(OWNED)).toHaveLength(1));
    // A post X adds gets its button.
    document.querySelector("main")!.insertAdjacentHTML("beforeend", card(GASPR, "1004"));
    const added = document.querySelector("main")!.lastElementChild!.querySelector("article")!;
    await vi.waitFor(() => expect(added.querySelectorAll(OWNED)).toHaveLength(1));

    expect(pageQuery).not.toHaveBeenCalled();
    expect(box(other!)).toBe(otherBox);
    expect(tint(mine(other!)).style.color).toBe(REST_COLOUR);
  });

  it("is made anew when X draws \"…\" in another look", () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    feedButton.scan(document, vi.fn());
    const first = box(article);
    tint(caret(article)).style.color = "rgb(139, 152, 165)";
    feedButton.scan(document, vi.fn());
    expect(box(article)).not.toBe(first);
    expect(tint(mine(article)).style.color).toBe("rgb(139, 152, 165)");
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

  it("repeats on hover what X draws on hover of \"…\", and takes it back off", async () => {
    const [article] = feed(card(GASPR, VIDEO_POST_ID));
    // X's hover script, as it changes "…" under the pointer.
    const more = caret(article);
    more.addEventListener("pointerover", () => {
      tint(more).style.color = HOVER_COLOUR;
      halo(more).classList.replace("r-1niwhzg", "r-1peqgm7");
    });
    const restHalo = halo(more).className;
    stop = feedButton.watch(document, vi.fn());
    more.querySelector("svg")!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await frames();

    const button = mine(article);
    button.dispatchEvent(new MouseEvent("pointerenter"));
    expect(tint(button).style.color).toBe(HOVER_COLOUR);
    expect(halo(button).classList.contains("r-1peqgm7")).toBe(true);
    expect(halo(button).classList.contains("r-1niwhzg")).toBe(false);
    button.dispatchEvent(new MouseEvent("pointerleave"));
    expect(tint(button).getAttribute("style")).toBe(`color: ${REST_COLOUR};`);
    expect(halo(button).className).toBe(restHalo);
  });

  it("belongs to X only", () => {
    expect(["x.com", "twitter.com", "pro.x.com", "X.COM"].every(feedButton.isXHost)).toBe(true);
    expect(["example.com", "x.com.example.com", "notx.com"].some(feedButton.isXHost)).toBe(false);
  });

  it("goes away from the whole page when the buttons are turned off", () => {
    const articles = feed([card(GASPR, "1001"), card(GASPR, "1002")].join(""));
    feedButton.scan(document, vi.fn());
    feedButton.removeAll(document);
    for (const article of articles) expect(article.querySelectorAll(OWNED)).toHaveLength(0);
  });
});

describe("the post X Pro opened over a column (Р2, Р3)", () => {
  const MAIN_ID = "2108800000000000001";
  const REPLY_ID = "2108800000000000002";
  const opened = () => column(
    [card(GASPR, "2108800000000000010", { base: "https://x.com" })],
    { main: card(ARTIGNATEV, MAIN_ID, { base: "https://x.com", opened: true }),
      replies: [card(LISTER, REPLY_ID, { base: "https://x.com" })] },
  );
  const post = (id: string) => [...document.querySelectorAll('article[data-testid="tweet"]')]
    .find((article) => article.querySelector(`a[href*="/status/${id}"]`))!;

  it("puts the button of the opened post in the stack header, before its actions, copied from its button", () => {
    feed(opened());
    feedButton.scan(document, vi.fn());
    const copy = stackMine()!;
    const copyBox = copy.closest(OWNED)!;
    expect(copyBox.parentElement).toBe(stackHeader());
    expect(copyBox.nextElementSibling).toBe(stackActions());
    expect(copyBox.className).toBe(stackActions().className);
    expect(copy.className).toBe(newColumnButton().className);
    expect(tint(copy).getAttribute("style")).toBe(tint(newColumnButton()).getAttribute("style"));
    // The empty wrapper beside X's button is not copied.
    expect(copyBox.querySelectorAll("div:empty:not([class*='halo'])")).toHaveLength(0);
    expect(copy.getAttribute("aria-label")).toBe("Save to Mine");
    expect(stackHeader().querySelectorAll(OWNED)).toHaveLength(1);
  });

  it("gives the opened post no button of its own, and every reply and column post one in its header", () => {
    feed(opened());
    feedButton.scan(document, vi.fn());
    expect(post(MAIN_ID).querySelectorAll(OWNED)).toHaveLength(0);
    for (const id of [REPLY_ID, "2108800000000000010"]) {
      expect(box(post(id)).nextElementSibling).toBe(caretBox(post(id)));
    }
  });

  it("saves the opened post from the stack header, whichever post is there when it is pressed", () => {
    feed(opened());
    const activate = vi.fn();
    feedButton.scan(document, activate);
    stackMine()!.click();
    expect(activate).toHaveBeenCalledWith(post(MAIN_ID), stackMine());
  });

  it("takes the opened post's ID from its own link, not from its quote or an analytics link of another post", () => {
    feed(column([], { main: card(ARTIGNATEV, MAIN_ID, { base: "https://x.com", opened: true, analyticsId: "999",
      quote: { user: ALEXIS, id: QUOTED_ID, text: "Quote text" } }) }));
    expect(feedButton.postIdentity(post(MAIN_ID))).toEqual({ tweetId: MAIN_ID, handle: "artignatev", href: `https://x.com/artignatev/status/${MAIN_ID}/photo/1` });
  });

  it("adds the stack button once X Pro has put the opened post in the stack", async () => {
    feed(column([card(GASPR, "2108800000000000010", { base: "https://x.com" })], { main: "" }));
    stop = feedButton.watch(document, vi.fn());
    expect(stackMine()).toBeNull();
    document.querySelector(".r-stack-timeline")!.insertAdjacentHTML("beforeend", card(ARTIGNATEV, MAIN_ID, { base: "https://x.com", opened: true }));
    await vi.waitFor(() => expect(stackMine()).not.toBeNull());
    // X Pro draws its header anew: the button comes back.
    const redrawn = stackActions().cloneNode(true) as Element;
    stackActions().replaceWith(redrawn);
    stackHeader().querySelector(OWNED)!.remove();
    await vi.waitFor(() => expect(stackMine()).not.toBeNull());
    expect(stackHeader().querySelectorAll(OWNED)).toHaveLength(1);
  });

  it("learns the hover of the stack header's button apart from the hover of \"…\"", async () => {
    feed(opened());
    const create = newColumnButton();
    create.addEventListener("pointerover", () => { tint(create).style.color = "rgb(231, 233, 234)"; });
    const reply = post(REPLY_ID);
    caret(reply).addEventListener("pointerover", () => { tint(caret(reply)).style.color = HOVER_COLOUR; });
    stop = feedButton.watch(document, vi.fn());
    caret(reply).querySelector("svg")!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await frames();
    stackMine()!.dispatchEvent(new MouseEvent("pointerenter"));
    expect(tint(stackMine()!).style.color).toBe(REST_COLOUR);
    stackMine()!.dispatchEvent(new MouseEvent("pointerleave"));

    create.querySelector("svg")!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await frames();
    stackMine()!.dispatchEvent(new MouseEvent("pointerenter"));
    expect(tint(stackMine()!).style.color).toBe("rgb(231, 233, 234)");
    mine(reply).dispatchEvent(new MouseEvent("pointerenter"));
    expect(tint(mine(reply)).style.color).toBe(HOVER_COLOUR);
  });
});

// The content script of an X page with the Mine buttons running, and the
// background it asks: the post the page's feeds delivered, then the clipper.
const libs = ["youtubeSource", "xThread", "twitterThreadSelection", "twitterTweetContent", "tweetTextCompletion", "xFeedButton", "feedButtonSettings"]
  .map((name) => readFileSync(`extension/lib/${name}.js`, "utf8")).join("\n");
const contentScript = readFileSync("extension/content.js", "utf8");
const shareWithWindow = ["MineXThread", "MineTwitterThreadSelection", "MineTwitterTweetContent", "MineTweetTextCompletion", "MineXFeedButton", "MineFeedButtonSettings"]
  .map((name) => `window.${name} = globalThis.${name};`).join("\n");

type Message = Record<string, unknown> & { action?: string; preloaded?: { metadata: Record<string, unknown>; article: Record<string, unknown> } };
const knownPosts = new Map((globalThis as unknown as { MineXThread: { feed(data: unknown): Array<{ id: string }> } })
  .MineXThread.feed(listResponse()).map((post) => [post.id, post]));

function xPage(url: string, markup: string, options: { cached?: boolean; syndication?: unknown; storage?: ReturnType<typeof switchStorage> } = {}) {
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
    chrome: {
      runtime: { onMessage: { addListener: vi.fn() }, sendMessage, lastError: undefined, getURL: (path: string) => path },
      ...(options.storage ? { storage: options.storage } : {}),
    },
    fetch, console, setTimeout, clearTimeout,
  });
  const articles = [...dom.window.document.querySelectorAll('article[data-testid="tweet"]')];
  /// Press the Mine button of a post, or the button given.
  async function press(target: Element) {
    (target.matches("button") ? target as HTMLButtonElement : target.querySelector(`${OWNED} button`) as HTMLButtonElement).click();
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

  it("opens the post X Pro opened from the button of its stack header, by the ID of its own link", async () => {
    const page = xPage("https://pro.x.com/i/decks/1",
      column([], { main: card(GASPR, VIDEO_POST_ID, { base: "https://x.com", opened: true }) }));
    const button = page.dom.window.document.querySelector(`[data-testid="root"] > ${OWNED} button`)!;
    const opened = await page.press(button);
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

  it("follows the switch in the clipper's menu at once, without a reload (Р11)", async () => {
    const storage = switchStorage();
    const page = xPage("https://x.com/home", [card(GASPR, "1001"), card(GASPR, "1002")].join(""), { storage });
    await vi.waitFor(() => expect(page.dom.window.document.querySelectorAll(OWNED)).toHaveLength(2));
    storage.set({ x: false, instagram: true });
    expect(page.dom.window.document.querySelectorAll(OWNED)).toHaveLength(0);
    // X adds a post meanwhile: no button while the switch is off.
    page.dom.window.document.querySelector("main")!.insertAdjacentHTML("beforeend", card(GASPR, "1003"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(page.dom.window.document.querySelectorAll(OWNED)).toHaveLength(0);
    storage.set({ x: true, instagram: true });
    expect(page.dom.window.document.querySelectorAll(OWNED)).toHaveLength(3);
  });

  it("puts no button while the switch is off from the start", async () => {
    const storage = switchStorage({ mineFeedButtons: { x: false, instagram: true } });
    const page = xPage("https://x.com/home", card(GASPR, "1001"), { storage });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.dom.window.document.querySelectorAll(OWNED)).toHaveLength(0);
  });

  it("puts no button on a page outside X", () => {
    const page = xPage("https://example.com/feed", card(GASPR, VIDEO_POST_ID));
    expect(page.articles[0].querySelectorAll(OWNED)).toHaveLength(0);
  });
});
