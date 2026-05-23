import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeMenuButton } from "./ThemeMenuButton";

describe("ThemeMenuButton", () => {
  it("exposes the Compact Detail top menu setting", () => {
    const onCompactDetailTopMenuChange = vi.fn();

    render(
      <ThemeMenuButton
        compactDetailTopMenuEnabled={false}
        onCompactDetailTopMenuChange={onCompactDetailTopMenuChange}
      />,
    );

    const trigger = screen.getByText("Settings").closest("[data-slot='dropdown-menu-trigger']");
    expect(trigger).toBeTruthy();
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(trigger!, { button: 0, ctrlKey: false });
    const item = screen.getByRole("menuitemcheckbox", {
      name: "Compact Detail top menu",
    });

    expect(item).toHaveAttribute("aria-checked", "false");
    fireEvent.click(item);

    expect(onCompactDetailTopMenuChange).toHaveBeenCalledWith(true);
  });
});
