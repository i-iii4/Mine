// How the sidebar's width reaches the page (SPEC_NARROW_WINDOW.md, У1, У2;
// SPEC_SIDEBAR_STRIP.md, ЛМ2). `--sidebar-width` is the width as CSS: plain
// pixels while a drag runs, the window's squeeze otherwise, 0 collapsed or
// over the feed. It changes every frame of a drag, a collapse and a window's
// resize, so it does not inherit (global.css registers it so): an inherited
// value that changes on the root restyles every element of the page in every
// such frame, the sidebar's thumbnails and the feed's cards with it. The
// value stands on the root, and on each element that lays itself out by it:
// the panel beside the feed, the top row's sidebar segment, the resize
// handle's catches and the top row's second row.
//
// The rows' columns take another width, `--sidebar-columns-width`: the
// sidebar's width when open, which a collapse and leaving the row do not
// change, so a name's column stands where it stood for the whole of those
// motions (user's decision of 05.11.2026; DESIGN_SYSTEM.md, «Переход между
// List и таблицей»). It stands on the root and on each element that works the
// name's column out from it (`--sidebar-name-col`, global.css): the name's
// cell and the guideline after it. It does not inherit either.

const SIDEBAR_WIDTH_VAR = "--sidebar-width";
const SIDEBAR_COLUMNS_VAR = "--sidebar-columns-width";

const hosts = new Set<HTMLElement>();
const columnHosts = new Set<HTMLElement>();

/** Sets the sidebar's width, `value` as CSS, on the root and on every element
 *  laid out by it, and the width its rows' columns follow, `columns`: the
 *  same, unless the sidebar is leaving its open width. */
export function writeSidebarWidth(value: string, columns: string = value): void {
  const root = document.documentElement.style;
  root.setProperty(SIDEBAR_WIDTH_VAR, value);
  for (const host of hosts) host.style.setProperty(SIDEBAR_WIDTH_VAR, value);
  if (root.getPropertyValue(SIDEBAR_COLUMNS_VAR) === columns) return;
  root.setProperty(SIDEBAR_COLUMNS_VAR, columns);
  for (const host of columnHosts) host.style.setProperty(SIDEBAR_COLUMNS_VAR, columns);
}

/** A callback ref for an element laid out by the sidebar's width: it takes
 *  the width the root holds now and every width written after. React runs
 *  the teardown it returns. */
export function sidebarWidthHost(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return undefined;
  hosts.add(element);
  element.style.setProperty(SIDEBAR_WIDTH_VAR, document.documentElement.style.getPropertyValue(SIDEBAR_WIDTH_VAR));
  return () => {
    hosts.delete(element);
    element.style.removeProperty(SIDEBAR_WIDTH_VAR);
  };
}

/** A callback ref for an element that works the name's column out: it takes
 *  the columns' width the root holds now, or its plain width where nothing
 *  wrote one, and every columns' width written after. */
export function sidebarColumnsHost(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return undefined;
  columnHosts.add(element);
  const root = document.documentElement.style;
  element.style.setProperty(SIDEBAR_COLUMNS_VAR, root.getPropertyValue(SIDEBAR_COLUMNS_VAR) || root.getPropertyValue(SIDEBAR_WIDTH_VAR));
  return () => {
    columnHosts.delete(element);
    element.style.removeProperty(SIDEBAR_COLUMNS_VAR);
  };
}
