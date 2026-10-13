import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EXTENSION_INSTALL_STEP, EmptySpaceOnboarding } from "./EmptySpaceOnboarding";

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

  it("shows the extension folder and says how to load it, right here", async () => {
    // Settings no longer has an Extension section (SPEC_ONBOARDING.md, О16):
    // the steps live where a new person first meets the extension.
    const onInstallClipper = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptySpaceOnboarding
        viewportHeight={800}
        onInstallClipper={onInstallClipper}
      />,
    );
    expect(screen.queryByText(EXTENSION_INSTALL_STEP)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /install the extension/i }));
    expect(onInstallClipper).toHaveBeenCalledOnce();
    expect(await screen.findByRole("status")).toHaveTextContent("Load unpacked");
  });

  /// SPEC_DEEP_AUDIT.md, Е6.6: the step says the folder "opened in Finder"
  /// only once Finder has shown it; before, it said so before the answer and
  /// after a failure.
  it("says the folder opened only after Finder showed it, and why it did not", async () => {
    let answer!: { resolve: () => void; reject: (error: Error) => void };
    const onInstallClipper = vi.fn(() => new Promise<void>((resolve, reject) => {
      answer = { resolve, reject };
    }));
    const user = userEvent.setup();
    const { unmount } = render(
      <EmptySpaceOnboarding viewportHeight={800} onInstallClipper={onInstallClipper} />,
    );

    await user.click(screen.getByRole("button", { name: /install the extension/i }));
    expect(screen.queryByText(EXTENSION_INSTALL_STEP)).not.toBeInTheDocument();

    await act(async () => answer.reject(new Error("The extension folder is missing from the app.")));
    expect(screen.queryByText(EXTENSION_INSTALL_STEP)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The extension folder is missing from the app.");

    await user.click(screen.getByRole("button", { name: /install the extension/i }));
    await act(async () => answer.resolve());
    expect(screen.getByRole("status")).toHaveTextContent("Load unpacked");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();
  });
});
