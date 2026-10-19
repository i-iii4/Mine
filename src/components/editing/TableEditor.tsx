// A table of the note's top level in the editor (SPEC_EDITING.md, Л9): drawn
// by the reading pipeline's own `ArticleTable` from its source, as when
// reading (Л9.4), with its cells told apart. A press on a cell opens the
// table editor there, the caret at the sign under the pointer (Л9.4, Л9.5);
// the active cell holds its own small CodeMirror view showing the cell's
// source, whose every edit is a transaction of the main document
// (`tableEditor.ts`); a drag over a cell's border, ⇧-click and ⇧↑ ⇧↓ make a
// range of cells that copies, cuts, clears and takes a paste (Л9.7). While
// the table is active its widths are frozen (Л9.10) and the rest of the
// table is drawn from the text it had when the active cell or the structure
// last changed, so typing in a cell draws nothing else again (Л9.12). A
// table of many rows draws the rows in view and a stand-in height for the
// others (Л9.12).
//
// The active cell, the range and the chosen block carry attributes only
// (`data-table-cell-active`, `data-table-range`): how they look waits for
// the user's decision ЛВ7 (в), (г).

import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent as ReactClipboardEvent,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { Components, ExtraProps } from "react-markdown";
import type { Element as HastElement } from "hast";
import { writeHtml } from "@tauri-apps/plugin-clipboard-manager";
import type { EditorView } from "@codemirror/view";
import { ArticleTable } from "@/components/reading/ArticleTable";
import { marqueeAutoScrollVelocity } from "@/components/grid/interaction";
import { logFailure } from "@/lib/appLog";
import { offerEditorTableMenu, withdrawEditorTableMenu } from "@/lib/editorTableMenu";
import type { HostedWidget } from "@/lib/editing/livePreview";
import { noteInteractionIntent, type NoteInteractionIntent } from "@/lib/reading/intents";
import { decodeCell, shownOffsetOfRendered } from "@/lib/editing/tableCell";
import {
  activeTable,
  cancelRange,
  clearRange,
  deactivateTable,
  enterTableCell,
  extendRange,
  extendRangeBy,
  moveToCell,
  openCellEditor,
  pasteIntoRange,
  rangeCells,
  runTableCommand,
  subscribeTable,
  tableMenuCommands,
  tableTextAt,
  topLevelTableAt,
  typeOverRange,
  type ActiveTable,
  type CellCaret,
  type TableCommandId,
} from "@/lib/editing/tableEditor";
import { cellSource, rowCount, tableColumnText, tableModel, type TableCellRef } from "@/lib/editing/tableModel";
import { clipboardCells, inRect, rangeAsHtml, rangeAsText, rangeRect, type CellRect } from "@/lib/editing/tableSelection";

/** A table with more body rows than this draws the rows in view and around
 *  them only (Л9.12). */
export const TABLE_WINDOW_MIN_ROWS = 200;
/** Rows drawn past each edge of the view. */
export const TABLE_WINDOW_OVERSCAN_ROWS = 40;
/** The log line of a copy of cells that did not reach the clipboard. */
export const TABLE_COPY_FAILED_TITLE = "Could not copy the cells";

/** Where an element's controls keep their own presses: a link in a drawn
 *  cell opens as a drawn link does (Л9.4, Л10.1). */
const CELL_CONTROLS = "a, button, summary, input, label, [role='checkbox']";
/** Presses there leave the active table as it is: the menus, and the
 *  buttons that open them (the open card's `…`, Л9.8). */
const KEEPS_TABLE = "[role='menu'], [role='menuitem'], [aria-haspopup='menu']";

type HostedBlock = Extract<HostedWidget, { type: "block" }>;

/** The active table of `view`, followed. */
function useActiveTable(view: EditorView): ActiveTable | null {
  const subscribe = useCallback((listener: () => void) => subscribeTable(view, () => listener()), [view]);
  return useSyncExternalStore(subscribe, () => activeTable(view.state), () => null);
}

/** What the elements of a drawn table read. */
interface TableViewState {
  view: EditorView;
  /** The logical row of each line of the drawn source past the delimiter
   *  row: the header is row 0. */
  rowOfLine: readonly number[];
  /** The active cell, when its editor is open. */
  editing: ActiveTable | null;
  range: CellRect | null;
  freezeKey: number | null;
  columns: ReturnType<typeof tableColumnText> | null;
  scrollRef: (element: HTMLDivElement | null) => void;
  /** Rows not drawn before and between the drawn ones, and after the last:
   *  their stand-in heights. */
  gapBefore: (row: number) => number;
  gapAfter: number;
  columnCount: number;
}

