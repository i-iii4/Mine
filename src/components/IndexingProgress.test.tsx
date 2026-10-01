// Numbers, a moving bar, and no lies at the edges.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IndexingProgress } from "./IndexingProgress";

describe("IndexingProgress", () => {
  it("counts the work out loud", () => {
    render(<IndexingProgress spaceName="Mine" processed={1284} total={3000} />);
    expect(screen.getByText("Indexing “Mine”")).toBeInTheDocument();
    expect(screen.getByText("1284 / 3000")).toBeInTheDocument();
  });

  it("draws the bar with the shared Progress, moved by transform (Г5.4)", () => {
    render(<IndexingProgress spaceName="Mine" processed={1500} total={3000} />);
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
    render(<IndexingProgress spaceName="Mine" processed={5000} total={3000} />);
    const fill = screen.getByRole("progressbar")
      .querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    expect(fill?.style.transform).toBe("translateX(-0%)");
  });

  it("is a progress bar a screen reader can read (А6.14)", () => {
    render(<IndexingProgress spaceName="Mine" processed={1284} total={3000} />);
    const bar = screen.getByRole("progressbar", { name: "Indexing “Mine”" });
    expect(bar).toHaveAttribute("aria-valuenow", "1284");
    expect(bar).toHaveAttribute("aria-valuemax", "3000");
    expect(bar).toHaveAttribute("aria-valuetext", "1284 of 3000");
  });

  it("announces the progress politely, in tenths", () => {
    const { rerender } = render(<IndexingProgress spaceName="Mine" processed={1284} total={3000} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Indexing “Mine”: 40%");

    // Counts inside the same tenth say nothing new.
    rerender(<IndexingProgress spaceName="Mine" processed={1290} total={3000} />);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing “Mine”: 40%");

    rerender(<IndexingProgress spaceName="Mine" processed={1500} total={3000} />);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing “Mine”: 50%");
  });

  it("stays empty for an empty total instead of dividing by it", () => {
    render(<IndexingProgress spaceName="Mine" processed={0} total={0} />);
    const fill = screen.getByRole("progressbar")
      .querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    expect(fill?.style.transform).toBe("translateX(-100%)");
  });
});
