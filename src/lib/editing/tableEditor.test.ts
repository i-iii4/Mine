import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { history, undo } from "@codemirror/commands";
import { LanguageSupport } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { bodyOfState, editorBody, lineEndingExtensions } from "./lineEndings";
import { editorEnvironment, livePreview, type EditorWidgetHost, type HostedWidget } from "./livePreview";
import { externalChangeSpec } from "./reloadDiff";
import { revealField } from "./reveal";
import { mineMarkdownLanguage } from "./syntax";
import {
  activeCellText,
  activeTable,
  cancelRange,
  cellEditorOf,
  clearRange,
  enterTableCell,
  enterTableFromText,
  extendRangeBy,
  openCellEditor,
  pasteIntoRange,
  rangeCells,
  runTableCommand,
  tableMenuCommands,
  topLevelTableAt,
  typeOverRange,
} from "./tableEditor";
import { clipboardCells } from "./tableSelection";
import { insertRow, parseTable, rowCount, writeCells, tableColumnText } from "./tableModel";

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

class Host implements EditorWidgetHost {
  mount(_dom: HTMLElement, _widget: HostedWidget) {}
  update(_dom: HTMLElement, _widget: HostedWidget) {}
  unmount(_dom: HTMLElement) {}
}

const TABLE = [
  "| Ключ | Значение |",
  "|:---|---:|",
  "| a | 1 |",
  "| b | 2 |",
].join("\n");

const views: EditorView[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
});

function makeEditor(body: string) {
  const loaded = editorBody(body);
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: loaded.text,
      extensions: [
        editorEnvironment.of({ host: new Host(), links: null, idPrefix: "test", columnWidth: 680 }),
        lineEndingExtensions(loaded.mode),
        new LanguageSupport(mineMarkdownLanguage),
        history(),
        livePreview(),
      ],
    }),
  });
  views.push(view);
  return { view, body: () => bodyOfState(view.state, loaded.bom) };
}

function tableBlock(view: EditorView) {
  const pos = view.state.doc.toString().indexOf("|");
  const block = topLevelTableAt(view.state, pos);
  if (!block) throw new Error("no table");
  return block;
}

/** Open the cell `row`, `col` and its editor, as a press on it does. */
function openCell(view: EditorView, row: number, col: number, caret: "start" | "end" = "end") {
  expect(enterTableCell(view, tableBlock(view), { row, col }, { kind: caret })).toBe(true);
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  closers.push(openCellEditor(view, parent));
  const cell = cellEditorOf(view)?.view;
  if (!cell) throw new Error("no cell editor");
  return cell;
}

/** The cell's editor now open, after a move; the old one is closed as the
 *  host closes it. */
function reopen(view: EditorView) {
  for (const close of closers.splice(0)) close();
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  closers.push(openCellEditor(view, parent));
  const cell = cellEditorOf(view)?.view;
  if (!cell) throw new Error("no cell editor");
  return cell;
}

function type(cell: EditorView, text: string) {
  cell.dispatch(cell.state.replaceSelection(text), { userEvent: "input.type" });
}

function press(cell: EditorView, key: string, modifiers: Partial<KeyboardEventInit> = {}) {
  return runScopeHandlers(cell, new KeyboardEvent("keydown", { key, ...modifiers }), "editor");
}

function changedLines(before: string, after: string): string[] {
  const old = before.split("\n");
  return after.split("\n").filter((line, index) => old[index] !== line);
}

