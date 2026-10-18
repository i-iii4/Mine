import { calloutOpener, mineMarkdownParser, NODE } from "./syntax";

/** The nodes of `text` named `name`, as the text they cover. */
function nodes(text: string, name: string): string[] {
  const found: string[] = [];
  mineMarkdownParser.parse(text).iterate({
    enter(node) {
      if (node.name === name) found.push(text.slice(node.from, node.to));
    },
  });
  return found;
}

/** Every node name of `text`, in document order. */
function names(text: string): string[] {
  const found: string[] = [];
  mineMarkdownParser.parse(text).iterate({ enter(node) { found.push(node.name); } });
  return found;
}

describe("the editor's Markdown (SPEC_EDITING.md, Л0.5)", () => {
  it("reads strikethrough with one or two tildes, not three", () => {
    expect(nodes("a ~b~ c", NODE.Strikethrough)).toEqual(["~b~"]);
    expect(nodes("a ~~b~~ c", NODE.Strikethrough)).toEqual(["~~b~~"]);
    expect(nodes("a ~~~b~~~ c", NODE.Strikethrough)).toEqual([]);
    expect(nodes("a ~b~~ c", NODE.Strikethrough)).toEqual([]);
  });

  it("reads a highlight of exactly two signs on each side (Ч3)", () => {
    expect(nodes("an ==important== word", NODE.Highlight)).toEqual(["==important=="]);
    expect(nodes("==a **b**==", NODE.Highlight)).toEqual(["==a **b**=="]);
    expect(nodes("==a **b**==", "StrongEmphasis")).toEqual(["**b**"]);
    expect(nodes("one =a= three ===b===", NODE.Highlight)).toEqual([]);
    expect(nodes("\\==escaped==", NODE.Highlight)).toEqual([]);
    expect(nodes("== spaced ==", NODE.Highlight)).toEqual([]);
    expect(nodes("`==code==`", NODE.Highlight)).toEqual([]);
  });

  it("reads wikilinks and embeds up to the first ]] on their line (Ч0.2)", () => {
    expect(nodes("see [[Note]] and [[Other|label]]", NODE.Wikilink)).toEqual(["[[Note]]", "[[Other|label]]"]);
    expect(nodes("[[Other|label]]", NODE.WikilinkTarget)).toEqual(["Other"]);
    expect(nodes("[[Other|label]]", NODE.WikilinkLabel)).toEqual(["label"]);
    expect(nodes("![[photo.png]] and ![[Note|cap]]", NODE.WikilinkEmbed)).toEqual(["![[photo.png]]", "![[Note|cap]]"]);
    expect(nodes("[[name [with] brackets]]", NODE.Wikilink)).toEqual(["[[name [with] brackets]]"]);
    expect(nodes("[[not\nclosed]]", NODE.Wikilink)).toEqual([]);
    expect(nodes("[[]]", NODE.Wikilink)).toEqual([]);
  });

  it("leaves wikilinks in code, math and HTML as written", () => {
    expect(nodes("`[[x]]`", NODE.Wikilink)).toEqual([]);
    expect(nodes("$[[1,2],[3,4]]$", NODE.Wikilink)).toEqual([]);
    expect(nodes("```mermaid\nA[[Sub]] --> B\n```", NODE.Wikilink)).toEqual([]);
    expect(nodes("$$\n[[x]]\n$$", NODE.Wikilink)).toEqual([]);
  });

  it("reads $…$ by Obsidian's rule and $$…$$ in a line (Ч9)", () => {
    expect(nodes("It costs $5 and $10 today.", NODE.InlineMath)).toEqual([]);
    expect(nodes("a formula $x^2$ here", NODE.InlineMath)).toEqual(["$x^2$"]);
    expect(nodes("It costs $5 and $10, and $x^2$ is a formula", NODE.InlineMath)).toEqual(["$x^2$"]);
    expect(nodes("$ x $", NODE.InlineMath)).toEqual([]);
    expect(nodes("\\$5 and $a$", NODE.InlineMath)).toEqual(["$a$"]);
    expect(nodes("$a \\$ b$", NODE.InlineMath)).toEqual(["$a \\$ b$"]);
    expect(nodes("in a line $$a+b$$ too", NODE.InlineMath)).toEqual(["$$a+b$$"]);
    expect(nodes("$x^2$", NODE.InlineMathMark)).toEqual(["$", "$"]);
  });

  it("reads $$ blocks, in a blockquote too, and unclosed ones to the end", () => {
    expect(nodes("$$\n\\int_0^1 x\n$$\n\nafter", NODE.MathBlock)).toEqual(["$$\n\\int_0^1 x\n$$"]);
    expect(nodes("> $$\n> x\n> $$\n\nout", NODE.MathBlock)).toEqual(["$$\n> x\n> $$"]);
    expect(nodes("> $$\n> x\n\nout", NODE.MathBlock)).toEqual(["$$\n> x"]);
    expect(nodes("$$\nopen", NODE.MathBlock)).toEqual(["$$\nopen"]);
    expect(nodes("text\n$$\nx\n$$", NODE.MathBlock)).toEqual(["$$\nx\n$$"]);
    expect(nodes("$$x$$ alone", NODE.MathBlock)).toEqual([]);
  });

  it("reads footnote references and definitions (Ч10)", () => {
    expect(nodes("A sentence.[^1] Another[^note].", NODE.FootnoteReference)).toEqual(["[^1]", "[^note]"]);
    expect(nodes("[^1]: Text of the note with a [link](https://example.com).", NODE.FootnoteDefinition)).toEqual([
      "[^1]: Text of the note with a [link](https://example.com).",
    ]);
    expect(nodes("[^1]: Text", NODE.FootnoteDefinitionMark)).toEqual(["[^1]:"]);
    expect(nodes("[^1]: Text [link](https://example.com)", "Link")).toEqual(["[link](https://example.com)"]);
  });

  it("reads a block id at the end of a line after a space", () => {
    expect(nodes("A paragraph ^abc-1", NODE.BlockId)).toEqual(["^abc-1"]);
    expect(nodes("x^2 is not ^one here", NODE.BlockId)).toEqual([]);
  });

  it("reads GFM tables, task items and literal links", () => {
    expect(names("| a | b |\n|---|---|\n| 1 | 2 |")).toContain("Table");
    expect(nodes("- [ ] task\n- [x] done", "TaskMarker")).toEqual(["[ ]", "[x]"]);
    expect(nodes("see https://example.com/a now", "URL")).toEqual(["https://example.com/a"]);
  });

  it("recognises a callout by its blockquote's first line (Ч8)", () => {
    expect(calloutOpener("> [!note] Title")).toEqual({ type: "note", fold: "" });
    expect(calloutOpener(">[!TIP]- Folded")).toEqual({ type: "tip", fold: "-" });
    expect(calloutOpener("> > [!warning]+")).toEqual({ type: "warning", fold: "+" });
    expect(calloutOpener("> plain quote")).toBeNull();
    expect(calloutOpener("> [!unclosed")).toBeNull();
  });
});
