// The crop's layer on a page that hides empty elements (SPEC_CLIPPER.md,
// «Слой обрезки и CSS страницы»). On 19.10.2026 Crop Area showed nothing on
// a Shopify product page: the theme Dawn hides `div:empty`, and the crop's
// host, whose content lives in a closed shadow tree, is an empty <div> to
// the page. The fixture is that page reduced, with Dawn's rule verbatim.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync("extension/content.js", "utf8");
const youtubeScript = readFileSync("extension/lib/youtubeSource.js", "utf8");
const fixture = readFileSync("extension/lib/shopifyDawnProduct.fixtures.html", "utf8");
const productPage = "https://wallacemercantileshop.com/products/mondrian-light-shorts-mud";
// A page that hides empty elements with an important rule, the look of the
// crop's layer included.
const importantHiding = "<style>div:empty{display:none!important;visibility:hidden!important;position:static!important}</style>";

type Listener = (message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) => unknown;
interface CropApi {
  start: (unused: string | null, cropId?: string) => void;
}

/// The product page running the content script, `extraHead` added to its head.
function productTab(extraHead = "") {
  const dom = new JSDOM(fixture.replace("</head>", `${extraHead}</head>`), { url: productPage });
  // The crop's layer lives in a closed shadow root; keep a handle to its host.
  const roots: ShadowRoot[] = [];
  const attachShadow = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = attachShadow.call(this, init);
    roots.push(root);
    return root;
  };
  let listener: Listener = () => undefined;
  const chrome = {
    runtime: {
      sendMessage: vi.fn((_message: unknown, callback?: (response: unknown) => void) => callback?.(undefined)),
      onMessage: { addListener: (added: Listener) => { listener = added; } },
    },
  };
  runInNewContext(`${youtubeScript}\n${script}`, {
    window: dom.window, document: dom.window.document, URL, chrome, fetch: vi.fn(), console,
    setTimeout, clearTimeout, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  });
  const crop = (dom.window as unknown as { __mineCrop: CropApi }).__mineCrop;
  const cropLayer = () => {
    const host = roots.at(-1)?.host;
    if (!host) throw new Error("The crop layer did not open");
    return { host, look: dom.window.getComputedStyle(host) };
  };
  const capture = () => new Promise((resolve) => listener({ action: "prepareViewportCapture" }, {}, resolve));
  return { dom, crop, cropLayer, capture };
}

describe("the crop's layer holds its look against the page's CSS", () => {
  it("shows over the Shopify Dawn product page, which hides empty divs", () => {
    const tab = productTab();
    const pageEmptyDiv = tab.dom.window.document.getElementById("shopify-block-empty");
    expect(tab.dom.window.getComputedStyle(pageEmptyDiv!).display).toBe("none");

    tab.crop.start(null, "crop-dawn");

    const { host, look } = tab.cropLayer();
    expect(host.parentElement).toBe(tab.dom.window.document.body);
    expect(host.matches(":empty")).toBe(true);
    expect(look.display).toBe("block");
    expect(look.visibility).toBe("visible");
    expect(look.position).toBe("fixed");
    expect(look.zIndex).toBe("2147483647");
  });

  it("shows when the page hides empty elements with an important rule", () => {
    const tab = productTab(importantHiding);

    tab.crop.start(null, "crop-important");

    const { look } = tab.cropLayer();
    expect(look.display).toBe("block");
    expect(look.visibility).toBe("visible");
    expect(look.position).toBe("fixed");
  });

  it("is still hidden for a capture taken while it is up", async () => {
    const tab = productTab(importantHiding);
    tab.crop.start(null, "crop-capture");

    await expect(tab.capture()).resolves.toEqual({ ok: true });

    expect(tab.cropLayer().look.visibility).toBe("hidden");
  });
});
