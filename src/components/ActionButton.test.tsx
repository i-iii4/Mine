import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionButton } from "./ActionButton";

describe("ActionButton", () => {
  it("uses fixed inner text boxes for vertical centering in 24px chrome buttons", () => {
    render(
      <ActionButton hotkey="⌘F" onClick={vi.fn()}>
        Search elements
      </ActionButton>,
    );

    const button = screen.getByRole("button", { name: /Search elements/ });
    expect(button).toHaveClass(
      "h-6",
      "p-[2px]",
      "items-center",
      "bg-transparent",
      "hover:bg-active",
    );
    expect(button).not.toHaveClass("hover:bg-component-fill-hover");

    const hotkey = screen.getByText("⌘F");
    expect(hotkey).toHaveClass("inline-flex", "h-5", "items-center", "leading-none");
    expect(hotkey).not.toHaveClass("py-[2px]");

    const label = screen.getByText("Search elements");
    expect(label).toHaveClass("inline-flex", "h-5", "items-center", "leading-none");
    expect(label).not.toHaveClass("py-[2px]");
  });

  it("uses the shared active surface for selected state", () => {
    render(<ActionButton isSelected>Design</ActionButton>);

    const button = screen.getByRole("button", { name: "Design" });
    expect(button).toHaveClass("bg-active");
    expect(button).not.toHaveClass("bg-component-fill-hover");
  });
});
