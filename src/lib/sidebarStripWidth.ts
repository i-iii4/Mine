// The width of each sidebar thumbnail strip, as the strip itself is laid out
// (SPEC_SIDEBAR_STRIP.md, ЛМ2). A strip draws as many tiles as its width
// holds, and the number must be right in the frame that draws the width: a
// drag of the panel's edge, a collapse's motion, a window squeezing the
// panel, the List look giving way to the table. All of them reach the strip
// only through layout (`--sidebar-width`, container queries), never through
// a render, so the strip learns its width from a resize observer.
//
// One observer serves every strip. Its callback runs after the frame's
// layout and before its paint; the strips whose width changed commit their
// new counts there, all in one synchronous React pass, and the browser lays
// out again before painting. Without `flushSync` React would render the
// update in a later task, and that frame would paint the old count: an empty
// end of the strip when it widens, a tile too many when it narrows.

import { flushSync } from "react-dom";

type StripWidthListener = (width: number) => void;

const listeners = new Map<Element, StripWidthListener>();
let observer: ResizeObserver | null = null;

function sharedObserver(): ResizeObserver {
  observer ??= new ResizeObserver((entries) => {
    flushSync(() => {
      for (const entry of entries) {
        listeners.get(entry.target)?.(entry.contentRect.width);
      }
    });
  });
  return observer;
}

/** Calls `listener` with the width of `strip` whenever its layout changes it,
 *  before the frame paints; returns the teardown. Outside a browser that has
 *  no resize observer nothing is observed. */
export function observeStripWidth(strip: Element, listener: StripWidthListener): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  listeners.set(strip, listener);
  const resize = sharedObserver();
  resize.observe(strip);
  return () => {
    listeners.delete(strip);
    resize.unobserve(strip);
  };
}
