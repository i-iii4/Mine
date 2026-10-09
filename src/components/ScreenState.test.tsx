// One layout for every screen that stands in for the feed or the window
// (DESIGN_SYSTEM.md, «Полноэкранные состояния»).

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScreenState } from "./ScreenState";

describe("ScreenState", () => {
  it("lays the dialog's anatomy on the page: a dialog-wide column, 8px in the header, 16px between parts", () => {
    const { container } = render(
      <ScreenState title="Folder unavailable" description="Mine did not move anything." actions={<button>Locate</button>}>
        <p>Note</p>
      </ScreenState>,
    );
    const column = container.querySelector("[data-screen-state]");
    expect(column).toHaveClass("grid", "w-full", "max-w-lg", "gap-4", "text-left");
    const title = screen.getByRole("heading", { name: "Folder unavailable" });
    expect(title).toHaveClass("text-lg", "font-semibold", "text-foreground");
    expect(title.parentElement).toHaveClass("grid", "gap-2");
    expect(screen.getByRole("button", { name: "Locate" }).parentElement).toHaveClass("flex", "items-center", "gap-2");
    expect(column?.lastElementChild).toHaveTextContent("Note");
  });

  it("mutes the text under a title and keeps it in the foreground as the screen's first line", () => {
    const { rerender } = render(<ScreenState title="Nothing here yet" description="Text" actions={null} />);
    expect(screen.getByText("Text")).toHaveClass("text-base", "text-muted-foreground");

    rerender(<ScreenState description="Text" actions={null} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Text")).toHaveClass("text-base", "text-foreground");
  });
});
