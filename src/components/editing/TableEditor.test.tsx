import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { writeHtml } from "@tauri-apps/plugin-clipboard-manager";
import { beginNoteEdit, saveNoteBody } from "@/lib/commands";
import { NoteEmbedLookups } from "@/components/reading/NoteEmbed";
import { editorTableMenu } from "@/lib/editorTableMenu";
import { activeTable } from "@/lib/editing/tableEditor";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { NoteEditor } from "./NoteEditor";
import { TABLE_WINDOW_MIN_ROWS } from "./TableEditor";

vi.mock("@/lib/commands", () => ({
  beginNoteEdit: vi.fn(),
  endNoteEdit: vi.fn(async () => undefined),
  noteBodyState: vi.fn(),
  reportEditsFlushed: vi.fn(async () => undefined),
  reportNoteEdits: vi.fn(async () => undefined),
  reportFocusedEditor: vi.fn(async () => undefined),
  saveNoteBody: vi.fn(() => new Promise(() => undefined)),
  getBlock: vi.fn(async () => null),
  resolveNoteLink: vi.fn(async () => null),
  toggleTaskItem: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeHtml: vi.fn(async () => undefined),
  writeText: vi.fn(async () => undefined),
}));

const SLUG = "Cards/Tables";

const TABLE = [
  "| Ключ | Значение |",
  "|:---|---:|",
  "| **жирный** x | 1 |",
  "| b | 2 |",
].join("\n");

const BODY = `Intro.\n\n${TABLE}\n\nEnd.`;

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

beforeEach(() => {
  vi.mocked(saveNoteBody).mockClear();
  vi.mocked(writeHtml).mockClear();
});

afterEach(() => {
  Reflect.deleteProperty(document, "caretRangeFromPoint");
});

function TestImage({ src, alt }: ComponentProps<"img"> & ExtraProps) {
  return <img data-test-image="" src={src} alt={alt} />;
}

async function renderEditor(body = BODY) {
  vi.mocked(beginNoteEdit).mockResolvedValue(indexedBlock({ slug: SLUG, body, body_hash: "hash-0" }));
  const result = render(
    <NoteEditor
      slug={SLUG}
      body={body}
      bodyHash="hash-0"
      fileName="Tables.md"
      vaultPath="/vault"
      thumbsRootPath="/thumbs"
      noteEmbeds={new NoteEmbedLookups(SLUG)}
      image={TestImage}
      onOpenNote={vi.fn()}
      onSaved={vi.fn()}
      omittedEmbed={null}
      fallback={null}
    />,
  );
  const content = await waitFor(() => {
    const found = result.container.querySelector<HTMLElement>(".cm-content");
    if (!found) throw new Error("no editor yet");
    return found;
  });
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("no view");
  await waitFor(() => expect(result.container.querySelector("[data-table-row='1'][data-table-col='0']")).not.toBeNull());
  return { ...result, view };
}

