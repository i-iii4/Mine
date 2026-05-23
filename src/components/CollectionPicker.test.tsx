import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CollectionPicker } from "./CollectionPicker";
import type { TagCount } from "@/types";

function tag(tag: string, count: number): TagCount {
  return { tag, count };
}

function rowTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-collection-picker-row]"))
    .map((row) => row.querySelector("span")?.textContent ?? "");
}

describe("CollectionPicker", () => {
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

  it("uses border-accent focus styling and supports keyboard navigation", () => {
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
    const input = screen.getByPlaceholderText("Search channels...");

    expect(input).toHaveClass("focus-visible:border-border-accent");
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

    expect(screen.getByPlaceholderText("Search channels...")).toHaveValue("t");
  });
});
