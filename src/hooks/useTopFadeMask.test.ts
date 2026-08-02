import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";

import { TOP_FADE_LIST } from "@/lib/edgeFade";
import { useTopFadeMask } from "./useTopFadeMask";

/// A detached scroll container. `scrollTop` is not settable on a jsdom element
/// that never lays out, so the tests own the value directly.
function createScrollElement(initialScrollTop = 0) {
  const element = document.createElement("div");
  let scrollTop = initialScrollTop;
  Object.defineProperty(element, "scrollTop", {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next;
    },
    configurable: true,
  });
  const scrollTo = (next: number) => {
    element.scrollTop = next;
    element.dispatchEvent(new Event("scroll"));
  };
  return { element, scrollTo };
}

function renderMask(enabled: boolean) {
  const forwardRef = createRef<HTMLElement>() as React.RefObject<HTMLElement | null>;
  const hook = renderHook(
    ({ on }: { on: boolean }) => useTopFadeMask(forwardRef, on, TOP_FADE_LIST),
    {
      initialProps: { on: enabled },
    },
  );
  /// Attach a node the way a component would, in a commit.
  const attach = (node: HTMLElement | null) => act(() => hook.result.current.ref(node));
  return { ...hook, forwardRef, attach };
}

describe("useTopFadeMask", () => {
  it("returns no style while the surface is at rest", () => {
    const { element } = createScrollElement();
    const { result, attach } = renderMask(true);
    attach(element);
    expect(result.current.height).toBe(0);
  });

  it("turns the mask on once the surface is scrolled", () => {
    const { element, scrollTo } = createScrollElement();
    const { result, attach } = renderMask(true);
    attach(element);

    act(() => scrollTo(120));
    expect(result.current.height).toBeGreaterThan(0);
  });

  it("turns the mask off again when the surface returns to the top", () => {
    const { element, scrollTo } = createScrollElement();
    const { result, attach } = renderMask(true);
    attach(element);

    act(() => scrollTo(120));
    expect(result.current.height).toBeGreaterThan(0);

    act(() => scrollTo(0));
    expect(result.current.height).toBe(0);
  });

  it("picks up a surface that is already scrolled when it attaches", () => {
    const { element } = createScrollElement(400);
    const { result, attach } = renderMask(true);
    attach(element);
    expect(result.current.height).toBeGreaterThan(0);
  });

  it("attaches to a node that only appears in a later render", () => {
    // The search overlay lives inside a Radix Dialog: its scroll container does
    // not exist until the dialog opens, long after the component mounted. A ref
    // object would still be empty when the effect first ran.
    const { element, scrollTo } = createScrollElement();
    const { result, attach } = renderMask(true);

    expect(result.current.height).toBe(0);

    attach(element); // dialog opens
    act(() => scrollTo(300));
    expect(result.current.height).toBeGreaterThan(0);
  });

  it("stops observing a node that is unmounted and remounted", () => {
    const first = createScrollElement();
    const second = createScrollElement();
    const { result, attach } = renderMask(true);

    attach(first.element);
    act(() => first.scrollTo(300));
    expect(result.current.height).toBeGreaterThan(0);

    attach(null); // dialog closes
    expect(result.current.height).toBe(0);

    attach(second.element); // dialog reopens at the top
    expect(result.current.height).toBe(0);
    act(() => second.scrollTo(300));
    expect(result.current.height).toBeGreaterThan(0);
  });

  it("keeps the caller's own ref pointing at the node", () => {
    const { element } = createScrollElement();
    const { forwardRef, attach } = renderMask(true);

    attach(element);
    expect(forwardRef.current).toBe(element);

    attach(null);
    expect(forwardRef.current).toBeNull();
  });

  it("ignores sub-pixel offsets from momentum scrolling", () => {
    const { element, scrollTo } = createScrollElement();
    const { result, attach } = renderMask(true);
    attach(element);

    act(() => scrollTo(0.5));
    expect(result.current.height).toBe(0);
  });

  it("stays off while the preference is disabled, even when scrolled", () => {
    const { element, scrollTo } = createScrollElement(500);
    const { result, attach } = renderMask(false);
    attach(element);
    expect(result.current.height).toBe(0);

    act(() => scrollTo(900));
    expect(result.current.height).toBe(0);
  });

  it("clears an active mask when the preference is turned off mid-session", () => {
    const { element, scrollTo } = createScrollElement();
    const { result, rerender, attach } = renderMask(true);
    attach(element);

    act(() => scrollTo(300));
    expect(result.current.height).toBeGreaterThan(0);

    rerender({ on: false });
    expect(result.current.height).toBe(0);
  });

  it("re-attaches and reflects current scroll when the preference is turned back on", () => {
    const { element, scrollTo } = createScrollElement();
    const { result, rerender, attach } = renderMask(true);
    attach(element);

    act(() => scrollTo(300));
    rerender({ on: false });
    expect(result.current.height).toBe(0);

    rerender({ on: true });
    expect(result.current.height).toBeGreaterThan(0);
  });

  it("does not throw when no node is ever attached", () => {
    const { result } = renderMask(true);
    expect(result.current.height).toBe(0);
  });

  it("removes its scroll listener on unmount", () => {
    const { element, scrollTo } = createScrollElement();
    const { result, unmount, attach } = renderMask(true);
    attach(element);

    unmount();
    expect(() => act(() => scrollTo(500))).not.toThrow();
    expect(result.current.height).toBe(0);
  });
});
