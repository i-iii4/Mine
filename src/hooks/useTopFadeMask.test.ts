import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { TOP_FADE_MASK_STYLE } from "@/lib/edgeFade";
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

function renderMask(element: HTMLElement | null, enabled: boolean) {
  const ref = createRef<HTMLElement>() as React.RefObject<HTMLElement | null>;
  ref.current = element;
  return renderHook(({ on }: { on: boolean }) => useTopFadeMask(ref, on), {
    initialProps: { on: enabled },
  });
}

describe("useTopFadeMask", () => {
  it("returns no style while the surface is at rest", () => {
    const { element } = createScrollElement();
    const { result } = renderMask(element, true);
    expect(result.current).toBeUndefined();
  });

  it("turns the mask on once the surface is scrolled", () => {
    const { element, scrollTo } = createScrollElement();
    const { result } = renderMask(element, true);

    act(() => scrollTo(120));
    expect(result.current).toBe(TOP_FADE_MASK_STYLE);
  });

  it("turns the mask off again when the surface returns to the top", () => {
    const { element, scrollTo } = createScrollElement();
    const { result } = renderMask(element, true);

    act(() => scrollTo(120));
    expect(result.current).toBe(TOP_FADE_MASK_STYLE);

    act(() => scrollTo(0));
    expect(result.current).toBeUndefined();
  });

  it("picks up a surface that is already scrolled when it mounts", () => {
    const { element } = createScrollElement(400);
    const { result } = renderMask(element, true);
    expect(result.current).toBe(TOP_FADE_MASK_STYLE);
  });

  it("ignores sub-pixel offsets from momentum scrolling", () => {
    const { element, scrollTo } = createScrollElement();
    const { result } = renderMask(element, true);

    act(() => scrollTo(0.5));
    expect(result.current).toBeUndefined();
  });

  it("stays off while the preference is disabled, even when scrolled", () => {
    const { element, scrollTo } = createScrollElement(500);
    const { result } = renderMask(element, false);
    expect(result.current).toBeUndefined();

    act(() => scrollTo(900));
    expect(result.current).toBeUndefined();
  });

  it("clears an active mask when the preference is turned off mid-session", () => {
    const { element, scrollTo } = createScrollElement();
    const { result, rerender } = renderMask(element, true);

    act(() => scrollTo(300));
    expect(result.current).toBe(TOP_FADE_MASK_STYLE);

    rerender({ on: false });
    expect(result.current).toBeUndefined();
  });

  it("re-attaches and reflects current scroll when the preference is turned back on", () => {
    const { element, scrollTo } = createScrollElement();
    const { result, rerender } = renderMask(element, true);

    act(() => scrollTo(300));
    rerender({ on: false });
    expect(result.current).toBeUndefined();

    rerender({ on: true });
    expect(result.current).toBe(TOP_FADE_MASK_STYLE);
  });

  it("does not throw when the ref has no node", () => {
    const { result } = renderMask(null, true);
    expect(result.current).toBeUndefined();
  });

  it("removes its scroll listener on unmount", () => {
    const { element, scrollTo } = createScrollElement();
    const { result, unmount } = renderMask(element, true);

    unmount();
    // A scroll after unmount must not reach the unmounted hook's state setter.
    expect(() => act(() => scrollTo(500))).not.toThrow();
    expect(result.current).toBeUndefined();
  });
});
