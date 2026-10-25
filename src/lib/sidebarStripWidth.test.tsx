import { afterEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef, useState } from "react";
import { render } from "@testing-library/react";

/** The observer the module makes, driven by the test. */
const resize = vi.hoisted(() => ({
  callback: null as ResizeObserverCallback | null,
  observer: null as ResizeObserver | null,
  observed: new Set<Element>(),
}));

class TestResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resize.callback = callback;
    resize.observer = this;
  }
  observe(target: Element) {
    resize.observed.add(target);
  }
  unobserve(target: Element) {
    resize.observed.delete(target);
  }
  disconnect() {
    resize.observed.clear();
  }
}

/** A layout that gave `target` the width `width`, as the observer reports it.
 *  The entry carries only what the module reads. */
function layout(target: Element, width: number) {
  const size = [{ inlineSize: width, blockSize: 32 }];
  const rect = { x: 0, y: 0, top: 0, left: 0, width, height: 32, right: width, bottom: 32, toJSON: () => ({}) };
  const observer = resize.observer;
  if (!observer) throw new Error("No strip was observed");
  resize.callback?.([{ target, contentRect: rect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size }], observer);
}

globalThis.ResizeObserver = TestResizeObserver;
const { observeStripWidth } = await import("./sidebarStripWidth");

function Strip() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => (ref.current ? observeStripWidth(ref.current, setWidth) : undefined), []);
  return <div ref={ref} data-width={width} />;
}

describe("observeStripWidth", () => {
  afterEach(() => resize.observed.clear());

  it("commits what a strip's new width renders before the observer's callback returns", () => {
    const { container } = render(<Strip />);
    const strip = container.firstElementChild as HTMLElement;
    expect(resize.observed.has(strip)).toBe(true);

    // No act(): the update is on the page when the callback returns, as the
    // browser paints right after it. React is told this is not a test of
    // act's batching, so it neither waits for act nor warns about it.
    const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
    try {
      layout(strip, 125.6);
      expect(strip).toHaveAttribute("data-width", "125.6");
      layout(strip, 0);
      expect(strip).toHaveAttribute("data-width", "0");
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    }
  });

  it("stops reporting once the strip is gone", () => {
    const { container, unmount } = render(<Strip />);
    const strip = container.firstElementChild as HTMLElement;
    unmount();
    expect(resize.observed.has(strip)).toBe(false);
  });
});
