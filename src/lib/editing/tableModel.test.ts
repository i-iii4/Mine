import { describe, expect, it } from "vitest";
import type { Table, TableCell as MdastCell, TableRow as MdastRow } from "mdast";
import { parseReadingSyntax } from "@/lib/reading/syntax";
import { unescapedPipes } from "./tableCell";
import {
  alignColumn,
  alignedDelimiter,
  applyTableChanges,
  cellRefAt,
  cellSource,
  cellTextRuns,
  clearColumn,
  clearRow,
  deleteColumn,
  deleteRow,
  duplicateColumn,
  duplicateRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  rowCount,
  tableColumnText,
  writeCells,
  type TableAlignment,
  type TableModel,
  type TableTextChange,
} from "./tableModel";

/** What a table holds as the reading mode reads it: every row's cells as
 *  written (header first, extra cells of a ragged row included) and the
 *  alignments. `null` when the reading mode reads no single table. */
function readingTable(text: string): { rows: string[][]; align: TableAlignment[] } | null {
  const tree = parseReadingSyntax(text);
  const [table] = tree.children;
  if (!table || table.type !== "table" || tree.children.length !== 1) return null;
  const rows = (table as Table).children.map((row: MdastRow) => row.children.map((cell: MdastCell, index, cells) => {
    const start = cell.position?.start.offset ?? 0;
    const end = cell.position?.end.offset ?? 0;
    let source = text.slice(start, end);
    if (source.startsWith("|")) source = source.slice(1);
    if (index === cells.length - 1) {
      const pipes = unescapedPipes(source);
      const last = pipes[pipes.length - 1];
      if (last !== undefined && source.slice(last + 1).trim() === "") source = source.slice(0, last);
    }
    return source.trim();
  }));
  return { rows, align: ((table as Table).align ?? []).map((value) => value ?? null) };
}

/** What the model holds, in the same terms. */
function modelTable(model: TableModel): { rows: string[][]; align: TableAlignment[] } {
  const rows = model.lines.filter((_, index) => index !== 1).map((line) => line.cells.map((cell) => model.text.slice(cell.from, cell.to)));
  return { rows, align: model.alignments };
}

function parsed(text: string): TableModel {
  const model = parseTable(text);
  if (!model) throw new Error(`no table: ${JSON.stringify(text)}`);
  return model;
}

function apply(text: string, changes: TableTextChange[]): string {
  return applyTableChanges(text, changes);
}

/** The model and the reading mode read `text` alike. */
function expectReadAlike(text: string) {
  const model = parsed(text);
  expect(modelTable(model)).toEqual(readingTable(text));
  return model;
}

describe("parseTable", () => {
  it("reads lines with and without the outer pipes, indentation, escaped pipes and code", () => {
    const text = [
      "  | Ключ | Значение \\| и черта | `a|b` |",
      "|:---|:---:|---:|---|",
      "x | y",
      "| <br> | a<br/>b | `c` | d |",
      "|  | пусто слева |",
    ].join("\n");
    const model = expectReadAlike(text);
    expect(model.columns).toBe(4);
    expect(model.alignments).toEqual(["left", "center", "right", null]);
    expect(cellSource(model, { row: 0, col: 1 })).toBe("Значение \\| и черта");
    // A pipe in code ends the cell, as in GFM.
    expect(cellSource(model, { row: 0, col: 2 })).toBe("`a");
    expect(cellSource(model, { row: 1, col: 0 })).toBe("x");
    expect(rowCount(model)).toBe(4);
  });

  it("keeps the cells of ragged rows: missing ones read empty, extra ones are kept", () => {
    const model = expectReadAlike("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |");
    expect(cellSource(model, { row: 1, col: 2 })).toBe("");
    expect(model.lines[3]?.cells).toHaveLength(5);
  });

  it("leaves the \\r of a mixed line ending out of the row", () => {
    const model = expectReadAlike("| a | b |\r\n|---|---|\n| 1 | 2 |\r");
    expect(model.lines[0]?.end).toBe(9);
    expect(model.lines[0]?.to).toBe(10);
    expect(model.lines[0]?.trailingPipe).toBe(true);
  });

  it("refuses what is no table", () => {
    expect(parseTable("| a |")).toBeNull();
    expect(parseTable("| a | b |\n|---|")).toBeNull();
    expect(parseTable("| a |\n| b |")).toBeNull();
  });

  it("finds the cell at a position, never in the delimiter row", () => {
    const model = parsed("| a | b |\n|---|---|\n| c | d |");
    expect(cellRefAt(model, 2)).toEqual({ row: 0, col: 0 });
    expect(cellRefAt(model, 26)).toEqual({ row: 1, col: 1 });
    expect(cellRefAt(model, 12)).toBeNull();
  });
});

