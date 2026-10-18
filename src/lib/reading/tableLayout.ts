// Column widths of an article table by its content (SPEC_READING_MODE.md,
// Ч5.1), by the rules the user accepted for Local MD on 09.06.2026
// (SPEC_TABLE_SIZING.md), in the part that applies to a table read, not
// edited. Pure: the caller measures text, this decides. The same table at the
// same width gets the same layout.

/** How a run of a cell's text is set: plain, bold, or code in a line. */
export type TableRunStyle = "normal" | "strong" | "code";

/** A run of a cell's visible text in one style. */
export interface TableTextRun {
  text: string;
  style: TableRunStyle;
}

/** A cell's visible text, line by line: `<br>` ends a line. */
export type TableCellLines = ReadonlyArray<ReadonlyArray<TableTextRun>>;

/** A column's cells: the header's, then the body's. */
export interface TableColumnText {
  header: TableCellLines;
  body: readonly TableCellLines[];
}

/** How the page measures text: the advance of `0` (`ch`) in the article's
 *  font at its size, a cell's padding across, and the width of a run. */
export interface TableMeasure {
  ch: number;
  cellPadding: number;
  measure(run: TableTextRun): number;
}

/** A column's widths, padding included. */
export interface TableColumnMetrics {
  /** The longest unbreakable word, at most `TABLE_WORD_CAP_CH`, at least
   *  `TABLE_MIN_COLUMN_CH`. */
  min: number;
  /** The longest line set without wrapping, at least `min`. */
  nat: number;
  /** Every body cell a number or empty: the column keeps `nat` and does
   *  not wrap. */
  numeric: boolean;
}

/** The widths a table is laid out with. */
export interface TableLayout {
  widths: number[];
  width: number;
  /** Wider than its budget: it scrolls inside its own block (Ч5.3). */
  scrolls: boolean;
}

/** The narrowest a column's content gets, in `ch` (Notion's ~100 px). */
export const TABLE_MIN_COLUMN_CH = 4;
/** A word longer than this counts as this long and breaks anywhere past it,
 *  so one address does not send the whole table into scrolling. */
export const TABLE_WORD_CAP_CH = 30;
/** A text column no wider than this keeps its natural width; a wider one
 *  shrinks, but not below it: short labels never wrap. */
export const TABLE_NO_SHRINK_CH = 20;

/** Spaces a line may break at. The no-break spaces (U+00A0, U+2007, U+202F)
 *  hold a word together, as the browser keeps them. */
const BREAKING_SPACE = /[ \t\n\r\f\v\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]/;

/** A number as a table cell writes one: grouped digits, a decimal part, a
 *  percent sign; `1 234`, `56,78`, `-3.5 %`. */
const NUMBER = /^[-+\u2212]?(?:\d{1,3}(?:[ \u00a0\u202f,.'\u2019]\d{3})+|\d+)(?:[.,]\d+)?(?:[ \u00a0\u202f]?%)?$/;

function lineText(line: ReadonlyArray<TableTextRun>): string {
  return line.map((run) => run.text).join("");
}

function cellText(cell: TableCellLines): string {
  return cell.map(lineText).join("\n").trim();
}

/** Whether a body cell's text is a number. */
export function isNumberCell(cell: TableCellLines): boolean {
  return NUMBER.test(cellText(cell));
}

/** The widest unbreakable word and the widest line of a cell, unpadded. A
 *  word runs across style changes until a breaking space. */
function measureCell(cell: TableCellLines, measure: TableMeasure["measure"]): { word: number; line: number } {
  let word = 0;
  let line = 0;
  for (const runs of cell) {
    let lineWidth = 0;
    let wordWidth = 0;
    for (const run of runs) {
      lineWidth += measure(run);
      for (const piece of run.text.split(new RegExp(`(${BREAKING_SPACE.source}+)`))) {
        if (!piece) continue;
        if (BREAKING_SPACE.test(piece)) {
          word = Math.max(word, wordWidth);
          wordWidth = 0;
        } else {
          wordWidth += measure({ text: piece, style: run.style });
        }
      }
    }
    word = Math.max(word, wordWidth);
    line = Math.max(line, lineWidth);
  }
  return { word, line };
}

/** Each column's `MIN`, `NAT` and whether it is a column of numbers. */
export function measureTableColumns(
  columns: readonly TableColumnText[],
  { ch, cellPadding, measure }: TableMeasure,
): TableColumnMetrics[] {
  return columns.map((column) => {
    let word = 0;
    let line = 0;
    for (const cell of [column.header, ...column.body]) {
      const widths = measureCell(cell, measure);
      word = Math.max(word, widths.word);
      line = Math.max(line, widths.line);
    }
    const floor = TABLE_MIN_COLUMN_CH * ch;
    const min = Math.ceil(Math.max(floor, Math.min(word, TABLE_WORD_CAP_CH * ch))) + cellPadding;
    const nat = Math.max(min, Math.ceil(line) + cellPadding);
    const filled = column.body.filter((cell) => cellText(cell) !== "");
    const numeric = filled.length > 0 && filled.every(isNumberCell);
    return { min, nat, numeric };
  });
}

/**
 * The column widths of a table in `budget` (Ч5.1):
 *
 * 1. Its natural widths fit: each column gets `nat`, the table is no wider
 *    than that, it does not stretch.
 * 2. They do not: only text columns wider than `TABLE_NO_SHRINK_CH` shrink,
 *    each by its share of the room it can give (its `nat` less its floor,
 *    the larger of the threshold and its `min`), never below that floor.
 * 3. Still wider: the table keeps those widths and scrolls in its block.
 */
export function layoutTableColumns(
  columns: readonly TableColumnMetrics[],
  budget: number,
  ch: number,
  cellPadding: number,
): TableLayout {
  const natural = columns.map((column) => column.nat);
  const naturalWidth = natural.reduce((sum, width) => sum + width, 0);
  if (naturalWidth <= budget) {
    return { widths: natural, width: naturalWidth, scrolls: false };
  }
  // Whole pixels, like `min` and `nat`: a shrunk width rounds down to no
  // less than its floor.
  const threshold = Math.ceil(TABLE_NO_SHRINK_CH * ch) + cellPadding;
  const floors = columns.map((column) => (
    column.numeric ? column.nat : Math.min(column.nat, Math.max(threshold, column.min))
  ));
  const slack = columns.map((column, index) => column.nat - (floors[index] ?? column.nat));
  const totalSlack = slack.reduce((sum, value) => sum + value, 0);
  const excess = naturalWidth - budget;
  const widths = totalSlack <= excess
    ? floors
    : columns.map((column, index) => {
      const share = (slack[index] ?? 0) * (excess / totalSlack);
      return share === 0 ? column.nat : Math.floor(column.nat - share);
    });
  const width = widths.reduce((sum, value) => sum + value, 0);
  return { widths, width, scrolls: width > budget };
}
