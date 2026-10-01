import { describe, it, expect } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import {
  decodeLocalMarkdownUrl,
  decodeWikilinkHref,
  firstImageOffset,
  inlineMediaOccurrenceIndex,
  preprocessWikilinks,
  markdownSourceByteOffset,
} from "./markdownWikilinks";

/** Where react-markdown's image nodes start in the rendered body, in order. */
function renderedImageOffsets(body: string): number[] {
  const offsets: number[] = [];
  function visit(node: Nodes) {
    if (node.type === "image" && node.position) offsets.push(node.position.start.offset ?? -1);
    if ("children" in node) node.children.forEach(visit);
  }
  visit(fromMarkdown(preprocessWikilinks(body)));
  return offsets;
}

describe("inlineMediaOccurrenceIndex", () => {
  // Г1.4: each rendered image names its own `![` in the source, whatever its
  // title, brackets, parentheses or spelling, and whatever stands before it.
  it.each([
    ["![a](p.jpg \"t1\")\n\n![b](p.jpg \"t2\")", [0, 1]],
    ["![a](<p q.jpg>)\n\n![b](<p q.jpg> 't')", [0, 1]],
    ["![a](Foo%20(1).jpg)\n\n![b](Foo%20(1).jpg (t))", [0, 1]],
    ["Intro ![[p.jpg]] mid ![x](p.jpg) end ![y](./p%2Ejpg)", [0, 1, 2]],
    ["[[Заметка]] 😀 `![` code ![a](p.jpg) ![[Фото (1).jpg|подпись]]", [1, 2]],
  ])("names the clicked image of %s by its opener", (body, expected) => {
    const offsets = renderedImageOffsets(body);
    expect(offsets.map((offset) => inlineMediaOccurrenceIndex(body, offset))).toEqual(expected);
  });

  it("names no opener for an offset that is not an image", () => {
    const body = "Text ![a](p.jpg)";
    expect(inlineMediaOccurrenceIndex(body, 0)).toBeNull();
  });
});

describe("firstImageOffset", () => {
  it("finds the first image of a source in document order", () => {
    const body = "![a](other.jpg) ![[clip.mp4|lead]]\n\n![b](clip.mp4 \"t\")";
    const rendered = preprocessWikilinks(body);
    const offset = firstImageOffset(rendered, (url) => url === "clip.mp4");
    expect(offset).toBe(rendered.indexOf("![lead]"));
    expect(firstImageOffset(rendered, (url) => url === "missing.mp4")).toBeNull();
  });
});

describe("selection source offsets", () => {
  it.each(["![[Media/Камень (1).jpg]]", "[[Заметка|ссылка]]", "😀 русский текст"])("maps a repeated paragraph after %s to UTF-8 source bytes", (prefix) => {
    const body = `${prefix}\n\nAuthor: @test\n\nAuthor: @test`;
    const rendered = preprocessWikilinks(body);
    const offset = rendered.lastIndexOf("Author:");
    expect(markdownSourceByteOffset(body, offset)).toBe(new TextEncoder().encode(body.slice(0, body.lastIndexOf("Author:"))).length);
    expect(markdownSourceByteOffset(body, rendered.length)).toBe(new TextEncoder().encode(body).length);
  });
  it("maps text after multiple inline rewrites without accepting a position inside one", () => {
    const body = "[[один]] and [[два|alias]] **bold**";
    const rendered = preprocessWikilinks(body);
    expect(markdownSourceByteOffset(body, rendered.indexOf("**bold**"))).toBe(new TextEncoder().encode(body.slice(0, body.indexOf("**bold**"))).length);
    expect(markdownSourceByteOffset(body, 2)).toBeNull();
    expect(markdownSourceByteOffset(body, rendered.length + 1)).toBeNull();
  });
});

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
    expect(preprocessWikilinks("see [[note]]")).toBe("see [note](#mine-wikilink:note)");
  });

  it("uses display text from pipe in text wikilink", () => {
    expect(preprocessWikilinks("see [[note|my note]]")).toBe(
      "see [my note](#mine-wikilink:note)"
    );
  });

  it("rewrites multiple wikilinks in one body", () => {
    const input = "![[a.jpg]]\n\n![[b (2).mp4|b alt]]\n\n[[c]]";
    const expected =
      "![](a.jpg)\n\n![b alt](b%20%282%29.mp4)\n\n[c](#mine-wikilink:c)";
    expect(preprocessWikilinks(input)).toBe(expected);
  });

  it("leaves ordinary markdown untouched", () => {
    const input = "![alt](photo.jpg)\n\n[link](https://example.com)";
    expect(preprocessWikilinks(input)).toBe(input);
  });

  it("keeps wiki target, alias and anchor separate from ordinary markdown links", () => {
    const rendered = preprocessWikilinks("[[Notes/Peer#Heading|my peer]] [external](https://example.com)");
    expect(rendered).toBe("[my peer](#mine-wikilink:Notes%2FPeer%23Heading) [external](https://example.com)");
    expect(decodeWikilinkHref("#mine-wikilink:Notes%2FPeer%23Heading")).toBe("Notes/Peer#Heading");
    expect(decodeWikilinkHref("https://example.com")).toBeNull();
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
