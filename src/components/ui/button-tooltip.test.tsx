import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

/** Longer than the button's 500ms tooltip delay. */
const PAST_THE_DELAY_MS = 650;
const pastTheDelay = () => new Promise((resolve) => setTimeout(resolve, PAST_THE_DELAY_MS));

function ConnectPlus() {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="raised" size="icon-xs" aria-label="Connect">+</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Inspiration</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// A held button says nothing: pressed as a toggle or holding its own menu
// open, what it names is already in front of the person (DESIGN_SYSTEM.md,
// «Подсказки»; user's decision of 07.10.2026).
describe("a held button's tooltip", () => {
  it("names an icon button on hover as before", async () => {
    render(<Button size="icon-xs" aria-label="Connect">+</Button>);
    fireEvent.pointerMove(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Connect");
  });

  it("names a menu's button while its menu is closed", async () => {
    render(<ConnectPlus />);
    const plus = screen.getByRole("button", { name: "Connect" });
    expect(plus).toHaveAttribute("aria-expanded", "false");
    fireEvent.pointerMove(plus);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Connect");
  });

  it.each([
    ["pressed as a toggle", { "aria-pressed": true }],
    ["holding its menu open", { "aria-expanded": true, "data-state": "open" }],
    ["switched on", { "data-state": "on" }],
  ] as const)("keeps quiet while %s, under the pointer and in focus", async (_, held) => {
    render(<Button size="icon-xs" aria-label="Connect" {...held}>+</Button>);
    const button = screen.getByRole("button", { name: "Connect" });
    fireEvent.pointerMove(button);
    fireEvent.focus(button);
    await pastTheDelay();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes when its button becomes held and stays closed when it is let go", async () => {
    const { rerender } = render(<Button size="icon-xs" aria-label="Connect">+</Button>);
    fireEvent.pointerMove(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();

    rerender(<Button size="icon-xs" aria-label="Connect" aria-expanded data-state="open">+</Button>);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

    rerender(<Button size="icon-xs" aria-label="Connect" aria-expanded={false} data-state="closed">+</Button>);
    await pastTheDelay();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("says nothing over the Connect plus while its picker is open (user's report)", async () => {
    render(<ConnectPlus />);
    const plus = screen.getByRole("button", { name: "Connect" });
    fireEvent.keyDown(plus, { key: "Enter" });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(plus).toHaveAttribute("aria-expanded", "true");

    // The pointer leaves the plus for the picker and comes back.
    fireEvent.pointerLeave(plus);
    fireEvent.pointerMove(plus);
    fireEvent.focus(plus);
    await pastTheDelay();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
