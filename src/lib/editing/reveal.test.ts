import { LanguageSupport } from "@codemirror/language";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { externalChange } from "./reloadDiff";
import {
  concealBlockEffect,
  isBlockSelected,
  isRevealed,
  revealBlockEffect,
  revealField,
  revealWaitEffect,
} from "./reveal";
import { mineMarkdownLanguage } from "./syntax";
import { blocksOf } from "./blocks";

const BODY = "Intro **bold** text\n\n```js\nlet x;\n```\n\nAfter";

function start(caret = 0): EditorState {
  return EditorState.create({
    doc: BODY,
    selection: EditorSelection.cursor(caret),
    extensions: [new LanguageSupport(mineMarkdownLanguage), revealField],
  });
}

function step(state: EditorState, spec: TransactionSpec): EditorState {
  return state.update(spec).state;
}

const BOLD_FROM = BODY.indexOf("**");
const BOLD_TO = BODY.indexOf("text") - 1;
const CODE_FROM = BODY.indexOf("```");

describe("revealField (SPEC_EDITING.md, Л5.2, Л5.3, Л5.5)", () => {
  it("reveals nothing for the caret the editor opens with, until the person acts", () => {
    let state = start(BOLD_FROM + 3);
    expect(isRevealed(state.field(revealField), BOLD_FROM, BOLD_TO)).toBe(false);
    state = step(state, { selection: EditorSelection.cursor(BOLD_FROM + 4), userEvent: "select" });
    expect(isRevealed(state.field(revealField), BOLD_FROM, BOLD_TO)).toBe(true);
  });

  it("reveals by touch or, for a task's box, only strictly inside", () => {
    const state = step(start(), { selection: EditorSelection.cursor(BOLD_FROM), userEvent: "select" });
    const reveal = state.field(revealField);
    expect(isRevealed(reveal, BOLD_FROM, BOLD_TO)).toBe(true);
    expect(isRevealed(reveal, BOLD_FROM, BOLD_TO, "inside")).toBe(false);
    expect(isRevealed(reveal, BOLD_TO + 1, BOLD_TO + 5)).toBe(false);
  });

  it("reveals what a selection crosses", () => {
    const state = step(start(), { selection: EditorSelection.range(0, BOLD_FROM + 2), userEvent: "select.pointer" });
    expect(isRevealed(state.field(revealField), BOLD_FROM, BOLD_TO)).toBe(true);
  });

  it("keeps a block's source while the caret is in it and draws it again when the caret leaves (Л5.3)", () => {
    let state = step(start(), { effects: revealBlockEffect.of(CODE_FROM), selection: EditorSelection.cursor(CODE_FROM) });
    expect(state.field(revealField).blocks).toEqual([CODE_FROM]);
    state = step(state, { selection: EditorSelection.cursor(CODE_FROM + 8), userEvent: "select" });
    expect(state.field(revealField).blocks).toEqual([CODE_FROM]);
    state = step(state, { selection: EditorSelection.cursor(state.doc.length), userEvent: "select" });
    expect(state.field(revealField).blocks).toEqual([]);
  });

  it("draws a block again on request and moves its start with the edits before it", () => {
    let state = step(start(), { effects: revealBlockEffect.of(CODE_FROM), selection: EditorSelection.cursor(CODE_FROM) });
    state = step(state, { changes: { from: 0, insert: "New " }, userEvent: "input.type" });
    expect(state.field(revealField).blocks).toEqual([CODE_FROM + 4]);
    state = step(state, { effects: concealBlockEffect.of(CODE_FROM + 4) });
    expect(state.field(revealField).blocks).toEqual([]);
  });

  it("carries the revealed selection through changes while the pointer is down, then takes the new one (Л5.5)", () => {
    let state = step(start(), { selection: EditorSelection.cursor(1), userEvent: "select" });
    state = step(state, { effects: revealWaitEffect.of({ reason: "pointer", waiting: true }) });
    state = step(state, { selection: EditorSelection.cursor(BOLD_FROM + 3), userEvent: "select.pointer" });
    expect(isRevealed(state.field(revealField), BOLD_FROM, BOLD_TO)).toBe(false);
    state = step(state, { effects: revealWaitEffect.of({ reason: "pointer", waiting: false }) });
    expect(isRevealed(state.field(revealField), BOLD_FROM, BOLD_TO)).toBe(true);
  });

  it("does not change what is revealed in a step of a composition or an external change", () => {
    let state = step(start(), { selection: EditorSelection.cursor(1), userEvent: "select" });
    const composed = step(state, {
      changes: { from: BOLD_FROM + 3, insert: "か" },
      selection: EditorSelection.cursor(BOLD_FROM + 4),
      userEvent: "input.type.compose",
    });
    expect(composed.field(revealField).selection.main.head).toBe(1);
    state = step(state, {
      changes: { from: 0, insert: "X" },
      selection: EditorSelection.cursor(BOLD_FROM + 4),
      annotations: externalChange.of(true),
    });
    expect(state.field(revealField).selection.main.head).toBe(2);
  });

  it("knows a block is chosen when the selection holds exactly it", () => {
    const state = start();
    const [block] = blocksOf(state);
    if (!block) throw new Error("a code block");
    expect(isBlockSelected(step(state, { selection: EditorSelection.range(block.from, block.to) }), block)).toBe(true);
    expect(isBlockSelected(step(state, { selection: EditorSelection.cursor(block.from) }), block)).toBe(false);
  });
});
