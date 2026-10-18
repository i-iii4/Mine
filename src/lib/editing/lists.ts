// Lists and tasks in the editor (SPEC_EDITING.md, Л7): Enter goes on with a
// list, a quote and a callout and leaves an empty item; Tab and ⇧Tab move an
// item with everything nested in it by the note's own unit of indentation; a
// task's box changes one sign of the document, as an edit in the history.

import { syntaxTree } from "@codemirror/language";
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import {
  EditorSelection,
  Transaction,
  type ChangeSpec,
  type EditorState,
  type StateCommand,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/** The unit of indentation of a note whose nested items show none. */
export const DEFAULT_INDENT_UNIT = "\t";

/** A task's marker: the list marker, up to four columns of space, then
 *  `[`, the state, `]`, as GFM reads it (`toggle_task_marker` in the core). */
const TASK_MARKER = /^([-*+]|\d{1,9}[.)])([ \t]{1,4})\[([ \txX])\](?=[ \t]|$)/;

/** The state sign of the task whose item starts at `item`: its position and
 *  whether it is done; `null` where no task starts. */
export function taskMarkerAt(doc: Text, item: number): { at: number; checked: boolean } | null {
  const line = doc.lineAt(item);
  const match = TASK_MARKER.exec(line.text.slice(item - line.from));
  if (!match) return null;
  const sign = match[3] ?? " ";
  return { at: item + (match[1]?.length ?? 0) + (match[2]?.length ?? 0) + 1, checked: sign === "x" || sign === "X" };
}

/**
 * The change of the task whose item starts at `item` (Л7.4): `' '` to `x`,
 * `x` and `X` to `' '`, one sign, as its own step in the history. `null`
 * where no task starts there.
 */
export function toggleTaskSpec(state: EditorState, item: number): TransactionSpec | null {
  const marker = taskMarkerAt(state.doc, item);
  if (!marker) return null;
  return {
    changes: { from: marker.at, to: marker.at + 1, insert: marker.checked ? " " : "x" },
    userEvent: "input.task",
    annotations: Transaction.addToHistory.of(true),
  };
}

/** Where the text of the list item on `line` starts, after its marker and a
 *  task's box: what the caret right after a drawn marker means (Л7.1). */
function itemTextStart(state: EditorState, pos: number): number | null {
  const line = state.doc.lineAt(pos);
  const match = /^((?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ \txX]\][ \t]+)?)/.exec(line.text);
  return match ? line.from + (match[1]?.length ?? 0) : null;
}

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** The markup of an empty item like the one `prefix` opens: the same quote
 *  markers, indentation and marker, an open box for a task. */
function emptyItemPrefix(prefix: string): string {
  return prefix.replace(/\[[ \txX]\]/, "[ ]");
}

/**
 * Enter in a list, a quote or a callout (Л7.1): a new item with the same
 * marker and indentation, `- [ ] ` after a task, the next number after a
 * numbered item; an empty item leaves the list and takes its marker away.
 * The numbers of the items after it are not rewritten, unlike the command of
 * @codemirror/lang-markdown, whose renumbering is dropped here. A caret right
 * after a drawn marker counts as the start of the item's text.
 */
export const continueListMarkup: StateCommand = ({ state, dispatch }) => {
  const main = state.selection.main;
  if (main.empty) {
    const line = state.doc.lineAt(main.head);
    const textStart = itemTextStart(state, main.head);
    if (textStart !== null && main.head <= textStart && textStart < line.to && state.selection.ranges.length === 1) {
      // At the start of an item's text: a new empty item above it, so the
      // text keeps its line, marker and state.
      const prefix = emptyItemPrefix(line.text.slice(0, textStart - line.from));
      dispatch(state.update({
        changes: { from: line.from, insert: state.toText(`${prefix}${state.lineBreak}`) },
        selection: EditorSelection.cursor(textStart + prefix.length + 1),
        scrollIntoView: true,
        userEvent: "input",
      }));
      return true;
    }
  }
  const start = state;
  let captured: Transaction | null = null;
  const handled = continueMarkup({ state: start, dispatch: (tr) => { captured = tr; } });
  if (!handled || !captured) return false;
  const tr: Transaction = captured;
  // Keep the changes on the caret's own lines; the ones after them renumber
  // later items.
  const limit = start.doc.lineAt(start.selection.main.head).to;
  const kept: ChangeSpec[] = [];
  let dropped = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA > limit) {
      dropped = true;
      return;
    }
    kept.push({ from: fromA, to: toA, insert: inserted });
  });
  if (!dropped) {
    dispatch(state.update({ changes: tr.changes, selection: tr.selection, scrollIntoView: true, userEvent: "input" }));
    return true;
  }
  const changes = state.changes(kept);
  dispatch(state.update({
    changes,
    selection: tr.selection ? EditorSelection.create(tr.selection.ranges.map((range) => EditorSelection.range(range.anchor, range.head))) : undefined,
    scrollIntoView: true,
    userEvent: "input",
  }));
  return true;
};