const TableViewContext = createContext<TableViewState | null>(null);
const TableRowContext = createContext<{ row: number; cells: readonly HastElement[] } | null>(null);

function TableElement({ node, ...props }: ComponentProps<"table"> & ExtraProps) {
  const state = useContext(TableViewContext);
  return (
    <ArticleTable
      {...props}
      node={node}
      freezeKey={state?.freezeKey ?? null}
      columns={state?.columns ?? null}
      scrollRef={state?.scrollRef}
    />
  );
}

function TableBody({ node: _node, children, ...props }: ComponentProps<"tbody"> & ExtraProps) {
  const state = useContext(TableViewContext);
  if (!state) return <tbody {...props}>{children}</tbody>;
  const rows: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ node?: HastElement }>(child)) {
      rows.push(child);
      return;
    }
    const line = child.props.node?.position?.start.line;
    const row = line === undefined ? null : state.rowOfLine[line - 1];
    const gap = row === null || row === undefined ? 0 : state.gapBefore(row);
    if (gap > 0) rows.push(<Spacer key={`gap-${row}`} height={gap} columns={state.columnCount} />);
    rows.push(child);
  });
  if (state.gapAfter > 0) rows.push(<Spacer key="gap-end" height={state.gapAfter} columns={state.columnCount} />);
  return <tbody {...props}>{rows}</tbody>;
}

/** The stand-in of rows not drawn (Л9.12). */
function Spacer({ height, columns }: { height: number; columns: number }) {
  return (
    <tr aria-hidden="true" data-table-spacer="">
      <td colSpan={columns} style={{ height, padding: 0 }} />
    </tr>
  );
}

function TableRow({ node, children, ...props }: ComponentProps<"tr"> & ExtraProps) {
  const state = useContext(TableViewContext);
  const line = node?.position?.start.line;
  const row = line === undefined ? undefined : state?.rowOfLine[line - 1];
  const cells = useMemo(() => (node ? node.children.filter((child): child is HastElement => child.type === "element") : []), [node]);
  const value = useMemo(() => (row === undefined ? null : { row, cells }), [cells, row]);
  return (
    <TableRowContext.Provider value={value}>
      <tr {...props} data-table-line-row={row}>{children}</tr>
    </TableRowContext.Provider>
  );
}

function TableCell({ node, children, ...props }: ComponentProps<"td"> & ExtraProps) {
  const state = useContext(TableViewContext);
  const row = useContext(TableRowContext);
  const Tag = node?.tagName === "th" ? "th" : "td";
  const col = row && node ? row.cells.indexOf(node) : -1;
  if (!state || !row || col < 0) return <Tag {...props}>{children}</Tag>;
  const ref = { row: row.row, col };
  const editing = state.editing?.owner.kind === "cell" && state.editing.owner.cell.row === ref.row && state.editing.owner.cell.col === col
    ? state.editing
    : null;
  return (
    <Tag
      {...props}
      data-table-row={ref.row}
      data-table-col={col}
      data-table-cell-active={editing ? "" : undefined}
      data-table-range={state.range && inRect(state.range, ref) ? "" : undefined}
    >
      {editing ? <CellEditor key={editing.generation} main={state.view} /> : children}
    </Tag>
  );
}

/** The elements the editor draws a table with, one object for every table. */
const TABLE_COMPONENTS: Components = {
  table: TableElement,
  tbody: TableBody,
  tr: TableRow,
  td: TableCell,
  th: TableCell,
};

/**
 * The editor of the active cell (Л9.5): its own CodeMirror view, made by
 * `openCellEditor`, showing the cell's source; every edit goes to the main
 * document.
 */
function CellEditor({ main }: { main: EditorView }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const parent = hostRef.current;
    return parent ? openCellEditor(main, parent) : undefined;
  }, [main]);
  return <div ref={hostRef} data-table-cell-host="" />;
}

/**
 * The table editor carries out what a press on a cell means (Л9.4, Л11.1):
 * the cell's editor. Every intent is handled; those a cell has no part in
 * say why.
 */
