import { describe, expect, it } from "vitest";
import type { InlineMath, Math as MathNode } from "mdast-util-math";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkObsidianInlineMath } from "./remarkObsidianInlineMath";
import { parseReadingSyntax } from "./syntax";
import { mdastNodesOfType } from "@/test/readingPipeline";

function formulas(markdown: string): string[] {
  return mdastNodesOfType<InlineMath>(parseReadingSyntax(markdown), "inlineMath").map((node) => node.value);
}

// SPEC_READING_MODE.md, Ч9: `$` opens before a non-space and closes after
// one; `remark-math` reads only `$$`.
describe("remarkObsidianInlineMath", () => {
  it("reads a formula set close to its dollars", () => {
    expect(formulas("Then $a^2$ holds.")).toEqual(["a^2"]);
  });

  it("leaves prices as text", () => {
    expect(formulas("It costs $5 and $10 today.")).toEqual([]);
  });

  it("finds the formula after prices in the same line", () => {
    expect(formulas("It costs $5 and $10, and $x^2$ is a formula.")).toEqual(["x^2"]);
  });

  it.each([
    ["a dollar before a space", "$ x $"],
    ["an escaped dollar", "\\$5 and 10$"],
    ["a single dollar", "Only $ here"],
    ["two dollars with nothing between", "a $$ b"],
  ])("leaves %s as text", (_case, markdown) => {
    expect(formulas(markdown)).toEqual([]);
  });

  it("leaves code in a line alone", () => {
    expect(formulas("`$a$`")).toEqual([]);
  });

  it("keeps TeX's escaped dollar inside a formula", () => {
    expect(formulas("$a\\$b$")).toEqual(["a\\$b"]);
  });

  it("reads `$$…$$` in a line by remark-math", () => {
    expect(formulas("Inline $$a+b$$ here")).toEqual(["a+b"]);
  });

  it("reads `$$` on lines of their own as a block", () => {
    const blocks = mdastNodesOfType<MathNode>(parseReadingSyntax("$$\n\\int x\n$$"), "math");
    expect(blocks.map((node) => node.value)).toEqual(["\\int x"]);
  });

  it("knows where the formula stands", () => {
    const source = "Lead $x$ tail";
    const [node] = mdastNodesOfType<InlineMath>(parseReadingSyntax(source), "inlineMath");
    expect(source.slice(node?.position?.start.offset, node?.position?.end.offset)).toBe("$x$");
  });

  it("reads single dollars after remark-math, whose mdast extension builds the node", () => {
    const tree = unified().use(remarkParse).use(remarkMath, { singleDollarTextMath: false }).use(remarkObsidianInlineMath).parse("$5 and $x$");
    expect(mdastNodesOfType<InlineMath>(tree, "inlineMath").map((node) => node.value)).toEqual(["x"]);
  });
});