const TABLE = [
  "| Слева | По центру | Справа |",
  "|:---|:---:|---:|",
  "| текст | `a \\| b` | 1 234 |",
  "| длинный текст | ок | 56,78 |",
].join("\n");

/** The lines of `after` that are not in `before`'s place: what changed. */
function changedLines(before: string, after: string): string[] {
  const old = before.split("\n");
  return after.split("\n").filter((line, index) => old[index] !== line);
}

describe("commands change only their bytes (Л9.11)", () => {
  it("typing into a cell changes its content only", () => {
    const model = parsed(TABLE);
    const result = apply(TABLE, writeCells(model, [{ ref: { row: 1, col: 0 }, source: "новый текст" }]));
    expect(result).toBe(TABLE.replace("| текст |", "| новый текст |"));
  });

  it("typing into a missing cell of a ragged row adds the cells before it at the end", () => {
    const text = "| a | b | c |\n|---|---|---|\n| 1 |";
    const result = apply(text, writeCells(parsed(text), [{ ref: { row: 1, col: 2 }, source: "x" }]));
    expect(result).toBe("| a | b | c |\n|---|---|---|\n| 1 | | x |");
    expectReadAlike(result);
    const open = "a | b | c\n--|--|--\n1 | 2";
    expect(apply(open, writeCells(parsed(open), [{ ref: { row: 1, col: 2 }, source: "x" }]))).toBe("a | b | c\n--|--|--\n1 | 2 | x ");
  });

  it("inserts a row of empty cells beside its neighbour, with its indentation and line ending", () => {
    const model = parsed(TABLE);
    expect(apply(TABLE, insertRow(model, 1, true)).split("\n")[3]).toBe("| | | |");
    expect(apply(TABLE, insertRow(model, 1, false)).split("\n")[2]).toBe("| | | |");
    expect(insertRow(model, 0, false)).toEqual([]);
    expect(apply(TABLE, insertRow(model, 0, true)).split("\n")[2]).toBe("| | | |");
    const indented = "  a | b\n  --|--\n  1 | 2\r";
    expect(apply(indented, insertRow(parsed(indented), 1, true))).toBe("  a | b\n  --|--\n  1 | 2\r\n  | | |\r");
  });

  it("deletes a row with its line break, the last one with the break before it", () => {
    const model = parsed(TABLE);
    expect(apply(TABLE, deleteRow(model, 1))).toBe(TABLE.split("\n").filter((_, index) => index !== 2).join("\n"));
    expect(apply(TABLE, deleteRow(model, 2))).toBe(TABLE.split("\n").slice(0, 3).join("\n"));
    expect(deleteRow(model, 0)).toEqual([]);
  });

  it("duplicates a row by its bytes; the header's copy is the first body row", () => {
    const model = parsed(TABLE);
    const lines = TABLE.split("\n");
    expect(apply(TABLE, duplicateRow(model, 1)).split("\n")).toEqual([...lines.slice(0, 3), lines[2], lines[3]]);
    expect(apply(TABLE, duplicateRow(model, 0)).split("\n")[2]).toBe(lines[0]);
  });

  it("clears a row's content and keeps its padding", () => {
    expect(apply(TABLE, clearRow(parsed(TABLE), 1)).split("\n")[2]).toBe("|  |  |  |");
  });

  it("moves a row by its bytes", () => {
    const lines = TABLE.split("\n");
    expect(apply(TABLE, moveRow(parsed(TABLE), 2, 1)).split("\n")).toEqual([lines[0], lines[1], lines[3], lines[2]]);
  });

  it("inserts a column at a boundary: empty cells, --- in the delimiter row", () => {
    const result = apply(TABLE, insertColumn(parsed(TABLE), 1));
    expect(result.split("\n")).toEqual([
      "| Слева | | По центру | Справа |",
      "|:---|---|:---:|---:|",
      "| текст | | `a \\| b` | 1 234 |",
      "| длинный текст | | ок | 56,78 |",
    ]);
    expectReadAlike(result);
  });

  it("deletes a column with one pipe beside each cell; never the only one", () => {
    expect(apply(TABLE, deleteColumn(parsed(TABLE), 0)).split("\n")[0]).toBe("| По центру | Справа |");
    expect(apply(TABLE, deleteColumn(parsed(TABLE), 2)).split("\n")[1]).toBe("|:---|:---:|");
    expect(deleteColumn(parsed("| a |\n|---|"), 0)).toEqual([]);
  });

  it("duplicates and clears a column", () => {
    expect(apply(TABLE, duplicateColumn(parsed(TABLE), 1)).split("\n")[2]).toBe("| текст | `a \\| b` | `a \\| b` | 1 234 |");
    const cleared = apply(TABLE, clearColumn(parsed(TABLE), 2));
    expect(cleared.split("\n")[0]).toBe("| Слева | По центру |  |");
    expect(cleared.split("\n")[1]).toBe("|:---|:---:|---:|");
  });

  it("moves a column with its padding and its alignment", () => {
    const moved = apply(TABLE, moveColumn(parsed(TABLE), 2, 0));
    expect(moved.split("\n")).toEqual([
      "| Справа | Слева | По центру |",
      "|---:|:---|:---:|",
      "| 1 234 | текст | `a \\| b` |",
      "| 56,78 | длинный текст | ок |",
    ]);
  });

  it("aligns by the delimiter cell only, keeping its width (Л9.9)", () => {
    expect(alignedDelimiter("---", "left")).toBe(":---");
    expect(alignedDelimiter("-----", "center")).toBe(":---:");
    expect(alignedDelimiter(":---:", "right")).toBe("----:");
    expect(alignedDelimiter("---:", "center")).toBe(":---:");
    expect(alignedDelimiter("----", "left")).toBe(":---");
    const result = apply(TABLE, alignColumn(parsed(TABLE), 0, "right"));
    expect(changedLines(TABLE, result)).toEqual(["|---:|:---:|---:|"]);
  });

  it("adds the pipe a row needs so no cell is lost", () => {
    // Clearing the first cell of a row without a leading pipe.
    const open = "a | b\n--|--\nc | d";
    expect(apply(open, clearColumn(parsed(open), 0))).toBe("| | b\n--|--\n| | d");
    expectReadAlike(apply(open, clearColumn(parsed(open), 0)));
    // Clearing the last cell of a row without a trailing pipe.
    expect(apply(open, clearColumn(parsed(open), 1))).toBe("a | |\n--|--\nc | |");
    // Deleting the only cell of a short row leaves a pipe, not a blank line.
    const short = "| a | b |\n|---|---|\n| x";
    expect(apply(short, deleteColumn(parsed(short), 0))).toBe("| b |\n|---|\n|");
    expect(parsed("| a |\n|---|\n|").lines[2]?.cells).toHaveLength(1);
  });

  it("works on a body with \\r\\n line endings kept in the lines", () => {
    const crlf = TABLE.split("\n").map((line) => `${line}\r`).join("\n");
    const model = expectReadAlike(crlf);
    const result = apply(crlf, insertColumn(model, 3));
    for (const line of result.split("\n")) expect(line.endsWith("\r")).toBe(true);
    expectReadAlike(result);
    expect(apply(crlf, moveRow(model, 1, 2)).split("\n").every((line) => line.endsWith("\r"))).toBe(true);
  });
});

