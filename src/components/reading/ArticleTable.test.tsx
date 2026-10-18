import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { ArticleMarkdown } from "./ArticleMarkdown";
import { ArticleTable } from "./ArticleTable";
import { hastElementsNamed, readingHast } from "@/test/readingPipeline";
import { NoteEmbedLookups } from "./NoteEmbed";

vi.mock("@/lib/commands", () => ({ getBlock: vi.fn(), resolveNoteLink: vi.fn(), toggleTaskItem: vi.fn() }));

function TestImage(props: ComponentProps<"img"> & ExtraProps) {
  return <img src={props.src} alt={props.alt} />;
}

function renderTable(body: string) {
  return render(
    <ArticleMarkdown
      body={body}
      vaultPath="/vault"
      noteEmbeds={new NoteEmbedLookups(undefined)}
      tasks={null}
      image={TestImage}
      onOpenNote={vi.fn()}
    />,
  );
}

let style: HTMLStyleElement;
let clientWidth: PropertyDescriptor | undefined;

beforeEach(() => {
  // The article's own stylesheet, so jsdom computes what the rules set.
  style = document.createElement("style");
  style.textContent = readFileSync("src/styles/article.css", "utf8");
  document.head.appendChild(style);
  clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  // The column the table stands in: jsdom lays nothing out.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 680 });
});

afterEach(() => {
  style.remove();
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
});

// SPEC_READING_MODE.md, Ч5.
describe("ArticleTable", () => {
  it("aligns cells by the delimiter row only", () => {
    const { container } = renderTable("| L | C | R | D |\n|:---|:---:|---:|---|\n| a | b | 1 | x |");
    const cells = [...container.querySelectorAll("td")];
    expect(cells.map((cell) => cell.style.textAlign)).toEqual(["left", "center", "right", ""]);
    expect(cells.map((cell) => getComputedStyle(cell).textAlign)).toEqual(["left", "center", "right", "left"]);
  });

  it("starts every cell's content at the top of its row and draws the header like the body", () => {
    const { container } = renderTable("| Head |\n|---|\n| body |");
    expect(getComputedStyle(container.querySelector("td")!).verticalAlign).toBe("top");
    expect(getComputedStyle(container.querySelector("th")!).verticalAlign).toBe("top");
    expect(getComputedStyle(container.querySelector("th")!).fontWeight).toBe("400");
  });

  it("sets the measured widths by a colgroup at a fixed layout, no wider than its columns", () => {
    const { container } = renderTable("| Key | Value |\n|---|---|\n| a | 1 |");
    const table = container.querySelector("table")!;
    const widths = [...table.querySelectorAll("col")].map((col) => Number.parseFloat(col.style.width));
    expect(widths).toHaveLength(2);
    expect(table.style.tableLayout).toBe("fixed");
    expect(Number.parseFloat(table.style.width)).toBe(widths.reduce((sum, width) => sum + width, 0));
    expect(Number.parseFloat(table.style.width)).toBeLessThan(680);
  });

  it("scrolls inside its own block", () => {
    const { container } = renderTable("| A |\n|---|\n| a |");
    expect(container.querySelector("[data-article-table-scroll]")).toHaveClass("overflow-x-auto", "max-w-full");
  });

  it("leaves a table from HTML with merged cells to the browser", () => {
    const { container } = renderTable("<table><tr><td colspan=\"2\">a</td></tr><tr><td>b</td><td>c</td></tr></table>");
    expect(container.querySelector("col")).toBeNull();
    expect(container.querySelector("table")).toHaveAttribute("data-article-table", "auto");
  });

  it("lays out a table it is given as a node, as any host would", () => {
    const [node] = hastElementsNamed(readingHast("| A | B |\n|---|---|\n| 1 | 2 |"), "table");
    const { container } = render(<ArticleTable node={node}><tbody><tr><td>1</td><td>2</td></tr></tbody></ArticleTable>);
    expect(container.querySelectorAll("col")).toHaveLength(2);
  });
});
