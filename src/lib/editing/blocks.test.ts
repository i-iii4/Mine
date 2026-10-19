import { Text } from "@codemirror/state";
import { parseReadingSyntax } from "@/lib/reading/syntax";
import { LIST_OF_IMAGES_BODY, MEDIA_SHAPES_BODY, READING_FIXTURE_BODY } from "@/test/editingFixture";
import { blockSource, collectBlocks, containerPrefixLength, type EditorBlock } from "./blocks";
import { mineMarkdownParser } from "./syntax";

/** The kind of block the reading pipeline's tree names each editor node. */
const READING_TYPE: Record<string, string> = {
  Paragraph: "paragraph",
  ATXHeading1: "heading",
  ATXHeading2: "heading",
  ATXHeading3: "heading",
  ATXHeading4: "heading",
  ATXHeading5: "heading",
  ATXHeading6: "heading",
  SetextHeading1: "heading",
  SetextHeading2: "heading",
  BulletList: "list",
  OrderedList: "list",
  Blockquote: "blockquote",
  FencedCode: "code",
  CodeBlock: "code",
  MathBlock: "math",
  Table: "table",
  HTMLBlock: "html",
  CommentBlock: "html",
  HorizontalRule: "thematicBreak",
  FootnoteDefinition: "footnoteDefinition",
  LinkReference: "definition",
};

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** The top-level blocks of `body` as `kind@line`, by the editor's parser. */
function editorSegments(body: string): string[] {
  const segments: string[] = [];
  for (let node = mineMarkdownParser.parse(body).topNode.firstChild; node; node = node.nextSibling) {
    segments.push(`${READING_TYPE[node.name] ?? node.name}@${lineOf(body, node.from)}`);
  }
  return segments;
}

/** The top-level blocks of `body` as `kind@line`, by the reading pipeline. */
function readingSegments(body: string): string[] {
  return parseReadingSyntax(body).children.map((node) => `${node.type}@${lineOf(body, node.position?.start.offset ?? 0)}`);
}

function blocksOfText(body: string): { doc: Text; blocks: EditorBlock[] } {
  const doc = Text.of(body.split("\n"));
  return { doc, blocks: collectBlocks(mineMarkdownParser.parse(body), doc) };
}

function describeBlocks(body: string): string[] {
  const { doc, blocks } = blocksOfText(body);
  return blocks.map((block) => `${block.kind}@${doc.lineAt(block.from).number}-${doc.lineAt(block.to).number}`);
}

describe("the parity corpus of blocks (SPEC_EDITING.md, Л6, Л11.1)", () => {
  it("finds the same blocks, of the same kinds, at the same lines as the reading pipeline on the fixture", () => {
    expect(editorSegments(READING_FIXTURE_BODY)).toEqual(readingSegments(READING_FIXTURE_BODY));
  });

  it.each([
    ["setext headings", "Title\n=====\n\nSub\n---\n"],
    ["indented code", "text\n\n    code\n    more\n"],
    ["a table after a paragraph", "para\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"],
    ["math in a quote", "> $$\n> x\n> $$\n"],
    ["a footnote and a link reference", "Text[^a].\n\n[^a]: Note.\n\n[ref]: https://example.com\n"],
    ["HTML around Markdown", "<details>\n<summary>S</summary>\n\nBody **b**.\n\n</details>\n"],
  ])("agrees on %s", (_name, body) => {
    expect(editorSegments(body)).toEqual(readingSegments(body));
  });
});

describe("collectBlocks (Л6, Л8)", () => {
  it("finds every block the fixture draws as a widget", () => {
    const blocks = describeBlocks(READING_FIXTURE_BODY);
    // Callouts, code, Mermaid, tables, the formula, HTML and the embeds.
    expect(blocks.filter((block) => block.startsWith("callout"))).toHaveLength(21);
    expect(blocks.filter((block) => block.startsWith("code"))).toHaveLength(7);
    expect(blocks.filter((block) => block.startsWith("mermaid"))).toHaveLength(6);
    expect(blocks.filter((block) => block.startsWith("table"))).toHaveLength(7);
    expect(blocks).toContain("math@211-213");
    // `<details>`, its Markdown and `</details>` are one element.
    expect(blocks).toContain("html@215-220");
    expect(blocks).toContain("media@333-333");
    expect(blocks).toContain("media@335-335");
    expect(blocks).toContain("media@337-337");
    // An embed between words stays in its line.
    expect(blocks).not.toContain("media@339-339");
    // A plain quote is lines, its nested quote too.
    expect(blocks.some((block) => block.endsWith("@37-41"))).toBe(false);
  });

  it("finds blocks inside list items and quotes, with their containers", () => {
    const body = "- item\n  ```js\n  code\n  ```\n\n> quote\n> | a |\n> |---|\n> | 1 |\n";
    const { blocks } = blocksOfText(body);
    expect(blocks.map((block) => [block.kind, block.containers.map((container) => container.kind)])).toEqual([
      ["code", ["item"]],
      ["table", ["quote"]],
    ]);
  });

  it("collects only the blocks of a range", () => {
    const { doc, blocks } = blocksOfText(READING_FIXTURE_BODY);
    const table = blocks.find((block) => block.kind === "table");
    if (!table) throw new Error("the fixture has a table");
    const inRange = collectBlocks(mineMarkdownParser.parse(READING_FIXTURE_BODY), doc, table.from, table.to);
    expect(inRange).toEqual([table]);
  });
});

