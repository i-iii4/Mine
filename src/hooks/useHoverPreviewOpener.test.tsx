import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOVER_PREVIEW_COLD_OPEN_DELAY_MS } from "@/lib/hoverPreviewTiming";
import { useHoverPreviewOpener } from "./useHoverPreviewOpener";

describe("useHoverPreviewOpener (SPEC_CARD_STATES.md, С7.10)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the latest resting check, and keeps one opener over renders", () => {
    const show = vi.fn();
    const { result, rerender } = renderHook(({ resting }) => useHoverPreviewOpener(() => resting), {
      initialProps: { resting: false },
    });
    const opener = result.current;
    opener.request(show);
    rerender({ resting: true });
    expect(result.current).toBe(opener);
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("drops a request on the way when the surface goes", () => {
    const show = vi.fn();
    const { result, unmount } = renderHook(() => useHoverPreviewOpener(() => true));
    result.current.request(show);
    unmount();
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    expect(show).not.toHaveBeenCalled();
  });
});
