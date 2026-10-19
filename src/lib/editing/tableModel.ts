// One GFM table of a note as the editor edits it (SPEC_EDITING.md, Л9.3,
// Л9.9, Л9.11): its lines, and in each line the indentation, the pipes, the
// cells with their content and the spaces around it, the tail after the last
// pipe, the line ending a mixed body keeps in the line. The cells split as
// micromark-extension-gfm-table splits them for the reading mode: `\|` does
// not end a cell, a pipe in code in a line does. The model is made again
// from the table's text whenever it is asked for; there is no second
// document.
//
// Every command of the table is a list of the smallest replacements of the
// lines it touches: untouched lines, cells, padding, pipes, alignment and
// line endings keep their bytes, the table's indentation stays. A row is
// rebuilt from its own pieces and only the difference to the line as it was
// is written. Two rules of GFM add a pipe where a command would otherwise
// lose a cell: a row without a leading pipe cannot start with an empty cell
// (that pipe would read as the leading one) and a row without a trailing
// pipe cannot end with one; a cell whose content ends with an unpaired
// backslash keeps a space before the pipe after it.
//
// Positions are offsets in the table's text: its lines joined by one `\n`,
// as CodeMirror counts a line break whatever the body writes for it. The
// editor turns the `\n` of new lines into the body's line break.

import { endsWithUnpairedBackslash, escapeLoosePipes, smallestReplacement } from "./tableCell";
import type { TableCellLines, TableColumnText, TableTextRun } from "@/lib/reading/tableLayout";

/** How a column's cells stand, from its cell of the delimiter row. */
export type TableAlignment = "left" | "center" | "right" | null;

/** A cell of one line of the table. */
export interface TableCell {
  /** The cell between its pipes (or the row's edges), padding included. */
  start: number;
  end: number;
  /** Its content without the spaces and tabs around it. An empty cell's
   *  content is the empty range where text would go: after one space. */
  from: number;
  to: number;
}

/** One line of the table. */
export interface TableLine {
  /** The start of the line. */
  from: number;
  /** The end of its text, a `\r` that ends a line of a mixed body left
   *  out. */
  end: number;
  /** The end of the line as the document holds it, that `\r` included. */
  to: number;
  /** Where its cells start: after the indentation and a leading pipe. */
  cellsFrom: number;
  leadingPipe: boolean;
  /** Whether the last pipe ends the line, only spaces after it. */
  trailingPipe: boolean;
  cells: TableCell[];
}

/** A parsed table. */
export interface TableModel {
  /** The table's text, its lines joined by `\n`. */
  text: string;
  /** Every line: the header, the delimiter row, then the body. */
  lines: TableLine[];
  /** The number of columns: the header's cells. */
  columns: number;
  /** The alignment of each column. */
  alignments: TableAlignment[];
}

/** A replacement in the table's text. */
export interface TableTextChange {
  from: number;
  to: number;
  insert: string;
}

/** A place in the table: row 0 is the header, row 1 the first body row; the
 *  delimiter row is no row. */
export interface TableCellRef {
  row: number;
  col: number;
}

const DELIMITER_CELL = /^(:?)-+(:?)$/;
/** The fewest dashes a delimiter cell keeps when colons take the place of
 *  its outer dashes (Л9.9). */
const DELIMITER_MIN_DASHES = 3;
/** The delimiter cell of a new column. */
const NEW_DELIMITER_CELL = "---";
/** Where indentation makes a line code instead of a row (CommonMark). */
const INDENTED_CODE_COLUMNS = 4;
/** An empty cell a command writes: one space between its pipes. */
const EMPTY_CELL = " ";

function isSpace(sign: string | undefined): boolean {
  return sign === " " || sign === "\t";
}

function content(text: string, start: number, end: number): { from: number; to: number } {
  let from = start;
  let to = end;
  while (from < to && isSpace(text[from])) from += 1;
  while (to > from && isSpace(text[to - 1])) to -= 1;
  if (from === to) {
    const place = end > start ? start + 1 : start;
    return { from: place, to: place };
  }
  return { from, to };
}

