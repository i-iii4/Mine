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

    expect(screen.getByText("Action item")).toHaveClass("focus:bg-active");
    expect(screen.getByText("Action item")).not.toHaveClass("focus:bg-accent");
    expect(screen.getByText("Nested actions")).toHaveClass(
      "focus:bg-active",
      "data-[state=open]:bg-active",
    );
    expect(screen.getByText("Nested actions")).not.toHaveClass(
      "data-[state=open]:bg-accent",
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
