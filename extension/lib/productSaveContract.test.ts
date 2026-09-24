import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import type { ArticleData } from "../popup/lib/messaging";
import "./productExtraction.js";

// Use the same compiled core as standaloneVault.test.ts. The capture command
// constructs final Markdown in memory and performs no filesystem/network I/O.
const wasm = createRequire(import.meta.url)("../../output/playwright/save-core-node/mine_core.js");
const extractor = (globalThis as unknown as {
  MineProductExtraction: {
    extractProductArticle: (doc: Document, url: string, convert: (html: string, url: string) => string) => ArticleData | null;
  };
}).MineProductExtraction;

it("preserves nine ordered product embeds, title and source in final save-core Markdown", () => {
  const url = "https://shop.example/products/meridian";
  const imageUrls = Array.from({ length: 9 }, (_, index) => `https://shop.example/images/${index}.jpg`);
  const dom = new JSDOM(`<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Meridian", url })}</script>
    </head><body><main><section data-product-root data-product-id="123" role="banner">
    <h1>Meridian</h1>
    ${imageUrls.map((src, index) => `<div data-product-single-media-wrapper data-product-media-type-image data-media-id="${index}" ${index ? "hidden" : ""}><img src="${src}" alt="View ${index}"></div>`).join("")}
    <div class="product-content-container"><div class="rte"><p>A book about geometry.</p><ul><li>192 pages</li></ul></div></div>
    </section></main></body></html>`, { url, runScripts: "outside-only" });
  try {
    dom.window.eval(readFileSync(resolve("extension/lib/defuddle.js"), "utf8"));
    const convert = (dom.window as unknown as {
      Defuddle: { createMarkdownContent: (html: string, url: string) => string };
    }).Defuddle.createMarkdownContent;
    const article = extractor.extractProductArticle(dom.window.document, url, convert);
    expect(article).not.toBeNull();

    const result = JSON.parse(wasm.execute_json(JSON.stringify({
      op: "capture",
      request: {
        slug: "Cards/Meridian", block_type: "article", title: article!.title,
        body: article!.content, url, author: article!.byline,
        source: "web-clipper", tags: [], saved_at: "2026-09-21T12:00:00Z",
      },
    })));
    expect(result.ok).toBe(true);
    const markdown: string = result.value.markdown;
    expect(markdown.match(/^# Meridian$/gm)).toHaveLength(1);
    expect(Array.from(markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g), (match) => match[1])).toEqual(imageUrls);
    expect(markdown).toContain(`url: ${url}`);
    expect(markdown).toContain("source: web-clipper");
    expect(markdown).toContain("A book about geometry.");
    expect(markdown).toContain("192 pages");
    expect(markdown.indexOf(imageUrls[8])).toBeLessThan(markdown.indexOf("A book about geometry."));
  } finally {
    dom.window.close();
  }
});
