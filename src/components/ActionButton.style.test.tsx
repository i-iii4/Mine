import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActionButton } from "./ActionButton";
import { applyActionButtonStyle } from "@/lib/actionButtonStyle";

describe("ActionButton presentation", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-action-button-style");
  });

  it("defaults to the pill presentation", () => {
    render(<ActionButton hotkey="⌘F">Search</ActionButton>);
    const node = screen.getByRole("button");
    expect(node.dataset.actionButton).toBe("pill");
    expect(node).toHaveTextContent("⌘F");
    expect(node).toHaveTextContent("Search");
  });

  it("puts the hotkey in a button and the label beside it when standard", () => {
    applyActionButtonStyle("standard");
    render(<ActionButton hotkey="⌘F">Search</ActionButton>);

    // The hotkey is the button's own content; the label is its sibling.
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("⌘F");
    expect(button).not.toHaveTextContent("Search");
    expect(screen.getByText("Search")).toBeInTheDocument();
  });

  it("keeps behaviour identical across presentations", async () => {
    const onClick = vi.fn();
    applyActionButtonStyle("standard");
    const { unmount } = render(<ActionButton hotkey="⌘F" onClick={onClick}>Search</ActionButton>);
    screen.getByRole("button").click();
    expect(onClick).toHaveBeenCalledTimes(1);
    unmount();

    applyActionButtonStyle("pill");
    render(<ActionButton hotkey="⌘F" onClick={onClick}>Search</ActionButton>);
    screen.getByRole("button").click();
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("matches the inner pill height and keeps the hotkey secondary at rest", () => {
    applyActionButtonStyle("standard");
    render(<ActionButton hotkey="⌘F">Search</ActionButton>);

    const button = screen.getByRole("button");
    // Same baseline as the pill presentation's inner fill.
    expect(button.className).toContain("h-5");
    // Reference material at rest, foreground only under the pointer.
    expect(button.className).toContain("text-muted-foreground");
    expect(button.className).toContain("hover:text-foreground");
    expect(screen.getByText("Search").className).toContain("text-muted-foreground");
  });

  it("collapses to a labelled button when there is no hotkey", () => {
    applyActionButtonStyle("standard");
    render(<ActionButton>Design</ActionButton>);
    // Nothing to place inside, so the label moves in rather than standing alone.
    expect(screen.getByRole("button")).toHaveTextContent("Design");
  });

  it("switches presentation without remounting call sites", () => {
    const { rerender } = render(<ActionButton hotkey="⌘F">Search</ActionButton>);
    expect(screen.getByRole("button").dataset.actionButton).toBe("pill");

    applyActionButtonStyle("standard");
    rerender(<ActionButton hotkey="⌘F">Search</ActionButton>);
    expect(
      document.querySelector('[data-action-button="standard"]'),
    ).toBeInTheDocument();
  });
});