describe("the active cell (Л9.2, Л9.5)", () => {
  it("opens the table editor: the main caret at the table's start, the cell's source in its own view", () => {
    const { view } = makeEditor(`Before.\n\n${TABLE}\n\nAfter.`);
    const cell = openCell(view, 1, 0);
    const active = activeTable(view.state);
    expect(active?.owner).toEqual({ kind: "cell", cell: { row: 1, col: 0 } });
    expect(view.state.selection.main.head).toBe(tableBlock(view).from);
    expect(cell.state.doc.toString()).toBe("a");
    expect(cell.contentDOM.getAttribute("aria-label")).toBe("Row 2, column 1");
  });

  it("writes typing into the cell's content only, a transaction of the main history", () => {
    const body = `Before.\n\n${TABLE}\n\nAfter.`;
    const { view, body: current } = makeEditor(body);
    const cell = openCell(view, 1, 0);
    type(cell, "бв");
    expect(changedLines(body, current())).toEqual(["| aбв | 1 |"]);
    // The cell's view shows the main document's text.
    expect(cell.state.doc.toString()).toBe(activeCellText(view.state));
    undo(view);
    expect(current()).toBe(body);
    // Undo leaves the cell (C4).
    expect(activeTable(view.state)).toBeNull();
  });

  it("encodes a pipe and a line break, keeps a space typed at the end", () => {
    const { view, body: current } = makeEditor(TABLE);
    const cell = openCell(view, 1, 1);
    type(cell, " ");
    expect(cell.state.doc.toString()).toBe("1 ");
    type(cell, "|");
    expect(current().split("\n")[2]).toBe("| a | 1 \\| |");
    expect(cell.state.doc.toString()).toBe("1 |");
    expect(press(cell, "Enter", { shiftKey: true })).toBe(true);
    type(cell, "x");
    expect(current().split("\n")[2]).toBe("| a | 1 \\|<br>x |");
    expect(cell.state.doc.toString()).toBe("1 |\nx");
  });

  it("does nothing at Enter while the decision ЛВ6 waits", () => {
    const { view, body: current } = makeEditor(TABLE);
    const cell = openCell(view, 1, 0);
    expect(press(cell, "Enter")).toBe(true);
    expect(current()).toBe(TABLE);
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 1, col: 0 } });
  });

  it("does nothing at Backspace at a cell's start and Delete at its end (C1)", () => {
    const { view, body: current } = makeEditor(TABLE);
    const cell = openCell(view, 1, 0, "start");
    expect(press(cell, "Backspace")).toBe(true);
    cell.dispatch({ selection: EditorSelection.cursor(cell.state.doc.length) });
    expect(press(cell, "Delete")).toBe(true);
    expect(current()).toBe(TABLE);
  });

  it("adds the cells a ragged row misses when its missing cell is typed in", () => {
    const text = "| a | b | c |\n|---|---|---|\n| 1 |";
    const { view, body: current } = makeEditor(text);
    const cell = openCell(view, 1, 2);
    expect(cell.state.doc.toString()).toBe("");
    type(cell, "x");
    expect(current()).toBe("| a | b | c |\n|---|---|---|\n| 1 | | x |");
    type(cell, "y");
    expect(current()).toBe("| a | b | c |\n|---|---|---|\n| 1 | | xy |");
  });

  it("keeps \\r\\n and mixed line endings byte for byte", () => {
    const crlf = TABLE.replace(/\n/g, "\r\n");
    const { view, body: current } = makeEditor(`${crlf}\r\n`);
    const cell = openCell(view, 2, 1);
    type(cell, "0");
    expect(current()).toBe(`${crlf.replace("| b | 2 |", "| b | 20 |")}\r\n`);
    // A mixed body keeps the `\r` of a row's ending in the row's line.
    const mixed = "Intro\r\n\r\n| a | b |\n|---|---|\n| 1 | 2 |\r\n\r\nend";
    const second = makeEditor(mixed);
    const mixedCell = openCell(second.view, 1, 1);
    type(mixedCell, "!");
    expect(second.body()).toBe("Intro\r\n\r\n| a | b |\n|---|---|\n| 1 | 2! |\r\n\r\nend");
  });

  it("follows a change of its cell from outside", () => {
    const { view } = makeEditor(TABLE);
    const cell = openCell(view, 1, 0);
    view.dispatch(externalChangeSpec(view.state, TABLE.replace("| a |", "| ab |")));
    const now = cellEditorOf(view)?.view ?? cell;
    expect(activeCellText(view.state)).toBe("ab");
    expect(now.state.doc.toString()).toBe("ab");
  });
});

