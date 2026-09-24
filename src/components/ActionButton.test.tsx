import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionButton } from "./ActionButton";

describe("ActionButton", () => {
  it("uses the standard key frame and one full action target", () => {
    render(
      <ActionButton hotkey="⌘F" onClick={vi.fn()}>
        Search elements
      </ActionButton>,
    );

    const button = screen.getByRole("button", { name: /Search elements/ });
    expect(button).toHaveClass("items-center", "gap-2");
    expect(button).toHaveAttribute("data-action-button", "standard");

    const hotkey = screen.getByText("⌘F");
    expect(hotkey).toHaveClass("inline-flex", "h-5", "items-center");

    const label = screen.getByText("Search elements");
    expect(label).toHaveClass("whitespace-nowrap", "font-mono");
  });

  it("uses the shared active surface for selected state", () => {
    render(<ActionButton isSelected>Design</ActionButton>);

    const button = screen.getByRole("button", { name: "Design" });
    expect(button).toHaveAttribute("data-selected", "true");
    expect(screen.getByText("Design")).toHaveClass("bg-active");
  });
});
