// The note's own line endings and byte order mark, kept byte for byte through
// the editor (SPEC_EDITING.md, Л0.3, Л0.4, Л3.4).
//
// CodeMirror splits a document into lines, and `doc.toString()` always joins
// them with `\n`; only `state.sliceDoc()` joins them with the state's line
// break. So a body whose every line ends in `\r\n` gets `\r\n` as the line
// separator, and one with `\n` only, or with mixed or lone `\r` endings, gets
// `\n`: a `\r` before `\n` then stays in the document as the last character
// of its line, and a new line takes the ending of the line it was started in.
// Text that comes in from the clipboard or a drop is brought to the ending of
// the place it lands in. A byte order mark at the start of the body is taken
// off when the document loads and put back when the body is written.

import {
  Annotation,
  ChangeSet,
  EditorSelection,
  EditorState,
  type ChangeSpec,
  type Extension,
  type Text,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** U+FEFF, the byte order mark. */
export const BYTE_ORDER_MARK = "\uFEFF";
/** The UTF-8 length of the byte order mark. */
const BYTE_ORDER_MARK_BYTES = 3;
const CARRIAGE_RETURN = "\r";
const LINE_FEED = "\n";
const CRLF = "\r\n";

/** How the lines of a body end. */
export type LineEndingMode = "lf" | "crlf" | "mixed";

/** A body taken apart for the editor: the document text and what it set
 *  aside. */
export interface EditorBody {
  /** The document: the body without its byte order mark. */
  text: string;
  /** Whether the body started with a byte order mark. */
  bom: boolean;
  /** How its lines end. */
  mode: LineEndingMode;
}

/** How the lines of `text` end: `crlf` when every line break is `\r\n`,
 *  `lf` when every one is `\n` (or there is none), otherwise `mixed`. */
export function lineEndingMode(text: string): LineEndingMode {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (text.charCodeAt(index + 1) !== 10) return "mixed";
      crlf += 1;
      index += 1;
    } else if (code === 10) {
      lf += 1;
    }
    if (crlf > 0 && lf > 0) return "mixed";
  }
  return crlf > 0 ? "crlf" : "lf";
}

/** `body` as the editor loads it: the byte order mark set aside, the line
 *  endings named. */
export function editorBody(body: string): EditorBody {
  const bom = body.startsWith(BYTE_ORDER_MARK);
  const text = bom ? body.slice(BYTE_ORDER_MARK.length) : body;
  return { text, bom, mode: lineEndingMode(text) };
}

/** The line separator the document of a body with `mode` is split by. */
export function documentLineSeparator(mode: LineEndingMode): string {
  return mode === "crlf" ? CRLF : LINE_FEED;
}

/** The body `state` holds, as the file gets it: `sliceDoc`, never
 *  `doc.toString()`, and the byte order mark back in front. */
export function bodyOfState(state: EditorState, bom: boolean): string {
  const text = state.sliceDoc();
  return bom ? BYTE_ORDER_MARK + text : text;
}

/** `text` with every line break, `\r\n`, `\r` or `\n`, made `lineBreak`. */
export function normalizeLineBreaks(text: string, lineBreak: string): string {
  return text.replace(/\r\n|\r|\n/g, lineBreak);
}

/** The line break a new line started at `pos` of a mixed document gets: the
 *  ending of the line it starts in. */
export function lineBreakAt(doc: Text, pos: number): string {
  return doc.lineAt(pos).text.endsWith(CARRIAGE_RETURN) ? CRLF : LINE_FEED;
}

/** Whether `pos` stands right after the `\r` that ends its line in a mixed
 *  document: the caret goes before that sign, which is part of the ending. */
export function isAfterLineEndingReturn(doc: Text, pos: number): boolean {
  const line = doc.lineAt(pos);
  return pos === line.to && line.text.endsWith(CARRIAGE_RETURN);
}

const verbatimText = Annotation.define<boolean>();

/** Marks a transaction whose text keeps its line breaks as written: a body
 *  loaded or applied from the file, never typed. */
export const keepLineBreaks = verbatimText.of(true);

/**
 * What a change of a mixed document needs on top of itself to keep the
 * document's endings, in the positions of the document after it: a line
 * break typed in a line that ends in `\r\n` gets its `\r`; a deletion that
 * would split a `\r\n` takes the other sign too; a caret left after the `\r`
 * of a line ending moves before it. `null` when nothing needs to change.
 */
