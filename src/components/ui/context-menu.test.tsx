import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { subscribeContextMenus } from "@/lib/openMenus";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu";

describe("ContextMenu", () => {
  it("uses the feed card surface for floating menu content", () => {
    render(
      <ContextMenu modal={false}>
        <ContextMenuTrigger>Open context menu</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Action item</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText("Open context menu"));

    const content = document.querySelector("[data-slot='context-menu-content']");

    expect(content).toHaveClass("bg-card", "text-card-foreground");
    expect(content).not.toHaveClass("bg-popover", "text-popover-foreground");
    expect(screen.getByText("Action item")).toHaveClass("focus:state-active");
    expect(screen.getByText("Action item")).not.toHaveClass("focus:bg-accent");
  });

  // DESIGN_SYSTEM.md, «Цвет текста и значков»: focus and an open submenu
  // lift the icon one step together with the text.
  it("lifts the item icon with its text on focus and an open submenu", () => {
    render(
      <ContextMenu modal={false}>
        <ContextMenuTrigger>Open context menu</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Action item</ContextMenuItem>
          <ContextMenuItem variant="destructive">Delete item</ContextMenuItem>
          <ContextMenuItem disabled>Unavailable item</ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Nested actions</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Nested item</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText("Open context menu"));

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
});

// DESIGN_SYSTEM.md, «Открытое меню» (src/lib/openMenus.ts).
describe("ContextMenu over the page", () => {
  function renderContextMenu(under: { onPointerEnter?: () => void; onClick?: () => void } = {}) {
    render(
      <>
        <button type="button" {...under}>Under the menu</button>
        <ContextMenu>
          <ContextMenuTrigger>Open context menu</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Action item</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </>,
    );
    fireEvent.contextMenu(screen.getByText("Open context menu"));
    expect(screen.getByText("Action item")).toBeInTheDocument();
    return screen.getByText("Under the menu");
  }

  it("lets the hover reach what lies under it", async () => {
    const user = userEvent.setup();
    const onPointerEnter = vi.fn();
    const under = renderContextMenu({ onPointerEnter });

    expect(document.body.style.pointerEvents).toBe("");
    await user.hover(under);

    expect(onPointerEnter).toHaveBeenCalled();
    expect(screen.getByText("Action item")).toBeInTheDocument();
  });

  it("closes on a press outside without acting there", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const under = renderContextMenu({ onClick });

    await user.click(under);

    await waitFor(() => expect(screen.queryByText("Action item")).not.toBeInTheDocument());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("holds the pointer's answers while it is open (SPEC_CARD_STATES.md, С7.8)", async () => {
    const user = userEvent.setup();
    const listener = vi.fn();
    const unsubscribe = subscribeContextMenus(listener);
    try {
      renderContextMenu();
      expect(listener).toHaveBeenLastCalledWith(true);

      await user.keyboard("{Escape}");

      await waitFor(() => expect(listener).toHaveBeenLastCalledWith(false));
    } finally {
      unsubscribe();
    }
  });
});
