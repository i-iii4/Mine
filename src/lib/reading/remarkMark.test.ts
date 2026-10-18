import { describe, expect, it } from "vitest";
import type { Mark, Nodes } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkMark } from "./remarkMark";
import { parseReadingSyntax } from "./syntax";
import { hastElementsNamed, mdastNodesOfType, readingHast } from "@/test/readingPipeline";

function marks(markdown: string): Mark[] {
  return mdastNodesOfType<Mark>(parseReadingSyntax(markdown), "mark");
}

function text(node: Nodes): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map((child) => text(child)).join("") : "";
}

// SPEC_READING_MODE.md, Ч3: `==text==` by Obsidian's syntax.
describe("remarkMark", () => {
  it("marks text between two pairs of signs set close to it", () => {
    const [mark] = marks("a ==highlighted== b");
    expect(mark && text(mark)).toBe("highlighted");
  });

  it.each([
    ["spaces inside the pairs", "a == spaced == b"],
    ["one sign on each side", "a =one= b"],
    ["three signs on each side", "a ===three=== b"],
    ["an escaped opening pair", "a \\==escaped== b"],
    ["code in a line", "a `==code==` b"],
    ["a link's address", "[link](==target==)"],
    ["an empty mark", "a ==== b"],
    ["a comparison", "if a == b and c == d"],
  ])("leaves %s as text", (_case, markdown) => {
    expect(marks(markdown)).toEqual([]);
  });

  it("holds bold, a link and code inside it", () => {
    const [mark] = marks("==a **bold** [link](https://example.com) `code`==");
    expect(mark?.children.map((child) => child.type)).toEqual(["text", "strong", "text", "link", "text", "inlineCode"]);
  });

  it("marks inside a table cell and a heading", () => {
    expect(marks("| Head |\n|---|\n| ==cell== |")).toHaveLength(1);
    expect(marks("## A ==heading==")).toHaveLength(1);
  });

  it("knows where it stands in the source", () => {
    const source = "Lead ==mark== tail";
    const [mark] = marks(source);
    expect(source.slice(mark?.position?.start.offset, mark?.position?.end.offset)).toBe("==mark==");
  });

  it("is drawn as <mark>", () => {
    const [mark] = hastElementsNamed(readingHast("a ==b== c"), "mark");
    expect(mark?.children).toEqual([expect.objectContaining({ type: "text", value: "b" })]);
  });

  it("adds its syntax to any remark processor", () => {
    const tree = unified().use(remarkParse).use(remarkMark).parse("==alone==");
    expect(mdastNodesOfType<Mark>(tree, "mark")).toHaveLength(1);
  });
});
