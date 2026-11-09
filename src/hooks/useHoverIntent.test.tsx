import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import { useHoverIntent, type HoverIntentHandle } from "./useHoverIntent";

/** Enter `target` at `x`, then rest on it past the dwell. */
function restOn(intent: HoverIntentHandle, target: string, x: number) {
  act(() => {
    intent.move(target, x, 100);
    vi.advanceTimersByTime(100);
    intent.move(target, x + 1, 100);
    vi.advanceTimersByTime(HOVER_INTENT.dwellMs + 50);
  });
}

describe("useHoverIntent without window focus (PLAN 46.14, SPEC_CARD_STATES.md, С7.8)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps answering the pointer when the window loses focus", () => {
    const { result } = renderHook(() => useHoverIntent());
    restOn(result.current, "a", 0);
    expect(result.current.current().chosen).toBe("a");

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current.current().chosen).toBe("a");

    restOn(result.current, "b", 200);
    expect(result.current.current().chosen).toBe("b");
  });

  it("still holds the answers while a drag suspends them", () => {
    const { result } = renderHook(() => useHoverIntent());
    restOn(result.current, "a", 0);
    act(() => {
      result.current.suspend("drag", true);
    });
    expect(result.current.current().chosen).toBeNull();
  });
});

describe("the lift's speed rule through the hook (SPEC_CARD_STATES.md, С8.6)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Fast steps over `target`: 20 px every 8 ms. */
  function sweep(intent: HoverIntentHandle, target: string, from: number) {
    act(() => {
      for (let step = 0; step < 4; step += 1) {
        vi.advanceTimersByTime(8);
        intent.move(target, from + step * 20, 100);
      }
    });
  }

  it("lifts nothing under a sweep and lifts the card the pointer stops on", () => {
    const { result } = renderHook(() => useHoverIntent());
    sweep(result.current, "a", 0);
    expect(result.current.current().raised).toBeNull();
    act(() => vi.advanceTimersByTime(HOVER_INTENT.velocityWindowMs));
    expect(result.current.current().raised).toBe("a");
  });
});
