import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";
import type { ArticleData } from "../popup/lib/messaging";
import "./productExtraction.js";

type Converter = (html: string, url: string) => string;
const { extractProductArticle } = (globalThis as unknown as {
  MineProductExtraction: {
    extractProductArticle: (doc: Document, pageUrl: string, toMarkdown: Converter) => ArticleData | null;
  };
}).MineProductExtraction;

const pageUrl = "https://shop.example/products/meridian";
const product = { "@type": "Product", name: "Meridian", url: pageUrl };
const converterWindow = new JSDOM("<!doctype html><html><body></body></html>", {
  url: pageUrl,
  runScripts: "outside-only",
});
converterWindow.window.eval(readFileSync(resolve("extension/lib/defuddle.js"), "utf8"));
const toMarkdown: Converter = (html, url) => (converterWindow.window as unknown as {
  Defuddle: { createMarkdownContent: Converter };
}).Defuddle.createMarkdownContent(html, url);
afterAll(() => converterWindow.window.close());

function slide(id: string, src: string, attributes = "") {
  return `<div data-product-single-media-wrapper data-product-media-type-image data-media-id="${id}" ${attributes}><img src="${src}" alt="Product view"></div>`;
}

function root(gallery = slide("one", "/images/one.jpg"), description = "<p>A book about geometry.</p>") {
  return `<section data-product-root data-product-id="123" role="banner"><h1>Meridian</h1>
    <div class="product-gallery">${gallery}</div>
    <div class="product-content-container"><div class="rte">${description}</div></div></section>`;
}

function fixture(body = root(), schema: unknown = product): Document {
  const doc = document.implementation.createHTMLDocument("Store search title");
  doc.head.innerHTML = `<base href="${pageUrl}"><script type="application/ld+json">${JSON.stringify(schema)}</script>`;
  doc.body.innerHTML = `<main>${body}</main>`;
  return doc;
}

function extract(doc: Document, converter: Converter = toMarkdown) {
  return extractProductArticle(doc, pageUrl, converter);
}

function extractedHtml(doc: Document) {
  const result = extract(doc, (html) => html);
  expect(result).not.toBeNull();
  const output = document.implementation.createHTMLDocument();
  output.body.innerHTML = result!.content;
  return output;
}

