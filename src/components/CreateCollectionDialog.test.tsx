import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CreateCollectionDialog, NEW_COLLECTION_DESCRIPTION } from "./CreateCollectionDialog";
import { CreateCollectionNameDialog } from "./TopCollectionSwitcher";

// DESIGN_SYSTEM.md, «Тексты окон»: `New collection` shows no description;
// the screen reader hears one hidden line, the same on both paths.
describe("New collection description", () => {
  it("is one hidden line for the screen reader", () => {
    expect(NEW_COLLECTION_DESCRIPTION).toBe("Name the new collection.");
  });

  it("is hidden in the window opened with the sidebar closed", () => {
    render(<CreateCollectionDialog open onOpenChange={vi.fn()} onCreate={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "New collection" });
    expect(dialog).toHaveAccessibleDescription(NEW_COLLECTION_DESCRIPTION);
    expect(screen.getByText(NEW_COLLECTION_DESCRIPTION)).toHaveClass("sr-only");
  });

  it("is hidden in the collection switcher's window", () => {
    render(
      <CreateCollectionNameDialog
        open
        name=""
        error={null}
        creating={false}
        onOpenChange={vi.fn()}
        onNameChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "New collection" });
    expect(dialog).toHaveAccessibleDescription(NEW_COLLECTION_DESCRIPTION);
    expect(screen.getByText(NEW_COLLECTION_DESCRIPTION)).toHaveClass("sr-only");
  });
});
