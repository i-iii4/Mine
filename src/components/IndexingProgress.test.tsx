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

  it("never draws past the end, whatever the numbers say", () => {
    const { container } = render(
      <IndexingProgress spaceName="Mine" processed={5000} total={3000} />,
    );
    const bar = container.querySelector('[data-indexing-progress] .bg-foreground') as HTMLElement;
    expect(bar.style.width).toBe("100%");
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

  it("stays at zero width for an empty total instead of dividing by it", () => {
    const { container } = render(<IndexingProgress spaceName="Mine" processed={0} total={0} />);
    const bar = container.querySelector('[data-indexing-progress] .bg-foreground') as HTMLElement;
    expect(bar.style.width).toBe("0%");
  });
});
