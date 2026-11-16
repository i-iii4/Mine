import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cardOpenArticle } from "@/dev/cardOpenArticle";
import { preprocessWikilinksWithMap } from "@/lib/markdownWikilinks";
import { assembleRenderedTree } from "./renderedTree";
import { parseReadingSyntax } from "./syntax";

// SPEC_READING_MODE.md, Ч0.5: the rendered text's tree made of the parse of
// the body as written is the tree a parse of the rendered text gives, node
// for node and place for place, or it is not made at all.

/** The tree made for `body`, or `null` where it is not made. */
function made(body: string) {
  const { text, rewrites } = preprocessWikilinksWithMap(body);
  return assembleRenderedTree(parseReadingSyntax(body), body, text, rewrites);
}

/** The tree a parse of the rendered text gives. */
function parsed(body: string) {
  return parseReadingSyntax(preprocessWikilinksWithMap(body).text);
}

function fixture(name: string): string {
  return readFileSync(`scripts/fixtures/${name}`, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
}

describe("the rendered text's tree made of the body's parse", () => {
  it.each([
    ["a picture on a line of its own", "Before.\n\n![[Title (image 1).jpg]]\n\nAfter **bold**.\n"],
    ["a picture with a caption", "![[photo.jpg|a sunset]]"],
    ["links in a paragraph", "See [[note]] and [[other|the other]], then *more*.\n\nLast."],
    ["two lines of one paragraph", "First [[a]] line\nsecond [[b|B]] line\n\nNext paragraph."],
    ["a heading", "# About [[topic]]\n\nText.\n\n## Plain\n\nMore [[x]]."],
    ["a quote", "> Said [[who]]\n> twice\n\nAfter."],
    ["a table's cell", "| a | b |\n| --- | --- |\n| [[x]] | 1 |\n\nAfter."],
    ["a list before a paragraph", "- [[one]]\n- ![[two.png]]\n\n  nested [[three]]\n\nAfter the list."],
    ["a list at the end", "Intro.\n\n- [[one]]\n- [[two]]\n"],
    ["neighbours with rewrites read as one part", "![[a.png]]\n\n![[b.png]]\n\n- [[c]]\n\nPlain."],
    ["Windows line endings", "Before.\r\n\r\n![[a.png]] and [[b]]\r\n\r\nAfter.\r\n"],
    ["a wikilink in code beside one in text", "`[[a]]` and [[b]]\n\n```\n[[c]]\n```\n\nEnd [[d]]."],
    ["an indented first line", "Text.\n\n   [[a]] indented\n\nEnd."],
    ["a wikilink that makes a table of a paragraph", "![[a|b]]\n|---|\n\nAfter."],
    ["a name with a Markdown link in it", "![[[https example.com page…](https t.co abc) (image 1).jpg]]\n\nAfter."],
    ["a callout", "> [!note] About [[x]]\n> Body [[y]]\n\nAfter."],
  ])("equals the parsed tree for %s", (_what, body) => {
    const tree = made(body);
    expect(tree).not.toBeNull();
    expect(tree).toEqual(parsed(body));
  });

  it("gives the body's own tree when nothing was rewritten", () => {
    const body = "`[[a]]` only in code\n\n$[[1,2]]$\n";
    const source = parseReadingSyntax(body);
    const { text, rewrites } = preprocessWikilinksWithMap(body);
    expect(text).toBe(body);
    expect(assembleRenderedTree(source, body, text, rewrites)).toBe(source);
  });

  // Where a block read alone may not be what the whole text gives, the tree
  // is not made and the rendered text is parsed.
  it.each([
    ["a link defined elsewhere", "[[a]] and [ref]\n\n[ref]: https://example.com\n"],
    ["a footnote", "[[a]] with a note[^1]\n\n[^1]: The note.\n"],
    ["an empty wikilink, which leaves its line", "Before ![[]] after\n\nNext."],
    ["a list before an indented line", "10. [[one]]\n\n   three spaces in\n"],
    ["a list before another list", "- [[one]]\n\n* other\n"],
    ["code after the rewritten block, in its group", "See [[a]]:\n```\ncode\n```\n\nAfter."],
  ])("is not made for %s", (_what, body) => {
    expect(made(body)).toBeNull();
  });

  it.each(["reading-mode.md", "list-of-images.md", "media-shapes.md"])("equals the parsed tree for the fixture %s, or is not made", (name) => {
    const body = fixture(name);
    const tree = made(body);
    if (tree !== null) expect(tree).toEqual(parsed(body));
  });

  it("is made for an article as the clipper saves it", () => {
    const body = cardOpenArticle(100 * 1024);
    const tree = made(body);
    expect(tree).not.toBeNull();
    expect(tree).toEqual(parsed(body));
  });

  // Bodies put together from blocks of every kind, with and without
  // wikilinks, parted by one line ending or by a blank line: whatever the
  // order, the tree made is the parsed one or none.
  it("equals the parsed tree for generated bodies, or is not made", () => {
    const blocks = [
      "Plain paragraph with **bold** and `code`.",
      "A paragraph with [[link]] and [[other|label]] in it.",
      "![[picture one.jpg]]",
      "![[clip (1).mp4|caption]] trailing text",
      "# Heading with [[link]]",
      "## Plain heading",
      "- item [[a]]\n- item b\n  - nested ![[c.png]]",
      "1. first\n2. second [[x]]",
      "- [ ] task [[t]]\n- [x] done",
      "> quote [[q]]\n> more",
      "> [!warning] Title\n> body [[w]]",
      "| a | b |\n| --- | --- |\n| [[x]] | ![[y.png]] |",
      "| [[h|H]] | b |\n| --- | --- |\n| 1 | 2 |",
      "```js\nconst a = \"[[not a link]]\";\n```",
      "    indented [[code]]",
      "$$\n[[1,2],[3,4]]\n$$",
      "Formula $[[1]]$ and ==mark [[m]]== and ~~gone [[g]]~~.",
      "<div>\n[[in html]]\n</div>",
      "<kbd>[[k]]</kbd> inline html",
      "---",
      "Setext [[s]]\n===",
      "www.example.com [[after]] https://example.com/[[x]]",
      "Text with a hard break  \nand [[second]] line\\\nthird [[line]]",
      "*emphasis start* [[e]]",
      "[[start]] of a line and [[end]]",
      "![[a|b]]\n|---|",
      "[[]] empty and ![[ ]]",
      "Mixed `[[a]]` [[b]] $[[c]]$ ![[d.png]]",
    ];
    // The same numbers every run (mulberry32).
    let state = 7;
    const next = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    let madeCount = 0;
    const BODIES = 600;
    for (let index = 0; index < BODIES; index += 1) {
      const count = 1 + Math.floor(next() * 7);
      let body = "";
      for (let position = 0; position < count; position += 1) {
        const block = blocks[Math.floor(next() * blocks.length)] ?? "";
        const separator = position === 0 ? "" : next() < 0.75 ? "\n\n" : next() < 0.5 ? "\n" : "\n\n\n";
        body += separator + block;
      }
      if (next() < 0.5) body += "\n";
      if (next() < 0.1) body = body.replace(/\n/g, "\r\n");
      const tree = made(body);
      if (tree === null) continue;
      madeCount += 1;
      expect(tree, body).toEqual(parsed(body));
    }
    // The comparison is of something: most bodies get their tree made.
    expect(madeCount).toBeGreaterThan(BODIES / 2);
  });
});