/** One line of a table, split as micromark-extension-gfm-table splits it. */
export function parseTableLine(text: string, from: number, to: number): TableLine {
  const end = to > from && text[to - 1] === "\r" ? to - 1 : to;
  let index = from;
  while (index < end && isSpace(text[index])) index += 1;
  const leadingPipe = text[index] === "|";
  const cellsFrom = leadingPipe ? index + 1 : index;
  const cells: TableCell[] = [];
  let start = cellsFrom;
  for (let position = cellsFrom; position < end; position += 1) {
    const sign = text[position];
    if (sign === "\\" && position + 1 < end && (text[position + 1] === "\\" || text[position + 1] === "|")) {
      position += 1;
    } else if (sign === "|") {
      cells.push({ start, end: position, ...content(text, start, position) });
      start = position + 1;
    }
  }
  let trailingPipe = false;
  let rest = start;
  while (rest < end && isSpace(text[rest])) rest += 1;
  // A line of a leading pipe and nothing else holds one empty cell, as
  // micromark reads it.
  if (rest < end || (leadingPipe && cells.length === 0)) cells.push({ start, end, ...content(text, start, end) });
  else trailingPipe = cells.length > 0;
  return { from, end, to, cellsFrom, leadingPipe, trailingPipe, cells };
}

function alignmentOf(source: string): TableAlignment | undefined {
  const match = DELIMITER_CELL.exec(source);
  if (!match) return undefined;
  const left = match[1] === ":";
  const right = match[2] === ":";
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return null;
}

/** Where each line of `text` starts and ends. */
function lineRanges(text: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let from = 0;
  for (;;) {
    const next = text.indexOf("\n", from);
    if (next < 0) {
      ranges.push({ from, to: text.length });
      return ranges;
    }
    ranges.push({ from, to: next });
    from = next + 1;
  }
}

/**
 * The table `text` holds, or `null` when it is no table the editor can
 * edit: fewer than two lines, a delimiter row that is not one, or a header
 * whose cells do not match it.
 */
export function parseTable(text: string): TableModel | null {
  const ranges = lineRanges(text);
  if (ranges.length < 2) return null;
  const lines = ranges.map((range) => parseTableLine(text, range.from, range.to));
  const header = lines[0];
  const delimiter = lines[1];
  if (!header || !delimiter || header.cells.length === 0 || header.cells.length !== delimiter.cells.length) return null;
  const alignments: TableAlignment[] = [];
  for (const cell of delimiter.cells) {
    const alignment = alignmentOf(text.slice(cell.from, cell.to));
    if (alignment === undefined) return null;
    alignments.push(alignment);
  }
  return { text, lines, columns: header.cells.length, alignments };
}

const modelCache = new Map<string, TableModel | null>();
/** Tables kept parsed by their text (Л9.3). */
const MODEL_CACHE_LIMIT = 16;

/** `parseTable`, kept by the table's text. */
export function tableModel(text: string): TableModel | null {
  if (modelCache.has(text)) return modelCache.get(text) ?? null;
  const model = parseTable(text);
  modelCache.set(text, model);
  while (modelCache.size > MODEL_CACHE_LIMIT) {
    const oldest = modelCache.keys().next().value;
    if (oldest === undefined) break;
    modelCache.delete(oldest);
  }
  return model;
}

/** The number of rows: the header and the body. */
export function rowCount(model: TableModel): number {
  return model.lines.length - 1;
}

/** The line of row `row`: the delimiter row is skipped. */
export function lineOfRow(model: TableModel, row: number): TableLine | undefined {
  return model.lines[row === 0 ? 0 : row + 1];
}

/** The cell at `ref`, or `null` where its row has no such cell (a ragged
 *  row, or a column past the header's). */
export function cellAt(model: TableModel, ref: TableCellRef): TableCell | null {
  return lineOfRow(model, ref.row)?.cells[ref.col] ?? null;
}

/** The source of the cell at `ref`: its content as written; empty where the
 *  row has no such cell. */
export function cellSource(model: TableModel, ref: TableCellRef): string {
  const cell = cellAt(model, ref);
  return cell ? model.text.slice(cell.from, cell.to) : "";
}

/** The row and column at offset `pos` of the table's text, if a cell holds
 *  it; the delimiter row holds none. */
export function cellRefAt(model: TableModel, pos: number): TableCellRef | null {
  const index = model.lines.findIndex((line) => line.from <= pos && pos <= line.to);
  if (index < 0 || index === 1) return null;
  const line = model.lines[index];
  if (!line) return null;
  const col = line.cells.findIndex((cell) => cell.start <= pos && pos <= cell.end);
  if (col < 0 || col >= model.columns) return null;
  return { row: index === 0 ? 0 : index - 1, col };
}

