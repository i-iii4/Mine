import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptySpaceOnboarding } from "./EmptySpaceOnboarding";

describe("EmptySpaceOnboarding", () => {
  it("offers both ways to fill a space and does not offer the cancelled import", async () => {
    render(
      <EmptySpaceOnboarding
        viewportHeight={800}
        onInstallClipper={vi.fn()}
      />,
    );

    // An empty Everything route used to say nothing at all, leaving the
    // extension — the main way anything gets in — undiscoverable. One column
    // now: the way that needs no button is a line of text, not a half-empty
    // second column.
    expect(screen.getByText(/The extension brings pages/)).toBeInTheDocument();
    expect(screen.getByText(/drag images, videos and documents/i)).toBeInTheDocument();
    // The Are.na import was cancelled for this version and must not be offered.
    expect(screen.queryByText(/Are\.na/)).not.toBeInTheDocument();
  });

  it("starts the extension setup", async () => {
    const onInstallClipper = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptySpaceOnboarding
        viewportHeight={800}
        onInstallClipper={onInstallClipper}
      />,
    );

    await user.click(screen.getByRole("button", { name: /install the extension/i }));
    expect(onInstallClipper).toHaveBeenCalled();
  });

});
