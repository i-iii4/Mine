import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

describe("DropdownMenu", () => {
  it("does not open trigger menus from modified arrow shortcuts", () => {
    render(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    fireEvent.keyDown(screen.getByText("Open menu"), {
      key: "ArrowDown",
      metaKey: true,
    });

    expect(screen.queryByText("Action item")).not.toBeInTheDocument();
  });

  it("uses active surface for item focus and open submenu state", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Nested actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(screen.getByText("Action item")).toHaveClass("focus:state-active");
    expect(screen.getByText("Action item")).not.toHaveClass("focus:bg-accent");
    expect(screen.getByText("Nested actions")).toHaveClass(
      "focus:state-active",
      "data-[state=open]:state-active",
    );
    expect(screen.getByText("Nested actions")).not.toHaveClass(
      "data-[state=open]:bg-accent",
    );
  });

  // DESIGN_SYSTEM.md, «Цвет текста и значков»: focus and an open submenu
  // lift the icon one step together with the text.
  it("lifts the item icon with its text on focus and an open submenu", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action item</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Delete item</DropdownMenuItem>
          <DropdownMenuItem disabled>Unavailable item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Nested actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const iconAtRest = "[&_svg:not([class*='text-'])]:text-muted-foreground";
    const iconOnFocus = "focus:[&_svg:not([class*='text-'])]:text-foreground";
    const iconOnOpen = "data-[state=open]:[&_svg:not([class*='text-'])]:text-foreground";

    expect(screen.getByText("Action item")).toHaveClass("focus:text-foreground", iconAtRest, iconOnFocus);
    expect(screen.getByText("Nested actions")).toHaveClass(
      "focus:text-foreground",
      "data-[state=open]:text-foreground",
      iconAtRest,
      iconOnFocus,
      iconOnOpen,
    );
    // Destructive keeps its colour on text and icon in every state.
    expect(screen.getByText("Delete item")).toHaveClass(
      "data-[variant=destructive]:focus:text-destructive",
      "data-[variant=destructive]:[&_svg]:!text-destructive",
    );
    // Disabled keeps the tertiary step.
    expect(screen.getByText("Unavailable item")).toHaveClass(
      "data-[disabled]:text-tertiary-foreground",
      "data-[disabled]:[&_svg:not([class*='text-'])]:text-tertiary-foreground",
    );
  });

  it("uses the feed card surface for floating menu content", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Nested actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const content = document.querySelector("[data-slot='dropdown-menu-content']");
    const subContent = document.querySelector("[data-slot='dropdown-menu-sub-content']");

    expect(content).toHaveClass("bg-card", "text-card-foreground");
    expect(content).not.toHaveClass("bg-popover", "text-popover-foreground");
    expect(subContent).toHaveClass("bg-card", "text-card-foreground");
    expect(subContent).not.toHaveClass("bg-popover", "text-popover-foreground");
  });

  it("gives the menu and its submenu the one width rule (07.10.2026)", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Nested actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    for (const slot of ["dropdown-menu-content", "dropdown-menu-sub-content"]) {
      const content = document.querySelector(`[data-slot='${slot}']`);
      expect(content).toHaveAttribute("data-floating-menu", "");
      expect(content).not.toHaveAttribute("data-floating-menu-width");
      expect(content?.className).not.toMatch(/(?:^|\s)min-w-/);
    }
  });

  it("holds the width a menu opened with as its least", () => {
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(176);
    try {
      render(
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Action item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );
      const content = document.querySelector<HTMLElement>("[data-slot='dropdown-menu-content']");
      expect(content?.style.minWidth).toBe("176px");
    } finally {
      width.mockRestore();
    }
  });
});

// DESIGN_SYSTEM.md, «Открытое меню»: the pointer's hover passes under an open
// menu; a press outside only closes it (src/lib/openMenus.ts).
describe("DropdownMenu over the page", () => {
  function renderMenuOverPage(under: { onPointerEnter?: () => void; onPointerDown?: () => void; onClick?: () => void } = {}) {
    render(
      <>
        <button type="button" {...under}>Under the menu</button>
        <DropdownMenu>
          <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Action item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>,
    );
    return { trigger: screen.getByText("Open menu"), under: screen.getByText("Under the menu") };
  }

  it("lets the hover reach what lies under the open menu", async () => {
    const user = userEvent.setup();
    const onPointerEnter = vi.fn();
    const { trigger, under } = renderMenuOverPage({ onPointerEnter });

    await user.click(trigger);
    expect(screen.getByText("Action item")).toBeInTheDocument();
    // A modal menu set `pointer-events: none` here; user-event refuses to
    // hover through it.
    expect(document.body.style.pointerEvents).toBe("");
    await user.hover(under);

    expect(onPointerEnter).toHaveBeenCalled();
    expect(screen.getByText("Action item")).toBeInTheDocument();
  });

  it("closes on a press outside, and neither the press nor its click acts there", async () => {
    const user = userEvent.setup();
    const onPointerDown = vi.fn();
    const onClick = vi.fn();
    const { trigger, under } = renderMenuOverPage({ onPointerDown, onClick });

    await user.click(trigger);
    await user.click(under);

    await waitFor(() => expect(screen.queryByText("Action item")).not.toBeInTheDocument());
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    // As the modal menu did, the focus goes back to the trigger.
    await waitFor(() => expect(trigger).toHaveFocus());

    // With the menu closed the next click is the page's again.
    await user.click(under);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("holds the rest of the press that opened it", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      // A trigger inside a clickable row: opening the menu does not open the row.
      <div role="presentation" onClick={onRowClick}>
        <DropdownMenu>
          <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Action item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>,
    );

    await user.click(screen.getByText("Open menu"));

    expect(screen.getByText("Action item")).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("closes on Escape and gives the focus back to its trigger", async () => {
    const user = userEvent.setup();
    const { trigger } = renderMenuOverPage();

    await user.click(trigger);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Action item")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("scrolls nothing under it with the wheel", async () => {
    const user = userEvent.setup();
    const { trigger, under } = renderMenuOverPage();

    await user.click(trigger);

    expect(fireEvent.wheel(under, { deltaY: 40 })).toBe(false);
    expect(fireEvent.wheel(screen.getByText("Action item"), { deltaY: 40 })).toBe(true);
  });

  it("closes only itself when it is open over a dialog", async () => {
    const user = userEvent.setup();
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Dialog title</DialogTitle>
          <DialogDescription>Dialog text</DialogDescription>
          <DropdownMenu>
            <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Action item</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </DialogContent>
      </Dialog>,
    );

    await user.click(screen.getByText("Open menu"));
    await user.click(screen.getByText("Dialog text"));

    await waitFor(() => expect(screen.queryByText("Action item")).not.toBeInTheDocument());
    expect(screen.getByText("Dialog title")).toBeInTheDocument();
  });
});
