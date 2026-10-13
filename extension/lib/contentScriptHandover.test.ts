// One content script per page (SPEC_CLIPPER.md, К4; «Кнопка Mine в ленте X»,
// rule 9). A reload of the extension leaves the content script of an open
// page cut off; the worker of the new build puts a new one there. The old one
// takes its buttons and observers away and stops answering; the new one puts
// one button per post and never fights a button it did not make.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { card, GASPR } from "./xFeed.fixtures";
import { switchStorage } from "./feedButtonSwitch.fixtures";

const libs = ["youtubeSource", "xThread", "twitterThreadSelection", "twitterTweetContent", "tweetTextCompletion", "xFeedButton", "feedButtonSettings"]
  .map((name) => readFileSync(`extension/lib/${name}.js`, "utf8")).join("\n");
const contentScript = readFileSync("extension/content.js", "utf8");
const shareWithWindow = ["MineXThread", "MineTwitterThreadSelection", "MineTwitterTweetContent", "MineTweetTextCompletion", "MineXFeedButton", "MineFeedButtonSettings"]
  .map((name) => `window.${name} = globalThis.${name};`).join("\n");
const X_BUTTON = "[data-mine-x-post]";
const INSTAGRAM_BUTTON = "[data-la-clip]";
const POSTS = ["2001", "2002"];

type Message = Record<string, unknown>;
type Listener = (message: Message, sender: unknown, reply: (response: unknown) => void) => boolean | undefined;

/// The extension as one content script sees it: its runtime, cut off when
/// the extension reloads, and what the script sent.
function extension() {
  const sent: Message[] = [];
  const listeners = new Set<Listener>();
  const runtime = {
    id: "mine" as string | undefined,
    lastError: undefined,
    getURL: (path: string) => path,
    sendMessage: vi.fn((message: Message, reply?: (response: unknown) => void) => {
      sent.push(message);
      if (message.action === "readXPost") reply?.({ post: null });
      else if (message.action === "showOverlayInThisTab") reply?.({ ok: true, mode: "overlay" });
      else reply?.(undefined);
    }),
    onMessage: {
      addListener: (listener: Listener) => { listeners.add(listener); },
      removeListener: (listener: Listener) => { listeners.delete(listener); },
    },
  };
  return {
    chrome: { runtime, storage: switchStorage() },
    sent,
    listeners,
    /// The extension reloaded: this script's runtime names no extension, and
    /// nothing it sends arrives.
    cutOff() {
      runtime.id = undefined;
      runtime.sendMessage = vi.fn(() => { throw new Error("Extension context invalidated."); });
    },
  };
}

/// Another world of the same page: the same document, globals of its own.
function isolatedWorld(window: Window) {
  const own = new Map<PropertyKey, unknown>();
  return new Proxy(window, {
    get(target, key) {
      if (own.has(key)) return own.get(key);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" && !/^[A-Z]/.test(String(key)) ? value.bind(target) : value;
    },
    set(_target, key, value) { own.set(key, value); return true; },
    has(target, key) { return own.has(key) || Reflect.has(target, key); },
    deleteProperty(_target, key) { own.delete(key); return true; },
  });
}

function page(url: string, markup: string) {
  return new JSDOM(`<html><head></head><body><main>${markup}</main></body></html>`, { url, pretendToBeVisual: true });
}

function runContentScript(dom: JSDOM, world: Window, host: ReturnType<typeof extension>) {
  runInNewContext(`${libs}\n${shareWithWindow}\n${contentScript}`, {
    window: world, document: dom.window.document, URL, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle,
    chrome: host.chrome, fetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  });
}

const xPage = () => page("https://x.com/home", POSTS.map((id) => card(GASPR, id)).join(""));
const buttonsOf = (dom: JSDOM) => [...dom.window.document.querySelectorAll(X_BUTTON)];
const press = (box: Element) => (box.querySelector("button") as HTMLButtonElement).click();
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

async function withButtons(dom: JSDOM) {
  await vi.waitFor(() => expect(buttonsOf(dom)).toHaveLength(POSTS.length));
  return buttonsOf(dom);
}

