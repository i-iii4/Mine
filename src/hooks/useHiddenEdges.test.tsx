import { act, fireEvent, render } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useHiddenEdges } from "./useHiddenEdges";

/** Give jsdom, which lays out nothing, the block's scroll geometry. */
function geometry(
  block: HTMLElement,
  { scrollLeft, clientWidth, scrollWidth }: { scrollLeft: number; clientWidth: number; scrollWidth: number },
) {
  Object.defineProperty(block, "clientWidth", { configurable: true, value: clientWidth });
  Object.defineProperty(block, "scrollWidth", { configurable: true, value: scrollWidth });
  block.scrollLeft = scrollLeft;
}

const observers = new Set<FakeResizeObserver>();
class FakeResizeObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
  deliver() {
    this.callback([...this.targets].map((target) => ({ target }) as ResizeObserverEntry), this as unknown as ResizeObserver);
  }
}
function deliverResizes() {
  act(() => {
    for (const observer of [...observers]) observer.deliver();
  });
}

function Block({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { edges, sync } = useHiddenEdges(ref);
  return (
    <div ref={ref} data-block="" onScroll={sync} data-left={String(edges.left)} data-right={String(edges.right)}>
      {children}
    </div>
  );
}

function edgesOf(block: HTMLElement) {
  return { left: block.dataset.left === "true", right: block.dataset.right === "true" };
}

// SPEC_SCROLL_EDGE_FADE.md, «Полоса вкладок».
describe("useHiddenEdges", () => {
  const saved = globalThis.ResizeObserver;
  beforeEach(() => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = saved;
    observers.clear();
  });

  it("follows the block's scroll", () => {
    const { container } = render(<Block>content</Block>);
    const block = container.querySelector<HTMLElement>("[data-block]")!;
    expect(edgesOf(block)).toEqual({ left: false, right: false });

    geometry(block, { scrollLeft: 0, clientWidth: 400, scrollWidth: 960 });
    fireEvent.scroll(block);
    expect(edgesOf(block)).toEqual({ left: false, right: true });

    geometry(block, { scrollLeft: 560, clientWidth: 400, scrollWidth: 960 });
    fireEvent.scroll(block);
    expect(edgesOf(block)).toEqual({ left: true, right: false });
  });

  it("follows the sizes of the block and of what it holds", () => {
    const { container } = render(<Block><span data-child="">content</span></Block>);
    const block = container.querySelector<HTMLElement>("[data-block]")!;
    const [observer] = observers;
    expect([...observer!.targets]).toEqual([block, container.querySelector("[data-child]")]);

    geometry(block, { scrollLeft: 0, clientWidth: 400, scrollWidth: 960 });
    deliverResizes();
    expect(edgesOf(block)).toEqual({ left: false, right: true });

    geometry(block, { scrollLeft: 0, clientWidth: 960, scrollWidth: 960 });
    deliverResizes();
    expect(edgesOf(block)).toEqual({ left: false, right: false });
  });

  it("follows a change of its content", async () => {
    const { container, rerender } = render(<Block>short</Block>);
    const block = container.querySelector<HTMLElement>("[data-block]")!;
    geometry(block, { scrollLeft: 0, clientWidth: 400, scrollWidth: 960 });
    rerender(<Block>a longer text</Block>);
    // MutationObserver delivers in a microtask.
    await act(async () => {});
    expect(edgesOf(block)).toEqual({ left: false, right: true });
  });

  it("stops observing when the block goes", () => {
    const { unmount } = render(<Block>content</Block>);
    expect(observers.size).toBe(1);
    unmount();
    expect(observers.size).toBe(0);
  });
});