/** Backspace right after the markup of a list or a quote: one level of it
 *  goes (@codemirror/lang-markdown). */
export const deleteListMarkup: StateCommand = deleteMarkupBackward;

/** The list item `pos` stands in on its first line or further lines. */
function listItemAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === "ListItem") return node;
  }
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === "ListItem") return node;
  }
  return null;
}

/** The quote markers at the start of `text`. */
function quotePrefix(text: string): number {
  return /^(?:[ \t]{0,3}>[ \t]?)*/.exec(text)?.[0].length ?? 0;
}

/**
 * The note's unit of indentation (Л7.2): a tab when its first nested item is
 * indented by tabs, otherwise as many spaces as that item is indented more
 * than its parent; a tab when no item is nested.
 */
export function noteIndentUnit(state: EditorState): string {
  let unit: string | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (unit !== null) return false;
      if (node.name !== "ListItem") return undefined;
      const parentItem = node.node.parent?.parent;
      if (parentItem?.name !== "ListItem") return undefined;
      // A nested item's node starts at its parent's content column: its
      // marker says where it is written.
      const ownMark = node.node.getChild("ListMark");
      const parentMark = parentItem.getChild("ListMark");
      if (!ownMark || !parentMark) return false;
      const line = state.doc.lineAt(ownMark.from);
      const parentLine = state.doc.lineAt(parentMark.from);
      const own = line.text.slice(quotePrefix(line.text), ownMark.from - line.from);
      const parent = parentLine.text.slice(quotePrefix(parentLine.text), parentMark.from - parentLine.from);
      if (own.includes("\t")) unit = "\t";
      else if (own.length > parent.length) unit = " ".repeat(own.length - parent.length);
      return false;
    },
  });
  return unit ?? DEFAULT_INDENT_UNIT;
}

/** The lines of the items the selection touches, each item with everything
 *  nested in it, every line once. */
function itemLines(state: EditorState): number[] | null {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const firstLine = state.doc.lineAt(range.from).number;
    const lastLine = state.doc.lineAt(range.to).number;
    for (let number = firstLine; number <= lastLine; number += 1) {
      const line = state.doc.line(number);
      const item = listItemAt(state, Math.min(line.to, line.from + quotePrefix(line.text)));
      if (!item) continue;
      const from = state.doc.lineAt(item.from).number;
      const to = state.doc.lineAt(item.to).number;
      for (let inner = from; inner <= to; inner += 1) lines.add(inner);
    }
  }
  return lines.size > 0 ? [...lines].sort((a, b) => a - b) : null;
}

/** The width of `text` in columns, tabs to the next multiple of four. */
function columns(text: string): number {
  let column = 0;
  for (const char of text) column += char === "\t" ? 4 - (column % 4) : 1;
  return column;
}

/**
 * Tab in a list item (Л7.2): the item and everything nested in it go one
 * unit in. Outside a list, Tab types a tab sign.
 */
export const indentListItem: StateCommand = ({ state, dispatch }) => {
  const lines = itemLines(state);
  if (!lines) {
    dispatch(state.update(state.replaceSelection("\t"), { scrollIntoView: true, userEvent: "input" }));
    return true;
  }
  const unit = noteIndentUnit(state);
  const changes: ChangeSpec[] = [];
  for (const number of lines) {
    const line = state.doc.line(number);
    if (line.text.trim() === "") continue;
    changes.push({ from: line.from + quotePrefix(line.text), insert: unit });
  }
  dispatch(state.update({ changes, scrollIntoView: true, userEvent: "input.indent" }));
  return true;
};

/**
 * ⇧Tab in a list item (Л7.2): the item and everything nested in it go one
 * unit out, as far as they are indented. Outside a list it does nothing and
 * keeps the key, so the focus stays in the text.
 */
export const outdentListItem: StateCommand = ({ state, dispatch }) => {
  const lines = itemLines(state);
  if (!lines) return true;
  const width = columns(noteIndentUnit(state));
  const changes: ChangeSpec[] = [];
  for (const number of lines) {
    const line = state.doc.line(number);
    const start = quotePrefix(line.text);
    const indent = /^[ \t]*/.exec(line.text.slice(start))?.[0] ?? "";
    let take = 0;
    let column = 0;
    while (take < indent.length && column < width) {
      column += indent[take] === "\t" ? 4 - (column % 4) : 1;
      take += 1;
    }
    if (take > 0) changes.push({ from: line.from + start, to: line.from + start + take });
  }
  if (changes.length > 0) dispatch(state.update({ changes, scrollIntoView: true, userEvent: "delete.dedent" }));
  return true;
};