// ─── Rows as pieces ─────────────────────────────────────────────────────────

/** A cell of a line between its pipes, padding included. `open` marks the
 *  last cell of a line without a trailing pipe: nothing followed it, so a
 *  pipe that comes after it now gets a space before it. */
interface Segment {
  text: string;
  open: boolean;
}

/** A line taken apart: what comes before the cells, each cell between its
 *  pipes with its padding, whether a pipe ends the last one, what follows. */
interface LinePieces {
  /** The indentation and the leading pipe, if any. */
  head: string;
  /** Whether `head` ends with the leading pipe. */
  leadingPipe: boolean;
  segments: Segment[];
  trailingPipe: boolean;
  /** After the trailing pipe: spaces; then the line ending kept in the line. */
  tail: string;
}

function piecesOf(model: TableModel, line: TableLine): LinePieces {
  const { text } = model;
  const count = line.cells.length;
  const segments = line.cells.map((cell, index) => ({
    text: text.slice(cell.start, cell.end),
    open: index === count - 1 && !line.trailingPipe,
  }));
  const last = line.cells[count - 1];
  const tailFrom = last ? (line.trailingPipe ? last.end + 1 : last.end) : line.cellsFrom;
  return {
    head: text.slice(line.from, line.cellsFrom),
    leadingPipe: line.leadingPipe,
    segments,
    trailingPipe: line.trailingPipe,
    tail: text.slice(tailFrom, line.to),
  };
}

function segmentContent(segment: string): { before: string; text: string; after: string } {
  const start = segment.length - segment.trimStart().length;
  const trimmed = segment.trim();
  if (trimmed === "") {
    // An empty cell: its spaces stay on either side of where text goes.
    const before = segment.slice(0, segment.length > 0 ? 1 : 0);
    return { before, text: "", after: segment.slice(before.length) };
  }
  return { before: segment.slice(0, start), text: segment.slice(start, start + trimmed.length), after: segment.slice(start + trimmed.length) };
}

function withContent(segment: Segment, text: string): Segment {
  const parts = segmentContent(segment.text);
  return { text: parts.before + text + parts.after, open: segment.open };
}

function isEmptySegment(segment: Segment | undefined): boolean {
  return segment === undefined || segment.text.trim() === "";
}

function newSegment(text: string): Segment {
  return { text, open: false };
}

/** How far spaces and tabs reach, a tab to the next stop of four. */
function indentationWidth(text: string): number {
  let width = 0;
  for (const sign of text) width = sign === "\t" ? width + 4 - (width % 4) : width + 1;
  return width;
}

/**
 * The rules of GFM a rebuilt line keeps: a line always holds a pipe (a
 * single cell without one gets the leading pipe); an empty first cell needs
 * the leading pipe and an empty last cell the
 * trailing one; a first cell that would start four columns in (indented
 * code) needs the leading pipe too; no cell holds an unescaped pipe; a cell whose content ends
 * with an unpaired backslash keeps a space before the pipe after it, and so
 * does the cell that ended the line before a pipe came after it.
 */
function normalizePieces(pieces: LinePieces, header: boolean): LinePieces {
  let { head, leadingPipe, trailingPipe } = pieces;
  const count = pieces.segments.length;
  // A leading pipe and one empty cell read as that cell (micromark), but not
  // in the header: a header of one pipe and nothing else is none.
  const lonePipe = count === 1 && leadingPipe && !header;
  if (!trailingPipe && count > 0 && !lonePipe && isEmptySegment(pieces.segments[count - 1])) trailingPipe = true;
  const first = pieces.segments[0];
  const noPipe = count <= 1 && !trailingPipe;
  if (!leadingPipe && (noPipe || first === undefined || isEmptySegment(first) || indentationWidth(head + segmentContent(first.text).before) >= INDENTED_CODE_COLUMNS)) {
    head += "|";
    leadingPipe = true;
  }
  const segments = pieces.segments.map((segment, index) => {
    const parts = segmentContent(segment.text);
    const safe = escapeLoosePipes(parts.text);
    let after = parts.after;
    const followedByPipe = index < count - 1 || trailingPipe;
    if (followedByPipe && after === "" && safe !== "" && (segment.open || endsWithUnpairedBackslash(safe))) after = " ";
    return { text: parts.before + safe + after, open: segment.open && !followedByPipe };
  });
  return { head, leadingPipe, segments, trailingPipe, tail: pieces.tail };
}

