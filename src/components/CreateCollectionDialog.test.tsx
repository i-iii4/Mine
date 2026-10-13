import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CreateCollectionDialog, NEW_COLLECTION_DESCRIPTION } from "./CreateCollectionDialog";

/** A refusal as `createChannel` throws it: an Error whose cause is the
 *  command's `name_refused`. */
function nameRefused(message: string): Error {
  return Object.assign(new Error(message), { cause: { kind: "name_refused", message } });
}

// DESIGN_SYSTEM.md, «Тексты окон»: `New collection` shows no description;
// the screen reader hears one hidden line.
describe("New collection description", () => {
  it("is one hidden line for the screen reader", () => {
    expect(NEW_COLLECTION_DESCRIPTION).toBe("Name the new collection.");
  });

  it("is hidden in the window", () => {
    render(<CreateCollectionDialog open onOpenChange={vi.fn()} onCreate={vi.fn(async () => undefined)} />);

    const dialog = screen.getByRole("dialog", { name: "New collection" });
    expect(dialog).toHaveAccessibleDescription(NEW_COLLECTION_DESCRIPTION);
    expect(screen.getByText(NEW_COLLECTION_DESCRIPTION)).toHaveClass("sr-only");
  });
});

/// SPEC_DEEP_AUDIT.md, Е6.2: one window names a new collection wherever it
/// is made from (the closed sidebar's ⇧⌘N, the collection switcher), with
/// the one check of the name and the reason under the field.
describe("New collection window", () => {
  it("checks the name as it is typed and offers no Create for a refused one", async () => {
    const onCheckName = vi.fn(async (name: string) => (
      name === "alpha" ? "A collection named \"alpha\" already exists." : null
    ));
    render(
      <CreateCollectionDialog open onOpenChange={vi.fn()} onCheckName={onCheckName} onCreate={vi.fn()} />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Collection name" }), { target: { value: "alpha" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("A collection named \"alpha\" already exists.");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("stays open with the reason when the creation is refused", async () => {
    const onOpenChange = vi.fn();
    const onCreate = vi.fn(async () => {
      throw nameRefused("A new collection cannot be in a folder: type its name without /.");
    });
    render(<CreateCollectionDialog open onOpenChange={onOpenChange} onCreate={onCreate} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Collection name" }), { target: { value: "a/b" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A new collection cannot be in a folder: type its name without /.",
    );
    expect(onCreate).toHaveBeenCalledWith("a/b");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("shows Creating… until the answer and closes after a creation that was made", async () => {
    let made!: () => void;
    const onOpenChange = vi.fn();
    const onCreate = vi.fn(() => new Promise<void>((resolve) => { made = resolve; }));
    render(
      <CreateCollectionDialog open initialName="Reading" onOpenChange={onOpenChange} onCreate={onCreate} />,
    );

    expect(screen.getByRole("textbox", { name: "Collection name" })).toHaveValue("Reading");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => made());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onCreate).toHaveBeenCalledWith("Reading");
  });
});
