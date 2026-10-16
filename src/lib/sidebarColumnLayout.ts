// TRIAL (PLAN 47.6, user's request of 16.10.2026): the order and visibility of
// the sidebar rows' columns, set in the Display panel. Once the user decides,
// this module either goes or becomes a lasting setting with its own spec.
//
// A row has three columns: the name, the previews and the meta zone (the
// count, and Connect or Connected over it). The rows themselves take no
// props for it: this module writes CSS variables and attributes on the root
// (global.css, «Sidebar columns»), so every row, the guidelines and the
// lifted row of a drag follow at once, and the default writes nothing, which
// leaves the rows exactly as they were. Kept between launches in its own
// localStorage key; other tabs and windows hear it through
// `settings-changed`.

import { useSyncExternalStore } from "react";

/** One column of a sidebar row. */
export type SidebarColumn = "name" | "previews" | "meta";

/** The columns in their order, and the hidden ones. */
export interface SidebarColumnLayout {
  order: readonly SidebarColumn[];
  hidden: readonly SidebarColumn[];
}

/** The columns as the rows have always shown them. */
export const SIDEBAR_COLUMNS: readonly SidebarColumn[] = ["name", "previews", "meta"];

/** The default: today's order, every column shown. */
export const DEFAULT_SIDEBAR_COLUMN_LAYOUT: SidebarColumnLayout = { order: SIDEBAR_COLUMNS, hidden: [] };

export const SIDEBAR_COLUMNS_STORAGE_KEY = "mine.sidebar.columns";

/** What the Display panel calls each column. */
export const SIDEBAR_COLUMN_LABELS: Record<SidebarColumn, string> = {
  name: "Name",
  previews: "Previews",
  meta: "Count",
};

function isColumn(value: unknown): value is SidebarColumn {
  return typeof value === "string" && (SIDEBAR_COLUMNS as readonly string[]).includes(value);
}

/** A stored value as a layout: the default for anything that is not every
 *  column once in `order` and a subset of them in `hidden`, leaving one at
 *  least shown. */
export function parseSidebarColumnLayout(raw: string | null): SidebarColumnLayout {
  if (raw === null) return DEFAULT_SIDEBAR_COLUMN_LAYOUT;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_SIDEBAR_COLUMN_LAYOUT;
    // A non-null object: its fields are read as unknown and checked below.
    const { order, hidden } = value as { order?: unknown; hidden?: unknown };
    if (!Array.isArray(order) || !Array.isArray(hidden)) return DEFAULT_SIDEBAR_COLUMN_LAYOUT;
    const columns = order.filter(isColumn);
    const hiddenColumns = hidden.filter(isColumn);
    const complete = columns.length === SIDEBAR_COLUMNS.length
      && SIDEBAR_COLUMNS.every((column) => columns.includes(column));
    const hiddenValid = hiddenColumns.length === hidden.length
      && new Set(hiddenColumns).size === hiddenColumns.length
      && hiddenColumns.length < SIDEBAR_COLUMNS.length;
    if (!complete || !hiddenValid) return DEFAULT_SIDEBAR_COLUMN_LAYOUT;
    return { order: columns, hidden: hiddenColumns };
  } catch {
    // A damaged value reads as the default, as the feed's options do.
    return DEFAULT_SIDEBAR_COLUMN_LAYOUT;
  }
}

/** Whether `layout` is the rows as they have always been. */
export function isDefaultSidebarColumnLayout(layout: SidebarColumnLayout): boolean {
  return layout.hidden.length === 0
    && layout.order.every((column, index) => column === SIDEBAR_COLUMNS[index]);
}

// ── Geometry ────────────────────────────────────────────────────────────────
//
// The rows' own model (DESIGN_SYSTEM.md, «Строка боковой панели: три зоны»):
// a row is zones split by guidelines; the row's inset belongs to the name's
// zone, a guideline's pixel to the zone after it. So every column carries its
// insets wherever it stands: the name its inset (`--sidebar-row-pad-x`), the
// previews the gap after their guideline, the meta zone its fields. A column
// after another owns the guideline's pixel before it (its lead); the first
// one has none.

/** The name's zone with the previews shown: the row's inset and the name's
 *  column, as it is when the name comes first. */
const NAME_ZONE = "(var(--sidebar-row-pad-x) + var(--sidebar-name-col))";
const META_ZONE = "var(--sidebar-zone)";
/** A guideline's pixel, owned by the column after it. */
const GUIDE_PX = 1;

function shownColumns(layout: SidebarColumnLayout): SidebarColumn[] {
  return layout.order.filter((column) => !layout.hidden.includes(column));
}

/** The width of `column`'s zone in a row laid out as `layout`, as a term of a
 *  `calc()`: the name's and the meta zone's their own; the previews (or, with
 *  them hidden, the name; alone, the meta zone) take what the others and the
 *  guidelines leave. */
function zoneWidth(column: SidebarColumn, layout: SidebarColumnLayout): string {
  const shown = shownColumns(layout);
  const flexible = (["previews", "name", "meta"] as const).find((candidate) => shown.includes(candidate));
  const own = (candidate: SidebarColumn) => (candidate === "meta" ? META_ZONE : NAME_ZONE);
  if (column !== flexible) return own(column);
  const taken: string[] = shown.filter((candidate) => candidate !== column).map(own);
  const guides = shown.length - 1;
  if (guides > 0) taken.push(`${guides * GUIDE_PX}px`);
  return taken.length === 0 ? "100%" : `(100% - ${taken.join(" - ")})`;
}

