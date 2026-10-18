import { describe, expect, it } from "vitest";
import type { Element, Nodes } from "hast";
import { codeLanguage, highlightCode } from "./highlight";

function classes(tree: Nodes): string[] {
  const found: string[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "element") found.push(...((node as Element).properties?.className as string[] | undefined ?? []));
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return found;
}

// SPEC_READING_MODE.md, Ч6.4.
describe("highlightCode", () => {
  it("highlights a known language into hljs classes", async () => {
    const tree = await highlightCode("const answer = 42;", "typescript");
    expect(tree && classes(tree)).toEqual(expect.arrayContaining(["hljs-keyword", "hljs-number"]));
  });

  it.each(["ts", "tsx", "js", "jsx", "py", "sh"])("knows the alias %s", async (alias) => {
    expect(await highlightCode("x", alias)).not.toBeNull();
  });

  it("leaves an unknown language and none as plain text", async () => {
    expect(await highlightCode("graph TD", "mermaid-unknown")).toBeNull();
    expect(await highlightCode("plain", null)).toBeNull();
  });

  it("reads the language from a fence's info string", () => {
    expect(codeLanguage("TS {1,3}")).toBe("ts");
    expect(codeLanguage("  ")).toBeNull();
    expect(codeLanguage(undefined)).toBeNull();
  });
});
