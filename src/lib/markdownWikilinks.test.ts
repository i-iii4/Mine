import { describe, it, expect } from "vitest";
import { preprocessWikilinks } from "./markdownWikilinks";

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
});
