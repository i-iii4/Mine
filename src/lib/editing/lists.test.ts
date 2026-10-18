import { history, undo } from "@codemirror/commands";
import { LanguageSupport } from "@codemirror/language";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { bodyOfState, editorBody, lineEndingExtensions } from "./lineEndings";
import {
  continueListMarkup,
  deleteListMarkup,
  indentListItem,
  noteIndentUnit,
  outdentListItem,
  taskMarkerAt,
  toggleTaskSpec,
} from "./lists";
import { mineMarkdownLanguage } from "./syntax";

/** A state of `text`, the caret where `|` stands. */
function state(text: string): EditorState {
  const caret = text.indexOf("|");
  const body = caret < 0 ? text : text.slice(0, caret) + text.slice(caret + 1);
  const loaded = editorBody(body);
  return EditorState.create({
    doc: loaded.text,
    selection: EditorSelection.cursor(caret < 0 ? 0 : caret),
    extensions: [lineEndingExtensions(loaded.mode), new LanguageSupport(mineMarkdownLanguage), history()],
  });
}

/** `command` on `start`: the new text with `|` at the caret, or `null` when
 *  the command did not run. */
function run(start: EditorState, command: StateCommand): string | null {
  let next: EditorState | null = null;
  const handled = command({ state: start, dispatch: (tr) => { next = tr.state; } });
  if (!handled) return null;
  const result: EditorState = next ?? start;
  const text = bodyOfState(result, false);
  // A position counts a line break as one sign; the text keeps its own.
  const head = result.sliceDoc(0, result.selection.main.head).length;
  return text.slice(0, head) + "|" + text.slice(head);
}

describe("Enter in a list (SPEC_EDITING.md, Л7.1)", () => {
  it("goes on with a bullet list and a task", () => {
    expect(run(state("- one|"), continueListMarkup)).toBe("- one\n- |");
    expect(run(state("- [x] done|"), continueListMarkup)).toBe("- [x] done\n- [ ] |");
    expect(run(state("  * nested|"), continueListMarkup)).toBe("  * nested\n  * |");
  });

  it("gives a numbered item the next number and leaves the numbers after it as they are", () => {
    expect(run(state("1. one|\n2. two\n3. three"), continueListMarkup)).toBe("1. one\n2. |\n2. two\n3. three");
  });

  it("leaves the list from an empty item and takes its marker away", () => {
    expect(run(state("- one\n- |"), continueListMarkup)).toBe("- one\n|");
    expect(run(state("1. one\n2. |"), continueListMarkup)).toBe("1. one\n|");
    expect(run(state("- one\n- [ ] |"), continueListMarkup)).toBe("- one\n|");
  });

  it("goes on with a quote and a callout", () => {
    expect(run(state("> quoted|"), continueListMarkup)).toBe("> quoted\n> |");
    expect(run(state("> [!note] Title\n> body|"), continueListMarkup)).toBe("> [!note] Title\n> body\n> |");
  });

  it("counts a caret right after a drawn marker as the start of the item's text", () => {
    expect(run(state("- [ ]| task"), continueListMarkup)).toBe("- [ ] \n- [ ] |task");
    expect(run(state("|- item"), continueListMarkup)).toBe("- \n- |item");
  });

  it("keeps \\r\\n line breaks", () => {
    expect(run(state("- one|\r\n- two\r\n"), continueListMarkup)).toBe("- one\r\n- |\r\n- two\r\n");
  });

  it("does nothing outside a list", () => {
    expect(run(state("plain|"), continueListMarkup)).toBeNull();
  });

  it("takes a level of markup away with Backspace after it", () => {
    expect(run(state("- one\n- |"), deleteListMarkup)).toBe("- one\n  |");
    expect(run(state("> |"), deleteListMarkup)).toBe("|");
  });
});

describe("Tab and ⇧Tab in a list (Л7.2)", () => {
  it("moves an item with its nested items by the note's unit", () => {
    expect(run(state("- a\n- b|\n  - c\n- d"), indentListItem)).toBe("- a\n  - b|\n    - c\n- d");
    expect(run(state("- a\n- b|"), indentListItem)).toBe("- a\n\t- b|");
  });

  it("takes the unit of the note's first nested item", () => {
    expect(noteIndentUnit(state("- a\n    - b"))).toBe("    ");
    expect(noteIndentUnit(state("- a\n\t- b"))).toBe("\t");
    expect(noteIndentUnit(state("- a\n- b"))).toBe("\t");
    expect(run(state("- a\n  - b\n- c|"), indentListItem)).toBe("- a\n  - b\n  - c|");
  });

  it("moves an item out by the unit, as far as it is indented", () => {
    expect(run(state("- a\n  - b|\n    - c"), outdentListItem)).toBe("- a\n- b|\n  - c");
    expect(run(state("- a|"), outdentListItem)).toBe("- a|");
  });

  it("indents an item inside a quote after its markers", () => {
    expect(run(state("> - a\n> - b|"), indentListItem)).toBe("> - a\n> \t- b|");
  });

  it("types a tab outside a list", () => {
    expect(run(state("text|"), indentListItem)).toBe("text\t|");
  });
});

describe("a task's box (Л7.4)", () => {
  it("finds the state sign of a task by where its item starts", () => {
    const doc = state("- [ ] a\n1. [x] b\n* [X] c\n- not a task").doc;
    expect(taskMarkerAt(doc, 0)).toEqual({ at: 3, checked: false });
    expect(taskMarkerAt(doc, doc.line(2).from)).toEqual({ at: doc.line(2).from + 4, checked: true });
    expect(taskMarkerAt(doc, doc.line(3).from)).toEqual({ at: doc.line(3).from + 3, checked: true });
    expect(taskMarkerAt(doc, doc.line(4).from)).toBeNull();
  });

  it("changes one sign, which ⌘Z takes back", () => {
    const start = state("> - [ ] quoted task\r\n- [x] done\r\n");
    const item = start.doc.line(1).from + 2;
    const spec = toggleTaskSpec(start, item);
    if (!spec) throw new Error("a task");
    const toggled = start.update(spec).state;
    expect(bodyOfState(toggled, false)).toBe("> - [x] quoted task\r\n- [x] done\r\n");
    const second = toggleTaskSpec(toggled, toggled.doc.line(2).from);
    if (!second) throw new Error("a task");
    const both = toggled.update(second).state;
    expect(bodyOfState(both, false)).toBe("> - [x] quoted task\r\n- [ ] done\r\n");
    let undone = both;
    undo({ state: both, dispatch: (tr) => { undone = tr.state; } });
    expect(bodyOfState(undone, false)).toBe("> - [x] quoted task\r\n- [x] done\r\n");
  });
});
