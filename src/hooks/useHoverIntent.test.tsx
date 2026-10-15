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
