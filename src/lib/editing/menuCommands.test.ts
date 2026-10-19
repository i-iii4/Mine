import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { editorHistory, runEditMenuCommand } from "./menuCommands";

// SPEC_EDITING.md, Л12 (row 50.24): the Edit menu's Undo, Redo and Select
// All in the note editor, and what enables Undo and Redo.

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

const views: EditorView[] = [];

function view(doc: string, extensions = [history()]): EditorView {
  const made = new EditorView({ parent: document.body, state: EditorState.create({ doc, extensions }) });
  views.push(made);
  return made;
}

function type(target: EditorView, at: number, text: string) {
  target.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" });
}

afterEach(() => {
  for (const made of views.splice(0)) made.destroy();
});

describe("the Edit menu in the note editor (Л12)", () => {
  it("enables Undo and Redo by the editor's history", () => {
    const main = view("Body");
    expect(editorHistory(main.state)).toEqual({ can_undo: false, can_redo: false });
    type(main, 4, "!");
    expect(editorHistory(main.state)).toEqual({ can_undo: true, can_redo: false });
    runEditMenuCommand(main, main, "undo");
    expect(editorHistory(main.state)).toEqual({ can_undo: false, can_redo: true });
  });

  it("undoes and redoes the editor's own edits", () => {
    const main = view("Body");
    type(main, 4, "!");
    type(main, 0, ">");
    // Two separate steps of the history: the second edit was not typed next
    // to the first.
    expect(runEditMenuCommand(main, main, "undo")).toBe(true);
    expect(main.state.doc.toString()).toBe("Body!");
    expect(runEditMenuCommand(main, main, "undo")).toBe(true);
    expect(main.state.doc.toString()).toBe("Body");
    expect(runEditMenuCommand(main, main, "undo")).toBe(false);
    expect(runEditMenuCommand(main, main, "redo")).toBe(true);
    expect(main.state.doc.toString()).toBe("Body!");
  });

  it("selects the whole note in the main editor", () => {
    const main = view("First line\nSecond line");
    main.dispatch({ selection: { anchor: 3 } });
    runEditMenuCommand(main, main, "select_all");
    expect(main.state.selection.main.from).toBe(0);
    expect(main.state.selection.main.to).toBe(main.state.doc.length);
  });

  it("selects only the cell's text from a cell's editor, and undoes in the main history from there (Л9.6, Л4.10)", () => {
    const main = view("| a |\n| - |\n| text |");
    type(main, 0, "x");
    // A cell's editor has no history of its own (Л9.5).
    const cell = view("text", []);
    runEditMenuCommand(main, cell, "select_all");
    expect(cell.state.selection.main.from).toBe(0);
    expect(cell.state.selection.main.to).toBe(4);
    expect(main.state.selection.main.empty).toBe(true);
    runEditMenuCommand(main, cell, "undo");
    expect(main.state.doc.toString()).toBe("| a |\n| - |\n| text |");
    expect(main.hasFocus || document.activeElement === main.contentDOM).toBe(true);
  });
});
