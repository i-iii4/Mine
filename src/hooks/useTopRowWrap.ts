// The selection's commands take a second row when the top row over the feed
// cannot hold them (SPEC_NARROW_WINDOW.md, У10): the half over the feed,
// showing only them then, moves right under the row, and the feed moves down
// by that row. When the row has room again, the half comes back. Nothing
// else in the row ever takes a second row: an open card's name, the place,
// the space and the graph's controls end in an ellipsis (topRowFit.ts).
//
// The fit is measured, not computed, as the sidebar's filter row is
// (useSidebarRowFit.ts): nothing here knows a width in pixels. The host's
// `data-top-row` says where the half stands and the styles answer it
// (global.css), so a try costs a layout, not a render. In one row the row is
// read as it is; in two rows one row is tried through `data-top-row-try`,
// which moves the half back for a single layout and leaves the feed where it
// is. Whatever the half or the row cuts (topRowFit.ts) means two rows.

import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";
import { topRowCut } from "@/lib/topRowFit";

/** One row, or the half over the feed in a second row under it. */
export type TopRowFit = "one" | "two";

/** What `useTopRowWrap` gives the page. */
export interface TopRowWrap {
  /** The fit last measured; the host renders it as `data-top-row`. */
  fit: TopRowFit;
  /** The element that carries `data-top-row`: an ancestor of the row and of
   *  the feed that moves down with the second row. */
  hostRef: RefCallback<HTMLElement>;
  /** The row's part right of the sidebar's segment, the half over the feed
   *  inside it. It is measured from the moment it mounts. */
  rowRef: RefCallback<HTMLElement>;
}

/** Fit the top row to its width: one row while nothing in it is cut. */
export function useTopRowWrap(): TopRowWrap {
  const [fit, setFit] = useState<TopRowFit>("one");
  const hostElementRef = useRef<HTMLElement | null>(null);
  const rowElementRef = useRef<HTMLElement | null>(null);
  // The widest row one row was found not to fit, for what the row shows
  // since: a row no wider will not fit either, so two rows stay without a
  // try while the window narrows. A change of what the row shows forgets it.
  const missedWidthRef = useRef(Number.NEGATIVE_INFINITY);
  const frameRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const host = hostElementRef.current;
    const row = rowElementRef.current;
    if (!host || !row) return;
    const width = row.clientWidth;
    let next: TopRowFit;
    if (host.dataset.topRow !== "two") {
      next = topRowCut(row) ? "two" : "one";
      if (next === "two") missedWidthRef.current = width;
    } else if (width <= missedWidthRef.current || topRowCut(row)) {
      // The second row is never narrower than the half's place in one row:
      // what it cuts, one row would cut too.
      next = "two";
    } else {
      host.dataset.topRowTry = "one";
      next = topRowCut(row) ? "two" : "one";
      delete host.dataset.topRowTry;
      if (next === "two") missedWidthRef.current = width;
    }
    if (next === "one") missedWidthRef.current = Number.NEGATIVE_INFINITY;
    host.dataset.topRow = next;
    setFit(next);
  }, []);

  // Changes come in bursts (a resize frame, a layer and its content): one
  // measure per frame.
  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  const contentChanged = useCallback(() => {
    missedWidthRef.current = Number.NEGATIVE_INFINITY;
    schedule();
  }, [schedule]);

  const hostRef = useCallback<RefCallback<HTMLElement>>((host) => {
    hostElementRef.current = host;
    if (host) schedule();
  }, [schedule]);

  // The row's width follows the window and the sidebar; what it shows
  // changes with the place, the selection's count, the layer entered and an
  // open card. Neither observer sees the host's attributes, so a measure
  // cannot call itself again.
  const rowRef = useCallback<RefCallback<HTMLElement>>((row) => {
    if (!row) return;
    rowElementRef.current = row;
    const resizeObserver = new ResizeObserver(() => schedule());
    resizeObserver.observe(row);
    const mutationObserver = new MutationObserver(() => contentChanged());
    mutationObserver.observe(row, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-entered", "data-path-card-line"],
    });
    contentChanged();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (rowElementRef.current === row) rowElementRef.current = null;
    };
  }, [contentChanged, schedule]);

  // A font that arrives late widens the texts it draws.
  useEffect(() => {
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (!fonts) return;
    fonts.addEventListener("loadingdone", contentChanged);
    return () => fonts.removeEventListener("loadingdone", contentChanged);
  }, [contentChanged]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  return { fit, hostRef, rowRef };
}