describe("a content script put into a page that already has one (К4)", () => {
  it("takes the page over in the same world: the one before takes its buttons away and stops answering", async () => {
    const dom = xPage();
    const before = extension();
    runContentScript(dom, dom.window as unknown as Window, before);
    const old = await withButtons(dom);
    expect(before.listeners.size).toBe(1);

    const after = extension();
    runContentScript(dom, dom.window as unknown as Window, after);
    const current = await withButtons(dom);
    expect(current.some((box) => old.includes(box))).toBe(false);
    expect(old.every((box) => !box.isConnected)).toBe(true);
    expect(before.listeners.size).toBe(0);
    expect(after.listeners.size).toBe(1);

    press(current[0]!);
    await vi.waitFor(() => expect(after.sent.some((message) => message.action === "showOverlayInThisTab")).toBe(true));
    expect(before.sent).toEqual([]);
  });

  it("takes over from a script a reload cut off in its own world, and the overlay of the new world finds it", async () => {
    const dom = xPage();
    const before = extension();
    runContentScript(dom, dom.window as unknown as Window, before);
    const old = await withButtons(dom);
    before.cutOff();

    const world = isolatedWorld(dom.window as unknown as Window);
    const after = extension();
    runContentScript(dom, world, after);
    const current = await withButtons(dom);
    expect(old.every((box) => !box.isConnected)).toBe(true);
    expect(before.listeners.size).toBe(0);
    // The page's own window no longer holds the old script's helpers; the
    // new world has its own.
    expect((dom.window as unknown as Record<string, unknown>).__mineClipper).toBeUndefined();
    expect((dom.window as unknown as Record<string, unknown>).__mineCrop).toBeUndefined();
    expect((world as unknown as Record<string, unknown>).__mineClipper).toBeDefined();

    press(current[1]!);
    await vi.waitFor(() => expect(after.sent.some((message) => message.action === "showOverlayInThisTab")).toBe(true));
    // The old script's observer is gone: X redraws a post and only the new
    // script puts its button back.
    current[0]!.remove();
    await frames();
    expect(buttonsOf(dom)).toHaveLength(POSTS.length);
  });

  it("gives the page up at the first press when it is cut off and nothing replaced it", async () => {
    const dom = xPage();
    const host = extension();
    runContentScript(dom, dom.window as unknown as Window, host);
    const [first] = await withButtons(dom);
    host.cutOff();
    press(first!);
    expect(buttonsOf(dom)).toEqual([]);
    expect(host.listeners.size).toBe(0);
    // X adds a post: nothing puts a button on it.
    dom.window.document.querySelector("main")!.insertAdjacentHTML("beforeend", card(GASPR, "2003"));
    await frames();
    expect(buttonsOf(dom)).toEqual([]);
  });

  it("stays when the page itself announces another content script", async () => {
    const dom = xPage();
    const host = extension();
    runContentScript(dom, dom.window as unknown as Window, host);
    const buttons = await withButtons(dom);
    dom.window.document.dispatchEvent(new dom.window.Event("mine-content-script-started"));
    expect(buttons.every((box) => box.isConnected)).toBe(true);
    expect(host.listeners.size).toBe(1);
  });

  it("answers the X button of a script that cannot give the page up, and never replaces it", async () => {
    const dom = xPage();
    const document = dom.window.document;
    // A content script of a build before 13.10.2026, cut off by the reload:
    // it keeps one button of its own in each header and removes any other.
    const orphans = new WeakSet<Element>();
    const orphanButtons = () => {
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const grok = [...article.querySelectorAll("button")].find((button) => button.className.includes("r-grok"))!.parentElement!;
        const container = grok.parentElement!;
        const boxes = [...container.children].filter((child) => child.matches(X_BUTTON));
        if (boxes.length === 1 && orphans.has(boxes[0]!)) continue;
        boxes.forEach((box) => box.remove());
        const box = document.createElement("div");
        box.setAttribute("data-mine-x-post", "post");
        box.innerHTML = "<button type=\"button\"><svg></svg></button>";
        orphans.add(box);
        grok.before(box);
      }
    };
    orphanButtons();
    new dom.window.MutationObserver(orphanButtons).observe(document.documentElement, { childList: true, subtree: true });
    const orphaned = buttonsOf(dom);

    const host = extension();
    runContentScript(dom, isolatedWorld(dom.window as unknown as Window), host);
    await frames();
    let changes = 0;
    new dom.window.MutationObserver((records) => { changes += records.length; })
      .observe(document.querySelector("main")!, { childList: true, subtree: true });
    await frames();
    await frames();
    expect(changes).toBe(0);
    expect(buttonsOf(dom)).toEqual(orphaned);

    press(orphaned[0]!);
    await vi.waitFor(() => expect(host.sent.some((message) => message.action === "showOverlayInThisTab")).toBe(true));
  });

  it("replaces an Instagram button another script put, which that script then leaves alone", async () => {
    const dom = page("https://www.instagram.com/", ["abc", "def"].map((code) => `<article><a href="/p/${code}/">Post</a></article>`).join(""));
    const foreign = dom.window.document.createElement("button");
    foreign.setAttribute("data-la-clip", "");
    foreign.setAttribute("data-la-clip-version", "3");
    dom.window.document.querySelector("article")!.append(foreign);
    const host = extension();
    runContentScript(dom, dom.window as unknown as Window, host);
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll(INSTAGRAM_BUTTON)).toHaveLength(2));
    expect(foreign.isConnected).toBe(false);
    for (const article of dom.window.document.querySelectorAll("article")) {
      expect(article.querySelectorAll(INSTAGRAM_BUTTON)).toHaveLength(1);
    }
    host.chrome.storage.set({ x: true, instagram: false });
  });
});
