import { describe, expect, it } from "vitest";
import type { Nodes } from "hast";
import { READING_SANITIZE_SCHEMA } from "./pipeline";
import { hastText } from "./hast";
import { hastElementsNamed, readingHast } from "@/test/readingPipeline";

function allProperties(tree: Nodes): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "element") found.push(node.properties ?? {});
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return found;
}

// SPEC_READING_MODE.md, Ч4: the note's HTML after `rehype-raw` and
// `rehype-sanitize` with the pipeline's schema.
describe("the reading sanitizer", () => {
  it.each([
    ["script", "<script>window.x = 1</script>"],
    ["style", "<style>body { color: red }</style>"],
    ["iframe", "<iframe src=\"https://example.com\"></iframe>"],
    ["object", "<object data=\"x.swf\"></object>"],
    ["form", "<form><input name=\"q\"></form>"],
    ["video", "<video src=\"clip.mp4\"></video>"],
    ["audio", "<audio src=\"song.mp3\"></audio>"],
  ])("removes %s with its content", (tag, html) => {
    const tree = readingHast(`Before\n\n${html}\n\nAfter`);
    expect(hastElementsNamed(tree, tag)).toEqual([]);
    expect(hastText(tree)).not.toMatch(/window\.x|color: red/);
  });

  it("removes event handlers, style and foreign classes", () => {
    const tree = readingHast("<img src=\"p.png\" onerror=\"alert(1)\" style=\"width: 9px\" class=\"evil\">");
    const [image] = hastElementsNamed(tree, "img");
    expect(image?.properties).toEqual({ src: "p.png" });
  });

  it("removes comments", () => {
    const tree = readingHast("Text <!-- hidden --> more");
    expect(JSON.stringify(tree)).not.toContain("hidden");
  });

  it.each(["kbd", "sub", "sup", "mark", "u", "ins", "del", "s", "details", "summary"])("keeps <%s>", (tag) => {
    const html = tag === "summary" ? "<details><summary>S</summary>x</details>" : `<${tag}>x</${tag}>`;
    expect(hastElementsNamed(readingHast(`a ${html} b`), tag)).toHaveLength(1);
  });

  it("keeps <abbr> with its title", () => {
    const [abbr] = hastElementsNamed(readingHast("<abbr title=\"HyperText\">HTML</abbr>"), "abbr");
    expect(abbr?.properties?.title).toBe("HyperText");
  });

  it("prefixes ids once against clobbering", () => {
    const [span] = hastElementsNamed(readingHast("<span id=\"top\">x</span>"), "span");
    expect(span?.properties?.id).toBe("user-content-top");
    const ids = allProperties(readingHast("Ref[^1]\n\n[^1]: Note")).map((properties) => properties.id).filter(Boolean);
    expect(ids).toEqual(["user-content-fnref-1", "user-content-footnote-label", "user-content-fn-1"]);
  });

  it("keeps the classes of math and of GFM's task lists", () => {
    const [code] = hastElementsNamed(readingHast("$x$"), "code");
    expect(code?.properties?.className).toEqual(["language-math", "math-inline"]);
    const [list] = hastElementsNamed(readingHast("- [ ] task"), "ul");
    expect(list?.properties?.className).toEqual(["contains-task-list"]);
  });

  it("keeps the places of Markdown blocks in the source", () => {
    const markdown = "First\n\n<kbd>K</kbd> second\n\n> Quote";
    const [first, second] = hastElementsNamed(readingHast(markdown), "p");
    expect(markdown.slice(first?.position?.start.offset, first?.position?.end.offset)).toBe("First");
    expect(markdown.slice(second?.position?.start.offset, second?.position?.end.offset)).toBe("<kbd>K</kbd> second");
  });

  it("checks no protocols itself: safeMarkdownUrl does, as for Markdown", () => {
    expect(READING_SANITIZE_SCHEMA.protocols).toEqual({});
    const [image] = hastElementsNamed(readingHast("![](Screenshot 10:30.png)".replace(" ", "%20")), "img");
    expect(image?.properties?.src).toBe("Screenshot%2010:30.png");
  });
});
