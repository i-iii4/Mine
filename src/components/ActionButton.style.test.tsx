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

  it("encloses the hotkey, not the action name", () => {
    render(<ActionButton hotkey="⌘F">Search</ActionButton>);

    // The hotkey is the fixed, glyph-like half and reads as a key cap when
    // enclosed; the action name is prose and stays open.
    expect(screen.getByText("⌘F").className).toContain("bg-component-fill-inner");
    expect(screen.getByText("Search").className).not.toContain("bg-component-fill-inner");
  });

  it("puts the hotkey in a frame and the label beside it when standard", () => {
    applyActionButtonStyle("standard");
    render(<ActionButton hotkey="⌘F">Search</ActionButton>);

    // One control covering both halves: the label is part of the target, not a
    // caption sitting next to a smaller button.
    const control = screen.getByRole("button");
    expect(control.dataset.actionButton).toBe("standard");
    expect(control).toHaveTextContent("⌘F");
    expect(control).toHaveTextContent("Search");
    expect(control.querySelector("button")).toBeNull();
  });

  it("activates from the label, not just the frame", () => {
    const onClick = vi.fn();
    applyActionButtonStyle("standard");
    render(<ActionButton hotkey="⌘F" onClick={onClick}>Search</ActionButton>);

    screen.getByText("Search").click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("separates the pair from the next control", () => {
    applyActionButtonStyle("standard");
    render(<ActionButton hotkey="⌘F">Search</ActionButton>);
    // The bar's own gap equals the gap inside the pair, so without this the
    // label runs into the following button.
    expect(screen.getByRole("button").className).toContain("mr-2");
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

    const frame = screen.getByText("⌘F");
    // Same baseline as the pill presentation's inner fill.
    expect(frame.className).toContain("h-5");
    // Reference material at rest, foreground only when the pair is hovered.
    expect(frame.className).toContain("text-muted-foreground");
    expect(frame.className).toContain("group-hover:text-foreground");
  });

  it("leaves the label unchanged on hover", () => {
    applyActionButtonStyle("standard");
    render(<ActionButton hotkey="⌘F">Search</ActionButton>);

    // Lighting both halves at once reads as a blinking block, not one control.
    const label = screen.getByText("Search");
    expect(label.className).toContain("text-muted-foreground");
    expect(label.className).not.toContain("group-hover:");
    expect(label.className).not.toContain("hover:");
  });

  it("collapses to a labelled frame when there is no hotkey", () => {
    applyActionButtonStyle("standard");
    render(<ActionButton>Design</ActionButton>);
    // Nothing to place inside, so the label moves in rather than standing alone.
    expect(screen.getByRole("button")).toHaveTextContent("Design");
    expect(screen.getAllByText("Design")).toHaveLength(1);
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
