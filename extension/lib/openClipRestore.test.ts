// A new document asks background for the clip of the overlay its tab had open,
// and only when some tab has one: pages of a browser with no open overlay do
// not wake background (SPEC_CLIPPER.md, «Доработки после живого просмотра», Р7).
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync("extension/content.js", "utf8");
const youtubeScript = readFileSync("extension/lib/youtubeSource.js", "utf8");

function page(openClipTabs: unknown, options: { sessionThrows?: boolean } = {}) {
  const dom = new JSDOM("<html><body><p>Page B</p></body></html>", { url: "https://b.example/other" });
  const sent: Array<Record<string, unknown>> = [];
  const chrome = {
    runtime: {
      sendMessage: vi.fn((message: Record<string, unknown>, callback?: (response: unknown) => void) => {
        sent.push(message);
        callback?.({ ok: true, mode: "overlay" });
      }),
      onMessage: { addListener: () => undefined },
      lastError: undefined,
    },
    storage: {
      session: {
        get: vi.fn(async (key: string) => {
          if (options.sessionThrows) throw new Error("Access to storage is not allowed from this context.");
          return { [key]: openClipTabs };
        }),
      },
    },
  };
  runInNewContext(`${youtubeScript}\n${script}`, {
    window: dom.window, document: dom.window.document, URL, chrome, fetch: vi.fn(), console,
    setTimeout, clearTimeout, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
  });
  const restores = () => sent.filter((message) => message.action === "restoreOpenClip");
  return { dom, chrome, restores };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a new document asks for the clip of its tab's overlay", () => {
  it("asks background once the page loads while some tab keeps a clip", async () => {
    const tab = page([5]);
    await settle();
    expect(tab.chrome.storage.session.get).toHaveBeenCalledWith("mineOpenClipTabs");
    expect(tab.restores()).toEqual([{ target: "background", action: "restoreOpenClip" }]);
  });

  it("asks nothing while no tab keeps a clip, or while the page may not read session storage", async () => {
    for (const tab of [page([]), page(undefined), page([5], { sessionThrows: true })]) {
      await settle();
      expect(tab.restores()).toHaveLength(0);
    }
  });

  it("asks again when the page comes back from the history cache", async () => {
    const tab = page([5]);
    await settle();
    const shown = new tab.dom.window.Event("pageshow");
    Object.defineProperty(shown, "persisted", { value: true });
    tab.dom.window.dispatchEvent(shown);
    await settle();
    expect(tab.restores()).toHaveLength(2);
    tab.dom.window.dispatchEvent(new tab.dom.window.Event("pageshow"));
    await settle();
    expect(tab.restores()).toHaveLength(2);
  });
});