function textOfPieces(pieces: LinePieces): string {
  if (pieces.segments.length === 0) return pieces.head + pieces.tail;
  return pieces.head + pieces.segments.map((segment) => segment.text).join("|") + (pieces.trailingPipe ? "|" : "") + pieces.tail;
}

/** The smallest change that turns `line` into the line of `pieces`. */
function lineChange(model: TableModel, line: TableLine, pieces: LinePieces): TableTextChange | null {
  const before = model.text.slice(line.from, line.to);
  const change = smallestReplacement(before, textOfPieces(normalizePieces(pieces, line === model.lines[0])));
  return change ? { from: line.from + change.from, to: line.from + change.to, insert: change.insert } : null;
}

function present(changes: Array<TableTextChange | null>): TableTextChange[] {
  return changes.filter((change): change is TableTextChange => change !== null);
}

/** The padding a new cell of `pieces` takes: that of the cell beside it. */
function paddingBeside(pieces: LinePieces, index: number): { before: string; after: string } {
  const neighbour = pieces.segments[index - 1] ?? pieces.segments[index];
  if (neighbour === undefined || isEmptySegment(neighbour)) return { before: " ", after: " " };
  const parts = segmentContent(neighbour.text);
  return { before: parts.before, after: neighbour.open && parts.after === "" ? " " : parts.after };
}

/** `pieces` with cells up to `count`, the missing ones empty. */
function padSegments(pieces: LinePieces, count: number): LinePieces {
  if (pieces.segments.length >= count) return pieces;
  const segments = [...pieces.segments];
  while (segments.length < count) segments.push(newSegment(EMPTY_CELL));
  return { ...pieces, segments };
}

// ─── Cells ──────────────────────────────────────────────────────────────────

/** A cell's new source. */
export interface CellWrite {
  ref: TableCellRef;
  /** The new content, as source. */
  source: string;
}

/**
 * Write cells (Л9.11): each cell's content becomes its new source, its
 * padding stays; a cell missing from a ragged row is added at the end of
 * the row with the empty cells before it. Columns past the header's are not
 * written.
 */
export function writeCells(model: TableModel, writes: readonly CellWrite[]): TableTextChange[] {
  const byRow = new Map<number, CellWrite[]>();
  for (const write of writes) {
    if (write.ref.col < 0 || write.ref.col >= model.columns || write.ref.row < 0 || write.ref.row >= rowCount(model)) continue;
    const list = byRow.get(write.ref.row) ?? [];
    list.push(write);
    byRow.set(write.ref.row, list);
  }
  const changes: Array<TableTextChange | null> = [];
  for (const [row, list] of byRow) {
    const line = lineOfRow(model, row);
    if (!line) continue;
    let pieces = piecesOf(model, line);
    const widest = Math.max(...list.map((write) => write.ref.col)) + 1;
    pieces = padSegments(pieces, widest);
    const segments = [...pieces.segments];
    for (const write of list) {
      const existing = segments[write.ref.col];
      segments[write.ref.col] = existing === undefined || write.ref.col >= line.cells.length
        ? newSegment(` ${write.source} `)
        : withContent(existing, write.source);
    }
    changes.push(lineChange(model, line, { ...pieces, segments }));
  }
  return present(changes).sort((left, right) => left.from - right.from);
}

/** A range of a line or of the table's text. */
export interface TextRange {
  from: number;
  to: number;
}

/** The content range a cell's editor starts with: the cell's content, or
 *  `null` for a cell missing from its row. */
export function cellEditRange(line: TableLine, col: number): TextRange | null {
  const cell = line.cells[col];
  return cell ? { from: cell.from, to: cell.to } : null;
}

/**
 * Typing in one cell of one line (Л9.5, Л9.11): the source of the cell's
 * editing range `range` (its content as the cell's editor holds it, spaces
 * typed at its ends included; `null` for a cell missing from the line)
 * becomes `source`. A missing cell is added at the end of the line with the
 * empty cells before it; the rules of a line (a pipe where an emptied first
 * or last cell needs one, a space before a pipe after an unpaired
 * backslash) hold. `text` is the line, a header's when `header`. Returns the
 * change of the line and the editing range after it, both in the line's
 * offsets.
 */
