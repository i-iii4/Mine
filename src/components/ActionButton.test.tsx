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
    expect(button).toHaveClass("h-6", "p-[2px]", "items-center");

    const hotkey = screen.getByText("⌘F");
    expect(hotkey).toHaveClass("inline-flex", "h-5", "items-center", "leading-none");
    expect(hotkey).not.toHaveClass("py-[2px]");

    const label = screen.getByText("Search elements");
    expect(label).toHaveClass("inline-flex", "h-5", "items-center", "leading-none");
    expect(label).not.toHaveClass("py-[2px]");
  });
});
