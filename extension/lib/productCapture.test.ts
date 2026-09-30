import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import type { ArticleData, PageMetadata } from "../popup/lib/messaging";
import { normalizeArticleMedia } from "../popup/lib/normalizeArticleMedia";
import { resolveCaptureResult } from "../popup/lib/captureResult";

const url = "https://shop.example/products/meridian";
const documents: JSDOM[] = [];

// The real save core, compiled to WebAssembly: the layer that writes the note
// (SPEC_AUDIT_FIXES.md, А10.2). It builds the Markdown in memory, no I/O.
const core = createRequire(import.meta.url)("../../output/playwright/save-core-node/mine_core.js") as {
  execute_json(request: string): string;
};

/** The note the core writes for what the clipper shows, as both executors send it. */
function savedMarkdown(title: string, body: string, source: string): string {
  const reply = JSON.parse(core.execute_json(JSON.stringify({
    op: "capture",
    request: {
      slug: "Cards/Meridian", block_type: "article", title, body, url,
      author: null, source: "web-clipper", tags: [], saved_at: "2026-09-21T12:00:00Z",
      ...(source === "selection" ? { selection: true } : {}),
    },
  }))) as { ok: boolean; value?: { markdown: string } };
  expect(reply.ok).toBe(true);
  return reply.value!.markdown;
}
type Extractors = {
  extractArticle(): ArticleData;
  extractArticleAsync(): Promise<ArticleData>;
  extractMetadata(): PageMetadata;
};

function page(html: string, productEnabled = true) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  documents.push(dom);
  const window = dom.window;
  Object.assign(window, { chrome: { runtime: { onMessage: { addListener() {} } } } });
  for (const file of ["lib/defuddle.js", "lib/extractionDocumentSanitizer.js",
    ...(productEnabled ? ["lib/productExtraction.js"] : []), "content.js"]) {
    window.eval(readFileSync(`extension/${file}`, "utf8"));
  }
  return (window as unknown as { __mineClipper: Extractors }).__mineClipper;
}

const product = `<!doctype html><html><head><title>Long store title</title>
<script type="application/ld+json">{"@type":"Product","name":"Meridian","url":"${url}"}</script>
</head><body><header>Navigation</header><main><section data-product-root role="banner">
<h1>Meridian</h1>${Array.from({ length: 9 }, (_, i) => `<div data-product-single-media-wrapper data-product-media-type-image data-media-id="${i}" hidden><img alt="Meridian" src="/media/${i}.jpg"></div>`).join("")}
<div class="product-content-container"><div class="rte"><p>A geometric book.</p><p>ISBN: 123</p></div></div>
</section></main><footer>Newsletter</footer></body></html>`;

afterEach(() => documents.splice(0).forEach(dom => dom.window.close()));

describe("actual product content capture", () => {
  it("uses the same complete product in synchronous and asynchronous extraction", async () => {
    const api = page(product);
    const sync = api.extractArticle();
    const asyncResult = await api.extractArticleAsync();
    expect(asyncResult.content).toBe(sync.content);
    expect(asyncResult.title).toBe("Meridian");
    expect(asyncResult.sourceUrl).toBe(url);
    expect(sync.content.match(/!\[/g)).toHaveLength(9);
    expect(sync.content).toContain("ISBN: 123");
    expect(sync.content).not.toMatch(/Newsletter|Navigation/);
  });

  it("passes the same ordered body and source to the existing capture contract", async () => {
    const api = page(product);
    const article = normalizeArticleMedia(await api.extractArticleAsync(), url);
    const capture = resolveCaptureResult("content", api.extractMetadata(), article);
    expect(capture.body.text).toBe(article.content);
    expect(capture.sourceUrl).toBe(url);
    expect([...capture.body.text.matchAll(/https:\/\/shop.example\/media\/(\d).jpg/g)].map(match => match[1]))
      .toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("does not change generic article output or type detection", async () => {
    const html = '<!doctype html><html><head><title>Article</title></head><body><main><article><h1>Article</h1>'
      + '<p>This is an independent paragraph about geometric art and its history. It is editorial content, not a product description.</p>'.repeat(8)
      + '<img src="https://example.com/art.jpg" alt="Study"></article></main></body></html>';
    const oldApi = page(html, false);
    const newApi = page(html);
    const { captureGeneration: newGeneration, ...newArticle } = await newApi.extractArticleAsync();
    const { captureGeneration: oldGeneration, ...oldArticle } = await oldApi.extractArticleAsync();
    expect(newGeneration).toEqual(expect.any(String));
    expect(oldGeneration).toEqual(expect.any(String));
    expect(newGeneration).not.toBe(oldGeneration);
    expect(newArticle).toEqual(oldArticle);
    expect(newApi.extractMetadata().detectedType).toBe(oldApi.extractMetadata().detectedType);
    expect(page(product).extractMetadata().detectedType).toBe(page(product, false).extractMetadata().detectedType);
  });

  it("keeps explicit selection above extracted product content", async () => {
    const api = page(product);
    const metadata = { ...api.extractMetadata(), selection: "Selected passage", detectedType: "selection" as const };
    const capture = resolveCaptureResult("content", metadata, await api.extractArticleAsync());
    expect(capture.body.text).toBe("Selected passage");
    expect(capture.body.source).toBe("selection");
  });

  it("writes all nine photos sharing one alt text into the saved note, in order", async () => {
    const api = page(product);
    const article = normalizeArticleMedia(await api.extractArticleAsync(), url);
    const capture = resolveCaptureResult("content", api.extractMetadata(), article);
    const markdown = savedMarkdown(article.title ?? "Meridian", capture.body.text, capture.body.source);
    expect([...markdown.matchAll(/!\[Meridian\]\(https:\/\/shop\.example\/media\/(\d)\.jpg\)/g)].map(match => match[1]))
      .toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(markdown).toContain("ISBN: 123");
  });

  it("saves a selection as shown, without the page title above it", async () => {
    const api = page(product);
    const metadata = { ...api.extractMetadata(), selection: "Selected passage", detectedType: "selection" as const };
    const capture = resolveCaptureResult("content", metadata, await api.extractArticleAsync());
    const markdown = savedMarkdown("Meridian", capture.body.text, capture.body.source);
    const body = markdown.slice(markdown.indexOf("\n---\n", 4) + 5).trim();
    expect(body).toBe("Selected passage");
    expect(markdown).not.toMatch(/^# /m);
  });
});