export function editLineCell(
  text: string,
  header: boolean,
  col: number,
  range: TextRange | null,
  source: string,
): { change: TableTextChange | null; range: TextRange } {
  const line = parseTableLine(text, 0, text.length);
  const pieces = piecesOf({ text, lines: [line], columns: line.cells.length, alignments: [] }, line);
  const segments = [...pieces.segments];
  const cell = line.cells[col];
  let left: string;
  if (cell && range) {
    left = text.slice(cell.start, range.from);
    const right = text.slice(range.to, cell.end);
    segments[col] = { text: left + source + right, open: segments[col]?.open ?? false };
  } else {
    while (segments.length < col) segments.push(newSegment(EMPTY_CELL));
    left = " ";
    segments[col] = newSegment(` ${source} `);
  }
  const normalized = normalizePieces({ ...pieces, segments }, header);
  let start = normalized.head.length;
  for (let index = 0; index < col; index += 1) start += (normalized.segments[index]?.text.length ?? 0) + 1;
  const from = start + left.length;
  return { change: smallestReplacement(text, textOfPieces(normalized)), range: { from, to: from + source.length } };
}

// ─── Rows ───────────────────────────────────────────────────────────────────

function emptyRowText(model: TableModel, neighbour: TableLine): string {
  let indentationEnd = neighbour.from;
  while (indentationEnd < neighbour.end && isSpace(model.text[indentationEnd])) indentationEnd += 1;
  const indentation = model.text.slice(neighbour.from, indentationEnd);
  const ending = model.text.slice(neighbour.end, neighbour.to);
  const segments = Array.from({ length: model.columns }, () => newSegment(EMPTY_CELL));
  return textOfPieces(normalizePieces({ head: `${indentation}|`, leadingPipe: true, segments, trailingPipe: true, tail: ending }, false));
}

/** A new line at body position `bodyIndex` (0 before the first body row,
 *  the body's length after the last) holding `text`. */
function insertLine(model: TableModel, bodyIndex: number, text: string): TableTextChange {
  const before = model.lines[bodyIndex + 2];
  if (before) return { from: before.from, to: before.from, insert: `${text}\n` };
  const last = model.lines[model.lines.length - 1];
  const end = last ? last.to : model.text.length;
  return { from: end, to: end, insert: `\n${text}` };
}

/**
 * Insert an empty row (Л9.11): one new line beside `row`, above it
 * (`below` false; not above the header) or below it, with the indentation of
 * that row, empty cells of one space as many as the header has, between
 * pipes on both sides (an empty first and last cell need them), and that
 * row's line ending.
 */
export function insertRow(model: TableModel, row: number, below: boolean): TableTextChange[] {
  if (!below && row === 0) return [];
  const neighbour = lineOfRow(model, row);
  if (!neighbour) return [];
  const bodyIndex = below ? row : row - 1;
  return [insertLine(model, bodyIndex, emptyRowText(model, neighbour))];
}

/** Delete body row `row` with its line break (Л9.11); the header stays. */
export function deleteRow(model: TableModel, row: number): TableTextChange[] {
  if (row <= 0) return [];
  const index = row + 1;
  const line = model.lines[index];
  if (!line) return [];
  const next = model.lines[index + 1];
  if (next) return [{ from: line.from, to: next.from, insert: "" }];
  const previous = model.lines[index - 1];
  return [{ from: previous ? previous.to : line.from, to: line.to, insert: "" }];
}

/** Duplicate `row` (Л9.11): a copy of its bytes below it; the header's copy
 *  is the first body row. */
export function duplicateRow(model: TableModel, row: number): TableTextChange[] {
  const line = lineOfRow(model, row);
  if (!line) return [];
  return [insertLine(model, row === 0 ? 0 : row, model.text.slice(line.from, line.to))];
}

/** Clear `row` (Л9.11): the content of each of its cells, the padding
 *  stays. */
export function clearRow(model: TableModel, row: number): TableTextChange[] {
  const line = lineOfRow(model, row);
  if (!line) return [];
  const pieces = piecesOf(model, line);
  return present([lineChange(model, line, { ...pieces, segments: pieces.segments.map((segment) => withContent(segment, "")) })]);
}