describe("keys of a table (Л9.6)", () => {
  it("Tab goes to the next cell; in the last one it adds a row and goes to its first cell", () => {
    const { view, body: current } = makeEditor(TABLE);
    let cell = openCell(view, 2, 0);
    expect(press(cell, "Tab")).toBe(true);
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 2, col: 1 } });
    cell = reopen(view);
    expect(press(cell, "Tab")).toBe(true);
    expect(current()).toBe(`${TABLE}\n| | |`);
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 3, col: 0 } });
    cell = reopen(view);
    type(cell, "c");
    // Only the cell's content changes: its one space of padding stays before it.
    expect(current()).toBe(`${TABLE}\n| c| |`);
  });

  it("⇧Tab goes back and leaves the table from its first cell", () => {
    const { view } = makeEditor(`Before.\n\n${TABLE}`);
    let cell = openCell(view, 1, 0);
    expect(press(cell, "Tab", { shiftKey: true })).toBe(true);
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 0, col: 1 } });
    cell = reopen(view);
    press(cell, "Tab", { shiftKey: true });
    cell = reopen(view);
    expect(press(cell, "Tab", { shiftKey: true })).toBe(true);
    expect(activeTable(view.state)).toBeNull();
    expect(view.state.selection.main.head).toBe(tableBlock(view).from - 1);
  });

  it("← and → cross cells at their edges and leave the table past its first and last cell", () => {
    const { view } = makeEditor(`${TABLE}\n\nAfter.`);
    let cell = openCell(view, 0, 1, "start");
    expect(press(cell, "ArrowLeft")).toBe(true);
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 0, col: 0 } });
    cell = reopen(view);
    expect(cell.state.selection.main.head).toBe(cell.state.doc.length);
    // Inside the text the arrow moves the cell's own caret.
    cell.dispatch({ selection: EditorSelection.cursor(0) });
    press(cell, "ArrowRight");
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 0, col: 0 } });
    cell.dispatch({ selection: EditorSelection.cursor(cell.state.doc.length) });
    expect(press(cell, "ArrowRight")).toBe(true);
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 0, col: 1 } });
    const table = tableBlock(view);
    enterTableCell(view, table, { row: 2, col: 1 }, { kind: "end" });
    cell = reopen(view);
    expect(press(cell, "ArrowRight")).toBe(true);
    expect(activeTable(view.state)).toBeNull();
    expect(view.state.selection.main.head).toBe(table.to + 1);
  });

  it("↑ ↓ go to the cell of the same column, the caret's column kept; out of the table at its ends", () => {
    const { view } = makeEditor(`Above.\n${TABLE.replace("| a |", "| abc |")}\nBelow.`.replace("Above.\n", "Above.\n\n").replace("\nBelow.", "\n\nBelow."));
    let cell = openCell(view, 1, 0);
    cell.dispatch({ selection: EditorSelection.cursor(2) });
    expect(press(cell, "ArrowUp")).toBe(true);
    const active = activeTable(view.state);
    expect(active?.owner).toEqual({ kind: "cell", cell: { row: 0, col: 0 } });
    expect(active?.caret).toEqual({ kind: "column", column: 2, fromAbove: false });
    cell = reopen(view);
    expect(cell.state.selection.main.head).toBe(2);
    expect(press(cell, "ArrowUp")).toBe(true);
    expect(activeTable(view.state)).toBeNull();
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    const table = tableBlock(view);
    enterTableCell(view, table, { row: 2, col: 1 }, { kind: "end" });
    cell = reopen(view);
    expect(press(cell, "ArrowDown")).toBe(true);
    expect(activeTable(view.state)).toBeNull();
    expect(view.state.selection.main.head).toBe(table.to + 1);
  });

  it("↓ from the line above opens the header, ↑ from the line below the last row", () => {
    // jsdom lays nothing out, so the arrows' move between lines is the
    // browser check's; here the entry they lead to.
    const { view } = makeEditor(`Above.\n\n${TABLE}\n\nBelow.`);
    expect(enterTableFromText(view, tableBlock(view), true, null)).toBe(true);
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 0, col: 0 } });
    expect(activeTable(view.state)?.caret).toEqual({ kind: "start" });
    expect(enterTableFromText(view, tableBlock(view), false, null)).toBe(true);
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 2, col: 0 } });
  });

  it("Escape leaves the table, the caret right after it", () => {
    const { view } = makeEditor(`${TABLE}\n\nAfter.`);
    const cell = openCell(view, 1, 1);
    expect(press(cell, "Escape")).toBe(true);
    expect(activeTable(view.state)).toBeNull();
    expect(view.state.selection.main.head).toBe(tableBlock(view).to + 1);
  });

  it("a press elsewhere in the main text ends the active table", () => {
    const { view } = makeEditor(`${TABLE}\n\nAfter.`);
    openCell(view, 1, 1);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), userEvent: "select.pointer" });
    expect(activeTable(view.state)).toBeNull();
  });
});

