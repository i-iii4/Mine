import { describe, expect, it } from "vitest";
import { matchHeading, parseArticleAnchor, sourceHeadings, stripHeading } from "./anchors";

// SPEC_READING_MODE.md, Ч11.8: a place in a note, found as Obsidian 1.13.7
// finds it (`resolveSubpath`, `stripHeading`, its metadata cache).
describe("parseArticleAnchor", () => {
  it("reads a heading, a path of headings and a block", () => {
    expect(parseArticleAnchor("Plan")).toEqual({ kind: "heading", path: ["Plan"] });
    expect(parseArticleAnchor("Plan#Steps")).toEqual({ kind: "heading", path: ["Plan", "Steps"] });
    expect(parseArticleAnchor("#Plan##Steps#")).toEqual({ kind: "heading", path: ["Plan", "Steps"] });
    expect(parseArticleAnchor("^c0ffee")).toEqual({ kind: "block", id: "c0ffee" });
    expect(parseArticleAnchor("^ c0ffee ")).toEqual({ kind: "block", id: "c0ffee" });
  });

  it("names no place when there is none to jump to", () => {
    expect(parseArticleAnchor("")).toBeNull();
    expect(parseArticleAnchor("##")).toBeNull();
    expect(parseArticleAnchor("^")).toBeNull();
    // A footnote of the note: the article does not jump to it.
    expect(parseArticleAnchor("[^1]")).toBeNull();
  });

  it("reads a ^ past the first part as a heading, as Obsidian does", () => {
    expect(parseArticleAnchor("Plan#^c0ffee")).toEqual({ kind: "heading", path: ["Plan", "^c0ffee"] });
  });
});

describe("stripHeading", () => {
  it("takes Obsidian's special characters out and folds the spaces", () => {
    expect(stripHeading("Ideas: A/B")).toBe("Ideas A B");
    expect(stripHeading("**Bold** and [[Peer|alias]]")).toBe("Bold and Peer alias");
    expect(stripHeading("  Задачи   (план)  ")).toBe("Задачи план");
    expect(stripHeading("`code` ==mark== #tag ^id")).toBe("code mark tag id");
  });

  it("keeps what Obsidian keeps: dashes, underscores, apostrophes, letters", () => {
    expect(stripHeading("snake_case - it's Ёлка")).toBe("snake_case - it's Ёлка");
  });
});

describe("matchHeading", () => {
  const headings = [
    { level: 1, text: "Note" },
    { level: 2, text: "Steps" },
    { level: 2, text: "Plan: A/B" },
    { level: 3, text: "Steps" },
    { level: 2, text: "Other" },
    { level: 3, text: "Deep" },
  ];

  it("finds the first heading of the text, letter case and special characters aside", () => {
    expect(matchHeading(headings, ["Steps"])).toBe(1);
    expect(matchHeading(headings, ["plan a b"])).toBe(2);
    expect(matchHeading(headings, ["PLAN: A/B"])).toBe(2);
  });

  it("walks a path: each part a heading deeper than the one before", () => {
    expect(matchHeading(headings, ["Plan A B", "Steps"])).toBe(3);
    expect(matchHeading(headings, ["Note", "Other", "Deep"])).toBe(5);
    // Not deeper: a heading of the same level does not continue the path.
    expect(matchHeading(headings, ["Steps", "Plan A B"])).toBeNull();
  });

  it("finds nothing when a part matches no heading", () => {
    expect(matchHeading(headings, ["Missing"])).toBeNull();
    expect(matchHeading(headings, ["Plan A B", "Missing"])).toBeNull();
    expect(matchHeading(headings, [])).toBeNull();
  });
});

describe("sourceHeadings", () => {
  it("keeps the note's own headings with their text as written", () => {
    const body = "# Title ##\n\nText\n\n## Plan [[Peer|p]] **now**\n\nSetext\n---\n\n###\n";
    expect(sourceHeadings(body)).toEqual([
      { level: 1, text: "Title", start: 0 },
      { level: 2, text: "Plan [[Peer|p]] **now**", start: body.indexOf("## Plan") },
      { level: 2, text: "Setext", start: body.indexOf("Setext") },
      { level: 3, text: "", start: body.indexOf("###") },
    ]);
  });

  it("leaves out headings inside a quote, a callout or a list, as Obsidian's cache does", () => {
    const body = "> ## Quoted\n\n> [!note] Callout\n> ## In callout\n\n- ## In list\n\n## Own";
    expect(sourceHeadings(body).map((heading) => heading.text)).toEqual(["Own"]);
  });

  it("does not read a # in code as a heading", () => {
    expect(sourceHeadings("```\n# not a heading\n```\n\n## Real")).toEqual([
      { level: 2, text: "Real", start: "```\n# not a heading\n```\n\n".length },
    ]);
  });
});
