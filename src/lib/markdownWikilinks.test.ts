import { describe, it, expect } from "vitest";
import { decodeLocalMarkdownUrl, preprocessWikilinks } from "./markdownWikilinks";

describe("preprocessWikilinks", () => {
  it("rewrites a bare embed wikilink to markdown image without alt", () => {
    expect(preprocessWikilinks("![[photo.jpg]]")).toBe("![](photo.jpg)");
  });

  it("rewrites an embed wikilink with alt via pipe", () => {
    expect(preprocessWikilinks("![[photo.jpg|sunset]]")).toBe(
      "![sunset](photo.jpg)"
    );
  });

  it("percent-encodes space and parens in filenames", () => {
    expect(preprocessWikilinks("![[Title (image 1).jpg]]")).toBe(
      "![](Title%20%28image%201%29.jpg)"
    );
  });

  it("percent-encodes bare percent to avoid spurious escape", () => {
    expect(preprocessWikilinks("![[50% off.jpg]]")).toBe(
      "![](50%25%20off.jpg)"
    );
  });

  it("preserves unicode characters without encoding", () => {
    // Cyrillic stays readable; encoding only what confuses the parser.
    expect(preprocessWikilinks("![[Закат (image 1).jpg]]")).toBe(
      "![](Закат%20%28image%201%29.jpg)"
    );
  });

  it("rewrites text wikilink (no leading !) to markdown link", () => {
    expect(preprocessWikilinks("see [[note]]")).toBe("see [note](note)");
  });

  it("uses display text from pipe in text wikilink", () => {
    expect(preprocessWikilinks("see [[note|my note]]")).toBe(
      "see [my note](note)"
    );
  });

  it("rewrites multiple wikilinks in one body", () => {
    const input = "![[a.jpg]]\n\n![[b (2).mp4|b alt]]\n\n[[c]]";
    const expected =
      "![](a.jpg)\n\n![b alt](b%20%282%29.mp4)\n\n[c](c)";
    expect(preprocessWikilinks(input)).toBe(expected);
  });

  it("leaves ordinary markdown untouched", () => {
    const input = "![alt](photo.jpg)\n\n[link](https://example.com)";
    expect(preprocessWikilinks(input)).toBe(input);
  });

  it("drops empty wikilinks silently instead of producing broken markdown", () => {
    expect(preprocessWikilinks("![[]]")).toBe("");
    expect(preprocessWikilinks("![[   ]]")).toBe("");
  });

  it("is a no-op for bodies without wikilinks", () => {
    const input = "plain paragraph\n\nwith **bold** and `code`";
    expect(preprocessWikilinks(input)).toBe(input);
  });

  it("keeps an embed whose filename contains a bracket", () => {
    // A tweet whose title was itself a markdown link produced this filename.
    // The old pattern forbade `]` inside the name, so it matched nothing and
    // the article rendered without a single image.
    const name = "[https escobedosoliz.net casa-nogal-esp.html…](https t.co z2hN1sQXGq) (image 1).jpg";
    const out = preprocessWikilinks(`![[${name}]]`);
    // Square brackets need no escape inside a markdown destination; the round
    // brackets do, and they are the ones that would close it early.
    expect(out).toBe(
      "![]([https%20escobedosoliz.net%20casa-nogal-esp.html…]%28https%20t.co%20z2hN1sQXGq%29%20%28image%201%29.jpg)",
    );
    expect(decodeLocalMarkdownUrl(out.slice(out.indexOf("](") + 2, -1))).toBe(name);
  });

  it("does not let an unclosed embed swallow the rest of the body", () => {
    const out = preprocessWikilinks("![[broken\nNogal House");
    expect(out).toBe("![[broken\nNogal House");
  });

});

describe("decodeLocalMarkdownUrl", () => {
  it("decodes local filenames with spaces and parens", () => {
    expect(decodeLocalMarkdownUrl("Title%20%28image%201%29.jpg")).toBe(
      "Title (image 1).jpg",
    );
  });

  it("decodes bare percent escapes back to the original filename", () => {
    expect(decodeLocalMarkdownUrl("50%25%20off.jpg")).toBe("50% off.jpg");
  });

  it("preserves unicode while decoding encoded separators", () => {
    expect(decodeLocalMarkdownUrl("Закат%20%28image%201%29.jpg")).toBe(
      "Закат (image 1).jpg",
    );
  });

  it("leaves remote URLs untouched", () => {
    const remote = "https://example.com/Title%20%28image%201%29.jpg";
    expect(decodeLocalMarkdownUrl(remote)).toBe(remote);
  });
});
