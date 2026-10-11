import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RenameBlockDialog } from "./RenameBlockDialog";

describe("RenameBlockDialog", () => {
  // DESIGN_SYSTEM.md, «Тексты окон»: what the rename takes along.
  it("says the media named after the element and the links follow it", () => {
    render(
      <RenameBlockDialog
        open
        currentSlug="Old Name"
        onOpenChange={vi.fn()}
        onRename={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Rename file" })).toHaveAccessibleDescription(
      "Media files named after this element are renamed with it, and links to it follow the new name.",
    );
  });

  it("submits the new filename stem", async () => {
    const onRename = vi.fn(async () => {});

    render(
      <RenameBlockDialog
        open
        currentSlug="Old Name"
        onOpenChange={vi.fn()}
        onRename={onRename}
      />,
    );

    const input = screen.getByLabelText("Filename");
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith("Old Name", "New Name");
    });
  });

  it("surfaces typed rename errors", async () => {
    const onRename = vi.fn(async () => {
      throw { kind: "name_taken", requested: "Taken" } as const;
    });

    render(
      <RenameBlockDialog
        open
        currentSlug="Old Name"
        onOpenChange={vi.fn()}
        onRename={onRename}
      />,
    );

    fireEvent.change(screen.getByLabelText("Filename"), {
      target: { value: "Taken" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(await screen.findByText('A file named "Taken.md" already exists.')).toBeInTheDocument();
  });
});
