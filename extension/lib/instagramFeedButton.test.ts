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

function instagram(storage: ReturnType<typeof switchStorage>) {
  const dom = new JSDOM(`<html><body><main>${post("abc")}${post("def")}</main></body></html>`,
    { url: "https://www.instagram.com/", pretendToBeVisual: true });
  runInNewContext(`${libs}\nwindow.MineFeedButtonSettings = globalThis.MineFeedButtonSettings;\n${contentScript}`, {
    window: dom.window, document: dom.window.document, URL, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle,
    chrome: {
      runtime: { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn(), lastError: undefined, getURL: (path: string) => path },
      storage,
    },
    fetch: vi.fn(), console, setTimeout, setInterval, clearInterval, clearTimeout,
  });
  return dom.window.document;
}

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