function cell(container: HTMLElement, row: number, col: number): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-table-row='${row}'][data-table-col='${col}']`);
  if (!found) throw new Error(`no cell ${row}, ${col}`);
  return found;
}

async function cellEditor(container: HTMLElement, row: number, col: number): Promise<EditorView> {
  const content = await waitFor(() => {
    const found = cell(container, row, col).querySelector<HTMLElement>("[data-table-cell-editor] .cm-content");
    if (!found) throw new Error("no cell editor yet");
    return found;
  });
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("no cell view");
  return view;
}

function lastSavedBody(): string {
  const calls = vi.mocked(saveNoteBody).mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("nothing saved");
  return last[0].body;
}

describe("the table in the editor (SPEC_EDITING.md, Л9)", () => {
  it("a press on a cell opens its editor with the caret at the sign under the pointer", async () => {
    const { container, view } = await renderEditor();
    const drawn = cell(container, 1, 0);
    const bold = drawn.querySelector("strong")?.firstChild;
    if (!bold) throw new Error("no drawn bold text");
    // The page tells the place under the pointer: after «жир».
    Object.defineProperty(document, "caretRangeFromPoint", {
      configurable: true,
      value: () => {
        const range = document.createRange();
        range.setStart(bold, 3);
        return range;
      },
    });
    fireEvent.mouseDown(drawn, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseUp(window);
    const editor = await cellEditor(container, 1, 0);
    expect(editor.state.doc.toString()).toBe("**жирный** x");
    expect(editor.state.selection.main.head).toBe("**жир".length);
    expect(editor.contentDOM.getAttribute("aria-label")).toBe("Row 2, column 1");
    expect(cell(container, 1, 0).hasAttribute("data-table-cell-active")).toBe(true);
    // The main editor's caret stands at the table's start, where it draws
    // nothing.
    expect(view.state.selection.main.head).toBe(BODY.indexOf("|"));
  });

  it("typing in the cell writes only its bytes, Tab goes on, Escape leaves", async () => {
    const { container, view } = await renderEditor();
    fireEvent.mouseDown(cell(container, 2, 1), { button: 0 });
    fireEvent.mouseUp(window);
    let editor = await cellEditor(container, 2, 1);
    act(() => {
      editor.dispatch(editor.state.replaceSelection("0"), { userEvent: "input.type" });
    });
    await waitFor(() => expect(saveNoteBody).toHaveBeenCalled());
    expect(lastSavedBody()).toBe(BODY.replace("| b | 2 |", "| b | 20 |"));
    act(() => {
      runScopeHandlers(editor, new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }), "editor");
    });
    editor = await cellEditor(container, 2, 0);
    expect(editor.state.doc.toString()).toBe("b");
    act(() => {
      runScopeHandlers(editor, new KeyboardEvent("keydown", { key: "Escape" }), "editor");
    });
    await waitFor(() => expect(container.querySelector("[data-table-cell-editor]")).toBeNull());
    expect(activeTable(view.state)).toBeNull();
  });

  it("⇧-press makes a range; it copies as text and as an HTML table, takes a paste and typing", async () => {
    const { container, view } = await renderEditor();
    fireEvent.mouseDown(cell(container, 1, 0), { button: 0 });
    fireEvent.mouseUp(window);
    await cellEditor(container, 1, 0);
    fireEvent.mouseDown(cell(container, 2, 1), { button: 0, shiftKey: true });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(container.querySelectorAll("[data-table-range]")).toHaveLength(4));
    expect(container.querySelector("[data-table-cell-editor]")).toBeNull();
    const field = container.querySelector<HTMLTextAreaElement>("[data-table-range-keys]");
    if (!field) throw new Error("no range field");
    expect(document.activeElement).toBe(field);
    const written: Record<string, string> = {};
    const clipboardData = { setData: (type: string, value: string) => { written[type] = value; }, getData: () => "" };
    fireEvent.copy(field, { clipboardData });
    expect(written["text/plain"]).toBe("**жирный** x\t1\nb\t2");
    expect(written["text/html"]).toBe("<table><tbody><tr><td>**жирный** x</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>");
    expect(writeHtml).toHaveBeenCalledWith(written["text/html"], written["text/plain"]);
    fireEvent.paste(field, {
      clipboardData: { getData: (type: string) => (type === "text/html" ? "<table><tr><td>x<br>y</td><td>|</td></tr></table>" : "x y\t|") },
    });
    await waitFor(() => expect(lastSavedBody()).toContain("| x<br>y | \\| |"));
    const input = new InputEvent("beforeinput", { inputType: "insertText", data: "z", cancelable: true, bubbles: true });
    act(() => {
      field.dispatchEvent(input);
    });
    expect(activeTable(view.state)?.owner).toEqual({ kind: "cell", cell: { row: 1, col: 0 } });
    expect(view.state.doc.toString()).toContain("| z |  |\n|  |  |");
  });

  it("offers its row's and column's commands to the open card's Table menu and runs them", async () => {
    const { container } = await renderEditor();
    fireEvent.mouseDown(cell(container, 1, 0), { button: 0 });
    fireEvent.mouseUp(window);
    await cellEditor(container, 1, 0);
    const menu = editorTableMenu();
    expect(menu?.slug).toBe(SLUG);
    expect(menu?.commands.map((command) => command.label)).toContain("Insert Row Below");
    act(() => {
      menu?.run("insert-row-below");
    });
    await waitFor(() => expect(lastSavedBody()).toBe(BODY.replace("| **жирный** x | 1 |\n", "| **жирный** x | 1 |\n| | |\n")));
    // The new row's cell takes the caret.
    await cellEditor(container, 2, 0);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(container.querySelector("[data-table-cell-editor]")).toBeNull());
    expect(editorTableMenu()).toBeNull();
  });

  it("a table of many rows draws a window of them (Л9.12)", async () => {
    const rows = Array.from({ length: TABLE_WINDOW_MIN_ROWS + 100 }, (_, index) => `| ${index} | ячейка |`);
    const body = `| № | Текст |\n|---|---|\n${rows.join("\n")}`;
    const { container } = await renderEditor(body);
    const drawn = container.querySelectorAll("tbody tr[data-table-line-row]");
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(rows.length);
  });
});