/** Move body row `from` to body position `to` (Л9.11): the row's bytes
 *  move, unchanged, and the rows between shift by one. */
export function moveRow(model: TableModel, from: number, to: number): TableTextChange[] {
  if (from === to || from <= 0 || to <= 0) return [];
  const first = Math.min(from, to) + 1;
  const last = Math.max(from, to) + 1;
  const start = model.lines[first];
  const end = model.lines[last];
  if (!start || !end) return [];
  const texts = model.lines.slice(first, last + 1).map((line) => model.text.slice(line.from, line.to));
  const moved = from < to ? [...texts.slice(1), texts[0] ?? ""] : [texts[texts.length - 1] ?? "", ...texts.slice(0, -1)];
  const change = smallestReplacement(model.text.slice(start.from, end.to), moved.join("\n"));
  return change ? [{ from: start.from + change.from, to: start.from + change.to, insert: change.insert }] : [];
}

// ─── Columns ────────────────────────────────────────────────────────────────

function eachLine(model: TableModel, rebuild: (pieces: LinePieces, index: number, line: TableLine) => LinePieces | null): TableTextChange[] {
  return present(model.lines.map((line, index) => {
    const pieces = rebuild(piecesOf(model, line), index, line);
    return pieces ? lineChange(model, line, pieces) : null;
  }));
}

/**
 * Insert an empty column at `col` (0 before the first, the column count
 * after the last; Л9.11): in every line one cell at that boundary, empty in
 * the header and the body, `---` in the delimiter row, padded as the cell
 * beside it. A line shorter than the place stays as it is.
 */
export function insertColumn(model: TableModel, col: number): TableTextChange[] {
  if (col < 0 || col > model.columns) return [];
  return eachLine(model, (pieces, index) => {
    if (pieces.segments.length < col) return null;
    const padding = paddingBeside(pieces, col);
    const cell = index === 1 ? `${padding.before}${NEW_DELIMITER_CELL}${padding.after}` : EMPTY_CELL;
    const segments = [...pieces.segments];
    segments.splice(col, 0, newSegment(cell));
    return { ...pieces, segments };
  });
}

/** Delete column `col` (Л9.11): in every line that has it, the cell with
 *  one pipe beside it. The only column is not deleted. */
export function deleteColumn(model: TableModel, col: number): TableTextChange[] {
  if (model.columns <= 1 || col < 0 || col >= model.columns) return [];
  return eachLine(model, (pieces) => {
    if (pieces.segments.length <= col) return null;
    const segments = [...pieces.segments];
    segments.splice(col, 1);
    return { ...pieces, segments };
  });
}

/** Duplicate column `col` (Л9.11): a copy of the cell's bytes beside it in
 *  every line that has it. */
export function duplicateColumn(model: TableModel, col: number): TableTextChange[] {
  if (col < 0 || col >= model.columns) return [];
  return eachLine(model, (pieces) => {
    const segment = pieces.segments[col];
    if (segment === undefined) return null;
    const segments = [...pieces.segments];
    segments.splice(col + 1, 0, segment);
    return { ...pieces, segments };
  });
}

/** Clear column `col` (Л9.11): the content of its cell in every line, the
 *  header's too; the delimiter row stays. */
export function clearColumn(model: TableModel, col: number): TableTextChange[] {
  if (col < 0 || col >= model.columns) return [];
  return eachLine(model, (pieces, index) => {
    const segment = pieces.segments[col];
    if (index === 1 || segment === undefined || segmentContent(segment.text).text === "") return null;
    const segments = [...pieces.segments];
    segments[col] = withContent(segment, "");
    return { ...pieces, segments };
  });
}

/** Move column `from` to column position `to` (Л9.11): in every line the
 *  cells move by their bytes with their padding; a ragged line gets the
 *  empty cells the move needs; extra cells past the header's stay at the
 *  end. */
export function moveColumn(model: TableModel, from: number, to: number): TableTextChange[] {
  if (from === to || from < 0 || to < 0 || from >= model.columns || to >= model.columns) return [];
  return eachLine(model, (pieces) => {
    const length = pieces.segments.length;
    if (length <= Math.min(from, to)) return null;
    const padded = padSegments(pieces, Math.max(from, to) + 1);
    const segments = [...padded.segments];
    const [moved] = segments.splice(from, 1);
    segments.splice(to, 0, moved ?? newSegment(EMPTY_CELL));
    // A ragged line keeps no empty cells at its end that it did not have.
    while (segments.length > length && isEmptySegment(segments[segments.length - 1])) segments.pop();
    return { ...padded, segments };
  });
}

