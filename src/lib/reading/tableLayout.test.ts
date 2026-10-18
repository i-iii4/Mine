import { describe, expect, it } from "vitest";
import {
  isNumberCell,
  layoutTableColumns,
  measureTableColumns,
  TABLE_MIN_COLUMN_CH,
  TABLE_NO_SHRINK_CH,
  TABLE_WORD_CAP_CH,
  type TableCellLines,
  type TableColumnMetrics,
  type TableColumnText,
  type TableMeasure,
} from "./tableLayout";
import { hastTableColumns } from "./hast";
import { hastElementsNamed, readingHast } from "@/test/readingPipeline";

/** One unit a character, `ch` one unit, two units of padding. */
const MEASURE: TableMeasure = { ch: 1, cellPadding: 2, measure: (run) => run.text.length };

function cell(...lines: string[]): TableCellLines {
  return lines.map((line) => [{ text: line, style: "normal" as const }]);
}

function column(header: string, ...body: TableCellLines[]): TableColumnText {
  return { header: cell(header), body };
}

function text(nat: number, min = Math.min(nat, 10)): TableColumnMetrics {
  return { nat, min, numeric: false };
}

// SPEC_READING_MODE.md, Ч5.1.
describe("measureTableColumns", () => {
  it("takes MIN from the longest word and NAT from the longest line, header included", () => {
    const [metrics] = measureTableColumns([column("Header word", cell("tiny"), cell("a longer line of words"))], MEASURE);
    expect(metrics).toEqual({ min: "Header".length + 2, nat: "a longer line of words".length + 2, numeric: false });
  });

  it("breaks lines at <br>", () => {
    const [metrics] = measureTableColumns([column("H", cell("first line", "second"))], MEASURE);
    expect(metrics?.nat).toBe("first line".length + 2);
  });

  it("keeps the floor of 4ch for short and empty cells", () => {
    const [metrics] = measureTableColumns([column("", cell(""), cell("a"))], MEASURE);
    expect(metrics).toEqual({ min: TABLE_MIN_COLUMN_CH + 2, nat: TABLE_MIN_COLUMN_CH + 2, numeric: false });
  });

  it("counts a word longer than 30ch as 30ch for MIN", () => {
    const word = "x".repeat(80);
    const [metrics] = measureTableColumns([column("H", cell(word))], MEASURE);
    expect(metrics).toEqual({ min: TABLE_WORD_CAP_CH + 2, nat: 80 + 2, numeric: false });
  });

  it("holds a word together across styles and at no-break spaces", () => {
    const bold: TableCellLines = [[{ text: "ab", style: "normal" }, { text: "cd", style: "strong" }, { text: " e\u00a0f", style: "normal" }]];
    const [metrics] = measureTableColumns([{ header: cell("H"), body: [bold] }], { ...MEASURE, ch: 0.5 });
    expect(metrics?.min).toBe("abcd".length + 2);
  });

  it("knows a column of numbers", () => {
    const [numbers, mixed] = measureTableColumns([
      column("Size", cell("1 234"), cell("56,78"), cell(""), cell("-3.5 %")),
      column("Size", cell("1077"), cell("379 KB")),
    ], MEASURE);
    expect(numbers?.numeric).toBe(true);
    expect(mixed?.numeric).toBe(false);
    expect(isNumberCell(cell("0,72"))).toBe(true);
    expect(isNumberCell(cell("01.05.2026"))).toBe(false);
  });
});

describe("layoutTableColumns", () => {
  it("gives each column its natural width when they fit, and does not stretch", () => {
    expect(layoutTableColumns([text(10), text(20)], 100, 1, 2)).toEqual({ widths: [10, 20], width: 30, scrolls: false });
  });

  it("keeps natural widths when they fill the budget exactly", () => {
    expect(layoutTableColumns([text(40), text(60)], 100, 1, 2)).toEqual({ widths: [40, 60], width: 100, scrolls: false });
  });

  it("shrinks only text columns wider than the threshold, by their share of the room", () => {
    const threshold = TABLE_NO_SHRINK_CH + 2;
    const layout = layoutTableColumns([text(10), text(62), text(42), { nat: 30, min: 30, numeric: true }], 124, 1, 2);
    // 144 natural against 124: 20 to give, from 40 and 20 of room above the threshold.
    expect(layout.widths).toEqual([10, Math.floor(62 - 40 * (20 / 60)), Math.floor(42 - 20 * (20 / 60)), 30]);
    expect(layout.widths[1]).toBeGreaterThanOrEqual(threshold);
    expect(layout.scrolls).toBe(false);
  });

  it("shrinks a column to fit, but never below its MIN", () => {
    const columns = [{ nat: 80, min: 32, numeric: false }, text(10)];
    expect(layoutTableColumns(columns, 50, 1, 2)).toEqual({ widths: [40, 10], width: 50, scrolls: false });
    expect(layoutTableColumns(columns, 30, 1, 2)).toEqual({ widths: [32, 10], width: 42, scrolls: true });
  });

  it("fills the budget when the floors add up to it", () => {
    const layout = layoutTableColumns([{ nat: 80, min: 40, numeric: false }, { nat: 70, min: 60, numeric: false }], 100, 1, 2);
    expect(layout).toEqual({ widths: [40, 60], width: 100, scrolls: false });
  });

  it("scrolls when even the floors do not fit, keeping them", () => {
    const layout = layoutTableColumns([{ nat: 80, min: 40, numeric: false }, { nat: 30, min: 30, numeric: true }], 50, 1, 2);
    expect(layout).toEqual({ widths: [40, 30], width: 70, scrolls: true });
  });

  it("is the same for the same table and width", () => {
    const columns = [text(55), text(90), text(33)];
    expect(layoutTableColumns(columns, 120, 1, 2)).toEqual(layoutTableColumns(columns, 120, 1, 2));
  });
});

describe("hastTableColumns", () => {
  it("reads a Markdown table's columns as visible text", () => {
    const [table] = hastElementsNamed(readingHast("| A | **B** |\n|---|---|\n| `code` | [link](https://x.y)<br>two |"), "table");
    const columns = hastTableColumns(table!);
    expect(columns?.map((each) => each.header)).toEqual([[[{ text: "A", style: "normal" }]], [[{ text: "B", style: "strong" }]]]);
    expect(columns?.[0]?.body).toEqual([[[{ text: "code", style: "code" }]]]);
    expect(columns?.[1]?.body).toEqual([[[{ text: "link", style: "normal" }], [{ text: "two", style: "normal" }]]]);
  });

  it("leaves a table with merged cells to the browser", () => {
    const [table] = hastElementsNamed(readingHast("<table><tr><td colspan=\"2\">a</td></tr><tr><td>b</td><td>c</td></tr></table>"), "table");
    expect(hastTableColumns(table!)).toBeNull();
  });

  it("reads a table of a header alone", () => {
    const [table] = hastElementsNamed(readingHast("| A | B |\n|---|---|"), "table");
    expect(hastTableColumns(table!)?.map((each) => each.body)).toEqual([[], []]);
  });
});
