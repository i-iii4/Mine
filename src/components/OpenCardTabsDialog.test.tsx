import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OPEN_CARD_TABS_DESCRIPTION, OpenCardTabsDialog } from "./OpenCardTabsDialog";

/// SPEC_TABS.md, В86, п. 6: a drop that opens many tabs asks first.
describe("Open N tabs?", () => {
  it("names the tabs and opens them on Open", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<OpenCardTabsDialog count={18} onCancel={onCancel} onConfirm={onConfirm} />);

    const dialog = screen.getByRole("alertdialog", { name: "Open 18 tabs?" });
    expect(dialog).toHaveAccessibleDescription(OPEN_CARD_TABS_DESCRIPTION);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("opens nothing on Cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<OpenCardTabsDialog count={15} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("is closed without a count", () => {
    render(<OpenCardTabsDialog count={null} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
