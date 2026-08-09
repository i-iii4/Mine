import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  COLLECTION_PICKER_INLINE_SURFACE_CLASS,
  CollectionPicker,
} from "./CollectionPicker";
import type { TagCount } from "@/types";

function tag(tag: string, count: number): TagCount {
  return { tag, count };
}

function rowTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-collection-picker-row]"))
    .map((row) => row.querySelector("span")?.textContent ?? "");
}

describe("CollectionPicker", () => {
  it("uses the feed card surface for inline picker shells", () => {
    expect(COLLECTION_PICKER_INLINE_SURFACE_CLASS).toContain("bg-card");
    expect(COLLECTION_PICKER_INLINE_SURFACE_CLASS).toContain("text-card-foreground");
    expect(COLLECTION_PICKER_INLINE_SURFACE_CLASS).not.toContain("bg-popover");
    expect(COLLECTION_PICKER_INLINE_SURFACE_CLASS).not.toContain("text-popover-foreground");
  });

  it("keeps channel rows in sidebar order when connection state changes", () => {
    const onToggleTag = vi.fn();
    const { container } = render(
      <CollectionPicker
        blockSlug="alpha"
        selectedTags={["local-first"]}
        tags={[
          tag("tools", 1),
          tag("local-first", 2),
          tag("typography", 3),
        ]}
        onToggleTag={onToggleTag}
        onCreateAndAssign={vi.fn()}
      />,
    );

    expect(rowTitles(container)).toEqual(["tools", "local-first", "typography"]);

    fireEvent.click(screen.getByRole("button", { name: "Connect tools" }));

    expect(onToggleTag).toHaveBeenCalledWith("alpha", "tools", false);
    expect(rowTitles(container)).toEqual(["tools", "local-first", "typography"]);
  });

  it("keeps optimistic membership visible across stale parent props", () => {
    const onToggleTag = vi.fn();
    const tags = [tag("tools", 1), tag("typography", 2)];
    const props = {
      blockSlug: "alpha",
      tags,
      onToggleTag,
      onCreateAndAssign: vi.fn(),
    };
    const { rerender } = render(
      <CollectionPicker
        {...props}
        selectedTags={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect tools" }));
    expect(onToggleTag).toHaveBeenCalledWith("alpha", "tools", false);
    expect(screen.getByRole("button", { name: "Disconnect tools" })).toBeInTheDocument();

    rerender(
      <CollectionPicker
        {...props}
        selectedTags={[]}
      />,
    );
    expect(screen.getByRole("button", { name: "Disconnect tools" })).toBeInTheDocument();

    rerender(
      <CollectionPicker
        {...props}
        selectedTags={["tools"]}
      />,
    );
    expect(screen.getByRole("button", { name: "Disconnect tools" })).toBeInTheDocument();
  });

  it("uses flat menu-header search styling and supports keyboard navigation", () => {
    const onToggleTag = vi.fn();
    const onRequestClose = vi.fn();
    const { container } = render(
      <CollectionPicker
        blockSlug="alpha"
        selectedTags={[]}
        tags={[tag("tools", 1), tag("typography", 2)]}
        onToggleTag={onToggleTag}
        onCreateAndAssign={vi.fn()}
        onRequestClose={onRequestClose}
        stopKeyPropagation
      />,
    );
    const picker = container.querySelector("[data-collection-picker]") as HTMLElement;
    const input = screen.getByPlaceholderText("Search collections...");

    expect(input.parentElement).toHaveClass("border-b", "border-border", "p-1");
    expect(input).toHaveClass("border-none", "bg-transparent", "rounded-0", "px-2", "py-0");
    expect(input).not.toHaveClass("focus-visible:border-border-accent");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("spellcheck", "false");

    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(
      screen.getByText("typography").closest("[data-collection-picker-row]"),
    ).toHaveAttribute("data-collection-picker-row-active", "true");

    fireEvent.keyDown(picker, { key: "Enter" });
    expect(onToggleTag).toHaveBeenCalledWith("alpha", "typography", false);

    fireEvent.keyDown(picker, { key: "Escape" });
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("uses one active row for pointer and keyboard interaction", () => {
    const { container } = render(
      <CollectionPicker
        blockSlug="alpha"
        selectedTags={[]}
        tags={[tag("tools", 1), tag("typography", 2), tag("drawings", 3)]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        stopKeyPropagation
      />,
    );
    const picker = container.querySelector("[data-collection-picker]") as HTMLElement;
    const rows = Array.from(
      container.querySelectorAll("[data-collection-picker-row]"),
    ) as HTMLElement[];

    expect(rows[0]).toHaveAttribute("data-collection-picker-row-active", "true");

    fireEvent.pointerMove(rows[2]!);
    expect(rows[0]).not.toHaveAttribute("data-collection-picker-row-active");
    expect(rows[2]).toHaveAttribute("data-collection-picker-row-active", "true");
    expect(rows[2]).toHaveAttribute("data-collection-picker-interaction-mode", "pointer");

    fireEvent.keyDown(picker, { key: "ArrowUp" });
    expect(rows[1]).toHaveAttribute("data-collection-picker-row-active", "true");
    expect(rows[1]).toHaveAttribute("data-collection-picker-interaction-mode", "keyboard");
    expect(rows[2]).not.toHaveAttribute("data-collection-picker-row-active");
  });

  it("does not let stationary pointer position reclaim selection after keyboard scroll", () => {
    const { container } = render(
      <CollectionPicker
        blockSlug="alpha"
        selectedTags={[]}
        tags={[
          tag("one", 1),
          tag("two", 2),
          tag("three", 3),
          tag("four", 4),
          tag("five", 5),
        ]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        stopKeyPropagation
      />,
    );
    const picker = container.querySelector("[data-collection-picker]") as HTMLElement;
    const rows = Array.from(
      container.querySelectorAll("[data-collection-picker-row]"),
    ) as HTMLElement[];

    fireEvent.pointerMove(rows[2]!, { clientX: 120, clientY: 160, pointerId: 1 });
    expect(rows[2]).toHaveAttribute("data-collection-picker-row-active", "true");

    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(rows[3]).toHaveAttribute("data-collection-picker-row-active", "true");
    expect(rows[3]).toHaveAttribute("data-collection-picker-interaction-mode", "keyboard");

    fireEvent.pointerEnter(rows[1]!, { clientX: 120, clientY: 160, pointerId: 1 });
    fireEvent.pointerMove(rows[1]!, { clientX: 120, clientY: 160, pointerId: 1 });

    expect(rows[3]).toHaveAttribute("data-collection-picker-row-active", "true");
    expect(rows[1]).not.toHaveAttribute("data-collection-picker-row-active");

    fireEvent.pointerMove(rows[1]!, { clientX: 121, clientY: 160, pointerId: 1 });

    expect(rows[1]).toHaveAttribute("data-collection-picker-row-active", "true");
    expect(rows[1]).toHaveAttribute("data-collection-picker-interaction-mode", "pointer");
  });

  it("switches the right slot instantly when active row changes", () => {
    const { container } = render(
      <CollectionPicker
        blockSlug="alpha"
        selectedTags={[]}
        tags={[tag("tools", 1), tag("typography", 2)]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        stopKeyPropagation
      />,
    );
    const picker = container.querySelector("[data-collection-picker]") as HTMLElement;
    const rows = Array.from(
      container.querySelectorAll("[data-collection-picker-row]"),
    ) as HTMLElement[];
    const firstButton = within(rows[0]!).getByRole("button", { name: "Connect tools" });
    const secondButton = within(rows[1]!).getByRole("button", { name: "Connect typography" });

    expect(firstButton).toHaveClass("opacity-100");
    expect(firstButton).not.toHaveClass("transition-opacity");
    expect(secondButton).toHaveClass("opacity-0");

    fireEvent.keyDown(picker, { key: "ArrowDown" });

    expect(firstButton).toHaveClass("opacity-0");
    expect(secondButton).toHaveClass("opacity-100");
    expect(secondButton).not.toHaveClass("transition-opacity");
  });

  it("closes a side submenu with the directional back arrow", () => {
    const onRequestClose = vi.fn();
    const { container } = render(
      <div data-slot="dropdown-menu-sub-content" data-side="right">
        <CollectionPicker
          blockSlug="alpha"
          selectedTags={[]}
          tags={[tag("tools", 1)]}
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestClose={onRequestClose}
          stopKeyPropagation
        />
      </div>,
    );
    const picker = container.querySelector("[data-collection-picker]") as HTMLElement;

    fireEvent.keyDown(picker, { key: "ArrowLeft" });

    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("clears a live query on Escape instead of letting the layer above close", () => {
    const { container } = render(
      <CollectionPicker
        blockSlug="alpha"
        selectedTags={[]}
        tags={[tag("tools", 1), tag("design", 2)]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
      />,
    );
    const search = screen.getByRole("textbox");
    fireEvent.change(search, { target: { value: "des" } });
    expect(rowTitles(container)).toEqual(["design"]);

    // First press: only the innermost state — the query — is undone. The
    // event must not propagate, or the surface above (a Radix menu, the
    // clipper panel) would close on the same press.
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(rowTitles(container)).toEqual(["tools", "design"]);
  });

  it("moves printable keyboard input into search", () => {
    const { container } = render(
      <CollectionPicker
        blockSlug="alpha"
        selectedTags={[]}
        tags={[tag("tools", 1)]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        stopKeyPropagation
      />,
    );
    const picker = container.querySelector("[data-collection-picker]") as HTMLElement;

    fireEvent.keyDown(picker, { key: "t" });

    expect(screen.getByPlaceholderText("Search collections...")).toHaveValue("t");
  });

  it("keeps printable typing routed to search from a hovered row", () => {
    const { container } = render(
      <CollectionPicker
        blockSlug="alpha"
        selectedTags={[]}
        tags={[tag("tools", 1), tag("typography", 2)]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        stopKeyPropagation
      />,
    );
    const row = container.querySelectorAll("[data-collection-picker-row]")[1] as HTMLElement;

    fireEvent.pointerMove(row);
    fireEvent.keyDown(row, { key: "p" });

    expect(screen.getByPlaceholderText("Search collections...")).toHaveValue("p");
  });

  it("lets ArrowDown reach the create-channel action from search", () => {
    const onCreateAndAssign = vi.fn();
    const { container } = render(
      <CollectionPicker
        blockSlug="alpha"
        selectedTags={[]}
        tags={[tag("tools", 1)]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={onCreateAndAssign}
        stopKeyPropagation
      />,
    );
    const picker = container.querySelector("[data-collection-picker]") as HTMLElement;
    const input = screen.getByPlaceholderText("Search collections...");

    fireEvent.change(input, { target: { value: "new-channel" } });
    fireEvent.keyDown(picker, { key: "ArrowDown" });

    const createAction = screen.getByRole("button", { name: /Create/ });
    expect(createAction).toHaveAttribute("data-collection-picker-create-active", "true");

    fireEvent.keyDown(picker, { key: "Enter" });

    expect(onCreateAndAssign).toHaveBeenCalledWith("new-channel", "alpha");
  });

  it("supports edge-to-edge clipper layout without changing row behavior", () => {
    const { container } = render(
      <CollectionPicker
        blockSlug="alpha"
        selectedTags={[]}
        tags={[tag("tools", 1)]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        layout="edge"
        className="h-full"
      />,
    );

    const picker = container.querySelector("[data-collection-picker]") as HTMLElement;
    const input = screen.getByPlaceholderText("Search collections...");
    expect(picker).toHaveClass("h-full");
    expect(input).toHaveClass("h-10", "rounded-0", "px-3", "py-0");
    expect(input).not.toHaveClass("focus-visible:border-border-accent");
  });
});
