import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderHook } from "@testing-library/react";
import { useStaleDragRecovery } from "./useStaleDragRecovery";

describe("stale drag recovery", () => {
  const libraryEscape = vi.fn((event: KeyboardEvent) => event.code);
  const appEscape = vi.fn();
  document.addEventListener("keydown", libraryEscape);
  window.addEventListener("keydown", appEscape);
  afterEach(() => {
    libraryEscape.mockClear();
    appEscape.mockClear();
  });

  it("ends a drag whose release never arrived on the next primary press", () => {
    const reset = vi.fn();
    renderHook(() => useStaleDragRecovery(true, reset));
    fireEvent.pointerDown(window, { button: 0 });
    expect(reset).toHaveBeenCalledOnce();
    // dnd-kit's document listener cancels its drag...
    expect(libraryEscape).toHaveBeenCalledOnce();
    expect(libraryEscape.mock.results[0]?.value).toBe("Escape");
    // ...and the app's Escape shortcuts (close the card, clear the selection) never run.
    expect(appEscape).not.toHaveBeenCalled();
  });

  it("ignores other buttons", () => {
    const reset = vi.fn();
    renderHook(() => useStaleDragRecovery(true, reset));
    fireEvent.pointerDown(window, { button: 2 });
    expect(reset).not.toHaveBeenCalled();
  });

  it("does nothing while no drag is recorded", () => {
    const reset = vi.fn();
    renderHook(() => useStaleDragRecovery(false, reset));
    fireEvent.pointerDown(window, { button: 0 });
    expect(reset).not.toHaveBeenCalled();
    expect(libraryEscape).not.toHaveBeenCalled();
  });
});