/** A small generator with a seed, so a failing case can be run again. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const CONTENTS = ["a", "текст", "1 234", "`x \\| y`", "a\\|b", "**b**", "[l](u)", "<br>", "x<br/>y", "C:\\\\p", "😀", "a b"];

function randomTable(next: () => number): string {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const columns = 1 + Math.floor(next() * 4);
  const lineEnding = next() < 0.3 ? "\r" : "";
  const row = (cells: string[], delimiter = false): string => {
    const leading = delimiter || next() < 0.8 || cells[0] === "";
    const trailing = delimiter || next() < 0.7 || cells[cells.length - 1] === "";
    const indent = pick(["", "", " ", "  "]);
    const pad = () => pick(["", " ", " ", "  "]);
    const body = cells.map((cell) => {
      const before = pad();
      const after = cell.endsWith("\\") ? " " : pad();
      return `${before}${cell}${after}`;
    }).join("|");
    // A row needs a pipe, and without the leading one its first cell needs
    // content; it gets one either way.
    return `${indent}${leading || !cells.some(Boolean) ? "|" : ""}${body}${trailing ? "|" : ""}${lineEnding}`;
  };
  const header = Array.from({ length: columns }, () => pick(CONTENTS));
  const delimiter = Array.from({ length: columns }, () => pick(["---", ":---", "---:", ":-:", "--"]));
  const body = Array.from({ length: Math.floor(next() * 5) }, () => {
    const count = Math.max(1, columns + Math.floor(next() * 3) - 1);
    return Array.from({ length: count }, () => (next() < 0.2 ? "" : pick(CONTENTS)));
  });
  return [row(header), row(delimiter, true), ...body.map((cells) => row(cells))].join("\n");
}

type Expected = { rows: string[][]; align: TableAlignment[] };

/** What a command does to the table as the reading mode reads it. */
function expectedAfter(before: Expected, command: string, args: number[], columns: number): Expected {
  const rows = before.rows.map((row) => [...row]);
  const align = [...before.align];
  const [a = 0, b = 0] = args;
  switch (command) {
    case "insertRowBelow":
      rows.splice(a + 1, 0, Array.from({ length: columns }, () => ""));
      break;
    case "insertRowAbove":
      rows.splice(a, 0, Array.from({ length: columns }, () => ""));
      break;
    case "deleteRow":
      rows.splice(a, 1);
      break;
    case "duplicateRow":
      rows.splice(a === 0 ? 1 : a + 1, 0, [...(rows[a] ?? [])]);
      break;
    case "clearRow":
      rows[a] = (rows[a] ?? []).map(() => "");
      break;
    case "moveRow": {
      const [moved] = rows.splice(a, 1);
      rows.splice(b, 0, moved ?? []);
      break;
    }
    case "insertColumn":
      for (const row of rows) if (row.length >= a) row.splice(a, 0, "");
      align.splice(a, 0, null);
      break;
    case "deleteColumn":
      for (const row of rows) if (row.length > a) row.splice(a, 1);
      align.splice(a, 1);
      break;
    case "duplicateColumn":
      for (const row of rows) if (row.length > a) row.splice(a + 1, 0, row[a] ?? "");
      align.splice(a + 1, 0, align[a] ?? null);
      break;
    case "clearColumn":
      for (const row of rows) if (row.length > a) row[a] = "";
      break;
    case "moveColumn": {
      for (const [index, row] of rows.entries()) {
        const length = row.length;
        if (length <= Math.min(a, b)) continue;
        while (row.length < Math.max(a, b) + 1) row.push("");
        const [moved] = row.splice(a, 1);
        row.splice(b, 0, moved ?? "");
        while (row.length > length && row[row.length - 1] === "") row.pop();
        rows[index] = row;
      }
      const [moved] = align.splice(a, 1);
      align.splice(b, 0, moved ?? null);
      break;
    }
    case "align":
      align[a] = (["left", "center", "right"] as const)[b] ?? null;
      break;
    case "write": {
      const row = rows[a];
      if (row) {
        while (row.length <= b) row.push("");
        row[b] = "w";
      }
      break;
    }
  }
  return { rows, align };
}

