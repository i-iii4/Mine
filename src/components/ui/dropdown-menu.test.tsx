import { render, screen } from "@testing-library/react";
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
});
