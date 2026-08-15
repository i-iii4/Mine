import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptySpaceOnboarding } from "./EmptySpaceOnboarding";

describe("EmptySpaceOnboarding", () => {
  it("offers all three ways to fill a space", async () => {
    render(
      <EmptySpaceOnboarding
        viewportHeight={800}
        onInstallClipper={vi.fn()}
        onImportFromArena={vi.fn()}
      />,
    );

    // An empty Everything route used to say nothing at all, leaving the clipper
    // — the main way anything gets in — undiscoverable.
    expect(screen.getByText(/Save from the web/)).toBeInTheDocument();
    expect(screen.getByText(/Drag files in/)).toBeInTheDocument();
    expect(screen.getByText(/Bring a collection/)).toBeInTheDocument();
  });

  it("starts the clipper setup", async () => {
    const onInstallClipper = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptySpaceOnboarding
        viewportHeight={800}
        onInstallClipper={onInstallClipper}
        onImportFromArena={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /install the clipper/i }));
    expect(onInstallClipper).toHaveBeenCalled();
  });

  it("reaches the Are.na import, which had no entry point at all", async () => {
    const onImportFromArena = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptySpaceOnboarding
        viewportHeight={800}
        onInstallClipper={vi.fn()}
        onImportFromArena={onImportFromArena}
      />,
    );

    await user.click(screen.getByRole("button", { name: /import from are\.na/i }));
    expect(onImportFromArena).toHaveBeenCalled();
  });
});
