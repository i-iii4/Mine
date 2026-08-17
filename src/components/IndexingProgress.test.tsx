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

  it("stays at zero width for an empty total instead of dividing by it", () => {
    const { container } = render(<IndexingProgress spaceName="Mine" processed={0} total={0} />);
    const bar = container.querySelector('[data-indexing-progress] .bg-foreground') as HTMLElement;
    expect(bar.style.width).toBe("0%");
  });
});
