// The table editor of the note's editor (SPEC_EDITING.md, Л9): a table of the
// note's top level is a widget the main editor's caret never stands in, in
// one of three states: drawn, active (this editor), or its source (`Edit as
// Markdown`). The active table has one owner (`tableSelection.ts`): one
// cell's editor, one range of cells, or nothing. The cell's editor is a
// view of its own that shows the cell's source (`tableCell.ts`) and holds no
// text and no history of its own: every edit of it becomes the smallest edit
// of the cell's content in the main document, one transaction of the main
// document's history (Л9.5). Undo and redo leave the cell (Local MD, C4).
//
// This module holds the active table's state in the main editor, the
// commands of its keys (Л9.6), of its range (Л9.7) and of its structure
// (Л9.8, Л9.11), and what typing at a table's edges does: the table stays
// whole. The host (`TableEditor.tsx`) draws the table and makes the cell's
// view.

import {
  Annotation,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type ChangeSpec,
  type Extension,
} from "@codemirror/state";
import { EditorView, ViewPlugin, highlightSpecialChars, keymap, type KeyBinding, type ViewUpdate } from "@codemirror/view";
import { redo, selectAll, standardKeymap, undo } from "@codemirror/commands";
import { blocksOf, type EditorBlock } from "./blocks";
import { keepLineBreaks } from "./lineEndings";
import { revealBlockEffect } from "./reveal";
import { decodeCell, editCellSource, type CellEdit } from "./tableCell";
import {
  alignColumn,
  applyTableChanges,
  cellEditRange,
  cellSource,
  clearColumn,
  clearRow,
  deleteColumn,
  deleteRow,
  duplicateColumn,
  duplicateRow,
  editLineCell,
  insertColumn,
  insertRow,
  lineOfRow,
  moveColumn,
  moveRow,
  rowCount,
  tableModel,
  writeCells,
  type CellWrite,
  type TableCellRef,
  type TableModel,
  type TableTextChange,
  type TextRange,
} from "./tableModel";
import {
  clampCell,
  clearWrites,
  nextOwner,
  pasteWrites,
  rangeRect,
  typeOverWrites,
  type CellRect,
  type TableOwner,
} from "./tableSelection";

/** Where a cell's editor puts its caret when it opens. */
export type CellCaret =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "all" }
  /** A position of the shown text. */
  | { kind: "offset"; offset: number }
  /** The column of the caret in the cell left: on the first line of the new
   *  cell when it came from above, on its last when it came from below,
   *  clamped to the line (Л9.6). */
  | { kind: "column"; column: number; fromAbove: boolean }
  /** A point on the screen: arrows from the text beside the table. */
  | { kind: "point"; x: number; y: number };

/** The active table of the main editor. */
export interface ActiveTable {
  /** Its lines in the document, carried through changes. */
  from: number;
  to: number;
  owner: TableOwner;
  /** The editing range of the active cell's source: its content as the
   *  cell's editor holds it. `null` without a cell's editor and for a cell
   *  missing from a ragged row. */
  edit: TextRange | null;
  /** Where the cell's editor opens its caret. */
  caret: CellCaret;
  /** Grows when the table is drawn anew: a new owner, a structure command,
   *  a change from outside the cell's editor. */
  generation: number;
  /** Grows when the table is activated and when its structure changes: the
   *  widths, frozen while it is active, are measured again (Л9.10). */
  layout: number;
}

/** The table's kinds of change: a cell's editor, a range, a structure
 *  command, a move of the caret. */
export type TableEditKind = "cell" | "range" | "structure" | "select";

/** Marks the main transactions the table editor makes. */
export const tableEdit = Annotation.define<TableEditKind>();

/** Sets the active table, or ends it. */
export const setActiveTable = StateEffect.define<ActiveTable | null>();

/** The user events that mean the person acted elsewhere in the main
 *  editor: the active table ends. */
const ELSEWHERE = ["select", "input", "delete", "move"];

/** The top-level table whose lines hold `pos`; a table in a quote or a list
 *  item is edited as its container's source (Л9.1). */
export function topLevelTableAt(state: EditorState, pos: number): EditorBlock | null {
  return blocksOf(state, pos, pos).find((block) => (
    block.kind === "table" && block.containers.length === 0 && block.from <= pos && pos <= block.to
  )) ?? null;
}

/** The text of the table between `from` and `to`, its lines joined by one
 *  `\n` as CodeMirror counts them. */
export function tableTextAt(state: EditorState, from: number, to: number): string {
  return state.doc.sliceString(from, to, "\n");
}

/** The model of the active table. */
export function activeModel(state: EditorState, active: ActiveTable): TableModel | null {
  return tableModel(tableTextAt(state, active.from, active.to));
}

function editRangeOf(model: TableModel, tableFrom: number, ref: TableCellRef): TextRange | null {
  const line = lineOfRow(model, ref.row);
  const range = line ? cellEditRange(line, ref.col) : null;
  return range ? { from: tableFrom + range.from, to: tableFrom + range.to } : null;
}

/** The active table again after a change from outside it, or `null` when
 *  there is no table there any more: the same cell, its content as now
 *  written; a range ends on its anchor (Л9.7). */
