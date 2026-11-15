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
//
// The rule holds for every frame that shows the strips (user's decision of
// 15.11.2026; SPEC_SIDEBAR_STRIP.md, ЛМ2). The List giving way to the table
// under the edge in hand lays every strip out in one frame, while the rows'
// move keeps them transparent until the fade-in, halfway through
// (sidebarListMorph.ts): that frame alone would hold the look's change, the
// move's start and every strip's tiles, past a frame's time. The move holds
// the strips' widths (`holdStripWidths`) and lets them go a few frames on,
// still transparent, or at once whenever the strips might show.

import { flushSync } from "react-dom";

type StripWidthListener = (width: number) => void;

const listeners = new Map<Element, StripWidthListener>();
let observer: ResizeObserver | null = null;
/** The holds in force: while any is, the widths wait in `waiting`. */
let holds = 0;
/** Each held strip's last width, for its listener once the holds end. */
const waiting = new Map<Element, number>();

function sharedObserver(): ResizeObserver {
  observer ??= new ResizeObserver((entries) => {
    if (holds > 0) {
      for (const entry of entries) {
        if (listeners.has(entry.target)) waiting.set(entry.target, entry.contentRect.width);
      }
      return;
    }
    flushSync(() => {
      for (const entry of entries) {
        listeners.get(entry.target)?.(entry.contentRect.width);
      }
    });
  });
  return observer;
}

/** Holds the strips' new widths from their listeners until the returned
 *  release, which hands each strip its last width in one synchronous React
 *  pass, before the frame it is called in paints. Only for strips nobody
 *  sees meanwhile (the List giving way to the table, its strips
 *  transparent). Releasing twice does nothing. */
export function holdStripWidths(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds > 0 || waiting.size === 0) return;
    const widths = [...waiting];
    waiting.clear();
    flushSync(() => {
      for (const [strip, width] of widths) listeners.get(strip)?.(width);
    });
  };
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
    waiting.delete(strip);
    resize.unobserve(strip);
  };
}
