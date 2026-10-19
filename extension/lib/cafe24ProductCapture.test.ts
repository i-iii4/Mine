import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import type { ArticleData, PageMetadata } from "../popup/lib/messaging";
import { normalizeArticleMedia } from "../popup/lib/normalizeArticleMedia";
import { resolveCaptureResult } from "../popup/lib/captureResult";

// The card «-» of 19.10.2026: a Cafe24 product page whose og:title is «-» and
// whose Swiper gallery loops (SPEC_CLIPPER.md, «Название страницы», «Копии
// слайдов»). The fixture is a reduced copy of the page, see its header.
const url = "https://m.en.anglan.co.kr/product/parachute-wide-track-pants-navy/4455/";
const fixture = readFileSync("extension/lib/cafe24Product.fixtures.html", "utf8");
const productName = "Parachute Wide Track Pants - Navy";
const documents: JSDOM[] = [];

// The real save core, compiled to WebAssembly: it names the card and writes
// the note in memory, no I/O.
const core = createRequire(import.meta.url)("../../output/playwright/save-core-node/mine_core.js") as {
  execute_json(request: string): string;
};

type CoreReply = { ok: boolean; value?: { name?: string; markdown?: string } };

function coreValue(command: object) {
  const reply = JSON.parse(core.execute_json(JSON.stringify(command))) as CoreReply;
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  return reply.value ?? {};
}

/** The file name the core gives a card with this title from this page. */
function savedName(title: string): string {
  return coreValue({
    op: "name", title, url,
    layout: { cards: "Cards", media: "Media", collections: "Collections" }, existing: [],
  }).name ?? "";
}

/** The note the core writes for this title and body, as both executors send it. */
function savedMarkdown(title: string, body: string): string {
  return coreValue({
    op: "capture",
    request: { slug: "Cards/Product", block_type: "article", title, body, url, tags: [], saved_at: "2026-10-19T18:05:33Z" },
  }).markdown ?? "";
}

type Extractors = {
  extractArticle(): ArticleData;
  extractArticleAsync(): Promise<ArticleData>;
  extractMetadata(): PageMetadata;
};

function page(html: string) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  documents.push(dom);
  const window = dom.window;
  Object.assign(window, { chrome: { runtime: { onMessage: { addListener() {} } } } });
  for (const file of ["lib/defuddle.js", "lib/extractionDocumentSanitizer.js", "lib/productExtraction.js",
    "lib/pageTitle.js", "content.js"]) {
    window.eval(readFileSync(`extension/${file}`, "utf8"));
  }
  return (window as unknown as { __mineClipper: Extractors }).__mineClipper;
}

/** The images of a body, by file name, in order. */
function images(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\((https:\/\/cafe24img[^)\s]+)\)/g)].map(match => (match[1] ?? "").split("/").pop() ?? "");
}

afterEach(() => documents.splice(0).forEach(dom => dom.window.close()));

describe("Cafe24 product page with a placeholder og:title and a looping gallery", () => {
  it("is named by the product in the link, the preview and the saved note", async () => {
    const api = page(fixture);
    expect(api.extractMetadata().title).toBe(productName);
    expect(api.extractArticle().title).toBe(productName);
    const article = await api.extractArticleAsync();
    expect(article.title).toBe(productName);
    expect(savedName(article.title)).toBe(productName);
    const capture = resolveCaptureResult("content", api.extractMetadata(), normalizeArticleMedia(article, url));
    expect(savedMarkdown(article.title, capture.body.text)).toContain(`\n# ${productName}\n`);
  });

  it("saves each gallery image once, in the gallery's order", async () => {
    const source = new JSDOM(fixture);
    documents.push(source);
    const slides = source.window.document.querySelectorAll("#prdThumb li");
    const gallery = Array.from(slides, slide => slide.querySelector("img")!.getAttribute("src")!.split("/").pop()!);
    // The page as the shop's slider leaves it: a copy of the last slide first, of the first slide last.
    expect(slides[0]?.classList.contains("swiper-slide-duplicate")).toBe(true);
    expect(slides[slides.length - 1]?.classList.contains("swiper-slide-duplicate")).toBe(true);
    expect(gallery).toHaveLength(20);

    const api = page(fixture);
    const article = normalizeArticleMedia(await api.extractArticleAsync(), url);
    const capture = resolveCaptureResult("content", api.extractMetadata(), article);
    const saved = images(savedMarkdown(article.title ?? "", capture.body.text));
    expect(saved).toEqual(gallery.slice(1, -1));
    expect(new Set(saved).size).toBe(18);
  });

  it("names a page whose every title is separators alone by its address, without a heading", async () => {
    const html = fixture.replace("<title>Parachute Wide Track Pants - Navy - ANGLAN</title>", "<title>–</title>");
    const api = page(html);
    expect(api.extractMetadata().title).toBe("");
    const article = await api.extractArticleAsync();
    expect(article.title).toBe("");
    for (const title of [article.title, "-", " | "]) {
      expect(savedName(title)).toBe("m.en.anglan.co.kr product parachute-wide-track-pants-navy 4455");
      expect(savedMarkdown(title, "Text")).not.toMatch(/^# /m);
    }
  });
});