/** What the root carries for `layout`: the columns' order, each column's lead
 *  (the guideline's pixel before it, none for the first), the guidelines'
 *  places between the shown columns, and how far the meta zone stands from
 *  the row's right edge (the count and Connect are placed from there). The
 *  default carries nothing: the styles' own defaults are the rows as they
 *  were. */
export function sidebarColumnRootStyle(layout: SidebarColumnLayout): Record<string, string> {
  if (isDefaultSidebarColumnLayout(layout)) return {};
  const shown = shownColumns(layout);
  const style: Record<string, string> = {};
  for (const column of SIDEBAR_COLUMNS) {
    style[`--sidebar-${column}-order`] = String(layout.order.indexOf(column));
    const index = shown.indexOf(column);
    style[`--sidebar-${column}-lead`] = index > 0 ? `${GUIDE_PX}px` : "0px";
  }
  // A guideline before each shown column but the first: after the zones
  // before it and the guidelines between them.
  const guides = shown.slice(1).map((_, index) => {
    const terms = shown.slice(0, index + 1).map((column) => zoneWidth(column, layout));
    if (index > 0) terms.push(`${index * GUIDE_PX}px`);
    return `calc(${terms.join(" + ")})`;
  });
  style["--sidebar-guide-1-left"] = guides[0] ?? "-1px";
  style["--sidebar-guide-2-left"] = guides[1] ?? "-1px";
  style["--sidebar-guide-2-right"] = "auto";
  style["--sidebar-guide-1-display"] = guides[0] ? "block" : "none";
  style["--sidebar-guide-2-display"] = guides[1] ? "block" : "none";
  const metaIndex = shown.indexOf("meta");
  const after = metaIndex === -1 ? [] : shown.slice(metaIndex + 1);
  style["--sidebar-meta-right"] = after.length === 0
    ? "0px"
    : `calc(${[...after.map((column) => zoneWidth(column, layout)), `${after.length * GUIDE_PX}px`].join(" + ")})`;
  return style;
}

const ROOT_VARIABLES = [
  ...SIDEBAR_COLUMNS.map((column) => `--sidebar-${column}-order`),
  ...SIDEBAR_COLUMNS.map((column) => `--sidebar-${column}-lead`),
  "--sidebar-guide-1-left",
  "--sidebar-guide-2-left",
  "--sidebar-guide-2-right",
  "--sidebar-guide-1-display",
  "--sidebar-guide-2-display",
  "--sidebar-meta-right",
];

/** Write `layout` on the root: the variables and the hidden columns. */
export function applySidebarColumnLayout(layout: SidebarColumnLayout, root: HTMLElement = document.documentElement) {
  for (const name of ROOT_VARIABLES) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(sidebarColumnRootStyle(layout))) root.style.setProperty(name, value);
  for (const column of SIDEBAR_COLUMNS) {
    root.toggleAttribute(`data-sidebar-hide-${column}`, layout.hidden.includes(column));
  }
}

// ── Store ───────────────────────────────────────────────────────────────────

function readStored(): string | null {
  try {
    return window.localStorage.getItem(SIDEBAR_COLUMNS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(layout: SidebarColumnLayout) {
  try {
    window.localStorage.setItem(SIDEBAR_COLUMNS_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Unwritable storage (private mode, quota): the choice lasts this session.
  }
}

let current: SidebarColumnLayout = typeof window === "undefined"
  ? DEFAULT_SIDEBAR_COLUMN_LAYOUT
  : parseSidebarColumnLayout(readStored());
const listeners = new Set<() => void>();

function publish(next: SidebarColumnLayout) {
  current = next;
  if (typeof document !== "undefined") applySidebarColumnLayout(next);
  for (const listener of listeners) listener();
}

if (typeof document !== "undefined") applySidebarColumnLayout(current);

/** The layout now. */
export function getSidebarColumnLayout(): SidebarColumnLayout {
  return current;
}

/** Put the columns in `order` and keep it. */
export function setSidebarColumnOrder(order: readonly SidebarColumn[]) {
  const next = parseSidebarColumnLayout(JSON.stringify({ order, hidden: current.hidden }));
  writeStored(next);
  publish(next);
}

/** Show or hide `column` and keep it; the last shown column stays shown. */
export function setSidebarColumnShown(column: SidebarColumn, shown: boolean) {
  const hidden = shown
    ? current.hidden.filter((candidate) => candidate !== column)
    : [...new Set([...current.hidden, column])];
  if (hidden.length >= SIDEBAR_COLUMNS.length) return;
  const next = { order: current.order, hidden };
  writeStored(next);
  publish(next);
}

/** Re-read storage: another tab or window chose (`settings-changed`). */
export function reloadSidebarColumnLayout() {
  publish(parseSidebarColumnLayout(readStored()));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The layout, re-rendering when it changes. */
export function useSidebarColumnLayout(): SidebarColumnLayout {
  return useSyncExternalStore(subscribe, getSidebarColumnLayout, getSidebarColumnLayout);
}
