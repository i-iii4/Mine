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
/// What content.js gives the overlay clipper in the same page.
interface CropApi {
  start: (documentUrl: string | null, cropId?: string) => void;
  cancel: (cropId: string) => void;
}
type Listener = (message: Message, sender: unknown, sendResponse: (response: unknown) => void) => unknown;

/// A page running the content script; background refuses the crop's capture
/// at once, or when the test says so with `holdCapture`.
function page(options: { holdCapture?: boolean } = {}) {
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
  const heldCaptures: Array<() => void> = [];
  let listener: Listener = () => undefined;
  const chrome = {
    runtime: {
      sendMessage: vi.fn((message: Message, callback?: (response: unknown) => void) => {
        sent.push(message);
        if (message.action === "captureForCrop" && options.holdCapture) {
          heldCaptures.push(() => callback?.({ ok: false, error: refusal }));
          return;
        }
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

  return { dom, sent, heldCaptures, dragSelection, receive: (message: Message) => listener(message, {}, () => undefined) };
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

  it("hands the refusal to the overlay clipper instead of a silent cancel, naming the clipper's crop", async () => {
    const tab = page();
    const overlay = { show: vi.fn(), hide: vi.fn() };
    const win = tab.dom.window as unknown as { __mineOverlay: typeof overlay; __mineCrop: CropApi };
    win.__mineOverlay = overlay;
    const results: unknown[] = [];
    tab.dom.window.addEventListener("mine-crop-result", (event) => results.push((event as CustomEvent).detail));

    win.__mineCrop.start(pageA, "crop-1");
    await tab.dragSelection();

    expect(tab.sent.find((message) => message.action === "captureForCrop")).toMatchObject({ documentUrl: pageA });
    expect(overlay.show).toHaveBeenCalledOnce();
    expect(results).toEqual([{ cropId: "crop-1", error: refusal }]);
  });

  it("names the crop that a clipper started through background in what it reports", async () => {
    const tab = page();
    tab.receive({ action: "startCropOverlay", documentUrl: pageA, cropId: "crop-2" });
    await tab.dragSelection();
    expect(tab.sent.find((message) => message.action === "cropDone")).toMatchObject({ cropId: "crop-2", status: "cancelled", error: refusal });
  });

  it("names no address when the clipper named none, so background refuses rather than guesses", async () => {
    const tab = page();
    tab.receive({ action: "startCropOverlay" });
    await tab.dragSelection();
    expect(tab.sent.find((message) => message.action === "captureForCrop")).toMatchObject({ documentUrl: null });
  });
});

describe("a crop gives Escape back to the page when it ends (SPEC_AUDIT_FIXES.md, В4.3)", () => {
  /// The overlay clipper, hidden for the crop, over a page with its own
  /// Escape and its own scroll style.
  function overlayPage(options: { holdCapture?: boolean } = {}) {
    const tab = page(options);
    const overlay = { show: vi.fn(), hide: vi.fn() };
    const win = tab.dom.window as unknown as { __mineOverlay: typeof overlay; __mineCrop: CropApi };
    win.__mineOverlay = overlay;
    const pageEscapes: KeyboardEvent[] = [];
    tab.dom.window.addEventListener("keydown", (event) => pageEscapes.push(event));
    const escape = () => {
      const event = new tab.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      tab.dom.window.document.body.dispatchEvent(event);
      return event;
    };
    const cropLayers = () => tab.dom.window.document.body.children.length - 1;
    return { tab, overlay, start: () => win.__mineCrop.start(pageA, "crop-1"), escape, pageEscapes, cropLayers };
  }

  it("cancels on Escape, then leaves the page's Escape and scroll alone and does not bring the clipper back", () => {
    const page = overlayPage();
    const html = page.tab.dom.window.document.documentElement;
    page.start();
    expect(html.style.overflow).toBe("hidden");

    expect(page.escape().defaultPrevented).toBe(true);
    expect(page.overlay.show).toHaveBeenCalledOnce();
    expect(page.cropLayers()).toBe(0);
    expect(html.style.overflow).toBe("");

    html.style.overflow = "scroll";
    const later = page.escape();
    expect(later.defaultPrevented).toBe(false);
    expect(page.pageEscapes.at(-1)).toBe(later);
    expect(page.overlay.show).toHaveBeenCalledOnce();
    expect(html.style.overflow).toBe("scroll");
  });

  it("leaves the page's Escape alone after a finished crop", async () => {
    const page = overlayPage();
    page.start();
    await page.tab.dragSelection();
    expect(page.overlay.show).toHaveBeenCalledOnce();

    expect(page.escape().defaultPrevented).toBe(false);
    expect(page.overlay.show).toHaveBeenCalledOnce();
  });

  it("does not stack crops: a second start while one is under way is ignored, and one Escape ends it", () => {
    const page = overlayPage();
    page.start();
    page.start();
    expect(page.cropLayers()).toBe(1);

    page.escape();
    expect(page.overlay.show).toHaveBeenCalledOnce();
    expect(page.escape().defaultPrevented).toBe(false);

    page.start();
    expect(page.cropLayers()).toBe(1);
  });

  it("does not start another crop while the finished one's capture is still out, and hands over one result", async () => {
    const page = overlayPage({ holdCapture: true });
    page.start();
    await page.tab.dragSelection();
    expect(page.tab.heldCaptures).toHaveLength(1);
    expect(page.cropLayers()).toBe(0);

    page.start();
    expect(page.cropLayers()).toBe(0);

    page.tab.heldCaptures[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.overlay.show).toHaveBeenCalledOnce();
    page.start();
    expect(page.cropLayers()).toBe(1);
  });
});

describe("a crop ends with the clipper that started it (SPEC_AUDIT_FIXES.md, Г3.3)", () => {
  function overlayPage(options: { holdCapture?: boolean } = {}) {
    const tab = page(options);
    const overlay = { show: vi.fn(), hide: vi.fn() };
    const win = tab.dom.window as unknown as { __mineOverlay: typeof overlay; __mineCrop: CropApi };
    win.__mineOverlay = overlay;
    const results: unknown[] = [];
    tab.dom.window.addEventListener("mine-crop-result", (event) => results.push((event as CustomEvent).detail));
    const escape = () => {
      const event = new tab.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      tab.dom.window.document.body.dispatchEvent(event);
      return event;
    };
    const cropLayers = () => tab.dom.window.document.body.children.length - 1;
    return { tab, overlay, win, results, escape, cropLayers };
  }

  it("cancelled by its clipper, it leaves the page and reports nothing, and another crop may start", () => {
    const page = overlayPage();
    const html = page.tab.dom.window.document.documentElement;
    page.win.__mineCrop.start(pageA, "crop-1");
    expect(page.cropLayers()).toBe(1);

    page.win.__mineCrop.cancel("crop-1");

    expect(page.cropLayers()).toBe(0);
    expect(html.style.overflow).toBe("");
    expect(page.escape().defaultPrevented).toBe(false);
    expect(page.overlay.show).not.toHaveBeenCalled();
    expect(page.results).toEqual([]);
    page.win.__mineCrop.start(pageA, "crop-2");
    expect(page.cropLayers()).toBe(1);
  });

  it("cancelled while its capture is out, its frame is dropped and the clipper is not shown", async () => {
    const page = overlayPage({ holdCapture: true });
    page.win.__mineCrop.start(pageA, "crop-1");
    await page.tab.dragSelection();
    expect(page.tab.heldCaptures).toHaveLength(1);

    page.win.__mineCrop.cancel("crop-1");
    page.tab.heldCaptures[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(page.overlay.show).not.toHaveBeenCalled();
    expect(page.results).toEqual([]);
    page.win.__mineCrop.start(pageA, "crop-2");
    expect(page.cropLayers()).toBe(1);
  });

  it("is not cancelled by a clipper that names another crop", () => {
    const page = overlayPage();
    page.win.__mineCrop.start(pageA, "crop-1");
    page.win.__mineCrop.cancel("crop-0");
    expect(page.cropLayers()).toBe(1);
    expect(page.escape().defaultPrevented).toBe(true);
    expect(page.results).toEqual([{ cropId: "crop-1" }]);
  });
});
