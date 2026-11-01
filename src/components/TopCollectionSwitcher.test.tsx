import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TopCollectionSwitcher } from "./TopCollectionSwitcher";
import { TooltipProvider } from "./ui/tooltip";

// User's decision of 31.10.2026: the place's name in the top row opens no
// menu; a collection's name renames it with a click, as the open card's file
// name does (ChromeNameField).
describe("TopCollectionSwitcher", () => {
  function place(props: Partial<Parameters<typeof TopCollectionSwitcher>[0]> = {}) {
    const onRename = vi.fn(async (_oldTag: string, _name: string) => undefined);
    const view = render(
      <TooltipProvider>
        <TopCollectionSwitcher onRename={onRename} joinsNext {...props} />
      </TooltipProvider>,
    );
    const name = () => view.container.querySelector<HTMLElement>("[data-top-collection-name]")!;
    return { ...view, onRename, name };
  }

  it("names a collection with no menu and no chevron, a text cursor and brighter text under the pointer", () => {
    const { container, name } = place({ currentTag: "Интерфейсы" });
    expect(name()).toHaveTextContent("Интерфейсы");
    expect(name()).toHaveClass("cursor-text", "hover:text-foreground", "font-mono", "text-sm", "text-muted-foreground");
    expect(name()).not.toHaveClass("hover:state-active");
    expect(container.querySelector("button, [data-menu-chevron], [aria-haspopup]")).toBeNull();
    // The path's insets stay: 8 px from the line before it, none after.
    expect(container.querySelector("[data-top-collection-switcher]")).toHaveClass("pl-[var(--top-collection-pad-x)]", "pr-0");
  });

  it("starts the rename with a click and saves on Enter through the sidebar's rename", async () => {
    const { onRename, name } = place({ currentTag: "Интерфейсы" });
    fireEvent.click(name());
    const field = screen.getByRole("textbox", { name: "Rename collection" });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Интерфейсы");
    fireEvent.change(field, { target: { value: "Интерфейсы 2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Интерфейсы", "Интерфейсы 2"));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Rename collection" })).toBeNull());
  });

  // The rename field follows its text up to the place's limit, half the row,
  // as the name at rest does (user's decision of 01.11.2026): every box
  // between the field and the place's slot can shrink to it.
  it("caps the rename field by the place's half of the row", () => {
    const { container, name } = place({ currentTag: "Интерфейсы" });
    fireEvent.click(name());
    const field = screen.getByRole("textbox", { name: "Rename collection" });
    const slot = container.querySelector("[data-top-collection-switcher-slot]")!;
    expect(slot).toHaveClass("max-w-[50%]", "min-w-0");
    for (let box = field.parentElement; box && box !== slot; box = box.parentElement) {
      expect(box).toHaveClass("min-w-0");
    }
    expect(container.querySelector("[data-top-collection-switcher]")).toHaveClass("max-w-full");
  });

  it("keeps the old name on Escape and saves nothing", () => {
    const { onRename, name } = place({ currentTag: "Интерфейсы" });
    fireEvent.click(name());
    const field = screen.getByRole("textbox", { name: "Rename collection" });
    fireEvent.change(field, { target: { value: "Другое" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Rename collection" })).toBeNull();
    expect(name()).toHaveTextContent("Интерфейсы");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("says under the name why a typed name would be refused, by the collection names' one check", async () => {
    const onCheckName = vi.fn(async (_oldTag: string, typed: string) => (
      typed === "Taken" ? "A collection named \"Taken\" already exists." : null
    ));
    const { name } = place({ currentTag: "Интерфейсы", onCheckName });
    fireEvent.click(name());
    const field = screen.getByRole("textbox", { name: "Rename collection" });
    await act(async () => {
      fireEvent.change(field, { target: { value: "Taken" } });
    });
    expect(onCheckName).toHaveBeenCalledWith("Интерфейсы", "Taken");
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(document.querySelector("[data-top-collection-name-notice]")).toHaveTextContent("A collection named \"Taken\" already exists.");
  });

  it.each([
    ["Everything", {}],
    ["an author's feed", { currentAuthor: "@kotecinho" }],
  ])("names %s in plain text that answers nothing", (_place, props) => {
    const { container, name, onRename } = place(props);
    expect(name()).toHaveAttribute("data-top-place-plain");
    expect(name()).not.toHaveClass("cursor-text");
    expect(name().className).not.toMatch(/hover:/);
    fireEvent.click(name());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });
});