function carryOutCellIntent(intent: NoteInteractionIntent, enterCell: () => void): boolean {
  switch (intent.kind) {
    case "EnterTableCell":
      enterCell();
      return true;
    // A cell's links and boxes act inside it as drawn ones do; a cell is no
    // block to choose or reveal, and the caret it takes is its editor's.
    case "OpenNote":
    case "OpenExternal":
    case "JumpToAnchor":
    case "ToggleTask":
    case "OpenImagePreview":
    case "OpenEmbed":
    case "SelectBlock":
    case "RevealBlock":
    case "PlaceCaret":
    case "Nothing":
      return false;
    default: {
      const unhandled: never = intent;
      return unhandled;
    }
  }
}

/** The nearest box that scrolls `element` up and down: the open card's
 *  scroll, or the page. */
function verticalScroller(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/** The cell an element stands in, inside `dom`. */
function cellOf(dom: HTMLElement, target: EventTarget | null): { element: HTMLElement; ref: TableCellRef } | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>("[data-table-row][data-table-col]");
  if (!element || !dom.contains(element)) return null;
  return { element, ref: { row: Number(element.dataset.tableRow), col: Number(element.dataset.tableCol) } };
}

/** The offset of the drawn text of `cell` under the point, if the page can
 *  tell it. */
