import { describe, expect, it } from "vitest";
import { parseReadingSyntax } from "@/lib/reading/syntax";
import { parseTable, rowCount } from "@/lib/editing/tableModel";
import { editingTableHandle, tableCaseBody } from "./editingTables";
import fixture from "../../scripts/fixtures/editing-tables.md?raw";

/** The tables of a body as the reading mode finds them, by their source. */
function readingTables(body: string): string[] {
  const tree = parseReadingSyntax(body);
  const found: string[] = [];
  const visit = (node: { type: string; children?: unknown[]; position?: { start: { offset?: number }; end: { offset?: number } } }) => {
    if (node.type === "table") found.push(body.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0));
    for (const child of node.children ?? []) visit(child as typeof node);
  };
  visit(tree);
  return found;
}

describe("the table cases of the editing page (SPEC_EDITING.md, Л9, Л17)", () => {
  it("gives every case a body whose tables the table model reads", () => {
    // The reading parser is slow on the long table in jsdom: the long one is
    // checked by its lines below.
    for (const variant of ["tables", "tables-crlf", "wide-table"]) {
      const body = tableCaseBody(variant);
      expect(body, variant).not.toBeNull();
      const tables = readingTables((body ?? "").replace(/\r\n/g, "\n"));
      expect(tables.length, variant).toBeGreaterThan(0);
      for (const table of tables) expect(parseTable(table.replace(/^ +/gm, "")), table).not.toBeNull();
    }
    expect(tableCaseBody("crlf")).toBeNull();
    // The table fixture is the note after its front matter.
    expect(tableCaseBody("tables")).toBe(fixture.replace(/^---\n[\s\S]*?\n---\n/, ""));
  });

  it("holds the cases the browser check needs: ragged rows, escaped pipes, a wide and a long table", () => {
    const tables = readingTables(tableCaseBody("tables") ?? "");
    expect(tables.some((table) => table.includes("\\|"))).toBe(true);
    expect(tables.some((table) => table.includes("| 1 | 2 | 3 | лишняя |"))).toBe(true);
    expect(tables.some((table) => table.split("\n")[0]?.split("|").length === 17)).toBe(true);
    const longLines = (tableCaseBody("large-table") ?? "").split("\n").filter((line) => line.startsWith("|"));
    const long = parseTable(longLines.join("\n"));
    expect(long ? rowCount(long) : 0).toBe(5001);
    const wide = parseTable(readingTables(tableCaseBody("wide-table") ?? "")[0] ?? "");
    expect(wide?.columns).toBe(30);
  });

  it("answers nothing while no editor is on the page", async () => {
    const handle = editingTableHandle();
    expect(await handle.active()).toBeNull();
    expect(await handle.cellText()).toBe("");
    expect(await handle.rangeCells()).toEqual([]);
    expect(await handle.menu()).toEqual([]);
    expect(await handle.command("insert-row-below")).toBe(false);
  });
});
