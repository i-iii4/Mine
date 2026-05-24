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

describe("useGridScroll", () => {
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
