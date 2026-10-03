// The sidebar's filter row gives room up in a fixed order when the sidebar
// narrows (DESIGN_SYSTEM.md, «Сжатие ряда фильтра»): first the space's name
// shrinks to its minimum, then labelled segments turn into icons, then the
// filter field folds into a search button. `+` never goes.
//
// The fit is measured, not computed, as the bottom bar's is: each stage is
// tried on the live row through its `data-row-fit` attribute, and the first
// one that leaves the field its minimum width wins. The styles of the stages
// answer the attribute (global.css), so a try costs a layout, not a render.

import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

export type SidebarRowFit = "full" | "name" | "icons" | "search";

const STAGES: readonly SidebarRowFit[] = ["full", "name", "icons", "search"];

/** The narrowest the filter field may get before the row gives up more. */
export const SIDEBAR_FIELD_MIN_WIDTH_PX = 72;

/** Fit `row` so `field` keeps its minimum width; `contentKey` names what is
 *  in the row now (a card open, a query, the space), so a change of it
 *  measures again. */
export function useSidebarRowFit(
  rowRef: RefObject<HTMLElement | null>,
  fieldRef: RefObject<HTMLElement | null>,
  contentKey: string,
): SidebarRowFit {
  const [fit, setFit] = useState<SidebarRowFit>("full");
  const measure = useCallback(() => {
    const row = rowRef.current;
    const field = fieldRef.current;
    if (!row || !field) return;
    let chosen: SidebarRowFit = "search";
    for (const stage of STAGES.slice(0, -1)) {
      row.dataset.rowFit = stage;
      if (field.getBoundingClientRect().width >= SIDEBAR_FIELD_MIN_WIDTH_PX) {
        chosen = stage;
        break;
      }
    }
    row.dataset.rowFit = chosen;
    setFit((current) => (current === chosen ? current : chosen));
  }, [rowRef, fieldRef]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    // The row's own width follows the sidebar; its stages change only what
    // is inside it, so observing it cannot loop.
    const observer = new ResizeObserver(() => measure());
    observer.observe(row);
    return () => observer.disconnect();
  }, [measure, rowRef]);

  useLayoutEffect(() => {
    measure();
  }, [measure, contentKey]);

  return fit;
}

/** Whether the row shows its segments as icons. */
export function fitShowsIcons(fit: SidebarRowFit): boolean {
  return fit === "icons" || fit === "search";
}
