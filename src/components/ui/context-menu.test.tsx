import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
