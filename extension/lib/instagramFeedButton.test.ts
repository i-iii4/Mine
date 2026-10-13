// The Mine button on Instagram posts follows its switch in the clipper's "…"
// menu at once, without a reload (SPEC_CLIPPER.md, «Доработки после живого
// просмотра», пункт 5 и Р11).
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { switchStorage } from "./feedButtonSwitch.fixtures";

const libs = ["youtubeSource", "feedButtonSettings"].map((name) => readFileSync(`extension/lib/${name}.js`, "utf8")).join("\n");
const contentScript = readFileSync("extension/content.js", "utf8");
const BUTTON = "[data-la-clip]";
const post = (shortcode: string) => `<article><a href="/p/${shortcode}/">Post</a></article>`;

function instagram(storage: ReturnType<typeof switchStorage>, options: {
  fetch?: (...args: unknown[]) => unknown; sendMessage?: (...args: unknown[]) => unknown;
} = {}) {
  const dom = new JSDOM(`<html><body><main>${post("abc")}${post("def")}</main></body></html>`,
    { url: "https://www.instagram.com/", pretendToBeVisual: true });
  runInNewContext(`${libs}\nwindow.MineFeedButtonSettings = globalThis.MineFeedButtonSettings;\n${contentScript}`, {
    window: dom.window, document: dom.window.document, URL, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle,
    chrome: {
      runtime: { onMessage: { addListener: vi.fn() }, sendMessage: options.sendMessage ?? vi.fn(), lastError: undefined, getURL: (path: string) => path },
      storage,
    },
    fetch: options.fetch ?? vi.fn(), console, setTimeout, setInterval, clearInterval, clearTimeout,
  });
  return dom.window.document;
}

// SPEC_DEEP_AUDIT.md, Е3.16: a press that cannot read the post or open the
// clipper shows why, the way the Mine button of an X post does.
describe("a press on the Instagram button that fails", () => {
  it("opens the clipper for the post with the reason when Instagram does not give the post", async () => {
    // A request the network or the browser refuses fails this way.
    const sendMessage = vi.fn(async () => ({ ok: true, mode: "overlay" }));
    const storage = switchStorage();
    const page = instagram(storage, { fetch: vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))), sendMessage });
    await vi.waitFor(() => expect(page.querySelectorAll(BUTTON)).toHaveLength(2));
    (page.querySelector(BUTTON) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({
      action: "showOverlayInThisTab",
      preloaded: {
        metadata: { url: "https://www.instagram.com/p/abc/" },
        article: { content: "", unavailableReason: "Mine couldn't read this Instagram post. Save it as Screenshot or Link." },
      },
    });
    storage.set({ x: true, instagram: false });
  });

  it("names the reason on the button when the clipper does not open", async () => {
    const sendMessage = vi.fn(async () => ({ ok: false, error: "The Mine extension files on disk do not match the running extension." }));
    const storage = switchStorage();
    const page = instagram(storage, { fetch: vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))), sendMessage });
    await vi.waitFor(() => expect(page.querySelectorAll(BUTTON)).toHaveLength(2));
    const button = page.querySelector(BUTTON) as HTMLButtonElement;
    button.click();
    await vi.waitFor(() => expect(button.title).toBe("Mine could not open: The Mine extension files on disk do not match the running extension."));
    storage.set({ x: true, instagram: false });
  });
});

describe("the Mine button on Instagram posts", () => {
  it("goes away at once when its switch is turned off and comes back when it is on again", async () => {
    const storage = switchStorage();
    const page = instagram(storage);
    await vi.waitFor(() => expect(page.querySelectorAll(BUTTON)).toHaveLength(2));
    storage.set({ x: true, instagram: false });
    expect(page.querySelectorAll(BUTTON)).toHaveLength(0);
    // Instagram adds a post meanwhile: it stays without a button.
    page.querySelector("main")!.insertAdjacentHTML("beforeend", post("ghi"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(page.querySelectorAll(BUTTON)).toHaveLength(0);
    storage.set({ x: true, instagram: true });
    expect(page.querySelectorAll(BUTTON)).toHaveLength(3);
    storage.set({ x: true, instagram: false });
  });

  it("is not put on posts while its switch is off from the start, and the X switch does not touch it", async () => {
    const off = instagram(switchStorage({ mineFeedButtons: { x: true, instagram: false } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(off.querySelectorAll(BUTTON)).toHaveLength(0);
    const storage = switchStorage();
    const on = instagram(storage);
    await vi.waitFor(() => expect(on.querySelectorAll(BUTTON)).toHaveLength(2));
    storage.set({ x: false, instagram: true });
    expect(on.querySelectorAll(BUTTON)).toHaveLength(2);
    storage.set({ x: false, instagram: false });
  });
});
