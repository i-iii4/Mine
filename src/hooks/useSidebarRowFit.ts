// The sidebar's filter row gives room up in a fixed order when the sidebar
// narrows (DESIGN_SYSTEM.md, «Сжатие ряда фильтра»): first the space's name
// shrinks to its minimum, then the filter field folds into a search button.
// `+` never goes. (A stage that turned labelled segments into icons left with
// the All / Connected filter, 07.10.2026.)
//
// The fit is measured, not computed, as the bottom bar's is: each stage is
// tried on the live row through its `data-row-fit` attribute, and the first
// one that leaves the field its minimum width wins. The styles of the stages
// answer the attribute (global.css), so a try costs a layout, not a render.

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefCallback,
  type RefObject,
} from "react";

export type SidebarRowFit = "full" | "name" | "search";

const STAGES: readonly SidebarRowFit[] = ["full", "name", "search"];

/** The narrowest the filter field may get before the row gives up more. */
export const SIDEBAR_FIELD_MIN_WIDTH_PX = 72;

/** What `useSidebarRowFit` gives its row. */
export interface SidebarRowFitResult {
  /** The stage the row was last measured at. */
  fit: SidebarRowFit;
  /** The ref for the row: the row is measured from the moment it mounts. */
  rowRef: RefCallback<HTMLElement>;
}

/** Fit the row that takes `rowRef` so `field` keeps its minimum width;
 *  `contentKey` names what is in the row now (a card open, a query, the
 *  space), so a change of it measures again. */
export function useSidebarRowFit(
  fieldRef: RefObject<HTMLElement | null>,
  contentKey: string,
): SidebarRowFitResult {
  const [fit, setFit] = useState<SidebarRowFit>("full");
  const rowElementRef = useRef<HTMLElement | null>(null);
  const measure = useCallback(() => {
    const row = rowElementRef.current;
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
  }, [fieldRef]);

  // The row is observed from the moment it mounts, not from the hook's first
  // commit: a page may show the row only later (the app's row waits for its
  // space to open), and an effect run before that found no row and never
  // observed it. A measure on a content change may read the row mid-way
  // through a width transition (the sidebar opening from 0); the observer
  // then follows the row frame by frame to its final width. The row's own
  // width follows the sidebar; its stages change only what is inside it, so
  // observing it cannot loop.
  const rowRef = useCallback<RefCallback<HTMLElement>>((row) => {
    if (!row) return;
    rowElementRef.current = row;
    const observer = new ResizeObserver(() => measure());
    observer.observe(row);
    return () => {
      observer.disconnect();
      if (rowElementRef.current === row) rowElementRef.current = null;
    };
  }, [measure]);

  useLayoutEffect(() => {
    measure();
  }, [measure, contentKey]);

  return { fit, rowRef };
}
