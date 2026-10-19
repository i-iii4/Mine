// Undo, Redo and Select All of the Edit menu in the note editor
// (SPEC_EDITING.md, Л12). The history lives in the main editor: Undo and Redo
// run there from the main text and from a cell's editor alike, and leave the
// cell (Л4.10, C4). Select All selects the text of the part in focus: the
// whole note in the main editor, the cell's text in a cell (Л9.6, C5).

import { redo, redoDepth, selectAll, undo, undoDepth } from "@codemirror/commands";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { EditMenuCommand, FocusedEditor } from "@/types";
import { runMainHistory } from "./tableEditor";

/** What the main editor's history can do now: the menu's Undo and Redo are
 *  enabled by it. */
export function editorHistory(state: EditorState): FocusedEditor {
  return { can_undo: undoDepth(state) > 0, can_redo: redoDepth(state) > 0 };
}

/** Carry out `command` of the Edit menu in the note editor `main`, whose part
 *  `focused` holds the focus (`main` itself or a cell's editor). Whether
 *  anything changed. */
export function runEditMenuCommand(main: EditorView, focused: EditorView, command: EditMenuCommand): boolean {
  switch (command) {
    case "undo":
      return runMainHistory(main, undo);
    case "redo":
      return runMainHistory(main, redo);
    case "select_all":
      return selectAll(focused);
  }
}