describe("the range of cells (Л9.7)", () => {
  it("⇧↓ makes a range from the active cell, its cells read as shown", () => {
    const { view } = makeEditor(TABLE.replace("| b |", "| b\\|c |"));
    const cell = openCell(view, 1, 0);
    expect(press(cell, "ArrowDown", { shiftKey: true })).toBe(true);
    const active = activeTable(view.state);
    expect(active?.owner).toEqual({ kind: "range", anchor: { row: 1, col: 0 }, head: { row: 2, col: 0 } });
    expect(active?.edit).toBeNull();
    expect(extendRangeBy(view, 0, 1)).toBe(true);
    expect(rangeCells(view.state)).toEqual([["a", "1"], ["b|c", "2"]]);
  });

  it("clears, takes a paste cut at the table's edge, and fills with one cell", () => {
    const { view, body: current } = makeEditor(TABLE);
    openCell(view, 1, 0);
    extendRangeBy(view, 1, 1);
    expect(clearRange(view)).toBe(true);
    expect(current().split("\n").slice(2)).toEqual(["|  |  |", "|  |  |"]);
    expect(pasteIntoRange(view, clipboardCells(null, "x\ty\tz\nu|v\tw\nlost"))).toBe(true);
    expect(current().split("\n").slice(2)).toEqual(["| x | y |", "| u\\|v | w |"]);
    expect(pasteIntoRange(view, clipboardCells("<table><tr><td>one<br>two</td></tr></table>", "one two"))).toBe(true);
    expect(current().split("\n").slice(2)).toEqual(["| one<br>two | one<br>two |", "| one<br>two | one<br>two |"]);
  });

  it("typing over a range clears it and writes the anchor cell, which takes the caret", () => {
    const { view, body: current } = makeEditor(TABLE);
    openCell(view, 1, 1);
    extendRangeBy(view, 1, 0);
    expect(typeOverRange(view, "z")).toBe(true);
    expect(current().split("\n").slice(2)).toEqual(["| a | z |", "| b |  |"]);
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 1, col: 1 } });
  });

  it("Escape ends the range on its anchor cell", () => {
    const { view } = makeEditor(TABLE);
    openCell(view, 2, 1);
    extendRangeBy(view, -1, 0);
    expect(cancelRange(view)).toBe(true);
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 2, col: 1 } });
  });

  it("a change of the table from outside ends the range", () => {
    const { view } = makeEditor(TABLE);
    openCell(view, 1, 0);
    extendRangeBy(view, 1, 0);
    view.dispatch(externalChangeSpec(view.state, TABLE.replace("| b |", "| bb |")));
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 1, col: 0 } });
  });
});

describe("structure commands (Л9.8, Л9.11)", () => {
  it("offers the commands a row and a column can take", () => {
    const { view } = makeEditor(TABLE);
    openCell(view, 0, 0);
    const header = tableMenuCommands(view.state).map((command) => command.id);
    expect(header).not.toContain("insert-row-above");
    expect(header).not.toContain("delete-row");
    expect(header).toContain("delete-column");
    expect(header).toContain("edit-as-markdown");
    const single = makeEditor("| a |\n|---|\n| b |");
    openCell(single.view, 1, 0);
    expect(tableMenuCommands(single.view.state).map((command) => command.id)).not.toContain("delete-column");
  });

  it("runs each command as one transaction that changes only its bytes", () => {
    const body = `Before.\n\n${TABLE}\n\nAfter.`;
    const { view, body: current } = makeEditor(body);
    openCell(view, 1, 1);
    expect(runTableCommand(view, "insert-row-below")).toBe(true);
    expect(current()).toBe(body.replace("| a | 1 |\n", "| a | 1 |\n| | |\n"));
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 2, col: 1 } });
    undo(view);
    expect(current()).toBe(body);
    openCell(view, 1, 1);
    runTableCommand(view, "align-right");
    expect(current()).toBe(body);
    runTableCommand(view, "align-center");
    expect(changedLines(body, current())).toEqual(["|:---|:---:|"]);
    undo(view);
    openCell(view, 1, 0);
    runTableCommand(view, "delete-column");
    expect(current()).toBe(body.replace("| Ключ | Значение |", "| Значение |").replace("|:---|---:|", "|---:|").replace("| a | 1 |", "| 1 |").replace("| b | 2 |", "| 2 |"));
    undo(view);
    openCell(view, 2, 0);
    runTableCommand(view, "move-row-up");
    expect(current()).toBe(body.replace("| a | 1 |\n| b | 2 |", "| b | 2 |\n| a | 1 |"));
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 1, col: 0 } });
    runTableCommand(view, "move-column-right");
    expect(current().split("\n")[2]).toBe("| Значение | Ключ |");
  });

  it("Edit as Markdown shows the table's source", () => {
    const { view } = makeEditor(TABLE);
    openCell(view, 1, 0);
    expect(runTableCommand(view, "edit-as-markdown")).toBe(true);
    expect(activeTable(view.state)).toBeNull();
    expect(view.state.field(revealField).blocks).toEqual([0]);
  });
});

