import { Text } from "@codemirror/state";
import { parseReadingSyntax } from "@/lib/reading/syntax";
import { READING_FIXTURE_BODY } from "@/test/editingFixture";
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
