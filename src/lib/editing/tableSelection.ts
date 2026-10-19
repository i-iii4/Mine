// Who owns an active table, and the cell range with its clipboard
// (SPEC_EDITING.md, Л9.2, Л9.7; Local MD, SPEC_TABLE_STRUCTURE_CONTROLS,
// «Mutually exclusive interaction ownership»). At any moment exactly one
// owner: nothing, one cell's editor, one rectangular range of cells, the
// move of one row, the move of one column. Entering an owner leaves the one
// before; hover owns nothing. Text selected in a cell and a range of cells
// are two different owners and never one ambiguous selection.
//
// A range copies as text (cells by tabs, rows by line breaks, a line break
// inside a cell as a space) and beside it as an HTML table that keeps those
// line breaks; a paste reads the HTML table first, the text otherwise.

import { encodeCellText } from "./tableCell";
import type { CellWrite, TableCellRef } from "./tableModel";

/** The owner of an active table. */
export type TableOwner =
  | { kind: "idle" }
  | { kind: "cell"; cell: TableCellRef }
  | { kind: "range"; anchor: TableCellRef; head: TableCellRef }
  | { kind: "reorder-row"; row: number }
  | { kind: "reorder-column"; col: number };

/** What happens to an active table's owner. */
export type TableOwnerEvent =
  /** A cell's editor takes the caret: a click, a key, a command. */
  | { type: "edit-cell"; cell: TableCellRef }
  /** A range starts at its anchor or extends to `head`: a drag over a cell
   *  border, ⇧-click, ⇧↑ ⇧↓. */
  | { type: "extend-range"; head: TableCellRef }
  /** A whole row or column is chosen (its handle, Л9.8). */
  | { type: "choose-row"; row: number; columns: number }
  | { type: "choose-column"; col: number; rows: number }
  /** A row's or column's handle starts to move it. */
  | { type: "start-reorder-row"; row: number }
  | { type: "start-reorder-column"; col: number }
  /** The move was dropped at `to`: the moved row or column is chosen there. */
  | { type: "drop"; to: number; rows: number; columns: number }
  /** Escape, a click outside the table, an undo or a change of its source:
   *  the range or the move ends. */
  | { type: "cancel" };

/** The rectangle of a range, both ends included. */
export interface CellRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The owner after `event` (Л9.2). */
export function nextOwner(owner: TableOwner, event: TableOwnerEvent): TableOwner {
  switch (event.type) {
    case "edit-cell":
      // Text in a cell and a range are never held together; a move holds
      // the pointer until it drops or ends.
      if (owner.kind === "reorder-row" || owner.kind === "reorder-column") return owner;
      return { kind: "cell", cell: event.cell };
    case "extend-range": {
      if (owner.kind === "cell") return { kind: "range", anchor: owner.cell, head: event.head };
      if (owner.kind === "range") return { kind: "range", anchor: owner.anchor, head: event.head };
      if (owner.kind === "idle") return { kind: "range", anchor: event.head, head: event.head };
      // During a move ranges are inert.
      return owner;
    }
    case "choose-row":
      if (owner.kind === "reorder-row" || owner.kind === "reorder-column") return owner;
      return { kind: "range", anchor: { row: event.row, col: 0 }, head: { row: event.row, col: Math.max(0, event.columns - 1) } };
    case "choose-column":
      if (owner.kind === "reorder-row" || owner.kind === "reorder-column") return owner;
      return { kind: "range", anchor: { row: 0, col: event.col }, head: { row: Math.max(0, event.rows - 1), col: event.col } };
    case "start-reorder-row":
      // The header row is not moved (Л9.8).
      return event.row > 0 ? { kind: "reorder-row", row: event.row } : owner;
    case "start-reorder-column":
      return { kind: "reorder-column", col: event.col };
    case "drop":
      if (owner.kind === "reorder-row") {
        return nextOwner({ kind: "idle" }, { type: "choose-row", row: Math.max(1, event.to), columns: event.columns });
      }
      if (owner.kind === "reorder-column") {
        return nextOwner({ kind: "idle" }, { type: "choose-column", col: event.to, rows: event.rows });
      }
      return owner;
    case "cancel":
      // A range ends on its anchor cell's editor; a move leaves nothing.
      if (owner.kind === "range") return { kind: "cell", cell: owner.anchor };
      if (owner.kind === "reorder-row" || owner.kind === "reorder-column") return { kind: "idle" };
      return owner;
  }
}

/** The rectangle of a range, whichever way it was drawn. */
export function rangeRect(anchor: TableCellRef, head: TableCellRef): CellRect {
  return {
    top: Math.min(anchor.row, head.row),
    left: Math.min(anchor.col, head.col),
    bottom: Math.max(anchor.row, head.row),
    right: Math.max(anchor.col, head.col),
  };
}

