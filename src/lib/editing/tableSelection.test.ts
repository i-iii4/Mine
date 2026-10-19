import { describe, expect, it } from "vitest";
import {
  clampCell,
  clearWrites,
  clipboardCells,
  inRect,
  nextOwner,
  pasteWrites,
  rangeAsHtml,
  rangeAsText,
  rangeRect,
  typeOverWrites,
  type TableOwner,
} from "./tableSelection";

const IDLE: TableOwner = { kind: "idle" };
const CELL: TableOwner = { kind: "cell", cell: { row: 1, col: 1 } };

describe("one owner of an active table (Л9.2)", () => {
  it("a cell's editor and a range are never held together", () => {
    const range = nextOwner(CELL, { type: "extend-range", head: { row: 2, col: 0 } });
    expect(range).toEqual({ kind: "range", anchor: { row: 1, col: 1 }, head: { row: 2, col: 0 } });
    // Editing a cell ends the range.
    expect(nextOwner(range, { type: "edit-cell", cell: { row: 0, col: 0 } })).toEqual({ kind: "cell", cell: { row: 0, col: 0 } });
    // Extending keeps the anchor and moves the head only.
    expect(nextOwner(range, { type: "extend-range", head: { row: 0, col: 1 } })).toEqual({ kind: "range", anchor: { row: 1, col: 1 }, head: { row: 0, col: 1 } });
    expect(nextOwner(IDLE, { type: "extend-range", head: { row: 2, col: 2 } })).toEqual({ kind: "range", anchor: { row: 2, col: 2 }, head: { row: 2, col: 2 } });
  });

  it("a move of a row or column replaces every other owner and leaves cells inert", () => {
    const move = nextOwner(CELL, { type: "start-reorder-row", row: 2 });
    expect(move).toEqual({ kind: "reorder-row", row: 2 });
    expect(nextOwner(move, { type: "edit-cell", cell: { row: 0, col: 0 } })).toBe(move);
    expect(nextOwner(move, { type: "extend-range", head: { row: 0, col: 0 } })).toBe(move);
    // The header row does not move.
    expect(nextOwner(CELL, { type: "start-reorder-row", row: 0 })).toBe(CELL);
  });

  it("a drop chooses the moved row or column at its new place; a cancel leaves nothing", () => {
    const row = nextOwner({ kind: "reorder-row", row: 3 }, { type: "drop", to: 1, rows: 4, columns: 2 });
    expect(row).toEqual({ kind: "range", anchor: { row: 1, col: 0 }, head: { row: 1, col: 1 } });
    const column = nextOwner({ kind: "reorder-column", col: 0 }, { type: "drop", to: 2, rows: 4, columns: 3 });
    expect(column).toEqual({ kind: "range", anchor: { row: 0, col: 2 }, head: { row: 3, col: 2 } });
    expect(nextOwner({ kind: "reorder-column", col: 0 }, { type: "cancel" })).toEqual(IDLE);
  });

  it("a cancel ends a range on its anchor cell's editor", () => {
    const range: TableOwner = { kind: "range", anchor: { row: 2, col: 1 }, head: { row: 0, col: 0 } };
    expect(nextOwner(range, { type: "cancel" })).toEqual({ kind: "cell", cell: { row: 2, col: 1 } });
    expect(nextOwner(CELL, { type: "cancel" })).toBe(CELL);
  });

  it("chooses a whole row or column", () => {
    expect(nextOwner(CELL, { type: "choose-row", row: 2, columns: 3 })).toEqual({ kind: "range", anchor: { row: 2, col: 0 }, head: { row: 2, col: 2 } });
    expect(nextOwner(CELL, { type: "choose-column", col: 1, rows: 3 })).toEqual({ kind: "range", anchor: { row: 0, col: 1 }, head: { row: 2, col: 1 } });
  });
});

describe("the rectangle of a range (Л9.7)", () => {
  it("is the same whichever way it was drawn", () => {
    expect(rangeRect({ row: 3, col: 0 }, { row: 1, col: 2 })).toEqual({ top: 1, left: 0, bottom: 3, right: 2 });
    expect(rangeRect({ row: 1, col: 2 }, { row: 3, col: 0 })).toEqual({ top: 1, left: 0, bottom: 3, right: 2 });
    expect(inRect({ top: 1, left: 0, bottom: 3, right: 2 }, { row: 2, col: 2 })).toBe(true);
    expect(inRect({ top: 1, left: 0, bottom: 3, right: 2 }, { row: 0, col: 2 })).toBe(false);
    expect(clampCell({ row: 9, col: -1 }, 3, 2)).toEqual({ row: 2, col: 0 });
  });
});

describe("the clipboard of a range (Л9.7)", () => {
  const cells = [["a", "b|c"], ["line\none", "<x>"]];

  it("copies as text with tabs and line breaks, a line break in a cell as a space", () => {
    expect(rangeAsText(cells)).toBe("a\tb|c\nline one\t<x>");
  });

  it("copies beside it an HTML table that keeps line breaks in cells", () => {
    expect(rangeAsHtml(cells)).toBe("<table><tbody><tr><td>a</td><td>b|c</td></tr><tr><td>line<br>one</td><td>&lt;x&gt;</td></tr></tbody></table>");
  });

  it("reads a paste from an HTML table first, its line breaks kept", () => {
    expect(clipboardCells(rangeAsHtml(cells), rangeAsText(cells))).toEqual([["a", "b|c"], ["line\none", "<x>"]]);
    expect(clipboardCells("<meta charset='utf-8'><table><tr><th>H</th></tr><tr><td><p>one</p><p>two</p></td></tr></table>", "")).toEqual([["H"], ["one\ntwo"]]);
  });

  it("reads plain text by lines and tabs otherwise, a final empty line left out", () => {
    expect(clipboardCells(null, "a\tb\r\nc\td\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(clipboardCells("<p>no table</p>", "x")).toEqual([["x"]]);
  });

  it("pastes from the top left cell, cut at the table's edges, encoded as source", () => {
    const writes = pasteWrites({ top: 1, left: 1, bottom: 1, right: 1 }, [["a|b", "c"], ["d\ne", "f"], ["lost"]], 3, 2);
    expect(writes).toEqual([
      { ref: { row: 1, col: 1 }, source: "a\\|b" },
      { ref: { row: 2, col: 1 }, source: "d<br>e" },
    ]);
  });

  it("fills the whole range with a clipboard of one cell", () => {
    expect(pasteWrites({ top: 0, left: 0, bottom: 1, right: 1 }, [["x"]], 3, 3)).toHaveLength(4);
  });

  it("clears a range and types over it into its anchor", () => {
    expect(clearWrites({ top: 1, left: 0, bottom: 1, right: 1 }, 3, 2)).toEqual([
      { ref: { row: 1, col: 0 }, source: "" },
      { ref: { row: 1, col: 1 }, source: "" },
    ]);
    expect(typeOverWrites({ top: 1, left: 0, bottom: 2, right: 0 }, { row: 2, col: 0 }, "|", 3, 1)).toEqual([
      { ref: { row: 1, col: 0 }, source: "" },
      { ref: { row: 2, col: 0 }, source: "\\|" },
    ]);
  });
});
