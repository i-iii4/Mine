// How the sidebar's width reaches the page (SPEC_NARROW_WINDOW.md, У1, У2;
// SPEC_SIDEBAR_STRIP.md, ЛМ2). `--sidebar-width` is the width as CSS: plain
// pixels while a drag runs, the window's squeeze otherwise, 0 collapsed or
// over the feed. It changes every frame of a drag, a collapse and a window's
// resize, so it does not inherit (global.css registers it so): an inherited
// value that changes on the root restyles every element of the page in every
// such frame, the sidebar's thumbnails and the feed's cards with it. The
// value stands on the root, and on each element that lays itself out by it:
// the panel beside the feed, the top row's sidebar segment, the resize
// handle's catches and the top row's second row. Nothing inside the panel
// reads it: the rows take their columns from the list's own width
// (`--sidebar-name-col`, container units, global.css).

const SIDEBAR_WIDTH_VAR = "--sidebar-width";

const hosts = new Set<HTMLElement>();

/** Sets the sidebar's width, `value` as CSS, on the root and on every element
 *  laid out by it. */
export function writeSidebarWidth(value: string): void {
  document.documentElement.style.setProperty(SIDEBAR_WIDTH_VAR, value);
  for (const host of hosts) host.style.setProperty(SIDEBAR_WIDTH_VAR, value);
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