export function mixedLineEndingFixup(tr: Transaction): TransactionSpec | null {
  const before = tr.startState.doc;
  const changes: ChangeSpec[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    // A line break typed in a line that ends in `\r\n` ends the same way.
    if (inserted.lines > 1 && lineBreakAt(before, fromA) === CRLF) {
      let offset = 0;
      for (let line = 1; line < inserted.lines; line += 1) {
        const text = inserted.line(line).text;
        offset += text.length;
        if (!text.endsWith(CARRIAGE_RETURN)) changes.push({ from: fromB + offset, insert: CARRIAGE_RETURN });
        offset += 1;
      }
    }
    if (toA > fromA) {
      // The `\n` of a `\r\n` went and its `\r` stayed: take the `\r` too.
      if (before.sliceString(fromA, fromA + 1) === LINE_FEED && fromA > 0 && before.sliceString(fromA - 1, fromA) === CARRIAGE_RETURN) {
        const at = tr.changes.mapPos(fromA - 1, -1);
        if (tr.newDoc.sliceString(at, at + 1) === CARRIAGE_RETURN) changes.push({ from: at, to: at + 1 });
      }
      // The `\r` of a `\r\n` went and its `\n` stayed: take the `\n` too.
      if (before.sliceString(toA - 1, toA) === CARRIAGE_RETURN && before.sliceString(toA, toA + 1) === LINE_FEED) {
        const at = tr.changes.mapPos(toA, 1);
        if (tr.newDoc.sliceString(at, at + 1) === LINE_FEED) changes.push({ from: at, to: at + 1 });
      }
    }
  });
  const fixed = changes.length > 0 ? ChangeSet.of(changes, tr.newDoc.length) : null;
  const doc = fixed ? fixed.apply(tr.newDoc) : tr.newDoc;
  const selection = fixed ? tr.newSelection.map(fixed) : tr.newSelection;
  let clamped = false;
  const ranges = selection.ranges.map((range) => {
    const anchor = isAfterLineEndingReturn(doc, range.anchor) ? range.anchor - 1 : range.anchor;
    const head = isAfterLineEndingReturn(doc, range.head) ? range.head - 1 : range.head;
    if (anchor === range.anchor && head === range.head) return range;
    clamped = true;
    return EditorSelection.range(anchor, head);
  });
  if (changes.length === 0 && !clamped) return null;
  return {
    changes,
    sequential: true,
    selection: clamped || fixed ? EditorSelection.create(ranges, selection.mainIndex) : undefined,
  };
}

/** The transaction filter of a mixed document (`mixedLineEndingFixup`). */
const mixedLineEndingFilter = EditorState.transactionFilter.of((tr) => {
  if (tr.annotation(verbatimText) === true) return tr;
  if (!tr.docChanged && !tr.selection) return tr;
  const fixup = mixedLineEndingFixup(tr);
  return fixup ? [tr, fixup] : tr;
});

/**
 * The extensions that keep the line endings of a body with `mode`: the line
 * separator, and the input filters that bring pasted and dropped text, and in
 * a mixed document typed line breaks, to the ending of their place.
 */
export function lineEndingExtensions(mode: LineEndingMode): Extension {
  const separator = documentLineSeparator(mode);
  const pasteFilter = EditorView.clipboardInputFilter.of((text, state) =>
    normalizeLineBreaks(text, mode === "mixed" ? lineBreakAt(state.doc, state.selection.main.from) : separator),
  );
  return [
    EditorState.lineSeparator.of(separator),
    pasteFilter,
    mode === "mixed" ? mixedLineEndingFilter : [],
  ];
}

/**
 * The UTF-8 offset of document position `pos` in the body: what the core
 * addresses a body by (SPEC_EDITING.md, Л0.3). The UTF-8 starts of lines are
 * kept per document, so a later question costs one line.
 */
export function bodyByteOffset(doc: Text, pos: number, lineBreak: string, bom: boolean): number {
  const line = doc.lineAt(pos);
  const starts = lineByteStarts(doc, lineBreak, line.number);
  const lineStart = starts[line.number - 1] ?? 0;
  return (bom ? BYTE_ORDER_MARK_BYTES : 0) + lineStart + utf8Length(line.text.slice(0, pos - line.from));
}

/** The document position of UTF-8 offset `offset` of `text`, the inverse of
 *  counting bytes; `null` inside a character or past the end. */
export function positionOfByteOffset(text: string, offset: number): number | null {
  let bytes = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (bytes === offset) return index;
    if (bytes > offset || index === text.length) return null;
    const code = text.codePointAt(index) ?? 0;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    bytes += width;
    if (code >= 0x10000) index += 1;
  }
  return null;
}

interface LineByteStarts {
  lineBreak: string;
  starts: number[];
}

const lineStartCache = new WeakMap<Text, LineByteStarts>();
const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function lineByteStarts(doc: Text, lineBreak: string, upTo: number): number[] {
  let cached = lineStartCache.get(doc);
  if (!cached || cached.lineBreak !== lineBreak) {
    cached = { lineBreak, starts: [0] };
    lineStartCache.set(doc, cached);
  }
  const { starts } = cached;
  const breakBytes = utf8Length(lineBreak);
  while (starts.length < upTo) {
    const number = starts.length;
    const previous = starts[number - 1] ?? 0;
    starts.push(previous + utf8Length(doc.line(number).text) + breakBytes);
  }
  return starts;
}
