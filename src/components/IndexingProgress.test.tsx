// Numbers, a moving bar, and no lies at the edges.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { INDEXING_NOTICE_DELAY_MS, IndexingProgress, useIndexingNotice } from "./IndexingProgress";

describe("IndexingProgress", () => {
  it("counts the work out loud", () => {
    render(<IndexingProgress spaceName="Mine" processed={1284} total={3000} onClose={() => {}} />);
    expect(screen.getByText("Indexing “Mine”")).toBeInTheDocument();
    expect(screen.getByText("1284 / 3000")).toBeInTheDocument();
  });

  it("draws the bar with the shared Progress, moved by transform (Г5.4)", () => {
    render(<IndexingProgress spaceName="Mine" processed={1500} total={3000} onClose={() => {}} />);
    const bar = screen.getByRole("progressbar", { name: "Indexing “Mine”" });
    expect(bar).toHaveAttribute("data-slot", "progress");
    expect(bar).toHaveAttribute("data-progress-mode", "determinate");
    const fill = bar.querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    expect(fill).not.toBeNull();
    // A pill fill inside a pill track, and the fill slides rather than
    // resizing: no width is animated (DESIGN_SYSTEM.md, Progress).
    expect(bar.className).toContain("rounded-pill");
    expect(fill?.className).toContain("rounded-pill");
    expect(fill?.style.transform).toBe("translateX(-50%)");
    expect(fill?.style.width).toBe("");
    expect(fill?.className).not.toContain("transition-[width]");
  });

  it("never draws past the end, whatever the numbers say", () => {
    render(<IndexingProgress spaceName="Mine" processed={5000} total={3000} onClose={() => {}} />);
    const fill = screen.getByRole("progressbar")
      .querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    expect(fill?.style.transform).toBe("translateX(-0%)");
  });

  it("is a progress bar a screen reader can read (А6.14)", () => {
    render(<IndexingProgress spaceName="Mine" processed={1284} total={3000} onClose={() => {}} />);
    const bar = screen.getByRole("progressbar", { name: "Indexing “Mine”" });
    expect(bar).toHaveAttribute("aria-valuenow", "1284");
    expect(bar).toHaveAttribute("aria-valuemax", "3000");
    expect(bar).toHaveAttribute("aria-valuetext", "1284 of 3000");
  });

  it("announces the progress politely, in tenths", () => {
    const { rerender } = render(<IndexingProgress spaceName="Mine" processed={1284} total={3000} onClose={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Indexing “Mine”: 40%");

    // Counts inside the same tenth say nothing new.
    rerender(<IndexingProgress spaceName="Mine" processed={1290} total={3000} onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing “Mine”: 40%");

    rerender(<IndexingProgress spaceName="Mine" processed={1500} total={3000} onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing “Mine”: 50%");
  });

  it("stays empty for an empty total instead of dividing by it", () => {
    render(<IndexingProgress spaceName="Mine" processed={0} total={0} onClose={() => {}} />);
    const fill = screen.getByRole("progressbar")
      .querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    expect(fill?.style.transform).toBe("translateX(-100%)");
  });

  it("offers another folder while the count shows what this one holds (О12)", () => {
    const onChooseAnother = vi.fn();
    render(<IndexingProgress spaceName="Documents" processed={25} total={3000} onClose={() => {}} onChooseAnother={onChooseAnother} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose another folder" }));
    expect(onChooseAnother).toHaveBeenCalledOnce();
  });

  it("is a notification card in the corner, digits in the interface's font", () => {
    const onClose = vi.fn();
    const { container } = render(<IndexingProgress spaceName="Mine" processed={1284} total={3000} onClose={onClose} />);
    expect(container.querySelector("[data-notification-card]")).not.toBeNull();
    const count = screen.getByText("1284 / 3000");
    expect(count).toHaveClass("text-sm", "tabular-nums");
    expect(count).not.toHaveClass("font-mono");
    expect(screen.queryByRole("button", { name: "Choose another folder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows only a pass that runs past the delay, and stays hidden once hidden", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ count }: { count: { processed: number; total: number } | null }) => useIndexingNotice(count),
        { initialProps: { count: { processed: 1, total: 10 } as { processed: number; total: number } | null } },
      );
      expect(result.current.visible).toBe(false);
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS - 1));
      expect(result.current.visible).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(result.current.visible).toBe(true);
      act(() => result.current.hide());
      expect(result.current.visible).toBe(false);
      rerender({ count: { processed: 5, total: 10 } });
      expect(result.current.visible).toBe(false);

      // A short pass ends before the delay and never shows.
      rerender({ count: null });
      rerender({ count: { processed: 1, total: 3 } });
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS / 2));
      rerender({ count: null });
      act(() => vi.advanceTimersByTime(INDEXING_NOTICE_DELAY_MS));
      expect(result.current.visible).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