describe("product extraction", () => {
  it("converts the confirmed product through the existing Markdown converter", () => {
    const result = extract(fixture(root(undefined, `<p>A <strong>geometry</strong> book.</p><ul><li>Hardcover</li></ul>
      <table><thead><tr><th>Pages</th></tr></thead><tbody><tr><td>192</td></tr></tbody></table>`)));
    expect(result?.title).toBe("Meridian");
    expect(result?.byline).toBeNull();
    expect(result?.content).toContain("**geometry**");
    expect(result?.content).toContain("Hardcover");
    expect(result?.content).toContain("192");
    expect(result?.content).toContain("https://shop.example/images/one.jpg");
    expect(result?.content).not.toMatch(/^# Meridian/m);
  });

  it("retains all nine slides in source order including hidden slides", () => {
    const gallery = Array.from({ length: 9 }, (_, index) => slide(String(index), `/images/${index}.jpg`, index ? 'hidden aria-hidden="true" class="hidden md:block"' : "")).join("");
    const output = extractedHtml(fixture(root(gallery)));
    expect(Array.from(output.images, (img) => img.src)).toEqual(Array.from({ length: 9 }, (_, index) => `https://shop.example/images/${index}.jpg`));
  });

  it("deduplicates initialized gallery copies by media identity", () => {
    const output = extractedHtml(fixture(root(slide("one", "/images/one.jpg") + slide("two", "/images/two.jpg") + slide("one", "/images/one.jpg"))));
    expect(Array.from(output.images, (img) => img.src)).toEqual(["https://shop.example/images/one.jpg", "https://shop.example/images/two.jpg"]);
  });

  it("keeps different images with identical alt text", () => {
    const output = extractedHtml(fixture(root(slide("one", "/images/one.jpg") + slide("two", "/images/two.jpg"))));
    expect(output.images).toHaveLength(2);
  });

  it("selects an existing largest srcset candidate without removing its query", () => {
    const gallery = '<div data-product-single-media-wrapper data-product-media-type-image data-media-id="one"><picture><img alt="View" src="/images/small.jpg" srcset="/images/small.jpg 320w, /images/large.jpg?variant=blue&amp;token=signed 1600w"></picture></div>';
    const output = extractedHtml(fixture(root(gallery)));
    expect(output.images).toHaveLength(1);
    expect(output.images[0].src).toBe("https://shop.example/images/large.jpg?variant=blue&token=signed");
  });

  it("accepts Product in arrays and graph with supported page identities", () => {
    const schemas = [
      [product],
      { "@graph": [{ "@type": "WebSite", url: "https://shop.example" }, product] },
      { "@type": "Product", name: "Meridian", "@id": `${pageUrl}#product` },
      { "@type": "Product", name: "Meridian", offers: { "@type": "Offer", url: pageUrl } },
    ];
    for (const schema of schemas) expect(extract(fixture(root(), schema))?.title).toBe("Meridian");
  });

  it("rejects unrelated Product identities", () => {
    expect(extract(fixture(root(), { ...product, url: "https://shop.example/products/other" }))).toBeNull();
  });

  it("rejects conflicting product names", () => {
    expect(extract(fixture(root(), { ...product, name: "Another book" }))).toBeNull();
  });

  it("rejects ambiguous product roots", () => {
    expect(extract(fixture(root() + root()))).toBeNull();
  });

  it("rejects multiple unrelated Product entities", () => {
    expect(extract(fixture(root(), [product, { "@type": "Product", name: "Other", url: "https://shop.example/products/other" }]))).toBeNull();
  });

  it("rejects malformed JSON-LD", () => {
    const doc = fixture();
    doc.querySelector("script")!.textContent = '{"@type":"Product",';
    expect(extract(doc)).toBeNull();
  });

  it("rejects an article with a Product recommendation and a catalog", () => {
    expect(extract(fixture(`<article><h1>Recommended books</h1><p>An editorial article.</p><aside>${root()}</aside></article>`, { ...product, url: "https://shop.example/products/other" }))).toBeNull();
    expect(extract(fixture('<main><h1>Books</h1><div class="product-card"><h2>Meridian</h2><img src="/images/one.jpg"></div></main>'))).toBeNull();
  });

  it("leaves the source document unchanged", () => {
    const doc = fixture(root(slide("one", "/images/one.jpg", "hidden"), '<p>Keep this.</p><form><button>Buy</button></form>'));
    const before = doc.documentElement.outerHTML;
    expect(extract(doc)).not.toBeNull();
    expect(doc.documentElement.outerHTML).toBe(before);
  });

  it("removes scripts forms and navigation while retaining description structure", () => {
    const output = extractedHtml(fixture(root(undefined, '<p>Useful text.</p><script>window.evil=1</script><form><button>Buy now</button></form><nav>Navigation junk</nav><ul><li>Useful specification</li></ul>')));
    expect(output.querySelector("script,form,nav,button")).toBeNull();
    expect(output.body.textContent).not.toMatch(/evil|Buy now|Navigation junk/);
    expect(Array.from(output.querySelectorAll("p"), (p) => p.textContent)).toContain("Useful text.");
    expect(output.querySelector("li")?.textContent).toBe("Useful specification");
  });

  it("rejects the whole gallery when any image has an unsupported source", () => {
    const gallery = slide("one", "/images/one.jpg") + slide("two", "data:image/png;base64,AA==") + slide("three", "blob:https://shop.example/id");
    expect(extract(fixture(root(gallery)))).toBeNull();
  });

  it("allows only HTTP links in the description", () => {
    const description = '<p><a href="/details">Details</a> <a href="https://example.com/reference">Reference</a> <a href="javascript:alert(1)">Unsafe</a> <a href="file:///private/secret">Local</a></p>';
    const output = extractedHtml(fixture(root(undefined, description)));
    expect(Array.from(output.querySelectorAll("a[href]"), (a) => a.getAttribute("href"))).toEqual(["https://shop.example/details", "https://example.com/reference"]);
    expect(Array.from(output.images, (img) => img.src)).toEqual(["https://shop.example/images/one.jpg"]);
  });

  it("rejects malformed schema alongside an otherwise valid Product", () => {
    const doc = fixture();
    const broken = doc.createElement("script");
    broken.type = "application/ld+json";
    broken.textContent = '{"@type":';
    doc.head.append(broken);
    expect(extract(doc)).toBeNull();
  });

  it("deduplicates identical cleaned descriptions from responsive copies", () => {
    const doc = fixture();
    const description = doc.querySelector(".rte")!;
    const clone = description.cloneNode(true) as Element;
    clone.setAttribute("hidden", "");
    clone.querySelector("p")!.setAttribute("class", "mobile-description");
    description.parentElement!.append(clone);
    const result = extract(doc);
    expect(result).not.toBeNull();
    expect(result!.content.match(/A book about geometry\./g)).toHaveLength(1);
  });

  it("preserves literal commas in the selected srcset URL", () => {
    const gallery = '<div data-product-single-media-wrapper data-product-media-type-image><img src="/small.jpg" srcset="/small.jpg 320w, /large.jpg?crop=0,0,1200,800&amp;token=signed 1600w"></div>';
    const output = extractedHtml(fixture(root(gallery)));
    expect(output.images[0].src).toBe("https://shop.example/large.jpg?crop=0,0,1200,800&token=signed");
  });

  it("rejects matching Product cards nested in non-product page regions", () => {
    for (const tag of ["article", "aside", "nav", "header", "footer"]) {
      expect(extract(fixture(`<${tag}>${root()}</${tag}>`))).toBeNull();
    }
  });

  it("rejects videos iframes and unsupported gallery wrappers", () => {
    for (const unsupported of [
      '<video src="/film.mp4"></video>',
      '<iframe src="https://video.example/embed/1"></iframe>',
      '<div data-product-single-media-wrapper data-product-media-type-video><img src="/poster.jpg"></div>',
    ]) {
      expect(extract(fixture(root(slide("one", "/one.jpg") + unsupported)))).toBeNull();
    }
  });

  it("uses a picture source without a media condition", () => {
    const gallery = '<div data-product-single-media-wrapper data-product-media-type-image><picture><source srcset="/medium.webp 640w, /large.webp 1600w"><img src="/small.jpg"></picture></div>';
    expect(extractedHtml(fixture(root(gallery))).images[0].src).toBe("https://shop.example/large.webp");
  });

  it("uses lazy data-src instead of a placeholder", () => {
    const gallery = '<div data-product-single-media-wrapper data-product-media-type-image><img src="data:image/gif;base64,AA==" data-src="/actual.jpg"></div>';
    expect(extractedHtml(fixture(root(gallery))).images[0].src).toBe("https://shop.example/actual.jpg");
  });

  it("removes active attributes and unsafe nested content from descriptions", () => {
    const description = '<div onclick="alert(1)"><p style="background:url(https://evil.example/pixel)" onmouseover="alert(1)">Safe prose</p>'
      + '<a href="java&#10;script:alert(1)" onclick="alert(1)">Unsafe link</a>'
      + '<a href="https://user:secret@example.com/private">Credentials</a>'
      + '<img src="/detail.jpg" onerror="alert(1)" srcset="/detail.jpg 1x" alt="Detail">'
      + '<img src="data:image/svg+xml;base64,AA=="><svg><script>alert(1)</script></svg>'
      + '<object data="https://evil.example/object">Object fallback</object>'
      + '<template><img src="https://evil.example/template"></template></div>';
    const output = extractedHtml(fixture(root(undefined, description)));
    expect(output.querySelector("script,svg,object,template,[style],[onclick],[onmouseover],[onerror],[srcset]")).toBeNull();
    expect(output.querySelector("a[href]")).toBeNull();
    expect(output.body.textContent).toContain("Safe prose");
    expect(output.body.textContent).not.toContain("Object fallback");
    expect(Array.from(output.images, (img) => img.src)).toEqual(["https://shop.example/images/one.jpg", "https://shop.example/detail.jpg"]);
  });
});
