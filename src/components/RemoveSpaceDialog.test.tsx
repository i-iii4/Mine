import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RemoveSpaceDialog } from "./RemoveSpaceDialog";

/// SPEC_DEEP_AUDIT.md, Е6.9: one question before a space leaves the list,
/// for the space switcher and for Settings. It names the space by its folder
/// and says the folder stays.
describe("RemoveSpaceDialog", () => {
  it("names the space and removes it only on Remove", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<RemoveSpaceDialog path="/Users/me/Mine/" onCancel={onCancel} onConfirm={onConfirm} />);
    expect(screen.getByRole("alertdialog", { name: "Remove Mine from the list?" })).toBeInTheDocument();
    expect(screen.getByText(/The folder and its files stay where they are\./)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledWith("/Users/me/Mine/");
  });

  it("keeps the space on Cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<RemoveSpaceDialog path="/Users/me/Mine" onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("asks nothing while no space is named", () => {
    render(<RemoveSpaceDialog path={null} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
