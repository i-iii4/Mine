// Small readers of the drawn tree (hast) that the article's elements share.

import type { Element, ElementContent, Nodes, RootContent } from "hast";
import type { TableCellLines, TableColumnText, TableRunStyle, TableTextRun } from "./tableLayout";

/** The text of `node` and everything in it, as written. */
export function hastText(node: Nodes | RootContent | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map((child) => hastText(child)).join("");
  return "";
}

/** The classes of an element. */
export function hastClasses(element: Element | undefined): string[] {
  const value = element?.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

/** The element children of `element`, text and comments left out. */
export function hastElements(element: Element | undefined): Element[] {
  return (element?.children ?? []).filter((child): child is Element => child.type === "element");
}

/** The language a code element names by its `language-*` class. */
export function hastCodeLanguage(code: Element | undefined): string | null {
  const language = hastClasses(code).find((name) => name.startsWith("language-"));
  return language ? language.slice("language-".length).toLowerCase() || null : null;
}

/** The single `code` element a `pre` holds, as Markdown's code block makes. */
export function hastCodeOfPre(pre: Element | undefined): Element | null {
  const elements = hastElements(pre);
  const [only] = elements;
  return elements.length === 1 && only?.tagName === "code" ? only : null;
}

const STRONG_TAGS = new Set(["strong", "b"]);

function collectRuns(nodes: readonly ElementContent[], style: TableRunStyle, lines: TableTextRun[][]) {
  for (const node of nodes) {
    if (node.type === "text") {
      const line = lines[lines.length - 1];
      if (line && node.value) line.push({ text: node.value, style });
      continue;
    }
    if (node.type !== "element") continue;
    if (node.tagName === "br") {
      lines.push([]);
      continue;
    }
    if (node.tagName === "img") {
      const alt = node.properties?.alt;
      const line = lines[lines.length - 1];
      if (line && typeof alt === "string" && alt) line.push({ text: alt, style });
      continue;
    }
    const nested: TableRunStyle = node.tagName === "code"
      ? "code"
      : style === "normal" && STRONG_TAGS.has(node.tagName) ? "strong" : style;
    collectRuns(node.children, nested, lines);
  }
}

/** A cell's visible text, line by line, in runs of one style. */
export function hastCellLines(cell: Element): TableCellLines {
  const lines: TableTextRun[][] = [[]];
  collectRuns(cell.children, "normal", lines);
  return lines;
}

/** The rows of a table, header rows first, each a list of cells. */
function tableRows(table: Element): { head: Element[][]; body: Element[][] } {
  const head: Element[][] = [];
  const body: Element[][] = [];
  const visit = (element: Element, inHead: boolean) => {
    for (const child of hastElements(element)) {
      if (child.tagName === "tr") {
        (inHead ? head : body).push(hastElements(child).filter((cell) => cell.tagName === "th" || cell.tagName === "td"));
      } else if (child.tagName === "thead" || child.tagName === "tbody" || child.tagName === "tfoot") {
        visit(child, child.tagName === "thead");
      }
    }
  };
  visit(table, false);
  return { head, body };
}

function spans(cell: Element): boolean {
  const { colSpan, rowSpan } = cell.properties ?? {};
  return Number(colSpan ?? 1) > 1 || Number(rowSpan ?? 1) > 1;
}

/**
 * A table's columns as text for its layout (`tableLayout.ts`): one header
 * row and the body rows. `null` for a table the layout does not draw, one
 * from HTML with merged cells or more than one header row: the browser lays
 * that out by itself (Ч5, «Края»).
 */
export function hastTableColumns(table: Element): TableColumnText[] | null {
  const { head, body } = tableRows(table);
  if (head.length > 1 || [...head, ...body].some((row) => row.some(spans))) return null;
  const header = head[0] ?? [];
  const count = Math.max(header.length, ...body.map((row) => row.length));
  if (count === 0) return null;
  return Array.from({ length: count }, (_, index) => {
    const headerCell = header[index];
    return {
      header: headerCell ? hastCellLines(headerCell) : [[]],
      body: body.map((row) => {
        const cell = row[index];
        return cell ? hastCellLines(cell) : [[]];
      }),
    };
  });
}
