// The difference between the document and the file's new body, as the
// changes that turn one into the other (SPEC_EDITING.md, Л4.2): the common
// start and end first, then whole lines in between, then the common start and
// end of each changed run of lines. Applied as one transaction kept out of
// the history, the changes carry the caret, the selection, what is revealed
// and the scroll position through the external edit, and ⌘Z undoes only the
// session's own edits.

import { Annotation, Text, Transaction, type ChangeSpec, type EditorState, type TransactionSpec } from "@codemirror/state";
import { keepLineBreaks } from "./lineEndings";

/** Past this many deleted and inserted lines the middle is replaced whole:
 *  the difference of two unrelated bodies is not worth its time and memory. */
export const RELOAD_DIFF_MAX_EDITS = 500;

/** Marks the transaction of an external change, which presentation waits
 *  out (Л5.5) and the history keeps out (Л4.10). */
export const externalChange = Annotation.define<boolean>();

/** One run of changed lines: lines `[oldFrom, oldTo)` of the old ones
 *  became lines `[newFrom, newTo)` of the new ones. */
export interface LineHunk {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
}

/**
 * The runs of `before` that differ from `after`, by Myers' difference: the
 * fewest deleted and inserted lines. `null` when that takes more than
 * `maxEdits` of them.
 */
export function lineHunks(before: readonly string[], after: readonly string[], maxEdits = RELOAD_DIFF_MAX_EDITS): LineHunk[] | null {
  const n = before.length;
  const m = after.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const furthest = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let distance = 0;
  let done = false;
  for (; distance <= max && !done; distance += 1) {
    trace.push(furthest.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const fromAbove = diagonal === -distance
        || (diagonal !== distance && (furthest[offset + diagonal - 1] ?? 0) < (furthest[offset + diagonal + 1] ?? 0));
      let x = fromAbove ? (furthest[offset + diagonal + 1] ?? 0) : (furthest[offset + diagonal - 1] ?? 0) + 1;
      let y = x - diagonal;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      furthest[offset + diagonal] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
  }
  if (!done) return null;
  // Back through the trace: every diagonal step is a pair of equal lines.
  const equal: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let step = trace.length - 1; step >= 0; step -= 1) {
    const previous = trace[step];
    if (!previous) break;
    const diagonal = x - y;
    const fromAbove = diagonal === -step
      || (diagonal !== step && (previous[offset + diagonal - 1] ?? 0) < (previous[offset + diagonal + 1] ?? 0));
    const previousDiagonal = fromAbove ? diagonal + 1 : diagonal - 1;
    const previousX = step === 0 ? 0 : (previous[offset + previousDiagonal] ?? 0);
    const previousY = step === 0 ? 0 : previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      equal.push([x, y]);
    }
    x = previousX;
    y = previousY;
  }
  equal.reverse();
  const hunks: LineHunk[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const [oldLine, newLine] of [...equal, [n, m] as [number, number]]) {
    if (oldLine > oldCursor || newLine > newCursor) {
      hunks.push({ oldFrom: oldCursor, oldTo: oldLine, newFrom: newCursor, newTo: newLine });
    }
    oldCursor = oldLine + 1;
    newCursor = newLine + 1;
  }
  return hunks;
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

function commonSuffix(a: string, b: string, limit: number): number {
  let index = 0;
  while (index < limit && a.charCodeAt(a.length - 1 - index) === b.charCodeAt(b.length - 1 - index)) index += 1;
  return index;
}

/** `text`, whose lines are joined by `\n` here, as a document's text. */
function asText(text: string): Text {
  return Text.of(text.split("\n"));
}

/** The change of `before`, which starts at `start`, into `insert`, trimmed
 *  to what differs; `null` when nothing does. */
function trimmedChange(before: string, start: number, insert: string): ChangeSpec | null {
  if (before === insert) return null;
  const prefix = commonPrefix(before, insert);
  const suffix = commonSuffix(before, insert, Math.min(before.length, insert.length) - prefix);
  return {
    from: start + prefix,
    to: start + before.length - suffix,
    insert: asText(insert.slice(prefix, insert.length - suffix)),
  };
}

/** `text` cut into lines that keep their `\n`; the last may have none. */
function linesWithBreaks(text: string): string[] {
  const lines = text.split("\n");
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
}

/**
 * The changes that turn document `before` into `after` (Л4.2). Positions are
 * the document's: a line break counts as one position whatever the file's
 * line ending, and inserted text is given as lines, so it never leans on the
 * state's line separator.
 */
export function reloadChanges(before: Text, after: Text): ChangeSpec[] {
  // `\n` joins the lines here whatever the document's separator, so string
  // offsets are positions.
  const a = before.sliceString(0, before.length, "\n");
  const b = after.sliceString(0, after.length, "\n");
  if (a === b) return [];
  const prefix = commonPrefix(a, b);
  const suffix = commonSuffix(a, b, Math.min(a.length, b.length) - prefix);
  const oldMiddle = a.slice(prefix, a.length - suffix);
  const newMiddle = b.slice(prefix, b.length - suffix);
  const oldLines = linesWithBreaks(oldMiddle);
  const newLines = linesWithBreaks(newMiddle);
  const hunks = oldLines.length > 1 || newLines.length > 1 ? lineHunks(oldLines, newLines) : null;
  if (!hunks) {
    const whole = trimmedChange(oldMiddle, prefix, newMiddle);
    return whole ? [whole] : [];
  }
  const oldStarts = [prefix];
  for (const line of oldLines) oldStarts.push((oldStarts[oldStarts.length - 1] ?? prefix) + line.length);
  const changes: ChangeSpec[] = [];
  for (const hunk of hunks) {
    const oldText = oldLines.slice(hunk.oldFrom, hunk.oldTo).join("");
    const newText = newLines.slice(hunk.newFrom, hunk.newTo).join("");
    const change = trimmedChange(oldText, oldStarts[hunk.oldFrom] ?? prefix, newText);
    if (change) changes.push(change);
  }
  return changes;
}

/**
 * The transaction that applies the file's body `text` to `state` (Л4.2): the
 * least changes, out of the history, with the line breaks as the file has
 * them, marked as an external change.
 */
export function externalChangeSpec(state: EditorState, text: string): TransactionSpec {
  const after = state.toText(text);
  return {
    changes: reloadChanges(state.doc, after),
    annotations: [Transaction.addToHistory.of(false), keepLineBreaks, externalChange.of(true)],
  };
}