/** Whether `cell` is in `rect`. */
export function inRect(rect: CellRect, cell: TableCellRef): boolean {
  return cell.row >= rect.top && cell.row <= rect.bottom && cell.col >= rect.left && cell.col <= rect.right;
}

/** `cell` kept inside a table of `rows` by `columns`. */
export function clampCell(cell: TableCellRef, rows: number, columns: number): TableCellRef {
  return {
    row: Math.max(0, Math.min(rows - 1, cell.row)),
    col: Math.max(0, Math.min(columns - 1, cell.col)),
  };
}

// ─── Clipboard ──────────────────────────────────────────────────────────────

/** The text of a range (Л9.7): cells by tabs, rows by line breaks, a line
 *  break inside a cell as a space. `cells` holds what each cell shows. */
export function rangeAsText(cells: readonly (readonly string[])[]): string {
  return cells.map((row) => row.map((cell) => cell.replace(/\r\n|\r|\n|\t/g, " ")).join("\t")).join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The HTML table of a range (Л9.7): Numbers, Excel and a paste into Mine
 *  take the line breaks inside cells from it. */
export function rangeAsHtml(cells: readonly (readonly string[])[]): string {
  const rows = cells.map((row) => `<tr>${row.map((cell) => `<td>${cell.split(/\r\n|\r|\n/).map(escapeHtml).join("<br>")}</td>`).join("")}</tr>`);
  return `<table><tbody>${rows.join("")}</tbody></table>`;
}

/** The text of an HTML cell: `<br>` and blocks as line breaks. */
function htmlCellText(cell: Element): string {
  let text = "";
  const visit = (node: Node) => {
    if (node.nodeType === node.TEXT_NODE) {
      text += (node.textContent ?? "").replace(/\s+/g, " ");
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    const block = node.tagName === "P" || node.tagName === "DIV";
    if (block && text !== "" && !text.endsWith("\n")) text += "\n";
    for (const child of node.childNodes) visit(child);
  };
  for (const child of cell.childNodes) visit(child);
  return text.trim().replace(/ *\n */g, "\n");
}

/**
 * The cells a paste carries (Л9.7): the first HTML table of `html` when it
 * has one, its line breaks inside cells kept; otherwise `text` split into
 * rows by line breaks and into cells by tabs. A final empty line of the
 * text does not count.
 */
export function clipboardCells(html: string | null, text: string): string[][] {
  if (html && typeof DOMParser !== "undefined") {
    const table = new DOMParser().parseFromString(html, "text/html").querySelector("table");
    if (table) {
      const rows = [...table.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("td, th")].map(htmlCellText));
      if (rows.length > 0) return rows;
    }
  }
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}

/**
 * The writes of a paste into a range (Л9.7): the clipboard's rectangle
 * starts at the range's top left cell and is cut at the table's edges; a
 * clipboard of one cell fills the whole range. Text is encoded as a cell's
 * source: a pipe as `\|`, a line break as `<br>`.
 */
export function pasteWrites(rect: CellRect, clipboard: readonly (readonly string[])[], rows: number, columns: number): CellWrite[] {
  const writes: CellWrite[] = [];
  const single = clipboard.length === 1 && clipboard[0]?.length === 1;
  if (single) {
    const source = encodeCellText(clipboard[0]?.[0] ?? "", "");
    for (let row = rect.top; row <= Math.min(rect.bottom, rows - 1); row += 1) {
      for (let col = rect.left; col <= Math.min(rect.right, columns - 1); col += 1) writes.push({ ref: { row, col }, source });
    }
    return writes;
  }
  clipboard.forEach((cells, rowOffset) => {
    const row = rect.top + rowOffset;
    if (row >= rows) return;
    cells.forEach((text, colOffset) => {
      const col = rect.left + colOffset;
      if (col >= columns) return;
      writes.push({ ref: { row, col }, source: encodeCellText(text, "") });
    });
  });
  return writes;
}

/** The writes that clear a range (Л9.7): every cell's content, the table's
 *  structure stays. */
export function clearWrites(rect: CellRect, rows: number, columns: number): CellWrite[] {
  const writes: CellWrite[] = [];
  for (let row = rect.top; row <= Math.min(rect.bottom, rows - 1); row += 1) {
    for (let col = rect.left; col <= Math.min(rect.right, columns - 1); col += 1) writes.push({ ref: { row, col }, source: "" });
  }
  return writes;
}

/** The writes of typing over a range (Л9.7): the range is cleared and the
 *  text goes into its anchor cell. */
export function typeOverWrites(rect: CellRect, anchor: TableCellRef, text: string, rows: number, columns: number): CellWrite[] {
  const source = encodeCellText(text, "");
  return clearWrites(rect, rows, columns).map((write) => (
    write.ref.row === anchor.row && write.ref.col === anchor.col ? { ref: write.ref, source } : write
  ));
}
