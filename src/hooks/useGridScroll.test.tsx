import { render, act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCallback, useRef } from "react";
import { useGridScroll } from "./useGridScroll";
import type { MasonryPosition } from "@/lib/masonryLayout";

function position(index: number, top: number): MasonryPosition {
  return {
    index,
    top,
    left: 0,
    width: 100,
    height: 80,
    bottom: top + 80,
    column: 0,
  };
}

function visibleForViewport(
  positions: readonly MasonryPosition[],
  scrollTop: number,
  viewportHeight: number,
): MasonryPosition[] {
  const viewportBottom = scrollTop + viewportHeight;
  return positions.filter((item) => item.bottom >= scrollTop && item.top <= viewportBottom);
}

function Harness({
  positions,
  viewportHeight,
}: {
  positions: MasonryPosition[];
  viewportHeight?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const getVisibleItems = useCallback(
    (scrollTop: number) => visibleForViewport(positions, scrollTop, 100),
    [positions],
  );
  const visible = useGridScroll(scrollRef, {
    getVisibleItems,
    resetKey: "test",
    viewportHeight,
  });

  return (
    <div ref={scrollRef} data-testid="scroll">
      <div data-testid="visible">{visible.map((item) => item.index).join(",")}</div>
    </div>
  );
}

function CountingHarness({
  positions,
  overscan,
}: {
  positions: MasonryPosition[];
  overscan: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const getVisibleItems = useCallback(
    (scrollTop: number) => visibleForViewport(positions, scrollTop, 100 + overscan),
    [positions, overscan],
  );
  const visible = useGridScroll(scrollRef, {
    getVisibleItems,
    resetKey: "count",
    viewportHeight: 100,
  });

  return (
    <div ref={scrollRef} data-testid="scroll">
      <div data-testid="rendercount">{renderCountRef.current}</div>
      <div data-testid="visible">{visible.map((item) => item.index).join(",")}</div>
    </div>
  );
}

describe("useGridScroll", () => {
  it("does not bump render state when a readiness-window change leaves the visible set identical", () => {
    // item 1 sits at top 500, far outside both the 100 px viewport and the
    // widened overscan below, so it never enters the visible set.
    const positions = [position(0, 0), position(1, 500), position(2, 1000)];

    const { rerender } = render(
      <CountingHarness positions={positions} overscan={0} />,
    );
    expect(screen.getByTestId("visible")).toHaveTextContent("0");
    const before = Number(screen.getByTestId("rendercount").textContent);

    // Widen the overscan enough to change getVisibleItems identity but not
    // enough to pull item 1 into view. This mirrors a velocity ripple changing
    // the readiness window without changing which cards are mounted.
    act(() => {
      rerender(<CountingHarness positions={positions} overscan={150} />);
    });

    expect(screen.getByTestId("visible")).toHaveTextContent("0");
    const after = Number(screen.getByTestId("rendercount").textContent);
    // Exactly one render for the prop change itself. The identity-change effect
    // must not bump scrollTick because the visible set did not change.
    expect(after - before).toBe(1);
  });

  it("synchronously updates the visible window when a native scroll jump would blank the viewport", () => {
    const positions = [
      position(0, 0),
      position(1, 120),
      position(2, 240),
      position(99, 12000),
    ];

    render(<Harness positions={positions} />);

    const scroll = screen.getByTestId("scroll");
    Object.defineProperty(scroll, "clientHeight", {
      value: 100,
      configurable: true,
    });

    expect(screen.getByTestId("visible")).toHaveTextContent("0");

    act(() => {
      scroll.scrollTop = 12000;
      scroll.dispatchEvent(new Event("scroll"));
    });

    expect(screen.getByTestId("visible")).toHaveTextContent("99");
  });

  it("uses the measured viewport height when clientHeight is not available yet", () => {
    const positions = [
      position(0, 0),
      position(1, 120),
      position(2, 240),
      position(99, 12000),
    ];

    render(<Harness positions={positions} viewportHeight={100} />);

    const scroll = screen.getByTestId("scroll");
    Object.defineProperty(scroll, "clientHeight", {
      value: 0,
      configurable: true,
    });

    expect(screen.getByTestId("visible")).toHaveTextContent("0");

    act(() => {
      scroll.scrollTop = 12000;
      scroll.dispatchEvent(new Event("scroll"));
    });

    expect(screen.getByTestId("visible")).toHaveTextContent("99");
  });
});