/**
 * The delimiter cell of an alignment (Л9.9): colons take the place of the
 * outer dashes while three dashes stay besides them, otherwise they are
 * added; `null` writes dashes only.
 */
export function alignedDelimiter(current: string, alignment: TableAlignment): string {
  const length = current.length;
  const dashes = current.replace(/:/g, "").length;
  const left = alignment === "left" || alignment === "center" ? ":" : "";
  const right = alignment === "right" || alignment === "center" ? ":" : "";
  const colons = left.length + right.length;
  if (colons === 0) return "-".repeat(Math.max(dashes, 1));
  const run = length - colons >= DELIMITER_MIN_DASHES ? length - colons : Math.max(dashes, 1);
  return `${left}${"-".repeat(run)}${right}`;
}

/** Align column `col` (Л9.9): only its cell of the delimiter row changes. */
export function alignColumn(model: TableModel, col: number, alignment: TableAlignment): TableTextChange[] {
  const delimiter = model.lines[1];
  const cell = delimiter?.cells[col];
  if (!delimiter || !cell) return [];
  const current = model.text.slice(cell.from, cell.to);
  const next = alignedDelimiter(current, alignment);
  return next === current ? [] : [{ from: cell.from, to: cell.to, insert: next }];
}

// ─── Text ───────────────────────────────────────────────────────────────────

/** The table's text after `changes`. */
export function applyTableChanges(text: string, changes: readonly TableTextChange[]): string {
  let result = text;
  for (const change of [...changes].sort((left, right) => right.from - left.from)) {
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return result;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", nbsp: " " };
const INLINE_TOKEN = /\\([!-/:-@[-`{-~])|(`+)([\s\S]*?[^`])\2(?!`)|!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]|!\[([^\]]*)\]\([^)]*\)|\[([^\]]*)\]\([^)]*\)|(\*\*|__)([\s\S]+?)\8|<[^>]+>|&(amp|lt|gt|quot|#39|nbsp);|\*{1,2}|~{1,2}|==/g;

function inlineRuns(source: string, style: TableTextRun["style"], runs: TableTextRun[]) {
  let last = 0;
  const push = (text: string, runStyle: TableTextRun["style"]) => {
    if (text) runs.push({ text, style: runStyle });
  };
  for (const match of source.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0;
    push(source.slice(last, index), style);
    last = index + match[0].length;
    if (match[1] !== undefined) push(match[1], style);
    else if (match[2] !== undefined) push((match[3] ?? "").replace(/^ ([\s\S]*) $/, "$1"), "code");
    else if (match[4] !== undefined) push(match[5] ?? match[4], style);
    else if (match[6] !== undefined) push(match[6], style);
    else if (match[7] !== undefined) inlineRuns(match[7], style, runs);
    else if (match[9] !== undefined) inlineRuns(match[9], style === "code" ? style : "strong", runs);
    else if (match[10] !== undefined) push(ENTITIES[match[10]] ?? "", style);
  }
  push(source.slice(last), style);
}

/**
 * The visible text of a cell's source for the layout of its column (Л9.10,
 * Ч5.1), line by line: `<br>` ends a line, `\|` is `|`, code in a line is
 * code, bold is strong, the markup of emphasis, marks, links, wikilinks,
 * pictures and HTML is not counted. What a column of a table too long to
 * draw whole (Л9.12) is measured by.
 */
export function cellTextRuns(source: string): TableCellLines {
  return source.split(/<br\s*\/?>/i).map((line) => {
    const runs: TableTextRun[] = [];
    inlineRuns(line.replace(/\\\|/g, "|").trim(), "normal", runs);
    return runs;
  });
}

/** Every column's visible text, for the layout (Л9.10). */
export function tableColumnText(model: TableModel): TableColumnText[] {
  return Array.from({ length: model.columns }, (_, col) => ({
    header: cellTextRuns(cellSource(model, { row: 0, col })),
    body: Array.from({ length: rowCount(model) - 1 }, (_, index) => cellTextRuns(cellSource(model, { row: index + 1, col }))),
  }));
}