function refreshed(state: EditorState, value: ActiveTable, from: number): ActiveTable | null {
  const block = topLevelTableAt(state, from);
  if (!block || block.from !== from) return null;
  const model = tableModel(tableTextAt(state, block.from, block.to));
  if (!model) return null;
  const owner = value.owner.kind === "range" ? nextOwner(value.owner, { type: "cancel" }) : value.owner;
  const cell = owner.kind === "cell" ? clampCell(owner.cell, rowCount(model), model.columns) : null;
  return {
    ...value,
    from: block.from,
    to: block.to,
    owner: cell ? { kind: "cell", cell } : owner,
    edit: cell ? editRangeOf(model, block.from, cell) : null,
    caret: { kind: "end" },
    generation: value.generation + 1,
  };
}

/** The active table of the main editor (Л9.2). */
export const tableEditorField = StateField.define<ActiveTable | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setActiveTable)) return effect.value;
    if (!value) return null;
    // Undo and redo leave the cell: its text is the document's again (C4).
    if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return null;
    const own = tr.annotation(tableEdit) !== undefined;
    if (!own && tr.selection && ELSEWHERE.some((event) => tr.isUserEvent(event))) return null;
    if (!tr.docChanged) return value;
    let touched = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (toA >= value.from && fromA <= value.to) touched = true;
    });
    if (!touched) {
      return {
        ...value,
        from: tr.changes.mapPos(value.from, -1),
        to: tr.changes.mapPos(value.to, -1),
        edit: value.edit ? { from: tr.changes.mapPos(value.edit.from, -1), to: tr.changes.mapPos(value.edit.to, 1) } : null,
      };
    }
    return refreshed(tr.state, value, tr.changes.mapPos(value.from, -1));
  },
});

/** The active table of `state`. */
export function activeTable(state: EditorState): ActiveTable | null {
  return state.field(tableEditorField, false) ?? null;
}

// ─── Listeners of the host ──────────────────────────────────────────────────

/** What the host hears: the active table changed, or the document. */
type TableListener = (update: ViewUpdate) => void;

const listeners = new WeakMap<EditorView, Set<TableListener>>();

