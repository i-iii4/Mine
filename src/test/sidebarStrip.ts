// The width of the sidebar's thumbnail strips in a test. JSDOM lays nothing
// out, so a strip would measure 0 and hold no tiles; the test says how wide
// every strip is (SPEC_SIDEBAR_STRIP.md, приёмка 2). `installSidebarStripWidth`
// puts a resize observer in place that reports that width to the strips it
// observes and answers a strip's own measure with it; `setSidebarStripWidth`
// changes it as a drag of the panel's edge would, through the observer and
// with no render of anything else. Install it before the first strip
// mounts: the strips share one observer (sidebarStripWidth.ts).

import { act } from "@testing-library/react";

const STRIP_SELECTOR = "[data-sidebar-thumbnail-strip]";

let stripWidth = 0;
const observers = new Set<StripResizeObserver>();

class StripResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    observers.delete(this);
  }

  /** Reports the strips' width to the callback, as a layout that moved it. */
  notifyStrips(): void {
    const entries = Array.from(this.targets)
      .filter((target) => target.matches(STRIP_SELECTOR))
      .map((target) => stripEntry(target));
    if (entries.length > 0) this.callback(entries, this);
  }
}

/** What a resize observer reports for a strip: its content box is its whole
 *  box (the strip has no padding). The entry carries only what the strips
 *  read; the rest of the interface has no meaning without a layout. */
function stripEntry(target: Element): ResizeObserverEntry {
  const rect = stripRect();
  const size = [{ inlineSize: stripWidth, blockSize: rect.height }];
  return {
    target,
    contentRect: rect,
    borderBoxSize: size,
    contentBoxSize: size,
    devicePixelContentBoxSize: size,
  };
}

function stripRect(): DOMRect {
  const height = 32;
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: stripWidth,
    height,
    right: stripWidth,
    bottom: height,
    toJSON: () => ({}),
  };
}

/** Makes every strip `width` wide from its first measure on. */
export function installSidebarStripWidth(width: number): void {
  stripWidth = width;
  globalThis.ResizeObserver = StripResizeObserver;
  const measure = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
    return this.matches(STRIP_SELECTOR) ? stripRect() : measure.call(this);
  };
}

/** Resizes every strip on the page to `width`, as a layout does: only the
 *  strips' observer hears of it. */
export function setSidebarStripWidth(width: number): void {
  stripWidth = width;
  act(() => {
    for (const observer of observers) observer.notifyStrips();
  });
}