function renderedOffsetAt(cell: HTMLElement, x: number, y: number): number | null {
  const documentWithCaret = cell.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const range = documentWithCaret.caretRangeFromPoint?.(x, y);
  if (range) {
    node = range.startContainer;
    offset = range.startOffset;
  } else {
    const position = documentWithCaret.caretPositionFromPoint?.(x, y);
    if (position) {
      node = position.offsetNode;
      offset = position.offset;
    }
  }
  if (!node || !cell.contains(node)) return null;
  const before = cell.ownerDocument.createRange();
  before.setStart(cell, 0);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** The commands the open card's `Table` menu offers for an active table:
 *  offered again when its owner or structure changes, not on every key
 *  typed in a cell. */
function useTableMenu(view: EditorView, active: ActiveTable | null, slug: string | null) {
  const offered = active && active.owner.kind !== "idle" ? active.generation : null;
  useEffect(() => {
    if (!slug) return undefined;
    if (offered === null) {
      withdrawEditorTableMenu(slug);
      return undefined;
    }
    offerEditorTableMenu({
      slug,
      commands: tableMenuCommands(view.state),
      run: (id) => {
        // The menu names the commands `tableMenuCommands` gave it.
        runTableCommand(view, id as TableCommandId);
      },
    });
    return undefined;
  }, [offered, slug, view]);
  useEffect(() => () => {
    if (slug) withdrawEditorTableMenu(slug);
  }, [slug]);
}

/** The stand-in height of a row not drawn: the drawn body rows' mean, the
 *  row of one line (`--spacing-row`) before any is drawn. */
function rowHeightOf(table: HTMLElement | null): number {
  const rows = table ? [...table.querySelectorAll<HTMLElement>("tbody tr[data-table-line-row]")] : [];
  const heights = rows.map((row) => row.getBoundingClientRect().height).filter((height) => height > 0);
  if (heights.length > 0) return heights.reduce((sum, height) => sum + height, 0) / heights.length;
  const token = table ? Number.parseFloat(getComputedStyle(table).getPropertyValue("--spacing-row")) : Number.NaN;
  return Number.isFinite(token) && token > 0 ? token : 0;
}

export interface TableBlockViewProps {
  view: EditorView;
  dom: HTMLElement;
  widget: HostedBlock;
  /** The card the note is of, for the `Table` menu (Л9.8). */
  sourceSlug: string | null;
  /** Draws a table's source as the widget's article does, with the table's
   *  own elements; `toDocument` maps an offset of the source to the
   *  document. */
  renderArticle(text: string, toDocument: (offset: number) => number | null, components: Components): ReactNode;
}

/** A table of the note's top level in the editor (Л9). */
export function TableBlockView({ view, dom, widget, sourceSlug, renderArticle }: TableBlockViewProps) {
  const active = useActiveTable(view);
  const from = dom.isConnected ? view.posAtDOM(dom) : -1;
  const mine = active !== null && active.from === from ? active : null;
  const sourceKey = mine ? `active:${mine.generation}` : `idle:${widget.source}`;
  // The active table draws the text it had when its owner or structure last
  // changed; typing in a cell draws nothing else (Л9.12). `sourceKey` says
  // when the text is read again.
  const text = useMemo(() => (mine ? tableTextAt(view.state, mine.from, mine.to) : widget.source), [sourceKey]);
  const model = useMemo(() => tableModel(text), [text]);
  const bodyRows = model ? rowCount(model) - 1 : 0;
  const windowed = bodyRows > TABLE_WINDOW_MIN_ROWS;
  const [span, setSpan] = useState({ start: 0, end: TABLE_WINDOW_OVERSCAN_ROWS * 2 });
  const [rowHeight, setRowHeight] = useState(0);
  const scrollBlock = useRef<HTMLDivElement | null>(null);
  const scrollRef = useCallback((element: HTMLDivElement | null) => {
    scrollBlock.current = element;
  }, []);
  const editingRow = mine?.owner.kind === "cell" ? mine.owner.cell.row : null;
  const owner = mine?.owner ?? null;
  const range = useMemo(() => (owner?.kind === "range" ? rangeRect(owner.anchor, owner.head) : null), [owner]);

  // The body rows drawn: all of them, or the window and the active cell's.
  const drawnRows = useMemo(() => {
    const rows: number[] = [];
    const start = windowed ? Math.max(0, span.start) : 0;
    const end = windowed ? Math.min(bodyRows, span.end) : bodyRows;
    for (let index = start; index < end; index += 1) rows.push(index + 1);
    if (editingRow !== null && editingRow > 0 && !rows.includes(editingRow)) {
      rows.push(editingRow);
      rows.sort((left, right) => left - right);
    }
    return rows;
  }, [bodyRows, editingRow, span.end, span.start, windowed]);

  // The drawn source: the table's lines, or its header, delimiter row and
  // drawn rows; with where each drawn line starts and the table's line it
  // is.
  const drawn = useMemo(() => {
    const lines = text.split("\n");
    const starts: number[] = [];
    let offset = 0;
    for (const line of lines) {
      starts.push(offset);
      offset += line.length + 1;
    }
    const lineOf = windowed ? [0, 1, ...drawnRows.map((row) => row + 1)] : lines.map((_, index) => index);
    const drawnStarts: number[] = [];
    let drawnOffset = 0;
    for (const index of lineOf) {
      drawnStarts.push(drawnOffset);
      drawnOffset += (lines[index] ?? "").length + 1;
    }
    return {
      text: windowed ? lineOf.map((index) => lines[index] ?? "").join("\n") : text,
      rowOfLine: windowed ? [0, -1, ...drawnRows] : [0, -1, ...lines.slice(2).map((_, index) => index + 1)],
      lineOf,
      starts,
      drawnStarts,
    };
  }, [drawnRows, text, windowed]);

  const toDocument = useCallback((offset: number) => {
    if (!dom.isConnected) return null;
    const tableFrom = view.posAtDOM(dom);
    let line = drawn.drawnStarts.length - 1;
    while (line > 0 && (drawn.drawnStarts[line] ?? 0) > offset) line -= 1;
    const source = drawn.lineOf[line] ?? 0;
    return tableFrom + (drawn.starts[source] ?? 0) + offset - (drawn.drawnStarts[line] ?? 0);
  }, [dom, drawn, view]);

  // Widths over every row of a table drawn in part (Л9.10).
  const columns = useMemo(() => (windowed && model ? tableColumnText(model) : null), [model, windowed]);

  const state = useMemo<TableViewState>(() => {
    const drawnSet = new Set(drawnRows);
    const gapBefore = (row: number) => {
      if (!windowed || row <= 0) return 0;
      let missing = 0;
      for (let previous = row - 1; previous >= 1 && !drawnSet.has(previous); previous -= 1) missing += 1;
      return missing * rowHeight;
    };
    const last = drawnRows[drawnRows.length - 1] ?? 0;
    return {
      view,
      rowOfLine: drawn.rowOfLine,
      editing: mine?.owner.kind === "cell" ? mine : null,
      range,
      freezeKey: mine ? mine.layout : null,
      columns,
      scrollRef,
      gapBefore,
      gapAfter: windowed ? Math.max(0, bodyRows - last) * rowHeight : 0,
      columnCount: model?.columns ?? 1,
    };
  }, [bodyRows, columns, drawn.rowOfLine, drawnRows, mine, model?.columns, range, rowHeight, scrollRef, view, windowed]);

  const article = useMemo(() => renderArticle(drawn.text, toDocument, TABLE_COMPONENTS), [drawn.text, renderArticle, toDocument]);

  // The rows in view of a long table, and the stand-in height of the rest.
  useEffect(() => {
    if (!windowed) return undefined;
    const scroller = verticalScroller(dom);
    let frame = 0;
    const measure = () => {
      frame = 0;
      const table = dom.querySelector<HTMLElement>("table");
      const body = table?.querySelector("tbody");
      const height = rowHeightOf(table);
      if (height > 0) setRowHeight((current) => (Math.abs(current - height) < 0.5 ? current : height));
      if (!body || height <= 0) return;
      const top = body.getBoundingClientRect().top;
      const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const viewBottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
      const first = Math.floor((viewTop - top) / height);
      const last = Math.ceil((viewBottom - top) / height);
      setSpan((current) => {
        const inside = first >= current.start && last <= current.end;
        if (inside && first - current.start < TABLE_WINDOW_OVERSCAN_ROWS * 2 && current.end - last < TABLE_WINDOW_OVERSCAN_ROWS * 2) return current;
        return { start: Math.max(0, first - TABLE_WINDOW_OVERSCAN_ROWS), end: Math.min(bodyRows, last + TABLE_WINDOW_OVERSCAN_ROWS) };
      });
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    (scroller ?? window).addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      (scroller ?? window).removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [bodyRows, dom, windowed]);

  useTableMenu(view, mine, sourceSlug);

  // A press on a cell (Л9.4, Л9.7): its editor with the caret under the
  // pointer; ⇧-press or a drag over a cell's border, a range.
  useEffect(() => {
    let drag: { anchor: TableCellRef; ranging: boolean; x: number; y: number; frame: number; last: number } | null = null;
    const scroller = verticalScroller(dom);
    const hitTest = () => {
      if (!drag) return;
      const over = cellOf(dom, dom.ownerDocument.elementFromPoint(drag.x, drag.y));
      if (!over) return;
      if (over.ref.row === drag.anchor.row && over.ref.col === drag.anchor.col && !drag.ranging) return;
      drag.ranging = true;
      extendRange(view, over.ref);
    };
    const edgeScroll = (time: number) => {
      if (!drag) return;
      const elapsed = drag.last === 0 ? 0 : (time - drag.last) / 1000;
      drag.last = time;
      if (drag.ranging && elapsed > 0) {
        const block = scrollBlock.current;
        if (block) {
          const rect = block.getBoundingClientRect();
          block.scrollLeft += marqueeAutoScrollVelocity(drag.x, rect.left, rect.right) * elapsed;
        }
        const rect = scroller?.getBoundingClientRect();
        const top = rect ? rect.top : 0;
        const bottom = rect ? rect.bottom : window.innerHeight;
        const velocity = marqueeAutoScrollVelocity(drag.y, top, bottom) * elapsed;
        if (scroller) scroller.scrollTop += velocity;
        else window.scrollBy(0, velocity);
        hitTest();
      }
      drag.frame = requestAnimationFrame(edgeScroll);
    };
    const onMove = (event: MouseEvent) => {
      if (!drag) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      hitTest();
    };
    const end = () => {
      if (drag) cancelAnimationFrame(drag.frame);
      drag = null;
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", end, true);
      window.removeEventListener("blur", end);
    };
    const begin = (anchor: TableCellRef, x: number, y: number, ranging: boolean) => {
      end();
      drag = { anchor, ranging, x, y, frame: 0, last: 0 };
      drag.frame = requestAnimationFrame(edgeScroll);
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", end, true);
      window.addEventListener("blur", end);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      const hit = cellOf(dom, target);
      if (!hit) return;
      const inEditor = target instanceof Element && target.closest("[data-table-cell-editor]") !== null;
      if (!inEditor && target instanceof Element && target.closest(CELL_CONTROLS)) return;
      const current = activeTable(view.state);
      const tableFrom = view.posAtDOM(dom);
      const isActive = current !== null && current.from === tableFrom;
      if (inEditor && !event.shiftKey) {
        // The cell's own editor selects its text; leaving the cell makes a
        // range.
        begin(hit.ref, event.clientX, event.clientY, false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey && isActive && current.owner.kind !== "idle") {
        extendRange(view, hit.ref);
        begin(hit.ref, event.clientX, event.clientY, true);
        return;
      }
      const block = topLevelTableAt(view.state, tableFrom);
      if (!block) return;
      // What a press on a cell means is decided with the reading mode's
      // (Л11.1).
      const intent = noteInteractionIntent({ surface: "editing", element: { kind: "table-cell" }, event: "click" });
      if (!carryOutCellIntent(intent, () => {
        const table = tableModel(tableTextAt(view.state, block.from, block.to));
        const shown = table ? decodeCell(cellSource(table, hit.ref)).text : "";
        const rendered = renderedOffsetAt(hit.element, event.clientX, event.clientY);
        const caret: CellCaret = rendered === null
          ? { kind: "end" }
          : { kind: "offset", offset: shownOffsetOfRendered(hit.element.textContent ?? "", shown, rendered) };
        enterTableCell(view, block, hit.ref, caret);
      })) return;
      begin(hit.ref, event.clientX, event.clientY, false);
    };
    dom.addEventListener("mousedown", onMouseDown, true);
    return () => {
      end();
      dom.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [dom, view]);

  // A press outside the active table ends it, but for the menus that act
  // on it (Л9.7, Л9.8).
  const isActive = mine !== null;
  useEffect(() => {
    if (!isActive) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || dom.contains(target)) return;
      if (target instanceof Element && target.closest(KEEPS_TABLE)) return;
      deactivateTable(view);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [dom, isActive, view]);

  return (
    <TableViewContext.Provider value={state}>
      {article}
      {range && <RangeKeys view={view} />}
    </TableViewContext.Provider>
  );
}

/**
 * The keys and the clipboard of a range of cells (Л9.7): a field the page
 * cannot see takes the focus, so the range copies, cuts, takes a paste and
 * typing, and Escape, Backspace, Delete and the arrows reach it. Its text is
 * the range's, selected, so the system's Copy is never empty.
 */
function RangeKeys({ view }: { view: EditorView }) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const text = rangeAsText(rangeCells(view.state));
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.value = text;
    field.focus({ preventScroll: true });
    field.select();
  }, [text]);
  // Typing over the range (Л9.7): the page's own input event, which every
  // way of typing sends.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return undefined;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === "insertFromPaste") return;
      event.preventDefault();
      if (event.inputType === "insertText" && event.data) typeOverRange(view, event.data);
    };
    field.addEventListener("beforeinput", onBeforeInput);
    return () => field.removeEventListener("beforeinput", onBeforeInput);
  }, [view]);
  const copy = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const cells = rangeCells(view.state);
    const plain = rangeAsText(cells);
    const html = rangeAsHtml(cells);
    event.preventDefault();
    event.clipboardData.setData("text/plain", plain);
    event.clipboardData.setData("text/html", html);
    // The system's clipboard, as Mine writes it everywhere (Л9.7).
    void writeHtml(html, plain).catch((error: unknown) => logFailure(TABLE_COPY_FAILED_TITLE, error));
  };
  return (
    <textarea
      ref={fieldRef}
      aria-label="Table cells"
      data-table-range-keys=""
      spellCheck={false}
      style={{ position: "absolute", top: 0, left: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none", resize: "none", overflow: "hidden" }}
      onCopy={copy}
      onCut={(event) => {
        copy(event);
        clearRange(view);
      }}
      onPaste={(event) => {
        event.preventDefault();
        pasteIntoRange(view, clipboardCells(event.clipboardData.getData("text/html") || null, event.clipboardData.getData("text/plain")));
      }}
      onKeyDown={(event) => {
        const handled = rangeKey(view, event.key, event.shiftKey);
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    />
  );
}

/** A key pressed while a range owns the table. */
function rangeKey(view: EditorView, key: string, shift: boolean): boolean {
  switch (key) {
    case "Escape":
      return cancelRange(view);
    case "Backspace":
    case "Delete":
      return clearRange(view);
    case "ArrowUp":
      return shift ? extendRangeBy(view, -1, 0) : headCell(view);
    case "ArrowDown":
      return shift ? extendRangeBy(view, 1, 0) : headCell(view);
    case "ArrowLeft":
      return shift ? extendRangeBy(view, 0, -1) : headCell(view);
    case "ArrowRight":
      return shift ? extendRangeBy(view, 0, 1) : headCell(view);
    default:
      return false;
  }
}

/** An arrow without ⇧ in a range: the range's head cell takes the caret. */
function headCell(view: EditorView): boolean {
  const active = activeTable(view.state);
  if (active?.owner.kind !== "range") return false;
  return moveToCell(view, active.owner.head, { kind: "end" });
}
