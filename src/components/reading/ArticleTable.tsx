import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type TableHTMLAttributes } from "react";
import type { Element } from "hast";
import { useHiddenEdges } from "@/hooks/useHiddenEdges";
import { stripFadeMaskStyle } from "@/lib/edgeFade";
import { hastTableColumns } from "@/lib/reading/hast";
import {
  layoutTableColumns,
  measureTableColumns,
  type TableColumnText,
  type TableLayout,
  type TableMeasure,
  type TableRunStyle,
} from "@/lib/reading/tableLayout";

/** Code in a line is set at 12/14 of the text round it (Ч2). */
const INLINE_CODE_SCALE = 12 / 14;
/** Bold text, as Tailwind Typography sets `strong`. */
const STRONG_WEIGHT = "600";

function sameLayout(left: TableLayout | null, right: TableLayout): boolean {
  return left !== null
    && left.width === right.width
    && left.widths.length === right.widths.length
    && left.widths.every((width, index) => width === right.widths[index]);
}

/** How the page sets each style of a cell's text, read from the table and
 *  its first cell, measured on a canvas as the feed measures its cards. */
function pageMeasure(table: HTMLTableElement): (TableMeasure & { outerBorder: number }) | null {
  const cell = table.querySelector<HTMLTableCellElement>("th, td");
  const context = table.ownerDocument.createElement("canvas").getContext("2d");
  if (!cell || !context) return null;
  const style = getComputedStyle(cell);
  const size = Number.parseFloat(style.fontSize);
  const codeFont = getComputedStyle(table).getPropertyValue("--article-code-font").trim() || "monospace";
  const codeStyle = table.querySelector<HTMLElement>(":not(pre) > code");
  const codeInset = codeStyle
    ? Number.parseFloat(getComputedStyle(codeStyle).paddingLeft) + Number.parseFloat(getComputedStyle(codeStyle).paddingRight)
    : 0;
  const fonts: Record<TableRunStyle, string> = {
    normal: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    strong: `${style.fontStyle} ${STRONG_WEIGHT} ${style.fontSize} ${style.fontFamily}`,
    code: `normal 400 ${size * INLINE_CODE_SCALE}px ${codeFont}`,
  };
  context.font = fonts.normal;
  const ch = context.measureText("0").width;
  const padding = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"] as const;
  const cellPadding = Math.ceil(padding.reduce((sum, side) => sum + (Number.parseFloat(style[side]) || 0), 0));
  return {
    ch,
    cellPadding,
    // Collapsed borders: the table is its columns and half its outer line
    // on either side wider.
    outerBorder: Number.parseFloat(style.borderLeftWidth) || 0,
    measure(run) {
      context.font = fonts[run.style];
      const width = context.measureText(run.text).width;
      return run.style === "code" ? width + codeInset : width;
    },
  };
}

/** What the note's editor lends a table it edits (SPEC_EDITING.md, Л9.10,
 *  Л9.12); the reading mode lends none of it. */
export interface ArticleTableEditing {
  /** While set, the widths are measured once for each value and then kept:
   *  they do not follow the table's text, its block or its font until the
   *  value changes or goes. */
  freezeKey?: number | null;
  /** The text of every column, for a table drawn only in part: its widths
   *  stand on all its rows, not on the drawn ones. */
  columns?: TableColumnText[] | null;
  /** The block that scrolls the table sideways. */
  scrollRef?: Ref<HTMLDivElement>;
}

/**
 * A table of the article (SPEC_READING_MODE.md, Ч5): column widths by its
 * content (`tableLayout.ts`), set by a `<colgroup>` at `table-layout:
 * fixed`, laid out again when the column or the article's font changes. It
 * stands at the column's left edge, no wider than its natural width, and a
 * table wider than its budget scrolls sideways inside its own block, the
 * header row with the body; the page never does. The block dissolves the
 * edges that hide columns past them, as the tab bar's strip does
 * (SPEC_SCROLL_EDGE_FADE.md, «Полоса вкладок»): the mask lies on the block,
 * so the table's lines dissolve with its text. The budget is the width of
 * the block it stands in: the column, or the content of a list, quote,
 * callout or footnote (Ч5.4; user's decision of 18.10.2026 on В1: a table
 * stays in the column). A table from HTML with merged cells keeps the
 * browser's own layout in the same block.
 */
export function ArticleTable({
  node,
  children,
  freezeKey = null,
  columns: givenColumns = null,
  scrollRef,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & ArticleTableEditing & { node?: Element; children?: ReactNode }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const columns = useMemo<TableColumnText[] | null>(
    () => givenColumns ?? (node ? hastTableColumns(node) : null),
    [givenColumns, node],
  );
  const [layout, setLayout] = useState<TableLayout | null>(null);
  const { edges, sync } = useHiddenEdges(wrapperRef);
  // The key the widths were measured for while frozen.
  const measuredFor = useRef<number | null>(null);
  const setWrapper = useCallback((element: HTMLDivElement | null) => {
    wrapperRef.current = element;
    if (typeof scrollRef === "function") scrollRef(element);
    else if (scrollRef) scrollRef.current = element;
  }, [scrollRef]);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const table = tableRef.current;
    if (freezeKey !== null && measuredFor.current === freezeKey) return undefined;
    if (!columns || !wrapper || !table) {
      setLayout(null);
      return undefined;
    }
    const lay = () => {
      const measure = pageMeasure(table);
      const budget = measure ? wrapper.clientWidth - measure.outerBorder : 0;
      if (!measure || budget <= 0) return;
      const next = layoutTableColumns(measureTableColumns(columns, measure), budget, measure.ch, measure.cellPadding);
      setLayout((current) => (sameLayout(current, next) ? current : next));
    };
    lay();
    measuredFor.current = freezeKey;
    // Frozen widths follow neither the block nor the font.
    if (freezeKey !== null) return undefined;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(lay);
    resize?.observe(wrapper);
    // The article's font is the page's choice (`data-font-content`).
    const font = new MutationObserver(lay);
    font.observe(table.ownerDocument.documentElement, { attributes: true, attributeFilter: ["data-font-content"] });
    const fonts = table.ownerDocument.fonts;
    fonts?.addEventListener?.("loadingdone", lay);
    return () => {
      resize?.disconnect();
      font.disconnect();
      fonts?.removeEventListener?.("loadingdone", lay);
    };
  }, [columns, freezeKey]);

  return (
    <div
      ref={setWrapper}
      className="my-5 max-w-full overflow-x-auto"
      style={stripFadeMaskStyle(edges)}
      onScroll={sync}
      data-article-table-scroll=""
      data-fade-left={edges.left ? "true" : undefined}
      data-fade-right={edges.right ? "true" : undefined}
    >
      <table
        {...props}
        ref={tableRef}
        style={layout ? { width: layout.width, tableLayout: "fixed" } : undefined}
        data-article-table={layout ? "columns" : "auto"}
        data-article-table-scrolls={layout?.scrolls ? "" : undefined}
      >
        {layout && (
          <colgroup>
            {layout.widths.map((width, index) => (
              <col key={index} style={{ width }} />
            ))}
          </colgroup>
        )}
        {children}
      </table>
    </div>
  );
}
