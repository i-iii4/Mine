// The source of one table cell and what its active editor shows of it
// (SPEC_EDITING.md, Л9.5; Local MD, 06.06.2026): `<br>` in any of its forms
// shows as a line break, the escaped pipe `\|` as `|`, everything else as
// written. A boundary map ties every shown position to a source offset, so an
// edit of the shown text becomes the smallest edit of the source: the pieces
// it does not touch keep their bytes, and only the text typed or pasted is
// encoded (`|` as `\|`, a line break as `<br>`). The cell never splits: a pipe
// left unescaped by an edit gets its backslash.
//
// Pairing follows micromark-extension-gfm-table, which the reading mode parses
// tables with: in a cell, `\` followed by `\` or `|` is one pair of data, so
// `\|` does not end the cell and `\\|` does.

/** What the active cell shows of a cell's source, with the way back. */
export interface CellView {
  /** The shown text: line breaks for `<br>`, `|` for `\|`. */
  text: string;
  /** The source offset of every shown position, `text.length + 1` of them:
   *  a position between two pieces maps to the source between them. */
  sourceAt: readonly number[];
}

/** One edit of the shown text, in its positions. */
export interface CellEdit {
  from: number;
  to: number;
  insert: string;
}

/** The line break of a cell's source. */
export const CELL_LINE_BREAK = "<br>";

/** `<br>`, `<br/>`, `<br />`, in any case. */
const LINE_BREAK_TAG = /^<br\s*\/?>/i;
const BACKSLASH = "\\";
const PIPE = "|";

/** Whether `text` ends with a backslash that pairs with what follows it: an
 *  odd run of backslashes at its end. */
export function endsWithUnpairedBackslash(text: string): boolean {
  let run = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === BACKSLASH; index -= 1) run += 1;
  return run % 2 === 1;
}

/** The offsets of the pipes in `source` that end a cell: those not paired
 *  with a backslash before them. */
export function unescapedPipes(source: string): number[] {
  const found: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const sign = source[index];
    if (sign === BACKSLASH && (source[index + 1] === BACKSLASH || source[index + 1] === PIPE)) {
      index += 1;
    } else if (sign === PIPE) {
      found.push(index);
    }
  }
  return found;
}

/** What the active cell shows of `source`, with its boundary map. */
export function decodeCell(source: string): CellView {
  let text = "";
  const sourceAt: number[] = [];
  let index = 0;
  while (index < source.length) {
    sourceAt.push(index);
    const sign = source[index];
    if (sign === BACKSLASH && source[index + 1] === PIPE) {
      text += PIPE;
      index += 2;
      continue;
    }
    if (sign === BACKSLASH && source[index + 1] === BACKSLASH) {
      // A pair of backslashes shows as written, one position each.
      text += BACKSLASH;
      sourceAt.push(index + 1);
      text += BACKSLASH;
      index += 2;
      continue;
    }
    if (sign === "<") {
      const tag = LINE_BREAK_TAG.exec(source.slice(index, index + 8));
      if (tag) {
        text += "\n";
        index += tag[0].length;
        continue;
      }
    }
    text += sign;
    index += 1;
  }
  sourceAt.push(source.length);
  return { text, sourceAt };
}

/** The source offset of shown position `pos`, clamped to the cell. */
export function sourceOffset(view: CellView, pos: number): number {
  const clamped = Math.max(0, Math.min(view.text.length, pos));
  return view.sourceAt[clamped] ?? view.sourceAt[view.sourceAt.length - 1] ?? 0;
}

/** The shown position of source offset `offset`: the last shown position at
 *  or before it, so an offset inside a `<br>` or `\|` falls before it. */
export function shownOffset(view: CellView, offset: number): number {
  let low = 0;
  let high = view.sourceAt.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((view.sourceAt[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Text typed or pasted into a cell, as its source: every line break (`\r\n`,
 * `\r`, `\n`) as `<br>`, every `|` as `\|`, except a `|` right after a
 * backslash that is still unpaired, which it completes as written (`\|`).
 * `before` is the source the text lands after.
 */
export function encodeCellText(text: string, before: string): string {
  let encoded = "";
  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) encoded += CELL_LINE_BREAK;
    for (const sign of line) {
      if (sign === PIPE && !endsWithUnpairedBackslash(before + encoded)) encoded += BACKSLASH;
      encoded += sign;
    }
  });
  return encoded;
}

/** `source` with a backslash before every pipe that would end the cell. */
export function escapeLoosePipes(source: string): string {
  const pipes = unescapedPipes(source);
  if (pipes.length === 0) return source;
  let result = "";
  let last = 0;
  for (const pipe of pipes) {
    result += source.slice(last, pipe) + BACKSLASH;
    last = pipe;
  }
  return result + source.slice(last);
}

/**
 * The source of a cell after `edits` of its shown text, given in the shown
 * positions before them and in order (as a transaction's changes): each
 * edit replaces the source of its shown range and encodes only its own
 * text; untouched pieces keep their bytes. A pipe the edit left unescaped
 * gets its backslash, so the cell never splits.
 */
export function editCellSource(source: string, edits: readonly CellEdit[]): string {
  const view = decodeCell(source);
  let result = "";
  let consumed = 0;
  for (const edit of [...edits].sort((left, right) => left.from - right.from)) {
    const from = Math.max(consumed, sourceOffset(view, edit.from));
    const to = Math.max(from, sourceOffset(view, edit.to));
    result += source.slice(consumed, from);
    result += encodeCellText(edit.insert, result);
    consumed = to;
  }
  result += source.slice(consumed);
  return escapeLoosePipes(result);
}

/** The smallest single replacement that turns `before` into `after`: their
 *  common start and end stay. */
export function smallestReplacement(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let end = 0;
  while (
    end < shorter - start
    && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) {
    end += 1;
  }
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

/**
 * The shown position under offset `offset` of a cell's drawn text
 * (`rendered`, the text of the drawn cell without its markup): the drawn text
 * is walked against the shown text, every drawn sign taking the next equal
 * shown sign; signs of markup in between (`**`, `[`, `](…)`, backticks) are
 * passed over. A drawn sign with no match ahead (a formula drawn by KaTeX) is
 * left out, so the result is always a position of the shown text.
 */
export function shownOffsetOfRendered(rendered: string, shown: string, offset: number): number {
  let position = 0;
  const target = Math.max(0, Math.min(rendered.length, offset));
  for (let index = 0; index < target; index += 1) {
    const sign = rendered[index];
    const found = sign === undefined ? -1 : shown.indexOf(sign === " " ? " " : sign, position);
    const exact = sign === undefined ? -1 : shown.indexOf(sign, position);
    const match = exact >= 0 ? exact : found;
    if (match >= 0) position = match + 1;
  }
  return position;
}
