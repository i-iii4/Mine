// The page-level crop in the actual content script: its capture names the page
// address the clipper opened for, and a refusal reaches the editor as its
// reason instead of a silent cancel (SPEC_AUDIT_FIXES.md, Ф6, Б4.5, Б4.6).
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync("extension/content.js", "utf8");
const youtubeScript = readFileSync("extension/lib/youtubeSource.js", "utf8");
const pageA = "https://a.example/story";
const refusal = "This tab shows another page than the one Mine opened for. Open Mine again on the page you want to capture.";

type Message = Record<string, unknown>;
type Listener = (message: Message, sender: unknown, sendResponse: (response: unknown) => void) => unknown;

function page() {
  const dom = new JSDOM("<html><body><p>Page</p></body></html>", { url: pageA });
  // The crop overlay lives in a closed shadow root; keep a handle to drive it.
  const roots: ShadowRoot[] = [];
  const attachShadow = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = attachShadow.call(this, init);
    roots.push(root);
    return root;
  };
  const sent: Message[] = [];
  let listener: Listener = () => undefined;
  const chrome = {
    runtime: {
      sendMessage: vi.fn((message: Message, callback?: (response: unknown) => void) => {
        sent.push(message);
        callback?.(message.action === "captureForCrop" ? { ok: false, error: refusal } : undefined);
      }),
      onMessage: { addListener: (added: Listener) => { listener = added; } },
    },
  };
  runInNewContext(`${youtubeScript}\n${script}`, {
    window: dom.window, document: dom.window.document, URL, chrome, fetch: vi.fn(), console,
    setTimeout, clearTimeout, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
  });

  async function dragSelection() {
    const overlay = roots.at(-1)?.querySelector(".overlay");
    if (!overlay) throw new Error("The crop overlay did not open");
    overlay.dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, clientX: 10, clientY: 10, bubbles: true }));
    dom.window.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: 160, clientY: 120 }));
    dom.window.dispatchEvent(new dom.window.MouseEvent("mouseup"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { dom, sent, dragSelection, receive: (message: Message) => listener(message, {}, () => undefined) };
}

describe("page crop names the page it was started for", () => {
  it("asks for the capture of the window's page address, even after the page moved, and reports the refusal", async () => {
    const tab = page();
    tab.receive({ action: "startCropOverlay", documentUrl: pageA });
    tab.dom.window.history.pushState({}, "", "/other");

    await tab.dragSelection();

    expect(tab.sent.find((message) => message.action === "captureForCrop"))
      .toEqual({ target: "background", action: "captureForCrop", documentUrl: pageA });
    expect(tab.sent.find((message) => message.action === "cropDone"))
      .toMatchObject({ target: "background", status: "cancelled", error: refusal });
  });

  it("hands the refusal to the overlay clipper instead of a silent cancel", async () => {
    const tab = page();
    const overlay = { show: vi.fn(), hide: vi.fn() };
    const win = tab.dom.window as unknown as { __mineOverlay: typeof overlay; __mineCrop: { start: (documentUrl: string | null) => void } };
    win.__mineOverlay = overlay;
    const results: unknown[] = [];
    tab.dom.window.addEventListener("mine-crop-result", (event) => results.push((event as CustomEvent).detail));

    win.__mineCrop.start(pageA);
    await tab.dragSelection();

    expect(tab.sent.find((message) => message.action === "captureForCrop")).toMatchObject({ documentUrl: pageA });
    expect(overlay.show).toHaveBeenCalledOnce();
    expect(results).toEqual([{ error: refusal }]);
  });

  it("names no address when the clipper named none, so background refuses rather than guesses", async () => {
    const tab = page();
    tab.receive({ action: "startCropOverlay" });
    await tab.dragSelection();
    expect(tab.sent.find((message) => message.action === "captureForCrop")).toMatchObject({ documentUrl: null });
  });
});
