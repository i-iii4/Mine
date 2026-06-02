import { beforeEach, describe, expect, it } from "vitest";

import "./extractionDocumentSanitizer.js";

type ExtractionDocumentSanitizer = {
  sanitizeExtractionDocument: (doc: Document) => Document;
  shouldRemoveExtractionImage: (img: HTMLImageElement) => boolean;
};

const sanitizer = (globalThis as unknown as {
  MineExtractionDocumentSanitizer: ExtractionDocumentSanitizer;
}).MineExtractionDocumentSanitizer;

describe("extraction document sanitizer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("removes VMAX app-shell pixel image before article extraction", () => {
    document.body.innerHTML = `
      <div id="__DEFAULT_LAYOUT" class="DefaultLayout-module__2xpMVW__body">
        <img
          class="DefaultLayout-module__2xpMVW__pixel"
          src="https://intdev-global.s3.us-west-2.amazonaws.com/template-app-icon.png"
          alt=""
        />
        <div class="Document-module__QpC_fW__content">
          <h1>unix-ctf: Procedural Environments</h1>
          <p>Terminal agents are usually described as models that can use a shell.</p>
          <figure>
            <img src="https://intdev-global.s3.us-west-2.amazonaws.com/public/vmax-ai/chart.png" alt="Terminal benchmark task mix" />
          </figure>
        </div>
      </div>
    `;

    sanitizer.sanitizeExtractionDocument(document);

    expect(document.querySelector('img[src*="template-app-icon"]')).toBeNull();
    expect(document.querySelector('img[src*="chart.png"]')).toBeTruthy();
  });

  it("keeps app-icon imagery when it is part of article content", () => {
    document.body.innerHTML = `
      <article>
        <h1>Designing an app icon</h1>
        <figure>
          <img src="https://example.com/template-app-icon.png" alt="App icon study" />
          <figcaption>App icon study</figcaption>
        </figure>
      </article>
    `;

    sanitizer.sanitizeExtractionDocument(document);

    expect(document.querySelector('img[src*="template-app-icon"]')).toBeTruthy();
  });

  it("keeps empty-alt images inside article content", () => {
    document.body.innerHTML = `
      <article>
        <h1>Photo essay</h1>
        <img src="https://example.com/photo.jpg" alt="" />
      </article>
    `;

    sanitizer.sanitizeExtractionDocument(document);

    expect(document.querySelector("img")).toBeTruthy();
  });

  it("removes declared tracking pixels outside content", () => {
    document.body.innerHTML = `
      <img src="https://tracker.example.com/pixel.gif" width="1" height="1" alt="" />
      <main>
        <p>Readable body text.</p>
      </main>
    `;

    sanitizer.sanitizeExtractionDocument(document);

    expect(document.querySelector('img[src*="pixel.gif"]')).toBeNull();
  });

  it("does not remove ordinary layout logos by generic filename alone", () => {
    document.body.innerHTML = `
      <header>
        <img src="https://example.com/logo.png" alt="Example" />
      </header>
      <main>
        <p>Readable body text.</p>
      </main>
    `;

    sanitizer.sanitizeExtractionDocument(document);

    expect(document.querySelector('img[src*="logo.png"]')).toBeTruthy();
  });
});