/** A line left with no cell reads as one empty cell. */
function asRead(table: Expected): Expected {
  return { rows: table.rows.map((row) => (row.length === 0 ? [""] : row)), align: table.align };
}

function runCommand(model: TableModel, command: string, args: number[]): TableTextChange[] {
  const [a = 0, b = 0] = args;
  switch (command) {
    case "insertRowBelow":
      return insertRow(model, a, true);
    case "insertRowAbove":
      return insertRow(model, a, false);
    case "deleteRow":
      return deleteRow(model, a);
    case "duplicateRow":
      return duplicateRow(model, a);
    case "clearRow":
      return clearRow(model, a);
    case "moveRow":
      return moveRow(model, a, b);
    case "insertColumn":
      return insertColumn(model, a);
    case "deleteColumn":
      return deleteColumn(model, a);
    case "duplicateColumn":
      return duplicateColumn(model, a);
    case "clearColumn":
      return clearColumn(model, a);
    case "moveColumn":
      return moveColumn(model, a, b);
    case "align":
      return alignColumn(model, a, (["left", "center", "right"] as const)[b] ?? null);
    default:
      return writeCells(model, [{ ref: { row: a, col: b }, source: "w" }]);
  }
}

describe("random tables and chains of commands", () => {
  it("every result reads as the expected table, and lines the command keeps keep their bytes", () => {
    const next = random(2026);
    const commands = ["insertRowBelow", "insertRowAbove", "deleteRow", "duplicateRow", "clearRow", "moveRow", "insertColumn", "deleteColumn", "duplicateColumn", "clearColumn", "moveColumn", "align", "write"];
    let checked = 0;
    for (let table = 0; table < 150; table += 1) {
      let text = randomTable(next);
      const read = readingTable(text);
      if (!read) continue;
      expect(modelTable(parsed(text))).toEqual(read);
      for (let step = 0; step < 12; step += 1) {
        const model = parsed(text);
        const rows = rowCount(model);
        const command = commands[Math.floor(next() * commands.length)] ?? "write";
        let args: number[];
        if (command === "insertRowAbove" || command === "deleteRow") args = [1 + Math.floor(next() * Math.max(1, rows - 1))];
        else if (command === "moveRow") args = [1 + Math.floor(next() * Math.max(1, rows - 1)), 1 + Math.floor(next() * Math.max(1, rows - 1))];
        else if (command === "insertRowBelow" || command === "duplicateRow" || command === "clearRow") args = [Math.floor(next() * rows)];
        else if (command === "insertColumn") args = [Math.floor(next() * (model.columns + 1))];
        else if (command === "moveColumn") args = [Math.floor(next() * model.columns), Math.floor(next() * model.columns)];
        else if (command === "align") args = [Math.floor(next() * model.columns), Math.floor(next() * 3)];
        else if (command === "write") args = [Math.floor(next() * rows), Math.floor(next() * model.columns)];
        else args = [Math.floor(next() * model.columns)];
        if (command === "deleteColumn" && model.columns <= 1) continue;
        if ((command === "insertRowAbove" || command === "deleteRow" || command === "moveRow") && rows < 2) continue;
        const changes = runCommand(model, command, args);
        const after = apply(text, changes);
        const expected = expectedAfter(modelTable(model), command, args, model.columns);
        const context = `${command}(${args.join(", ")}) on ${JSON.stringify(text)} gave ${JSON.stringify(after)}`;
        expect(readingTable(after), context).toEqual(asRead(expected));
        expect(modelTable(parsed(after)), context).toEqual(asRead(expected));
        const movesLines = ["insertRowBelow", "insertRowAbove", "deleteRow", "duplicateRow", "moveRow"].includes(command);
        // A line the command does not change keeps its bytes.
        if (!movesLines) {
          const before = text.split("\n");
          const lines = after.split("\n");
          const oldRows = modelTable(model).rows;
          const newRows = expected.rows;
          before.forEach((line, index) => {
            if (index === 1) return;
            const row = index === 0 ? 0 : index - 1;
            // A moved column carries its padding: a line it passes through
            // changes even where the cells read the same.
            const moved = command === "moveColumn" && (oldRows[row]?.length ?? 0) > Math.min(args[0] ?? 0, args[1] ?? 0);
            if (!moved && JSON.stringify(oldRows[row]) === JSON.stringify(newRows[row])) expect(lines[index], context).toBe(line);
          });
          if (command !== "insertColumn" && command !== "deleteColumn" && command !== "duplicateColumn" && command !== "moveColumn" && command !== "align") {
            expect(lines[1], context).toBe(before[1]);
          }
        }
        // Every change stays inside one line, but for the commands of rows.
        if (!movesLines) {
          for (const change of changes) expect(text.slice(change.from, change.to).includes("\n"), context).toBe(false);
        }
        text = after;
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe("visible text for the layout (Л9.10)", () => {
  it("reads the visible text of a cell's source by style", () => {
    expect(cellTextRuns("**Жирный** и `код` [ссылка](https://e.com)<br>вторая \\| строка")).toEqual([
      [
        { text: "Жирный", style: "strong" },
        { text: " и ", style: "normal" },
        { text: "код", style: "code" },
        { text: " ", style: "normal" },
        { text: "ссылка", style: "normal" },
      ],
      [{ text: "вторая | строка", style: "normal" }],
    ]);
    expect(cellTextRuns("[[Заметка|Подпись]] ![[Пример]] &amp; <kbd>K</kbd>")).toEqual([[
      { text: "Подпись", style: "normal" },
      { text: " ", style: "normal" },
      { text: "Пример", style: "normal" },
      { text: " ", style: "normal" },
      { text: "&", style: "normal" },
      { text: " ", style: "normal" },
      { text: "K", style: "normal" },
    ]]);
  });

  it("gives every column its header and its body, missing cells empty", () => {
    const columns = tableColumnText(parsed("| a | b |\n|---|---|\n| 1 |"));
    expect(columns[1]?.body).toEqual([[[]]]);
    expect(columns[0]?.header).toEqual([[{ text: "a", style: "normal" }]]);
  });
});
