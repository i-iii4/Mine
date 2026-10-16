import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTopRowWrap } from "./useTopRowWrap";

// The layout is the browser's; here the row is as wide as `rowWidth` and one
// row holds its parts from `needWidth` on.
const layout = vi.hoisted(() => ({
  rowWidth: 800,
  needWidth: 600,
  oneRowTries: 0,
}));

vi.mock("@/lib/topRowFit", () => ({
  topRowCut: (row: HTMLElement) => {
    const host = row.parentElement!;
    const tryingOne = host.dataset.topRowTry === "one";
    if (tryingOne) layout.oneRowTries += 1;
    const oneRow = host.dataset.topRow !== "two" || tryingOne;
    return oneRow && layout.rowWidth < layout.needWidth;
  },
}));

const resizeCallbacks: ResizeObserverCallback[] = [];

function Harness() {
  const wrap = useTopRowWrap();
  return (
    <div ref={wrap.hostRef} data-testid="host" data-top-row={wrap.fit}>
      <div ref={wrap.rowRef} data-testid="row">
        <span data-testid="text">Everything</span>
      </div>
    </div>
  );
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

/** The window changes the row's width; the observer reports it. */
async function resizeRow(width: number): Promise<void> {
  layout.rowWidth = width;
  act(() => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });
  await nextFrame();
}

describe("useTopRowWrap: the top row in one row or two (SPEC_NARROW_WINDOW.md, У10)", () => {
  const OriginalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    layout.rowWidth = 800;
    layout.needWidth = 600;
    layout.oneRowTries = 0;
    resizeCallbacks.length = 0;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return layout.rowWidth;
      },
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });

  it("keeps one row while nothing is cut", async () => {
    render(<Harness />);
    await nextFrame();
    expect(screen.getByTestId("host")).toHaveAttribute("data-top-row", "one");
  });

  it("takes a second row when one row cuts, and comes back when it has room", async () => {
    render(<Harness />);
    await nextFrame();

    await resizeRow(500);
    const host = screen.getByTestId("host");
    expect(host).toHaveAttribute("data-top-row", "two");

    await resizeRow(700);
    expect(host).toHaveAttribute("data-top-row", "one");
    // The try leaves nothing behind.
    expect(host).not.toHaveAttribute("data-top-row-try");
  });

  it("does not try one row again while the window narrows", async () => {
    render(<Harness />);
    await nextFrame();
    await resizeRow(500);
    layout.oneRowTries = 0;

    await resizeRow(480);
    await resizeRow(500);
    expect(layout.oneRowTries).toBe(0);
    await resizeRow(520);
    expect(layout.oneRowTries).toBe(1);
    expect(screen.getByTestId("host")).toHaveAttribute("data-top-row", "two");
  });

  it("tries one row again when what the row shows changes", async () => {
    render(<Harness />);
    await nextFrame();
    await resizeRow(500);
    layout.oneRowTries = 0;

    // The selection ends: the half needs less.
    layout.needWidth = 400;
    await act(async () => {
      screen.getByTestId("text").textContent = "Inbox";
      // The observer answers in a microtask.
      await Promise.resolve();
    });
    await nextFrame();
    expect(layout.oneRowTries).toBe(1);
    expect(screen.getByTestId("host")).toHaveAttribute("data-top-row", "one");
  });
});