describe("a block's source (Л8.1)", () => {
  it("takes the markers of its quotes and the indentation of its list items off every line", () => {
    expect(containerPrefixLength("> > text", [{ kind: "quote", contentColumn: 0 }, { kind: "quote", contentColumn: 0 }])).toBe(4);
    expect(containerPrefixLength("    code", [{ kind: "item", contentColumn: 2 }])).toBe(2);
    expect(containerPrefixLength("\tcode", [{ kind: "item", contentColumn: 2 }])).toBe(1);
    expect(containerPrefixLength("", [{ kind: "item", contentColumn: 2 }])).toBe(0);
  });

  it("maps a place in the source back to the document", () => {
    const body = "> [!note] Title\n> - [ ] task\n> text";
    const { doc, blocks } = blocksOfText(body);
    const [callout] = blocks;
    if (!callout) throw new Error("one callout");
    const outer = blockSource(doc, callout);
    expect(outer.text).toBe(body);
    const nested = "- item\n  ```js\n  let x;\n  ```";
    const nestedBlocks = blocksOfText(nested);
    const [code] = nestedBlocks.blocks;
    if (!code) throw new Error("one code block");
    const source = blockSource(nestedBlocks.doc, code);
    expect(source.text).toBe("```js\nlet x;\n```");
    const letAt = source.text.indexOf("let");
    expect(nested.slice(source.toDocument(letAt), source.toDocument(letAt) + 3)).toBe("let");
  });
});

describe("the limitation of a table in a mixed body (SPEC_EDITING.md, Л9, «Ограничение О1»)", () => {
  // A body of mixed line endings keeps the `\r` before `\n` as a sign of its
  // line (Л0.3). `@lezer/markdown` 1.7.2 takes no table whose header row or
  // delimiter row ends with that sign; the reading mode reads `\r\n` as a
  // line ending and draws the table. This test pins the behaviour: when the
  // parser takes such a table, the limitation and this test go.
  it("does not see a table whose header or delimiter row ends with a lone \\r, which the reading mode draws", () => {
    const delimiterCr = "Абзац.\n\n| a | b |\n|---|---|\r\n| 1 | 2 |\n";
    expect(describeBlocks(delimiterCr)).toEqual([]);
    expect(editorSegments(delimiterCr)).toEqual(["paragraph@1", "paragraph@3"]);
    expect(readingSegments(delimiterCr)).toEqual(["paragraph@1", "table@3"]);
    const headerCr = "Абзац.\n\n| a | b |\r\n|---|---|\n| 1 | 2 |\n";
    expect(describeBlocks(headerCr)).toEqual([]);
    expect(readingSegments(headerCr)).toEqual(["paragraph@1", "table@3"]);
  });

  it("sees the table when only its body rows end with \\r", () => {
    const rowsCr = "Абзац.\r\n\r\n| a | b |\n|---|---|\n| 1 | 2 |\r\n| 3 | 4 |\r\n";
    expect(describeBlocks(rowsCr)).toEqual(["table@3-6"]);
    expect(readingSegments(rowsCr)).toEqual(["paragraph@1", "table@3"]);
  });
});

describe("pictures in lists, paragraphs and quotes (SPEC_READING_MODE.md, Ч15; SPEC_EDITING.md, Л8.6)", () => {
  it("draws every picture of the clipper's list as a widget that starts its item", () => {
    const { doc, blocks } = blocksOfText(LIST_OF_IMAGES_BODY);
    const items = blocks.filter((block) => block.kind === "media" && block.containers.length === 1 && block.containers[0]?.kind === "item");
    expect(items).toHaveLength(20);
    expect(items.every((block) => block.startsItem)).toBe(true);
    expect(items.map((block) => doc.lineAt(block.from).number)).toEqual(Array.from({ length: 20 }, (_, index) => index + 3));
  });

  it("takes pictures parted by hard line breaks and by the lines of their quote as one paragraph of pictures", () => {
    expect(describeBlocks("![[a.png]]  \n![[b.png]]\\\n![[c.png]]")).toEqual(["media@1-3"]);
    expect(describeBlocks("> ![[a.png]]\n> ![[b.png]]")).toEqual(["media@1-2"]);
    expect(describeBlocks("![[a.png]]\n![[b.png]] and words")).toEqual([]);
    expect(describeBlocks("> ![[a.png]]\n> words")).toEqual([]);
  });

  it("says a block starts its item only on the item's first line", () => {
    const { blocks } = blocksOfText("- ![[a.png]]\n\n  ![[b.png]]\n1. ![[c.png]]\n- text\n  ```js\n  x\n  ```");
    expect(blocks.map((block) => [block.kind, block.startsItem])).toEqual([
      ["media", true],
      ["media", false],
      ["media", true],
      ["code", false],
    ]);
    expect(blocksOfText("![[a.png]]").blocks.map((block) => block.startsItem)).toEqual([false]);
  });

  it("finds the same pictures on the shapes note as the reading mode's paragraphs and items of pictures", () => {
    const { blocks } = blocksOfText(MEDIA_SHAPES_BODY);
    // Shapes 1 to 21 and 23 and the note embed stand on rows of their own;
    // 22 among words.
    const media = blocks.filter((block) => block.kind === "media");
    expect(media.map((block) => MEDIA_SHAPES_BODY.slice(block.from, block.to).match(/shape \d+|Пример заметки/g)?.join(" "))).toEqual([
      "shape 1", "shape 2", "shape 3", "shape 4", "shape 5", "shape 6", "shape 7", "shape 8", "shape 9",
      "shape 10", "shape 11", "shape 12 shape 13", "shape 14 shape 15 shape 16", "shape 17 shape 18",
      "shape 19", "shape 20", "shape 23", "Пример заметки", "shape 21",
    ]);
  });
});