/** Hear the main editor's updates while a table is active or becomes so. */
export function subscribeTable(view: EditorView, listener: TableListener): () => void {
  let set = listeners.get(view);
  if (!set) {
    set = new Set();
    listeners.set(view, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

const tableListenerPlugin = ViewPlugin.fromClass(class {
  update(update: ViewUpdate) {
    const before = activeTable(update.startState);
    const after = activeTable(update.state);
    if (before === after && !(after && update.docChanged)) return;
    for (const listener of listeners.get(update.view) ?? []) listener(update);
  }
});

// ─── The cell's editor ──────────────────────────────────────────────────────

/** The cell's editor of a main editor, while one is open. */
export interface CellEditorHandle {
  view: EditorView;
  /** The cell's text came from the main document: show it. */
  resync(): void;
}

const cellEditors = new WeakMap<EditorView, CellEditorHandle>();

/** The host registers the cell's editor it made; the commands focus it. */
export function registerCellEditor(main: EditorView, handle: CellEditorHandle): () => void {
  cellEditors.set(main, handle);
  return () => {
    if (cellEditors.get(main) === handle) cellEditors.delete(main);
  };
}

/** The open cell's editor of `main`. */
export function cellEditorOf(main: EditorView): CellEditorHandle | null {
  return cellEditors.get(main) ?? null;
}

/** What the active cell shows: its source's text with `<br>` as a line
 *  break and `\|` as `|` (Л9.5). Empty for a missing cell. */
export function activeCellText(state: EditorState): string {
  const active = activeTable(state);
  if (!active?.edit) return "";
  return decodeCell(state.sliceDoc(active.edit.from, active.edit.to)).text;
}

/** The changes of a transaction of the cell's editor, in the shown
 *  positions before it. */
function cellEdits(tr: Transaction): CellEdit[] {
  const edits: CellEdit[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    edits.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return edits;
}

/** The user event a main transaction carries for a cell edit: the cell's
 *  own, so the history groups typing as it groups typing in text. */
function userEventOf(tr: Transaction): string {
  for (const event of ["input.type.compose", "input.type", "input.paste", "input.drop", "input", "delete.backward", "delete.forward", "delete.cut", "delete", "move.drop"]) {
    if (tr.isUserEvent(event)) return event;
  }
  return "input";
}

/**
 * Carry an edit of the cell's editor into the main document (Л9.5): the
 * smallest edit of the cell's content, a missing cell added at the end of
 * its row, one transaction of the main history. Returns whether it went.
 */
export function applyCellEdit(main: EditorView, tr: Transaction): boolean {
  const state = main.state;
  const active = activeTable(state);
  if (!active || active.owner.kind !== "cell" || !tr.docChanged) return false;
  const ref = active.owner.cell;
  const firstLine = state.doc.lineAt(active.from).number;
  const lineNumber = firstLine + (ref.row === 0 ? 0 : ref.row + 1);
  if (lineNumber > state.doc.lines) return false;
  const line = state.doc.line(lineNumber);
  const before = active.edit ? state.sliceDoc(active.edit.from, active.edit.to) : "";
  const source = editCellSource(before, cellEdits(tr));
  const range = active.edit ? { from: active.edit.from - line.from, to: active.edit.to - line.from } : null;
  const written = editLineCell(line.text, ref.row === 0, ref.col, range, source);
  const changes: ChangeSpec[] = written.change
    ? [{ from: line.from + written.change.from, to: line.from + written.change.to, insert: written.change.insert }]
    : [];
  const delta = written.change ? written.change.insert.length - (written.change.to - written.change.from) : 0;
  main.dispatch({
    changes,
    effects: setActiveTable.of({
      ...active,
      to: active.to + delta,
      edit: { from: line.from + written.range.from, to: line.from + written.range.to },
    }),
    annotations: [tableEdit.of("cell"), keepLineBreaks, Transaction.userEvent.of(userEventOf(tr))],
  });
  return true;
}

// ─── Activation and leaving ─────────────────────────────────────────────────

function activation(state: EditorState, block: { from: number; to: number }, owner: TableOwner, caret: CellCaret, previous: ActiveTable | null): ActiveTable | null {
  const model = tableModel(tableTextAt(state, block.from, block.to));
  if (!model) return null;
  const cell = owner.kind === "cell" ? clampCell(owner.cell, rowCount(model), model.columns) : null;
  const generation = (previous?.generation ?? 0) + 1;
  return {
    from: block.from,
    to: block.to,
    owner: cell ? { kind: "cell", cell } : owner,
    edit: cell ? editRangeOf(model, block.from, cell) : null,
    caret,
    generation,
    layout: previous && previous.from === block.from ? previous.layout : generation,
  };
}

/**
 * Open the cell `ref` of the table `block` in its editor (Л9.4, Л9.5), the
 * caret where `caret` says; the main editor's caret goes to the table's
 * start, where it draws nothing. A table that is no table the editor can
 * edit opens as its source.
 */
export function enterTableCell(view: EditorView, block: { from: number; to: number }, ref: TableCellRef, caret: CellCaret): boolean {
  const previous = activeTable(view.state);
  const next = activation(view.state, block, { kind: "cell", cell: ref }, caret, previous);
  if (!next) return showTableSource(view, block.from);
  view.dispatch({
    selection: EditorSelection.cursor(block.from),
    effects: setActiveTable.of(next),
    annotations: tableEdit.of("select"),
  });
  return true;
}

/** The cell of row `row` of the drawn table `block` that stands under the
 *  horizontal place `x`, and the point to put the caret at: the nearest
 *  cell when none is under it, the first when the screen tells nothing. */
function cellUnder(view: EditorView, block: { from: number }, row: number, x: number | null, fromAbove: boolean): { col: number; caret: CellCaret } {
  const fallback = { col: 0, caret: fromAbove ? { kind: "start" as const } : { kind: "end" as const } };
  if (x === null) return fallback;
  const widget = [...view.contentDOM.querySelectorAll<HTMLElement>("[data-editor-block='table']")]
    .find((dom) => dom.isConnected && view.posAtDOM(dom) === block.from);
  const cells = widget ? [...widget.querySelectorAll<HTMLElement>(`[data-table-row='${row}'][data-table-col]`)] : [];
  let best: { col: number; distance: number; rect: DOMRect } | null = null;
  for (const cell of cells) {
    const rect = cell.getBoundingClientRect();
    if (rect.width <= 0) continue;
    const distance = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    if (!best || distance < best.distance) best = { col: Number(cell.dataset.tableCol), distance, rect };
  }
  if (!best) return fallback;
  const y = fromAbove ? best.rect.top + 1 : best.rect.bottom - 1;
  return { col: best.col, caret: { kind: "point", x: Math.min(Math.max(x, best.rect.left), best.rect.right), y } };
}

/** ↓ from the line above a table opens its header, ↑ from the line below
 *  its last row, in the cell under the caret (Л9.6). */
export function enterTableFromText(view: EditorView, block: { from: number; to: number }, fromAbove: boolean, x: number | null): boolean {
  const model = tableModel(tableTextAt(view.state, block.from, block.to));
  if (!model) return showTableSource(view, block.from);
  const row = fromAbove ? 0 : rowCount(model) - 1;
  const { col, caret } = cellUnder(view, block, row, x, fromAbove);
  return enterTableCell(view, block, { row, col }, caret);
}

/** Where the main editor's caret goes when it leaves the table. */
export type TableExit = "before" | "after" | "above" | "below";

/**
 * Leave the active table (Л9.6): Escape and → past the last cell put the
 * caret right after it, ⇧Tab and ← before the first before it, ↑ from the
 * header on the line above, ↓ from the last row on the line below, at the
 * horizontal place `x` when the screen gives one.
 */
export function leaveTable(view: EditorView, exit: TableExit, x: number | null = null): boolean {
  const active = activeTable(view.state);
  if (!active) return false;
  const doc = view.state.doc;
  let pos: number;
  if (exit === "after" || exit === "below") pos = active.to < doc.length ? active.to + 1 : active.to;
  else pos = active.from > 0 ? active.from - 1 : active.from;
  if (x !== null && (exit === "above" || exit === "below") && pos !== active.from && pos !== active.to) {
    const line = view.lineBlockAt(pos);
    const found = view.posAtCoords({ x, y: view.documentTop + line.top + line.height / 2 }, false);
    if (found >= line.from && found <= line.to) pos = found;
  }
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: setActiveTable.of(null),
    annotations: tableEdit.of("select"),
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** End the active table without moving the main editor's caret: a click
 *  outside it. */
export function deactivateTable(view: EditorView): void {
  if (!activeTable(view.state)) return;
  view.dispatch({ effects: setActiveTable.of(null), annotations: tableEdit.of("select") });
}

/** Show the table at `from` as its source (Л9.2, `Edit as Markdown`). */
export function showTableSource(view: EditorView, from: number): boolean {
  view.dispatch({
    selection: EditorSelection.cursor(from),
    effects: [setActiveTable.of(null), revealBlockEffect.of(from)],
    annotations: tableEdit.of("select"),
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** Move the active table's cell editor to `ref`. */
export function moveToCell(view: EditorView, ref: TableCellRef, caret: CellCaret): boolean {
  const active = activeTable(view.state);
  if (!active) return false;
  return enterTableCell(view, active, ref, caret);
}

// ─── Keys of a cell (Л9.6) ──────────────────────────────────────────────────

function activeCell(view: EditorView): { active: ActiveTable; model: TableModel; cell: TableCellRef } | null {
  const active = activeTable(view.state);
  if (!active || active.owner.kind !== "cell") return null;
  const model = activeModel(view.state, active);
  return model ? { active, model, cell: active.owner.cell } : null;
}

/** Tab: the next cell; in the last cell a new row at the bottom and its
 *  first cell. */
export function nextCell(view: EditorView): boolean {
  const found = activeCell(view);
  if (!found) return false;
  const { model, cell } = found;
  if (cell.col + 1 < model.columns) return moveToCell(view, { row: cell.row, col: cell.col + 1 }, { kind: "end" });
  if (cell.row + 1 < rowCount(model)) return moveToCell(view, { row: cell.row + 1, col: 0 }, { kind: "end" });
  return runStructure(view, insertRow(model, rowCount(model) - 1, true), { row: rowCount(model), col: 0 }, { kind: "start" });
}

/** ⇧Tab, and ← at the start of a cell: the end of the cell before it; from
 *  the first cell out before the table. */
export function previousCell(view: EditorView): boolean {
  const found = activeCell(view);
  if (!found) return false;
  const { model, cell } = found;
  if (cell.col > 0) return moveToCell(view, { row: cell.row, col: cell.col - 1 }, { kind: "end" });
  if (cell.row > 0) return moveToCell(view, { row: cell.row - 1, col: model.columns - 1 }, { kind: "end" });
  return leaveTable(view, "before");
}

/** → at the end of a cell: the start of the cell after it, or out after
 *  the table from the last cell. */
export function cellAfter(view: EditorView): boolean {
  const found = activeCell(view);
  if (!found) return false;
  const { model, cell } = found;
  if (cell.col + 1 < model.columns) return moveToCell(view, { row: cell.row, col: cell.col + 1 }, { kind: "start" });
  if (cell.row + 1 < rowCount(model)) return moveToCell(view, { row: cell.row + 1, col: 0 }, { kind: "start" });
  return leaveTable(view, "after");
}

/** ↑ from a cell's first line and ↓ from its last: the cell of the same
 *  column above or below, the caret's column kept and clamped; out of the
 *  table from the header up and from the last row down. The delimiter row
 *  is no row. */
export function cellVertical(view: EditorView, down: boolean, column: number, x: number | null): boolean {
  const found = activeCell(view);
  if (!found) return false;
  const { model, cell } = found;
  const row = cell.row + (down ? 1 : -1);
  if (row < 0) return leaveTable(view, "above", x);
  if (row >= rowCount(model)) return leaveTable(view, "below", x);
  return moveToCell(view, { row, col: cell.col }, { kind: "column", column, fromAbove: down });
}

/** Whether the caret of `cell` is on its first (or last) visual line. */
function onEdgeLine(cell: EditorView, last: boolean): boolean {
  const head = cell.state.selection.main.head;
  const doc = cell.state.doc;
  const here = cell.coordsAtPos(head);
  const edge = cell.coordsAtPos(last ? doc.length : 0);
  if (here && edge && here.bottom - here.top > 0) {
    return last ? here.bottom >= edge.bottom - 1 : here.top <= edge.top + 1;
  }
  const line = doc.lineAt(head).number;
  return last ? line === doc.lines : line === 1;
}

/** The keys of a cell's editor (Л9.6, Л12): Enter waits for the decision
 *  ЛВ6 and does nothing meanwhile; the rest of CodeMirror's motions and
 *  deletions stand, Enter of `standardKeymap` left out. */
export function cellKeymap(main: EditorView): KeyBinding[] {
  const caretColumn = (cell: EditorView) => {
    const head = cell.state.selection.main.head;
    return head - cell.state.doc.lineAt(head).from;
  };
  const caretX = (cell: EditorView) => cell.coordsAtPos(cell.state.selection.main.head)?.left ?? null;
  const own: KeyBinding[] = [
    { key: "Tab", run: () => nextCell(main) },
    { key: "Shift-Tab", run: () => previousCell(main) },
    { key: "Enter", run: () => true },
    {
      key: "Shift-Enter",
      run: (cell) => {
        cell.dispatch(cell.state.replaceSelection("\n"), { userEvent: "input" });
        return true;
      },
    },
    { key: "Escape", run: () => leaveTable(main, "after") },
    {
      key: "ArrowLeft",
      run: (cell) => {
        const selection = cell.state.selection.main;
        return selection.empty && selection.head === 0 ? previousCell(main) : false;
      },
    },
    {
      key: "ArrowRight",
      run: (cell) => {
        const selection = cell.state.selection.main;
        return selection.empty && selection.head === cell.state.doc.length ? cellAfter(main) : false;
      },
    },
    {
      key: "ArrowUp",
      run: (cell) => (cell.state.selection.main.empty && onEdgeLine(cell, false) ? cellVertical(main, false, caretColumn(cell), caretX(cell)) : false),
    },
    {
      key: "ArrowDown",
      run: (cell) => (cell.state.selection.main.empty && onEdgeLine(cell, true) ? cellVertical(main, true, caretColumn(cell), caretX(cell)) : false),
    },
    { key: "Shift-ArrowUp", run: () => extendRangeBy(main, -1, 0) },
    { key: "Shift-ArrowDown", run: () => extendRangeBy(main, 1, 0) },
    // Backspace at the start and Delete at the end of a cell do nothing
    // (C1): they never reach the table's pipes.
    { key: "Backspace", run: (cell) => cell.state.selection.main.empty && cell.state.selection.main.head === 0 },
    { key: "Delete", run: (cell) => cell.state.selection.main.empty && cell.state.selection.main.head === cell.state.doc.length },
    // ⌘A selects the cell's text (C5).
    { key: "Mod-a", run: selectAll },
  ];
  return [...own, ...standardKeymap.filter((binding) => binding.key !== "Enter")];
}

/** Marks a transaction of the cell's editor that takes the main document's
 *  text: it is no edit to carry back. */
const cellSync = Annotation.define<boolean>();

/** The look of a cell's editor: none of its own, the cell's text and caret
 *  (Л15). */
const cellEditorTheme = EditorView.theme({
  "&": { color: "inherit", backgroundColor: "transparent", display: "block" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflow: "visible" },
  ".cm-content": { padding: "0", caretColor: "currentColor", fontFamily: "inherit", minWidth: "0" },
  ".cm-line": { padding: "0" },
  ".cm-specialChar": { color: "var(--muted-foreground)" },
});

/** The selection a cell's editor opens with (`CellCaret`). */
function caretSelection(cell: EditorView, caret: CellCaret): EditorSelection {
  const doc = cell.state.doc;
  const clamp = (pos: number) => Math.max(0, Math.min(doc.length, pos));
  switch (caret.kind) {
    case "start":
      return EditorSelection.single(0);
    case "end":
      return EditorSelection.single(doc.length);
    case "all":
      return EditorSelection.single(0, doc.length);
    case "offset":
      return EditorSelection.single(clamp(caret.offset));
    case "column": {
      const line = caret.fromAbove ? doc.line(1) : doc.line(doc.lines);
      return EditorSelection.single(line.from + Math.min(caret.column, line.length));
    }
    case "point":
      return EditorSelection.single(clamp(cell.posAtCoords({ x: caret.x, y: caret.y }, false)));
  }
}

/**
 * Open the active cell's editor in `parent` (Л9.5): a CodeMirror view of its
 * own that shows the cell's source, `<br>` as a line break and `\|` as `|`,
 * with the keys of a cell (Л9.6). It keeps no text and no history of its
 * own: every edit goes to the main document as the smallest edit of the
 * cell's content (`applyCellEdit`), and the view then shows what the main
 * document holds; a change of the cell from elsewhere shows at once. It
 * opens with the caret the active table asks for and takes the focus.
 * Returns what closes it.
 */
export function openCellEditor(main: EditorView, parent: HTMLElement): () => void {
  const active = activeTable(main.state);
  const cell = active?.owner.kind === "cell" ? active.owner.cell : { row: 0, col: 0 };
  let applying = false;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: activeCellText(main.state),
      extensions: [
        keymap.of(cellKeymap(main)),
        cellHistoryHandlers(main),
        highlightSpecialChars(),
        EditorView.lineWrapping,
        cellEditorTheme,
        EditorView.contentAttributes.of({ "aria-label": `Row ${cell.row + 1}, column ${cell.col + 1}` }),
        EditorView.editorAttributes.of({ "data-table-cell-editor": "" }),
      ],
    }),
    dispatchTransactions(transactions, cellView) {
      for (const tr of transactions) {
        if (!tr.docChanged || tr.annotation(cellSync) === true) {
          cellView.update([tr]);
          continue;
        }
        applying = true;
        try {
          applyCellEdit(main, tr);
        } finally {
          applying = false;
        }
        const shown = activeCellText(main.state);
        if (shown === tr.newDoc.toString()) {
          cellView.update([tr]);
        } else {
          // The source shows otherwise than typed (a pipe escaped, a pasted
          // line break): the view takes the main document's.
          cellView.update([cellView.state.update({
            changes: { from: 0, to: cellView.state.doc.length, insert: shown },
            selection: EditorSelection.single(Math.min(shown.length, tr.newSelection.main.head)),
            annotations: cellSync.of(true),
          })]);
        }
      }
    },
  });
  const resync = () => {
    if (applying) return;
    const shown = activeCellText(main.state);
    if (shown === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: shown },
      selection: EditorSelection.single(Math.min(shown.length, view.state.selection.main.head)),
      annotations: cellSync.of(true),
    });
  };
  const unregister = registerCellEditor(main, { view, resync });
  const unsubscribe = subscribeTable(main, (update) => {
    if (update.docChanged) resync();
  });
  view.dispatch({ selection: caretSelection(view, active?.caret ?? { kind: "end" }), annotations: cellSync.of(true) });
  view.focus();
  return () => {
    unsubscribe();
    unregister();
    view.destroy();
  };
}

/** Undo and redo from a cell's editor go to the main history and leave the
 *  cell (Л4.10, C4). */
export function runMainHistory(main: EditorView, command: (view: EditorView) => boolean): boolean {
  const ran = command(main);
  main.focus();
  return ran;
}

// ─── The range (Л9.7) ───────────────────────────────────────────────────────

function setOwner(view: EditorView, owner: TableOwner, kind: TableEditKind = "select", caret: CellCaret = { kind: "end" }): boolean {
  const active = activeTable(view.state);
  if (!active) return false;
  const model = activeModel(view.state, active);
  if (!model) return false;
  const cell = owner.kind === "cell" ? owner.cell : null;
  view.dispatch({
    effects: setActiveTable.of({
      ...active,
      owner,
      edit: cell ? editRangeOf(model, active.from, cell) : null,
      caret,
      generation: active.generation + 1,
    }),
    annotations: tableEdit.of(kind),
  });
  return true;
}

/** Extend the range to `head`, from the active cell or the range's anchor
 *  (a drag over a cell's border, ⇧-click). */
export function extendRange(view: EditorView, head: TableCellRef): boolean {
  const active = activeTable(view.state);
  if (!active) return false;
  const model = activeModel(view.state, active);
  if (!model) return false;
  return setOwner(view, nextOwner(active.owner, { type: "extend-range", head: clampCell(head, rowCount(model), model.columns) }));
}

/** ⇧↑ ⇧↓ (and ⇧← ⇧→ in a range): move the range's head by rows (and
 *  columns), its anchor stays. */
export function extendRangeBy(view: EditorView, rows: number, columns: number): boolean {
  const active = activeTable(view.state);
  if (!active) return false;
  const head = active.owner.kind === "range" ? active.owner.head : active.owner.kind === "cell" ? active.owner.cell : null;
  if (!head) return false;
  return extendRange(view, { row: head.row + rows, col: head.col + columns });
}

/** The range's rectangle, if the table has one. */
export function activeRange(state: EditorState): CellRect | null {
  const active = activeTable(state);
  return active?.owner.kind === "range" ? rangeRect(active.owner.anchor, active.owner.head) : null;
}

/** Escape in a range: it ends on its anchor cell's editor. */
export function cancelRange(view: EditorView): boolean {
  const active = activeTable(view.state);
  if (!active || active.owner.kind !== "range") return false;
  return setOwner(view, nextOwner(active.owner, { type: "cancel" }));
}

/** What each cell of the range shows, row by row (Л9.7). */
export function rangeCells(state: EditorState): string[][] {
  const active = activeTable(state);
  const rect = activeRange(state);
  const model = active ? activeModel(state, active) : null;
  if (!rect || !model) return [];
  const cells: string[][] = [];
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    const line: string[] = [];
    for (let col = rect.left; col <= rect.right; col += 1) line.push(decodeCell(cellSource(model, { row, col })).text);
    cells.push(line);
  }
  return cells;
}

function writeRange(view: EditorView, writes: readonly CellWrite[], owner: TableOwner, caret: CellCaret, userEvent: string): boolean {
  const active = activeTable(view.state);
  const model = active ? activeModel(view.state, active) : null;
  if (!active || !model) return false;
  return dispatchTableChanges(view, active, writeCells(model, writes), owner, caret, "range", userEvent);
}

/** Cut, Backspace, Delete in a range: its cells' content goes, the table's
 *  structure stays (Л9.7). */
export function clearRange(view: EditorView): boolean {
  const active = activeTable(view.state);
  const rect = activeRange(view.state);
  const model = active ? activeModel(view.state, active) : null;
  if (!active || !rect || !model) return false;
  return writeRange(view, clearWrites(rect, rowCount(model), model.columns), active.owner, { kind: "end" }, "delete");
}

/** A paste into a range (Л9.7): the clipboard's cells from the range's top
 *  left cell, cut at the table's edges; one cell fills the range. */
export function pasteIntoRange(view: EditorView, clipboard: readonly (readonly string[])[]): boolean {
  const active = activeTable(view.state);
  const rect = activeRange(view.state);
  const model = active ? activeModel(view.state, active) : null;
  if (!active || !rect || !model || clipboard.length === 0) return false;
  return writeRange(view, pasteWrites(rect, clipboard, rowCount(model), model.columns), active.owner, { kind: "end" }, "input.paste");
}

/** Typing over a range (Л9.7): it is cleared, the text goes into its
 *  anchor cell, whose editor takes the caret after it. */
export function typeOverRange(view: EditorView, text: string): boolean {
  const active = activeTable(view.state);
  const rect = activeRange(view.state);
  const model = active ? activeModel(view.state, active) : null;
  if (!active || active.owner.kind !== "range" || !rect || !model) return false;
  const anchor = active.owner.anchor;
  return writeRange(view, typeOverWrites(rect, anchor, text, rowCount(model), model.columns), { kind: "cell", cell: anchor }, { kind: "end" }, "input.type");
}

// ─── Structure (Л9.8, Л9.11) ────────────────────────────────────────────────

/** The changes of a table command in the document's terms: offsets from
 *  the table's start, a new line as the document's line break. */
function documentChanges(state: EditorState, active: ActiveTable, changes: readonly TableTextChange[]): ChangeSpec[] {
  const lineBreak = state.lineBreak;
  return changes.map((change) => ({
    from: active.from + change.from,
    to: active.from + change.to,
    insert: lineBreak === "\n" ? change.insert : change.insert.replace(/\n/g, lineBreak),
  }));
}

function dispatchTableChanges(
  view: EditorView,
  active: ActiveTable,
  changes: readonly TableTextChange[],
  owner: TableOwner,
  caret: CellCaret,
  kind: TableEditKind,
  userEvent: string,
): boolean {
  const state = view.state;
  const delta = changes.reduce((sum, change) => sum + change.insert.length - (change.to - change.from), 0);
  const spec = documentChanges(state, active, changes);
  const to = active.to + delta;
  const model = tableModel(applyTableChanges(tableTextAt(state, active.from, active.to), changes));
  if (!model) return false;
  const cell = owner.kind === "cell" ? clampCell(owner.cell, rowCount(model), model.columns) : null;
  const range = owner.kind === "range"
    ? { kind: "range" as const, anchor: clampCell(owner.anchor, rowCount(model), model.columns), head: clampCell(owner.head, rowCount(model), model.columns) }
    : null;
  view.dispatch({
    changes: spec,
    effects: setActiveTable.of({
      ...active,
      to,
      owner: cell ? { kind: "cell", cell } : range ?? owner,
      edit: cell ? editRangeOf(model, active.from, cell) : null,
      caret,
      generation: active.generation + 1,
      layout: kind === "structure" ? active.generation + 1 : active.layout,
    }),
    annotations: [tableEdit.of(kind), keepLineBreaks, Transaction.userEvent.of(userEvent)],
  });
  return true;
}

function runStructure(view: EditorView, changes: readonly TableTextChange[], focus: TableCellRef, caret: CellCaret): boolean {
  const active = activeTable(view.state);
  if (!active || changes.length === 0) return false;
  return dispatchTableChanges(view, active, changes, { kind: "cell", cell: focus }, caret, "structure", "input.table");
}

/** The commands of a table's structure, as the menus name them. */
export type TableCommandId =
  | "insert-row-above"
  | "insert-row-below"
  | "duplicate-row"
  | "clear-row"
  | "delete-row"
  | "insert-column-left"
  | "insert-column-right"
  | "duplicate-column"
  | "clear-column"
  | "align-left"
  | "align-center"
  | "align-right"
  | "delete-column"
  | "move-row-up"
  | "move-row-down"
  | "move-column-left"
  | "move-column-right"
  | "edit-as-markdown";

/** A command the menu shows. */
export interface TableCommand {
  id: TableCommandId;
  label: string;
  destructive: boolean;
  /** Starts a group: the menu draws a line before it. */
  separatorBefore: boolean;
}

/** The cell the commands act on: the active cell, a range's anchor. */
function commandCell(active: ActiveTable): TableCellRef | null {
  if (active.owner.kind === "cell") return active.owner.cell;
  if (active.owner.kind === "range") return active.owner.anchor;
  return null;
}

const COMMAND_LABELS: Record<TableCommandId, string> = {
  "insert-row-above": "Insert Row Above",
  "insert-row-below": "Insert Row Below",
  "duplicate-row": "Duplicate Row",
  "clear-row": "Clear Row",
  "delete-row": "Delete Row",
  "insert-column-left": "Insert Column Left",
  "insert-column-right": "Insert Column Right",
  "duplicate-column": "Duplicate Column",
  "clear-column": "Clear Column",
  "align-left": "Align Left",
  "align-center": "Align Center",
  "align-right": "Align Right",
  "delete-column": "Delete Column",
  "move-row-up": "Move Row Up",
  "move-row-down": "Move Row Down",
  "move-column-left": "Move Column Left",
  "move-column-right": "Move Column Right",
  "edit-as-markdown": "Edit as Markdown",
};

/**
 * The commands of the active table's row and column for the `Table` menu of
 * the open card (Л9.8): a command that cannot run is not there (the header
 * row has no `Insert Row Above` and no `Delete Row`, the only column no
 * `Delete Column`). The moves of rows and columns are the handles' drag
 * (ЛВ7 (е)) and are not in the menu.
 */
export function tableMenuCommands(state: EditorState): TableCommand[] {
  const active = activeTable(state);
  const model = active ? activeModel(state, active) : null;
  const cell = active ? commandCell(active) : null;
  if (!active || !model || !cell) return [];
  const ids: Array<[TableCommandId, boolean]> = [
    ["insert-row-above", cell.row > 0],
    ["insert-row-below", true],
    ["duplicate-row", true],
    ["clear-row", true],
    ["delete-row", cell.row > 0],
    ["insert-column-left", true],
    ["insert-column-right", true],
    ["duplicate-column", true],
    ["clear-column", true],
    ["align-left", true],
    ["align-center", true],
    ["align-right", true],
    ["delete-column", model.columns > 1],
    ["edit-as-markdown", true],
  ];
  const groups = new Set<TableCommandId>(["insert-column-left", "delete-row", "delete-column", "edit-as-markdown"]);
  const destructive = new Set<TableCommandId>(["delete-row", "delete-column"]);
  return ids.filter(([, available]) => available).map(([id]) => ({
    id,
    label: COMMAND_LABELS[id],
    destructive: destructive.has(id),
    separatorBefore: groups.has(id),
  }));
}

/** Run a command of the active table's structure (Л9.11). The cell's
 *  editor goes where the command leaves the content it acted on: a new row
 *  or column, the row or column moved, the cell beside a deleted one. */
export function runTableCommand(view: EditorView, id: TableCommandId): boolean {
  const active = activeTable(view.state);
  const model = active ? activeModel(view.state, active) : null;
  const cell = active ? commandCell(active) : null;
  if (!active || !model || !cell) return false;
  const rows = rowCount(model);
  const { row, col } = cell;
  switch (id) {
    case "insert-row-above":
      return runStructure(view, insertRow(model, row, false), { row, col }, { kind: "start" });
    case "insert-row-below":
      return runStructure(view, insertRow(model, row, true), { row: row + 1, col }, { kind: "start" });
    case "duplicate-row":
      return runStructure(view, duplicateRow(model, row), { row, col }, { kind: "end" });
    case "clear-row":
      return runStructure(view, clearRow(model, row), { row, col }, { kind: "start" });
    case "delete-row":
      return runStructure(view, deleteRow(model, row), { row: Math.min(row, rows - 2), col }, { kind: "end" });
    case "insert-column-left":
      return runStructure(view, insertColumn(model, col), { row, col }, { kind: "start" });
    case "insert-column-right":
      return runStructure(view, insertColumn(model, col + 1), { row, col: col + 1 }, { kind: "start" });
    case "duplicate-column":
      return runStructure(view, duplicateColumn(model, col), { row, col }, { kind: "end" });
    case "clear-column":
      return runStructure(view, clearColumn(model, col), { row, col }, { kind: "start" });
    case "align-left":
      return runStructure(view, alignColumn(model, col, "left"), { row, col }, { kind: "end" });
    case "align-center":
      return runStructure(view, alignColumn(model, col, "center"), { row, col }, { kind: "end" });
    case "align-right":
      return runStructure(view, alignColumn(model, col, "right"), { row, col }, { kind: "end" });
    case "delete-column":
      return runStructure(view, deleteColumn(model, col), { row, col: Math.min(col, model.columns - 2) }, { kind: "end" });
    case "move-row-up":
      return row > 1 ? runStructure(view, moveRow(model, row, row - 1), { row: row - 1, col }, { kind: "end" }) : false;
    case "move-row-down":
      return row > 0 && row + 1 < rows ? runStructure(view, moveRow(model, row, row + 1), { row: row + 1, col }, { kind: "end" }) : false;
    case "move-column-left":
      return col > 0 ? runStructure(view, moveColumn(model, col, col - 1), { row, col: col - 1 }, { kind: "end" }) : false;
    case "move-column-right":
      return col + 1 < model.columns ? runStructure(view, moveColumn(model, col, col + 1), { row, col: col + 1 }, { kind: "end" }) : false;
    case "edit-as-markdown":
      return showTableSource(view, active.from);
  }
}

// ─── Edges of a table in the main text ──────────────────────────────────────

/** Input that lands right at a table's edge goes on its own line, and a
 *  deletion that would join a line to the table chooses the table instead:
 *  the table stays whole, the main caret never edits its rows (Л9.2). */
const tableEdgeFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(tableEdit) !== undefined) return tr;
  const typing = tr.isUserEvent("input.type") || tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop");
  const deleting = tr.isUserEvent("delete.backward") || tr.isUserEvent("delete.forward");
  if (!typing && !deleting) return tr;
  const changes: Array<{ fromA: number; toA: number; text: string }> = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ fromA, toA, text: inserted.toString() }));
  if (changes.length !== 1) return tr;
  const [change] = changes;
  if (!change) return tr;
  const state = tr.startState;
  const lineBreak = state.lineBreak;
  if (typing && change.fromA === change.toA) {
    const table = topLevelTableAt(state, change.fromA);
    if (!table) return tr;
    if (change.fromA === table.from) {
      return { changes: { from: change.fromA, insert: change.text + lineBreak }, selection: EditorSelection.cursor(change.fromA + change.text.length), userEvent: "input.type" };
    }
    if (change.fromA === table.to) {
      const insert = lineBreak + change.text;
      return { changes: { from: change.fromA, insert }, selection: EditorSelection.cursor(change.fromA + insert.length), userEvent: "input.type" };
    }
    return tr;
  }
  if (deleting && change.toA - change.fromA === 1 && change.text === "") {
    // The line break right after a table, or right before it.
    const after = topLevelTableAt(state, change.fromA);
    const before = topLevelTableAt(state, change.toA);
    const table = after && after.to === change.fromA ? after : before && before.from === change.toA ? before : null;
    if (table) return { selection: EditorSelection.range(table.from, table.to), userEvent: "select" };
  }
  return tr;
});

/** The table editor of the main editor: its state, its listeners, its
 *  edges. */
export function tableEditor(): Extension {
  return [tableEditorField, tableListenerPlugin, tableEdgeFilter];
}

/** The ⌘Z and ⇧⌘Z of a cell's editor, as the page's editing events: they
 *  go to the main history and leave the cell (Л4.10, C4). */
export function cellHistoryHandlers(main: EditorView): Extension {
  return EditorView.domEventHandlers({
    beforeinput(event) {
      if (event.inputType === "historyUndo") {
        event.preventDefault();
        return runMainHistory(main, undo);
      }
      if (event.inputType === "historyRedo") {
        event.preventDefault();
        return runMainHistory(main, redo);
      }
      return false;
    },
  });
}
