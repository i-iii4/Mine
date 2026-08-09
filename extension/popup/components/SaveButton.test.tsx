import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SaveButton } from "./SaveButton";

describe("SaveButton", () => {
  it("names the destination count while idle", () => {
    const onClick = vi.fn();
    render(<SaveButton count={2} state="idle" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Save to 2 collections" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("replaces itself with the indeterminate bar while saving", () => {
    const { container } = render(<SaveButton count={0} state="saving" onClick={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(".mine-progress-indicator")).not.toBeNull();
  });

  it("carries success on the button itself — no separate status strip", () => {
    render(<SaveButton count={0} state="saved" onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Saved" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-clipper-saved");
  });
});
