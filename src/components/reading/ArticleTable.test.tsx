import { readFileSync } from "node:fs";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { ArticleMarkdown } from "./ArticleMarkdown";
import { ArticleTable } from "./ArticleTable";
import { hastElementsNamed, readingHast } from "@/test/readingPipeline";
import { stripFadeMaskStyle } from "@/lib/edgeFade";
import { NoteEmbedLookups } from "./NoteEmbed";

vi.mock("@/lib/commands", () => ({ getBlock: vi.fn(), resolveNoteLink: vi.fn(), toggleTaskItem: vi.fn() }));
// The shared strip mask, watched: jsdom drops a mask image whose stops use
// `calc()`, which the right edge's do, so the edges the table asks the mask
// for are read from its calls.
vi.mock("@/lib/edgeFade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgeFade")>();
  return { ...actual, stripFadeMaskStyle: vi.fn(actual.stripFadeMaskStyle) };
});
const { stripFadeMaskStyle: sharedMask } = await vi.importActual<typeof import("@/lib/edgeFade")>("@/lib/edgeFade");

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

/** Give jsdom, which lays out nothing, the block's scroll geometry. */
function geometry(
  block: HTMLElement,
  { scrollLeft, clientWidth, scrollWidth }: { scrollLeft: number; clientWidth: number; scrollWidth: number },
) {
  Object.defineProperty(block, "clientWidth", { configurable: true, value: clientWidth });
  Object.defineProperty(block, "scrollWidth", { configurable: true, value: scrollWidth });
  block.scrollLeft = scrollLeft;
}

function scrollBlock(container: HTMLElement): HTMLElement {
  const block = container.querySelector<HTMLElement>("[data-article-table-scroll]");
  if (!block) throw new Error("no table block");
  return block;
}

/** The block's hidden edges as it marks them, and as it last asked the
 *  shared mask for them. */
function fadeOf(block: HTMLElement) {
  return {
    marked: { left: block.dataset.fadeLeft === "true", right: block.dataset.fadeRight === "true" },
    masked: vi.mocked(stripFadeMaskStyle).mock.lastCall?.[0],
  };
}

function fading(left: boolean, right: boolean) {
  return { marked: { left, right }, masked: { left, right } };
}

/** The table's natural width in the tests below: wider than its 680 block. */
const WIDE = 1200;
const WIDE_TABLE = "| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |";

// SPEC_READING_MODE.md, Ч5.3; SPEC_SCROLL_EDGE_FADE.md, «Полоса вкладок».
describe("ArticleTable: the edges that hide columns dissolve", () => {
  it("has no mask while the table fits", () => {
    const { container } = renderTable(WIDE_TABLE);
    const block = scrollBlock(container);
    geometry(block, { scrollLeft: 0, clientWidth: 680, scrollWidth: 680 });
    fireEvent.scroll(block);
    expect(fadeOf(block)).toEqual(fading(false, false));
    expect(block.style.cssText).toBe("");
  });

  it("dissolves the right edge at the start, both in the middle and the left at the end", () => {
    const { container } = renderTable(WIDE_TABLE);
    const block = scrollBlock(container);

    geometry(block, { scrollLeft: 0, clientWidth: 680, scrollWidth: WIDE });
    fireEvent.scroll(block);
    expect(fadeOf(block)).toEqual(fading(false, true));

    geometry(block, { scrollLeft: 260, clientWidth: 680, scrollWidth: WIDE });
    fireEvent.scroll(block);
    expect(fadeOf(block)).toEqual(fading(true, true));

    geometry(block, { scrollLeft: WIDE - 680, clientWidth: 680, scrollWidth: WIDE });
    fireEvent.scroll(block);
    expect(fadeOf(block)).toEqual(fading(true, false));
    // The left edge's stops are plain lengths, which jsdom keeps: the block
    // wears the shared mask itself, nothing of its own.
    const probe = render(<div style={sharedMask({ left: true, right: false })} />);
    const expected = (probe.container.firstElementChild as HTMLElement).style.cssText;
    probe.unmount();
    expect(expected).toContain("linear-gradient");
    expect(block.style.cssText).toBe(expected);
  });

  it("follows a resize across the table's width", () => {
    const saved = globalThis.ResizeObserver;
    const callbacks: ResizeObserverCallback[] = [];
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { container } = renderTable(WIDE_TABLE);
      const block = scrollBlock(container);
      // The block is as wide as the window lets it be; it scrolls as wide as
      // the wider of itself and the table.
      const resize = (clientWidth: number) => {
        geometry(block, { scrollLeft: 0, clientWidth, scrollWidth: Math.max(clientWidth, WIDE) });
        act(() => {
          for (const callback of callbacks) callback([], {} as ResizeObserver);
        });
      };
      resize(680);
      expect(fadeOf(block)).toEqual(fading(false, true));
      resize(WIDE + 80);
      expect(fadeOf(block)).toEqual(fading(false, false));
      expect(block.style.cssText).toBe("");
      resize(680);
      expect(fadeOf(block)).toEqual(fading(false, true));
    } finally {
      globalThis.ResizeObserver = saved;
    }
  });
});
