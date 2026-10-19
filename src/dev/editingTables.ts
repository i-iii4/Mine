// The table cases of the editing page, `/__editing` (SPEC_EDITING.md, Л9,
// Л17): the bodies of `?body=tables`, `tables-crlf`, `large-table` and
// `wide-table`, and the handle the browser check of row 50.29 drives the
// table editor by: its state, its commands (the structure has no visible
// controls until the decision ЛВ7), the text of the active cell. Dev only.

import { EditorView } from "@codemirror/view";
import { activeCellText, activeTable, rangeCells, runTableCommand, tableMenuCommands, type TableCommandId } from "@/lib/editing/tableEditor";
import tables from "../../scripts/fixtures/editing-tables.md?raw";

/** Rows of the long table: past the window's threshold (Л9.12, Л14.2). */
const LARGE_TABLE_ROWS = 5000;
/** Columns of the wide table (Л14.2). */
const WIDE_TABLE_COLUMNS = 30;

function generatedTable(rows: number, columns: number): string {
  const header = `| ${Array.from({ length: columns }, (_, index) => `Столбец ${index + 1}`).join(" | ")} |`;
  const delimiter = `|${Array.from({ length: columns }, () => "---").join("|")}|`;
  const body = Array.from({ length: rows }, (_, row) => (
    `| ${Array.from({ length: columns }, (_, col) => (col === 0 ? String(row + 1) : `ячейка ${row + 1}.${col + 1}`)).join(" | ")} |`
  ));
  return [header, delimiter, ...body].join("\n");
}

/** The body of a table case of `?body=`, or `null` for another variant. */
export function tableCaseBody(variant: string | null): string | null {
  const body = tables.replace(/^---\n[\s\S]*?\n---\n/, "");
  switch (variant) {
    case "tables":
      return body;
    case "tables-crlf":
      return body.replace(/\n/g, "\r\n");
    case "large-table":
      return `# Длинная таблица\n\nАбзац перед таблицей.\n\n${generatedTable(LARGE_TABLE_ROWS, 5)}\n\nАбзац после таблицы.\n`;
    case "wide-table":
      return `# Широкая таблица\n\nАбзац перед таблицей.\n\n${generatedTable(20, WIDE_TABLE_COLUMNS)}\n\nАбзац после таблицы.\n`;
    default:
      return null;
  }
}

/** The note's editor: by its root, whose first content is its own, not a
 *  cell editor's inside one of its tables. */
function mainEditor(): EditorView | null {
  const root = document.querySelector<HTMLElement>(".mine-note-editor");
  return root ? EditorView.findFromDOM(root) : null;
}

/** What the browser check reads and drives of the table editor. */
export interface EditingTableHandle {
  /** The active table: its place in the document and its owner. */
  active(): { from: number; to: number; owner: unknown } | null;
  /** What the active cell shows. */
  cellText(): string;
  /** What the cells of the range show, row by row. */
  rangeCells(): string[][];
  /** The commands the open card's `Table` menu offers now. */
  menu(): string[];
  /** Run a command of the active table, as its menu does. */
  command(id: string): boolean;
}

/** The handle of `window.__editing.table`. */
export function editingTableHandle(): EditingTableHandle {
  return {
    active() {
      const view = mainEditor();
      const active = view ? activeTable(view.state) : null;
      return active ? { from: active.from, to: active.to, owner: active.owner } : null;
    },
    cellText() {
      const view = mainEditor();
      return view ? activeCellText(view.state) : "";
    },
    rangeCells() {
      const view = mainEditor();
      return view ? rangeCells(view.state) : [];
    },
    menu() {
      const view = mainEditor();
      return view ? tableMenuCommands(view.state).map((command) => command.id) : [];
    },
    command(id) {
      const view = mainEditor();
      // The check names the commands as the menu does (`tableMenuCommands`).
      return view ? runTableCommand(view, id as TableCommandId) : false;
    },
  };
}
