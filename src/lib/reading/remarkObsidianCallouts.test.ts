import { describe, expect, it } from "vitest";
import type { Callout, Nodes, Paragraph, ListItem } from "mdast";
import { CALLOUT_TYPES, defaultCalloutTitle, resolveCalloutType, type CalloutType } from "./callouts";
import {
  CALLOUT_FOLD_PROPERTY,
  CALLOUT_PROPERTY,
  CALLOUT_WRITTEN_PROPERTY,
} from "./remarkObsidianCallouts";
import { mdastNodesOfType, readingMdast } from "@/test/readingPipeline";

function callouts(markdown: string): Callout[] {
  return mdastNodesOfType<Callout>(readingMdast(markdown), "callout");
}

function text(node: Nodes): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map((child) => text(child)).join("") : "";
}

function property(callout: Callout | undefined, name: string): unknown {
  return (callout?.data?.hProperties as Record<string, unknown> | undefined)?.[name];
}

const ALL_NAMES = (Object.entries(CALLOUT_TYPES) as [CalloutType, { aliases: readonly string[] }][])
  .flatMap(([type, { aliases }]) => [type, ...aliases].map((name) => [name, type] as const));

// SPEC_READING_MODE.md, Ч8.
describe("remarkObsidianCallouts", () => {
  it.each(ALL_NAMES)("draws [!%s] as the %s type", (name, type) => {
    const [callout] = callouts(`> [!${name}]\n> Body`);
    expect(property(callout, CALLOUT_PROPERTY)).toBe(type);
    expect(property(callout, CALLOUT_WRITTEN_PROPERTY)).toBe(name);
  });

  it("reads the type in any letter case", () => {
    expect(property(callouts("> [!WaRnInG] Title")[0], CALLOUT_PROPERTY)).toBe("warning");
    expect(resolveCalloutType("TIP")).toBe("tip");
  });

  it("draws a type Obsidian does not know as note, titled by its name", () => {
    const [callout] = callouts("> [!custom]\n> Body");
    expect(property(callout, CALLOUT_PROPERTY)).toBe("note");
    expect(text(callout!.children[0])).toBe("Custom");
  });

  it("titles a callout without a title by its type as written", () => {
    expect(text(callouts("> [!note]\n> Body")[0]!.children[0])).toBe("Note");
    expect(text(callouts("> [!faq]\n> Body")[0]!.children[0])).toBe("Faq");
    expect(defaultCalloutTitle("FAQ")).toBe("Faq");
  });

  it("folds by - and + and not without a sign", () => {
    expect(property(callouts("> [!tip]- Folded")[0], CALLOUT_FOLD_PROPERTY)).toBe("folded");
    expect(property(callouts("> [!tip]+ Unfolded")[0], CALLOUT_FOLD_PROPERTY)).toBe("unfolded");
    expect(property(callouts("> [!tip] Plain")[0], CALLOUT_FOLD_PROPERTY)).toBeUndefined();
  });

  it("keeps Markdown in the title", () => {
    const [callout] = callouts("> [!info] A **bold** [link](https://example.com) `code` ==mark== $x$\n> Body");
    expect(callout!.children[0].children.map((child) => child.type)).toEqual(
      ["text", "strong", "text", "link", "text", "inlineCode", "text", "mark", "text", "inlineMath"],
    );
  });

  it("gives the body on the title's second line its own place in the source", () => {
    const source = "> [!note] Title\n> Body line one\n> line two";
    const [callout] = callouts(source);
    const [paragraph] = callout!.children[1].children as Paragraph[];
    expect(text(callout!.children[0])).toBe("Title");
    expect(source.slice(paragraph?.position?.start.offset, paragraph?.position?.end.offset)).toBe("Body line one\n> line two");
    expect(paragraph?.position?.start.line).toBe(2);
    expect(text(paragraph!)).toBe("Body line one\nline two");
  });

  it("keeps the place of a body after a hard line break", () => {
    const source = "> [!note] Title  \n> Body";
    const [paragraph] = callouts(source)[0]!.children[1].children as Paragraph[];
    expect(source.slice(paragraph?.position?.start.offset, paragraph?.position?.end.offset)).toBe("Body");
  });

  it("is a title alone when the body is empty", () => {
    expect(callouts("> [!note] Only a title")[0]!.children[1].children).toEqual([]);
  });

  it("draws callouts inside callouts at any depth", () => {
    const found = callouts("> [!note] Outer\n> Text\n>\n> > [!warning] Inner\n> > Inner text\n> >\n> > > [!bug] Deepest");
    expect(found.map((callout) => property(callout, CALLOUT_PROPERTY))).toEqual(["note", "warning", "bug"]);
  });

  it("keeps a list in a callout with each item's place", () => {
    const source = "> [!todo] Tasks\n> - [ ] one\n> - [x] two";
    const items = mdastNodesOfType<ListItem>(callouts(source)[0]!, "listItem");
    expect(items.map((item) => source.slice(item.position?.start.offset, item.position?.end.offset))).toEqual(["- [ ] one", "- [x] two"]);
    expect(items.map((item) => item.checked)).toEqual([false, true]);
  });

  it("works inside a list and without a space after the marker", () => {
    expect(callouts("- item\n\n  > [!note] In a list")).toHaveLength(1);
    expect(callouts(">[!note] Tight")).toHaveLength(1);
  });

  it.each([
    ["the type not on the first line", "> Quote\n> [!note] Late"],
    ["no closing bracket", "> [!note Title"],
    ["a plain quote", "> Just a quote"],
  ])("leaves a quote with %s a quote", (_case, markdown) => {
    expect(callouts(markdown)).toEqual([]);
    expect(mdastNodesOfType(readingMdast(markdown), "blockquote")).toHaveLength(1);
  });
});
