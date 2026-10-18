import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SYSTEM_MONO_STACK } from "@/lib/fontChoice";

const article = readFileSync("src/styles/article.css", "utf8");

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(article);
  if (!match?.[1]) throw new Error(`no rule ${selector} in article.css`);
  return match[1];
}

// SPEC_READING_MODE.md, Ч0.4 to Ч12: the article's stylesheet, by the class
// of its root.
describe("article.css", () => {
  it("is imported by the app's stylesheet", () => {
    expect(readFileSync("src/styles/global.css", "utf8")).toContain('@import "./article.css";');
  });

  it("sets code in the system monospace, whatever the interface font (Ч2)", () => {
    expect(rule(".mine-article")).toContain(`--article-code-font: ${SYSTEM_MONO_STACK};`);
  });

  it("breaks a long word anywhere and hyphenates nothing (Ч1)", () => {
    expect(rule(".mine-article")).toMatch(/overflow-wrap: anywhere;[\s\S]*hyphens: manual;/);
  });

  it("draws code in a line without backticks, at 400, on the quiet fill (Ч2)", () => {
    const code = rule(".mine-article :not(pre) > code");
    expect(code).toContain("font-family: var(--article-code-font);");
    expect(code).toContain("font-size: calc(12em / 14);");
    expect(code).toContain("font-weight: 400;");
    expect(code).toContain("background-color: var(--component-fill);");
    expect(code).toContain("border-radius: var(--radius-1);");
    expect(code).toContain("padding-inline: var(--spacing-s1);");
    expect(rule(".mine-article code::before,\n.mine-article code::after")).toContain("content: none;");
  });

  it("marks with the search's yellow, lying on the text (Ч3)", () => {
    const mark = rule(".mine-article mark");
    expect(mark).toContain("background-color: var(--search-mark);");
    expect(mark).toContain("color: var(--search-mark-foreground);");
    expect(mark).toContain("padding: 0;");
  });

  it("draws a key as the tooltip's key in the primary step (Ч4)", () => {
    const kbd = rule(".mine-article kbd");
    expect(kbd).toContain("font-family: var(--font-sans);");
    expect(kbd).toContain("background-color: var(--component-fill);");
    expect(kbd).toContain("color: var(--foreground);");
    expect(kbd).toContain("box-shadow: none;");
  });

  it("lays a table's cells from the top on 1 px lines, the header like the body (Ч5.2)", () => {
    const cells = rule(".mine-article :is(th, td)");
    expect(cells).toContain("padding: calc(var(--spacing) * 1.5) var(--spacing-plate);");
    expect(cells).toContain("border: 1px solid var(--border);");
    expect(cells).toContain("vertical-align: top;");
    expect(rule(".mine-article th")).toContain("font-weight: 400;");
    expect(rule(".mine-article table")).toContain("width: auto;");
  });

  it("colours highlighting from --code-* variables and the block's own text only (Ч6.4)", () => {
    const highlight = article.match(/\[data-code-block\][^{]*\{ color: [^}]+\}/g) ?? [];
    expect(highlight.length).toBeGreaterThan(10);
    for (const line of highlight) {
      expect(line).toMatch(/\{ color: var\(--(?:code-[a-z]+|tw-prose-pre-code)\);(?: background-color: var\(--code-[a-z]+-fill\);| font-(?:weight: 600|style: italic);)? \}$/);
    }
  });

  it("gives a note embed's button the feed card's frame under the pointer and in focus (Ч11.7)", () => {
    expect(rule(".mine-article [data-note-embed-open]:is(:hover, :focus-visible) [data-feed-card-frame]"))
      .toContain("--card-frame-color: var(--border-accent);");
    expect(rule(".mine-article [data-note-embed-open]:focus-visible [data-card-media-clip] > [data-card-lift=\"window\"]::after"))
      .toContain("opacity: 1;");
  });

  it("sets footnotes under a line in the small secondary step (Ч10)", () => {
    const footnotes = rule(".mine-article section[data-footnotes]");
    expect(footnotes).toContain("border-top: 1px solid var(--border);");
    expect(footnotes).toContain("font-size: var(--text-sm);");
    expect(footnotes).toContain("line-height: var(--text-sm--line-height);");
    expect(footnotes).toContain("color: var(--muted-foreground);");
  });

  it("stands a note embed on a line of its own, centred (Ч11.3)", () => {
    const embed = rule(".mine-article [data-note-embed]");
    expect(embed).toContain("justify-content: center;");
    expect(embed).toContain("margin-block: calc(var(--spacing) * 5);");
  });

  it("strikes a done task through in the secondary step (Ч12.1)", () => {
    const done = rule('.mine-article li[data-task-item][data-task-checked="true"] > [data-task-text]');
    expect(done).toContain("color: var(--muted-foreground);");
    expect(done).toContain("text-decoration: line-through;");
  });
});
