import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

  it("marks menu width by semantic role", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent widthRole="selector">
          <DropdownMenuItem>Action item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Nested actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent widthRole="picker">
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(document.querySelector("[data-slot='dropdown-menu-content']")).toHaveAttribute(
      "data-floating-menu-width",
      "selector",
    );
    expect(document.querySelector("[data-slot='dropdown-menu-sub-content']")).toHaveAttribute(
      "data-floating-menu-width",
      "picker",
    );
  });
});
