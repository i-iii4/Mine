// The blink of a chosen menu item (user's decision of 13.11.2026;
// SPEC_MOTION_LEVELS.md, «Вне ролей»; DESIGN_SYSTEM.md, «Нажатие»): the
// highlight out for half of 150 ms and back for the other half, then the menu
// closes and the command runs, once, on every level, by the pointer, Enter
// and Space alike. A check, a choice of a value, a submenu's trigger, an item
// that keeps its menu open and a disabled item do not blink.
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setMotionLevel } from "@/test/motionLevel";
import { MOTION_LEVELS, MOTION_MENU_BLINK_MS } from "./motion";
import { MENU_BLINK_ATTRIBUTE, menuBlinkMs, setMenuBlinkMsForTests } from "./menuBlink";

const HALF = MOTION_MENU_BLINK_MS / 2;

beforeEach(() => {
  setMenuBlinkMsForTests(MOTION_MENU_BLINK_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

function Menu({ onAction, onKeep, onCheck, onChoose }: {
  onAction: () => void;
  onKeep?: () => void;
  onCheck?: () => void;
  onChoose?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onAction}>Action</DropdownMenuItem>
        <DropdownMenuItem
          staysOpen
          onSelect={(event) => {
            event.preventDefault();
            onKeep?.();
          }}
        >
          Keep
        </DropdownMenuItem>
        <DropdownMenuItem disabled onSelect={onAction}>Unavailable</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={false} onCheckedChange={onCheck} onSelect={(event) => event.preventDefault()}>
          Check
        </DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup value="a" onValueChange={onChoose}>
          <DropdownMenuRadioItem value="b" onSelect={(event) => event.preventDefault()}>Choice</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={onAction}>Nested</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const menu = () => document.querySelector('[data-slot="dropdown-menu-content"]');
const item = (name: string) => screen.getByRole("menuitem", { name });

/** Opens the menu on real time, then holds the clock: the blink is timed
 *  from here on by the test. */
async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByText("Open menu"));
  expect(menu()).not.toBeNull();
  vi.useFakeTimers();
}

/** A choice as the menu hears it: the pointer's click, or Enter or Space on
 *  the focused item, which the menu turns into a click. */
function choose(name: string, how: "pointer" | "Enter" | "Space", role = "menuitem") {
  const target = screen.getByRole(role, { name });
  act(() => {
    if (how === "pointer") {
      fireEvent.click(target);
      return;
    }
    target.focus();
    fireEvent.keyDown(target, { key: how === "Enter" ? "Enter" : " " });
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("the blink of a chosen menu item", () => {
  it("is 150 ms long, the new value of the design system", () => {
    expect(MOTION_MENU_BLINK_MS).toBe(150);
    expect(menuBlinkMs()).toBe(MOTION_MENU_BLINK_MS);
  });

  for (const level of MOTION_LEVELS) {
    for (const how of ["pointer", "Enter", "Space"] as const) {
      it(`${level}: chosen by ${how}, it blinks, then the menu closes and the command runs once`, async () => {
        setMotionLevel(level);
        const onAction = vi.fn();
        render(<Menu onAction={onAction} />);
        await openMenu();
        choose("Action", how);
        // The highlight is out for the first half, the menu still open.
        expect(item("Action")).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        expect(onAction).not.toHaveBeenCalled();
        advance(HALF);
        // Back for the second half.
        expect(item("Action")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        expect(onAction).not.toHaveBeenCalled();
        expect(menu()).not.toBeNull();
        advance(HALF);
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(menu()).toBeNull();
      });
    }
  }

  it("runs the command once for a double click and for Enter pressed again during the blink", async () => {
    const onAction = vi.fn();
    render(<Menu onAction={onAction} />);
    await openMenu();
    choose("Action", "pointer");
    choose("Action", "pointer");
    choose("Action", "Enter");
    advance(HALF);
    choose("Action", "Space");
    advance(HALF);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    advance(MOTION_MENU_BLINK_MS);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("runs nothing when the menu closes during the blink", async () => {
    const onAction = vi.fn();
    render(<Menu onAction={onAction} />);
    await openMenu();
    choose("Action", "pointer");
    act(() => {
      fireEvent.keyDown(item("Action"), { key: "Escape" });
    });
    expect(menu()).toBeNull();
    advance(MOTION_MENU_BLINK_MS);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("does not blink an item that keeps its menu open, a check or a choice of a value", async () => {
    const onKeep = vi.fn();
    const onCheck = vi.fn();
    const onChoose = vi.fn();
    render(<Menu onAction={vi.fn()} onKeep={onKeep} onCheck={onCheck} onChoose={onChoose} />);
    await openMenu();
    choose("Keep", "pointer");
    expect(item("Keep")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    expect(onKeep).toHaveBeenCalledTimes(1);
    choose("Check", "Enter", "menuitemcheckbox");
    expect(screen.getByRole("menuitemcheckbox", { name: "Check" })).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    expect(onCheck).toHaveBeenCalledTimes(1);
    choose("Choice", "pointer", "menuitemradio");
    expect(screen.getByRole("menuitemradio", { name: "Choice" })).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(menu()).not.toBeNull();
  });

  it("does not blink a disabled item or a submenu's trigger", async () => {
    const onAction = vi.fn();
    render(<Menu onAction={onAction} />);
    await openMenu();
    choose("Unavailable", "pointer");
    expect(item("Unavailable")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    choose("More", "Enter");
    expect(item("More")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    advance(MOTION_MENU_BLINK_MS);
    expect(onAction).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("blinks a context menu's item too", async () => {
    const onRename = vi.fn();
    render(
      <ContextMenu>
        <ContextMenuTrigger>Card</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onRename}>Rename</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    const card = screen.getByText("Card");
    fireEvent.pointerDown(card, { button: 2 });
    fireEvent.contextMenu(card);
    vi.useFakeTimers();
    choose("Rename", "pointer");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
    expect(onRename).not.toHaveBeenCalled();
    advance(MOTION_MENU_BLINK_MS);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-slot="context-menu-content"]')).toBeNull();
  });
});
