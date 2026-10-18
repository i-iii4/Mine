import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  BYTE_ORDER_MARK,
  bodyByteOffset,
  bodyOfState,
  documentLineSeparator,
  editorBody,
  keepLineBreaks,
  lineEndingExtensions,
  lineEndingMode,
  positionOfByteOffset,
} from "./lineEndings";

/** A state of `body` as the editor loads it, and its byte order mark. */
function load(body: string) {
  const loaded = editorBody(body);
  const state = EditorState.create({ doc: loaded.text, extensions: lineEndingExtensions(loaded.mode) });
  return { state, bom: loaded.bom };
}

function apply(state: EditorState, spec: TransactionSpec): EditorState {
  return state.update(spec).state;
}

/** Text pasted at the caret, through the editor's input filters, as
 *  CodeMirror's own paste handling runs them. */
function paste(state: EditorState, text: string): EditorState {
  const filtered = state.facet(EditorView.clipboardInputFilter).reduce((value, filter) => filter(value, state), text);
  const { from, to } = state.selection.main;
  return apply(state, {
    changes: { from, to, insert: state.toText(filtered) },
    selection: EditorSelection.cursor(from + state.toText(filtered).length),
    userEvent: "input.paste",
  });
}

/** Enter at the caret, as `insertNewline` types it: the state's line break. */
function enter(state: EditorState): EditorState {
  const { from, to } = state.selection.main;
  return apply(state, {
    changes: { from, to, insert: state.lineBreak },
    selection: EditorSelection.cursor(from + state.lineBreak.length),
    userEvent: "input",
  });
}

function caret(state: EditorState, pos: number): EditorState {
  return apply(state, { selection: EditorSelection.cursor(pos), userEvent: "select" });
}

const BODIES: Array<[string, string]> = [
  ["\\n only", "# Title\n\nFirst line\nsecond line\n"],
  ["\\r\\n only", "# Title\r\n\r\nFirst line\r\nsecond line\r\n"],
  ["mixed", "# Title\r\n\nFirst line\r\nsecond line\n"],
  ["a lone \\r", "First\rsecond\nthird\r\n"],
  ["no final line break", "First line\r\nsecond line"],
  ["a byte order mark", `${BYTE_ORDER_MARK}First line\r\nsecond\r\n`],
  ["tabs and trailing spaces", "\tindented  \n- item\t \n"],
  ["empty", ""],
];

