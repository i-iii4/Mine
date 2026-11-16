import { readFileSync } from "node:fs";
import type { Nodes } from "mdast";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preprocessWikilinks } from "@/lib/markdownWikilinks";
import { readingMdast } from "@/test/readingPipeline";
import { parseReadingSyntax } from "./syntax";
import { firstImageOffset, readingTree } from "./tree";

// The reading parser, watched: the tree of a body is made of one parse.
vi.mock("./syntax", async (importOriginal) => {
  const original = await importOriginal<typeof import("./syntax")>();
  return { ...original, parseReadingSyntax: vi.fn(original.parseReadingSyntax) };
});

/** The texts the reading parser was given since the watch was cleared. */
function parsedTexts(): string[] {
  return vi.mocked(parseReadingSyntax).mock.calls.map(([text]) => text);
}

function fixture(name: string): string {
  return readFileSync(`scripts/fixtures/${name}`, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** A body of text with pictures the clipper's way, each on its own line. */
function articleBody(seed: string): string {
  const paragraph = `Paragraph of ${seed} with **bold** text and a [link](https://example.com). `.repeat(6);
  return Array.from({ length: 12 }, (_, index) => `${paragraph}\n\n![[${seed} (image ${index + 1}).jpg]]`).join("\n\n");
}

beforeEach(() => {
  vi.mocked(parseReadingSyntax).mockClear();
});

// SPEC_READING_MODE.md, Ч0.5.
describe("readingTree", () => {
  it.each(["reading-mode.md", "list-of-images.md", "media-shapes.md"])("is the tree the pipeline's plugins give for the fixture %s", (name) => {
    const text = preprocessWikilinks(fixture(name));
    expect(readingTree(text)).toEqual(readingMdast(text));
  });

  it("parses a body with wikilinks once: the body as written, whole, and no text as long again", () => {
    const body = articleBody("one parse");
    const text = preprocessWikilinks(body);
    readingTree(text);
    const whole = parsedTexts().filter((parsed) => parsed.length >= body.length / 2);
    expect(whole).toEqual([body]);
  });

  it("parses a body without wikilinks once", () => {
    const body = articleBody("plain").replace(/!\[\[(.*?)\]\]/g, "![]($1)").replace(/ \(image/g, "-image").replace(/\)\.jpg/g, ".jpg");
    expect(preprocessWikilinks(body)).toBe(body);
    readingTree(body);
    expect(parsedTexts()).toEqual([body]);
  });

  it("keeps the tree: asked again, it parses nothing and gives the same tree", () => {
    const text = preprocessWikilinks(articleBody("kept"));
    const tree = readingTree(text);
    vi.mocked(parseReadingSyntax).mockClear();
    expect(readingTree(text)).toBe(tree);
    expect(parsedTexts()).toEqual([]);
  });

  it("parses the rendered text where the tree cannot be made of the body's parse", () => {
    // A link defined elsewhere resolves across the whole document.
    const body = "See [[note]] and [ref].\n\n[ref]: https://example.com\n";
    const text = preprocessWikilinks(body);
    expect(readingTree(text)).toEqual(readingMdast(text));
    expect(parsedTexts()).toEqual([body, text]);
  });

  it("holds callouts and note embeds as the article draws them", () => {
    const types = new Set<string>();
    const visit = (node: Nodes) => {
      types.add(node.type);
      if ("children" in node) node.children.forEach(visit);
    };
    visit(readingTree(preprocessWikilinks("> [!note] Title\n> Body\n\n![[Other note]]\n")));
    expect(types).toContain("callout");
    expect(types).toContain("noteEmbed");
    expect(types).not.toContain("blockquote");
  });
});

describe("firstImageOffset", () => {
  it("reads the kept tree of the rendered body", () => {
    const body = articleBody("lead").replace("(image 3).jpg", "(video 1).mp4");
    const text = preprocessWikilinks(body);
    readingTree(text);
    vi.mocked(parseReadingSyntax).mockClear();
    expect(firstImageOffset(text, (url) => url.endsWith(".mp4"))).toBe(text.indexOf("![](lead%20%28video"));
    expect(parsedTexts()).toEqual([]);
  });
});
