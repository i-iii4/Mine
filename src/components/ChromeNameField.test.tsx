import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChromeNameField, type ChromeNameFieldHandle } from "./ChromeNameField";
import { TooltipProvider } from "./ui/tooltip";

// The one way a name in the top row's path is renamed in place: the open
// card's file and, since 31.10.2026, the collection the feed shows.
describe("ChromeNameField", () => {
  function field(save: (typed: string) => Promise<void>, resetKey = "one") {
    const element = (key: string) => (
      <TooltipProvider>
        <ChromeNameField
          name="Inbox"
          title="Inbox"
          fieldLabel="Rename collection"
          save={save}
          reasonOf={(error) => (error instanceof Error ? error.message : "Could not rename.")}
          resetKey={key}
          marker="audit-name"
        />
      </TooltipProvider>
    );
    const view = render(element(resetKey));
    return { ...view, rerenderWith: (key: string) => view.rerender(element(key)) };
  }

  // SPEC_FRONTEND.md, «RenameBlockDialog»: the open card's `Rename…` comes in
  // by the click's own way.
  it("opens from elsewhere as a click does: cursor at the end, Enter saves, Escape keeps the name", async () => {
    const save = vi.fn(async () => undefined);
    const ref = createRef<ChromeNameFieldHandle>();
    const { container } = render(
      <TooltipProvider>
        <ChromeNameField
          ref={ref}
          name="Inbox"
          title="Inbox"
          fieldLabel="Rename collection"
          save={save}
          reasonOf={() => "Could not rename."}
          resetKey="one"
          marker="audit-name"
        />
      </TooltipProvider>,
    );

    act(() => ref.current!.startEditing());
    const input = screen.getByRole("textbox", { name: "Rename collection" });
    expect(input).toHaveFocus();
    expect(input).toHaveProperty("selectionStart", "Inbox".length);
    expect(input).toHaveProperty("selectionEnd", "Inbox".length);
    fireEvent.change(input, { target: { value: "Dropped" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Rename collection" })).toBeNull();
    expect(container.querySelector("[data-audit-name]")).toHaveTextContent("Inbox");
    expect(save).not.toHaveBeenCalled();

    act(() => ref.current!.startEditing());
    const again = screen.getByRole("textbox", { name: "Rename collection" });
    fireEvent.change(again, { target: { value: "Saved" } });
    await act(async () => {
      fireEvent.keyDown(again, { key: "Enter" });
    });
    expect(save).toHaveBeenCalledWith("Saved");
  });

  it("keeps the field, the typed name and the reason under it when Enter is refused", async () => {
    const save = vi.fn(async () => {
      throw new Error("A collection named \"Taken\" already exists.");
    });
    const { container } = field(save);
    fireEvent.click(container.querySelector("[data-audit-name]")!);
    const input = screen.getByRole("textbox", { name: "Rename collection" });
    fireEvent.change(input, { target: { value: "Taken" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(save).toHaveBeenCalledWith("Taken");
    // The refused name shakes and stays, with the reason under it.
    await waitFor(() => expect(input).toHaveAttribute("data-name-refused"));
    expect(screen.getByRole("textbox", { name: "Rename collection" })).toHaveValue("Taken");
    expect(document.querySelector("[data-audit-name-notice]")).toHaveTextContent("A collection named \"Taken\" already exists.");
  });

  // User's decision of 01.11.2026: the field is as wide as its text, with the
  // name's 8 px on both sides as at rest; what caps the name caps the field.
  // JSDOM measures nothing: the widths are checked by `test:top-row`.
  it("sizes the field by its text with the name's padding, shrinking as the name at rest does", () => {
    const { container } = field(vi.fn(async () => undefined));
    const rest = container.querySelector("[data-audit-name]")!;
    expect(rest).toHaveClass("px-2", "min-w-0", "truncate");
    fireEvent.click(rest);
    const input = screen.getByRole("textbox", { name: "Rename collection" });
    expect(input).toHaveClass("field-sizing-content", "px-2", "min-w-0");
    // A field stretched over the row would not follow its text.
    expect(input).not.toHaveClass("flex-1");
    expect(container.querySelector("[data-audit-name-anchor]")).toHaveClass("min-w-0");
  });

  it("saves when the field is left, and ends the edit when another thing is named there", async () => {
    const save = vi.fn(async () => undefined);
    const { container, rerenderWith } = field(save);
    fireEvent.click(container.querySelector("[data-audit-name]")!);
    const input = screen.getByRole("textbox", { name: "Rename collection" });
    fireEvent.change(input, { target: { value: "Inbox 2" } });
    fireEvent.blur(input);
    await waitFor(() => expect(save).toHaveBeenCalledWith("Inbox 2"));

    fireEvent.click(container.querySelector("[data-audit-name]")!);
    expect(screen.getByRole("textbox", { name: "Rename collection" })).toBeInTheDocument();
    rerenderWith("two");
    expect(screen.queryByRole("textbox", { name: "Rename collection" })).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