describe("line endings (SPEC_EDITING.md, Л0.3, Л0.4)", () => {
  it("names how the lines end", () => {
    expect(lineEndingMode("a\nb\n")).toBe("lf");
    expect(lineEndingMode("a")).toBe("lf");
    expect(lineEndingMode("a\r\nb\r\n")).toBe("crlf");
    expect(lineEndingMode("a\r\nb\n")).toBe("mixed");
    expect(lineEndingMode("a\rb")).toBe("mixed");
    expect(lineEndingMode("a\r")).toBe("mixed");
    expect(documentLineSeparator("crlf")).toBe("\r\n");
    expect(documentLineSeparator("mixed")).toBe("\n");
  });

  it.each(BODIES)("loads a body with %s and gives it back sign for sign", (_name, body) => {
    const { state, bom } = load(body);
    expect(bodyOfState(state, bom)).toBe(body);
  });

  it("takes a byte order mark off the document and puts it back", () => {
    const { state, bom } = load(`${BYTE_ORDER_MARK}Text`);
    expect(bom).toBe(true);
    expect(state.doc.toString()).toBe("Text");
    expect(bodyOfState(state, bom)).toBe(`${BYTE_ORDER_MARK}Text`);
  });

  it.each(BODIES.filter(([, body]) => body.length > 4))(
    "an edit in the middle of a body with %s changes only its range, and its reverse gives the body back",
    (_name, body) => {
      const { state, bom } = load(body);
      const middle = Math.floor(state.doc.length / 2);
      const edited = apply(state, { changes: { from: middle, insert: "XYZ" } });
      const text = bodyOfState(edited, bom);
      // Positions count a line break as one sign; the body around the edit
      // keeps its own.
      const prefix = (bom ? BYTE_ORDER_MARK : "") + state.sliceDoc(0, middle);
      expect(text).toBe(prefix + "XYZ" + state.sliceDoc(middle));
      expect(text.startsWith(prefix) && body.startsWith(prefix)).toBe(true);
      expect(text.slice(prefix.length + 3)).toBe(body.slice(prefix.length));
      const reverted = apply(edited, { changes: { from: middle, to: middle + 3 } });
      expect(bodyOfState(reverted, bom)).toBe(body);
    },
  );

  it("brings pasted lines to \\r\\n in a \\r\\n body", () => {
    const { state, bom } = load("one\r\ntwo\r\n");
    const pasted = paste(caret(state, 3), "a\nb\r\nc\rd");
    expect(bodyOfState(pasted, bom)).toBe("onea\r\nb\r\nc\r\nd\r\ntwo\r\n");
  });

  it("brings pasted lines to \\n in a \\n body", () => {
    const { state, bom } = load("one\ntwo\n");
    expect(bodyOfState(paste(caret(state, 3), "a\r\nb\rc"), bom)).toBe("onea\nb\nc\ntwo\n");
  });

  it("gives a pasted line in a mixed body the ending of the line it lands in", () => {
    const { state, bom } = load("crlf line\r\nlf line\n");
    // The first line ends in \r\n: the caret before its \r.
    expect(bodyOfState(paste(caret(state, 4), "a\nb"), bom)).toBe("crlfa\r\nb line\r\nlf line\n");
    const second = state.doc.line(2).from + 2;
    expect(bodyOfState(paste(caret(state, second), "a\r\nb"), bom)).toBe("crlf line\r\nlfa\nb line\n");
  });

  it("gives a typed line in a mixed body the ending of the line it starts in", () => {
    const { state, bom } = load("crlf line\r\nlf line\n");
    expect(bodyOfState(enter(caret(state, 4)), bom)).toBe("crlf\r\n line\r\nlf line\n");
    // At the end of the \r\n line: the caret sits before its \r.
    const atEnd = caret(state, state.doc.line(1).to);
    expect(atEnd.selection.main.head).toBe(state.doc.line(1).to - 1);
    expect(bodyOfState(enter(atEnd), bom)).toBe("crlf line\r\n\r\nlf line\n");
    const second = state.doc.line(2).from + 2;
    expect(bodyOfState(enter(caret(state, second)), bom)).toBe("crlf line\r\nlf\n line\n");
  });

  it("deletes a \\r\\n whole in a mixed body, from either side", () => {
    const { state, bom } = load("one\r\ntwo\nthree");
    const lineTwo = state.doc.line(2).from;
    const backspace = apply(caret(state, lineTwo), { changes: { from: lineTwo - 1, to: lineTwo }, userEvent: "delete.backward" });
    expect(bodyOfState(backspace, bom)).toBe("onetwo\nthree");
    const forward = apply(caret(state, 3), { changes: { from: 3, to: 4 }, userEvent: "delete.forward" });
    expect(bodyOfState(forward, bom)).toBe("onetwo\nthree");
  });

  it("leaves a body applied from the file as it is", () => {
    const { state, bom } = load("one\r\ntwo\n");
    const replaced = apply(state, { changes: { from: 0, to: state.doc.length, insert: "a\nb\r\nc" }, annotations: keepLineBreaks });
    expect(bodyOfState(replaced, bom)).toBe("a\nb\r\nc");
  });

  it("counts body offsets in UTF-8 bytes, the byte order mark and line breaks included", () => {
    const body = `${BYTE_ORDER_MARK}Привет\r\nмир 😀 x\r\n`;
    const { state, bom } = load(body);
    const encoder = new TextEncoder();
    for (let pos = 0; pos <= state.doc.length; pos += 1) {
      const line = state.doc.lineAt(pos);
      // Positions inside a surrogate pair have no byte offset of their own.
      const code = state.doc.sliceString(pos - 1, pos).charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff) continue;
      const expected = encoder.encode(BYTE_ORDER_MARK + state.sliceDoc(0, line.from) + line.text.slice(0, pos - line.from)).length;
      expect(bodyByteOffset(state.doc, pos, state.lineBreak, bom)).toBe(expected);
    }
  });

  it("finds the position of a UTF-8 offset and refuses one inside a character", () => {
    expect(positionOfByteOffset("aб😀c", 0)).toBe(0);
    expect(positionOfByteOffset("aб😀c", 1)).toBe(1);
    expect(positionOfByteOffset("aб😀c", 2)).toBeNull();
    expect(positionOfByteOffset("aб😀c", 3)).toBe(2);
    expect(positionOfByteOffset("aб😀c", 7)).toBe(4);
    expect(positionOfByteOffset("aб😀c", 8)).toBe(5);
    expect(positionOfByteOffset("aб😀c", 9)).toBeNull();
  });
});