describe("the edges of a table in the main text (Л9.2)", () => {
  it("typing right after a table at the end of the note goes on a line of its own", () => {
    const { view, body: current } = makeEditor(TABLE);
    const end = view.state.doc.length;
    view.dispatch({ selection: EditorSelection.cursor(end) });
    view.dispatch({ changes: { from: end, insert: "x" }, userEvent: "input.type" });
    expect(current()).toBe(`${TABLE}\nx`);
  });

  it("typing right before a table at the start of the note goes on a line of its own", () => {
    const { view, body: current } = makeEditor(TABLE);
    view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    expect(current()).toBe(`x\n${TABLE}`);
  });

  it("Backspace at the line after a table chooses the table instead of joining the line to it", () => {
    const { view, body: current } = makeEditor(`${TABLE}\n\nText`);
    const table = tableBlock(view);
    view.dispatch({ changes: { from: table.to, to: table.to + 1 }, userEvent: "delete.backward" });
    expect(current()).toBe(`${TABLE}\n\nText`);
    expect(view.state.selection.main).toMatchObject({ from: table.from, to: table.to });
  });
});

describe("large tables (Л9.12)", () => {
  /** A table of `rows` body rows and `columns` columns. */
  function bigTable(rows: number, columns: number): string {
    const header = `| ${Array.from({ length: columns }, (_, index) => `Столбец ${index}`).join(" | ")} |`;
    const delimiter = `|${Array.from({ length: columns }, () => "---").join("|")}|`;
    const body = Array.from({ length: rows }, (_, row) => `| ${Array.from({ length: columns }, (_, col) => (col === 1 ? `**${row}**` : `ячейка ${row}.${col}`)).join(" | ")} |`);
    return [header, delimiter, ...body].join("\n");
  }

  function percentile(values: number[], share: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
  }

  it("types in a cell of a table of 5000 rows with no cost of its own beyond the parser's", () => {
    const text = `Intro.\n\n${bigTable(5000, 5)}\n\nEnd.`;
    // The same keystrokes in plain CodeMirror with the note's language: what
    // the parser costs, which reads the whole table again on every edit of
    // it (one leaf block of @lezer/markdown).
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const plain = new EditorView({
      parent,
      state: EditorState.create({ doc: text, extensions: [lineEndingExtensions("lf"), new LanguageSupport(mineMarkdownLanguage)] }),
    });
    views.push(plain);
    const at = plain.state.doc.line(2 + 2 + 2500).from + 3;
    const { view, body: current } = makeEditor(text);
    const cell = openCell(view, 2500, 3);
    // Keystrokes alternate between the two, so a busy machine weighs on both
    // alike.
    const plainTimes: number[] = [];
    const times: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      let start = performance.now();
      plain.dispatch({ changes: { from: at, insert: "ж" }, userEvent: "input.type" });
      plainTimes.push(performance.now() - start);
      start = performance.now();
      type(cell, "ж");
      times.push(performance.now() - start);
    }
    expect(current().split("\n")[2 + 1 + 2500]).toContain("ж".repeat(40));
    const median = percentile(times, 0.5);
    const parser = percentile(plainTimes, 0.5);
    console.info(`table 5000×5 (${text.length} signs): typing in a cell median ${median.toFixed(1)} ms, p95 ${percentile(times, 0.95).toFixed(1)} ms; the parser alone median ${parser.toFixed(1)} ms, p95 ${percentile(plainTimes, 0.95).toFixed(1)} ms`);
    // What the table editor adds to the parser stays within one frame.
    expect(median - parser).toBeLessThan(16);
  }, 60_000);

  it("parses, measures and edits the structure of a table of 5000 rows and of 30 columns within a frame or two", () => {
    for (const [rows, columns] of [[5000, 12], [200, 30]] as const) {
      const text = bigTable(rows, columns);
      let start = performance.now();
      const model = parseTable(text);
      const parse = performance.now() - start;
      if (!model) throw new Error("no table");
      expect(rowCount(model)).toBe(rows + 1);
      start = performance.now();
      tableColumnText(model);
      const columnText = performance.now() - start;
      start = performance.now();
      insertRow(model, Math.floor(rows / 2), true);
      writeCells(model, [{ ref: { row: rows, col: columns - 1 }, source: "x" }]);
      const command = performance.now() - start;
      console.info(`table ${rows}×${columns}: parse ${parse.toFixed(1)} ms, column text ${columnText.toFixed(1)} ms, two commands ${command.toFixed(1)} ms`);
      expect(parse).toBeLessThan(200);
      expect(command).toBeLessThan(50);
    }
  });
});
